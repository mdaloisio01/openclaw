import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export const REPORT_DELIVERY_PENDING_MARKER = "pending_report_delivery";

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

export function enforceReportDeliveryText(
  text: string,
  options?: { explicitArtifactOnlyAllowed?: boolean },
): { text: string; validation: ReportDeliveryValidation } {
  const validation = validateReportDeliveryText(text, options);
  if (validation.ok) {
    return { text, validation };
  }
  return {
    text: buildPendingReportDeliveryNotice(validation),
    validation,
  };
}
