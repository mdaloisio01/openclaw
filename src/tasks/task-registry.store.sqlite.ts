import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { readValidatedGovernedMissionReceiptChainFromDatabase } from "../governance/governed-mission-ledger-sqlite.js";
import { GOVERNED_MISSION_RUNTIME_PRODUCER } from "../governance/governed-mission-ledger.types.js";
import {
  governedMissionStateBlocksChildCreation,
  readGovernedMissionStateFromTaskFlow,
} from "../governance/governed-mission-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { isRecord } from "../utils.js";
import {
  parseTaskFlowRegistryRow,
  type TaskFlowRegistryRow,
} from "./task-flow-registry.sqlite.shared.js";
import { parseTaskFlowStatus, type JsonValue } from "./task-flow-registry.types.js";
import { ParentFlowLinkError } from "./task-parent-flow-link-error.js";
import { parseDeliveryContextJson } from "./task-registry.sqlite.shared.js";
import type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";
import {
  parseOptionalTaskMissionState,
  parseOptionalTaskTerminalOutcome,
  parseTaskDeliveryStatus,
  parseTaskNotifyPolicy,
  parseTaskRuntime,
  parseTaskScopeKind,
  parseTaskStatus,
  type TaskDeliveryState,
  type TaskRecord,
} from "./task-registry.types.js";

type TaskRunsTable = OpenClawStateKyselyDatabase["task_runs"];
type TaskDeliveryStateTable = OpenClawStateKyselyDatabase["task_delivery_state"];
type TaskRegistryStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "flow_runs" | "governed_mission_receipts" | "task_delivery_state" | "task_runs"
>;

type TaskRegistryRow = Selectable<TaskRunsTable> & {
  runtime: string;
  scope_kind: string;
  status: string;
  delivery_status: string;
  notify_policy: string;
  mission_state: string | null;
  terminal_outcome: string | null;
};

type TaskDeliveryStateRow = Selectable<TaskDeliveryStateTable>;

type TaskRegistryDatabase = {
  db: DatabaseSync;
  path: string;
  readOnly: boolean;
};

const TASK_RUN_SELECT_COLUMNS = [
  "task_id",
  "runtime",
  "task_kind",
  "source_id",
  "requester_session_key",
  "owner_key",
  "scope_kind",
  "child_session_key",
  "parent_flow_id",
  "parent_task_id",
  "agent_id",
  "run_id",
  "label",
  "task",
  "mission_id",
  "mission_summary",
  "mission_state",
  "status",
  "delivery_status",
  "notify_policy",
  "created_at",
  "started_at",
  "ended_at",
  "last_event_at",
  "cleanup_after",
  "error",
  "progress_summary",
  "mission_updated_at",
  "terminal_summary",
  "terminal_outcome",
] as const;

