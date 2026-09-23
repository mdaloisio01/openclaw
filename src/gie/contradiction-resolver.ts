export const GIE_TRUTH_SOURCE_KINDS = [
  "mark_operator_instruction",
  "sop",
  "controlling_build_plan",
  "latest_build_state_interpretation",
  "live_runtime_truth",
  "receipt_result",
  "memory",
  "active_repair_artifact",
  "stale_prior_report",
] as const;

export type GieTruthSourceKind = (typeof GIE_TRUTH_SOURCE_KINDS)[number];

export const GIE_TRUTH_STATUSES = [
  "unknown",
  "not_started",
  "in_progress",
  "blocked",
  "complete",
  "failed",
] as const;

export type GieTruthStatus = (typeof GIE_TRUTH_STATUSES)[number];

export type GieTruthClaim = {
  claimId: string;
  subjectId: string;
  sourceId: string;
  sourceKind: GieTruthSourceKind;
  truthStatus: GieTruthStatus;
  statement: string;
  updatedAt?: number | string | null;
  proofRefs: string[];
  supersedes?: string[] | null;
  authorityRef?: string | null;
  receiptRef?: string | null;
  phaseId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type GieTruthClassification = "current" | "partial" | "stale" | "superseded" | "invalid";

export type GieContradictionResolutionKind =
  | "consistent"
  | "reconciled_to_stronger_truth"
  | "false_completion_reopened"
  | "human_escalation_required";

export type GieClassifiedTruthClaim = {
  claimId: string;
  sourceKind: GieTruthSourceKind;
  truthStatus: GieTruthStatus;
  classification: GieTruthClassification;
  precedenceScore: number;
  reasons: string[];
  proofRefsUsed: string[];
};

export type GieTruthContradiction = {
  subjectId: string;
  claimIds: string[];
  statuses: GieTruthStatus[];
  reason: string;
};

export type GieContradictionResolution = {
  resolution: GieContradictionResolutionKind;
  winningClaim: GieTruthClaim | null;
  classifications: GieClassifiedTruthClaim[];
  contradictions: GieTruthContradiction[];
  reopenedClaims: GieTruthClaim[];
  humanEscalationRequired: boolean;
  humanEscalationRule: string | null;
  proofRefsUsed: string[];
};

type HumanEscalationRule =
  | "missing_truth_claims"
  | "operator_instruction_authority_conflict"
  | "authority_source_conflict"
  | "equal_strength_authority_conflict";

export type GieContradictionResolverInput = {
  claims: GieTruthClaim[];
  subjectId?: string | null;
  now?: number;
  staleAfterMs?: number;
};

const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const SOURCE_PRECEDENCE: Record<GieTruthSourceKind, number> = {
  live_runtime_truth: 100,
  receipt_result: 95,
  active_repair_artifact: 90,
  latest_build_state_interpretation: 85,
  controlling_build_plan: 75,
  sop: 70,
  mark_operator_instruction: 65,
  memory: 50,
  stale_prior_report: 10,
};

const AUTHORITY_SOURCE_KINDS = new Set<GieTruthSourceKind>([
  "mark_operator_instruction",
  "sop",
  "controlling_build_plan",
]);
const STRONG_LIVE_SOURCE_KINDS = new Set<GieTruthSourceKind>([
  "live_runtime_truth",
  "receipt_result",
  "active_repair_artifact",
]);
const OPEN_OR_BAD_STATUSES = new Set<GieTruthStatus>([
  "not_started",
  "in_progress",
  "blocked",
  "failed",
]);

function cleanString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanProofRefs(value: string[]): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function parseTime(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function supersededClaimIds(claims: GieTruthClaim[]): Set<string> {
  const ids = new Set<string>();
  for (const claim of claims) {
    for (const superseded of claim.supersedes ?? []) {
      const clean = cleanString(superseded);
      if (clean) {
        ids.add(clean);
      }
    }
  }
  return ids;
}

function isValidClaim(claim: GieTruthClaim): boolean {
  return Boolean(
    cleanString(claim.claimId) &&
    cleanString(claim.subjectId) &&
    cleanString(claim.sourceId) &&
    cleanString(claim.statement) &&
    GIE_TRUTH_SOURCE_KINDS.includes(claim.sourceKind) &&
    GIE_TRUTH_STATUSES.includes(claim.truthStatus),
  );
}

function classifyClaim(params: {
  claim: GieTruthClaim;
  supersededIds: Set<string>;
  now: number;
  staleAfterMs: number;
}): GieClassifiedTruthClaim {
  const { claim, supersededIds, now, staleAfterMs } = params;
  const reasons: string[] = [];
  const proofRefsUsed = cleanProofRefs(claim.proofRefs);
  const updatedAt = parseTime(claim.updatedAt);
  let classification: GieTruthClassification = "current";
  let precedenceScore = SOURCE_PRECEDENCE[claim.sourceKind] ?? 0;

  if (!isValidClaim(claim)) {
    classification = "invalid";
    reasons.push("invalid_claim_shape");
    precedenceScore -= 120;
  }

  if (supersededIds.has(claim.claimId)) {
    classification = "superseded";
    reasons.push("superseded_by_newer_claim");
    precedenceScore -= 110;
  }

  if (claim.sourceKind === "stale_prior_report") {
    classification = classification === "superseded" ? classification : "stale";
    reasons.push("stale_prior_report_source");
    precedenceScore -= 60;
  }

  if (updatedAt === null) {
    classification = classification === "current" ? "partial" : classification;
    reasons.push("missing_or_invalid_updated_at");
    precedenceScore -= 15;
  } else if (now - updatedAt > staleAfterMs) {
    if (classification !== "superseded" && classification !== "invalid") {
      classification = "stale";
    }
    reasons.push("older_than_stale_window");
    precedenceScore -= 45;
  }

  if (proofRefsUsed.length === 0) {
    classification = classification === "current" ? "partial" : classification;
    reasons.push("missing_proof_refs");
    precedenceScore -= 30;
  }

  if (claim.truthStatus === "unknown") {
    classification = classification === "current" ? "partial" : classification;
    reasons.push("unknown_truth_status");
    precedenceScore -= 25;
  }

  return {
    claimId: claim.claimId,
    sourceKind: claim.sourceKind,
    truthStatus: claim.truthStatus,
    classification,
    precedenceScore,
    reasons,
    proofRefsUsed,
  };
}

function activeClassifications(
  classifications: GieClassifiedTruthClaim[],
): GieClassifiedTruthClaim[] {
  return classifications.filter(
    (item) => item.classification !== "superseded" && item.classification !== "invalid",
  );
}

function findContradictions(params: {
  claims: GieTruthClaim[];
  classifications: GieClassifiedTruthClaim[];
}): GieTruthContradiction[] {
  const activeIds = new Set(
    activeClassifications(params.classifications).map((item) => item.claimId),
  );
  const grouped = new Map<string, GieTruthClaim[]>();
  for (const claim of params.claims) {
    if (!activeIds.has(claim.claimId)) {
      continue;
    }
    const group = grouped.get(claim.subjectId) ?? [];
    group.push(claim);
    grouped.set(claim.subjectId, group);
  }

  const contradictions: GieTruthContradiction[] = [];
  for (const [subjectId, group] of grouped.entries()) {
    const statuses = [...new Set(group.map((claim) => claim.truthStatus))];
    if (statuses.length <= 1) {
      continue;
    }
    const hasComplete = statuses.includes("complete");
    const hasOpenOrBad = statuses.some((status) => OPEN_OR_BAD_STATUSES.has(status));
    if (hasComplete && hasOpenOrBad) {
      contradictions.push({
        subjectId,
        claimIds: group.map((claim) => claim.claimId),
        statuses,
        reason: "completion_status_conflicts_with_open_or_bad_truth",
      });
      continue;
    }
    if (statuses.includes("blocked") && statuses.includes("failed")) {
      contradictions.push({
        subjectId,
        claimIds: group.map((claim) => claim.claimId),
        statuses,
        reason: "blocked_status_conflicts_with_terminal_truth",
      });
    }
  }
  return contradictions;
}

function selectWinningClaim(params: {
  claims: GieTruthClaim[];
  classifications: GieClassifiedTruthClaim[];
}): GieTruthClaim | null {
  const byId = new Map(params.classifications.map((item) => [item.claimId, item]));
  const eligible = params.claims
    .filter((claim) => {
      const classification = byId.get(claim.claimId);
      return (
        classification &&
        classification.classification !== "invalid" &&
        classification.classification !== "superseded"
      );
    })
    .toSorted((a, b) => {
      const aScore = byId.get(a.claimId)?.precedenceScore ?? Number.NEGATIVE_INFINITY;
      const bScore = byId.get(b.claimId)?.precedenceScore ?? Number.NEGATIVE_INFINITY;
      if (aScore !== bScore) {
        return bScore - aScore;
      }
      const aTime = parseTime(a.updatedAt) ?? 0;
      const bTime = parseTime(b.updatedAt) ?? 0;
      return bTime - aTime;
    });
  return eligible[0] ?? null;
}

function equalStrengthConflict(params: {
  claims: GieTruthClaim[];
  classifications: GieClassifiedTruthClaim[];
  winningClaim: GieTruthClaim | null;
  contradictions: GieTruthContradiction[];
}): boolean {
  if (!params.winningClaim || params.contradictions.length === 0) {
    return false;
  }
  const winningClassification = params.classifications.find(
    (item) => item.claimId === params.winningClaim?.claimId,
  );
  if (!winningClassification) {
    return false;
  }
  const conflictingIds = new Set(params.contradictions.flatMap((item) => item.claimIds));
  return params.classifications.some((item) => {
    if (item.claimId === winningClassification.claimId || !conflictingIds.has(item.claimId)) {
      return false;
    }
    return (
      item.precedenceScore === winningClassification.precedenceScore &&
      item.truthStatus !== winningClassification.truthStatus
    );
  });
}

function authorityConflictEscalation(params: {
  claims: GieTruthClaim[];
  classifications: GieClassifiedTruthClaim[];
  contradictions: GieTruthContradiction[];
}): HumanEscalationRule | null {
  if (params.contradictions.length === 0) {
    return null;
  }
  const classificationById = new Map(params.classifications.map((item) => [item.claimId, item]));
  const claimById = new Map(params.claims.map((claim) => [claim.claimId, claim]));
  for (const contradiction of params.contradictions) {
    const activeClaims = contradiction.claimIds
      .map((claimId) => claimById.get(claimId))
      .filter((claim): claim is GieTruthClaim => {
        if (!claim) {
          return false;
        }
        const classification = classificationById.get(claim.claimId);
        return Boolean(
          classification &&
          classification.classification !== "invalid" &&
          classification.classification !== "superseded" &&
          classification.classification !== "stale",
        );
      });
    const operatorConflict = activeClaims.some(
      (claim) => claim.sourceKind === "mark_operator_instruction",
    );
    if (operatorConflict) {
      return "operator_instruction_authority_conflict";
    }
    const authorityStatuses = new Set(
      activeClaims
        .filter((claim) => AUTHORITY_SOURCE_KINDS.has(claim.sourceKind))
        .map((claim) => claim.truthStatus),
    );
    if (authorityStatuses.size > 0) {
      const nonAuthorityStatuses = new Set(
        activeClaims
          .filter((claim) => STRONG_LIVE_SOURCE_KINDS.has(claim.sourceKind))
          .map((claim) => claim.truthStatus),
      );
      const conflictsWithStrongLiveTruth = [...authorityStatuses].some(
        (status) => nonAuthorityStatuses.size > 0 && !nonAuthorityStatuses.has(status),
      );
      if (conflictsWithStrongLiveTruth) {
        return "authority_source_conflict";
      }
      if (authorityStatuses.size > 1) {
        return "authority_source_conflict";
      }
    }
  }
  return null;
}

function reopenedFalseCompletionClaims(params: {
  claims: GieTruthClaim[];
  classifications: GieClassifiedTruthClaim[];
  winningClaim: GieTruthClaim | null;
  contradictions: GieTruthContradiction[];
}): GieTruthClaim[] {
  if (
    !params.winningClaim ||
    params.winningClaim.truthStatus === "complete" ||
    params.contradictions.length === 0
  ) {
    return [];
  }
  const byId = new Map(params.classifications.map((item) => [item.claimId, item]));
  const winningScore =
    byId.get(params.winningClaim.claimId)?.precedenceScore ?? Number.NEGATIVE_INFINITY;
  const conflictIds = new Set(params.contradictions.flatMap((item) => item.claimIds));
  return params.claims.filter((claim) => {
    if (!conflictIds.has(claim.claimId) || claim.truthStatus !== "complete") {
      return false;
    }
    const classification = byId.get(claim.claimId);
    if (
      !classification ||
      classification.classification === "superseded" ||
      classification.classification === "invalid"
    ) {
      return false;
    }
    return classification.precedenceScore < winningScore;
  });
}

export function resolveGieContradictions(
  input: GieContradictionResolverInput,
): GieContradictionResolution {
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const claims = input.subjectId
    ? input.claims.filter((claim) => claim.subjectId === input.subjectId)
    : input.claims;
  if (claims.length === 0) {
    return {
      resolution: "human_escalation_required",
      winningClaim: null,
      classifications: [],
      contradictions: [],
      reopenedClaims: [],
      humanEscalationRequired: true,
      humanEscalationRule: "missing_truth_claims",
      proofRefsUsed: [],
    };
  }

  const supersededIds = supersededClaimIds(claims);
  const classifications = claims.map((claim) =>
    classifyClaim({ claim, supersededIds, now, staleAfterMs }),
  );
  const contradictions = findContradictions({ claims, classifications });
  const winningClaim = selectWinningClaim({ claims, classifications });
  const proofRefsUsed = cleanProofRefs(claims.flatMap((claim) => claim.proofRefs));
  const reopenedClaims = reopenedFalseCompletionClaims({
    claims,
    classifications,
    winningClaim,
    contradictions,
  });

  const authorityEscalation = authorityConflictEscalation({
    claims,
    classifications,
    contradictions,
  });
  if (authorityEscalation) {
    return {
      resolution: "human_escalation_required",
      winningClaim,
      classifications,
      contradictions,
      reopenedClaims: [],
      humanEscalationRequired: true,
      humanEscalationRule: authorityEscalation,
      proofRefsUsed,
    };
  }

  if (equalStrengthConflict({ claims, classifications, winningClaim, contradictions })) {
    return {
      resolution: "human_escalation_required",
      winningClaim,
      classifications,
      contradictions,
      reopenedClaims: [],
      humanEscalationRequired: true,
      humanEscalationRule: "equal_strength_authority_conflict",
      proofRefsUsed,
    };
  }

  if (reopenedClaims.length > 0) {
    return {
      resolution: "false_completion_reopened",
      winningClaim,
      classifications,
      contradictions,
      reopenedClaims,
      humanEscalationRequired: false,
      humanEscalationRule: null,
      proofRefsUsed,
    };
  }

  return {
    resolution: contradictions.length > 0 ? "reconciled_to_stronger_truth" : "consistent",
    winningClaim,
    classifications,
    contradictions,
    reopenedClaims: [],
    humanEscalationRequired: false,
    humanEscalationRule: null,
    proofRefsUsed,
  };
}
