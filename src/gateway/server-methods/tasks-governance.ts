import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type TasksGovernanceApplyParams,
  type TasksGovernanceApplyResult,
  type TasksGovernancePreviewResult,
  type TasksGovernanceStatusResult,
  validateTasksGovernancePreviewParams,
  validateTasksGovernanceStatusParams,
  validateTasksGovernanceApplyParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  observeGovernedMissionIdentity,
  readGovernedWorkspaceSkillSha256,
} from "../../governance/governed-mission-identity.js";
import { computeGovernedMissionReceiptSha256 } from "../../governance/governed-mission-ledger-integrity.js";
import { GOVERNED_MISSION_RUNTIME_PRODUCER } from "../../governance/governed-mission-ledger.types.js";
import { readmitGovernedProductionFlow } from "../../governance/governed-mission-production-admission.js";
import {
  applyGovernedMissionOperation,
  isGovernedMissionFlowClaimed,
  isGovernedMissionStateCanonicallyPersisted,
  listGovernedMissionReceipts,
  previewGovernedMissionOperation,
  readGovernedMissionReleasedPayload,
  readGovernedMissionWithheldPayload,
  readPinnedGovernedMissionContract,
  resolveGovernedMissionFlowForLookupToken,
  resolveGovernedMissionOperationIdempotency,
  verifyAndApplyGovernedMissionArtifacts,
} from "../../governance/governed-mission-runtime.js";
import { readGovernedMissionStateFromTaskFlow } from "../../governance/governed-mission-state.js";
import type {
  GovernedMissionIdentityBindings,
  GovernedMissionOperation,
  GovernedMissionTransitionDecision,
} from "../../governance/governed-mission-transition.js";
import { GOVERNED_MISSION_PUBLIC_OPERATIONS } from "../../governance/governed-mission-transition.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  computeProductionExecutorAssignmentSha256,
  getProductionExecutorAssignment,
  isProductionExecutorAssignmentCurrentGovernedAttempt,
  type ProductionExecutorAssignment,
} from "../../tasks/production-executor-assignment.js";
import { getTaskById, listTasksForFlowId } from "../../tasks/runtime-internal.js";
import { listTaskFlowAuditFindings } from "../../tasks/task-flow-registry.audit.js";
import { deriveTaskFlowStatusFromTask } from "../../tasks/task-flow-registry.js";
import {
  findGovernedMissionReceiptByIdFromSqlite,
  findGovernedMissionReceiptByIdempotencyFromSqlite,
  findValidatedGovernedMissionReceiptByIdempotencyFromSqlite,
} from "../../tasks/task-flow-registry.store.sqlite.js";
import { isTaskFlowProductionParentScopeClosed } from "../../tasks/task-flow-runtime-internal.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";

const GOVERNED_OPERATION_NAMES = new Set<GovernedMissionOperation["operation"]>(
  GOVERNED_MISSION_PUBLIC_OPERATIONS,
);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readCurrentSkillSha256(params: {
  flow: NonNullable<ReturnType<typeof resolveGovernedMissionFlowForLookupToken>>;
  config: OpenClawConfig;
}): string | undefined {
  const agentId =
    parseAgentSessionKey(params.flow.ownerKey)?.agentId ?? resolveDefaultAgentId(params.config);
  return readGovernedWorkspaceSkillSha256({
    workspaceDir: resolveAgentWorkspaceDir(params.config, agentId),
    config: params.config,
    agentId,
  });
}

