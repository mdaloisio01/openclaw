import type { Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  parseOptionalTaskFlowSyncMode,
  parseTaskFlowStatus,
  type JsonValue,
  type TaskFlowRecord,
  type TaskFlowSyncMode,
} from "./task-flow-registry.types.js";
import {
  normalizeSqliteNumber,
  parseDeliveryContextJson,
  parseSqliteJsonValue,
} from "./task-registry.sqlite.shared.js";
import { parseTaskNotifyPolicy } from "./task-registry.types.js";

export type TaskFlowRegistryRow = Selectable<OpenClawStateKyselyDatabase["flow_runs"]> & {
  sync_mode: string | null;
  status: string;
  notify_policy: string;
};

function rowToSyncMode(row: TaskFlowRegistryRow): TaskFlowSyncMode {
  const syncMode = parseOptionalTaskFlowSyncMode(row.sync_mode);
  if (syncMode) {
    return syncMode;
  }
  return row.shape === "single_task" ? "task_mirrored" : "managed";
}

export function parseTaskFlowRegistryRow(row: TaskFlowRegistryRow): TaskFlowRecord {
  const endedAt = normalizeSqliteNumber(row.ended_at);
  const cancelRequestedAt = normalizeSqliteNumber(row.cancel_requested_at);
  const requesterOrigin = parseDeliveryContextJson(row.requester_origin_json);
  const stateJson = parseSqliteJsonValue<JsonValue>(row.state_json);
  const waitJson = parseSqliteJsonValue<JsonValue>(row.wait_json);
  return {
    flowId: row.flow_id,
    syncMode: rowToSyncMode(row),
    ownerKey: row.owner_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: normalizeSqliteNumber(row.revision) ?? 0,
    status: parseTaskFlowStatus(row.status),
    notifyPolicy: parseTaskNotifyPolicy(row.notify_policy),
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    ...(stateJson !== undefined ? { stateJson } : {}),
    ...(waitJson !== undefined ? { waitJson } : {}),
    ...(cancelRequestedAt != null ? { cancelRequestedAt } : {}),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    ...(endedAt != null ? { endedAt } : {}),
  };
}
