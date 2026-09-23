export const GIE_MEMORY_BUCKETS = [
  "task_history",
  "failure_history",
  "fix_history",
  "human_corrections",
  "approved_best_practices",
  "rejected_patterns",
  "department_specific_knowledge",
  "global_rules",
  "confidence_history",
  "performance_history",
] as const;

export type GieMemoryBucket = (typeof GIE_MEMORY_BUCKETS)[number];

export type GieMemoryRecord = {
  recordId: string;
  bucket: GieMemoryBucket;
  subjectKey: string;
  summary: string;
  confidence: number;
  sourceRef: string;
  authorityRef: string;
  proofRefs: string[];
  updatedAt: number;
  expiresAt?: number | null;
};

export type GieMemoryRetrieval = {
  checked: boolean;
  subjectKey: string;
  records: GieMemoryRecord[];
  staleRecords: GieMemoryRecord[];
  approvedPatterns: GieMemoryRecord[];
  rejectedPatterns: GieMemoryRecord[];
};

export type GieMemoryBeforeActionDecision = {
  allowed: boolean;
  reason:
    | "memory_checked"
    | "memory_before_action_required"
    | "rejected_pattern_blocked"
    | "missing_live_authority_or_proof";
  reusePatternRefs: string[];
  blockedPatternRefs: string[];
  staleMemoryOverriddenByLiveProof: boolean;
  proofRefsUsed: string[];
};

const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function cleanString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, Number(value.toFixed(4))));
}

function isStale(record: GieMemoryRecord, now: number, staleAfterMs: number): boolean {
  if (record.expiresAt && record.expiresAt <= now) {
    return true;
  }
  return now - record.updatedAt > staleAfterMs;
}

export function createGieMemoryRecord(params: {
  recordId: string;
  bucket: GieMemoryBucket;
  subjectKey: string;
  summary: string;
  confidence: number;
  sourceRef: string;
  authorityRef: string;
  proofRefs: string[];
  updatedAt: number;
  expiresAt?: number | null;
}): GieMemoryRecord {
  const record: GieMemoryRecord = {
    recordId: cleanString(params.recordId),
    bucket: params.bucket,
    subjectKey: cleanString(params.subjectKey),
    summary: cleanString(params.summary),
    confidence: clampConfidence(params.confidence),
    sourceRef: cleanString(params.sourceRef),
    authorityRef: cleanString(params.authorityRef),
    proofRefs: cleanList(params.proofRefs),
    updatedAt: params.updatedAt,
    expiresAt: params.expiresAt ?? null,
  };
  if (
    !record.recordId ||
    !GIE_MEMORY_BUCKETS.includes(record.bucket) ||
    !record.subjectKey ||
    !record.summary ||
    !record.sourceRef ||
    !record.authorityRef ||
    record.proofRefs.length === 0 ||
    !Number.isFinite(record.updatedAt)
  ) {
    throw new Error("gie_memory_record_required_fields_missing");
  }
  return record;
}

export function retrieveGieMemory(params: {
  records: GieMemoryRecord[];
  subjectKey: string;
  now?: number;
  staleAfterMs?: number;
  bucketFilter?: GieMemoryBucket[];
}): GieMemoryRetrieval {
  const subjectKey = cleanString(params.subjectKey);
  if (!subjectKey) {
    throw new Error("gie_memory_subject_key_required");
  }
  const now = params.now ?? Date.now();
  const staleAfterMs = params.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const bucketFilter = params.bucketFilter ? new Set(params.bucketFilter) : null;
  const records = params.records
    .filter((record) => record.subjectKey === subjectKey)
    .filter((record) => !bucketFilter || bucketFilter.has(record.bucket))
    .toSorted((a, b) => {
      if (a.confidence !== b.confidence) {
        return b.confidence - a.confidence;
      }
      return b.updatedAt - a.updatedAt;
    });
  const staleRecords = records.filter((record) => isStale(record, now, staleAfterMs));
  const currentRecords = records.filter((record) => !isStale(record, now, staleAfterMs));
  return {
    checked: true,
    subjectKey,
    records,
    staleRecords,
    approvedPatterns: currentRecords.filter(
      (record) => record.bucket === "approved_best_practices",
    ),
    rejectedPatterns: currentRecords.filter((record) => record.bucket === "rejected_patterns"),
  };
}

export function evaluateGieMemoryBeforeAction(params: {
  retrieval: GieMemoryRetrieval;
  liveProofRefs: string[];
  authorityRefs: string[];
}): GieMemoryBeforeActionDecision {
  const liveProofRefs = cleanList(params.liveProofRefs);
  const authorityRefs = cleanList(params.authorityRefs);
  const proofRefsUsed = cleanList([
    ...liveProofRefs,
    ...authorityRefs,
    ...params.retrieval.records.flatMap((record) => record.proofRefs),
  ]);
  if (!params.retrieval.checked) {
    return {
      allowed: false,
      reason: "memory_before_action_required",
      reusePatternRefs: [],
      blockedPatternRefs: [],
      staleMemoryOverriddenByLiveProof: false,
      proofRefsUsed,
    };
  }
  if (liveProofRefs.length === 0 || authorityRefs.length === 0) {
    return {
      allowed: false,
      reason: "missing_live_authority_or_proof",
      reusePatternRefs: [],
      blockedPatternRefs: [],
      staleMemoryOverriddenByLiveProof: false,
      proofRefsUsed,
    };
  }
  const blockedPatternRefs = params.retrieval.rejectedPatterns.map((record) => record.recordId);
  if (blockedPatternRefs.length > 0) {
    return {
      allowed: false,
      reason: "rejected_pattern_blocked",
      reusePatternRefs: [],
      blockedPatternRefs,
      staleMemoryOverriddenByLiveProof: params.retrieval.staleRecords.length > 0,
      proofRefsUsed,
    };
  }
  return {
    allowed: true,
    reason: "memory_checked",
    reusePatternRefs: params.retrieval.approvedPatterns.map((record) => record.recordId),
    blockedPatternRefs: [],
    staleMemoryOverriddenByLiveProof: params.retrieval.staleRecords.length > 0,
    proofRefsUsed,
  };
}
