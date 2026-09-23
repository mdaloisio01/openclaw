import { createHash, randomUUID } from "node:crypto";
import {
  findAppliedGovernedAdmissionByMissionFromSqlite,
  findCurrentGovernedExecutionAttemptFromSqlite,
  findGovernedMissionReceiptByIdFromSqlite,
  findGovernedMissionReceiptByIdempotencyFromSqlite,
  findLatestAppliedGovernedMissionOperationReceiptFromSqlite,
  hasCanonicalGovernedMissionProvenanceFromSqlite,
  hasGovernedMissionClaimForFlow,
  listAppliedGovernedMissionContractReceiptsFromSqlite,
  listGovernedMissionReceiptsFromSqlite,
  listGovernedMissionOwnerClaimFlowIdsFromSqlite,
} from "../tasks/task-flow-registry.store.sqlite.js";
import type { JsonValue, TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  attachProductionContinuationToStateJson,
  buildProductionContinuationForLawfulStop,
  commitGovernedMissionLedger,
  createStartedProductionContinuationState,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  isTaskFlowProductionParentScopeClosed,
  listTaskFlowsForOwnerKey,
  prepareFlowNextExecutableLaunch,
  requireManagedTaskFlowControllerId,
  requireTaskFlowOwnerKey,
} from "../tasks/task-flow-runtime-internal.js";
import type {
  ProductionContinuationState,
  ProductionContinuationStopReason,
  TaskFlowUpdateResult,
} from "../tasks/task-flow-runtime-internal.js";
import { countActiveTaskRegistryRecordsForFlowFromSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskNotifyPolicy, TaskRecord } from "../tasks/task-registry.types.js";
import {
  normalizeGovernedArtifactDeclarations,
  verifyGovernedArtifacts,
  type GovernedArtifactDeclaration,
  type GovernedArtifactVerificationResult,
} from "./governed-artifact-verifier.js";
import {
  validateGovernedCloseoutAndBuildReleaseState,
  type GovernedCloseoutValidationResult,
  type GovernedPinnedReleaseState,
} from "./governed-closeout-validator.js";
import {
  computeGovernedFinalPayloadHash,
  mayReleaseGovernedFinal,
} from "./governed-final-release-decision.js";
import {
  admitGovernedMission,
  type GovernedMissionAdmissionInput,
} from "./governed-mission-admission.js";
import {
  governedMissionPlanCanSatisfyContract,
  missingGovernedContractFoundationFields,
  type GovernedMissionContract,
  type GovernedReceiptKind,
} from "./governed-mission-contract.js";
import { resolveGovernedAuthorityPath } from "./governed-mission-identity.js";
import {
  GOVERNED_MISSION_ARTIFACT_DECLARATIONS_KEY,
  GOVERNED_MISSION_CONTRACT_KEY,
  GOVERNED_MISSION_PLAN_KEY,
  GOVERNED_MISSION_RELEASE_STATE_KEY,
  computeGovernedTerminalAdmissionPreconditionSha256,
} from "./governed-mission-ledger-integrity.js";
import {
  GOVERNED_MISSION_RUNTIME_PRODUCER,
  type GovernedMissionArtifactLedgerRecord,
  type GovernedMissionLedgerCommitResult,
  type GovernedMissionLedgerReceipt,
} from "./governed-mission-ledger.types.js";
import { hasOwnerRunForGovernedMissionAdmission } from "./governed-mission-owner-run-fence.js";
import {
  buildGovernedMissionTaskFlowStatePatch,
  hasGovernedMissionStateValue,
  readGovernedMissionStateFromTaskFlow,
  type GovernedMissionState,
} from "./governed-mission-state.js";
import {
  evaluateGovernedMissionOperation,
  type GovernedMissionOperation,
  type GovernedMissionTransitionDecision,
} from "./governed-mission-transition.js";
import { MISSION_GATE_KINDS, type GateKind } from "./mission-manifest.types.js";
import type { CompiledMissionPlan } from "./mission-plan-compiler.js";

type GovernedReleaseAuthorization = {
  allowed: boolean;
  reasonCode: string;
  missingReceiptKinds: GovernedReceiptKind[];
  closeoutValidation?: GovernedCloseoutValidationResult;
};

export type AdmitGovernedMissionToTaskFlowInput = {
  admission: Omit<GovernedMissionAdmissionInput, "ownerCorrelation" | "existingState">;
  idempotencyKey: string;
  productionRequestSha256?: string;
  ownerKey: string;
  controllerId: string;
  goal: string;
  currentStep?: string;
  notifyPolicy?: TaskNotifyPolicy;
  stateJson?: JsonValue;
  continuation?: Partial<ProductionContinuationState>;
  createdAt?: number;
  compiledPlan: CompiledMissionPlan;
  artifactDeclarations: readonly GovernedArtifactDeclaration[];
  deliveryRequired?: boolean;
};

export type GovernedMissionRuntimeResult =
  | {
      status: "applied";
      flow: TaskFlowRecord;
      decision: GovernedMissionTransitionDecision;
      receipt: GovernedMissionLedgerReceipt;
    }
  | {
      status: "already_applied";
      flow?: TaskFlowRecord;
      receipt: GovernedMissionLedgerReceipt;
    }
  | {
      status: "denied" | "repair_required" | "irrelevant";
      flow: TaskFlowRecord;
      decision: GovernedMissionTransitionDecision;
      receipt: GovernedMissionLedgerReceipt;
    }
  | {
      status: "conflict";
      flow?: TaskFlowRecord;
      decision?: GovernedMissionTransitionDecision;
      receipt?: GovernedMissionLedgerReceipt;
      reasonCode: "REVISION_CONFLICT" | "IDEMPOTENCY_PAYLOAD_CONFLICT" | "ACTIVE_WORK_CONFLICT";
    }
  | { status: "not_found" }
  | { status: "not_governed"; flow: TaskFlowRecord }
  | { status: "untrusted_governed_state"; flow: TaskFlowRecord };

export function isGovernedMissionStateCanonicallyPersisted(
  flow: TaskFlowRecord,
  state = readGovernedMissionStateFromTaskFlow(flow),
): boolean {
  return Boolean(
    state &&
    state.ownerCorrelation.taskFlowId === flow.flowId &&
    hasCanonicalGovernedMissionProvenanceFromSqlite({
      flow,
      missionId: state.missionId,
    }),
  );
}

