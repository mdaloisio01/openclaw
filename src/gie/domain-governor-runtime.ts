import { createGieMemoryRecord, type GieMemoryRecord } from "./memory-bucket-runtime.js";
import { evaluatePolicyDecision, type GiePolicyDecision } from "./policy-engine.js";

export type GieDomainScopeKind = "department" | "lane" | "domain";
export type GieDomainLessonKind =
  | "local_lesson"
  | "local_standard"
  | "local_policy"
  | "local_rollback_signal";

export type GieDomainGovernor = {
  governorId: string;
  domainId: string;
  departmentId: string;
  scopeKind: GieDomainScopeKind;
  ownerLane: string;
  ownerTarget: string;
  localStandardsRefs: string[];
  localPolicyRefs: string[];
  globalPolicyRefs: string[];
  localMemorySubjectPrefix: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
};

export type GieLocalDomainMemoryRecord = {
  memoryRecord: GieMemoryRecord;
  domainId: string;
  departmentId: string;
  governorRef: string;
  visibility: "local_domain_only";
  promotionState: "not_promoted";
  boundaryRef: string;
};

export type GieDomainLessonRecord = {
  lessonId: string;
  governorRef: string;
  domainId: string;
  departmentId: string;
  lessonKind: GieDomainLessonKind;
  subjectKey: string;
  summary: string;
  localScope: "local_only";
  promotionState: "not_promoted";
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
};

export type GieLocalMemoryBoundaryDecision = {
  allowed: boolean;
  reason:
    | "local_domain_match"
    | "local_learning_not_promoted"
    | "local_memory_boundary_missing"
    | "lawfully_promoted_ref_required";
  subjectKey: string;
  sourceDomainId: string;
  targetDomainId: string;
  proofRefsUsed: string[];
};

export type GieLocalPolicyBoundaryDecision = {
  allowed: boolean;
  reason: "global_policy_allows_local_governance" | "global_policy_blocks_local_governance";
  policyDecision: GiePolicyDecision;
  proofRefsUsed: string[];
};

export type GiePromotionCandidateHandoff = {
  handoffId: string;
  candidateRef: string;
  sourceDomainId: string;
  targetPhase: "gie_phase11_local_to_global_promotion_and_rollback_ladder";
  handoffStatus: "candidate_handoff_only";
  globalAdoptionStatus: "not_adopted";
  reason: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
};

