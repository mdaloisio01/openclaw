import crypto from "node:crypto";
import { z } from "zod";
import type { AgentWaitResult } from "../agents/run-wait.js";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  createCleanupCrewExecutorCapabilityRecord,
  resolveCleanupCrewCapabilityRoute,
  validateCleanupCrewMissionAbortExhaustionReceipt,
  type CleanupCrewMissionAbortExhaustionReceipt,
} from "../continuity/continuity-gate-v2.js";
import { triageBuildDiscoveredIssue } from "../governance/build-discovered-issue-triage.js";
import {
  getProductionExecutorAssignment,
  productionExecutorCapabilitySchema,
  productionExecutorRoleSchema,
} from "./production-executor-assignment.js";
import { evaluateProductionOwnerLaneGuard } from "./production-owner-lane-guard.js";
import { getTaskById } from "./runtime-internal.js";
import type { JsonValue, TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  listTaskFlowsForOwnerKey,
  recordFlowLawfulStop,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";

const text = z.string().trim().min(1).max(4_096);
const identity = z.string().trim().min(1).max(256);
const evidenceRefs = z.array(text).min(1).max(32);
const executor = z.strictObject({
  taskId: identity,
  expectedRunId: identity,
  ownerLane: identity,
  role: productionExecutorRoleSchema,
  permitted: z.array(productionExecutorCapabilitySchema).min(1),
  prohibited: z.array(productionExecutorCapabilitySchema),
  evidenceRefs,
});
const common = {
  flowId: identity,
  ownerKey: identity,
  actionId: identity,
  occurrenceId: identity,
  issueId: identity,
  summary: text,
  evidenceRefs,
};
const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("triage"),
    impact: z.enum([
      "non_blocking",
      "current_blocker",
      "unsafe",
      "dishonest",
      "impossible",
      "operator_decision",
    ]),
    resume: z.strictObject({ executor, message: text }).optional(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("recover_execution_surface"),
    primaryFailure: z.strictObject({
      taskId: identity,
      kind: z.enum(["execution_unavailable", "policy_denied"]),
      evidenceRefs,
    }),
    requiredCapability: productionExecutorCapabilitySchema,
    executors: z.array(executor).max(32),
    message: text,
    exhaustion: z
      .custom<CleanupCrewMissionAbortExhaustionReceipt>(
        (value) => validateCleanupCrewMissionAbortExhaustionReceipt(value).ok,
      )
      .optional(),
  }),
]);

const executionTarget = { taskId: identity, sessionKey: identity };
const executionSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not_dispatched"), reason: text }),
  z.strictObject({ state: z.literal("dispatch_pending"), ...executionTarget }),
  z.strictObject({ state: z.literal("dispatch_unknown"), ...executionTarget, reason: text }),
  z.strictObject({ state: z.literal("dispatch_failed"), reason: text }),
  z.strictObject({ state: z.literal("awaiting_result"), ...executionTarget, runId: identity }),
  z.strictObject({
    state: z.literal("terminal_result_observed"),
    ...executionTarget,
    runId: identity,
    resultStatus: z.enum(["ok", "error", "timeout"]),
    reply: z.string().optional(),
  }),
]);
const receiptSchema = z.strictObject({
  input: actionSchema,
  inputHash: identity,
  createdAt: z.number(),
  updatedAt: z.number(),
  duplicateOfFlowId: identity.optional(),
  decision: text,
  execution: executionSchema,
});
type Action = z.infer<typeof actionSchema>;
type Executor = z.infer<typeof executor>;
type Receipt = z.infer<typeof receiptSchema>;
type Execution = Receipt["execution"];
type IssueAction =
  | { kind: "stop"; decision: string }
  | {
      kind: "dispatch";
      decision: string;
      target: { taskId: string; sessionKey: string };
      message: string;
    };

const sendResultSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    details: z.object({
      status: z.enum(["ok", "error", "forbidden", "accepted", "timeout"]),
      runId: identity.optional(),
      dispatchState: z.literal("not_dispatched").optional(),
      reply: z.string().optional(),
      error: z.string().optional(),
    }),
  }),
});
const admissionFailureSchema = z.object({
  ok: z.literal(false),
  status: z.number(),
  error: z.object({ message: z.string() }),
});

function flowState(flow: TaskFlowRecord): Record<string, JsonValue> {
  const value = flow.stateJson;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("build_issue_flow_state_missing");
  }
  return value;
}

function receipts(flow: TaskFlowRecord): Receipt[] {
  const state = flow.stateJson;
  const value =
    state && typeof state === "object" && !Array.isArray(state)
      ? state.buildIssueActions
      : undefined;
  return value === undefined ? [] : z.array(receiptSchema).parse(value);
}