export function admitGovernedMissionToTaskFlow(input: AdmitGovernedMissionToTaskFlowInput):
  | { status: "admitted"; flow: TaskFlowRecord; receipt: GovernedMissionLedgerReceipt }
  | { status: "denied"; reasonCode: string; receipt: GovernedMissionLedgerReceipt }
  | { status: "already_applied"; flow?: TaskFlowRecord; receipt: GovernedMissionLedgerReceipt }
  | {
      status: "conflict";
      reasonCode:
        | "IDEMPOTENCY_PAYLOAD_CONFLICT"
        | "MISSION_ALREADY_ADMITTED"
        | "OWNER_SESSION_ALREADY_GOVERNED";
    } {
  let ownerKey: string | undefined;
  let controllerId: string | undefined;
  let packageIssue: string | undefined;
  try {
    ownerKey = requireTaskFlowOwnerKey(input.ownerKey);
  } catch {
    packageIssue = "FLOW_OWNER_INVALID";
  }
  try {
    controllerId = requireManagedTaskFlowControllerId(input.controllerId);
  } catch {
    packageIssue ??= "FLOW_CONTROLLER_INVALID";
  }
  const artifactDeclarations = normalizeGovernedArtifactDeclarations(input.artifactDeclarations);
  packageIssue ??= artifactDeclarations ? undefined : "ARTIFACT_DECLARATIONS_INVALID";
  const flowId = randomUUID();
  const admission = admitGovernedMission({
    ...input.admission,
    requiredProofs: requiredProofsForAdmission(input),
    ownerCorrelation: {
      owner: ownerKey ?? (input.ownerKey.trim() || "invalid-owner"),
      taskFlowId: flowId,
      runId: input.admission.actor.runId ?? flowId,
      ...(input.admission.actor.sessionKey ? { sessionKey: input.admission.actor.sessionKey } : {}),
    },
  });
  const attemptId = admissionAttemptId(input);
  const suppliedMissionId = input.admission.contract?.missionId?.trim();
  const missionId = admission.missionId?.trim() || suppliedMissionId || attemptId;
  const payloadSha256 = digestAdmissionPayload(
    {
      ...input,
      ownerKey: ownerKey ?? input.ownerKey,
      controllerId: controllerId ?? input.controllerId,
    },
    artifactDeclarations ?? input.artifactDeclarations,
    missionId,
  );
  const existing = findGovernedMissionReceiptByIdempotencyFromSqlite({
    missionId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    if (!sameAdmissionRequest(existing, input.productionRequestSha256, payloadSha256)) {
      return { status: "conflict", reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT" };
    }
    const existingFlow = existing.flowId ? getTaskFlowById(existing.flowId) : undefined;
    return {
      status: "already_applied",
      ...(existingFlow ? { flow: existingFlow } : {}),
      receipt: existing,
    };
  }
  const existingAdmission = findAppliedGovernedAdmissionByMissionFromSqlite(missionId);
  if (existingAdmission) {
    if (!sameAdmissionRequest(existingAdmission, input.productionRequestSha256, payloadSha256)) {
      return { status: "conflict", reasonCode: "MISSION_ALREADY_ADMITTED" };
    }
    const existingFlow = existingAdmission.flowId
      ? getTaskFlowById(existingAdmission.flowId)
      : undefined;
    return {
      status: "already_applied",
      ...(existingFlow ? { flow: existingFlow } : {}),
      receipt: existingAdmission,
    };
  }

  if (ownerKey && hasOwnerRunForGovernedMissionAdmission(ownerKey)) {
    packageIssue ??= "OWNER_SESSION_RUN_ACTIVE";
  }

  const timestamp = resolveAdmissionTimestamp(input);
  packageIssue ??= timestamp.issue;
  const planIssue = admission.missionState
    ? findCompiledPlanAdmissionIssue(input.compiledPlan, input.admission.contract)
    : undefined;
  packageIssue ??= planIssue;
  if (
    admission.missionState &&
    input.admission.contract &&
    !planIssue &&
    !governedMissionPlanCanSatisfyContract(
      input.admission.contract as GovernedMissionContract,
      input.compiledPlan,
    )
  ) {
    packageIssue ??= "REQUIRED_RECEIPT_KIND_UNSATISFIABLE";
  }
  const artifactDeclarationIssue =
    admission.missionState && artifactDeclarations && !planIssue
      ? findArtifactDeclarationAdmissionIssue({
          declarations: artifactDeclarations,
          mission: admission.missionState,
          compiledPlan: input.compiledPlan,
        })
      : undefined;
  packageIssue ??= artifactDeclarationIssue;
  if (!input.idempotencyKey.trim()) {
    packageIssue ??= "IDEMPOTENCY_KEY_INVALID";
  }
  const denialReason = admission.decision === "ADMIT" ? packageIssue : admission.reasonCode;
  const receipt = buildAdmissionLedgerReceipt({
    admission,
    missionId,
    ...(admission.decision === "ADMIT" && admission.missionState && !packageIssue
      ? { flowId }
      : {}),
    ...(missionId === attemptId ? { attemptId } : {}),
    idempotencyKey: input.idempotencyKey,
    payloadSha256,
    productionRequestSha256: input.productionRequestSha256,
    createdAt: timestamp.value,
    ...(denialReason ? { decision: "denied", reasonCode: denialReason } : {}),
  });
  if (admission.decision !== "ADMIT" || !admission.missionState || packageIssue) {
    const committed = commitGovernedMissionLedger({ receipt });
    if (committed.status === "idempotency_conflict") {
      return { status: "conflict", reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT" };
    }
    if (committed.status === "already_applied") {
      return { status: "already_applied", receipt: committed.receipt };
    }
    if (
      committed.status === "revision_conflict" ||
      committed.status === "mission_conflict" ||
      committed.status === "owner_conflict"
    ) {
      throw new Error(`denied governed admission unexpectedly failed: ${committed.status}`);
    }
    return {
      status: "denied",
      reasonCode: denialReason ?? "GOVERNED_ADMISSION_DENIED",
      receipt: committed.receipt,
    };
  }

  const baseFlow: TaskFlowRecord = {
    flowId,
    syncMode: "managed",
    ownerKey: ownerKey!,
    controllerId: controllerId!,
    revision: 0,
    status: "queued",
    notifyPolicy: input.notifyPolicy ?? "done_only",
    goal: input.goal,
    currentStep: input.currentStep ?? "governed_mission_admitted",
    stateJson: {
      ...jsonObject(input.stateJson),
      [GOVERNED_MISSION_CONTRACT_KEY]: input.admission.contract as unknown as JsonValue,
      [GOVERNED_MISSION_PLAN_KEY]: input.compiledPlan as unknown as JsonValue,
      [GOVERNED_MISSION_ARTIFACT_DECLARATIONS_KEY]: artifactDeclarations as unknown as JsonValue,
      governedMissionState: admission.missionState as unknown as JsonValue,
    },
    createdAt: timestamp.value,
    updatedAt: timestamp.value,
  };
  const continuation = input.continuation?.activeProductionRun
    ? createStartedProductionContinuationState({
        continuation: input.continuation,
        at: timestamp.value,
      })
    : undefined;
  const flow: TaskFlowRecord = {
    ...baseFlow,
    stateJson: attachProductionContinuationToStateJson({
      flow: baseFlow,
      stateJson: baseFlow.stateJson,
      continuation,
    }),
  };
  const committed = commitGovernedMissionLedger({
    receipt,
    nextFlow: flow,
    governedOwnerClaimKey: ownerKey!,
  });
  if (committed.status === "idempotency_conflict") {
    return { status: "conflict", reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT" };
  }
  if (committed.status === "mission_conflict") {
    return { status: "conflict", reasonCode: "MISSION_ALREADY_ADMITTED" };
  }
  if (committed.status === "owner_conflict") {
    return { status: "conflict", reasonCode: "OWNER_SESSION_ALREADY_GOVERNED" };
  }
  if (committed.status === "revision_conflict") {
    throw new Error("new governed TaskFlow unexpectedly conflicted during admission");
  }
  if (committed.status === "already_applied") {
    const canonicalFlow = committed.receipt.flowId
      ? getTaskFlowById(committed.receipt.flowId)
      : undefined;
    return {
      status: "already_applied",
      ...(canonicalFlow ? { flow: canonicalFlow } : {}),
      receipt: committed.receipt,
    };
  }
  return {
    status: "admitted",
    flow,
    receipt: committed.receipt,
  };
}

function findCompiledPlanAdmissionIssue(
  plan: CompiledMissionPlan,
  contract: GovernedMissionAdmissionInput["contract"],
): string | undefined {
  try {
    const requirements = plan.requirements.requirements;
    const gates = plan.gates;
    if (
      !contract ||
      !Array.isArray(requirements) ||
      !Array.isArray(gates) ||
      !requirements.every(isCompiledRequirement) ||
      !gates.every(isCompiledGate) ||
      plan.manifest.schema !== "openclaw.mission_manifest.v1" ||
      plan.manifest.missionId !== contract.missionId ||
      plan.manifest.planRevisionId !== contract.planRevisionId ||
      plan.manifest.sourceRevision !== contract.sourceRevision ||
      plan.manifest.runtimeBuildSha256 !== contract.runtimeBuildSha256 ||
      plan.manifest.policyVersion !== contract.policyVersion ||
      plan.manifest.skillSha256 !== contract.skillSha256 ||
      plan.manifest.mode !== contract.mode ||
      !plan.manifest.planRevisionAuthorized ||
      plan.manifest.scopeHash !== plan.manifest.authorizedScopeHash ||
      plan.requirements.schema !== "openclaw.requirement_manifest.v1" ||
      plan.requirements.missionId !== plan.manifest.missionId ||
      plan.requirements.planRevisionId !== plan.manifest.planRevisionId
    ) {
      return "COMPILED_PLAN_CONTRACT_MISMATCH";
    }
  } catch {
    return "COMPILED_PLAN_CONTRACT_MISMATCH";
  }
  return undefined;
}

function isCompiledRequirement(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const requirement = value as Record<string, unknown>;
  return (
    typeof requirement.id === "string" &&
    requirement.id.trim().length > 0 &&
    typeof requirement.text === "string" &&
    requirement.text.trim().length > 0 &&
    typeof requirement.required === "boolean" &&
    Array.isArray(requirement.gateIds) &&
    requirement.gateIds.every((gateId) => typeof gateId === "string" && gateId.trim().length > 0) &&
    (requirement.dependsOn === undefined ||
      (Array.isArray(requirement.dependsOn) &&
        requirement.dependsOn.every(
          (requirementId) => typeof requirementId === "string" && requirementId.trim().length > 0,
        )))
  );
}

function isCompiledGate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const gate = value as Record<string, unknown>;
  return (
    typeof gate.id === "string" &&
    gate.id.trim().length > 0 &&
    typeof gate.requirementId === "string" &&
    gate.requirementId.trim().length > 0 &&
    typeof gate.kind === "string" &&
    (MISSION_GATE_KINDS as readonly string[]).includes(gate.kind) &&
    typeof gate.required === "boolean" &&
    (gate.freshnessMs === undefined ||
      (typeof gate.freshnessMs === "number" &&
        Number.isSafeInteger(gate.freshnessMs) &&
        gate.freshnessMs >= 0))
  );
}

export function resolveGovernedMissionFlowForLookupToken(
  token: string,
): TaskFlowRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  const explicitFlow = getTaskFlowById(lookup);
  if (explicitFlow) {
    return explicitFlow;
  }
  const ownerFlows = listTaskFlowsForOwnerKey(lookup);
  // The durable governed owner claim must not be shadowed by a newer ordinary flow.
  const claimFlowIds = listGovernedMissionOwnerClaimFlowIdsFromSqlite(lookup);
  if (claimFlowIds.length > 0) {
    return ownerFlows.find((flow) => claimFlowIds.includes(flow.flowId));
  }
  return ownerFlows.find(hasGovernedMissionStateValue) ?? ownerFlows[0];
}

export function isGovernedMissionFlowClaimed(flow: TaskFlowRecord): boolean {
  return hasGovernedMissionClaimForFlow(flow);
}

export function previewGovernedMissionOperation(params: {
  lookup: string;
  request: GovernedMissionOperation;
}):
  | { status: "preview"; flow: TaskFlowRecord; decision: GovernedMissionTransitionDecision }
  | { status: "not_found" }
  | { status: "not_governed"; flow: TaskFlowRecord }
  | { status: "untrusted_governed_state"; flow: TaskFlowRecord } {
  const flow = resolveGovernedMissionFlowForLookupToken(params.lookup);
  if (!flow) {
    return { status: "not_found" };
  }
  const state = readGovernedMissionStateFromTaskFlow(flow);
  if (!state) {
    return {
      status: isGovernedMissionFlowClaimed(flow) ? "untrusted_governed_state" : "not_governed",
      flow,
    };
  }
  if (!isGovernedMissionStateCanonicallyPersisted(flow, state)) {
    return { status: "untrusted_governed_state", flow };
  }
  const request = bindOperationToCanonicalFacts(flow, params.request);
  const activeChildWorkPresent =
    (request.operation === "cancelMission" || request.operation === "stopMission") &&
    countActiveTaskRegistryRecordsForFlowFromSqlite(flow.flowId) > 0;
  const releaseAuthorization = buildReleaseAuthorization(flow, state, request);
  return {
    status: "preview",
    flow,
    decision: evaluateWithFlowOwner(flow, state, request, {
      ...(releaseAuthorization ? { releaseAuthorization } : {}),
      activeChildWorkPresent,
    }),
  };
}

export function applyGovernedMissionOperation(params: {
  flowId: string;
  request: GovernedMissionOperation;
}): GovernedMissionRuntimeResult {
  return applyGovernedMissionOperationWithFacts({ ...params, artifacts: [] });
}

export function resolveGovernedMissionOperationIdempotency(params: {
  flowId: string;
  request: GovernedMissionOperation;
}): GovernedMissionRuntimeResult | undefined {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return { status: "not_found" };
  }
  const state = readGovernedMissionStateFromTaskFlow(flow);
  if (!state) {
    return {
      status: isGovernedMissionFlowClaimed(flow) ? "untrusted_governed_state" : "not_governed",
      flow,
    };
  }
  if (!isGovernedMissionStateCanonicallyPersisted(flow, state)) {
    return { status: "untrusted_governed_state", flow };
  }
  const request = bindOperationToCanonicalFacts(flow, params.request);
  const existing = findGovernedMissionReceiptByIdempotencyFromSqlite({
    missionId: state.missionId,
    idempotencyKey: request.idempotencyKey,
  });
  return existing ? existingTransitionResult(flow, request, existing) : undefined;
}

export function cancelGovernedMissionTaskFlow(params: {
  flowId: string;
  occurredAt: number;
}): GovernedMissionRuntimeResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return { status: "not_found" };
  }
  const state = readGovernedMissionStateFromTaskFlow(flow);
  if (!state) {
    return {
      status: isGovernedMissionFlowClaimed(flow) ? "untrusted_governed_state" : "not_governed",
      flow,
    };
  }
  if (!isGovernedMissionStateCanonicallyPersisted(flow, state)) {
    return { status: "untrusted_governed_state", flow };
  }
  return applyGovernedMissionOperation({
    flowId: flow.flowId,
    request: {
      operation: "cancelMission",
      expectedRevision: state.revision,
      idempotencyKey: `task-flow-cancel:${flow.flowId}:${state.revision}`,
      owner: state.ownerCorrelation.owner,
      controllerId: flow.controllerId,
      bindings: {
        contractHash: state.contractHash,
        authorityHash: state.authorityHash,
        planRevisionId: state.planRevisionId,
        sourceRevision: state.sourceRevision,
        runtimeBuildSha256: state.runtimeBuildSha256,
        policyVersion: state.policyVersion,
        skillSha256: state.skillSha256,
      },
      occurredAt: new Date(params.occurredAt).toISOString(),
      reasonCode: "TASK_FLOW_CANCEL_REQUESTED",
    },
  });
}

