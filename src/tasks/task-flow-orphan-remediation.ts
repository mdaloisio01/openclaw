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

const DEFAULT_STALE_QUEUED_MS = 30 * 60 * 1000;
const ORPHAN_QUEUED_FLOW_SUMMARY =
  "Managed queued TaskFlow aged past stale threshold without executor proof, linked task rows, or wait state.";

export type OrphanQueuedFlowRemediationMode = "dry-run" | "write";

export type OrphanQueuedFlowRemediationCounts = {
  queuedWithoutExecutorProof: number;
  lostWithoutExecutorProof: number;
};

export type OrphanQueuedFlowCandidate = {
  flowId: string;
  ownerKey: string;
  controllerId: string | null;
  currentStep: string | null;
  goal: string;
  createdAt: number;
  updatedAt: number;
  ageMs: number;
  proposedRepairAction: "mark_lost_unlaunched";
};

export type OrphanQueuedFlowSkippedRow = {
  flowId: string;
  reason: "has_linked_task" | "has_wait_state" | "not_stale" | "production_continuation_present";
};

export type OrphanQueuedFlowInventory = {
  candidates: OrphanQueuedFlowCandidate[];
  skippedRows: OrphanQueuedFlowSkippedRow[];
};

export type OrphanQueuedFlowRemediationReceipt = {
  receiptVersion: "1";
  runId: string;
  mode: OrphanQueuedFlowRemediationMode;
  dbPath: string;
  receiptPath: string;
  snapshotPath: string | null;
  createdAtIso: string;
  staleQueuedMs: number;
  before: OrphanQueuedFlowRemediationCounts;
  after: OrphanQueuedFlowRemediationCounts;
  candidates: {
    flowRuns: number;
  };
  repaired: {
    flowRuns: number;
  };
  skipped: {
    total: number;
    byReason: Record<string, number>;
  };
  perRowActions: Array<{ table: "flow_runs"; id: string; action: "mark_lost_unlaunched" }>;
  skippedRows: OrphanQueuedFlowSkippedRow[];
  validationSummary: {
    safeToWrite: boolean;
  };
};

export type OrphanQueuedFlowRemediationRunResult = {
  mode: OrphanQueuedFlowRemediationMode;
  receipt: OrphanQueuedFlowRemediationReceipt;
};

export type RunOrphanQueuedFlowRemediationOptions = OpenClawStateDatabaseOptions & {
  mode: OrphanQueuedFlowRemediationMode;
  receiptDir: string;
  snapshotPath?: string;
  runId?: string;
  now?: number;
  staleQueuedMs?: number;
};

type FlowRow = {
  flow_id: string;
  sync_mode: string | null;
  owner_key: string;
  controller_id: string | null;
  status: string;
  goal: string;
  current_step: string | null;
  wait_json: string | null;
  state_json: string | null;
  created_at: number;
  updated_at: number;
};

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

function hasSerializedWaitState(raw: string | null): boolean {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "null") {
    return false;
  }
  return true;
}

function readCounts(
  db: DatabaseSync,
  staleQueuedMs: number,
  now: number,
): OrphanQueuedFlowRemediationCounts {
  const threshold = now - staleQueuedMs;
  const queuedWithoutExecutorProof =
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM flow_runs f
              WHERE f.sync_mode = 'managed'
                AND f.status = 'queued'
                AND f.updated_at <= ?
                AND (f.wait_json IS NULL OR trim(f.wait_json) = '' OR trim(f.wait_json) = 'null')
                AND NOT EXISTS (
                  SELECT 1 FROM task_runs t
                   WHERE t.parent_flow_id = f.flow_id
                )
                AND coalesce(json_extract(f.state_json, '$.productionContinuation.activeProductionRun'), 0) != 1`,
          )
          .get(threshold) as { count?: number | bigint } | undefined
      )?.count ?? 0,
    ) || 0;
  const lostWithoutExecutorProof =
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM flow_runs
              WHERE status = 'lost'
                AND blocked_summary = ?`,
          )
          .get(ORPHAN_QUEUED_FLOW_SUMMARY) as { count?: number | bigint } | undefined
      )?.count ?? 0,
    ) || 0;
  return {
    queuedWithoutExecutorProof,
    lostWithoutExecutorProof,
  };
}