function persistReceipt(flowId: string, receipt: Receipt): Receipt {
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    throw new Error("build_issue_flow_missing");
  }
  const previous = receipts(flow);
  const next = [
    ...previous.filter((entry) => entry.input.actionId !== receipt.input.actionId),
    receipt,
  ];
  const saved = updateFlowRecordByIdExpectedRevision({
    flowId,
    expectedRevision: flow.revision,
    patch: {
      stateJson: { ...flowState(flow), buildIssueActions: next },
      updatedAt: receipt.updatedAt,
    },
  });
  if (!saved.applied) {
    throw new Error(`build_issue_receipt_write_failed:${saved.reason}`);
  }
  const readback = getTaskFlowById(flowId);
  const verified =
    readback && receipts(readback).find((entry) => entry.input.actionId === receipt.input.actionId);
  if (!verified || stableStringify(verified) !== stableStringify(receipt)) {
    throw new Error("build_issue_receipt_readback_failed");
  }
  return verified;
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = [...new Set(left)].toSorted();
  const rightSet = [...new Set(right)].toSorted();
  return (
    leftSet.length === rightSet.length &&
    leftSet.every((capability, index) => capability === rightSet[index])
  );
}

function resolveExecutor(flow: TaskFlowRecord, candidate: Executor) {
  const task = getTaskById(candidate.taskId);
  const assignment = getProductionExecutorAssignment(flow, candidate.taskId);
  // Candidate fields identify a persisted assignment; they never grant lane,
  // role, or capability authority. Missing or changed authority fails closed.
  const assignmentMatches =
    assignment !== undefined &&
    assignment.expectedRunId === candidate.expectedRunId &&
    assignment.ownerLane === candidate.ownerLane &&
    assignment.role === candidate.role &&
    sameCapabilities(assignment.permitted, candidate.permitted) &&
    sameCapabilities(assignment.prohibited, candidate.prohibited);
  if (!assignment || !assignmentMatches) {
    return undefined;
  }
  const identityMatches =
    task?.ownerKey === flow.ownerKey &&
    task.parentFlowId === flow.flowId &&
    task.runId === assignment.expectedRunId &&
    Boolean(task.childSessionKey);
  const state = flowState(flow);
  const ownerGuard = evaluateProductionOwnerLaneGuard({
    buildPlanRef: typeof state.authorityPath === "string" ? state.authorityPath : undefined,
    buildItem: typeof state.buildItem === "string" ? state.buildItem : undefined,
    requiredOwnerLane:
      typeof state.requiredOwnerLane === "string" ? state.requiredOwnerLane : undefined,
    attemptedOwnerLane: assignment.ownerLane,
    attemptedExecutor: assignment.executorId,
    executorRole: assignment.role,
    lawfulRouteRequired:
      typeof state.lawfulRouteRequired === "string" ? state.lawfulRouteRequired : undefined,
  });
  return createCleanupCrewExecutorCapabilityRecord({
    executorId: assignment.taskId,
    role: assignment.role,
    sessionKey: identityMatches ? task?.childSessionKey : undefined,
    taskId: candidate.taskId,
    runId: identityMatches ? task?.runId : undefined,
    available: ownerGuard.allowed && (task?.status === "running" || task?.status === "queued"),
    stale: !identityMatches,
    permitted: assignment.permitted,
    prohibited: assignment.prohibited,
    receiptRequirements: assignment.evidenceRefs,
  });
}