export function isGovernedMissionCancellationComplete(
  result: GovernedMissionRuntimeResult,
): boolean {
  if (result.status !== "applied" && result.status !== "already_applied") {
    return false;
  }
  const flow = result.flow;
  const mission = flow ? readGovernedMissionStateFromTaskFlow(flow) : null;
  return (
    result.receipt.operation === "cancelMission" &&
    result.receipt.decision === "applied" &&
    flow?.status === "cancelled" &&
    mission?.currentGovernedState === "cancelled" &&
    mission.terminalStatus === "cancelled"
  );
}

function commitGovernedOperationalFlowUpdate(params: {
  flow: TaskFlowRecord;
  state: GovernedMissionState;
  nextFlow: TaskFlowRecord;
  operation: "recordBuildIssueAction" | "recordBuildIssueBoundary";
  reasonCode: string;
  idempotencyKey: string;
  details: JsonValue;
  occurredAt: number;
}): TaskFlowUpdateResult {
  const committed = commitGovernedMissionLedger({
    expectedFlowRevision: params.flow.revision,
    nextFlow: params.nextFlow,
    receipt: {
      receiptId: `governed:${digest([params.state.missionId, params.idempotencyKey]).slice(0, 40)}`,
      missionId: params.state.missionId,
      flowId: params.flow.flowId,
      runId: params.state.ownerCorrelation.runId,
      operation: params.operation,
      receiptKind: "transition",
      fromState: params.state.currentGovernedState,
      toState: params.state.currentGovernedState,
      decision: "applied",
      reasonCode: params.reasonCode,
      expectedRevision: params.state.revision,
      resultingRevision: params.state.revision,
      contractId: params.state.contractId,
      contractHash: params.state.contractHash,
      authorityHash: params.state.authorityHash,
      planRevisionId: params.state.planRevisionId,
      sourceRevision: params.state.sourceRevision,
      runtimeBuildSha256: params.state.runtimeBuildSha256,
      policyVersion: params.state.policyVersion,
      skillSha256: params.state.skillSha256,
      payloadSha256: digest(params.details),
      producer: GOVERNED_MISSION_RUNTIME_PRODUCER,
      idempotencyKey: params.idempotencyKey,
      details: params.details,
      createdAt: params.occurredAt,
    },
  });
  if (committed.status === "inserted") {
    return { applied: true, flow: params.nextFlow };
  }
  if (committed.status === "already_applied") {
    const current = getTaskFlowById(params.flow.flowId);
    return current ? { applied: true, flow: current } : { applied: false, reason: "not_found" };
  }
  if (committed.status === "revision_conflict") {
    return {
      applied: false,
      reason: "revision_conflict",
      current: getTaskFlowById(params.flow.flowId),
    };
  }
  return {
    applied: false,
    reason: "guard_blocked",
    current: params.flow,
    blockedSummary: `Governed build-issue ledger commit failed: ${committed.status}.`,
  };
}

export function recordGovernedBuildIssueAction(params: {
  flowId: string;
  expectedFlowRevision: number;
  actionId: string;
  occurrenceId: string;
  actions: JsonValue[];
  updatedAt: number;
}): TaskFlowUpdateResult {
  const flow = getTaskFlowById(params.flowId);
  const state = flow ? readGovernedMissionStateFromTaskFlow(flow) : undefined;
  if (!flow) {
    return { applied: false, reason: "not_found" };
  }
  if (
    !state ||
    flow.revision !== params.expectedFlowRevision ||
    !isGovernedMissionStateCanonicallyPersisted(flow, state)
  ) {
    return {
      applied: false,
      reason: flow.revision === params.expectedFlowRevision ? "guard_blocked" : "revision_conflict",
      current: flow,
      blockedSummary: "Governed build-issue action requires canonical current mission state.",
    };
  }
  const actionsSha256 = digest(params.actions);
  const nextFlow: TaskFlowRecord = {
    ...flow,
    revision: flow.revision + 1,
    stateJson: {
      ...jsonObject(flow.stateJson),
      buildIssueActions: structuredClone(params.actions),
    },
    updatedAt: params.updatedAt,
  };
  return commitGovernedOperationalFlowUpdate({
    flow,
    state,
    nextFlow,
    operation: "recordBuildIssueAction",
    reasonCode: "GOVERNED_BUILD_ISSUE_ACTION_RECORDED",
    idempotencyKey: `build-issue:${params.actionId}:action:${actionsSha256}`,
    details: {
      actionId: params.actionId,
      occurrenceId: params.occurrenceId,
      actionsSha256,
    },
    occurredAt: params.updatedAt,
  });
}

