import { describe, expect, it } from "vitest";
import {
  createGieDomainGovernor,
  createGieDomainLessonRecord,
  createGieLocalDomainMemoryRecord,
  createGiePromotionCandidateHandoff,
  createGieRollbackSignalHandoff,
  evaluateGieLocalMemoryBoundary,
  evaluateGieLocalPolicyBoundary,
} from "./domain-governor-runtime.js";

const NOW = Date.parse("2026-07-21T22:30:00Z");

function makeGovernor() {
  return createGieDomainGovernor({
    governorId: "gov-security",
    domainId: "security",
    departmentId: "security-branch",
    scopeKind: "department",
    ownerLane: "security_branch",
    ownerTarget: "security-domain-governor",
    localStandardsRefs: ["security-local-standards"],
    localPolicyRefs: ["security-local-policy"],
    globalPolicyRefs: ["fleet-controller-law", "approval-rules"],
    localMemorySubjectPrefix: "security",
    authorityRef: "phase10-authority",
    proofRefs: ["phase10-proof"],
    createdAt: NOW,
  });
}

function makeLesson() {
  const governor = makeGovernor();
  return {
    governor,
    lesson: createGieDomainLessonRecord({
      lessonId: "lesson-1",
      governor,
      lessonKind: "local_lesson",
      subjectKey: "security/policy-review",
      summary: "Security review should preserve least-privilege before helper dispatch.",
      authorityRef: "security-local-policy",
      proofRefs: ["lesson-proof"],
      createdAt: NOW,
    }),
  };
}

