import {
  createGieLearningEvent,
  createGieReusableExperience,
  retestGieLearningAttempt,
  type GieLearningFailureMode,
  type GieReusableExperienceRecord,
} from "./learning-by-doing-runtime.js";
import { createGieMemoryRecord, type GieMemoryRecord } from "./memory-bucket-runtime.js";
import { evaluatePolicyDecision, type GiePolicyDecision } from "./policy-engine.js";

export const GIE_FEEDBACK_CLASSIFICATIONS = [
  "good",
  "bad",
  "incomplete",
  "unsafe",
  "wrong_route",
  "wrong_fix",
  "correct_outcome_bad_process",
  "correct_process_bad_outcome",
] as const;

export type GieFeedbackClassification = (typeof GIE_FEEDBACK_CLASSIFICATIONS)[number];
export type GieFeedbackSource =
  | "mark"
  | "operator"
  | "governance"
  | "verification"
  | "security"
  | "lane_owner";
export type GieCorrectionChangeScope =
  | "routing_behavior"
  | "fix_behavior"
  | "process_behavior"
  | "memory_behavior"
  | "doctrine_behavior";
export type GieCorrectionApprovalStatus = "pending" | "approved" | "rejected";

export type GieFeedbackRecord = {
  feedbackId: string;
  source: GieFeedbackSource;
  classification: GieFeedbackClassification;
  targetRef: string;
  summary: string;
  authorityRef: string;
  proofRefs: string[];
  receivedAt: number;
};

export type GieCorrectionNote = {
  correctionId: string;
  feedbackRef: string;
  classification: GieFeedbackClassification;
  proposedChange: string;
  changeScope: GieCorrectionChangeScope;
  doctrineMutationRequested: boolean;
  doctrineApprovalRefs: string[];
  approvalStatus: "pending";
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
};

export type GieCorrectionApproval = {
  correctionId: string;
  feedbackRef: string;
  classification: GieFeedbackClassification;
  approvalStatus: "approved";
  policyDecision: GiePolicyDecision;
  approver: string;
  approvalRef: string;
  authorityRef: string;
  proofRefs: string[];
  approvedAt: number;
};

export type GieCorrectionRejection = {
  correctionId: string;
  feedbackRef: string;
  classification: GieFeedbackClassification;
  approvalStatus: "rejected";
  rejector: string;
  rejectionReason: string;
  rejectionHandling: "do_not_apply_or_learn";
  authorityRef: string;
  proofRefs: string[];
  rejectedAt: number;
};

export type GieCorrectionDecision = GieCorrectionApproval | GieCorrectionRejection;

export type GieFeedbackLearningCandidate = {
  learningCandidateId: string;
  feedbackRef: string;
  correctionRef: string;
  learningSubjectKey: string;
  expectedBehaviorChange: string;
  failureMode: GieLearningFailureMode;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
};

export type GieFeedbackRollback = {
  rollbackId: string;
  correctionRef: string;
  feedbackRef: string;
  approvalRef: string;
  rollbackStatus: "rolled_back";
  reason: string;
  rollbackRef: string;
  authorityRef: string;
  proofRefs: string[];
  rolledBackAt: number;
};

