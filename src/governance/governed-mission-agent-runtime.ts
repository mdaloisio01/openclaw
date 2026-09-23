import { createHash, randomUUID } from "node:crypto";
import { getProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  findGovernedMissionReceiptByIdempotencyFromSqlite,
  listGovernedMissionOwnerClaimFlowIdsFromSqlite,
} from "../tasks/task-flow-registry.store.sqlite.js";
import type { JsonValue, TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  commitGovernedMissionLedger,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  listTaskFlowsForOwnerKey,
} from "../tasks/task-flow-runtime-internal.js";
import {
  observeGovernedMissionIdentity,
  type GovernedRuntimeIdentity,
} from "./governed-mission-identity.js";
import {
  GOVERNED_MISSION_RUNTIME_PRODUCER,
  type GovernedMissionLedgerReceipt,
} from "./governed-mission-ledger.types.js";
import {
  applyGovernedMissionOperation,
  isGovernedMissionStateCanonicallyPersisted,
  readPinnedGovernedMissionContract,
} from "./governed-mission-runtime.js";
import {
  hasGovernedMissionStateValue,
  readGovernedMissionStateFromTaskFlow,
  type GovernedMissionState,
} from "./governed-mission-state.js";
import type { GovernedMissionIdentityBindings } from "./governed-mission-transition.js";
import type {
  MissionSpecificToolEnforcementAuthority,
  MissionSpecificToolEnforcementDecision,
  MissionSpecificToolInvocation,
} from "./mission-specific-tool-enforcement.js";
import type { TrustedHostPolicy } from "./protected-action-policy.js";

export type GovernedMissionToolEnforcementContext = {
  active: true;
  conversationClassification: "governed";
  expectedCurrentStep: string;
  trustedHostPolicy: TrustedHostPolicy;
  authority: MissionSpecificToolEnforcementAuthority;
  resolveAuthority: () => MissionSpecificToolEnforcementAuthority | undefined;
  onDecision: (
    decision: MissionSpecificToolEnforcementDecision,
    invocation?: MissionSpecificToolInvocation,
  ) => void;
};

export type GovernedMissionAgentRunPreparation =
  | { status: "irrelevant" }
  | {
      status: "bound";
      flowId: string;
      attemptReceiptId: string;
      toolEnforcement: GovernedMissionToolEnforcementContext;
    }
  | { status: "blocked"; reasonCode: string; message: string };

