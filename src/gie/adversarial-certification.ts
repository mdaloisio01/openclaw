import type { GieRouteDecision } from "./decision-router.js";
import type { GiePolicyDecision } from "./policy-engine.js";

export const GIE_PHASE14_ADVERSARIAL_CASES = [
  "false_completion",
  "bad_routing",
  "missing_owner",
  "stale_memory",
  "bad_promotion",
  "helper_failure",
  "hidden_unresolved_issue",
  "authority_contradiction",
  "policy_bypass_attempt",
  "conflicting_feedback",
  "unsafe_automation_attempt",
  "low_confidence_silent_action",
] as const;

export const GIE_PHASE14_DIAGNOSTIC_CHECKS = [
  "false_completion",
  "unresolved_owner_truth",
  "paper_only_artifacts",
  "route_execution_mismatch",
  "memory_pollution",
  "helper_coordination_failure",
  "promotion_drift",
  "hidden_unresolved_issues",
] as const;

export const GIE_PHASE14_END_STATE_ITEMS = [
  "phase1_policy_engine",
  "phase2_runtime_platform",
  "phase3_decision_router",
  "phase4_contradiction_resolver",
  "phase5_stepwise_execution_runtime",
  "phase6_helper_coordination_runtime",
  "phase7_memory_bucket_runtime",
  "phase8_learning_by_doing_loop",
  "phase9_feedback_correction_governance",
  "phase10_domain_governor_layer",
  "phase11_promotion_rollback_ladder",
  "phase12_operator_control_dashboard",
  "phase13_cross_lane_optimization",
] as const;

export type GiePhase14AdversarialCase = (typeof GIE_PHASE14_ADVERSARIAL_CASES)[number];
export type GiePhase14DiagnosticCheck = (typeof GIE_PHASE14_DIAGNOSTIC_CHECKS)[number];
export type GiePhase14EndStateItem = (typeof GIE_PHASE14_END_STATE_ITEMS)[number];

export type GieAdversarialValidationRecord = {
  caseId: string;
  caseType: GiePhase14AdversarialCase;
  expectedDefense:
    | "hard_stop"
    | "human_escalation"
    | "reopen"
    | "deny"
    | "rollback"
    | "block_silent_action";
  observedDefense: string;
  passed: boolean;
  policyDecisionRef?: string | null;
  routeDecisionRef?: string | null;
  proofRefs: string[];
  evaluatedAt: number;
};

export type GieFinalDiagnosticRecord = {
  checkId: string;
  checkType: GiePhase14DiagnosticCheck;
  passed: boolean;
  finding: string;
  proofRefs: string[];
  evaluatedAt: number;
};

export type GieWholeEvidenceItem = {
  item: GiePhase14EndStateItem;
  phaseReceiptRef: string;
  implementationRefs: string[];
  testRefs: string[];
  proven: boolean;
};

export type GieRuntimeCleanliness = {
  watchdogClean: boolean;
  runningTaskFlows: number;
  runningTasks: number;
  proofRefs: string[];
};

export type GieCertificationDecision = {
  decision: "certified_full_gie" | "blocked";
  reason: string;
  fullGieCertified: boolean;
  failedAdversarialCases: string[];
  failedDiagnostics: string[];
  missingEvidenceItems: GiePhase14EndStateItem[];
  runtimeBlockers: string[];
  proofRefsUsed: string[];
  decidedAt: number;
};

function cleanString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanRefs(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function requireProofRefs(proofRefs: string[], error: string): void {
  if (proofRefs.length === 0) {
    throw new Error(error);
  }
}

function requireTimestamp(value: number, error: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(error);
  }
}

export function createGieAdversarialValidationRecord(params: {
  caseId: string;
  caseType: GiePhase14AdversarialCase;
  expectedDefense: GieAdversarialValidationRecord["expectedDefense"];
  observedDefense: string;
  policyDecision?: GiePolicyDecision | null;
  routeDecision?: GieRouteDecision | null;
  proofRefs: string[];
  evaluatedAt: number;
}): GieAdversarialValidationRecord {
  const proofRefs = cleanRefs([
    ...params.proofRefs,
    ...(params.policyDecision?.proofRefsUsed ?? []),
    ...(params.routeDecision?.proofRefsUsed ?? []),
  ]);
  requireProofRefs(proofRefs, "gie_phase14_adversarial_proof_required");
  const observedDefense = cleanString(params.observedDefense);
  const expectedObserved =
    params.expectedDefense === "block_silent_action" ? "hard_stop" : params.expectedDefense;
  const record: GieAdversarialValidationRecord = {
    caseId: cleanString(params.caseId),
    caseType: params.caseType,
    expectedDefense: params.expectedDefense,
    observedDefense,
    passed: observedDefense === expectedObserved || observedDefense === params.expectedDefense,
    policyDecisionRef: params.policyDecision?.triggeredRule ?? null,
    routeDecisionRef: params.routeDecision?.triggeredPolicyRule ?? null,
    proofRefs,
    evaluatedAt: params.evaluatedAt,
  };
  if (!record.caseId || !GIE_PHASE14_ADVERSARIAL_CASES.includes(record.caseType)) {
    throw new Error("gie_phase14_adversarial_required_fields_missing");
  }
  requireTimestamp(record.evaluatedAt, "gie_phase14_adversarial_timestamp_required");
  return record;
}

