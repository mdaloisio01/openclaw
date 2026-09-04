import { promises as fs } from "node:fs";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../auto-reply/tokens.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  runAnnounceDeliveryWithRetry,
  resolveSubagentAnnounceTimeoutMs,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  applySubagentWaitOutcome,
  buildChildCompletionFindings,
  buildCompactAnnounceStatsLine,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
  readLatestSubagentOutputWithRetry,
  readSubagentOutput,
  type SubagentRunOutcome,
  waitForSubagentRunOutcome,
} from "./subagent-announce-output.js";
import {
  callGateway,
  dispatchGatewayMethodInProcess,
  isEmbeddedAgentRunActive,
  getRuntimeConfig,
  waitForEmbeddedAgentRunEnd,
} from "./subagent-announce.runtime.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

type SubagentAnnounceDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
};

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
  loadSubagentRegistryRuntime,
};

let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

const subagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-announce.registry.runtime.js"),
);

function loadSubagentRegistryRuntime() {
  return subagentRegistryRuntimeLoader.load();
}

export { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export type { SubagentRunOutcome } from "./subagent-announce-output.js";

export type SubagentAnnounceType = "subagent task" | "cron job";

export type GrantCloseoutGateAssessment = {
  applies: boolean;
  passed: boolean;
  outcomeCode?: string;
  missingFields: string[];
  missingProofPaths?: string[];
};

export type GrantCloseoutGateResult = {
  assessment: GrantCloseoutGateAssessment;
  findings: string;
  rawFindings: string;
  taskLabel: string;
  statusLabel: string;
};

const GRANT_CLOSEOUT_REQUIRED_MARKERS: Array<{
  label: string;
  patterns: string[];
}> = [
  { label: "run label", patterns: ["run label"] },
  { label: "target handled", patterns: ["target handled", "requested target"] },
  {
    label: "actual execution owner",
    patterns: ["actual execution owner"],
  },
  { label: "artifact path(s)", patterns: ["artifact path", "artifact path(s)"] },
  {
    label: "proof path(s)",
    patterns: ["proof path", "proof path(s)", "proof supporting this claim"],
  },
  {
    label: "what is materially real now",
    patterns: ["what is materially real now"],
  },
  {
    label: "what is still not real yet",
    patterns: ["what is still not real yet"],
  },
  {
    label: "who lawfully owns the next step",
    patterns: ["who lawfully owns the next step"],
  },
  { label: "open/closed truth", patterns: ["open/closed truth"] },
  { label: "exact next action", patterns: ["exact next action"] },
];

function isGrantHardeningRun(params: { label?: string; task?: string }): boolean {
  const normalizedLabel = normalizeOptionalLowercaseString(params.label);
  if (normalizedLabel?.startsWith("grant")) {
    return true;
  }
  const task = normalizeOptionalLowercaseString(params.task);
  if (!task) {
    return false;
  }
  return (
    task.includes("execution owner: `grant`") ||
    task.includes("execution owner: grant") ||
    task.includes("lawful next owner: grant") ||
    task.includes("grant is the lawful") ||
    task.includes("grant is the sole") ||
    task.includes("grant-only")
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractGrantFieldValues(findings: string, fieldLabel: string): string[] {
  const pattern = new RegExp(`^\\s*${escapeRegex(fieldLabel)}\\s*:\\s*(.+)$`, "gim");
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(findings)) !== null) {
    const value = normalizeOptionalString(match[1]);
    if (value) {
      values.push(value);
    }
  }
  return values;
}

function normalizeGrantFieldHeading(line: string): string {
  return line
    .trim()
    .replace(/^[`*_#>\-\s]+/, "")
    .replace(/[`*_]+$/g, "")
    .trim()
    .toLowerCase();
}

function findGrantFieldLabelForHeading(line: string): string | undefined {
  const normalized = normalizeGrantFieldHeading(line);
  for (const field of GRANT_CLOSEOUT_REQUIRED_MARKERS) {
    if (
      field.patterns.some(
        (pattern) =>
          normalized === pattern ||
          normalized.startsWith(`${pattern}:`) ||
          normalized === `${pattern}(s)`,
      )
    ) {
      return field.label;
    }
  }
  return undefined;
}

function resolveGrantCanonicalFieldLabel(fieldLabel: string): string {
  const normalized = normalizeGrantFieldHeading(fieldLabel);
  for (const field of GRANT_CLOSEOUT_REQUIRED_MARKERS) {
    if (field.patterns.some((pattern) => normalized === pattern || normalized === field.label)) {
      return field.label;
    }
  }
  return normalized;
}

function extractGrantFieldSection(findings: string, fieldLabel: string): string[] {
  const canonicalFieldLabel = resolveGrantCanonicalFieldLabel(fieldLabel);
  const values = extractGrantFieldValues(findings, fieldLabel);
  const lines = findings.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const matchedLabel = findGrantFieldLabelForHeading(line);
    if (matchedLabel !== canonicalFieldLabel) {
      continue;
    }
    const inlineMatch = new RegExp(`^\\s*${escapeRegex(fieldLabel)}\\s*:\\s*(.+)$`, "i").exec(line);
    if (inlineMatch?.[1]?.trim()) {
      values.push(inlineMatch[1].trim());
    }
    const blockLines: string[] = [];
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const nextLine = lines[inner] ?? "";
      if (findGrantFieldLabelForHeading(nextLine)) {
        break;
      }
      const trimmed = nextLine.trim();
      if (!trimmed) {
        continue;
      }
      blockLines.push(trimmed);
    }
    if (blockLines.length > 0) {
      values.push(blockLines.join("\n"));
    }
  }
  return values;
}

function normalizeReferencedFilePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/[),.;]+$/g, "");
  if (/:\d+$/.test(trimmed)) {
    return trimmed.replace(/:\d+$/, "");
  }
  return trimmed;
}

function extractReferencedFilePaths(text: string): string[] {
  const candidates = new Set<string>();
  const markdownPathPattern = /\((\/[^)\n]+)\)/g;
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownPathPattern.exec(text)) !== null) {
    const normalized = normalizeReferencedFilePath(markdownMatch[1] ?? "");
    if (normalized.startsWith("/")) {
      candidates.add(normalized);
    }
  }

  const absolutePathPattern = /(^|[\s`<])((?:\/[A-Za-z0-9._~-]+)+)(?::\d+)?(?=$|[\s`>),.;])/gm;
  let absoluteMatch: RegExpExecArray | null;
  while ((absoluteMatch = absolutePathPattern.exec(text)) !== null) {
    const normalized = normalizeReferencedFilePath(absoluteMatch[2] ?? "");
    if (normalized.startsWith("/")) {
      candidates.add(normalized);
    }
  }

  return Array.from(candidates);
}

async function filterMissingPaths(paths: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const filePath of paths) {
    try {
      await fs.access(filePath);
    } catch {
      missing.push(filePath);
    }
  }
  return missing;
}