const TERMINAL_FLOW_STATUSES = new Set<TaskFlowRecord["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);
const GOVERNED_RUNTIME_INSTANCE_ID = randomUUID();

/** Classify a session before any plugin hook can observe its prompt or model-selected data. */
export function hasGovernedMissionClaimForOwnerKey(ownerKeyValue: string): boolean {
  const ownerKey = ownerKeyValue.trim();
  if (!ownerKey) {
    return false;
  }
  // Durable admission remains authoritative even when the mutable flow state is
  // missing or malformed. Such corruption must block the turn, never declassify it.
  return (
    listGovernedMissionOwnerClaimFlowIdsFromSqlite(ownerKey).length > 0 ||
    listTaskFlowsForOwnerKey(ownerKey).some(hasGovernedMissionStateValue)
  );
}

function isCanonicalTerminalGovernedFlow(flow: TaskFlowRecord): boolean {
  if (!TERMINAL_FLOW_STATUSES.has(flow.status)) {
    return false;
  }
  const state = readGovernedMissionStateFromTaskFlow(flow);
  if (
    !state ||
    state.activeExecutionLease ||
    !isGovernedMissionStateCanonicallyPersisted(flow, state)
  ) {
    return false;
  }
  if (state.currentGovernedState === "released") {
    return flow.status === "succeeded" && state.terminalStatus === "succeeded";
  }
  if (
    state.currentGovernedState === "cancelled" ||
    state.currentGovernedState === "operator_stopped"
  ) {
    return flow.status === "cancelled" && state.terminalStatus === "cancelled";
  }
  if (state.currentGovernedState === "failed") {
    return flow.status === "failed" && state.terminalStatus === "failed";
  }
  if (state.currentGovernedState === "lost") {
    return flow.status === "lost" && state.terminalStatus === "lost";
  }
  return false;
}

function priorLeaseOwnerIsProvablyGone(
  lease: NonNullable<GovernedMissionState["activeExecutionLease"]>,
): boolean {
  // A different instance with our PID proves PID reuse after the prior process exited.
  if (lease.processId === process.pid) {
    return lease.runtimeInstanceId !== GOVERNED_RUNTIME_INSTANCE_ID;
  }
  if (lease.processStartTime !== undefined) {
    const currentStartTime = getProcessStartTime(lease.processId);
    if (currentStartTime !== null && currentStartTime !== lease.processStartTime) {
      return true;
    }
  }
  return isPidDefinitelyDead(lease.processId);
}

/** Resolve and advance only canonical persisted governed state before model execution. */
export function prepareGovernedMissionAgentRun(params: {
  ownerKey: string;
  runId: string;
  occurredAt?: string;
  trustedRuntimeIdentity?: GovernedRuntimeIdentity;
  observedSkillSha256?: string;
  readObservedSkillSha256?: () => string | undefined;
}): GovernedMissionAgentRunPreparation {
  const ownerKey = params.ownerKey.trim();
  if (!ownerKey) {
    return { status: "irrelevant" };
  }
  const ownerFlows = listTaskFlowsForOwnerKey(ownerKey);
  const durableClaimFlowIds = listGovernedMissionOwnerClaimFlowIdsFromSqlite(ownerKey);
  if (durableClaimFlowIds.length > 1) {
    return blocked(
      "MULTIPLE_ACTIVE_GOVERNED_MISSIONS",
      "Multiple durable governed mission claims are bound to this agent session.",
    );
  }
  const durableClaimFlow = durableClaimFlowIds[0]
    ? ownerFlows.find((flow) => flow.flowId === durableClaimFlowIds[0])
    : undefined;
  if (durableClaimFlowIds.length === 1 && !durableClaimFlow) {
    return blocked(
      "GOVERNED_MISSION_FLOW_MISSING",
      "The durable governed mission claim has no readable TaskFlow state.",
    );
  }
  const candidates = durableClaimFlow
    ? [durableClaimFlow]
    : ownerFlows.filter(hasGovernedMissionStateValue);
  if (candidates.length === 0) {
    return { status: "irrelevant" };
  }
  if (candidates.length > 1) {
    return blocked(
      "MULTIPLE_ACTIVE_GOVERNED_MISSIONS",
      "Multiple active governed missions are bound to this agent session.",
    );
  }
  let flow = candidates[0];
  let state = readGovernedMissionStateFromTaskFlow(flow);
  if (!state) {
    return blocked("MALFORMED_GOVERNED_MISSION_STATE", "Governed mission state is malformed.");
  }
  if (
    flow.ownerKey !== ownerKey ||
    (state.ownerCorrelation.sessionKey !== undefined &&
      state.ownerCorrelation.sessionKey !== ownerKey)
  ) {
    return blocked(
      "GOVERNED_MISSION_OWNER_MISMATCH",
      "Governed mission ownership does not match the active agent session.",
    );
  }
  if (!isGovernedMissionStateCanonicallyPersisted(flow, state)) {
    return blocked(
      "GOVERNED_MISSION_PROVENANCE_INVALID",
      "Governed mission state is not backed by its canonical SQLite receipt chain.",
    );
  }

  if (isCanonicalTerminalGovernedFlow(flow)) {
    return blocked(
      "GOVERNED_MISSION_SESSION_TERMINAL",
      "This agent session is bound to a terminal governed mission; start a new session for more work.",
    );
  }

  const productionContinuation = getTaskFlowProductionContinuation(flow);
  if (
    productionContinuation?.activeProductionRun &&
    (!productionContinuation.parentRunOpen || productionContinuation.lawfulStopReason)
  ) {
    return blocked(
      "GOVERNED_PRODUCTION_BOUNDARY_ACTIVE",
      "The governed production flow has a lawful stop boundary that must be resolved before more work starts.",
    );
  }

  if (flow.cancelRequestedAt != null) {
    return blocked(
      "GOVERNED_CANCELLATION_PENDING",
      "The governed mission has a pending cancellation and cannot start more work.",
    );
  }

  if (
    state.currentGovernedState === "admitted" ||
    state.currentGovernedState === "repair_required"
  ) {
    const bindings = observeGovernedMissionIdentity({
      mission: state,
      trustedRuntimeIdentity: params.trustedRuntimeIdentity,
      observedSkillSha256: params.observedSkillSha256,
    });
    if (!bindings) {
      return blocked(
        "GOVERNED_IDENTITY_UNAVAILABLE",
        "The host could not remeasure the governed mission identity.",
      );
    }
    const occurredAt = params.occurredAt ?? new Date().toISOString();
    const started = applyGovernedMissionOperation({
      flowId: flow.flowId,
      request: {
        operation: "startWorkOrder",
        expectedRevision: state.revision,
        idempotencyKey: `agent-run:${params.runId}:start-work-order`,
        owner: flow.ownerKey,
        controllerId: flow.controllerId,
        bindings,
        occurredAt,
      },
    });
    if (started.status !== "applied" && started.status !== "already_applied") {
      return blocked(
        `GOVERNED_START_${started.status.toUpperCase()}`,
        "The governed work-order start transition was not accepted.",
      );
    }
    flow = getTaskFlowById(flow.flowId) ?? flow;
    state = readGovernedMissionStateFromTaskFlow(flow);
    if (!state || state.currentGovernedState !== "executing") {
      return blocked(
        "GOVERNED_START_STATE_MISMATCH",
        "The governed mission did not enter its executing state.",
      );
    }
  }

  if (state.currentGovernedState !== "executing") {
    return blocked(
      "GOVERNED_MISSION_NOT_EXECUTABLE",
      `Governed mission state ${state.currentGovernedState} does not admit agent execution.`,
    );
  }

  if (state.activeExecutionLease && priorLeaseOwnerIsProvablyGone(state.activeExecutionLease)) {
    const bindings = observeGovernedMissionIdentity({
      mission: state,
      trustedRuntimeIdentity: params.trustedRuntimeIdentity,
      observedSkillSha256: params.observedSkillSha256,
    });
    if (!bindings) {
      return blocked(
        "GOVERNED_IDENTITY_UNAVAILABLE",
        "The host could not remeasure the governed mission identity.",
      );
    }
    const staleRunId = state.activeExecutionLease.runId;
    const occurredAt = params.occurredAt ?? new Date().toISOString();
    const recovered = applyGovernedMissionOperation({
      flowId: flow.flowId,
      request: {
        operation: "closeExecutionLease",
        expectedRevision: state.revision,
        idempotencyKey: `agent-run:${params.runId}:recover-stale-lease:${staleRunId}`,
        owner: flow.ownerKey,
        controllerId: flow.controllerId,
        bindings,
        occurredAt,
        runId: staleRunId,
      },
    });
    if (recovered.status !== "applied" && recovered.status !== "already_applied") {
      return blocked(
        `GOVERNED_EXECUTION_LEASE_RECOVERY_${recovered.status.toUpperCase()}`,
        "The prior governed execution lease could not be safely recovered.",
      );
    }
    flow = getTaskFlowById(flow.flowId) ?? flow;
    state = readGovernedMissionStateFromTaskFlow(flow);
    if (!state || state.activeExecutionLease) {
      return blocked(
        "GOVERNED_EXECUTION_LEASE_RECOVERY_STATE_MISMATCH",
        "The prior governed execution lease remained active after recovery.",
      );
    }
  }

  if (state.activeExecutionLease && state.activeExecutionLease.runId !== params.runId) {
    return blocked(
      "GOVERNED_EXECUTION_LEASE_CONFLICT",
      "Another governed embedded run still owns the persisted execution lease.",
    );
  }
  const contract = readPinnedGovernedMissionContract(flow);
  const bindings = observeGovernedMissionIdentity({
    mission: state,
    trustedRuntimeIdentity: params.trustedRuntimeIdentity,
    observedSkillSha256: params.observedSkillSha256,
  });
  if (!contract || !bindings) {
    return blocked(
      "GOVERNED_IDENTITY_UNAVAILABLE",
      "The host could not remeasure the governed mission identity.",
    );
  }
  let attemptReceipt: GovernedMissionLedgerReceipt | undefined;
  if (!state.activeExecutionLease) {
    const occurredAt = params.occurredAt ?? new Date().toISOString();
    const processStartTime = getProcessStartTime(process.pid);
    const opened = applyGovernedMissionOperation({
      flowId: flow.flowId,
      request: {
        operation: "openExecutionLease",
        expectedRevision: state.revision,
        idempotencyKey: `agent-run:${params.runId}:open-execution-lease`,
        owner: flow.ownerKey,
        controllerId: flow.controllerId,
        bindings,
        occurredAt,
        runId: params.runId,
        processId: process.pid,
        ...(processStartTime !== null ? { processStartTime } : {}),
        runtimeInstanceId: GOVERNED_RUNTIME_INSTANCE_ID,
      },
    });
    if (opened.status !== "applied" && opened.status !== "already_applied") {
      return blocked(
        `GOVERNED_EXECUTION_LEASE_${opened.status.toUpperCase()}`,
        "The governed execution lease could not be opened.",
      );
    }
    attemptReceipt = opened.receipt;
    flow = getTaskFlowById(flow.flowId) ?? flow;
    state = readGovernedMissionStateFromTaskFlow(flow);
    if (!state || state.activeExecutionLease?.runId !== params.runId) {
      return blocked(
        "GOVERNED_EXECUTION_LEASE_STATE_MISMATCH",
        "The governed execution lease was not durably persisted.",
      );
    }
  } else {
    attemptReceipt = findGovernedMissionReceiptByIdempotencyFromSqlite({
      missionId: state.missionId,
      idempotencyKey: `agent-run:${params.runId}:open-execution-lease`,
    });
  }

  const authority: MissionSpecificToolEnforcementAuthority = {
    governedMissionAdmitted: true,
    contract,
    missionState: state,
    expectedCurrentStep: state.currentStep,
    observedContractHash: bindings.contractHash,
    observedAuthorityHash: bindings.authorityHash,
    requiredEvidencePresent: true,
    enforcementHealth: { healthy: true },
  };
  if (
    !attemptReceipt ||
    attemptReceipt.operation !== "openExecutionLease" ||
    attemptReceipt.decision !== "applied" ||
    attemptReceipt.flowId !== flow.flowId ||
    attemptReceipt.attemptId !== params.runId ||
    attemptReceipt.contractHash !== state.contractHash
  ) {
    return closeRejectedPreparationLease({
      flowId: flow.flowId,
      runId: params.runId,
      ...(params.trustedRuntimeIdentity
        ? { trustedRuntimeIdentity: params.trustedRuntimeIdentity }
        : {}),
      observedSkillSha256: params.observedSkillSha256,
      reasonCode: "GOVERNED_ATTEMPT_RECEIPT_MISSING",
      message: "The current governed execution attempt is not backed by its lease receipt.",
    });
  }
  const missionRevision = state.revision;
  return {
    status: "bound",
    flowId: flow.flowId,
    attemptReceiptId: attemptReceipt.receiptId,
    toolEnforcement: {
      active: true,
      conversationClassification: "governed",
      expectedCurrentStep: state.currentStep,
      trustedHostPolicy: state.trustedHostPolicy,
      authority,
      resolveAuthority: () =>
        resolveToolEnforcementAuthority({
          flowId: flow.flowId,
          runId: params.runId,
          trustedRuntimeIdentity: params.trustedRuntimeIdentity,
          observedSkillSha256: params.observedSkillSha256,
          readObservedSkillSha256: params.readObservedSkillSha256,
        }),
      onDecision: (decision, invocation) => {
        if (!invocation) {
          throw new Error("governed tool invocation identity is missing");
        }
        assertGovernedMissionAgentRunBinding({
          ownerKey,
          flowId: flow.flowId,
          runId: params.runId,
          attemptReceiptId: attemptReceipt.receiptId,
          trustedRuntimeIdentity: params.trustedRuntimeIdentity,
          observedSkillSha256: params.observedSkillSha256,
          readObservedSkillSha256: params.readObservedSkillSha256,
        });
        recordGovernedMissionToolDecision({
          flowId: flow.flowId,
          expectedMissionRevision: missionRevision,
          runId: params.runId,
          attemptReceiptId: attemptReceipt.receiptId,
          decision,
          invocation,
        });
      },
    },
  };
}

/** Recheck the exact lease receipt at the final boundary before provider dispatch. */
export function assertGovernedMissionAgentRunBinding(params: {
  ownerKey: string;
  flowId: string;
  runId: string;
  attemptReceiptId: string;
  trustedRuntimeIdentity?: GovernedRuntimeIdentity;
  observedSkillSha256?: string;
  readObservedSkillSha256?: () => string | undefined;
}): void {
  const ownerKey = params.ownerKey.trim();
  const flow = getTaskFlowById(params.flowId);
  const state = flow ? readGovernedMissionStateFromTaskFlow(flow) : undefined;
  const attemptReceipt = state
    ? findGovernedMissionReceiptByIdempotencyFromSqlite({
        missionId: state.missionId,
        idempotencyKey: `agent-run:${params.runId}:open-execution-lease`,
      })
    : undefined;
  const observedBindings = state
    ? observeGovernedMissionIdentity({
        mission: state,
        trustedRuntimeIdentity: params.trustedRuntimeIdentity,
        observedSkillSha256: params.readObservedSkillSha256
          ? params.readObservedSkillSha256()
          : params.observedSkillSha256,
      })
    : undefined;
  if (
    !ownerKey ||
    !flow ||
    !state ||
    flow.ownerKey !== ownerKey ||
    flow.cancelRequestedAt != null ||
    state.currentGovernedState !== "executing" ||
    state.activeExecutionLease?.runId !== params.runId ||
    !isGovernedMissionStateCanonicallyPersisted(flow, state) ||
    !observedBindings ||
    !identityBindingsMatch(state, observedBindings) ||
    attemptReceipt?.receiptId !== params.attemptReceiptId ||
    attemptReceipt.operation !== "openExecutionLease" ||
    attemptReceipt.decision !== "applied" ||
    attemptReceipt.flowId !== flow.flowId ||
    attemptReceipt.attemptId !== params.runId ||
    attemptReceipt.contractHash !== state.contractHash
  ) {
    throw new Error("governed mission dispatch binding is no longer canonical");
  }
}

/** Close the exact persisted lease only after the embedded session and tool runtime are idle. */
export function closeGovernedMissionExecutionLease(params: {
  flowId: string;
  runId: string;
  occurredAt?: string;
  trustedRuntimeIdentity?: GovernedRuntimeIdentity;
  observedSkillSha256?: string;
}): void {
  const flow = getTaskFlowById(params.flowId);
  const state = flow ? readGovernedMissionStateFromTaskFlow(flow) : undefined;
  if (!flow || !state || state.activeExecutionLease?.runId !== params.runId) {
    throw new Error("governed execution lease is missing or owned by another run");
  }
  // Lease release is an exact-owner cleanup operation. If live identity cannot
  // be read, persisted bindings may close this run's lease but authorize no work.
  const bindings =
    observeGovernedMissionIdentity({
      mission: state,
      trustedRuntimeIdentity: params.trustedRuntimeIdentity,
      observedSkillSha256: params.observedSkillSha256,
    }) ?? missionIdentityBindings(state);
  const closed = applyGovernedMissionOperation({
    flowId: flow.flowId,
    request: {
      operation: "closeExecutionLease",
      expectedRevision: state.revision,
      idempotencyKey: `agent-run:${params.runId}:close-execution-lease`,
      owner: flow.ownerKey,
      controllerId: flow.controllerId,
      bindings,
      occurredAt: params.occurredAt ?? new Date().toISOString(),
      runId: params.runId,
    },
  });
  const closedFlow = "flow" in closed ? closed.flow : undefined;
  const closedState = closedFlow ? readGovernedMissionStateFromTaskFlow(closedFlow) : undefined;
  const leaseClosedForReadmission =
    closed.status === "denied" &&
    closed.decision?.stateChanged &&
    closedState?.activeExecutionLease === undefined &&
    closedFlow?.status === "blocked";
  if (
    closed.status !== "applied" &&
    closed.status !== "already_applied" &&
    !leaseClosedForReadmission
  ) {
    throw new Error(`governed execution lease close failed: ${closed.status}`);
  }
}

function resolveToolEnforcementAuthority(params: {
  flowId: string;
  runId: string;
  trustedRuntimeIdentity?: GovernedRuntimeIdentity;
  observedSkillSha256?: string;
  readObservedSkillSha256?: () => string | undefined;
}): MissionSpecificToolEnforcementAuthority | undefined {
  const flow = getTaskFlowById(params.flowId);
  const state = flow ? readGovernedMissionStateFromTaskFlow(flow) : undefined;
  if (
    !flow ||
    !state ||
    flow.cancelRequestedAt != null ||
    state.currentGovernedState !== "executing" ||
    state.activeExecutionLease?.runId !== params.runId ||
    !isGovernedMissionStateCanonicallyPersisted(flow, state)
  ) {
    return undefined;
  }
  const contract = readPinnedGovernedMissionContract(flow);
  const observedBindings = observeGovernedMissionIdentity({
    mission: state,
    trustedRuntimeIdentity: params.trustedRuntimeIdentity,
    observedSkillSha256: params.readObservedSkillSha256
      ? params.readObservedSkillSha256()
      : params.observedSkillSha256,
  });
  if (!contract || !observedBindings || !identityBindingsMatch(state, observedBindings)) {
    return undefined;
  }
  return {
    governedMissionAdmitted: true,
    contract,
    missionState: state,
    expectedCurrentStep: state.currentStep,
    observedContractHash: observedBindings.contractHash,
    observedAuthorityHash: observedBindings.authorityHash,
    requiredEvidencePresent: true,
    enforcementHealth: { healthy: true },
  };
}

function recordGovernedMissionToolDecision(params: {
  flowId: string;
  expectedMissionRevision: number;
  runId: string;
  attemptReceiptId: string;
  decision: MissionSpecificToolEnforcementDecision;
  invocation: MissionSpecificToolInvocation;
}): GovernedMissionLedgerReceipt {
  const flow = getTaskFlowById(params.flowId);
  const state = flow ? readGovernedMissionStateFromTaskFlow(flow) : undefined;
  if (
    !flow ||
    !state ||
    flow.cancelRequestedAt != null ||
    state.revision !== params.expectedMissionRevision ||
    !isGovernedMissionStateCanonicallyPersisted(flow, state)
  ) {
    throw new Error("governed mission changed before the tool decision could be recorded");
  }
  const stableDecision = {
    attemptReceiptId: params.attemptReceiptId,
    invocationId: params.invocation.invocationId,
    toolCallId: params.invocation.toolCallId,
    toolName: params.invocation.toolName,
    parametersSha256: digest({ params: params.invocation.params }),
    actionId: params.decision.actionId,
    protected: params.decision.protected,
    decision: params.decision.decision,
    reasonCode: params.decision.reasonCode,
    obligations: params.decision.obligations,
  };
  const payloadSha256 = digest(stableDecision);
  const receipt: GovernedMissionLedgerReceipt = {
    receiptId: `governed-tool:${digest([state.missionId, params.attemptReceiptId, params.invocation.invocationId, stableDecision.parametersSha256]).slice(0, 40)}`,
    missionId: state.missionId,
    flowId: flow.flowId,
    runId: params.runId,
    operation: "authorizeToolCall",
    receiptKind: "transition",
    fromState: state.currentGovernedState,
    toState: state.currentGovernedState,
    decision: params.decision.decision === "ALLOW" ? "applied" : "denied",
    reasonCode: params.decision.reasonCode,
    expectedRevision: state.revision,
    resultingRevision: state.revision,
    contractId: state.contractId,
    contractHash: state.contractHash,
    authorityHash: state.authorityHash,
    planRevisionId: state.planRevisionId,
    sourceRevision: state.sourceRevision,
    runtimeBuildSha256: state.runtimeBuildSha256,
    policyVersion: state.policyVersion,
    skillSha256: state.skillSha256,
    payloadSha256,
    contractReceiptKinds:
      params.decision.decision === "ALLOW"
        ? ["policy_decision", "tool_call"]
        : ["policy_decision", "violation"],
    producer: GOVERNED_MISSION_RUNTIME_PRODUCER,
    idempotencyKey: `tool:${params.attemptReceiptId}:${params.invocation.invocationId}:${stableDecision.parametersSha256}`,
    details: stableDecision as JsonValue,
    createdAt: Date.parse(params.decision.evaluatedAt),
  };
  const committed = commitGovernedMissionLedger({ receipt });
  if (committed.status === "inserted" || committed.status === "already_applied") {
    return committed.receipt;
  }
  throw new Error(`governed tool decision receipt failed: ${committed.status}`);
}

function identityBindingsMatch(
  state: GovernedMissionState,
  observed: GovernedMissionIdentityBindings,
): boolean {
  return (
    state.contractHash === observed.contractHash &&
    state.authorityHash === observed.authorityHash &&
    state.planRevisionId === observed.planRevisionId &&
    state.sourceRevision === observed.sourceRevision &&
    state.runtimeBuildSha256 === observed.runtimeBuildSha256 &&
    state.policyVersion === observed.policyVersion &&
    state.skillSha256 === observed.skillSha256
  );
}

function missionIdentityBindings(state: GovernedMissionState): GovernedMissionIdentityBindings {
  return {
    contractHash: state.contractHash,
    authorityHash: state.authorityHash,
    planRevisionId: state.planRevisionId,
    sourceRevision: state.sourceRevision,
    runtimeBuildSha256: state.runtimeBuildSha256,
    policyVersion: state.policyVersion,
    skillSha256: state.skillSha256,
  };
}

function closeRejectedPreparationLease(params: {
  flowId: string;
  runId: string;
  trustedRuntimeIdentity?: GovernedRuntimeIdentity;
  observedSkillSha256?: string;
  reasonCode: string;
  message: string;
}): GovernedMissionAgentRunPreparation {
  try {
    closeGovernedMissionExecutionLease({
      flowId: params.flowId,
      runId: params.runId,
      ...(params.trustedRuntimeIdentity
        ? { trustedRuntimeIdentity: params.trustedRuntimeIdentity }
        : {}),
      observedSkillSha256: params.observedSkillSha256,
    });
  } catch {
    return blocked(
      "GOVERNED_EXECUTION_LEASE_ROLLBACK_FAILED",
      "The governed run was rejected after lease creation, and its lease could not be closed.",
    );
  }
  return blocked(params.reasonCode, params.message);
}

function blocked(reasonCode: string, message: string): GovernedMissionAgentRunPreparation {
  return { status: "blocked", reasonCode, message };
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}
