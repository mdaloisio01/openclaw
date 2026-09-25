import { describe, expect, it } from "vitest";
import {
  GIE_PHASE14_ADVERSARIAL_CASES,
  GIE_PHASE14_DIAGNOSTIC_CHECKS,
  GIE_PHASE14_END_STATE_ITEMS,
  createGieAdversarialValidationRecord,
  createGieFinalDiagnosticRecord,
  createGieWholeEvidenceItem,
  evaluateGieFinalCertification,
  type GieAdversarialValidationRecord,
  type GieFinalDiagnosticRecord,
  type GieWholeEvidenceItem,
} from "./adversarial-certification.js";
import { routeGieDecision } from "./decision-router.js";
import { evaluateGieMemoryBeforeAction, retrieveGieMemory } from "./memory-bucket-runtime.js";
import { evaluatePolicyDecision } from "./policy-engine.js";

const NOW = Date.parse("2026-07-21T22:30:00Z");

function adversarialRecords(): GieAdversarialValidationRecord[] {
  const policyBypass = evaluatePolicyDecision({
    action: "policy_bypass",
    ownerLane: "sadb",
    ownerTarget: "runtime",
    proofRefs: ["policy-proof"],
    bypassAttempt: true,
  });
  const missingOwnerRoute = routeGieDecision({
    taskSummary: "dispatch without owner",
    proofRefs: ["route-proof"],
    scoring: {
      risk: 0.1,
      ambiguity: 0.1,
      reversibility: 0.9,
      complianceSafetyImpact: 0.1,
      novelty: 0.1,
      repeatability: 0.9,
      confidence: 0.9,
      costOfFailure: 0.1,
      priorOutcomes: 0.9,
    },
    memoryBeforeAction: evaluateGieMemoryBeforeAction({
      retrieval: retrieveGieMemory({ records: [], subjectKey: "dispatch-without-owner", now: NOW }),
      authorityRefs: ["authority-proof"],
      liveProofRefs: ["route-proof"],
    }),
    now: NOW,
  });
  const expected: Record<
    (typeof GIE_PHASE14_ADVERSARIAL_CASES)[number],
    GieAdversarialValidationRecord["expectedDefense"]
  > = {
    false_completion: "reopen",
    bad_routing: "human_escalation",
    missing_owner: "hard_stop",
    stale_memory: "deny",
    bad_promotion: "rollback",
    helper_failure: "human_escalation",
    hidden_unresolved_issue: "reopen",
    authority_contradiction: "human_escalation",
    policy_bypass_attempt: "hard_stop",
    conflicting_feedback: "human_escalation",
    unsafe_automation_attempt: "hard_stop",
    low_confidence_silent_action: "block_silent_action",
  };
  return GIE_PHASE14_ADVERSARIAL_CASES.map((caseType, index) =>
    createGieAdversarialValidationRecord({
      caseId: `case-${caseType}`,
      caseType,
      expectedDefense: expected[caseType],
      observedDefense: expected[caseType],
      policyDecision: caseType === "policy_bypass_attempt" ? policyBypass : null,
      routeDecision: caseType === "missing_owner" ? missingOwnerRoute : null,
      proofRefs: [`proof-${index}`],
      evaluatedAt: NOW + index,
    }),
  );
}

function diagnostics(): GieFinalDiagnosticRecord[] {
  return GIE_PHASE14_DIAGNOSTIC_CHECKS.map((checkType, index) =>
    createGieFinalDiagnosticRecord({
      checkId: `check-${checkType}`,
      checkType,
      passed: true,
      finding: "clean",
      proofRefs: [`diagnostic-proof-${index}`],
      evaluatedAt: NOW + index,
    }),
  );
}

function evidenceItems(): GieWholeEvidenceItem[] {
  return GIE_PHASE14_END_STATE_ITEMS.map((item) =>
    createGieWholeEvidenceItem({
      item,
      phaseReceiptRef: `/receipt/${item}.json`,
      implementationRefs: [`/impl/${item}.ts`],
      testRefs: [`/test/${item}.test.ts`],
      proven: true,
    }),
  );
}

describe("GIE Phase 14 adversarial diagnostics and certification", () => {
  it("requires every adversarial case, diagnostic, evidence item, watchdog, and running-task gate to pass", () => {
    const decision = evaluateGieFinalCertification({
      adversarialRecords: adversarialRecords().slice(1),
      diagnostics: diagnostics(),
      evidenceItems: evidenceItems(),
      runtimeCleanliness: {
        watchdogClean: true,
        runningTaskFlows: 0,
        runningTasks: 0,
        proofRefs: ["runtime-proof"],
      },
      proofRefs: ["cert-proof"],
      decidedAt: NOW,
    });

    expect(decision.decision).toBe("blocked");
    expect(decision.fullGieCertified).toBe(false);
    expect(decision.failedAdversarialCases).toContain("false_completion");
  });

  it("blocks final certification when runtime cleanliness is not proven", () => {
    const decision = evaluateGieFinalCertification({
      adversarialRecords: adversarialRecords(),
      diagnostics: diagnostics(),
      evidenceItems: evidenceItems(),
      runtimeCleanliness: {
        watchdogClean: false,
        runningTaskFlows: 1,
        runningTasks: 2,
        proofRefs: ["runtime-proof"],
      },
      proofRefs: ["cert-proof"],
      decidedAt: NOW,
    });

    expect(decision.decision).toBe("blocked");
    expect(decision.runtimeBlockers).toEqual([
      "watchdog_not_clean",
      "running_taskflows_not_zero",
      "running_tasks_not_zero",
    ]);
  });

  it("blocks paper-only evidence and failed diagnostics", () => {
    const brokenEvidence = evidenceItems();
    brokenEvidence[0] = { ...brokenEvidence[0], proven: false };
    const brokenDiagnostics = diagnostics();
    brokenDiagnostics[0] = { ...brokenDiagnostics[0], passed: false };

    const decision = evaluateGieFinalCertification({
      adversarialRecords: adversarialRecords(),
      diagnostics: brokenDiagnostics,
      evidenceItems: brokenEvidence,
      runtimeCleanliness: {
        watchdogClean: true,
        runningTaskFlows: 0,
        runningTasks: 0,
        proofRefs: ["runtime-proof"],
      },
      proofRefs: ["cert-proof"],
      decidedAt: NOW,
    });

    expect(decision.decision).toBe("blocked");
    expect(decision.failedDiagnostics).toContain("false_completion");
    expect(decision.missingEvidenceItems).toContain("phase1_policy_engine");
  });

  it("certifies full GIE only when the complete Phase 14 matrix is clean", () => {
    const decision = evaluateGieFinalCertification({
      adversarialRecords: adversarialRecords(),
      diagnostics: diagnostics(),
      evidenceItems: evidenceItems(),
      runtimeCleanliness: {
        watchdogClean: true,
        runningTaskFlows: 0,
        runningTasks: 0,
        proofRefs: ["runtime-proof"],
      },
      proofRefs: ["cert-proof"],
      decidedAt: NOW,
    });

    expect(decision.decision).toBe("certified_full_gie");
    expect(decision.fullGieCertified).toBe(true);
    expect(decision.failedAdversarialCases).toEqual([]);
    expect(decision.failedDiagnostics).toEqual([]);
    expect(decision.missingEvidenceItems).toEqual([]);
    expect(decision.runtimeBlockers).toEqual([]);
  });
});
