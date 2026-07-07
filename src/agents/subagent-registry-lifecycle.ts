import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { persistCleanupCrewContinuityGateDecision } from "../commands/cleanup-plan.js";
import {
  createGrantRetryKey,
  resolveGrantRetry,
  type GrantRejectionType,
} from "../continuity/continuity-gate-v2.js";
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import { formatErrorMessage, readErrorName } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/detached-task-runtime.js";
import { markTaskRunningByRunId } from "../tasks/runtime-internal.js";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  resolveRequiredCompletionTerminalResult,
} from "../tasks/task-completion-contract.js";
import {
  getTaskFlowProductionContinuation,
  getTaskFlowById,
  recordFlowLawfulStop,
  recordFlowNextExecutableLaunch,
  recordBlindTestCloseoutFailure,
  updateFlowRecordByIdExpectedRevision,
} from "../tasks/task-flow-runtime-internal.js";
import { createTaskRecord, findTaskByRunId } from "../tasks/task-registry.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { retireSessionMcpRuntimeForSessionKey } from "./agent-bundle-mcp-tools.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import {
  attachGrantRulebookMetadata,
  loadGrantHardeningRulebook,
} from "./grant-hardening-rulebook.js";
import { removeInternalSessionEffectsTranscript } from "./internal-session-effects.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { type SubagentRunOutcome, withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import type { GrantCloseoutGateResult } from "./subagent-announce.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
  isDeliverySuspended,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveCleanupCompletionReason,
  resolveDeferredCleanupDecision,
} from "./subagent-registry-cleanup.js";
import { shouldUpdateRunOutcome } from "./subagent-registry-completion.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  capFrozenResultText,
  logAnnounceGiveUp,
  MAX_ANNOUNCE_RETRY_COUNT,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import { replaceSubagentRunAfterSteer as replaceSubagentRunAfterSteerDefault } from "./subagent-registry-steer-runtime.js";
import type { PendingFinalDeliveryPayload, SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentRunDeadlineMs } from "./subagent-run-timeout.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";