export function recordGovernedBuildIssueBoundary(params: {
  flowId: string;
  expectedFlowRevision: number;
  actionId: string;
  issueId: string;
  reason: ProductionContinuationStopReason;
  detail: string;
  updatedAt: number;
}): TaskFlowUpdateResult {
  const flow = getTaskFlowById(params.flowId);
  const state = flow ? readGovernedMissionStateFromTaskFlow(flow) : undefined;
  if (!flow) {
    return { applied: false, reason: "not_found" };
  }
  const continuation = getTaskFlowProductionContinuation(flow);
  if (
    !state ||
    flow.revision !== params.expectedFlowRevision ||
    !continuation?.activeProductionRun ||
    !isGovernedMissionStateCanonicallyPersisted(flow, state)
  ) {
    return {
      applied: false,
      reason: flow.revision === params.expectedFlowRevision ? "guard_blocked" : "revision_conflict",
      current: flow,
      blockedSummary: "Governed build-issue boundary requires canonical active production state.",
    };
  }
  const nextContinuation = buildProductionContinuationForLawfulStop({
    state: continuation,
    reason: params.reason,
    at: params.updatedAt,
    detail: params.detail,
  });
  const stateJson = attachProductionContinuationToStateJson({
    flow,
    continuation: nextContinuation,
  });
  if (!stateJson) {
    return {
      applied: false,
      reason: "guard_blocked",
      current: flow,
      blockedSummary: "Governed build-issue boundary could not preserve production state.",
    };
  }
  const { endedAt: _endedAt, ...openFlow } = flow;
  const nextFlow: TaskFlowRecord = {
    ...openFlow,
    revision: flow.revision + 1,
    status: "blocked",
    currentStep: "build_issue_resolution_required",
    stateJson,
    blockedSummary: params.detail,
    updatedAt: params.updatedAt,
  };
  return commitGovernedOperationalFlowUpdate({
    flow,
    state,
    nextFlow,
    operation: "recordBuildIssueBoundary",
    reasonCode: "GOVERNED_BUILD_ISSUE_BOUNDARY_RECORDED",
    idempotencyKey: `build-issue:${params.actionId}:boundary`,
    details: {
      actionId: params.actionId,
      issueId: params.issueId,
      reason: params.reason,
      detail: params.detail,
    },
    occurredAt: params.updatedAt,
  });
}

export function commitGovernedMissionChildCompletion(params: {
  flowId: string;
  expectedFlowRevision: number;
  producerDeviceId: string;
  governedAttemptReceiptId: string;
  assignmentSha256: string;
  nextExecutableLaunch?: { detail: string; currentStep?: string | null };
  occurredAt: number;
  taskUpdate: TaskRecord;
}): TaskFlowUpdateResult | { applied: false; reason: "already_applied"; current: TaskFlowRecord } {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return { applied: false, reason: "not_found" };
  }
  const state = readGovernedMissionStateFromTaskFlow(flow);
  if (!state || !isGovernedMissionStateCanonicallyPersisted(flow, state)) {
    return {
      applied: false,
      reason: "guard_blocked",
      current: flow,
      blockedSummary: "Governed mission state is not canonically persisted.",
    };
  }
  const prepared = params.nextExecutableLaunch
    ? prepareFlowNextExecutableLaunch({
        flowId: flow.flowId,
        expectedRevision: params.expectedFlowRevision,
        detail: params.nextExecutableLaunch.detail,
        currentStep: params.nextExecutableLaunch.currentStep,
        updatedAt: params.occurredAt,
      })
    : undefined;
  if (prepared && !prepared.applied) {
    return prepared;
  }
  if (
    params.taskUpdate.parentFlowId !== flow.flowId ||
    !params.taskUpdate.runId ||
    params.taskUpdate.status !== "succeeded" ||
    params.taskUpdate.deliveryStatus !== "delivered"
  ) {
    return { applied: false, reason: "guard_blocked", current: flow };
  }
  const details = {
    taskId: params.taskUpdate.taskId,
    runId: params.taskUpdate.runId,
    progressSummary: params.taskUpdate.progressSummary ?? null,
    terminalSummary: params.taskUpdate.terminalSummary ?? null,
    producerDeviceId: params.producerDeviceId,
    governedAttemptReceiptId: params.governedAttemptReceiptId,
    assignmentSha256: params.assignmentSha256,
    ...(params.nextExecutableLaunch
      ? {
          detail: params.nextExecutableLaunch.detail,
          currentStep: params.nextExecutableLaunch.currentStep ?? null,
        }
      : {}),
  };
  const payloadSha256 = createHash("sha256").update(stableJson(details)).digest("hex");
  const committed = commitGovernedMissionLedger({
    ...(prepared?.applied ? { nextFlow: prepared.flow } : {}),
    expectedFlowRevision: params.expectedFlowRevision,
    taskUpdate: params.taskUpdate,
    receipt: {
      receiptId: `child-completion:${flow.flowId}:${params.taskUpdate.taskId}`,
      missionId: state.missionId,
      flowId: flow.flowId,
      runId: params.taskUpdate.runId,
      operation: params.nextExecutableLaunch
        ? "recordNextExecutableLaunch"
        : "completeGovernedChildTask",
      receiptKind: "transition",
      fromState: state.currentGovernedState,
      toState: state.currentGovernedState,
      decision: "applied",
      reasonCode: params.nextExecutableLaunch
        ? "NEXT_EXECUTABLE_UNIT_LAUNCHED"
        : "GOVERNED_CHILD_TASK_COMPLETED",
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
      producer: GOVERNED_MISSION_RUNTIME_PRODUCER,
      idempotencyKey: `child-completion:${params.taskUpdate.taskId}`,
      details,
      createdAt: params.occurredAt,
    },
  });
  if (committed.status === "inserted") {
    return { applied: true, flow: prepared?.applied ? prepared.flow : flow };
  }
  if (committed.status === "already_applied") {
    // The receipt won the earlier attempt; leave the task mirror untouched and
    // let the authenticated Gateway reply from the canonical persisted records.
    return {
      applied: false,
      reason: "already_applied",
      current: getTaskFlowById(flow.flowId) ?? flow,
    };
  }
  return {
    applied: false,
    reason: committed.status === "revision_conflict" ? "revision_conflict" : "persist_failed",
    current: getTaskFlowById(flow.flowId) ?? flow,
  };
}

type GovernedWithheldPayload = {
  schema: "openclaw.governed_withheld_payload.v1";
  runId: string;
  attemptReceiptId: string;
  payloadHash: string;
  payload: JsonValue;
  capturedAt: number;
};

export function readGovernedMissionWithheldPayload(
  flow: TaskFlowRecord,
): GovernedWithheldPayload | undefined {
  const mission = readGovernedMissionStateFromTaskFlow(flow);
  if (!mission) {
    return undefined;
  }
  const receipt = findLatestAppliedGovernedMissionOperationReceiptFromSqlite({
    flowId: flow.flowId,
    operation: "recordWithheldFinalPayload",
    contractHash: mission.contractHash,
  });
  const currentAttempt = findCurrentGovernedExecutionAttemptFromSqlite({
    flowId: flow.flowId,
    contractHash: mission.contractHash,
  });
  const value = receipt?.details;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.schema === "openclaw.governed_withheld_payload.v1" &&
    typeof candidate.runId === "string" &&
    candidate.runId.trim() &&
    typeof candidate.attemptReceiptId === "string" &&
    candidate.attemptReceiptId.trim() &&
    candidate.attemptReceiptId === currentAttempt?.receiptId &&
    typeof candidate.payloadHash === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.payloadHash) &&
    candidate.payload !== undefined &&
    computeGovernedFinalPayloadHash(candidate.payload) === candidate.payloadHash &&
    typeof candidate.capturedAt === "number" &&
    Number.isSafeInteger(candidate.capturedAt) &&
    candidate.capturedAt >= 0
    ? (candidate as GovernedWithheldPayload)
    : undefined;
}

export function recordGovernedMissionWithheldPayload(params: {
  flowId: string;
  attemptReceiptId: string;
  payload: unknown;
  capturedAt?: number;
}): TaskFlowUpdateResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return { applied: false, reason: "not_found" };
  }
  const state = readGovernedMissionStateFromTaskFlow(flow);
  if (
    !state ||
    !isGovernedMissionStateCanonicallyPersisted(flow, state) ||
    state.currentGovernedState !== "executing" ||
    !params.attemptReceiptId.trim()
  ) {
    return {
      applied: false,
      reason: "guard_blocked",
      current: flow,
      blockedSummary:
        "Canonical executing mission, current execution attempt, and withheld payload identity are required.",
    };
  }
  const currentAttempt = findCurrentGovernedExecutionAttemptFromSqlite({
    flowId: flow.flowId,
    contractHash: state.contractHash,
  });
  const attempt = findGovernedMissionReceiptByIdFromSqlite(params.attemptReceiptId);
  const runId = attempt?.attemptId?.trim();
  const leaseClose = findGovernedMissionReceiptByIdempotencyFromSqlite({
    missionId: state.missionId,
    idempotencyKey: `agent-run:${runId}:close-execution-lease`,
  });
  // A live exact lease fences governance transitions while the accepted payload
  // is recorded. Older callers may still record immediately after exact close.
  const activeAttempt = Boolean(runId && state.activeExecutionLease?.runId === runId);
  if (
    !runId ||
    attempt?.receiptId !== params.attemptReceiptId ||
    attempt.operation !== "openExecutionLease" ||
    attempt.decision !== "applied" ||
    attempt.flowId !== flow.flowId ||
    attempt.contractHash !== state.contractHash ||
    currentAttempt?.receiptId !== attempt.receiptId ||
    (state.activeExecutionLease !== undefined && !activeAttempt) ||
    (!activeAttempt &&
      (leaseClose?.operation !== "closeExecutionLease" ||
        leaseClose.decision !== "applied" ||
        leaseClose.contractHash !== state.contractHash ||
        leaseClose.resultingRevision !== state.revision ||
        (leaseClose.resultingRevision ?? -1) <= (attempt.resultingRevision ?? -1)))
  ) {
    return {
      applied: false,
      reason: "guard_blocked",
      current: flow,
      blockedSummary: "Withheld output does not belong to the current closed execution attempt.",
    };
  }
  let payload: JsonValue;
  try {
    const serialized = JSON.stringify(params.payload);
    if (serialized === undefined) {
      throw new Error("payload is not JSON serializable");
    }
    payload = JSON.parse(serialized) as JsonValue;
  } catch {
    return {
      applied: false,
      reason: "guard_blocked",
      current: flow,
      blockedSummary: "Governed withheld payload must be JSON serializable.",
    };
  }
  const capturedAt = params.capturedAt ?? Date.now();
  const withheld: GovernedWithheldPayload = {
    schema: "openclaw.governed_withheld_payload.v1",
    runId,
    attemptReceiptId: params.attemptReceiptId.trim(),
    payloadHash: computeGovernedFinalPayloadHash(payload),
    payload,
    capturedAt,
  };
  const nextFlow: TaskFlowRecord = {
    ...flow,
    revision: flow.revision + 1,
    updatedAt: capturedAt,
  };
  const committed = commitGovernedMissionLedger({
    nextFlow,
    receipt: {
      receiptId: `withheld-payload:${flow.flowId}:${withheld.attemptReceiptId}`,
      missionId: state.missionId,
      flowId: flow.flowId,
      runId: withheld.runId,
      operation: "recordWithheldFinalPayload",
      receiptKind: "transition",
      fromState: state.currentGovernedState,
      toState: state.currentGovernedState,
      decision: "applied",
      reasonCode: "WITHHELD_FINAL_PAYLOAD_RECORDED",
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
      payloadSha256: withheld.payloadHash,
      producer: GOVERNED_MISSION_RUNTIME_PRODUCER,
      idempotencyKey: `withheld-payload:${withheld.attemptReceiptId}`,
      details: withheld,
      createdAt: capturedAt,
    },
  });
  if (committed.status === "inserted" || committed.status === "already_applied") {
    return { applied: true, flow: getTaskFlowById(flow.flowId) ?? nextFlow };
  }
  return {
    applied: false,
    reason: committed.status === "revision_conflict" ? "revision_conflict" : "persist_failed",
    current: getTaskFlowById(flow.flowId) ?? flow,
  };
}

