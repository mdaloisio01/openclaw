import { describe, expect, it } from "vitest";
import {
  GIE_FEEDBACK_CLASSIFICATIONS,
  approveGieCorrection,
  buildGieFeedbackLearningCandidate,
  buildGieFeedbackLearningExperience,
  createGieCorrectionNote,
  createGieFeedbackRecord,
  createGieFeedbackRollback,
  createGieRejectedFeedbackMemory,
  createGieRollbackBlockingMemory,
  rejectGieCorrection,
  recordGieFeedbackChangeTrail,
} from "./feedback-correction-governance.js";

const NOW = Date.parse("2026-07-21T21:42:00Z");

function baseFeedback(overrides: Partial<Parameters<typeof createGieFeedbackRecord>[0]> = {}) {
  return createGieFeedbackRecord({
    feedbackId: "feedback-1",
    source: "mark",
    classification: "wrong_route",
    targetRef: "route-decision-1",
    summary: "This should have been human review, not AI-direct.",
    authorityRef: "phase9-plan",
    proofRefs: ["feedback-proof"],
    receivedAt: NOW,
    ...overrides,
  });
}

function baseNote(overrides: Partial<Parameters<typeof createGieCorrectionNote>[0]> = {}) {
  return createGieCorrectionNote({
    correctionId: "correction-1",
    feedback: baseFeedback(),
    proposedChange: "Route similar proof-light tasks to human review.",
    changeScope: "routing_behavior",
    doctrineMutationRequested: false,
    authorityRef: "phase9-plan",
    proofRefs: ["correction-proof"],
    createdAt: NOW + 1,
    ...overrides,
  });
}

