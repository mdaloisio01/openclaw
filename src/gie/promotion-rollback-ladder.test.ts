import { describe, expect, it } from "vitest";
import {
  createGieDomainGovernor,
  createGieDomainLessonRecord,
  createGiePromotionCandidateHandoff,
  createGieRollbackSignalHandoff,
} from "./domain-governor-runtime.js";
import {
  GIE_PROMOTION_LADDER_STAGES,
  GIE_PROMOTION_REVIEW_CRITERIA,
  adoptGiePromotionGlobally,
  createGiePromotionAuditEvent,
  createGiePromotionCandidate,
  createGiePromotionObservation,
  detectBadGiePromotion,
  recordGieRepeatedLocalSuccess,
  reviewGiePromotionCandidate,
  rollbackBadGiePromotion,
} from "./promotion-rollback-ladder.js";

const NOW = Date.parse("2026-07-21T22:00:00Z");

function makeLessonAndHandoff() {
  const governor = createGieDomainGovernor({
    governorId: "gov-sadb",
    domainId: "sadb",
    departmentId: "data-ai-systems",
    scopeKind: "department",
    ownerLane: "data_ai_systems",
    ownerTarget: "sadb-domain-governor",
    localStandardsRefs: ["sadb-standards"],
    localPolicyRefs: ["sadb-local-policy"],
    globalPolicyRefs: ["fleet-controller-law"],
    localMemorySubjectPrefix: "sadb",
    authorityRef: "governance-authority",
    proofRefs: ["phase10-proof"],
    createdAt: NOW,
  });
  const lesson = createGieDomainLessonRecord({
    lessonId: "lesson-router-proof",
    governor,
    lessonKind: "local_lesson",
    subjectKey: "sadb/router-proof",
    summary: "Router changes need receipt-backed review before closeout.",
    authorityRef: "sadb-local-policy",
    proofRefs: ["lesson-proof"],
    createdAt: NOW,
  });
  const handoff = createGiePromotionCandidateHandoff({
    handoffId: "handoff-router-proof",
    lesson,
    reason: "Repeated local success should be reviewed for global adoption.",
    authorityRef: "governance-authority",
    proofRefs: ["handoff-proof"],
    createdAt: NOW,
  });
  const rollbackSignal = createGieRollbackSignalHandoff({
    handoffId: "rollback-signal-router-proof",
    rollbackSignalRef: "rollback-signal-proof",
    sourceGovernor: governor,
    reason: "Promoted router proof pattern regressed.",
    authorityRef: "governance-authority",
    proofRefs: ["rollback-signal-proof"],
    createdAt: NOW,
  });
  return { lesson, handoff, rollbackSignal };
}

function passingCriteria() {
  return Object.fromEntries(
    GIE_PROMOTION_REVIEW_CRITERIA.map((criterion) => [criterion, true]),
  ) as Record<(typeof GIE_PROMOTION_REVIEW_CRITERIA)[number], boolean>;
}

function makeApprovedCandidate() {
  const { lesson, handoff, rollbackSignal } = makeLessonAndHandoff();
  const observation = createGiePromotionObservation({
    observationId: "obs-router-proof",
    sourceDomainId: lesson.domainId,
    lessonRef: lesson.lessonId,
    subjectKey: lesson.subjectKey,
    summary: lesson.summary,
    authorityRef: "governance-authority",
    proofRefs: ["observation-proof"],
    observedAt: NOW,
  });
  const success = recordGieRepeatedLocalSuccess({
    successId: "success-router-proof",
    observation,
    successRefs: ["success-1", "success-2"],
    authorityRef: "governance-authority",
    proofRefs: ["success-proof"],
    recordedAt: NOW + 1,
  });
  const review = reviewGiePromotionCandidate({
    reviewId: "review-router-proof",
    success,
    decision: "approved_for_candidate",
    criteriaResults: passingCriteria(),
    reviewerRefs: ["governance-review", "domain-review"],
    securityReviewRef: "security-review",
    authorityRef: "governance-authority",
    proofRefs: ["review-proof"],
    reviewedAt: NOW + 2,
  });
  const candidate = createGiePromotionCandidate({
    candidateId: "candidate-router-proof",
    review,
    handoff,
    subjectKey: lesson.subjectKey,
    proposedGlobalSummary: "Use receipt-backed router closeout globally.",
    authorityRef: "governance-authority",
    proofRefs: ["candidate-proof"],
    createdAt: NOW + 3,
  });
  return { candidate, rollbackSignal };
}

