import {
  evaluateEnforcementHealth,
  type EnforcementHealthCapabilityRecord,
} from "./enforcement-health.js";
import type {
  AdmissionReceipt,
  GovernedAuthorityRef,
  GovernedMissionContract,
} from "./governed-mission-contract.js";
import {
  isGovernedAuthorityRefPinnedToContract,
  missingGovernedContractFoundationFields,
} from "./governed-mission-contract.js";
import {
  createGovernedMissionState,
  requireGovernedMissionPinnedAuthority,
  updateGovernedMissionState,
  type GovernedMissionOwnerCorrelation,
  type GovernedMissionProofState,
  type GovernedMissionState,
} from "./governed-mission-state.js";
import {
  evaluateGovernedAction,
  type GovernedPolicyDecisionOutput,
} from "./governed-policy-decision.js";

export type GovernedAdmissionMissionClassification =
  | "casual"
  | "governed_required"
  | "ambiguous_governed_required";

export type GovernedMissionAdmissionObservedAuthority = {
  contractHash: string;
  authorityHash: string;
  authorityRef: GovernedAuthorityRef;
  planRevisionId: string;
  sourceRevision: string;
  runtimeBuildSha256: string;
  policyVersion: string;
  skillSha256: string;
};

export type GovernedMissionAdmissionInput = {
  hookName: "before_agent_run";
  classification: GovernedAdmissionMissionClassification;
  actor: {
    actorId: string;
    parentActorId?: string;
    sessionKey?: string;
    runId?: string;
  };
  contract?: Partial<GovernedMissionContract>;
  existingState?: GovernedMissionState;
  observedAuthority?: GovernedMissionAdmissionObservedAuthority;
  ownerCorrelation: GovernedMissionOwnerCorrelation;
  requiredProofs?: Partial<Record<keyof GovernedMissionProofState, boolean>>;
  enforcementCapabilities: readonly EnforcementHealthCapabilityRecord[];
  hostAuthority: {
    openclawAllows: boolean;
    osAllows: boolean;
    hostAllows: boolean;
  };
  now: string;
};

export type GovernedMissionAdmissionDecision = "ADMIT" | "IRRELEVANT" | "DENY";

export type GovernedMissionAdmissionResult = {
  schema: "openclaw.governed_mission_admission.v1";
  hookName: "before_agent_run";
  decision: GovernedMissionAdmissionDecision;
  reasonCode: string;
  missionId?: string;
  contractId?: string;
  contractHash?: string;
  authorityHash?: string;
  missionState?: GovernedMissionState;
  policyDecision?: GovernedPolicyDecisionOutput;
  admissionReceipt?: AdmissionReceipt;
  obligations: string[];
};

const PRODUCER = "openclaw.governed_mission_admission";