export type GieRollbackSignalHandoff = {
  handoffId: string;
  rollbackSignalRef: string;
  sourceDomainId: string;
  targetPhase: "gie_phase11_local_to_global_promotion_and_rollback_ladder";
  handoffStatus: "rollback_signal_handoff_only";
  rollbackStatus: "not_rolled_back_globally";
  reason: string;
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

function normalizePrefix(prefix: string): string {
  const cleaned = cleanString(prefix);
  if (!cleaned) {
    return "";
  }
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function isWillAuthorityAlias(value: string): boolean {
  const normalized = cleanString(value).toLowerCase();
  return (
    normalized === "will" ||
    normalized === "mark" ||
    normalized === "operator" ||
    normalized.includes("will") ||
    normalized.includes("mark") ||
    normalized.includes("operator")
  );
}

function assertNonWillAuthorityRef(value: string, error: string): void {
  if (isWillAuthorityAlias(value)) {
    throw new Error(error);
  }
}

function proofRefsForGovernor(governor: GieDomainGovernor, extraRefs: string[] = []): string[] {
  return cleanRefs([
    governor.authorityRef,
    ...governor.proofRefs,
    ...governor.localPolicyRefs,
    ...governor.globalPolicyRefs,
    ...extraRefs,
  ]);
}

export function createGieDomainGovernor(params: {
  governorId: string;
  domainId: string;
  departmentId: string;
  scopeKind: GieDomainScopeKind;
  ownerLane: string;
  ownerTarget: string;
  localStandardsRefs: string[];
  localPolicyRefs: string[];
  globalPolicyRefs: string[];
  localMemorySubjectPrefix: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GieDomainGovernor {
  const governor: GieDomainGovernor = {
    governorId: cleanString(params.governorId),
    domainId: cleanString(params.domainId),
    departmentId: cleanString(params.departmentId),
    scopeKind: params.scopeKind,
    ownerLane: cleanString(params.ownerLane),
    ownerTarget: cleanString(params.ownerTarget),
    localStandardsRefs: cleanRefs(params.localStandardsRefs),
    localPolicyRefs: cleanRefs(params.localPolicyRefs),
    globalPolicyRefs: cleanRefs(params.globalPolicyRefs),
    localMemorySubjectPrefix: normalizePrefix(params.localMemorySubjectPrefix),
    authorityRef: cleanString(params.authorityRef),
    proofRefs: cleanRefs(params.proofRefs),
    createdAt: params.createdAt,
  };

  if (
    !governor.governorId ||
    !governor.domainId ||
    !governor.departmentId ||
    !governor.scopeKind ||
    !governor.ownerLane ||
    !governor.ownerTarget ||
    governor.localStandardsRefs.length === 0 ||
    governor.localPolicyRefs.length === 0 ||
    governor.globalPolicyRefs.length === 0 ||
    !governor.localMemorySubjectPrefix ||
    !governor.authorityRef ||
    governor.proofRefs.length === 0
  ) {
    throw new Error("gie_domain_governor_required_fields_missing");
  }
  if (isWillAuthorityAlias(governor.ownerLane) || isWillAuthorityAlias(governor.ownerTarget)) {
    throw new Error("gie_domain_governor_owner_must_be_department_or_lane_not_will");
  }
  assertNonWillAuthorityRef(
    governor.authorityRef,
    "gie_domain_governor_authority_must_not_be_will_or_operator",
  );
  requireTimestamp(governor.createdAt, "gie_domain_governor_timestamp_required");
  return governor;
}

export function createGieDomainLessonRecord(params: {
  lessonId: string;
  governor: GieDomainGovernor;
  lessonKind: GieDomainLessonKind;
  subjectKey: string;
  summary: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GieDomainLessonRecord {
  const subjectKey = cleanString(params.subjectKey);
  if (!subjectKey.startsWith(params.governor.localMemorySubjectPrefix)) {
    throw new Error("gie_domain_lesson_outside_local_memory_boundary");
  }
  const proofRefs = cleanRefs([...params.governor.proofRefs, ...params.proofRefs]);
  requireRefs(proofRefs, "gie_domain_lesson_proof_required");
  const record: GieDomainLessonRecord = {
    lessonId: cleanString(params.lessonId),
    governorRef: params.governor.governorId,
    domainId: params.governor.domainId,
    departmentId: params.governor.departmentId,
    lessonKind: params.lessonKind,
    subjectKey,
    summary: cleanString(params.summary),
    localScope: "local_only",
    promotionState: "not_promoted",
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    createdAt: params.createdAt,
  };
  if (!record.lessonId || !record.lessonKind || !record.summary || !record.authorityRef) {
    throw new Error("gie_domain_lesson_required_fields_missing");
  }
  assertNonWillAuthorityRef(
    record.authorityRef,
    "gie_domain_lesson_authority_must_not_be_will_or_operator",
  );
  requireTimestamp(record.createdAt, "gie_domain_lesson_timestamp_required");
  return record;
}

export function createGieLocalDomainMemoryRecord(params: {
  memoryId: string;
  governor: GieDomainGovernor;
  lesson: GieDomainLessonRecord;
  confidence: number;
  updatedAt: number;
}): GieLocalDomainMemoryRecord {
  if (params.lesson.domainId !== params.governor.domainId) {
    throw new Error("gie_domain_memory_domain_mismatch");
  }
  return {
    memoryRecord: createGieMemoryRecord({
      recordId: cleanString(params.memoryId),
      bucket: "department_specific_knowledge",
      subjectKey: params.lesson.subjectKey,
      summary: params.lesson.summary,
      confidence: params.confidence,
      sourceRef: params.lesson.lessonId,
      authorityRef: params.lesson.authorityRef,
      proofRefs: params.lesson.proofRefs,
      updatedAt: params.updatedAt,
    }),
    domainId: params.governor.domainId,
    departmentId: params.governor.departmentId,
    governorRef: params.governor.governorId,
    visibility: "local_domain_only",
    promotionState: "not_promoted",
    boundaryRef: params.governor.localMemorySubjectPrefix,
  };
}

export function evaluateGieLocalMemoryBoundary(params: {
  lesson: GieDomainLessonRecord;
  sourceGovernor: GieDomainGovernor;
  targetDomainId: string;
  lawfullyPromotedRef?: string | null;
}): GieLocalMemoryBoundaryDecision {
  const targetDomainId = cleanString(params.targetDomainId);
  const proofRefsUsed = proofRefsForGovernor(params.sourceGovernor, params.lesson.proofRefs);
  if (!params.lesson.subjectKey.startsWith(params.sourceGovernor.localMemorySubjectPrefix)) {
    return {
      allowed: false,
      reason: "local_memory_boundary_missing",
      subjectKey: params.lesson.subjectKey,
      sourceDomainId: params.sourceGovernor.domainId,
      targetDomainId,
      proofRefsUsed,
    };
  }
  if (targetDomainId === params.sourceGovernor.domainId) {
    return {
      allowed: true,
      reason: "local_domain_match",
      subjectKey: params.lesson.subjectKey,
      sourceDomainId: params.sourceGovernor.domainId,
      targetDomainId,
      proofRefsUsed,
    };
  }
  if (!cleanString(params.lawfullyPromotedRef)) {
    return {
      allowed: false,
      reason: "local_learning_not_promoted",
      subjectKey: params.lesson.subjectKey,
      sourceDomainId: params.sourceGovernor.domainId,
      targetDomainId,
      proofRefsUsed,
    };
  }
  return {
    allowed: true,
    reason: "lawfully_promoted_ref_required",
    subjectKey: params.lesson.subjectKey,
    sourceDomainId: params.sourceGovernor.domainId,
    targetDomainId,
    proofRefsUsed: cleanRefs([...proofRefsUsed, cleanString(params.lawfullyPromotedRef)]),
  };
}

export function evaluateGieLocalPolicyBoundary(params: {
  governor: GieDomainGovernor;
  actionRef: string;
  proofRefs: string[];
  structuralChange?: boolean;
  authorityChange?: boolean;
  bypassAttempt?: boolean;
}): GieLocalPolicyBoundaryDecision {
  const proofRefsUsed = proofRefsForGovernor(params.governor, [
    params.actionRef,
    ...params.proofRefs,
  ]);
  const policyDecision = evaluatePolicyDecision({
    action: "domain_policy_boundary",
    ownerLane: params.governor.ownerLane,
    ownerTarget: params.governor.ownerTarget,
    proofRefs: proofRefsUsed,
    structuralChange: params.structuralChange ?? false,
    authorityChange: params.authorityChange ?? false,
    bypassAttempt: params.bypassAttempt ?? false,
  });
  return {
    allowed: policyDecision.allowed,
    reason: policyDecision.allowed
      ? "global_policy_allows_local_governance"
      : "global_policy_blocks_local_governance",
    policyDecision,
    proofRefsUsed,
  };
}

export function createGiePromotionCandidateHandoff(params: {
  handoffId: string;
  lesson: GieDomainLessonRecord;
  reason: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GiePromotionCandidateHandoff {
  const proofRefs = cleanRefs([...params.lesson.proofRefs, ...params.proofRefs]);
  requireRefs(proofRefs, "gie_promotion_candidate_handoff_proof_required");
  const handoff: GiePromotionCandidateHandoff = {
    handoffId: cleanString(params.handoffId),
    candidateRef: params.lesson.lessonId,
    sourceDomainId: params.lesson.domainId,
    targetPhase: "gie_phase11_local_to_global_promotion_and_rollback_ladder",
    handoffStatus: "candidate_handoff_only",
    globalAdoptionStatus: "not_adopted",
    reason: cleanString(params.reason),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    createdAt: params.createdAt,
  };
  if (!handoff.handoffId || !handoff.candidateRef || !handoff.reason || !handoff.authorityRef) {
    throw new Error("gie_promotion_candidate_handoff_required_fields_missing");
  }
  assertNonWillAuthorityRef(
    handoff.authorityRef,
    "gie_promotion_candidate_authority_must_not_be_will_or_operator",
  );
  requireTimestamp(handoff.createdAt, "gie_promotion_candidate_handoff_timestamp_required");
  return handoff;
}

export function createGieRollbackSignalHandoff(params: {
  handoffId: string;
  rollbackSignalRef: string;
  sourceGovernor: GieDomainGovernor;
  reason: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GieRollbackSignalHandoff {
  const proofRefs = cleanRefs([
    ...params.sourceGovernor.proofRefs,
    ...params.proofRefs,
    params.rollbackSignalRef,
  ]);
  requireRefs(proofRefs, "gie_rollback_signal_handoff_proof_required");
  const handoff: GieRollbackSignalHandoff = {
    handoffId: cleanString(params.handoffId),
    rollbackSignalRef: cleanString(params.rollbackSignalRef),
    sourceDomainId: params.sourceGovernor.domainId,
    targetPhase: "gie_phase11_local_to_global_promotion_and_rollback_ladder",
    handoffStatus: "rollback_signal_handoff_only",
    rollbackStatus: "not_rolled_back_globally",
    reason: cleanString(params.reason),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    createdAt: params.createdAt,
  };
  if (
    !handoff.handoffId ||
    !handoff.rollbackSignalRef ||
    !handoff.reason ||
    !handoff.authorityRef
  ) {
    throw new Error("gie_rollback_signal_handoff_required_fields_missing");
  }
  assertNonWillAuthorityRef(
    handoff.authorityRef,
    "gie_rollback_signal_authority_must_not_be_will_or_operator",
  );
  requireTimestamp(handoff.createdAt, "gie_rollback_signal_handoff_timestamp_required");
  return handoff;
}
