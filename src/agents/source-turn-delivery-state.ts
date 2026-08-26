export const SOURCE_TURN_DELIVERY_STATES = [
  "accepted",
  "progress_delivered",
  "final_delivered",
  "final_delivery_failed",
  "failure_delivered",
  "settled_resolved_later",
  "blocked_refused",
] as const;

export type SourceTurnDeliveryState = (typeof SOURCE_TURN_DELIVERY_STATES)[number];

export const SOURCE_TURN_VISIBLE_FINAL_PROOF_KINDS = [
  "source_chat_final",
  "verified_message_tool_final",
  "direct_source_final",
] as const;

export type SourceTurnVisibleFinalProofKind =
  (typeof SOURCE_TURN_VISIBLE_FINAL_PROOF_KINDS)[number];

export type SourceTurnDeliveryEvidenceKind =
  | SourceTurnVisibleFinalProofKind
  | "source_chat_progress"
  | "source_chat_failure"
  | "mark_facing_export_visible"
  | "ledger_write"
  | "report_artifact"
  | "registry_entry"
  | "closeout_artifact"
  | "internal_evidence_record"
  | "private_final_response"
  | "delivery_tool_failure"
  | "settled_resolved_later";

export type SourceTurnDeliveryGuardReason =
  | "accepted"
  | "progress_visible_but_final_not_proven"
  | "final_visible_delivery_proven"
  | "delivery_tool_failed"
  | "failure_notice_visible"
  | "historical_debt_settled_not_delivered"
  | "private_final_without_visible_delivery"
  | "missing_visible_final_delivery_proof"
  | "missing_mark_facing_export_proof"
  | "missing_report_path"
  | "false_final_delivery_delivered_refused";

export type SourceTurnDeliveryFacts = {
  finalDeliveryRequired?: boolean;
  finalDeliveryDelivered?: boolean;
  hasVisibleFinalDeliveryProof?: boolean;
  visibleFinalProofKind?: SourceTurnVisibleFinalProofKind;
  evidenceKinds?: SourceTurnDeliveryEvidenceKind[];
  reportRequired?: boolean;
  reportArtifactPath?: string;
  markFacingExportRequired?: boolean;
  markFacingExportRoot?: string;
  markFacingExportPath?: string;
  markFacingExportVerified?: boolean;
  privateOnlyFinalResponse?: boolean;
  deliveryToolFailed?: boolean;
  failureNoticeVisible?: boolean;
  historicalSettlement?: boolean;
};

export type SourceTurnDeliveryDecision = {
  state: SourceTurnDeliveryState;
  finalDeliveryDelivered: boolean;
  refused: boolean;
  reason: SourceTurnDeliveryGuardReason;
};

const nonVisibleFinalEvidence = new Set<SourceTurnDeliveryEvidenceKind>([
  "ledger_write",
  "report_artifact",
  "registry_entry",
  "closeout_artifact",
  "internal_evidence_record",
  "private_final_response",
]);

export function isSourceTurnVisibleFinalProofKind(
  kind: SourceTurnDeliveryEvidenceKind | undefined,
): kind is SourceTurnVisibleFinalProofKind {
  return kind !== undefined && SOURCE_TURN_VISIBLE_FINAL_PROOF_KINDS.includes(kind as never);
}

function hasVisibleFinalDeliveryProof(facts: SourceTurnDeliveryFacts): boolean {
  if (facts.hasVisibleFinalDeliveryProof === true) {
    return true;
  }
  if (isSourceTurnVisibleFinalProofKind(facts.visibleFinalProofKind)) {
    return true;
  }
  return (facts.evidenceKinds ?? []).some(isSourceTurnVisibleFinalProofKind);
}

function hasProgressProof(facts: SourceTurnDeliveryFacts): boolean {
  return (facts.evidenceKinds ?? []).includes("source_chat_progress");
}

function hasMarkFacingExportProof(facts: SourceTurnDeliveryFacts): boolean {
  return (
    facts.markFacingExportVerified === true ||
    (facts.evidenceKinds ?? []).includes("mark_facing_export_visible")
  );
}

function hasOnlyNonVisibleFinalEvidence(facts: SourceTurnDeliveryFacts): boolean {
  const evidenceKinds = facts.evidenceKinds ?? [];
  return (
    evidenceKinds.length > 0 && evidenceKinds.every((kind) => nonVisibleFinalEvidence.has(kind))
  );
}

function isHistoricalSettlement(facts: SourceTurnDeliveryFacts): boolean {
  return (
    facts.historicalSettlement === true ||
    (facts.evidenceKinds ?? []).includes("settled_resolved_later")
  );
}

/**
 * Resolves the source-turn delivery contract only. It does not write evidence,
 * mutate registries, replay delivery, or integrate with runtime dispatch.
 */
export function resolveSourceTurnDeliveryState(
  facts: SourceTurnDeliveryFacts,
): SourceTurnDeliveryDecision {
  if (isHistoricalSettlement(facts)) {
    return {
      state: "settled_resolved_later",
      finalDeliveryDelivered: false,
      refused: false,
      reason: "historical_debt_settled_not_delivered",
    };
  }

  const visibleFinalDeliveryProof = hasVisibleFinalDeliveryProof(facts);
  const markFacingExportProof = hasMarkFacingExportProof(facts);
  const markFacingExportMissing = facts.markFacingExportRequired === true && !markFacingExportProof;
  const claimsFinalDelivered = facts.finalDeliveryDelivered === true;

  if (claimsFinalDelivered && !visibleFinalDeliveryProof) {
    return {
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "false_final_delivery_delivered_refused",
    };
  }

  if (claimsFinalDelivered && markFacingExportMissing) {
    return {
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "missing_mark_facing_export_proof",
    };
  }

  if (
    facts.deliveryToolFailed === true ||
    (facts.evidenceKinds ?? []).includes("delivery_tool_failure")
  ) {
    return {
      state: "final_delivery_failed",
      finalDeliveryDelivered: false,
      refused: false,
      reason: "delivery_tool_failed",
    };
  }

  if (
    facts.failureNoticeVisible === true ||
    (facts.evidenceKinds ?? []).includes("source_chat_failure")
  ) {
    return {
      state: "failure_delivered",
      finalDeliveryDelivered: false,
      refused: false,
      reason: "failure_notice_visible",
    };
  }

  if (visibleFinalDeliveryProof && !markFacingExportMissing) {
    return {
      state: "final_delivered",
      finalDeliveryDelivered: true,
      refused: false,
      reason: "final_visible_delivery_proven",
    };
  }

  if (
    facts.privateOnlyFinalResponse === true ||
    (facts.evidenceKinds ?? []).includes("private_final_response")
  ) {
    return {
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "private_final_without_visible_delivery",
    };
  }

  if (facts.reportRequired === true && !facts.reportArtifactPath?.trim()) {
    return {
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "missing_report_path",
    };
  }

  if (markFacingExportMissing) {
    return {
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "missing_mark_facing_export_proof",
    };
  }

  if (facts.finalDeliveryRequired === true || hasOnlyNonVisibleFinalEvidence(facts)) {
    return {
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "missing_visible_final_delivery_proof",
    };
  }

  if (hasProgressProof(facts)) {
    return {
      state: "progress_delivered",
      finalDeliveryDelivered: false,
      refused: false,
      reason: "progress_visible_but_final_not_proven",
    };
  }

  return {
    state: "accepted",
    finalDeliveryDelivered: false,
    refused: false,
    reason: "accepted",
  };
}
