import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type TaskSummary,
  type TasksListParams,
  validateTasksCancelParams,
  validateTasksGetParams,
  validateTasksListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { runRuntimeAssetGuardPreflight } from "../../infra/runtime-asset-guard-preflight.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
  ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME,
} from "../../tasks/active-production-watchdog-lifecycle.js";
import { cancelDetachedTaskRunById } from "../../tasks/detached-task-runtime.js";
import {
  evaluateProductionOwnerLaneGuard,
  type ProductionOwnerLaneOverride,
} from "../../tasks/production-owner-lane-guard.js";
import { getTaskById, listTaskRecords, listTasksForFlowId } from "../../tasks/runtime-internal.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  runTaskInFlowForOwner,
} from "../../tasks/task-executor.js";
import type { ProductionContinuationStopReason } from "../../tasks/task-flow-registry.js";
import {
  createManagedTaskFlow,
  finishFlow,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  recordFlowLawfulStop,
  recordFlowNextExecutableLaunch,
  resolveTaskFlowForLookupToken,
  resumeFlow,
} from "../../tasks/task-flow-runtime-internal.js";
import type {
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskStatus,
} from "../../tasks/task-registry.types.js";
import {
  TASK_STATUS_DETAIL_MAX_CHARS,
  formatTaskStatusTitle,
  sanitizeTaskStatusText,
} from "../../tasks/task-status.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const WATCHDOG_PROBE_POLL_TIMEOUT_MS = 5_000;
const WATCHDOG_PROBE_POLL_INTERVAL_MS = 50;
const WATCHDOG_LIFECYCLE_PROBE_CONTROLLER_ID = "gateway/tasks/watchdog-lifecycle-live-probe";
const PRODUCTION_FLOW_KIND = "production_taskflow_slice";
const CHILD_EXECUTION_PROOF_KIND = "production_taskflow_child_execution_proof";

const TASK_RUNTIMES = new Set<TaskRuntime>(["subagent", "acp", "cli", "cron"]);
const TASK_DELIVERY_STATUSES = new Set<TaskDeliveryStatus>([
  "pending",
  "delivered",
  "session_queued",
  "failed",
  "parent_missing",
  "not_applicable",
]);
const TASK_NOTIFY_POLICIES = new Set<TaskNotifyPolicy>(["done_only", "state_changes", "silent"]);

type TaskLedgerStatus = TaskSummary["status"];

// Gateway task APIs preserve the older ledger status vocabulary while the
// runtime registry tracks finer-grained task states such as `lost`.
const TASK_STATUS_TO_LEDGER_STATUS: Record<TaskStatus, TaskLedgerStatus> = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  lost: "failed",
};

const LEDGER_STATUS_TO_TASK_STATUSES: Record<TaskLedgerStatus, TaskStatus[]> = {
  queued: ["queued"],
  running: ["running"],
  completed: ["succeeded"],
  failed: ["failed", "lost"],
  timed_out: ["timed_out"],
  cancelled: ["cancelled"],
};

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

