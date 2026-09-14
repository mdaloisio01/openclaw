const ACKNOWLEDGEMENT_SCHEMA =
  "openclaw.systemwide_department_flow_durability_drill.acknowledgement.v1";

const REQUIRED_ACKNOWLEDGEMENT_FIELDS = [
  "department_lane_name",
  "received_mission",
  "controlling_prompt_recognized",
  "scope_understood",
  "durability_checks_performed",
  "result",
  "proof_path_or_durable_response_receipt",
  "what_is_materially_real_now",
  "what_is_still_not_real_yet",
  "who_lawfully_owns_the_next_step",
  "open_closed_truth_for_section",
  "exact_next_action",
] as const;

const ALLOWED_ACKNOWLEDGEMENT_RESULTS = new Set(["pass", "fail", "blocked", "not_applicable"]);

export const SYSTEMWIDE_DEPARTMENT_FLOW_ACKNOWLEDGEMENT_SCHEMA = ACKNOWLEDGEMENT_SCHEMA;

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractJsonCandidate(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) {
    return fenced;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return undefined;
}

function parseObjectJson(text: string): Record<string, unknown> | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function isSystemwideDepartmentFlowAcknowledgementText(text: string | undefined): boolean {
  if (!text?.trim()) {
    return false;
  }
  const parsed = parseObjectJson(text);
  if (!parsed || parsed.schema !== ACKNOWLEDGEMENT_SCHEMA) {
    return false;
  }
  for (const field of REQUIRED_ACKNOWLEDGEMENT_FIELDS) {
    if (field === "durability_checks_performed") {
      const checks = parsed[field];
      if (!Array.isArray(checks) || checks.length === 0) {
        return false;
      }
      continue;
    }
    if (!normalizeText(parsed[field])) {
      return false;
    }
  }
  const result = normalizeText(parsed.result)?.toLowerCase();
  return Boolean(result && ALLOWED_ACKNOWLEDGEMENT_RESULTS.has(result));
}

export function isSystemwideDepartmentFlowAcknowledgementRequestText(
  text: string | undefined,
): boolean {
  const normalized = text?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("systemwide department-flow durability validation drill") ||
    (normalized.includes("phase 5") &&
      normalized.includes("acknowledgement") &&
      normalized.includes("schema")) ||
    normalized.includes(ACKNOWLEDGEMENT_SCHEMA)
  );
}

export function buildSystemwideDepartmentFlowBlockedAcknowledgementText(params: {
  blocker: string;
  sessionKey?: string;
  proofPathOrReceipt?: string;
  nextAction?: string;
}): string {
  const sessionKey = normalizeText(params.sessionKey) ?? "unknown ACP session";
  const blocker =
    normalizeText(params.blocker) ?? "ACP acknowledgement blocked before schema proof.";
  return JSON.stringify({
    schema: ACKNOWLEDGEMENT_SCHEMA,
    department_lane_name: "ACP/session path",
    received_mission: "Verify bounded Phase 5 ACP/session acknowledgement.",
    controlling_prompt_recognized:
      "systemwide_department_flow_durability_validation_drill_14_point_build_prompt_2026-09-04T1352PDT.md",
    scope_understood:
      "ACP/session path owns only the bounded Phase 5 acknowledgement; Phase 6 and final drill closeout remain out of scope.",
    durability_checks_performed: [
      "bounded ACP turn attempted",
      "ACP runtime blocker captured",
      "acknowledgement ledger not updated from blocked result",
    ],
    result: "blocked",
    proof_path_or_durable_response_receipt:
      normalizeText(params.proofPathOrReceipt) ??
      `runtime ACP blocker for ${sessionKey}; no pass-schema proof emitted`,
    what_is_materially_real_now: `The bounded Phase 5 ACP acknowledgement did not pass because ${blocker}`,
    what_is_still_not_real_yet:
      "No valid Phase 5 pass schema is proven. No acknowledgement ledger pass, Phase 6, or final drill closeout is lawful.",
    who_lawfully_owns_the_next_step: "Will / OpenClaw controller and ACP/runtime repair lane",
    open_closed_truth_for_section:
      "Phase 5 ACP/session acknowledgement section remains blocked/open.",
    exact_next_action:
      normalizeText(params.nextAction) ??
      "Repair ACP session metadata/rebind, rerun focused validation, then retry only the bounded Phase 5 acknowledgement.",
  });
}
