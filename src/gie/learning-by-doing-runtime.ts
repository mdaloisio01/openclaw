import { createGieMemoryRecord, type GieMemoryRecord } from "./memory-bucket-runtime.js";

export const GIE_LEARNING_LOOP_STAGES = [
  "task_runs",
  "result_checked",
  "success_logged",
  "failure_logged",
  "failure_analyzed",
  "better_move_attempted",
  "retested",
  "successful_path_stored",
  "unresolved_failure_escalated",
] as const;

export type GieLearningLoopStage = (typeof GIE_LEARNING_LOOP_STAGES)[number];
export type GieLearningResult = "success" | "failure" | "unresolved";
export type GieLearningFailureMode =
  | "bad_route"
  | "wrong_fix"
  | "missing_proof"
  | "stale_memory"
  | "policy_denied"
  | "helper_failed"
  | "retest_needed"
  | "unknown";

export type GieLearningEvent = {
  eventId: string;
  taskRef: string;
  outcomeRef: string;
  stage: GieLearningLoopStage;
  result: GieLearningResult;
  summary: string;
  ownerLane: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
};

export type GieFailureAnalysisRecord = {
  analysisId: string;
  failureEventRef: string;
  failureMode: GieLearningFailureMode;
  rootCause: string;
  betterMove: string;
  mutationRequested: boolean;
  mutationGuard: GieNoSilentMutationDecision;
  authorityRef: string;
  proofRefs: string[];
  analyzedAt: number;
};

export type GieBetterMoveAttempt = {
  attemptId: string;
  analysisRef: string;
  attemptedMove: string;
  expectedImprovement: string;
  mutationApplied: false;
  authorityRef: string;
  proofRefs: string[];
  attemptedAt: number;
};

export type GiePassedLearningRetestRecord = {
  retestId: string;
  attemptRef: string;
  retestResult: "pass";
  retestProofRefs: string[];
  authorityRef: string;
  retestedAt: number;
  escalation: null;
};

export type GieFailedLearningRetestRecord = {
  retestId: string;
  attemptRef: string;
  retestResult: "fail";
  retestProofRefs: string[];
  authorityRef: string;
  retestedAt: number;
  escalation: GieLearningEscalation & {
    escalated: true;
    reason: "unresolved_failure_after_retest";
    unresolvedFailureRef: string;
  };
};

export type GieLearningRetestRecord = GiePassedLearningRetestRecord | GieFailedLearningRetestRecord;

export type GieReusableExperienceRecord = {
  experienceId: string;
  subjectKey: string;
  retestRef: string;
  summary: string;
  memoryRecord: GieMemoryRecord;
  storedAt: number;
};

export type GieLearningEscalation = {
  escalated: boolean;
  reason: "unresolved_failure_after_retest" | "no_escalation_required";
  unresolvedFailureRef: string | null;
  authorityRef: string;
  proofRefs: string[];
  escalatedAt: number;
};

export type GieNoSilentMutationDecision = {
  allowed: boolean;
  reason: "no_mutation_requested" | "mutation_requires_explicit_approval" | "mutation_approved";
  approvalRefs: string[];
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

function requireFiniteTimestamp(value: number, error: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(error);
  }
}

function requireRefs(value: string[], error: string): void {
  if (value.length === 0) {
    throw new Error(error);
  }
}

export function evaluateNoSilentMutationGuard(params: {
  mutationRequested: boolean;
  approvalRefs: string[];
}): GieNoSilentMutationDecision {
  const approvalRefs = cleanRefs(params.approvalRefs);
  if (!params.mutationRequested) {
    return {
      allowed: true,
      reason: "no_mutation_requested",
      approvalRefs,
    };
  }
  if (approvalRefs.length === 0) {
    return {
      allowed: false,
      reason: "mutation_requires_explicit_approval",
      approvalRefs,
    };
  }
  return {
    allowed: true,
    reason: "mutation_approved",
    approvalRefs,
  };
}

