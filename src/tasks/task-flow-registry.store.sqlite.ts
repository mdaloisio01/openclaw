import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import {
  computeGovernedMissionPackageSha256,
  computeGovernedMissionReceiptSha256,
  computeGovernedTerminalAdmissionPreconditionSha256,
} from "../governance/governed-mission-ledger-integrity.js";
import {
  parseGovernedMissionReceiptRow,
  readValidatedGovernedMissionReceiptChainFromDatabase,
} from "../governance/governed-mission-ledger-sqlite.js";
import {
  GOVERNED_MISSION_RUNTIME_PRODUCER,
  type GovernedMissionArtifactLedgerRecord,
  type GovernedMissionLedgerCommit,
  type GovernedMissionLedgerCommitResult,
  type GovernedMissionLedgerReceipt,
} from "../governance/governed-mission-ledger.types.js";
import {
  governedMissionStateBlocksChildCreation,
  hasGovernedMissionStateValue,
  readGovernedMissionStateFromTaskFlow,
} from "../governance/governed-mission-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  parseTaskFlowRegistryRow,
  type TaskFlowRegistryRow,
} from "./task-flow-registry.sqlite.shared.js";
import type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";
import type { JsonValue, TaskFlowRecord } from "./task-flow-registry.types.js";
import { normalizeSqliteNumber } from "./task-registry.sqlite.shared.js";
import {
  upsertTaskDeliveryStateInTransaction,
  upsertTaskRegistryRecordInTransaction,
} from "./task-registry.store.sqlite.js";

type FlowRunsTable = OpenClawStateKyselyDatabase["flow_runs"];
type FlowRegistryStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "flow_runs" | "governed_mission_artifacts" | "governed_mission_receipts" | "task_runs"
>;

type FlowRegistryDatabase = {
  db: DatabaseSync;
  path: string;
  readOnly: boolean;
};

const cachedDatabases = new Map<string, FlowRegistryDatabase>();
const validatedLedgerHeads = new WeakMap<
  DatabaseSync,
  Map<string, { dataVersion: number; receiptSha256: string; governedPackageSha256: string }>
>();
const MAX_VALIDATED_LEDGER_HEADS = 256;

function sqliteDataVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA data_version").get() as { data_version: number };
  return row.data_version;
}

function rememberValidatedLedgerHead(
  db: DatabaseSync,
  flowId: string,
  receipt: GovernedMissionLedgerReceipt,
): void {
  if (!receipt.receiptSha256 || !receipt.governedPackageSha256) {
    return;
  }
  let cache = validatedLedgerHeads.get(db);
  if (!cache) {
    cache = new Map();
    validatedLedgerHeads.set(db, cache);
  }
  cache.delete(flowId);
  cache.set(flowId, {
    dataVersion: sqliteDataVersion(db),
    receiptSha256: receipt.receiptSha256,
    governedPackageSha256: receipt.governedPackageSha256,
  });
  if (cache.size > MAX_VALIDATED_LEDGER_HEADS) {
    cache.delete(cache.keys().next().value!);
  }
}

function sqliteTableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

