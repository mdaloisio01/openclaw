import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type {
  SessionEntry,
  TrbGateDecisionRecordV1,
  TrbRecoveryRecordV1,
  TrbRecoveryState,
} from "../config/sessions/types.js";

export const TRB_RECOVERY_CLASSIFICATIONS = ["current_blocker", "deferred_issue"] as const;
type TrbRecoveryClassification = (typeof TRB_RECOVERY_CLASSIFICATIONS)[number];

export const TRB_STALL_PROOF_CONDITION_CODES = [
  "stalled run",
  "stopped run",
  "missing report",
  "missing closeout",
  "missing milestone",
  "tool boundary failure",
  "context/compaction boundary failure",
  "why did this stop",
  "no final answer after tool work",
] as const;

export const TRB_WATCHDOG_CODES = [
  "TRB_STARTED_NO_FINAL_REPORT",
  "TRB_FINAL_MISSING_REQUIRED_FIELDS",
  "TRB_STALL_WITHOUT_SESSION_LOG_PROOF",
  "TRB_CURRENT_BLOCKER_LOGGED_AS_DEFERRED",
  "TRB_ARTIFACT_MISSING",
  "TRB_ISSUE_ACTION_MISSING",
] as const;

export type TrbWatchdogCode = (typeof TRB_WATCHDOG_CODES)[number];

export type TrbRecoveryContract = {
  what_was_happening_before_misfire?: string;
  proof_checked?: string[];
  actual_issue_identified?: string;
  root_cause?: string;
  missing_proof?: {
    what_was_checked?: string;
    proof_missing?: string;
    where_proof_should_exist?: string;
    missing_proof_is_blocker?: boolean;
    exact_next_recovery_step?: string;
  };
  classification?: string;
  active_mission_impact?: string;
  active_mission_blocked?: boolean;
  issue_list_action?: string;
  lawful_no_update_reason?: string;
  recovery_artifact_path?: string;
  exact_next_action?: string;
  session_tool_log_proof?: {
    checked: boolean;
    evidence?: string;
  };
  oversized_output?: {
    observed: boolean;
    summarized_or_checkpointed?: boolean;
    final_recovery_report_delivered?: boolean;
  };
};

export type TrbRecoveryValidationResult = {
  ok: boolean;
  reasonCodes: TrbWatchdogCode[];
  errors: string[];
};

const UNKNOWN_WORD_RE = /\b(unknown|likely|probably|not proven|unclear|cannot determine)\b/i;

const ACTIVE_BLOCKER_IMPLICATION_RE =
  /\b(active mission cannot continue|required proof is missing|closeout is missing|report delivery is missing|source repair did not land|validation did not run|current build remains blocked|build remains blocked|still blocked|blocked by this issue)\b/i;

export function isTrbCommandText(text: string | undefined | null): boolean {
  const normalized = normalizeOptionalString(text);
  if (!normalized) {
    return false;
  }
  return /(?:^|[^\p{L}\p{N}_])trb(?:$|[^\p{L}\p{N}_])/iu.test(normalized);
}

export function inboundTrbRecoveryRequired(
  ctx: Pick<MsgContext, "BodyForCommands" | "CommandBody" | "RawBody" | "Body">,
): boolean {
  return isTrbCommandText(ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body);
}

export function trbRequiresSessionToolLogProof(text: string | undefined | null): boolean {
  const normalized = normalizeOptionalString(text)?.toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }
  return TRB_STALL_PROOF_CONDITION_CODES.some((code) => normalized.includes(code));
}

