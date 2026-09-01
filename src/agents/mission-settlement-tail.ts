import type { SourceTurnDeliveryDecision } from "./source-turn-delivery-state.js";

export const MISSION_SETTLEMENT_STAGES = [
  "WORK_PENDING",
  "WORK_RUNNING",
  "WORK_COMPLETED",
  "RESULT_DURABLE",
  "CLOSEOUT_READY",
  "CLOSEOUT_VALIDATED",
  "REPORT_RENDERED",
  "DELIVERY_INTENT_DURABLE",
  "DELIVERY_STARTED",
  "DELIVERY_PROVEN",
  "DELIVERY_FAILED",
  "DELIVERY_UNKNOWN",
  "SETTLED",
] as const;

export type MissionSettlementStage = (typeof MISSION_SETTLEMENT_STAGES)[number];

export const MISSION_SETTLEMENT_FAILURE_STATES = [
  "WORK_FAILED",
  "WORK_UNCERTAIN",
  "CLOSEOUT_BLOCKED",
  "REPORT_BLOCKED",
  "PARENT_SCOPE_CONTINUATION_REQUIRED",
  "RECOVERY_REQUIRED",
  "OPERATOR_REVIEW_REQUIRED",
  "RECOVERY_EXHAUSTED_VERIFIED_BLOCKER",
] as const;

export type MissionSettlementFailureState = (typeof MISSION_SETTLEMENT_FAILURE_STATES)[number];

export type MissionSettlementState = MissionSettlementStage | MissionSettlementFailureState;

export type MissionWorkState = "pending" | "running" | "completed" | "failed" | "uncertain";

export type MissionDeliveryState =
  | "not_required"
  | "not_started"
  | "intent_durable"
  | "started"
  | "proven"
  | "failed"
  | "unknown";

export const STRUCTURED_CLOSEOUT_REQUIRED_FIELDS = [
  "whatIsMateriallyRealNow",
  "whatIsStillNotRealYet",
  "whoLawfullyOwnsNextStep",
  "openClosedTruth",
  "exactNextAction",
] as const;

export type StructuredCloseoutRequiredField = (typeof STRUCTURED_CLOSEOUT_REQUIRED_FIELDS)[number];

export type StructuredMissionCloseout = {
  runLabel: string;
  targetHandled: string;
  scopeHandled: string;
  actualExecutionOwner: string;
  artifactPaths: string[];
  proofPaths: string[];
  whatIsMateriallyRealNow: string;
  whatIsStillNotRealYet: string;
  whoLawfullyOwnsNextStep: string;
  openClosedTruth: string;
  exactNextAction: string;
  shortResult: string;
};

export type StructuredCloseoutValidation = {
  valid: boolean;
  missingFields: StructuredCloseoutRequiredField[];
  missingSupportFields: Array<
    | "runLabel"
    | "targetHandled"
    | "scopeHandled"
    | "actualExecutionOwner"
    | "artifactPaths"
    | "proofPaths"
    | "shortResult"
  >;
};

export type MissionSettlementTailFacts = {
  missionId: string;
  activeMissionScope?: string;
  closeoutScope?: string;
  reviewScope?: string;
  remainingParentScope?: string;
  parentContinuationCoverage?: ParentContinuationCoverageFacts;
  workState: MissionWorkState;
  resultDurable?: boolean;
  closeout?: StructuredMissionCloseout;
  closeoutReady?: boolean;
  reportRequired?: boolean;
  reportRendered?: boolean;
  deliveryState?: MissionDeliveryState;
  oldWorkerAlive?: boolean;
  recoveryConflict?: boolean;
  recoveryExhausted?: boolean;
  verifiedBlockerArtifact?: boolean;
  oversizedEvidenceTruncated?: boolean;
  oversizedEvidenceReference?: string;
  oversizedEvidenceSufficient?: boolean;
};

export type SourceTurnMissionSettlementFacts = Omit<MissionSettlementTailFacts, "deliveryState"> & {
  sourceTurnDelivery: SourceTurnDeliveryDecision;
};