function openReadableGovernedLedger(): DatabaseSync | undefined {
  if (!existsSync(resolveOpenClawStateSqlitePath(process.env))) {
    return undefined;
  }
  const { db } = openFlowRegistryDatabase({ readOnly: true });
  return sqliteTableExists(db, "governed_mission_receipts") ? db : undefined;
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function sameGovernedIdempotencyPayload(
  existing: GovernedMissionLedgerReceipt,
  incoming: GovernedMissionLedgerReceipt,
): boolean {
  const existingDetails = parseJsonRecord(existing.details);
  const incomingDetails = parseJsonRecord(incoming.details);
  const existingProductionRequestSha256 = existingDetails?.productionRequestSha256;
  const incomingProductionRequestSha256 = incomingDetails?.productionRequestSha256;
  if (
    typeof existingProductionRequestSha256 === "string" &&
    typeof incomingProductionRequestSha256 === "string"
  ) {
    return existingProductionRequestSha256 === incomingProductionRequestSha256;
  }
  const existingRequestSha256 = existingDetails?.requestSha256;
  const incomingRequestSha256 = incomingDetails?.requestSha256;
  if (typeof existingRequestSha256 === "string" && typeof incomingRequestSha256 === "string") {
    return existingRequestSha256 === incomingRequestSha256;
  }
  return existing.payloadSha256 === incoming.payloadSha256;
}

function parseJsonRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function bindFlowRecord(record: TaskFlowRecord): Insertable<FlowRunsTable> {
  return {
    flow_id: record.flowId,
    sync_mode: record.syncMode,
    shape: null,
    owner_key: record.ownerKey,
    requester_origin_json: serializeJson(record.requesterOrigin),
    controller_id: record.controllerId ?? null,
    revision: record.revision,
    status: record.status,
    notify_policy: record.notifyPolicy,
    goal: record.goal,
    current_step: record.currentStep ?? null,
    blocked_task_id: record.blockedTaskId ?? null,
    blocked_summary: record.blockedSummary ?? null,
    state_json: serializeJson(record.stateJson),
    wait_json: serializeJson(record.waitJson),
    cancel_requested_at: record.cancelRequestedAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ended_at: record.endedAt ?? null,
  };
}

function getFlowRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<FlowRegistryStoreDatabase>(db);
}

