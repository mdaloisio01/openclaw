import {
  CLEANUP_CREW_CANONICAL_OUTCOMES,
  CLEANUP_CREW_EXTERNAL_DEPENDENCY_CLASSES,
  CLEANUP_CREW_GOVERNANCE_REASON_CODES,
  CLEANUP_CREW_IMPACT_LEVELS,
  CLEANUP_CREW_OWNER_DECISION_CLASSES,
  CLEANUP_CREW_POLICY_SCHEMA_VERSION,
} from "../continuity/continuity-gate-v2.js";
import {
  CLEANUP_WATCHDOG_CLEAN_DIMENSIONS,
  CLEANUP_WATCHDOG_POLICY_VERSION,
  getCleanupWatchdogPriority,
  type CleanupWatchdogFindingCategory,
  type CleanupWatchdogPriorityCode,
} from "../governance/cleanup-watchdog-policy.js";

export const REPORT_DELIVERY_GUARD_STATES = [
  "not_required",
  "report_delivery_satisfied",
  "pending_report_delivery",
  "pending_milestone_report",
  "pending_mark_facing_export_delivery",
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
  | "missing_mark_facing_export_path"
  | "missing_mark_facing_export_proof"
  | "milestone_stage_report_missing";

export type ReportDeliveryGuardFacts = {
  reportGenerated?: boolean;
  reportArtifactPath?: string;
  markFacingExportRequired?: boolean;
  markFacingExportRoot?: string;
  markFacingExportPath?: string;
  markFacingExportVerified?: boolean;
  reportBodyDeliveredInChat?: boolean;
  explicitArtifactOnlyAllowed?: boolean;
  privateOnlyFinalResponse?: boolean;
  milestoneStageCompleted?: boolean;
  milestoneReportRequired?: boolean;
  milestoneReportDelivered?: boolean;
};

export type ReportDeliveryGuardDecision = {
  state: ReportDeliveryGuardState;
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  canonicalPriority?: CleanupWatchdogPriorityCode;
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

export const CLEANUP_CREW_CANONICAL_POLICY_PROMPT = [
  `Cleanup Crew watchdog governance policy version: ${CLEANUP_WATCHDOG_POLICY_VERSION}.`,
  `Cleanup Crew canonical policy version: ${CLEANUP_CREW_POLICY_SCHEMA_VERSION}.`,
  `Canonical outcomes: ${CLEANUP_CREW_CANONICAL_OUTCOMES.join(", ")}.`,
  `Canonical impact levels: ${CLEANUP_CREW_IMPACT_LEVELS.join(", ")}.`,
  `Closed owner-decision classes: ${CLEANUP_CREW_OWNER_DECISION_CLASSES.join(", ")}.`,
  `External-dependency classes: ${CLEANUP_CREW_EXTERNAL_DEPENDENCY_CLASSES.join(", ")}.`,
  `Reason codes: ${CLEANUP_CREW_GOVERNANCE_REASON_CODES.join(", ")}.`,
  "Malformed or unknown policy input fails closed as ACTION_BLOCKED with MALFORMED_POLICY_INPUT.",
  "OWNER_DECISION_REQUIRED requires a closed owner-decision class; do not use it for ordinary technical uncertainty.",
  "MISSION_ABORTED requires a mission-bound exhaustion receipt covering every continuation class.",
  `Watchdog active worker recovery priority: ${getCleanupWatchdogPriority("active_no_worker")}.`,
  `Report-delivery debt priority: ${getCleanupWatchdogPriority("pending_report_delivery")}.`,
  `Watchdog CLEAN requires dimensions: ${CLEANUP_WATCHDOG_CLEAN_DIMENSIONS.join(", ")}.`,
  "Changing a mission to blocked, suppressing duplicate delivery, or proving runtime readiness without mission resumption cannot make watchdog CLEAN.",
].join("\n");

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
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  canonicalPriority?: CleanupWatchdogPriorityCode;
  shouldContinue: boolean;
  allowedToAdvance: boolean;
  requiredReportDelivered: boolean;
  milestoneReportFormat: MilestoneReportFormatDecision;
  nextAction: string;
};

export type CleanupCrewReportDeliveryRepairFacts = {
  missionId?: string;
  reportId?: string;
  reportGenerated?: boolean;
  reportArtifactPath?: string;
  markFacingExportRequired?: boolean;
  markFacingExportPath?: string;
  markFacingExportVerified?: boolean;
  reportBodyDeliveredInChat?: boolean;
  deliveryFailed?: boolean;
  registryRowPresent?: boolean;
  repairWorkScheduled?: boolean;
  verifiedLaterSettlementProof?: string;
  parentMissionOpen?: boolean;
  attemptedMissionCloseout?: boolean;
};

export type CleanupCrewReportDeliveryRepairDecision = {
  schema: "openclaw.cleanup_crew_report_delivery_repair_decision.v1";
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  canonicalPriority?: CleanupWatchdogPriorityCode;
  missionId: string;
  reportId: string;
  state:
    | "not_required"
    | "delivery_satisfied_continue"
    | "schedule_delivery_repair_work"
    | "repair_work_pending"
    | "settlement_proof_required"
    | "settled_by_later_verified_delivery"
    | "invalid_report_delivery_state";
  allowedToAdvance: boolean;
  allowedToCloseMission: boolean;
  missionRemainsOpen: boolean;
  registryWorkRequired: boolean;
  repairWorkRequired: boolean;
  acknowledgementAllowed: boolean;
  nextAction: string;
  validationErrors: string[];
};

export type CleanupCrewPostReportContinuationState =
  | "not_cleanup_crew_report"
  | "delivery_not_verified"
  | "terminal_stop_allowed_operator_stop"
  | "terminal_stop_allowed_full_build_complete"
  | "terminal_stop_allowed_verified_hard_stop"
  | "continuation_dispatch_required"
  | "pending_continuation_action";

export type CleanupCrewPostReportContinuationDecision = {
  schema: "openclaw.cleanup_crew_post_report_continuation_decision.v1";
  state: CleanupCrewPostReportContinuationState;
  activeCleanupCrewMission: boolean;
  broaderBuildOpen: boolean;
  finalDeliveryDelivered: boolean;
  stopAllowed: boolean;
  checkpointKind?: "milestone_delivered" | "report_boundary";
  nextExecutableAction?: string;
  pendingContinuationVisible: boolean;
  reason: string;
};

export const REQUIRED_CLEANUP_CREW_CLOSEOUT_TRUTH_FIELDS = [
  "What is materially real now:",
  "What is still not real yet:",
  "Who lawfully owns the next step:",
  "Open/closed truth:",
  "Exact next action:",
] as const;

export type RequiredCleanupCrewCloseoutTruthField =
  (typeof REQUIRED_CLEANUP_CREW_CLOSEOUT_TRUTH_FIELDS)[number];

export type CleanupCrewReportCloseoutAcceptanceState =
  | "not_cleanup_crew_report"
  | "accepted_closeout"
  | "accepted_report_continue"
  | "stop_after_report_only_request"
  | "not_required"
  | "report_delivery_satisfied"
  | "pending_report_delivery"
  | "pending_milestone_report"
  | "pending_mark_facing_export_delivery"
  | "blocked_missing_report_path"
  | "blocked_private_only_report"
  | "blocked_missing_truth_fields"
  | "blocked_paperwork_only_closeout";

export type CleanupCrewReportCloseoutAcceptanceDecision = {
  schema: "openclaw.cleanup_crew_report_closeout_acceptance_decision.v1";
  state: CleanupCrewReportCloseoutAcceptanceState;
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  activeCleanupCrewMission: boolean;
  allowedToAcceptReport: boolean;
  allowedToCloseMission: boolean;
  reportDelivery: ReportDeliveryGuardDecision;
  postReportContinuation: CleanupCrewPostReportContinuationDecision;
  missingTruthFields: RequiredCleanupCrewCloseoutTruthField[];
  nextAction: string;
  reason: string;
};

function reportNamesVerifiedHardStopOrExhaustion(text: string): boolean {
  return (
    reportTextIncludesAny(text, [
      "true hard stop",
      "hard stop",
      "hard_stop",
      "safety stop",
      "safety_stop",
      "destructive risk",
      "forbidden action",
      "operator-only decision",
      "human/operator-only decision",
      "owner decision required",
      "approval unavailable",
      "approval_unavailable",
      "external dependency",
      "external_dependency",
      "no lawful executable path remains",
      "no lawful path remains",
      "all lawful recovery paths exhausted",
      "all lawful repair paths exhausted",
      "lawful alternatives exhausted",
      "exhausted lawful alternatives",
      "alternate execution surfaces are exhausted",
      "alternate execution surfaces exhausted",
    ]) &&
    reportTextIncludesAny(text, [
      "exhausted",
      "operator-only",
      "owner decision required",
      "approval unavailable",
      "external dependency",
      "hard stop",
      "safety stop",
      "forbidden action",
      "destructive risk",
    ]) &&
    reportTextIncludesAny(text, [
      "proof",
      "evidence",
      "blocker_artifact",
      "blocker artifact",
      "hey, i'm stuck",
      "hey, im stuck",
    ])
  );
}

function hasPath(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function deliveryPriority(
  category: CleanupWatchdogFindingCategory | undefined,
): CleanupWatchdogPriorityCode | undefined {
  return category ? getCleanupWatchdogPriority(category) : undefined;
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("pending_report_delivery"),
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "missing_report_path",
    };
  }

  if (reportRequired && facts.markFacingExportRequired === true) {
    if (!hasPath(facts.markFacingExportPath)) {
      return {
        state: "blocked_missing_report_path",
        policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
        canonicalPriority: deliveryPriority("pending_report_delivery"),
        allowed: false,
        reportDeliveryComplete: false,
        milestoneReportComplete: false,
        reason: "missing_mark_facing_export_path",
      };
    }
    if (facts.markFacingExportVerified !== true) {
      return {
        state: "pending_mark_facing_export_delivery",
        policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
        canonicalPriority: deliveryPriority("pending_report_delivery"),
        allowed: false,
        reportDeliveryComplete: false,
        milestoneReportComplete: false,
        reason: "missing_mark_facing_export_proof",
      };
    }
  }

  if (
    reportRequired &&
    facts.privateOnlyFinalResponse === true &&
    facts.reportBodyDeliveredInChat !== true
  ) {
    return {
      state: "blocked_private_only_report",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("pending_report_delivery"),
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("pending_report_delivery"),
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "artifact_only_without_chat_body",
    };
  }

  if (milestoneRequired(facts) && facts.milestoneReportDelivered !== true) {
    return {
      state: "pending_milestone_report",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("pending_milestone_report"),
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      allowed: true,
      reportDeliveryComplete: true,
      milestoneReportComplete: !milestoneRequired(facts) || facts.milestoneReportDelivered === true,
      reason: artifactOnly ? "explicit_artifact_only_allowed" : "report_body_delivered",
    };
  }

  return {
    state: "not_required",
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("pending_milestone_report"),
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("active_no_worker"),
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("review_required_for_safe_work"),
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
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("missing_correctness_proof"),
      shouldContinue: true,
      allowedToAdvance: false,
      requiredReportDelivered,
      milestoneReportFormat,
      nextAction: "report unproven proof status and rerun the interrupted proof check",
    };
  }

  return {
    state: "continue_after_visibility_report",
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    shouldContinue: true,
    allowedToAdvance: true,
    requiredReportDelivered,
    milestoneReportFormat,
    nextAction: "continue to the next lawful Cleanup Crew stage",
  };
}

