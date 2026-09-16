import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { markReplyPayloadAsProgressHeartbeat } from "../auto-reply/reply-payload.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import type { OriginatingChannelType } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolveContextEngineOptions } from "../context-engine/registry.js";
import type { ContextEngine, SubagentEndReason } from "../context-engine/types.js";
import { callGateway } from "../gateway/call.js";
import { getAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  peekSystemEventEntries,
  type ParentYieldWaitRef,
} from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatBlockedLivenessError, isBlockedLivenessState } from "../shared/agent-liveness.js";
import { normalizeAssistantPhase } from "../shared/chat-message-content.js";
import { createLazyImportLoader, createLazyPromiseLoader } from "../shared/lazy-promise.js";
import { importRuntimeModule } from "../shared/runtime-import.js";
import { sanitizeTaskStatusText } from "../tasks/task-status.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  ackLeasedAgentSteeringItemsFromSubagentRuns,
  leasePendingAgentSteeringItemsFromSubagentRuns,
  prependAgentSteeringPrompt,
  releaseLeasedAgentSteeringItemsFromSubagentRuns,
} from "./agent-steering-queue.js";
import { removeInternalSessionEffectsTranscript } from "./internal-session-effects.js";
import { isAbortedAgentStopReason } from "./run-termination.js";
import { waitForAgentRun, type AgentWaitResult } from "./run-wait.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import {
  loadSourceTurnDeliveryRegistry,
  persistSourceTurnDeliveryState,
  resolveSourceTurnDeliveryRegistryPath,
  type SourceTurnDeliveryRow,
} from "./source-turn-delivery-store.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryAttemptCount,
  getDeliveryLastAttemptAt,
  getDeliveryLastError,
  isDeliverySuspended,
  isParentYieldCloseoutPending,
  shouldRetainParentYieldCloseout,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  resolveLifecycleOutcomeFromRunOutcome,
} from "./subagent-registry-completion.js";
import {
  ANNOUNCE_EXPIRY_MS,
  MAX_ANNOUNCE_RETRY_COUNT,
  reconcileOrphanedRestoredRuns,
  reconcileOrphanedRun,
  resolveAnnounceRetryDelayMs,
  resolveSubagentRunOrphanReason,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsExcludingRunFromRuns,
  countPendingDescendantRunsFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  isSubagentSessionRunActiveFromRuns,
  listRunsForControllerFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import {
  createSubagentRunManager,
  markSubagentRunPausedAfterYield,
  type RegisterSubagentRunParams,
} from "./subagent-registry-run-manager.js";
import {
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import { configureSubagentRegistrySteerRuntime } from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type { SubagentRunRecord } from "./subagent-registry.types.js";
export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-registry-helpers.js";
const log = createSubsystemLogger("agents/subagent-registry");
const PARENT_YIELD_WAIT_STALE_MS = 15 * 60 * 1000;

type SubagentAnnounceModule = Pick<
  typeof import("./subagent-announce.js"),
  "captureSubagentCompletionReply" | "runSubagentAnnounceFlow"
>;
type BrowserCleanupModule = Pick<
  typeof import("../browser-lifecycle-cleanup.js"),
  "cleanupBrowserSessionsForLifecycleEnd"
>;

type SubagentRegistryDeps = {
  callGateway: typeof callGateway;
  captureSubagentCompletionReply: SubagentAnnounceModule["captureSubagentCompletionReply"];
  cleanupBrowserSessionsForLifecycleEnd: typeof cleanupBrowserSessionsForLifecycleEnd;
  getSubagentRunsSnapshotForRead: typeof getSubagentRunsSnapshotForRead;
  getRuntimeConfig: typeof getRuntimeConfig;
  onAgentEvent: typeof onAgentEvent;
  persistSubagentRunsToDisk: typeof persistSubagentRunsToDisk;
  persistSubagentRunsToDiskOrThrow: typeof persistSubagentRunsToDiskOrThrow;
  resolveAgentTimeoutMs: typeof resolveAgentTimeoutMs;
  restoreSubagentRunsFromDisk: typeof restoreSubagentRunsFromDisk;
  runSubagentAnnounceFlow: SubagentAnnounceModule["runSubagentAnnounceFlow"];
  ensureContextEnginesInitialized?: () => void;
  ensureRuntimePluginsLoaded?: typeof ensureRuntimePluginsLoadedFn;
  resolveContextEngine?: (
    cfg?: OpenClawConfig,
    options?: ResolveContextEngineOptions,
  ) => Promise<ContextEngine>;
};

const subagentAnnounceLoader = createLazyImportLoader<SubagentAnnounceModule>(
  () => import("./subagent-announce.js"),
);
const browserCleanupLoader = createLazyImportLoader<BrowserCleanupModule>(
  () => import("../browser-lifecycle-cleanup.js"),
);

async function loadSubagentAnnounceModule(): Promise<SubagentAnnounceModule> {
  return await subagentAnnounceLoader.load();
}

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
  BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"]
> {
  return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}

const defaultSubagentRegistryDeps: SubagentRegistryDeps = {
  callGateway,
  captureSubagentCompletionReply: async (sessionKey, options) =>
    (await loadSubagentAnnounceModule()).captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: async (params) =>
    (await loadCleanupBrowserSessionsForLifecycleEnd())(params),
  getSubagentRunsSnapshotForRead,
  getRuntimeConfig,
  onAgentEvent,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  resolveAgentTimeoutMs,
  restoreSubagentRunsFromDisk,
  runSubagentAnnounceFlow: async (params) =>
    (await loadSubagentAnnounceModule()).runSubagentAnnounceFlow(params),
};

let subagentRegistryDeps: SubagentRegistryDeps = defaultSubagentRegistryDeps;
type ContextEngineInitModule = Pick<
  {
    ensureContextEnginesInitialized: () => void;
  },
  "ensureContextEnginesInitialized"
>;
type ContextEngineRegistryModule = Pick<
  {
    resolveContextEngine: (
      cfg?: OpenClawConfig,
      options?: ResolveContextEngineOptions,
    ) => Promise<ContextEngine>;
  },
  "resolveContextEngine"
>;
type RuntimePluginsModule = Pick<
  {
    ensureRuntimePluginsLoaded: typeof ensureRuntimePluginsLoadedFn;
  },
  "ensureRuntimePluginsLoaded"
>;

const SUBAGENT_REGISTRY_RUNTIME_SPEC = ["./subagent-registry.runtime", ".js"] as const;

const contextEngineInitLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<ContextEngineInitModule>(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC),
);
const contextEngineRegistryLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<ContextEngineRegistryModule>(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC),
);
const runtimePluginsLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<RuntimePluginsModule>(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC),
);

let sweeper: NodeJS.Timeout | null = null;
const resumeRetryTimers = new Set<ReturnType<typeof setTimeout>>();
// Only the control caller owns an admitted steer until its handoff finishes.
// A warm Gateway restart must not abandon that still-running transaction.
const activeSteerRestarts = new Set<string>();
let sweepInProgress = false;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
let restoreAttempted = false;
let parentYieldWaitRecovery: Promise<void> | undefined;
const ORPHAN_RECOVERY_DEBOUNCE_MS = 1_000;
let lastOrphanRecoveryScheduleAt = 0;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
/**
 * Embedded runs can emit transient lifecycle `error` events while provider/model
 * retry is still in progress. Defer terminal error cleanup briefly so a
 * subsequent lifecycle `start` / `end` can cancel premature failure announces.
 */
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;
/**
 * Embedded runs can also surface an intermediate lifecycle `end` with
 * `aborted=true` just before the runtime automatically retries the same run.
 * Give that timeout a short grace window so the parent does not get a stale
 * `timed out` completion right before the eventual success.
 */
const LIFECYCLE_TIMEOUT_RETRY_GRACE_MS = 15_000;
/** Absolute TTL for session-mode runs after cleanup completes (no archiveAtMs). */
const SESSION_RUN_TTL_MS = 5 * 60_000; // 5 minutes
/** Absolute TTL for orphaned pendingLifecycleError / pendingLifecycleTimeout entries. */
const PENDING_LIFECYCLE_TERMINAL_TTL_MS = 5 * 60_000; // 5 minutes
const SUBAGENT_PROGRESS_STALL_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 5_000 : 3 * 60_000;
const SUBAGENT_PROGRESS_EMIT_MIN_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 250 : 15_000;
const SUBAGENT_FAILURE_STREAK_WINDOW_MS = 6 * 60 * 60_000;
/** Grace period before treating a "running" subagent without a live run context as stale. */
const STALE_ACTIVE_SUBAGENT_GRACE_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 1_000 : 60_000;
const SUSPENDED_DELIVERY_CRON_EXPIRY_MS = 2 * 60 * 60_000;
const SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS = 6 * 60 * 60_000;
const SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS = 24 * 60 * 60_000;
const SUSPENDED_DELIVERY_SOFT_CAP = 25;
const SUSPENDED_DELIVERY_HARD_CAP = 50;
const SUSPENDED_DELIVERY_PRESSURE_TARGET = 10;
const REMOTE_AGENT_LIVENESS_PROBE_TIMEOUT_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 25 : 250;

function loadContextEngineInitModule(): Promise<ContextEngineInitModule> {
  return contextEngineInitLoader.load();
}

function loadContextEngineRegistryModule(): Promise<ContextEngineRegistryModule> {
  return contextEngineRegistryLoader.load();
}

function loadRuntimePluginsModule(): Promise<RuntimePluginsModule> {
  return runtimePluginsLoader.load();
}

async function ensureSubagentRegistryPluginRuntimeLoaded(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  allowGatewaySubagentBinding?: boolean;
}) {
  const ensureRuntimePluginsLoaded = subagentRegistryDeps.ensureRuntimePluginsLoaded;
  if (ensureRuntimePluginsLoaded) {
    ensureRuntimePluginsLoaded(params);
    return;
  }
  (await loadRuntimePluginsModule()).ensureRuntimePluginsLoaded(params);
}

async function resolveSubagentRegistryContextEngine(
  cfg: OpenClawConfig,
  options?: ResolveContextEngineOptions,
) {
  const initModule = await loadContextEngineInitModule();
  const registryModule = await loadContextEngineRegistryModule();
  const ensureContextEnginesInitialized =
    subagentRegistryDeps.ensureContextEnginesInitialized ??
    initModule.ensureContextEnginesInitialized;
  const resolveContextEngine =
    subagentRegistryDeps.resolveContextEngine ?? registryModule.resolveContextEngine;
  ensureContextEnginesInitialized();
  return await resolveContextEngine(cfg, options);
}

function persistSubagentRuns() {
  subagentRegistryDeps.persistSubagentRunsToDisk(subagentRuns);
}

function persistSubagentRunsOrThrow(runs = subagentRuns) {
  subagentRegistryDeps.persistSubagentRunsToDiskOrThrow(runs);
}

