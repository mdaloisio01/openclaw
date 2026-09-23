export const GIE_PHASE1_BLOCKED_TASKFLOW_IDS = [
  "old_gie_taskflow",
  "old-blocked-gie-taskflow",
  "gie_legacy_taskflow",
] as const;

export const GIE_POLICY_DECISIONS = ["allow", "deny", "approval_required", "hard_stop"] as const;
export type GiePolicyDecisionKind = (typeof GIE_POLICY_DECISIONS)[number];

export type GiePolicyAction =
  | "governed_dispatch"
  | "dispatch_preflight"
  | "operator_override"
  | "policy_bypass"
  | "feedback_ingest"
  | "feedback_correction_approval"
  | "domain_policy_boundary"
  | "taskflow_revival"
  | "closeout_claim"
  | "unknown";

export type GiePolicyInput = {
  action?: GiePolicyAction | string;
  ownerLane?: string | null;
  ownerTarget?: string | null;
  proofRefs?: string[] | null;
  taskFlowId?: string | null;
  closeoutScope?: string | null;
  approvalRef?: string | null;
  requestedBy?: string | null;
  bypassAttempt?: boolean | null;
  authorityChange?: boolean | null;
  privilegedAccess?: boolean | null;
  structuralChange?: boolean | null;
  metadata?: Record<string, unknown> | null;
};

export type GiePolicyDecision = {
  decision: GiePolicyDecisionKind;
  allowed: boolean;
  reason: string;
  triggeredRule: string;
  auditRequired: boolean;
  hardStopReason?: string;
  approvalRequired?: boolean;
  proofRefsUsed: string[];
};

function normalizeString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeProofRefs(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function normalizeAction(value: GiePolicyInput["action"]): string {
  return normalizeString(value).toLowerCase();
}

function makeDecision(params: {
  decision: GiePolicyDecisionKind;
  reason: string;
  triggeredRule: string;
  proofRefsUsed?: string[];
  hardStopReason?: string;
  approvalRequired?: boolean;
}): GiePolicyDecision {
  return {
    decision: params.decision,
    allowed: params.decision === "allow",
    reason: params.reason,
    triggeredRule: params.triggeredRule,
    auditRequired: true,
    ...(params.hardStopReason ? { hardStopReason: params.hardStopReason } : {}),
    ...(params.approvalRequired ? { approvalRequired: true } : {}),
    proofRefsUsed: params.proofRefsUsed ?? [],
  };
}

function isBlockedTaskFlowRevival(input: GiePolicyInput): boolean {
  const taskFlowId = normalizeString(input.taskFlowId).toLowerCase();
  if (!taskFlowId) {
    return false;
  }
  return GIE_PHASE1_BLOCKED_TASKFLOW_IDS.some((blockedId) => taskFlowId.includes(blockedId));
}

function isWholeGieCloseoutClaim(input: GiePolicyInput): boolean {
  const closeoutScope = normalizeString(input.closeoutScope).toLowerCase();
  if (!closeoutScope) {
    return false;
  }
  return (
    closeoutScope === "whole_gie" ||
    closeoutScope === "full_gie" ||
    closeoutScope === "security" ||
    closeoutScope === "verification" ||
    closeoutScope.includes("whole-gie") ||
    closeoutScope.includes("full-gie")
  );
}

export function evaluatePolicyDecision(input: GiePolicyInput): GiePolicyDecision {
  const action = normalizeAction(input.action);
  const proofRefsUsed = normalizeProofRefs(input.proofRefs);
  const ownerLane = normalizeString(input.ownerLane);
  const ownerTarget = normalizeString(input.ownerTarget);

  if (input.bypassAttempt === true || action === "policy_bypass") {
    return makeDecision({
      decision: "hard_stop",
      reason: "Policy bypass attempts must fail closed before ordinary allow rules.",
      triggeredRule: "policy_bypass_hard_stop",
      hardStopReason: "policy_bypass_attempt",
      proofRefsUsed,
    });
  }

  if (action === "taskflow_revival" && isBlockedTaskFlowRevival(input)) {
    return makeDecision({
      decision: "hard_stop",
      reason: "Old blocked GIE TaskFlow revival is forbidden.",
      triggeredRule: "old_gie_taskflow_revival_hard_stop",
      hardStopReason: "blocked_taskflow_revival_attempt",
      proofRefsUsed,
    });
  }

  if (action === "closeout_claim" && isWholeGieCloseoutClaim(input)) {
    return makeDecision({
      decision: "hard_stop",
      reason:
        "Security, Verification, or whole-GIE closeout cannot be claimed by the policy engine.",
      triggeredRule: "closeout_claim_hard_stop",
      hardStopReason: "unauthorized_closeout_claim",
      proofRefsUsed,
    });
  }

  if (
    action === "operator_override" ||
    action === "feedback_correction_approval" ||
    input.authorityChange === true ||
    input.privilegedAccess === true ||
    input.structuralChange === true
  ) {
    return makeDecision({
      decision: "approval_required",
      reason:
        "Operator override, authority change, privileged access, or structural change requires approval.",
      triggeredRule: "human_approval_required",
      approvalRequired: true,
      proofRefsUsed,
    });
  }

  if (
    action === "governed_dispatch" ||
    action === "dispatch_preflight" ||
    action === "domain_policy_boundary"
  ) {
    if (!ownerLane || !ownerTarget) {
      return makeDecision({
        decision: "hard_stop",
        reason: "Governed dispatch requires an explicit verified owner lane and owner target.",
        triggeredRule: "verified_owner_required",
        hardStopReason: "missing_owner_target",
        proofRefsUsed,
      });
    }
    if (proofRefsUsed.length === 0) {
      return makeDecision({
        decision: "hard_stop",
        reason: "Governed dispatch requires proof references.",
        triggeredRule: "proof_refs_required",
        hardStopReason: "missing_proof_refs",
        proofRefsUsed,
      });
    }
    return makeDecision({
      decision: "allow",
      reason: "Known governed dispatch with explicit owner and proof references is allowed.",
      triggeredRule: "governed_dispatch_allowed",
      proofRefsUsed,
    });
  }

  return makeDecision({
    decision: "deny",
    reason: "Unknown or unsupported GIE action is denied by default.",
    triggeredRule: "deny_by_default",
    proofRefsUsed,
  });
}

export function assertGiePolicyAllowed(input: GiePolicyInput): GiePolicyDecision {
  const decision = evaluatePolicyDecision(input);
  if (!decision.allowed) {
    throw new Error(`${decision.decision}: ${decision.reason}`);
  }
  return decision;
}