export function createGieFinalDiagnosticRecord(params: {
  checkId: string;
  checkType: GiePhase14DiagnosticCheck;
  passed: boolean;
  finding: string;
  proofRefs: string[];
  evaluatedAt: number;
}): GieFinalDiagnosticRecord {
  const proofRefs = cleanRefs(params.proofRefs);
  requireProofRefs(proofRefs, "gie_phase14_diagnostic_proof_required");
  const record: GieFinalDiagnosticRecord = {
    checkId: cleanString(params.checkId),
    checkType: params.checkType,
    passed: params.passed,
    finding: cleanString(params.finding),
    proofRefs,
    evaluatedAt: params.evaluatedAt,
  };
  if (
    !record.checkId ||
    !GIE_PHASE14_DIAGNOSTIC_CHECKS.includes(record.checkType) ||
    !record.finding
  ) {
    throw new Error("gie_phase14_diagnostic_required_fields_missing");
  }
  requireTimestamp(record.evaluatedAt, "gie_phase14_diagnostic_timestamp_required");
  return record;
}

export function createGieWholeEvidenceItem(params: {
  item: GiePhase14EndStateItem;
  phaseReceiptRef: string;
  implementationRefs: string[];
  testRefs: string[];
  proven: boolean;
}): GieWholeEvidenceItem {
  const evidence: GieWholeEvidenceItem = {
    item: params.item,
    phaseReceiptRef: cleanString(params.phaseReceiptRef),
    implementationRefs: cleanRefs(params.implementationRefs),
    testRefs: cleanRefs(params.testRefs),
    proven: params.proven,
  };
  if (
    !GIE_PHASE14_END_STATE_ITEMS.includes(evidence.item) ||
    !evidence.phaseReceiptRef ||
    evidence.implementationRefs.length === 0 ||
    evidence.testRefs.length === 0
  ) {
    throw new Error("gie_phase14_evidence_item_required_fields_missing");
  }
  return evidence;
}

export function evaluateGieFinalCertification(params: {
  adversarialRecords: GieAdversarialValidationRecord[];
  diagnostics: GieFinalDiagnosticRecord[];
  evidenceItems: GieWholeEvidenceItem[];
  runtimeCleanliness: GieRuntimeCleanliness;
  proofRefs: string[];
  decidedAt: number;
}): GieCertificationDecision {
  const adversarialByType = new Map(
    params.adversarialRecords.map((record) => [record.caseType, record]),
  );
  const diagnosticByType = new Map(params.diagnostics.map((record) => [record.checkType, record]));
  const evidenceByItem = new Map(params.evidenceItems.map((record) => [record.item, record]));

  const failedAdversarialCases = GIE_PHASE14_ADVERSARIAL_CASES.filter(
    (caseType) => adversarialByType.get(caseType)?.passed !== true,
  );
  const failedDiagnostics = GIE_PHASE14_DIAGNOSTIC_CHECKS.filter(
    (checkType) => diagnosticByType.get(checkType)?.passed !== true,
  );
  const missingEvidenceItems = GIE_PHASE14_END_STATE_ITEMS.filter(
    (item) => evidenceByItem.get(item)?.proven !== true,
  );
  const runtimeBlockers: string[] = [];
  if (!params.runtimeCleanliness.watchdogClean) {
    runtimeBlockers.push("watchdog_not_clean");
  }
  if (params.runtimeCleanliness.runningTaskFlows !== 0) {
    runtimeBlockers.push("running_taskflows_not_zero");
  }
  if (params.runtimeCleanliness.runningTasks !== 0) {
    runtimeBlockers.push("running_tasks_not_zero");
  }
  const proofRefsUsed = cleanRefs([...params.proofRefs, ...params.runtimeCleanliness.proofRefs]);
  requireProofRefs(proofRefsUsed, "gie_phase14_certification_proof_required");
  requireTimestamp(params.decidedAt, "gie_phase14_certification_timestamp_required");

  if (
    failedAdversarialCases.length ||
    failedDiagnostics.length ||
    missingEvidenceItems.length ||
    runtimeBlockers.length
  ) {
    return {
      decision: "blocked",
      reason:
        "Full GIE certification is blocked until adversarial, diagnostic, evidence, and runtime-cleanliness gates all pass.",
      fullGieCertified: false,
      failedAdversarialCases,
      failedDiagnostics,
      missingEvidenceItems,
      runtimeBlockers,
      proofRefsUsed,
      decidedAt: params.decidedAt,
    };
  }

  return {
    decision: "certified_full_gie",
    reason:
      "Full Governed Intelligence Engine certification passed with all required end-state evidence, adversarial cases, diagnostics, watchdog, and running-task checks clean.",
    fullGieCertified: true,
    failedAdversarialCases: [],
    failedDiagnostics: [],
    missingEvidenceItems: [],
    runtimeBlockers: [],
    proofRefsUsed,
    decidedAt: params.decidedAt,
  };
}