function buildOperation(params: {
  flow: NonNullable<ReturnType<typeof resolveGovernedMissionFlowForLookupToken>>;
  bindings: GovernedMissionIdentityBindings;
  operation: GovernedMissionOperation["operation"];
  payloadHash?: string;
  reasonCode?: string;
  nextAction?: string;
}): GovernedMissionOperation | null {
  const operation = params.operation;
  const mission = readGovernedMissionStateFromTaskFlow(params.flow);
  if (!mission) {
    return null;
  }
  const expectedRevision = mission.revision;
  const idempotencyKey = `preview:${params.operation}:${mission.revision}`;
  const controllerId = params.flow.controllerId;
  if (!controllerId) {
    return null;
  }
  const base = {
    operation: params.operation,
    expectedRevision,
    idempotencyKey,
    owner: mission.ownerCorrelation.owner,
    controllerId,
    bindings: params.bindings,
    occurredAt: new Date().toISOString(),
  };
  switch (operation) {
    case "startWorkOrder":
    case "requestCloseout":
    case "requestReadmission":
      return base as GovernedMissionOperation;
    case "openExecutionLease":
    case "closeExecutionLease":
      return null;
    case "recordImplementationResult":
    case "recordValidationResult":
    case "recordReviewResult":
    case "verifyRequiredArtifacts":
    case "recordDeliveryResult":
      return { ...base, passed: false } as GovernedMissionOperation;
    case "admitTerminalPendingWatchdog":
      return {
        ...base,
        parentScopeClosed: false,
        openWorkCount: 1,
      } as GovernedMissionOperation;
    case "recordPostTerminalWatchdog":
      return {
        ...base,
        passed: false,
        boundRevision: -1,
        boundRuntimeBuildSha256: "missing",
      } as GovernedMissionOperation;
    case "releaseFinalResult":
      return {
        ...base,
        operation: "releaseFinalResult",
        ...(params.payloadHash ? { payloadHash: params.payloadHash } : {}),
      };
    case "blockForRepair":
      return {
        ...base,
        operation: "blockForRepair",
        reasonCode: params.reasonCode ?? "REPAIR_REQUIRED",
        nextAction: params.nextAction ?? "Repair the governed mission.",
      };
    case "cancelMission": {
      const reasonCode = params.reasonCode;
      return { ...base, operation: "cancelMission", ...(reasonCode ? { reasonCode } : {}) };
    }
    case "stopMission": {
      const reasonCode = params.reasonCode;
      return { ...base, operation: "stopMission", ...(reasonCode ? { reasonCode } : {}) };
    }
  }
  const unreachableOperation: never = operation;
  return unreachableOperation;
}

