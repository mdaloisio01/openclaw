import {
  normalizeGovernedArtifactDeclarations,
  type GovernedArtifactDeclaration,
} from "./governed-artifact-verifier.js";
import {
  governedMissionPlanCanSatisfyContract,
  isGovernedAuthorityRefPinnedToContract,
  missingGovernedContractFoundationFields,
  type GovernedAuthorityRef,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import { resolveGovernedAuthorityPath } from "./governed-mission-identity.js";
import type { GovernedMissionReceiptKind } from "./governed-mission-ledger.types.js";
import {
  updateGovernedMissionState,
  type GovernedMissionReplacementIdentity,
  type GovernedMissionProofState,
  type GovernedMissionState,
  type GovernedMissionStateValue,
} from "./governed-mission-state.js";
import type { CompiledMissionPlan } from "./mission-plan-compiler.js";

export const GOVERNED_MISSION_PUBLIC_OPERATIONS = [
  "startWorkOrder",
  "recordImplementationResult",
  "recordValidationResult",
  "recordReviewResult",
  "requestCloseout",
  "verifyRequiredArtifacts",
  "admitTerminalPendingWatchdog",
  "recordPostTerminalWatchdog",
  "releaseFinalResult",
  "recordDeliveryResult",
  "blockForRepair",
  "requestReadmission",
  "cancelMission",
  "stopMission",
] as const;

export const GOVERNED_MISSION_OPERATIONS = [
  ...GOVERNED_MISSION_PUBLIC_OPERATIONS,
  "openExecutionLease",
  "closeExecutionLease",
] as const;

export type GovernedMissionPublicOperationName =
  (typeof GOVERNED_MISSION_PUBLIC_OPERATIONS)[number];
export type GovernedMissionOperationName = (typeof GOVERNED_MISSION_OPERATIONS)[number];

export type GovernedMissionIdentityBindings = {
  contractHash: string;
  authorityHash: string;
  planRevisionId: string;
  sourceRevision: string;
  runtimeBuildSha256: string;
  policyVersion: string;
  skillSha256: string;
};

type GovernedMissionOperationBase = {
  expectedRevision: number;
  idempotencyKey: string;
  owner: string;
  controllerId?: string;
  bindings: GovernedMissionIdentityBindings;
  occurredAt: string;
  /** Stable authenticated request identity used before mutable proof evidence is reloaded. */
  sourceEvidenceHash?: string;
};

type ProofResultOperation = GovernedMissionOperationBase & {
  passed: boolean;
  proofRefs?: readonly string[];
  failureCodes?: readonly string[];
};

type ArtifactProofName = "rollback" | "restoration";

type GovernedMissionProofOperation = Extract<GovernedMissionOperation, { passed: boolean }>;

export type GovernedMissionOperation =
  | (GovernedMissionOperationBase & { operation: "startWorkOrder" })
  | (GovernedMissionOperationBase & {
      operation: "openExecutionLease";
      runId: string;
      processId: number;
      processStartTime?: number;
      runtimeInstanceId: string;
    })
  | (GovernedMissionOperationBase & { operation: "closeExecutionLease"; runId: string })
  | (ProofResultOperation & { operation: "recordImplementationResult" })
  | (ProofResultOperation & { operation: "recordValidationResult" })
  | (ProofResultOperation & { operation: "recordReviewResult" })
  | (GovernedMissionOperationBase & { operation: "requestCloseout" })
  | (ProofResultOperation & {
      operation: "verifyRequiredArtifacts";
      satisfiedProofs?: readonly ArtifactProofName[];
    })
  | (GovernedMissionOperationBase & {
      operation: "admitTerminalPendingWatchdog";
      parentScopeClosed: boolean;
      openWorkCount: number;
    })
  | (ProofResultOperation & {
      operation: "recordPostTerminalWatchdog";
      boundRevision: number;
      boundRuntimeBuildSha256: string;
    })
  | (GovernedMissionOperationBase & {
      operation: "releaseFinalResult";
      payloadHash?: string;
    })
  | (ProofResultOperation & { operation: "recordDeliveryResult" })
  | (GovernedMissionOperationBase & {
      operation: "blockForRepair";
      reasonCode: string;
      nextAction: string;
    })
  | (GovernedMissionOperationBase & {
      operation: "requestReadmission";
      productionRequestSha256?: string;
      replacementIdentity: GovernedMissionReplacementIdentity;
      replacementContract: GovernedMissionContract;
      replacementCompiledPlan: CompiledMissionPlan;
      replacementArtifactDeclarations: readonly GovernedArtifactDeclaration[];
      replacementDeliveryRequired: boolean;
    })
  | (GovernedMissionOperationBase & { operation: "cancelMission"; reasonCode?: string })
  | (GovernedMissionOperationBase & { operation: "stopMission"; reasonCode?: string });

export type GovernedMissionTransitionStatus =
  | "applied"
  | "denied"
  | "conflict"
  | "irrelevant"
  | "repair_required";

export type GovernedMissionTransitionDecision = {
  schema: "openclaw.governed_mission_transition_decision.v1";
  status: GovernedMissionTransitionStatus;
  operation: GovernedMissionOperationName;
  reasonCode: string;
  receiptKind: GovernedMissionReceiptKind;
  previousState: GovernedMissionState;
  nextState: GovernedMissionState;
  stateChanged: boolean;
  nextAction: string;
  missingProof: string[];
};

export type GovernedMissionTransitionContext = {
  cancellationPending?: boolean;
  activeChildWorkPresent?: boolean;
  releaseAuthorization?: {
    allowed: boolean;
    reasonCode: string;
  };
};

const TERMINAL_STATES = new Set<GovernedMissionStateValue>([
  "released",
  "cancelled",
  "failed",
  "lost",
  "operator_stopped",
]);

export function evaluateGovernedMissionOperation(
  state: GovernedMissionState,
  request: GovernedMissionOperation,
  context: GovernedMissionTransitionContext = {},
): GovernedMissionTransitionDecision {
  const conflict = validateTransitionRequest(state, request);
  if (conflict) {
    if (conflict.status === "readmission_required") {
      if (TERMINAL_STATES.has(state.currentGovernedState)) {
        return unchanged(state, request, "denied", conflict.reasonCode, conflict.nextAction);
      }
      if (
        request.operation === "closeExecutionLease" &&
        state.activeExecutionLease?.runId === request.runId
      ) {
        // Identity drift must stop execution without stranding the durable lease.
        // Close the exact lease and atomically force lawful readmission.
        return applyState(state, request, "readmission_required", {
          decisionStatus: "denied",
          reasonCode: conflict.reasonCode,
          nextAction: conflict.nextAction,
          blockedStatus: blockedStatusForIdentityMismatch(conflict.reasonCode),
          clearActiveExecutionLease: true,
        });
      }
      return applyState(state, request, "readmission_required", {
        decisionStatus: "denied",
        reasonCode: conflict.reasonCode,
        nextAction: conflict.nextAction,
        blockedStatus: blockedStatusForIdentityMismatch(conflict.reasonCode),
      });
    }
    return unchanged(state, request, conflict.status, conflict.reasonCode, conflict.nextAction);
  }

  if (
    context.cancellationPending === true &&
    request.operation !== "closeExecutionLease" &&
    request.operation !== "cancelMission" &&
    request.operation !== "stopMission"
  ) {
    return unchanged(
      state,
      request,
      "denied",
      "CANCELLATION_PENDING",
      "Complete or resolve the pending cancellation before another governed transition.",
    );
  }

  if (
    TERMINAL_STATES.has(state.currentGovernedState) &&
    !(state.currentGovernedState === "released" && request.operation === "recordDeliveryResult")
  ) {
    return unchanged(
      state,
      request,
      "irrelevant",
      "MISSION_ALREADY_TERMINAL",
      "Inspect the terminal receipt; do not retry this operation.",
    );
  }

  if (
    context.activeChildWorkPresent === true &&
    (request.operation === "cancelMission" || request.operation === "stopMission")
  ) {
    return unchanged(
      state,
      request,
      "conflict",
      "ACTIVE_WORK_CONFLICT",
      "Settle queued and running child tasks before terminating the governed mission.",
    );
  }

  switch (request.operation) {
    case "startWorkOrder":
      return advance(state, request, ["admitted", "waiting", "repair_required"], "executing", {
        reasonCode: "WORK_ORDER_STARTED",
        nextAction: "Execute the admitted work order.",
        blockedStatus: "not_blocked",
        proofs: resetProofsForNewAttempt(state.proofs),
        clearPostTerminalWatchdogBinding: true,
      });
    case "openExecutionLease": {
      if (
        !request.runId.trim() ||
        !Number.isSafeInteger(request.processId) ||
        request.processId <= 0 ||
        (request.processStartTime !== undefined &&
          (!Number.isSafeInteger(request.processStartTime) || request.processStartTime < 0)) ||
        !request.runtimeInstanceId.trim()
      ) {
        return unchanged(
          state,
          request,
          "denied",
          "EXECUTION_LEASE_OWNER_INVALID",
          "Open the execution lease with a valid run and runtime process identity.",
        );
      }
      if (state.activeExecutionLease) {
        return unchanged(
          state,
          request,
          "conflict",
          "ACTIVE_EXECUTION_LEASE_EXISTS",
          "Wait for the active governed execution lease to close.",
          ["execution_quiescence"],
        );
      }
      if (!request.runId.trim()) {
        return unchanged(
          state,
          request,
          "denied",
          "EXECUTION_LEASE_RUN_ID_MISSING",
          "Provide the active embedded run id.",
        );
      }
      return advance(state, request, ["executing"], "executing", {
        reasonCode: "EXECUTION_LEASE_OPENED",
        nextAction: "Execute only the admitted governed work order.",
        activeExecutionLease: {
          runId: request.runId,
          processId: request.processId,
          ...(request.processStartTime !== undefined
            ? { processStartTime: request.processStartTime }
            : {}),
          runtimeInstanceId: request.runtimeInstanceId,
          openedAt: request.occurredAt,
        },
      });
    }
    case "closeExecutionLease": {
      if (!state.activeExecutionLease || state.activeExecutionLease.runId !== request.runId) {
        return unchanged(
          state,
          request,
          "conflict",
          "EXECUTION_LEASE_MISMATCH",
          "Close the exact active governed execution lease.",
          ["execution_quiescence"],
        );
      }
      return advance(state, request, ["executing"], "executing", {
        reasonCode: "EXECUTION_LEASE_CLOSED",
        nextAction: "Record implementation proof from the completed execution.",
        clearActiveExecutionLease: true,
      });
    }
    case "recordImplementationResult":
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      return recordProofResult(state, request, {
        allowedFrom: ["executing"],
        proof: "implementation",
        nextState: "implementation_complete",
        passedReason: "IMPLEMENTATION_RECORDED",
        failedReason: "IMPLEMENTATION_PROOF_MISSING",
        failedAction: "Repair the implementation and submit fresh implementation proof.",
      });
    case "recordValidationResult":
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      return recordProofResult(state, request, {
        allowedFrom: ["implementation_complete"],
        proof: "validation",
        nextState: "validation_complete",
        passedReason: "VALIDATION_RECORDED",
        failedReason: "VALIDATION_PROOF_MISSING",
        failedAction: "Run the required validation and submit its fresh result.",
      });
    case "recordReviewResult":
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      return recordProofResult(state, request, {
        allowedFrom: ["validation_complete"],
        proof: "review",
        nextState: "review_complete",
        passedReason: "REVIEW_RECORDED",
        failedReason: "REVIEW_PROOF_MISSING",
        failedAction: "Resolve the review findings and submit a fresh passing review.",
      });
    case "requestCloseout": {
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      const missingProof = requiredProofs(state.proofs, ["implementation", "validation", "review"]);
      if (missingProof.length > 0) {
        return unchanged(
          state,
          request,
          "repair_required",
          "CLOSEOUT_PROOF_MISSING",
          `Provide the missing ${missingProof[0]} proof, then preview closeout again.`,
          missingProof,
        );
      }
      return advance(state, request, ["review_complete"], "closeout_ready", {
        reasonCode: "CLOSEOUT_READY",
        nextAction: "Verify every required artifact from disk.",
      });
    }
    case "verifyRequiredArtifacts":
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      return recordProofResult(state, request, {
        allowedFrom: ["closeout_ready"],
        proof: "artifacts",
        nextState: "artifact_verified",
        passedReason: "REQUIRED_ARTIFACTS_VERIFIED",
        failedReason: request.failureCodes?.[0] ?? "REQUIRED_ARTIFACT_INVALID",
        failedAction: "Repair the first invalid required artifact and verify it again.",
        additionalPassedProofs: request.satisfiedProofs,
      });
    case "admitTerminalPendingWatchdog": {
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      const missingProof = requiredProofs(state.proofs, ["artifacts", "rollback", "restoration"]);
      if (!request.parentScopeClosed) {
        missingProof.push("parent_scope");
      }
      if (!Number.isSafeInteger(request.openWorkCount) || request.openWorkCount !== 0) {
        missingProof.push("open_work");
      }
      if (missingProof.length > 0) {
        return unchanged(
          state,
          request,
          "repair_required",
          "TERMINAL_PENDING_PROOF_MISSING",
          `Resolve ${missingProof[0]} before requesting terminal-pending watchdog admission.`,
          missingProof,
        );
      }
      return advance(state, request, ["artifact_verified"], "terminal_pending_watchdog", {
        reasonCode: "TERMINAL_PENDING_WATCHDOG_ADMITTED",
        nextAction: "Run the bound post-terminal watchdog observation.",
      });
    }
    case "recordPostTerminalWatchdog": {
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      if (
        request.boundRevision !== state.revision ||
        request.boundRuntimeBuildSha256 !== state.runtimeBuildSha256
      ) {
        return unchanged(
          state,
          request,
          "repair_required",
          "POST_TERMINAL_WATCHDOG_BINDING_MISMATCH",
          "Run a fresh watchdog observation bound to the current revision and runtime build.",
          ["postTerminalWatchdog"],
        );
      }
      if (!request.passed) {
        return unchanged(
          state,
          request,
          "repair_required",
          "POST_TERMINAL_WATCHDOG_NOT_CLEAN",
          "Resolve the first watchdog finding and run a fresh observation.",
          ["postTerminalWatchdog"],
        );
      }
      return advance(state, request, ["terminal_pending_watchdog"], "terminal_pending_watchdog", {
        reasonCode: "POST_TERMINAL_WATCHDOG_RECORDED",
        nextAction: "Request final release.",
        proofs: { ...state.proofs, postTerminalWatchdog: "passed" },
        postTerminalWatchdogBinding: {
          boundRevision: request.boundRevision,
          runtimeBuildSha256: request.boundRuntimeBuildSha256,
        },
      });
    }
    case "releaseFinalResult": {
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      const missingProof = requiredProofs(state.proofs, ["postTerminalWatchdog"]);
      const watchdogBinding = state.postTerminalWatchdogBinding;
      if (
        !watchdogBinding ||
        watchdogBinding.boundRevision !== state.revision - 1 ||
        watchdogBinding.runtimeBuildSha256 !== state.runtimeBuildSha256
      ) {
        missingProof.push("postTerminalWatchdogBinding");
      }
      if (context.releaseAuthorization?.allowed !== true) {
        missingProof.push("release_decision");
      }
      if (missingProof.length > 0) {
        return unchanged(
          state,
          request,
          "repair_required",
          context.releaseAuthorization?.reasonCode ?? "FINAL_RELEASE_PROOF_MISSING",
          `Provide a current ${missingProof[0]} proof before releasing the final result.`,
          missingProof,
        );
      }
      return advance(state, request, ["terminal_pending_watchdog"], "released", {
        reasonCode: "FINAL_RESULT_RELEASED",
        nextAction:
          state.proofs.delivery === "pending" ? "Record visible delivery proof." : "None.",
        terminalStatus: "succeeded",
      });
    }
    case "recordDeliveryResult":
      return recordProofResult(state, request, {
        allowedFrom: ["released"],
        proof: "delivery",
        nextState: "released",
        passedReason: "VISIBLE_DELIVERY_RECORDED",
        failedReason: "VISIBLE_DELIVERY_PROOF_MISSING",
        failedAction: "Retry delivery and record transport-visible delivery proof.",
      });
    case "blockForRepair":
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      if (state.currentGovernedState === "readmission_required") {
        return unchanged(
          state,
          request,
          "denied",
          "READMISSION_REQUIRED",
          "Submit a complete lawful readmission package before resuming or changing repair state.",
        );
      }
      return applyState(state, request, "repair_required", {
        reasonCode: request.reasonCode,
        nextAction: request.nextAction,
        blockedStatus: "required_proof_missing",
      });
    case "requestReadmission": {
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      if (!isValidReplacementIdentity(request.replacementIdentity)) {
        return unchanged(
          state,
          request,
          "denied",
          "READMISSION_IDENTITY_MISSING",
          "Provide the complete replacement contract, authority, plan, source, build, policy, and skill identity.",
        );
      }
      if (
        !isValidReplacementContract(
          state.missionId,
          request.replacementIdentity,
          request.replacementContract,
        )
      ) {
        return unchanged(
          state,
          request,
          "denied",
          "READMISSION_CONTRACT_MISMATCH",
          "Provide a complete replacement contract pinned to the replacement identity.",
        );
      }
      if (
        !isValidReplacementPlan(
          state,
          request.replacementIdentity,
          request.replacementContract,
          request.replacementCompiledPlan,
        )
      ) {
        return unchanged(
          state,
          request,
          "denied",
          "READMISSION_PLAN_MISMATCH",
          "Provide a replacement compiled plan pinned to the replacement mission identity.",
        );
      }
      if (
        !isValidReplacementArtifacts(
          state,
          request.replacementIdentity,
          request.replacementCompiledPlan,
          request.replacementArtifactDeclarations,
        )
      ) {
        return unchanged(
          state,
          request,
          "denied",
          "READMISSION_ARTIFACT_DECLARATIONS_MISMATCH",
          "Provide bounded artifact declarations pinned to the replacement plan and mission identity.",
        );
      }
      if (TERMINAL_STATES.has(state.currentGovernedState)) {
        return unchanged(
          state,
          request,
          "denied",
          "ILLEGAL_LIFECYCLE_EDGE",
          "A terminal governed mission cannot be readmitted.",
        );
      }
      // The production boundary has remeasured every replacement identity and
      // package component. Permit that complete package to recover a nonterminal
      // mission even when the old authority can no longer be observed.
      return applyState(state, request, "admitted", {
        reasonCode: "MISSION_READMITTED",
        nextAction: "Start or resume the admitted work order.",
        blockedStatus: "not_blocked",
        replacementIdentity: request.replacementIdentity,
        proofs: resetProofsForReplacementPlan(
          request.replacementCompiledPlan,
          request.replacementDeliveryRequired,
        ),
        clearPostTerminalWatchdogBinding: true,
      });
    }
    case "cancelMission":
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      return applyState(state, request, "cancelled", {
        reasonCode: request.reasonCode ?? "MISSION_CANCELLED",
        nextAction: "None.",
        terminalStatus: "cancelled",
      });
    case "stopMission":
      if (state.activeExecutionLease) {
        return activeExecutionLeaseDenial(state, request);
      }
      return applyState(state, request, "operator_stopped", {
        reasonCode: request.reasonCode ?? "MISSION_STOPPED_BY_OPERATOR",
        nextAction: "None.",
        terminalStatus: "cancelled",
      });
  }
  const unreachableRequest: never = request;
  return unreachableRequest;
}

function isValidReplacementContract(
  missionId: string,
  identity: GovernedMissionReplacementIdentity,
  contract: GovernedMissionContract | undefined,
): boolean {
  return (
    contract !== undefined &&
    missingGovernedContractFoundationFields(contract).length === 0 &&
    contract.missionId === missionId &&
    contract.contractId === identity.contractId &&
    contract.contractVersion === identity.contractVersion &&
    contract.contractHash === identity.contractHash &&
    contract.authorityHash === identity.authorityHash &&
    contract.planRevisionId === identity.planRevisionId &&
    contract.sourceRevision === identity.sourceRevision &&
    contract.runtimeBuildSha256 === identity.runtimeBuildSha256 &&
    contract.policyVersion === identity.policyVersion &&
    contract.skillSha256 === identity.skillSha256 &&
    isGovernedAuthorityRefPinnedToContract(contract, identity.authorityRef)
  );
}

function validateTransitionRequest(
  state: GovernedMissionState,
  request: GovernedMissionOperation,
): {
  status: "conflict" | "denied" | "readmission_required";
  reasonCode: string;
  nextAction: string;
} | null {
  if (request.expectedRevision !== state.revision) {
    return {
      status: "conflict",
      reasonCode: "REVISION_CONFLICT",
      nextAction: "Reload the mission and retry with its current revision.",
    };
  }
  if (request.owner !== state.ownerCorrelation.owner) {
    return {
      status: "denied",
      reasonCode: "OWNER_MISMATCH",
      nextAction: "Use the mission owner recorded at admission.",
    };
  }
  if (!request.idempotencyKey.trim()) {
    return {
      status: "denied",
      reasonCode: "IDEMPOTENCY_KEY_MISSING",
      nextAction: "Retry with a stable non-empty idempotency key.",
    };
  }
  const mismatchedBinding = firstBindingMismatch(state, request.bindings);
  if (mismatchedBinding) {
    return {
      status: "readmission_required",
      reasonCode: mismatchedBinding,
      nextAction: "Request lawful readmission with current authority and build bindings.",
    };
  }
  return null;
}

function firstBindingMismatch(
  state: GovernedMissionState,
  bindings: GovernedMissionIdentityBindings,
): string | null {
  const checks: Array<[string, string, string]> = [
    [state.contractHash, bindings.contractHash, "CONTRACT_HASH_MISMATCH"],
    [state.authorityHash, bindings.authorityHash, "AUTHORITY_HASH_MISMATCH"],
    [state.planRevisionId, bindings.planRevisionId, "PLAN_REVISION_MISMATCH"],
    [state.sourceRevision, bindings.sourceRevision, "SOURCE_REVISION_MISMATCH"],
    [state.runtimeBuildSha256, bindings.runtimeBuildSha256, "RUNTIME_BUILD_MISMATCH"],
    [state.policyVersion, bindings.policyVersion, "POLICY_VERSION_MISMATCH"],
    [state.skillSha256, bindings.skillSha256, "SKILL_HASH_MISMATCH"],
  ];
  return checks.find(([expected, actual]) => expected !== actual)?.[2] ?? null;
}

function recordProofResult(
  state: GovernedMissionState,
  request: GovernedMissionProofOperation,
  rule: {
    allowedFrom: GovernedMissionStateValue[];
    proof: keyof GovernedMissionProofState;
    nextState: GovernedMissionStateValue;
    passedReason: string;
    failedReason: string;
    failedAction: string;
    additionalPassedProofs?: readonly ArtifactProofName[];
  },
): GovernedMissionTransitionDecision {
  if (!request.passed) {
    return unchanged(state, request, "repair_required", rule.failedReason, rule.failedAction, [
      rule.proof,
    ]);
  }
  return advance(state, request, rule.allowedFrom, rule.nextState, {
    reasonCode: rule.passedReason,
    nextAction: nextActionFor(rule.nextState),
    proofs: {
      ...state.proofs,
      [rule.proof]: "passed",
      ...Object.fromEntries(
        (rule.additionalPassedProofs ?? []).map((proof) => [proof, "passed"] as const),
      ),
    },
  });
}

function advance(
  state: GovernedMissionState,
  request: GovernedMissionOperation,
  allowedFrom: GovernedMissionStateValue[],
  nextState: GovernedMissionStateValue,
  options: Parameters<typeof applyState>[3],
): GovernedMissionTransitionDecision {
  if (!allowedFrom.includes(state.currentGovernedState)) {
    return unchanged(
      state,
      request,
      "denied",
      "ILLEGAL_LIFECYCLE_EDGE",
      `Complete the required operation for ${state.currentGovernedState} before ${request.operation}.`,
    );
  }
  return applyState(state, request, nextState, options);
}

function applyState(
  state: GovernedMissionState,
  request: GovernedMissionOperation,
  nextState: GovernedMissionStateValue,
  options: {
    reasonCode: string;
    nextAction: string;
    proofs?: GovernedMissionProofState;
    activeExecutionLease?: GovernedMissionState["activeExecutionLease"];
    clearActiveExecutionLease?: boolean;
    postTerminalWatchdogBinding?: GovernedMissionState["postTerminalWatchdogBinding"];
    clearPostTerminalWatchdogBinding?: boolean;
    blockedStatus?: GovernedMissionState["blockedStatus"];
    terminalStatus?: GovernedMissionState["terminalStatus"];
    replacementIdentity?: GovernedMissionReplacementIdentity;
    decisionStatus?: "applied" | "denied";
  },
): GovernedMissionTransitionDecision {
  const next = updateGovernedMissionState(state, {
    expectedRevision: state.revision,
    currentGovernedState: nextState,
    currentStep: request.operation,
    ...(options.proofs ? { proofs: options.proofs } : {}),
    ...(options.activeExecutionLease ? { activeExecutionLease: options.activeExecutionLease } : {}),
    ...(options.clearActiveExecutionLease ? { clearActiveExecutionLease: true } : {}),
    ...(options.postTerminalWatchdogBinding
      ? { postTerminalWatchdogBinding: options.postTerminalWatchdogBinding }
      : {}),
    ...(options.clearPostTerminalWatchdogBinding ? { clearPostTerminalWatchdogBinding: true } : {}),
    ...(options.blockedStatus ? { blockedStatus: options.blockedStatus } : {}),
    ...(options.terminalStatus ? { terminalStatus: options.terminalStatus } : {}),
    ...(options.replacementIdentity ? { replacementIdentity: options.replacementIdentity } : {}),
    now: request.occurredAt,
  });
  return {
    schema: "openclaw.governed_mission_transition_decision.v1",
    status: options.decisionStatus ?? "applied",
    operation: request.operation,
    reasonCode: options.reasonCode,
    receiptKind: receiptKindFor(request.operation),
    previousState: state,
    nextState: next,
    stateChanged: true,
    nextAction: options.nextAction,
    missingProof: [],
  };
}

function activeExecutionLeaseDenial(
  state: GovernedMissionState,
  request: GovernedMissionOperation,
): GovernedMissionTransitionDecision {
  return unchanged(
    state,
    request,
    "repair_required",
    "ACTIVE_EXECUTION_LEASE_OPEN",
    "Wait for the governed embedded run and every in-flight tool execution to finish.",
    ["execution_quiescence"],
  );
}

function blockedStatusForIdentityMismatch(
  reasonCode: string,
): GovernedMissionState["blockedStatus"] {
  const statuses: Record<string, GovernedMissionState["blockedStatus"]> = {
    CONTRACT_HASH_MISMATCH: "contract_hash_mismatch",
    AUTHORITY_HASH_MISMATCH: "stale_authority_hash",
    PLAN_REVISION_MISMATCH: "plan_revision_mismatch",
    SOURCE_REVISION_MISMATCH: "source_revision_mismatch",
    RUNTIME_BUILD_MISMATCH: "runtime_build_mismatch",
    POLICY_VERSION_MISMATCH: "policy_version_mismatch",
    SKILL_HASH_MISMATCH: "readmission_required",
  };
  return statuses[reasonCode] ?? "readmission_required";
}

function isValidReplacementIdentity(
  identity: GovernedMissionReplacementIdentity | undefined,
): identity is GovernedMissionReplacementIdentity {
  if (
    !identity ||
    !isValidAuthorityRef(identity.authorityRef) ||
    identity.authorityRef.sha256 !== identity.authorityHash
  ) {
    return false;
  }
  try {
    resolveGovernedAuthorityPath(identity.authorityRef.uri);
  } catch {
    return false;
  }
  return [
    identity.contractId,
    identity.contractVersion,
    identity.contractHash,
    identity.authorityHash,
    identity.planRevisionId,
    identity.sourceRevision,
    identity.runtimeBuildSha256,
    identity.policyVersion,
    identity.skillSha256,
  ].every((value) => Boolean(value.trim()));
}

function isValidAuthorityRef(authorityRef: GovernedAuthorityRef): boolean {
  return Boolean(
    authorityRef.refId.trim() &&
    authorityRef.uri.trim() &&
    [
      "sop",
      "build_plan",
      "work_order",
      "operator_approval",
      "policy",
      "source_lock",
      "runtime_lock",
    ].includes(authorityRef.kind),
  );
}

function isValidReplacementPlan(
  state: GovernedMissionState,
  identity: GovernedMissionReplacementIdentity,
  contract: GovernedMissionContract,
  plan: CompiledMissionPlan | undefined,
): plan is CompiledMissionPlan {
  return Boolean(
    plan &&
    plan.manifest.schema === "openclaw.mission_manifest.v1" &&
    plan.manifest.missionId === state.missionId &&
    plan.manifest.planRevisionId === identity.planRevisionId &&
    plan.manifest.sourceRevision === identity.sourceRevision &&
    plan.manifest.runtimeBuildSha256 === identity.runtimeBuildSha256 &&
    plan.manifest.policyVersion === identity.policyVersion &&
    plan.manifest.skillSha256 === identity.skillSha256 &&
    plan.manifest.planRevisionAuthorized &&
    plan.manifest.scopeHash === plan.manifest.authorizedScopeHash &&
    plan.requirements.schema === "openclaw.requirement_manifest.v1" &&
    plan.requirements.missionId === state.missionId &&
    plan.requirements.planRevisionId === identity.planRevisionId &&
    governedMissionPlanCanSatisfyContract(contract, plan),
  );
}

function isValidReplacementArtifacts(
  state: GovernedMissionState,
  identity: GovernedMissionReplacementIdentity,
  plan: CompiledMissionPlan,
  value: readonly GovernedArtifactDeclaration[] | undefined,
): boolean {
  const declarations = normalizeGovernedArtifactDeclarations(value);
  if (!declarations) {
    return false;
  }
  const expectedBindings: Record<string, string> = {
    missionId: state.missionId,
    contractHash: identity.contractHash,
    authorityHash: identity.authorityHash,
    planRevisionId: identity.planRevisionId,
    sourceRevision: identity.sourceRevision,
    runtimeBuildSha256: identity.runtimeBuildSha256,
    policyVersion: identity.policyVersion,
    skillSha256: identity.skillSha256,
  };
  const gates = new Map(plan.gates.map((gate) => [gate.id, gate] as const));
  const declarationsMatch = declarations.every(
    (declaration) =>
      declaration.missionId === state.missionId &&
      gates.has(declaration.gateId) &&
      declaration.required === gates.get(declaration.gateId)?.required &&
      Boolean(declaration.identityBindings) &&
      Object.entries(expectedBindings).every(
        ([key, expected]) => declaration.identityBindings?.[key] === expected,
      ),
  );
  if (!declarationsMatch) {
    return false;
  }
  const declaredRequiredGateIds = new Set(
    declarations.filter((declaration) => declaration.required).map((item) => item.gateId),
  );
  return plan.gates.every((gate) => !gate.required || declaredRequiredGateIds.has(gate.id));
}

function resetProofsForNewAttempt(proofs: GovernedMissionProofState): GovernedMissionProofState {
  const reset = (status: GovernedMissionProofState[keyof GovernedMissionProofState]) =>
    status === "not_required" ? "not_required" : "pending";
  return {
    implementation: reset(proofs.implementation),
    validation: reset(proofs.validation),
    review: reset(proofs.review),
    artifacts: reset(proofs.artifacts),
    rollback: reset(proofs.rollback),
    restoration: reset(proofs.restoration),
    postTerminalWatchdog: reset(proofs.postTerminalWatchdog),
    delivery: reset(proofs.delivery),
  };
}

function resetProofsForReplacementPlan(
  plan: CompiledMissionPlan,
  deliveryRequired: boolean,
): GovernedMissionProofState {
  const requiredGateKinds = new Set(
    plan.gates.filter((gate) => gate.required).map((gate) => gate.kind),
  );
  return {
    implementation: "pending",
    validation: "pending",
    review: "pending",
    artifacts: "pending",
    rollback: requiredGateKinds.has("rollback") ? "pending" : "not_required",
    restoration: requiredGateKinds.has("restoration") ? "pending" : "not_required",
    postTerminalWatchdog: "pending",
    delivery: deliveryRequired ? "pending" : "not_required",
  };
}

function unchanged(
  state: GovernedMissionState,
  request: GovernedMissionOperation,
  status: Exclude<GovernedMissionTransitionStatus, "applied">,
  reasonCode: string,
  nextAction: string,
  missingProof: string[] = [],
): GovernedMissionTransitionDecision {
  return {
    schema: "openclaw.governed_mission_transition_decision.v1",
    status,
    operation: request.operation,
    reasonCode,
    receiptKind: receiptKindFor(request.operation),
    previousState: state,
    nextState: state,
    stateChanged: false,
    nextAction,
    missingProof: [...missingProof].toSorted(),
  };
}

function requiredProofs(
  proofs: GovernedMissionProofState,
  names: Array<keyof GovernedMissionProofState>,
): string[] {
  return names
    .filter((name) => proofs[name] !== "passed" && proofs[name] !== "not_required")
    .toSorted();
}

function receiptKindFor(operation: GovernedMissionOperationName): GovernedMissionReceiptKind {
  if (operation === "verifyRequiredArtifacts") {
    return "artifact_verification";
  }
  if (operation === "recordPostTerminalWatchdog") {
    return "watchdog_observation";
  }
  if (operation === "releaseFinalResult") {
    return "release";
  }
  if (operation === "recordDeliveryResult") {
    return "delivery";
  }
  return "transition";
}

function nextActionFor(state: GovernedMissionStateValue): string {
  const actions: Partial<Record<GovernedMissionStateValue, string>> = {
    implementation_complete: "Run the required validation.",
    validation_complete: "Run the required independent review.",
    review_complete: "Request closeout evaluation.",
    artifact_verified: "Request terminal-pending watchdog admission.",
    terminal_pending_watchdog: "Run the bound post-terminal watchdog observation.",
    released: "Record visible delivery proof if delivery is required.",
  };
  return actions[state] ?? "Continue with the next admitted work-order operation.";
}
