export type GieLaneOutcomeResult = "success" | "failure" | "blocked";
export type GieRecurringIssueClass =
  | "bad_route"
  | "missing_proof"
  | "helper_failure"
  | "stale_memory"
  | "policy_conflict"
  | "unknown";
export type GieAdaptationCandidateType =
  | "reusable_strategy"
  | "priority_tuning"
  | "resource_tuning"
  | "boundary_review";

export type GieCrossLaneOutcome = {
  outcomeId: string;
  laneId: string;
  domainId: string;
  patternKey: string;
  result: GieLaneOutcomeResult;
  confidence: number;
  durationMs: number;
  resourceCost: number;
  authorityRef: string;
  proofRefs: string[];
  recordedAt: number;
};

export type GieCrossLanePattern = {
  patternId: string;
  patternKey: string;
  laneIds: string[];
  domainIds: string[];
  occurrenceCount: number;
  successCount: number;
  failureCount: number;
  averageConfidence: number;
  authorityRef: string;
  proofRefs: string[];
  detectedAt: number;
};

export type GieRecurringIssue = {
  issueId: string;
  issueClass: GieRecurringIssueClass;
  patternRef: string;
  affectedLaneIds: string[];
  failureCount: number;
  summary: string;
  authorityRef: string;
  proofRefs: string[];
  classifiedAt: number;
};

export type GieLocalGlobalBoundaryDecision = {
  allowed: boolean;
  reason:
    | "same_lane_or_domain"
    | "lawful_promotion_or_boundary_review_required"
    | "promotion_ref_present";
  sourceLaneId: string;
  targetLaneId: string;
  proofRefsUsed: string[];
};

export type GieAdaptationCandidate = {
  candidateId: string;
  candidateType: GieAdaptationCandidateType;
  sourcePatternRef: string;
  targetLaneIds: string[];
  recommendation: string;
  boundaryDecision: GieLocalGlobalBoundaryDecision;
  applicationStatus: "candidate_only_not_applied";
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
};

export type GiePerformanceTrend = {
  trendId: string;
  patternKey: string;
  sampleCount: number;
  averageConfidence: number;
  averageDurationMs: number;
  averageResourceCost: number;
  trendDirection: "improving" | "declining" | "flat";
  authorityRef: string;
  proofRefs: string[];
  calculatedAt: number;
};

export type GieTuningSignal = {
  signalId: string;
  signalType: "priority" | "resource";
  sourceTrendRef: string;
  targetLaneId: string;
  recommendation: string;
  applicationStatus: "signal_only_not_applied";
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
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

function requireTimestamp(value: number, error: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(error);
  }
}

