import type { GieMemoryBeforeActionDecision } from "./memory-bucket-runtime.js";
import {
  evaluatePolicyDecision,
  type GiePolicyDecision,
  type GiePolicyInput,
} from "./policy-engine.js";

export const GIE_ROUTE_TYPES = [
  "ai_direct",
  "ai_with_human_review",
  "helper_or_specialist_lane",
  "human_only",
  "hard_stop",
] as const;

export type GieRouteType = (typeof GIE_ROUTE_TYPES)[number];

export type GieRouteScoringInput = {
  risk: number;
  ambiguity: number;
  reversibility: number;
  complianceSafetyImpact: number;
  novelty: number;
  repeatability: number;
  confidence: number;
  costOfFailure: number;
  priorOutcomes: number;
};

export type GieDecisionRouterInput = {
  taskId?: string;
  taskSummary: string;
  ownerLane?: string | null;
  ownerTarget?: string | null;
  proofRefs: string[];
  scoring: GieRouteScoringInput;
  requestedRoute?: GieRouteType;
  specialistLane?: string | null;
  policyInput?: GiePolicyInput;
  receiptRef?: string | null;
  memoryBeforeAction?: GieMemoryBeforeActionDecision | null;
  now?: number;
};

export type GieRouteScoreBreakdown = {
  automationReadiness: number;
  riskPressure: number;
  ambiguityPressure: number;
  compliancePressure: number;
  confidence: number;
};

export type GieRouteDecision = {
  routeType: GieRouteType;
  routeReason: string;
  confidenceScore: number;
  scoringInputs: GieRouteScoringInput;
  scoreBreakdown: GieRouteScoreBreakdown;
  triggeredPolicyRule: string;
  escalationRequirement: "none" | "human_review" | "specialist_lane" | "human_only" | "hard_stop";
  ownerLaneTarget: string | null;
  proofRefsUsed: string[];
  auditReceiptRef: string;
  decisionTimestamp: number;
  validationFindings: string[];
  memoryBeforeAction: GieMemoryBeforeActionDecision | null;
  policyDecision: GiePolicyDecision;
};

