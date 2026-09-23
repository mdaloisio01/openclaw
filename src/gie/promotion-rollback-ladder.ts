import type {
  GiePromotionCandidateHandoff,
  GieRollbackSignalHandoff,
} from "./domain-governor-runtime.js";
import { createGieMemoryRecord, type GieMemoryRecord } from "./memory-bucket-runtime.js";

export const GIE_PROMOTION_LADDER_STAGES = [
  "local_observation",
  "repeated_local_success",
  "review",
  "promotion_candidate",
  "global_adoption",
  "rollback_if_bad",
] as const;

export const GIE_PROMOTION_REVIEW_CRITERIA = [
  "repeated_local_success_proven",
  "source_domain_authority_valid",
  "proof_refs_current",
  "no_rejected_pattern_collision",
  "global_policy_review_complete",
  "security_review_complete_when_risk_bearing",
  "rollback_path_defined",
] as const;

export type GiePromotionLadderStage = (typeof GIE_PROMOTION_LADDER_STAGES)[number];
export type GiePromotionReviewCriterion = (typeof GIE_PROMOTION_REVIEW_CRITERIA)[number];
export type GiePromotionReviewDecision =
  | "approved_for_candidate"
  | "rejected"
  | "needs_more_local_evidence";

export type GiePromotionObservation = {
  observationId: string;
  stage: "local_observation";
  sourceDomainId: string;
  lessonRef: string;
  subjectKey: string;
  summary: string;
  authorityRef: string;
  proofRefs: string[];
  observedAt: number;
};

export type GieRepeatedLocalSuccess = {
  successId: string;
  stage: "repeated_local_success";
  observationRef: string;
  sourceDomainId: string;
  successRefs: string[];
  successCount: number;
  authorityRef: string;
  proofRefs: string[];
  recordedAt: number;
};

export type GiePromotionReview = {
  reviewId: string;
  stage: "review";
  successRef: string;
  sourceDomainId: string;
  decision: GiePromotionReviewDecision;
  criteriaResults: Record<GiePromotionReviewCriterion, boolean>;
  reviewerRefs: string[];
  securityReviewRef: string | null;
  rejectionReason: string | null;
  authorityRef: string;
  proofRefs: string[];
  reviewedAt: number;
};

export type GiePromotionCandidate = {
  candidateId: string;
  stage: "promotion_candidate";
  reviewRef: string;
  sourceDomainId: string;
  handoffRef: string;
  subjectKey: string;
  proposedGlobalSummary: string;
  globalAdoptionStatus: "not_adopted";
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
};

export type GieGlobalAdoptionRecord = {
  adoptionId: string;
  stage: "global_adoption";
  candidateRef: string;
  sourceDomainId: string;
  globalSubjectKey: string;
  version: string;
  previousVersionRef: string | null;
  governanceApprovalRef: string;
  securityApprovalRef: string | null;
  globalMemoryRecord: GieMemoryRecord;
  authorityRef: string;
  proofRefs: string[];
  adoptedAt: number;
};

export type GieBadPromotionDetection = {
  detectionId: string;
  stage: "rollback_if_bad";
  adoptionRef: string;
  badPatternSummary: string;
  severity: "low" | "medium" | "high";
  rollbackSignalRef: string | null;
  authorityRef: string;
  proofRefs: string[];
  detectedAt: number;
};

export type GiePromotionRollback = {
  rollbackId: string;
  stage: "rollback_if_bad";
  adoptionRef: string;
  detectionRef: string;
  rollbackVersion: string;
  rollbackStatus: "rolled_back";
  rollbackMemoryRecord: GieMemoryRecord;
  authorityRef: string;
  proofRefs: string[];
  rolledBackAt: number;
};

