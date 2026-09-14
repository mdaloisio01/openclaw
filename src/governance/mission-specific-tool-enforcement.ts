import type { ChildExecutionInheritanceDecision } from "./child-execution-inheritance.js";
import type { GovernedMissionContract } from "./governed-mission-contract.js";
import type { GovernedMissionState } from "./governed-mission-state.js";
import {
  evaluateGovernedAction,
  type GovernedPolicyDecisionOutput,
} from "./governed-policy-decision.js";
import {
  evaluateGovernedSupervisorRequirement,
  type GovernedSupervisorReceipt,
} from "./governed-supervisor-receipt.js";
import {
  classifyProtectedAction,
  evaluateProtectedAction,
  type ProtectedActionDecision,
  type ProtectedActionSignals,
  type TrustedHostPolicy,
} from "./protected-action-policy.js";

export type MissionSpecificToolEnforcementAuthority = {
  governedMissionAdmitted: boolean;
  contract: GovernedMissionContract;
  missionState: GovernedMissionState;
  expectedCurrentStep: string;
  observedContractHash: string;
  observedAuthorityHash: string;
  requiredEvidencePresent: boolean;
  requiresApproval?: boolean;
  childInheritance?: ChildExecutionInheritanceDecision;
  supervisorReceipt?: GovernedSupervisorReceipt;
  supervisorAvailable?: boolean;
  enforcementHealth: {
    healthy: boolean;
    reason?: string;
  };
};

export type MissionSpecificToolEnforcementInput = {
  actionId: string;
  actor: {
    actorId: string;
    parentActorId?: string;
    sessionKey?: string;
    runId?: string;
  };
  toolName: string;
  target: string;
  signals: ProtectedActionSignals;
  conversationClassification: "ordinary" | "governed" | "ambiguous";
  trustedHostPolicy: TrustedHostPolicy;
  authority?: MissionSpecificToolEnforcementAuthority;
  now: string;
};

export type MissionSpecificToolEnforcementDecision = {
  schema: "openclaw.mission_specific_tool_enforcement_decision.v1";
  actionId: string;
  protected: boolean;
  decision: "ALLOW" | "DENY" | "BLOCKED" | "REQUIRE_APPROVAL";
  reasonCode:
    | "UNPROTECTED_ACTION"
    | "MISSING_GOVERNED_AUTHORITY"
    | "MISSION_IDENTITY_MISMATCH"
    | "CONTRACT_IDENTITY_MISMATCH"
    | "CONTRACT_STATE_HASH_MISMATCH"
    | "CONTRACT_HASH_MISMATCH"
    | "CONTRACT_AUTHORITY_HASH_MISMATCH"
    | "STALE_AUTHORITY_HASH"
    | "CURRENT_STEP_MISMATCH"
    | "TRUSTED_HOST_POLICY_DENIED"
    | "POLICY_DENY"
    | "POLICY_BLOCKED"
    | "POLICY_REQUIRES_APPROVAL"
    | "MISSING_SUPERVISOR_WRAPPER"
    | "MISSING_SUPERVISOR_RECEIPT"
    | "SUPERVISOR_UNAVAILABLE"
    | "SUPERVISOR_TIMEOUT"
    | "MISSING_CHILD_INHERITANCE"
    | "PROTECTED_TOOL_ALLOWED";
  obligations: string[];
  protectedActionDecision?: ProtectedActionDecision;
  policyDecision?: GovernedPolicyDecisionOutput;
  evaluatedAt: string;
};

