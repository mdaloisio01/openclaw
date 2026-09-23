import { describe, expect, it } from "vitest";
import { routeGieDecision, type GieRouteScoringInput } from "./decision-router.js";
import type { GieMemoryBeforeActionDecision } from "./memory-bucket-runtime.js";

const BASE_SCORING: GieRouteScoringInput = {
  risk: 0.2,
  ambiguity: 0.2,
  reversibility: 0.9,
  complianceSafetyImpact: 0.1,
  novelty: 0.2,
  repeatability: 0.9,
  confidence: 0.9,
  costOfFailure: 0.1,
  priorOutcomes: 0.9,
};

const MEMORY_CHECKED: GieMemoryBeforeActionDecision = {
  allowed: true,
  reason: "memory_checked",
  reusePatternRefs: ["approved-closeout-pattern"],
  blockedPatternRefs: [],
  staleMemoryOverriddenByLiveProof: false,
  proofRefsUsed: ["memory-proof"],
};

function route(overrides: Partial<Parameters<typeof routeGieDecision>[0]> = {}) {
  return routeGieDecision({
    taskSummary: "classify bounded work",
    ownerLane: "sadb",
    ownerTarget: "sadb-head",
    proofRefs: ["phase-1-proof", "phase-2-proof"],
    scoring: BASE_SCORING,
    now: 1_720_000_000_000,
    memoryBeforeAction: MEMORY_CHECKED,
    ...overrides,
  });
}

describe("GIE decision router", () => {
  it("routes low-risk repeatable work to ai_direct", () => {
    const decision = route();

    expect(decision.routeType).toBe("ai_direct");
    expect(decision.escalationRequirement).toBe("none");
    expect(decision.triggeredPolicyRule).toBe("governed_dispatch_allowed");
    expect(decision.proofRefsUsed).toEqual(["phase-1-proof", "phase-2-proof", "memory-proof"]);
  });

  it("routes moderate/high risk work to ai_with_human_review", () => {
    const decision = route({
      scoring: {
        ...BASE_SCORING,
        risk: 0.9,
        ambiguity: 0.7,
        complianceSafetyImpact: 0.5,
      },
    });

    expect(decision.routeType).toBe("ai_with_human_review");
    expect(decision.escalationRequirement).toBe("human_review");
  });

  it("routes verified specialist work to helper_or_specialist_lane", () => {
    const decision = route({
      specialistLane: "security",
      scoring: {
        ...BASE_SCORING,
        risk: 0.35,
        ambiguity: 0.35,
        confidence: 0.65,
        repeatability: 0.45,
      },
    });

    expect(decision.routeType).toBe("helper_or_specialist_lane");
    expect(decision.escalationRequirement).toBe("specialist_lane");
  });

  it("routes high compliance/cost-of-failure work to human_only", () => {
    const decision = route({
      scoring: {
        ...BASE_SCORING,
        complianceSafetyImpact: 0.95,
        costOfFailure: 0.9,
      },
    });

    expect(decision.routeType).toBe("human_only");
    expect(decision.escalationRequirement).toBe("human_only");
  });

  it("hard-stops policy bypass attempts", () => {
    const decision = route({
      policyInput: {
        action: "policy_bypass",
      },
    });

    expect(decision.routeType).toBe("hard_stop");
    expect(decision.escalationRequirement).toBe("hard_stop");
    expect(decision.triggeredPolicyRule).toBe("policy_bypass_hard_stop");
  });

  it("hard-stops routing when memory was not checked", () => {
    const decision = route({
      memoryBeforeAction: undefined,
    });

    expect(decision.routeType).toBe("hard_stop");
    expect(decision.validationFindings).toContain("memory_before_action_required");
    expect(decision.triggeredPolicyRule).toBe("memory_before_action_gate");
  });

  it("hard-stops rejected memory patterns before ai_direct routing", () => {
    const decision = route({
      memoryBeforeAction: {
        ...MEMORY_CHECKED,
        allowed: false,
        reason: "rejected_pattern_blocked",
        blockedPatternRefs: ["rejected-claim-only-closeout"],
      },
    });

    expect(decision.routeType).toBe("hard_stop");
    expect(decision.validationFindings).toContain("rejected_pattern_blocked");
  });

  it("hard-stops missing proof refs", () => {
    const decision = route({
      proofRefs: [],
    });

    expect(decision.routeType).toBe("hard_stop");
    expect(decision.validationFindings).toContain("missing_proof_refs");
  });

  it("hard-stops out-of-range scoring", () => {
    const decision = route({
      scoring: {
        ...BASE_SCORING,
        risk: 2,
      },
    });

    expect(decision.routeType).toBe("hard_stop");
    expect(decision.validationFindings).toContain("risk_out_of_range");
  });
});