export type MissionSettlementRecoveryAction =
  | "start_or_continue_work"
  | "reconcile_live_worker_before_recovery"
  | "persist_completed_result"
  | "repair_structured_closeout_only"
  | "render_human_report_from_validated_closeout"
  | "persist_delivery_intent"
  | "attempt_delivery_only"
  | "retry_delivery_only_with_idempotency"
  | "reconcile_ambiguous_delivery_ack"
  | "record_bounded_evidence_reference"
  | "record_verified_blocker"
  | "record_parent_scope_continuation_coverage"
  | "reread_after_revision_conflict"
  | "settlement_complete";

export type MissionSettlementDecision = {
  schema: "openclaw.mission_settlement_tail_decision.v1";
  missionId: string;
  state: MissionSettlementState;
  settled: boolean;
  allowedToCloseMission: boolean;
  workCompletionSettledSeparately: boolean;
  closeoutValidation?: StructuredCloseoutValidation;
  recoveryAction: MissionSettlementRecoveryAction;
  validationErrors: string[];
  nextIncompleteBoundary: string;
};

export const GOVERNED_TURN_SETTLEMENT_STATES = [
  "unsettled",
  "settled_delivered",
  "settled_handoff",
  "settled_blocked",
] as const;

export type GovernedTurnSettlementState = (typeof GOVERNED_TURN_SETTLEMENT_STATES)[number];

export type GovernedTurnSettlementBoundary =
  | "none"
  | "settlement_identity"
  | "final_report_artifact"
  | "visible_final_delivery"
  | "issue_register_action"
  | "tool_boundary_integrity"
  | "watchdog_proof"
  | "next_step_coverage";

export type GovernedTurnSettlementRecoveryAction =
  | "record_settlement_identity"
  | "write_final_report_artifact"
  | "deliver_final_report"
  | "record_issue_register_action"
  | "record_tool_boundary_failure"
  | "collect_watchdog_proof"
  | "record_next_step_coverage"
  | "continue_from_handoff"
  | "keep_lawful_blocker_visible"
  | "settlement_complete";

export const PARENT_CONTINUATION_COVERAGE_KINDS = [
  "missing",
  "next_executable_parent_step_started",
  "durable_wait",
  "lawful_blocker",
  "operator_scope_change",
  "parent_scope_proven_closed",
] as const;

export type ParentContinuationCoverageKind = (typeof PARENT_CONTINUATION_COVERAGE_KINDS)[number];

export type ParentContinuationCoverageFacts = {
  kind?: ParentContinuationCoverageKind;
  owner?: string;
  reason?: string;
  nextCheck?: string;
  deadline?: string;
  evidence?: string[];
  exhaustedPaths?: string[];
  approvalProof?: string;
};

export type GovernedTurnSettlementFacts = {
  settlementId?: string;
  missionId?: string;
  activeMissionScope?: string;
  closeoutScope?: string;
  reviewScope?: string;
  remainingParentScope?: string;
  parentContinuationCoverage?: ParentContinuationCoverageFacts;
  finalReportRequired?: boolean;
  finalReportArtifactWritten?: boolean;
  finalReportVisibleDeliveryProven?: boolean;
  issueFamilyNamed?: boolean;
  issueRegisterActionProven?: boolean;
  lawfulNoIssueUpdateReason?: string;
  broaderMissionOpen?: boolean;
  nextExecutableStepStarted?: boolean;
  durableWaitRecorded?: boolean;
  lawfulBlockerRecorded?: boolean;
  toolBoundaryClean?: boolean;
  toolBoundaryFailureRecorded?: boolean;
  watchdogProofCollected?: boolean;
};

export type GovernedTurnSettlementDecision = {
  schema: "openclaw.governed_turn_settlement_decision.v1";
  settlementId: string;
  missionId: string;
  state: GovernedTurnSettlementState;
  allowedToCloseMission: boolean;
  allowedToAcceptReport: boolean;
  watchdogVisible: boolean;
  recoveryAction: GovernedTurnSettlementRecoveryAction;
  nextIncompleteBoundary: GovernedTurnSettlementBoundary;
  validationErrors: string[];
};

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasEntries(value: string[] | undefined): boolean {
  return Array.isArray(value) && value.some((entry) => hasText(entry));
}

