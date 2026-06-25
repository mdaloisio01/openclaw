import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  recordOpenClawStateBackupRun,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

const DELIVERY_FAILURE_PREFIX =
  "Required completion delivery failed before reaching the requester:";

export type DeliveryRemediationMode = "dry-run" | "write";

export type DeliveryRemediationCounts = {
  blockedDeliveryFlows: number;
  pendingFinalDeliveryRuns: number;
  succeededBlockedTasks: number;
};

export type DeliveryRemediationTaskCandidate = {
  taskId: string;
  runId: string | null;
  parentFlowId: string | null;
  status: string;
  deliveryStatus: string;
  terminalOutcome: string | null;
  terminalSummary: string | null;
  proposedRepairAction: "set_terminal_outcome_succeeded";
};

export type DeliveryRemediationFlowCandidate = {
  flowId: string;
  blockedTaskId: string | null;
  status: string;
  blockedSummary: string | null;
  proposedRepairAction: "clear_synthetic_delivery_blocker";
};

export type DeliveryRemediationSubagentCandidate = {
  runId: string;
  childSessionKey: string;
  pendingFinalDelivery: number;
  pendingFinalDeliveryAttemptCount: number | null;
  pendingFinalDeliveryLastError: string | null;
  payloadDeliveryStatus: string | null;
  payloadSuspendedReason: string | null;
  proposedRepairAction: "clear_stale_pending_flag_preserve_suspended_delivery_debt";
};

export type DeliveryRemediationSkippedRow = {
  table: "flow_runs" | "task_runs" | "subagent_runs";
  id: string;
  reason:
    | "missing_succeeded_blocked_task_proof"
    | "missing_matching_flow"
    | "payload_not_suspended_retry_limit"
    | "not_old_delivery_failure_seam";
  summary: string | null;
};

export type DeliveryRemediationInventory = {
  taskCandidates: DeliveryRemediationTaskCandidate[];
  flowCandidates: DeliveryRemediationFlowCandidate[];
  subagentCandidates: DeliveryRemediationSubagentCandidate[];
  skippedRows: DeliveryRemediationSkippedRow[];
};

export type DeliveryRemediationReceipt = {
  receiptVersion: "1";
  runId: string;
  mode: DeliveryRemediationMode;
  dbPath: string;
  receiptPath: string;
  snapshotPath: string | null;
  createdAtIso: string;
  before: DeliveryRemediationCounts;
  after: DeliveryRemediationCounts;
  candidates: {
    taskRuns: number;
    flowRuns: number;
    subagentRuns: number;
  };
  repaired: {
    taskRuns: number;
    flowRuns: number;
    subagentRuns: number;
  };
  skipped: {
    total: number;
    byReason: Record<string, number>;
  };
  perRowActions: Array<
    | {
        table: "task_runs";
        id: string;
        action: DeliveryRemediationTaskCandidate["proposedRepairAction"];
      }
    | {
        table: "flow_runs";
        id: string;
        action: DeliveryRemediationFlowCandidate["proposedRepairAction"];
      }
    | {
        table: "subagent_runs";
        id: string;
        action: DeliveryRemediationSubagentCandidate["proposedRepairAction"];
      }
  >;
  skippedRows: DeliveryRemediationSkippedRow[];
  validationSummary: {
    safeToWrite: boolean;
    orphanBlockedFlowCount: number;
  };
};

export type DeliveryRemediationRunResult = {
  mode: DeliveryRemediationMode;
  receipt: DeliveryRemediationReceipt;
};

export type RunDeliveryRemediationOptions = OpenClawStateDatabaseOptions & {
  mode: DeliveryRemediationMode;
  receiptDir: string;
  snapshotPath?: string;
  runId?: string;
  now?: number;
};

type TaskCandidateRow = {
  task_id: string;
  run_id: string | null;
  parent_flow_id: string | null;
  status: string;
  delivery_status: string;
  terminal_outcome: string | null;
  terminal_summary: string | null;
};

type FlowCandidateRow = {
  flow_id: string;
  blocked_task_id: string | null;
  status: string;
  blocked_summary: string | null;
};