export function createTrbRecoveryState(params: {
  ctx: Pick<
    MsgContext,
    | "MessageSid"
    | "MessageSidFull"
    | "MessageSidFirst"
    | "MessageSidLast"
    | "BodyForCommands"
    | "CommandBody"
    | "RawBody"
    | "Body"
  >;
  sessionKey?: string;
  sessionId?: string;
  now?: number;
}): TrbRecoveryState {
  const triggerText =
    params.ctx.BodyForCommands ?? params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body;
  const triggerMessageId = normalizeOptionalString(
    params.ctx.MessageSidFull ??
      params.ctx.MessageSid ??
      params.ctx.MessageSidFirst ??
      params.ctx.MessageSidLast,
  );
  const now = params.now ?? Date.now();
  return {
    schemaVersion: 1,
    trb_recovery_required: true,
    recovery_mode: "trb",
    ...(triggerMessageId ? { trigger_message_id: triggerMessageId } : {}),
    ...(params.sessionKey ? { trigger_session_key: params.sessionKey } : {}),
    ...(params.sessionId ? { trigger_session_id: params.sessionId } : {}),
    trigger_timestamp: now,
    active_mission_session_ref: params.sessionKey ?? params.sessionId,
    requires_session_tool_log_proof: trbRequiresSessionToolLogProof(triggerText),
    final_response_gate: {
      status: "pending",
      checkedAt: now,
    },
  };
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasProofList(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => hasText(entry));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]")
    .replace(/\b(?:sk|pk|rk|xox[baprs])-[A-Za-z0-9_-]{12,}\b/g, "[redacted-token]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function boundedText(value: string | undefined, maxLength = 1_000): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const trimmed = redactSensitiveText(normalized.trim());
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

function sha256Text(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  return createHash("sha256").update(normalized).digest("hex");
}

function missingProofComplete(value: TrbRecoveryContract["missing_proof"]): boolean {
  return (
    hasText(value?.what_was_checked) &&
    hasText(value?.proof_missing) &&
    hasText(value?.where_proof_should_exist) &&
    typeof value?.missing_proof_is_blocker === "boolean" &&
    hasText(value?.exact_next_recovery_step)
  );
}

function textForUnknownScan(contract: TrbRecoveryContract): string {
  return [
    contract.what_was_happening_before_misfire,
    contract.actual_issue_identified,
    contract.root_cause,
    contract.active_mission_impact,
    contract.issue_list_action,
    contract.lawful_no_update_reason,
    contract.exact_next_action,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function validateTrbRecoveryContract(
  contract: TrbRecoveryContract,
  opts: { requireSessionToolLogProof?: boolean } = {},
): TrbRecoveryValidationResult {
  const errors: string[] = [];
  const reasonCodes = new Set<TrbWatchdogCode>();

  if (
    contract.classification !== "current_blocker" &&
    contract.classification !== "deferred_issue"
  ) {
    errors.push("classification must be exactly current_blocker or deferred_issue");
    reasonCodes.add("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  }
  if (!hasText(contract.what_was_happening_before_misfire)) {
    errors.push("what_was_happening_before_misfire is required");
    reasonCodes.add("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  }
  if (!hasText(contract.actual_issue_identified)) {
    errors.push("actual_issue_identified is required");
    reasonCodes.add("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  }
  if (!hasText(contract.root_cause) && !missingProofComplete(contract.missing_proof)) {
    errors.push("root_cause is required unless complete missing_proof fields are present");
    reasonCodes.add("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  }
  if (!hasText(contract.exact_next_action)) {
    errors.push("exact_next_action is required");
    reasonCodes.add("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  }
  if (!hasText(contract.recovery_artifact_path)) {
    errors.push("recovery_artifact_path is required");
    reasonCodes.add("TRB_ARTIFACT_MISSING");
  }
  if (!hasText(contract.issue_list_action) && !hasText(contract.lawful_no_update_reason)) {
    errors.push("issue_list_action or lawful_no_update_reason is required");
    reasonCodes.add("TRB_ISSUE_ACTION_MISSING");
  }
  if (!hasProofList(contract.proof_checked)) {
    errors.push("proof_checked is required");
    reasonCodes.add("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  }
  if (opts.requireSessionToolLogProof && contract.session_tool_log_proof?.checked !== true) {
    errors.push("session/tool-log proof is required for this TRB");
    reasonCodes.add("TRB_STALL_WITHOUT_SESSION_LOG_PROOF");
  }

  const unknownLanguage =
    UNKNOWN_WORD_RE.test(textForUnknownScan(contract)) ||
    Object.values(contract.missing_proof ?? {}).some(
      (value) => typeof value === "string" && UNKNOWN_WORD_RE.test(value),
    );
  if (unknownLanguage && !missingProofComplete(contract.missing_proof)) {
    errors.push("unknown/not-proven language requires complete missing_proof fields");
    reasonCodes.add("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  }

  const activeBlockerImplied =
    contract.active_mission_blocked === true ||
    ACTIVE_BLOCKER_IMPLICATION_RE.test(textForUnknownScan(contract));
  if (contract.classification === "deferred_issue" && activeBlockerImplied) {
    errors.push("deferred_issue is not allowed when the TRB implies an active blocker");
    reasonCodes.add("TRB_CURRENT_BLOCKER_LOGGED_AS_DEFERRED");
  }

  if (
    contract.oversized_output?.observed === true &&
    (contract.oversized_output.summarized_or_checkpointed !== true ||
      contract.oversized_output.final_recovery_report_delivered !== true)
  ) {
    errors.push(
      "oversized output requires summarization/checkpointing and a final recovery report",
    );
    reasonCodes.add("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  }

  return {
    ok: errors.length === 0,
    reasonCodes: [...reasonCodes],
    errors,
  };
}

function contractFromRecoveryRecord(record: TrbRecoveryRecordV1): TrbRecoveryContract {
  return {
    what_was_happening_before_misfire: record.whatWasHappeningBeforeMisfire,
    proof_checked: record.proofChecked,
    actual_issue_identified: record.actualIssueIdentified,
    root_cause: record.rootCause,
    missing_proof: record.missingProof
      ? {
          what_was_checked: record.missingProof.whatWasChecked,
          proof_missing: record.missingProof.proofMissing,
          where_proof_should_exist: record.missingProof.whereProofShouldExist,
          missing_proof_is_blocker: record.missingProof.missingProofIsBlocker,
          exact_next_recovery_step: record.missingProof.exactNextRecoveryStep,
        }
      : undefined,
    classification: record.classification,
    active_mission_impact: record.activeMissionImpact,
    active_mission_blocked: record.activeMissionBlocked,
    issue_list_action: record.issueListAction,
    lawful_no_update_reason: record.lawfulNoUpdateReason,
    recovery_artifact_path: record.recoveryArtifactPath,
    exact_next_action: record.exactNextAction,
    session_tool_log_proof: record.sessionToolLogProof,
    oversized_output: record.oversizedOutput
      ? {
          observed: record.oversizedOutput.observed,
          summarized_or_checkpointed: record.oversizedOutput.summarizedOrCheckpointed,
          final_recovery_report_delivered: record.oversizedOutput.finalRecoveryReportDelivered,
        }
      : undefined,
  };
}

function buildTrbRecoveryRecordId(params: {
  state: TrbRecoveryState;
  contract: TrbRecoveryContract;
}): string {
  const seed = [
    params.state.trigger_session_key,
    params.state.trigger_session_id,
    params.state.trigger_message_id,
    params.state.trigger_timestamp,
    params.contract.classification,
    params.contract.recovery_artifact_path,
  ]
    .filter((value): value is string | number => value !== undefined && value !== null)
    .join("|");
  const digest = createHash("sha256")
    .update(seed || "trb-recovery")
    .digest("hex")
    .slice(0, 32);
  return `trb-recovery:${digest}`;
}

export function createTrbRecoveryRecordFromContract(params: {
  state: TrbRecoveryState;
  contract: TrbRecoveryContract;
  createdAt?: number;
}): TrbRecoveryRecordV1 | undefined {
  const result = validateTrbRecoveryContract(params.contract, {
    requireSessionToolLogProof: params.state.requires_session_tool_log_proof,
  });
  if (!result.ok) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    recordId: buildTrbRecoveryRecordId({
      state: params.state,
      contract: params.contract,
    }),
    createdAt: params.createdAt ?? Date.now(),
    classification: params.contract.classification as TrbRecoveryClassification,
    whatWasHappeningBeforeMisfire: params.contract.what_was_happening_before_misfire!,
    proofChecked: params.contract.proof_checked!,
    actualIssueIdentified: params.contract.actual_issue_identified!,
    ...(params.contract.root_cause ? { rootCause: params.contract.root_cause } : {}),
    ...(params.contract.missing_proof
      ? {
          missingProof: {
            whatWasChecked: params.contract.missing_proof.what_was_checked,
            proofMissing: params.contract.missing_proof.proof_missing,
            whereProofShouldExist: params.contract.missing_proof.where_proof_should_exist,
            missingProofIsBlocker: params.contract.missing_proof.missing_proof_is_blocker,
            exactNextRecoveryStep: params.contract.missing_proof.exact_next_recovery_step,
          },
        }
      : {}),
    activeMissionImpact: params.contract.active_mission_impact!,
    ...(typeof params.contract.active_mission_blocked === "boolean"
      ? { activeMissionBlocked: params.contract.active_mission_blocked }
      : {}),
    ...(params.contract.issue_list_action
      ? { issueListAction: params.contract.issue_list_action }
      : {}),
    ...(params.contract.lawful_no_update_reason
      ? { lawfulNoUpdateReason: params.contract.lawful_no_update_reason }
      : {}),
    recoveryArtifactPath: params.contract.recovery_artifact_path!,
    exactNextAction: params.contract.exact_next_action!,
    ...(params.contract.session_tool_log_proof
      ? { sessionToolLogProof: params.contract.session_tool_log_proof }
      : {}),
    ...(params.contract.oversized_output
      ? {
          oversizedOutput: {
            observed: params.contract.oversized_output.observed,
            summarizedOrCheckpointed: params.contract.oversized_output.summarized_or_checkpointed,
            finalRecoveryReportDelivered:
              params.contract.oversized_output.final_recovery_report_delivered,
          },
        }
      : {}),
  };
}

export function validateTrbRecoveryRecord(
  record: TrbRecoveryRecordV1,
  opts: { requireSessionToolLogProof?: boolean } = {},
): TrbRecoveryValidationResult {
  return validateTrbRecoveryContract(contractFromRecoveryRecord(record), opts);
}

function missingFieldsFromErrors(errors: string[]): string[] {
  const fields = new Set<string>();
  for (const error of errors) {
    if (error.includes("classification")) {
      fields.add("classification");
    }
    if (error.includes("what_was_happening_before_misfire")) {
      fields.add("what_was_happening_before_misfire");
    }
    if (error.includes("actual_issue_identified")) {
      fields.add("actual_issue_identified");
    }
    if (error.includes("root_cause")) {
      fields.add("root_cause");
    }
    if (error.includes("missing_proof")) {
      fields.add("missing_proof");
    }
    if (error.includes("exact_next_action")) {
      fields.add("exact_next_action");
    }
    if (error.includes("recovery_artifact_path")) {
      fields.add("recovery_artifact_path");
    }
    if (error.includes("issue_list_action")) {
      fields.add("issue_list_action");
    }
    if (error.includes("lawful_no_update_reason")) {
      fields.add("lawful_no_update_reason");
    }
    if (error.includes("proof_checked")) {
      fields.add("proof_checked");
    }
    if (error.includes("session/tool-log")) {
      fields.add("session_tool_log_proof");
    }
    if (error.includes("oversized output")) {
      fields.add("oversized_output");
    }
  }
  return [...fields];
}

function buildTrbGateDecisionRecord(params: {
  state: TrbRecoveryState;
  result: TrbRecoveryValidationResult;
  checkedAt: number;
  candidateReplyText?: string;
}): TrbGateDecisionRecordV1 {
  const recoveryRecord = params.state.recovery_record;
  const status = params.result.ok ? "passed" : "blocked";
  const triggerRef =
    params.state.trigger_message_id ??
    params.state.trigger_session_key ??
    params.state.trigger_session_id ??
    "trb";
  const lineageKey = [
    "trb-gate",
    params.state.trigger_session_key
      ? `session-key:${params.state.trigger_session_key}`
      : undefined,
    params.state.trigger_session_id ? `session-id:${params.state.trigger_session_id}` : undefined,
    params.state.trigger_message_id ? `message:${params.state.trigger_message_id}` : undefined,
    `trigger:${params.state.trigger_timestamp}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join("|");
  const previousDecision = params.state.final_response_gate?.decisionRecord;
  const attempt =
    previousDecision?.lineageKey === lineageKey &&
    previousDecision.status === status &&
    typeof previousDecision.attempt === "number"
      ? previousDecision.attempt + 1
      : 1;
  const candidateReplyPreview = boundedText(params.candidateReplyText);
  const candidateReplySha256 = sha256Text(params.candidateReplyText);
  return {
    schemaVersion: 1,
    recordId: `trb-gate:${triggerRef}:${status}`,
    lineageKey,
    status,
    checkedAt: params.checkedAt,
    attempt,
    ...(params.result.reasonCodes.length > 0 ? { reasonCodes: params.result.reasonCodes } : {}),
    ...(params.result.errors.length > 0 ? { errors: params.result.errors } : {}),
    ...(params.result.errors.length > 0
      ? { missingFields: missingFieldsFromErrors(params.result.errors) }
      : {}),
    ...(params.state.trigger_message_id
      ? { triggerMessageId: params.state.trigger_message_id }
      : {}),
    ...(params.state.trigger_session_key
      ? { triggerSessionKey: params.state.trigger_session_key }
      : {}),
    ...(params.state.trigger_session_id
      ? { triggerSessionId: params.state.trigger_session_id }
      : {}),
    ...(params.state.active_mission_session_ref
      ? { activeMissionSessionRef: params.state.active_mission_session_ref }
      : {}),
    ...(recoveryRecord ? { recoveryRecordId: recoveryRecord.recordId } : {}),
    ...(recoveryRecord?.recoveryArtifactPath
      ? { recoveryArtifactPath: recoveryRecord.recoveryArtifactPath }
      : {}),
    issueActionPresent: Boolean(
      recoveryRecord?.issueListAction || recoveryRecord?.lawfulNoUpdateReason,
    ),
    ...(candidateReplyPreview ? { candidateReplyPreview } : {}),
    ...(candidateReplySha256 ? { candidateReplySha256 } : {}),
  };
}

function parseLineValue(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(
      new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?${escaped}[ \\t]*:[ \\t]*(.+)$`, "im"),
    );
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return undefined;
}

function unwrapExactBacktickValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^`([^`]+)`$/);
  return match?.[1]?.trim() || trimmed;
}

function parseBulletListUnderEmptyLabel(text: string, labels: string[]): string[] | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const matchedLabel = labels.some((label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^\\s*(?:[-*]\\s*)?${escaped}\\s*:\\s*$`, "i").test(line);
    });
    if (!matchedLabel) {
      continue;
    }

    const entries: string[] = [];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex] ?? "";
      if (!nextLine.trim()) {
        if (entries.length === 0) {
          continue;
        }
        break;
      }
      const bullet = nextLine.match(/^\s*[-*]\s+(.+)$/);
      if (!bullet) {
        break;
      }
      if (bullet[1]?.trim()) {
        entries.push(bullet[1].trim());
      }
    }

    if (entries.length > 0) {
      return entries;
    }
  }
  return undefined;
}

function parseFirstBulletUnderEmptyLabel(text: string, labels: string[]): string | undefined {
  return parseBulletListUnderEmptyLabel(text, labels)?.[0];
}

function inferClassificationFromStatus(text: string): TrbRecoveryClassification | undefined {
  const status = parseLineValue(text, ["Status", "STATUS"]);
  if (!status) {
    return undefined;
  }
  if (/\bblocked\b/i.test(status)) {
    return "current_blocker";
  }
  if (/\bdeferred\b/i.test(status)) {
    return "deferred_issue";
  }
  return undefined;
}

function parseProofList(text: string): string[] | undefined {
  const value = parseLineValue(text, ["proof_checked", "proof checked", "PROOF"]);
  if (!value) {
    return parseBulletListUnderEmptyLabel(text, ["proof_checked", "proof checked", "PROOF"]);
  }
  return value
    .split(/[,;|]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseRequiredScalarValue(text: string, labels: string[]): string | undefined {
  const value = parseLineValue(text, labels);
  if (!value) {
    return undefined;
  }
  return unwrapExactBacktickValue(value);
}

export function parseTrbRecoveryContractFromText(text: string): TrbRecoveryContract {
  const missingProofText = parseLineValue(text, ["missing_proof", "missing proof"]);
  const whatWasChecked = parseLineValue(text, ["what_was_checked", "what was checked"]);
  const proofMissing = parseLineValue(text, ["proof_missing", "proof missing"]);
  const whereProofShouldExist = parseLineValue(text, [
    "where_proof_should_exist",
    "where proof should exist",
  ]);
  const missingProofIsBlocker =
    /missing_proof_is_blocker\s*:\s*true|missing proof is blocker\s*:\s*true/i.test(text);
  const exactNextRecoveryStep = parseLineValue(text, [
    "exact_next_recovery_step",
    "exact next recovery step",
  ]);
  const hasMissingProofFields = Boolean(
    missingProofText ||
    whatWasChecked ||
    proofMissing ||
    whereProofShouldExist ||
    exactNextRecoveryStep ||
    /missing_proof_is_blocker\s*:|missing proof is blocker\s*:/i.test(text),
  );
  const sessionLogProofText = parseLineValue(text, [
    "session_tool_log_proof",
    "session/tool-log proof",
    "session log proof",
    "tool log proof",
  ]);
  const oversizedText = parseLineValue(text, ["oversized_output", "oversized output"]);
  return {
    what_was_happening_before_misfire: parseLineValue(text, [
      "what_was_happening_before_misfire",
      "what was happening before misfire",
      "what happened",
      "TRB finding",
    ]),
    proof_checked: parseProofList(text),
    actual_issue_identified: parseLineValue(text, [
      "actual_issue_identified",
      "actual issue identified",
      "issue identified",
    ]),
    root_cause: parseLineValue(text, ["root_cause", "root cause"]),
    missing_proof: hasMissingProofFields
      ? {
          what_was_checked: whatWasChecked ?? missingProofText,
          proof_missing: proofMissing ?? missingProofText,
          where_proof_should_exist: whereProofShouldExist ?? missingProofText,
          missing_proof_is_blocker: missingProofIsBlocker,
          exact_next_recovery_step:
            exactNextRecoveryStep ??
            parseLineValue(text, ["exact_next_action", "exact next action"]),
        }
      : undefined,
    classification:
      parseRequiredScalarValue(text, ["classification", "TRB classification"]) ??
      inferClassificationFromStatus(text),
    active_mission_impact: parseLineValue(text, ["active_mission_impact", "active mission impact"]),
    active_mission_blocked:
      /active_mission_blocked\s*:\s*true|active mission blocked\s*:\s*true/i.test(text),
    issue_list_action: parseLineValue(text, [
      "issue_list_action",
      "issue-list action",
      "issue list action",
    ]),
    lawful_no_update_reason: parseLineValue(text, [
      "lawful_no_update_reason",
      "lawful no-update reason",
      "lawful no update reason",
    ]),
    recovery_artifact_path:
      parseLineValue(text, ["recovery_artifact_path", "recovery artifact path", "artifact path"]) ??
      parseFirstBulletUnderEmptyLabel(text, ["Files/Reports", "Files and Reports"]),
    exact_next_action:
      parseLineValue(text, ["exact_next_action", "exact next action", "NEXT STAGE"]) ??
      parseFirstBulletUnderEmptyLabel(text, ["Next Steps", "Next steps"]),
    session_tool_log_proof: sessionLogProofText
      ? {
          checked: /\b(checked|yes|true|inspected|present)\b/i.test(sessionLogProofText),
          evidence: sessionLogProofText,
        }
      : undefined,
    oversized_output: oversizedText
      ? {
          observed: /\b(observed|yes|true)\b/i.test(oversizedText),
          summarized_or_checkpointed: /\b(summarized|summary|checkpoint|checkpointed)\b/i.test(
            oversizedText,
          ),
          final_recovery_report_delivered: /\b(final report|recovery report|delivered)\b/i.test(
            oversizedText,
          ),
        }
      : undefined,
  };
}

export function validateTrbFinalReplyPayloads(params: {
  payloads: ReplyPayload | ReplyPayload[] | undefined;
  state?: TrbRecoveryState;
}): TrbRecoveryValidationResult {
  if (!params.state?.trb_recovery_required) {
    return { ok: true, reasonCodes: [], errors: [] };
  }
  const payloads = Array.isArray(params.payloads)
    ? params.payloads
    : params.payloads
      ? [params.payloads]
      : [];
  const text = payloads
    .map((payload) => payload.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (params.state.recovery_record) {
    return validateTrbRecoveryRecord(params.state.recovery_record, {
      requireSessionToolLogProof: params.state.requires_session_tool_log_proof,
    });
  }
  if (!text.trim()) {
    return {
      ok: false,
      reasonCodes: ["TRB_STARTED_NO_FINAL_REPORT"],
      errors: ["TRB turn ended without a final report payload"],
    };
  }
  return validateTrbRecoveryContract(parseTrbRecoveryContractFromText(text), {
    requireSessionToolLogProof: params.state.requires_session_tool_log_proof,
  });
}

function replyPayloadsToText(payloads: ReplyPayload | ReplyPayload[] | undefined): string {
  return (Array.isArray(payloads) ? payloads : payloads ? [payloads] : [])
    .map((payload) => payload.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function extractStructuredRecoveryRecordFromPayloads(
  payloads: ReplyPayload | ReplyPayload[] | undefined,
): TrbRecoveryRecordV1 | undefined {
  for (const payload of Array.isArray(payloads) ? payloads : payloads ? [payloads] : []) {
    const record = getReplyPayloadMetadata(payload)?.trbRecoveryRecord;
    if (record) {
      return record;
    }
  }
  return undefined;
}

export function captureTrbRecoveryRecordFromFinalReplyPayloads(params: {
  sessionEntry?: SessionEntry;
  payloads: ReplyPayload | ReplyPayload[] | undefined;
  createdAt?: number;
}): boolean {
  const state = params.sessionEntry?.trbRecovery;
  if (!state?.trb_recovery_required || state.recovery_record) {
    return false;
  }
  const structuredRecord = extractStructuredRecoveryRecordFromPayloads(params.payloads);
  if (structuredRecord) {
    const result = validateTrbRecoveryRecord(structuredRecord, {
      requireSessionToolLogProof: state.requires_session_tool_log_proof,
    });
    if (!result.ok) {
      return false;
    }
    state.recovery_record = structuredRecord;
    return true;
  }
  const candidateReplyText = replyPayloadsToText(params.payloads);
  if (!candidateReplyText.trim()) {
    return false;
  }
  const parsedContract = parseTrbRecoveryContractFromText(candidateReplyText);
  const record = createTrbRecoveryRecordFromContract({
    state,
    contract: parsedContract,
    createdAt: params.createdAt,
  });
  if (!record) {
    return false;
  }
  state.recovery_record = record;
  return true;
}

export function evaluateTrbPostTurnWatchdog(params: {
  state?: TrbRecoveryState;
  finalValidation?: TrbRecoveryValidationResult;
}): { status: "clean" | "needs_review"; codes: TrbWatchdogCode[] } {
  if (!params.state?.trb_recovery_required) {
    return { status: "clean", codes: [] };
  }
  const codes = new Set<TrbWatchdogCode>();
  const gate = params.state.final_response_gate;
  if (!gate || gate.status === "pending") {
    codes.add("TRB_STARTED_NO_FINAL_REPORT");
  }
  for (const code of gate?.reasonCodes ?? []) {
    if ((TRB_WATCHDOG_CODES as readonly string[]).includes(code)) {
      codes.add(code as TrbWatchdogCode);
    }
  }
  for (const code of params.finalValidation?.reasonCodes ?? []) {
    codes.add(code);
  }
  if (params.finalValidation && !params.finalValidation.ok && codes.size === 0) {
    codes.add("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  }
  return {
    status: codes.size === 0 ? "clean" : "needs_review",
    codes: [...codes],
  };
}

export function buildTrbRecoveryBlockedPayload(result: TrbRecoveryValidationResult): ReplyPayload {
  return {
    isError: true,
    text: [
      "TRB final response blocked by runtime gate.",
      `Reason codes: ${result.reasonCodes.join(", ") || "TRB_FINAL_MISSING_REQUIRED_FIELDS"}`,
      `Missing/invalid: ${result.errors.join("; ")}`,
      "Normal continuation is withheld until the TRB recovery contract is complete.",
    ].join("\n"),
  };
}

export function buildTrbRecoverySystemPrompt(state?: TrbRecoveryState): string | undefined {
  if (!state?.trb_recovery_required) {
    return undefined;
  }
  if (state.final_response_gate?.status === "passed") {
    return undefined;
  }
  const decision = state.final_response_gate?.decisionRecord;
  return [
    "## Runtime TRB Recovery Gate",
    "This turn has mechanically entered TRB recovery mode.",
    "You must complete the TRB recovery contract before any normal continuation or closeout.",
    "Final response must include these exact fields as `field: value` lines:",
    "classification: current_blocker or deferred_issue",
    "what_was_happening_before_misfire:",
    "proof_checked:",
    "actual_issue_identified:",
    "root_cause: or missing_proof:",
    "missing_proof: required when root_cause is unknown, likely, probably, not proven, unclear, or cannot be determined.",
    "active_mission_impact:",
    "issue_list_action: or lawful_no_update_reason:",
    "recovery_artifact_path:",
    "exact_next_action:",
    state.requires_session_tool_log_proof
      ? "session_tool_log_proof: checked, with evidence. This TRB cannot close without session/tool-log proof."
      : undefined,
    decision?.status === "blocked" ? "Previous TRB gate decision:" : undefined,
    decision?.status === "blocked"
      ? `status: ${decision.status}; reason_codes: ${(decision.reasonCodes ?? []).join(", ") || "none"}`
      : undefined,
    decision?.status === "blocked" && decision.errors?.length
      ? `missing_or_invalid: ${decision.errors.join("; ")}`
      : undefined,
    decision?.status === "blocked" && decision.recoveryArtifactPath
      ? `recovery_artifact_path: ${decision.recoveryArtifactPath}`
      : undefined,
    "Put the required contract block before any prose. Each scalar field must be one same-line `field: value` entry with no extra explanation on that line.",
    "Use `proof_checked: item one; item two` on one line, or `proof_checked:` followed immediately by short `- item` bullet lines.",
    "The `classification:` value must be exactly `current_blocker` or `deferred_issue`.",
    "If any root cause is unknown, likely, probably, not proven, unclear, or cannot be determined, include what_was_checked, proof_missing, where_proof_should_exist, missing_proof_is_blocker, and exact_next_recovery_step.",
    "If the active mission cannot continue, required proof is missing, closeout/report delivery is missing, source repair did not land, or validation did not run, classification must be current_blocker.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function shouldDrainStaleTrbRecoveryState(params: {
  state?: TrbRecoveryState;
  trbInboundRequired: boolean;
}): boolean {
  return Boolean(params.state?.trb_recovery_required && !params.trbInboundRequired);
}

export function markTrbGateResultOnSessionEntry(params: {
  sessionEntry?: SessionEntry;
  result: TrbRecoveryValidationResult;
  checkedAt?: number;
  candidateReplyText?: string;
}): void {
  if (!params.sessionEntry?.trbRecovery) {
    return;
  }
  const checkedAt = params.checkedAt ?? Date.now();
  const decisionRecord = buildTrbGateDecisionRecord({
    state: params.sessionEntry.trbRecovery,
    result: params.result,
    checkedAt,
    candidateReplyText: params.candidateReplyText,
  });
  params.sessionEntry.trbRecovery = {
    ...params.sessionEntry.trbRecovery,
    final_response_gate: {
      status: params.result.ok ? "passed" : "blocked",
      checkedAt,
      ...(params.result.reasonCodes.length > 0 ? { reasonCodes: params.result.reasonCodes } : {}),
      ...(params.result.errors.length > 0 ? { errors: params.result.errors } : {}),
      ...(decisionRecord.missingFields && decisionRecord.missingFields.length > 0
        ? { missingFields: decisionRecord.missingFields }
        : {}),
      decisionRecordId: decisionRecord.recordId,
      decisionRecord,
    },
  };
}