function missionProjection(
  state: NonNullable<ReturnType<typeof readGovernedMissionStateFromTaskFlow>>,
) {
  return {
    schema: state.schema,
    missionId: state.missionId,
    contractId: state.contractId,
    contractVersion: state.contractVersion,
    contractHash: state.contractHash,
    authorityHash: state.authorityHash,
    authorityRef: {
      refId: state.authorityRef.refId,
      kind: state.authorityRef.kind,
      sha256: state.authorityRef.sha256 ?? null,
    },
    planRevisionId: state.planRevisionId,
    sourceRevision: state.sourceRevision,
    runtimeBuildSha256: state.runtimeBuildSha256,
    policyVersion: state.policyVersion,
    skillSha256: state.skillSha256,
    currentGovernedState: state.currentGovernedState,
    currentStep: state.currentStep,
    owner: state.ownerCorrelation.owner,
    taskFlowId: state.ownerCorrelation.taskFlowId ?? null,
    terminalStatus: state.terminalStatus,
    blockedStatus: state.blockedStatus,
    proofs: state.proofs,
    revision: state.revision,
    stateVersion: state.stateVersion,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

function receiptProjection(receipt: ReturnType<typeof listGovernedMissionReceipts>[number]) {
  return {
    receiptId: receipt.receiptId,
    operation: receipt.operation,
    receiptKind: receipt.receiptKind,
    fromState: receipt.fromState ?? null,
    toState: receipt.toState ?? null,
    decision: receipt.decision,
    reasonCode: receipt.reasonCode,
    expectedRevision: receipt.expectedRevision ?? null,
    resultingRevision: receipt.resultingRevision ?? null,
    payloadSha256: receipt.payloadSha256,
    producer: receipt.producer,
    createdAt: receipt.createdAt,
  };
}

function transitionDecisionProjection(decision: GovernedMissionTransitionDecision) {
  return {
    status: decision.status,
    operation: decision.operation,
    reasonCode: decision.reasonCode,
    receiptKind: decision.receiptKind,
    stateChanged: decision.stateChanged,
    nextAction: decision.nextAction,
    missingProof: decision.missingProof,
    currentMission: missionProjection(decision.previousState),
    proposedMission: missionProjection(decision.nextState),
  };
}

function previewProjection(
  result: ReturnType<typeof previewGovernedMissionOperation>,
): TasksGovernancePreviewResult["preview"] {
  if (result.status === "not_found") {
    return result;
  }
  if (result.status === "not_governed" || result.status === "untrusted_governed_state") {
    return {
      status: result.status,
      flowId: result.flow.flowId,
      flowRevision: result.flow.revision,
    };
  }
  return {
    status: result.status,
    flowId: result.flow.flowId,
    flowRevision: result.flow.revision,
    decision: transitionDecisionProjection(result.decision),
  };
}

function canonicalOperationBase(params: {
  flow: NonNullable<ReturnType<typeof resolveGovernedMissionFlowForLookupToken>>;
  mission: NonNullable<ReturnType<typeof readGovernedMissionStateFromTaskFlow>>;
  input: TasksGovernanceApplyParams;
  bindings: GovernedMissionIdentityBindings;
}) {
  return {
    expectedRevision: params.input.expectedRevision,
    idempotencyKey: params.input.idempotencyKey,
    owner: params.mission.ownerCorrelation.owner,
    controllerId: params.flow.controllerId,
    bindings: params.bindings,
    occurredAt: new Date().toISOString(),
  };
}

function pinnedMissionBindings(
  mission: NonNullable<ReturnType<typeof readGovernedMissionStateFromTaskFlow>>,
): GovernedMissionIdentityBindings {
  return {
    contractHash: mission.contractHash,
    authorityHash: mission.authorityHash,
    planRevisionId: mission.planRevisionId,
    sourceRevision: mission.sourceRevision,
    runtimeBuildSha256: mission.runtimeBuildSha256,
    policyVersion: mission.policyVersion,
    skillSha256: mission.skillSha256,
  };
}

function receiptMissionBindings(
  receipt: NonNullable<ReturnType<typeof findGovernedMissionReceiptByIdempotencyFromSqlite>>,
): GovernedMissionIdentityBindings | undefined {
  const details =
    receipt.details && typeof receipt.details === "object" && !Array.isArray(receipt.details)
      ? receipt.details
      : undefined;
  const requestBindings =
    details?.requestBindings &&
    typeof details.requestBindings === "object" &&
    !Array.isArray(details.requestBindings)
      ? details.requestBindings
      : undefined;
  const contractHash = optionalString(requestBindings?.contractHash ?? receipt.contractHash);
  const authorityHash = optionalString(requestBindings?.authorityHash ?? receipt.authorityHash);
  const planRevisionId = optionalString(requestBindings?.planRevisionId ?? receipt.planRevisionId);
  const sourceRevision = optionalString(requestBindings?.sourceRevision ?? receipt.sourceRevision);
  const runtimeBuildSha256 = optionalString(
    requestBindings?.runtimeBuildSha256 ?? receipt.runtimeBuildSha256,
  );
  const policyVersion = optionalString(requestBindings?.policyVersion ?? receipt.policyVersion);
  const skillSha256 = optionalString(requestBindings?.skillSha256 ?? receipt.skillSha256);
  if (
    !contractHash ||
    !authorityHash ||
    !planRevisionId ||
    !sourceRevision ||
    !runtimeBuildSha256 ||
    !policyVersion ||
    !skillSha256
  ) {
    return undefined;
  }
  return {
    contractHash,
    authorityHash,
    planRevisionId,
    sourceRevision,
    runtimeBuildSha256,
    policyVersion,
    skillSha256,
  };
}

type DerivedProofFields = {
  passed: boolean;
  proofRefs: string[];
  failureCodes: string[];
};

type ProofAction = Extract<
  TasksGovernanceApplyParams["action"],
  {
    operation: "recordImplementationResult" | "recordValidationResult" | "recordReviewResult";
  }
>;

type ProofProducerAuthorization = {
  callerDeviceId: string;
  proofKind: "implementation" | "validation" | "review";
};

function proofAssignmentRevisionContinuity(params: {
  flow: NonNullable<ReturnType<typeof resolveGovernedMissionFlowForLookupToken>>;
  mission: NonNullable<ReturnType<typeof readGovernedMissionStateFromTaskFlow>>;
  assignment: ProductionExecutorAssignment;
}): { valid: true; leaseCloseReceiptId?: string } | { valid: false } {
  const { assignment, flow, mission } = params;
  if (assignment.governedMissionRevision === mission.revision) {
    return { valid: true };
  }
  const assignmentRevision = assignment.governedMissionRevision;
  const attemptReceiptId = assignment.governedAttemptReceiptId;
  const attemptRunId = assignment.governedAttemptRunId;
  if (
    assignmentRevision === undefined ||
    !attemptReceiptId ||
    !attemptRunId ||
    mission.activeExecutionLease
  ) {
    return { valid: false };
  }
  const attempt = findGovernedMissionReceiptByIdFromSqlite(attemptReceiptId);
  const leaseClose = findGovernedMissionReceiptByIdempotencyFromSqlite({
    missionId: mission.missionId,
    idempotencyKey: `agent-run:${attemptRunId}:close-execution-lease`,
  });
  // Proof work may finish inside the exact lease that authorized it. Accept the
  // one revision advanced by that lease's durable close, but no later transition.
  if (
    attempt?.producer !== GOVERNED_MISSION_RUNTIME_PRODUCER ||
    attempt.receiptSha256 !== computeGovernedMissionReceiptSha256(attempt) ||
    attempt.operation !== "openExecutionLease" ||
    attempt.decision !== "applied" ||
    attempt.reasonCode !== "EXECUTION_LEASE_OPENED" ||
    attempt.missionId !== mission.missionId ||
    attempt.flowId !== flow.flowId ||
    attempt.attemptId !== attemptRunId ||
    attempt.contractHash !== mission.contractHash ||
    attempt.planRevisionId !== mission.planRevisionId ||
    attempt.resultingRevision !== assignmentRevision ||
    leaseClose?.producer !== GOVERNED_MISSION_RUNTIME_PRODUCER ||
    leaseClose.receiptSha256 !== computeGovernedMissionReceiptSha256(leaseClose) ||
    leaseClose.operation !== "closeExecutionLease" ||
    leaseClose.decision !== "applied" ||
    leaseClose.reasonCode !== "EXECUTION_LEASE_CLOSED" ||
    leaseClose.missionId !== mission.missionId ||
    leaseClose.flowId !== flow.flowId ||
    leaseClose.attemptId !== attemptRunId ||
    leaseClose.contractHash !== mission.contractHash ||
    leaseClose.planRevisionId !== mission.planRevisionId ||
    leaseClose.expectedRevision !== assignmentRevision ||
    leaseClose.resultingRevision !== mission.revision ||
    leaseClose.resultingRevision !== assignmentRevision + 1
  ) {
    return { valid: false };
  }
  return { valid: true, leaseCloseReceiptId: leaseClose.receiptId };
}

function authorizeProofProducer(params: {
  flow: NonNullable<ReturnType<typeof resolveGovernedMissionFlowForLookupToken>>;
  action: ProofAction;
  client: GatewayClient | null;
}): { ok: true; authorization: ProofProducerAuthorization } | { ok: false; reasonCode: string } {
  const proofKind = {
    recordImplementationResult: "implementation",
    recordValidationResult: "validation",
    recordReviewResult: "review",
  }[params.action.operation] as ProofProducerAuthorization["proofKind"];
  const designatedDeviceId = readPinnedGovernedMissionContract(params.flow)?.proofProducers?.[
    proofKind
  ].deviceId;
  const callerDeviceId = params.client?.connect.device?.id?.trim();
  if (
    !params.client?.isDeviceTokenAuth ||
    !callerDeviceId ||
    !designatedDeviceId ||
    callerDeviceId !== designatedDeviceId
  ) {
    return { ok: false, reasonCode: "GOVERNED_PROOF_PRODUCER_UNAUTHORIZED" };
  }
  return { ok: true, authorization: { callerDeviceId, proofKind } };
}

function authorizeDeliveryProducer(params: {
  flow: NonNullable<ReturnType<typeof resolveGovernedMissionFlowForLookupToken>>;
  client: GatewayClient | null;
}): { ok: true; callerDeviceId: string } | { ok: false; reasonCode: string } {
  const designatedDeviceId = readPinnedGovernedMissionContract(params.flow)?.proofProducers
    ?.delivery.deviceId;
  const callerDeviceId = params.client?.connect.device?.id?.trim();
  if (
    !params.client?.isDeviceTokenAuth ||
    !callerDeviceId ||
    callerDeviceId !== designatedDeviceId
  ) {
    return { ok: false, reasonCode: "GOVERNED_PROOF_PRODUCER_UNAUTHORIZED" };
  }
  return { ok: true, callerDeviceId };
}

function sourceEvidenceHash(
  action: TasksGovernanceApplyParams["action"],
  deviceId: string,
): string {
  const source =
    "proofTaskId" in action
      ? [action.operation, action.proofTaskId, deviceId]
      : "releaseReceiptId" in action
        ? [action.operation, action.releaseReceiptId, action.payloadHash, deviceId]
        : [action.operation, deviceId];
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function deriveProofFields(params: {
  flow: NonNullable<ReturnType<typeof resolveGovernedMissionFlowForLookupToken>>;
  action: ProofAction;
  authorization: ProofProducerAuthorization;
}): { ok: true; fields: DerivedProofFields } | { ok: false; reasonCode: string } {
  const { callerDeviceId, proofKind } = params.authorization;
  const taskId = params.action.proofTaskId;
  const task = getTaskById(taskId);
  const assignment = getProductionExecutorAssignment(params.flow, taskId);
  const requirements = {
    implementation: { capability: "repo_write", roles: ["Coding Agent", "SADB"] },
    validation: { capability: "repo_read", roles: ["Grant", "SADB"] },
    review: { capability: "grant_review", roles: ["Grant"] },
  } as const;
  const requirement = requirements[proofKind];
  const mission = readGovernedMissionStateFromTaskFlow(params.flow);
  const requiredMissionState = {
    implementation: "executing",
    validation: "implementation_complete",
    review: "validation_complete",
  } as const;
  if (!mission || !assignment) {
    return { ok: false, reasonCode: "GOVERNED_PROOF_TASK_AUTHORITY_INVALID" };
  }
  const revisionContinuity = proofAssignmentRevisionContinuity({
    flow: params.flow,
    mission,
    assignment,
  });
  if (
    (task &&
      (task.parentFlowId !== params.flow.flowId ||
        task.ownerKey !== params.flow.ownerKey ||
        task.runId !== assignment.expectedRunId)) ||
    assignment.producerDeviceId !== callerDeviceId ||
    assignment.proofPurpose !== proofKind ||
    !revisionContinuity.valid ||
    assignment.governedMissionState !== requiredMissionState[proofKind] ||
    mission.currentGovernedState !== requiredMissionState[proofKind] ||
    !isProductionExecutorAssignmentCurrentGovernedAttempt({ flow: params.flow, assignment }) ||
    !assignment.permitted.includes(requirement.capability) ||
    assignment.prohibited.includes(requirement.capability) ||
    !(requirement.roles as readonly string[]).includes(assignment.role)
  ) {
    return { ok: false, reasonCode: "GOVERNED_PROOF_TASK_AUTHORITY_INVALID" };
  }
  const completion = findValidatedGovernedMissionReceiptByIdempotencyFromSqlite({
    flow: params.flow,
    missionId: mission.missionId,
    idempotencyKey: `child-completion:${taskId}`,
  });
  const completionDetails =
    completion?.details &&
    typeof completion.details === "object" &&
    !Array.isArray(completion.details)
      ? completion.details
      : undefined;
  // The completion receipt is the durable proof after normal task retention removes
  // the mutable row; if the row remains, it must still agree with that receipt.
  const completionVerified = Boolean(
    completion &&
    completion.producer === GOVERNED_MISSION_RUNTIME_PRODUCER &&
    completion.receiptSha256 === computeGovernedMissionReceiptSha256(completion) &&
    completion.flowId === params.flow.flowId &&
    completion.runId === assignment.expectedRunId &&
    completion.decision === "applied" &&
    (completion.operation === "completeGovernedChildTask" ||
      completion.operation === "recordNextExecutableLaunch") &&
    completionDetails?.taskId === taskId &&
    completionDetails.runId === assignment.expectedRunId &&
    completionDetails.producerDeviceId === callerDeviceId &&
    completionDetails.governedAttemptReceiptId === assignment.governedAttemptReceiptId &&
    completionDetails.assignmentSha256 === computeProductionExecutorAssignmentSha256(assignment),
  );
  if (!task && !completionVerified) {
    return { ok: false, reasonCode: "GOVERNED_PROOF_TASK_AUTHORITY_INVALID" };
  }
  const taskSucceeded = task ? deriveTaskFlowStatusFromTask(task) === "succeeded" : true;
  const taskDelivered = task ? task.deliveryStatus === "delivered" : true;
  const passed = taskSucceeded && taskDelivered && completionVerified;
  return {
    ok: true,
    fields: {
      passed,
      proofRefs: [
        `task:${taskId}`,
        `run:${assignment.expectedRunId}`,
        `device:${callerDeviceId}`,
        ...(revisionContinuity.leaseCloseReceiptId
          ? [`lease-close-receipt:${revisionContinuity.leaseCloseReceiptId}`]
          : []),
        ...(completionVerified && completion ? [`completion-receipt:${completion.receiptId}`] : []),
        ...assignment.evidenceRefs,
      ],
      failureCodes: passed
        ? []
        : [
            !taskSucceeded
              ? task?.terminalOutcome === "blocked"
                ? "PROOF_TASK_BLOCKED"
                : "PROOF_TASK_NOT_SUCCEEDED"
              : !taskDelivered
                ? "PROOF_TASK_NOT_DELIVERED"
                : "PROOF_TASK_COMPLETION_UNVERIFIED",
          ],
    },
  };
}

function deriveDeliveryProofFields(params: {
  flow: NonNullable<ReturnType<typeof resolveGovernedMissionFlowForLookupToken>>;
  action: Extract<TasksGovernanceApplyParams["action"], { operation: "recordDeliveryResult" }>;
  callerDeviceId: string;
}): { ok: true; fields: DerivedProofFields } | { ok: false; reasonCode: string } {
  const withheld = readGovernedMissionWithheldPayload(params.flow);
  const releasedPayload = readGovernedMissionReleasedPayload(params.flow);
  const releaseReceipt = findGovernedMissionReceiptByIdFromSqlite(params.action.releaseReceiptId);
  if (
    releasedPayload === undefined ||
    !withheld ||
    params.action.payloadHash !== withheld.payloadHash ||
    releaseReceipt?.flowId !== params.flow.flowId ||
    releaseReceipt.operation !== "releaseFinalResult" ||
    releaseReceipt.decision !== "applied" ||
    !releaseReceipt.contractReceiptKinds?.includes("release")
  ) {
    return { ok: false, reasonCode: "GOVERNED_DELIVERY_RELEASE_BINDING_INVALID" };
  }
  return {
    ok: true,
    fields: {
      passed: true,
      proofRefs: [
        `release-receipt:${releaseReceipt.receiptId}`,
        `payload-sha256:${withheld.payloadHash}`,
        `device:${params.callerDeviceId}`,
      ],
      failureCodes: [],
    },
  };
}

function buildApplyOperation(params: {
  flow: NonNullable<ReturnType<typeof resolveGovernedMissionFlowForLookupToken>>;
  mission: NonNullable<ReturnType<typeof readGovernedMissionStateFromTaskFlow>>;
  input: TasksGovernanceApplyParams;
  bindings: GovernedMissionIdentityBindings;
  proofFields?: DerivedProofFields;
  sourceEvidenceHash?: string;
}): GovernedMissionOperation {
  const base = canonicalOperationBase(params);
  const action = params.input.action;
  switch (action.operation) {
    case "startWorkOrder":
      return { ...base, operation: action.operation };
    case "recordImplementationResult":
    case "recordValidationResult":
    case "recordReviewResult":
    case "recordDeliveryResult":
      if (!params.proofFields) {
        throw new Error("governed proof fields must be derived from authenticated evidence");
      }
      return {
        ...base,
        operation: action.operation,
        ...params.proofFields,
        ...(params.sourceEvidenceHash ? { sourceEvidenceHash: params.sourceEvidenceHash } : {}),
      };
    case "requestReadmission":
      throw new Error("readmission must pass through the production admission boundary");
    case "requestCloseout":
      return { ...base, operation: action.operation };
    case "verifyRequiredArtifacts":
      // The verifier replaces this placeholder with bounded filesystem facts.
      return { ...base, operation: action.operation, passed: false };
    case "admitTerminalPendingWatchdog": {
      const openWorkCount = listTasksForFlowId(params.flow.flowId).filter(
        (task) => task.status === "queued" || task.status === "running",
      ).length;
      return {
        ...base,
        operation: action.operation,
        parentScopeClosed: isTaskFlowProductionParentScopeClosed(params.flow, openWorkCount),
        openWorkCount,
      };
    }
    case "recordPostTerminalWatchdog": {
      const findings = listTaskFlowAuditFindings({
        flows: [params.flow],
        now: Date.now(),
        staleQueuedMs: Number.MAX_SAFE_INTEGER,
        staleRunningMs: Number.MAX_SAFE_INTEGER,
        staleWaitingMs: Number.MAX_SAFE_INTEGER,
        staleBlockedMs: Number.MAX_SAFE_INTEGER,
        cancelStuckMs: Number.MAX_SAFE_INTEGER,
      }).filter((finding) => finding.code !== "governed_terminal_proof_missing");
      return {
        ...base,
        operation: action.operation,
        passed: findings.length === 0,
        proofRefs: [
          `task-flow-audit:${params.flow.flowId}:${params.mission.revision}`,
          ...findings.map((finding) => `finding:${finding.code}`),
        ],
        failureCodes: findings.map((finding) => finding.code),
        boundRevision: params.mission.revision,
        boundRuntimeBuildSha256: params.bindings.runtimeBuildSha256,
      };
    }
    case "releaseFinalResult": {
      const withheld = readGovernedMissionWithheldPayload(params.flow);
      return {
        ...base,
        operation: action.operation,
        ...(withheld ? { payloadHash: withheld.payloadHash } : {}),
      };
    }
    case "blockForRepair":
      return {
        ...base,
        operation: action.operation,
        reasonCode: action.reasonCode,
        nextAction: action.nextAction,
      };
    case "cancelMission":
    case "stopMission":
      return {
        ...base,
        operation: action.operation,
        ...(action.reasonCode ? { reasonCode: action.reasonCode } : {}),
      };
  }
  const unreachableAction: never = action;
  return unreachableAction;
}

function applyResultProjection(
  result: Awaited<
    ReturnType<typeof applyGovernedMissionOperation | typeof verifyAndApplyGovernedMissionArtifacts>
  >,
): TasksGovernanceApplyResult {
  const flow = "flow" in result ? result.flow : undefined;
  const decision = "decision" in result ? result.decision : undefined;
  const receipt = "receipt" in result ? result.receipt : undefined;
  const reasonCode =
    "reasonCode" in result ? result.reasonCode : (decision?.reasonCode ?? receipt?.reasonCode);
  return {
    status: result.status,
    ...(flow ? { flowId: flow.flowId, flowRevision: flow.revision } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(receipt ? { receipt: receiptProjection(receipt) } : {}),
    ...(decision ? { decision: transitionDecisionProjection(decision) } : {}),
  };
}

export const governedTasksHandlers: GatewayRequestHandlers = {
  "tasks.governance.apply": async ({ params, respond, context, client }) => {
    if (!validateTasksGovernanceApplyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid governance apply params"),
      );
      return;
    }
    const flow = resolveGovernedMissionFlowForLookupToken(params.lookup);
    if (!flow) {
      respond(true, applyResultProjection({ status: "not_found" }));
      return;
    }
    const mission = readGovernedMissionStateFromTaskFlow(flow);
    if (!mission) {
      respond(
        true,
        applyResultProjection({
          status: isGovernedMissionFlowClaimed(flow) ? "untrusted_governed_state" : "not_governed",
          flow,
        }),
      );
      return;
    }
    if (!isGovernedMissionStateCanonicallyPersisted(flow, mission)) {
      respond(true, applyResultProjection({ status: "untrusted_governed_state", flow }));
      return;
    }
    if (params.action.operation === "requestReadmission") {
      const cfg = context.getRuntimeConfig();
      const agentId = parseAgentSessionKey(flow.ownerKey)?.agentId ?? resolveDefaultAgentId(cfg);
      const result = readmitGovernedProductionFlow(
        {
          lookup: flow.flowId,
          expectedRevision: params.expectedRevision,
          idempotencyKey: params.idempotencyKey,
          authorityPath: params.action.authorityPath,
          artifactRoot: resolveAgentWorkspaceDir(cfg, agentId),
          governedMission: params.action.governedMission,
          observedSkillSha256: readCurrentSkillSha256({ flow, config: cfg }),
        },
        context.governedRuntimeIdentity,
      );
      if (result.status === "invalid_package") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.reasonCode));
        return;
      }
      respond(true, applyResultProjection(result));
      return;
    }
    const proofAction = [
      "recordImplementationResult",
      "recordValidationResult",
      "recordReviewResult",
    ].includes(params.action.operation)
      ? (params.action as Extract<TasksGovernanceApplyParams["action"], { proofTaskId: string }>)
      : undefined;
    const deliveryAction =
      params.action.operation === "recordDeliveryResult" ? params.action : undefined;
    const proofAuthorization = proofAction
      ? authorizeProofProducer({ flow, action: proofAction, client })
      : undefined;
    const deliveryAuthorization = deliveryAction
      ? authorizeDeliveryProducer({ flow, client })
      : undefined;
    const authorization = proofAuthorization ?? deliveryAuthorization;
    if (authorization && !authorization.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, authorization.reasonCode));
      return;
    }
    const callerDeviceId = proofAuthorization?.ok
      ? proofAuthorization.authorization.callerDeviceId
      : deliveryAuthorization?.ok
        ? deliveryAuthorization.callerDeviceId
        : undefined;
    const evidenceHash =
      callerDeviceId && (proofAction || deliveryAction)
        ? sourceEvidenceHash(proofAction ?? deliveryAction!, callerDeviceId)
        : undefined;
    const existingReceipt = findGovernedMissionReceiptByIdempotencyFromSqlite({
      missionId: mission.missionId,
      idempotencyKey: params.idempotencyKey,
    });
    const idempotencyRequest = buildApplyOperation({
      flow,
      mission,
      input: params,
      bindings:
        (existingReceipt ? receiptMissionBindings(existingReceipt) : undefined) ??
        pinnedMissionBindings(mission),
      ...(proofAction || deliveryAction
        ? { proofFields: { passed: false, proofRefs: [], failureCodes: [] } }
        : {}),
      ...(evidenceHash ? { sourceEvidenceHash: evidenceHash } : {}),
    });
    const existing = resolveGovernedMissionOperationIdempotency({
      flowId: flow.flowId,
      request: idempotencyRequest,
    });
    if (existing) {
      const projection = applyResultProjection(existing);
      if (
        params.action.operation === "releaseFinalResult" &&
        existing.status === "already_applied"
      ) {
        const releasedFlow = "flow" in existing ? existing.flow : undefined;
        const releasedPayload = releasedFlow
          ? readGovernedMissionReleasedPayload(releasedFlow)
          : undefined;
        if (releasedPayload === undefined) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "released governed payload is unavailable"),
          );
          return;
        }
        respond(true, { ...projection, releasedPayload });
        return;
      }
      respond(true, projection);
      return;
    }
    const cfg = context.getRuntimeConfig();
    const bindings = observeGovernedMissionIdentity({
      mission,
      trustedRuntimeIdentity: context.governedRuntimeIdentity,
      observedSkillSha256: readCurrentSkillSha256({ flow, config: cfg }),
    });
    if (!bindings) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "governed mission identity could not be remeasured"),
      );
      return;
    }
    const proof =
      proofAction && proofAuthorization?.ok
        ? deriveProofFields({
            flow,
            action: proofAction,
            authorization: proofAuthorization.authorization,
          })
        : deliveryAction && deliveryAuthorization?.ok
          ? deriveDeliveryProofFields({
              flow,
              action: deliveryAction,
              callerDeviceId: deliveryAuthorization.callerDeviceId,
            })
          : undefined;
    if (proof && !proof.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, proof.reasonCode));
      return;
    }
    const request = buildApplyOperation({
      flow,
      mission,
      input: params,
      bindings,
      ...(proof?.ok ? { proofFields: proof.fields } : {}),
      ...(evidenceHash ? { sourceEvidenceHash: evidenceHash } : {}),
    });
    const result =
      request.operation === "verifyRequiredArtifacts"
        ? await verifyAndApplyGovernedMissionArtifacts({
            flowId: flow.flowId,
            request,
            observedAtMs: Date.now(),
          })
        : applyGovernedMissionOperation({ flowId: flow.flowId, request });
    const projection = applyResultProjection(result);
    if (
      request.operation === "releaseFinalResult" &&
      (result.status === "applied" || result.status === "already_applied")
    ) {
      const releasedFlow = "flow" in result ? result.flow : undefined;
      const releasedPayload = releasedFlow
        ? readGovernedMissionReleasedPayload(releasedFlow)
        : undefined;
      if (releasedPayload === undefined) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "released governed payload is unavailable"),
        );
        return;
      }
      respond(true, { ...projection, releasedPayload });
      return;
    }
    respond(true, projection);
  },
  "tasks.governance.status": ({ params, respond }) => {
    if (!validateTasksGovernanceStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid governance status params"),
      );
      return;
    }
    const lookup = optionalString(params.lookup);
    if (!lookup) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "lookup is required"));
      return;
    }
    const flow = resolveGovernedMissionFlowForLookupToken(lookup);
    if (!flow) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `TaskFlow not found: ${lookup}`),
      );
      return;
    }
    const mission = readGovernedMissionStateFromTaskFlow(flow);
    const governed = isGovernedMissionFlowClaimed(flow);
    const canonical = mission ? isGovernedMissionStateCanonicallyPersisted(flow, mission) : false;
    const receiptLimit =
      typeof params.receiptLimit === "number" && Number.isSafeInteger(params.receiptLimit)
        ? Math.max(1, Math.min(params.receiptLimit, 100))
        : 20;
    const result: TasksGovernanceStatusResult = {
      flowId: flow.flowId,
      flowRevision: flow.revision,
      governed,
      malformed: governed && !mission,
      canonical,
      mission: mission && canonical ? missionProjection(mission) : null,
      receipts:
        mission && canonical
          ? listGovernedMissionReceipts({ flowId: flow.flowId, limit: receiptLimit }).map(
              receiptProjection,
            )
          : [],
    };
    respond(true, result);
  },
  "tasks.governance.preview": ({ params, respond, context }) => {
    if (!validateTasksGovernancePreviewParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid governance preview params"),
      );
      return;
    }
    const lookup = optionalString(params.lookup);
    const operation = optionalString(params.operation);
    if (
      !lookup ||
      !operation ||
      !GOVERNED_OPERATION_NAMES.has(operation as GovernedMissionOperation["operation"])
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "valid lookup and operation are required"),
      );
      return;
    }
    const flow = resolveGovernedMissionFlowForLookupToken(lookup);
    if (!flow) {
      respond(true, { preview: previewProjection({ status: "not_found" }) });
      return;
    }
    const mission = readGovernedMissionStateFromTaskFlow(flow);
    if (!mission) {
      const status = isGovernedMissionFlowClaimed(flow)
        ? "untrusted_governed_state"
        : "not_governed";
      respond(true, { preview: previewProjection({ status, flow }) });
      return;
    }
    if (!isGovernedMissionStateCanonicallyPersisted(flow, mission)) {
      respond(true, {
        preview: previewProjection({ status: "untrusted_governed_state", flow }),
      });
      return;
    }
    const bindings = observeGovernedMissionIdentity({
      mission,
      trustedRuntimeIdentity: context.governedRuntimeIdentity,
      observedSkillSha256: readCurrentSkillSha256({
        flow,
        config: context.getRuntimeConfig(),
      }),
    });
    if (!bindings) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "governed mission identity could not be remeasured"),
      );
      return;
    }
    const request = buildOperation({
      flow,
      bindings,
      operation: operation as GovernedMissionOperation["operation"],
      payloadHash: optionalString(params.payloadHash),
      reasonCode: optionalString(params.reasonCode),
      nextAction: optionalString(params.nextAction),
    });
    if (!request) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid governance preview identity"),
      );
      return;
    }
    const preview = previewGovernedMissionOperation({ lookup: flow.flowId, request });
    const result: TasksGovernancePreviewResult = { preview: previewProjection(preview) };
    respond(true, result);
  },
};