type SubagentCandidateRow = {
  run_id: string;
  child_session_key: string;
  pending_final_delivery: number;
  pending_final_delivery_attempt_count: number | null;
  pending_final_delivery_last_error: string | null;
  payload_delivery_status: string | null;
  payload_suspended_reason: string | null;
};

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readCounts(db: DatabaseSync): DeliveryRemediationCounts {
  const blockedDeliveryFlows =
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM flow_runs
              WHERE status = 'blocked'
                AND blocked_summary LIKE ?`,
          )
          .get(`${DELIVERY_FAILURE_PREFIX}%`) as { count?: number | bigint } | undefined
      )?.count ?? 0,
    ) || 0;
  const pendingFinalDeliveryRuns =
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM subagent_runs
              WHERE pending_final_delivery = 1`,
          )
          .get() as { count?: number | bigint } | undefined
      )?.count ?? 0,
    ) || 0;
  const succeededBlockedTasks =
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM task_runs
              WHERE status = 'succeeded'
                AND terminal_outcome = 'blocked'`,
          )
          .get() as { count?: number | bigint } | undefined
      )?.count ?? 0,
    ) || 0;
  return {
    blockedDeliveryFlows,
    pendingFinalDeliveryRuns,
    succeededBlockedTasks,
  };
}

function buildInventory(db: DatabaseSync): DeliveryRemediationInventory {
  const taskRows = db
    .prepare(
      `SELECT task_id, run_id, parent_flow_id, status, delivery_status, terminal_outcome, terminal_summary
         FROM task_runs
        WHERE status = 'succeeded'
          AND terminal_outcome = 'blocked'
          AND terminal_summary LIKE ?
        ORDER BY task_id`,
    )
    .all(`${DELIVERY_FAILURE_PREFIX}%`) as TaskCandidateRow[];
  const taskCandidates = taskRows
    .filter((row) => row.delivery_status === "failed")
    .map<DeliveryRemediationTaskCandidate>((row) => ({
      taskId: row.task_id,
      runId: row.run_id,
      parentFlowId: row.parent_flow_id,
      status: row.status,
      deliveryStatus: row.delivery_status,
      terminalOutcome: row.terminal_outcome,
      terminalSummary: row.terminal_summary,
      proposedRepairAction: "set_terminal_outcome_succeeded",
    }));
  const taskCandidateIds = new Set(taskCandidates.map((row) => row.taskId));

  const flowRows = db
    .prepare(
      `SELECT flow_id, blocked_task_id, status, blocked_summary
         FROM flow_runs
        WHERE status = 'blocked'
          AND blocked_summary LIKE ?
        ORDER BY flow_id`,
    )
    .all(`${DELIVERY_FAILURE_PREFIX}%`) as FlowCandidateRow[];
  const flowCandidates: DeliveryRemediationFlowCandidate[] = [];
  const skippedRows: DeliveryRemediationSkippedRow[] = [];
  for (const row of flowRows) {
    if (row.blocked_task_id && taskCandidateIds.has(row.blocked_task_id)) {
      flowCandidates.push({
        flowId: row.flow_id,
        blockedTaskId: row.blocked_task_id,
        status: row.status,
        blockedSummary: row.blocked_summary,
        proposedRepairAction: "clear_synthetic_delivery_blocker",
      });
      continue;
    }
    skippedRows.push({
      table: "flow_runs",
      id: row.flow_id,
      reason: "missing_succeeded_blocked_task_proof",
      summary: row.blocked_summary,
    });
  }

  const subagentRows = db
    .prepare(
      `SELECT
         run_id,
         child_session_key,
         pending_final_delivery,
         pending_final_delivery_attempt_count,
         pending_final_delivery_last_error,
         json_extract(payload_json, '$.delivery.status') AS payload_delivery_status,
         json_extract(payload_json, '$.delivery.suspendedReason') AS payload_suspended_reason
       FROM subagent_runs
       WHERE pending_final_delivery = 1
       ORDER BY run_id`,
    )
    .all() as SubagentCandidateRow[];
  const subagentCandidates: DeliveryRemediationSubagentCandidate[] = [];
  for (const row of subagentRows) {
    if (
      row.payload_delivery_status === "suspended" &&
      row.payload_suspended_reason === "retry-limit"
    ) {
      subagentCandidates.push({
        runId: row.run_id,
        childSessionKey: row.child_session_key,
        pendingFinalDelivery: row.pending_final_delivery,
        pendingFinalDeliveryAttemptCount: row.pending_final_delivery_attempt_count,
        pendingFinalDeliveryLastError: row.pending_final_delivery_last_error,
        payloadDeliveryStatus: row.payload_delivery_status,
        payloadSuspendedReason: row.payload_suspended_reason,
        proposedRepairAction: "clear_stale_pending_flag_preserve_suspended_delivery_debt",
      });
      continue;
    }
    skippedRows.push({
      table: "subagent_runs",
      id: row.run_id,
      reason: "payload_not_suspended_retry_limit",
      summary: row.pending_final_delivery_last_error,
    });
  }

  return {
    taskCandidates,
    flowCandidates,
    subagentCandidates,
    skippedRows,
  };
}

function summarizeSkippedReasons(
  skippedRows: DeliveryRemediationSkippedRow[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of skippedRows) {
    counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  }
  return counts;
}

function buildReceiptPath(params: {
  receiptDir: string;
  createdAtIso: string;
  mode: DeliveryRemediationMode;
}): string {
  const sluggedTs = params.createdAtIso.replace(/:/g, "").replace(/\.\d+Z$/u, "Z");
  return path.join(
    params.receiptDir,
    `openclaw_oc_rscan_001_historical_remediation_${params.mode}_${sluggedTs}.json`,
  );
}

function writeReceipt(receipt: DeliveryRemediationReceipt): void {
  ensureDir(path.dirname(receipt.receiptPath));
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function createDatabaseSnapshot(params: {
  dbPath: string;
  snapshotPath: string;
  manifest: Record<string, unknown>;
  options?: OpenClawStateDatabaseOptions;
  createdAt: number;
}): void {
  ensureDir(path.dirname(params.snapshotPath));
  if (fs.existsSync(params.snapshotPath)) {
    throw new Error(`Snapshot path already exists: ${params.snapshotPath}`);
  }
  closeOpenClawStateDatabase();
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(params.dbPath);
  try {
    db.exec(`VACUUM INTO ${quoteSqlString(params.snapshotPath)}`);
  } finally {
    db.close();
  }
  if (!fs.existsSync(params.snapshotPath)) {
    throw new Error(`Snapshot was not created at ${params.snapshotPath}`);
  }
  recordOpenClawStateBackupRun({
    ...(params.options ?? {}),
    createdAt: params.createdAt,
    archivePath: params.snapshotPath,
    status: "completed",
    manifest: params.manifest,
  });
}

function applyInventory(params: {
  inventory: DeliveryRemediationInventory;
  options?: OpenClawStateDatabaseOptions;
  updatedAt: number;
}): {
  repaired: {
    taskRuns: number;
    flowRuns: number;
    subagentRuns: number;
  };
  perRowActions: DeliveryRemediationReceipt["perRowActions"];
} {
  const perRowActions: DeliveryRemediationReceipt["perRowActions"] = [];
  runOpenClawStateWriteTransaction(({ db }) => {
    const updateTask = db.prepare(
      `UPDATE task_runs
          SET terminal_outcome = 'succeeded'
        WHERE task_id = ?
          AND status = 'succeeded'
          AND terminal_outcome = 'blocked'
          AND terminal_summary LIKE ?`,
    );
    const updateFlow = db.prepare(
      `UPDATE flow_runs
          SET status = 'succeeded',
              blocked_task_id = NULL,
              blocked_summary = NULL,
              updated_at = ?
        WHERE flow_id = ?
          AND status = 'blocked'
          AND blocked_summary LIKE ?`,
    );
    const updateSubagent = db.prepare(
      `UPDATE subagent_runs
          SET pending_final_delivery = 0
        WHERE run_id = ?
          AND pending_final_delivery = 1
          AND json_extract(payload_json, '$.delivery.status') = 'suspended'
          AND json_extract(payload_json, '$.delivery.suspendedReason') = 'retry-limit'`,
    );

    for (const row of params.inventory.taskCandidates) {
      updateTask.run(row.taskId, `${DELIVERY_FAILURE_PREFIX}%`);
      perRowActions.push({
        table: "task_runs",
        id: row.taskId,
        action: row.proposedRepairAction,
      });
    }
    for (const row of params.inventory.flowCandidates) {
      updateFlow.run(params.updatedAt, row.flowId, `${DELIVERY_FAILURE_PREFIX}%`);
      perRowActions.push({
        table: "flow_runs",
        id: row.flowId,
        action: row.proposedRepairAction,
      });
    }
    for (const row of params.inventory.subagentCandidates) {
      updateSubagent.run(row.runId);
      perRowActions.push({
        table: "subagent_runs",
        id: row.runId,
        action: row.proposedRepairAction,
      });
    }
  }, params.options);

  return {
    repaired: {
      taskRuns: params.inventory.taskCandidates.length,
      flowRuns: params.inventory.flowCandidates.length,
      subagentRuns: params.inventory.subagentCandidates.length,
    },
    perRowActions,
  };
}

export function runHistoricalDeliveryFailureRemediation(
  options: RunDeliveryRemediationOptions,
): DeliveryRemediationRunResult {
  const now = options.now ?? Date.now();
  const createdAtIso = new Date(now).toISOString();
  const runId = options.runId ?? randomUUID();
  const database = openOpenClawStateDatabase(options);
  const dbPath = database.path;
  const before = readCounts(database.db);
  const inventory = buildInventory(database.db);
  const safeToWrite = inventory.skippedRows.every((row) => row.table !== "task_runs");

  let snapshotPath: string | null = null;
  let repaired = {
    taskRuns: 0,
    flowRuns: 0,
    subagentRuns: 0,
  };
  let perRowActions: DeliveryRemediationReceipt["perRowActions"] = [];

  if (options.mode === "write") {
    if (!options.snapshotPath?.trim()) {
      throw new Error("Write mode requires a verified snapshot path.");
    }
    snapshotPath = options.snapshotPath;
    createDatabaseSnapshot({
      dbPath,
      snapshotPath,
      createdAt: now,
      options,
      manifest: {
        kind: "oc-rscan-001-historical-remediation",
        runId,
        before,
        candidates: {
          taskRuns: inventory.taskCandidates.length,
          flowRuns: inventory.flowCandidates.length,
          subagentRuns: inventory.subagentCandidates.length,
        },
      },
    });
    const applied = applyInventory({
      inventory,
      options,
      updatedAt: now,
    });
    repaired = applied.repaired;
    perRowActions = applied.perRowActions;
  }

  closeOpenClawStateDatabase();
  const reopened = openOpenClawStateDatabase(options);
  const after = readCounts(reopened.db);
  const receiptPath = buildReceiptPath({
    receiptDir: options.receiptDir,
    createdAtIso,
    mode: options.mode,
  });
  const receipt: DeliveryRemediationReceipt = {
    receiptVersion: "1",
    runId,
    mode: options.mode,
    dbPath,
    receiptPath,
    snapshotPath,
    createdAtIso,
    before,
    after,
    candidates: {
      taskRuns: inventory.taskCandidates.length,
      flowRuns: inventory.flowCandidates.length,
      subagentRuns: inventory.subagentCandidates.length,
    },
    repaired,
    skipped: {
      total: inventory.skippedRows.length,
      byReason: summarizeSkippedReasons(inventory.skippedRows),
    },
    perRowActions,
    skippedRows: inventory.skippedRows,
    validationSummary: {
      safeToWrite,
      orphanBlockedFlowCount:
        summarizeSkippedReasons(inventory.skippedRows).missing_succeeded_blocked_task_proof ?? 0,
    },
  };
  writeReceipt(receipt);
  return {
    mode: options.mode,
    receipt,
  };
}

export function planHistoricalDeliveryFailureSnapshotPath(
  dbPath: string,
  now: number = Date.now(),
): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `${dbPath}.oc-rscan-001-${stamp}.snapshot.sqlite`;
}

export function isHistoricalDeliveryFailureRemediationSafeToWrite(
  inventory: DeliveryRemediationInventory,
): boolean {
  return inventory.skippedRows.every((row) => row.table !== "task_runs");
}
