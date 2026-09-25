/**
 * Post-restart recovery for main sessions interrupted while holding a transcript lock.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
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
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
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
import {
  createSourceTurnDeliveryQueueOwnerReference,
  loadSourceTurnDeliveryRegistry,
  settleSourceTurnDeliveryFinal,
} from "./source-turn-delivery-store.js";

const log = createSubsystemLogger("main-session-restart-recovery");

const DEFAULT_RECOVERY_DELAY_MS = 30_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;
const RECOVERY_STATUS_FILENAME = "main-session-restart-recovery-status.json";
const UNRESUMABLE_SESSION_NOTICE =
  "I was interrupted by a gateway restart and couldn't safely resume the previous turn. " +
  "Please send that last request again and I'll pick it up cleanly.";

function formatRestartRecoveryPerfMs(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "n/a";
}

export type MainSessionRestartRecoveryStatus =
  | "marked"
  | "queued"
  | "continued"
  | "blocked"
  | "failed"
  | "superseded";

export type MainSessionRestartRecoveryStatusRecord = {
  sessionKey: string;
  sessionId?: string;
  markedAt: number;
  updatedAt: number;
  status: MainSessionRestartRecoveryStatus;
  runId?: string;
  reason?: string;
  transcriptTailRole?: string;
  deliveryAttempted: boolean;
  deliverySucceeded: boolean;
  artifactPath?: string;
};

export type MainSessionRestartRecoveryAccounting = {
  scannedCheckpoints: number;
  candidateSessions: number;
  ineligibleSessions: number;
  ineligibleRunningWithoutAbortMarker: number;
  ineligibleNonRunningSessions: number;
  skippedNonMainSessions: number;
  recoveredSessions: number;
  failedSessions: number;
  skippedSessions: number;
};

export type MainSessionRestartRecoveryResult = {
  recovered: number;
  failed: number;
  skipped: number;
  accounting?: MainSessionRestartRecoveryAccounting;
};

type MainSessionRestartRecoveryStatusStore = {
  version: 1;
  records: MainSessionRestartRecoveryStatusRecord[];
};

function createRestartRecoveryAccounting(
  scannedCheckpoints = 0,
): MainSessionRestartRecoveryAccounting {
  return {
    scannedCheckpoints,
    candidateSessions: 0,
    ineligibleSessions: 0,
    ineligibleRunningWithoutAbortMarker: 0,
    ineligibleNonRunningSessions: 0,
    skippedNonMainSessions: 0,
    recoveredSessions: 0,
    failedSessions: 0,
    skippedSessions: 0,
  };
}

function addRestartRecoveryAccounting(
  target: MainSessionRestartRecoveryAccounting,
  source: MainSessionRestartRecoveryAccounting,
): void {
  target.scannedCheckpoints += source.scannedCheckpoints;
  target.candidateSessions += source.candidateSessions;
  target.ineligibleSessions += source.ineligibleSessions;
  target.ineligibleRunningWithoutAbortMarker += source.ineligibleRunningWithoutAbortMarker;
  target.ineligibleNonRunningSessions += source.ineligibleNonRunningSessions;
  target.skippedNonMainSessions += source.skippedNonMainSessions;
  target.recoveredSessions += source.recoveredSessions;
  target.failedSessions += source.failedSessions;
  target.skippedSessions += source.skippedSessions;
}

function resolveRecoveryStatusPath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, RECOVERY_STATUS_FILENAME);
}

async function readRecoveryStatusStore(
  stateDir?: string,
): Promise<MainSessionRestartRecoveryStatusStore> {
  try {
    const raw = await fs.promises.readFile(resolveRecoveryStatusPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<MainSessionRestartRecoveryStatusStore>;
    if (parsed.version === 1 && Array.isArray(parsed.records)) {
      return {
        version: 1,
        records: parsed.records.filter(
          (record): record is MainSessionRestartRecoveryStatusRecord =>
            Boolean(record) &&
            typeof record === "object" &&
            typeof record.sessionKey === "string" &&
            typeof record.markedAt === "number" &&
            typeof record.updatedAt === "number" &&
            typeof record.status === "string",
        ),
      };
    }
  } catch {
    // missing or corrupt status files are treated as empty; session stores remain canonical.
  }
  return { version: 1, records: [] };
}

async function writeRecoveryStatusStore(
  store: MainSessionRestartRecoveryStatusStore,
  stateDir?: string,
): Promise<void> {
  const filePath = resolveRecoveryStatusPath(stateDir);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(tempPath, filePath);
}

async function updateRecoveryStatus(params: {
  stateDir?: string;
  sessionKey: string;
  sessionId?: string;
  status: MainSessionRestartRecoveryStatus;
  reason?: string;
  runId?: string;
  transcriptTailRole?: string;
  deliveryAttempted?: boolean;
  deliverySucceeded?: boolean;
  artifactPath?: string;
}): Promise<MainSessionRestartRecoveryStatusRecord> {
  const now = Date.now();
  const store = await readRecoveryStatusStore(params.stateDir);
  const index = store.records.findIndex((record) => record.sessionKey === params.sessionKey);
  const previous = index >= 0 ? store.records[index] : undefined;
  const next: MainSessionRestartRecoveryStatusRecord = {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId ?? previous?.sessionId,
    markedAt: previous?.markedAt ?? now,
    updatedAt: now,
    status: params.status,
    runId: params.runId ?? previous?.runId,
    reason: params.reason ?? previous?.reason,
    transcriptTailRole: params.transcriptTailRole ?? previous?.transcriptTailRole,
    deliveryAttempted: params.deliveryAttempted ?? previous?.deliveryAttempted ?? false,
    deliverySucceeded: params.deliverySucceeded ?? previous?.deliverySucceeded ?? false,
    artifactPath: params.artifactPath ?? previous?.artifactPath,
  };
  if (index >= 0) {
    store.records[index] = next;
  } else {
    store.records.push(next);
  }
  await writeRecoveryStatusStore(store, params.stateDir);
  return next;
}

export async function readMainSessionRestartRecoveryStatus(params: {
  sessionKey: string;
  stateDir?: string;
}): Promise<MainSessionRestartRecoveryStatusRecord | null> {
  const store = await readRecoveryStatusStore(params.stateDir);
  return store.records.find((record) => record.sessionKey === params.sessionKey) ?? null;
}

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
    const markedStatuses: Array<{ sessionKey: string; sessionId?: string }> = [];
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
          markedStatuses.push({ sessionKey, sessionId: entry.sessionId });
        }
      },
      { skipMaintenance: true },
    );
    for (const marked of markedStatuses) {
      await updateRecoveryStatus({
        stateDir,
        sessionKey: marked.sessionKey,
        sessionId: marked.sessionId,
        status: "marked",
        reason: params.reason ?? "restart interrupted active main session",
      });
    }
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
  if (!lastMeaningful) {
    return "transcript tail is not resumable";
  }
  if (getMessageRole(lastMeaningful) === "assistant") {
    return "restart interrupted assistant/tool-call turn before a safe checkpoint";
  }
  if (!isResumableTailMessage(lastMeaningful)) {
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
    "The restart command may already have performed its side effect. Do not treat aborted, timed-out, or transport-lost tool output as proof that nothing happened.",
    `Checkpoint: ${checkpoint.checkpointId}`,
    `Objective: ${checkpoint.activeObjective}`,
    `Current phase: ${checkpoint.currentPhase}`,
    `Last completed proof: ${checkpoint.lastCompletedProof}`,
    `Next validation step: ${checkpoint.nextValidationStep}`,
    `Stop conditions: ${checkpoint.stopConditions.join("; ")}`,
    "Before any final report, verify the target live state and write or cite a current-truth closeout/blocker artifact for the interrupted side effect.",
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
  stateDir?: string;
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
    const queued = await callGateway<{ runId: string }>({
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
        entry.restartRecoveryDeliveryRunId = queued.runId;
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
      } runId=${queued.runId} deliver=${Boolean(deliveryContext)}`,
    );
    await updateRecoveryStatus({
      stateDir: params.stateDir,
      sessionKey: params.sessionKey,
      sessionId: params.entry.sessionId,
      status: "queued",
      runId: queued.runId,
      reason: params.checkpoint
        ? "restart recovery queued checkpoint continuation"
        : "restart recovery queued continuation",
      deliveryAttempted: Boolean(deliveryContext),
      deliverySucceeded: Boolean(deliveryContext),
    });
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
  const inferredStateDir = path.resolve(sessionsDir, "..", "..", "..");
  const markedStatuses: Array<{ sessionKey: string; sessionId?: string }> = [];
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
        markedStatuses.push({ sessionKey, sessionId: entry.sessionId });
      }
    },
    { skipMaintenance: true },
  );
  for (const marked of markedStatuses) {
    await updateRecoveryStatus({
      stateDir: inferredStateDir,
      sessionKey: marked.sessionKey,
      sessionId: marked.sessionId,
      status: "marked",
      reason: "restart interrupted session transcript lock",
    });
  }

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
  preparedSourceSessionKeys?: Set<string>;
  sourceRegistryUnavailable?: boolean;
}): Promise<
  MainSessionRestartRecoveryResult & { accounting: MainSessionRestartRecoveryAccounting }
> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const accounting = createRestartRecoveryAccounting();
  const started = performance.now();
  log.info(`scanning restart recovery store: ${params.storePath}`);
  let store: Record<string, SessionEntry>;
  let storeBytes: number | undefined;
  try {
    try {
      storeBytes = fs.statSync(params.storePath).size;
    } catch {
      storeBytes = undefined;
    }
    store = loadSessionStore(params.storePath);
  } catch (err) {
    log.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    accounting.failedSessions++;
    return { ...result, accounting };
  }

  const entries = Object.entries(store).toSorted(([a], [b]) => a.localeCompare(b));
  let candidateRows = 0;
  for (const [sessionKey, entry] of entries) {
    if (!entry) {
      accounting.ineligibleSessions++;
      accounting.ineligibleNonRunningSessions++;
      continue;
    }
    if (entry.status !== "running") {
      accounting.ineligibleSessions++;
      accounting.ineligibleNonRunningSessions++;
      continue;
    }
    const pendingChannel =
      entry.pendingFinalDeliveryContext?.channel ??
      entry.deliveryContext?.channel ??
      entry.lastChannel;
    if (
      params.preparedSourceSessionKeys?.has(sessionKey) ||
      (params.sourceRegistryUnavailable &&
        (entry.pendingFinalDelivery === true || Boolean(entry.pendingFinalDeliveryText)) &&
        (!pendingChannel || !isDeliverableMessageChannel(pendingChannel)))
    ) {
      // A durable source final owns this turn even when a stale lock also
      // marked it aborted. If its registry is unreadable, a pending final
      // cannot safely be distinguished from one already prepared.
      result.skipped++;
      accounting.skippedSessions++;
      continue;
    }
    if (entry.abortedLastRun !== true) {
      accounting.ineligibleSessions++;
      accounting.ineligibleRunningWithoutAbortMarker++;
      continue;
    }
    candidateRows++;
    accounting.candidateSessions++;
    if (shouldSkipMainRecovery(entry, sessionKey)) {
      log.info(`skipped interrupted main session recovery: ${sessionKey} (non-main session)`);
      result.skipped++;
      accounting.skippedSessions++;
      accounting.skippedNonMainSessions++;
      continue;
    }
    if (params.resumedSessionKeys.has(sessionKey)) {
      log.info(`skipped interrupted main session recovery: ${sessionKey} (already resumed)`);
      result.skipped++;
      accounting.skippedSessions++;
      continue;
    }
    log.info(`selected interrupted main session for restart recovery: ${sessionKey}`);

    const checkpoint = params.checkpoints.find((candidate) =>
      candidate.status === "pending" || candidate.status === "expired"
        ? (candidate.sessionKey && candidate.sessionKey === sessionKey) ||
          (candidate.sessionId && candidate.sessionId === entry.sessionId)
        : false,
    );
    if (checkpoint) {
      if (checkpoint.status === "expired") {
        const deliveredNotice = await sendCheckpointBlockedNotice({
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
        await updateRecoveryStatus({
          stateDir: params.stateDir,
          sessionKey,
          sessionId: entry.sessionId,
          status: deliveredNotice ? "blocked" : "failed",
          reason: "restart checkpoint expired before startup recovery could safely continue",
          transcriptTailRole: "checkpoint",
          deliveryAttempted: true,
          deliverySucceeded: deliveredNotice,
        });
        result.failed++;
        accounting.failedSessions++;
        continue;
      }
      if (!checkpoint.safeToAutoResume || checkpoint.requiresOperatorReview) {
        const reason =
          checkpoint.unsafeAutoResumeReason ??
          "checkpoint requires operator review before continuation";
        const deliveredNotice = await sendCheckpointBlockedNotice({
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
        await updateRecoveryStatus({
          stateDir: params.stateDir,
          sessionKey,
          sessionId: entry.sessionId,
          status: deliveredNotice ? "blocked" : "failed",
          reason,
          transcriptTailRole: "checkpoint",
          deliveryAttempted: true,
          deliverySucceeded: deliveredNotice,
        });
        result.failed++;
        accounting.failedSessions++;
        continue;
      }
      const resumed = await resumeMainSession({
        cfg: params.cfg,
        entry,
        stateDir: params.stateDir,
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
        accounting.recoveredSessions++;
      } else {
        await updateActiveWorkCheckpointStatus({
          checkpoint,
          status: "blocked",
          reason: "failed to queue restart continuation",
          stateDir: params.stateDir,
        });
        await updateRecoveryStatus({
          stateDir: params.stateDir,
          sessionKey,
          sessionId: entry.sessionId,
          status: "failed",
          reason: "failed to queue restart continuation",
          transcriptTailRole: "checkpoint",
          deliveryAttempted: false,
          deliverySucceeded: false,
        });
        result.failed++;
        accounting.failedSessions++;
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
      accounting.failedSessions++;
      continue;
    }

    const resumeBlockReason = resolveMainSessionResumeBlockReason(messages);
    if (resumeBlockReason) {
      const tailRole = getMessageRole(messages.toReversed().find(isMeaningfulTailMessage));
      const deliveredNotice = await sendUnresumableSessionNotice({
        cfg: params.cfg,
        entry,
        sessionKey,
        reason: resumeBlockReason,
      });
      await updateRecoveryStatus({
        stateDir: params.stateDir,
        sessionKey,
        sessionId: entry.sessionId,
        status: deliveredNotice ? "blocked" : "failed",
        reason: resumeBlockReason,
        transcriptTailRole: tailRole,
        deliveryAttempted: true,
        deliverySucceeded: deliveredNotice,
      });
      await markSessionFailed({
        storePath: params.storePath,
        sessionKey,
        reason: resumeBlockReason,
      });
      result.failed++;
      accounting.failedSessions++;
      continue;
    }

    const resumed = await resumeMainSession({
      cfg: params.cfg,
      entry,
      stateDir: params.stateDir,
      storePath: params.storePath,
      sessionKey,
      pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
    });
    if (resumed) {
      params.resumedSessionKeys.add(sessionKey);
      result.recovered++;
      accounting.recoveredSessions++;
    } else {
      await updateRecoveryStatus({
        stateDir: params.stateDir,
        sessionKey,
        sessionId: entry.sessionId,
        status: "failed",
        reason: "failed to queue restart continuation",
        deliveryAttempted: false,
        deliverySucceeded: false,
      });
      result.failed++;
      accounting.failedSessions++;
    }
  }

  const durationMs = performance.now() - started;
  if (durationMs >= 250 || candidateRows > 0) {
    const message =
      `[perf:main-session-restart-recovery] storePath=${JSON.stringify(params.storePath)} ` +
      `durationMs=${formatRestartRecoveryPerfMs(durationMs)} storeBytes=${storeBytes ?? "unknown"} ` +
      `storeEntries=${entries.length} candidateRows=${candidateRows} ineligible=${accounting.ineligibleSessions} ` +
      `runningWithoutAbortMarker=${accounting.ineligibleRunningWithoutAbortMarker} ` +
      `nonRunning=${accounting.ineligibleNonRunningSessions} nonMain=${accounting.skippedNonMainSessions} ` +
      `recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`;
    if (durationMs >= 1_000) {
      log.warn(message);
    } else {
      log.info(message);
    }
  }
  return { ...result, accounting };
}

async function resolveRestartRecoveryStorePaths(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
}): Promise<string[]> {
  const started = performance.now();
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
  const resolved = [...storePaths].toSorted((a, b) => a.localeCompare(b));
  const durationMs = performance.now() - started;
  if (durationMs >= 250 || resolved.length > 0) {
    log.info(
      `[perf:main-session-restart-recovery] phase=resolve_store_paths durationMs=${formatRestartRecoveryPerfMs(
        durationMs,
      )} storePathCount=${resolved.length}`,
    );
  }
  return resolved;
}

/** Finish immutable WebChat finals that were prepared after model work released its lock. */
export async function recoverPreparedWebchatSourceFinals(
  params: {
    cfg?: OpenClawConfig;
    stateDir?: string;
    registryPath?: string;
    ownedSessionKeys?: Set<string>;
  } = {},
): Promise<{ recovered: number; failed: number }> {
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const registryPath =
    params.registryPath ??
    process.env.OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH ??
    resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
  const registry = await loadSourceTurnDeliveryRegistry(registryPath);
  const storePaths = await resolveRestartRecoveryStorePaths(params);
  const result = { recovered: 0, failed: 0 };
  const clearRecoveredSession = async (
    storePath: string,
    sessionKey: string,
    sessionId: string,
    expectedCreatedAt: number,
  ) => {
    await updateSessionStore(
      storePath,
      (store) => {
        const entry = store[sessionKey];
        if (
          entry?.sessionId !== sessionId ||
          entry.pendingFinalDeliveryCreatedAt !== expectedCreatedAt ||
          entry.pendingFinalDelivery !== true
        ) {
          return;
        }
        entry.pendingFinalDelivery = undefined;
        entry.pendingFinalDeliveryText = undefined;
        entry.pendingFinalDeliveryCreatedAt = undefined;
        entry.pendingFinalDeliveryLastAttemptAt = undefined;
        entry.pendingFinalDeliveryAttemptCount = undefined;
        entry.pendingFinalDeliveryLastError = undefined;
        entry.pendingFinalDeliveryContext = undefined;
        entry.abortedLastRun = false;
        entry.updatedAt = Date.now();
      },
      { skipMaintenance: true },
    );
  };
  for (const row of registry.rows) {
    const prepared = row.preparedSourceFinal;
    if (
      row.sourceChannel !== "webchat" ||
      row.deliveryContext?.channel !== "webchat" ||
      row.parentYieldWaits?.length ||
      row.obligationIdentity.deliveryId ||
      !row.obligationIdentity.runId ||
      !row.sourceSessionKey ||
      prepared?.kind !== "source_session_transcript" ||
      !prepared.pendingFinalDeliveryCreatedAt ||
      prepared.parts.length !== prepared.expectedPartCount
    ) {
      continue;
    }
    const storePath = storePaths.find((candidate) => {
      try {
        const entry = loadSessionStore(candidate, { skipCache: true })[row.sourceSessionKey!];
        return (
          entry?.sessionId === prepared.sessionId &&
          entry.pendingFinalDelivery === true &&
          entry.pendingFinalDeliveryCreatedAt === prepared.pendingFinalDeliveryCreatedAt
        );
      } catch {
        return false;
      }
    });
    if (!storePath) {
      continue;
    }
    params.ownedSessionKeys?.add(row.sourceSessionKey);
    try {
      if (row.finalDeliveryDelivered) {
        // A crash after source settlement but before session cleanup still
        // owns this exact pending final; no publication should run again.
        await clearRecoveredSession(
          storePath,
          row.sourceSessionKey,
          prepared.sessionId,
          prepared.pendingFinalDeliveryCreatedAt,
        );
        result.recovered++;
        continue;
      }
      const { publishPreparedWebchatSourceReply } =
        await import("../gateway/webchat-source-publication.js");
      for (const part of prepared.parts) {
        // The exact key acknowledges a pre-crash append; native transcript text
        // alone never proves this source delivery or authorizes a model rerun.
        await publishPreparedWebchatSourceReply({
          sessionKey: row.sourceSessionKey,
          agentId: resolveAgentIdFromSessionKey(row.sourceSessionKey),
          storePath,
          expectedSessionId: prepared.sessionId,
          part,
          config: params.cfg ?? {},
        });
      }
      await settleSourceTurnDeliveryFinal({
        registryPath,
        owner: createSourceTurnDeliveryQueueOwnerReference(row),
      });
      await clearRecoveredSession(
        storePath,
        row.sourceSessionKey,
        prepared.sessionId,
        prepared.pendingFinalDeliveryCreatedAt,
      );
      result.recovered++;
    } catch (error) {
      result.failed++;
      log.warn(`prepared WebChat source final recovery pending: ${String(error)}`);
    }
  }
  return result;
}