export function scheduleSubagentOrphanRecovery(params?: { delayMs?: number; maxRetries?: number }) {
  const now = Date.now();
  if (now - lastOrphanRecoveryScheduleAt < ORPHAN_RECOVERY_DEBOUNCE_MS) {
    return;
  }
  lastOrphanRecoveryScheduleAt = now;
  void import("./subagent-orphan-recovery.js").then(
    ({ scheduleOrphanRecovery }) => {
      scheduleOrphanRecovery({
        getActiveRuns: () => subagentRuns,
        delayMs: params?.delayMs,
        maxRetries: params?.maxRetries,
      });
    },
    () => {
      // Ignore import failures — orphan recovery is best-effort.
    },
  );
}

const resumedRuns = new Set<string>();
const endedHookInFlightRunIds = new Set<string>();
const pendingLifecycleErrorByRunId = new Map<
  string,
  {
    timer: NodeJS.Timeout;
    endedAt: number;
    startedAt?: number;
    error?: string;
  }
>();
const pendingLifecycleTimeoutByRunId = new Map<
  string,
  {
    timer: NodeJS.Timeout;
    endedAt: number;
    startedAt?: number;
  }
>();
type SubagentProgressRelayState = {
  lastActivityAt: number;
  lastSummary?: string;
  lastSummaryAt?: number;
  stallNoticeCount: number;
  terminalFailureNotified?: boolean;
};
const subagentProgressRelayByRunId = new Map<string, SubagentProgressRelayState>();
const subagentFailureStreakByKey = new Map<string, { count: number; lastFailedAt: number }>();

function clearPendingLifecycleError(runId: string) {
  const pending = pendingLifecycleErrorByRunId.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingLifecycleErrorByRunId.delete(runId);
}

function clearAllPendingLifecycleErrors() {
  for (const pending of pendingLifecycleErrorByRunId.values()) {
    clearTimeout(pending.timer);
  }
  pendingLifecycleErrorByRunId.clear();
}

function clearPendingLifecycleTimeout(runId: string) {
  const pending = pendingLifecycleTimeoutByRunId.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingLifecycleTimeoutByRunId.delete(runId);
}

function clearAllPendingLifecycleTimeouts() {
  for (const pending of pendingLifecycleTimeoutByRunId.values()) {
    clearTimeout(pending.timer);
  }
  pendingLifecycleTimeoutByRunId.clear();
}

function resolveSubagentRelayLabel(entry: SubagentRunRecord): string {
  return (
    sanitizeTaskStatusText(entry.label ?? entry.task, { maxChars: 80 }) ||
    sanitizeTaskStatusText(entry.task, { maxChars: 80 }) ||
    "Subagent"
  );
}

function ensureSubagentProgressRelayState(entry: SubagentRunRecord): SubagentProgressRelayState {
  let state = subagentProgressRelayByRunId.get(entry.runId);
  if (!state) {
    state = {
      lastActivityAt: entry.startedAt ?? entry.createdAt ?? Date.now(),
      stallNoticeCount: 0,
    };
    subagentProgressRelayByRunId.set(entry.runId, state);
  }
  return state;
}

function emitSubagentRequesterSystemEvent(
  entry: SubagentRunRecord,
  text: string,
  contextSuffix: string,
  parentYieldWait?: ParentYieldWaitRef,
): void {
  const sessionKey = normalizeOptionalString(
    parentYieldWait ? entry.parentYieldWait?.parentSessionKey : entry.requesterSessionKey,
  );
  const trimmed = text.trim();
  if (!sessionKey || !trimmed) {
    return;
  }
  const contextKey = parentYieldWait
    ? `subagent:parent-yield:${parentYieldWait.parentRunId}:${parentYieldWait.waitId}`
    : `subagent:${entry.runId}:${contextSuffix}`;
  const fallback = () => {
    enqueueSystemEvent(trimmed, {
      sessionKey,
      contextKey,
      deliveryContext: entry.requesterOrigin,
      ...(parentYieldWait ? { parentYieldWait } : {}),
    });
    requestHeartbeat({
      source: "subagent-progress",
      intent: "event",
      reason: "subagent:progress",
      sessionKey,
    });
  };
  // Continuation is work for the parent, even when a direct status route exists.
  // Keep the typed wait identity on the wake event until its final delivery.
  if (parentYieldWait) {
    fallback();
    return;
  }
  const directOrigin = resolveRoutableDeliveryContext(entry.requesterOrigin);
  if (!directOrigin) {
    fallback();
    return;
  }
  const payload: ReplyPayload = {
    text: trimmed,
    isStatusNotice: true,
  };
  const isActiveRunNotice =
    contextSuffix === "start" || contextSuffix === "progress" || contextSuffix.startsWith("stall");
  const routedPayload = isActiveRunNotice
    ? markReplyPayloadAsProgressHeartbeat(payload, {
        category: "working",
        activeRunContinues: true,
      })
    : payload;
  void routeReply({
    payload: routedPayload,
    channel: directOrigin.channel,
    to: directOrigin.to,
    accountId: directOrigin.accountId,
    threadId: directOrigin.threadId,
    cfg: subagentRegistryDeps.getRuntimeConfig(),
    sessionKey,
    policySessionKey: sessionKey,
    replyKind: "block",
  })
    .then((result) => {
      if (!result.ok) {
        fallback();
      }
    })
    .catch(() => {
      fallback();
    });
}

function emitParentYieldNoPendingChildrenEvent(params: {
  controllerSessionKey: string;
  parentRunId?: string;
  reason?: string;
  now: number;
}): void {
  const sessionKey = normalizeOptionalString(params.controllerSessionKey);
  if (!sessionKey) {
    return;
  }
  const trimmedReason = normalizeOptionalString(params.reason);
  const message = [
    "Subagent wait ready to resume:",
    trimmedReason || "parent called sessions_yield, but no pending child runs were found.",
    "No pending child completion can wake this wait.",
    "Resume the parent task now and produce the required user-facing closeout; do not reply NO_REPLY.",
  ].join(" ");
  enqueueSystemEvent(message, {
    sessionKey,
    contextKey: `subagent:yield-wait-empty:${params.parentRunId ?? "run"}:${params.now}`,
  });
  requestHeartbeat({
    source: "subagent-progress",
    intent: "event",
    reason: "subagent:yield-wait-empty",
    sessionKey,
  });
}

function isRunTerminalForParentYieldWait(entry: SubagentRunRecord): boolean {
  return (
    typeof entry.endedAt === "number" &&
    entry.pauseReason !== "sessions_yield" &&
    entry.suppressAnnounceReason !== "steer-restart" &&
    entry.outcome !== undefined
  );
}

function collectParentYieldWaitMembers(waitId: string): SubagentRunRecord[] {
  const trimmed = waitId.trim();
  if (!trimmed) {
    return [];
  }
  return Array.from(subagentRuns.values()).filter(
    (entry) => entry.parentYieldWait?.waitId === trimmed,
  );
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).toSorted();
}

function commitParentYieldWaitUpdates(
  updates: Map<string, NonNullable<SubagentRunRecord["parentYieldWait"]>>,
): void {
  if (updates.size === 0) {
    return;
  }
  const nextRuns = new Map(subagentRuns);
  for (const [runId, wait] of updates) {
    const entry = subagentRuns.get(runId);
    if (entry) {
      nextRuns.set(runId, { ...entry, parentYieldWait: wait });
    }
  }
  // A wake may start source delivery immediately. Its exact wait must survive
  // restart before any event or heartbeat can publish that obligation.
  persistSubagentRunsOrThrow(nextRuns);
  for (const [runId, wait] of updates) {
    const entry = subagentRuns.get(runId);
    if (entry) {
      entry.parentYieldWait = wait;
    }
  }
}

function updateParentYieldWaitFanIn(
  waitId: string,
  sourceEntry: SubagentRunRecord,
  now = Date.now(),
  replayScheduled = false,
): void {
  const members = collectParentYieldWaitMembers(waitId).filter(
    (entry) =>
      entry.parentYieldWait?.parentRunId === sourceEntry.parentYieldWait?.parentRunId &&
      entry.parentYieldWait?.parentSessionKey === sourceEntry.parentYieldWait?.parentSessionKey,
  );
  const representative = members.find((entry) => entry.runId === sourceEntry.runId) ?? members[0];
  const wait = representative?.parentYieldWait;
  if (!representative || !wait) {
    return;
  }
  const expected = wait.expectedChildRunIds;
  const expectedSet = new Set(expected);
  const terminalChildRunIds = uniqueSorted(
    members
      .filter((entry) => expectedSet.has(entry.runId) && isRunTerminalForParentYieldWait(entry))
      .map((entry) => entry.runId),
  );
  const allTerminal = expected.length > 0 && terminalChildRunIds.length === expectedSet.size;
  const scheduleContinuation =
    allTerminal &&
    wait.status !== "closeout_delivered" &&
    wait.continuation?.phase !== "yield_requested" &&
    (wait.continuationScheduledAt === undefined || replayScheduled);
  const updates = new Map<string, NonNullable<SubagentRunRecord["parentYieldWait"]>>();
  for (const entry of members) {
    const current = entry.parentYieldWait;
    if (!current || current.status === "closeout_delivered") {
      continue;
    }
    const newlyScheduled = scheduleContinuation && current.continuationScheduledAt === undefined;
    const nextStatus = newlyScheduled
      ? "continuation_scheduled"
      : allTerminal && current.status === "waiting"
        ? "ready_to_resume"
        : current.status;
    if (
      current.status !== nextStatus ||
      JSON.stringify(current.terminalChildRunIds ?? []) !== JSON.stringify(terminalChildRunIds)
    ) {
      updates.set(entry.runId, {
        ...current,
        status: nextStatus,
        terminalChildRunIds,
        ...(newlyScheduled ? { continuationScheduledAt: now } : {}),
        lastUpdatedAt: now,
      });
    }
  }
  commitParentYieldWaitUpdates(updates);
  if (!scheduleContinuation) {
    return;
  }
  emitSubagentRequesterSystemEvent(
    representative,
    [
      "Subagent wait ready to resume:",
      wait.reason || "parent yielded waiting for child completions.",
      `All expected child runs are terminal (${wait.expectedChildRunIds.join(", ")}).`,
      "Resume the parent task now and produce the required user-facing closeout; do not reply NO_REPLY.",
    ].join(" "),
    `yield-wait-ready:${wait.waitId}`,
    wait.parentRunId ? { waitId: wait.waitId, parentRunId: wait.parentRunId } : undefined,
  );
}

type ParentYieldWaitDeliveryIdentity = {
  controllerSessionKey: string;
  waitId: string;
  parentRunId: string;
};

function consumeParentYieldWaitEvents(identity: ParentYieldWaitDeliveryIdentity): void {
  consumeSelectedSystemEventEntries(
    identity.controllerSessionKey,
    peekSystemEventEntries(identity.controllerSessionKey).filter(
      (event) =>
        event.parentYieldWait?.waitId === identity.waitId &&
        event.parentYieldWait.parentRunId === identity.parentRunId,
    ),
  );
}