function normalizedText(value: string | undefined): string | undefined {
  return hasText(value) ? value.trim().replace(/\s+/gu, " ").toLowerCase() : undefined;
}

function normalizeSettlementId(value: string | undefined, fallback: string): string {
  return hasText(value) ? value.trim() : fallback;
}

function scopeValuesDiffer(first: string | undefined, second: string | undefined): boolean {
  const normalizedFirst = normalizedText(first);
  const normalizedSecond = normalizedText(second);
  return Boolean(normalizedFirst && normalizedSecond && normalizedFirst !== normalizedSecond);
}

function hasOpenParentScope(facts: GovernedTurnSettlementFacts): boolean {
  return (
    facts.broaderMissionOpen === true ||
    hasText(facts.remainingParentScope) ||
    scopeValuesDiffer(facts.activeMissionScope, facts.closeoutScope) ||
    scopeValuesDiffer(facts.activeMissionScope, facts.reviewScope)
  );
}

function validateParentContinuationCoverage(facts: GovernedTurnSettlementFacts): {
  covered: boolean;
  parentProvenClosed: boolean;
  validationErrors: string[];
} {
  const validationErrors: string[] = [];
  const coverage = facts.parentContinuationCoverage;
  if (coverage?.kind === "parent_scope_proven_closed") {
    return { covered: true, parentProvenClosed: true, validationErrors };
  }
  if (coverage?.kind === "next_executable_parent_step_started") {
    return { covered: true, parentProvenClosed: false, validationErrors };
  }
  if (coverage?.kind === "durable_wait") {
    if (!hasText(coverage.owner)) {
      validationErrors.push("durable_wait_owner_missing");
    }
    if (!hasText(coverage.reason)) {
      validationErrors.push("durable_wait_reason_missing");
    }
    if (!hasText(coverage.nextCheck)) {
      validationErrors.push("durable_wait_next_check_missing");
    }
    if (!hasText(coverage.deadline)) {
      validationErrors.push("durable_wait_deadline_missing");
    }
    return {
      covered: validationErrors.length === 0,
      parentProvenClosed: false,
      validationErrors,
    };
  }
  if (coverage?.kind === "lawful_blocker") {
    if (!hasEntries(coverage.evidence)) {
      validationErrors.push("lawful_blocker_evidence_missing");
    }
    if (!hasEntries(coverage.exhaustedPaths)) {
      validationErrors.push("lawful_blocker_exhausted_paths_missing");
    }
    return {
      covered: validationErrors.length === 0,
      parentProvenClosed: false,
      validationErrors,
    };
  }
  if (coverage?.kind === "operator_scope_change") {
    if (!hasText(coverage.approvalProof)) {
      validationErrors.push("operator_scope_change_approval_proof_missing");
    }
    return {
      covered: validationErrors.length === 0,
      parentProvenClosed: false,
      validationErrors,
    };
  }
  if (facts.nextExecutableStepStarted === true) {
    return { covered: true, parentProvenClosed: false, validationErrors };
  }
  if (facts.durableWaitRecorded === true) {
    return { covered: true, parentProvenClosed: false, validationErrors };
  }
  if (facts.lawfulBlockerRecorded === true) {
    return { covered: true, parentProvenClosed: false, validationErrors };
  }
  validationErrors.push("parent_scope_continuation_required");
  return { covered: false, parentProvenClosed: false, validationErrors };
}

