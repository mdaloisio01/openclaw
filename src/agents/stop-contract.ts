import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import type { AgentInternalEvent } from "./internal-events.js";

export type EmbeddedRunStopContract = {
  stopReason?: string;
  stopAllowed?: boolean;
  nextOwner?: string;
  openTruth?: string;
  executionRunningNow?: boolean;
  executionProofSummary?: string;
};

const OWNER_BOUNDARY_EXPLICIT_STOP_PATTERNS = [
  /\bstopping here because\b/u,
  /\bi am stopping\b/u,
  /\bturn is ending\b/u,
  /\bending this turn\b/u,
  /\bsop forbids\b/u,
  /\bwithout override\b/u,
  /\bremaining substantive work belongs to\b/u,
] as const;

const STILL_OPEN_EXPLICIT_STOP_PATTERNS = [
  /\bturn is ending\b/u,
  /\bending this turn\b/u,
  /\bthis is not complete\b/u,
  /\bnot materially complete\b/u,
  /\bstill open\b/u,
] as const;

export function inferStopContractFromText(
  text: string | undefined,
): EmbeddedRunStopContract | undefined {
  const normalized = normalizeTextForComparison(text ?? "");
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("routed to lawful owner, build still open")) {
    return {
      stopAllowed: true,
      stopReason: "owner_boundary_stop",
      openTruth: "routed to lawful owner, build still open.",
    };
  }
  if (normalized.includes("owner execution in progress, build still open")) {
    return {
      stopAllowed: false,
      stopReason: "owner_execution_in_progress",
      openTruth: "owner execution in progress, build still open.",
    };
  }
  if (normalized.includes("paperwork/setup done, build still open")) {
    return {
      stopAllowed: false,
      stopReason: "paperwork_only_still_open",
      openTruth: "paperwork/setup done, build still open.",
    };
  }
  if (normalized.includes("local slice complete; broader mission still open")) {
    return {
      stopAllowed: false,
      stopReason: "local_slice_complete_broader_mission_open",
      openTruth: "local slice complete; broader mission still open",
    };
  }
  if (normalized.includes("broader mission still open")) {
    return {
      stopAllowed: false,
      stopReason: "broader_mission_still_open",
      openTruth: "broader mission still open",
    };
  }
  if (normalized.includes("build still open")) {
    return {
      stopAllowed: false,
      stopReason: "explicit_open_build_state",
      openTruth: "build still open",
    };
  }
  return undefined;
}

export function extractLatestStopContract(
  internalEvents?: readonly AgentInternalEvent[],
): EmbeddedRunStopContract | undefined {
  if (!internalEvents?.length) {
    return undefined;
  }
  for (let index = internalEvents.length - 1; index >= 0; index -= 1) {
    const event = internalEvents[index];
    if (event?.type !== "task_completion") {
      continue;
    }
    if (
      event.stopReason ||
      typeof event.stopAllowed === "boolean" ||
      event.nextOwner ||
      event.openTruth
    ) {
      return {
        stopReason: normalizeOptionalString(event.stopReason),
        stopAllowed: typeof event.stopAllowed === "boolean" ? event.stopAllowed : undefined,
        nextOwner: normalizeOptionalString(event.nextOwner),
        openTruth: normalizeOptionalString(event.openTruth),
        executionRunningNow:
          typeof event.executionRunningNow === "boolean" ? event.executionRunningNow : undefined,
        executionProofSummary: normalizeOptionalString(event.executionProofSummary),
      };
    }
  }
  return undefined;
}

export function buildExplicitStopExplanation(
  contract: EmbeddedRunStopContract,
): string | undefined {
  const openTruth = normalizeOptionalString(contract.openTruth);
  if (!openTruth) {
    return undefined;
  }
  switch (contract.stopReason) {
    case "owner_boundary_stop": {
      const ownerClause = contract.nextOwner
        ? ` The remaining substantive work belongs to ${contract.nextOwner}.`
        : "";
      return `${openTruth} I am stopping here because this reached a lawful owner boundary.${ownerClause} SOP forbids me from continuing that owner's lane without override.`;
    }
    case "owner_execution_in_progress":
      if (contract.executionRunningNow === true) {
        return `${openTruth} This turn is ending while the build remains open. Active owner execution is already underway, so this is not complete.`;
      }
      return `${openTruth} This turn is ending without live proof that active owner execution is underway, so the build remains open.`;
    case "paperwork_only_still_open":
      return `${openTruth} This turn is ending without material completion because only paperwork/setup is done so far.`;
    case "explicit_open_build_state":
      return `${openTruth} This turn is ending without material completion, so the still-open truth must be explicit.`;
    default:
      return `${openTruth} This turn is ending without material completion, and the stop reason must be stated explicitly.`;
  }
}

export function textSatisfiesStopContract(
  text: string,
  contract: EmbeddedRunStopContract,
): boolean {
  const normalized = normalizeTextForComparison(text);
  if (!normalized) {
    return false;
  }
  const openTruth = normalizeOptionalString(contract.openTruth);
  const normalizedOpenTruth = openTruth ? normalizeTextForComparison(openTruth) : "";
  const hasOpenTruth = normalizedOpenTruth ? normalized.includes(normalizedOpenTruth) : false;
  switch (contract.stopReason) {
    case "owner_boundary_stop": {
      const owner = normalizeOptionalString(contract.nextOwner);
      const hasOwner = owner ? normalized.includes(normalizeTextForComparison(owner)) : true;
      return (
        hasOpenTruth &&
        hasOwner &&
        OWNER_BOUNDARY_EXPLICIT_STOP_PATTERNS.some((pattern) => pattern.test(normalized))
      );
    }
    case "owner_execution_in_progress":
    case "paperwork_only_still_open":
    case "explicit_open_build_state":
      return (
        hasOpenTruth &&
        STILL_OPEN_EXPLICIT_STOP_PATTERNS.some((pattern) => pattern.test(normalized))
      );
    default:
      return hasOpenTruth;
  }
}

export function applyStopContractToAnswerTexts(
  answerTexts: string[],
  contract: EmbeddedRunStopContract | undefined,
): string[] {
  if (!contract) {
    return answerTexts;
  }
  const explicitExplanation = buildExplicitStopExplanation(contract);
  if (!explicitExplanation) {
    return answerTexts;
  }
  if (answerTexts.some((text) => textSatisfiesStopContract(text, contract))) {
    return answerTexts;
  }
  if (answerTexts.length === 0) {
    return [explicitExplanation];
  }
  const first = answerTexts[0] ?? "";
  const normalizedFirst = normalizeTextForComparison(first);
  const normalizedExplanation = normalizeTextForComparison(explicitExplanation);
  if (normalizedFirst.includes(normalizedExplanation)) {
    return answerTexts;
  }
  return [`${explicitExplanation}\n\n${first}`.trim(), ...answerTexts.slice(1)];
}

export function applyStopContractToSingleText(
  text: string | undefined,
  contract: EmbeddedRunStopContract | undefined,
): string | undefined {
  const adjusted = applyStopContractToAnswerTexts(text ? [text] : [], contract);
  return adjusted[0];
}