type CaptureSubagentCompletionReply =
  (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
type BrowserCleanupModule = Pick<
  typeof import("../browser-lifecycle-cleanup.js"),
  "cleanupBrowserSessionsForLifecycleEnd"
>;

const DELIVERY_MIRROR_HISTORY_MAX_CHARS = 128 * 1024;
const GRANT_AUDIT_RELATIVE_DIR = path.join("var", "grant", "after_action_audits");
const CONTINUITY_GATE_GRANT_CLOSEOUT_RELATIVE_DIR = path.join(
  "var",
  "continuity_gate_v2",
  "grant_closeout_gate",
);
const GRANT_CORRECTION_QUEUE_RELATIVE_PATH = path.join(
  "var",
  "grant",
  "grant_correction_candidates.jsonl",
);
const REL002_CHILD_RESULT_REJECTED = "CHILD_RESULT_REJECTED";
const REL002_SAME_SLICE_REWORK_REQUIRED = "SAME_SLICE_REWORK_REQUIRED";
const REL002_REWORK_PACKET_CREATED = "REWORK_PACKET_CREATED";
const REL002_REWORK_PACKET_QUEUED = "REWORK_PACKET_QUEUED";
const REL002_REWORK_EXECUTOR_LAUNCH_REQUIRED = "REWORK_EXECUTOR_LAUNCH_REQUIRED";
const REL002_REWORK_EXECUTOR_LAUNCHED = "REWORK_EXECUTOR_LAUNCHED";
const REL002_REWORK_EXECUTOR_RUNNING = "REWORK_EXECUTOR_RUNNING";
const REL002_REWORK_FOLLOW_THROUGH_VIOLATION = "REWORK_FOLLOW_THROUGH_VIOLATION";
const REL002_LAWFUL_BLOCKED_CLOSEOUT = "LAWFUL_BLOCKED_CLOSEOUT";

function buildGrantCorrectionSummary(result: GrantCloseoutGateResult): string {
  const outcome = result.assessment.outcomeCode ?? "grant_closeout_gate_failed";
  const missingFields = result.assessment.missingFields ?? [];
  const missingProofPaths = result.assessment.missingProofPaths ?? [];
  const fixes: string[] = [];
  if (missingFields.length > 0) {
    fixes.push(`add the missing Grant closeout fields: ${missingFields.join(", ")}`);
  }
  if (missingProofPaths.length > 0) {
    fixes.push(
      `replace unreadable proof with concrete readable proof paths: ${missingProofPaths.join(", ")}`,
    );
  }
  if (fixes.length === 0) {
    fixes.push(`correct the closeout so it truthfully passes ${outcome}`);
  }
  return `Grant closeout failed (${outcome}). What was wrong: ${fixes.join(
    "; ",
  )}. Fix it and retry the same slice now. Do not advance to adjacent work.`;
}

function classifyGrantCloseoutGateRejection(outcomeCode: string | undefined): GrantRejectionType {
  switch (outcomeCode) {
    case "rejected_closeout_missing_truth":
      return "MECHANICAL_CLOSEOUT_FORMAT";
    case "rejected_proof_missing":
      return "MECHANICAL_PROOF_LINK";
    case "rejected_scope_expansion":
      return "SCOPE_EXPANSION";
    case "rejected_semantic_safety":
    case "rejected_false_success_state":
      return "SEMANTIC_SAFETY";
    default:
      return "UNKNOWN_REVIEW_BLOCKER";
  }
}

function resolveSafeGrantWorkspaceDir(workspaceDir: string | undefined): string | undefined {
  const trimmed = workspaceDir?.trim();
  if (!trimmed || trimmed === "undefined" || !path.isAbsolute(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function buildGrantCloseoutRetrySurfaceId(params: {
  entry: SubagentRunRecord;
  result: GrantCloseoutGateResult;
  rejectionType: GrantRejectionType;
}): string {
  const fileSurfaceHash = createHash("sha256")
    .update(
      JSON.stringify({
        task: params.entry.task ?? params.result.taskLabel ?? "",
        missingFields: params.result.assessment.missingFields ?? [],
        missingProofPaths: params.result.assessment.missingProofPaths ?? [],
        outcomeCode: params.result.assessment.outcomeCode ?? "unknown",
      }),
    )
    .digest("hex");
  return createGrantRetryKey({
    rejectionType: params.rejectionType,
    fileSurfaceHash,
    artifactId: `grant_closeout_gate:${params.entry.runId}:${
      params.result.assessment.outcomeCode ?? "unknown"
    }`,
  });
}

async function countGrantContinuityDecisionsForRetrySurface(params: {
  outputDir: string;
  retrySurfaceId: string;
}): Promise<number> {
  const decisionDir = path.join(params.outputDir, "cleanup_crew_decision_records");
  try {
    const entries = await fs.readdir(decisionDir);
    let count = 0;
    for (const name of entries) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(decisionDir, name), "utf8")) as {
          authority_resolution?: { winnerId?: unknown };
        };
        if (parsed.authority_resolution?.winnerId === params.retrySurfaceId) {
          count += 1;
        }
      } catch {
        continue;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function persistGrantCloseoutContinuityGateDecision(params: {
  workspaceDir: string;
  entry: SubagentRunRecord;
  result: GrantCloseoutGateResult;
  correctionSummary: string;
  auditPath?: string;
}): Promise<void> {
  const workspaceDir = resolveSafeGrantWorkspaceDir(params.workspaceDir);
  if (!workspaceDir) {
    return;
  }
  const rejectionType = classifyGrantCloseoutGateRejection(params.result.assessment.outcomeCode);
  const retrySurfaceId = buildGrantCloseoutRetrySurfaceId({
    entry: params.entry,
    result: params.result,
    rejectionType,
  });
  const outputDir = path.join(workspaceDir, CONTINUITY_GATE_GRANT_CLOSEOUT_RELATIVE_DIR);
  const priorAttempts = await countGrantContinuityDecisionsForRetrySurface({
    outputDir,
    retrySurfaceId,
  });
  const retry = resolveGrantRetry({
    retrySurfaceId,
    rejectionType,
    priorAttempts,
  });
  const canContinue = retry.result === "continue_repair";
  await persistCleanupCrewContinuityGateDecision({
    outputDir,
    activeMission:
      params.entry.task ??
      params.result.taskLabel ??
      `Grant closeout gate repair for ${params.entry.runId}`,
    now: new Date().toISOString(),
    authoritySources: [
      {
        kind: "active_mission_lock",
        id: retrySurfaceId,
        summary: `Grant closeout gate result ${params.result.assessment.outcomeCode ?? "unknown"} for ${params.entry.label ?? params.result.taskLabel ?? params.entry.runId}`,
        active: true,
      },
    ],
    issue: {
      summary: params.correctionSummary,
      blocker: canContinue ? "grant rejected" : "Grant semantic/safety closeout issue",
      pathRisk: canContinue ? "MEDIUM_RISK_RUNTIME" : "CRITICAL_CONTROL",
      diffIntent: canContinue ? "mechanical_format" : "unknown_intent",
      behaviorImpact: canContinue ? "technical" : "true_unknown",
      safeTechnicalPathDescription: canContinue ? params.correctionSummary : undefined,
      ownerLevelBlockerAudit: "grant_closeout_gate",
    },
    scope: {
      files: ["src/agents/subagent-registry-lifecycle.ts"],
      records: [
        params.result.assessment.outcomeCode ?? "unknown_grant_closeout_outcome",
        ...(params.auditPath ? [params.auditPath] : []),
      ],
      commands: [],
    },
    repairAction: canContinue
      ? params.correctionSummary
      : "stop Grant closeout continuation until semantic/safety issue is diagnosed",
    proofPath: params.auditPath ?? params.entry.runId,
    diagnostic: {
      surfaces: ["subagent-registry-lifecycle:grant-closeout-gate"],
      grantResult: `${retry.result}:${rejectionType}:attempt_${retry.attempt}_of_${retry.maxAttempts}`,
      proofRefs: [
        params.entry.runId,
        ...(params.result.assessment.missingProofPaths ?? []),
        ...(params.auditPath ? [params.auditPath] : []),
      ],
      redactionStatus: "no_sensitive_payloads",
    },
  });
}

function buildRel002QueueSummary(correctionSummary: string): string {
  return [
    REL002_CHILD_RESULT_REJECTED,
    REL002_SAME_SLICE_REWORK_REQUIRED,
    REL002_REWORK_PACKET_CREATED,
    REL002_REWORK_PACKET_QUEUED,
    REL002_REWORK_EXECUTOR_LAUNCH_REQUIRED,
    correctionSummary,
  ].join(" :: ");
}

function buildRel002RunningSummary(correctionSummary: string, runId: string): string {
  return [
    REL002_REWORK_EXECUTOR_LAUNCHED,
    REL002_REWORK_EXECUTOR_RUNNING,
    `run ${runId}`,
    correctionSummary,
  ].join(" :: ");
}

function buildRel002BlockedReason(reason: string): string {
  return [REL002_REWORK_FOLLOW_THROUGH_VIOLATION, REL002_LAWFUL_BLOCKED_CLOSEOUT, reason].join(
    " :: ",
  );
}

function continuationRequiresImmediateReworkLaunch(
  continuation: ReturnType<typeof getTaskFlowProductionContinuation> | null | undefined,
): continuation is NonNullable<ReturnType<typeof getTaskFlowProductionContinuation>> {
  return (
    continuation?.activeProductionRun === true &&
    continuation.parentRunOpen === true &&
    continuation.blockerPresent !== true &&
    continuation.ownerDecisionRequired !== true &&
    continuation.restartOrReloadRequired !== true &&
    continuation.hardStopPresent !== true &&
    continuation.safetyStopPresent !== true &&
    continuation.lawfulWholeRunCompletion !== true
  );
}
const GRANT_CORRECTION_ARCHIVE_RELATIVE_PATH = path.join(
  "var",
  "grant",
  "grant_correction_candidates.archive.jsonl",
);
const GRANT_CORRECTION_RETIREMENT_QUEUE_RELATIVE_PATH = path.join(
  "var",
  "grant",
  "grant_correction_retirements.jsonl",
);
const GRANT_CORRECTION_RETIREMENT_REQUESTS_RELATIVE_DIR = path.join(
  "var",
  "grant",
  "retirement_requests",
);
const GRANT_CORRECTION_RETIREMENT_ARCHIVE_RELATIVE_PATH = path.join(
  "var",
  "grant",
  "grant_correction_retirements.archive.jsonl",
);
const GRANT_CORRECTION_RETIREMENT_REJECTED_ARCHIVE_RELATIVE_PATH = path.join(
  "var",
  "grant",
  "grant_correction_retirements.rejected.jsonl",
);
const GRANT_CORRECTIONS_MATRIX_RELATIVE_PATH = path.join(
  "docs",
  "grant",
  "grant_corrections_matrix.md",
);
const GRANT_CORRECTION_RETIREMENT_REQUEST_TEMPLATE_RELATIVE_PATH = path.join(
  "templates",
  "grant",
  "grant_correction_retirement_request_template.json",
);
const ALLOWED_GRANT_RETIREMENT_REASONS = new Set([
  "obsolete_rule",
  "superseded_by_higher_quality_rule",
  "false_positive_pattern",
  "capability_materially_fixed",
]);

const browserCleanupLoader = createLazyImportLoader<BrowserCleanupModule>(
  () => import("../browser-lifecycle-cleanup.js"),
);

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
  BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"]
> {
  return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}

function shouldPreservePublishedExplicitRunTimeout(params: { entry: SubagentRunRecord }): boolean {
  if (
    typeof params.entry.runTimeoutSeconds !== "number" ||
    !Number.isFinite(params.entry.runTimeoutSeconds) ||
    params.entry.runTimeoutSeconds <= 0 ||
    params.entry.outcome?.status !== "timeout" ||
    typeof params.entry.endedAt !== "number"
  ) {
    return false;
  }
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry);
  if (deadlineMs === undefined || params.entry.endedAt < deadlineMs) {
    return false;
  }
  if (
    params.entry.cleanupHandled ||
    typeof params.entry.cleanupCompletedAt === "number" ||
    typeof params.entry.endedHookEmittedAt === "number" ||
    params.entry.delivery?.status === "delivered" ||
    typeof params.entry.delivery?.announcedAt === "number"
  ) {
    return true;
  }
  return false;
}

function resolveExpiredExplicitRunDeadlineMs(params: {
  entry: SubagentRunRecord;
  nextOutcome: SubagentRunOutcome;
  nextEndedAt: number;
  observedStartedAt?: number;
}): number | undefined {
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry, params.observedStartedAt);
  return deadlineMs !== undefined && params.nextEndedAt > deadlineMs ? deadlineMs : undefined;
}

export function createSubagentRegistryLifecycleController(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  persist(): void;
  clearPendingLifecycleError(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string): number;
  suppressAnnounceForSteerRestart(entry?: SubagentRunRecord): boolean;
  shouldEmitEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }): boolean;
  emitSubagentEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
  }): Promise<void>;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted";
    agentDir?: string;
    workspaceDir?: string;
  }): Promise<void>;
  resumeSubagentRun(runId: string): void;
  replaceSubagentRunAfterSteer?(params: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    preserveFrozenResultFallback?: boolean;
    transcriptFile?: string;
  }): boolean;
  callGateway: typeof defaultCallGateway;
  captureSubagentCompletionReply: CaptureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd?: typeof cleanupBrowserSessionsForLifecycleEnd;
  runSubagentAnnounceFlow: RunSubagentAnnounceFlow;
  warn(message: string, meta?: Record<string, unknown>): void;
}) {
  const scheduledResumeTimers = new Set<ReturnType<typeof setTimeout>>();

  const scheduleResumeSubagentRun = (runId: string, entry: SubagentRunRecord, delayMs: number) => {
    const timer = setTimeout(() => {
      scheduledResumeTimers.delete(timer);
      if (params.runs.get(runId) !== entry) {
        return;
      }
      params.resumeSubagentRun(runId);
    }, delayMs);
    timer.unref?.();
    scheduledResumeTimers.add(timer);
  };

  const clearScheduledResumeTimers = () => {
    for (const timer of scheduledResumeTimers) {
      clearTimeout(timer);
    }
    scheduledResumeTimers.clear();
  };

  const maskRunId = (runId: string): string => {
    const trimmed = runId.trim();
    if (!trimmed) {
      return "unknown";
    }
    if (trimmed.length <= 8) {
      return "***";
    }
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  };

  const maskSessionKey = (sessionKey: string): string => {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return "unknown";
    }
    const prefix = trimmed.split(":").slice(0, 2).join(":") || "session";
    return `${prefix}:…`;
  };

  const buildSafeLifecycleErrorMeta = (err: unknown): Record<string, string> => {
    const message = formatErrorMessage(err);
    const name = readErrorName(err);
    return name ? { name, message } : { message };
  };

  const formatAnnounceDeliveryError = (delivery: SubagentAnnounceDeliveryResult): string => {
    const errors = [
      delivery.error,
      ...(delivery.phases ?? []).map((phase) =>
        phase.error ? `${phase.phase}: ${phase.error}` : undefined,
      ),
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    return errors.length > 0
      ? uniqueStrings(errors).join("; ")
      : `delivery path ${delivery.path} did not complete`;
  };

  const recordAnnounceDeliveryResult = (
    entry: SubagentRunRecord,
    delivery: SubagentAnnounceDeliveryResult,
  ) => {
    const deliveryState = ensureDeliveryState(entry);
    if (typeof delivery.enqueuedAt === "number") {
      deliveryState.enqueuedAt ??= delivery.enqueuedAt;
    }
    if (delivery.delivered) {
      const deliveredAt =
        typeof delivery.deliveredAt === "number" ? delivery.deliveredAt : Date.now();
      deliveryState.deliveredAt = deliveredAt;
      deliveryState.lastDropReason = undefined;
    }
  };

  const hasPriorRequesterDeliveryMirror = async (entry: SubagentRunRecord): Promise<boolean> => {
    const completion = ensureCompletionState(entry);
    const expectedText = extractTextFromChatContent(completion.resultText, { joinWith: "" });
    if (entry.expectsCompletionMessage !== true || expectedText == null) {
      return false;
    }
    const mirrorNotBefore = entry.startedAt ?? entry.createdAt;
    const mirrorNotAfter = Date.now() + 30_000;
    const expectedIdempotencyKey = buildAnnounceIdempotencyKey(
      buildAnnounceIdFromChildRun({
        childSessionKey: entry.childSessionKey,
        childRunId: entry.runId,
      }),
    );
    const isExpectedMirrorIdempotencyKey = (value: unknown): boolean =>
      typeof value === "string" &&
      (value === expectedIdempotencyKey ||
        value.startsWith(`${expectedIdempotencyKey}:internal-source-reply:`) ||
        value.startsWith(`${expectedIdempotencyKey}:message-tool:internal-source-reply:`) ||
        value.startsWith(`${entry.runId}:message-tool:`) ||
        value.startsWith(`${entry.runId}:internal-source-reply:`));
    try {
      const history = await params.callGateway<{
        messages?: unknown[];
      }>({
        method: "chat.history",
        params: {
          sessionKey: entry.requesterSessionKey,
          limit: 25,
          maxChars: DELIVERY_MIRROR_HISTORY_MAX_CHARS,
        },
        timeoutMs: 5_000,
      });
      const mirror = history.messages?.find((message) => {
        if (!message || typeof message !== "object") {
          return false;
        }
        const record = message as Record<string, unknown>;
        const timestamp = record.timestamp;
        if (
          typeof timestamp !== "number" ||
          !Number.isFinite(timestamp) ||
          timestamp < mirrorNotBefore ||
          timestamp > mirrorNotAfter ||
          !isExpectedMirrorIdempotencyKey(record.idempotencyKey)
        ) {
          return false;
        }
        const text = extractTextFromChatContent(record.content, { joinWith: "" });
        return (
          record.role === "assistant" &&
          record.provider === "openclaw" &&
          record.model === "delivery-mirror" &&
          text === expectedText
        );
      });
      if (mirror) {
        ensureDeliveryState(entry).deliveredAt = (mirror as { timestamp: number }).timestamp;
      }
      return Boolean(mirror);
    } catch {
      return false;
    }
  };

  const safeSetSubagentTaskDeliveryStatus = (args: {
    runId: string;
    childSessionKey: string;
    deliveryStatus: "delivered" | "failed";
    deliveryError?: string;
  }) => {
    try {
      setDetachedTaskDeliveryStatusByRunId({
        runId: args.runId,
        runtime: "subagent",
        sessionKey: args.childSessionKey,
        deliveryStatus: args.deliveryStatus,
        error: args.deliveryStatus === "failed" ? args.deliveryError : undefined,
      });
    } catch (err) {
      params.warn("failed to update subagent background task delivery state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.runId),
        childSessionKey: maskSessionKey(args.childSessionKey),
        deliveryStatus: args.deliveryStatus,
      });
    }
  };

  const safeFinalizeSubagentTaskRun = (args: {
    entry: SubagentRunRecord;
    outcome: SubagentRunOutcome;
  }) => {
    const endedAt = args.entry.endedAt ?? Date.now();
    const lastEventAt = endedAt;
    try {
      if (args.outcome.status === "ok") {
        const completion = ensureCompletionState(args.entry);
        const terminalResult =
          args.entry.expectsCompletionMessage === true
            ? resolveRequiredCompletionTerminalResult(completion.resultText)
            : {};
        completeTaskRunByRunId({
          runId: args.entry.runId,
          runtime: "subagent",
          sessionKey: args.entry.childSessionKey,
          endedAt,
          lastEventAt,
          progressSummary: completion.resultText ?? undefined,
          terminalSummary: terminalResult.terminalSummary ?? null,
          terminalOutcome: terminalResult.terminalOutcome,
        });
        return;
      }
      failTaskRunByRunId({
        runId: args.entry.runId,
        runtime: "subagent",
        sessionKey: args.entry.childSessionKey,
        status: args.outcome.status === "timeout" ? "timed_out" : "failed",
        endedAt,
        lastEventAt,
        error: args.outcome.status === "error" ? args.outcome.error : undefined,
        progressSummary: ensureCompletionState(args.entry).resultText ?? undefined,
        terminalSummary: null,
      });
    } catch (err) {
      params.warn("failed to finalize subagent background task state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
        outcomeStatus: args.outcome.status,
      });
    }
  };

  const safeMarkRequiredCompletionDeliveryBlocked = (args: {
    entry: SubagentRunRecord;
    reason?: string;
  }) => {
    if (args.entry.expectsCompletionMessage !== true || args.entry.outcome?.status !== "ok") {
      return;
    }
    const endedAt = args.entry.endedAt ?? Date.now();
    const terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(args.reason);
    try {
      completeTaskRunByRunId({
        runId: args.entry.runId,
        runtime: "subagent",
        sessionKey: args.entry.childSessionKey,
        endedAt,
        lastEventAt: Date.now(),
        progressSummary: ensureCompletionState(args.entry).resultText ?? undefined,
        terminalSummary: terminalResult.terminalSummary,
        terminalOutcome: terminalResult.terminalOutcome,
      });
    } catch (err) {
      params.warn("failed to mark subagent completion delivery blocked", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
      });
    }
  };

  const sanitizeGrantAuditSlug = (value: string): string => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return "grant-run";
    }
    return (
      trimmed
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "grant-run"
    );
  };

  const countQueuedGrantCorrectionCandidates = async (queuePath: string, outcomeCode: string) => {
    try {
      const raw = await fs.readFile(queuePath, "utf8");
      let count = 0;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as { outcomeCode?: unknown };
          if (parsed.outcomeCode === outcomeCode) {
            count += 1;
          }
        } catch {
          continue;
        }
      }
      return count;
    } catch {
      return 0;
    }
  };

  const countGrantAuditReceiptsForOutcome = async (auditDir: string, outcomeCode: string) => {
    try {
      const entries = await fs.readdir(auditDir);
      let count = 0;
      for (const name of entries) {
        if (!name.endsWith(".md")) {
          continue;
        }
        try {
          const raw = await fs.readFile(path.join(auditDir, name), "utf8");
          if (raw.includes(`[Grant Closeout Gate Result] ${outcomeCode}`)) {
            count += 1;
          }
        } catch {
          continue;
        }
      }
      return count;
    } catch {
      return 0;
    }
  };

  const buildGrantGatePreventiveRule = (outcomeCode?: string): string => {
    switch (outcomeCode) {
      case "rejected_closeout_missing_truth":
        return "Every meaningful Grant closeout must include the mandatory truth fields before it can be treated as complete.";
      case "rejected_proof_missing":
        return "Grant must cite readable proof paths for material claims or keep the item open.";
      default:
        return "Grant must satisfy the closeout gate truthfully before a closeout can pass.";
    }
  };

  const buildGrantGeneratedCorrectionBlock = (outcomeCode: string): string | null => {
    switch (outcomeCode) {
      case "rejected_closeout_missing_truth":
        return [
          `<!-- grant-generated-correction:${outcomeCode} -->`,
          "",
          "### GC-005: Do not close out without the full truth fields",
          "",
          "- Trigger:",
          "  - meaningful Grant closeout omits required truth fields",
          "- Required behavior:",
          "  - include run label",
          "  - include target handled",
          "  - include artifact path(s)",
          "  - include proof path(s)",
          "  - include what is materially real now",
          "  - include what is still not real yet",
          "  - include who lawfully owns the next step",
          "  - include open/closed truth",
          "  - include exact next action",
          "- Reason:",
          "  - partial closeout truth is a fake-completion vector",
          "",
        ].join("\n");
      case "rejected_proof_missing":
        return [
          `<!-- grant-generated-correction:${outcomeCode} -->`,
          "",
          "### GC-006: Do not cite proof that is not materially there",
          "",
          "- Trigger:",
          "  - Grant cites proof paths that are missing, unreadable, or not concretely named",
          "- Required behavior:",
          "  - cite readable proof paths for material claims",
          "  - if proof is missing, keep the item open",
          "  - do not imply proof exists because the artifact sounds plausible",
          "- Reason:",
          "  - unsupported proof claims make clean closeouts untrustworthy",
          "",
        ].join("\n");
      default:
        return null;
    }
  };

  const loadGrantCorrectionQueueEntries = async (queuePath: string) => {
    try {
      const raw = await fs.readFile(queuePath, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  };

  const loadGrantRetirementQueueEntries = async (queuePath: string) => {
    return await loadGrantCorrectionQueueEntries(queuePath);
  };

  const persistGrantRetirementQueueEntries = async (
    queuePath: string,
    entries: Record<string, unknown>[],
  ) => {
    if (entries.length === 0) {
      await fs.rm(queuePath, { force: true });
      return;
    }
    await fs.writeFile(
      queuePath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  };

  const appendGrantCorrectionToMatrix = async (matrixPath: string, block: string) => {
    const raw = await fs.readFile(matrixPath, "utf8");
    if (raw.includes(block.split("\n")[0] ?? "")) {
      return false;
    }
    const anchor = "## Active corrections";
    const insertAt = raw.includes(anchor) ? raw.indexOf(anchor) + anchor.length : raw.length;
    const next =
      raw.slice(0, insertAt) +
      "\n\n" +
      block.trimEnd() +
      "\n" +
      raw.slice(insertAt).replace(/^\n*/, "\n");
    await fs.writeFile(matrixPath, next, "utf8");
    return true;
  };

  const hasGrantGeneratedCorrectionBlock = async (matrixPath: string, outcomeCode: string) => {
    try {
      const raw = await fs.readFile(matrixPath, "utf8");
      return raw.includes(`<!-- grant-generated-correction:${outcomeCode} -->`);
    } catch {
      return false;
    }
  };

  const removeGrantGeneratedCorrectionBlock = async (matrixPath: string, outcomeCode: string) => {
    const raw = await fs.readFile(matrixPath, "utf8");
    const marker = `<!-- grant-generated-correction:${outcomeCode} -->`;
    const start = raw.indexOf(marker);
    if (start < 0) {
      return false;
    }
    const nextMarker = raw.indexOf("<!-- grant-generated-correction:", start + marker.length);
    const nextHeading = raw.indexOf("\n### GC-", start + marker.length);
    const candidates = [nextMarker, nextHeading].filter((value) => value >= 0);
    const end = candidates.length > 0 ? Math.min(...candidates) : raw.length;
    const next = `${raw.slice(0, start).replace(/\n*$/, "\n\n")}${raw.slice(end).replace(/^\n+/, "")}`;
    await fs.writeFile(matrixPath, next, "utf8");
    return true;
  };

  const archivePromotedGrantQueueEntries = async (args: {
    queuePath: string;
    archivePath: string;
    entries: Record<string, unknown>[];
    promotedOutcomeCode: string;
  }) => {
    const allEntries = await loadGrantCorrectionQueueEntries(args.queuePath);
    const promoted = allEntries.filter((entry) => entry.outcomeCode === args.promotedOutcomeCode);
    const remaining = allEntries.filter((entry) => entry.outcomeCode !== args.promotedOutcomeCode);
    if (promoted.length === 0) {
      return false;
    }
    await fs.mkdir(path.dirname(args.archivePath), { recursive: true });
    const archiveLines = promoted.map((entry) =>
      JSON.stringify({
        ...entry,
        archivedAt: new Date().toISOString(),
        archiveReason: "promoted_to_corrections_matrix",
      }),
    );
    await fs.appendFile(args.archivePath, `${archiveLines.join("\n")}\n`, "utf8");
    if (remaining.length > 0) {
      await fs.writeFile(
        args.queuePath,
        `${remaining.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );
    } else {
      await fs.rm(args.queuePath, { force: true });
    }
    return true;
  };

  const archiveGrantRetirementEntries = async (args: {
    queuePath: string;
    archivePath: string;
    retiredOutcomeCode: string;
    archiveReason?: string;
  }) => {
    const allEntries = await loadGrantRetirementQueueEntries(args.queuePath);
    const retired = allEntries.filter((entry) => entry.outcomeCode === args.retiredOutcomeCode);
    const remaining = allEntries.filter((entry) => entry.outcomeCode !== args.retiredOutcomeCode);
    if (retired.length === 0) {
      return false;
    }
    await fs.mkdir(path.dirname(args.archivePath), { recursive: true });
    const archiveLines = retired.map((entry) =>
      JSON.stringify({
        ...entry,
        archivedAt: new Date().toISOString(),
        archiveReason: args.archiveReason ?? "retired_from_corrections_matrix",
      }),
    );
    await fs.appendFile(args.archivePath, `${archiveLines.join("\n")}\n`, "utf8");
    if (remaining.length > 0) {
      await fs.writeFile(
        args.queuePath,
        `${remaining.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );
    } else {
      await fs.rm(args.queuePath, { force: true });
    }
    return true;
  };

  const validateGrantRetirementEntry = (
    entry: Record<string, unknown>,
  ):
    | {
        valid: true;
        outcomeCode: string;
        requestPath: string;
        requestedBy: string;
        approvedBy: string;
        reason: string;
        evidence: string;
        resolutionProofPaths: string[];
        notes: string;
        requestedAt?: string;
        approvedAt?: string;
      }
    | { valid: false; error: string; outcomeCode?: string } => {
    const outcomeCode =
      typeof entry.outcomeCode === "string" && entry.outcomeCode.trim()
        ? entry.outcomeCode.trim()
        : "";
    if (!outcomeCode) {
      return { valid: false, error: "missing outcomeCode" };
    }
    const requestedBy =
      typeof entry.requestedBy === "string" && entry.requestedBy.trim()
        ? entry.requestedBy.trim()
        : "";
    if (requestedBy !== "Will") {
      return { valid: false, error: "requestedBy must be Will", outcomeCode };
    }
    const approvedBy =
      typeof entry.approvedBy === "string" && entry.approvedBy.trim()
        ? entry.approvedBy.trim()
        : "";
    if (approvedBy !== "Will") {
      return { valid: false, error: "approvedBy must be Will", outcomeCode };
    }
    const reason =
      typeof entry.reason === "string" && entry.reason.trim() ? entry.reason.trim() : "";
    if (!ALLOWED_GRANT_RETIREMENT_REASONS.has(reason)) {
      return {
        valid: false,
        error: `reason must be one of: ${Array.from(ALLOWED_GRANT_RETIREMENT_REASONS).join(", ")}`,
        outcomeCode,
      };
    }
    const evidence =
      typeof entry.evidence === "string" && entry.evidence.trim() ? entry.evidence.trim() : "";
    const resolutionProofPaths = Array.isArray(entry.resolutionProofPaths)
      ? entry.resolutionProofPaths.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const requestPath =
      typeof entry.requestPath === "string" && entry.requestPath.trim()
        ? entry.requestPath.trim()
        : "";
    if (!requestPath) {
      return {
        valid: false,
        error: "retirement request requires requestPath",
        outcomeCode,
      };
    }
    if (!evidence && resolutionProofPaths.length === 0) {
      return {
        valid: false,
        error: "retirement request requires evidence or resolutionProofPaths",
        outcomeCode,
      };
    }
    const notes = typeof entry.notes === "string" ? entry.notes : "";
    const requestedAt =
      typeof entry.requestedAt === "string" && entry.requestedAt.trim()
        ? entry.requestedAt.trim()
        : undefined;
    const approvedAt =
      typeof entry.approvedAt === "string" && entry.approvedAt.trim()
        ? entry.approvedAt.trim()
        : undefined;
    return {
      valid: true,
      outcomeCode,
      requestPath,
      requestedBy,
      approvedBy,
      reason,
      evidence,
      resolutionProofPaths,
      notes,
      requestedAt,
      approvedAt,
    };
  };

  const materializeGrantRetirementRequestArtifactIfNeeded = async (args: {
    workspaceDir: string;
    entry: Record<string, unknown>;
  }): Promise<
    | {
        valid: true;
        entry: Record<string, unknown>;
      }
    | {
        valid: false;
        error: string;
        outcomeCode?: string;
      }
  > => {
    const validation = validateGrantRetirementEntry(args.entry);
    if (validation.valid) {
      return { valid: true, entry: args.entry };
    }
    if (validation.error !== "retirement request requires requestPath") {
      return validation;
    }

    const outcomeCode =
      typeof args.entry.outcomeCode === "string" && args.entry.outcomeCode.trim()
        ? args.entry.outcomeCode.trim()
        : undefined;
    const requestedBy =
      typeof args.entry.requestedBy === "string" && args.entry.requestedBy.trim()
        ? args.entry.requestedBy.trim()
        : "";
    if (requestedBy !== "Will") {
      return { valid: false, error: "requestedBy must be Will", outcomeCode };
    }
    const approvedBy =
      typeof args.entry.approvedBy === "string" && args.entry.approvedBy.trim()
        ? args.entry.approvedBy.trim()
        : "";
    if (approvedBy !== "Will") {
      return { valid: false, error: "approvedBy must be Will", outcomeCode };
    }
    const reason =
      typeof args.entry.reason === "string" && args.entry.reason.trim()
        ? args.entry.reason.trim()
        : "";
    if (!ALLOWED_GRANT_RETIREMENT_REASONS.has(reason)) {
      return {
        valid: false,
        error: `reason must be one of: ${Array.from(ALLOWED_GRANT_RETIREMENT_REASONS).join(", ")}`,
        outcomeCode,
      };
    }
    const evidence =
      typeof args.entry.evidence === "string" && args.entry.evidence.trim()
        ? args.entry.evidence.trim()
        : "";
    const resolutionProofPaths = Array.isArray(args.entry.resolutionProofPaths)
      ? args.entry.resolutionProofPaths.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
    if (!evidence && resolutionProofPaths.length === 0) {
      return {
        valid: false,
        error: "retirement request requires evidence or resolutionProofPaths",
        outcomeCode,
      };
    }
    if (!outcomeCode) {
      return { valid: false, error: "missing outcomeCode" };
    }

    let rulebook;
    try {
      rulebook = await loadGrantHardeningRulebook({ workspaceDir: args.workspaceDir });
    } catch (err) {
      const error = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      return {
        valid: false,
        error,
        outcomeCode,
      };
    }

    const templatePath = path.join(
      args.workspaceDir,
      GRANT_CORRECTION_RETIREMENT_REQUEST_TEMPLATE_RELATIVE_PATH,
    );
    let templateRecord: Record<string, unknown>;
    try {
      templateRecord = JSON.parse(await fs.readFile(templatePath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (err) {
      const error = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      return {
        valid: false,
        error: `retirement request template missing or unreadable at ${templatePath}: ${error}`,
        outcomeCode,
      };
    }

    const timestamp =
      (typeof args.entry.requestedAt === "string" && args.entry.requestedAt.trim()) ||
      (typeof args.entry.approvedAt === "string" && args.entry.approvedAt.trim()) ||
      (typeof args.entry.queuedAt === "string" && args.entry.queuedAt.trim()) ||
      new Date().toISOString();
    const requestDir = path.join(
      args.workspaceDir,
      GRANT_CORRECTION_RETIREMENT_REQUESTS_RELATIVE_DIR,
    );
    const requestPath = path.join(
      requestDir,
      `${timestamp.replace(/[:.]/g, "").replace(/Z$/, "Z")}_${sanitizeGrantAuditSlug(outcomeCode)}.json`,
    );
    const requestArtifact = attachGrantRulebookMetadata(
      {
        ...templateRecord,
        requestedBy,
        approvedBy,
        outcomeCode,
        reason,
        evidence,
        resolutionProofPaths,
        notes: typeof args.entry.notes === "string" ? args.entry.notes : "",
        requestedAt:
          (typeof args.entry.requestedAt === "string" && args.entry.requestedAt.trim()) ||
          timestamp,
        approvedAt:
          (typeof args.entry.approvedAt === "string" && args.entry.approvedAt.trim()) || timestamp,
      },
      rulebook.verification,
    );
    await fs.mkdir(requestDir, { recursive: true });
    await fs.writeFile(requestPath, `${JSON.stringify(requestArtifact, null, 2)}\n`, "utf8");
    return {
      valid: true,
      entry: {
        ...attachGrantRulebookMetadata(args.entry, rulebook.verification),
        requestPath,
      },
    };
  };

  const archiveRejectedGrantRetirementEntry = async (args: {
    queuePath: string;
    archivePath: string;
    outcomeCode: string;
    rejectionReason: string;
  }) => {
    return await archiveGrantRetirementEntries({
      queuePath: args.queuePath,
      archivePath: args.archivePath,
      retiredOutcomeCode: args.outcomeCode,
      archiveReason: `rejected_retirement_request:${args.rejectionReason}`,
    });
  };

  const promoteGrantCorrectionCandidatesIfReady = async (workspaceDir: string) => {
    const queuePath = path.join(workspaceDir, GRANT_CORRECTION_QUEUE_RELATIVE_PATH);
    const archivePath = path.join(workspaceDir, GRANT_CORRECTION_ARCHIVE_RELATIVE_PATH);
    const matrixPath = path.join(workspaceDir, GRANT_CORRECTIONS_MATRIX_RELATIVE_PATH);
    const entries = await loadGrantCorrectionQueueEntries(queuePath);
    if (entries.length === 0) {
      return;
    }
    let matrixExists = true;
    try {
      await fs.access(matrixPath);
    } catch {
      matrixExists = false;
    }
    if (!matrixExists) {
      return;
    }
    const promotedOutcomeCodes = new Set<string>();
    for (const entry of entries) {
      const outcomeCode =
        typeof entry.outcomeCode === "string" && entry.outcomeCode.trim()
          ? entry.outcomeCode.trim()
          : "";
      if (!outcomeCode || promotedOutcomeCodes.has(outcomeCode)) {
        continue;
      }
      const block = buildGrantGeneratedCorrectionBlock(outcomeCode);
      if (!block) {
        continue;
      }
      const didAppend = await appendGrantCorrectionToMatrix(matrixPath, block);
      await archivePromotedGrantQueueEntries({
        queuePath,
        archivePath,
        entries,
        promotedOutcomeCode: outcomeCode,
      });
      if (didAppend) {
        promotedOutcomeCodes.add(outcomeCode);
      }
    }
  };

  const processGrantCorrectionRetirementsIfReady = async (workspaceDir: string) => {
    const queuePath = path.join(workspaceDir, GRANT_CORRECTION_RETIREMENT_QUEUE_RELATIVE_PATH);
    const archivePath = path.join(workspaceDir, GRANT_CORRECTION_RETIREMENT_ARCHIVE_RELATIVE_PATH);
    const rejectedArchivePath = path.join(
      workspaceDir,
      GRANT_CORRECTION_RETIREMENT_REJECTED_ARCHIVE_RELATIVE_PATH,
    );
    const matrixPath = path.join(workspaceDir, GRANT_CORRECTIONS_MATRIX_RELATIVE_PATH);
    const entries = await loadGrantRetirementQueueEntries(queuePath);
    if (entries.length === 0) {
      return;
    }
    try {
      await fs.access(matrixPath);
    } catch {
      return;
    }
    for (const entry of entries) {
      const materialized = await materializeGrantRetirementRequestArtifactIfNeeded({
        workspaceDir,
        entry,
      });
      if (!materialized.valid) {
        if (materialized.outcomeCode) {
          await archiveRejectedGrantRetirementEntry({
            queuePath,
            archivePath: rejectedArchivePath,
            outcomeCode: materialized.outcomeCode,
            rejectionReason: materialized.error,
          });
        }
        continue;
      }
      if (
        materialized.entry.requestPath !== entry.requestPath &&
        typeof materialized.entry.requestPath === "string" &&
        materialized.entry.requestPath.trim()
      ) {
        Object.assign(entry, materialized.entry);
        await persistGrantRetirementQueueEntries(queuePath, entries);
      }
      const validation = validateGrantRetirementEntry(materialized.entry);
      if (!validation.valid) {
        if (validation.outcomeCode) {
          await archiveRejectedGrantRetirementEntry({
            queuePath,
            archivePath: rejectedArchivePath,
            outcomeCode: validation.outcomeCode,
            rejectionReason: validation.error,
          });
        }
        continue;
      }
      const outcomeCode = validation.outcomeCode;
      try {
        await fs.access(validation.requestPath);
      } catch {
        await archiveRejectedGrantRetirementEntry({
          queuePath,
          archivePath: rejectedArchivePath,
          outcomeCode,
          rejectionReason: "requestPath unreadable",
        });
        continue;
      }
      const removed = await removeGrantGeneratedCorrectionBlock(matrixPath, outcomeCode);
      if (!removed) {
        continue;
      }
      await archiveGrantRetirementEntries({
        queuePath,
        archivePath,
        retiredOutcomeCode: outcomeCode,
      });
    }
  };

  const launchGrantSameSliceRework = async (args: {
    entry: SubagentRunRecord;
    linkedTask: NonNullable<ReturnType<typeof findTaskByRunId>>;
    linkedFlowId: string;
    expectedFlowRevision: number;
    correctionSummary: string;
    assessedAt: number;
  }): Promise<{ launched: boolean; blockedReason?: string }> => {
    const childSessionKey = args.entry.childSessionKey?.trim();
    if (!childSessionKey) {
      return {
        launched: false,
        blockedReason: buildRel002BlockedReason(
          "same-slice rework launch requires a child session key, but none is available",
        ),
      };
    }
    let launchResponse: { runId?: string } | undefined;
    try {
      launchResponse = await params.callGateway<{ runId?: string }>({
        method: "agent",
        params: {
          sessionKey: childSessionKey,
          message: `Grant closeout rework handback. ${args.correctionSummary}`,
          deliver: false,
          timeout: 0,
        },
        timeoutMs: 10_000,
      });
    } catch (error) {
      return {
        launched: false,
        blockedReason: buildRel002BlockedReason(
          `same-slice rework launch failed before acceptance: ${formatErrorMessage(error)}`,
        ),
      };
    }
    const nextRunId = typeof launchResponse?.runId === "string" ? launchResponse.runId.trim() : "";
    if (!nextRunId) {
      return {
        launched: false,
        blockedReason: buildRel002BlockedReason(
          "same-slice rework launch returned no accepted run id, so running proof is missing",
        ),
      };
    }
    const replaceAfterSteer =
      params.replaceSubagentRunAfterSteer ?? replaceSubagentRunAfterSteerDefault;
    if (
      !replaceAfterSteer({
        previousRunId: args.entry.runId,
        nextRunId,
        preserveFrozenResultFallback: true,
      })
    ) {
      return {
        launched: false,
        blockedReason: buildRel002BlockedReason(
          `same-slice rework launch accepted ${nextRunId}, but the subagent registry could not bind the new run`,
        ),
      };
    }
    const queuedTask = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: args.linkedTask.ownerKey,
      ownerKey: args.linkedTask.ownerKey,
      scopeKind: args.linkedTask.scopeKind,
      childSessionKey,
      parentFlowId: args.linkedTask.parentFlowId,
      parentTaskId: args.linkedTask.taskId,
      runId: nextRunId,
      task: `${args.linkedTask.task} rework`,
      missionId: args.linkedTask.missionId,
      missionSummary: args.linkedTask.missionSummary ?? args.correctionSummary,
      missionState: "active",
      status: "queued",
      deliveryStatus: "pending",
      notifyPolicy: "state_changes",
      progressSummary: buildRel002QueueSummary(args.correctionSummary),
      preferMetadata: true,
    });
    if (!queuedTask) {
      return {
        launched: false,
        blockedReason: buildRel002BlockedReason(
          `same-slice rework launch accepted ${nextRunId}, but the queued rework packet could not be persisted`,
        ),
      };
    }
    const runningRecords = markTaskRunningByRunId({
      runId: nextRunId,
      runtime: "subagent",
      sessionKey: childSessionKey,
      startedAt: args.assessedAt,
      lastEventAt: args.assessedAt,
      progressSummary: buildRel002RunningSummary(args.correctionSummary, nextRunId),
      eventSummary: REL002_REWORK_EXECUTOR_RUNNING,
    });
    if (!runningRecords.some((task) => task.runId === nextRunId && task.status === "running")) {
      return {
        launched: false,
        blockedReason: buildRel002BlockedReason(
          `same-slice rework launch accepted ${nextRunId}, but no running task proof was persisted`,
        ),
      };
    }
    const launchedFlow = recordFlowNextExecutableLaunch({
      flowId: args.linkedFlowId,
      expectedRevision: args.expectedFlowRevision,
      detail: `${REL002_REWORK_EXECUTOR_LAUNCHED}: accepted same-slice rework run ${nextRunId}`,
      currentStep: "closeout_rework_running",
      updatedAt: args.assessedAt,
    });
    if (!launchedFlow.applied) {
      return {
        launched: false,
        blockedReason: buildRel002BlockedReason(
          `same-slice rework run ${nextRunId} started, but parent flow launch proof could not be recorded`,
        ),
      };
    }
    const stateJson = launchedFlow.flow.stateJson as {
      rework?: { handbackStatus?: string };
    } | null;
    if (stateJson?.rework?.handbackStatus === "required") {
      updateFlowRecordByIdExpectedRevision({
        flowId: launchedFlow.flow.flowId,
        expectedRevision: launchedFlow.flow.revision,
        patch: {
          stateJson: {
            ...(stateJson ?? {}),
            rework: {
              ...stateJson.rework,
              handbackStatus: "completed",
            },
          },
          updatedAt: args.assessedAt,
        },
      });
    }
    return { launched: true };
  };

  const persistGrantCloseoutGateAudit = async (args: {
    entry: SubagentRunRecord;
    result: GrantCloseoutGateResult;
  }) => {
    const completion = ensureCompletionState(args.entry);
    const assessedAt = Date.now();
    const previousGate = completion.grantCloseoutGate;
    const reviewStatus = !args.result.assessment.applies
      ? "not_applicable"
      : args.result.assessment.passed
        ? "passed"
        : "rejected";
    completion.grantCloseoutGate = {
      applies: args.result.assessment.applies,
      passed: args.result.assessment.passed,
      reviewStatus,
      outcomeCode: args.result.assessment.outcomeCode,
      assessedAt,
      missingFields: args.result.assessment.missingFields,
      missingProofPaths: args.result.assessment.missingProofPaths,
      requiresCorrectedCloseout: args.result.assessment.applies && !args.result.assessment.passed,
      materialProgressState: args.result.assessment.applies
        ? args.result.assessment.passed
          ? "closeout_review_passed"
          : "closeout_rejected"
        : "closeout_not_applicable",
      auditReceiptPath: previousGate?.auditReceiptPath,
      correctionCandidateQueuePath: previousGate?.correctionCandidateQueuePath,
      correctionCandidateQueuedAt: previousGate?.correctionCandidateQueuedAt,
    };

    const workspaceDir = resolveSafeGrantWorkspaceDir(args.entry.workspaceDir);
    if (workspaceDir) {
      await processGrantCorrectionRetirementsIfReady(workspaceDir);
    }

    if (!args.result.assessment.applies) {
      params.persist();
      return;
    }

    const linkedTask = findTaskByRunId(args.entry.runId);
    const linkedFlowId = linkedTask?.parentFlowId?.trim();
    const linkedFlow = linkedFlowId ? getTaskFlowById(linkedFlowId) : undefined;
    const linkedContinuation = linkedFlow ? getTaskFlowProductionContinuation(linkedFlow) : null;
    if (linkedContinuation && linkedFlowId) {
      args.entry.productionContinuation = {
        activeProductionRun: linkedContinuation.activeProductionRun,
        continuationRequiredAfterLocalSuccess:
          linkedContinuation.continuationRequiredAfterLocalSuccess,
        nextExecutableUnitIdentified: linkedContinuation.nextExecutableUnitIdentified,
        nextExecutableUnitLaunched: linkedContinuation.nextExecutableUnitLaunched,
        continuationViolation: linkedContinuation.continuationViolation,
        lawfulStopReason: linkedContinuation.lawfulStopReason,
        parentFlowId: linkedFlowId,
      };
    }

    if (args.result.assessment.passed) {
      params.persist();
      return;
    }

    const correctionSummary = buildGrantCorrectionSummary(args.result);
    if (linkedTask) {
      completeTaskRunByRunId({
        runId: args.entry.runId,
        runtime: "subagent",
        sessionKey: args.entry.childSessionKey,
        endedAt: assessedAt,
        lastEventAt: assessedAt,
        terminalOutcome: "blocked",
        terminalSummary: `${REL002_CHILD_RESULT_REJECTED} :: ${correctionSummary}`,
      });
      let postFailureFlow = linkedFlow;
      if (linkedFlowId) {
        const flow = getTaskFlowById(linkedFlowId);
        if (flow) {
          const reworkUpdate = recordBlindTestCloseoutFailure({
            flowId: linkedFlowId,
            expectedRevision: flow.revision,
            summary: correctionSummary,
            outcomeCode: args.result.assessment.outcomeCode,
            reviewedAt: assessedAt,
            updatedAt: assessedAt,
          });
          if (reworkUpdate.applied) {
            postFailureFlow = reworkUpdate.flow;
          }
        }
      }
      const postFailureContinuation = postFailureFlow
        ? getTaskFlowProductionContinuation(postFailureFlow)
        : null;
      const handbackState =
        (
          postFailureFlow?.stateJson as {
            rework?: { handbackStatus?: string; transferOwner?: string };
          } | null
        )?.rework ?? null;
      const canAttemptImmediateFollowThrough =
        Boolean(
          handbackState?.handbackStatus === "required" && handbackState.transferOwner !== "Will",
        ) &&
        continuationRequiresImmediateReworkLaunch(postFailureContinuation) &&
        Boolean(linkedFlowId);
      if (canAttemptImmediateFollowThrough && linkedFlowId && postFailureFlow) {
        const followThrough = await launchGrantSameSliceRework({
          entry: args.entry,
          linkedTask,
          linkedFlowId,
          expectedFlowRevision: postFailureFlow.revision,
          correctionSummary,
          assessedAt,
        });
        if (!followThrough.launched) {
          const blockedReason =
            followThrough.blockedReason ??
            buildRel002BlockedReason("same-slice rework launch failed without an exact reason");
          recordFlowLawfulStop({
            flowId: linkedFlowId,
            expectedRevision: postFailureFlow.revision,
            reason: "blocker",
            detail: blockedReason,
            currentStep: "rework_launch_blocked",
            updatedAt: assessedAt,
          });
          if (linkedTask.missionId?.trim() || linkedTask.missionSummary?.trim()) {
            createTaskRecord({
              runtime: "subagent",
              requesterSessionKey: linkedTask.ownerKey,
              ownerKey: linkedTask.ownerKey,
              scopeKind: linkedTask.scopeKind,
              parentFlowId: linkedTask.parentFlowId,
              parentTaskId: linkedTask.taskId,
              task: `${linkedTask.task} rework blocked`,
              missionId: linkedTask.missionId,
              missionSummary: linkedTask.missionSummary ?? correctionSummary,
              missionState: "active",
              status: "failed",
              deliveryStatus: "pending",
              notifyPolicy: "state_changes",
              error: blockedReason,
              terminalSummary: blockedReason,
              endedAt: assessedAt,
              lastEventAt: assessedAt,
              preferMetadata: true,
            });
          }
        }
      } else if (linkedTask.missionId?.trim() || linkedTask.missionSummary?.trim()) {
        createTaskRecord({
          runtime: "subagent",
          requesterSessionKey: linkedTask.ownerKey,
          ownerKey: linkedTask.ownerKey,
          scopeKind: linkedTask.scopeKind,
          childSessionKey: linkedTask.childSessionKey,
          parentFlowId: linkedTask.parentFlowId,
          parentTaskId: linkedTask.taskId,
          task: `${linkedTask.task} rework`,
          missionId: linkedTask.missionId,
          missionSummary: linkedTask.missionSummary ?? correctionSummary,
          missionState: "active",
          status: "queued",
          deliveryStatus: "pending",
          notifyPolicy: "state_changes",
          progressSummary: buildRel002QueueSummary(correctionSummary),
          preferMetadata: true,
        });
      }
      const latestFlow = linkedFlowId ? getTaskFlowById(linkedFlowId) : undefined;
      const latestContinuation = latestFlow ? getTaskFlowProductionContinuation(latestFlow) : null;
      if (latestContinuation && linkedFlowId) {
        args.entry.productionContinuation = {
          activeProductionRun: latestContinuation.activeProductionRun,
          continuationRequiredAfterLocalSuccess:
            latestContinuation.continuationRequiredAfterLocalSuccess,
          nextExecutableUnitIdentified: latestContinuation.nextExecutableUnitIdentified,
          nextExecutableUnitLaunched: latestContinuation.nextExecutableUnitLaunched,
          continuationViolation: latestContinuation.continuationViolation,
          lawfulStopReason: latestContinuation.lawfulStopReason,
          parentFlowId: linkedFlowId,
        };
      }
    }

    if (!workspaceDir) {
      params.persist();
      return;
    }

    const prior = previousGate;
    if (
      prior?.outcomeCode === args.result.assessment.outcomeCode &&
      typeof prior?.auditReceiptPath === "string" &&
      prior.auditReceiptPath.trim()
    ) {
      params.persist();
      return;
    }

    const auditDir = path.join(workspaceDir, GRANT_AUDIT_RELATIVE_DIR);
    const queuePath = path.join(workspaceDir, GRANT_CORRECTION_QUEUE_RELATIVE_PATH);
    const matrixPath = path.join(workspaceDir, GRANT_CORRECTIONS_MATRIX_RELATIVE_PATH);
    await fs.mkdir(auditDir, { recursive: true });
    await fs.mkdir(path.dirname(queuePath), { recursive: true });

    const timestamp = new Date(assessedAt).toISOString();
    const auditFileName = `${timestamp.replace(/[:.]/g, "").replace(/Z$/, "Z")}_${sanitizeGrantAuditSlug(args.entry.label || args.result.taskLabel || args.entry.runId)}_${sanitizeGrantAuditSlug(args.entry.runId)}.md`;
    const auditPath = path.join(auditDir, auditFileName);
    const priorAuditCount = args.result.assessment.outcomeCode
      ? await countGrantAuditReceiptsForOutcome(auditDir, args.result.assessment.outcomeCode)
      : 0;
    const priorCandidateCount = args.result.assessment.outcomeCode
      ? await countQueuedGrantCorrectionCandidates(queuePath, args.result.assessment.outcomeCode)
      : 0;
    const correctionAlreadyActive = args.result.assessment.outcomeCode
      ? await hasGrantGeneratedCorrectionBlock(matrixPath, args.result.assessment.outcomeCode)
      : false;
    const shouldQueueCandidate =
      priorAuditCount >= 1 && priorCandidateCount === 0 && !correctionAlreadyActive;
    const candidateLabel = args.result.assessment.outcomeCode
      ? `grant-${args.result.assessment.outcomeCode}`
      : "grant-closeout-gate";
    await persistGrantCloseoutContinuityGateDecision({
      workspaceDir,
      entry: args.entry,
      result: args.result,
      correctionSummary,
      auditPath,
    });

    const auditLines = [
      "# Grant After-Action Audit",
      "",
      "## Run identity",
      `- Run label: ${args.entry.label || args.result.taskLabel || "unknown"}`,
      `- Date: ${timestamp}`,
      "- Work-order path: unknown",
      "- Reviewer: Will",
      "",
      "## What Grant got right",
      `- Gate applied: ${args.result.assessment.applies ? "yes" : "no"}`,
      `- Outcome captured: ${args.result.assessment.outcomeCode ?? "unknown"}`,
      "",
      "## What Grant missed",
      ...(args.result.assessment.missingFields.length > 0
        ? args.result.assessment.missingFields.map(
            (field: string) => `- missing closeout field: ${field}`,
          )
        : ["- none recorded"]),
      ...(args.result.assessment.missingProofPaths &&
      args.result.assessment.missingProofPaths.length > 0
        ? args.result.assessment.missingProofPaths.map(
            (proofPath: string) => `- missing or unreadable proof path: ${proofPath}`,
          )
        : []),
      "",
      "## What contradiction Grant failed to catch",
      "- none explicitly proven in this gate result",
      "",
      "## What ambiguity was still present",
      `- ${args.result.assessment.outcomeCode === "rejected_closeout_missing_truth" ? "closeout truth remained incomplete" : "proof claim was not materially supported"}`,
      "",
      "## Did Grant preserve owner truth",
      "- yes/no: yes",
      "- notes: owner truth was not disproven by this gate result",
      "",
      "## Did Grant drift into fake completion",
      `- yes/no: ${args.result.assessment.passed ? "no" : "yes"}`,
      `- notes: ${args.result.assessment.passed ? "gate passed review-required state" : "closeout attempted to pass without satisfying the Grant gate"}`,
      "",
      "## Did Will have to rescue the packet",
      "- yes/no: yes",
      "- where: live Grant completion review gate",
      "",
      "## Correction candidate",
      `- ${shouldQueueCandidate ? "new candidate" : "none"}`,
      `- candidate label: ${shouldQueueCandidate ? candidateLabel : "n/a"}`,
      `- why: ${args.result.assessment.outcomeCode ?? "Grant closeout gate failure"}`,
      "",
      "## Promotion decision",
      `- ${shouldQueueCandidate ? "correction candidate" : "audit note only"}`,
      "",
      "## Exact rule that would have prevented the miss",
      `- ${buildGrantGatePreventiveRule(args.result.assessment.outcomeCode)}`,
      "",
      "## Next training move",
      `- Re-run this slice with a corrected closeout that satisfies ${args.result.assessment.outcomeCode ?? "the Grant closeout gate"}.`,
      "",
      "## Evidence",
      "```text",
      args.result.findings,
      "```",
      "",
    ];
    await fs.writeFile(auditPath, auditLines.join("\n"), "utf8");

    completion.grantCloseoutGate.auditReceiptPath = auditPath;

    if (shouldQueueCandidate) {
      const queueEntry = {
        queuedAt: timestamp,
        runId: args.entry.runId,
        label: args.entry.label ?? args.result.taskLabel,
        outcomeCode: args.result.assessment.outcomeCode,
        candidateLabel,
        auditReceiptPath: auditPath,
        missingFields: args.result.assessment.missingFields,
        missingProofPaths: args.result.assessment.missingProofPaths ?? [],
      };
      await fs.appendFile(queuePath, `${JSON.stringify(queueEntry)}\n`, "utf8");
      completion.grantCloseoutGate.correctionCandidateQueuePath = queuePath;
      completion.grantCloseoutGate.correctionCandidateQueuedAt = assessedAt;
      await promoteGrantCorrectionCandidatesIfReady(workspaceDir);
    }

    params.persist();
  };

  const freezeRunResultAtCompletion = async (
    entry: SubagentRunRecord,
    outcome: SubagentRunOutcome,
  ): Promise<boolean> => {
    const completion = ensureCompletionState(entry);
    if (completion.resultText !== undefined) {
      return false;
    }
    if (outcome.status === "error") {
      completion.resultText = null;
      completion.capturedAt = Date.now();
      return true;
    }
    try {
      const captured = await params.captureSubagentCompletionReply(entry.childSessionKey, {
        waitForReply: entry.expectsCompletionMessage === true,
        outcome,
        sessionFile: entry.execution?.transcriptFile,
      });
      completion.resultText = captured?.trim() ? capFrozenResultText(captured) : null;
    } catch {
      completion.resultText = null;
    }
    completion.capturedAt = Date.now();
    return true;
  };

  const listPendingCompletionRunsForSession = (sessionKey: string): SubagentRunRecord[] => {
    const key = sessionKey.trim();
    if (!key) {
      return [];
    }
    const out: SubagentRunRecord[] = [];
    for (const entry of params.runs.values()) {
      if (entry.childSessionKey !== key) {
        continue;
      }
      if (entry.expectsCompletionMessage !== true) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (typeof entry.cleanupCompletedAt === "number") {
        continue;
      }
      out.push(entry);
    }
    return out;
  };

  const refreshFrozenResultFromSession = async (sessionKey: string): Promise<boolean> => {
    const candidates = listPendingCompletionRunsForSession(sessionKey).filter(
      (entry) => entry.outcome?.status !== "error",
    );
    if (candidates.length === 0) {
      return false;
    }

    let captured: string | undefined;
    try {
      captured = await params.captureSubagentCompletionReply(sessionKey);
    } catch {
      return false;
    }
    const trimmed = captured?.trim();
    if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
      return false;
    }

    const nextFrozen = capFrozenResultText(trimmed);
    const capturedAt = Date.now();
    let changed = false;
    for (const entry of candidates) {
      const completion = ensureCompletionState(entry);
      if (completion.resultText === nextFrozen) {
        continue;
      }
      completion.resultText = nextFrozen;
      completion.capturedAt = capturedAt;
      const delivery = entry.delivery;
      if (delivery?.payload) {
        delivery.payload = {
          ...delivery.payload,
          frozenResultText: nextFrozen,
        };
      }
      changed = true;
    }
    if (changed) {
      params.persist();
    }
    return changed;
  };

  const emitCompletionEndedHookIfNeeded = async (
    entry: SubagentRunRecord,
    reason: SubagentLifecycleEndedReason,
  ) => {
    if (
      entry.expectsCompletionMessage === true &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason,
      })
    ) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason,
        sendFarewell: true,
      });
    }
  };

  const clearPendingFinalDelivery = (entry: SubagentRunRecord) => {
    const delivery = ensureDeliveryState(entry);
    delivery.payload = undefined;
    delivery.createdAt = undefined;
    delivery.lastAttemptAt = undefined;
    delivery.attemptCount = undefined;
    delivery.lastError = undefined;
    delivery.suspendedAt = undefined;
    delivery.suspendedReason = undefined;
    if (delivery.status !== "delivered" && delivery.status !== "failed") {
      clearDeliveryState(entry);
    }
  };

  const loadPendingFinalDeliveryPayload = (
    entry: SubagentRunRecord,
  ): PendingFinalDeliveryPayload => {
    return {
      requesterSessionKey:
        entry.delivery?.payload?.requesterSessionKey ?? entry.requesterSessionKey,
      requesterOrigin: entry.delivery?.payload?.requesterOrigin ?? entry.requesterOrigin,
      requesterDisplayKey:
        entry.delivery?.payload?.requesterDisplayKey ?? entry.requesterDisplayKey,
      childSessionKey: entry.delivery?.payload?.childSessionKey ?? entry.childSessionKey,
      childRunId: entry.delivery?.payload?.childRunId ?? entry.runId,
      task: entry.delivery?.payload?.task ?? entry.task,
      label: entry.delivery?.payload?.label ?? entry.label,
      startedAt: entry.delivery?.payload?.startedAt ?? entry.startedAt,
      endedAt: entry.delivery?.payload?.endedAt ?? entry.endedAt,
      outcome: entry.delivery?.payload?.outcome ?? entry.outcome,
      expectsCompletionMessage:
        entry.delivery?.payload?.expectsCompletionMessage ?? entry.expectsCompletionMessage,
      spawnMode: entry.delivery?.payload?.spawnMode ?? entry.spawnMode,
      frozenResultText: entry.delivery?.payload?.frozenResultText ?? entry.completion?.resultText,
      fallbackFrozenResultText:
        entry.delivery?.payload?.fallbackFrozenResultText ?? entry.completion?.fallbackResultText,
      wakeOnDescendantSettle:
        entry.delivery?.payload?.wakeOnDescendantSettle ?? entry.wakeOnDescendantSettle,
    };
  };

  const markPendingFinalDelivery = (args: { entry: SubagentRunRecord; error?: string }) => {
    const now = Date.now();
    const payload: PendingFinalDeliveryPayload = loadPendingFinalDeliveryPayload(args.entry);

    const delivery = ensureDeliveryState(args.entry);
    delivery.status = "pending";
    delivery.createdAt ??= now;
    delivery.lastAttemptAt = now;
    delivery.attemptCount = (delivery.attemptCount ?? 0) + 1;
    delivery.lastError = args.error ?? null;
    delivery.payload = payload;
  };

  const refreshPendingFinalDeliveryPayload = (entry: SubagentRunRecord): boolean => {
    const delivery = entry.delivery;
    if (
      !delivery?.payload ||
      delivery.status === "delivered" ||
      typeof delivery.announcedAt === "number"
    ) {
      return false;
    }
    delivery.payload = {
      ...delivery.payload,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      outcome: entry.outcome,
      frozenResultText: entry.completion?.resultText,
      fallbackFrozenResultText: entry.completion?.fallbackResultText,
    };
    return true;
  };

  const suspendPendingFinalDelivery = (args: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "retry-limit" | "expiry";
    error?: string;
  }) => {
    markPendingFinalDelivery({
      entry: args.entry,
      error: args.error ?? getDeliveryLastError(args.entry) ?? args.reason,
    });
    const now = Date.now();
    const delivery = ensureDeliveryState(args.entry);
    delivery.status = "suspended";
    delivery.suspendedAt ??= now;
    delivery.suspendedReason = args.reason;
    args.entry.cleanupHandled = false;
    args.entry.wakeOnDescendantSettle = undefined;
    const completion = ensureCompletionState(args.entry);
    completion.fallbackResultText = undefined;
    completion.fallbackCapturedAt = undefined;
    params.resumedRuns.delete(args.runId);
    safeSetSubagentTaskDeliveryStatus({
      runId: args.runId,
      childSessionKey: args.entry.childSessionKey,
      deliveryStatus: "failed",
      deliveryError: getDeliveryLastError(args.entry) ?? args.reason,
    });
    safeMarkRequiredCompletionDeliveryBlocked({
      entry: args.entry,
      reason: getDeliveryLastError(args.entry) ?? args.reason,
    });
    logAnnounceGiveUp(args.entry, args.reason);
    params.persist();
  };

  const shouldSuspendPendingFinalDelivery = (entry: SubagentRunRecord) =>
    entry.expectsCompletionMessage === true &&
    entry.cleanup === "keep" &&
    entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE &&
    entry.outcome?.status === "ok";

  const finalizeResumedAnnounceGiveUp = async (giveUpParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "retry-limit" | "expiry";
  }) => {
    if (shouldSuspendPendingFinalDelivery(giveUpParams.entry)) {
      suspendPendingFinalDelivery({
        runId: giveUpParams.runId,
        entry: giveUpParams.entry,
        reason: giveUpParams.reason,
        error: getDeliveryLastError(giveUpParams.entry),
      });
      return;
    }
    const deliveryError = getDeliveryLastError(giveUpParams.entry) ?? giveUpParams.reason;
    clearPendingFinalDelivery(giveUpParams.entry);
    const failedDelivery = ensureDeliveryState(giveUpParams.entry);
    failedDelivery.status = "failed";
    failedDelivery.lastError = deliveryError;
    safeSetSubagentTaskDeliveryStatus({
      runId: giveUpParams.runId,
      childSessionKey: giveUpParams.entry.childSessionKey,
      deliveryStatus: "failed",
      deliveryError,
    });
    safeMarkRequiredCompletionDeliveryBlocked({
      entry: giveUpParams.entry,
      reason: deliveryError,
    });
    giveUpParams.entry.wakeOnDescendantSettle = undefined;
    const completion = ensureCompletionState(giveUpParams.entry);
    completion.fallbackResultText = undefined;
    completion.fallbackCapturedAt = undefined;
    const shouldDeleteAttachments =
      giveUpParams.entry.cleanup === "delete" || !giveUpParams.entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(giveUpParams.entry);
    }
    const completionReason = resolveCleanupCompletionReason(giveUpParams.entry);
    logAnnounceGiveUp(giveUpParams.entry, giveUpParams.reason);
    // Retry-limit / expiry give-up should not leave cleanup stuck behind the
    // best-effort ended hook. Mark the run cleaned first, then fire the hook.
    completeCleanupBookkeeping({
      runId: giveUpParams.runId,
      entry: giveUpParams.entry,
      cleanup: giveUpParams.entry.cleanup,
      completedAt: Date.now(),
    });
    await emitCompletionEndedHookIfNeeded(giveUpParams.entry, completionReason);
  };

  const beginSubagentCleanup = (runId: string) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return false;
    }
    if (entry.cleanupCompletedAt || entry.cleanupHandled) {
      return false;
    }
    entry.cleanupHandled = true;
    params.persist();
    return true;
  };

  const retryDeferredCompletedAnnounces = (excludeRunId?: string) => {
    const now = Date.now();
    for (const [runId, entry] of params.runs.entries()) {
      if (excludeRunId && runId === excludeRunId) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (entry.cleanupCompletedAt || entry.cleanupHandled) {
        continue;
      }
      if (isDeliverySuspended(entry)) {
        continue;
      }
      if (params.suppressAnnounceForSteerRestart(entry)) {
        continue;
      }
      const endedAgo = now - (entry.endedAt ?? now);
      if (entry.expectsCompletionMessage !== true && endedAgo > ANNOUNCE_EXPIRY_MS) {
        if (!beginSubagentCleanup(runId)) {
          continue;
        }
        void finalizeResumedAnnounceGiveUp({
          runId,
          entry,
          reason: "expiry",
        }).catch((error: unknown) => {
          defaultRuntime.log(
            `[warn] Subagent expiry finalize failed during deferred retry for run ${runId}: ${String(error)}`,
          );
          const current = params.runs.get(runId);
          if (!current || current.cleanupCompletedAt) {
            return;
          }
          current.cleanupHandled = false;
          params.persist();
        });
        continue;
      }
      params.resumedRuns.delete(runId);
      params.resumeSubagentRun(runId);
    }
  };

  const completeCleanupBookkeeping = (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
  }) => {
    void removeInternalSessionEffectsTranscript(cleanupParams.entry.execution?.transcriptFile);
    if (cleanupParams.entry.spawnMode !== "session") {
      void retireSessionMcpRuntimeForSessionKey({
        sessionKey: cleanupParams.entry.childSessionKey,
        reason: "subagent-run-cleanup",
        onError: (error, sessionId) => {
          params.warn("failed to retire subagent bundle MCP runtime", {
            error: buildSafeLifecycleErrorMeta(error),
            sessionId,
            runId: maskRunId(cleanupParams.runId),
            childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey),
          });
        },
      });
    }
    if (cleanupParams.cleanup === "delete") {
      params.clearPendingLifecycleError(cleanupParams.runId);
      void params.notifyContextEngineSubagentEnded({
        childSessionKey: cleanupParams.entry.childSessionKey,
        reason: "deleted",
        agentDir: cleanupParams.entry.agentDir,
        workspaceDir: cleanupParams.entry.workspaceDir,
      });
      params.runs.delete(cleanupParams.runId);
      params.persist();
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      return;
    }
    void params.notifyContextEngineSubagentEnded({
      childSessionKey: cleanupParams.entry.childSessionKey,
      reason: "completed",
      agentDir: cleanupParams.entry.agentDir,
      workspaceDir: cleanupParams.entry.workspaceDir,
    });
    cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
    params.persist();
    retryDeferredCompletedAnnounces(cleanupParams.runId);
  };

  const retireRunModeBundleMcpRuntime = async (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: string;
  }) => {
    if (cleanupParams.entry.spawnMode === "session") {
      return;
    }
    await retireSessionMcpRuntimeForSessionKey({
      sessionKey: cleanupParams.entry.childSessionKey,
      reason: cleanupParams.reason,
      onError: (error, sessionId) => {
        params.warn("failed to retire subagent bundle MCP runtime", {
          error: buildSafeLifecycleErrorMeta(error),
          sessionId,
          runId: maskRunId(cleanupParams.runId),
          childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey),
        });
      },
    });
  };

  const finalizeSubagentCleanup = async (
    runId: string,
    cleanup: "delete" | "keep",
    didAnnounce: boolean,
    options?: {
      skipAnnounce?: boolean;
      skipDeliveryStatus?: boolean;
    },
  ) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return;
    }
    if (entry.expectsCompletionMessage === false) {
      clearPendingFinalDelivery(entry);
      entry.wakeOnDescendantSettle = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
      return;
    }
    if (didAnnounce) {
      const delivery = ensureDeliveryState(entry);
      const shouldCreditDelivery =
        !options?.skipAnnounce ||
        delivery.status === "delivered" ||
        typeof delivery.announcedAt === "number";
      if (shouldCreditDelivery) {
        const deliveredAt = delivery.deliveredAt ?? delivery.announcedAt ?? Date.now();
        delivery.status = "delivered";
        delivery.deliveredAt = deliveredAt;
        delivery.announcedAt = delivery.announcedAt ?? deliveredAt;
        if (!options?.skipAnnounce) {
          delivery.announcedAt = deliveredAt;
          params.persist();
        }
      }
      clearPendingFinalDelivery(entry);
      const finalDelivery = ensureDeliveryState(entry);
      if (shouldCreditDelivery) {
        finalDelivery.status = "delivered";
        finalDelivery.suspendedAt = undefined;
        finalDelivery.suspendedReason = undefined;
      }
      if (shouldCreditDelivery && !options?.skipDeliveryStatus) {
        safeSetSubagentTaskDeliveryStatus({
          runId,
          childSessionKey: entry.childSessionKey,
          deliveryStatus: "delivered",
        });
      }
      finalDelivery.lastError = undefined;
      finalDelivery.lastDropReason = undefined;
      entry.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(entry);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
      const completionReason = resolveCleanupCompletionReason(entry);
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (cleanup === "delete") {
        completion.resultText = undefined;
        completion.capturedAt = undefined;
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
      return;
    }

    const now = Date.now();
    const deferredDecision = resolveDeferredCleanupDecision({
      entry,
      now,
      activeDescendantRuns: Math.max(0, params.countPendingDescendantRuns(entry.childSessionKey)),
      announceExpiryMs: ANNOUNCE_EXPIRY_MS,
      announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
      maxAnnounceRetryCount: MAX_ANNOUNCE_RETRY_COUNT,
      deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
      resolveAnnounceRetryDelayMs,
    });

    if (deferredDecision.kind === "defer-descendants") {
      ensureDeliveryState(entry).lastAttemptAt = now;
      entry.wakeOnDescendantSettle = true;
      entry.cleanupHandled = false;
      params.resumedRuns.delete(runId);
      params.persist();
      scheduleResumeSubagentRun(runId, entry, deferredDecision.delayMs);
      return;
    }

    if (deferredDecision.kind === "give-up") {
      if (shouldSuspendPendingFinalDelivery(entry)) {
        suspendPendingFinalDelivery({
          runId,
          entry,
          reason: deferredDecision.reason,
          error: getDeliveryLastError(entry),
        });
        return;
      }
      const deliveryError = getDeliveryLastError(entry) ?? deferredDecision.reason;
      clearPendingFinalDelivery(entry);
      const failedDelivery = ensureDeliveryState(entry);
      failedDelivery.status = "failed";
      failedDelivery.lastError = deliveryError;
      if (deferredDecision.retryCount != null) {
        failedDelivery.attemptCount = deferredDecision.retryCount;
        failedDelivery.lastAttemptAt = now;
      }
      safeSetSubagentTaskDeliveryStatus({
        runId,
        childSessionKey: entry.childSessionKey,
        deliveryStatus: "failed",
        deliveryError,
      });
      safeMarkRequiredCompletionDeliveryBlocked({
        entry,
        reason: deliveryError,
      });
      entry.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(entry);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      const completionReason = resolveCleanupCompletionReason(entry);
      logAnnounceGiveUp(entry, deferredDecision.reason);
      // Giving up on announce delivery is terminal for cleanup even if the
      // best-effort hook is still resolving.
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: now,
      });
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
      return;
    }

    markPendingFinalDelivery({
      entry,
      error: didAnnounce ? undefined : "announce deferred or direct delivery failed",
    });
    entry.cleanupHandled = false;
    params.resumedRuns.delete(runId);
    params.persist();
    if (deferredDecision.resumeDelayMs == null) {
      return;
    }
    scheduleResumeSubagentRun(runId, entry, deferredDecision.resumeDelayMs);
  };

  const startSubagentAnnounceCleanupFlow = (runId: string, entry: SubagentRunRecord): boolean => {
    if (typeof entry.delivery?.announcedAt === "number" || entry.delivery?.status === "delivered") {
      if (!beginSubagentCleanup(runId)) {
        return false;
      }
      void finalizeSubagentCleanup(runId, entry.cleanup, true, {
        skipAnnounce: true,
      }).catch((err: unknown) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
      return true;
    }
    if (!beginSubagentCleanup(runId)) {
      return false;
    }
    if (entry.expectsCompletionMessage === false) {
      void (async () => {
        if (entry.cleanup === "delete") {
          await deleteSubagentSessionForCleanup({
            callGateway: params.callGateway,
            childSessionKey: entry.childSessionKey,
            spawnMode: entry.spawnMode,
            onError: (error) =>
              params.warn("sessions.delete failed during subagent cleanup", {
                error: buildSafeLifecycleErrorMeta(error),
                runId: maskRunId(runId),
                childSessionKey: maskSessionKey(entry.childSessionKey),
              }),
          });
        }
        await finalizeSubagentCleanup(runId, entry.cleanup, true, {
          skipAnnounce: true,
          skipDeliveryStatus: true,
        });
      })().catch((err: unknown) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
      return true;
    }
    const pendingPayload = loadPendingFinalDeliveryPayload(entry);
    const requesterOrigin = normalizeDeliveryContext(pendingPayload.requesterOrigin);
    let latestDeliveryError = getDeliveryLastError(entry);
    const finalizeAnnounceCleanup = async (didAnnounce: boolean) => {
      const shouldCreditPriorDelivery =
        !didAnnounce && (await hasPriorRequesterDeliveryMirror(entry));
      if (shouldCreditPriorDelivery) {
        latestDeliveryError = undefined;
      }
      if (!didAnnounce && latestDeliveryError) {
        ensureDeliveryState(entry).lastError = latestDeliveryError;
      }
      void finalizeSubagentCleanup(
        runId,
        entry.cleanup,
        didAnnounce || shouldCreditPriorDelivery,
      ).catch((err: unknown) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
    };

    void params
      .runSubagentAnnounceFlow({
        childSessionKey: pendingPayload.childSessionKey,
        childRunId: pendingPayload.childRunId,
        requesterSessionKey: pendingPayload.requesterSessionKey,
        requesterOrigin,
        requesterDisplayKey: pendingPayload.requesterDisplayKey,
        task: pendingPayload.task,
        timeoutMs: params.subagentAnnounceTimeoutMs,
        cleanup: entry.cleanup,
        roundOneReply: pendingPayload.frozenResultText ?? undefined,
        fallbackReply: pendingPayload.fallbackFrozenResultText ?? undefined,
        waitForCompletion: false,
        startedAt: pendingPayload.startedAt,
        endedAt: pendingPayload.endedAt,
        label: pendingPayload.label,
        outcome: pendingPayload.outcome,
        spawnMode: pendingPayload.spawnMode,
        expectsCompletionMessage: pendingPayload.expectsCompletionMessage,
        wakeOnDescendantSettle: pendingPayload.wakeOnDescendantSettle === true,
        onGrantCloseoutGateResult: async (result) => {
          await persistGrantCloseoutGateAudit({
            entry,
            result,
          });
        },
        onDeliveryResult: (delivery) => {
          recordAnnounceDeliveryResult(entry, delivery);
          if (delivery.delivered) {
            const deliveryState = ensureDeliveryState(entry);
            if (deliveryState.lastError !== undefined) {
              deliveryState.lastError = undefined;
              params.persist();
            }
            latestDeliveryError = undefined;
            return;
          }
          if (delivery.path === "none") {
            ensureDeliveryState(entry).lastDropReason = "sink_unavailable";
          }
          latestDeliveryError = formatAnnounceDeliveryError(delivery);
          if (ensureDeliveryState(entry).lastError !== latestDeliveryError) {
            ensureDeliveryState(entry).lastError = latestDeliveryError;
            params.persist();
          }
        },
      })
      .then((didAnnounce) => {
        void finalizeAnnounceCleanup(didAnnounce);
      })
      .catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
        );
        void finalizeAnnounceCleanup(false);
      });
    return true;
  };

  const completeSubagentRun = async (completeParams: {
    runId: string;
    endedAt?: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    triggerCleanup: boolean;
    startedAt?: number;
  }) => {
    params.clearPendingLifecycleError(completeParams.runId);
    const entry = params.runs.get(completeParams.runId);
    if (!entry) {
      return;
    }

    let mutated = false;
    if (
      completeParams.reason === SUBAGENT_ENDED_REASON_COMPLETE &&
      entry.suppressAnnounceReason === "killed" &&
      (entry.cleanupHandled || typeof entry.cleanupCompletedAt === "number")
    ) {
      entry.suppressAnnounceReason = undefined;
      entry.cleanupHandled = false;
      entry.cleanupCompletedAt = undefined;
      ensureDeliveryState(entry).announcedAt = undefined;
      mutated = true;
    }

    let endedAt = typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
    let completionOutcome = completeParams.outcome;
    let completionReason = completeParams.reason;
    if (
      shouldPreservePublishedExplicitRunTimeout({
        entry,
      })
    ) {
      return;
    }

    const observedStartedAt =
      typeof completeParams.startedAt === "number" && Number.isFinite(completeParams.startedAt)
        ? completeParams.startedAt
        : undefined;
    if (observedStartedAt !== undefined && entry.startedAt !== observedStartedAt) {
      entry.startedAt = observedStartedAt;
      if (typeof entry.sessionStartedAt !== "number") {
        entry.sessionStartedAt = observedStartedAt;
      }
      mutated = true;
    }

    const expiredDeadlineMs = resolveExpiredExplicitRunDeadlineMs({
      entry,
      nextOutcome: completionOutcome,
      nextEndedAt: endedAt,
      observedStartedAt,
    });
    if (expiredDeadlineMs !== undefined) {
      endedAt = expiredDeadlineMs;
      completionOutcome = { status: "timeout" };
      completionReason = SUBAGENT_ENDED_REASON_COMPLETE;
    }
    if (entry.endedAt !== endedAt) {
      entry.endedAt = endedAt;
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        startedAt: entry.startedAt,
        endedAt,
      };
      mutated = true;
    }
    const outcome = withSubagentOutcomeTiming(completionOutcome, {
      startedAt: entry.startedAt,
      endedAt,
    });
    if (shouldUpdateRunOutcome(entry.outcome, outcome)) {
      entry.outcome = outcome;
      mutated = true;
    }
    if (
      entry.execution?.status !== "terminal" ||
      entry.execution.endedAt !== endedAt ||
      entry.execution.outcome !== outcome
    ) {
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        startedAt: entry.startedAt,
        endedAt,
        outcome,
      };
      mutated = true;
    }
    if (entry.endedReason !== completionReason) {
      entry.endedReason = completionReason;
      mutated = true;
    }
    if (entry.pauseReason !== undefined) {
      entry.pauseReason = undefined;
      mutated = true;
    }

    if (await freezeRunResultAtCompletion(entry, outcome)) {
      mutated = true;
    }
    if (refreshPendingFinalDeliveryPayload(entry)) {
      mutated = true;
    }

    if (mutated) {
      params.persist();
    }
    safeFinalizeSubagentTaskRun({
      entry,
      outcome,
    });

    try {
      await persistSubagentSessionTiming(entry);
    } catch (err) {
      params.warn("failed to persist subagent session timing", {
        err,
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
      });
    }

    const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
    if (mutated && !suppressedForSteerRestart) {
      emitSessionLifecycleEvent({
        sessionKey: entry.childSessionKey,
        reason: "subagent-status",
        parentSessionKey: entry.requesterSessionKey,
        label: entry.label,
      });
    }
    const shouldEmitEndedHook =
      !suppressedForSteerRestart &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason: completionReason,
      });
    const shouldDeferEndedHook =
      shouldEmitEndedHook &&
      completeParams.triggerCleanup &&
      entry.expectsCompletionMessage === true &&
      !suppressedForSteerRestart;
    if (!shouldDeferEndedHook && shouldEmitEndedHook) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason: completionReason,
        sendFarewell: completeParams.sendFarewell,
        accountId: completeParams.accountId,
      });
    }

    if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
      return;
    }

    // registerSubagentRun fires both an in-process listener and a gateway
    // waitForSubagentCompletion RPC; both can reach this point for the same
    // runId in embedded mode. Dedupe only the browser driver tab-close IPC
    // with a sync check-then-set. The retire + announce tail below must still
    // run for every caller, so a slow or held first browser cleanup cannot
    // strand a duplicate caller's completion behind it.
    if (entry.browserCleanupDispatchedAt === undefined) {
      entry.browserCleanupDispatchedAt = Date.now();
      try {
        const cleanupBrowserSessions =
          params.cleanupBrowserSessionsForLifecycleEnd ??
          (await loadCleanupBrowserSessionsForLifecycleEnd());
        await cleanupBrowserSessions({
          sessionKeys: [entry.childSessionKey],
          onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
        });
      } catch (error) {
        params.warn("failed to cleanup browser sessions for completed subagent", {
          error: buildSafeLifecycleErrorMeta(error),
          runId: maskRunId(completeParams.runId),
          childSessionKey: maskSessionKey(entry.childSessionKey),
        });
      }
    }

    try {
      await retireRunModeBundleMcpRuntime({
        runId: completeParams.runId,
        entry,
        reason: "subagent-run-complete",
      });
    } catch (error) {
      params.warn("failed to retire subagent bundle MCP runtime after completion", {
        error: buildSafeLifecycleErrorMeta(error),
        runId: maskRunId(completeParams.runId),
        childSessionKey: maskSessionKey(entry.childSessionKey),
      });
    }

    startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
  };

  return {
    clearScheduledResumeTimers,
    completeCleanupBookkeeping,
    completeSubagentRun,
    finalizeResumedAnnounceGiveUp,
    refreshFrozenResultFromSession,
    startSubagentAnnounceCleanupFlow,
    testing: {
      persistGrantCloseoutGateAudit,
    },
  };
}