export function admitGovernedMission(
  input: GovernedMissionAdmissionInput,
): GovernedMissionAdmissionResult {
  if (input.classification === "casual") {
    return {
      schema: "openclaw.governed_mission_admission.v1",
      hookName: input.hookName,
      decision: "IRRELEVANT",
      reasonCode: "GOVERNED_ADMISSION_NOT_REQUIRED",
      obligations: [],
    };
  }

  if (input.classification === "ambiguous_governed_required") {
    return deny(input, "AMBIGUOUS_GOVERNED_MISSION", ["operator_scope_lock_required"]);
  }

  const contractCheck = requireCompleteContract(input.contract);
  if (!contractCheck.ok) {
    return deny(
      input,
      "MALFORMED_CONTRACT_STATE",
      contractCheck.missingFields.map((field) => `missing:${field}`),
    );
  }
  const contract = contractCheck.contract;

  if (!input.observedAuthority) {
    return deny(input, "MISSING_OBSERVED_AUTHORITY", ["collect_authority_snapshot"]);
  }

  const mismatch = firstAuthorityMismatch(contract, input.observedAuthority);
  if (mismatch) {
    return deny(input, mismatch, ["lawful_readmission_required"]);
  }

  const missionState = bindMissionState(input, contract, input.observedAuthority);
  if (!missionState.ok) {
    return {
      ...base(input, missionState.state),
      decision: "DENY",
      reasonCode: missionState.reason,
      missionState: missionState.state,
      obligations: ["lawful_readmission_required"],
      admissionReceipt: admissionReceipt(input, contract, false, missionState.reason),
    };
  }

  const health = evaluateEnforcementHealth({
    operation: "governed_mutation",
    capabilities: input.enforcementCapabilities,
    now: input.now,
  });
  if (health.decision !== "HEALTHY") {
    return {
      ...base(input, missionState.state),
      decision: "DENY",
      reasonCode: "ENFORCEMENT_HEALTH_BLOCKED",
      missionState: missionState.state,
      obligations: health.reasons.length ? health.reasons : ["repair_enforcement_health"],
      admissionReceipt: admissionReceipt(input, contract, false, "ENFORCEMENT_HEALTH_BLOCKED"),
    };
  }

  const policyDecision = evaluateGovernedAction({
    policyVersion: contract.policyVersion,
    actor: input.actor,
    contract,
    missionState: missionState.state,
    requestedAction: {
      actionId: `${input.hookName}:${contract.missionId}`,
      actionClass: "mission_admission",
      target: contract.missionId,
    },
    hostAuthority: input.hostAuthority,
    evidenceState: { requiredEvidencePresent: true },
    enforcementHealth: { healthy: true },
    now: input.now,
  });
  if (policyDecision.decision !== "ALLOW") {
    return {
      ...base(input, missionState.state),
      decision: "DENY",
      reasonCode: `POLICY_${policyDecision.reasonCode}`,
      missionState: missionState.state,
      policyDecision,
      obligations: policyDecision.obligations,
      admissionReceipt: admissionReceipt(input, contract, false, policyDecision.reasonCode),
    };
  }

  return {
    ...base(input, missionState.state),
    decision: "ADMIT",
    reasonCode: input.existingState ? "BOUND_PINNED_MISSION_STATE" : "CREATED_PINNED_MISSION_STATE",
    missionState: missionState.state,
    policyDecision,
    admissionReceipt: admissionReceipt(input, contract, true, "admitted"),
    obligations: ["write_admission_receipt", "persist_governed_mission_state"],
  };
}

function requireCompleteContract(
  contract: Partial<GovernedMissionContract> | undefined,
): { ok: true; contract: GovernedMissionContract } | { ok: false; missingFields: string[] } {
  if (!contract) {
    return { ok: false, missingFields: ["contract"] };
  }
  const missingFields = missingGovernedContractFoundationFields(contract);
  if (missingFields.length > 0) {
    return { ok: false, missingFields };
  }
  return { ok: true, contract: contract as GovernedMissionContract };
}

function firstAuthorityMismatch(
  contract: GovernedMissionContract,
  observed: GovernedMissionAdmissionObservedAuthority,
): string | undefined {
  if (contract.contractHash !== observed.contractHash) {
    return "CONTRACT_HASH_MISMATCH";
  }
  if (contract.authorityHash !== observed.authorityHash) {
    return "STALE_AUTHORITY_HASH";
  }
  if (!isGovernedAuthorityRefPinnedToContract(contract, observed.authorityRef)) {
    return "AUTHORITY_REFERENCE_MISMATCH";
  }
  if (contract.planRevisionId !== observed.planRevisionId) {
    return "PLAN_REVISION_MISMATCH";
  }
  if (contract.sourceRevision !== observed.sourceRevision) {
    return "SOURCE_REVISION_MISMATCH";
  }
  if (contract.runtimeBuildSha256 !== observed.runtimeBuildSha256) {
    return "RUNTIME_LOCK_MISMATCH";
  }
  if (contract.policyVersion !== observed.policyVersion) {
    return "POLICY_VERSION_MISMATCH";
  }
  if (contract.skillSha256 !== observed.skillSha256) {
    return "SKILL_HASH_MISMATCH";
  }
  return undefined;
}