async function assessGrantCloseoutGate(params: {
  label?: string;
  task?: string;
  findings: string;
}): Promise<GrantCloseoutGateAssessment> {
  if (!isGrantHardeningRun({ label: params.label, task: params.task })) {
    return {
      applies: false,
      passed: true,
      missingFields: [],
    };
  }
  const findings = normalizeOptionalLowercaseString(params.findings) ?? "";
  const missingFields = GRANT_CLOSEOUT_REQUIRED_MARKERS.filter(
    (field) => !field.patterns.some((pattern) => findings.includes(pattern)),
  ).map((field) => field.label);
  if (missingFields.length > 0) {
    return {
      applies: true,
      passed: false,
      outcomeCode: "rejected_closeout_missing_truth",
      missingFields,
    };
  }

  const proofFieldValues = extractGrantFieldSection(params.findings, "proof path(s)").concat(
    extractGrantFieldSection(params.findings, "proof supporting this claim"),
  );
  const referencedProofPaths = extractReferencedFilePaths(proofFieldValues.join("\n"));
  const missingProofPaths =
    referencedProofPaths.length > 0 ? await filterMissingPaths(referencedProofPaths) : [];
  if (referencedProofPaths.length === 0 || missingProofPaths.length > 0) {
    return {
      applies: true,
      passed: false,
      outcomeCode: "rejected_proof_missing",
      missingFields: [],
      missingProofPaths:
        referencedProofPaths.length === 0 ? ["no readable proof path found"] : missingProofPaths,
    };
  }

  return {
    applies: true,
    passed: true,
    outcomeCode: "accepted_closeout_fields_present",
    missingFields: [],
    missingProofPaths: [],
  };
}

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  grantCloseoutGate?: GrantCloseoutGateAssessment;
  findings?: string;
}): string {
  const stopReasonInstruction = buildStopReasonReplyInstruction(params.findings);
  const grantReviewInstruction = params.grantCloseoutGate?.applies
    ? params.grantCloseoutGate.passed
      ? " This is a Grant-labeled governed execution completion. Apply the Grant closeout gate before treating the original task as done. Confirm the result truthfully states what is materially real now, what is still not real yet, who lawfully owns the next step, proof, open/closed truth, and exact next action."
      : ` This is a Grant-labeled governed execution completion and it already failed the Grant closeout field check with outcome ${params.grantCloseoutGate.outcomeCode}. Keep the item open, reject the closeout truthfully, and require a corrected Grant closeout before any done/complete update.`
    : "";
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words.${grantReviewInstruction}${stopReasonInstruction} Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done.${grantReviewInstruction}${stopReasonInstruction} If additional action is required, launch or route the next executable unit now, or record a lawful current-run blocker tied to the active work; a follow-up note alone is not sufficient. Otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type). Reply ONLY: ${SILENT_REPLY_TOKEN} when no user-facing update is needed.`;
  }
  return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done.${grantReviewInstruction}${stopReasonInstruction} If additional action is required, launch or route the next executable unit now, or record a lawful current-run blocker tied to the active work; a follow-up note alone is not sufficient. Otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

function normalizeFindingsOpenTruth(findings: string | undefined): string | undefined {
  const values = extractGrantFieldSection(findings ?? "", "open/closed truth");
  return normalizeOptionalString(values[0]);
}

function normalizeFindingsNextOwner(findings: string | undefined): string | undefined {
  const values = extractGrantFieldSection(findings ?? "", "who lawfully owns the next step");
  return normalizeOptionalString(values[0]);
}

function resolveStopReasonMetadata(findings: string | undefined): {
  stopReason?: string;
  stopAllowed?: boolean;
  nextOwner?: string;
  openTruth?: string;
  executionRunningNow?: boolean;
  executionProofSummary?: string;
} {
  const openTruth = normalizeFindingsOpenTruth(findings);
  const normalizedOpenTruth = normalizeOptionalLowercaseString(openTruth);
  const nextOwner = normalizeFindingsNextOwner(findings);
  if (!normalizedOpenTruth) {
    return {};
  }
  if (normalizedOpenTruth.includes("routed to lawful owner")) {
    return {
      stopReason: "owner_boundary_stop",
      stopAllowed: true,
      nextOwner,
      openTruth,
      executionRunningNow: false,
      executionProofSummary:
        "This result only proves a lawful owner boundary route, not active next-owner execution.",
    };
  }
  if (normalizedOpenTruth.includes("owner execution in progress")) {
    return {
      stopReason: "owner_execution_in_progress",
      stopAllowed: false,
      nextOwner,
      openTruth,
      executionRunningNow: false,
      executionProofSummary:
        "This result text claims owner execution is in progress, but this announce path does not yet carry live proof for that owner execution state.",
    };
  }
  if (normalizedOpenTruth.includes("paperwork/setup done")) {
    return {
      stopReason: "paperwork_only_still_open",
      stopAllowed: false,
      nextOwner,
      openTruth,
      executionRunningNow: false,
      executionProofSummary:
        "Paperwork/setup-only still-open truth does not prove active owner execution.",
    };
  }
  if (normalizedOpenTruth.includes("build still open")) {
    return {
      stopReason: "explicit_open_build_state",
      stopAllowed: false,
      nextOwner,
      openTruth,
      executionRunningNow: false,
      executionProofSummary: "Still-open build truth does not prove active owner execution.",
    };
  }
  return {};
}

function buildStopReasonReplyInstruction(findings: string | undefined): string {
  const normalizedOpenTruth = normalizeOptionalLowercaseString(
    normalizeFindingsOpenTruth(findings),
  );
  if (!normalizedOpenTruth?.includes("build still open")) {
    return "";
  }
  const nextOwner = normalizeFindingsNextOwner(findings);
  const ownerPhrase = nextOwner ? ` Name the lawful next owner exactly as ${nextOwner}.` : "";
  const genericInstruction =
    " The result says the build is still open. Lead the user-facing update with that open truth. If you end this turn without a blocker or completion, you must say exactly why the turn is stopping. Do not let a closeout, route artifact, or local slice result masquerade as build completion.";
  if (normalizedOpenTruth.includes("routed to lawful owner")) {
    return `${genericInstruction}${ownerPhrase} If you stop at this owner boundary, say plainly that SOP forbids you from continuing that owner's substantive lane without override, and do not imply active execution has started unless the result explicitly says it has.`;
  }
  if (normalizedOpenTruth.includes("owner execution in progress")) {
    return `${genericInstruction} If you end the turn while owner execution is in progress, say that plainly and do not imply the build is done.`;
  }
  if (normalizedOpenTruth.includes("paperwork/setup done")) {
    return `${genericInstruction} If the result is only paperwork or setup, say that plainly and do not imply material completion.`;
  }
  return genericInstruction;
}