export async function recoverRestartAbortedMainSessions(
  params: {
    cfg?: OpenClawConfig;
    includeAccounting?: boolean;
    stateDir?: string;
    resumedSessionKeys?: Set<string>;
    preparedSourceSessionKeys?: Set<string>;
    sourceRegistryUnavailable?: boolean;
  } = {},
): Promise<MainSessionRestartRecoveryResult> {
  const started = performance.now();
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();
  const checkpoints = await listActiveWorkCheckpoints({
    stateDir: params.stateDir,
  });
  const accounting = createRestartRecoveryAccounting(checkpoints.length);

  for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
    const storeResult = await recoverStore({
      cfg: params.cfg,
      storePath,
      resumedSessionKeys,
      checkpoints,
      stateDir: params.stateDir,
      preparedSourceSessionKeys: params.preparedSourceSessionKeys,
      sourceRegistryUnavailable: params.sourceRegistryUnavailable,
    });
    result.recovered += storeResult.recovered;
    result.failed += storeResult.failed;
    result.skipped += storeResult.skipped;
    addRestartRecoveryAccounting(accounting, storeResult.accounting);
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `main-session restart recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  const durationMs = performance.now() - started;
  if (durationMs >= 250 || result.recovered > 0 || result.failed > 0 || result.skipped > 0) {
    const message =
      `[perf:main-session-restart-recovery] phase=complete durationMs=${formatRestartRecoveryPerfMs(
        durationMs,
      )} recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped} ` +
      `checkpoints=${checkpoints.length} candidateSessions=${accounting.candidateSessions} ` +
      `ineligibleSessions=${accounting.ineligibleSessions} ` +
      `runningWithoutAbortMarker=${accounting.ineligibleRunningWithoutAbortMarker} ` +
      `nonRunningSessions=${accounting.ineligibleNonRunningSessions} ` +
      `skippedNonMainSessions=${accounting.skippedNonMainSessions}`;
    if (durationMs >= 1_000) {
      log.warn(message);
    } else {
      log.info(message);
    }
  }
  return params.includeAccounting ? { ...result, accounting } : result;
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
  log.info(
    `scheduled interrupted main session restart recovery delayMs=${initialDelay} maxRetries=${maxRetries}`,
  );

  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      log.info(`starting interrupted main session restart recovery attempt=${attempt}`);
      const preparedSourceSessionKeys = new Set<string>();
      void (async () => {
        const prepared = await recoverPreparedWebchatSourceFinals({
          cfg: params.cfg,
          stateDir: params.stateDir,
          ownedSessionKeys: preparedSourceSessionKeys,
        }).catch((error: unknown) => {
          log.warn(`prepared source final registry unavailable: ${String(error)}`);
          return undefined;
        });
        const resumed = await recoverRestartAbortedMainSessions({
          cfg: params.cfg,
          stateDir: params.stateDir,
          resumedSessionKeys,
          preparedSourceSessionKeys,
          sourceRegistryUnavailable: prepared === undefined,
        });
        return { prepared, resumed };
      })()
        .then(({ prepared, resumed }) => {
          const failed = (prepared?.failed ?? 1) + resumed.failed;
          if (failed > 0 && attempt < maxRetries) {
            log.info(
              `main-session restart recovery retry scheduled attempt=${attempt + 1} delayMs=${
                delay * RETRY_BACKOFF_MULTIPLIER
              } failed=${failed}`,
            );
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          }
        })
        .catch((err: unknown) => {
          if (attempt < maxRetries) {
            log.warn(`main-session restart recovery failed: ${String(err)}`);
            log.info(
              `main-session restart recovery retry scheduled attempt=${attempt + 1} delayMs=${
                delay * RETRY_BACKOFF_MULTIPLIER
              }`,
            );
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          } else {
            log.warn(`main-session restart recovery gave up: ${String(err)}`);
          }
        });
    }, delay).unref?.();
  };

  attemptRecovery(1, initialDelay);
}