const cachedDatabases = new Map<string, TaskRegistryDatabase>();

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function rowToTaskRecord(row: TaskRegistryRow): TaskRecord {
  const startedAt = normalizeNumber(row.started_at);
  const endedAt = normalizeNumber(row.ended_at);
  const lastEventAt = normalizeNumber(row.last_event_at);
  const cleanupAfter = normalizeNumber(row.cleanup_after);
  const missionUpdatedAt = normalizeNumber(row.mission_updated_at);
  const scopeKind = parseTaskScopeKind(row.scope_kind);
  const missionState = parseOptionalTaskMissionState(row.mission_state);
  const terminalOutcome = parseOptionalTaskTerminalOutcome(row.terminal_outcome);
  const requesterSessionKey =
    scopeKind === "system" ? "" : row.requester_session_key?.trim() || row.owner_key;
  return {
    taskId: row.task_id,
    runtime: parseTaskRuntime(row.runtime),
    ...(row.task_kind ? { taskKind: row.task_kind } : {}),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    requesterSessionKey,
    ownerKey: row.owner_key,
    scopeKind,
    ...(row.child_session_key ? { childSessionKey: row.child_session_key } : {}),
    ...(row.parent_flow_id ? { parentFlowId: row.parent_flow_id } : {}),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    task: row.task,
    status: parseTaskStatus(row.status),
    deliveryStatus: parseTaskDeliveryStatus(row.delivery_status),
    notifyPolicy: parseTaskNotifyPolicy(row.notify_policy),
    createdAt: normalizeNumber(row.created_at) ?? 0,
    ...(startedAt != null ? { startedAt } : {}),
    ...(endedAt != null ? { endedAt } : {}),
    ...(lastEventAt != null ? { lastEventAt } : {}),
    ...(cleanupAfter != null ? { cleanupAfter } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.progress_summary ? { progressSummary: row.progress_summary } : {}),
    ...(row.mission_id ? { missionId: row.mission_id } : {}),
    ...(row.mission_summary ? { missionSummary: row.mission_summary } : {}),
    ...(missionState ? { missionState } : {}),
    ...(missionUpdatedAt != null ? { missionUpdatedAt } : {}),
    ...(row.terminal_summary ? { terminalSummary: row.terminal_summary } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
  };
}

function rowToTaskDeliveryState(row: TaskDeliveryStateRow): TaskDeliveryState {
  const requesterOrigin = parseDeliveryContextJson(row.requester_origin_json);
  const lastNotifiedEventAt = normalizeNumber(row.last_notified_event_at);
  return {
    taskId: row.task_id,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(lastNotifiedEventAt != null ? { lastNotifiedEventAt } : {}),
  };
}

function bindTaskRecordBase(record: TaskRecord): Insertable<TaskRunsTable> {
  return {
    task_id: record.taskId,
    runtime: record.runtime,
    task_kind: record.taskKind ?? null,
    source_id: record.sourceId ?? null,
    requester_session_key: record.scopeKind === "system" ? "" : record.requesterSessionKey,
    owner_key: record.ownerKey,
    scope_kind: record.scopeKind,
    child_session_key: record.childSessionKey ?? null,
    parent_flow_id: record.parentFlowId ?? null,
    parent_task_id: record.parentTaskId ?? null,
    agent_id: record.agentId ?? null,
    run_id: record.runId ?? null,
    label: record.label ?? null,
    task: record.task,
    mission_id: record.missionId ?? null,
    mission_summary: record.missionSummary ?? null,
    mission_state: record.missionState ?? null,
    status: record.status,
    delivery_status: record.deliveryStatus,
    notify_policy: record.notifyPolicy,
    created_at: record.createdAt,
    started_at: record.startedAt ?? null,
    ended_at: record.endedAt ?? null,
    last_event_at: record.lastEventAt ?? null,
    cleanup_after: record.cleanupAfter ?? null,
    error: record.error ?? null,
    progress_summary: record.progressSummary ?? null,
    mission_updated_at: record.missionUpdatedAt ?? null,
    terminal_summary: record.terminalSummary ?? null,
    terminal_outcome: record.terminalOutcome ?? null,
  };
}

function bindTaskDeliveryState(state: TaskDeliveryState): Insertable<TaskDeliveryStateTable> {
  return {
    task_id: state.taskId,
    requester_origin_json: serializeJson(state.requesterOrigin),
    last_notified_event_at: state.lastNotifiedEventAt ?? null,
  };
}

function getTaskRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TaskRegistryStoreDatabase>(db);
}

