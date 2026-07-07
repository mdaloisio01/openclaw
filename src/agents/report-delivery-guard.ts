export const REPORT_DELIVERY_GUARD_STATES = [
  "not_required",
  "report_delivery_satisfied",
  "pending_report_delivery",
  "pending_milestone_report",
  "blocked_missing_report_path",
  "blocked_private_only_report",
] as const;

export type ReportDeliveryGuardState = (typeof REPORT_DELIVERY_GUARD_STATES)[number];

export type ReportDeliveryGuardReason =
  | "not_required"
  | "report_body_delivered"
  | "explicit_artifact_only_allowed"
  | "artifact_only_without_chat_body"
  | "private_only_report_without_chat_body"
  | "missing_report_path"
  | "milestone_stage_report_missing";

export type ReportDeliveryGuardFacts = {
  reportGenerated?: boolean;
  reportArtifactPath?: string;
  reportBodyDeliveredInChat?: boolean;
  explicitArtifactOnlyAllowed?: boolean;
  privateOnlyFinalResponse?: boolean;
  milestoneStageCompleted?: boolean;
  milestoneReportRequired?: boolean;
  milestoneReportDelivered?: boolean;
};

export type ReportDeliveryGuardDecision = {
  state: ReportDeliveryGuardState;
  allowed: boolean;
  reportDeliveryComplete: boolean;
  milestoneReportComplete: boolean;
  reason: ReportDeliveryGuardReason;
};

export const REQUIRED_MILESTONE_REPORT_FIELDS = [
  "STATUS:",
  "MODE:",
  "STAGE COMPLETE:",
  "RESULT:",
  "PROOF:",
  "NEXT STAGE:",
  "SAFETY CHECK:",
  "BLOCKERS:",
] as const;

export type RequiredMilestoneReportField = (typeof REQUIRED_MILESTONE_REPORT_FIELDS)[number];

export const CLEANUP_CREW_MILESTONE_REPORT_MOMENTS = [
  "build_complete",
  "asset_guard_complete",
  "restart_starts",
  "restart_fails",
  "restart_completes",
  "proof_passes",
  "proof_fails",
  "grant_fail",
  "watchdog_needs_review",
  "watchdog_reconciliation_complete",
  "interruption_or_aborted_tool",
  "phase_closeout",
  "explicit_status_or_report_request",
] as const;

export type CleanupCrewMilestoneReportMoment =
  (typeof CLEANUP_CREW_MILESTONE_REPORT_MOMENTS)[number];

export type MilestoneReportFormatDecision = {
  valid: boolean;
  missingFields: RequiredMilestoneReportField[];
};

export type CleanupCrewStageTransitionFacts = {
  moment: CleanupCrewMilestoneReportMoment;
  milestoneReportText?: string;
  milestoneReportDelivered?: boolean;
  explicitReportOnlyRequest?: boolean;
  explicitStopRequest?: boolean;
  sopBlockerPresent?: boolean;
  watchdogNeedsReview?: boolean;
  grantFailed?: boolean;
  proofInterruptedOrAborted?: boolean;
};

export type CleanupCrewStageTransitionDecision = {
  state:
    | "continue_after_visibility_report"
    | "stop_after_report_only_request"
    | "stop_after_explicit_stop"
    | "pending_milestone_report"
    | "pause_for_watchdog_needs_review"
    | "route_grant_fail_repair"
    | "proof_unproven_recovery_required"
    | "blocked_by_sop";
  shouldContinue: boolean;
  allowedToAdvance: boolean;
  requiredReportDelivered: boolean;
  milestoneReportFormat: MilestoneReportFormatDecision;
  nextAction: string;
};

