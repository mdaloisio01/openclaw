import { describe, expect, it } from "vitest";
import {
  calculateGiePerformanceTrend,
  classifyGieRecurringIssue,
  createGieAdaptationCandidate,
  createGieCrossLaneOutcome,
  createGieTuningSignal,
  detectGieCrossLanePattern,
  evaluateGieLocalGlobalOptimizationBoundary,
} from "./cross-lane-optimization.js";

const NOW = Date.parse("2026-07-21T22:20:00Z");

function makeOutcomes() {
  return [
    createGieCrossLaneOutcome({
      outcomeId: "outcome-1",
      laneId: "sadb",
      domainId: "data-ai-systems",
      patternKey: "receipt-first-closeout",
      result: "success",
      confidence: 0.7,
      durationMs: 1000,
      resourceCost: 2,
      authorityRef: "phase13-authority",
      proofRefs: ["proof-1"],
      recordedAt: NOW,
    }),
    createGieCrossLaneOutcome({
      outcomeId: "outcome-2",
      laneId: "verification",
      domainId: "verification",
      patternKey: "receipt-first-closeout",
      result: "success",
      confidence: 0.9,
      durationMs: 800,
      resourceCost: 1,
      authorityRef: "phase13-authority",
      proofRefs: ["proof-2"],
      recordedAt: NOW + 1,
    }),
  ];
}

function makeFailurePattern() {
  const outcomes = [
    createGieCrossLaneOutcome({
      outcomeId: "fail-1",
      laneId: "sadb",
      domainId: "data-ai-systems",
      patternKey: "missing-proof-closeout",
      result: "failure",
      confidence: 0.4,
      durationMs: 1200,
      resourceCost: 4,
      authorityRef: "phase13-authority",
      proofRefs: ["fail-proof-1"],
      recordedAt: NOW,
    }),
    createGieCrossLaneOutcome({
      outcomeId: "fail-2",
      laneId: "governance",
      domainId: "governance",
      patternKey: "missing-proof-closeout",
      result: "blocked",
      confidence: 0.5,
      durationMs: 1300,
      resourceCost: 5,
      authorityRef: "phase13-authority",
      proofRefs: ["fail-proof-2"],
      recordedAt: NOW + 1,
    }),
  ];
  return detectGieCrossLanePattern({
    patternId: "pattern-failure",
    outcomes,
    patternKey: "missing-proof-closeout",
    authorityRef: "phase13-authority",
    proofRefs: ["pattern-proof"],
    detectedAt: NOW + 2,
  });
}

describe("GIE cross-lane learning and optimization", () => {
  it("detects repeated cross-lane patterns only across more than one lane", () => {
    const pattern = detectGieCrossLanePattern({
      patternId: "pattern-1",
      outcomes: makeOutcomes(),
      patternKey: "receipt-first-closeout",
      authorityRef: "phase13-authority",
      proofRefs: ["pattern-proof"],
      detectedAt: NOW + 2,
    });

    expect(pattern.laneIds).toEqual(["sadb", "verification"]);
    expect(pattern.successCount).toBe(2);
    expect(pattern.averageConfidence).toBe(0.8);

    expect(() =>
      detectGieCrossLanePattern({
        patternId: "pattern-bad",
        outcomes: [makeOutcomes()[0]],
        patternKey: "receipt-first-closeout",
        authorityRef: "phase13-authority",
        proofRefs: ["pattern-proof"],
        detectedAt: NOW + 2,
      }),
    ).toThrow("gie_cross_lane_pattern_requires_repeated_cross_lane_outcomes");
  });

  it("classifies recurring issues only when repeated cross-lane failures exist", () => {
    const issue = classifyGieRecurringIssue({
      issueId: "issue-1",
      pattern: makeFailurePattern(),
      issueClass: "missing_proof",
      summary: "Closeout attempts keep missing proof across lanes.",
      authorityRef: "phase13-authority",
      proofRefs: ["issue-proof"],
      classifiedAt: NOW + 3,
    });

    expect(issue.issueClass).toBe("missing_proof");
    expect(issue.failureCount).toBe(2);
    expect(issue.affectedLaneIds).toEqual(["sadb", "governance"]);
  });

  it("blocks cross-lane adaptation without lawful promotion or boundary review", () => {
    const pattern = detectGieCrossLanePattern({
      patternId: "pattern-1",
      outcomes: makeOutcomes(),
      patternKey: "receipt-first-closeout",
      authorityRef: "phase13-authority",
      proofRefs: ["pattern-proof"],
      detectedAt: NOW + 2,
    });
    const decision = evaluateGieLocalGlobalOptimizationBoundary({
      sourceLaneId: "sadb",
      targetLaneId: "verification",
      proofRefs: ["boundary-proof"],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("lawful_promotion_or_boundary_review_required");
    expect(() =>
      createGieAdaptationCandidate({
        candidateId: "candidate-1",
        candidateType: "reusable_strategy",
        pattern,
        sourceLaneId: "sadb",
        targetLaneIds: ["verification"],
        recommendation: "Use receipt-first closeout in verification.",
        authorityRef: "phase13-authority",
        proofRefs: ["candidate-proof"],
        createdAt: NOW + 3,
      }),
    ).toThrow("gie_adaptation_candidate_boundary_review_required");
  });

  it("creates adaptation candidates as candidate-only when boundary proof exists", () => {
    const pattern = detectGieCrossLanePattern({
      patternId: "pattern-1",
      outcomes: makeOutcomes(),
      patternKey: "receipt-first-closeout",
      authorityRef: "phase13-authority",
      proofRefs: ["pattern-proof"],
      detectedAt: NOW + 2,
    });
    const candidate = createGieAdaptationCandidate({
      candidateId: "candidate-1",
      candidateType: "reusable_strategy",
      pattern,
      sourceLaneId: "sadb",
      targetLaneIds: ["verification"],
      recommendation: "Use receipt-first closeout in verification.",
      promotionOrBoundaryReviewRef: "phase11-promotion-or-boundary-review",
      authorityRef: "phase13-authority",
      proofRefs: ["candidate-proof"],
      createdAt: NOW + 3,
    });

    expect(candidate.applicationStatus).toBe("candidate_only_not_applied");
    expect(candidate.boundaryDecision.allowed).toBe(true);
  });

  it("calculates performance trends and emits signal-only tuning records", () => {
    const trend = calculateGiePerformanceTrend({
      trendId: "trend-1",
      outcomes: makeOutcomes(),
      patternKey: "receipt-first-closeout",
      authorityRef: "phase13-authority",
      proofRefs: ["trend-proof"],
      calculatedAt: NOW + 4,
    });
    const signal = createGieTuningSignal({
      signalId: "signal-1",
      signalType: "resource",
      trend,
      targetLaneId: "verification",
      recommendation: "Reduce reviewer wait on receipt-first closeouts.",
      authorityRef: "phase13-authority",
      proofRefs: ["signal-proof"],
      createdAt: NOW + 5,
    });

    expect(trend.trendDirection).toBe("improving");
    expect(signal.applicationStatus).toBe("signal_only_not_applied");
  });
});