function readParentYieldWaitMembers(identity: ParentYieldWaitDeliveryIdentity) {
  const snapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
  const members = [...snapshot.values()].filter(
    (entry) =>
      entry.parentYieldWait?.waitId === identity.waitId &&
      entry.parentYieldWait.parentRunId === identity.parentRunId &&
      entry.parentYieldWait.parentSessionKey === identity.controllerSessionKey,
  );
  const wait = members[0]?.parentYieldWait;
  if (
    !wait?.requiredCloseout ||
    wait.expectedChildRunIds.length === 0 ||
    members.length !== new Set(wait.expectedChildRunIds).size ||
    !wait.expectedChildRunIds.every((runId) => members.some((entry) => entry.runId === runId)) ||
    !members.every((entry) => isDeepStrictEqual(entry.parentYieldWait, wait))
  ) {
    return undefined;
  }
  return { members, wait };
}

export function getParentYieldWaitContinuation(
  identity: ParentYieldWaitDeliveryIdentity,
): { status: "ready" | "waiting"; yieldedRunIds: string[] } | undefined {
  const state = readParentYieldWaitMembers(identity);
  if (!state || state.wait.status === "closeout_delivered") {
    return undefined;
  }
  return {
    status:
      state.wait.status === "continuation_scheduled" &&
      state.wait.continuation?.phase !== "yield_requested" &&
      state.members.every(isRunTerminalForParentYieldWait)
        ? "ready"
        : "waiting",
    yieldedRunIds: (state.wait.yieldedContinuations ?? []).map((entry) => entry.runId),
  };
}

/** Claim the exact execution before dispatch can create its accepted source row. */
export function prepareParentYieldWaitContinuation(
  identity: ParentYieldWaitDeliveryIdentity & { runId: string },
): string {
  const state = readParentYieldWaitMembers(identity);
  if (
    !state ||
    state.wait.status !== "continuation_scheduled" ||
    state.wait.continuation?.phase === "yield_requested" ||
    !state.members.every(isRunTerminalForParentYieldWait)
  ) {
    throw new Error("Parent continuation is still waiting for its owned work");
  }
  // A pre-dispatch interruption can leave the claim without an accepted row.
  // Reuse that exact identity; an existing accepted row is checked by heartbeat first.
  const runId = state.wait.continuation?.runId ?? identity.runId;
  const next = { ...state.wait, continuation: { runId, phase: "running" as const } };
  commitParentYieldWaitUpdates(new Map(state.members.map((entry) => [entry.runId, next])));
  return runId;
}

/** Called only by the common run owner after the backend returns a confirmed yield. */
export function completeParentYieldWaitContinuationYield(params: {
  controllerSessionKey: string;
  runId: string;
}): void {
  const snapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
  const requested = [...snapshot.values()].find(
    (entry) =>
      entry.parentYieldWait?.parentSessionKey === params.controllerSessionKey &&
      entry.parentYieldWait.continuation?.runId === params.runId &&
      entry.parentYieldWait.continuation.phase === "yield_requested",
  )?.parentYieldWait;
  if (!requested?.parentRunId) {
    return;
  }
  const identity = {
    controllerSessionKey: params.controllerSessionKey,
    waitId: requested.waitId,
    parentRunId: requested.parentRunId,
  };
  const state = readParentYieldWaitMembers(identity);
  if (!state || state.wait.status === "closeout_delivered") {
    throw new Error("Parent yield handoff is missing its complete child ownership");
  }
  const now = Date.now();
  const next = {
    ...state.wait,
    status: "waiting" as const,
    continuation: undefined,
    continuationScheduledAt: undefined,
    yieldedContinuations: [
      ...(state.wait.yieldedContinuations ?? []),
      { runId: params.runId, endedAt: now },
    ],
    lastUpdatedAt: now,
  };
  commitParentYieldWaitUpdates(new Map(state.members.map((entry) => [entry.runId, next])));
  // Retire the old wake only after the handoff commits, then let canonical
  // child fan-in schedule the next round under the same original obligation.
  consumeParentYieldWaitEvents(identity);
  updateParentYieldWaitFanIn(identity.waitId, state.members[0], now);
}

function isParentYieldWaitDeliveryReceipt(
  row: SourceTurnDeliveryRow,
  identity: ParentYieldWaitDeliveryIdentity,
): boolean {
  return Boolean(
    row.sourceSessionKey === identity.controllerSessionKey &&
    row.parentYieldWaits?.some(
      (wait) => wait.waitId === identity.waitId && wait.parentRunId === identity.parentRunId,
    ) &&
    row.sourceTurnState === "final_delivered" &&
    row.obligationStage === "delivered" &&
    row.finalDeliveryDelivered &&
    row.deliveryDecision.finalDeliveryDelivered &&
    !row.deliveryDecision.refused &&
    row.durabilityDecision.allowedToSettle &&
    normalizeOptionalString(row.obligationIdentity?.runId) &&
    row.idempotencyKey,
  );
}

/** Settle a yielded parent's closeout only from the delivery owner's durable receipt. */
export async function completeParentYieldWaitFromDelivery(
  params: ParentYieldWaitDeliveryIdentity & { registryPath: string; deliveryRecordId: string },
): Promise<number> {
  const registry = await loadSourceTurnDeliveryRegistry(params.registryPath);
  const receipt = registry.rows.find(
    (row) => row.id === params.deliveryRecordId && isParentYieldWaitDeliveryReceipt(row, params),
  );
  const deliveredAt = receipt ? Date.parse(receipt.updatedAt) : Number.NaN;
  if (!receipt || !Number.isFinite(deliveredAt)) {
    return 0;
  }

  const snapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
  const updated = new Map<string, SubagentRunRecord>();
  for (const entry of snapshot.values()) {
    const wait = entry.parentYieldWait;
    if (
      !wait ||
      wait.status !== "continuation_scheduled" ||
      wait.waitId !== params.waitId ||
      wait.parentSessionKey !== params.controllerSessionKey ||
      wait.parentRunId !== params.parentRunId ||
      !wait.requiredCloseout ||
      wait.continuationScheduledAt === undefined ||
      deliveredAt < wait.continuationScheduledAt ||
      wait.yieldedContinuations?.some(
        (yielded) => yielded.runId === receipt.obligationIdentity.runId,
      ) ||
      (wait.continuation &&
        (wait.continuation.phase !== "running" ||
          wait.continuation.runId !== receipt.obligationIdentity.runId)) ||
      wait.expectedChildRunIds.length === 0
    ) {
      continue;
    }
    // A later reply cannot settle missing children or another yield generation.
    const childrenTerminal = wait.expectedChildRunIds.every((runId) => {
      const child = snapshot.get(runId);
      return (
        child?.parentYieldWait?.waitId === wait.waitId &&
        child.parentYieldWait.parentRunId === wait.parentRunId &&
        child.parentYieldWait.parentSessionKey === wait.parentSessionKey &&
        isDeepStrictEqual(child.parentYieldWait.continuation, wait.continuation) &&
        isDeepStrictEqual(child.parentYieldWait.yieldedContinuations, wait.yieldedContinuations) &&
        isRunTerminalForParentYieldWait(child) &&
        child.endedAt! <= deliveredAt
      );
    });
    if (!childrenTerminal) {
      continue;
    }
    updated.set(entry.runId, {
      ...entry,
      ...(entry.cleanup === "delete" ? { archiveAtMs: deliveredAt } : {}),
      parentYieldWait: {
        ...wait,
        status: "closeout_delivered",
        terminalChildRunIds: uniqueSorted(wait.expectedChildRunIds),
        lastUpdatedAt: deliveredAt,
        closeout: {
          parentRunId: params.parentRunId,
          deliveryRecordId: receipt.id,
          deliveryIdempotencyKey: receipt.idempotencyKey,
          deliveryRegistryPath: params.registryPath,
          deliveredAt,
        },
      },
    });
  }
  if (updated.size === 0) {
    return 0;
  }

  // Publish memory only after SQLite commits; failed persistence must leave the
  // required closeout visible to the next recovery attempt.
  const next = new Map([...snapshot, ...updated]);
  subagentRegistryDeps.persistSubagentRunsToDiskOrThrow(next);
  for (const [runId, entry] of updated) {
    subagentRuns.set(runId, entry);
  }
  return updated.size;
}

/** Reconcile an existing receipt before any parent continuation can be redelivered. */
export async function reconcileParentYieldWaitDelivery(
  params: ParentYieldWaitDeliveryIdentity & { registryPath: string },
): Promise<"settled" | "pending" | "missing_receipt"> {
  try {
    const registry = await loadSourceTurnDeliveryRegistry(params.registryPath);
    const receipts = registry.rows.filter((row) => isParentYieldWaitDeliveryReceipt(row, params));
    if (receipts.length === 0) {
      return "missing_receipt";
    }
    for (const receipt of receipts) {
      await completeParentYieldWaitFromDelivery({ ...params, deliveryRecordId: receipt.id });
    }
    const snapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
    const members = [...snapshot.values()].filter(
      (child) =>
        child.parentYieldWait?.waitId === params.waitId &&
        child.parentYieldWait.parentRunId === params.parentRunId &&
        child.parentYieldWait.parentSessionKey === params.controllerSessionKey,
    );
    const isClosed = (child: SubagentRunRecord | undefined) => {
      const wait = child?.parentYieldWait;
      const expected = uniqueSorted(wait?.expectedChildRunIds ?? []);
      const terminal = uniqueSorted(wait?.terminalChildRunIds ?? []);
      return (
        child !== undefined &&
        wait?.waitId === params.waitId &&
        wait.parentRunId === params.parentRunId &&
        wait.parentSessionKey === params.controllerSessionKey &&
        wait.status === "closeout_delivered" &&
        wait.requiredCloseout &&
        wait.closeout.parentRunId === params.parentRunId &&
        wait.closeout.deliveryRegistryPath === params.registryPath &&
        expected.length > 0 &&
        expected.includes(child.runId) &&
        expected.length === terminal.length &&
        expected.every((id, index) => terminal[index] === id) &&
        isRunTerminalForParentYieldWait(child) &&
        receipts.some(
          (receipt) =>
            wait.closeout.deliveryRecordId === receipt.id &&
            wait.closeout.deliveryIdempotencyKey === receipt.idempotencyKey &&
            wait.closeout.deliveredAt === Date.parse(receipt.updatedAt) &&
            child.endedAt! <= wait.closeout.deliveredAt,
        )
      );
    };
    const settled =
      members.length > 0 &&
      members.every((child) => {
        const expected = child.parentYieldWait?.expectedChildRunIds ?? [];
        // Completion already verified every child before committing the full
        // terminal set. Normal cleanup may sweep siblings after that commit.
        return (
          isClosed(child) && expected.every((id) => !snapshot.has(id) || isClosed(snapshot.get(id)))
        );
      });
    if (settled) {
      const closedWait = members[0].parentYieldWait;
      if (closedWait?.status !== "closeout_delivered") {
        return "pending";
      }
      const receipt = receipts.find((row) => row.id === closedWait.closeout.deliveryRecordId)!;
      for (const yielded of closedWait.yieldedContinuations ?? []) {
        // A confirmed yield transfers the still-owed final, never claims that
        // this older execution delivered it. Only this exact later receipt settles it.
        const yieldedRows = registry.rows.filter(
          (row) =>
            row.obligationIdentity.runId === yielded.runId &&
            row.sourceSessionKey === params.controllerSessionKey &&
            row.parentYieldWaits?.some(
              (wait) => wait.waitId === params.waitId && wait.parentRunId === params.parentRunId,
            ),
        );
        for (const row of yieldedRows) {
          if (
            row.sourceChannel !== receipt.sourceChannel ||
            !isDeepStrictEqual(row.deliveryContext, receipt.deliveryContext) ||
            row.preparedSourceFinal ||
            row.finalDeliveryDelivered ||
            !(Date.parse(row.acceptedAt) <= yielded.endedAt) ||
            !(yielded.endedAt <= closedWait.closeout.deliveredAt)
          ) {
            return "pending";
          }
          if (row.sourceTurnState === "settled_resolved_later") {
            continue;
          }
          await persistSourceTurnDeliveryState({
            registryPath: params.registryPath,
            id: row.id,
            sourceTurnId: row.sourceTurnId,
            ...row.obligationIdentity,
            facts: {
              finalDeliveryRequired: true,
              historicalSettlement: true,
              evidenceKinds: ["settled_resolved_later"],
            },
            currentStage: "parent_yield_settled_by_later_final",
            watchdogReconciliation: {
              status: "settled_resolved_later",
              action: "settle-source-resolved-later",
              reason: `Confirmed yielded run ${yielded.runId}; exact parent final ${receipt.id} (${receipt.idempotencyKey}) delivered.`,
              proofPath: params.registryPath,
              originalFinalDeliveryDelivered: false,
              originalVisibleDeliveryCount: row.visibleDeliveryCount,
            },
          });
        }
      }
      consumeParentYieldWaitEvents(params);
    }
    return settled ? "settled" : "pending";
  } catch (error) {
    // The receipt may already be durable. Keep the wait visible and let the
    // existing wake owner retry settlement without another model run or delivery.
    log.warn(`failed to reconcile parent yield wait ${params.waitId}: ${String(error)}`);
    return "pending";
  }
}

