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
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { waitForAgentRun } from "../../agents/run-wait.js";
import {
  createActiveProductionDispatchReceipt,
  evaluateActiveProductionFinality,
} from "../../continuity/active-production-continuation-controller.js";
import { readGovernedWorkspaceSkillSha256 } from "../../governance/governed-mission-identity.js";
import { admitGovernedProductionFlow } from "../../governance/governed-mission-production-admission.js";
import {
  commitGovernedMissionChildCompletion,
  isGovernedMissionFlowClaimed,
  isGovernedMissionStateCanonicallyPersisted,
  readPinnedGovernedMissionContract,
} from "../../governance/governed-mission-runtime.js";
import { readGovernedMissionStateFromTaskFlow } from "../../governance/governed-mission-state.js";
import { runRuntimeAssetGuardPreflight } from "../../infra/runtime-asset-guard-preflight.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
  ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME,
  reconcileProductionWatchdogCron,
} from "../../tasks/active-production-watchdog-lifecycle.js";
import { handleBuildIssueAction } from "../../tasks/build-issue-controller.js";
import { cancelDetachedTaskRunById } from "../../tasks/detached-task-runtime.js";
import {
  computeProductionExecutorAssignmentSha256,
  getProductionExecutorAssignment,
  isProductionExecutorAssignmentCurrentGovernedAttempt,
  parseProductionExecutorAssignmentAuthority,
  recordProductionExecutorAssignment,
  productionProofPurposeSchema,
} from "../../tasks/production-executor-assignment.js";
import {
  evaluateProductionOwnerLaneGuard,
  type ProductionOwnerLaneOverride,
} from "../../tasks/production-owner-lane-guard.js";
import {
  deleteTaskRecordById,
  getTaskById,
  listTaskRecords,
  listTasksForFlowId,
} from "../../tasks/runtime-internal.js";
import {
  finalizeTaskRunById,
  recordTaskRunProgressById,
  runTaskInFlowForOwner,
} from "../../tasks/task-executor.js";
import type { ProductionContinuationStopReason } from "../../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  finishFlow,
  getTaskFlowActiveProductionContinuation,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  recordFlowLawfulStop,
  recordFlowNextExecutableLaunch,
  resolveTaskFlowForLookupToken,
  resumeFlow,
} from "../../tasks/task-flow-runtime-internal.js";
import type {
  TaskDeliveryState,
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
import { invokeGatewayTool } from "../tools-invoke-shared.js";
import { governedTasksHandlers } from "./tasks-governance.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const WATCHDOG_PROBE_POLL_TIMEOUT_MS = 5_000;
const WATCHDOG_PROBE_POLL_INTERVAL_MS = 50;
const WATCHDOG_PROBE_CRON_OPERATION_TIMEOUT_MS = 2_000;
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
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class WatchdogProbeDiagnosticError extends Error {
  constructor(
    public readonly diagnostic: {
      operation: "cron.readJob" | "cron.list";
      timeoutMs: number;
      stage: "initial-read" | "poll-read";
    },
  ) {
    super(
      `${diagnostic.operation} timed out after ${diagnostic.timeoutMs}ms during ${diagnostic.stage}`,
    );
    this.name = "WatchdogProbeDiagnosticError";
  }
}

function isWatchdogProbeDiagnosticError(error: unknown): error is WatchdogProbeDiagnosticError {
  return error instanceof WatchdogProbeDiagnosticError;
}

async function withWatchdogProbeCronTimeout<T>(
  operation: WatchdogProbeDiagnosticError["diagnostic"]["operation"],
  stage: WatchdogProbeDiagnosticError["diagnostic"]["stage"],
  run: Promise<T>,
  timeoutMs = WATCHDOG_PROBE_CRON_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new WatchdogProbeDiagnosticError({ operation, stage, timeoutMs }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
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
  const taskId = optionalStringField(input.taskId);
  const runtime = input.runtime === undefined ? undefined : readTaskRuntime(input.runtime);
  if (input.runtime !== undefined && !runtime) {
    return { ok: false, message: "child_task_scope_invalid: valid runtime is required" };
  }
  const sessionKey = optionalStringField(input.sessionKey);
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
  let task: TaskRecord | undefined;
  let ambiguous = false;
  for (const candidate of listTasksForFlowId(flow.flowId)) {
    if (
      candidate.runId !== runId.value ||
      (taskId && candidate.taskId !== taskId) ||
      (runtime && candidate.runtime !== runtime) ||
      (sessionKey && candidate.childSessionKey !== sessionKey)
    ) {
      continue;
    }
    if (task) {
      ambiguous = true;
      break;
    }
    task = candidate;
  }
  if (!task) {
    return {
      ok: false,
      message: `child_task_not_found_for_parent_flow: ${runId.value}`,
    };
  }
  if (ambiguous) {
    return {
      ok: false,
      message:
        "child_task_scope_ambiguous: more than one child matches this run scope; taskId is required",
    };
  }
  return { ok: true, flow, runId: runId.value, task };
}

async function readActiveWorkWatchdogJob(
  context: GatewayRequestContext,
  stage: WatchdogProbeDiagnosticError["diagnostic"]["stage"] = "poll-read",
) {
  const jobs = await withWatchdogProbeCronTimeout(
    "cron.list",
    stage,
    context.cron.list({ includeDisabled: true }),
  );
  return jobs
    .filter((job) => job.name === ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME)
    .toSorted(
      (left, right) => right.createdAtMs - left.createdAtMs || right.updatedAtMs - left.updatedAtMs,
    )[0];
}

async function waitForActiveWorkWatchdogEnabledState(params: {
  context: GatewayRequestContext;
  expected: boolean;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  let lastJob = await readActiveWorkWatchdogJob(params.context, "poll-read");
  while (Date.now() - startedAt <= (params.timeoutMs ?? WATCHDOG_PROBE_POLL_TIMEOUT_MS)) {
    if (lastJob?.enabled === params.expected) {
      return { matched: true, job: lastJob, elapsedMs: Date.now() - startedAt };
    }
    await delay(WATCHDOG_PROBE_POLL_INTERVAL_MS);
    lastJob = await readActiveWorkWatchdogJob(params.context, "poll-read");
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
  ...governedTasksHandlers,
  "tasks.handleBuildIssue": async ({ params, respond, context }) => {
    const cfg = context.getRuntimeConfig();
    try {
      const receipt = await handleBuildIssueAction({
        input: params,
        dispatch: (request) =>
          invokeGatewayTool({
            cfg,
            input: {
              name: "sessions_send",
              sessionKey: request.ownerKey,
              idempotencyKey: request.actionId,
              args: {
                sessionKey: request.sessionKey,
                message: request.message,
                timeoutSeconds: 30,
              },
            },
            toolCallIdPrefix: "build-issue",
            approvalMode: "report",
            // This authenticated TaskFlow action uses the same runtime policy
            // as native MCP. Generic tools.invoke keeps its HTTP-only denies.
            toolPolicySurface: "loopback",
          }),
        waitForRun: (runId) => waitForAgentRun({ runId, timeoutMs: 1_000 }),
      });
      respond(true, { receipt });
    } catch (error) {
      const message = error instanceof Error ? error.message : "build_issue_action_failed";
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    }
  },
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
  "tasks.startProductionFlow": ({ params, respond, context }) => {
    const input = params && typeof params === "object" ? params : {};
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
      buildPlanRef: fields.authorityPath,
      buildItem: fields.buildItem,
      requiredOwnerLane: fields.requiredOwnerLane,
      attemptedOwnerLane: fields.attemptedOwnerLane,
      attemptedExecutor: fields.attemptedExecutor,
      executorRole: fields.executorRole,
      lawfulRouteRequired: fields.lawfulRouteRequired,
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
    const stateJson = {
      kind: PRODUCTION_FLOW_KIND,
      sliceId: fields.sliceId,
      sliceOwner: fields.sliceOwner,
      authorityPath: fields.authorityPath,
      authorityBasis: fields.authorityBasis,
      buildItem: fields.buildItem,
      requiredOwnerLane: fields.requiredOwnerLane,
      attemptedOwnerLane: fields.attemptedOwnerLane,
      attemptedExecutor: fields.attemptedExecutor,
      executorRole: fields.executorRole,
      lawfulRouteRequired: fields.lawfulRouteRequired,
      ownerLaneGuard: ownerLaneGuard.details,
      blockers: readStringArrayParam(input.blockers),
    };
    const currentStep = optionalStringField(input.currentStep) ?? "production_slice_started";
    if (input.governedMission !== undefined) {
      const cfg = context.getRuntimeConfig();
      const agentId = parseAgentSessionKey(fields.ownerKey)?.agentId ?? resolveDefaultAgentId(cfg);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const admission = admitGovernedProductionFlow(
        {
          ownerKey: fields.ownerKey,
          controllerId: fields.controllerId,
          goal: fields.goal,
          authorityPath: fields.authorityPath,
          artifactRoot: workspaceDir,
          currentStep,
          stateJson,
          governedMission: input.governedMission,
          observedSkillSha256: readGovernedWorkspaceSkillSha256({
            workspaceDir,
            config: cfg,
            agentId,
          }),
          now,
        },
        context.governedRuntimeIdentity,
      );
      if (admission.status === "admitted") {
        respond(true, {
          flow: admission.flow,
          governedAdmissionReceipt: admission.receipt,
        });
        return;
      }
      if (admission.status === "already_applied" && admission.flow) {
        respond(true, {
          flow: admission.flow,
          governedAdmissionReceipt: admission.receipt,
        });
        return;
      }
      if (admission.status === "already_applied") {
        if (admission.receipt.decision === "denied") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `governed admission denied: ${admission.receipt.reasonCode ?? "GOVERNED_ADMISSION_DENIED"}`,
            ),
          );
          return;
        }
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "governed admission flow is unavailable"),
        );
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `governed admission denied: ${admission.reasonCode}`,
        ),
      );
      return;
    }
    const flow = createManagedTaskFlow({
      ownerKey: fields.ownerKey,
      controllerId: fields.controllerId,
      goal: fields.goal,
      status: "running",
      notifyPolicy: "done_only",
      currentStep,
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
      stateJson,
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
    const input = params && typeof params === "object" ? params : {};
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
  "tasks.runTaskInFlow": ({ params, respond, client }) => {
    const input = params && typeof params === "object" ? params : {};
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
    const flow = resolveTaskFlowForLookupToken(fields.lookup);
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
    const governedMission = readGovernedMissionStateFromTaskFlow(flow);
    if (
      isGovernedMissionFlowClaimed(flow) &&
      (!governedMission || !isGovernedMissionStateCanonicallyPersisted(flow, governedMission))
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "governed_child_task_flow_untrusted: repair the canonical governed mission state before dispatch",
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
      buildPlanRef: fields.buildPlanRef,
      buildItem: fields.buildItem,
      requiredOwnerLane: fields.requiredOwnerLane,
      attemptedOwnerLane: fields.attemptedOwnerLane,
      attemptedExecutor: fields.attemptedExecutor,
      executorRole: fields.executorRole,
      lawfulRouteRequired: fields.lawfulRouteRequired,
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
    const producerDeviceId = client?.connect.device?.id?.trim();
    if (governedMission && (!client?.isDeviceTokenAuth || !producerDeviceId)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "governed_child_task_requires_authenticated_device: governed proof work must be dispatched by a paired device token",
        ),
      );
      return;
    }
    const proofPurpose = productionProofPurposeSchema.safeParse(input.proofPurpose);
    if (governedMission && !proofPurpose.success) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "governed_child_task_proof_purpose_invalid: choose implementation, validation, review, or delivery",
        ),
      );
      return;
    }
    if (governedMission && proofPurpose.success) {
      const designatedDeviceId =
        readPinnedGovernedMissionContract(flow)?.proofProducers?.[proofPurpose.data].deviceId;
      if (!designatedDeviceId || producerDeviceId !== designatedDeviceId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "governed_child_task_producer_unauthorized: paired device does not match the contract-pinned proof producer",
          ),
        );
        return;
      }
    }
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
    const assignmentAuthority = parseProductionExecutorAssignmentAuthority({
      role: fields.executorRole,
      permitted: input.permitted,
      prohibited: input.prohibited,
    });
    if (!assignmentAuthority.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "child_task_assignment_invalid: executorRole, permitted, and prohibited must define a valid executor assignment",
        ),
      );
      return;
    }
    const recordAssignment = (
      task: TaskRecord,
      taskDeliveryState?: TaskDeliveryState,
    ): ReturnType<typeof recordProductionExecutorAssignment> =>
      recordProductionExecutorAssignment({
        flowId: flow.flowId,
        taskId: task.taskId,
        expectedRunId: runId,
        executorId: fields.attemptedExecutor,
        ...(producerDeviceId ? { producerDeviceId } : {}),
        ownerLane: fields.attemptedOwnerLane,
        ...(proofPurpose.success ? { proofPurpose: proofPurpose.data } : {}),
        role: assignmentAuthority.role,
        permitted: assignmentAuthority.permitted,
        prohibited: assignmentAuthority.prohibited,
        evidenceRefs: [fields.workPacketRef, fields.handoffRef],
        assignedAt: now,
        ...(governedMission ? { taskUpdate: task } : {}),
        ...(governedMission && taskDeliveryState ? { taskDeliveryState } : {}),
      });
    let assignment: ReturnType<typeof recordProductionExecutorAssignment> | undefined;
    const child = runTaskInFlowForOwner({
      callerOwnerKey: flow.ownerKey,
      flowId: flow.flowId,
      runtime,
      sourceId: optionalStringField(input.sourceId) ?? fields.workPacketRef,
      childSessionKey,
      parentTaskId: optionalStringField(input.parentTaskId),
      agentId: optionalStringField(input.agentId),
      runId,
      label: optionalStringField(input.label) ?? fields.buildItem,
      task: fields.task,
      notifyPolicy: readTaskNotifyPolicy(input.notifyPolicy),
      // Governed proof delivery is server-observed evidence. Never let the
      // dispatching producer preseed a successful delivery assertion.
      deliveryStatus: governedMission
        ? "pending"
        : (readTaskDeliveryStatus(input.deliveryStatus) ?? "pending"),
      status: input.status === "running" ? "running" : "queued",
      startedAt: input.status === "running" ? now : undefined,
      lastEventAt: now,
      progressSummary: optionalStringField(input.progressSummary),
      preferMetadata: input.preferMetadata === true,
      ...(governedMission
        ? {
            persistTask: (task: TaskRecord, taskDeliveryState?: TaskDeliveryState) => {
              assignment = recordAssignment(task, taskDeliveryState);
              return assignment.applied;
            },
          }
        : {}),
    });
    if (!child.created || !child.task) {
      const assignmentFailure = assignment && !assignment.applied ? assignment.reason : undefined;
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          assignmentFailure
            ? `child_task_assignment_persist_failed: ${assignmentFailure}`
            : `child_task_dispatch_not_authorized: ${child.reason}`,
        ),
      );
      return;
    }
    const governedChildCreatedByRequest = Boolean(governedMission && assignment);
    const backingSession = validateProductionChildBackingSession(child.task);
    if (!backingSession.ok) {
      if (!governedMission || governedChildCreatedByRequest) {
        deleteTaskRecordById(child.task.taskId);
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, backingSession.message));
      return;
    }
    if (governedMission && !assignment) {
      const persistedFlow = getTaskFlowById(flow.flowId);
      const persistedAssignment = persistedFlow
        ? getProductionExecutorAssignment(persistedFlow, child.task.taskId)
        : undefined;
      const matchesRequest = Boolean(
        persistedFlow &&
        persistedAssignment &&
        persistedAssignment.expectedRunId === runId &&
        persistedAssignment.executorId === fields.attemptedExecutor &&
        persistedAssignment.producerDeviceId === producerDeviceId &&
        persistedAssignment.ownerLane === fields.attemptedOwnerLane &&
        persistedAssignment.proofPurpose === proofPurpose.data &&
        persistedAssignment.role === assignmentAuthority.role &&
        JSON.stringify(persistedAssignment.permitted) ===
          JSON.stringify(assignmentAuthority.permitted) &&
        JSON.stringify(persistedAssignment.prohibited) ===
          JSON.stringify(assignmentAuthority.prohibited) &&
        JSON.stringify(persistedAssignment.evidenceRefs) ===
          JSON.stringify([fields.workPacketRef, fields.handoffRef]) &&
        child.task.task === fields.task &&
        child.task.label === (optionalStringField(input.label) ?? fields.buildItem) &&
        isProductionExecutorAssignmentCurrentGovernedAttempt({
          flow: persistedFlow,
          assignment: persistedAssignment,
        }),
      );
      if (!persistedFlow || !persistedAssignment || !matchesRequest) {
        // A deduplicated task belongs to the original request. Never rewrite its
        // immutable authority receipt or compensate work this retry did not create.
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "governed_child_task_idempotency_conflict: the existing run has different or stale executor authority",
          ),
        );
        return;
      }
      assignment = { applied: true, assignment: persistedAssignment, flow: persistedFlow };
    }
    // Child assignment is the authority boundary. Commit it to flow state before
    // returning execution proof so later routing never trusts request assertions.
    assignment ??= recordAssignment(child.task);
    if (!assignment.applied) {
      // Registration is not complete without its authority record. Remove the
      // exact child so a retry cannot leave or duplicate unassigned execution.
      const compensated = deleteTaskRecordById(child.task.taskId);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `child_task_assignment_persist_failed: ${assignment.reason}${compensated ? "" : "; child_task_compensation_failed"}`,
        ),
      );
      return;
    }
    const proof = buildChildExecutionProof({
      buildPlanRef: fields.buildPlanRef,
      buildItem: fields.buildItem,
      workPacketRef: fields.workPacketRef,
      requiredOwnerLane: fields.requiredOwnerLane,
      attemptedOwnerLane: fields.attemptedOwnerLane,
      attemptedExecutor: fields.attemptedExecutor,
      executorRole: fields.executorRole,
      lawfulRouteRequired: fields.lawfulRouteRequired,
      handoffRef: fields.handoffRef,
      handoffAcceptedBy: fields.handoffAcceptedBy,
      ownerLaneGuard: ownerLaneGuard.details,
      taskId: child.task.taskId,
      flowId: flow.flowId,
      childSessionKey: backingSession.childSessionKey,
      deliveryStatus: child.task.deliveryStatus,
    });
    respond(true, {
      flow: assignment.flow,
      task: mapTaskSummary(child.task),
      executorIdentityProof: proof,
    });
  },
  "tasks.recordTaskInFlowProgress": ({ params, respond, client }) => {
    const input = params && typeof params === "object" ? params : {};
    const resolved = resolveProductionChildTaskForMutation(input);
    if (!resolved.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.message));
      return;
    }
    const governedState = readGovernedMissionStateFromTaskFlow(resolved.flow);
    if (
      isGovernedMissionFlowClaimed(resolved.flow) &&
      (!governedState || !isGovernedMissionStateCanonicallyPersisted(resolved.flow, governedState))
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "governed_child_task_flow_untrusted: repair the canonical governed mission state before recording progress",
        ),
      );
      return;
    }
    if (governedState) {
      const governedAssignment = getProductionExecutorAssignment(
        resolved.flow,
        resolved.task.taskId,
      );
      const callerDeviceId = client?.connect.device?.id?.trim();
      if (
        !client?.isDeviceTokenAuth ||
        !callerDeviceId ||
        !governedAssignment ||
        governedAssignment.producerDeviceId !== callerDeviceId ||
        !governedAssignment.governedAttemptReceiptId ||
        !isProductionExecutorAssignmentCurrentGovernedAttempt({
          flow: resolved.flow,
          assignment: governedAssignment,
        })
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "governed_child_task_progress_owner_mismatch: progress requires the current assigned paired device token",
          ),
        );
        return;
      }
      if (
        (resolved.task.status !== "queued" && resolved.task.status !== "running") ||
        resolved.task.missionState === "abandoned"
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "governed_child_task_progress_not_active: progress requires an active governed child",
          ),
        );
        return;
      }
    }
    const backingSession = validateProductionChildBackingSession(resolved.task);
    if (!backingSession.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, backingSession.message));
      return;
    }
    const now = Date.now();
    const task = recordTaskRunProgressById({
      taskId: resolved.task.taskId,
      lastEventAt: now,
      progressSummary: optionalStringField(input.progressSummary),
      eventSummary: optionalStringField(input.eventSummary),
    });
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
  "tasks.completeTaskInFlow": ({ params, respond, client }) => {
    const input = params && typeof params === "object" ? params : {};
    const resolved = resolveProductionChildTaskForMutation(input);
    if (!resolved.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.message));
      return;
    }
    const governedState = readGovernedMissionStateFromTaskFlow(resolved.flow);
    if (
      isGovernedMissionFlowClaimed(resolved.flow) &&
      (!governedState || !isGovernedMissionStateCanonicallyPersisted(resolved.flow, governedState))
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "governed_child_task_flow_untrusted: repair the canonical governed mission state before completion",
        ),
      );
      return;
    }
    const governedAssignment = governedState
      ? getProductionExecutorAssignment(resolved.flow, resolved.task.taskId)
      : undefined;
    const governedAttemptReceiptId = governedAssignment?.governedAttemptReceiptId;
    const callerDeviceId = client?.connect.device?.id?.trim();
    const status = optionalStringField(input.status) ?? "succeeded";
    if (governedState) {
      if (
        !client?.isDeviceTokenAuth ||
        !callerDeviceId ||
        governedAssignment?.producerDeviceId !== callerDeviceId ||
        (status === "succeeded" &&
          (!governedAttemptReceiptId ||
            !isProductionExecutorAssignmentCurrentGovernedAttempt({
              flow: resolved.flow,
              assignment: governedAssignment,
            })))
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "governed_child_task_completion_owner_mismatch: completion requires the dispatching paired device token",
          ),
        );
        return;
      }
    }
    const backingSession = validateProductionChildBackingSession(resolved.task);
    if (status === "succeeded" && !backingSession.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, backingSession.message));
      return;
    }
    const now = Date.now();
    const activeProductionContinuation = getTaskFlowActiveProductionContinuation(resolved.flow);
    const nextExecutableLaunch = readNextExecutableLaunchProof(input.nextExecutableLaunch);
    if (status === "succeeded" && activeProductionContinuation?.activeProductionRun === true) {
      const receipt =
        nextExecutableLaunch && activeProductionContinuation.nextAction
          ? createActiveProductionDispatchReceipt({
              action: {
                ...activeProductionContinuation.nextAction,
                summary: nextExecutableLaunch.detail,
                dispatchProofRef: nextExecutableLaunch.detail,
              },
              dispatchedAt: now,
              proofRef: nextExecutableLaunch.detail,
            })
          : undefined;
      const finality = evaluateActiveProductionFinality({
        state: {
          ...activeProductionContinuation,
          dispatchReceipts: receipt
            ? [...activeProductionContinuation.dispatchReceipts, receipt]
            : activeProductionContinuation.dispatchReceipts,
        },
        attemptedFinalKind: "task_success",
        now,
      });
      if (!finality.allowed) {
        const message =
          finality.result === "hard_boundary"
            ? `child_task_completion_requires_lawful_stop: active production child success is blocked by ${finality.boundary}; record a blocked/rejected child closeout or a lawful production stop instead`
            : "child_task_completion_requires_continuation_proof: active production child success must include nextExecutableLaunch proof or record a lawful production stop before local success can be accepted";
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
        return;
      }
    }
    const common = {
      taskId: resolved.task.taskId,
      endedAt: now,
      lastEventAt: now,
      // The contract-pinned paired device was authenticated above. Its successful
      // completion is the server-observed delivery acknowledgment for this exact proof.
      ...(status === "succeeded" && governedState ? { deliveryStatus: "delivered" as const } : {}),
      progressSummary: optionalStringField(input.progressSummary),
      terminalSummary: optionalStringField(input.terminalSummary),
    };
    let governedContinuationFlow: TaskFlowRecord | undefined;
    let governedCompletionReplayFlow: TaskFlowRecord | undefined;
    let governedContinuationFailure: string | undefined;
    const terminalStatus =
      status === "succeeded"
        ? "succeeded"
        : status === "blocked" || status === "rejected" || status === "failed"
          ? "failed"
          : status === "timed_out" || status === "cancelled"
            ? status
            : null;
    const task = terminalStatus
      ? finalizeTaskRunById(
          {
            ...common,
            status: terminalStatus,
            ...(status === "blocked" || status === "rejected"
              ? {
                  error: optionalStringField(input.error) ?? status,
                  terminalOutcome: "blocked" as const,
                }
              : status === "failed" || status === "timed_out" || status === "cancelled"
                ? { error: optionalStringField(input.error) }
                : {}),
          },
          status === "succeeded" &&
            governedState &&
            governedAssignment &&
            governedAttemptReceiptId &&
            callerDeviceId
            ? {
                persist: (taskUpdate) => {
                  const launched = commitGovernedMissionChildCompletion({
                    flowId: resolved.flow.flowId,
                    expectedFlowRevision: resolved.flow.revision,
                    producerDeviceId: callerDeviceId,
                    governedAttemptReceiptId,
                    assignmentSha256: computeProductionExecutorAssignmentSha256(governedAssignment),
                    ...(nextExecutableLaunch
                      ? {
                          nextExecutableLaunch: {
                            detail: nextExecutableLaunch.detail,
                            currentStep:
                              nextExecutableLaunch.currentStep ?? resolved.flow.currentStep,
                          },
                        }
                      : {}),
                    occurredAt: now,
                    taskUpdate,
                  });
                  if (!launched.applied) {
                    if (launched.reason === "already_applied") {
                      governedCompletionReplayFlow = launched.current;
                      return false;
                    }
                    governedContinuationFailure = launched.reason;
                    return false;
                  }
                  governedContinuationFlow = launched.flow;
                  return true;
                },
                syncParentFlow: false,
              }
            : undefined,
        )
      : null;
    if (governedCompletionReplayFlow) {
      const canonicalTask = getTaskById(resolved.task.taskId);
      if (canonicalTask?.status === "succeeded" && canonicalTask.deliveryStatus === "delivered") {
        respond(true, {
          flow: governedCompletionReplayFlow,
          task: mapTaskSummary(canonicalTask),
        });
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "child_task_completion_canonical_task_missing"),
      );
      return;
    }
    if (governedContinuationFailure) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `child_task_completion_continuation_launch_failed: ${governedContinuationFailure}`,
        ),
      );
      return;
    }
    if (!terminalStatus) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "child_task_terminal_status_invalid: expected succeeded, failed, timed_out, cancelled, blocked, or rejected",
        ),
      );
      return;
    }
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
      if (governedContinuationFlow) {
        flow = governedContinuationFlow;
      } else {
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
    }
    respond(true, {
      flow,
      task: mapTaskSummary(task),
    });
  },
  "tasks.recordProductionFlowLawfulStop": ({ params, respond }) => {
    const input = params && typeof params === "object" ? params : {};
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
    try {
      const initial = await readActiveWorkWatchdogJob(context, "initial-read");
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

      const closeReconcile = await reconcileProductionWatchdogCron({ cron: context.cron });
      if (!closeReconcile.ok) {
        respond(
          false,
          {
            flowId: finished.flow.flowId,
            initialEnabled: initial.enabled,
            afterOpenEnabled,
            lifecycleCloseReconcile: closeReconcile,
          },
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `watchdog lifecycle close reconcile failed: ${closeReconcile.action}`,
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
    } catch (error) {
      if (isWatchdogProbeDiagnosticError(error)) {
        respond(
          false,
          {
            ok: false,
            diagnostic: {
              kind: "watchdog_lifecycle_probe_timeout",
              ...error.diagnostic,
            },
          },
          errorShape(ErrorCodes.UNAVAILABLE, error.message),
        );
        return;
      }
      throw error;
    }
  },
};

export const testApi = {
  mapTaskSummary,
};
export { testApi as __test };