function createGovernedTurnSettlementDecision(
  facts: GovernedTurnSettlementFacts,
  params: {
    state: GovernedTurnSettlementState;
    allowedToCloseMission: boolean;
    allowedToAcceptReport: boolean;
    watchdogVisible: boolean;
    recoveryAction: GovernedTurnSettlementRecoveryAction;
    nextIncompleteBoundary: GovernedTurnSettlementBoundary;
    validationErrors: string[];
  },
): GovernedTurnSettlementDecision {
  return {
    schema: "openclaw.governed_turn_settlement_decision.v1",
    settlementId: normalizeSettlementId(facts.settlementId, "unknown"),
    missionId: normalizeSettlementId(facts.missionId, "unknown"),
    ...params,
  };
}

export function resolveGovernedTurnSettlement(
  facts: GovernedTurnSettlementFacts,
): GovernedTurnSettlementDecision {
  const validationErrors: string[] = [];
  if (!hasText(facts.settlementId)) {
    validationErrors.push("settlement_id_missing");
  }
  if (!hasText(facts.missionId)) {
    validationErrors.push("mission_id_missing");
  }
  if (validationErrors.length > 0) {
    return createGovernedTurnSettlementDecision(facts, {
      state: "unsettled",
      allowedToCloseMission: false,
      allowedToAcceptReport: false,
      watchdogVisible: true,
      recoveryAction: "record_settlement_identity",
      nextIncompleteBoundary: "settlement_identity",
      validationErrors,
    });
  }
  if (facts.finalReportRequired === true && facts.finalReportArtifactWritten !== true) {
    return createGovernedTurnSettlementDecision(facts, {
      state: "unsettled",
      allowedToCloseMission: false,
      allowedToAcceptReport: false,
      watchdogVisible: true,
      recoveryAction: "write_final_report_artifact",
      nextIncompleteBoundary: "final_report_artifact",
      validationErrors,
    });
  }
  if (facts.finalReportRequired === true && facts.finalReportVisibleDeliveryProven !== true) {
    return createGovernedTurnSettlementDecision(facts, {
      state: "unsettled",
      allowedToCloseMission: false,
      allowedToAcceptReport: false,
      watchdogVisible: true,
      recoveryAction: "deliver_final_report",
      nextIncompleteBoundary: "visible_final_delivery",
      validationErrors,
    });
  }
  if (
    facts.issueFamilyNamed === true &&
    facts.issueRegisterActionProven !== true &&
    !hasText(facts.lawfulNoIssueUpdateReason)
  ) {
    return createGovernedTurnSettlementDecision(facts, {
      state: "unsettled",
      allowedToCloseMission: false,
      allowedToAcceptReport: false,
      watchdogVisible: true,
      recoveryAction: "record_issue_register_action",
      nextIncompleteBoundary: "issue_register_action",
      validationErrors,
    });
  }
  if (facts.toolBoundaryClean === false && facts.toolBoundaryFailureRecorded !== true) {
    return createGovernedTurnSettlementDecision(facts, {
      state: "unsettled",
      allowedToCloseMission: false,
      allowedToAcceptReport: false,
      watchdogVisible: true,
      recoveryAction: "record_tool_boundary_failure",
      nextIncompleteBoundary: "tool_boundary_integrity",
      validationErrors,
    });
  }
  if (facts.watchdogProofCollected === false) {
    return createGovernedTurnSettlementDecision(facts, {
      state: "unsettled",
      allowedToCloseMission: false,
      allowedToAcceptReport: false,
      watchdogVisible: true,
      recoveryAction: "collect_watchdog_proof",
      nextIncompleteBoundary: "watchdog_proof",
      validationErrors,
    });
  }
  const parentContinuation = validateParentContinuationCoverage(facts);
  validationErrors.push(...parentContinuation.validationErrors);
  const parentScopeOpen = hasOpenParentScope(facts) && !parentContinuation.parentProvenClosed;
  if (parentScopeOpen && !parentContinuation.covered) {
    return createGovernedTurnSettlementDecision(facts, {
      state: "unsettled",
      allowedToCloseMission: false,
      allowedToAcceptReport: false,
      watchdogVisible: true,
      recoveryAction: "record_next_step_coverage",
      nextIncompleteBoundary: "next_step_coverage",
      validationErrors,
    });
  }
  if (
    facts.lawfulBlockerRecorded === true ||
    facts.parentContinuationCoverage?.kind === "lawful_blocker"
  ) {
    return createGovernedTurnSettlementDecision(facts, {
      state: "settled_blocked",
      allowedToCloseMission: false,
      allowedToAcceptReport: true,
      watchdogVisible: false,
      recoveryAction: "keep_lawful_blocker_visible",
      nextIncompleteBoundary: "none",
      validationErrors,
    });
  }
  if (parentScopeOpen) {
    return createGovernedTurnSettlementDecision(facts, {
      state: "settled_handoff",
      allowedToCloseMission: false,
      allowedToAcceptReport: true,
      watchdogVisible: false,
      recoveryAction: "continue_from_handoff",
      nextIncompleteBoundary: "none",
      validationErrors,
    });
  }
  return createGovernedTurnSettlementDecision(facts, {
    state: "settled_delivered",
    allowedToCloseMission: true,
    allowedToAcceptReport: true,
    watchdogVisible: false,
    recoveryAction: "settlement_complete",
    nextIncompleteBoundary: "none",
    validationErrors,
  });
}