function hasPath(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function milestoneRequired(facts: ReportDeliveryGuardFacts): boolean {
  return facts.milestoneStageCompleted === true && facts.milestoneReportRequired !== false;
}

/**
 * Pure report/milestone delivery guard. It does not write artifacts, deliver
 * messages, mutate registries, or inspect live chat state.
 */
export function resolveReportDeliveryGuard(
  facts: ReportDeliveryGuardFacts,
): ReportDeliveryGuardDecision {
  const reportRequired = facts.reportGenerated === true;
  if (reportRequired && !hasPath(facts.reportArtifactPath)) {
    return {
      state: "blocked_missing_report_path",
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "missing_report_path",
    };
  }

  if (
    reportRequired &&
    facts.privateOnlyFinalResponse === true &&
    facts.reportBodyDeliveredInChat !== true
  ) {
    return {
      state: "blocked_private_only_report",
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "private_only_report_without_chat_body",
    };
  }

  if (
    reportRequired &&
    facts.reportBodyDeliveredInChat !== true &&
    facts.explicitArtifactOnlyAllowed !== true
  ) {
    return {
      state: "pending_report_delivery",
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "artifact_only_without_chat_body",
    };
  }

  if (milestoneRequired(facts) && facts.milestoneReportDelivered !== true) {
    return {
      state: "pending_milestone_report",
      allowed: false,
      reportDeliveryComplete: reportRequired,
      milestoneReportComplete: false,
      reason: "milestone_stage_report_missing",
    };
  }

  if (reportRequired) {
    const artifactOnly = facts.explicitArtifactOnlyAllowed === true;
    return {
      state: "report_delivery_satisfied",
      allowed: true,
      reportDeliveryComplete: true,
      milestoneReportComplete: !milestoneRequired(facts) || facts.milestoneReportDelivered === true,
      reason: artifactOnly ? "explicit_artifact_only_allowed" : "report_body_delivered",
    };
  }

  return {
    state: "not_required",
    allowed: true,
    reportDeliveryComplete: false,
    milestoneReportComplete: !milestoneRequired(facts) || facts.milestoneReportDelivered === true,
    reason: "not_required",
  };
}

export function validateMilestoneReportFormat(
  reportText: string | undefined,
): MilestoneReportFormatDecision {
  const text = reportText ?? "";
  const missingFields = REQUIRED_MILESTONE_REPORT_FIELDS.filter((field) => !text.includes(field));
  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Pure Cleanup Crew phase-transition guard. Milestone reporting is a
 * visibility gate: once a valid required report is delivered, continuation is
 * allowed unless an SOP blocker or higher-priority repair route exists.
 */
export function resolveCleanupCrewStageTransition(
  facts: CleanupCrewStageTransitionFacts,
): CleanupCrewStageTransitionDecision {
  const milestoneReportFormat = validateMilestoneReportFormat(facts.milestoneReportText);
  const requiredReportDelivered =
    facts.milestoneReportDelivered === true && milestoneReportFormat.valid;

  if (facts.explicitStopRequest === true) {
    return {
      state: "stop_after_explicit_stop",
      shouldContinue: false,
      allowedToAdvance: false,
      requiredReportDelivered,
      milestoneReportFormat,
      nextAction: "stop because the operator explicitly requested stop",
    };
  }

  if (!requiredReportDelivered) {
    return {
      state: "pending_milestone_report",
      shouldContinue: false,
      allowedToAdvance: false,
      requiredReportDelivered: false,
      milestoneReportFormat,
      nextAction: "deliver the required milestone report in chat before phase transition",
    };
  }

  if (facts.explicitReportOnlyRequest === true) {
    return {
      state: "stop_after_report_only_request",
      shouldContinue: false,
      allowedToAdvance: false,
      requiredReportDelivered,
      milestoneReportFormat,
      nextAction: "stop after report because the operator requested report/status only",
    };
  }

  if (facts.sopBlockerPresent === true) {
    return {
      state: "blocked_by_sop",
      shouldContinue: false,
      allowedToAdvance: false,
      requiredReportDelivered,
      milestoneReportFormat,
      nextAction: "route the SOP blocker before adjacent production work",
    };
  }

  if (facts.watchdogNeedsReview === true) {
    return {
      state: "pause_for_watchdog_needs_review",
      shouldContinue: true,
      allowedToAdvance: false,
      requiredReportDelivered,
      milestoneReportFormat,
      nextAction:
        "route watchdog alert to Cleanup Crew recovery: inspect latest watchdog receipt, analyze read-only, amend active plan, resume recovery, rerun watchdog",
    };
  }

  if (facts.grantFailed === true) {
    return {
      state: "route_grant_fail_repair",
      shouldContinue: true,
      allowedToAdvance: false,
      requiredReportDelivered,
      milestoneReportFormat,
      nextAction: "convert Grant findings into the next lawful repair batch",
    };
  }

  if (facts.proofInterruptedOrAborted === true) {
    return {
      state: "proof_unproven_recovery_required",
      shouldContinue: true,
      allowedToAdvance: false,
      requiredReportDelivered,
      milestoneReportFormat,
      nextAction: "report unproven proof status and rerun the interrupted proof check",
    };
  }

  return {
    state: "continue_after_visibility_report",
    shouldContinue: true,
    allowedToAdvance: true,
    requiredReportDelivered,
    milestoneReportFormat,
    nextAction: "continue to the next lawful Cleanup Crew stage",
  };
}