function pruneFlowsNotInSnapshot(params: { db: DatabaseSync; ids: readonly string[] }) {
  const tempTableName = "openclaw_live_flow_ids";
  params.db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${tempTableName} (id TEXT PRIMARY KEY)`);
  params.db.exec(`DELETE FROM ${tempTableName}`);
  const insert = params.db.prepare(`INSERT OR IGNORE INTO ${tempTableName} (id) VALUES (?)`);
  for (const id of params.ids) {
    insert.run(id);
  }
  params.db.exec(`
    DELETE FROM flow_runs
    WHERE NOT EXISTS (
      SELECT 1 FROM ${tempTableName}
      WHERE ${tempTableName}.id = flow_runs.flow_id
    )
  `);
  params.db.exec(`DELETE FROM ${tempTableName}`);
}

function selectFlowRows(db: DatabaseSync): TaskFlowRegistryRow[] {
  const query = getFlowRegistryKysely(db)
    .selectFrom("flow_runs")
    .select([
      "flow_id",
      "sync_mode",
      "shape",
      "owner_key",
      "requester_origin_json",
      "controller_id",
      "revision",
      "status",
      "notify_policy",
      "goal",
      "current_step",
      "blocked_task_id",
      "blocked_summary",
      "state_json",
      "wait_json",
      "cancel_requested_at",
      "created_at",
      "updated_at",
      "ended_at",
    ])
    .orderBy("created_at", "asc")
    .orderBy("flow_id", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

function upsertFlowRow(db: DatabaseSync, row: Insertable<FlowRunsTable>): void {
  executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .insertInto("flow_runs")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("flow_id").doUpdateSet({
          sync_mode: (eb) => eb.ref("excluded.sync_mode"),
          owner_key: (eb) => eb.ref("excluded.owner_key"),
          requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
          controller_id: (eb) => eb.ref("excluded.controller_id"),
          revision: (eb) => eb.ref("excluded.revision"),
          status: (eb) => eb.ref("excluded.status"),
          notify_policy: (eb) => eb.ref("excluded.notify_policy"),
          goal: (eb) => eb.ref("excluded.goal"),
          current_step: (eb) => eb.ref("excluded.current_step"),
          blocked_task_id: (eb) => eb.ref("excluded.blocked_task_id"),
          blocked_summary: (eb) => eb.ref("excluded.blocked_summary"),
          state_json: (eb) => eb.ref("excluded.state_json"),
          wait_json: (eb) => eb.ref("excluded.wait_json"),
          cancel_requested_at: (eb) => eb.ref("excluded.cancel_requested_at"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
          ended_at: (eb) => eb.ref("excluded.ended_at"),
        }),
      ),
  );
}

function bindGovernedMissionReceipt(
  receipt: GovernedMissionLedgerReceipt,
): Insertable<OpenClawStateKyselyDatabase["governed_mission_receipts"]> {
  return {
    receipt_id: receipt.receiptId,
    mission_id: receipt.missionId,
    flow_id: receipt.flowId ?? null,
    run_id: receipt.runId ?? null,
    work_order_id: receipt.workOrderId ?? null,
    gate_id: receipt.gateId ?? null,
    attempt_id: receipt.attemptId ?? null,
    operation: receipt.operation,
    receipt_kind: receipt.receiptKind,
    from_state: receipt.fromState ?? null,
    to_state: receipt.toState ?? null,
    decision: receipt.decision,
    reason_code: receipt.reasonCode,
    expected_revision: receipt.expectedRevision ?? null,
    resulting_revision: receipt.resultingRevision ?? null,
    contract_id: receipt.contractId ?? null,
    contract_hash: receipt.contractHash ?? null,
    authority_hash: receipt.authorityHash ?? null,
    plan_revision_id: receipt.planRevisionId ?? null,
    source_revision: receipt.sourceRevision ?? null,
    runtime_build_sha256: receipt.runtimeBuildSha256 ?? null,
    policy_version: receipt.policyVersion ?? null,
    skill_sha256: receipt.skillSha256 ?? null,
    payload_sha256: receipt.payloadSha256,
    contract_receipt_kinds_json: receipt.contractReceiptKinds
      ? JSON.stringify(receipt.contractReceiptKinds)
      : null,
    ledger_sequence: receipt.ledgerSequence ?? null,
    previous_receipt_sha256: receipt.previousReceiptSha256 ?? null,
    governed_package_sha256: receipt.governedPackageSha256 ?? null,
    receipt_sha256: receipt.receiptSha256 ?? null,
    producer: receipt.producer,
    idempotency_key: receipt.idempotencyKey,
    details_json: JSON.stringify(receipt.details),
    created_at: receipt.createdAt,
  };
}

function bindGovernedMissionArtifact(
  artifact: GovernedMissionArtifactLedgerRecord,
): Insertable<OpenClawStateKyselyDatabase["governed_mission_artifacts"]> {
  return {
    verification_id: artifact.verificationId,
    receipt_id: artifact.receiptId,
    mission_id: artifact.missionId,
    flow_id: artifact.flowId ?? null,
    work_order_id: artifact.workOrderId ?? null,
    gate_id: artifact.gateId ?? null,
    logical_artifact_id: artifact.logicalArtifactId,
    artifact_kind: artifact.artifactKind,
    locator: artifact.locator,
    status: artifact.status,
    failure_code: artifact.failureCode ?? null,
    size_bytes: artifact.sizeBytes ?? null,
    computed_sha256: artifact.computedSha256 ?? null,
    expected_sha256: artifact.expectedSha256 ?? null,
    expected_labels_json: JSON.stringify(artifact.expectedLabels),
    identity_bindings_json: JSON.stringify(artifact.identityBindings),
    verifier_version: artifact.verifierVersion,
    verified_at: artifact.verifiedAt,
  };
}

function openFlowRegistryDatabase(
  options: { readOnly?: boolean; path?: string } = {},
): FlowRegistryDatabase {
  const database = options.readOnly
    ? openOpenClawStateDatabase({ readOnly: true, ...(options.path ? { path: options.path } : {}) })
    : openOpenClawStateDatabase(options.path ? { path: options.path } : undefined);
  const pathname = database.path;
  const readOnly = options.readOnly === true;
  const cacheKey = `${pathname}\0${readOnly ? "readonly" : "readwrite"}`;
  const cachedDatabase = cachedDatabases.get(cacheKey);
  if (cachedDatabase?.db.isOpen) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabases.delete(cacheKey);
  }
  const flowDatabase = {
    db: database.db,
    path: pathname,
    readOnly,
  };
  cachedDatabases.set(cacheKey, flowDatabase);
  return flowDatabase;
}

function withWriteTransaction(
  write: (database: FlowRegistryDatabase) => void,
  options: { path?: string } = {},
) {
  const database = openFlowRegistryDatabase(options);
  runOpenClawStateWriteTransaction(
    () => {
      write(database);
    },
    options.path ? { path: options.path } : undefined,
  );
}

export function loadTaskFlowRegistryStateFromSqlite(): TaskFlowRegistryStoreSnapshot {
  const { db } = openFlowRegistryDatabase({ readOnly: true });
  const rows = selectFlowRows(db);
  return {
    flows: new Map(rows.map((row) => [row.flow_id, parseTaskFlowRegistryRow(row)])),
  };
}

export function saveTaskFlowRegistryStateToSqlite(snapshot: TaskFlowRegistryStoreSnapshot) {
  withWriteTransaction(({ db }) => {
    const kysely = getFlowRegistryKysely(db);
    const flowIds = [...snapshot.flows.keys()];
    if (flowIds.length === 0) {
      executeSqliteQuerySync(db, kysely.deleteFrom("flow_runs"));
      return;
    }
    pruneFlowsNotInSnapshot({ db, ids: flowIds });
    for (const flow of snapshot.flows.values()) {
      upsertFlowRow(db, bindFlowRecord(flow));
    }
  });
}

export function upsertTaskFlowRegistryRecordToSqlite(flow: TaskFlowRecord) {
  withWriteTransaction(({ db }) => {
    upsertFlowRow(db, bindFlowRecord(flow));
  });
}

export function deleteTaskFlowRegistryRecordFromSqlite(flowId: string) {
  withWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getFlowRegistryKysely(db).deleteFrom("flow_runs").where("flow_id", "=", flowId),
    );
  });
}

export function commitGovernedMissionLedgerToSqlite(
  commit: GovernedMissionLedgerCommit,
  options: { path?: string } = {},
): GovernedMissionLedgerCommitResult {
  let result: GovernedMissionLedgerCommitResult | undefined;
  withWriteTransaction(({ db }) => {
    const kysely = getFlowRegistryKysely(db);
    const existing = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("governed_mission_receipts")
        .selectAll()
        .where("mission_id", "=", commit.receipt.missionId)
        .where("idempotency_key", "=", commit.receipt.idempotencyKey),
    ).rows[0];
    if (existing) {
      const receipt = parseGovernedMissionReceiptRow(existing);
      result = {
        status: sameGovernedIdempotencyPayload(receipt, commit.receipt)
          ? "already_applied"
          : "idempotency_conflict",
        receipt,
      };
      return;
    }

    if (commit.receipt.operation === "admitMission" && commit.receipt.decision === "applied") {
      const existingAdmission = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("governed_mission_receipts")
          .selectAll()
          .where("mission_id", "=", commit.receipt.missionId)
          .where("operation", "=", "admitMission")
          .where("decision", "=", "applied")
          .limit(1),
      ).rows[0];
      if (existingAdmission) {
        const receipt = parseGovernedMissionReceiptRow(existingAdmission);
        result = {
          status:
            receipt.payloadSha256 === commit.receipt.payloadSha256
              ? "already_applied"
              : "mission_conflict",
          receipt,
        };
        return;
      }
    }

    if (commit.expectedFlowRevision !== undefined && commit.receipt.flowId) {
      const currentFlow = selectFlowRecordById(db, commit.receipt.flowId);
      if (currentFlow?.revision !== commit.expectedFlowRevision) {
        result = { status: "revision_conflict", currentRevision: currentFlow?.revision };
        return;
      }
    }

    if (commit.nextFlow) {
      if (commit.governedOwnerClaimKey) {
        const existingOwnerClaim = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("flow_runs")
            .innerJoin(
              "governed_mission_receipts",
              "governed_mission_receipts.flow_id",
              "flow_runs.flow_id",
            )
            .selectAll("governed_mission_receipts")
            .select("flow_runs.flow_id as claimed_flow_id")
            .where("flow_runs.owner_key", "=", commit.governedOwnerClaimKey)
            .where("flow_runs.flow_id", "!=", commit.nextFlow.flowId)
            .where("governed_mission_receipts.operation", "=", "admitMission")
            .where("governed_mission_receipts.decision", "=", "applied")
            .limit(1),
        ).rows[0];
        // Admission and the owner claim share this write transaction. Terminal
        // claims remain exclusive so a later run cannot resolve two missions.
        if (existingOwnerClaim) {
          const receipt = parseGovernedMissionReceiptRow(existingOwnerClaim);
          result = {
            status: "owner_conflict",
            flowId: existingOwnerClaim.claimed_flow_id,
            receipt,
          };
          return;
        }
      }
      const current = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("flow_runs")
          .select("revision")
          .where("flow_id", "=", commit.nextFlow.flowId),
      ).rows[0];
      const currentRevision = current ? normalizeSqliteNumber(current.revision) : undefined;
      const expectedFlowRevision = commit.nextFlow.revision - 1;
      if (currentRevision !== undefined && currentRevision !== expectedFlowRevision) {
        result = { status: "revision_conflict", currentRevision };
        return;
      }
      if (currentRevision === undefined && commit.nextFlow.revision !== 0) {
        result = { status: "revision_conflict" };
        return;
      }
    }

    if (
      !commit.nextFlow &&
      commit.receipt.producer === GOVERNED_MISSION_RUNTIME_PRODUCER &&
      commit.receipt.operation === "authorizeToolCall" &&
      commit.receipt.flowId &&
      commit.receipt.expectedRevision !== undefined
    ) {
      const currentFlow = selectFlowRecordById(db, commit.receipt.flowId);
      const currentRevision = currentFlow
        ? readGovernedMissionStateFromTaskFlow(currentFlow)?.revision
        : undefined;
      if (currentRevision !== commit.receipt.expectedRevision) {
        result = { status: "revision_conflict", currentRevision };
        return;
      }
    }

    if (
      commit.requireNoActiveTasks === true &&
      commit.receipt.decision === "applied" &&
      commit.receipt.flowId
    ) {
      const activeTask = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("task_runs")
          .select("task_id")
          .where("parent_flow_id", "=", commit.receipt.flowId)
          .where("status", "in", ["queued", "running"])
          .limit(1),
      ).rows[0];
      // This transaction serializes terminalization with child creation.
      // A direct cancel or stop cannot strand work behind a terminal parent.
      if (activeTask) {
        result = { status: "revision_conflict", reason: "active_work" };
        return;
      }
    }

    if (
      commit.receipt.operation === "admitTerminalPendingWatchdog" &&
      commit.receipt.decision === "applied" &&
      commit.receipt.flowId
    ) {
      const currentFlow = selectFlowRecordById(db, commit.receipt.flowId);
      const activeTask = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("task_runs")
          .select("task_id")
          .where("parent_flow_id", "=", commit.receipt.flowId)
          .where("status", "in", ["queued", "running"])
          .limit(1),
      ).rows[0];
      // This transaction serializes the final active-work check with child creation.
      // A stale zero-count observation cannot cross the closeout fence.
      if (
        !currentFlow ||
        !governedMissionStateBlocksChildCreation(currentFlow.stateJson) ||
        !commit.terminalAdmissionPreconditionSha256 ||
        computeGovernedTerminalAdmissionPreconditionSha256(currentFlow) !==
          commit.terminalAdmissionPreconditionSha256 ||
        activeTask
      ) {
        result = { status: "revision_conflict", reason: "active_work" };
        return;
      }
    }

    let persistedReceipt = commit.receipt;
    if (commit.receipt.producer === GOVERNED_MISSION_RUNTIME_PRODUCER && commit.receipt.flowId) {
      const currentFlow = selectFlowRecordById(db, commit.receipt.flowId);
      const previous = readGovernedMissionReceiptHeadFromDatabase(db, commit.receipt.flowId);
      if (commit.receipt.operation !== "admitMission") {
        // Validate the whole chain inside the write transaction. Cancellation
        // can enter here without a prior provenance check, and only a validated
        // append may advance the trusted ledger-head cache.
        const validatedChain = currentFlow
          ? readValidatedGovernedMissionReceiptChainFromDatabase(db, {
              flow: currentFlow,
              missionId: commit.receipt.missionId,
            })
          : undefined;
        const trustedHead =
          currentFlow &&
          previous &&
          validatedChain?.at(-1)?.receiptSha256 === previous.receiptSha256 &&
          previous.missionId === commit.receipt.missionId &&
          previous.ledgerSequence !== undefined &&
          previous.ledgerSequence > 0 &&
          previous.receiptSha256 &&
          previous.receiptSha256 === computeGovernedMissionReceiptSha256(previous) &&
          previous.governedPackageSha256 === computeGovernedMissionPackageSha256(currentFlow);
        if (!trustedHead) {
          result = { status: "revision_conflict", reason: "untrusted_state" };
          return;
        }
      }
      const packageFlow = commit.nextFlow ?? currentFlow;
      if (!packageFlow) {
        result = { status: "revision_conflict" };
        return;
      }
      persistedReceipt = {
        ...commit.receipt,
        ledgerSequence: (previous?.ledgerSequence ?? 0) + 1,
        ...(previous?.receiptSha256 ? { previousReceiptSha256: previous.receiptSha256 } : {}),
        governedPackageSha256: computeGovernedMissionPackageSha256(packageFlow),
      };
      persistedReceipt = {
        ...persistedReceipt,
        receiptSha256: computeGovernedMissionReceiptSha256(persistedReceipt),
      };
    }

    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("governed_mission_receipts")
        .values(bindGovernedMissionReceipt(persistedReceipt)),
    );
    for (const artifact of commit.artifacts ?? []) {
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("governed_mission_artifacts")
          .values(bindGovernedMissionArtifact(artifact)),
      );
    }
    if (commit.nextFlow) {
      upsertFlowRow(db, bindFlowRecord(commit.nextFlow));
    }
    if (commit.taskUpdate) {
      upsertTaskRegistryRecordInTransaction(db, commit.taskUpdate);
    }
    if (commit.taskDeliveryState) {
      if (commit.taskDeliveryState.taskId !== commit.taskUpdate?.taskId) {
        throw new Error("governed task delivery state requires its matching task update");
      }
      upsertTaskDeliveryStateInTransaction(db, commit.taskDeliveryState);
    }
    result = { status: "inserted", receipt: persistedReceipt };
  }, options);
  if (!result) {
    throw new Error("governed mission ledger transaction completed without a result");
  }
  if (result.status === "inserted" && result.receipt.flowId && result.receipt.receiptSha256) {
    const readable = openReadableGovernedLedger();
    if (readable) {
      rememberValidatedLedgerHead(readable, result.receipt.flowId, result.receipt);
    }
  }
  return result;
}

function selectFlowRecordById(db: DatabaseSync, flowId: string): TaskFlowRecord | undefined {
  const row = executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db).selectFrom("flow_runs").selectAll().where("flow_id", "=", flowId),
  ).rows[0];
  return row ? parseTaskFlowRegistryRow(row as TaskFlowRegistryRow) : undefined;
}

export function listGovernedMissionReceiptsFromSqlite(params: {
  flowId: string;
  limit: number;
}): GovernedMissionLedgerReceipt[] {
  const db = openReadableGovernedLedger();
  if (!db) {
    return [];
  }
  const rows = executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .selectFrom("governed_mission_receipts")
      .selectAll()
      .where("flow_id", "=", params.flowId)
      .orderBy("created_at", "desc")
      .orderBy("receipt_id", "desc")
      .limit(Math.max(1, Math.min(Math.trunc(params.limit), 500))),
  ).rows;
  return rows.map((row) => parseGovernedMissionReceiptRow(row));
}

export function findAppliedGovernedAdmissionByMissionFromSqlite(
  missionId: string,
): GovernedMissionLedgerReceipt | undefined {
  const db = openReadableGovernedLedger();
  if (!db) {
    return undefined;
  }
  const row = executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .selectFrom("governed_mission_receipts")
      .selectAll()
      .where("mission_id", "=", missionId)
      .where("operation", "=", "admitMission")
      .where("decision", "=", "applied")
      .limit(1),
  ).rows[0];
  return row ? parseGovernedMissionReceiptRow(row) : undefined;
}

export function hasGovernedMissionRepairReceiptFromSqlite(params: {
  flowId: string;
  resultingRevision: number;
}): boolean {
  const db = openReadableGovernedLedger();
  if (!db) {
    return false;
  }
  return Boolean(
    executeSqliteQuerySync(
      db,
      getFlowRegistryKysely(db)
        .selectFrom("governed_mission_receipts")
        .select("receipt_id")
        .where("flow_id", "=", params.flowId)
        .where("decision", "=", "repair_required")
        .where("resulting_revision", "=", params.resultingRevision)
        .limit(1),
    ).rows[0],
  );
}

export function hasCanonicalGovernedMissionProvenanceFromSqlite(params: {
  flow: TaskFlowRecord;
  missionId: string;
}): boolean {
  const db = openReadableGovernedLedger();
  if (!db) {
    return false;
  }
  const head = readGovernedMissionReceiptHeadFromDatabase(db, params.flow.flowId);
  const packageSha256 = computeGovernedMissionPackageSha256(params.flow);
  if (
    !head ||
    head.missionId !== params.missionId ||
    !head.receiptSha256 ||
    head.receiptSha256 !== computeGovernedMissionReceiptSha256(head) ||
    head.governedPackageSha256 !== packageSha256
  ) {
    return false;
  }
  const cached = validatedLedgerHeads.get(db)?.get(params.flow.flowId);
  // A changed SQLite data_version can include external receipt edits. Recheck
  // the whole chain then; ordinary appends advance the trusted head below.
  if (
    cached?.dataVersion === sqliteDataVersion(db) &&
    cached.receiptSha256 === head.receiptSha256 &&
    cached.governedPackageSha256 === packageSha256
  ) {
    return true;
  }
  const chain = readValidatedGovernedMissionReceiptChainFromDatabase(db, params);
  if (!chain) {
    return false;
  }
  rememberValidatedLedgerHead(db, params.flow.flowId, head);
  return true;
}

function readGovernedMissionReceiptHeadFromDatabase(
  db: DatabaseSync,
  flowId: string,
): GovernedMissionLedgerReceipt | undefined {
  const row = executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .selectFrom("governed_mission_receipts")
      .selectAll()
      .where("flow_id", "=", flowId)
      .where("producer", "=", GOVERNED_MISSION_RUNTIME_PRODUCER)
      .where("ledger_sequence", "is not", null)
      .orderBy("ledger_sequence", "desc")
      .limit(1),
  ).rows[0];
  return row ? parseGovernedMissionReceiptRow(row) : undefined;
}

function readValidatedGovernedMissionReceiptChainFromSqlite(params: {
  flow: TaskFlowRecord;
  missionId: string;
}): GovernedMissionLedgerReceipt[] | undefined {
  const db = openReadableGovernedLedger();
  if (!db) {
    return undefined;
  }
  return readValidatedGovernedMissionReceiptChainFromDatabase(db, params);
}

export function listAppliedGovernedMissionContractReceiptsFromSqlite(params: {
  flow: TaskFlowRecord;
  missionId: string;
}): GovernedMissionLedgerReceipt[] {
  const receipts = readValidatedGovernedMissionReceiptChainFromSqlite(params);
  return (receipts ?? []).filter(
    (receipt) => receipt.decision === "applied" && (receipt.contractReceiptKinds?.length ?? 0) > 0,
  );
}

export function listGovernedMissionOwnerClaimFlowIdsFromSqlite(ownerKey: string): string[] {
  const normalizedOwnerKey = ownerKey.trim();
  const db = normalizedOwnerKey ? openReadableGovernedLedger() : undefined;
  if (!db) {
    return [];
  }
  const rows = executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .selectFrom("flow_runs")
      .innerJoin(
        "governed_mission_receipts",
        "governed_mission_receipts.flow_id",
        "flow_runs.flow_id",
      )
      .select("flow_runs.flow_id as flow_id")
      .where("flow_runs.owner_key", "=", normalizedOwnerKey)
      .where("governed_mission_receipts.operation", "=", "admitMission")
      .where("governed_mission_receipts.decision", "=", "applied")
      .where("governed_mission_receipts.producer", "=", GOVERNED_MISSION_RUNTIME_PRODUCER)
      .orderBy("flow_runs.flow_id", "asc"),
  ).rows;
  return [...new Set(rows.map((row) => row.flow_id))];
}

export function hasAppliedGovernedMissionClaimForFlowIdFromSqlite(flowId: string): boolean {
  const normalizedFlowId = flowId.trim();
  const db = normalizedFlowId ? openReadableGovernedLedger() : undefined;
  if (!db) {
    return false;
  }
  return Boolean(
    executeSqliteQuerySync(
      db,
      getFlowRegistryKysely(db)
        .selectFrom("governed_mission_receipts")
        .select("receipt_id")
        .where("flow_id", "=", normalizedFlowId)
        .where("operation", "=", "admitMission")
        .where("decision", "=", "applied")
        .where("producer", "=", GOVERNED_MISSION_RUNTIME_PRODUCER)
        .limit(1),
    ).rows[0],
  );
}

export function hasGovernedMissionClaimForFlow(flow: TaskFlowRecord): boolean {
  return (
    hasGovernedMissionStateValue(flow) ||
    hasAppliedGovernedMissionClaimForFlowIdFromSqlite(flow.flowId)
  );
}

export function findValidatedGovernedMissionReceiptByIdempotencyFromSqlite(params: {
  flow: TaskFlowRecord;
  missionId: string;
  idempotencyKey: string;
}): GovernedMissionLedgerReceipt | undefined {
  return readValidatedGovernedMissionReceiptChainFromSqlite(params)?.find(
    (receipt) => receipt.idempotencyKey === params.idempotencyKey,
  );
}

export function findGovernedMissionReceiptByIdempotencyFromSqlite(params: {
  missionId: string;
  idempotencyKey: string;
}): GovernedMissionLedgerReceipt | undefined {
  const db = openReadableGovernedLedger();
  if (!db) {
    return undefined;
  }
  const row = executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .selectFrom("governed_mission_receipts")
      .selectAll()
      .where("mission_id", "=", params.missionId)
      .where("idempotency_key", "=", params.idempotencyKey),
  ).rows[0];
  return row ? parseGovernedMissionReceiptRow(row) : undefined;
}

export function findGovernedMissionReceiptByIdFromSqlite(
  receiptId: string,
): GovernedMissionLedgerReceipt | undefined {
  const db = openReadableGovernedLedger();
  if (!db) {
    return undefined;
  }
  const row = executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .selectFrom("governed_mission_receipts")
      .selectAll()
      .where("receipt_id", "=", receiptId),
  ).rows[0];
  return row ? parseGovernedMissionReceiptRow(row) : undefined;
}

export function findLatestAppliedGovernedMissionOperationReceiptFromSqlite(params: {
  flowId: string;
  operation: string;
  contractHash: string;
}): GovernedMissionLedgerReceipt | undefined {
  const db = openReadableGovernedLedger();
  if (!db) {
    return undefined;
  }
  const row = executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .selectFrom("governed_mission_receipts")
      .selectAll()
      .where("flow_id", "=", params.flowId)
      .where("operation", "=", params.operation)
      .where("decision", "=", "applied")
      .where("contract_hash", "=", params.contractHash)
      .orderBy("resulting_revision", "desc")
      .orderBy("created_at", "desc")
      .orderBy("receipt_id", "desc")
      .limit(1),
  ).rows[0];
  return row ? parseGovernedMissionReceiptRow(row) : undefined;
}

export function findCurrentGovernedExecutionAttemptFromSqlite(params: {
  flowId: string;
  contractHash: string;
}): GovernedMissionLedgerReceipt | undefined {
  const attempt = findLatestAppliedGovernedMissionOperationReceiptFromSqlite({
    ...params,
    operation: "openExecutionLease",
  });
  if (!attempt) {
    return undefined;
  }
  const readmission = findLatestAppliedGovernedMissionOperationReceiptFromSqlite({
    ...params,
    operation: "requestReadmission",
  });
  // A replacement may retain the contract hash; only a lease opened after
  // that readmission belongs to the current mission identity.
  return readmission &&
    (attempt.resultingRevision === undefined ||
      readmission.resultingRevision === undefined ||
      attempt.resultingRevision <= readmission.resultingRevision)
    ? undefined
    : attempt;
}

export function closeTaskFlowRegistryDatabase() {
  cachedDatabases.clear();
  closeOpenClawStateDatabase();
}