export function createGieLearningEvent(params: {
  eventId: string;
  taskRef: string;
  outcomeRef: string;
  stage: GieLearningLoopStage;
  result: GieLearningResult;
  summary: string;
  ownerLane: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GieLearningEvent {
  const event: GieLearningEvent = {
    eventId: cleanString(params.eventId),
    taskRef: cleanString(params.taskRef),
    outcomeRef: cleanString(params.outcomeRef),
    stage: params.stage,
    result: params.result,
    summary: cleanString(params.summary),
    ownerLane: cleanString(params.ownerLane),
    authorityRef: cleanString(params.authorityRef),
    proofRefs: cleanRefs(params.proofRefs),
    createdAt: params.createdAt,
  };
  if (
    !event.eventId ||
    !event.taskRef ||
    !event.outcomeRef ||
    !GIE_LEARNING_LOOP_STAGES.includes(event.stage) ||
    !event.summary ||
    !event.ownerLane ||
    !event.authorityRef ||
    event.proofRefs.length === 0
  ) {
    throw new Error("gie_learning_event_required_fields_missing");
  }
  requireFiniteTimestamp(event.createdAt, "gie_learning_event_timestamp_required");
  return event;
}

export function analyzeGieLearningFailure(params: {
  analysisId: string;
  failureEvent: GieLearningEvent;
  failureMode: GieLearningFailureMode;
  rootCause: string;
  betterMove: string;
  mutationRequested: boolean;
  approvalRefs?: string[];
  authorityRef: string;
  proofRefs: string[];
  analyzedAt: number;
}): GieFailureAnalysisRecord {
  if (params.failureEvent.result !== "failure" && params.failureEvent.result !== "unresolved") {
    throw new Error("gie_learning_failure_event_required");
  }
  const mutationGuard = evaluateNoSilentMutationGuard({
    mutationRequested: params.mutationRequested,
    approvalRefs: params.approvalRefs ?? [],
  });
  if (!mutationGuard.allowed) {
    throw new Error("gie_learning_silent_mutation_blocked");
  }
  const proofRefs = cleanRefs([
    ...params.failureEvent.proofRefs,
    ...params.proofRefs,
    ...mutationGuard.approvalRefs,
  ]);
  requireRefs(proofRefs, "gie_learning_failure_analysis_proof_required");
  const analysis: GieFailureAnalysisRecord = {
    analysisId: cleanString(params.analysisId),
    failureEventRef: params.failureEvent.eventId,
    failureMode: params.failureMode,
    rootCause: cleanString(params.rootCause),
    betterMove: cleanString(params.betterMove),
    mutationRequested: params.mutationRequested,
    mutationGuard,
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    analyzedAt: params.analyzedAt,
  };
  if (
    !analysis.analysisId ||
    !analysis.rootCause ||
    !analysis.betterMove ||
    !analysis.authorityRef
  ) {
    throw new Error("gie_learning_failure_analysis_required_fields_missing");
  }
  requireFiniteTimestamp(analysis.analyzedAt, "gie_learning_failure_analysis_timestamp_required");
  return analysis;
}

export function attemptBetterGieMove(params: {
  attemptId: string;
  analysis: GieFailureAnalysisRecord;
  attemptedMove: string;
  expectedImprovement: string;
  authorityRef: string;
  proofRefs: string[];
  attemptedAt: number;
}): GieBetterMoveAttempt {
  const proofRefs = cleanRefs([...params.analysis.proofRefs, ...params.proofRefs]);
  requireRefs(proofRefs, "gie_learning_attempt_proof_required");
  const attempt: GieBetterMoveAttempt = {
    attemptId: cleanString(params.attemptId),
    analysisRef: params.analysis.analysisId,
    attemptedMove: cleanString(params.attemptedMove),
    expectedImprovement: cleanString(params.expectedImprovement),
    mutationApplied: false,
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    attemptedAt: params.attemptedAt,
  };
  if (
    !attempt.attemptId ||
    !attempt.analysisRef ||
    !attempt.attemptedMove ||
    !attempt.expectedImprovement ||
    !attempt.authorityRef
  ) {
    throw new Error("gie_learning_attempt_required_fields_missing");
  }
  requireFiniteTimestamp(attempt.attemptedAt, "gie_learning_attempt_timestamp_required");
  return attempt;
}

export function retestGieLearningAttempt(params: {
  retestId: string;
  attempt: GieBetterMoveAttempt;
  retestResult: "pass" | "fail";
  retestProofRefs: string[];
  authorityRef: string;
  unresolvedFailureRef?: string | null;
  retestedAt: number;
}): GieLearningRetestRecord {
  const retestProofRefs = cleanRefs([...params.attempt.proofRefs, ...params.retestProofRefs]);
  requireRefs(retestProofRefs, "gie_learning_retest_proof_required");
  const authorityRef = cleanString(params.authorityRef);
  const escalation =
    params.retestResult === "fail"
      ? evaluateGieLearningEscalation({
          retestResult: "fail",
          unresolvedFailureRef: cleanString(params.unresolvedFailureRef),
          authorityRef,
          proofRefs: retestProofRefs,
          escalatedAt: params.retestedAt,
        })
      : null;
  const base = {
    retestId: cleanString(params.retestId),
    attemptRef: params.attempt.attemptId,
    retestProofRefs,
    authorityRef,
    retestedAt: params.retestedAt,
  };
  if (!base.retestId || !base.attemptRef || !base.authorityRef) {
    throw new Error("gie_learning_retest_required_fields_missing");
  }
  requireFiniteTimestamp(base.retestedAt, "gie_learning_retest_timestamp_required");
  if (params.retestResult === "fail") {
    return {
      ...base,
      retestResult: "fail",
      escalation: escalation as GieFailedLearningRetestRecord["escalation"],
    };
  }
  return {
    ...base,
    retestResult: "pass",
    escalation: null,
  };
}

export function createGieReusableExperience(params: {
  experienceId: string;
  subjectKey: string;
  retest: GieLearningRetestRecord;
  summary: string;
  authorityRef: string;
  storedAt: number;
}): GieReusableExperienceRecord {
  const experienceId = cleanString(params.experienceId);
  const subjectKey = cleanString(params.subjectKey);
  const summary = cleanString(params.summary);
  const authorityRef = cleanString(params.authorityRef);
  if (params.retest.retestResult !== "pass") {
    throw new Error("gie_learning_successful_retest_required");
  }
  const memoryRecord = createGieMemoryRecord({
    recordId: experienceId,
    bucket: "approved_best_practices",
    subjectKey,
    summary,
    confidence: 0.85,
    sourceRef: params.retest.retestId,
    authorityRef,
    proofRefs: params.retest.retestProofRefs,
    updatedAt: params.storedAt,
  });
  return {
    experienceId,
    subjectKey,
    retestRef: params.retest.retestId,
    summary,
    memoryRecord,
    storedAt: params.storedAt,
  };
}

export function evaluateGieLearningEscalation(params: {
  retestResult: "pass" | "fail";
  unresolvedFailureRef: string;
  authorityRef: string;
  proofRefs: string[];
  escalatedAt: number;
}): GieLearningEscalation {
  const proofRefs = cleanRefs(params.proofRefs);
  const authorityRef = cleanString(params.authorityRef);
  requireRefs(proofRefs, "gie_learning_escalation_proof_required");
  requireFiniteTimestamp(params.escalatedAt, "gie_learning_escalation_timestamp_required");
  if (params.retestResult === "fail") {
    const unresolvedFailureRef = cleanString(params.unresolvedFailureRef);
    if (!unresolvedFailureRef || !authorityRef) {
      throw new Error(
        !unresolvedFailureRef
          ? "gie_learning_failed_retest_escalation_required"
          : "gie_learning_escalation_required_fields_missing",
      );
    }
    return {
      escalated: true,
      reason: "unresolved_failure_after_retest",
      unresolvedFailureRef,
      authorityRef,
      proofRefs,
      escalatedAt: params.escalatedAt,
    };
  }
  return {
    escalated: false,
    reason: "no_escalation_required",
    unresolvedFailureRef: null,
    authorityRef,
    proofRefs,
    escalatedAt: params.escalatedAt,
  };
}
