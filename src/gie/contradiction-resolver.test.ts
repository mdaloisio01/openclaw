import { describe, expect, it } from "vitest";
import { resolveGieContradictions, type GieTruthClaim } from "./contradiction-resolver.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-21T20:14:00Z");

function claim(overrides: Partial<GieTruthClaim>): GieTruthClaim {
  return {
    claimId: "claim",
    subjectId: "gie_phase4",
    sourceId: "source",
    sourceKind: "receipt_result",
    truthStatus: "in_progress",
    statement: "default claim",
    updatedAt: NOW,
    proofRefs: ["proof-ref"],
    ...overrides,
  };
}

describe("GIE contradiction resolver", () => {
  it("reopens stale false-completion claims when stronger live truth disagrees", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [
        claim({
          claimId: "stale-complete",
          sourceKind: "stale_prior_report",
          truthStatus: "complete",
          statement: "Phase 4 is complete",
          updatedAt: NOW - 60 * DAY,
        }),
        claim({
          claimId: "live-open",
          sourceKind: "live_runtime_truth",
          truthStatus: "in_progress",
          statement: "Phase 4 has no verifier receipt",
          updatedAt: NOW,
        }),
      ],
    });

    expect(resolution.resolution).toBe("false_completion_reopened");
    expect(resolution.winningClaim?.claimId).toBe("live-open");
    expect(resolution.reopenedClaims.map((item) => item.claimId)).toEqual(["stale-complete"]);
    expect(resolution.humanEscalationRequired).toBe(false);
  });

  it("treats superseded stale blockers as non-winning history", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [
        claim({
          claimId: "old-blocker",
          sourceKind: "receipt_result",
          truthStatus: "blocked",
          statement: "slice 01 blocked",
          updatedAt: NOW - 2 * DAY,
        }),
        claim({
          claimId: "current-pass",
          sourceKind: "receipt_result",
          truthStatus: "complete",
          statement: "slice 01 superseded and reconciled",
          supersedes: ["old-blocker"],
          updatedAt: NOW,
        }),
      ],
    });

    expect(resolution.resolution).toBe("consistent");
    expect(resolution.winningClaim?.claimId).toBe("current-pass");
    expect(
      resolution.classifications.find((item) => item.claimId === "old-blocker")?.classification,
    ).toBe("superseded");
    expect(resolution.reopenedClaims).toEqual([]);
  });

  it("escalates equal-strength unresolved authority conflicts", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [
        claim({
          claimId: "receipt-pass-a",
          sourceKind: "receipt_result",
          truthStatus: "complete",
          statement: "phase pass",
          updatedAt: NOW,
        }),
        claim({
          claimId: "receipt-blocked-b",
          sourceKind: "receipt_result",
          truthStatus: "blocked",
          statement: "phase blocked",
          updatedAt: NOW,
        }),
      ],
    });

    expect(resolution.resolution).toBe("human_escalation_required");
    expect(resolution.humanEscalationRequired).toBe(true);
    expect(resolution.humanEscalationRule).toBe("equal_strength_authority_conflict");
  });

  it("does not let partial claim-only closure outrank proven receipt truth", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [
        claim({
          claimId: "claim-only-complete",
          sourceKind: "latest_build_state_interpretation",
          truthStatus: "complete",
          statement: "phase complete",
          proofRefs: [],
          updatedAt: NOW,
        }),
        claim({
          claimId: "receipt-open",
          sourceKind: "receipt_result",
          truthStatus: "in_progress",
          statement: "verifier still pending",
          updatedAt: NOW,
        }),
      ],
    });

    expect(resolution.resolution).toBe("false_completion_reopened");
    expect(resolution.winningClaim?.claimId).toBe("receipt-open");
    expect(resolution.reopenedClaims.map((item) => item.claimId)).toEqual(["claim-only-complete"]);
    expect(
      resolution.classifications.find((item) => item.claimId === "claim-only-complete")
        ?.classification,
    ).toBe("partial");
  });

  it("classifies empty claim sets as human escalation instead of silent success", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [],
    });

    expect(resolution.resolution).toBe("human_escalation_required");
    expect(resolution.humanEscalationRequired).toBe(true);
    expect(resolution.humanEscalationRule).toBe("missing_truth_claims");
  });

  it("keeps stronger current live truth above stale memory", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [
        claim({
          claimId: "memory-complete",
          sourceKind: "memory",
          truthStatus: "complete",
          statement: "remembered complete",
          updatedAt: NOW - 90 * DAY,
        }),
        claim({
          claimId: "runtime-blocked",
          sourceKind: "live_runtime_truth",
          truthStatus: "blocked",
          statement: "runtime still blocked",
          updatedAt: NOW,
        }),
      ],
    });

    expect(resolution.winningClaim?.claimId).toBe("runtime-blocked");
    expect(resolution.resolution).toBe("false_completion_reopened");
    expect(resolution.reopenedClaims.map((item) => item.claimId)).toEqual(["memory-complete"]);
  });

  it("escalates Mark/operator instruction conflicts instead of silently preferring receipts", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [
        claim({
          claimId: "mark-says-blocked",
          sourceKind: "mark_operator_instruction",
          truthStatus: "blocked",
          statement: "Mark stopped the closeout",
          updatedAt: NOW,
        }),
        claim({
          claimId: "receipt-says-complete",
          sourceKind: "receipt_result",
          truthStatus: "complete",
          statement: "receipt says complete",
          updatedAt: NOW,
        }),
      ],
    });

    expect(resolution.resolution).toBe("human_escalation_required");
    expect(resolution.humanEscalationRule).toBe("operator_instruction_authority_conflict");
  });

  it("escalates SOP conflicts with live truth as authority conflicts", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [
        claim({
          claimId: "sop-blocked",
          sourceKind: "sop",
          truthStatus: "blocked",
          statement: "SOP says this must stop",
          updatedAt: NOW,
        }),
        claim({
          claimId: "runtime-complete",
          sourceKind: "live_runtime_truth",
          truthStatus: "complete",
          statement: "runtime says complete",
          updatedAt: NOW,
        }),
      ],
    });

    expect(resolution.resolution).toBe("human_escalation_required");
    expect(resolution.humanEscalationRule).toBe("authority_source_conflict");
  });

  it("lets active repair artifacts outrank stale controlling build plans", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [
        claim({
          claimId: "old-plan-complete",
          sourceKind: "controlling_build_plan",
          truthStatus: "complete",
          statement: "old plan implies complete",
          updatedAt: NOW - 90 * DAY,
        }),
        claim({
          claimId: "repair-blocked",
          sourceKind: "active_repair_artifact",
          truthStatus: "blocked",
          statement: "active repair says blocked",
          updatedAt: NOW,
        }),
      ],
    });

    expect(resolution.resolution).toBe("false_completion_reopened");
    expect(resolution.winningClaim?.claimId).toBe("repair-blocked");
  });

  it("does not report blocked-versus-in-progress as terminal failure conflict", () => {
    const resolution = resolveGieContradictions({
      now: NOW,
      claims: [
        claim({
          claimId: "blocked",
          sourceKind: "receipt_result",
          truthStatus: "blocked",
          statement: "blocked",
          updatedAt: NOW,
        }),
        claim({
          claimId: "in-progress",
          sourceKind: "latest_build_state_interpretation",
          truthStatus: "in_progress",
          statement: "in progress",
          updatedAt: NOW,
        }),
      ],
    });

    expect(resolution.contradictions.map((item) => item.reason)).not.toContain(
      "blocked_status_conflicts_with_terminal_truth",
    );
  });
});