const SCORE_KEYS: Array<keyof GieRouteScoringInput> = [
  "risk",
  "ambiguity",
  "reversibility",
  "complianceSafetyImpact",
  "novelty",
  "repeatability",
  "confidence",
  "costOfFailure",
  "priorOutcomes",
];

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function cleanString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanProofRefs(value: string[]): string[] {
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function normalizeScoring(scoring: GieRouteScoringInput): GieRouteScoringInput {
  return {
    risk: clampScore(scoring.risk),
    ambiguity: clampScore(scoring.ambiguity),
    reversibility: clampScore(scoring.reversibility),
    complianceSafetyImpact: clampScore(scoring.complianceSafetyImpact),
    novelty: clampScore(scoring.novelty),
    repeatability: clampScore(scoring.repeatability),
    confidence: clampScore(scoring.confidence),
    costOfFailure: clampScore(scoring.costOfFailure),
    priorOutcomes: clampScore(scoring.priorOutcomes),
  };
}

function findInvalidScoring(scoring: GieRouteScoringInput): string[] {
  const findings: string[] = [];
  for (const key of SCORE_KEYS) {
    const value = scoring[key];
    if (!Number.isFinite(value)) {
      findings.push(`${key}_not_finite`);
    } else if (value < 0 || value > 1) {
      findings.push(`${key}_out_of_range`);
    }
  }
  return findings;
}

function buildScoreBreakdown(scoring: GieRouteScoringInput): GieRouteScoreBreakdown {
  const riskPressure = clampScore(
    scoring.risk * 0.35 +
      scoring.costOfFailure * 0.3 +
      scoring.complianceSafetyImpact * 0.25 +
      (1 - scoring.reversibility) * 0.1,
  );
  const ambiguityPressure = clampScore(
    scoring.ambiguity * 0.55 + scoring.novelty * 0.25 + (1 - scoring.repeatability) * 0.2,
  );
  const compliancePressure = clampScore(
    scoring.complianceSafetyImpact * 0.65 + scoring.costOfFailure * 0.35,
  );
  const confidence = scoring.confidence;
  const automationReadiness = clampScore(
    confidence * 0.35 +
      scoring.repeatability * 0.2 +
      scoring.reversibility * 0.15 +
      scoring.priorOutcomes * 0.15 +
      (1 - riskPressure) * 0.15,
  );
  return {
    automationReadiness,
    riskPressure,
    ambiguityPressure,
    compliancePressure,
    confidence,
  };
}

function routeFromScores(params: {
  scoring: GieRouteScoringInput;
  breakdown: GieRouteScoreBreakdown;
  specialistLane: string;
}): Pick<GieRouteDecision, "routeType" | "routeReason" | "escalationRequirement"> {
  const { scoring, breakdown, specialistLane } = params;
  if (breakdown.compliancePressure >= 0.8 || scoring.costOfFailure >= 0.85) {
    return {
      routeType: "human_only",
      routeReason:
        "High compliance/safety or cost-of-failure pressure requires human-only handling.",
      escalationRequirement: "human_only",
    };
  }
  if (breakdown.riskPressure >= 0.78 || breakdown.ambiguityPressure >= 0.78) {
    return {
      routeType: "ai_with_human_review",
      routeReason: "High risk or ambiguity allows AI support only with human review.",
      escalationRequirement: "human_review",
    };
  }
  if (specialistLane) {
    return {
      routeType: "helper_or_specialist_lane",
      routeReason: "A verified helper or specialist lane is available and appropriate.",
      escalationRequirement: "specialist_lane",
    };
  }
  if (
    breakdown.automationReadiness >= 0.72 &&
    breakdown.riskPressure <= 0.35 &&
    breakdown.ambiguityPressure <= 0.45
  ) {
    return {
      routeType: "ai_direct",
      routeReason:
        "Low risk, low ambiguity, high confidence, and repeatable work supports AI-direct handling.",
      escalationRequirement: "none",
    };
  }
  return {
    routeType: "ai_with_human_review",
    routeReason:
      "Defaulting to human review because automation readiness is not high enough for silent AI-direct routing.",
    escalationRequirement: "human_review",
  };
}

function buildHardStopDecision(params: {
  input: GieDecisionRouterInput;
  scoring: GieRouteScoringInput;
  breakdown: GieRouteScoreBreakdown;
  validationFindings: string[];
  policyDecision: GiePolicyDecision;
  reason: string;
  triggeredRule?: string;
}): GieRouteDecision {
  return {
    memoryBeforeAction: params.input.memoryBeforeAction ?? null,
    routeType: "hard_stop",
    routeReason: params.reason,
    confidenceScore: params.breakdown.confidence,
    scoringInputs: params.scoring,
    scoreBreakdown: params.breakdown,
    triggeredPolicyRule: params.triggeredRule ?? params.policyDecision.triggeredRule,
    escalationRequirement: "hard_stop",
    ownerLaneTarget: null,
    proofRefsUsed: cleanProofRefs([
      ...params.input.proofRefs,
      ...(params.input.memoryBeforeAction?.proofRefsUsed ?? []),
    ]),
    auditReceiptRef: cleanString(params.input.receiptRef) || "gie_decision_router_local_receipt",
    decisionTimestamp: params.input.now ?? Date.now(),
    validationFindings: params.validationFindings,
    policyDecision: params.policyDecision,
  };
}

export function routeGieDecision(input: GieDecisionRouterInput): GieRouteDecision {
  const validationFindings = findInvalidScoring(input.scoring);
  const scoring = normalizeScoring(input.scoring);
  const breakdown = buildScoreBreakdown(scoring);
  const memoryBeforeAction = input.memoryBeforeAction ?? null;
  const proofRefsUsed = cleanProofRefs([
    ...input.proofRefs,
    ...(memoryBeforeAction?.proofRefsUsed ?? []),
  ]);
  const liveProofRefs = cleanProofRefs(input.proofRefs);
  const ownerLane = cleanString(input.ownerLane);
  const ownerTarget = cleanString(input.ownerTarget);
  const specialistLane = cleanString(input.specialistLane);
  const auditReceiptRef = cleanString(input.receiptRef) || "gie_decision_router_local_receipt";
  const ownerLaneTarget = ownerLane && ownerTarget ? `${ownerLane}:${ownerTarget}` : null;

  if (!cleanString(input.taskSummary)) {
    validationFindings.push("missing_task_summary");
  }
  if (liveProofRefs.length === 0) {
    validationFindings.push("missing_proof_refs");
  }
  if (!ownerLaneTarget) {
    validationFindings.push("missing_owner_lane_target");
  }
  if (!memoryBeforeAction) {
    validationFindings.push("memory_before_action_required");
  } else if (!memoryBeforeAction.allowed) {
    validationFindings.push(memoryBeforeAction.reason);
    validationFindings.push(
      ...memoryBeforeAction.blockedPatternRefs.map((ref) => `blocked_pattern:${ref}`),
    );
  }

  const policyDecision = evaluatePolicyDecision({
    action: "governed_dispatch",
    ownerLane,
    ownerTarget,
    proofRefs: liveProofRefs,
    ...input.policyInput,
  });

  if (policyDecision.decision === "hard_stop" || policyDecision.decision === "deny") {
    return buildHardStopDecision({
      input,
      scoring,
      breakdown,
      validationFindings,
      policyDecision,
      reason: policyDecision.reason,
    });
  }

  if (validationFindings.length > 0) {
    return buildHardStopDecision({
      input,
      scoring,
      breakdown,
      validationFindings,
      policyDecision,
      reason: "Decision router input failed contract validation.",
      triggeredRule: validationFindings.some((finding) => finding.includes("memory"))
        ? "memory_before_action_gate"
        : "decision_router_input_contract",
    });
  }

  if (policyDecision.decision === "approval_required") {
    return {
      routeType: "human_only",
      routeReason: policyDecision.reason,
      confidenceScore: breakdown.confidence,
      scoringInputs: scoring,
      scoreBreakdown: breakdown,
      triggeredPolicyRule: policyDecision.triggeredRule,
      escalationRequirement: "human_only",
      ownerLaneTarget,
      proofRefsUsed,
      auditReceiptRef,
      decisionTimestamp: input.now ?? Date.now(),
      validationFindings,
      memoryBeforeAction,
      policyDecision,
    };
  }

  const route = routeFromScores({
    scoring,
    breakdown,
    specialistLane,
  });

  return {
    ...route,
    confidenceScore: breakdown.confidence,
    scoringInputs: scoring,
    scoreBreakdown: breakdown,
    triggeredPolicyRule: policyDecision.triggeredRule,
    ownerLaneTarget,
    proofRefsUsed,
    auditReceiptRef,
    decisionTimestamp: input.now ?? Date.now(),
    validationFindings,
    memoryBeforeAction,
    policyDecision,
  };
}
