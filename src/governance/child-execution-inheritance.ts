import type {
  GovernedActionClass,
  GovernedPolicyDecisionOutput,
} from "./governed-policy-decision.js";

export const CHILD_AUTHORITY_RANKS = ["none", "read_only", "governed", "protected"] as const;

export type ChildAuthorityRank = (typeof CHILD_AUTHORITY_RANKS)[number];

export type ChildExecutionPolicy = {
  authorityRank: ChildAuthorityRank;
  allowedActionClasses: GovernedActionClass[];
};

export type ChildExecutionInheritanceInput = {
  actionId: string;
  parent: {
    missionId: string;
    contractId: string;
    contractHash: string;
    authorityHash: string;
    sessionKey?: string;
    runId?: string;
    taskFlowId?: string;
    taskId?: string;
    policy: ChildExecutionPolicy;
  };
  child: {
    runtime:
      | "subagent"
      | "acp"
      | "task_flow"
      | "background_task"
      | "worker_process"
      | "codex_native"
      | "other";
    sessionKey?: string;
    runId?: string;
    taskFlowId?: string;
    taskId?: string;
    policy: ChildExecutionPolicy;
  };
  policyDecision?: GovernedPolicyDecisionOutput;
  now: string;
};

export type ChildExecutionInheritanceDecision = {
  schema: "openclaw.child_execution_inheritance_decision.v1";
  actionId: string;
  decision: "ALLOW" | "DENY";
  reasonCode:
    | "CHILD_AUTHORITY_INHERITED"
    | "MISSION_IDENTITY_MISSING"
    | "CHILD_AUTHORITY_EXCEEDS_PARENT"
    | "CHILD_ACTION_CLASS_EXCEEDS_PARENT"
    | "CENTRAL_POLICY_DENIED";
  obligations: string[];
  receipt: ChildExecutionInheritanceReceipt;
  evaluatedAt: string;
};

export type ChildExecutionInheritanceReceipt = {
  schema: "openclaw.child_execution_inheritance_receipt.v1";
  actionId: string;
  parentMissionId: string;
  parentContractId: string;
  parentContractHash: string;
  parentAuthorityHash: string;
  parentSessionKey?: string;
  parentRunId?: string;
  parentTaskFlowId?: string;
  parentTaskId?: string;
  childRuntime: ChildExecutionInheritanceInput["child"]["runtime"];
  childSessionKey?: string;
  childRunId?: string;
  childTaskFlowId?: string;
  childTaskId?: string;
  effectiveChildPolicy: ChildExecutionPolicy;
  producedAt: string;
};

const AUTHORITY_RANK_VALUE: Record<ChildAuthorityRank, number> = {
  none: 0,
  read_only: 1,
  governed: 2,
  protected: 3,
};

export function evaluateChildExecutionInheritance(
  input: ChildExecutionInheritanceInput,
): ChildExecutionInheritanceDecision {
  const receipt = buildReceipt(input);
  if (!input.parent.missionId || !input.parent.contractHash || !input.parent.authorityHash) {
    return deny(input, receipt, "MISSION_IDENTITY_MISSING", [
      "deny_child_delegation",
      "readmit_parent_governed_mission",
    ]);
  }
  if (
    AUTHORITY_RANK_VALUE[input.child.policy.authorityRank] >
    AUTHORITY_RANK_VALUE[input.parent.policy.authorityRank]
  ) {
    return deny(input, receipt, "CHILD_AUTHORITY_EXCEEDS_PARENT", [
      "deny_child_delegation",
      "narrow_child_authority",
    ]);
  }
  const parentActions = new Set(input.parent.policy.allowedActionClasses);
  const widenedActions = input.child.policy.allowedActionClasses.filter(
    (actionClass) => !parentActions.has(actionClass),
  );
  if (widenedActions.length > 0) {
    return deny(input, receipt, "CHILD_ACTION_CLASS_EXCEEDS_PARENT", [
      "deny_child_delegation",
      `remove_child_action_classes:${widenedActions.join(",")}`,
    ]);
  }
  if (input.policyDecision && input.policyDecision.decision !== "ALLOW") {
    return deny(input, receipt, "CENTRAL_POLICY_DENIED", [
      "deny_child_delegation",
      ...input.policyDecision.obligations,
    ]);
  }
  return {
    schema: "openclaw.child_execution_inheritance_decision.v1",
    actionId: input.actionId,
    decision: "ALLOW",
    reasonCode: "CHILD_AUTHORITY_INHERITED",
    obligations: ["write_child_inheritance_receipt"],
    receipt,
    evaluatedAt: input.now,
  };
}

function buildReceipt(input: ChildExecutionInheritanceInput): ChildExecutionInheritanceReceipt {
  return {
    schema: "openclaw.child_execution_inheritance_receipt.v1",
    actionId: input.actionId,
    parentMissionId: input.parent.missionId,
    parentContractId: input.parent.contractId,
    parentContractHash: input.parent.contractHash,
    parentAuthorityHash: input.parent.authorityHash,
    ...(input.parent.sessionKey ? { parentSessionKey: input.parent.sessionKey } : {}),
    ...(input.parent.runId ? { parentRunId: input.parent.runId } : {}),
    ...(input.parent.taskFlowId ? { parentTaskFlowId: input.parent.taskFlowId } : {}),
    ...(input.parent.taskId ? { parentTaskId: input.parent.taskId } : {}),
    childRuntime: input.child.runtime,
    ...(input.child.sessionKey ? { childSessionKey: input.child.sessionKey } : {}),
    ...(input.child.runId ? { childRunId: input.child.runId } : {}),
    ...(input.child.taskFlowId ? { childTaskFlowId: input.child.taskFlowId } : {}),
    ...(input.child.taskId ? { childTaskId: input.child.taskId } : {}),
    effectiveChildPolicy: {
      authorityRank: input.child.policy.authorityRank,
      allowedActionClasses: [...input.child.policy.allowedActionClasses],
    },
    producedAt: input.now,
  };
}

function deny(
  input: ChildExecutionInheritanceInput,
  receipt: ChildExecutionInheritanceReceipt,
  reasonCode: Exclude<ChildExecutionInheritanceDecision["reasonCode"], "CHILD_AUTHORITY_INHERITED">,
  obligations: string[],
): ChildExecutionInheritanceDecision {
  return {
    schema: "openclaw.child_execution_inheritance_decision.v1",
    actionId: input.actionId,
    decision: "DENY",
    reasonCode,
    obligations,
    receipt,
    evaluatedAt: input.now,
  };
}