export function readGovernedMissionReleasedPayload(flow: TaskFlowRecord): JsonValue | undefined {
  const mission = readGovernedMissionStateFromTaskFlow(flow);
  const withheld = readGovernedMissionWithheldPayload(flow);
  const releaseState = jsonObject(flow.stateJson)[GOVERNED_MISSION_RELEASE_STATE_KEY] as
    | GovernedPinnedReleaseState
    | undefined;
  if (!mission || !withheld || !releaseState) {
    return undefined;
  }
  const decision = mayReleaseGovernedFinal({
    missionId: mission.missionId,
    runId: withheld.runId,
    contractId: mission.contractId,
    contractHash: mission.contractHash,
    payloadHash: withheld.payloadHash,
    releaseState,
  });
  return decision.allowed ? structuredClone(withheld.payload) : undefined;
}

export async function verifyAndApplyGovernedMissionArtifacts(params: {
  flowId: string;
  request: Extract<GovernedMissionOperation, { operation: "verifyRequiredArtifacts" }>;
  observedAtMs: number;
}): Promise<GovernedMissionRuntimeResult> {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return { status: "not_found" };
  }
  const state = readGovernedMissionStateFromTaskFlow(flow);
  if (!state) {
    return {
      status: isGovernedMissionFlowClaimed(flow) ? "untrusted_governed_state" : "not_governed",
      flow,
    };
  }
  if (!isGovernedMissionStateCanonicallyPersisted(flow, state)) {
    return { status: "untrusted_governed_state", flow };
  }
  const existing = findGovernedMissionReceiptByIdempotencyFromSqlite({
    missionId: state.missionId,
    idempotencyKey: params.request.idempotencyKey,
  });
  if (existing) {
    return existingTransitionResult(flow, params.request, existing);
  }
  const declarations = readPinnedArtifactDeclarations(flow);
  const gates = readPinnedGateMap(flow);
  const artifactResults: GovernedArtifactVerificationResult[] = [];
  if (!gates) {
    return applyGovernedMissionOperationWithFacts({
      flowId: params.flowId,
      request: { ...params.request, passed: false, failureCodes: ["invalid_declaration"] },
      artifacts: artifactResults,
    });
  }
  for (const declaration of declarations) {
    const gate = gates.get(declaration.gateId);
    if (!gate) {
      continue;
    }
    const verified = await verifyGovernedArtifacts([declaration], {
      missionId: state.missionId,
      workOrderId: declaration.workOrderId,
      gateId: declaration.gateId,
      gateKind: gate.kind,
      operation: params.request.operation,
      flowRevision: flow.revision,
      observedAtMs: params.observedAtMs,
    });
    artifactResults.push(...verified.results);
  }
  return applyGovernedMissionOperationWithFacts({
    flowId: params.flowId,
    request: params.request,
    artifacts: artifactResults,
  });
}

function readPinnedArtifactDeclarations(flow: TaskFlowRecord): GovernedArtifactDeclaration[] {
  return (
    normalizeGovernedArtifactDeclarations(
      jsonObject(flow.stateJson)[GOVERNED_MISSION_ARTIFACT_DECLARATIONS_KEY],
    ) ?? []
  );
}

function findArtifactDeclarationAdmissionIssue(params: {
  declarations: readonly GovernedArtifactDeclaration[];
  mission: GovernedMissionState;
  compiledPlan: CompiledMissionPlan;
}): string | undefined {
  const expectedBindings: Record<string, string> = {
    missionId: params.mission.missionId,
    contractHash: params.mission.contractHash,
    authorityHash: params.mission.authorityHash,
    planRevisionId: params.mission.planRevisionId,
    sourceRevision: params.mission.sourceRevision,
    runtimeBuildSha256: params.mission.runtimeBuildSha256,
    policyVersion: params.mission.policyVersion,
    skillSha256: params.mission.skillSha256,
  };
  const gates = new Map(params.compiledPlan.gates.map((gate) => [gate.id, gate] as const));
  for (const declaration of params.declarations) {
    const bindings = declaration.identityBindings;
    if (
      declaration.missionId !== params.mission.missionId ||
      !bindings ||
      Object.entries(expectedBindings).some(([key, expected]) => bindings[key] !== expected)
    ) {
      return "ARTIFACT_DECLARATION_IDENTITY_MISMATCH";
    }
    const gate = gates.get(declaration.gateId);
    if (!gate || declaration.required !== gate.required) {
      return "ARTIFACT_DECLARATION_GATE_MISMATCH";
    }
  }
  const declaredRequiredGateIds = new Set(
    params.declarations.filter((declaration) => declaration.required).map((item) => item.gateId),
  );
  if (
    params.compiledPlan.gates.some((gate) => gate.required && !declaredRequiredGateIds.has(gate.id))
  ) {
    return "ARTIFACT_DECLARATION_REQUIRED_GATE_MISSING";
  }
  return undefined;
}

function applyGovernedMissionOperationWithFacts(params: {
  flowId: string;
  request: GovernedMissionOperation;
  artifacts: readonly GovernedArtifactVerificationResult[];
}): GovernedMissionRuntimeResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return { status: "not_found" };
  }
  const state = readGovernedMissionStateFromTaskFlow(flow);
  if (!state) {
    return {
      status: isGovernedMissionFlowClaimed(flow) ? "untrusted_governed_state" : "not_governed",
      flow,
    };
  }
  if (!isGovernedMissionStateCanonicallyPersisted(flow, state)) {
    return { status: "untrusted_governed_state", flow };
  }
  const canonicalRequest = bindOperationToCanonicalFacts(flow, params.request);
  const requestSha256 = digestTransitionRequest(canonicalRequest);
  const request = bindArtifactDecisionToVerifiedFacts({
    flow,
    state,
    request: canonicalRequest,
    artifacts: params.artifacts,
  });
  const payloadSha256 = digestTransitionPayload(request, params.artifacts);
  const existing = findGovernedMissionReceiptByIdempotencyFromSqlite({
    missionId: state.missionId,
    idempotencyKey: request.idempotencyKey,
  });
  if (existing) {
    return existingTransitionResult(flow, canonicalRequest, existing);
  }

  const releaseAuthorization = buildReleaseAuthorization(flow, state, request);
  const decision = evaluateWithFlowOwner(
    flow,
    state,
    request,
    releaseAuthorization ? { releaseAuthorization } : {},
  );
  if (decision.status === "conflict") {
    const receipt = buildTransitionLedgerReceipt({
      flow,
      state,
      request,
      decision,
      payloadSha256,
      requestSha256,
      releaseAuthorization,
    });
    const committed = commitGovernedMissionLedger({ receipt });
    if (committed.status === "idempotency_conflict") {
      return {
        status: "conflict",
        flow,
        decision,
        reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT",
      };
    }
    if (committed.status === "revision_conflict") {
      return { status: "conflict", flow, decision, reasonCode: "REVISION_CONFLICT" };
    }
    return {
      status: "conflict",
      flow,
      decision,
      reasonCode: "REVISION_CONFLICT",
      receipt: committed.receipt,
    };
  }
  const receipt = buildTransitionLedgerReceipt({
    flow,
    state,
    request,
    decision,
    payloadSha256,
    requestSha256,
    releaseAuthorization,
  });
  const nextFlow = decision.stateChanged
    ? applyMissionStateToFlow(flow, decision.nextState, request, releaseAuthorization)
    : undefined;
  const artifacts = params.artifacts.map((artifact) => bindArtifactLedgerRecord(artifact, receipt));
  const terminalAdmissionPreconditionSha256 =
    request.operation === "admitTerminalPendingWatchdog" && decision.status === "applied"
      ? computeGovernedTerminalAdmissionPreconditionSha256(flow)
      : undefined;
  const requireNoActiveTasks =
    decision.status === "applied" &&
    (request.operation === "cancelMission" || request.operation === "stopMission");
  const committed = commitGovernedMissionLedger({
    receipt,
    nextFlow,
    artifacts,
    ...(terminalAdmissionPreconditionSha256 ? { terminalAdmissionPreconditionSha256 } : {}),
    ...(requireNoActiveTasks ? { requireNoActiveTasks: true } : {}),
  });
  if (committed.status === "revision_conflict") {
    return {
      status: "conflict",
      flow,
      decision,
      reasonCode: committed.reason === "active_work" ? "ACTIVE_WORK_CONFLICT" : "REVISION_CONFLICT",
    };
  }
  if (committed.status === "idempotency_conflict") {
    return { status: "conflict", flow, decision, reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT" };
  }
  if (committed.status === "already_applied") {
    return { status: "already_applied", flow, receipt: committed.receipt };
  }
  return {
    status: decision.status,
    flow: nextFlow ?? flow,
    decision,
    receipt: committed.receipt,
  } as GovernedMissionRuntimeResult;
}