export function evaluateMissionSpecificToolEnforcement(
  input: MissionSpecificToolEnforcementInput,
): MissionSpecificToolEnforcementDecision {
  const actionClass = classifyProtectedAction(input.signals);
  if (!actionClass) {
    return {
      schema: "openclaw.mission_specific_tool_enforcement_decision.v1",
      actionId: input.actionId,
      protected: false,
      decision: "ALLOW",
      reasonCode: "UNPROTECTED_ACTION",
      obligations: [],
      evaluatedAt: input.now,
    };
  }

  const missingAuthorityDecision = evaluateProtectedAction({
    actionId: input.actionId,
    actionClass,
    signals: input.signals,
    conversationClassification: input.conversationClassification,
    trustedHostPolicy: hostPolicyForMissingAuthority(input.trustedHostPolicy),
    now: input.now,
  });

  const authority = input.authority;
  if (!authority?.governedMissionAdmitted) {
    return fromProtectedDecision(input, missingAuthorityDecision, "MISSING_GOVERNED_AUTHORITY");
  }
  if (authority.missionState.missionId !== authority.contract.missionId) {
    return deny(input, "MISSION_IDENTITY_MISMATCH", ["lawful_readmission_required"]);
  }
  if (authority.missionState.contractId !== authority.contract.contractId) {
    return deny(input, "CONTRACT_IDENTITY_MISMATCH", ["lawful_readmission_required"]);
  }
  if (authority.missionState.contractHash !== authority.contract.contractHash) {
    return deny(input, "CONTRACT_STATE_HASH_MISMATCH", ["lawful_readmission_required"]);
  }
  if (authority.contract.contractHash !== authority.observedContractHash) {
    return deny(input, "CONTRACT_HASH_MISMATCH", ["lawful_readmission_required"]);
  }
  if (authority.contract.authorityHash !== authority.observedAuthorityHash) {
    return deny(input, "CONTRACT_AUTHORITY_HASH_MISMATCH", ["lawful_readmission_required"]);
  }
  if (authority.missionState.authorityHash !== authority.observedAuthorityHash) {
    return deny(input, "STALE_AUTHORITY_HASH", ["lawful_readmission_required"]);
  }
  if (authority.missionState.currentStep !== authority.expectedCurrentStep) {
    return deny(input, "CURRENT_STEP_MISMATCH", ["refresh_governed_mission_step"]);
  }
  const supervisorRequirement = evaluateRequiredSupervisor(actionClass, input.signals, authority);
  if (supervisorRequirement) {
    if (
      supervisorRequirement.reasonCode === "SUPERVISOR_UNAVAILABLE" &&
      input.signals.supervisorWrapperPresent !== true
    ) {
      return blocked(input, "MISSING_SUPERVISOR_WRAPPER", [
        "route_exec_through_supervisor_wrapper",
        "write_violation_receipt",
      ]);
    }
    if (supervisorRequirement.reasonCode === "SUPERVISOR_HEALTHY") {
      // Continue; central policy still decides whether the governed action is allowed.
    } else {
      return blocked(input, supervisorReasonCode(supervisorRequirement.reasonCode), [
        ...supervisorRequirement.obligations,
        "write_violation_receipt",
      ]);
    }
  }
  const childInheritance =
    actionClass === "child_execution_delegation" ? authority.childInheritance : undefined;
  if (actionClass === "child_execution_delegation" && childInheritance?.decision !== "ALLOW") {
    return blocked(input, "MISSING_CHILD_INHERITANCE", [
      "deny_child_delegation",
      "require_child_inheritance_receipt",
      "write_violation_receipt",
    ]);
  }

  const policyDecision = evaluateGovernedAction({
    policyVersion: authority.contract.policyVersion,
    actor: input.actor,
    contract: authority.contract,
    missionState: authority.missionState,
    requestedAction: {
      actionId: input.actionId,
      actionClass: centralActionClassForProtectedAction(actionClass),
      target: input.target,
      requiresApproval: authority.requiresApproval,
    },
    hostAuthority: {
      openclawAllows: input.trustedHostPolicy.openclawAllows,
      osAllows: input.trustedHostPolicy.osAllows,
      hostAllows: input.trustedHostPolicy.hostAllows,
    },
    evidenceState: {
      requiredEvidencePresent: authority.requiredEvidencePresent,
    },
    enforcementHealth: authority.enforcementHealth,
    ...(childInheritance?.decision === "ALLOW"
      ? {
          childContext: {
            delegationAllowed: true,
            childMissionId: childInheritance.receipt.parentMissionId,
          },
        }
      : {}),
    now: input.now,
  });
  if (policyDecision.decision === "DENY") {
    return fromPolicyDecision(input, policyDecision, "POLICY_DENY");
  }
  if (policyDecision.decision === "BLOCKED") {
    return fromPolicyDecision(input, policyDecision, "POLICY_BLOCKED");
  }
  if (policyDecision.decision === "REQUIRE_APPROVAL") {
    return fromPolicyDecision(input, policyDecision, "POLICY_REQUIRES_APPROVAL");
  }

  const protectedActionDecision = evaluateProtectedAction({
    actionId: input.actionId,
    actionClass,
    signals: input.signals,
    conversationClassification: input.conversationClassification,
    governedAuthority: {
      governedMissionAdmitted: authority.governedMissionAdmitted,
      contractValid: authority.contract.contractHash === authority.observedContractHash,
      sourceLockValid: authority.missionState.authorityHash === authority.observedAuthorityHash,
      policyDecision,
    },
    trustedHostPolicy: input.trustedHostPolicy,
    now: input.now,
  });

  return {
    schema: "openclaw.mission_specific_tool_enforcement_decision.v1",
    actionId: input.actionId,
    protected: true,
    decision: "ALLOW",
    reasonCode: "PROTECTED_TOOL_ALLOWED",
    obligations: [
      ...new Set([
        ...policyDecision.obligations,
        ...protectedActionDecision.obligations,
        "write_tool_call_receipt",
      ]),
    ],
    protectedActionDecision,
    policyDecision,
    evaluatedAt: input.now,
  };
}

function centralActionClassForProtectedAction(
  actionClass: ReturnType<typeof classifyProtectedAction>,
): "tool_call" | "exec_call" | "child_delegation" {
  if (actionClass === "protected_exec_script") {
    return "exec_call";
  }
  if (actionClass === "child_execution_delegation") {
    return "child_delegation";
  }
  return "tool_call";
}