describe("GIE feedback correction governance", () => {
  it("defines every required Phase 9 feedback classification", () => {
    expect(GIE_FEEDBACK_CLASSIFICATIONS).toEqual([
      "good",
      "bad",
      "incomplete",
      "unsafe",
      "wrong_route",
      "wrong_fix",
      "correct_outcome_bad_process",
      "correct_process_bad_outcome",
    ]);
  });

  it("ingests Mark/operator feedback with authority and proof", () => {
    const feedback = baseFeedback();

    expect(feedback.source).toBe("mark");
    expect(feedback.classification).toBe("wrong_route");
    expect(feedback.proofRefs).toEqual(["feedback-proof"]);
  });

  it("rejects claim-only feedback ingestion", () => {
    expect(() => baseFeedback({ proofRefs: [] })).toThrow("gie_feedback_required_fields_missing");
  });

  it("creates correction notes without silently mutating doctrine", () => {
    const note = baseNote();

    expect(note.approvalStatus).toBe("pending");
    expect(note.doctrineMutationRequested).toBe(false);
  });

  it("treats doctrine-scope correction notes as doctrine mutation", () => {
    expect(() =>
      baseNote({
        changeScope: "doctrine_behavior",
        doctrineMutationRequested: false,
      }),
    ).toThrow("gie_feedback_doctrine_mutation_requires_approval");
  });

  it("blocks doctrine mutation correction notes without explicit approval refs", () => {
    expect(() =>
      baseNote({
        doctrineMutationRequested: true,
        doctrineApprovalRefs: [],
      }),
    ).toThrow("gie_feedback_doctrine_mutation_requires_approval");
  });

  it("approves corrections only with approval proof", () => {
    const approval = approveGieCorrection({
      correction: baseNote(),
      approver: "governance",
      approvalRef: "approval-proof",
      authorityRef: "phase9-plan",
      approvedAt: NOW + 2,
    });

    expect(approval.approvalStatus).toBe("approved");
    expect(approval.approvalRef).toBe("approval-proof");
    expect(approval.classification).toBe("wrong_route");
    expect(approval.policyDecision.decision).toBe("approval_required");
    expect(approval.policyDecision.triggeredRule).toBe("human_approval_required");
  });

  it("records rejected corrections with rejection handling", () => {
    const rejection = rejectGieCorrection({
      correction: baseNote(),
      rejector: "governance",
      rejectionReason: "Would change doctrine without enough proof.",
      authorityRef: "phase9-plan",
      proofRefs: ["rejection-proof"],
      rejectedAt: NOW + 2,
    });

    expect(rejection.approvalStatus).toBe("rejected");
    expect(rejection.rejectionHandling).toBe("do_not_apply_or_learn");
    expect(rejection.classification).toBe("wrong_route");
  });

  it("records rejected corrections as rejected-pattern memory", () => {
    const rejection = rejectGieCorrection({
      correction: baseNote(),
      rejector: "governance",
      rejectionReason: "No proof.",
      authorityRef: "phase9-plan",
      proofRefs: ["rejection-proof"],
      rejectedAt: NOW + 2,
    });
    const memory = createGieRejectedFeedbackMemory({
      rejection,
      memoryId: "rejected-memory-1",
      subjectKey: "routing-proof-light-tasks",
      storedAt: NOW + 3,
    });

    expect(memory.bucket).toBe("rejected_patterns");
    expect(memory.proofRefs).toContain("rejection-proof");
  });

  it("turns approved corrections into learning candidates", () => {
    const approval = approveGieCorrection({
      correction: baseNote(),
      approver: "governance",
      approvalRef: "approval-proof",
      authorityRef: "phase9-plan",
      approvedAt: NOW + 2,
    });
    const candidate = buildGieFeedbackLearningCandidate({
      approval,
      candidateId: "candidate-1",
      learningSubjectKey: "routing-proof-light-tasks",
      expectedBehaviorChange: "Use human review when proof is incomplete.",
      authorityRef: "phase9-plan",
      proofRefs: ["candidate-proof"],
      createdAt: NOW + 3,
    });

    expect(candidate.learningCandidateId).toBe("candidate-1");
    expect(candidate.feedbackRef).toBe("feedback-1");
    expect(candidate.correctionRef).toBe("correction-1");
    expect(candidate.failureMode).toBe("bad_route");
  });

  it("turns approved corrections into retested reusable experience", () => {
    const approval = approveGieCorrection({
      correction: baseNote(),
      approver: "governance",
      approvalRef: "approval-proof",
      authorityRef: "phase9-plan",
      approvedAt: NOW + 2,
    });
    const candidate = buildGieFeedbackLearningCandidate({
      approval,
      candidateId: "candidate-1",
      learningSubjectKey: "routing-proof-light-tasks",
      expectedBehaviorChange: "Use human review when proof is incomplete.",
      authorityRef: "phase9-plan",
      proofRefs: ["candidate-proof"],
      createdAt: NOW + 3,
    });
    const experience = buildGieFeedbackLearningExperience({
      candidate,
      retestId: "feedback-retest-1",
      retestProofRefs: ["feedback-retest-proof"],
      storedAt: NOW + 4,
    });

    expect(experience.memoryRecord.bucket).toBe("approved_best_practices");
    expect(experience.memoryRecord.subjectKey).toBe("routing-proof-light-tasks");
    expect(experience.memoryRecord.proofRefs).toContain("feedback-retest-proof");
  });

  it("does not turn rejected corrections into learning candidates", () => {
    const rejection = rejectGieCorrection({
      correction: baseNote(),
      rejector: "governance",
      rejectionReason: "No proof.",
      authorityRef: "phase9-plan",
      proofRefs: ["rejection-proof"],
      rejectedAt: NOW + 2,
    });

    expect(() =>
      buildGieFeedbackLearningCandidate({
        approval: rejection,
        candidateId: "candidate-1",
        learningSubjectKey: "routing-proof-light-tasks",
        expectedBehaviorChange: "Use human review.",
        authorityRef: "phase9-plan",
        proofRefs: ["candidate-proof"],
        createdAt: NOW + 3,
      }),
    ).toThrow("gie_feedback_approved_correction_required");
  });

  it("records rollback paths for bad approved corrections", () => {
    const approval = approveGieCorrection({
      correction: baseNote(),
      approver: "governance",
      approvalRef: "approval-proof",
      authorityRef: "phase9-plan",
      approvedAt: NOW + 2,
    });
    const rollback = createGieFeedbackRollback({
      rollbackId: "rollback-1",
      approval,
      reason: "Correction caused wrong-route regression.",
      rollbackRef: "rollback-proof",
      authorityRef: "phase9-plan",
      proofRefs: ["rollback-proof"],
      rolledBackAt: NOW + 4,
    });

    expect(rollback.rollbackStatus).toBe("rolled_back");
    expect(rollback.approvalRef).toBe("approval-proof");
    const memory = createGieRollbackBlockingMemory({
      rollback,
      memoryId: "rollback-memory-1",
      subjectKey: "routing-proof-light-tasks",
      storedAt: NOW + 5,
    });

    expect(memory.bucket).toBe("rejected_patterns");
    expect(memory.summary).toContain("Correction caused wrong-route regression.");
  });

  it("records what changed because of feedback", () => {
    const approval = approveGieCorrection({
      correction: baseNote(),
      approver: "governance",
      approvalRef: "approval-proof",
      authorityRef: "phase9-plan",
      approvedAt: NOW + 2,
    });
    const trail = recordGieFeedbackChangeTrail({
      trailId: "trail-1",
      approval,
      changedRefs: ["decision-router-rule"],
      behaviorBefore: "AI-direct allowed proof-light route.",
      behaviorAfter: "Proof-light route requires human review.",
      authorityRef: "phase9-plan",
      proofRefs: ["trail-proof"],
      recordedAt: NOW + 5,
    });

    expect(trail.changedBecauseOfFeedbackRef).toBe("feedback-1");
    expect(trail.changedRefs).toEqual(["decision-router-rule"]);
  });
});
