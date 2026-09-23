import { describe, expect, it } from "vitest";
import {
  GIE_LEARNING_LOOP_STAGES,
  analyzeGieLearningFailure,
  attemptBetterGieMove,
  createGieLearningEvent,
  createGieReusableExperience,
  evaluateNoSilentMutationGuard,
  retestGieLearningAttempt,
} from "./learning-by-doing-runtime.js";

const NOW = Date.parse("2026-07-21T21:12:00Z");

function baseEvent(overrides: Partial<Parameters<typeof createGieLearningEvent>[0]> = {}) {
  return createGieLearningEvent({
    eventId: "learn-1",
    taskRef: "task-1",
    outcomeRef: "outcome-1",
    stage: "result_checked",
    result: "failure",
    summary: "The first route failed validation.",
    ownerLane: "sadb",
    authorityRef: "phase8-plan",
    proofRefs: ["task-proof", "receipt-proof"],
    createdAt: NOW,
    ...overrides,
  });
}

describe("GIE learning-by-doing runtime", () => {
  it("defines the exact governed Phase 8 loop stages", () => {
    expect(GIE_LEARNING_LOOP_STAGES).toEqual([
      "task_runs",
      "result_checked",
      "success_logged",
      "failure_logged",
      "failure_analyzed",
      "better_move_attempted",
      "retested",
      "successful_path_stored",
      "unresolved_failure_escalated",
    ]);
  });

  it("creates learning events only with authority and proof", () => {
    const event = baseEvent();

    expect(event.ownerLane).toBe("sadb");
    expect(event.proofRefs).toEqual(["task-proof", "receipt-proof"]);
    expect(event.result).toBe("failure");
  });

  it("rejects claim-only learning events", () => {
    expect(() =>
      baseEvent({
        proofRefs: [],
      }),
    ).toThrow("gie_learning_event_required_fields_missing");
  });

  it("analyzes a checked failure with a non-mutating better move", () => {
    const analysis = analyzeGieLearningFailure({
      analysisId: "analysis-1",
      failureEvent: baseEvent(),
      failureMode: "bad_route",
      rootCause: "Router selected AI-direct before enough proof was attached.",
      betterMove: "Require human review until proof refs are complete.",
      mutationRequested: false,
      authorityRef: "phase8-plan",
      proofRefs: ["analysis-proof"],
      analyzedAt: NOW + 1,
    });

    expect(analysis.failureMode).toBe("bad_route");
    expect(analysis.betterMove).toContain("human review");
  });

  it("blocks failure analysis when silent mutation is requested", () => {
    expect(() =>
      analyzeGieLearningFailure({
        analysisId: "analysis-1",
        failureEvent: baseEvent(),
        failureMode: "wrong_fix",
        rootCause: "The fix changed behavior without approval.",
        betterMove: "Rewrite runtime defaults silently.",
        mutationRequested: true,
        authorityRef: "phase8-plan",
        proofRefs: ["analysis-proof"],
        analyzedAt: NOW + 1,
      }),
    ).toThrow("gie_learning_silent_mutation_blocked");
  });

  it("attempts a better move only after failure analysis", () => {
    const analysis = analyzeGieLearningFailure({
      analysisId: "analysis-1",
      failureEvent: baseEvent(),
      failureMode: "missing_proof",
      rootCause: "Proof refs were absent.",
      betterMove: "Attach verifier receipt before route.",
      mutationRequested: false,
      authorityRef: "phase8-plan",
      proofRefs: ["analysis-proof"],
      analyzedAt: NOW + 1,
    });
    const attempt = attemptBetterGieMove({
      attemptId: "attempt-1",
      analysis,
      attemptedMove: "Attach verifier receipt before route.",
      expectedImprovement: "Route no longer fails missing proof.",
      authorityRef: "phase8-plan",
      proofRefs: ["attempt-proof"],
      attemptedAt: NOW + 2,
    });

    expect(attempt.analysisRef).toBe("analysis-1");
    expect(attempt.mutationApplied).toBe(false);
  });

  it("requires retest proof before successful experience storage", () => {
    const analysis = analyzeGieLearningFailure({
      analysisId: "analysis-1",
      failureEvent: baseEvent(),
      failureMode: "retest_needed",
      rootCause: "No retest existed.",
      betterMove: "Run verifier again.",
      mutationRequested: false,
      authorityRef: "phase8-plan",
      proofRefs: ["analysis-proof"],
      analyzedAt: NOW + 1,
    });
    const attempt = attemptBetterGieMove({
      attemptId: "attempt-1",
      analysis,
      attemptedMove: "Run verifier again.",
      expectedImprovement: "Verifier produces PASS.",
      authorityRef: "phase8-plan",
      proofRefs: ["attempt-proof"],
      attemptedAt: NOW + 2,
    });
    const retest = retestGieLearningAttempt({
      retestId: "retest-1",
      attempt,
      retestResult: "pass",
      retestProofRefs: ["retest-proof"],
      authorityRef: "phase8-plan",
      retestedAt: NOW + 3,
    });
    const experience = createGieReusableExperience({
      experienceId: "experience-1",
      subjectKey: "routing-proof",
      retest,
      summary: "Verifier receipt before route prevents missing-proof failure.",
      authorityRef: "phase8-plan",
      storedAt: NOW + 4,
    });

    expect(experience.memoryRecord.bucket).toBe("approved_best_practices");
    expect(experience.memoryRecord.proofRefs).toContain("retest-proof");
  });

  it("does not store failed retests as approved reusable experience", () => {
    const analysis = analyzeGieLearningFailure({
      analysisId: "analysis-1",
      failureEvent: baseEvent(),
      failureMode: "wrong_fix",
      rootCause: "The attempted better move failed.",
      betterMove: "Try a safer path.",
      mutationRequested: false,
      authorityRef: "phase8-plan",
      proofRefs: ["analysis-proof"],
      analyzedAt: NOW + 1,
    });
    const attempt = attemptBetterGieMove({
      attemptId: "attempt-1",
      analysis,
      attemptedMove: "Try a safer path.",
      expectedImprovement: "Should pass.",
      authorityRef: "phase8-plan",
      proofRefs: ["attempt-proof"],
      attemptedAt: NOW + 2,
    });
    const retest = retestGieLearningAttempt({
      retestId: "retest-1",
      attempt,
      retestResult: "fail",
      retestProofRefs: ["retest-proof"],
      unresolvedFailureRef: "failure-1",
      authorityRef: "phase8-plan",
      retestedAt: NOW + 3,
    });

    expect(() =>
      createGieReusableExperience({
        experienceId: "experience-1",
        subjectKey: "routing-proof",
        retest,
        summary: "Failed retest must not be stored.",
        authorityRef: "phase8-plan",
        storedAt: NOW + 4,
      }),
    ).toThrow("gie_learning_successful_retest_required");
  });

  it("requires failed retests to include unresolved-failure escalation", () => {
    const analysis = analyzeGieLearningFailure({
      analysisId: "analysis-1",
      failureEvent: baseEvent(),
      failureMode: "wrong_fix",
      rootCause: "The attempted better move failed.",
      betterMove: "Escalate instead of cycling silently.",
      mutationRequested: false,
      authorityRef: "phase8-plan",
      proofRefs: ["analysis-proof"],
      analyzedAt: NOW + 1,
    });
    const attempt = attemptBetterGieMove({
      attemptId: "attempt-1",
      analysis,
      attemptedMove: "Escalate instead of cycling silently.",
      expectedImprovement: "Governance sees unresolved failure.",
      authorityRef: "phase8-plan",
      proofRefs: ["attempt-proof"],
      attemptedAt: NOW + 2,
    });

    expect(() =>
      retestGieLearningAttempt({
        retestId: "retest-1",
        attempt,
        retestResult: "fail",
        retestProofRefs: ["retest-proof"],
        authorityRef: "phase8-plan",
        retestedAt: NOW + 3,
      }),
    ).toThrow("gie_learning_failed_retest_escalation_required");
  });

  it("binds unresolved-failure escalation to failed retests", () => {
    const analysis = analyzeGieLearningFailure({
      analysisId: "analysis-1",
      failureEvent: baseEvent(),
      failureMode: "wrong_fix",
      rootCause: "The attempted better move failed.",
      betterMove: "Escalate the unresolved failure.",
      mutationRequested: false,
      authorityRef: "phase8-plan",
      proofRefs: ["analysis-proof"],
      analyzedAt: NOW + 1,
    });
    const attempt = attemptBetterGieMove({
      attemptId: "attempt-1",
      analysis,
      attemptedMove: "Escalate the unresolved failure.",
      expectedImprovement: "Governance sees unresolved failure.",
      authorityRef: "phase8-plan",
      proofRefs: ["attempt-proof"],
      attemptedAt: NOW + 2,
    });
    const retest = retestGieLearningAttempt({
      retestId: "retest-1",
      attempt,
      retestResult: "fail",
      retestProofRefs: ["retest-proof"],
      unresolvedFailureRef: "failure-1",
      authorityRef: "phase8-plan",
      retestedAt: NOW + 3,
    });

    expect(retest.retestResult).toBe("fail");
    expect(retest.escalation.escalated).toBe(true);
    expect(retest.escalation.reason).toBe("unresolved_failure_after_retest");
    expect(retest.escalation.unresolvedFailureRef).toBe("failure-1");
  });

  it("allows no silent mutation only when approval is explicit", () => {
    expect(
      evaluateNoSilentMutationGuard({
        mutationRequested: false,
        approvalRefs: [],
      }).allowed,
    ).toBe(true);
    expect(
      evaluateNoSilentMutationGuard({
        mutationRequested: true,
        approvalRefs: [],
      }).allowed,
    ).toBe(false);
    expect(
      evaluateNoSilentMutationGuard({
        mutationRequested: true,
        approvalRefs: ["approval-proof"],
      }).allowed,
    ).toBe(true);
  });
});