export function validateStructuredMissionCloseout(
  closeout: StructuredMissionCloseout | undefined,
): StructuredCloseoutValidation {
  if (!closeout) {
    return {
      valid: false,
      missingFields: [...STRUCTURED_CLOSEOUT_REQUIRED_FIELDS],
      missingSupportFields: [
        "runLabel",
        "targetHandled",
        "scopeHandled",
        "actualExecutionOwner",
        "artifactPaths",
        "proofPaths",
        "shortResult",
      ],
    };
  }

  const missingFields = STRUCTURED_CLOSEOUT_REQUIRED_FIELDS.filter(
    (field) => !hasText(closeout[field]),
  );
  const missingSupportFields: StructuredCloseoutValidation["missingSupportFields"] = [];
  if (!hasText(closeout.runLabel)) {
    missingSupportFields.push("runLabel");
  }
  if (!hasText(closeout.targetHandled)) {
    missingSupportFields.push("targetHandled");
  }
  if (!hasText(closeout.scopeHandled)) {
    missingSupportFields.push("scopeHandled");
  }
  if (!hasText(closeout.actualExecutionOwner)) {
    missingSupportFields.push("actualExecutionOwner");
  }
  if (!hasEntries(closeout.artifactPaths)) {
    missingSupportFields.push("artifactPaths");
  }
  if (!hasEntries(closeout.proofPaths)) {
    missingSupportFields.push("proofPaths");
  }
  if (!hasText(closeout.shortResult)) {
    missingSupportFields.push("shortResult");
  }
  return {
    valid: missingFields.length === 0 && missingSupportFields.length === 0,
    missingFields,
    missingSupportFields,
  };
}

export function renderMissionCloseoutReport(closeout: StructuredMissionCloseout): string {
  return [
    closeout.runLabel,
    "",
    "Target handled:",
    closeout.targetHandled,
    "",
    "Scope handled:",
    closeout.scopeHandled,
    "",
    "Actual execution owner:",
    closeout.actualExecutionOwner,
    "",
    "Artifact path(s):",
    ...closeout.artifactPaths.map((artifactPath) => `- ${artifactPath}`),
    "",
    "Proof path(s):",
    ...closeout.proofPaths.map((proofPath) => `- ${proofPath}`),
    "",
    "What is materially real now:",
    closeout.whatIsMateriallyRealNow,
    "",
    "What is still not real yet:",
    closeout.whatIsStillNotRealYet,
    "",
    "Who lawfully owns the next step:",
    closeout.whoLawfullyOwnsNextStep,
    "",
    "Open/closed truth:",
    closeout.openClosedTruth,
    "",
    "Exact next action:",
    closeout.exactNextAction,
    "",
    "Short result:",
    closeout.shortResult,
  ].join("\n");
}

