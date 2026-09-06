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