async function recoverRestoredParentYieldWaits(): Promise<void> {
  const waits = new Map<
    string,
    ParentYieldWaitRef & {
      parentSessionKey: string;
      childRunId: string;
      replayScheduled: boolean;
    }
  >();
  for (const entry of subagentRuns.values()) {
    const wait = entry.parentYieldWait;
    if (!wait?.parentRunId) {
      continue;
    }
    // Warm restart can preserve the event after closeout committed. Include it
    // so receipt reconciliation removes that wake before another parent turn.
    const hasQueuedWait = peekSystemEventEntries(wait.parentSessionKey).some(
      (event) =>
        event.parentYieldWait?.waitId === wait.waitId &&
        event.parentYieldWait.parentRunId === wait.parentRunId,
    );
    if (!isParentYieldCloseoutPending(entry) && !hasQueuedWait) {
      continue;
    }
    const identity = JSON.stringify([wait.parentSessionKey, wait.parentRunId, wait.waitId]);
    if (!waits.has(identity)) {
      waits.set(identity, {
        waitId: wait.waitId,
        parentRunId: wait.parentRunId,
        parentSessionKey: wait.parentSessionKey,
        childRunId: entry.runId,
        replayScheduled: wait.continuationScheduledAt !== undefined,
      });
    }
  }
  if (waits.size === 0) {
    return;
  }

  const registryPath = resolveSourceTurnDeliveryRegistryPath();
  for (const wait of waits.values()) {
    try {
      // A crash can follow the sink's durable receipt but precede wait settlement.
      // Recover that acknowledgment before replaying an ephemeral system event.
      const reconciled = await reconcileParentYieldWaitDelivery({
        controllerSessionKey: wait.parentSessionKey,
        waitId: wait.waitId,
        parentRunId: wait.parentRunId,
        registryPath,
      });
      if (reconciled === "settled") {
        continue;
      }
      const current = subagentRuns.get(wait.childRunId);
      if (
        current?.parentYieldWait?.waitId !== wait.waitId ||
        current.parentYieldWait.parentRunId !== wait.parentRunId ||
        current.parentYieldWait.parentSessionKey !== wait.parentSessionKey
      ) {
        continue;
      }
      if (
        current.parentYieldWait.yieldedContinuations?.length &&
        !current.parentYieldWait.continuation &&
        current.parentYieldWait.continuationScheduledAt === undefined
      ) {
        // A warm crash can follow the yielded handoff commit but precede old
        // event retirement. Remove that wake before canonical fan-in replays it.
        consumeParentYieldWaitEvents({
          controllerSessionKey: wait.parentSessionKey,
          waitId: wait.waitId,
          parentRunId: wait.parentRunId,
        });
      }
      updateParentYieldWaitFanIn(wait.waitId, current, Date.now(), wait.replayScheduled);
    } catch (error) {
      log.warn(`failed to recover parent yield wait ${wait.waitId}: ${String(error)}`);
    }
  }
}

function recoverAbandonedSteerRestarts(): void {
  // Only explicit Gateway startup owns abandoned handoffs. Other processes can
  // import this shared registry while its actual control caller is still alive.
  for (const entry of subagentRuns.values()) {
    if (entry.suppressAnnounceReason !== "steer-restart" || activeSteerRestarts.has(entry.runId)) {
      continue;
    }
    // The Gateway may have committed the replacement before its caller received
    // the reply. Never close the old wait over that newer canonical child run.
    const latest = getLatestSubagentRunByChildSessionKey(entry.childSessionKey);
    if (latest?.runId === entry.runId) {
      // Clearing intent does not finish a still-running child; fan-in continues
      // to require its actual terminal outcome after the old caller is gone.
      clearSubagentRunSteerRestart(entry.runId);
    }
  }
}

export function markParentYieldWaitForController(params: {
  controllerSessionKey: string;
  parentRunId?: string;
  reason?: string;
  now?: number;
  staleAfterMs?: number;
  requiredCloseout?: boolean;
}): {
  marked: number;
  waitId?: string;
  expectedChildRunIds: string[];
  terminalChildRunIds: string[];
} {
  const controllerSessionKey = normalizeOptionalString(params.controllerSessionKey);
  if (!controllerSessionKey) {
    return { marked: 0, expectedChildRunIds: [], terminalChildRunIds: [] };
  }
  const now = params.now ?? Date.now();
  const controllerRuns = listRunsForControllerFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    controllerSessionKey,
  );
  const continuedWait = controllerRuns.find(
    (entry) =>
      params.parentRunId &&
      (entry.parentYieldWait?.continuation?.runId === params.parentRunId ||
        (entry.parentYieldWait?.parentRunId === params.parentRunId &&
          !entry.parentYieldWait.continuation)) &&
      entry.parentYieldWait?.status !== "closeout_delivered",
  )?.parentYieldWait;
  const continuedState = continuedWait?.parentRunId
    ? readParentYieldWaitMembers({
        controllerSessionKey,
        waitId: continuedWait.waitId,
        parentRunId: continuedWait.parentRunId,
      })
    : undefined;
  if (continuedWait && !continuedState) {
    throw new Error("Parent yield cannot replace an incomplete owned wait");
  }
  const candidates = controllerRuns.filter((entry) => {
    const wait = entry.parentYieldWait;
    if (continuedWait && wait?.waitId === continuedWait.waitId) {
      return true;
    }
    // Another required wait retains its own receipt and children. A new turn
    // cannot overwrite it merely because it shares the controller session.
    if (wait?.requiredCloseout && wait.status !== "closeout_delivered") {
      return false;
    }
    if (entry.expectsCompletionMessage === false) {
      return false;
    }
    if (entry.cleanupCompletedAt !== undefined) {
      return false;
    }
    return !isRunTerminalForParentYieldWait(entry) || entry.delivery?.status !== "delivered";
  });

  if (candidates.length === 0) {
    emitParentYieldNoPendingChildrenEvent({
      controllerSessionKey,
      parentRunId: params.parentRunId,
      reason: params.reason,
      now,
    });
    return { marked: 0, expectedChildRunIds: [], terminalChildRunIds: [] };
  }

  const expectedChildRunIds = uniqueSorted(candidates.map((entry) => entry.runId));
  const childSessionKeys = uniqueSorted(candidates.map((entry) => entry.childSessionKey));
  const waitId =
    continuedWait?.waitId ?? `${controllerSessionKey}:${params.parentRunId ?? "run"}:${now}`;
  const staleAt = now + Math.max(1, params.staleAfterMs ?? PARENT_YIELD_WAIT_STALE_MS);
  const terminalChildRunIds = uniqueSorted(
    candidates.filter(isRunTerminalForParentYieldWait).map((entry) => entry.runId),
  );

  const updates = new Map<string, NonNullable<SubagentRunRecord["parentYieldWait"]>>();
  for (const entry of candidates) {
    updates.set(entry.runId, {
      ...(continuedWait?.status !== "closeout_delivered" ? continuedWait : {}),
      waitId,
      parentSessionKey: controllerSessionKey,
      ...((continuedWait?.parentRunId ?? params.parentRunId)
        ? { parentRunId: continuedWait?.parentRunId ?? params.parentRunId }
        : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      expectedChildRunIds,
      childSessionKeys,
      waitStartedAt: continuedWait?.waitStartedAt ?? now,
      staleAt,
      requiredCloseout: params.requiredCloseout ?? true,
      status: "waiting",
      ...(continuedWait && params.parentRunId
        ? {
            continuation: { runId: params.parentRunId, phase: "yield_requested" as const },
            continuationScheduledAt: undefined,
          }
        : {}),
      terminalChildRunIds,
      lastUpdatedAt: now,
    });
  }

  commitParentYieldWaitUpdates(updates);
  updateParentYieldWaitFanIn(waitId, candidates[0], now);
  return {
    marked: candidates.length,
    waitId,
    expectedChildRunIds,
    terminalChildRunIds: uniqueSorted(
      collectParentYieldWaitMembers(waitId).flatMap(
        (entry) => entry.parentYieldWait?.terminalChildRunIds ?? [],
      ),
    ),
  };
}

function resolveRoutableDeliveryContext(
  context: DeliveryContext | undefined,
): (DeliveryContext & { channel: OriginatingChannelType; to: string }) | undefined {
  const channel = normalizeOptionalString(context?.channel);
  const to = normalizeOptionalString(context?.to);
  if (!context || !channel || !to) {
    return undefined;
  }
  return {
    ...context,
    channel: channel as OriginatingChannelType,
    to,
  };
}

function noteSubagentRelayActivity(entry: SubagentRunRecord, at = Date.now()): void {
  const state = ensureSubagentProgressRelayState(entry);
  state.lastActivityAt = at;
  state.stallNoticeCount = 0;
}

function maybeEmitSubagentProgressUpdate(
  entry: SubagentRunRecord,
  summary: string | undefined,
  at = Date.now(),
): void {
  const cleaned = sanitizeTaskStatusText(summary, { maxChars: 160 });
  if (!cleaned) {
    return;
  }
  const state = ensureSubagentProgressRelayState(entry);
  state.lastActivityAt = at;
  if (state.lastSummary === cleaned) {
    return;
  }
  if (
    typeof state.lastSummaryAt === "number" &&
    at - state.lastSummaryAt < SUBAGENT_PROGRESS_EMIT_MIN_MS
  ) {
    return;
  }
  state.lastSummary = cleaned;
  state.lastSummaryAt = at;
  emitSubagentRequesterSystemEvent(
    entry,
    `Subagent update: ${resolveSubagentRelayLabel(entry)}. ${cleaned}`,
    "progress",
  );
}