function requiresSupervisorWrapper(
  actionClass: ReturnType<typeof classifyProtectedAction>,
  signals: ProtectedActionSignals,
): boolean {
  return actionClass === "protected_exec_script" && signals.supervisorWrapperRequired === true;
}

function evaluateRequiredSupervisor(
  actionClass: ReturnType<typeof classifyProtectedAction>,
  signals: ProtectedActionSignals,
  authority: MissionSpecificToolEnforcementAuthority,
) {
  if (!requiresSupervisorWrapper(actionClass, signals)) {
    return null;
  }
  return evaluateGovernedSupervisorRequirement({
    wrapperRequired: true,
    wrapperPresent: signals.supervisorWrapperPresent === true,
    supervisorAvailable: authority.supervisorAvailable !== false,
    receipt: authority.supervisorReceipt,
  });
}

function supervisorReasonCode(
  reasonCode: ReturnType<typeof evaluateGovernedSupervisorRequirement>["reasonCode"],
):
  | "MISSING_SUPERVISOR_WRAPPER"
  | "MISSING_SUPERVISOR_RECEIPT"
  | "SUPERVISOR_UNAVAILABLE"
  | "SUPERVISOR_TIMEOUT" {
  if (reasonCode === "SUPERVISOR_RECEIPT_MISSING") {
    return "MISSING_SUPERVISOR_RECEIPT";
  }
  if (reasonCode === "SUPERVISOR_TIMEOUT") {
    return "SUPERVISOR_TIMEOUT";
  }
  if (reasonCode === "SUPERVISOR_UNAVAILABLE") {
    return "SUPERVISOR_UNAVAILABLE";
  }
  return "MISSING_SUPERVISOR_WRAPPER";
}

function fromProtectedDecision(
  input: MissionSpecificToolEnforcementInput,
  protectedActionDecision: ProtectedActionDecision,
  reasonCode: "MISSING_GOVERNED_AUTHORITY" | "TRUSTED_HOST_POLICY_DENIED",
): MissionSpecificToolEnforcementDecision {
  return {
    schema: "openclaw.mission_specific_tool_enforcement_decision.v1",
    actionId: input.actionId,
    protected: true,
    decision: "DENY",
    reasonCode,
    obligations: protectedActionDecision.obligations,
    protectedActionDecision,
    evaluatedAt: input.now,
  };
}

function hostPolicyForMissingAuthority(policy: TrustedHostPolicy): TrustedHostPolicy {
  return {
    ...policy,
    trustedHost: true,
    openclawAllows: true,
    osAllows: true,
    hostAllows: true,
  };
}

function fromPolicyDecision(
  input: MissionSpecificToolEnforcementInput,
  policyDecision: GovernedPolicyDecisionOutput,
  reasonCode: "POLICY_DENY" | "POLICY_BLOCKED" | "POLICY_REQUIRES_APPROVAL",
): MissionSpecificToolEnforcementDecision {
  return {
    schema: "openclaw.mission_specific_tool_enforcement_decision.v1",
    actionId: input.actionId,
    protected: true,
    decision:
      policyDecision.decision === "REQUIRE_APPROVAL" ? "REQUIRE_APPROVAL" : policyDecision.decision,
    reasonCode,
    obligations: policyDecision.obligations,
    policyDecision,
    evaluatedAt: input.now,
  };
}

function deny(
  input: MissionSpecificToolEnforcementInput,
  reasonCode:
    | "MISSION_IDENTITY_MISMATCH"
    | "CONTRACT_IDENTITY_MISMATCH"
    | "CONTRACT_STATE_HASH_MISMATCH"
    | "CONTRACT_HASH_MISMATCH"
    | "CONTRACT_AUTHORITY_HASH_MISMATCH"
    | "STALE_AUTHORITY_HASH"
    | "CURRENT_STEP_MISMATCH",
  obligations: string[],
): MissionSpecificToolEnforcementDecision {
  return {
    schema: "openclaw.mission_specific_tool_enforcement_decision.v1",
    actionId: input.actionId,
    protected: true,
    decision: "DENY",
    reasonCode,
    obligations,
    evaluatedAt: input.now,
  };
}

function blocked(
  input: MissionSpecificToolEnforcementInput,
  reasonCode:
    | "MISSING_SUPERVISOR_WRAPPER"
    | "MISSING_SUPERVISOR_RECEIPT"
    | "SUPERVISOR_UNAVAILABLE"
    | "SUPERVISOR_TIMEOUT"
    | "MISSING_CHILD_INHERITANCE",
  obligations: string[],
): MissionSpecificToolEnforcementDecision {
  return {
    schema: "openclaw.mission_specific_tool_enforcement_decision.v1",
    actionId: input.actionId,
    protected: true,
    decision: "BLOCKED",
    reasonCode,
    obligations,
    evaluatedAt: input.now,
  };
}
