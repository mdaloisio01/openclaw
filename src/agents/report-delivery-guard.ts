import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  recordPendingMilestoneReport,
  recordPendingReportDelivery,
} from "./report-delivery-state.js";

export const REPORT_DELIVERY_PENDING_MARKER = "pending_report_delivery";
export const MILESTONE_REPORT_PENDING_MARKER = "pending_milestone_report";

const REPORT_ARTIFACT_PATH_PATTERN =
  /(?:^|[\s(["'`<])(?<path>(?:\/home\/will\/\.openclaw\/workspace-orchestrator\/)?file_hub\/exports\/[^\s)"'`>]*?(?:report|closeout|review|readiness|blocker|incident|proof|summary|delivery|interpretation)[^\s)"'`>]*?\.md)\b/giu;

const REPORT_DELIVERY_TRIGGER_PATTERNS = [
  /\breport\s+(?:is\s+)?(?:written|saved|created|attached|exported|recorded)\b/iu,
  /\bcloseout\s+(?:is\s+)?(?:written|saved|created|attached|exported|recorded)\b/iu,
  /\b(?:see|check|open|read)\s+(?:the\s+)?(?:report|closeout|artifact|file)\b/iu,
  /\bartifact\s+(?:is\s+)?(?:written|saved|created|attached|exported|recorded)\b/iu,
  /\breport\s+written\s+here\b/iu,
] as const;

const REQUIRED_REPORT_SECTION_LABELS = [
  "STATUS:",
  "MODE:",
  "OWNER / CREW / LANE:",
  "CREW:",
  "MISSION / CURRENT BATCH:",
  "CURRENT BATCH:",
  "ACTION TAKEN:",
  "FILES CHANGED:",
  "COMMIT:",
  "TESTS / PROOF:",
  "TESTS:",
  "SERVICE / RUNTIME STATE:",
  "DIRTY TREE:",
  "SAFETY CHECK:",
  "WHAT REMAINS:",
  "NEXT ACTION:",
  "BLOCKERS:",
  "ARTIFACT:",
] as const;

const REQUIRED_MILESTONE_SECTION_LABELS = [
  "STATUS:",
  "MODE:",
  "STAGE COMPLETE:",
  "RESULT:",
  "PROOF:",
  "NEXT STAGE:",
  "SAFETY CHECK:",
  "BLOCKERS:",
] as const;

export type ReportDeliveryValidation = {
  ok: boolean;
  reason?:
    | "artifact_only_allowed"
    | "report_body_present"
    | "report_not_required"
    | "missing_chat_report_body";
  pendingReportDelivery?: boolean;
  artifactPaths: string[];
  sectionCount: number;
};

export type ReportGovernedMissionState = {
  report_governed_mission?: boolean;
  current_stage?: string;
  next_stage?: string;
  stage_complete_pending_report?: boolean;
  milestone_report_delivered?: boolean;
  final_closeout_required?: boolean;
  final_closeout_delivered?: boolean;
  interrupted_stage_pending_report?: boolean;
};

export type MilestoneReportValidation = {
  ok: boolean;
  reason?:
    | "milestone_body_present"
    | "milestone_not_required"
    | "milestone_updates_explicitly_suppressed"
    | "missing_milestone_report"
    | "interrupted_stage_not_reported";
  pendingMilestoneReport?: boolean;
  currentStage?: string;
  nextStage?: string;
  sectionCount: number;
};

function normalizeText(text: string): string {
  return normalizeOptionalString(text) ?? "";
}

export function extractReportArtifactPaths(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }
  const paths = new Set<string>();
  for (const match of normalized.matchAll(REPORT_ARTIFACT_PATH_PATTERN)) {
    const path = match.groups?.path?.trim();
    if (path) {
      paths.add(path);
    }
  }
  return [...paths];
}

export function hasReportDeliveryBody(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  const upper = normalized.toUpperCase();
  const sectionCount = REQUIRED_REPORT_SECTION_LABELS.filter((label) =>
    upper.includes(label),
  ).length;
  return upper.includes("STATUS:") && sectionCount >= 4;
}

export function countReportDeliverySections(text: string): number {
  const upper = normalizeText(text).toUpperCase();
  return REQUIRED_REPORT_SECTION_LABELS.filter((label) => upper.includes(label)).length;
}

export function countMilestoneReportSections(text: string): number {
  const upper = normalizeText(text).toUpperCase();
  return REQUIRED_MILESTONE_SECTION_LABELS.filter((label) => upper.includes(label)).length;
}

export function hasMilestoneReportBody(text: string): boolean {
  const upper = normalizeText(text).toUpperCase();
  const sectionCount = countMilestoneReportSections(upper);
  return upper.includes("STAGE COMPLETE:") && upper.includes("NEXT STAGE:") && sectionCount >= 6;
}

export function isReportDeliveryRequiredByText(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  if (extractReportArtifactPaths(normalized).length > 0) {
    return true;
  }
  return REPORT_DELIVERY_TRIGGER_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function validateReportDeliveryText(
  text: string,
  options?: { explicitArtifactOnlyAllowed?: boolean },
): ReportDeliveryValidation {
  const artifactPaths = extractReportArtifactPaths(text);
  const sectionCount = countReportDeliverySections(text);
  if (options?.explicitArtifactOnlyAllowed === true) {
    return {
      ok: true,
      reason: "artifact_only_allowed",
      artifactPaths,
      sectionCount,
    };
  }
  if (!isReportDeliveryRequiredByText(text)) {
    return {
      ok: true,
      reason: "report_not_required",
      artifactPaths,
      sectionCount,
    };
  }
  if (hasReportDeliveryBody(text)) {
    return {
      ok: true,
      reason: "report_body_present",
      artifactPaths,
      sectionCount,
    };
  }
  return {
    ok: false,
    reason: "missing_chat_report_body",
    pendingReportDelivery: true,
    artifactPaths,
    sectionCount,
  };
}

export function validateMilestoneReportText(text: string): MilestoneReportValidation {
  const sectionCount = countMilestoneReportSections(text);
  if (hasMilestoneReportBody(text)) {
    return {
      ok: true,
      reason: "milestone_body_present",
      sectionCount,
    };
  }
  return {
    ok: false,
    reason: "missing_milestone_report",
    pendingMilestoneReport: true,
    sectionCount,
  };
}

export function validateReportGovernedStageAdvance(
  state: ReportGovernedMissionState,
  options?: { explicitNoUpdatesAllowed?: boolean },
): MilestoneReportValidation {
  const sectionCount = 0;
  if (options?.explicitNoUpdatesAllowed === true) {
    return {
      ok: true,
      reason: "milestone_updates_explicitly_suppressed",
      currentStage: state.current_stage,
      nextStage: state.next_stage,
      sectionCount,
    };
  }
  if (state.report_governed_mission !== true) {
    return {
      ok: true,
      reason: "milestone_not_required",
      currentStage: state.current_stage,
      nextStage: state.next_stage,
      sectionCount,
    };
  }
  if (
    state.interrupted_stage_pending_report === true &&
    state.milestone_report_delivered !== true
  ) {
    return {
      ok: false,
      reason: "interrupted_stage_not_reported",
      pendingMilestoneReport: true,
      currentStage: state.current_stage,
      nextStage: state.next_stage,
      sectionCount,
    };
  }
  if (state.stage_complete_pending_report === true && state.milestone_report_delivered !== true) {
    return {
      ok: false,
      reason: "missing_milestone_report",
      pendingMilestoneReport: true,
      currentStage: state.current_stage,
      nextStage: state.next_stage,
      sectionCount,
    };
  }
  return {
    ok: true,
    reason: "milestone_not_required",
    currentStage: state.current_stage,
    nextStage: state.next_stage,
    sectionCount,
  };
}

export function buildPendingReportDeliveryNotice(validation: ReportDeliveryValidation): string {
  const artifactLine =
    validation.artifactPaths.length > 0
      ? `ARTIFACT: ${validation.artifactPaths.join(", ")}`
      : "ARTIFACT: Unknown or not included in the blocked final response.";
  return [
    "STATUS: Blocked",
    "MODE: System-wide report delivery validator",
    "OWNER / CREW / LANE: OpenClaw final response delivery guard",
    "MISSION / CURRENT BATCH: Prevent artifact-only report delivery",
    "ACTION TAKEN: The final response referenced a report/closeout artifact but did not include the report body in chat.",
    "TESTS / PROOF: Runtime final-response validation detected missing required report sections before delivery.",
    "SAFETY CHECK: The artifact path was not treated as report delivery. No generated report was silently called delivered.",
    "WHAT REMAINS: Send the actual report body to Mark in chat, then include the artifact path as proof/archive.",
    `NEXT ACTION: Deliver the full report body in chat; marker=${REPORT_DELIVERY_PENDING_MARKER}.`,
    "BLOCKERS: pending_report_delivery",
    artifactLine,
  ].join("\n");
}

export function buildPendingMilestoneReportNotice(validation: MilestoneReportValidation): string {
  const currentStage = validation.currentStage ?? "unknown";
  const nextStage = validation.nextStage ?? "unknown";
  const result =
    validation.reason === "interrupted_stage_not_reported"
      ? "A tool call or runtime phase was interrupted before the stage was proven, and no user-facing not-proven report was delivered."
      : "A report-governed mission completed a meaningful stage and attempted to advance without delivering the required milestone report in chat.";
  return [
    "STATUS: Blocked",
    "MODE: System-wide milestone report delivery validator",
    `STAGE COMPLETE: ${currentStage}`,
    `RESULT: ${result}`,
    "PROOF: Runtime/report-governed mission state shows stage_complete_pending_report=true or interrupted_stage_pending_report=true while milestone_report_delivered=false.",
    `NEXT STAGE: Do not advance to ${nextStage} until the milestone report is delivered in chat; marker=${MILESTONE_REPORT_PENDING_MARKER}.`,
    "SAFETY CHECK: The phase transition was not treated as silently proven. Artifact paths and internal state are not report delivery.",
    "BLOCKERS: pending_milestone_report",
  ].join("\n");
}

export function enforceReportDeliveryText(
  text: string,
  options?: { explicitArtifactOnlyAllowed?: boolean },
): { text: string; validation: ReportDeliveryValidation } {
  const validation = validateReportDeliveryText(text, options);
  if (validation.ok) {
    return { text, validation };
  }
  recordPendingReportDelivery({
    id:
      validation.artifactPaths[0] ??
      `final-response:${Buffer.from(normalizeText(text)).toString("base64url").slice(0, 32)}`,
    label: "final response report body missing",
    artifact_path: validation.artifactPaths[0],
    artifact_paths: validation.artifactPaths,
    notes:
      "Final response referenced a report artifact or report-written wording without delivering the report body in chat.",
  });
  return {
    text: buildPendingReportDeliveryNotice(validation),
    validation,
  };
}

export function enforceReportGovernedStageAdvance(
  state: ReportGovernedMissionState,
  options?: { explicitNoUpdatesAllowed?: boolean },
): MilestoneReportValidation {
  const validation = validateReportGovernedStageAdvance(state, options);
  if (!validation.ok) {
    recordPendingMilestoneReport({
      id: `stage:${state.current_stage ?? "unknown"}:${state.next_stage ?? "unknown"}`,
      label: `pending milestone report: ${state.current_stage ?? "unknown"}`,
      current_stage: state.current_stage,
      next_stage: state.next_stage,
      interrupted_stage_pending_report: state.interrupted_stage_pending_report,
      final_closeout_required: state.final_closeout_required,
      final_closeout_delivered: state.final_closeout_delivered,
      notes: validation.reason,
    });
  }
  return validation;
}
