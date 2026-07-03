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