function emitSubagentStartedUpdate(entry: SubagentRunRecord): void {
  ensureSubagentProgressRelayState(entry);
  emitSubagentRequesterSystemEvent(
    entry,
    `Subagent started: ${resolveSubagentRelayLabel(entry)}.`,
    "start",
  );
}

function buildSubagentFailureStreakKey(entry: SubagentRunRecord): string {
  return `${entry.requesterSessionKey}::${resolveSubagentRelayLabel(entry).toLowerCase()}`;
}

function clearSubagentFailureStreak(entry: SubagentRunRecord): void {
  subagentFailureStreakByKey.delete(buildSubagentFailureStreakKey(entry));
}

function noteSubagentFailureStreak(entry: SubagentRunRecord, now = Date.now()): number {
  const key = buildSubagentFailureStreakKey(entry);
  const current = subagentFailureStreakByKey.get(key);
  const nextCount =
    current && now - current.lastFailedAt <= SUBAGENT_FAILURE_STREAK_WINDOW_MS
      ? current.count + 1
      : 1;
  subagentFailureStreakByKey.set(key, { count: nextCount, lastFailedAt: now });
  return nextCount;
}

function noteConfirmedSubagentFailure(entry: SubagentRunRecord, outcome: SubagentRunOutcome): void {
  const state = ensureSubagentProgressRelayState(entry);
  if (state.terminalFailureNotified) {
    return;
  }
  state.terminalFailureNotified = true;
  const label = resolveSubagentRelayLabel(entry);
  const failureCount = noteSubagentFailureStreak(entry);
  if (outcome.status !== "error" && outcome.status !== "timeout") {
    return;
  }
  const detail =
    outcome.status === "error"
      ? sanitizeTaskStatusText(outcome.error, { errorContext: true, maxChars: 160 })
      : undefined;
  if (failureCount >= 2) {
    emitSubagentRequesterSystemEvent(
      entry,
      `Subagent failed again: ${label}. Reclaim locally instead of letting it keep burning time.${detail ? ` ${detail}` : ""}`,
      "failure-repeat",
    );
    return;
  }
  emitSubagentRequesterSystemEvent(
    entry,
    outcome.status === "timeout"
      ? `Subagent timed out: ${label}.`
      : `Subagent failed: ${label}.${detail ? ` ${detail}` : ""}`,
    "failure",
  );
}

function buildSubagentProgressSummaryFromEvent(evt: {
  stream: string;
  data?: Record<string, unknown>;
}): string | undefined {
  if (evt.stream === "plan") {
    const title = sanitizeTaskStatusText(evt.data?.title, { maxChars: 120 });
    return title ? `Plan updated: ${title}` : undefined;
  }
  if (evt.stream === "item") {
    const phase = typeof evt.data?.phase === "string" ? evt.data.phase : undefined;
    if (phase !== "start") {
      return undefined;
    }
    return sanitizeTaskStatusText(evt.data?.title, { maxChars: 120 }) || undefined;
  }
  if (evt.stream === "patch") {
    const summary = sanitizeTaskStatusText(evt.data?.summary, { maxChars: 120 });
    return summary ? `Patch applied: ${summary}` : "Patch applied.";
  }
  return undefined;
}

type CompleteSubagentRunParams = {
  runId: string;
  endedAt?: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  triggerCleanup: boolean;
  startedAt?: number;
};

async function completeSubagentRunWithRecovery(params: CompleteSubagentRunParams, source: string) {
  const entryBeforeCompletion = subagentRuns.get(params.runId);
  try {
    await completeSubagentRun(params);
    if (entryBeforeCompletion) {
      if (params.outcome.status === "ok") {
        clearSubagentFailureStreak(entryBeforeCompletion);
      } else if (params.outcome.status === "error" || params.outcome.status === "timeout") {
        noteConfirmedSubagentFailure(entryBeforeCompletion, params.outcome);
      }
    }
    subagentProgressRelayByRunId.delete(params.runId);
    return;
  } catch (error) {
    const current = subagentRuns.get(params.runId);
    log.warn("failed to complete subagent run; retrying completion", {
      source,
      runId: params.runId,
      childSessionKey: current?.childSessionKey,
      error,
    });
  }

  const current = subagentRuns.get(params.runId);
  if (
    !current ||
    typeof current.endedAt !== "number" ||
    typeof current.cleanupCompletedAt === "number" ||
    current.pauseReason === "sessions_yield"
  ) {
    return;
  }

  try {
    await completeSubagentRun(params);
    return;
  } catch (retryError) {
    log.warn("failed to complete subagent run after retry; retrying ended cleanup", {
      source,
      runId: params.runId,
      childSessionKey: current.childSessionKey,
      error: retryError,
    });
  }

  const latest = subagentRuns.get(params.runId);
  if (
    !latest ||
    typeof latest.endedAt !== "number" ||
    typeof latest.cleanupCompletedAt === "number" ||
    latest.pauseReason === "sessions_yield"
  ) {
    return;
  }
  latest.cleanupHandled = false;
  resumedRuns.delete(params.runId);
  resumeSubagentRun(params.runId);
}

function completeSubagentRunInBackground(params: CompleteSubagentRunParams, source: string) {
  void completeSubagentRunWithRecovery(params, source);
}

function completePausedYieldRunIfTerminal(runId: string, entry: SubagentRunRecord): boolean {
  if (entry.pauseReason !== "sessions_yield") {
    return false;
  }
  const completion = resolveSubagentSessionCompletion({
    childSessionKey: entry.childSessionKey,
    fallbackEndedAt: entry.endedAt ?? Date.now(),
    notBeforeMs: entry.startedAt ?? entry.createdAt,
  });
  if (!completion) {
    return false;
  }
  log.info("resuming sessions_yield-paused subagent after terminal session completion", {
    runId,
    childSessionKey: entry.childSessionKey,
    outcome: completion.outcome.status,
  });
  completeSubagentRunInBackground(
    {
      runId,
      endedAt: completion.endedAt,
      outcome: completion.outcome,
      reason: completion.reason,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
      startedAt: completion.startedAt,
    },
    "sessions-yield-terminal-resume",
  );
  return true;
}

function schedulePendingLifecycleError(params: {
  runId: string;
  endedAt: number;
  startedAt?: number;
  error?: string;
}) {
  clearPendingLifecycleTimeout(params.runId);
  clearPendingLifecycleError(params.runId);
  const timer = setTimeout(() => {
    const pending = pendingLifecycleErrorByRunId.get(params.runId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    pendingLifecycleErrorByRunId.delete(params.runId);
    const entry = subagentRuns.get(params.runId);
    if (!entry) {
      return;
    }
    if (entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE || entry.outcome?.status === "ok") {
      return;
    }
    const completionParams = {
      runId: params.runId,
      endedAt: pending.endedAt,
      outcome: {
        status: "error" as const,
        error: pending.error,
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
      startedAt: pending.startedAt,
    };
    completeSubagentRunInBackground(completionParams, "lifecycle-error-grace");
  }, LIFECYCLE_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingLifecycleErrorByRunId.set(params.runId, {
    timer,
    endedAt: params.endedAt,
    startedAt: params.startedAt,
    error: params.error,
  });
}

function schedulePendingLifecycleTimeout(params: {
  runId: string;
  endedAt: number;
  startedAt?: number;
}) {
  clearPendingLifecycleError(params.runId);
  clearPendingLifecycleTimeout(params.runId);
  const timer = setTimeout(() => {
    const pending = pendingLifecycleTimeoutByRunId.get(params.runId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    pendingLifecycleTimeoutByRunId.delete(params.runId);
    const entry = subagentRuns.get(params.runId);
    if (!entry) {
      return;
    }
    if (entry.outcome?.status === "ok") {
      return;
    }
    const completionParams = {
      runId: params.runId,
      endedAt: pending.endedAt,
      outcome: {
        status: "timeout" as const,
      },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
      startedAt: pending.startedAt,
    };
    completeSubagentRunInBackground(completionParams, "lifecycle-timeout-grace");
  }, LIFECYCLE_TIMEOUT_RETRY_GRACE_MS);
  timer.unref?.();
  pendingLifecycleTimeoutByRunId.set(params.runId, {
    timer,
    endedAt: params.endedAt,
    startedAt: params.startedAt,
  });
}

async function notifyContextEngineSubagentEnded(params: {
  childSessionKey: string;
  reason: SubagentEndReason;
  agentDir?: string;
  workspaceDir?: string;
}) {
  try {
    const cfg = subagentRegistryDeps.getRuntimeConfig();
    await ensureSubagentRegistryPluginRuntimeLoaded({
      config: cfg,
      workspaceDir: params.workspaceDir,
      allowGatewaySubagentBinding: true,
    });
    const engine = await resolveSubagentRegistryContextEngine(cfg, {
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    });
    if (!engine.onSubagentEnded) {
      return;
    }
    await engine.onSubagentEnded(params);
  } catch (err) {
    log.warn("context-engine onSubagentEnded failed (best-effort)", { err });
  }
}

function suppressAnnounceForSteerRestart(entry?: SubagentRunRecord) {
  return entry?.suppressAnnounceReason === "steer-restart";
}

function shouldKeepThreadBindingAfterRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  if (params.reason === SUBAGENT_ENDED_REASON_KILLED) {
    return false;
  }
  return params.entry.spawnMode === "session";
}

function shouldEmitEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  return !shouldKeepThreadBindingAfterRun(params);
}

async function emitSubagentEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason?: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
}) {
  if (params.entry.endedHookEmittedAt) {
    return;
  }
  const cfg = subagentRegistryDeps.getRuntimeConfig();
  await ensureSubagentRegistryPluginRuntimeLoaded({
    config: cfg,
    workspaceDir: params.entry.workspaceDir,
    allowGatewaySubagentBinding: true,
  });
  const reason = params.reason ?? params.entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  const outcome = resolveLifecycleOutcomeFromRunOutcome(params.entry.outcome);
  const error = params.entry.outcome?.status === "error" ? params.entry.outcome.error : undefined;
  await emitSubagentEndedHookOnce({
    entry: params.entry,
    reason,
    sendFarewell: params.sendFarewell,
    accountId: params.accountId ?? params.entry.requesterOrigin?.accountId,
    outcome,
    error,
    inFlightRunIds: endedHookInFlightRunIds,
    persist: persistSubagentRuns,
  });
}

const subagentLifecycleController = createSubagentRegistryLifecycleController({
  runs: subagentRuns,
  resumedRuns,
  subagentAnnounceTimeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
  persist: persistSubagentRuns,
  clearPendingLifecycleError,
  countPendingDescendantRuns,
  suppressAnnounceForSteerRestart,
  shouldEmitEndedHookForRun,
  emitSubagentEndedHookForRun,
  notifyContextEngineSubagentEnded,
  resumeSubagentRun,
  callGateway: (request) => subagentRegistryDeps.callGateway(request),
  captureSubagentCompletionReply: (sessionKey, options) =>
    subagentRegistryDeps.captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: (args) =>
    subagentRegistryDeps.cleanupBrowserSessionsForLifecycleEnd(args),
  runSubagentAnnounceFlow: (params) => subagentRegistryDeps.runSubagentAnnounceFlow(params),
  warn: (message, meta) => log.warn(message, meta),
});