describe("GIE domain governor runtime", () => {
  it("creates a bounded domain governor with local and global policy refs", () => {
    const governor = makeGovernor();

    expect(governor.domainId).toBe("security");
    expect(governor.localMemorySubjectPrefix).toBe("security/");
    expect(governor.globalPolicyRefs).toContain("fleet-controller-law");
  });

  it("does not allow Will or the operator to become the local domain governor owner or authority", () => {
    expect(() =>
      createGieDomainGovernor({
        governorId: "gov-will",
        domainId: "security",
        departmentId: "security-branch",
        scopeKind: "department",
        ownerLane: "will",
        ownerTarget: "will",
        localStandardsRefs: ["security-local-standards"],
        localPolicyRefs: ["security-local-policy"],
        globalPolicyRefs: ["fleet-controller-law"],
        localMemorySubjectPrefix: "security",
        authorityRef: "phase10-authority",
        proofRefs: ["phase10-proof"],
        createdAt: NOW,
      }),
    ).toThrow("gie_domain_governor_owner_must_be_department_or_lane_not_will");

    expect(() =>
      createGieDomainGovernor({
        governorId: "gov-will-alias",
        domainId: "security",
        departmentId: "security-branch",
        scopeKind: "department",
        ownerLane: "security_branch",
        ownerTarget: "security-domain-governor",
        localStandardsRefs: ["security-local-standards"],
        localPolicyRefs: ["security-local-policy"],
        globalPolicyRefs: ["fleet-controller-law"],
        localMemorySubjectPrefix: "security",
        authorityRef: "will-orchestrator-approval",
        proofRefs: ["phase10-proof"],
        createdAt: NOW,
      }),
    ).toThrow("gie_domain_governor_authority_must_not_be_will_or_operator");

    expect(() =>
      createGieDomainGovernor({
        governorId: "gov-operator-alias",
        domainId: "security",
        departmentId: "security-branch",
        scopeKind: "department",
        ownerLane: "operator_lane",
        ownerTarget: "security-domain-governor",
        localStandardsRefs: ["security-local-standards"],
        localPolicyRefs: ["security-local-policy"],
        globalPolicyRefs: ["fleet-controller-law"],
        localMemorySubjectPrefix: "security",
        authorityRef: "phase10-authority",
        proofRefs: ["phase10-proof"],
        createdAt: NOW,
      }),
    ).toThrow("gie_domain_governor_owner_must_be_department_or_lane_not_will");
  });

  it("requires local lessons to stay inside the governor memory boundary", () => {
    const governor = makeGovernor();

    expect(() =>
      createGieDomainLessonRecord({
        lessonId: "bad-lesson",
        governor,
        lessonKind: "local_lesson",
        subjectKey: "hr/policy-review",
        summary: "Wrong domain.",
        authorityRef: "security-local-policy",
        proofRefs: ["proof"],
        createdAt: NOW,
      }),
    ).toThrow("gie_domain_lesson_outside_local_memory_boundary");
  });

  it("stores local lessons as department-specific memory only", () => {
    const { governor, lesson } = makeLesson();
    const memory = createGieLocalDomainMemoryRecord({
      memoryId: "memory-1",
      governor,
      lesson,
      confidence: 0.82,
      updatedAt: NOW,
    });

    expect(memory.memoryRecord.bucket).toBe("department_specific_knowledge");
    expect(memory.memoryRecord.subjectKey).toBe("security/policy-review");
    expect(memory.memoryRecord.sourceRef).toBe("lesson-1");
    expect(memory.domainId).toBe("security");
    expect(memory.visibility).toBe("local_domain_only");
    expect(memory.promotionState).toBe("not_promoted");
  });

  it("does not allow Will/operator authority refs on lessons or handoffs", () => {
    const { governor, lesson } = makeLesson();

    expect(() =>
      createGieDomainLessonRecord({
        lessonId: "lesson-will-authority",
        governor,
        lessonKind: "local_lesson",
        subjectKey: "security/policy-review-2",
        summary: "Will cannot be local lesson authority.",
        authorityRef: "mark_operator_authority",
        proofRefs: ["lesson-proof"],
        createdAt: NOW,
      }),
    ).toThrow("gie_domain_lesson_authority_must_not_be_will_or_operator");

    expect(() =>
      createGiePromotionCandidateHandoff({
        handoffId: "promotion-will-authority",
        lesson,
        reason: "Bad authority.",
        authorityRef: "will-orchestrator",
        proofRefs: ["promotion-proof"],
        createdAt: NOW,
      }),
    ).toThrow("gie_promotion_candidate_authority_must_not_be_will_or_operator");

    expect(() =>
      createGieRollbackSignalHandoff({
        handoffId: "rollback-operator-authority",
        rollbackSignalRef: "rollback-signal-proof",
        sourceGovernor: governor,
        reason: "Bad authority.",
        authorityRef: "operator_lane",
        proofRefs: ["rollback-proof"],
        createdAt: NOW,
      }),
    ).toThrow("gie_rollback_signal_authority_must_not_be_will_or_operator");
  });

  it("allows same-domain reuse but blocks cross-domain use before lawful promotion", () => {
    const { governor, lesson } = makeLesson();

    const localDecision = evaluateGieLocalMemoryBoundary({
      lesson,
      sourceGovernor: governor,
      targetDomainId: "security",
    });
    const crossDomainDecision = evaluateGieLocalMemoryBoundary({
      lesson,
      sourceGovernor: governor,
      targetDomainId: "hr",
    });

    expect(localDecision.allowed).toBe(true);
    expect(localDecision.reason).toBe("local_domain_match");
    expect(crossDomainDecision.allowed).toBe(false);
    expect(crossDomainDecision.reason).toBe("local_learning_not_promoted");
  });

  it("uses global policy to block local authority creep and bypass attempts", () => {
    const governor = makeGovernor();

    const allowed = evaluateGieLocalPolicyBoundary({
      governor,
      actionRef: "local-policy-check",
      proofRefs: ["live-proof"],
    });
    const structural = evaluateGieLocalPolicyBoundary({
      governor,
      actionRef: "local-policy-check",
      proofRefs: ["live-proof"],
      structuralChange: true,
    });
    const bypass = evaluateGieLocalPolicyBoundary({
      governor,
      actionRef: "local-policy-check",
      proofRefs: ["live-proof"],
      bypassAttempt: true,
    });

    expect(allowed.allowed).toBe(true);
    expect(structural.allowed).toBe(false);
    expect(structural.policyDecision.decision).toBe("approval_required");
    expect(bypass.allowed).toBe(false);
    expect(bypass.policyDecision.decision).toBe("hard_stop");
  });

  it("creates promotion candidate handoff without global adoption", () => {
    const { lesson } = makeLesson();
    const handoff = createGiePromotionCandidateHandoff({
      handoffId: "promotion-handoff-1",
      lesson,
      reason: "Repeated local success should be reviewed by Phase 11.",
      authorityRef: "phase10-authority",
      proofRefs: ["promotion-proof"],
      createdAt: NOW,
    });

    expect(handoff.targetPhase).toBe("gie_phase11_local_to_global_promotion_and_rollback_ladder");
    expect(handoff.handoffStatus).toBe("candidate_handoff_only");
    expect(handoff.globalAdoptionStatus).toBe("not_adopted");
  });

  it("creates rollback signal handoff without claiming global rollback", () => {
    const governor = makeGovernor();
    const handoff = createGieRollbackSignalHandoff({
      handoffId: "rollback-handoff-1",
      rollbackSignalRef: "rollback-signal-proof",
      sourceGovernor: governor,
      reason: "Local signal says a promoted pattern may be bad.",
      authorityRef: "phase10-authority",
      proofRefs: ["rollback-proof"],
      createdAt: NOW,
    });

    expect(handoff.targetPhase).toBe("gie_phase11_local_to_global_promotion_and_rollback_ladder");
    expect(handoff.handoffStatus).toBe("rollback_signal_handoff_only");
    expect(handoff.rollbackStatus).toBe("not_rolled_back_globally");
  });
});