function stateForDelivery(deliveryState: MissionDeliveryState): MissionSettlementStage {
  switch (deliveryState) {
    case "intent_durable":
      return "DELIVERY_INTENT_DURABLE";
    case "started":
      return "DELIVERY_STARTED";
    case "proven":
      return "DELIVERY_PROVEN";
    case "failed":
      return "DELIVERY_FAILED";
    case "unknown":
      return "DELIVERY_UNKNOWN";
    case "not_required":
    case "not_started":
      return "REPORT_RENDERED";
    default:
      return "REPORT_RENDERED";
  }
}

export function missionDeliveryStateFromSourceTurnDelivery(
  decision: SourceTurnDeliveryDecision,
): MissionDeliveryState {
  switch (decision.state) {
    case "final_delivered":
    case "settled_resolved_later":
      return "proven";
    case "final_delivery_failed":
      return "failed";
    case "final_delivery_unknown":
      return "unknown";
    case "progress_delivered":
    case "failure_delivered":
      return "started";
    case "accepted":
    case "blocked_refused":
      return "not_started";
    default:
      return "not_started";
  }
}

export function resolveMissionSettlementTailFromSourceTurnDelivery(
  facts: SourceTurnMissionSettlementFacts,
): MissionSettlementDecision {
  return resolveMissionSettlementTail({
    ...facts,
    deliveryState: missionDeliveryStateFromSourceTurnDelivery(facts.sourceTurnDelivery),
  });
}