describe("GIE local-to-global promotion and rollback ladder", () => {
  it("defines the exact required Phase 11 ladder and review criteria", () => {
    expect(GIE_PROMOTION_LADDER_STAGES).toEqual([
      "local_observation",
      "repeated_local_success",
      "review",
      "promotion_candidate",
      "global_adoption",
      "rollback_if_bad",
    ]);
    expect(GIE_PROMOTION_REVIEW_CRITERIA).toContain("global_policy_review_complete");
    expect(GIE_PROMOTION_REVIEW_CRITERIA).toContain("rollback_path_defined");
  });

  it("requires repeated local success before review", () => {
    const { lesson } = makeLessonAndHandoff();
    const observation = createGiePromotionObservation({
      observationId: "obs-router-proof",
      sourceDomainId: lesson.domainId,
      lessonRef: lesson.lessonId,
      subjectKey: lesson.subjectKey,
      summary: lesson.summary,
      authorityRef: "governance-authority",
      proofRefs: ["observation-proof"],
      observedAt: NOW,
    });

    expect(() =>
      recordGieRepeatedLocalSuccess({
        successId: "success-router-proof",
        observation,
        successRefs: ["success-1"],
        authorityRef: "governance-authority",
        proofRefs: ["success-proof"],
        recordedAt: NOW + 1,
      }),
    ).toThrow("gie_repeated_local_success_requires_two_or_more_success_refs");
  });

  it("does not create a promotion candidate without approved review criteria", () => {
    const { lesson, handoff } = makeLessonAndHandoff();
    const observation = createGiePromotionObservation({
      observationId: "obs-router-proof",
      sourceDomainId: lesson.domainId,
      lessonRef: lesson.lessonId,
      subjectKey: lesson.subjectKey,
      summary: lesson.summary,
      authorityRef: "governance-authority",
      proofRefs: ["observation-proof"],
      observedAt: NOW,
    });
    const success = recordGieRepeatedLocalSuccess({
      successId: "success-router-proof",
      observation,
      successRefs: ["success-1", "success-2"],
      authorityRef: "governance-authority",
      proofRefs: ["success-proof"],
      recordedAt: NOW + 1,
    });
    expect(() =>
      reviewGiePromotionCandidate({
        reviewId: "review-router-proof",
        success,
        decision: "approved_for_candidate",
        criteriaResults: { ...passingCriteria(), rollback_path_defined: false },
        reviewerRefs: ["governance-review"],
        securityReviewRef: "security-review",
        authorityRef: "governance-authority",
        proofRefs: ["review-proof"],
        reviewedAt: NOW + 2,
      }),
    ).toThrow("gie_promotion_review_cannot_approve_failed_criteria");

    const rejected = reviewGiePromotionCandidate({
      reviewId: "review-rejected",
      success,
      decision: "rejected",
      criteriaResults: { ...passingCriteria(), no_rejected_pattern_collision: false },
      reviewerRefs: ["governance-review"],
      securityReviewRef: "security-review",
      rejectionReason: "Rejected pattern collision.",
      authorityRef: "governance-authority",
      proofRefs: ["review-proof"],
      reviewedAt: NOW + 2,
    });
    expect(() =>
      createGiePromotionCandidate({
        candidateId: "candidate-rejected",
        review: rejected,
        handoff,
        subjectKey: lesson.subjectKey,
        proposedGlobalSummary: lesson.summary,
        authorityRef: "governance-authority",
        proofRefs: ["candidate-proof"],
        createdAt: NOW + 3,
      }),
    ).toThrow("gie_promotion_candidate_requires_approved_review");
  });

  it("creates global adoption only after reviewed candidate with versioning and governance approval", () => {
    const { candidate } = makeApprovedCandidate();
    const adoption = adoptGiePromotionGlobally({
      adoptionId: "adopt-router-proof",
      candidate,
      version: "v1",
      governanceApprovalRef: "governance-approval",
      securityApprovalRef: "security-approval",
      globalMemoryId: "global-memory-router-proof",
      authorityRef: "governance-authority",
      proofRefs: ["adoption-proof"],
      adoptedAt: NOW + 4,
    });

    expect(adoption.stage).toBe("global_adoption");
    expect(adoption.version).toBe("v1");
    expect(adoption.globalSubjectKey).toBe("global/sadb/router-proof");
    expect(adoption.globalMemoryRecord.bucket).toBe("approved_best_practices");
    expect(adoption.globalMemoryRecord.subjectKey).toBe("global/sadb/router-proof");
  });

  it("blocks global adoption without governance approval and Will/operator authority", () => {
    const { candidate } = makeApprovedCandidate();

    expect(() =>
      adoptGiePromotionGlobally({
        adoptionId: "adopt-router-proof",
        candidate,
        version: "v1",
        governanceApprovalRef: "",
        globalMemoryId: "global-memory-router-proof",
        authorityRef: "governance-authority",
        proofRefs: ["adoption-proof"],
        adoptedAt: NOW + 4,
      }),
    ).toThrow("gie_global_adoption_governance_approval_required");

    expect(() =>
      adoptGiePromotionGlobally({
        adoptionId: "adopt-router-proof",
        candidate,
        version: "v1",
        governanceApprovalRef: "governance-approval",
        globalMemoryId: "global-memory-router-proof",
        authorityRef: "will-orchestrator",
        proofRefs: ["adoption-proof"],
        adoptedAt: NOW + 4,
      }),
    ).toThrow("gie_global_adoption_authority_must_not_be_will_or_operator");
  });

  it("detects bad promotions and rolls them back to rejected-pattern memory", () => {
    const { candidate, rollbackSignal } = makeApprovedCandidate();
    const adoption = adoptGiePromotionGlobally({
      adoptionId: "adopt-router-proof",
      candidate,
      version: "v1",
      governanceApprovalRef: "governance-approval",
      securityApprovalRef: "security-approval",
      globalMemoryId: "global-memory-router-proof",
      authorityRef: "governance-authority",
      proofRefs: ["adoption-proof"],
      adoptedAt: NOW + 4,
    });
    const detection = detectBadGiePromotion({
      detectionId: "bad-promotion-router-proof",
      adoption,
      badPatternSummary: "Global router closeout pattern caused false completion.",
      severity: "high",
      rollbackSignal,
      authorityRef: "governance-authority",
      proofRefs: ["bad-promotion-proof"],
      detectedAt: NOW + 5,
    });
    const rollback = rollbackBadGiePromotion({
      rollbackId: "rollback-router-proof",
      adoption,
      detection,
      rollbackVersion: "v2-rollback",
      rollbackMemoryId: "rejected-router-proof",
      authorityRef: "governance-authority",
      proofRefs: ["rollback-proof"],
      rolledBackAt: NOW + 6,
    });

    expect(detection.rollbackSignalRef).toBe("rollback-signal-router-proof");
    expect(rollback.rollbackStatus).toBe("rolled_back");
    expect(rollback.rollbackMemoryRecord.bucket).toBe("rejected_patterns");
    expect(rollback.rollbackMemoryRecord.subjectKey).toBe(adoption.globalSubjectKey);
  });

  it("records an audit event for each ladder stage", () => {
    const events = GIE_PROMOTION_LADDER_STAGES.map((stage, index) =>
      createGiePromotionAuditEvent({
        auditId: `audit-${stage}`,
        stage,
        sourceRef: `source-${stage}`,
        action: `record ${stage}`,
        authorityRef: "governance-authority",
        proofRefs: [`proof-${index}`],
        recordedAt: NOW + index,
      }),
    );

    expect(events.map((event) => event.stage)).toEqual(GIE_PROMOTION_LADDER_STAGES);
  });
});