function bindArtifactDecisionToVerifiedFacts(params: {
  flow: TaskFlowRecord;
  state: GovernedMissionState;
  request: GovernedMissionOperation;
  artifacts: readonly GovernedArtifactVerificationResult[];
}): GovernedMissionOperation {
  if (params.request.operation !== "verifyRequiredArtifacts") {
    return params.request;
  }
  const mismatched = params.artifacts.some(
    (artifact) =>
      artifact.missionId !== params.state.missionId ||
      artifact.operation !== params.request.operation ||
      artifact.flowRevision !== params.flow.revision,
  );
  const rejected = params.artifacts.filter((artifact) => artifact.status === "rejected");
  const gates = readPinnedGateMap(params.flow);
  const requiredGateIds = gates
    ? [...gates.values()].filter((gate) => gate.required).map((gate) => gate.id)
    : [];
  const verifiedGateIds = new Set(
    params.artifacts
      .filter((artifact) => artifact.status === "verified" && artifact.required)
      .map((artifact) => artifact.gateId),
  );
  const requiredGateMissing =
    !gates ||
    requiredGateIds.length === 0 ||
    requiredGateIds.some((gateId) => !verifiedGateIds.has(gateId));
  const passed = !requiredGateMissing && !mismatched && rejected.length === 0;
  const failureCodes = mismatched
    ? ["identity_mismatch"]
    : requiredGateMissing
      ? ["invalid_declaration"]
      : rejected.flatMap((artifact) => (artifact.failureCode ? [artifact.failureCode] : []));
  return {
    ...params.request,
    passed,
    ...(passed
      ? {
          satisfiedProofs: (["rollback", "restoration"] as const).filter((proof) =>
            params.artifacts.some(
              (artifact) => artifact.status === "verified" && artifact.gateKind === proof,
            ),
          ),
        }
      : {}),
    ...(failureCodes.length > 0 ? { failureCodes: failureCodes.toSorted() } : {}),
  };
}

function bindOperationToCanonicalFacts(
  flow: TaskFlowRecord,
  request: GovernedMissionOperation,
): GovernedMissionOperation {
  if (request.operation === "releaseFinalResult") {
    const withheld = readGovernedMissionWithheldPayload(flow);
    return {
      ...request,
      ...(withheld ? { payloadHash: withheld.payloadHash } : { payloadHash: undefined }),
    };
  }
  if (request.operation !== "admitTerminalPendingWatchdog") {
    return request;
  }
  const openWorkCount = countActiveTaskRegistryRecordsForFlowFromSqlite(flow.flowId);
  return {
    ...request,
    parentScopeClosed: isTaskFlowProductionParentScopeClosed(flow, openWorkCount),
    openWorkCount,
  };
}

function existingTransitionResult(
  flow: TaskFlowRecord,
  request: GovernedMissionOperation,
  receipt: GovernedMissionLedgerReceipt,
): GovernedMissionRuntimeResult {
  const details = jsonObject(receipt.details);
  if (
    request.operation === "requestReadmission" &&
    request.productionRequestSha256 &&
    details.productionRequestSha256 === request.productionRequestSha256
  ) {
    return { status: "already_applied", flow, receipt };
  }
  const requestSha256 = digestTransitionRequest(request);
  if (details.requestSha256 !== requestSha256) {
    return { status: "conflict", flow, reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT" };
  }
  return { status: "already_applied", flow, receipt };
}

function requiredProofsForAdmission(
  input: AdmitGovernedMissionToTaskFlowInput,
): GovernedMissionAdmissionInput["requiredProofs"] {
  const gates = Array.isArray(input.compiledPlan?.gates) ? input.compiledPlan.gates : [];
  const requiredGateKinds = new Set(gates.filter((gate) => gate.required).map((gate) => gate.kind));
  return {
    ...input.admission.requiredProofs,
    rollback: requiredGateKinds.has("rollback"),
    restoration: requiredGateKinds.has("restoration"),
    ...(input.deliveryRequired !== undefined ? { delivery: input.deliveryRequired } : {}),
  };
}

export function listGovernedMissionReceipts(params: {
  flowId: string;
  limit?: number;
}): GovernedMissionLedgerReceipt[] {
  return listGovernedMissionReceiptsFromSqlite({
    flowId: params.flowId,
    limit: params.limit ?? 50,
  });
}

function evaluateWithFlowOwner(
  flow: TaskFlowRecord,
  state: GovernedMissionState,
  request: GovernedMissionOperation,
  context: {
    releaseAuthorization?: GovernedReleaseAuthorization;
    activeChildWorkPresent?: boolean;
  } = {},
): GovernedMissionTransitionDecision {
  if (request.controllerId !== flow.controllerId) {
    return {
      schema: "openclaw.governed_mission_transition_decision.v1",
      status: "denied",
      operation: request.operation,
      reasonCode: "CONTROLLER_MISMATCH",
      receiptKind: "transition",
      previousState: state,
      nextState: state,
      stateChanged: false,
      nextAction: "Use the managed TaskFlow controller recorded at admission.",
      missingProof: [],
    };
  }
  return evaluateGovernedMissionOperation(state, request, {
    cancellationPending: flow.cancelRequestedAt != null && flow.status !== "cancelled",
    ...(context.activeChildWorkPresent !== undefined
      ? { activeChildWorkPresent: context.activeChildWorkPresent }
      : {}),
    ...(context.releaseAuthorization
      ? {
          releaseAuthorization: {
            allowed: context.releaseAuthorization.allowed,
            reasonCode: context.releaseAuthorization.reasonCode,
          },
        }
      : {}),
  });
}

function buildReleaseAuthorization(
  flow: TaskFlowRecord,
  state: GovernedMissionState,
  request: GovernedMissionOperation,
): GovernedReleaseAuthorization | undefined {
  if (request.operation !== "releaseFinalResult") {
    return undefined;
  }
  const contract = readPinnedGovernedMissionContract(flow);
  if (!contract) {
    return {
      allowed: false,
      reasonCode: "PINNED_CONTRACT_MISSING",
      missingReceiptKinds: [],
    };
  }
  if (contract.authoritativeCompletionOwner !== "governed_mission_state") {
    return {
      allowed: false,
      reasonCode: "AUTHORITATIVE_COMPLETION_OWNER_MISMATCH",
      missingReceiptKinds: [],
    };
  }
  const withheld = readGovernedMissionWithheldPayload(flow);
  if (!withheld || request.payloadHash !== withheld.payloadHash) {
    return {
      allowed: false,
      reasonCode: "WITHHELD_PAYLOAD_IDENTITY_MISSING",
      missingReceiptKinds: [],
    };
  }
  const receipts = listAppliedGovernedMissionContractReceiptsFromSqlite({
    flow,
    missionId: state.missionId,
  }).filter(
    (receipt) =>
      receipt.contractId === state.contractId &&
      receipt.contractHash === state.contractHash &&
      receipt.authorityHash === state.authorityHash &&
      receipt.planRevisionId === state.planRevisionId &&
      receipt.sourceRevision === state.sourceRevision &&
      receipt.runtimeBuildSha256 === state.runtimeBuildSha256 &&
      receipt.policyVersion === state.policyVersion &&
      receipt.skillSha256 === state.skillSha256,
  );
  const presentKinds = new Set(receipts.flatMap((receipt) => receipt.contractReceiptKinds ?? []));
  const requiredBeforeRelease = contract.requiredReceiptKinds.filter(
    (kind): kind is GovernedReceiptKind => kind !== "release",
  );
  const missingReceiptKinds = requiredBeforeRelease.filter((kind) => !presentKinds.has(kind));
  if (missingReceiptKinds.length > 0) {
    return {
      allowed: false,
      reasonCode: "REQUIRED_RECEIPT_KIND_MISSING",
      missingReceiptKinds,
    };
  }

  const requiredReceiptRefs = receipts
    .filter((receipt) =>
      receipt.contractReceiptKinds?.some((kind) => requiredBeforeRelease.includes(kind)),
    )
    .map((receipt) => receipt.receiptId)
    .toSorted();
  const proofNames = [
    "implementation",
    "validation",
    "review",
    "artifacts",
    "rollback",
    "restoration",
    "postTerminalWatchdog",
  ] as const;
  const closeoutPassed = proofNames.every(
    (name) => state.proofs[name] === "passed" || state.proofs[name] === "not_required",
  );
  const runId = withheld.runId;
  const closeoutValidation = validateGovernedCloseoutAndBuildReleaseState({
    contract,
    runId,
    observedContractHash: state.contractHash,
    observedAuthorityHash: state.authorityHash,
    requestedCompletionOwner: "governed_mission_state",
    requiredEvidenceReceiptRefs: requiredReceiptRefs,
    presentEvidenceReceiptRefs: requiredReceiptRefs,
    closeoutPassed,
    noBlockingState: state.blockedStatus === "not_blocked",
    ...(request.payloadHash ? { payloadHash: request.payloadHash } : {}),
    ...(state.overrideRef.overrideId ? { overrideRef: state.overrideRef.overrideId } : {}),
    producedAt: request.occurredAt,
    decisionSequence: state.revision,
    producer: GOVERNED_MISSION_RUNTIME_PRODUCER,
  });
  const releaseDecision = mayReleaseGovernedFinal({
    missionId: state.missionId,
    runId,
    contractId: state.contractId,
    contractHash: state.contractHash,
    ...(request.payloadHash ? { payloadHash: request.payloadHash } : {}),
    releaseState: closeoutValidation.releaseState,
  });
  return {
    allowed: releaseDecision.allowed,
    reasonCode: releaseDecision.allowed
      ? "FINAL_RELEASE_AUTHORIZED"
      : `FINAL_RELEASE_${releaseDecision.reason.toUpperCase()}`,
    missingReceiptKinds,
    closeoutValidation,
  };
}

export function readPinnedGovernedMissionContract(
  flow: TaskFlowRecord,
): GovernedMissionContract | null {
  const value = jsonObject(flow.stateJson)[GOVERNED_MISSION_CONTRACT_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const contract = value as Partial<GovernedMissionContract>;
  return contract.schema === "openclaw.governed_mission_contract.v1" &&
    missingGovernedContractFoundationFields(contract).length === 0
    ? (contract as GovernedMissionContract)
    : null;
}

function readPinnedGateMap(
  flow: TaskFlowRecord,
): Map<string, { id: string; kind: GateKind; required: boolean }> | null {
  const plan = jsonObject(flow.stateJson)[GOVERNED_MISSION_PLAN_KEY];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return null;
  }
  const gates = plan.gates;
  if (!Array.isArray(gates) || gates.length === 0) {
    return null;
  }
  const normalized = new Map<string, { id: string; kind: GateKind; required: boolean }>();
  for (const gate of gates) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      return null;
    }
    const id = typeof gate.id === "string" ? gate.id.trim() : "";
    const kind = typeof gate.kind === "string" ? gate.kind : "";
    if (
      !id ||
      !(MISSION_GATE_KINDS as readonly string[]).includes(kind) ||
      typeof gate.required !== "boolean" ||
      normalized.has(id)
    ) {
      return null;
    }
    normalized.set(id, { id, kind: kind as GateKind, required: gate.required });
  }
  return normalized;
}