export type GiePromotionAuditEvent = {
  auditId: string;
  stage: GiePromotionLadderStage;
  sourceRef: string;
  action: string;
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

function isOperatorAuthorityAlias(value: string): boolean {
  const normalized = cleanString(value).toLowerCase();
  return (
    normalized.includes("will") || normalized.includes("mark") || normalized.includes("operator")
  );
}

function assertGovernanceAuthority(value: string, error: string): void {
  const authorityRef = cleanString(value);
  if (!authorityRef || isOperatorAuthorityAlias(authorityRef)) {
    throw new Error(error);
  }
}

function allCriteriaPassed(criteriaResults: Record<GiePromotionReviewCriterion, boolean>): boolean {
  return GIE_PROMOTION_REVIEW_CRITERIA.every((criterion) => criteriaResults[criterion] === true);
}

export function createGiePromotionObservation(params: {
  observationId: string;
  sourceDomainId: string;
  lessonRef: string;
  subjectKey: string;
  summary: string;
  authorityRef: string;
  proofRefs: string[];
  observedAt: number;
}): GiePromotionObservation {
  const proofRefs = cleanRefs(params.proofRefs);
  requireRefs(proofRefs, "gie_promotion_observation_proof_required");
  assertGovernanceAuthority(
    params.authorityRef,
    "gie_promotion_observation_authority_must_not_be_will_or_operator",
  );
  const observation: GiePromotionObservation = {
    observationId: cleanString(params.observationId),
    stage: "local_observation",
    sourceDomainId: cleanString(params.sourceDomainId),
    lessonRef: cleanString(params.lessonRef),
    subjectKey: cleanString(params.subjectKey),
    summary: cleanString(params.summary),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    observedAt: params.observedAt,
  };
  if (
    !observation.observationId ||
    !observation.sourceDomainId ||
    !observation.lessonRef ||
    !observation.subjectKey ||
    !observation.summary
  ) {
    throw new Error("gie_promotion_observation_required_fields_missing");
  }
  requireTimestamp(observation.observedAt, "gie_promotion_observation_timestamp_required");
  return observation;
}

export function recordGieRepeatedLocalSuccess(params: {
  successId: string;
  observation: GiePromotionObservation;
  successRefs: string[];
  authorityRef: string;
  proofRefs: string[];
  recordedAt: number;
}): GieRepeatedLocalSuccess {
  const successRefs = cleanRefs(params.successRefs);
  if (successRefs.length < 2) {
    throw new Error("gie_repeated_local_success_requires_two_or_more_success_refs");
  }
  const proofRefs = cleanRefs([
    ...params.observation.proofRefs,
    ...params.proofRefs,
    ...successRefs,
  ]);
  requireRefs(proofRefs, "gie_repeated_local_success_proof_required");
  assertGovernanceAuthority(
    params.authorityRef,
    "gie_repeated_local_success_authority_must_not_be_will_or_operator",
  );
  const success: GieRepeatedLocalSuccess = {
    successId: cleanString(params.successId),
    stage: "repeated_local_success",
    observationRef: params.observation.observationId,
    sourceDomainId: params.observation.sourceDomainId,
    successRefs,
    successCount: successRefs.length,
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    recordedAt: params.recordedAt,
  };
  if (!success.successId) {
    throw new Error("gie_repeated_local_success_required_fields_missing");
  }
  requireTimestamp(success.recordedAt, "gie_repeated_local_success_timestamp_required");
  return success;
}

export function reviewGiePromotionCandidate(params: {
  reviewId: string;
  success: GieRepeatedLocalSuccess;
  decision: GiePromotionReviewDecision;
  criteriaResults: Record<GiePromotionReviewCriterion, boolean>;
  reviewerRefs: string[];
  securityReviewRef?: string | null;
  rejectionReason?: string | null;
  authorityRef: string;
  proofRefs: string[];
  reviewedAt: number;
}): GiePromotionReview {
  const reviewerRefs = cleanRefs(params.reviewerRefs);
  const securityReviewRef = cleanString(params.securityReviewRef ?? "");
  const proofRefs = cleanRefs([
    ...params.success.proofRefs,
    ...params.proofRefs,
    ...reviewerRefs,
    securityReviewRef,
  ]);
  requireRefs(proofRefs, "gie_promotion_review_proof_required");
  requireRefs(reviewerRefs, "gie_promotion_review_reviewer_required");
  assertGovernanceAuthority(
    params.authorityRef,
    "gie_promotion_review_authority_must_not_be_will_or_operator",
  );
  const criteriaPassed = allCriteriaPassed(params.criteriaResults);
  if (params.decision === "approved_for_candidate" && !criteriaPassed) {
    throw new Error("gie_promotion_review_cannot_approve_failed_criteria");
  }
  if (params.criteriaResults.security_review_complete_when_risk_bearing && !securityReviewRef) {
    throw new Error("gie_promotion_review_security_ref_required");
  }
  const review: GiePromotionReview = {
    reviewId: cleanString(params.reviewId),
    stage: "review",
    successRef: params.success.successId,
    sourceDomainId: params.success.sourceDomainId,
    decision: params.decision,
    criteriaResults: params.criteriaResults,
    reviewerRefs,
    securityReviewRef: securityReviewRef || null,
    rejectionReason: params.decision === "rejected" ? cleanString(params.rejectionReason) : null,
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    reviewedAt: params.reviewedAt,
  };
  if (!review.reviewId || (review.decision === "rejected" && !review.rejectionReason)) {
    throw new Error("gie_promotion_review_required_fields_missing");
  }
  requireTimestamp(review.reviewedAt, "gie_promotion_review_timestamp_required");
  return review;
}

export function createGiePromotionCandidate(params: {
  candidateId: string;
  review: GiePromotionReview;
  handoff: GiePromotionCandidateHandoff;
  subjectKey: string;
  proposedGlobalSummary: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GiePromotionCandidate {
  if (params.review.decision !== "approved_for_candidate") {
    throw new Error("gie_promotion_candidate_requires_approved_review");
  }
  if (params.handoff.globalAdoptionStatus !== "not_adopted") {
    throw new Error("gie_promotion_candidate_handoff_must_not_be_adopted");
  }
  const proofRefs = cleanRefs([
    ...params.review.proofRefs,
    ...params.handoff.proofRefs,
    ...params.proofRefs,
  ]);
  requireRefs(proofRefs, "gie_promotion_candidate_proof_required");
  assertGovernanceAuthority(
    params.authorityRef,
    "gie_promotion_candidate_authority_must_not_be_will_or_operator",
  );
  const candidate: GiePromotionCandidate = {
    candidateId: cleanString(params.candidateId),
    stage: "promotion_candidate",
    reviewRef: params.review.reviewId,
    sourceDomainId: params.review.sourceDomainId,
    handoffRef: params.handoff.handoffId,
    subjectKey: cleanString(params.subjectKey),
    proposedGlobalSummary: cleanString(params.proposedGlobalSummary),
    globalAdoptionStatus: "not_adopted",
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    createdAt: params.createdAt,
  };
  if (!candidate.candidateId || !candidate.subjectKey || !candidate.proposedGlobalSummary) {
    throw new Error("gie_promotion_candidate_required_fields_missing");
  }
  requireTimestamp(candidate.createdAt, "gie_promotion_candidate_timestamp_required");
  return candidate;
}

export function adoptGiePromotionGlobally(params: {
  adoptionId: string;
  candidate: GiePromotionCandidate;
  version: string;
  previousVersionRef?: string | null;
  governanceApprovalRef: string;
  securityApprovalRef?: string | null;
  globalMemoryId: string;
  authorityRef: string;
  proofRefs: string[];
  adoptedAt: number;
}): GieGlobalAdoptionRecord {
  const governanceApprovalRef = cleanString(params.governanceApprovalRef);
  const securityApprovalRef = cleanString(params.securityApprovalRef ?? "");
  const proofRefs = cleanRefs([
    ...params.candidate.proofRefs,
    ...params.proofRefs,
    governanceApprovalRef,
    securityApprovalRef,
  ]);
  requireRefs(proofRefs, "gie_global_adoption_proof_required");
  if (!governanceApprovalRef) {
    throw new Error("gie_global_adoption_governance_approval_required");
  }
  assertGovernanceAuthority(
    params.authorityRef,
    "gie_global_adoption_authority_must_not_be_will_or_operator",
  );
  const globalSubjectKey = `global/${params.candidate.subjectKey}`;
  const adoption: GieGlobalAdoptionRecord = {
    adoptionId: cleanString(params.adoptionId),
    stage: "global_adoption",
    candidateRef: params.candidate.candidateId,
    sourceDomainId: params.candidate.sourceDomainId,
    globalSubjectKey,
    version: cleanString(params.version),
    previousVersionRef: cleanString(params.previousVersionRef ?? "") || null,
    governanceApprovalRef,
    securityApprovalRef: securityApprovalRef || null,
    globalMemoryRecord: createGieMemoryRecord({
      recordId: cleanString(params.globalMemoryId),
      bucket: "approved_best_practices",
      subjectKey: globalSubjectKey,
      summary: params.candidate.proposedGlobalSummary,
      confidence: 1,
      sourceRef: params.candidate.candidateId,
      authorityRef: cleanString(params.authorityRef),
      proofRefs,
      updatedAt: params.adoptedAt,
    }),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    adoptedAt: params.adoptedAt,
  };
  if (!adoption.adoptionId || !adoption.version) {
    throw new Error("gie_global_adoption_required_fields_missing");
  }
  requireTimestamp(adoption.adoptedAt, "gie_global_adoption_timestamp_required");
  return adoption;
}

export function detectBadGiePromotion(params: {
  detectionId: string;
  adoption: GieGlobalAdoptionRecord;
  badPatternSummary: string;
  severity: "low" | "medium" | "high";
  rollbackSignal?: GieRollbackSignalHandoff | null;
  authorityRef: string;
  proofRefs: string[];
  detectedAt: number;
}): GieBadPromotionDetection {
  const rollbackSignalRef = params.rollbackSignal?.handoffId ?? null;
  const proofRefs = cleanRefs([
    ...params.adoption.proofRefs,
    ...params.proofRefs,
    rollbackSignalRef ?? "",
  ]);
  requireRefs(proofRefs, "gie_bad_promotion_detection_proof_required");
  assertGovernanceAuthority(
    params.authorityRef,
    "gie_bad_promotion_authority_must_not_be_will_or_operator",
  );
  const detection: GieBadPromotionDetection = {
    detectionId: cleanString(params.detectionId),
    stage: "rollback_if_bad",
    adoptionRef: params.adoption.adoptionId,
    badPatternSummary: cleanString(params.badPatternSummary),
    severity: params.severity,
    rollbackSignalRef,
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    detectedAt: params.detectedAt,
  };
  if (!detection.detectionId || !detection.badPatternSummary) {
    throw new Error("gie_bad_promotion_detection_required_fields_missing");
  }
  requireTimestamp(detection.detectedAt, "gie_bad_promotion_detection_timestamp_required");
  return detection;
}

export function rollbackBadGiePromotion(params: {
  rollbackId: string;
  adoption: GieGlobalAdoptionRecord;
  detection: GieBadPromotionDetection;
  rollbackVersion: string;
  rollbackMemoryId: string;
  authorityRef: string;
  proofRefs: string[];
  rolledBackAt: number;
}): GiePromotionRollback {
  if (params.detection.adoptionRef !== params.adoption.adoptionId) {
    throw new Error("gie_promotion_rollback_detection_adoption_mismatch");
  }
  const proofRefs = cleanRefs([
    ...params.adoption.proofRefs,
    ...params.detection.proofRefs,
    ...params.proofRefs,
  ]);
  requireRefs(proofRefs, "gie_promotion_rollback_proof_required");
  assertGovernanceAuthority(
    params.authorityRef,
    "gie_promotion_rollback_authority_must_not_be_will_or_operator",
  );
  const rollback: GiePromotionRollback = {
    rollbackId: cleanString(params.rollbackId),
    stage: "rollback_if_bad",
    adoptionRef: params.adoption.adoptionId,
    detectionRef: params.detection.detectionId,
    rollbackVersion: cleanString(params.rollbackVersion),
    rollbackStatus: "rolled_back",
    rollbackMemoryRecord: createGieMemoryRecord({
      recordId: cleanString(params.rollbackMemoryId),
      bucket: "rejected_patterns",
      subjectKey: params.adoption.globalSubjectKey,
      summary: params.detection.badPatternSummary,
      confidence: 1,
      sourceRef: params.detection.detectionId,
      authorityRef: cleanString(params.authorityRef),
      proofRefs,
      updatedAt: params.rolledBackAt,
    }),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    rolledBackAt: params.rolledBackAt,
  };
  if (!rollback.rollbackId || !rollback.rollbackVersion) {
    throw new Error("gie_promotion_rollback_required_fields_missing");
  }
  requireTimestamp(rollback.rolledBackAt, "gie_promotion_rollback_timestamp_required");
  return rollback;
}

export function createGiePromotionAuditEvent(params: {
  auditId: string;
  stage: GiePromotionLadderStage;
  sourceRef: string;
  action: string;
  authorityRef: string;
  proofRefs: string[];
  recordedAt: number;
}): GiePromotionAuditEvent {
  const proofRefs = cleanRefs(params.proofRefs);
  requireRefs(proofRefs, "gie_promotion_audit_proof_required");
  assertGovernanceAuthority(
    params.authorityRef,
    "gie_promotion_audit_authority_must_not_be_will_or_operator",
  );
  const audit: GiePromotionAuditEvent = {
    auditId: cleanString(params.auditId),
    stage: params.stage,
    sourceRef: cleanString(params.sourceRef),
    action: cleanString(params.action),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    recordedAt: params.recordedAt,
  };
  if (
    !audit.auditId ||
    !GIE_PROMOTION_LADDER_STAGES.includes(audit.stage) ||
    !audit.sourceRef ||
    !audit.action
  ) {
    throw new Error("gie_promotion_audit_required_fields_missing");
  }
  requireTimestamp(audit.recordedAt, "gie_promotion_audit_timestamp_required");
  return audit;
}