function bindMissionState(
  input: GovernedMissionAdmissionInput,
  contract: GovernedMissionContract,
  observed: GovernedMissionAdmissionObservedAuthority,
):
  | { ok: true; state: GovernedMissionState }
  | {
      ok: false;
      reason:
        | "mission_identity_mismatch"
        | "contract_identity_mismatch"
        | "contract_version_mismatch"
        | "contract_hash_mismatch"
        | "stale_authority_hash";
      state: GovernedMissionState;
    } {
  if (input.existingState) {
    const identityMismatch = firstExistingStateIdentityMismatch(input.existingState, contract);
    if (identityMismatch) {
      return {
        ok: false,
        reason: identityMismatch,
        state: updateGovernedMissionState(input.existingState, {
          expectedRevision: input.existingState.revision,
          currentGovernedState: "readmission_required",
          blockedStatus: "readmission_required",
          currentStep: "lawful_readmission_required",
          now: input.now,
        }),
      };
    }
    return requireGovernedMissionPinnedAuthority(input.existingState, observed, input.now);
  }
  return {
    ok: true,
    state: createGovernedMissionState({
      contract,
      authorityRef: observed.authorityRef,
      currentStep: "before_agent_run_admission",
      ownerCorrelation: input.ownerCorrelation,
      requiredProofs: input.requiredProofs,
      // Only the trusted admission boundary can establish these host facts. Persist
      // them with canonical mission state so later agent runs never reconstruct them.
      trustedHostPolicy: {
        trustedHost: true,
        ...input.hostAuthority,
        reason: "verified by governed mission admission",
      },
      now: input.now,
    }),
  };
}

function firstExistingStateIdentityMismatch(
  state: GovernedMissionState,
  contract: GovernedMissionContract,
):
  | "mission_identity_mismatch"
  | "contract_identity_mismatch"
  | "contract_version_mismatch"
  | undefined {
  if (state.missionId !== contract.missionId) {
    return "mission_identity_mismatch";
  }
  if (state.contractId !== contract.contractId) {
    return "contract_identity_mismatch";
  }
  if (state.contractVersion !== contract.contractVersion) {
    return "contract_version_mismatch";
  }
  return undefined;
}

function base(
  input: GovernedMissionAdmissionInput,
  state?: GovernedMissionState,
): Pick<
  GovernedMissionAdmissionResult,
  "schema" | "hookName" | "missionId" | "contractId" | "contractHash" | "authorityHash"
> {
  const contract = input.contract;
  return {
    schema: "openclaw.governed_mission_admission.v1",
    hookName: input.hookName,
    missionId: state?.missionId ?? contract?.missionId,
    contractId: state?.contractId ?? contract?.contractId,
    contractHash: state?.contractHash ?? contract?.contractHash,
    authorityHash: state?.authorityHash ?? contract?.authorityHash,
  };
}

function deny(
  input: GovernedMissionAdmissionInput,
  reasonCode: string,
  obligations: string[],
): GovernedMissionAdmissionResult {
  return {
    ...base(input),
    decision: "DENY",
    reasonCode,
    obligations,
  };
}

function admissionReceipt(
  input: GovernedMissionAdmissionInput,
  contract: GovernedMissionContract,
  admitted: boolean,
  reason: string,
): AdmissionReceipt {
  return {
    schema: "openclaw.governed_admission_receipt.v1",
    missionId: contract.missionId,
    contractId: contract.contractId,
    contractVersion: contract.contractVersion,
    contractHash: contract.contractHash,
    authorityHash: contract.authorityHash,
    receiptId: `admission:${contract.missionId}:${input.now}`,
    receiptKind: "admission",
    producedAt: input.now,
    producer: PRODUCER,
    admitted,
    reason,
  };
}