function buildAdmissionLedgerReceipt(params: {
  admission: ReturnType<typeof admitGovernedMission>;
  missionId: string;
  flowId?: string;
  attemptId?: string;
  idempotencyKey: string;
  payloadSha256: string;
  productionRequestSha256?: string;
  createdAt: number;
  decision?: "applied" | "denied";
  reasonCode?: string;
}): GovernedMissionLedgerReceipt {
  const state = params.admission.missionState;
  const decision =
    params.decision ?? (params.admission.decision === "ADMIT" ? "applied" : "denied");
  return {
    receiptId: `governed:${digest([params.missionId, params.idempotencyKey]).slice(0, 40)}`,
    missionId: params.missionId,
    ...(params.flowId ? { flowId: params.flowId } : {}),
    ...(params.attemptId ? { attemptId: params.attemptId } : {}),
    operation: "admitMission",
    receiptKind: "transition",
    toState: state?.currentGovernedState,
    decision,
    reasonCode: params.reasonCode ?? params.admission.reasonCode,
    resultingRevision: state?.revision,
    contractId: params.admission.contractId,
    contractHash: params.admission.contractHash,
    authorityHash: params.admission.authorityHash,
    planRevisionId: state?.planRevisionId,
    sourceRevision: state?.sourceRevision,
    runtimeBuildSha256: state?.runtimeBuildSha256,
    policyVersion: state?.policyVersion,
    skillSha256: state?.skillSha256,
    payloadSha256: params.payloadSha256,
    ...(decision === "applied" ? { contractReceiptKinds: ["admission", "policy_decision"] } : {}),
    producer: GOVERNED_MISSION_RUNTIME_PRODUCER,
    idempotencyKey: params.idempotencyKey,
    details: {
      ...(params.productionRequestSha256
        ? { productionRequestSha256: params.productionRequestSha256 }
        : {}),
      obligations: params.reasonCode
        ? [`repair_admission_package:${params.reasonCode}`]
        : params.admission.obligations,
    },
    createdAt: params.createdAt,
  };
}

function sameAdmissionRequest(
  receipt: GovernedMissionLedgerReceipt,
  productionRequestSha256: string | undefined,
  payloadSha256: string,
): boolean {
  const details = jsonObject(receipt.details);
  return productionRequestSha256 && typeof details.productionRequestSha256 === "string"
    ? details.productionRequestSha256 === productionRequestSha256
    : receipt.payloadSha256 === payloadSha256;
}

function buildTransitionLedgerReceipt(params: {
  flow: TaskFlowRecord;
  state: GovernedMissionState;
  request: GovernedMissionOperation;
  decision: GovernedMissionTransitionDecision;
  payloadSha256: string;
  requestSha256: string;
  releaseAuthorization?: GovernedReleaseAuthorization;
}): GovernedMissionLedgerReceipt {
  const contractReceiptKinds = contractReceiptKindsForTransition(params.request, params.decision);
  return {
    receiptId: `governed:${digest([params.state.missionId, params.request.idempotencyKey]).slice(0, 40)}`,
    missionId: params.state.missionId,
    flowId: params.flow.flowId,
    runId: params.state.ownerCorrelation.runId,
    ...((params.request.operation === "openExecutionLease" ||
      params.request.operation === "closeExecutionLease") &&
    params.request.runId.trim()
      ? { attemptId: params.request.runId.trim() }
      : {}),
    operation: params.request.operation,
    receiptKind: params.decision.receiptKind,
    fromState: params.state.currentGovernedState,
    toState: params.decision.nextState.currentGovernedState,
    decision: params.decision.status,
    reasonCode: params.decision.reasonCode,
    expectedRevision: params.request.expectedRevision,
    resultingRevision: params.decision.nextState.revision,
    contractId: params.decision.nextState.contractId,
    contractHash: params.decision.nextState.contractHash,
    authorityHash: params.decision.nextState.authorityHash,
    planRevisionId: params.decision.nextState.planRevisionId,
    sourceRevision: params.decision.nextState.sourceRevision,
    runtimeBuildSha256: params.decision.nextState.runtimeBuildSha256,
    policyVersion: params.decision.nextState.policyVersion,
    skillSha256: params.decision.nextState.skillSha256,
    payloadSha256: params.payloadSha256,
    ...(contractReceiptKinds.length > 0 ? { contractReceiptKinds } : {}),
    producer: GOVERNED_MISSION_RUNTIME_PRODUCER,
    idempotencyKey: params.request.idempotencyKey,
    details: {
      requestSha256: params.requestSha256,
      ...(params.request.operation === "requestReadmission" &&
      params.request.productionRequestSha256
        ? { productionRequestSha256: params.request.productionRequestSha256 }
        : {}),
      requestBindings: params.request.bindings,
      missingProof: params.decision.missingProof,
      nextAction: params.decision.nextAction,
      ...(params.releaseAuthorization
        ? {
            releaseAuthorization: {
              allowed: params.releaseAuthorization.allowed,
              reasonCode: params.releaseAuthorization.reasonCode,
              missingReceiptKinds: params.releaseAuthorization.missingReceiptKinds,
              ...(params.releaseAuthorization.closeoutValidation
                ? { closeoutValidation: params.releaseAuthorization.closeoutValidation }
                : {}),
            },
          }
        : {}),
    },
    createdAt: parseTimestamp(params.request.occurredAt),
  };
}

function contractReceiptKindsForTransition(
  request: GovernedMissionOperation,
  decision: GovernedMissionTransitionDecision,
): GovernedReceiptKind[] {
  if (decision.status !== "applied") {
    return [];
  }
  switch (request.operation) {
    case "recordImplementationResult":
    case "recordValidationResult":
    case "recordReviewResult":
    case "recordDeliveryResult":
      return ["evidence"];
    case "verifyRequiredArtifacts":
      return request.satisfiedProofs?.includes("rollback")
        ? ["evidence", "rollback"]
        : ["evidence"];
    case "requestCloseout":
      return ["closeout"];
    case "recordPostTerminalWatchdog":
      return ["supervisor"];
    case "releaseFinalResult":
      return ["release"];
    case "requestReadmission":
      return ["admission", "policy_decision"];
    default:
      return [];
  }
}