function requireRefs(value: string[], error: string): void {
  if (value.length === 0) {
    throw new Error(error);
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

export function createGieCrossLaneOutcome(params: {
  outcomeId: string;
  laneId: string;
  domainId: string;
  patternKey: string;
  result: GieLaneOutcomeResult;
  confidence: number;
  durationMs: number;
  resourceCost: number;
  authorityRef: string;
  proofRefs: string[];
  recordedAt: number;
}): GieCrossLaneOutcome {
  const proofRefs = cleanRefs(params.proofRefs);
  requireRefs(proofRefs, "gie_cross_lane_outcome_proof_required");
  const outcome: GieCrossLaneOutcome = {
    outcomeId: cleanString(params.outcomeId),
    laneId: cleanString(params.laneId),
    domainId: cleanString(params.domainId),
    patternKey: cleanString(params.patternKey),
    result: params.result,
    confidence: clamp01(params.confidence),
    durationMs: params.durationMs,
    resourceCost: params.resourceCost,
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    recordedAt: params.recordedAt,
  };
  if (
    !outcome.outcomeId ||
    !outcome.laneId ||
    !outcome.domainId ||
    !outcome.patternKey ||
    !outcome.authorityRef
  ) {
    throw new Error("gie_cross_lane_outcome_required_fields_missing");
  }
  requireTimestamp(outcome.recordedAt, "gie_cross_lane_outcome_timestamp_required");
  return outcome;
}

export function detectGieCrossLanePattern(params: {
  patternId: string;
  outcomes: GieCrossLaneOutcome[];
  patternKey: string;
  authorityRef: string;
  proofRefs: string[];
  detectedAt: number;
}): GieCrossLanePattern {
  const matching = params.outcomes.filter((outcome) => outcome.patternKey === params.patternKey);
  const laneIds = [...new Set(matching.map((outcome) => outcome.laneId))];
  if (laneIds.length < 2 || matching.length < 2) {
    throw new Error("gie_cross_lane_pattern_requires_repeated_cross_lane_outcomes");
  }
  const proofRefs = cleanRefs([
    ...params.proofRefs,
    ...matching.flatMap((outcome) => outcome.proofRefs),
  ]);
  requireRefs(proofRefs, "gie_cross_lane_pattern_proof_required");
  const successCount = matching.filter((outcome) => outcome.result === "success").length;
  const failureCount = matching.filter((outcome) => outcome.result !== "success").length;
  const pattern: GieCrossLanePattern = {
    patternId: cleanString(params.patternId),
    patternKey: cleanString(params.patternKey),
    laneIds,
    domainIds: [...new Set(matching.map((outcome) => outcome.domainId))],
    occurrenceCount: matching.length,
    successCount,
    failureCount,
    averageConfidence: clamp01(
      matching.reduce((sum, outcome) => sum + outcome.confidence, 0) / matching.length,
    ),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    detectedAt: params.detectedAt,
  };
  if (!pattern.patternId || !pattern.authorityRef) {
    throw new Error("gie_cross_lane_pattern_required_fields_missing");
  }
  requireTimestamp(pattern.detectedAt, "gie_cross_lane_pattern_timestamp_required");
  return pattern;
}

export function classifyGieRecurringIssue(params: {
  issueId: string;
  pattern: GieCrossLanePattern;
  issueClass: GieRecurringIssueClass;
  summary: string;
  authorityRef: string;
  proofRefs: string[];
  classifiedAt: number;
}): GieRecurringIssue {
  if (params.pattern.failureCount < 2) {
    throw new Error("gie_recurring_issue_requires_repeated_failures");
  }
  const proofRefs = cleanRefs([...params.pattern.proofRefs, ...params.proofRefs]);
  requireRefs(proofRefs, "gie_recurring_issue_proof_required");
  const issue: GieRecurringIssue = {
    issueId: cleanString(params.issueId),
    issueClass: params.issueClass,
    patternRef: params.pattern.patternId,
    affectedLaneIds: params.pattern.laneIds,
    failureCount: params.pattern.failureCount,
    summary: cleanString(params.summary),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    classifiedAt: params.classifiedAt,
  };
  if (!issue.issueId || !issue.summary || !issue.authorityRef) {
    throw new Error("gie_recurring_issue_required_fields_missing");
  }
  requireTimestamp(issue.classifiedAt, "gie_recurring_issue_timestamp_required");
  return issue;
}

export function evaluateGieLocalGlobalOptimizationBoundary(params: {
  sourceLaneId: string;
  targetLaneId: string;
  proofRefs: string[];
  promotionOrBoundaryReviewRef?: string | null;
}): GieLocalGlobalBoundaryDecision {
  const sourceLaneId = cleanString(params.sourceLaneId);
  const targetLaneId = cleanString(params.targetLaneId);
  const promotionRef = cleanString(params.promotionOrBoundaryReviewRef ?? "");
  const proofRefsUsed = cleanRefs([...params.proofRefs, promotionRef]);
  if (sourceLaneId === targetLaneId) {
    return {
      allowed: true,
      reason: "same_lane_or_domain",
      sourceLaneId,
      targetLaneId,
      proofRefsUsed,
    };
  }
  if (!promotionRef) {
    return {
      allowed: false,
      reason: "lawful_promotion_or_boundary_review_required",
      sourceLaneId,
      targetLaneId,
      proofRefsUsed,
    };
  }
  return {
    allowed: true,
    reason: "promotion_ref_present",
    sourceLaneId,
    targetLaneId,
    proofRefsUsed,
  };
}

export function createGieAdaptationCandidate(params: {
  candidateId: string;
  candidateType: GieAdaptationCandidateType;
  pattern: GieCrossLanePattern;
  sourceLaneId: string;
  targetLaneIds: string[];
  recommendation: string;
  promotionOrBoundaryReviewRef?: string | null;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GieAdaptationCandidate {
  const targetLaneIds = cleanRefs(params.targetLaneIds);
  requireRefs(targetLaneIds, "gie_adaptation_candidate_target_lanes_required");
  const boundaryDecision = evaluateGieLocalGlobalOptimizationBoundary({
    sourceLaneId: params.sourceLaneId,
    targetLaneId: targetLaneIds[0],
    proofRefs: params.proofRefs,
    promotionOrBoundaryReviewRef: params.promotionOrBoundaryReviewRef ?? null,
  });
  if (!boundaryDecision.allowed) {
    throw new Error("gie_adaptation_candidate_boundary_review_required");
  }
  const proofRefs = cleanRefs([
    ...params.pattern.proofRefs,
    ...params.proofRefs,
    ...boundaryDecision.proofRefsUsed,
  ]);
  requireRefs(proofRefs, "gie_adaptation_candidate_proof_required");
  const candidate: GieAdaptationCandidate = {
    candidateId: cleanString(params.candidateId),
    candidateType: params.candidateType,
    sourcePatternRef: params.pattern.patternId,
    targetLaneIds,
    recommendation: cleanString(params.recommendation),
    boundaryDecision,
    applicationStatus: "candidate_only_not_applied",
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    createdAt: params.createdAt,
  };
  if (!candidate.candidateId || !candidate.recommendation || !candidate.authorityRef) {
    throw new Error("gie_adaptation_candidate_required_fields_missing");
  }
  requireTimestamp(candidate.createdAt, "gie_adaptation_candidate_timestamp_required");
  return candidate;
}

export function calculateGiePerformanceTrend(params: {
  trendId: string;
  outcomes: GieCrossLaneOutcome[];
  patternKey: string;
  authorityRef: string;
  proofRefs: string[];
  calculatedAt: number;
}): GiePerformanceTrend {
  const matching = params.outcomes.filter((outcome) => outcome.patternKey === params.patternKey);
  if (matching.length < 2) {
    throw new Error("gie_performance_trend_requires_multiple_samples");
  }
  const firstHalf = matching.slice(0, Math.floor(matching.length / 2));
  const secondHalf = matching.slice(Math.floor(matching.length / 2));
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const firstConfidence = avg(firstHalf.map((outcome) => outcome.confidence));
  const secondConfidence = avg(secondHalf.map((outcome) => outcome.confidence));
  const proofRefs = cleanRefs([
    ...params.proofRefs,
    ...matching.flatMap((outcome) => outcome.proofRefs),
  ]);
  requireRefs(proofRefs, "gie_performance_trend_proof_required");
  return {
    trendId: cleanString(params.trendId),
    patternKey: cleanString(params.patternKey),
    sampleCount: matching.length,
    averageConfidence: clamp01(avg(matching.map((outcome) => outcome.confidence))),
    averageDurationMs: avg(matching.map((outcome) => outcome.durationMs)),
    averageResourceCost: avg(matching.map((outcome) => outcome.resourceCost)),
    trendDirection:
      secondConfidence > firstConfidence
        ? "improving"
        : secondConfidence < firstConfidence
          ? "declining"
          : "flat",
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    calculatedAt: params.calculatedAt,
  };
}

export function createGieTuningSignal(params: {
  signalId: string;
  signalType: "priority" | "resource";
  trend: GiePerformanceTrend;
  targetLaneId: string;
  recommendation: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GieTuningSignal {
  const proofRefs = cleanRefs([...params.trend.proofRefs, ...params.proofRefs]);
  requireRefs(proofRefs, "gie_tuning_signal_proof_required");
  const signal: GieTuningSignal = {
    signalId: cleanString(params.signalId),
    signalType: params.signalType,
    sourceTrendRef: params.trend.trendId,
    targetLaneId: cleanString(params.targetLaneId),
    recommendation: cleanString(params.recommendation),
    applicationStatus: "signal_only_not_applied",
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    createdAt: params.createdAt,
  };
  if (!signal.signalId || !signal.targetLaneId || !signal.recommendation || !signal.authorityRef) {
    throw new Error("gie_tuning_signal_required_fields_missing");
  }
  requireTimestamp(signal.createdAt, "gie_tuning_signal_timestamp_required");
  return signal;
}