const {
  clearScheduledResumeTimers,
  completeCleanupBookkeeping,
  finalizeResumedAnnounceGiveUp,
  refreshFrozenResultFromSession,
  startSubagentAnnounceCleanupFlow,
} = subagentLifecycleController;

async function completeSubagentRun(params: CompleteSubagentRunParams): Promise<void> {
  const entry = subagentRuns.get(params.runId);
  await subagentLifecycleController.completeSubagentRun(params);
  // Polling, lifecycle events, and successful completion retries share this
  // owner so every terminal observation can release its parent's durable wait.
  if (entry?.parentYieldWait?.waitId) {
    updateParentYieldWaitFanIn(entry.parentYieldWait.waitId, entry);
  }
}

function resumeSubagentRun(runId: string) {
  if (!runId || resumedRuns.has(runId)) {
    return;
  }
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (entry.cleanupCompletedAt) {
    return;
  }
  if (typeof entry.endedAt === "number" && isDeliverySuspended(entry)) {
    return;
  }
  if (entry.pauseReason === "sessions_yield") {
    if (completePausedYieldRunIfTerminal(runId, entry)) {
      resumedRuns.add(runId);
    }
    return;
  }
  // Skip entries that have exhausted their retry budget or expired (#18264).
  if (getDeliveryAttemptCount(entry) >= MAX_ANNOUNCE_RETRY_COUNT) {
    void finalizeResumedAnnounceGiveUp({
      runId,
      entry,
      reason: "retry-limit",
    });
    return;
  }
  if (
    entry.expectsCompletionMessage !== true &&
    typeof entry.endedAt === "number" &&
    Date.now() - entry.endedAt > ANNOUNCE_EXPIRY_MS
  ) {
    void finalizeResumedAnnounceGiveUp({
      runId,
      entry,
      reason: "expiry",
    });
    return;
  }

  const now = Date.now();
  const lastAttemptAt = getDeliveryLastAttemptAt(entry);
  const delayMs = resolveAnnounceRetryDelayMs(getDeliveryAttemptCount(entry));
  const earliestRetryAt = (lastAttemptAt ?? 0) + delayMs;
  if (entry.expectsCompletionMessage === true && lastAttemptAt && now < earliestRetryAt) {
    const waitMs = Math.max(1, earliestRetryAt - now);
    const scheduledEntry = entry;
    const timer = setTimeout(() => {
      resumeRetryTimers.delete(timer);
      if (subagentRuns.get(runId) !== scheduledEntry) {
        return;
      }
      resumedRuns.delete(runId);
      resumeSubagentRun(runId);
    }, waitMs);
    timer.unref?.();
    resumeRetryTimers.add(timer);
    resumedRuns.add(runId);
    return;
  }

  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
    const orphanReason = resolveSubagentRunOrphanReason({ entry });
    if (orphanReason) {
      if (
        reconcileOrphanedRun({
          runId,
          entry,
          reason: orphanReason,
          source: "resume",
          runs: subagentRuns,
          resumedRuns,
        })
      ) {
        persistSubagentRuns();
      }
      return;
    }
    if (suppressAnnounceForSteerRestart(entry)) {
      resumedRuns.add(runId);
      return;
    }
    if (!startSubagentAnnounceCleanupFlow(runId, entry)) {
      return;
    }
    resumedRuns.add(runId);
    return;
  }

  // Wait for completion again after restart.
  const cfg = subagentRegistryDeps.getRuntimeConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds);
  void subagentRunManager.waitForSubagentCompletion(runId, waitTimeoutMs, entry, true);
  resumedRuns.add(runId);
}

