import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { replaceFileAtomic } from "../infra/replace-file.js";

export const ACTIVE_WORK_CHECKPOINT_SCHEMA_VERSION = 1;
export const ACTIVE_WORK_CHECKPOINT_KIND = "openclaw.active-work-checkpoint";
export const ACTIVE_WORK_CHECKPOINT_DEFAULT_TTL_MS = 10 * 60_000;
const ACTIVE_WORK_CHECKPOINT_MAX_BYTES = 32 * 1024;
const ACTIVE_WORK_CHECKPOINT_DIR = "active-work-checkpoints";

export type ActiveWorkCheckpointStatus = "pending" | "continued" | "blocked" | "expired";
export type ActiveWorkCheckpointDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

export type ActiveWorkCheckpoint = {
  kind: typeof ACTIVE_WORK_CHECKPOINT_KIND;
  schemaVersion: typeof ACTIVE_WORK_CHECKPOINT_SCHEMA_VERSION;
  checkpointId: string;
  createdAt: string;
  createdAtMs: number;
  expiresAt: string;
  expiresAtMs: number;
  status: ActiveWorkCheckpointStatus;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  deliveryContext?: ActiveWorkCheckpointDeliveryContext;
  requestingAgentToolPath?: string;
  restartCommand?: string;
  restartIntent?: string;
  activeObjective: string;
  currentPhase: string;
  lastCompletedProof: string;
  nextValidationStep: string;
  stopConditions: string[];
  pendingApprovalState?: string;
  safeToAutoResume: boolean;
  requiresOperatorReview: boolean;
  unsafeAutoResumeReason?: string;
  completedAt?: string;
  completedAtMs?: number;
  completionReason?: string;
};

export type ActiveWorkCheckpointInput = Omit<
  ActiveWorkCheckpoint,
  | "kind"
  | "schemaVersion"
  | "checkpointId"
  | "createdAt"
  | "createdAtMs"
  | "expiresAt"
  | "expiresAtMs"
  | "status"
>;

function checkpointRootDir(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(process.env), ACTIVE_WORK_CHECKPOINT_DIR);
}

function checkpointPath(checkpointId: string, stateDir?: string): string {
  return path.join(checkpointRootDir(stateDir), `${checkpointId}.json`);
}

function normalizeOptionalString(value: unknown, maxLength = 500): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizeString(value: unknown, fallback: string, maxLength = 500): string {
  return normalizeOptionalString(value, maxLength) ?? fallback;
}

