import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TaskFlowSyncMode = "task_mirrored" | "managed";

export type TaskFlowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "terminal_pending_watchdog"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type ActiveProductionBoundary =
  | "none"
  | "plan_next_step"
  | "watchdog_recovery"
  | "delivery_recovery"
  | "validation_recovery"
  | "runtime_restart_recovery"
  | "technical_repair"
  | "grant_rework"
  | "operator_product_decision_required"
  | "operator_scope_decision_required"
  | "unsafe_destructive_action_required"
  | "external_side_effect_required"
  | "privacy_sensitive_action_required"
  | "financial_action_required"
  | "unresolved_authority_conflict"
  | "missing_controlling_build_plan"
  | "stale_or_contradicted_build_plan"
  | "next_owner_unclear"
  | "next_action_unclear"
  | "proof_source_unavailable"
  | "technical_impossibility"
  | "validation_failed_no_recovery_path"
  | "unsupported_runtime_surface"
  | "explicit_user_stop"
  | "complete";

export type ActiveProductionContinuationStatus =
  | "inactive"
  | "active"
  | "dispatch_required"
  | "dispatched"
  | "hard_boundary"
  | "complete";

export type ActiveProductionDispatchSurface =
  | "taskflow_child"
  | "watchdog_recovery"
  | "gateway"
  | "session"
  | "cron"
  | "report_delivery"
  | "manual";

export type ActiveProductionNextAction = {
  actionId: string;
  owner: string;
  summary: string;
  boundary: ActiveProductionBoundary;
  surface: ActiveProductionDispatchSurface;
  dispatchProofRef?: string;
};

export type ActiveProductionContinuationReceipt = {
  receiptId: string;
  actionId: string;
  surface: ActiveProductionDispatchSurface;
  boundary: ActiveProductionBoundary;
  dispatchedAt: number;
  owner: string;
  summary: string;
  proofRef: string;
};

export type ActiveProductionContinuationState = {
  activeProductionRun: boolean;
  broaderBuildOpen: boolean;
  status: ActiveProductionContinuationStatus;
  boundary: ActiveProductionBoundary;
  nextAction?: ActiveProductionNextAction;
  dispatchReceipts: ActiveProductionContinuationReceipt[];
  lastDispatchReceiptId?: string;
  lastFinalityCheckAt?: number;
  lastFinalityResult?: "complete_allowed" | "continuation_required" | "hard_boundary";
  lastFinalityReason?: string;
};

const TASK_FLOW_SYNC_MODES = new Set<TaskFlowSyncMode>(["task_mirrored", "managed"]);
const TASK_FLOW_STATUSES = new Set<TaskFlowStatus>([
  "queued",
  "running",
  "waiting",
  "blocked",
  "terminal_pending_watchdog",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);

function parsePersistedFlowValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value === "string" && values.has(value as T)) {
    return value as T;
  }
  throw new Error(`Invalid persisted task flow ${label}: ${JSON.stringify(value)}`);
}

export function parseOptionalTaskFlowSyncMode(value: unknown): TaskFlowSyncMode | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return parsePersistedFlowValue(value, TASK_FLOW_SYNC_MODES, "sync mode");
}

export function parseTaskFlowStatus(value: unknown): TaskFlowStatus {
  return parsePersistedFlowValue(value, TASK_FLOW_STATUSES, "status");
}

export type TaskFlowRecord = {
  flowId: string;
  syncMode: TaskFlowSyncMode;
  ownerKey: string;
  requesterOrigin?: DeliveryContext;
  controllerId?: string;
  revision: number;
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};
