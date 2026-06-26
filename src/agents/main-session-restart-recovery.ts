/**
 * Post-restart recovery for main sessions interrupted while holding a transcript lock.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import { resolveStateDir } from "../config/paths.js";
import {
  type SessionEntry,
  loadSessionStore,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
  updateSessionStore,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { readSessionMessagesAsync } from "../gateway/session-utils.fs.js";
import { resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import {
  listActiveWorkCheckpoints,
  updateActiveWorkCheckpointStatus,
  type ActiveWorkCheckpoint,
} from "./active-work-checkpoint.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";
import type { SessionLockInspection } from "./session-write-lock.js";

const log = createSubsystemLogger("main-session-restart-recovery");

const DEFAULT_RECOVERY_DELAY_MS = 5_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;
const UNRESUMABLE_SESSION_NOTICE =
  "I was interrupted by a gateway restart and couldn't safely resume the previous turn. " +
  "Please send that last request again and I'll pick it up cleanly.";

function shouldSkipMainRecovery(entry: SessionEntry, sessionKey: string): boolean {
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) {
    return true;
  }
  if (entry.subagentRole != null) {
    return true;
  }
  return (
    isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) || isAcpSessionKey(sessionKey)
  );
}

function normalizeStringSet(values: Iterable<string> | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return normalized;
}

function normalizeTranscriptLockPath(lockPath: string): string | undefined {
  const trimmed = lockPath.trim();
  if (!path.basename(trimmed).endsWith(".jsonl.lock")) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function resolveEntryTranscriptLockPaths(params: {
  entry: SessionEntry;
  sessionsDir: string;
}): string[] {
  const paths = new Set<string>();
  const push = (resolvePath: () => string) => {
    try {
      paths.add(path.resolve(`${resolvePath()}.lock`));
    } catch {
      // Keep restart recovery best-effort when session metadata is stale.
    }
  };
  push(() =>
    resolveSessionFilePath(params.entry.sessionId, params.entry, {
      sessionsDir: params.sessionsDir,
    }),
  );
  push(() => resolveSessionTranscriptPathInDir(params.entry.sessionId, params.sessionsDir));
  return [...paths];
}

export async function markRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  additionalCfgs?: Iterable<OpenClawConfig | undefined>;
  stateDir?: string;
  sessionKeys?: Iterable<string>;
  sessionIds?: Iterable<string>;
  reason?: string;
}): Promise<{ marked: number; skipped: number }> {
  const sessionKeys = normalizeStringSet(params.sessionKeys);
  const sessionIds = normalizeStringSet(params.sessionIds);
  const preferSessionIdMatch = sessionIds.size > 0;
  const result = { marked: 0, skipped: 0 };
  if (sessionKeys.size === 0 && sessionIds.size === 0) {
    return result;
  }

  const storePaths = new Set<string>();
  const env =
    params.stateDir === undefined
      ? process.env
      : { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const stateDir = resolveStateDir(env);
  const configs = [params.cfg, ...(params.additionalCfgs ?? [])].filter(
    (cfg): cfg is OpenClawConfig => Boolean(cfg),
  );
  for (const cfg of configs) {
    try {
      for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
        storePaths.add(path.resolve(target.storePath));
      }
    } catch (err) {
      log.warn(`failed to resolve configured session stores for restart marker: ${String(err)}`);
    }
    for (const sessionKey of sessionKeys) {
      try {
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key: sessionKey,
          scanLegacyKeys: true,
        });
        storePaths.add(path.resolve(target.storePath));
        for (const storeKey of target.storeKeys) {
          const trimmed = storeKey.trim();
          if (trimmed) {
            sessionKeys.add(trimmed);
          }
        }
      } catch (err) {
        log.warn(
          `failed to resolve session store for restart marker ${sessionKey}: ${String(err)}`,
        );
      }
    }
  }

  for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
    storePaths.add(path.join(sessionsDir, "sessions.json"));
  }

  for (const storePath of storePaths) {
    await updateSessionStore(
      storePath,
      (store) => {
        for (const [sessionKey, entry] of Object.entries(store)) {
          if (!entry || entry.status !== "running") {
            continue;
          }
          const matches =
            typeof entry.sessionId === "string" && sessionIds.has(entry.sessionId)
              ? true
              : !preferSessionIdMatch && sessionKeys.has(sessionKey);
          if (!matches) {
            continue;
          }
          if (shouldSkipMainRecovery(entry, sessionKey)) {
            result.skipped++;
            continue;
          }
          entry.abortedLastRun = true;
          entry.updatedAt = Date.now();
          store[sessionKey] = entry;
          result.marked++;
        }
      },
      { skipMaintenance: true },
    );
  }

  if (result.marked > 0) {
    log.warn(
      `marked ${result.marked} interrupted main session(s) for restart recovery${
        params.reason ? ` (${params.reason})` : ""
      }`,
    );
  }
  return result;
}

function getMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function isMeaningfulTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  if (!role || role === "system") {
    return false;
  }
  return true;
}

function isResumableTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  return role === "user" || role === "tool" || role === "toolResult";
}

function isApprovalPendingToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "toolResult") {
    return false;
  }
  const details = (message as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return false;
  }
  return (details as { status?: unknown }).status === "approval-pending";
}

function resolveMainSessionResumeBlockReason(messages: unknown[]): string | null {
  const lastMeaningful = messages.toReversed().find(isMeaningfulTailMessage);
  if (!lastMeaningful || !isResumableTailMessage(lastMeaningful)) {
    return "transcript tail is not resumable";
  }
  if (isApprovalPendingToolResult(lastMeaningful)) {
    return "transcript tail is a stale approval-pending tool result";
  }
  return null;
}

function buildResumeMessage(pendingFinalDeliveryText?: string | null): string {
  const base =
    "[System] Your previous turn was interrupted by a gateway restart while " +
    "OpenClaw was waiting on tool/model work. Continue from the existing " +
    "transcript and finish the interrupted response.";
  const sanitizedPendingText =
    typeof pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(pendingFinalDeliveryText)
      : "";
  if (sanitizedPendingText) {
    return `${base}\n\nNote: The interrupted final reply was captured: "${sanitizedPendingText}"`;
  }
  return base;
}

function buildCheckpointResumeMessage(checkpoint: ActiveWorkCheckpoint): string {
  return [
    "[System] The previous turn was interrupted by a gateway restart.",
    "A structured restart checkpoint is available. Continue only from this safe checkpoint state.",
    `Checkpoint: ${checkpoint.checkpointId}`,
    `Objective: ${checkpoint.activeObjective}`,
    `Current phase: ${checkpoint.currentPhase}`,
    `Last completed proof: ${checkpoint.lastCompletedProof}`,
    `Next validation step: ${checkpoint.nextValidationStep}`,
    `Stop conditions: ${checkpoint.stopConditions.join("; ")}`,
    "Do not run destructive operations after restart. If continuation needs destructive work, report blocked and ask for operator review.",
  ].join("\n");
}

function buildCheckpointBlockedNotice(params: {
  checkpoint: ActiveWorkCheckpoint;
  reason: string;
}): string {
  return [
    "Gateway restart recovery found a structured checkpoint but could not auto-resume safely.",
    `Checkpoint: ${params.checkpoint.checkpointId}`,
    `Reason: ${params.reason}`,
    `Next validation step: ${params.checkpoint.nextValidationStep}`,
    "Operator review is required before continuing.",
  ].join("\n");
}

async function markSessionFailed(params: {
  storePath: string;
  sessionKey: string;
  reason: string;
}): Promise<void> {
  await updateSessionStore(
    params.storePath,
    (store) => {
      const entry = store[params.sessionKey];
      if (!entry || entry.status !== "running") {
        return;
      }
      entry.status = "failed";
      entry.abortedLastRun = true;
      entry.endedAt = Date.now();
      entry.updatedAt = entry.endedAt;
      entry.pendingFinalDelivery = undefined;
      entry.pendingFinalDeliveryText = undefined;
      entry.pendingFinalDeliveryCreatedAt = undefined;
      entry.pendingFinalDeliveryLastAttemptAt = undefined;
      entry.pendingFinalDeliveryAttemptCount = undefined;
      entry.pendingFinalDeliveryLastError = undefined;
      entry.pendingFinalDeliveryContext = undefined;
      entry.restartRecoveryDeliveryContext = undefined;
      entry.restartRecoveryDeliveryRunId = undefined;
      store[params.sessionKey] = entry;
    },
    { skipMaintenance: true },
  );
  log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
}

async function sendUnresumableSessionNotice(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  reason: string;
  sessionKey: string;
}): Promise<boolean> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  if (!deliveryContext) {
    return false;
  }

  const messageParams: Record<string, unknown> = {
    to: deliveryContext.to,
    message: UNRESUMABLE_SESSION_NOTICE,
    bestEffort: true,
  };
  if (deliveryContext?.threadId != null) {
    messageParams.threadId = deliveryContext.threadId;
  }
  const actionParams: Record<string, unknown> = {
    channel: deliveryContext.channel,
    action: "send",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    idempotencyKey: `main-session-restart-recovery:${params.entry.sessionId}:failed-notice`,
    params: messageParams,
  };
  const accountId = normalizeOptionalString(deliveryContext?.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }

  try {
    await callGateway({
      method: "message.action",
      params: actionParams,
      timeoutMs: 10_000,
    });
    log.info(
      `sent interrupted main session recovery notice: ${params.sessionKey} (${params.reason})`,
    );
    return true;
  } catch (err) {
    log.warn(
      `failed to send interrupted main session recovery notice ${params.sessionKey}: ${String(err)}`,
    );
    return false;
  }
}

function resolveRestartRecoveryDeliveryContext(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  checkpoint?: ActiveWorkCheckpoint;
  includeSessionDeliveryFallback?: boolean;
  sessionKey: string;
}): DeliveryContext | undefined {
  const deliveryContext =
    normalizeDeliveryContext(params.checkpoint?.deliveryContext) ??
    normalizeDeliveryContext(params.entry.pendingFinalDeliveryContext) ??
    normalizeDeliveryContext(params.entry.restartRecoveryDeliveryContext) ??
    (params.includeSessionDeliveryFallback ? deliveryContextFromSession(params.entry) : undefined);
  const channel = normalizeOptionalString(deliveryContext?.channel);
  const to = normalizeOptionalString(deliveryContext?.to);
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  if (
    params.cfg &&
    resolveSendPolicy({
      cfg: params.cfg,
      entry: params.entry,
      sessionKey: params.sessionKey,
      channel,
      chatType: params.entry.chatType,
    }) === "deny"
  ) {
    return undefined;
  }
  return {
    ...deliveryContext,
    channel,
    to,
  };
}

async function resumeMainSession(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  storePath: string;
  sessionKey: string;
  checkpoint?: ActiveWorkCheckpoint;
  pendingFinalDeliveryText?: string | null;
}): Promise<boolean> {
  const sanitizedPendingText =
    typeof params.pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(params.pendingFinalDeliveryText)
      : "";
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    checkpoint: params.checkpoint,
    sessionKey: params.sessionKey,
  });
  try {
    const agentParams: Record<string, unknown> = {
      message: params.checkpoint
        ? buildCheckpointResumeMessage(params.checkpoint)
        : buildResumeMessage(sanitizedPendingText),
      sessionKey: params.sessionKey,
      idempotencyKey: crypto.randomUUID(),
      deliver: Boolean(deliveryContext),
      lane: CommandLane.Main,
    };
    if (deliveryContext) {
      agentParams.channel = deliveryContext.channel;
      agentParams.to = deliveryContext.to;
      agentParams.bestEffortDeliver = true;
      if (deliveryContext.accountId) {
        agentParams.accountId = deliveryContext.accountId;
      }
      if (deliveryContext.threadId != null) {
        agentParams.threadId = String(deliveryContext.threadId);
      }
    }
    await callGateway<{ runId: string }>({
      method: "agent",
      params: agentParams,
      timeoutMs: 10_000,
    });
    await updateSessionStore(
      params.storePath,
      (store) => {
        const entry = store[params.sessionKey];
        if (!entry) {
          return;
        }
        const now = Date.now();
        entry.abortedLastRun = false;
        entry.updatedAt = now;
        if (entry.pendingFinalDelivery || entry.pendingFinalDeliveryText) {
          if (sanitizedPendingText) {
            entry.pendingFinalDeliveryLastAttemptAt = now;
            entry.pendingFinalDeliveryAttemptCount =
              (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
            entry.pendingFinalDeliveryLastError = null;
            entry.pendingFinalDeliveryText = sanitizedPendingText;
          } else {
            entry.pendingFinalDelivery = undefined;
            entry.pendingFinalDeliveryText = undefined;
            entry.pendingFinalDeliveryCreatedAt = undefined;
            entry.pendingFinalDeliveryLastAttemptAt = undefined;
            entry.pendingFinalDeliveryAttemptCount = undefined;
            entry.pendingFinalDeliveryLastError = undefined;
            entry.pendingFinalDeliveryContext = undefined;
          }
        }
        store[params.sessionKey] = entry;
      },
      { skipMaintenance: true },
    );
    log.info(
      `resumed interrupted main session: ${params.sessionKey}${
        params.checkpoint
          ? ` (checkpoint=${params.checkpoint.checkpointId})`
          : sanitizedPendingText
            ? " (with pending payload)"
            : ""
      }`,
    );
    return true;
  } catch (err) {
    log.warn(`failed to resume interrupted main session ${params.sessionKey}: ${String(err)}`);
    return false;
  }
}

async function sendCheckpointBlockedNotice(params: {
  cfg?: OpenClawConfig;
  checkpoint: ActiveWorkCheckpoint;
  entry: SessionEntry;
  reason: string;
  sessionKey: string;
}): Promise<boolean> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    checkpoint: params.checkpoint,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  if (!deliveryContext) {
    return false;
  }
  const messageParams: Record<string, unknown> = {
    to: deliveryContext.to,
    message: buildCheckpointBlockedNotice({
      checkpoint: params.checkpoint,
      reason: params.reason,
    }),
    bestEffort: true,
  };
  if (deliveryContext.threadId != null) {
    messageParams.threadId = deliveryContext.threadId;
  }
  const actionParams: Record<string, unknown> = {
    channel: deliveryContext.channel,
    action: "send",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    idempotencyKey: `main-session-restart-checkpoint:${params.checkpoint.checkpointId}:blocked`,
    params: messageParams,
  };
  const accountId = normalizeOptionalString(deliveryContext.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }
  try {
    await callGateway({
      method: "message.action",
      params: actionParams,
      timeoutMs: 10_000,
    });
    return true;
  } catch (err) {
    log.warn(
      `failed to send checkpoint blocked notice ${params.checkpoint.checkpointId}: ${String(err)}`,
    );
    return false;
  }
}

export async function markRestartAbortedMainSessionsFromLocks(params: {
  sessionsDir: string;
  cleanedLocks: SessionLockInspection[];
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const sessionsDir = path.resolve(params.sessionsDir);
  const interruptedLockPaths = new Set(
    params.cleanedLocks
      .map((lock) => normalizeTranscriptLockPath(lock.lockPath))
      .filter((lockPath): lockPath is string => Boolean(lockPath)),
  );
  if (interruptedLockPaths.size === 0) {
    return result;
  }

  const storePath = path.join(sessionsDir, "sessions.json");
  await updateSessionStore(
    storePath,
    (store) => {
      for (const [sessionKey, entry] of Object.entries(store)) {
        if (!entry || entry.status !== "running") {
          continue;
        }
        if (shouldSkipMainRecovery(entry, sessionKey)) {
          result.skipped++;
          continue;
        }
        const entryLockPaths = resolveEntryTranscriptLockPaths({ entry, sessionsDir });
        if (!entryLockPaths.some((lockPath) => interruptedLockPaths.has(lockPath))) {
          continue;
        }
        entry.abortedLastRun = true;
        store[sessionKey] = entry;
        result.marked++;
      }
    },
    { skipMaintenance: true },
  );

  if (result.marked > 0) {
    log.warn(`marked ${result.marked} interrupted main session(s) from stale transcript locks`);
  }
  return result;
}

async function recoverStore(params: {
  cfg?: OpenClawConfig;
  storePath: string;
  resumedSessionKeys: Set<string>;
  checkpoints: ActiveWorkCheckpoint[];
  stateDir?: string;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(params.storePath);
  } catch (err) {
    log.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const [sessionKey, entry] of Object.entries(store).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!entry || entry.status !== "running" || entry.abortedLastRun !== true) {
      continue;
    }
    if (shouldSkipMainRecovery(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    if (params.resumedSessionKeys.has(sessionKey)) {
      result.skipped++;
      continue;
    }

    const checkpoint = params.checkpoints.find((candidate) =>
      candidate.status === "pending" || candidate.status === "expired"
        ? (candidate.sessionKey && candidate.sessionKey === sessionKey) ||
          (candidate.sessionId && candidate.sessionId === entry.sessionId)
        : false,
    );
    if (checkpoint) {
      if (checkpoint.status === "expired") {
        await sendCheckpointBlockedNotice({
          cfg: params.cfg,
          checkpoint,
          entry,
          reason: "restart checkpoint expired before startup recovery could safely continue",
          sessionKey,
        });
        await updateActiveWorkCheckpointStatus({
          checkpoint,
          status: "expired",
          reason: "checkpoint expired before restart recovery",
          stateDir: params.stateDir,
        });
        result.failed++;
        continue;
      }
      if (!checkpoint.safeToAutoResume || checkpoint.requiresOperatorReview) {
        const reason =
          checkpoint.unsafeAutoResumeReason ??
          "checkpoint requires operator review before continuation";
        await sendCheckpointBlockedNotice({
          cfg: params.cfg,
          checkpoint,
          entry,
          reason,
          sessionKey,
        });
        await updateActiveWorkCheckpointStatus({
          checkpoint,
          status: "blocked",
          reason,
          stateDir: params.stateDir,
        });
        result.failed++;
        continue;
      }
      const resumed = await resumeMainSession({
        cfg: params.cfg,
        entry,
        storePath: params.storePath,
        sessionKey,
        checkpoint,
      });
      if (resumed) {
        await updateActiveWorkCheckpointStatus({
          checkpoint,
          status: "continued",
          reason: "restart recovery queued continuation",
          stateDir: params.stateDir,
        });
        params.resumedSessionKeys.add(sessionKey);
        result.recovered++;
      } else {
        await updateActiveWorkCheckpointStatus({
          checkpoint,
          status: "blocked",
          reason: "failed to queue restart continuation",
          stateDir: params.stateDir,
        });
        result.failed++;
      }
      continue;
    }

    let messages: unknown[];
    try {
      messages = await readSessionMessagesAsync(
        entry.sessionId,
        params.storePath,
        entry.sessionFile,
        {
          mode: "recent",
          maxMessages: 20,
          maxBytes: 256 * 1024,
        },
      );
    } catch (err) {
      log.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    const resumeBlockReason = resolveMainSessionResumeBlockReason(messages);
    if (resumeBlockReason) {
      await sendUnresumableSessionNotice({
        cfg: params.cfg,
        entry,
        sessionKey,
        reason: resumeBlockReason,
      });
      await markSessionFailed({
        storePath: params.storePath,
        sessionKey,
        reason: resumeBlockReason,
      });
      result.failed++;
      continue;
    }

    const resumed = await resumeMainSession({
      cfg: params.cfg,
      entry,
      storePath: params.storePath,
      sessionKey,
      pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
    });
    if (resumed) {
      params.resumedSessionKeys.add(sessionKey);
      result.recovered++;
    } else {
      result.failed++;
    }
  }

  return result;
}

async function resolveRestartRecoveryStorePaths(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
}): Promise<string[]> {
  const storePaths = new Set<string>();
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
    storePaths.add(path.join(sessionsDir, "sessions.json"));
  }
  if (params.cfg) {
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env })) {
      storePaths.add(path.resolve(target.storePath));
    }
  }
  return [...storePaths].toSorted((a, b) => a.localeCompare(b));
}

export async function recoverRestartAbortedMainSessions(
  params: {
    cfg?: OpenClawConfig;
    stateDir?: string;
    resumedSessionKeys?: Set<string>;
  } = {},
): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();
  const checkpoints = await listActiveWorkCheckpoints({
    stateDir: params.stateDir,
  });

  for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
    const storeResult = await recoverStore({
      cfg: params.cfg,
      storePath,
      resumedSessionKeys,
      checkpoints,
      stateDir: params.stateDir,
    });
    result.recovered += storeResult.recovered;
    result.failed += storeResult.failed;
    result.skipped += storeResult.skipped;
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `main-session restart recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  return result;
}

export function scheduleRestartAbortedMainSessionRecovery(
  params: {
    cfg?: OpenClawConfig;
    delayMs?: number;
    maxRetries?: number;
    stateDir?: string;
  } = {},
): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();

  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      void recoverRestartAbortedMainSessions({
        cfg: params.cfg,
        stateDir: params.stateDir,
        resumedSessionKeys,
      })
        .then((result) => {
          if (result.failed > 0 && attempt < maxRetries) {
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          }
        })
        .catch((err: unknown) => {
          if (attempt < maxRetries) {
            log.warn(`main-session restart recovery failed: ${String(err)}`);
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          } else {
            log.warn(`main-session restart recovery gave up: ${String(err)}`);
          }
        });
    }, delay).unref?.();
  };

  attemptRecovery(1, initialDelay);
}
