import { describe, expect, it } from "vitest";
import { evaluatePolicyDecision, GIE_PHASE1_BLOCKED_TASKFLOW_IDS } from "./policy-engine.js";

describe("GIE hard-rule policy engine", () => {
  it("allows known governed dispatch with an explicit owner", () => {
    const decision = evaluatePolicyDecision({
      action: "governed_dispatch",
      ownerLane: "sadb",
      ownerTarget: "sadb-head",
      proofRefs: ["phase-1-proof", "phase-2-proof"],
    });

    expect(decision.decision).toBe("allow");
    expect(decision.allowed).toBe(true);
    expect(decision.triggeredRule).toBe("governed_dispatch_allowed");
    expect(decision.proofRefsUsed).toEqual(["phase-1-proof", "phase-2-proof"]);
  });

  it("denies unknown actions by default and records the decision", () => {
    const decision = evaluatePolicyDecision({
      action: "freeform_untrusted_action",
      proofRefs: ["intake-proof"],
    });

    expect(decision.decision).toBe("deny");
    expect(decision.allowed).toBe(false);
    expect(decision.triggeredRule).toBe("deny_by_default");
    expect(decision.auditRequired).toBe(true);
  });

  it("requires approval for operator override gates", () => {
    const decision = evaluatePolicyDecision({
      action: "operator_override",
      proofRefs: ["owner-request"],
    });

    expect(decision.decision).toBe("approval_required");
    expect(decision.allowed).toBe(false);
    expect(decision.approvalRequired).toBe(true);
    expect(decision.triggeredRule).toBe("human_approval_required");
  });

  it("requires approval for feedback correction approvals", () => {
    const decision = evaluatePolicyDecision({
      action: "feedback_correction_approval",
      ownerLane: "governance",
      ownerTarget: "governance-head",
      proofRefs: ["feedback-proof"],
      approvalRef: "approval-proof",
    });

    expect(decision.decision).toBe("approval_required");
    expect(decision.allowed).toBe(false);
    expect(decision.triggeredRule).toBe("human_approval_required");
    expect(decision.approvalRequired).toBe(true);
  });

  it("hard-stops old blocked GIE TaskFlow revival attempts", () => {
    const decision = evaluatePolicyDecision({
      action: "taskflow_revival",
      taskFlowId: GIE_PHASE1_BLOCKED_TASKFLOW_IDS[0],
      proofRefs: ["historical-blocker"],
    });

    expect(decision.decision).toBe("hard_stop");
    expect(decision.allowed).toBe(false);
    expect(decision.triggeredRule).toBe("old_gie_taskflow_revival_hard_stop");
    expect(decision.hardStopReason).toBe("blocked_taskflow_revival_attempt");
  });

  it("hard-stops policy-bypass attempts before normal allow rules", () => {
    const decision = evaluatePolicyDecision({
      action: "governed_dispatch",
      ownerLane: "sadb",
      ownerTarget: "sadb-head",
      proofRefs: ["phase-proof"],
      bypassAttempt: true,
    });

    expect(decision.decision).toBe("hard_stop");
    expect(decision.triggeredRule).toBe("policy_bypass_hard_stop");
    expect(decision.hardStopReason).toBe("policy_bypass_attempt");
  });

  it("hard-stops closeout claims for Security, Verification, or whole-GIE approval", () => {
    const decision = evaluatePolicyDecision({
      action: "closeout_claim",
      closeoutScope: "whole_gie",
      proofRefs: ["slice-proof"],
    });

    expect(decision.decision).toBe("hard_stop");
    expect(decision.allowed).toBe(false);
    expect(decision.triggeredRule).toBe("closeout_claim_hard_stop");
    expect(decision.hardStopReason).toBe("unauthorized_closeout_claim");
  });
});