function formatGrantCloseoutGateFindings(
  assessment: GrantCloseoutGateAssessment,
  findings: string,
): string {
  if (!assessment.applies) {
    return findings;
  }
  if (assessment.passed) {
    return [
      `[Grant Closeout Gate Result] ${assessment.outcomeCode}`,
      "Mandatory Grant closeout fields are present. Parent review is still required before truthful closure.",
      "",
      findings,
    ].join("\n");
  }
  return [
    `[Grant Closeout Gate Result] ${assessment.outcomeCode}`,
    "This run does not count as truthfully complete yet.",
    ...(assessment.missingFields.length > 0
      ? [`Missing required closeout fields: ${assessment.missingFields.join(", ")}`]
      : []),
    ...(assessment.missingProofPaths && assessment.missingProofPaths.length > 0
      ? [`Missing or unreadable proof path(s): ${assessment.missingProofPaths.join(", ")}`]
      : []),
    "Keep the item open and require a corrected Grant closeout.",
    "",
    findings,
  ].join("\n");
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

function deriveCompletionStatusLabel(params: {
  outcome: SubagentRunOutcome;
  findings: string;
}): string {
  if (params.outcome.status === "timeout") {
    return "timed out";
  }
  if (params.outcome.status === "error") {
    return `failed: ${params.outcome.error || "unknown error"}`;
  }
  if (params.outcome.status !== "ok") {
    return "finished with unknown status";
  }
  const findings = params.findings.trim();
  if (/^Background task blocked:/i.test(findings)) {
    return "blocked; follow-up required";
  }
  if (/^Background task local result ready for review:/i.test(findings)) {
    return "local result ready for review; broader build still open";
  }
  if (/^Background task local slice complete:/i.test(findings)) {
    return "local slice complete; broader mission still open";
  }
  if (/^Background task ready for review:/i.test(findings)) {
    return "review-ready; broader build execution paused pending parent review";
  }
  return "completed; ready for parent review";
}

function hasUsableSessionEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const sessionId = (entry as { sessionId?: unknown }).sessionId;
  return typeof sessionId !== "string" || sessionId.trim() !== "";
}

function buildDescendantWakeMessage(params: { findings: string; taskLabel: string }): string {
  return [
    "[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
    "[Subagent Context] All pending descendants for that run have now settled.",
    "[Subagent Context] Continue your workflow using these results. Spawn more subagents if needed, otherwise send your final answer.",
    "",
    `Task: ${params.taskLabel}`,
    "",
    params.findings,
  ].join("\n");
}

const WAKE_RUN_SUFFIX = ":wake";

function stripWakeRunSuffixes(runId: string): string {
  let next = runId.trim();
  while (next.endsWith(WAKE_RUN_SUFFIX)) {
    next = next.slice(0, -WAKE_RUN_SUFFIX.length);
  }
  return next || runId.trim();
}

function isWakeContinuationRun(runId: string): boolean {
  const trimmed = runId.trim();
  if (!trimmed) {
    return false;
  }
  return stripWakeRunSuffixes(trimmed) !== trimmed;
}

function shouldIgnoreSupersededChildRunAnnounce(params: {
  childRunId: string;
  latestRun:
    | {
        runId?: string;
      }
    | null
    | undefined;
}): boolean {
  const currentRunId = normalizeOptionalString(params.childRunId);
  const latestRunId = normalizeOptionalString(params.latestRun?.runId);
  if (!currentRunId || !latestRunId) {
    return false;
  }
  return currentRunId !== latestRunId;
}