function pruneRowsNotInSnapshot(params: {
  db: DatabaseSync;
  tableName: "task_delivery_state" | "task_runs";
  columnName: "task_id";
  tempTableName: string;
  ids: readonly string[];
}) {
  params.db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${params.tempTableName} (id TEXT PRIMARY KEY)`);
  params.db.exec(`DELETE FROM ${params.tempTableName}`);
  const insert = params.db.prepare(`INSERT OR IGNORE INTO ${params.tempTableName} (id) VALUES (?)`);
  for (const id of params.ids) {
    insert.run(id);
  }
  params.db.exec(`
    DELETE FROM ${params.tableName}
    WHERE NOT EXISTS (
      SELECT 1 FROM ${params.tempTableName}
      WHERE ${params.tempTableName}.id = ${params.tableName}.${params.columnName}
    )
  `);
  params.db.exec(`DELETE FROM ${params.tempTableName}`);
}

function selectTaskRows(db: DatabaseSync): TaskRegistryRow[] {
  const query = getTaskRegistryKysely(db)
    .selectFrom("task_runs")
    .select(TASK_RUN_SELECT_COLUMNS)
    .orderBy("created_at", "asc")
    .orderBy("task_id", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

function selectTaskDeliveryStateRows(db: DatabaseSync): TaskDeliveryStateRow[] {
  const query = getTaskRegistryKysely(db)
    .selectFrom("task_delivery_state")
    .select(["task_id", "requester_origin_json", "last_notified_event_at"])
    .orderBy("task_id", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

function upsertTaskRow(db: DatabaseSync, row: Insertable<TaskRunsTable>): void {
  executeSqliteQuerySync(
    db,
    getTaskRegistryKysely(db)
      .insertInto("task_runs")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("task_id").doUpdateSet({
          runtime: (eb) => eb.ref("excluded.runtime"),
          task_kind: (eb) => eb.ref("excluded.task_kind"),
          source_id: (eb) => eb.ref("excluded.source_id"),
          requester_session_key: (eb) => eb.ref("excluded.requester_session_key"),
          owner_key: (eb) => eb.ref("excluded.owner_key"),
          scope_kind: (eb) => eb.ref("excluded.scope_kind"),
          child_session_key: (eb) => eb.ref("excluded.child_session_key"),
          parent_flow_id: (eb) => eb.ref("excluded.parent_flow_id"),
          parent_task_id: (eb) => eb.ref("excluded.parent_task_id"),
          agent_id: (eb) => eb.ref("excluded.agent_id"),
          run_id: (eb) => eb.ref("excluded.run_id"),
          label: (eb) => eb.ref("excluded.label"),
          task: (eb) => eb.ref("excluded.task"),
          mission_id: (eb) => eb.ref("excluded.mission_id"),
          mission_summary: (eb) => eb.ref("excluded.mission_summary"),
          mission_state: (eb) => eb.ref("excluded.mission_state"),
          status: (eb) => eb.ref("excluded.status"),
          delivery_status: (eb) => eb.ref("excluded.delivery_status"),
          notify_policy: (eb) => eb.ref("excluded.notify_policy"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          started_at: (eb) => eb.ref("excluded.started_at"),
          ended_at: (eb) => eb.ref("excluded.ended_at"),
          last_event_at: (eb) => eb.ref("excluded.last_event_at"),
          cleanup_after: (eb) => eb.ref("excluded.cleanup_after"),
          error: (eb) => eb.ref("excluded.error"),
          progress_summary: (eb) => eb.ref("excluded.progress_summary"),
          mission_updated_at: (eb) => eb.ref("excluded.mission_updated_at"),
          terminal_summary: (eb) => eb.ref("excluded.terminal_summary"),
          terminal_outcome: (eb) => eb.ref("excluded.terminal_outcome"),
        }),
      ),
  );
}

function assertGovernedChildCompletionCompatible(db: DatabaseSync, task: TaskRecord): void {
  const kysely = getTaskRegistryKysely(db);
  const persistedTask = executeSqliteQuerySync(
    db,
    kysely.selectFrom("task_runs").select("parent_flow_id").where("task_id", "=", task.taskId),
  ).rows[0];
  const flowId = persistedTask?.parent_flow_id?.trim() || task.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  const receiptId = `child-completion:${flowId}:${task.taskId}`;
  const row = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("governed_mission_receipts")
      .select("receipt_id")
      .where("receipt_id", "=", receiptId),
  ).rows[0];
  if (!row) {
    return;
  }
  const flowRow = executeSqliteQuerySync(
    db,
    kysely.selectFrom("flow_runs").selectAll().where("flow_id", "=", flowId),
  ).rows[0];
  if (!flowRow) {
    throw new Error(`Governed child completion flow is missing: ${flowId}`);
  }
  const flow = parseTaskFlowRegistryRow(flowRow as TaskFlowRegistryRow);
  const mission = readGovernedMissionStateFromTaskFlow(flow);
  const receipt = mission
    ? readValidatedGovernedMissionReceiptChainFromDatabase(db, {
        flow,
        missionId: mission.missionId,
      })?.find((candidate) => candidate.receiptId === receiptId)
    : undefined;
  if (!receipt) {
    throw new Error(`Governed child completion ledger is malformed: ${receiptId}`);
  }
  const details = isRecord(receipt.details) ? receipt.details : undefined;
  const completionReasonMatches =
    (receipt.operation === "completeGovernedChildTask" &&
      receipt.reasonCode === "GOVERNED_CHILD_TASK_COMPLETED") ||
    (receipt.operation === "recordNextExecutableLaunch" &&
      receipt.reasonCode === "NEXT_EXECUTABLE_UNIT_LAUNCHED");
  const canonical =
    receipt.receiptId === receiptId &&
    receipt.flowId === flowId &&
    receipt.producer === GOVERNED_MISSION_RUNTIME_PRODUCER &&
    receipt.receiptKind === "transition" &&
    receipt.decision === "applied" &&
    completionReasonMatches &&
    receipt.idempotencyKey === `child-completion:${task.taskId}` &&
    receipt.ledgerSequence !== undefined &&
    receipt.ledgerSequence > 1 &&
    details?.taskId === task.taskId &&
    details.runId === receipt.runId;
  if (!canonical) {
    throw new Error(`Governed child completion receipt is malformed: ${receiptId}`);
  }
  const completionMatches =
    task.parentFlowId?.trim() === flowId &&
    task.status === "succeeded" &&
    task.deliveryStatus === "delivered" &&
    task.runId === receipt.runId &&
    (task.progressSummary ?? null) === (details.progressSummary ?? null) &&
    (task.terminalSummary ?? null) === (details.terminalSummary ?? null);
  // The receipt and task success are committed together. Later writers may update
  // unrelated metadata, but cannot contradict the proof-bearing completion facts.
  if (!completionMatches) {
    throw new Error(`Governed child completion is immutable: ${task.taskId}`);
  }
}

export function upsertTaskRegistryRecordInTransaction(db: DatabaseSync, task: TaskRecord): void {
  assertPersistedParentFlowLinkAllowed(db, task);
  assertGovernedChildCompletionCompatible(db, task);
  upsertTaskRow(db, bindTaskRecordBase(task));
}

export function upsertTaskDeliveryStateInTransaction(
  db: DatabaseSync,
  state: TaskDeliveryState,
): void {
  replaceTaskDeliveryStateRow(db, bindTaskDeliveryState(state));
}

function parseFlowStateJson(raw: string | null): JsonValue | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return undefined;
  }
}

function assertPersistedParentFlowLinkAllowed(db: DatabaseSync, task: TaskRecord): void {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  const kysely = getTaskRegistryKysely(db);
  const existingTask = executeSqliteQuerySync(
    db,
    kysely.selectFrom("task_runs").select("parent_flow_id").where("task_id", "=", task.taskId),
  ).rows[0];
  if (existingTask?.parent_flow_id === flowId) {
    return;
  }
  const flow = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("flow_runs")
      .select(["owner_key", "status", "cancel_requested_at", "state_json"])
      .where("flow_id", "=", flowId),
  ).rows[0];
  if (!flow) {
    throw new ParentFlowLinkError("parent_flow_not_found", `Parent flow not found: ${flowId}`, {
      flowId,
    });
  }
  const status = parseTaskFlowStatus(flow.status);
  if (flow.owner_key.trim() !== task.ownerKey.trim()) {
    throw new ParentFlowLinkError(
      "owner_key_mismatch",
      "Task ownerKey must match parent flow ownerKey.",
      { flowId, status },
    );
  }
  if (flow.cancel_requested_at != null) {
    throw new ParentFlowLinkError(
      "cancel_requested",
      "Parent flow cancellation has already been requested.",
      { flowId, status },
    );
  }
  if (governedMissionStateBlocksChildCreation(parseFlowStateJson(flow.state_json))) {
    throw new ParentFlowLinkError(
      "child_creation_closed",
      "Parent governed mission has closed child creation for closeout.",
      { flowId, status },
    );
  }
  if (["succeeded", "failed", "cancelled", "lost"].includes(status)) {
    throw new ParentFlowLinkError("terminal", `Parent flow is already ${status}.`, {
      flowId,
      status,
    });
  }
}

function replaceTaskDeliveryStateRow(
  db: DatabaseSync,
  row: Insertable<TaskDeliveryStateTable>,
): void {
  executeSqliteQuerySync(
    db,
    getTaskRegistryKysely(db)
      .insertInto("task_delivery_state")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("task_id").doUpdateSet({
          requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
          last_notified_event_at: (eb) => eb.ref("excluded.last_notified_event_at"),
        }),
      ),
  );
}

function deleteTaskRowsWithDeliveryState(db: DatabaseSync, taskId: string): void {
  const kysely = getTaskRegistryKysely(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("task_delivery_state").where("task_id", "=", taskId),
  );
  executeSqliteQuerySync(db, kysely.deleteFrom("task_runs").where("task_id", "=", taskId));
}

function openTaskRegistryDatabase(options: { readOnly?: boolean } = {}): TaskRegistryDatabase {
  const database = options.readOnly
    ? openOpenClawStateDatabase({ readOnly: true })
    : openOpenClawStateDatabase();
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
  const taskDatabase = {
    db: database.db,
    path: pathname,
    readOnly,
  };
  cachedDatabases.set(cacheKey, taskDatabase);
  return taskDatabase;
}

function withWriteTransaction(write: (database: TaskRegistryDatabase) => void) {
  const database = openTaskRegistryDatabase();
  runOpenClawStateWriteTransaction(() => {
    write(database);
  });
}

export function loadTaskRegistryStateFromSqlite(): TaskRegistryStoreSnapshot {
  const { db } = openTaskRegistryDatabase({ readOnly: true });
  const taskRows = selectTaskRows(db);
  const deliveryRows = selectTaskDeliveryStateRows(db);
  return {
    tasks: new Map(taskRows.map((row) => [row.task_id, rowToTaskRecord(row)])),
    deliveryStates: new Map(deliveryRows.map((row) => [row.task_id, rowToTaskDeliveryState(row)])),
  };
}

export function listTaskRegistryRecordsByOwnerKeyFromSqlite(ownerKey: string): TaskRecord[] {
  const key = ownerKey.trim();
  if (!key) {
    return [];
  }
  const { db } = openTaskRegistryDatabase();
  const query = getTaskRegistryKysely(db)
    .selectFrom("task_runs")
    .select(TASK_RUN_SELECT_COLUMNS)
    .where("owner_key", "=", key)
    .orderBy("created_at", "asc")
    .orderBy("task_id", "asc");
  const rows = executeSqliteQuerySync(db, query).rows;
  return rows.map(rowToTaskRecord);
}

export function saveTaskRegistryStateToSqlite(snapshot: TaskRegistryStoreSnapshot) {
  withWriteTransaction(({ db }) => {
    const kysely = getTaskRegistryKysely(db);
    const taskIds = [...snapshot.tasks.keys()];
    if (taskIds.length === 0) {
      executeSqliteQuerySync(db, kysely.deleteFrom("task_delivery_state"));
      executeSqliteQuerySync(db, kysely.deleteFrom("task_runs"));
      return;
    }
    pruneRowsNotInSnapshot({
      db,
      tableName: "task_runs",
      columnName: "task_id",
      tempTableName: "openclaw_live_task_run_ids",
      ids: taskIds,
    });
    const deliveryTaskIds = [...snapshot.deliveryStates.keys()];
    if (deliveryTaskIds.length === 0) {
      executeSqliteQuerySync(db, kysely.deleteFrom("task_delivery_state"));
    } else {
      pruneRowsNotInSnapshot({
        db,
        tableName: "task_delivery_state",
        columnName: "task_id",
        tempTableName: "openclaw_live_task_delivery_ids",
        ids: deliveryTaskIds,
      });
    }
    for (const task of snapshot.tasks.values()) {
      upsertTaskRegistryRecordInTransaction(db, task);
    }
    for (const state of snapshot.deliveryStates.values()) {
      replaceTaskDeliveryStateRow(db, bindTaskDeliveryState(state));
    }
  });
}

export function upsertTaskRegistryRecordToSqlite(task: TaskRecord) {
  withWriteTransaction(({ db }) => {
    // The persisted flow check shares this write transaction with task creation.
    // Closeout and child creation therefore cannot race past each other.
    upsertTaskRegistryRecordInTransaction(db, task);
  });
}

export function upsertTaskWithDeliveryStateToSqlite(params: {
  task: TaskRecord;
  deliveryState?: TaskDeliveryState;
}) {
  withWriteTransaction(({ db }) => {
    upsertTaskRegistryRecordInTransaction(db, params.task);
    if (params.deliveryState) {
      replaceTaskDeliveryStateRow(db, bindTaskDeliveryState(params.deliveryState));
    } else {
      executeSqliteQuerySync(
        db,
        getTaskRegistryKysely(db)
          .deleteFrom("task_delivery_state")
          .where("task_id", "=", params.task.taskId),
      );
    }
  });
}

export function countActiveTaskRegistryRecordsForFlowFromSqlite(flowId: string): number {
  const { db } = openTaskRegistryDatabase({ readOnly: true });
  const rows = executeSqliteQuerySync(
    db,
    getTaskRegistryKysely(db)
      .selectFrom("task_runs")
      .select("task_id")
      .where("parent_flow_id", "=", flowId)
      .where("status", "in", ["queued", "running"]),
  ).rows;
  return rows.length;
}

export function deleteTaskRegistryRecordFromSqlite(taskId: string) {
  withWriteTransaction(({ db }) => {
    deleteTaskRowsWithDeliveryState(db, taskId);
  });
}

export function deleteTaskAndDeliveryStateFromSqlite(taskId: string) {
  withWriteTransaction(({ db }) => {
    deleteTaskRowsWithDeliveryState(db, taskId);
  });
}

export function upsertTaskDeliveryStateToSqlite(state: TaskDeliveryState) {
  withWriteTransaction(({ db }) => {
    replaceTaskDeliveryStateRow(db, bindTaskDeliveryState(state));
  });
}

export function deleteTaskDeliveryStateFromSqlite(taskId: string) {
  withWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getTaskRegistryKysely(db).deleteFrom("task_delivery_state").where("task_id", "=", taskId),
    );
  });
}

export function closeTaskRegistryDatabase() {
  cachedDatabases.clear();
  closeOpenClawStateDatabase();
}