function normalizeStringArray(values: unknown, fallback: string[]): string[] {
  if (!Array.isArray(values)) {
    return fallback;
  }
  const normalized = values
    .map((value) => normalizeOptionalString(value, 300))
    .filter((value): value is string => Boolean(value));
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeDeliveryContext(
  value: ActiveWorkCheckpointDeliveryContext | undefined,
): ActiveWorkCheckpointDeliveryContext | undefined {
  const deliveryContext = {
    channel: normalizeOptionalString(value?.channel, 120),
    to: normalizeOptionalString(value?.to, 300),
    accountId: normalizeOptionalString(value?.accountId, 120),
    threadId: normalizeOptionalString(value?.threadId, 120),
  };
  return deliveryContext.channel && deliveryContext.to ? deliveryContext : undefined;
}

function buildCheckpoint(params: {
  input: ActiveWorkCheckpointInput;
  nowMs: number;
  ttlMs: number;
}): ActiveWorkCheckpoint {
  const checkpointId = crypto.randomUUID();
  const expiresAtMs = params.nowMs + Math.max(1, Math.floor(params.ttlMs));
  const safeToAutoResume = params.input.safeToAutoResume === true;
  const requiresOperatorReview = params.input.requiresOperatorReview === true || !safeToAutoResume;
  return {
    kind: ACTIVE_WORK_CHECKPOINT_KIND,
    schemaVersion: ACTIVE_WORK_CHECKPOINT_SCHEMA_VERSION,
    checkpointId,
    createdAt: new Date(params.nowMs).toISOString(),
    createdAtMs: params.nowMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    status: "pending",
    ...(normalizeOptionalString(params.input.sessionKey, 240)
      ? { sessionKey: normalizeOptionalString(params.input.sessionKey, 240) }
      : {}),
    ...(normalizeOptionalString(params.input.sessionId, 240)
      ? { sessionId: normalizeOptionalString(params.input.sessionId, 240) }
      : {}),
    ...(normalizeOptionalString(params.input.runId, 240)
      ? { runId: normalizeOptionalString(params.input.runId, 240) }
      : {}),
    ...(normalizeDeliveryContext(params.input.deliveryContext)
      ? { deliveryContext: normalizeDeliveryContext(params.input.deliveryContext) }
      : {}),
    ...(normalizeOptionalString(params.input.requestingAgentToolPath, 240)
      ? {
          requestingAgentToolPath: normalizeOptionalString(
            params.input.requestingAgentToolPath,
            240,
          ),
        }
      : {}),
    ...(normalizeOptionalString(params.input.restartCommand, 1000)
      ? { restartCommand: normalizeOptionalString(params.input.restartCommand, 1000) }
      : {}),
    ...(normalizeOptionalString(params.input.restartIntent, 300)
      ? { restartIntent: normalizeOptionalString(params.input.restartIntent, 300) }
      : {}),
    activeObjective: normalizeString(
      params.input.activeObjective,
      "Gateway restart requested from an active OpenClaw tool turn.",
    ),
    currentPhase: normalizeString(params.input.currentPhase, "pre-restart tool call"),
    lastCompletedProof: normalizeString(
      params.input.lastCompletedProof,
      "Gateway self-restart command was classified before execution.",
    ),
    nextValidationStep: normalizeString(
      params.input.nextValidationStep,
      "Wait for gateway startup health, then report restart truth and continue only safe validation.",
    ),
    stopConditions: normalizeStringArray(params.input.stopConditions, [
      "Gateway health fails after restart.",
      "Continuation would require destructive operations.",
      "Continuation would require private context export.",
      "Operator review is required.",
    ]),
    ...(normalizeOptionalString(params.input.pendingApprovalState, 300)
      ? { pendingApprovalState: normalizeOptionalString(params.input.pendingApprovalState, 300) }
      : {}),
    safeToAutoResume,
    requiresOperatorReview,
    ...(normalizeOptionalString(params.input.unsafeAutoResumeReason, 500)
      ? {
          unsafeAutoResumeReason: normalizeOptionalString(params.input.unsafeAutoResumeReason, 500),
        }
      : {}),
  };
}

async function writeCheckpointFile(checkpoint: ActiveWorkCheckpoint, stateDir?: string) {
  const root = checkpointRootDir(stateDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(checkpoint, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > ACTIVE_WORK_CHECKPOINT_MAX_BYTES) {
    throw new Error("active work checkpoint exceeds maximum safe size");
  }
  await replaceFileAtomic({
    filePath: checkpointPath(checkpoint.checkpointId, stateDir),
    content,
    mode: 0o600,
    tempPrefix: ".active-work-checkpoint",
  });
}

export async function writeActiveWorkCheckpoint(params: {
  input: ActiveWorkCheckpointInput;
  stateDir?: string;
  nowMs?: number;
  ttlMs?: number;
}): Promise<ActiveWorkCheckpoint> {
  const checkpoint = buildCheckpoint({
    input: params.input,
    nowMs: params.nowMs ?? Date.now(),
    ttlMs: params.ttlMs ?? ACTIVE_WORK_CHECKPOINT_DEFAULT_TTL_MS,
  });
  await writeCheckpointFile(checkpoint, params.stateDir);
  return checkpoint;
}

function parseCheckpoint(raw: string): ActiveWorkCheckpoint | undefined {
  if (Buffer.byteLength(raw, "utf8") > ACTIVE_WORK_CHECKPOINT_MAX_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Partial<ActiveWorkCheckpoint>;
  if (
    record.kind !== ACTIVE_WORK_CHECKPOINT_KIND ||
    record.schemaVersion !== ACTIVE_WORK_CHECKPOINT_SCHEMA_VERSION ||
    typeof record.checkpointId !== "string" ||
    typeof record.createdAtMs !== "number" ||
    typeof record.expiresAtMs !== "number" ||
    (record.status !== "pending" &&
      record.status !== "continued" &&
      record.status !== "blocked" &&
      record.status !== "expired")
  ) {
    return undefined;
  }
  return record as ActiveWorkCheckpoint;
}

export async function listActiveWorkCheckpoints(
  params: {
    stateDir?: string;
    nowMs?: number;
    includeCompleted?: boolean;
  } = {},
): Promise<ActiveWorkCheckpoint[]> {
  const root = checkpointRootDir(params.stateDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  const checkpoints: ActiveWorkCheckpoint[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = path.join(root, entry);
    let checkpoint: ActiveWorkCheckpoint | undefined;
    try {
      checkpoint = parseCheckpoint(await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (!checkpoint) {
      continue;
    }
    if (!params.includeCompleted && checkpoint.status !== "pending") {
      continue;
    }
    if (checkpoint.status === "pending" && checkpoint.expiresAtMs <= nowMs) {
      checkpoints.push({ ...checkpoint, status: "expired" });
      continue;
    }
    checkpoints.push(checkpoint);
  }
  return checkpoints.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export async function updateActiveWorkCheckpointStatus(params: {
  checkpoint: ActiveWorkCheckpoint;
  status: ActiveWorkCheckpointStatus;
  reason?: string;
  stateDir?: string;
  nowMs?: number;
}): Promise<ActiveWorkCheckpoint> {
  const nowMs = params.nowMs ?? Date.now();
  const next: ActiveWorkCheckpoint = {
    ...params.checkpoint,
    status: params.status,
    completedAt: new Date(nowMs).toISOString(),
    completedAtMs: nowMs,
    ...(normalizeOptionalString(params.reason, 500)
      ? { completionReason: normalizeOptionalString(params.reason, 500) }
      : {}),
  };
  await writeCheckpointFile(next, params.stateDir);
  return next;
}