export type GieFeedbackChangeTrail = {
  trailId: string;
  changedBecauseOfFeedbackRef: string;
  correctionRef: string;
  changedRefs: string[];
  behaviorBefore: string;
  behaviorAfter: string;
  authorityRef: string;
  proofRefs: string[];
  recordedAt: number;
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

function failureModeForClassification(
  classification: GieFeedbackClassification,
): GieLearningFailureMode {
  switch (classification) {
    case "wrong_route":
      return "bad_route";
    case "wrong_fix":
      return "wrong_fix";
    case "incomplete":
      return "missing_proof";
    case "unsafe":
      return "policy_denied";
    case "correct_outcome_bad_process":
    case "correct_process_bad_outcome":
    case "bad":
      return "unknown";
    case "good":
      return "retest_needed";
  }
}

export function createGieFeedbackRecord(params: {
  feedbackId: string;
  source: GieFeedbackSource;
  classification: GieFeedbackClassification;
  targetRef: string;
  summary: string;
  authorityRef: string;
  proofRefs: string[];
  receivedAt: number;
}): GieFeedbackRecord {
  const record: GieFeedbackRecord = {
    feedbackId: cleanString(params.feedbackId),
    source: params.source,
    classification: params.classification,
    targetRef: cleanString(params.targetRef),
    summary: cleanString(params.summary),
    authorityRef: cleanString(params.authorityRef),
    proofRefs: cleanRefs(params.proofRefs),
    receivedAt: params.receivedAt,
  };
  if (
    !record.feedbackId ||
    !record.source ||
    !GIE_FEEDBACK_CLASSIFICATIONS.includes(record.classification) ||
    !record.targetRef ||
    !record.summary ||
    !record.authorityRef ||
    record.proofRefs.length === 0
  ) {
    throw new Error("gie_feedback_required_fields_missing");
  }
  requireTimestamp(record.receivedAt, "gie_feedback_timestamp_required");
  return record;
}

export function createGieCorrectionNote(params: {
  correctionId: string;
  feedback: GieFeedbackRecord;
  proposedChange: string;
  changeScope: GieCorrectionChangeScope;
  doctrineMutationRequested: boolean;
  doctrineApprovalRefs?: string[];
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GieCorrectionNote {
  const doctrineApprovalRefs = cleanRefs(params.doctrineApprovalRefs ?? []);
  if (
    (params.doctrineMutationRequested || params.changeScope === "doctrine_behavior") &&
    doctrineApprovalRefs.length === 0
  ) {
    throw new Error("gie_feedback_doctrine_mutation_requires_approval");
  }
  const proofRefs = cleanRefs([
    ...params.feedback.proofRefs,
    ...params.proofRefs,
    ...doctrineApprovalRefs,
  ]);
  requireRefs(proofRefs, "gie_correction_note_proof_required");
  const note: GieCorrectionNote = {
    correctionId: cleanString(params.correctionId),
    feedbackRef: params.feedback.feedbackId,
    classification: params.feedback.classification,
    proposedChange: cleanString(params.proposedChange),
    changeScope: params.changeScope,
    doctrineMutationRequested: params.doctrineMutationRequested,
    doctrineApprovalRefs,
    approvalStatus: "pending",
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    createdAt: params.createdAt,
  };
  if (
    !note.correctionId ||
    !note.feedbackRef ||
    !note.proposedChange ||
    !note.changeScope ||
    !note.authorityRef
  ) {
    throw new Error("gie_correction_note_required_fields_missing");
  }
  requireTimestamp(note.createdAt, "gie_correction_note_timestamp_required");
  return note;
}

export function approveGieCorrection(params: {
  correction: GieCorrectionNote;
  approver: string;
  approvalRef: string;
  authorityRef: string;
  approvedAt: number;
}): GieCorrectionApproval {
  const approvalRef = cleanString(params.approvalRef);
  if (!approvalRef) {
    throw new Error("gie_correction_approval_ref_required");
  }
  const policyDecision = evaluatePolicyDecision({
    action: "feedback_correction_approval",
    ownerLane: "governance",
    ownerTarget: cleanString(params.approver),
    proofRefs: cleanRefs([...params.correction.proofRefs, approvalRef]),
    approvalRef,
    authorityChange:
      params.correction.doctrineMutationRequested ||
      params.correction.changeScope === "doctrine_behavior",
  });
  if (policyDecision.decision === "deny" || policyDecision.decision === "hard_stop") {
    throw new Error(`gie_correction_policy_blocked:${policyDecision.triggeredRule}`);
  }
  const approval: GieCorrectionApproval = {
    correctionId: params.correction.correctionId,
    feedbackRef: params.correction.feedbackRef,
    classification: params.correction.classification,
    approvalStatus: "approved",
    policyDecision,
    approver: cleanString(params.approver),
    approvalRef,
    authorityRef: cleanString(params.authorityRef),
    proofRefs: cleanRefs([...params.correction.proofRefs, approvalRef]),
    approvedAt: params.approvedAt,
  };
  if (!approval.approver || !approval.authorityRef || approval.proofRefs.length === 0) {
    throw new Error("gie_correction_approval_required_fields_missing");
  }
  requireTimestamp(approval.approvedAt, "gie_correction_approval_timestamp_required");
  return approval;
}

export function rejectGieCorrection(params: {
  correction: GieCorrectionNote;
  rejector: string;
  rejectionReason: string;
  authorityRef: string;
  proofRefs: string[];
  rejectedAt: number;
}): GieCorrectionRejection {
  const proofRefs = cleanRefs([...params.correction.proofRefs, ...params.proofRefs]);
  requireRefs(proofRefs, "gie_correction_rejection_proof_required");
  const rejection: GieCorrectionRejection = {
    correctionId: params.correction.correctionId,
    feedbackRef: params.correction.feedbackRef,
    classification: params.correction.classification,
    approvalStatus: "rejected",
    rejector: cleanString(params.rejector),
    rejectionReason: cleanString(params.rejectionReason),
    rejectionHandling: "do_not_apply_or_learn",
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    rejectedAt: params.rejectedAt,
  };
  if (!rejection.rejector || !rejection.rejectionReason || !rejection.authorityRef) {
    throw new Error("gie_correction_rejection_required_fields_missing");
  }
  requireTimestamp(rejection.rejectedAt, "gie_correction_rejection_timestamp_required");
  return rejection;
}

export function buildGieFeedbackLearningCandidate(params: {
  approval: GieCorrectionDecision;
  candidateId: string;
  learningSubjectKey: string;
  expectedBehaviorChange: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GieFeedbackLearningCandidate {
  if (params.approval.approvalStatus !== "approved") {
    throw new Error("gie_feedback_approved_correction_required");
  }
  const proofRefs = cleanRefs([...params.approval.proofRefs, ...params.proofRefs]);
  requireRefs(proofRefs, "gie_feedback_learning_candidate_proof_required");
  const candidate: GieFeedbackLearningCandidate = {
    learningCandidateId: cleanString(params.candidateId),
    feedbackRef: params.approval.feedbackRef,
    correctionRef: params.approval.correctionId,
    learningSubjectKey: cleanString(params.learningSubjectKey),
    expectedBehaviorChange: cleanString(params.expectedBehaviorChange),
    failureMode: failureModeForClassification(params.approval.classification),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    createdAt: params.createdAt,
  };
  if (
    !candidate.learningCandidateId ||
    !candidate.learningSubjectKey ||
    !candidate.expectedBehaviorChange ||
    !candidate.authorityRef
  ) {
    throw new Error("gie_feedback_learning_candidate_required_fields_missing");
  }
  requireTimestamp(candidate.createdAt, "gie_feedback_learning_candidate_timestamp_required");
  return candidate;
}

export function createGieFeedbackRollback(params: {
  rollbackId: string;
  approval: GieCorrectionApproval;
  reason: string;
  rollbackRef: string;
  authorityRef: string;
  proofRefs: string[];
  rolledBackAt: number;
}): GieFeedbackRollback {
  const rollbackRef = cleanString(params.rollbackRef);
  const proofRefs = cleanRefs([...params.approval.proofRefs, ...params.proofRefs, rollbackRef]);
  requireRefs(proofRefs, "gie_feedback_rollback_proof_required");
  const rollback: GieFeedbackRollback = {
    rollbackId: cleanString(params.rollbackId),
    correctionRef: params.approval.correctionId,
    feedbackRef: params.approval.feedbackRef,
    approvalRef: params.approval.approvalRef,
    rollbackStatus: "rolled_back",
    reason: cleanString(params.reason),
    rollbackRef,
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    rolledBackAt: params.rolledBackAt,
  };
  if (!rollback.rollbackId || !rollback.reason || !rollback.rollbackRef || !rollback.authorityRef) {
    throw new Error("gie_feedback_rollback_required_fields_missing");
  }
  requireTimestamp(rollback.rolledBackAt, "gie_feedback_rollback_timestamp_required");
  return rollback;
}

export function recordGieFeedbackChangeTrail(params: {
  trailId: string;
  approval: GieCorrectionApproval;
  changedRefs: string[];
  behaviorBefore: string;
  behaviorAfter: string;
  authorityRef: string;
  proofRefs: string[];
  recordedAt: number;
}): GieFeedbackChangeTrail {
  const changedRefs = cleanRefs(params.changedRefs);
  const proofRefs = cleanRefs([...params.approval.proofRefs, ...params.proofRefs]);
  requireRefs(changedRefs, "gie_feedback_change_refs_required");
  requireRefs(proofRefs, "gie_feedback_change_trail_proof_required");
  const trail: GieFeedbackChangeTrail = {
    trailId: cleanString(params.trailId),
    changedBecauseOfFeedbackRef: params.approval.feedbackRef,
    correctionRef: params.approval.correctionId,
    changedRefs,
    behaviorBefore: cleanString(params.behaviorBefore),
    behaviorAfter: cleanString(params.behaviorAfter),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    recordedAt: params.recordedAt,
  };
  if (!trail.trailId || !trail.behaviorBefore || !trail.behaviorAfter || !trail.authorityRef) {
    throw new Error("gie_feedback_change_trail_required_fields_missing");
  }
  requireTimestamp(trail.recordedAt, "gie_feedback_change_trail_timestamp_required");
  return trail;
}

export function buildGieFeedbackLearningExperience(params: {
  candidate: GieFeedbackLearningCandidate;
  retestId: string;
  retestProofRefs: string[];
  storedAt: number;
}): GieReusableExperienceRecord {
  const learningEvent = createGieLearningEvent({
    eventId: `${params.candidate.learningCandidateId}:feedback_learning_event`,
    taskRef: params.candidate.correctionRef,
    outcomeRef: params.candidate.feedbackRef,
    stage: "result_checked",
    result: "failure",
    summary: params.candidate.expectedBehaviorChange,
    ownerLane: "governance",
    authorityRef: params.candidate.authorityRef,
    proofRefs: params.candidate.proofRefs,
    createdAt: params.candidate.createdAt,
  });
  const attempt = {
    attemptId: `${params.candidate.learningCandidateId}:feedback_attempt`,
    analysisRef: `${params.candidate.learningCandidateId}:feedback_analysis`,
    attemptedMove: params.candidate.expectedBehaviorChange,
    expectedImprovement: params.candidate.expectedBehaviorChange,
    mutationApplied: false as const,
    authorityRef: params.candidate.authorityRef,
    proofRefs: [...learningEvent.proofRefs, ...params.candidate.proofRefs],
    attemptedAt: params.candidate.createdAt,
  };
  const retest = retestGieLearningAttempt({
    retestId: params.retestId,
    attempt,
    retestResult: "pass",
    retestProofRefs: params.retestProofRefs,
    authorityRef: params.candidate.authorityRef,
    retestedAt: params.storedAt,
  });
  return createGieReusableExperience({
    experienceId: `${params.candidate.learningCandidateId}:feedback_experience`,
    subjectKey: params.candidate.learningSubjectKey,
    retest,
    summary: params.candidate.expectedBehaviorChange,
    authorityRef: params.candidate.authorityRef,
    storedAt: params.storedAt,
  });
}

export function createGieRejectedFeedbackMemory(params: {
  rejection: GieCorrectionRejection;
  memoryId: string;
  subjectKey: string;
  storedAt: number;
}): GieMemoryRecord {
  return createGieMemoryRecord({
    recordId: cleanString(params.memoryId),
    bucket: "rejected_patterns",
    subjectKey: cleanString(params.subjectKey),
    summary: params.rejection.rejectionReason,
    confidence: 1,
    sourceRef: params.rejection.correctionId,
    authorityRef: params.rejection.authorityRef,
    proofRefs: params.rejection.proofRefs,
    updatedAt: params.storedAt,
  });
}

export function createGieRollbackBlockingMemory(params: {
  rollback: GieFeedbackRollback;
  memoryId: string;
  subjectKey: string;
  storedAt: number;
}): GieMemoryRecord {
  return createGieMemoryRecord({
    recordId: cleanString(params.memoryId),
    bucket: "rejected_patterns",
    subjectKey: cleanString(params.subjectKey),
    summary: params.rollback.reason,
    confidence: 1,
    sourceRef: params.rollback.rollbackRef,
    authorityRef: params.rollback.authorityRef,
    proofRefs: params.rollback.proofRefs,
    updatedAt: params.storedAt,
  });
}
