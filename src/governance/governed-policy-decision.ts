import type { GovernedMissionContract } from "./governed-mission-contract.js";
import type { GovernedMissionState } from "./governed-mission-state.js";
import {
  evaluateGovernedOperatorOverride,
  type GovernedOperatorOverrideRecord,
} from "./governed-operator-override.js";

export const GOVERNED_POLICY_DECISIONS = ["ALLOW", "DENY", "REQUIRE_APPROVAL", "BLOCKED"] as const;

export type GovernedPolicyDecision = (typeof GOVERNED_POLICY_DECISIONS)[number];

export const GOVERNED_ACTION_CLASSES = [
  "mission_admission",
  "tool_call",
  "exec_call",
  "child_delegation",
  "closeout",
  "release",
  "watchdog",
  "override",
  "final_output",
] as const;

export type GovernedActionClass = (typeof GOVERNED_ACTION_CLASSES)[number];

export type GovernedPolicyActor = {
  actorId: string;
  parentActorId?: string;
  sessionKey?: string;
  runId?: string;
};

export type GovernedPolicyRequestedAction = {
  actionId: string;
  actionClass: GovernedActionClass;
  target: string;
  requiresApproval?: boolean;
};

export type GovernedPolicyEvidenceState = {
  requiredEvidencePresent: boolean;
  closeoutPassed?: boolean;
  releaseAllowed?: boolean;
};

export type GovernedPolicyEnforcementHealth = {
  healthy: boolean;
  reason?: string;
};

export type GovernedPolicyChildContext = {
  delegationAllowed: boolean;
  childMissionId?: string;
};

export type GovernedPolicyDecisionContext = {
  policyVersion: string;
  actor: GovernedPolicyActor;
  contract: GovernedMissionContract;
  missionState: GovernedMissionState;
  requestedAction: GovernedPolicyRequestedAction;
  hostAuthority: {
    openclawAllows: boolean;
    osAllows: boolean;
    hostAllows: boolean;
  };
  operatorOverride?: GovernedOperatorOverrideRecord;
  evidenceState: GovernedPolicyEvidenceState;
  enforcementHealth: GovernedPolicyEnforcementHealth;
  childContext?: GovernedPolicyChildContext;
  now: string;
};

export type GovernedPolicyDecisionOutput = {
  schema: "openclaw.governed_policy_decision.v1";
  decision: GovernedPolicyDecision;
  reasonCode: string;
  policyVersion: string;
  contractId: string;
  contractHash: string;
  obligations: string[];
  requiredApproval?: "operator";
  receiptMetadata: {
    missionId: string;
    actionId: string;
    actorId: string;
    producedAt: string;
  };
};

const OVERRIDE_CLASS_BY_ACTION: Partial<
  Record<GovernedActionClass, GovernedOperatorOverrideRecord["allowableClasses"][number]>
> = {
  tool_call: "tool_action_exception",
  exec_call: "exec_action_exception",
  child_delegation: "child_delegation_exception",
  closeout: "closeout_repair_exception",
  mission_admission: "mission_policy_exception",
};

export function evaluateGovernedAction(
  context: GovernedPolicyDecisionContext,
): GovernedPolicyDecisionOutput {
  const base = {
    schema: "openclaw.governed_policy_decision.v1" as const,
    policyVersion: context.policyVersion,
    contractId: context.contract.contractId,
    contractHash: context.contract.contractHash,
    receiptMetadata: {
      missionId: context.contract.missionId,
      actionId: context.requestedAction.actionId,
      actorId: context.actor.actorId,
      producedAt: context.now,
    },
  };

  if (!context.enforcementHealth.healthy) {
    return decision(base, "BLOCKED", "ENFORCEMENT_HEALTH_UNHEALTHY", [
      context.enforcementHealth.reason ?? "repair_enforcement_health",
    ]);
  }
  if (context.missionState.currentGovernedState === "GOVERNED_MISSION_BLOCKED") {
    return decision(base, "BLOCKED", context.missionState.blockedStatus, [
      "resolve_governed_mission_block",
    ]);
  }
  if (
    context.missionState.currentGovernedState === "GOVERNED_MISSION_TERMINAL" &&
    context.missionState.terminalStatus !== "succeeded"
  ) {
    return decision(base, "BLOCKED", "TERMINAL_MISSION_NOT_EXECUTABLE", [
      "do_not_continue_terminal_failed_mission",
    ]);
  }
  if (!hostAuthorityAllows(context.hostAuthority)) {
    return decision(base, "DENY", "HOST_AUTHORITY_DENIED", ["do_not_execute"]);
  }
  if (
    context.requestedAction.actionClass === "child_delegation" &&
    context.childContext?.delegationAllowed !== true
  ) {
    return decision(base, "DENY", "CHILD_DELEGATION_DENIED", ["do_not_spawn_child"]);
  }
  if (!context.evidenceState.requiredEvidencePresent) {
    return decision(base, "BLOCKED", "REQUIRED_EVIDENCE_MISSING", ["collect_required_evidence"]);
  }
  if (context.requestedAction.actionClass === "release" && !context.evidenceState.releaseAllowed) {
    return decision(base, "BLOCKED", "RELEASE_NOT_ALLOWED", ["wait_for_release_gate"]);
  }
  if (
    context.requestedAction.actionClass === "final_output" &&
    (!context.evidenceState.closeoutPassed || !context.evidenceState.releaseAllowed)
  ) {
    return decision(base, "BLOCKED", "FINAL_OUTPUT_RELEASE_NOT_READY", [
      "require_closeout_and_release",
    ]);
  }
  if (context.requestedAction.requiresApproval) {
    const overrideClass = OVERRIDE_CLASS_BY_ACTION[context.requestedAction.actionClass];
    if (overrideClass) {
      const overrideDecision = evaluateGovernedOperatorOverride(context.operatorOverride, {
        missionId: context.contract.missionId,
        actionId: context.requestedAction.actionId,
        scopeHash: context.missionState.authorityHash,
        requestedClass: overrideClass,
        hostAuthority: context.hostAuthority,
        now: context.now,
      });
      if (overrideDecision.valid) {
        return decision(base, "ALLOW", "VALID_OPERATOR_OVERRIDE", [
          `override_receipt:${overrideDecision.receiptRef}`,
        ]);
      }
    }
    return {
      ...decision(base, "REQUIRE_APPROVAL", "OPERATOR_APPROVAL_REQUIRED", [
        "obtain_operator_approval",
      ]),
      requiredApproval: "operator",
    };
  }
  return decision(base, "ALLOW", "POLICY_ALLOW", ["write_policy_decision_receipt"]);
}

function decision(
  base: Omit<GovernedPolicyDecisionOutput, "decision" | "reasonCode" | "obligations">,
  nextDecision: GovernedPolicyDecision,
  reasonCode: string,
  obligations: string[],
): GovernedPolicyDecisionOutput {
  return {
    ...base,
    decision: nextDecision,
    reasonCode,
    obligations,
  };
}

function hostAuthorityAllows(authority: GovernedPolicyDecisionContext["hostAuthority"]): boolean {
  return authority.openclawAllows && authority.osAllows && authority.hostAllows;
}