// Status text can originate from providers, shells, and subprocesses. Keep the
// public task shape bounded before it reaches control-plane clients.
function sanitizeOptionalTaskText(
  value: unknown,
  opts?: { errorContext?: boolean },
): string | undefined {
  const sanitized = sanitizeTaskStatusText(value, {
    errorContext: opts?.errorContext,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  return sanitized || undefined;
}

function mapTaskSummary(task: TaskRecord): TaskSummary {
  const progressSummary = sanitizeOptionalTaskText(task.progressSummary);
  const terminalSummary = sanitizeOptionalTaskText(task.terminalSummary, { errorContext: true });
  const error = sanitizeOptionalTaskText(task.error, { errorContext: true });
  return {
    id: task.taskId,
    taskId: task.taskId,
    kind: task.taskKind ?? task.runtime,
    runtime: task.runtime,
    status: TASK_STATUS_TO_LEDGER_STATUS[task.status],
    title: formatTaskStatusTitle(task),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    sessionKey: task.requesterSessionKey,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ownerKey: task.ownerKey,
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.parentFlowId ? { flowId: task.parentFlowId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    createdAt: task.createdAt,
    updatedAt: taskUpdatedAt(task),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(progressSummary ? { progressSummary } : {}),
    ...(terminalSummary ? { terminalSummary } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizeTaskStatusFilter(status: TasksListParams["status"]): Set<TaskStatus> | null {
  if (!status) {
    return null;
  }
  const statuses = Array.isArray(status) ? status : [status];
  return new Set(statuses.flatMap((value) => LEDGER_STATUS_TO_TASK_STATUSES[value] ?? []));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireStringParam(
  params: Record<string, unknown>,
  name: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = optionalStringField(params[name]);
  if (!value) {
    return { ok: false, message: `${name} is required` };
  }
  return { ok: true, value };
}

function readStringArrayParam(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function readTaskRuntime(value: unknown): TaskRuntime | undefined {
  return typeof value === "string" && TASK_RUNTIMES.has(value as TaskRuntime)
    ? (value as TaskRuntime)
    : undefined;
}

function readTaskDeliveryStatus(value: unknown): TaskDeliveryStatus | undefined {
  return typeof value === "string" && TASK_DELIVERY_STATUSES.has(value as TaskDeliveryStatus)
    ? (value as TaskDeliveryStatus)
    : undefined;
}

function readTaskNotifyPolicy(value: unknown): TaskNotifyPolicy | undefined {
  return typeof value === "string" && TASK_NOTIFY_POLICIES.has(value as TaskNotifyPolicy)
    ? (value as TaskNotifyPolicy)
    : undefined;
}

function readProductionStopReason(value: unknown): ProductionContinuationStopReason | undefined {
  return value === "blocker" ||
    value === "owner_decision" ||
    value === "restart_or_reload" ||
    value === "hard_stop" ||
    value === "safety_stop" ||
    value === "whole_run_complete"
    ? value
    : undefined;
}

function readNextExecutableLaunchProof(
  value: unknown,
): { detail: string; currentStep?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const detail = optionalStringField(input.detail);
  if (!detail) {
    return undefined;
  }
  const currentStep = optionalStringField(input.currentStep);
  return {
    detail,
    ...(currentStep ? { currentStep } : {}),
  };
}

function readOwnerLaneOverride(value: unknown): ProductionOwnerLaneOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  return {
    ...(input.explicitOperatorApproval === true ? { explicitOperatorApproval: true } : {}),
    ...(optionalStringField(input.targetWorkItem)
      ? { targetWorkItem: optionalStringField(input.targetWorkItem) }
      : {}),
    ...(optionalStringField(input.normalRequiredOwnerLane)
      ? { normalRequiredOwnerLane: optionalStringField(input.normalRequiredOwnerLane) }
      : {}),
    ...(optionalStringField(input.approvedAlternateExecutor)
      ? { approvedAlternateExecutor: optionalStringField(input.approvedAlternateExecutor) }
      : {}),
    ...(optionalStringField(input.reason) ? { reason: optionalStringField(input.reason) } : {}),
    ...(optionalStringField(input.scope) ? { scope: optionalStringField(input.scope) } : {}),
    ...(optionalStringField(input.expiresAt)
      ? { expiresAt: optionalStringField(input.expiresAt) }
      : {}),
    ...(input.oneTimeUse === true ? { oneTimeUse: true } : {}),
  };
}

function readProductionFlowState(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const state = value as Record<string, unknown>;
  return state.kind === PRODUCTION_FLOW_KIND ? state : null;
}

function buildChildExecutionProof(params: {
  buildPlanRef: string;
  buildItem: string;
  workPacketRef: string;
  requiredOwnerLane: string;
  attemptedOwnerLane: string;
  attemptedExecutor: string;
  executorRole: string;
  lawfulRouteRequired: string;
  handoffRef: string;
  handoffAcceptedBy: string;
  ownerLaneGuard: unknown;
  taskId: string;
  flowId: string;
  childSessionKey: string;
  deliveryStatus: TaskDeliveryStatus;
}) {
  return {
    kind: CHILD_EXECUTION_PROOF_KIND,
    buildPlanRef: params.buildPlanRef,
    buildItem: params.buildItem,
    workPacketRef: params.workPacketRef,
    requiredOwnerLane: params.requiredOwnerLane,
    attemptedOwnerLane: params.attemptedOwnerLane,
    attemptedExecutor: params.attemptedExecutor,
    executorRole: params.executorRole,
    lawfulRouteRequired: params.lawfulRouteRequired,
    handoffRef: params.handoffRef,
    handoffAcceptedBy: params.handoffAcceptedBy,
    ownerLaneGuard: params.ownerLaneGuard,
    parentFlowId: params.flowId,
    childTaskId: params.taskId,
    childSessionKey: params.childSessionKey,
    deliveryStatus: params.deliveryStatus,
  };
}

function validateProductionChildBackingSession(
  task: TaskRecord,
): { ok: true; childSessionKey: string } | { ok: false; message: string } {
  const childSessionKey = normalizeOptionalString(task.childSessionKey);
  if (!childSessionKey) {
    return {
      ok: false,
      message:
        "child_task_backing_session_missing: production child TaskFlow execution requires a backing child session before it can be treated as dispatched, progressed, or completed",
    };
  }
  return { ok: true, childSessionKey };
}

function resolveProductionChildTaskForMutation(input: Record<string, unknown>):
  | {
      ok: true;
      flow: NonNullable<ReturnType<typeof getTaskFlowById>>;
      runId: string;
      task: TaskRecord;
    }
  | { ok: false; message: string } {
  const lookup = requireStringParam(input, "lookup");
  if (!lookup.ok) {
    return { ok: false, message: lookup.message };
  }
  const runId = requireStringParam(input, "runId");
  if (!runId.ok) {
    return { ok: false, message: runId.message };
  }
  const flow = resolveTaskFlowForLookupToken(lookup.value);
  if (!flow) {
    return {
      ok: false,
      message: `child_task_parent_flow_invalid: TaskFlow not found: ${lookup.value}`,
    };
  }
  const flowState = readProductionFlowState(flow.stateJson);
  if (flow.syncMode !== "managed" || !flowState) {
    return {
      ok: false,
      message: `child_task_parent_flow_invalid: TaskFlow is not a managed production TaskFlow: ${flow.flowId}`,
    };
  }
  const task = listTasksForFlowId(flow.flowId).find((candidate) => candidate.runId === runId.value);
  if (!task) {
    return {
      ok: false,
      message: `child_task_not_found_for_parent_flow: ${runId.value}`,
    };
  }
  return { ok: true, flow, runId: runId.value, task };
}

async function readActiveWorkWatchdogJob(context: GatewayRequestContext) {
  const byId = await context.cron.readJob(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID);
  if (byId) {
    return byId;
  }
  const jobs = await context.cron.list({ includeDisabled: true });
  return jobs.find((job) => job.name === ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME);
}

async function waitForActiveWorkWatchdogEnabledState(params: {
  context: GatewayRequestContext;
  expected: boolean;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  let lastJob = await readActiveWorkWatchdogJob(params.context);
  while (Date.now() - startedAt <= (params.timeoutMs ?? WATCHDOG_PROBE_POLL_TIMEOUT_MS)) {
    if (lastJob?.enabled === params.expected) {
      return { matched: true, job: lastJob, elapsedMs: Date.now() - startedAt };
    }
    await delay(WATCHDOG_PROBE_POLL_INTERVAL_MS);
    lastJob = await readActiveWorkWatchdogJob(params.context);
  }
  return { matched: false, job: lastJob, elapsedMs: Date.now() - startedAt };
}

// Session filtering needs all ownership keys because detached child runs may be
// queried from the requester, child session, or owner/control-plane view.
function taskMatchesSession(task: TaskRecord, sessionKey: string | undefined): boolean {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return true;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => normalizeOptionalString(candidate) === normalized,
  );
}

// Some records predate a direct `agentId`, so task listings still recover the
// owning agent from session-style keys instead of hiding those tasks.
function taskMatchesAgent(task: TaskRecord, agentId: string | undefined): boolean {
  const normalized = normalizeOptionalString(agentId);
  if (!normalized) {
    return true;
  }
  if (normalizeOptionalString(task.agentId) === normalized) {
    return true;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => parseAgentSessionKey(candidate)?.agentId === normalized,
  );
}

// Cursor strings are offsets, not opaque tokens; reject malformed values so a
// client cannot silently restart pagination at the first page.
function parseCursor(cursor: string | undefined): number | null {
  if (!cursor) {
    return 0;
  }
  if (!/^\d+$/.test(cursor.trim())) {
    return null;
  }
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// Control UI task methods expose the stable gateway protocol shape; helpers
// above keep runtime registry details out of the wire result.
export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": ({ params, respond }) => {
    if (!validateTasksListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.list params: ${formatValidationErrors(validateTasksListParams.errors)}`,
        ),
      );
      return;
    }
    const cursor = parseCursor(params.cursor);
    if (cursor === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid tasks.list cursor"),
      );
      return;
    }
    const statusFilter = normalizeTaskStatusFilter(params.status);
    const limit = Math.min(params.limit ?? DEFAULT_TASKS_LIST_LIMIT, MAX_TASKS_LIST_LIMIT);
    const filtered = listTaskRecords().filter((task) => {
      if (statusFilter && !statusFilter.has(task.status)) {
        return false;
      }
      return taskMatchesAgent(task, params.agentId) && taskMatchesSession(task, params.sessionKey);
    });
    const page = filtered.slice(cursor, cursor + limit);
    const nextOffset = cursor + page.length;
    respond(true, {
      tasks: page.map((task) => mapTaskSummary(task)),
      ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}),
    });
  },
  "tasks.get": ({ params, respond }) => {
    if (!validateTasksGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.get params: ${formatValidationErrors(validateTasksGetParams.errors)}`,
        ),
      );
      return;
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }
    respond(true, { task: mapTaskSummary(task) });
  },
  "tasks.cancel": async ({ params, respond, context }) => {
    if (!validateTasksCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.cancel params: ${formatValidationErrors(validateTasksCancelParams.errors)}`,
        ),
      );
      return;
    }
    const taskId = params.taskId;
    const reason = normalizeOptionalString(params.reason);
    const result = await cancelDetachedTaskRunById({
      cfg: context.getRuntimeConfig(),
      taskId,
      ...(reason ? { reason } : {}),
    });
    respond(true, {
      found: result.found,
      cancelled: result.cancelled,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.task ? { task: mapTaskSummary(result.task) } : {}),
    });
  },
  "tasks.startProductionFlow": ({ params, respond }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const required = [
      "ownerKey",
      "controllerId",
      "goal",
      "sliceId",
      "sliceOwner",
      "authorityPath",
      "authorityBasis",
      "buildItem",
      "requiredOwnerLane",
      "attemptedOwnerLane",
      "attemptedExecutor",
      "executorRole",
      "lawfulRouteRequired",
    ] as const;
    const fields: Record<string, string> = {};
    for (const name of required) {
      const field = requireStringParam(input, name);
      if (!field.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, field.message));
        return;
      }
      fields[name] = field.value;
    }
    const ownerLaneGuard = evaluateProductionOwnerLaneGuard({
      buildPlanRef: fields.authorityPath!,
      buildItem: fields.buildItem!,
      requiredOwnerLane: fields.requiredOwnerLane!,
      attemptedOwnerLane: fields.attemptedOwnerLane!,
      attemptedExecutor: fields.attemptedExecutor!,
      executorRole: fields.executorRole!,
      lawfulRouteRequired: fields.lawfulRouteRequired!,
      override: readOwnerLaneOverride(input.operatorOverride),
    });
    if (!ownerLaneGuard.allowed) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, ownerLaneGuard.message, {
          details: ownerLaneGuard.details,
        }),
      );
      return;
    }
    const now = Date.now();
    const flow = createManagedTaskFlow({
      ownerKey: fields.ownerKey!,
      controllerId: fields.controllerId!,
      goal: fields.goal!,
      status: "running",
      notifyPolicy: "done_only",
      currentStep: optionalStringField(input.currentStep) ?? "production_slice_started",
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
      stateJson: {
        kind: PRODUCTION_FLOW_KIND,
        sliceId: fields.sliceId!,
        sliceOwner: fields.sliceOwner!,
        authorityPath: fields.authorityPath!,
        authorityBasis: fields.authorityBasis!,
        buildItem: fields.buildItem!,
        requiredOwnerLane: fields.requiredOwnerLane!,
        attemptedOwnerLane: fields.attemptedOwnerLane!,
        attemptedExecutor: fields.attemptedExecutor!,
        executorRole: fields.executorRole!,
        lawfulRouteRequired: fields.lawfulRouteRequired!,
        ownerLaneGuard: ownerLaneGuard.details,
        blockers: readStringArrayParam(input.blockers),
      },
      createdAt: now,
      updatedAt: now,
    });
    if (!flow) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to create production TaskFlow"),
      );
      return;
    }
    respond(true, { flow });
  },
  "tasks.resumeProductionFlow": ({ params, respond }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const lookup = requireStringParam(input, "lookup");
    if (!lookup.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, lookup.message));
      return;
    }
    const flow = resolveTaskFlowForLookupToken(lookup.value);
    if (!flow) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `TaskFlow not found: ${lookup.value}`),
      );
      return;
    }
    if (flow.syncMode !== "managed") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `TaskFlow is not managed: ${flow.flowId}`),
      );
      return;
    }
    const continuation = getTaskFlowProductionContinuation(flow);
    if (!continuation?.activeProductionRun) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `TaskFlow is not an active-production flow: ${flow.flowId}`,
        ),
      );
      return;
    }
    const runtimeGuard = runRuntimeAssetGuardPreflight({ operation: "production preflight" });
    if (!runtimeGuard.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `production resume blocked by runtime asset guard: ${runtimeGuard.message}`,
          { retryable: false },
        ),
      );
      return;
    }
    const resumed = resumeFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      status: "running",
      currentStep: optionalStringField(input.currentStep) ?? flow.currentStep,
    });
    if (!resumed.applied) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to resume production TaskFlow: ${resumed.reason}`,
        ),
      );
      return;
    }
    respond(true, { flow: resumed.flow });
  },
  "tasks.runTaskInFlow": ({ params, respond }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const required = [
      "lookup",
      "workPacketRef",
      "buildPlanRef",
      "buildItem",
      "requiredOwnerLane",
      "attemptedOwnerLane",
      "attemptedExecutor",
      "executorRole",
      "lawfulRouteRequired",
      "handoffRef",
      "handoffAcceptedBy",
      "task",
    ] as const;
    const fields: Record<string, string> = {};
    for (const name of required) {
      const field = requireStringParam(input, name);
      if (!field.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `child_task_handoff_missing: ${field.message}`),
        );
        return;
      }
      fields[name] = field.value;
    }
    const runtime = readTaskRuntime(input.runtime);
    if (!runtime) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "child_task_dispatch_not_authorized: valid runtime is required",
        ),
      );
      return;
    }
    const flow = resolveTaskFlowForLookupToken(fields.lookup!);
    if (!flow) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `child_task_parent_flow_invalid: TaskFlow not found: ${fields.lookup}`,
        ),
      );
      return;
    }
    if (flow.syncMode !== "managed" || flow.status !== "running") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `child_task_parent_flow_invalid: parent TaskFlow must be managed and running: ${flow.flowId}`,
        ),
      );
      return;
    }
    const flowState = readProductionFlowState(flow.stateJson);
    if (!flowState) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `child_task_parent_flow_invalid: TaskFlow is not a production TaskFlow: ${flow.flowId}`,
        ),
      );
      return;
    }
    const continuation = getTaskFlowProductionContinuation(flow);
    if (!continuation?.activeProductionRun || continuation.blockerPresent) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `child_task_parent_flow_invalid: production TaskFlow is not open for child execution: ${flow.flowId}`,
        ),
      );
      return;
    }
    if (
      flowState.authorityPath !== fields.buildPlanRef ||
      flowState.buildItem !== fields.buildItem
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "child_task_dispatch_not_authorized: child build plan/item does not match parent flow",
        ),
      );
      return;
    }
    const ownerLaneGuard = evaluateProductionOwnerLaneGuard({
      buildPlanRef: fields.buildPlanRef!,
      buildItem: fields.buildItem!,
      requiredOwnerLane: fields.requiredOwnerLane!,
      attemptedOwnerLane: fields.attemptedOwnerLane!,
      attemptedExecutor: fields.attemptedExecutor!,
      executorRole: fields.executorRole!,
      lawfulRouteRequired: fields.lawfulRouteRequired!,
      override: readOwnerLaneOverride(input.operatorOverride),
    });
    if (!ownerLaneGuard.allowed) {
      const code =
        ownerLaneGuard.blockerCode === "unresolved_owner_lane" ||
        ownerLaneGuard.blockerCode === "missing_sop_owner_route"
          ? "child_task_owner_lane_unresolved"
          : ownerLaneGuard.blockerCode === "will_self_perform_forbidden" ||
              ownerLaneGuard.blockerCode === "grant_self_perform_forbidden" ||
              ownerLaneGuard.blockerCode === "owner_lane_mismatch"
            ? "child_task_executor_identity_mismatch"
            : "child_task_dispatch_not_authorized";
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `${code}: ${ownerLaneGuard.message}`, {
          details: ownerLaneGuard.details,
        }),
      );
      return;
    }
    const now = Date.now();
    const runId =
      optionalStringField(input.runId) ?? `${flow.flowId}:${fields.attemptedExecutor}:${now}`;
    const childSessionKey = optionalStringField(input.childSessionKey);
    if (!childSessionKey) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "child_task_backing_session_missing: production child TaskFlow execution requires childSessionKey before dispatch",
        ),
      );
      return;
    }
    const child = runTaskInFlowForOwner({
      callerOwnerKey: flow.ownerKey,
      flowId: flow.flowId,
      runtime,
      sourceId: optionalStringField(input.sourceId) ?? fields.workPacketRef!,
      childSessionKey,
      parentTaskId: optionalStringField(input.parentTaskId),
      agentId: optionalStringField(input.agentId),
      runId,
      label: optionalStringField(input.label) ?? fields.buildItem!,
      task: fields.task!,
      notifyPolicy: readTaskNotifyPolicy(input.notifyPolicy),
      deliveryStatus: readTaskDeliveryStatus(input.deliveryStatus) ?? "pending",
      status: input.status === "running" ? "running" : "queued",
      startedAt: input.status === "running" ? now : undefined,
      lastEventAt: now,
      progressSummary: optionalStringField(input.progressSummary),
      preferMetadata: input.preferMetadata === true,
    });
    if (!child.created || !child.task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `child_task_dispatch_not_authorized: ${child.reason}`),
      );
      return;
    }
    const backingSession = validateProductionChildBackingSession(child.task);
    if (!backingSession.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, backingSession.message));
      return;
    }
    const proof = buildChildExecutionProof({
      buildPlanRef: fields.buildPlanRef!,
      buildItem: fields.buildItem!,
      workPacketRef: fields.workPacketRef!,
      requiredOwnerLane: fields.requiredOwnerLane!,
      attemptedOwnerLane: fields.attemptedOwnerLane!,
      attemptedExecutor: fields.attemptedExecutor!,
      executorRole: fields.executorRole!,
      lawfulRouteRequired: fields.lawfulRouteRequired!,
      handoffRef: fields.handoffRef!,
      handoffAcceptedBy: fields.handoffAcceptedBy!,
      ownerLaneGuard: ownerLaneGuard.details,
      taskId: child.task.taskId,
      flowId: flow.flowId,
      childSessionKey: backingSession.childSessionKey,
      deliveryStatus: child.task.deliveryStatus,
    });
    respond(true, {
      flow: getTaskFlowById(flow.flowId) ?? child.flow,
      task: mapTaskSummary(child.task),
      executorIdentityProof: proof,
    });
  },
  "tasks.recordTaskInFlowProgress": ({ params, respond }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const resolved = resolveProductionChildTaskForMutation(input);
    if (!resolved.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.message));
      return;
    }
    const backingSession = validateProductionChildBackingSession(resolved.task);
    if (!backingSession.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, backingSession.message));
      return;
    }
    const now = Date.now();
    const updated = recordTaskRunProgressByRunId({
      runId: resolved.runId,
      runtime: readTaskRuntime(input.runtime),
      sessionKey: optionalStringField(input.sessionKey) ?? backingSession.childSessionKey,
      lastEventAt: now,
      progressSummary: optionalStringField(input.progressSummary),
      eventSummary: optionalStringField(input.eventSummary),
    });
    const task =
      updated.find((candidate) => candidate.taskId === resolved.task.taskId) ??
      getTaskById(resolved.task.taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `child_task_progress_not_recorded: ${resolved.runId}`),
      );
      return;
    }
    respond(true, {
      flow: getTaskFlowById(resolved.flow.flowId) ?? resolved.flow,
      task: mapTaskSummary(task),
    });
  },
  "tasks.completeTaskInFlow": ({ params, respond }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const resolved = resolveProductionChildTaskForMutation(input);
    if (!resolved.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.message));
      return;
    }
    const backingSession = validateProductionChildBackingSession(resolved.task);
    if (!backingSession.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, backingSession.message));
      return;
    }
    const status = optionalStringField(input.status) ?? "succeeded";
    const now = Date.now();
    const parentContinuation = getTaskFlowProductionContinuation(resolved.flow);
    const nextExecutableLaunch = readNextExecutableLaunchProof(input.nextExecutableLaunch);
    const requiresContinuationProof =
      status === "succeeded" &&
      parentContinuation?.activeProductionRun === true &&
      parentContinuation.lawfulWholeRunCompletion !== true &&
      parentContinuation.blockerPresent !== true &&
      parentContinuation.ownerDecisionRequired !== true &&
      parentContinuation.restartOrReloadRequired !== true &&
      parentContinuation.hardStopPresent !== true &&
      parentContinuation.safetyStopPresent !== true &&
      parentContinuation.nextExecutableUnitLaunched !== true;
    if (requiresContinuationProof && !nextExecutableLaunch) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "child_task_completion_requires_continuation_proof: active production child success must include nextExecutableLaunch proof or record a lawful production stop before local success can be accepted",
        ),
      );
      return;
    }
    const common = {
      runId: resolved.runId,
      runtime: readTaskRuntime(input.runtime),
      sessionKey: optionalStringField(input.sessionKey) ?? backingSession.childSessionKey,
      endedAt: now,
      lastEventAt: now,
      progressSummary: optionalStringField(input.progressSummary),
      terminalSummary: optionalStringField(input.terminalSummary),
    };
    const updated =
      status === "succeeded"
        ? completeTaskRunByRunId(common)
        : status === "failed" || status === "timed_out" || status === "cancelled"
          ? failTaskRunByRunId({
              ...common,
              status,
              error: optionalStringField(input.error),
            })
          : null;
    if (!updated) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "child_task_terminal_status_invalid: expected succeeded, failed, timed_out, or cancelled",
        ),
      );
      return;
    }
    const task =
      updated.find((candidate) => candidate.taskId === resolved.task.taskId) ??
      getTaskById(resolved.task.taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `child_task_completion_not_recorded: ${resolved.runId}`),
      );
      return;
    }
    let flow = getTaskFlowById(resolved.flow.flowId) ?? resolved.flow;
    if (status === "succeeded" && nextExecutableLaunch) {
      const launched = recordFlowNextExecutableLaunch({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        detail: nextExecutableLaunch.detail,
        currentStep: nextExecutableLaunch.currentStep ?? flow.currentStep,
        updatedAt: now,
      });
      if (!launched.applied) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `child_task_completion_continuation_launch_failed: ${launched.reason}`,
          ),
        );
        return;
      }
      flow = launched.flow;
    }
    respond(true, {
      flow,
      task: mapTaskSummary(task),
    });
  },
  "tasks.recordProductionFlowLawfulStop": ({ params, respond }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const lookup = requireStringParam(input, "lookup");
    if (!lookup.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, lookup.message));
      return;
    }
    const reason = readProductionStopReason(input.reason);
    if (!reason) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "valid reason is required"));
      return;
    }
    const detail = requireStringParam(input, "detail");
    if (!detail.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, detail.message));
      return;
    }
    const flow = resolveTaskFlowForLookupToken(lookup.value);
    if (!flow) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `TaskFlow not found: ${lookup.value}`),
      );
      return;
    }
    const stopped = recordFlowLawfulStop({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      reason,
      detail: detail.value,
      currentStep: optionalStringField(input.currentStep) ?? flow.currentStep,
    });
    if (!stopped.applied) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to record lawful stop: ${stopped.reason}`),
      );
      return;
    }
    let result = stopped.flow;
    if (input.finish === true) {
      if (reason !== "whole_run_complete") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "finish is only valid for whole_run_complete"),
        );
        return;
      }
      const finished = finishFlow({
        flowId: stopped.flow.flowId,
        expectedRevision: stopped.flow.revision,
        currentStep: optionalStringField(input.currentStep) ?? stopped.flow.currentStep,
      });
      if (!finished.applied) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to finish production TaskFlow: ${finished.reason}`,
          ),
        );
        return;
      }
      result = finished.flow;
    }
    respond(true, { flow: result });
  },
  "tasks.probeProductionWatchdogLifecycle": async ({ respond, context }) => {
    const initial = await readActiveWorkWatchdogJob(context);
    if (!initial) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `managed watchdog cron not found: ${ACTIVE_WORK_WATCHDOG_CRON_JOB_ID}`,
        ),
      );
      return;
    }

    const startedAt = Date.now();
    const flow = createManagedTaskFlow({
      ownerKey: "agent:orchestrator:main",
      controllerId: WATCHDOG_LIFECYCLE_PROBE_CONTROLLER_ID,
      goal: "Disposable active production watchdog lifecycle live probe",
      status: "running",
      currentStep: "probe_open",
      notifyPolicy: "done_only",
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
      stateJson: {
        probe: "active-production-watchdog-lifecycle",
        startedAt,
      },
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    if (!flow) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "failed to create disposable watchdog lifecycle probe flow",
        ),
      );
      return;
    }

    const enabled = await waitForActiveWorkWatchdogEnabledState({
      context,
      expected: true,
    });
    if (!enabled.matched) {
      respond(
        false,
        {
          flowId: flow.flowId,
          initialEnabled: initial.enabled,
          afterOpenEnabled: enabled.job?.enabled,
          enabledPollElapsedMs: enabled.elapsedMs,
        },
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "watchdog cron did not enable after disposable active production flow opened",
        ),
      );
      return;
    }
    const afterOpenEnabled = enabled.job?.enabled;

    const stoppedAt = Date.now();
    const lawfulStop = recordFlowLawfulStop({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      reason: "whole_run_complete",
      detail: "Disposable watchdog lifecycle live probe closed truthfully.",
      currentStep: "probe_closed",
      updatedAt: stoppedAt,
    });
    if (!lawfulStop.applied) {
      respond(
        false,
        {
          flowId: flow.flowId,
          initialEnabled: initial.enabled,
          afterOpenEnabled,
          stopReason: lawfulStop.reason,
        },
        errorShape(ErrorCodes.UNAVAILABLE, "failed to record lawful stop for probe flow"),
      );
      return;
    }

    const finishedAt = Date.now();
    const finished = finishFlow({
      flowId: lawfulStop.flow.flowId,
      expectedRevision: lawfulStop.flow.revision,
      currentStep: "probe_finished",
      endedAt: finishedAt,
      updatedAt: finishedAt,
    });
    if (!finished.applied) {
      respond(
        false,
        {
          flowId: lawfulStop.flow.flowId,
          initialEnabled: initial.enabled,
          afterOpenEnabled,
          finishReason: finished.reason,
        },
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "failed to finish disposable probe flow after lawful stop",
        ),
      );
      return;
    }

    const disabled = await waitForActiveWorkWatchdogEnabledState({
      context,
      expected: false,
    });
    if (!disabled.matched) {
      respond(
        false,
        {
          flowId: finished.flow.flowId,
          initialEnabled: initial.enabled,
          afterOpenEnabled,
          afterCloseEnabled: disabled.job?.enabled,
          disabledPollElapsedMs: disabled.elapsedMs,
        },
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "watchdog cron did not disable after disposable active production flow closed",
        ),
      );
      return;
    }

    respond(true, {
      ok: true,
      flowId: finished.flow.flowId,
      cronJobId: disabled.job?.id ?? enabled.job?.id ?? initial.id,
      initialEnabled: initial.enabled,
      afterOpenEnabled,
      afterCloseEnabled: disabled.job?.enabled,
      enabledPollElapsedMs: enabled.elapsedMs,
      disabledPollElapsedMs: disabled.elapsedMs,
      flowStatus: finished.flow.status,
      controllerId: WATCHDOG_LIFECYCLE_PROBE_CONTROLLER_ID,
      startedAt,
      stoppedAt,
      finishedAt,
    });
  },
};

export const testApi = {
  mapTaskSummary,
};
export { testApi as __test };