export function resolveMissionSettlementTail(
  facts: MissionSettlementTailFacts,
): MissionSettlementDecision {
  const missionId = hasText(facts.missionId) ? facts.missionId.trim() : "unknown";
  const validationErrors: string[] = [];
  if (missionId === "unknown") {
    validationErrors.push("mission_id_missing");
  }
  if (facts.recoveryConflict === true) {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "RECOVERY_REQUIRED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: false,
      recoveryAction: "reread_after_revision_conflict",
      validationErrors,
      nextIncompleteBoundary: "revision_conflict",
    };
  }
  if (facts.oldWorkerAlive === true && facts.workState !== "completed") {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "RECOVERY_REQUIRED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: false,
      recoveryAction: "reconcile_live_worker_before_recovery",
      validationErrors,
      nextIncompleteBoundary: "live_worker",
    };
  }
  if (facts.recoveryExhausted === true) {
    const hasBlockerArtifact = facts.verifiedBlockerArtifact === true;
    if (!hasBlockerArtifact) {
      validationErrors.push("verified_blocker_artifact_missing");
    }
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: hasBlockerArtifact
        ? "RECOVERY_EXHAUSTED_VERIFIED_BLOCKER"
        : "OPERATOR_REVIEW_REQUIRED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: facts.workState === "completed",
      recoveryAction: hasBlockerArtifact
        ? "record_verified_blocker"
        : "reconcile_ambiguous_delivery_ack",
      validationErrors,
      nextIncompleteBoundary: hasBlockerArtifact ? "verified_blocker" : "operator_review",
    };
  }
  if (
    facts.oversizedEvidenceTruncated === true &&
    (!hasText(facts.oversizedEvidenceReference) || facts.oversizedEvidenceSufficient !== true)
  ) {
    if (!hasText(facts.oversizedEvidenceReference)) {
      validationErrors.push("oversized_evidence_reference_missing");
    }
    if (facts.oversizedEvidenceSufficient !== true) {
      validationErrors.push("oversized_evidence_sufficiency_unproven");
    }
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "RECOVERY_REQUIRED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: facts.workState === "completed",
      recoveryAction: "record_bounded_evidence_reference",
      validationErrors,
      nextIncompleteBoundary: "oversized_evidence_sufficiency",
    };
  }
  if (facts.workState === "failed") {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "WORK_FAILED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: false,
      recoveryAction: "start_or_continue_work",
      validationErrors,
      nextIncompleteBoundary: "work",
    };
  }
  if (facts.workState === "uncertain") {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "WORK_UNCERTAIN",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: false,
      recoveryAction: "reconcile_live_worker_before_recovery",
      validationErrors,
      nextIncompleteBoundary: "work",
    };
  }
  if (facts.workState === "pending" || facts.workState === "running") {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: facts.workState === "pending" ? "WORK_PENDING" : "WORK_RUNNING",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: false,
      recoveryAction: "start_or_continue_work",
      validationErrors,
      nextIncompleteBoundary: "work",
    };
  }
  if (facts.resultDurable !== true) {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "WORK_COMPLETED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      recoveryAction: "persist_completed_result",
      validationErrors,
      nextIncompleteBoundary: "result_durable",
    };
  }

  const closeoutValidation = validateStructuredMissionCloseout(facts.closeout);
  if (facts.closeoutReady !== true) {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "RESULT_DURABLE",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      closeoutValidation,
      recoveryAction: "repair_structured_closeout_only",
      validationErrors,
      nextIncompleteBoundary: "closeout_ready",
    };
  }
  if (!closeoutValidation.valid) {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "CLOSEOUT_BLOCKED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      closeoutValidation,
      recoveryAction: "repair_structured_closeout_only",
      validationErrors,
      nextIncompleteBoundary: "closeout_validated",
    };
  }
  if (facts.reportRequired === true && facts.reportRendered !== true) {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "CLOSEOUT_VALIDATED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      closeoutValidation,
      recoveryAction: "render_human_report_from_validated_closeout",
      validationErrors,
      nextIncompleteBoundary: "report_rendered",
    };
  }
  if (facts.reportRequired !== true) {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "SETTLED",
      settled: true,
      allowedToCloseMission: true,
      workCompletionSettledSeparately: true,
      closeoutValidation,
      recoveryAction: "settlement_complete",
      validationErrors,
      nextIncompleteBoundary: "none",
    };
  }

  const deliveryState = facts.deliveryState ?? "not_started";
  if (deliveryState === "not_started") {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "REPORT_RENDERED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      closeoutValidation,
      recoveryAction: "persist_delivery_intent",
      validationErrors,
      nextIncompleteBoundary: "delivery_intent",
    };
  }
  if (deliveryState === "intent_durable") {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "DELIVERY_INTENT_DURABLE",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      closeoutValidation,
      recoveryAction: "attempt_delivery_only",
      validationErrors,
      nextIncompleteBoundary: "delivery_attempt",
    };
  }
  if (deliveryState === "started") {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "DELIVERY_STARTED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      closeoutValidation,
      recoveryAction: "retry_delivery_only_with_idempotency",
      validationErrors,
      nextIncompleteBoundary: "delivery_ack",
    };
  }
  if (deliveryState === "failed" || deliveryState === "unknown") {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: stateForDelivery(deliveryState),
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      closeoutValidation,
      recoveryAction:
        deliveryState === "failed"
          ? "retry_delivery_only_with_idempotency"
          : "reconcile_ambiguous_delivery_ack",
      validationErrors,
      nextIncompleteBoundary: deliveryState === "failed" ? "delivery_retry" : "delivery_unknown",
    };
  }
  const parentContinuation = validateParentContinuationCoverage(facts);
  validationErrors.push(...parentContinuation.validationErrors);
  const parentScopeOpen = hasOpenParentScope(facts) && !parentContinuation.parentProvenClosed;
  if (parentScopeOpen && !parentContinuation.covered) {
    return {
      schema: "openclaw.mission_settlement_tail_decision.v1",
      missionId,
      state: "PARENT_SCOPE_CONTINUATION_REQUIRED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      closeoutValidation,
      recoveryAction: "record_parent_scope_continuation_coverage",
      validationErrors,
      nextIncompleteBoundary: "parent_scope_continuation_required",
    };
  }
  return {
    schema: "openclaw.mission_settlement_tail_decision.v1",
    missionId,
    state: "SETTLED",
    settled: true,
    allowedToCloseMission: !parentScopeOpen,
    workCompletionSettledSeparately: true,
    closeoutValidation,
    recoveryAction: "settlement_complete",
    validationErrors,
    nextIncompleteBoundary: "none",
  };
}