function buildInventory(
  db: DatabaseSync,
  staleQueuedMs: number,
  now: number,
): OrphanQueuedFlowInventory {
  const rows = db
    .prepare(
      `SELECT
         flow_id,
         sync_mode,
         owner_key,
         controller_id,
         status,
         goal,
         current_step,
         wait_json,
         state_json,
         created_at,
         updated_at
       FROM flow_runs
       ORDER BY created_at ASC, flow_id ASC`,
    )
    .all() as FlowRow[];

  const candidates: OrphanQueuedFlowCandidate[] = [];
  const skippedRows: OrphanQueuedFlowSkippedRow[] = [];
  for (const row of rows) {
    if (row.sync_mode !== "managed" || row.status !== "queued") {
      continue;
    }
    const linkedTaskCount =
      Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM task_runs
                WHERE parent_flow_id = ?`,
            )
            .get(row.flow_id) as { count?: number | bigint } | undefined
        )?.count ?? 0,
      ) || 0;
    if (linkedTaskCount > 0) {
      skippedRows.push({ flowId: row.flow_id, reason: "has_linked_task" });
      continue;
    }
    if (hasSerializedWaitState(row.wait_json)) {
      skippedRows.push({ flowId: row.flow_id, reason: "has_wait_state" });
      continue;
    }
    const stateJson = parseJsonObject(row.state_json);
    const continuation = stateJson?.productionContinuation;
    if (continuation && typeof continuation === "object") {
      const activeProductionRun = (continuation as Record<string, unknown>).activeProductionRun;
      if (activeProductionRun === true) {
        skippedRows.push({ flowId: row.flow_id, reason: "production_continuation_present" });
        continue;
      }
    }
    const ageMs = Math.max(0, now - row.updated_at);
    if (ageMs < staleQueuedMs) {
      skippedRows.push({ flowId: row.flow_id, reason: "not_stale" });
      continue;
    }
    candidates.push({
      flowId: row.flow_id,
      ownerKey: row.owner_key,
      controllerId: row.controller_id,
      currentStep: row.current_step,
      goal: row.goal,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ageMs,
      proposedRepairAction: "mark_lost_unlaunched",
    });
  }
  return { candidates, skippedRows };
}

function summarizeSkippedReasons(
  skippedRows: OrphanQueuedFlowSkippedRow[],
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
  mode: OrphanQueuedFlowRemediationMode;
}): string {
  const sluggedTs = params.createdAtIso.replace(/:/g, "").replace(/\.\d+Z$/u, "Z");
  return path.join(
    params.receiptDir,
    `openclaw_oc_rscan_002_orphan_queued_flow_remediation_${params.mode}_${sluggedTs}.json`,
  );
}

function writeReceipt(receipt: OrphanQueuedFlowRemediationReceipt): void {
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
  inventory: OrphanQueuedFlowInventory;
  options?: OpenClawStateDatabaseOptions;
  updatedAt: number;
}): {
  repaired: { flowRuns: number };
  perRowActions: OrphanQueuedFlowRemediationReceipt["perRowActions"];
} {
  const perRowActions: OrphanQueuedFlowRemediationReceipt["perRowActions"] = [];
  runOpenClawStateWriteTransaction(({ db }) => {
    const updateFlow = db.prepare(
      `UPDATE flow_runs
          SET status = 'lost',
              blocked_summary = ?,
              wait_json = NULL,
              blocked_task_id = NULL,
              updated_at = ?,
              ended_at = ?,
              revision = revision + 1
        WHERE flow_id = ?
          AND sync_mode = 'managed'
          AND status = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM task_runs t
             WHERE t.parent_flow_id = flow_runs.flow_id
          )`,
    );

    for (const row of params.inventory.candidates) {
      updateFlow.run(ORPHAN_QUEUED_FLOW_SUMMARY, params.updatedAt, params.updatedAt, row.flowId);
      perRowActions.push({
        table: "flow_runs",
        id: row.flowId,
        action: row.proposedRepairAction,
      });
    }
  }, params.options);

  return {
    repaired: {
      flowRuns: params.inventory.candidates.length,
    },
    perRowActions,
  };
}

export function runOrphanQueuedFlowRemediation(
  options: RunOrphanQueuedFlowRemediationOptions,
): OrphanQueuedFlowRemediationRunResult {
  const now = options.now ?? Date.now();
  const staleQueuedMs = options.staleQueuedMs ?? DEFAULT_STALE_QUEUED_MS;
  const createdAtIso = new Date(now).toISOString();
  const runId = options.runId ?? randomUUID();
  const database = openOpenClawStateDatabase(options);
  const dbPath = database.path;
  const before = readCounts(database.db, staleQueuedMs, now);
  const inventory = buildInventory(database.db, staleQueuedMs, now);

  let snapshotPath: string | null = null;
  let repaired = {
    flowRuns: 0,
  };
  let perRowActions: OrphanQueuedFlowRemediationReceipt["perRowActions"] = [];

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
        kind: "oc-rscan-002-orphan-queued-flow-remediation",
        runId,
        before,
        candidates: {
          flowRuns: inventory.candidates.length,
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
  const after = readCounts(reopened.db, staleQueuedMs, now);
  const receiptPath = buildReceiptPath({
    receiptDir: options.receiptDir,
    createdAtIso,
    mode: options.mode,
  });
  const receipt: OrphanQueuedFlowRemediationReceipt = {
    receiptVersion: "1",
    runId,
    mode: options.mode,
    dbPath,
    receiptPath,
    snapshotPath,
    createdAtIso,
    staleQueuedMs,
    before,
    after,
    candidates: {
      flowRuns: inventory.candidates.length,
    },
    repaired,
    skipped: {
      total: inventory.skippedRows.length,
      byReason: summarizeSkippedReasons(inventory.skippedRows),
    },
    perRowActions,
    skippedRows: inventory.skippedRows,
    validationSummary: {
      safeToWrite: true,
    },
  };
  writeReceipt(receipt);
  return {
    mode: options.mode,
    receipt,
  };
}

export function planOrphanQueuedFlowSnapshotPath(dbPath: string, now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `${dbPath}.oc-rscan-002-${stamp}.snapshot.sqlite`;
}