function normalizeReportText(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function reportTextIncludesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function isCleanupCrewReportText(text: string): boolean {
  return reportTextIncludesAny(text, ["cleanup crew", "cleanup-crew"]);
}

function isOperatorStopText(text: string): boolean {
  return reportTextIncludesAny(text, [
    "report only",
    "report-only",
    "status only",
    "status-only",
    "only report",
    "just report",
    "stop after this",
    "stop now",
    "do not continue",
    "don't continue",
  ]);
}

function reportNamesBroaderBuildOpen(text: string): boolean {
  const namesBroaderOpenFamily =
    /\bbroader\b.{0,96}\b(remains|is|still)\s+open\b/.test(text) ||
    /\b(entire|whole|historical)\b.{0,96}\bnot\b.{0,48}\b(closed|complete|globally closed)\b/.test(
      text,
    );
  if (namesBroaderOpenFamily) {
    return true;
  }
  return reportTextIncludesAny(text, [
    "broader build remains open",
    "broader mission remains open",
    "broader cleanup crew remains open",
    "broader issue family remains open",
    "broader issue remains open",
    "broader reliability family remains open",
    "broader cleanup crew issue-list repair remains open",
    "cleanup crew issue-list repair remains open",
    "cleanup crew mission remains open",
    "parent mission remains open",
    "parent run remains open",
    "build still open",
    "mission still open",
    "repair remains open",
    "remains open and routes",
    "remaining work:",
  ]);
}

function reportNamesFullBuildComplete(text: string): boolean {
  if (reportNamesBroaderBuildOpen(text)) {
    return false;
  }
  return reportTextIncludesAny(text, [
    "broader build is complete",
    "broader mission is complete",
    "cleanup crew issue-list repair is truthfully closed",
    "cleanup crew issue-list repair is complete",
    "whole build is complete",
    "whole mission is complete",
    "mission closed with proof",
    "nothing remains open",
    "what is still not real yet: nothing",
  ]);
}

function reportNamesLawfulStopBlocker(text: string): boolean {
  return (
    (reportTextIncludesAny(text, [
      "lawful blocker",
      "sop blocker",
      "why continuation is not lawful",
      "continuation is not lawful",
      "hard blocker",
      "blocked by sop",
    ]) ||
      (text.includes("status: blocked") && text.includes("blocker:"))) &&
    text.includes("proof:") &&
    reportTextIncludesAny(text, [
      "blocker_artifact:",
      "blocker artifact:",
      "blocker artifact path",
      "verified-blocker artifact",
    ])
  );
}

function isMilestoneReportText(text: string): boolean {
  return (
    text.includes("status:") &&
    text.includes("mode:") &&
    (text.includes("packet complete:") || text.includes("stage complete:")) &&
    (text.includes("next packet:") || text.includes("next stage:")) &&
    text.includes("safety check:") &&
    text.includes("blockers:")
  );
}

function isCleanupCrewCloseoutOrStatusReportText(text: string): boolean {
  return reportTextIncludesAny(text, [
    "closeout",
    "final report",
    "status:",
    "open/closed truth:",
    "what is materially real now:",
    "what is still not real yet:",
    "short slice result:",
    "slice result:",
  ]);
}

function requiresCleanupCrewCloseoutTruthFields(text: string): boolean {
  return reportTextIncludesAny(text, [
    "closeout",
    "final report",
    "open/closed truth:",
    "what is materially real now:",
    "what is still not real yet:",
    "short slice result:",
    "slice result:",
  ]);
}

function reportNamesArtifactSection(text: string): boolean {
  return reportTextIncludesAny(text, ["artifact path(s):", "artifact path:", "proof path(s):"]);
}

function reportClaimsCompletion(text: string): boolean {
  return reportTextIncludesAny(text, [
    "status: done",
    "status: complete",
    "status: closed",
    "truthfully closed",
    "is complete",
    "is closed",
    "closed.",
    "complete.",
  ]);
}

function reportNamesArtifactOnlyPermission(text: string): boolean {
  return reportTextIncludesAny(text, [
    "artifact-only allowed",
    "artifact only allowed",
    "paperwork-only acceptable",
    "report artifact only",
    "no chat body required",
  ]);
}

function reportNamesPaperworkOnlyWork(text: string): boolean {
  return reportTextIncludesAny(text, [
    "paperwork/setup done",
    "paperwork only",
    "paperwork-only",
    "documentation-only",
    "docs-only",
    "package/docs/routing/prep",
    "routing/prep/ready-for-activation",
  ]);
}

function reportNamesMarkFacingExportPath(text: string): boolean {
  return text.includes("/home/will/.openclaw/workspace/file_hub/exports/");
}

function missingCleanupCrewCloseoutTruthFields(
  reportText: string | undefined,
): RequiredCleanupCrewCloseoutTruthField[] {
  const text = reportText ?? "";
  return REQUIRED_CLEANUP_CREW_CLOSEOUT_TRUTH_FIELDS.filter((field) => !text.includes(field));
}

function stripNextActionText(value: string): string | undefined {
  const stripped = value
    .trim()
    .replace(/^[-*]\s*/u, "")
    .replace(/^["']|["']$/gu, "")
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

function extractNextExecutableAction(reportText: string | undefined): string | undefined {
  const lines = (reportText ?? "").split(/\r?\n/u);
  const labels = [
    "exact next action",
    "next executable action",
    "next action",
    "next stage",
    "next packet",
    "next steps",
  ];
  for (const wantedLabel of labels) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const match = line.match(/^\s*([A-Za-z ]+):\s*(.*)$/u);
      if (!match) {
        continue;
      }
      const label = match[1]?.trim().toLowerCase();
      if (label !== wantedLabel) {
        continue;
      }
      const inlineAction = stripNextActionText(match[2] ?? "");
      if (inlineAction) {
        return inlineAction;
      }
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
        const nextAction = stripNextActionText(lines[nextIndex] ?? "");
        if (nextAction) {
          return nextAction;
        }
      }
    }
  }
  return undefined;
}

/**
 * Determines whether a delivered Cleanup Crew milestone/final report may end
 * the source turn, or must be followed by a durable continuation checkpoint.
 */
export function resolveCleanupCrewPostReportContinuation(input: {
  currentTurnText?: string;
  reportText?: string;
  finalDeliveryDelivered?: boolean;
  activeCleanupCrewMission?: boolean;
}): CleanupCrewPostReportContinuationDecision {
  const currentTurnText = normalizeReportText(input.currentTurnText);
  const reportText = normalizeReportText(input.reportText);
  const combinedText = `${currentTurnText}\n${reportText}`;
  const activeCleanupCrewMission =
    input.activeCleanupCrewMission === true || isCleanupCrewReportText(combinedText);
  const finalDeliveryDelivered = input.finalDeliveryDelivered === true;
  const broaderBuildOpen = reportNamesBroaderBuildOpen(reportText);

  if (!activeCleanupCrewMission) {
    return {
      schema: "openclaw.cleanup_crew_post_report_continuation_decision.v1",
      state: "not_cleanup_crew_report",
      activeCleanupCrewMission: false,
      broaderBuildOpen: false,
      finalDeliveryDelivered,
      stopAllowed: true,
      pendingContinuationVisible: false,
      reason: "not_cleanup_crew_report",
    };
  }

  if (!finalDeliveryDelivered) {
    return {
      schema: "openclaw.cleanup_crew_post_report_continuation_decision.v1",
      state: "delivery_not_verified",
      activeCleanupCrewMission,
      broaderBuildOpen,
      finalDeliveryDelivered: false,
      stopAllowed: false,
      pendingContinuationVisible: false,
      reason: "final_delivery_not_verified",
    };
  }

  if (isOperatorStopText(currentTurnText)) {
    return {
      schema: "openclaw.cleanup_crew_post_report_continuation_decision.v1",
      state: "terminal_stop_allowed_operator_stop",
      activeCleanupCrewMission,
      broaderBuildOpen,
      finalDeliveryDelivered,
      stopAllowed: true,
      pendingContinuationVisible: false,
      reason: "operator_requested_report_only_or_stop",
    };
  }

  if (
    reportNamesLawfulStopBlocker(reportText) &&
    reportNamesVerifiedHardStopOrExhaustion(reportText)
  ) {
    return {
      schema: "openclaw.cleanup_crew_post_report_continuation_decision.v1",
      state: "terminal_stop_allowed_verified_hard_stop",
      activeCleanupCrewMission,
      broaderBuildOpen,
      finalDeliveryDelivered,
      stopAllowed: true,
      pendingContinuationVisible: false,
      reason: "verified_hard_stop_or_exhaustion_recorded_with_proof",
    };
  }

  if (reportNamesFullBuildComplete(reportText)) {
    return {
      schema: "openclaw.cleanup_crew_post_report_continuation_decision.v1",
      state: "terminal_stop_allowed_full_build_complete",
      activeCleanupCrewMission,
      broaderBuildOpen: false,
      finalDeliveryDelivered,
      stopAllowed: true,
      pendingContinuationVisible: false,
      reason: "full_build_completion_recorded",
    };
  }

  if (!broaderBuildOpen) {
    return {
      schema: "openclaw.cleanup_crew_post_report_continuation_decision.v1",
      state: "not_cleanup_crew_report",
      activeCleanupCrewMission,
      broaderBuildOpen: false,
      finalDeliveryDelivered,
      stopAllowed: true,
      pendingContinuationVisible: false,
      reason: "no_open_broader_build_claim",
    };
  }

  const nextExecutableAction = extractNextExecutableAction(input.reportText);
  const checkpointKind = isMilestoneReportText(reportText)
    ? "milestone_delivered"
    : "report_boundary";
  if (nextExecutableAction) {
    return {
      schema: "openclaw.cleanup_crew_post_report_continuation_decision.v1",
      state: "continuation_dispatch_required",
      activeCleanupCrewMission,
      broaderBuildOpen,
      finalDeliveryDelivered,
      stopAllowed: false,
      checkpointKind,
      nextExecutableAction,
      pendingContinuationVisible: false,
      reason: "broader_build_open_next_action_named",
    };
  }

  return {
    schema: "openclaw.cleanup_crew_post_report_continuation_decision.v1",
    state: "pending_continuation_action",
    activeCleanupCrewMission,
    broaderBuildOpen,
    finalDeliveryDelivered,
    stopAllowed: false,
    checkpointKind,
    pendingContinuationVisible: true,
    reason: "broader_build_open_next_action_missing",
  };
}

/**
 * Acceptance gate for Cleanup Crew report/final/closeout payloads. It composes
 * the older report-delivery and post-report-continuation helpers so the runtime
 * final-response path uses the same report law as the standalone guard tests.
 */
export function resolveCleanupCrewReportCloseoutAcceptance(input: {
  currentTurnText?: string;
  reportText?: string;
  activeCleanupCrewMission?: boolean;
  reportGenerated?: boolean;
  reportArtifactPath?: string;
  markFacingExportRequired?: boolean;
  markFacingExportPath?: string;
  markFacingExportVerified?: boolean;
  reportBodyDeliveredInChat?: boolean;
  explicitArtifactOnlyAllowed?: boolean;
  privateOnlyFinalResponse?: boolean;
  milestoneStageCompleted?: boolean;
  milestoneReportRequired?: boolean;
  milestoneReportDelivered?: boolean;
}): CleanupCrewReportCloseoutAcceptanceDecision {
  const currentTurnText = normalizeReportText(input.currentTurnText);
  const reportText = normalizeReportText(input.reportText);
  const combinedText = `${currentTurnText}\n${reportText}`;
  const activeCleanupCrewMission =
    input.activeCleanupCrewMission === true || isCleanupCrewReportText(combinedText);
  const reportGenerated =
    input.reportGenerated ??
    (activeCleanupCrewMission && isCleanupCrewCloseoutOrStatusReportText(reportText));
  const closeoutRequiresTruthFields =
    activeCleanupCrewMission && requiresCleanupCrewCloseoutTruthFields(reportText);
  const explicitArtifactOnlyAllowed =
    input.explicitArtifactOnlyAllowed === true ||
    reportNamesArtifactOnlyPermission(currentTurnText);
  const operatorStopRequested = isOperatorStopText(currentTurnText);
  const markFacingExportRequired =
    input.markFacingExportRequired ??
    (closeoutRequiresTruthFields &&
      reportNamesArtifactSection(reportText) &&
      !explicitArtifactOnlyAllowed &&
      !operatorStopRequested);
  const inferredMarkFacingExportVerified =
    input.markFacingExportVerified ?? reportNamesMarkFacingExportPath(input.reportText ?? "");
  const reportDelivery = resolveReportDeliveryGuard({
    reportGenerated,
    reportArtifactPath:
      input.reportArtifactPath ?? (reportGenerated ? "final_response_body" : undefined),
    markFacingExportRequired,
    markFacingExportPath:
      input.markFacingExportPath ??
      (inferredMarkFacingExportVerified ? "mark_facing_export_path_in_report_body" : undefined),
    markFacingExportVerified: inferredMarkFacingExportVerified,
    reportBodyDeliveredInChat: input.reportBodyDeliveredInChat,
    explicitArtifactOnlyAllowed,
    privateOnlyFinalResponse: input.privateOnlyFinalResponse,
    milestoneStageCompleted: input.milestoneStageCompleted,
    milestoneReportRequired: input.milestoneReportRequired,
    milestoneReportDelivered: input.milestoneReportDelivered,
  });
  const postReportContinuation = resolveCleanupCrewPostReportContinuation({
    currentTurnText: input.currentTurnText,
    reportText: input.reportText,
    finalDeliveryDelivered: reportDelivery.reportDeliveryComplete,
    activeCleanupCrewMission,
  });
  const missingTruthFields = closeoutRequiresTruthFields
    ? missingCleanupCrewCloseoutTruthFields(input.reportText)
    : [];
  const completionClaimed = reportClaimsCompletion(reportText);

  if (!activeCleanupCrewMission) {
    return {
      schema: "openclaw.cleanup_crew_report_closeout_acceptance_decision.v1",
      state: "not_cleanup_crew_report",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      activeCleanupCrewMission: false,
      allowedToAcceptReport: true,
      allowedToCloseMission: true,
      reportDelivery,
      postReportContinuation,
      missingTruthFields: [],
      nextAction: "continue normal final-response delivery",
      reason: "not_cleanup_crew_report",
    };
  }

  if (!reportDelivery.allowed) {
    return {
      schema: "openclaw.cleanup_crew_report_closeout_acceptance_decision.v1",
      state: reportDelivery.state,
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      activeCleanupCrewMission,
      allowedToAcceptReport: false,
      allowedToCloseMission: false,
      reportDelivery,
      postReportContinuation,
      missingTruthFields,
      nextAction: "deliver the missing Mark-facing report body/export proof before closeout",
      reason: reportDelivery.reason,
    };
  }

  if (missingTruthFields.length > 0) {
    return {
      schema: "openclaw.cleanup_crew_report_closeout_acceptance_decision.v1",
      state: "blocked_missing_truth_fields",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      activeCleanupCrewMission,
      allowedToAcceptReport: false,
      allowedToCloseMission: false,
      reportDelivery,
      postReportContinuation,
      missingTruthFields,
      nextAction: "rewrite the Cleanup Crew report with every required truth field",
      reason: "cleanup_crew_report_missing_required_truth_fields",
    };
  }

  if (completionClaimed && reportNamesPaperworkOnlyWork(reportText)) {
    return {
      schema: "openclaw.cleanup_crew_report_closeout_acceptance_decision.v1",
      state: "blocked_paperwork_only_closeout",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      activeCleanupCrewMission,
      allowedToAcceptReport: false,
      allowedToCloseMission: false,
      reportDelivery,
      postReportContinuation,
      missingTruthFields,
      nextAction: "state paperwork/setup truth without closing the Cleanup Crew mission",
      reason: "paperwork_only_work_cannot_close_cleanup_crew_mission",
    };
  }

  if (isOperatorStopText(currentTurnText)) {
    return {
      schema: "openclaw.cleanup_crew_report_closeout_acceptance_decision.v1",
      state: "stop_after_report_only_request",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      activeCleanupCrewMission,
      allowedToAcceptReport: true,
      allowedToCloseMission: true,
      reportDelivery,
      postReportContinuation,
      missingTruthFields,
      nextAction: "stop because Mark explicitly requested report-only/status-only/stop",
      reason: "operator_requested_report_only_or_stop",
    };
  }

  if (
    postReportContinuation.state === "continuation_dispatch_required" ||
    postReportContinuation.state === "pending_continuation_action"
  ) {
    return {
      schema: "openclaw.cleanup_crew_report_closeout_acceptance_decision.v1",
      state: "accepted_report_continue",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      activeCleanupCrewMission,
      allowedToAcceptReport: true,
      allowedToCloseMission: false,
      reportDelivery,
      postReportContinuation,
      missingTruthFields,
      nextAction:
        postReportContinuation.nextExecutableAction ??
        "record the next executable Cleanup Crew action before terminal stop",
      reason: postReportContinuation.reason,
    };
  }

  return {
    schema: "openclaw.cleanup_crew_report_closeout_acceptance_decision.v1",
    state: "accepted_closeout",
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    activeCleanupCrewMission,
    allowedToAcceptReport: true,
    allowedToCloseMission: true,
    reportDelivery,
    postReportContinuation,
    missingTruthFields,
    nextAction: "accept Cleanup Crew report/closeout",
    reason: "cleanup_crew_report_closeout_acceptance_passed",
  };
}

/**
 * Keeps report delivery and mission completion separate. A generated report
 * may require visible delivery or later verified settlement, but delivery
 * failure is not a parent-mission closeout and not a reason to drop
 * authorized continuation work.
 */
export function resolveCleanupCrewReportDeliveryRepair(
  facts: CleanupCrewReportDeliveryRepairFacts,
): CleanupCrewReportDeliveryRepairDecision {
  const missionId = facts.missionId?.trim() || "unknown";
  const reportId = facts.reportId?.trim() || "unknown";
  const validationErrors: string[] = [];
  const reportRequired = facts.reportGenerated === true || facts.deliveryFailed === true;

  if (!reportRequired) {
    return {
      schema: "openclaw.cleanup_crew_report_delivery_repair_decision.v1",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionId,
      reportId,
      state: "not_required",
      allowedToAdvance: true,
      allowedToCloseMission: facts.parentMissionOpen !== true,
      missionRemainsOpen: facts.parentMissionOpen === true,
      registryWorkRequired: false,
      repairWorkRequired: false,
      acknowledgementAllowed: true,
      nextAction: "continue; no report delivery obligation is present",
      validationErrors,
    };
  }

  if (missionId === "unknown") {
    validationErrors.push("mission_id_missing");
  }
  if (reportId === "unknown") {
    validationErrors.push("report_id_missing");
  }
  if (facts.reportGenerated === true && !hasPath(facts.reportArtifactPath)) {
    validationErrors.push("report_artifact_path_missing");
  }
  if (facts.reportGenerated === true && facts.markFacingExportRequired === true) {
    if (!hasPath(facts.markFacingExportPath)) {
      validationErrors.push("mark_facing_export_path_missing");
    }
    if (facts.markFacingExportVerified !== true) {
      validationErrors.push("mark_facing_export_proof_missing");
    }
  }
  if (facts.parentMissionOpen !== true) {
    validationErrors.push("parent_mission_open_proof_missing");
  }
  if (facts.attemptedMissionCloseout === true) {
    validationErrors.push("report_delivery_attempted_parent_closeout");
  }

  if (validationErrors.length > 0) {
    return {
      schema: "openclaw.cleanup_crew_report_delivery_repair_decision.v1",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("pending_report_delivery"),
      missionId,
      reportId,
      state: "invalid_report_delivery_state",
      allowedToAdvance: false,
      allowedToCloseMission: false,
      missionRemainsOpen: true,
      registryWorkRequired: true,
      repairWorkRequired: true,
      acknowledgementAllowed: false,
      nextAction: "repair report-delivery state before acknowledging or advancing",
      validationErrors,
    };
  }

  if (facts.reportBodyDeliveredInChat === true) {
    return {
      schema: "openclaw.cleanup_crew_report_delivery_repair_decision.v1",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionId,
      reportId,
      state: "delivery_satisfied_continue",
      allowedToAdvance: true,
      allowedToCloseMission: false,
      missionRemainsOpen: true,
      registryWorkRequired: false,
      repairWorkRequired: false,
      acknowledgementAllowed: true,
      nextAction: "record visible report delivery proof and continue authorized mission work",
      validationErrors,
    };
  }

  if (facts.verifiedLaterSettlementProof && facts.registryRowPresent === true) {
    return {
      schema: "openclaw.cleanup_crew_report_delivery_repair_decision.v1",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionId,
      reportId,
      state: "settled_by_later_verified_delivery",
      allowedToAdvance: true,
      allowedToCloseMission: false,
      missionRemainsOpen: true,
      registryWorkRequired: true,
      repairWorkRequired: false,
      acknowledgementAllowed: true,
      nextAction:
        "settle the delivery registry row with later verified proof and continue authorized mission work",
      validationErrors,
    };
  }

  if (facts.verifiedLaterSettlementProof && facts.registryRowPresent !== true) {
    return {
      schema: "openclaw.cleanup_crew_report_delivery_repair_decision.v1",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("pending_report_delivery"),
      missionId,
      reportId,
      state: "settlement_proof_required",
      allowedToAdvance: false,
      allowedToCloseMission: false,
      missionRemainsOpen: true,
      registryWorkRequired: true,
      repairWorkRequired: true,
      acknowledgementAllowed: false,
      nextAction: "restore or identify the delivery registry row before settlement",
      validationErrors,
    };
  }

  if (facts.repairWorkScheduled === true && facts.registryRowPresent === true) {
    return {
      schema: "openclaw.cleanup_crew_report_delivery_repair_decision.v1",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: deliveryPriority("pending_report_delivery"),
      missionId,
      reportId,
      state: "repair_work_pending",
      allowedToAdvance: false,
      allowedToCloseMission: false,
      missionRemainsOpen: true,
      registryWorkRequired: true,
      repairWorkRequired: true,
      acknowledgementAllowed: false,
      nextAction: "complete idempotent report-delivery repair work before acknowledgement",
      validationErrors,
    };
  }

  return {
    schema: "openclaw.cleanup_crew_report_delivery_repair_decision.v1",
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    canonicalPriority: deliveryPriority("pending_report_delivery"),
    missionId,
    reportId,
    state: "schedule_delivery_repair_work",
    allowedToAdvance: false,
    allowedToCloseMission: false,
    missionRemainsOpen: true,
    registryWorkRequired: true,
    repairWorkRequired: true,
    acknowledgementAllowed: false,
    nextAction: "create idempotent report-delivery repair work before acknowledgement",
    validationErrors,
  };
}