function resolveAction(
  flow: TaskFlowRecord,
  input: Action,
  duplicateOfFlowId?: string,
): IssueAction {
  const continuation = getTaskFlowProductionContinuation(flow);
  const ownerBoundary =
    continuation?.ownerDecisionRequired ||
    continuation?.hardStopPresent ||
    continuation?.safetyStopPresent ||
    continuation?.restartOrReloadRequired;
  if (ownerBoundary || (input.kind === "triage" && continuation?.blockerPresent)) {
    return { kind: "stop", decision: "production_boundary_requires_resolution" };
  }
  if (input.kind === "triage") {
    const decision = triageBuildDiscoveredIssue({
      activeBuildMission: true,
      duplicateIssueId: duplicateOfFlowId ? input.issueId : undefined,
      blocksCurrentMission: input.impact === "current_blocker",
      continuingWouldBeUnsafe: input.impact === "unsafe",
      continuingWouldBeDishonest: input.impact === "dishonest",
      continuingWouldBeImpossible: input.impact === "impossible",
      operatorDecisionRequired: input.impact === "operator_decision",
      issueRegisterUpdated: true,
      lawfulResumeAction: input.resume?.message,
    });
    if (!decision.shouldResumeActiveBuild) {
      return { kind: "stop", decision: decision.action };
    }
    if (!input.resume) {
      throw new Error("build_issue_resume_action_required");
    }
    const selected = resolveExecutor(flow, input.resume.executor);
    if (
      !selected ||
      !selected.available ||
      selected.stale ||
      !selected.session_key ||
      !selected.permitted.includes("production_dispatch") ||
      selected.prohibited.includes("production_dispatch")
    ) {
      return { kind: "stop", decision: "resume_executor_unavailable" };
    }
    return {
      kind: "dispatch",
      decision: decision.action,
      target: { taskId: selected.executor_id, sessionKey: selected.session_key },
      message: input.resume.message,
    };
  }
  const primary = getTaskById(input.primaryFailure.taskId);
  if (!primary || primary.ownerKey !== flow.ownerKey || primary.parentFlowId !== flow.flowId) {
    throw new Error("build_issue_primary_executor_owner_mismatch");
  }
  if (input.primaryFailure.kind === "policy_denied") {
    return { kind: "stop", decision: "policy_denial_requires_authorized_resolution" };
  }
  if (input.executors.some((entry) => entry.taskId === primary.taskId)) {
    throw new Error("build_issue_alternate_executor_must_differ_from_failed_primary");
  }
  const candidates = input.executors
    .map((entry) => resolveExecutor(flow, entry))
    .filter((entry) => entry !== undefined);
  const route = resolveCleanupCrewCapabilityRoute({
    missionId: flow.flowId,
    requiredCapability: input.requiredCapability,
    executors: candidates,
    evidence: [...input.evidenceRefs, ...input.primaryFailure.evidenceRefs],
  });
  const selected = candidates.find((entry) => entry.executor_id === route.selected_executor_id);
  if (route.outcome === "route_to_available_executor" && selected?.session_key) {
    return {
      kind: "dispatch",
      decision: route.outcome,
      target: { taskId: selected.executor_id, sessionKey: selected.session_key },
      message: input.message,
    };
  }
  if (input.exhaustion) {
    const validation = validateCleanupCrewMissionAbortExhaustionReceipt(input.exhaustion, {
      missionId: flow.flowId,
    });
    if (!validation.ok) {
      throw new Error(validation.errors.join(","));
    }
    return { kind: "stop", decision: "mission_bound_exhaustion_recorded" };
  }
  return { kind: "stop", decision: route.outcome };
}

function recordDecisionBoundary(receipt: Receipt): void {
  if (
    receipt.execution.state !== "not_dispatched" &&
    receipt.execution.state !== "dispatch_failed"
  ) {
    return;
  }
  const flow = getTaskFlowById(receipt.input.flowId);
  if (!flow || flow.endedAt !== undefined) {
    return;
  }
  const continuation = getTaskFlowProductionContinuation(flow);
  // Preserve a stronger existing boundary. Technical repair may proceed only
  // through a separately authorized recovery action, never a hidden resume.
  if (continuation?.lawfulStopReason) {
    return;
  }
  const impact = receipt.input.kind === "triage" ? receipt.input.impact : undefined;
  const reason =
    impact === "operator_decision"
      ? "owner_decision"
      : impact === "unsafe" || receipt.decision === "policy_denial_requires_authorized_resolution"
        ? "safety_stop"
        : "blocker";
  const saved = recordFlowLawfulStop({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    reason,
    currentStep: "build_issue_resolution_required",
    detail: `build_issue:${receipt.input.issueId}:${receipt.input.actionId}:${receipt.decision}`,
  });
  if (!saved.applied) {
    throw new Error(`build_issue_boundary_write_failed:${saved.reason}`);
  }
}

function observeDispatch(
  target: { taskId: string; sessionKey: string },
  value: unknown,
): Execution {
  const admitted = sendResultSchema.safeParse(value);
  if (admitted.success) {
    const result = admitted.data.result.details;
    if (result.dispatchState === "not_dispatched" || result.status === "forbidden") {
      return { state: "dispatch_failed", reason: result.error ?? result.status };
    }
    if (!result.runId) {
      return { state: "dispatch_unknown", ...target, reason: "executor_run_identity_missing" };
    }
    if (result.status === "ok") {
      return {
        state: "terminal_result_observed",
        ...target,
        runId: result.runId,
        resultStatus: "ok",
        ...(result.reply !== undefined ? { reply: result.reply } : {}),
      };
    }
    // sessions_send can return error after dispatch when its RPC or wait fails.
    // Preserve that run identity so retries reconcile it instead of declaring
    // admission failed and authorizing another execution with unknown effects.
    return { state: "awaiting_result", ...target, runId: result.runId };
  }
  const rejected = admissionFailureSchema.safeParse(value);
  if (rejected.success && rejected.data.status < 500) {
    return { state: "dispatch_failed", reason: rejected.data.error.message };
  }
  return { state: "dispatch_unknown", ...target, reason: "executor_dispatch_outcome_unproven" };
}