function restoreSubagentRunsOnce() {
  if (restoreAttempted) {
    return parentYieldWaitRecovery;
  }
  restoreAttempted = true;
  try {
    const restoredCount = subagentRegistryDeps.restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true,
    });
    if (restoredCount === 0) {
      return parentYieldWaitRecovery;
    }
    if (
      reconcileOrphanedRestoredRuns({
        runs: subagentRuns,
        resumedRuns,
      })
    ) {
      persistSubagentRuns();
    }
    if (subagentRuns.size === 0) {
      return parentYieldWaitRecovery;
    }
    // Resume pending work.
    ensureListener();
    // System events do not survive restart. The once-only restore guard bounds
    // replay while the persisted wait preserves its original schedule and age.
    parentYieldWaitRecovery = recoverRestoredParentYieldWaits().catch((error: unknown) => {
      log.warn(`failed to recover parent yield waits: ${String(error)}`);
    });
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    startSweeper();
    for (const runId of subagentRuns.keys()) {
      resumeSubagentRun(runId);
    }

    // Cold-start restore path: queue the same recovery pass that restart
    // startup also uses so resumed children are handled through one seam.
    scheduleSubagentOrphanRecovery();
  } catch (err) {
    log.warn(
      `failed to restore subagent runs from disk: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parentYieldWaitRecovery;
}

function resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number) {
  return subagentRegistryDeps.resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: runTimeoutSeconds ?? 0,
  });
}

function startSweeper() {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    void sweepSubagentRuns();
  }, 60_000);
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}

function isSuspendedPendingFinalDelivery(entry: SubagentRunRecord): boolean {
  return typeof entry.endedAt === "number" && isDeliverySuspended(entry);
}

function resolveSuspendedDeliveryExpiryMs(entry: SubagentRunRecord): number {
  const requester = entry.requesterSessionKey;
  if (requester.includes(":cron:")) {
    return SUSPENDED_DELIVERY_CRON_EXPIRY_MS;
  }
  if (requester.includes(":subagent:")) {
    return SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS;
  }
  return SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS;
}

function shouldSkipDiscardSuspendedPendingFinalDelivery(entry: SubagentRunRecord): {
  skip: boolean;
  reason?: string;
} {
  const delivery = ensureDeliveryState(entry);
  const completion = ensureCompletionState(entry);
  const frozenText =
    delivery.payload?.frozenResultText ??
    delivery.payload?.fallbackFrozenResultText ??
    completion.resultText ??
    completion.fallbackResultText;
  const replayProofExists = Boolean(delivery.announcedAt || delivery.deliveredAt);
  if (frozenText && !replayProofExists) {
    return {
      skip: true,
      reason: "frozen-output still exists without replay proof",
    };
  }
  return { skip: false };
}

function agentWaitResultStillRepresentsLiveRun(wait: AgentWaitResult): boolean {
  if (wait.status === "pending") {
    return true;
  }
  if (wait.status !== "timeout") {
    return false;
  }
  return wait.timeoutPhase === "gateway_draining" || wait.providerStarted === true;
}

async function remoteAgentRunStillAppearsLive(runId: string): Promise<boolean> {
  const wait = await waitForAgentRun({
    runId,
    timeoutMs: REMOTE_AGENT_LIVENESS_PROBE_TIMEOUT_MS,
    callGateway: subagentRegistryDeps.callGateway,
  });
  return agentWaitResultStillRepresentsLiveRun(wait);
}

async function discardSuspendedPendingFinalDelivery(
  runId: string,
  entry: SubagentRunRecord,
  now: number,
  reason: "expired" | "pressure-pruned",
): Promise<void> {
  const delivery = ensureDeliveryState(entry);
  const payload = delivery.payload;
  delivery.status = "discarded";
  delivery.discardedAt = now;
  delivery.discardReason = reason;
  delivery.discardedPayloadSummary = {
    requesterSessionKey: payload?.requesterSessionKey ?? entry.requesterSessionKey,
    childSessionKey: payload?.childSessionKey ?? entry.childSessionKey,
    childRunId: payload?.childRunId ?? entry.runId,
    endedAt: payload?.endedAt ?? entry.endedAt,
    status: payload?.outcome?.status ?? entry.outcome?.status,
    lastError: getDeliveryLastError(entry) ?? null,
  };
  delivery.payload = undefined;
  delivery.createdAt = undefined;
  delivery.lastAttemptAt = undefined;
  delivery.attemptCount = undefined;
  delivery.lastError = undefined;
  delivery.suspendedAt = undefined;
  delivery.suspendedReason = undefined;
  entry.wakeOnDescendantSettle = undefined;
  const completion = ensureCompletionState(entry);
  completion.fallbackResultText = undefined;
  completion.fallbackCapturedAt = undefined;
  entry.cleanupHandled = true;
  delivery.announcedAt = undefined;
  resumedRuns.delete(runId);
  clearPendingLifecycleError(runId);
  clearPendingLifecycleTimeout(runId);
  log.warn("subagent suspended delivery discarded", {
    reason,
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
  });
  const shouldDeleteAttachments = entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
  if (shouldDeleteAttachments) {
    await safeRemoveAttachmentsDir(entry);
  }
  await removeInternalSessionEffectsTranscript(entry.execution?.transcriptFile);
  const completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  completeCleanupBookkeeping({
    runId,
    entry,
    cleanup: entry.cleanup,
    completedAt: now,
  });
  if (
    entry.expectsCompletionMessage === true &&
    shouldEmitEndedHookForRun({
      entry,
      reason: completionReason,
    })
  ) {
    await emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: true,
    });
  }
}

async function sweepSubagentRuns() {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  try {
    const now = Date.now();
    const storeCache: SubagentSessionStoreCache = new Map();
    const retriedParentWaits = new Set<string>();
    let mutated = false;
    const suspendedEntries = [...subagentRuns.entries()].filter(([, entry]) =>
      isSuspendedPendingFinalDelivery(entry),
    );
    const pressureDiscardRunIds = new Set<string>();
    if (suspendedEntries.length > SUSPENDED_DELIVERY_HARD_CAP) {
      const pressureCount = Math.max(
        0,
        suspendedEntries.length - SUSPENDED_DELIVERY_PRESSURE_TARGET,
      );
      for (const [runId] of suspendedEntries
        .toSorted((a, b) => (a[1].delivery?.suspendedAt ?? 0) - (b[1].delivery?.suspendedAt ?? 0))
        .slice(0, pressureCount)) {
        pressureDiscardRunIds.add(runId);
      }
      log.warn("subagent suspended delivery backlog exceeded pressure cap", {
        suspendedCount: suspendedEntries.length,
        softCap: SUSPENDED_DELIVERY_SOFT_CAP,
        hardCap: SUSPENDED_DELIVERY_HARD_CAP,
        pressureTarget: SUSPENDED_DELIVERY_PRESSURE_TARGET,
        pressureDiscardCount: pressureDiscardRunIds.size,
      });
    }
    for (const [runId, entry] of subagentRuns.entries()) {
      // The parent receipt validator needs the complete child set after restart.
      // Resume cleanup after its durable closeout and exact wake retirement.
      if (typeof entry.endedAt === "number" && shouldRetainParentYieldCloseout(entry)) {
        const wait = entry.parentYieldWait;
        if (
          wait &&
          isParentYieldCloseoutPending(entry) &&
          wait.continuationScheduledAt === undefined
        ) {
          const identity = JSON.stringify([wait.parentSessionKey, wait.parentRunId, wait.waitId]);
          if (!retriedParentWaits.has(identity)) {
            retriedParentWaits.add(identity);
            try {
              // Immediate terminal callbacks can exhaust their storage retries.
              // The existing sweep owns a later attempt without deleting proof.
              updateParentYieldWaitFanIn(wait.waitId, entry, now);
            } catch (error) {
              log.warn(`failed to retry parent yield wait ${wait.waitId}: ${String(error)}`);
            }
          }
        }
        continue;
      }
      if (isSuspendedPendingFinalDelivery(entry)) {
        const suspendedAgeMs = now - (entry.delivery?.suspendedAt ?? now);
        const expired = suspendedAgeMs >= resolveSuspendedDeliveryExpiryMs(entry);
        if (expired || pressureDiscardRunIds.has(runId)) {
          const discardGuard = shouldSkipDiscardSuspendedPendingFinalDelivery(entry);
          if (discardGuard.skip) {
            log.warn("subagent suspended delivery discard skipped", {
              reason: discardGuard.reason,
              runId: entry.runId,
              childSessionKey: entry.childSessionKey,
              requesterSessionKey: entry.requesterSessionKey,
              discardAttempt: expired ? "expired" : "pressure-pruned",
            });
            continue;
          }
          await discardSuspendedPendingFinalDelivery(
            runId,
            entry,
            now,
            expired ? "expired" : "pressure-pruned",
          );
          mutated = true;
        }
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        const progressState = ensureSubagentProgressRelayState(entry);
        const inactiveMs = now - progressState.lastActivityAt;
        const nextStallThresholdMs =
          SUBAGENT_PROGRESS_STALL_MS * Math.max(1, progressState.stallNoticeCount + 1);
        if (inactiveMs >= nextStallThresholdMs) {
          progressState.stallNoticeCount += 1;
          progressState.lastSummary = undefined;
          progressState.lastSummaryAt = now;
          const seconds = Math.max(1, Math.round(inactiveMs / 1000));
          emitSubagentRequesterSystemEvent(
            entry,
            progressState.stallNoticeCount >= 2
              ? `Subagent stalled again: ${resolveSubagentRelayLabel(entry)}. No visible progress for ${seconds}s. Reclaim locally instead of letting it keep burning time.`
              : `Subagent stalled: ${resolveSubagentRelayLabel(entry)}. No visible progress for ${seconds}s.`,
            `stall-${progressState.stallNoticeCount}`,
          );
        }
        const hasLiveRunContext = Boolean(getAgentRunContext(runId));
        const activeAgeMs = now - (entry.startedAt ?? entry.createdAt);
        if (!hasLiveRunContext && activeAgeMs >= STALE_ACTIVE_SUBAGENT_GRACE_MS) {
          const sessionEntry = loadSubagentSessionEntry({
            childSessionKey: entry.childSessionKey,
            storeCache,
          });
          const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
            notBeforeMs: entry.startedAt ?? entry.createdAt,
          });
          if (completion) {
            await completeSubagentRunWithRecovery(
              {
                runId,
                startedAt: completion.startedAt,
                endedAt: completion.endedAt,
                outcome: completion.outcome,
                reason: completion.reason,
                sendFarewell: true,
                accountId: entry.requesterOrigin?.accountId,
                triggerCleanup: true,
              },
              "sweeper-session-completion",
            );
            continue;
          }

          if (sessionEntry?.abortedLastRun === true) {
            scheduleSubagentOrphanRecovery({ delayMs: 1_000 });
            continue;
          }

          const orphanReason = resolveSubagentRunOrphanReason({
            entry,
            storeCache,
          });
          if (orphanReason) {
            if (
              reconcileOrphanedRun({
                runId,
                entry,
                reason: orphanReason,
                source: "resume",
                runs: subagentRuns,
                resumedRuns,
              })
            ) {
              mutated = true;
            }
            continue;
          }

          if (await remoteAgentRunStillAppearsLive(runId)) {
            continue;
          }

          await completeSubagentRunWithRecovery(
            {
              runId,
              endedAt: now,
              outcome: {
                status: "error",
                error: "subagent run lost active execution context",
              },
              reason: SUBAGENT_ENDED_REASON_ERROR,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: true,
            },
            "sweeper-lost-context",
          );
          continue;
        }
      }

      if (!entry.archiveAtMs && entry.cleanup === "keep" && entry.spawnMode !== "session") {
        continue;
      }
      if (!entry.archiveAtMs) {
        if (
          typeof entry.cleanupCompletedAt === "number" &&
          now - entry.cleanupCompletedAt > SESSION_RUN_TTL_MS
        ) {
          clearPendingLifecycleError(runId);
          void notifyContextEngineSubagentEnded({
            childSessionKey: entry.childSessionKey,
            reason: "swept",
            agentDir: entry.agentDir,
            workspaceDir: entry.workspaceDir,
          });
          subagentRuns.delete(runId);
          mutated = true;
          if (!entry.retainAttachmentsOnKeep) {
            await safeRemoveAttachmentsDir(entry);
          }
        }
        continue;
      }
      if (entry.archiveAtMs > now) {
        continue;
      }
      clearPendingLifecycleError(runId);
      try {
        await subagentRegistryDeps.callGateway({
          method: "sessions.delete",
          params: {
            key: entry.childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: false,
          },
          timeoutMs: 10_000,
        });
      } catch (err) {
        log.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
          runId,
          childSessionKey: entry.childSessionKey,
          err,
        });
        continue;
      }
      subagentRuns.delete(runId);
      mutated = true;
      // Archive/purge is terminal for the run record; remove any retained attachments too.
      await safeRemoveAttachmentsDir(entry);
      void notifyContextEngineSubagentEnded({
        childSessionKey: entry.childSessionKey,
        reason: "swept",
        agentDir: entry.agentDir,
        workspaceDir: entry.workspaceDir,
      });
    }
    // Sweep orphaned pendingLifecycleError entries (absolute TTL).
    for (const [runId, pending] of pendingLifecycleErrorByRunId.entries()) {
      if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) {
        clearPendingLifecycleError(runId);
      }
    }
    for (const [runId, pending] of pendingLifecycleTimeoutByRunId.entries()) {
      if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) {
        clearPendingLifecycleTimeout(runId);
      }
    }

    if (mutated) {
      persistSubagentRuns();
    }
    if (subagentRuns.size === 0) {
      stopSweeper();
    }
  } finally {
    sweepInProgress = false;
  }
}

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = subagentRegistryDeps.onAgentEvent((evt) => {
    void (async () => {
      if (!evt) {
        return;
      }
      const entry = subagentRuns.get(evt.runId);
      if (entry) {
        const eventAt = evt.ts || Date.now();
        if (evt.stream === "assistant") {
          const assistantPhase = normalizeAssistantPhase(
            (evt.data as { phase?: unknown } | undefined)?.phase,
          );
          const delta =
            typeof (evt.data as { delta?: unknown } | undefined)?.delta === "string"
              ? ((evt.data as { delta?: string }).delta ?? "")
              : typeof (evt.data as { text?: unknown } | undefined)?.text === "string"
                ? ((evt.data as { text?: string }).text ?? "")
                : "";
          if (assistantPhase === "commentary" && delta.trim()) {
            noteSubagentRelayActivity(entry, eventAt);
          }
        } else {
          noteSubagentRelayActivity(entry, eventAt);
          maybeEmitSubagentProgressUpdate(
            entry,
            buildSubagentProgressSummaryFromEvent(evt),
            eventAt,
          );
        }
      }
      if (evt.stream !== "lifecycle") {
        return;
      }
      const phase = evt.data?.phase;
      if (!entry) {
        if (phase === "end" && typeof evt.sessionKey === "string") {
          await refreshFrozenResultFromSession(evt.sessionKey);
        }
        return;
      }
      if (phase === "start") {
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
        if (startedAt) {
          entry.startedAt = startedAt;
          if (typeof entry.sessionStartedAt !== "number") {
            entry.sessionStartedAt = startedAt;
          }
          persistSubagentRuns();
        }
        return;
      }
      if (phase !== "end" && phase !== "error") {
        return;
      }
      const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      const livenessState =
        typeof evt.data?.livenessState === "string" ? evt.data.livenessState : undefined;
      const stopReason = typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
      if (phase === "error") {
        schedulePendingLifecycleError({
          runId: evt.runId,
          endedAt,
          startedAt,
          error,
        });
        return;
      }
      if (isAbortedAgentStopReason(stopReason)) {
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        await completeSubagentRunWithRecovery(
          {
            runId: evt.runId,
            endedAt,
            outcome: {
              status: "error",
              error: "subagent run terminated",
            },
            reason: SUBAGENT_ENDED_REASON_KILLED,
            sendFarewell: true,
            accountId: entry.requesterOrigin?.accountId,
            triggerCleanup: true,
            startedAt,
          },
          "lifecycle-killed-event",
        );
        return;
      }
      if (isBlockedLivenessState(livenessState)) {
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        const blockedParams = {
          runId: evt.runId,
          endedAt,
          outcome: {
            status: "error" as const,
            error: formatBlockedLivenessError(error),
          },
          reason: SUBAGENT_ENDED_REASON_ERROR,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          startedAt,
        };
        await completeSubagentRunWithRecovery(blockedParams, "lifecycle-blocked-event");
        return;
      }
      if (evt.data?.aborted) {
        schedulePendingLifecycleTimeout({
          runId: evt.runId,
          endedAt,
          startedAt,
        });
        return;
      }
      if (evt.data?.yielded === true) {
        if (
          markSubagentRunPausedAfterYield({
            entry,
            endedAt,
            startedAt: startedAt ?? entry.startedAt,
          })
        ) {
          persistSubagentRuns();
        }
        return;
      }
      clearPendingLifecycleError(evt.runId);
      clearPendingLifecycleTimeout(evt.runId);
      const completionParams = {
        runId: evt.runId,
        endedAt,
        outcome: { status: "ok" as const },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
        startedAt,
      };
      await completeSubagentRunWithRecovery(completionParams, "lifecycle-ok-event");
    })().catch((err: unknown) => {
      log.warn("lifecycle event handler failed", { err, runId: evt.runId });
    });
  });
}

const subagentRunManager = createSubagentRunManager({
  runs: subagentRuns,
  resumedRuns,
  endedHookInFlightRunIds,
  persist: persistSubagentRuns,
  persistOrThrow: persistSubagentRunsOrThrow,
  callGateway: (request) => subagentRegistryDeps.callGateway(request),
  getRuntimeConfig: () => subagentRegistryDeps.getRuntimeConfig(),
  ensureRuntimePluginsLoaded: (args: {
    config: OpenClawConfig;
    workspaceDir?: string;
    allowGatewaySubagentBinding?: boolean;
  }) => ensureSubagentRegistryPluginRuntimeLoaded(args),
  ensureListener,
  startSweeper,
  stopSweeper,
  resumeSubagentRun,
  clearPendingLifecycleError,
  resolveSubagentWaitTimeoutMs,
  scheduleOrphanRecovery: (args) => scheduleSubagentOrphanRecovery(args),
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  notifyContextEngineSubagentEnded,
  completeCleanupBookkeeping,
  completeSubagentRun,
});

configureSubagentRegistrySteerRuntime({
  assertParentYieldWaitAllowsRestart,
  replaceSubagentRunAfterSteer,
  finalizeInterruptedSubagentRun: async (params) => await finalizeInterruptedSubagentRun(params),
});

export function markSubagentRunForSteerRestart(runId: string) {
  const key = runId.trim();
  if (activeSteerRestarts.has(key)) {
    return false;
  }
  const marked = subagentRunManager.markSubagentRunForSteerRestart(key);
  if (marked) {
    activeSteerRestarts.add(key);
  }
  return marked;
}

export function clearSubagentRunSteerRestart(runId: string) {
  const key = runId.trim();
  activeSteerRestarts.delete(key);
  const cleared = subagentRunManager.clearSubagentRunSteerRestart(key);
  const entry = subagentRuns.get(key);
  if (cleared && entry?.parentYieldWait) {
    try {
      updateParentYieldWaitFanIn(entry.parentYieldWait.waitId, entry);
    } catch (error) {
      // The terminal child stays retained. The existing sweep retries the exact
      // scheduling commit after storage recovers, without inventing a new wait.
      log.warn(`failed to resume parent after steer ${key}: ${String(error)}`);
    }
  }
  return cleared;
}

export async function replaceSubagentRunAfterSteer(params: {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
  transcriptFile?: string;
}) {
  const previous = subagentRuns.get(params.previousRunId.trim());
  if (previous && !(await settleParentYieldWaitBeforeRestart(previous))) {
    return false;
  }
  const replaced = subagentRunManager.replaceSubagentRunAfterSteer(params);
  if (replaced) {
    activeSteerRestarts.delete(params.previousRunId.trim());
  }
  return replaced;
}

export async function assertParentYieldWaitAllowsRestart(runId: string): Promise<void> {
  const entry = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns).get(runId);
  if (entry && !(await settleParentYieldWaitBeforeRestart(entry))) {
    throw new Error(
      "Parent closeout is pending; retry this child after its parent final is delivered.",
    );
  }
}

async function settleParentYieldWaitBeforeRestart(entry: SubagentRunRecord): Promise<boolean> {
  const wait = entry.parentYieldWait;
  if (!wait?.requiredCloseout) {
    return true;
  }
  if (wait.status !== "closeout_delivered" && wait.continuationScheduledAt === undefined) {
    return true;
  }
  if (!wait.parentRunId) {
    return false;
  }
  // Replacement can reuse the child session. Retire its exact delivered wake
  // before removing the old proof, and never carry that wait into the new run.
  const reconciled = await reconcileParentYieldWaitDelivery({
    controllerSessionKey: wait.parentSessionKey,
    waitId: wait.waitId,
    parentRunId: wait.parentRunId,
    registryPath:
      wait.status === "closeout_delivered"
        ? wait.closeout.deliveryRegistryPath
        : resolveSourceTurnDeliveryRegistryPath(),
  });
  const current = subagentRuns.get(entry.runId)?.parentYieldWait;
  return (
    reconciled === "settled" &&
    current?.status === "closeout_delivered" &&
    current.waitId === wait.waitId &&
    current.parentRunId === wait.parentRunId &&
    current.parentSessionKey === wait.parentSessionKey
  );
}

export function registerSubagentRun(params: RegisterSubagentRunParams) {
  subagentRunManager.registerSubagentRun(params);
  const entry = subagentRuns.get(params.runId);
  if (entry) {
    emitSubagentStartedUpdate(entry);
  }
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  clearScheduledResumeTimers();
  for (const timer of resumeRetryTimers) {
    clearTimeout(timer);
  }
  resumeRetryTimers.clear();
  activeSteerRestarts.clear();
  subagentRuns.clear();
  resumedRuns.clear();
  endedHookInFlightRunIds.clear();
  clearAllPendingLifecycleErrors();
  clearAllPendingLifecycleTimeouts();
  subagentProgressRelayByRunId.clear();
  subagentFailureStreakByKey.clear();
  contextEngineInitLoader.clear();
  contextEngineRegistryLoader.clear();
  runtimePluginsLoader.clear();
  subagentAnnounceLoader.clear();
  browserCleanupLoader.clear();
  stopSweeper();
  sweepInProgress = false;
  restoreAttempted = false;
  parentYieldWaitRecovery = undefined;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  if (opts?.persist !== false) {
    persistSubagentRuns();
  }
}

export const testing = {
  async sweepOnceForTests() {
    await sweepSubagentRuns();
  },
  async completeSubagentRunForTests(params: CompleteSubagentRunParams) {
    await completeSubagentRunWithRecovery(params, "test");
  },
  setDepsForTest(overrides?: Partial<SubagentRegistryDeps>) {
    subagentRegistryDeps = overrides
      ? {
          ...defaultSubagentRegistryDeps,
          ...overrides,
        }
      : defaultSubagentRegistryDeps;
  },
} as const;

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}

export async function releaseSubagentRun(runId: string) {
  const entry = subagentRuns.get(runId);
  if (
    entry &&
    (isParentYieldCloseoutPending(entry) || !(await settleParentYieldWaitBeforeRestart(entry)))
  ) {
    return;
  }
  subagentRunManager.releaseSubagentRun(runId);
}

export async function finalizeInterruptedSubagentRun(params: {
  runId?: string;
  childSessionKey?: string;
  error: string;
  endedAt?: number;
}): Promise<number> {
  const runIds = new Set<string>();
  if (typeof params.runId === "string" && params.runId.trim()) {
    runIds.add(params.runId.trim());
  }
  if (typeof params.childSessionKey === "string" && params.childSessionKey.trim()) {
    const childSessionKey = params.childSessionKey.trim();
    for (const [runId, entry] of subagentRuns.entries()) {
      if (entry.childSessionKey === childSessionKey) {
        runIds.add(runId);
      }
    }
  }
  if (runIds.size === 0) {
    return 0;
  }

  const endedAt =
    typeof params.endedAt === "number" && Number.isFinite(params.endedAt)
      ? params.endedAt
      : Date.now();
  let updated = 0;
  for (const runId of runIds) {
    clearPendingLifecycleError(runId);
    clearPendingLifecycleTimeout(runId);
    const entry = subagentRuns.get(runId);
    if (!entry || typeof entry.cleanupCompletedAt === "number") {
      continue;
    }
    await completeSubagentRunWithRecovery(
      {
        runId,
        endedAt,
        outcome: {
          status: "error",
          error: params.error,
        },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
      },
      "explicit-failed-mark",
    );
    updated += 1;
  }
  return updated;
}

export function resolveRequesterForChildSession(childSessionKey: string): {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const runsSnapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
  const resolved = resolveRequesterForChildSessionFromRuns(runsSnapshot, childSessionKey);
  if (resolved === null) {
    return null;
  }
  const requesterOrigin = normalizeDeliveryContext(resolved.requesterOrigin);
  return {
    requesterSessionKey: resolved.requesterSessionKey,
    requesterOrigin,
  };
}

export function isSubagentSessionRunActive(childSessionKey: string): boolean {
  return isSubagentSessionRunActiveFromRuns(subagentRuns, childSessionKey);
}

export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function markSubagentRunTerminated(params: {
  runId?: string;
  childSessionKey?: string;
  reason?: string;
}): number {
  return subagentRunManager.markSubagentRunTerminated(params);
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: { requesterRunId?: string },
): SubagentRunRecord[] {
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

export function leasePendingAgentSteeringItems(params: {
  requesterSessionKey: string;
  leaseId: string;
  now?: number;
}) {
  void restoreSubagentRunsOnce();
  const leased = leasePendingAgentSteeringItemsFromSubagentRuns({
    runs: subagentRuns,
    requesterSessionKey: params.requesterSessionKey,
    leaseId: params.leaseId,
    now: params.now,
  });
  if (leased) {
    persistSubagentRuns();
  }
  return leased;
}

export function ackPendingAgentSteeringItems(params: {
  runIds: readonly string[];
  leaseId: string;
  now?: number;
}): number {
  const updated = ackLeasedAgentSteeringItemsFromSubagentRuns({
    runs: subagentRuns,
    runIds: params.runIds,
    leaseId: params.leaseId,
    now: params.now,
  });
  if (updated > 0) {
    persistSubagentRuns();
    for (const runId of params.runIds) {
      const entry = subagentRuns.get(runId);
      if (!entry || typeof entry.cleanupCompletedAt === "number") {
        continue;
      }
      entry.cleanupHandled = false;
      startSubagentAnnounceCleanupFlow(runId, entry);
    }
  }
  return updated;
}

export function releasePendingAgentSteeringItems(params: {
  runIds: readonly string[];
  leaseId: string;
  error?: string;
}): number {
  const updated = releaseLeasedAgentSteeringItemsFromSubagentRuns({
    runs: subagentRuns,
    runIds: params.runIds,
    leaseId: params.leaseId,
    error: params.error,
  });
  if (updated > 0) {
    persistSubagentRuns();
  }
  return updated;
}

export { prependAgentSteeringPrompt };

export function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    controllerSessionKey,
  );
}

export function countActiveRunsForSession(requesterSessionKey: string): number {
  return countActiveRunsForSessionFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    requesterSessionKey,
  );
}

export function countActiveDescendantRuns(rootSessionKey: string): number {
  return countActiveDescendantRunsFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function countPendingDescendantRuns(rootSessionKey: string): number {
  return countPendingDescendantRunsFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function countPendingDescendantRunsExcludingRun(
  rootSessionKey: string,
  excludeRunId: string,
): number {
  return countPendingDescendantRunsExcludingRunFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
    excludeRunId,
  );
}

export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  return getSubagentRunByChildSessionKeyFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latest: SubagentRunRecord | null = null;
  for (const entry of subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }

  return latest;
}

export function initSubagentRegistry(opts?: { gatewayStartup?: boolean }) {
  const alreadyRestored = restoreAttempted;
  const recovery = restoreSubagentRunsOnce();
  if (!opts?.gatewayStartup) {
    return recovery;
  }
  // In-process restarts preserve events but can lose an in-flight wake request.
  // Each Gateway lifecycle refreshes that wake after checking durable receipts.
  parentYieldWaitRecovery = Promise.resolve(recovery)
    .then(async () => {
      if (alreadyRestored) {
        await recoverRestoredParentYieldWaits();
      }
      recoverAbandonedSteerRestarts();
    })
    .catch((error: unknown) => {
      log.warn(`failed to recover parent yield waits at Gateway startup: ${String(error)}`);
    });
  return parentYieldWaitRecovery;
}

// Importing this module also registers the subagent maintenance preserve-key
// provider as a side effect (see subagent-registry-maintenance.ts).
export { listSessionMaintenanceProtectedSubagentSessionKeys } from "./subagent-registry-maintenance.js";
export { testing as __testing };