function shouldIgnoreStaleTopLevelCompletionAnnounce(params: {
  requesterDepth: number;
  expectsCompletionMessage?: boolean;
  requesterChannel?: string;
  requesterSessionEntry: unknown;
  requesterSessionIsActive: boolean;
  childTerminalAt?: number;
}): boolean {
  if (params.requesterDepth >= 1 || params.expectsCompletionMessage !== true) {
    return false;
  }
  if (normalizeOptionalLowercaseString(params.requesterChannel) !== "webchat") {
    return false;
  }
  if (params.requesterSessionIsActive) {
    return false;
  }
  if (
    typeof params.childTerminalAt !== "number" ||
    !Number.isFinite(params.childTerminalAt) ||
    params.childTerminalAt <= 0
  ) {
    return false;
  }
  if (!params.requesterSessionEntry || typeof params.requesterSessionEntry !== "object") {
    return false;
  }
  const updatedAt = (params.requesterSessionEntry as { updatedAt?: unknown }).updatedAt;
  return (
    typeof updatedAt === "number" &&
    Number.isFinite(updatedAt) &&
    updatedAt > params.childTerminalAt
  );
}

function stripAndClassifyReply(text: string): string | null {
  let result = text;
  let didStrip = false;
  const hasLeadingSilentToken = startsWithSilentToken(result, SILENT_REPLY_TOKEN);
  if (hasLeadingSilentToken) {
    result = stripLeadingSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (hasLeadingSilentToken || result.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())) {
    result = stripSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (
    didStrip &&
    (!result.trim() || isSilentReplyText(result, SILENT_REPLY_TOKEN) || isAnnounceSkip(result))
  ) {
    return null;
  }
  return result;
}

async function wakeSubagentRunAfterDescendants(params: {
  runId: string;
  childSessionKey: string;
  taskLabel: string;
  findings: string;
  announceId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }

  const childEntry = loadSessionEntryByKey(params.childSessionKey);
  if (!hasUsableSessionEntry(childEntry)) {
    return false;
  }

  const cfg = subagentAnnounceDeps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });

  let wakeRunId;
  try {
    const wakeResponse = await runAnnounceDeliveryWithRetry<{ runId?: string }>({
      operation: "descendant wake agent call",
      signal: params.signal,
      run: async () =>
        await subagentAnnounceDeps.dispatchGatewayMethodInProcess(
          "agent",
          {
            sessionKey: params.childSessionKey,
            message: wakeMessage,
            deliver: false,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: params.childSessionKey,
              sourceChannel: INTERNAL_MESSAGE_CHANNEL,
              sourceTool: "subagent_announce",
            },
            idempotencyKey: buildAnnounceIdempotencyKey(`${params.announceId}:wake`),
          },
          {
            timeoutMs: announceTimeoutMs,
          },
        ),
    });
    wakeRunId = normalizeOptionalString(wakeResponse?.runId) ?? "";
  } catch {
    return false;
  }

  if (!wakeRunId) {
    return false;
  }

  const { replaceSubagentRunAfterSteer } = await loadSubagentRegistryRuntime();
  return replaceSubagentRunAfterSteer({
    previousRunId: params.runId,
    nextRunId: wakeRunId,
    preserveFrozenResultFallback: true,
  });
}

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  /**
   * Fallback text preserved from the pre-wake run when a wake continuation
   * completes with NO_REPLY despite an earlier final summary already existing.
   */
  fallbackReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  announceType?: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  onGrantCloseoutGateResult?: (result: GrantCloseoutGateResult) => void | Promise<void>;
}): Promise<boolean> {
  let didAnnounce = false;
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  const announceType = params.announceType ?? "subagent task";
  let shouldDeleteChildSession = params.cleanup === "delete";
  try {
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionId = (() => {
      const entry = loadSessionEntryByKey(params.childSessionKey);
      return typeof entry?.sessionId === "string" && entry.sessionId.trim()
        ? entry.sessionId.trim()
        : undefined;
    })();
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (childSessionId && isEmbeddedAgentRunActive(childSessionId)) {
      const settled = await waitForEmbeddedAgentRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedAgentRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        // Keep delete cleanup retryable until the active child can be removed.
        if (outcome?.status !== "timeout" || params.cleanup === "delete") {
          return false;
        }
      }
    }

    if (!reply && params.waitForCompletion !== false) {
      const wait = await waitForSubagentRunOutcome(params.childRunId, settleTimeoutMs);
      const applied = applySubagentWaitOutcome({
        wait,
        outcome,
        startedAt: params.startedAt,
        endedAt: params.endedAt,
      });
      outcome = applied.outcome;
      params.startedAt = applied.startedAt;
      params.endedAt = applied.endedAt;
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }
    const failedTerminalOutcome = outcome.status === "error";
    const allowFailedOutputCapture =
      !failedTerminalOutcome || (!params.roundOneReply && !params.fallbackReply);
    if (failedTerminalOutcome) {
      reply = undefined;
    }
    let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
    const requesterIsInternalSession = () =>
      requesterDepth >= 1 || isCronSessionKey(targetRequesterSessionKey);
    const initialRequesterSessionEntry = loadRequesterSessionEntry(targetRequesterSessionKey).entry;
    const initialRequesterSessionId =
      typeof (initialRequesterSessionEntry as { sessionId?: unknown } | undefined)?.sessionId ===
      "string"
        ? ((initialRequesterSessionEntry as { sessionId?: string }).sessionId ?? "").trim()
        : "";
    if (
      shouldIgnoreStaleTopLevelCompletionAnnounce({
        requesterDepth,
        expectsCompletionMessage,
        requesterChannel: targetRequesterOrigin?.channel,
        requesterSessionEntry: initialRequesterSessionEntry,
        requesterSessionIsActive: Boolean(
          initialRequesterSessionId && isEmbeddedAgentRunActive(initialRequesterSessionId),
        ),
        childTerminalAt:
          params.endedAt ?? outcome?.endedAt ?? outcome?.startedAt ?? params.startedAt,
      })
    ) {
      return true;
    }

    let childCompletionFindings: string | undefined;
    let subagentRegistryRuntime:
      | Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>
      | undefined;
    try {
      subagentRegistryRuntime = await subagentAnnounceDeps.loadSubagentRegistryRuntime();
      const latestRunForChildSession =
        typeof subagentRegistryRuntime.getLatestSubagentRunByChildSessionKey === "function"
          ? subagentRegistryRuntime.getLatestSubagentRunByChildSessionKey(params.childSessionKey)
          : undefined;
      if (
        shouldIgnoreSupersededChildRunAnnounce({
          childRunId: params.childRunId,
          latestRun: latestRunForChildSession,
        })
      ) {
        return true;
      }
      if (
        requesterDepth >= 1 &&
        subagentRegistryRuntime.shouldIgnorePostCompletionAnnounceForSession(
          targetRequesterSessionKey,
        )
      ) {
        return true;
      }

      const pendingChildDescendantRuns = Math.max(
        0,
        subagentRegistryRuntime.countPendingDescendantRuns(params.childSessionKey),
      );
      if (pendingChildDescendantRuns > 0 && announceType !== "cron job") {
        shouldDeleteChildSession = false;
        return false;
      }

      if (typeof subagentRegistryRuntime.listSubagentRunsForRequester === "function") {
        const directChildren = subagentRegistryRuntime.listSubagentRunsForRequester(
          params.childSessionKey,
          {
            requesterRunId: params.childRunId,
          },
        );
        if (Array.isArray(directChildren) && directChildren.length > 0) {
          childCompletionFindings = buildChildCompletionFindings(
            dedupeLatestChildCompletionRows(
              filterCurrentDirectChildCompletionRows(directChildren, {
                requesterSessionKey: params.childSessionKey,
                getLatestSubagentRunByChildSessionKey:
                  subagentRegistryRuntime.getLatestSubagentRunByChildSessionKey,
              }),
            ),
          );
        }
      }
    } catch {
      // Best-effort only.
    }

    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
    });

    const childRunAlreadyWoken = isWakeContinuationRun(params.childRunId);
    if (
      params.wakeOnDescendantSettle === true &&
      childCompletionFindings?.trim() &&
      !childRunAlreadyWoken
    ) {
      const wakeAnnounceId = buildAnnounceIdFromChildRun({
        childSessionKey: params.childSessionKey,
        childRunId: stripWakeRunSuffixes(params.childRunId),
      });
      const woke = await wakeSubagentRunAfterDescendants({
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        taskLabel: params.label || params.task || "task",
        findings: childCompletionFindings,
        announceId: wakeAnnounceId,
        signal: params.signal,
      });
      if (woke) {
        shouldDeleteChildSession = false;
        return true;
      }
    }

    if (!childCompletionFindings) {
      const fallbackReply = failedTerminalOutcome
        ? undefined
        : normalizeOptionalString(params.fallbackReply);
      const fallbackIsSilent =
        Boolean(fallbackReply) &&
        (isAnnounceSkip(fallbackReply) || isSilentReplyText(fallbackReply, SILENT_REPLY_TOKEN));

      if (!reply && allowFailedOutputCapture) {
        reply = await readSubagentOutput(params.childSessionKey, outcome);
      }

      if (!reply?.trim() && allowFailedOutputCapture) {
        reply = await readLatestSubagentOutputWithRetry({
          sessionKey: params.childSessionKey,
          maxWaitMs: params.timeoutMs,
          outcome,
        });
      }

      if (!reply?.trim() && fallbackReply && !fallbackIsSilent) {
        reply = fallbackReply;
      }

      // A worker can finish just after the first wait request timed out.
      // If we already have real completion content, do one cached recheck so
      // the final completion event prefers the authoritative terminal state.
      // This is best-effort; if the recheck fails, keep the known timeout
      // outcome instead of dropping the announcement entirely.
      if (outcome?.status === "timeout" && reply?.trim() && params.waitForCompletion !== false) {
        try {
          const rechecked = await waitForSubagentRunOutcome(params.childRunId, 0);
          const applied = applySubagentWaitOutcome({
            wait: rechecked,
            outcome,
            startedAt: params.startedAt,
            endedAt: params.endedAt,
          });
          outcome = applied.outcome;
          params.startedAt = applied.startedAt;
          params.endedAt = applied.endedAt;
        } catch {
          // Best-effort recheck; keep the existing timeout outcome on failure.
        }
      }

      if (isAnnounceSkip(reply) || isSilentReplyText(reply, SILENT_REPLY_TOKEN)) {
        if (fallbackReply && !fallbackIsSilent) {
          const cleaned = stripAndClassifyReply(fallbackReply);
          if (cleaned === null) {
            return true;
          }
          reply = cleaned;
        } else {
          return true;
        }
      } else if (reply) {
        const cleaned = stripAndClassifyReply(reply);
        if (cleaned === null) {
          if (fallbackReply && !fallbackIsSilent) {
            const cleanedFallback = stripAndClassifyReply(fallbackReply);
            if (cleanedFallback === null) {
              return true;
            }
            reply = cleanedFallback;
          } else {
            return true;
          }
        } else {
          reply = cleaned;
        }
      }
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    const rawFindings = childCompletionFindings || reply || "(no output)";
    let findings = rawFindings;
    const grantCloseoutGate = await assessGrantCloseoutGate({
      label: params.label,
      task: params.task,
      findings,
    });
    findings = formatGrantCloseoutGateFindings(grantCloseoutGate, findings);

    // Build status label
    let statusLabel = deriveCompletionStatusLabel({
      outcome,
      findings: rawFindings,
    });
    if (grantCloseoutGate.applies) {
      statusLabel = grantCloseoutGate.passed
        ? `${statusLabel}; Grant closeout gate review required`
        : `closeout rejected; corrected closeout required; Grant closeout gate failed: ${grantCloseoutGate.outcomeCode}`;
    }

    const taskLabel = params.label || params.task || "task";
    const announceSessionId = childSessionId || "unknown";

    if (params.onGrantCloseoutGateResult && grantCloseoutGate.applies) {
      await params.onGrantCloseoutGateResult({
        assessment: grantCloseoutGate,
        findings,
        rawFindings,
        taskLabel,
        statusLabel,
      });
    }

    let requesterIsSubagent = requesterIsInternalSession();
    if (requesterIsSubagent) {
      const {
        isSubagentSessionRunActive,
        resolveRequesterForChildSession,
        shouldIgnorePostCompletionAnnounceForSession,
      } = subagentRegistryRuntime ?? (await loadSubagentRegistryRuntime());
      if (!isSubagentSessionRunActive(targetRequesterSessionKey)) {
        if (shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)) {
          return true;
        }
        const parentSessionEntry = loadSessionEntryByKey(targetRequesterSessionKey);
        const parentSessionAlive = hasUsableSessionEntry(parentSessionEntry);

        if (!parentSessionAlive) {
          const fallback = resolveRequesterForChildSession(targetRequesterSessionKey);
          if (!fallback?.requesterSessionKey) {
            shouldDeleteChildSession = false;
            return false;
          }
          targetRequesterSessionKey = fallback.requesterSessionKey;
          targetRequesterOrigin =
            normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
          requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
          requesterIsSubagent = requesterIsInternalSession();
        }
      }
    }

    const replyInstruction = buildAnnounceReplyInstruction({
      requesterIsSubagent,
      announceType,
      expectsCompletionMessage,
      grantCloseoutGate,
      findings,
    });
    const statsLine = await buildCompactAnnounceStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });
    const internalEvents: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: announceType === "cron job" ? "cron" : "subagent",
        childSessionKey: params.childSessionKey,
        childSessionId: announceSessionId,
        announceType,
        taskLabel,
        status: outcome.status,
        statusLabel,
        result: findings,
        statsLine,
        ...resolveStopReasonMetadata(findings),
        replyInstruction,
      },
    ];
    const triggerMessage = buildAnnounceSteerMessage(internalEvents);

    // Send to the requester session. For nested subagents this is an internal
    // follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = loadRequesterSessionEntry(targetRequesterSessionKey);
      directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
    }
    const completionDirectOrigin =
      expectsCompletionMessage && !requesterIsSubagent
        ? await resolveSubagentCompletionOrigin({
            childSessionKey: params.childSessionKey,
            requesterSessionKey: targetRequesterSessionKey,
            requesterOrigin: directOrigin,
            childRunId: params.childRunId,
            spawnMode: params.spawnMode,
            expectsCompletionMessage,
          })
        : targetRequesterOrigin;
    const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey: targetRequesterSessionKey,
      announceId,
      triggerMessage,
      steerMessage: triggerMessage,
      internalEvents,
      summaryLine: taskLabel,
      requesterSessionOrigin: targetRequesterOrigin,
      requesterOrigin:
        expectsCompletionMessage && !requesterIsSubagent
          ? completionDirectOrigin
          : targetRequesterOrigin,
      completionDirectOrigin,
      directOrigin,
      sourceSessionKey: params.childSessionKey,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceTool: "subagent_announce",
      targetRequesterSessionKey,
      requesterIsSubagent,
      expectsCompletionMessage,
      bestEffortDeliver: params.bestEffortDeliver,
      directIdempotencyKey,
      signal: params.signal,
    });
    params.onDeliveryResult?.(delivery);
    didAnnounce = delivery.delivered;
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.log(
        `[warn] Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
      );
    }
  } catch (err) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await subagentAnnounceDeps.callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
    if (shouldDeleteChildSession) {
      await deleteSubagentSessionForCleanup({
        callGateway: subagentAnnounceDeps.callGateway,
        childSessionKey: params.childSessionKey,
        spawnMode: params.spawnMode,
      });
    }
  }
  return didAnnounce;
}

export const testing = {
  assessGrantCloseoutGate,
  formatGrantCloseoutGateFindings,
  isGrantHardeningRun,
  setDepsForTest(
    overrides?: Partial<SubagentAnnounceDeps> & {
      callGateway?: typeof callGateway;
    },
  ) {
    const callGatewayOverride = overrides?.callGateway;
    const dispatchGatewayMethodInProcessOverride =
      overrides?.dispatchGatewayMethodInProcess ??
      (callGatewayOverride
        ? ((async (method, agentParams, options) =>
            await callGatewayOverride({
              method,
              params: agentParams,
              expectFinal: options?.expectFinal,
              timeoutMs: options?.timeoutMs,
            })) satisfies typeof dispatchGatewayMethodInProcess)
        : undefined);
    subagentAnnounceDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeps,
          ...overrides,
          ...(dispatchGatewayMethodInProcessOverride
            ? { dispatchGatewayMethodInProcess: dispatchGatewayMethodInProcessOverride }
            : {}),
        }
      : defaultSubagentAnnounceDeps;
  },
};
export { testing as __testing };