export async function handleBuildIssueAction(params: {
  input: unknown;
  dispatch: (request: {
    ownerKey: string;
    sessionKey: string;
    message: string;
    actionId: string;
  }) => Promise<unknown>;
  waitForRun: (runId: string) => Promise<AgentWaitResult>;
}): Promise<Receipt> {
  const input = actionSchema.parse(params.input);
  const flow = getTaskFlowById(input.flowId);
  if (!flow || flow.ownerKey !== input.ownerKey || flow.syncMode !== "managed") {
    throw new Error("build_issue_flow_owner_mismatch");
  }
  const inputHash = crypto.createHash("sha256").update(stableStringify(input)).digest("hex");
  const ownerReceipts = listTaskFlowsForOwnerKey(flow.ownerKey).flatMap((entry) =>
    receipts(entry).map((receipt) => ({ flowId: entry.flowId, receipt })),
  );
  const retained = ownerReceipts.find(
    ({ receipt }) =>
      receipt.input.actionId === input.actionId ||
      receipt.input.occurrenceId === input.occurrenceId,
  );
  if (retained) {
    if (retained.flowId !== flow.flowId || retained.receipt.inputHash !== inputHash) {
      throw new Error("build_issue_idempotency_conflict");
    }
    recordDecisionBoundary(retained.receipt);
    const execution = retained.receipt.execution;
    if (execution.state !== "awaiting_result") {
      return retained.receipt;
    }
    const result = await params.waitForRun(execution.runId);
    const resultStatus =
      result.status === "ok" || result.status === "error" || result.status === "timeout"
        ? result.status
        : undefined;
    // A polling or transport timeout has no endedAt. A terminal run timeout
    // carries endedAt and must settle the receipt so retries do not poll forever.
    if (!resultStatus || result.endedAt === undefined) {
      return retained.receipt;
    }
    return persistReceipt(flow.flowId, {
      ...retained.receipt,
      updatedAt: Date.now(),
      execution: {
        ...execution,
        state: "terminal_result_observed",
        resultStatus,
      },
    });
  }
  const continuation = getTaskFlowProductionContinuation(flow);
  if (
    flow.endedAt !== undefined ||
    flow.cancelRequestedAt !== undefined ||
    !continuation?.activeProductionRun ||
    !continuation.parentRunOpen
  ) {
    throw new Error("build_issue_active_production_flow_required");
  }
  const duplicateOfFlowId = ownerReceipts.find(
    ({ receipt }) => receipt.input.issueId === input.issueId,
  )?.flowId;
  const action = resolveAction(flow, input, duplicateOfFlowId);
  const now = Date.now();
  const receipt: Receipt = {
    input,
    inputHash,
    createdAt: now,
    updatedAt: now,
    ...(duplicateOfFlowId ? { duplicateOfFlowId } : {}),
    decision: action.decision,
    execution:
      action.kind === "dispatch"
        ? { state: "dispatch_pending", ...action.target }
        : { state: "not_dispatched", reason: action.decision },
  };
  // Persist the occurrence and dispatch intent before the side effect. A retry
  // may reconcile a known run, but must never resend an ambiguous pending call.
  persistReceipt(flow.flowId, receipt);
  if (action.kind === "stop") {
    recordDecisionBoundary(receipt);
    return receipt;
  }
  let execution: Execution;
  try {
    const result = await params.dispatch({
      ownerKey: flow.ownerKey,
      sessionKey: action.target.sessionKey,
      message: action.message,
      actionId: input.actionId,
    });
    execution = observeDispatch(action.target, result);
  } catch {
    execution = {
      ...action.target,
      state: "dispatch_unknown",
      reason: "executor_dispatch_interrupted",
    };
  }
  // This records the executor result only. Neither acceptance nor a successful
  // child turn settles the parent mission or its visible-delivery obligation.
  const result = persistReceipt(flow.flowId, { ...receipt, execution, updatedAt: Date.now() });
  recordDecisionBoundary(result);
  return result;
}