function bindArtifactLedgerRecord(
  artifact: GovernedArtifactVerificationResult,
  receipt: GovernedMissionLedgerReceipt,
): GovernedMissionArtifactLedgerRecord {
  return {
    verificationId: `artifact:${digest([receipt.receiptId, artifact.artifactId]).slice(0, 40)}`,
    receiptId: receipt.receiptId,
    missionId: artifact.missionId,
    flowId: receipt.flowId,
    workOrderId: artifact.workOrderId,
    gateId: artifact.gateId,
    logicalArtifactId: artifact.artifactId,
    artifactKind: artifact.artifactKind,
    locator: artifact.locator,
    status: artifact.status,
    failureCode: artifact.failureCode,
    sizeBytes: artifact.sizeBytes,
    computedSha256: artifact.computedSha256,
    expectedSha256: artifact.expectedSha256,
    expectedLabels: artifact.expectedLabels,
    identityBindings: artifact.identityBindings,
    verifierVersion: artifact.verifierVersion,
    verifiedAt: artifact.verifiedAt,
  };
}

function applyMissionStateToFlow(
  flow: TaskFlowRecord,
  state: GovernedMissionState,
  request: GovernedMissionOperation,
  releaseAuthorization?: GovernedReleaseAuthorization,
): TaskFlowRecord {
  const patch = buildGovernedMissionTaskFlowStatePatch(flow, state);
  const status = taskFlowStatusFor(state);
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
  const updatedAt = parseTimestamp(request.occurredAt);
  // Readmission replaces every pinned proof input with the new identity.
  // Retaining the old plan or declarations would allow stale proof or trap closeout.
  const stateJson =
    request.operation === "requestReadmission"
      ? {
          ...jsonObject(patch.stateJson),
          [GOVERNED_MISSION_CONTRACT_KEY]: request.replacementContract as unknown as JsonValue,
          [GOVERNED_MISSION_PLAN_KEY]: request.replacementCompiledPlan as unknown as JsonValue,
          [GOVERNED_MISSION_ARTIFACT_DECLARATIONS_KEY]: normalizeGovernedArtifactDeclarations(
            request.replacementArtifactDeclarations,
          ) as unknown as JsonValue,
          authorityPath: resolveGovernedAuthorityPath(request.replacementIdentity.authorityRef.uri),
        }
      : patch.stateJson;
  let governedStateJson =
    request.operation === "releaseFinalResult" && releaseAuthorization?.closeoutValidation
      ? {
          ...jsonObject(stateJson),
          [GOVERNED_MISSION_RELEASE_STATE_KEY]: releaseAuthorization.closeoutValidation
            .releaseState as unknown as JsonValue,
        }
      : stateJson;
  if (request.operation === "requestReadmission") {
    const previousContinuation = getTaskFlowProductionContinuation(flow);
    const restartedContinuation = createStartedProductionContinuationState({
      continuation: { activeProductionRun: true, parentRunOpen: true },
      at: updatedAt,
    });
    // A replacement mission is new active work. Preserve prior events for audit, but
    // clear every stop/completion flag so watchdog and issue handling resume together.
    const continuation = previousContinuation
      ? {
          ...restartedContinuation,
          events: [...previousContinuation.events, ...restartedContinuation.events],
        }
      : restartedContinuation;
    governedStateJson =
      attachProductionContinuationToStateJson({
        flow,
        stateJson: governedStateJson,
        continuation,
      }) ?? governedStateJson;
  }
  if (request.operation === "admitTerminalPendingWatchdog") {
    const continuation = getTaskFlowProductionContinuation(flow);
    const closedContinuation = buildProductionContinuationForLawfulStop({
      state: continuation ?? undefined,
      reason: "whole_run_complete",
      at: updatedAt,
      detail: "Governed mission admitted terminal-pending after canonical parent-scope proof.",
    });
    governedStateJson =
      attachProductionContinuationToStateJson({
        flow,
        stateJson: governedStateJson,
        continuation: closedContinuation,
      }) ?? governedStateJson;
  }
  return {
    ...flow,
    revision: flow.revision + 1,
    status,
    currentStep: state.currentStep,
    stateJson: governedStateJson,
    blockedSummary:
      status === "blocked" ? `Governed mission requires repair: ${state.blockedStatus}` : undefined,
    updatedAt,
    ...(terminal ? { endedAt: updatedAt } : { endedAt: undefined }),
  };
}

function taskFlowStatusFor(mission: GovernedMissionState): TaskFlowRecord["status"] {
  const state = mission.currentGovernedState;
  if (state === "released") {
    return mission.proofs.delivery === "pending" || mission.proofs.delivery === "failed"
      ? "terminal_pending_watchdog"
      : "succeeded";
  }
  if (state === "failed" || state === "lost") {
    return state;
  }
  if (state === "cancelled" || state === "operator_stopped") {
    return "cancelled";
  }
  if (state === "terminal_pending_watchdog") {
    return "terminal_pending_watchdog";
  }
  if (state === "repair_required" || state === "readmission_required" || state === "blocked") {
    return "blocked";
  }
  if (state === "waiting" || state === "pending_override") {
    return "waiting";
  }
  if (state === "planned" || state === "admitted") {
    return "queued";
  }
  return "running";
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function digestAdmissionPayload(
  input: AdmitGovernedMissionToTaskFlowInput,
  artifactDeclarations: unknown,
  missionId: string,
): string {
  const {
    createdAt: _createdAt,
    idempotencyKey: _idempotencyKey,
    admission,
    ...stableInput
  } = input;
  const { now: _now, enforcementCapabilities, ...stableAdmission } = admission;
  const stableCapabilities = Array.isArray(enforcementCapabilities)
    ? enforcementCapabilities.map(({ observedAt: _observedAt, ...record }) => record)
    : enforcementCapabilities;
  return digest({
    ...stableInput,
    admission: { ...stableAdmission, enforcementCapabilities: stableCapabilities },
    artifactDeclarations,
    missionId,
  });
}

function admissionAttemptId(input: AdmitGovernedMissionToTaskFlowInput): string {
  return `admission-attempt:${digest([
    input.idempotencyKey.trim() || "missing-idempotency-key",
    input.admission.actor.actorId,
    input.admission.actor.runId ?? "",
  ]).slice(0, 40)}`;
}

function resolveAdmissionTimestamp(input: AdmitGovernedMissionToTaskFlowInput): {
  value: number;
  issue?: "ADMISSION_TIMESTAMP_INVALID";
} {
  if (input.createdAt !== undefined && Number.isFinite(input.createdAt) && input.createdAt >= 0) {
    return { value: input.createdAt };
  }
  const parsed = Date.parse(input.admission.now);
  if (Number.isFinite(parsed)) {
    return { value: parsed };
  }
  return { value: Date.now(), issue: "ADMISSION_TIMESTAMP_INVALID" };
}

function digestTransitionPayload(
  request: GovernedMissionOperation,
  artifacts: readonly GovernedArtifactVerificationResult[],
): string {
  const { occurredAt: _occurredAt, ...stableRequest } = request;
  const stableArtifacts = artifacts.map(({ verifiedAt: _verifiedAt, ...artifact }) => artifact);
  return digest({ request: stableRequest, artifacts: stableArtifacts });
}

function digestTransitionRequest(request: GovernedMissionOperation): string {
  const { occurredAt: _occurredAt, ...stableRequest } = request;
  if (stableRequest.operation === "requestReadmission") {
    const { bindings: _bindings, ...stableReadmissionRequest } = stableRequest;
    return digest(stableReadmissionRequest);
  }
  if ("passed" in stableRequest && stableRequest.sourceEvidenceHash) {
    const {
      passed: _passed,
      proofRefs: _proofRefs,
      failureCodes: _failureCodes,
      ...stableEvidenceRequest
    } = stableRequest;
    return digest(stableEvidenceRequest);
  }
  if (stableRequest.operation === "admitTerminalPendingWatchdog") {
    const {
      parentScopeClosed: _parentScopeClosed,
      openWorkCount: _openWorkCount,
      ...stableTerminalRequest
    } = stableRequest;
    return digest(stableTerminalRequest);
  }
  if (stableRequest.operation === "recordPostTerminalWatchdog") {
    const {
      passed: _passed,
      proofRefs: _proofRefs,
      failureCodes: _failureCodes,
      boundRevision: _boundRevision,
      boundRuntimeBuildSha256: _boundRuntimeBuildSha256,
      ...stableWatchdogRequest
    } = stableRequest;
    return digest(stableWatchdogRequest);
  }
  if (stableRequest.operation === "releaseFinalResult") {
    const { payloadHash: _payloadHash, ...stableReleaseRequest } = stableRequest;
    return digest(stableReleaseRequest);
  }
  return digest(stableRequest);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
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

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid governed mission timestamp: ${value}`);
  }
  return parsed;
}

function jsonObject(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

export type { GovernedMissionLedgerCommitResult };
