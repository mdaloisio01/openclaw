import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";

const SOURCE_DELIVERY_DIR_ENV = "OPENCLAW_SOURCE_DELIVERY_OBLIGATION_DIR";
const SOURCE_DELIVERY_FILE = "source_delivery_obligations.json";

export const SOURCE_DELIVERY_OBLIGATION_KIND = "openclaw.source-delivery-obligation";
export const SOURCE_DELIVERY_STALE_MS = 10 * 60 * 1000;

export type SourceDeliveryStatus =
  | "accepted"
  | "progress_delivered"
  | "final_pending"
  | "final_delivered"
  | "delivery_failed";

export type SourceDeliveryObligation = {
  id: string;
  kind: typeof SOURCE_DELIVERY_OBLIGATION_KIND;
  sourceChannel?: string;
  sourceSessionKey?: string;
  sourceMessageId?: string;
  parentRunId?: string;
  missionLabel?: string;
  currentStage?: string;
  acceptedAt: string;
  updatedAt: string;
  lastUserVisibleDeliveryAt?: string;
  requiredMilestoneDelivery?: boolean;
  requiredFinalDelivery?: boolean;
  finalDeliveryDelivered?: boolean;
  internalRunIds?: string[];
  internalWorkerIds?: string[];
  deliveryStatus: SourceDeliveryStatus;
  deliveryContext?: DeliveryContext;
  userFacingDeliveryFailed?: boolean;
  failureReason?: string;
  visibleDeliveryCount?: number;
  notes?: string;
};

export type SourceDeliveryObligationInput = {
  id: string;
  sourceChannel?: string;
  sourceSessionKey?: string;
  sourceMessageId?: string;
  parentRunId?: string;
  missionLabel?: string;
  currentStage?: string;
  acceptedAt?: string;
  lastUserVisibleDeliveryAt?: string;
  requiredMilestoneDelivery?: boolean;
  requiredFinalDelivery?: boolean;
  finalDeliveryDelivered?: boolean;
  internalRunIds?: string[];
  internalWorkerIds?: string[];
  deliveryStatus?: SourceDeliveryStatus;
  deliveryContext?: DeliveryContext;
  userFacingDeliveryFailed?: boolean;
  failureReason?: string;
  visibleDeliveryCount?: number;
  notes?: string;
};

export type SourceDeliveryEvaluation = {
  ok: boolean;
  reason:
    | "source_delivery_satisfied"
    | "source_delivery_failed"
    | "source_delivery_stale"
    | "source_delivery_pending";
  ageMs?: number;
  lastVisibleAgeMs?: number;
};

function sourceDeliveryDir(): string | undefined {
  const configured = process.env[SOURCE_DELIVERY_DIR_ENV]?.trim();
  if (configured) {
    return configured;
  }
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return undefined;
  }
  return path.join(
    os.homedir(),
    ".openclaw",
    "workspace-orchestrator",
    "var",
    "source_delivery_obligations",
  );
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return entries.length > 0 ? [...new Set(entries)] : undefined;
}

function readRows(filePath: string): SourceDeliveryObligation[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const rows =
      parsed && typeof parsed === "object" ? (parsed as { rows?: unknown }).rows : parsed;
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.filter((row): row is SourceDeliveryObligation => {
      return Boolean(
        row &&
        typeof row === "object" &&
        (row as { kind?: unknown }).kind === SOURCE_DELIVERY_OBLIGATION_KIND &&
        typeof (row as { id?: unknown }).id === "string",
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }
}

function normalizeInput(input: SourceDeliveryObligationInput): SourceDeliveryObligation {
  const now = new Date().toISOString();
  return {
    id: input.id,
    kind: SOURCE_DELIVERY_OBLIGATION_KIND,
    acceptedAt: input.acceptedAt ?? now,
    updatedAt: now,
    deliveryStatus: input.deliveryStatus ?? "accepted",
    ...(normalizeString(input.sourceChannel)
      ? { sourceChannel: normalizeString(input.sourceChannel) }
      : {}),
    ...(normalizeString(input.sourceSessionKey)
      ? { sourceSessionKey: normalizeString(input.sourceSessionKey) }
      : {}),
    ...(normalizeString(input.sourceMessageId)
      ? { sourceMessageId: normalizeString(input.sourceMessageId) }
      : {}),
    ...(normalizeString(input.parentRunId)
      ? { parentRunId: normalizeString(input.parentRunId) }
      : {}),
    ...(normalizeString(input.missionLabel)
      ? { missionLabel: normalizeString(input.missionLabel) }
      : {}),
    ...(normalizeString(input.currentStage)
      ? { currentStage: normalizeString(input.currentStage) }
      : {}),
    ...(normalizeString(input.lastUserVisibleDeliveryAt)
      ? { lastUserVisibleDeliveryAt: normalizeString(input.lastUserVisibleDeliveryAt) }
      : {}),
    ...(input.requiredMilestoneDelivery !== undefined
      ? { requiredMilestoneDelivery: input.requiredMilestoneDelivery }
      : {}),
    ...(input.requiredFinalDelivery !== undefined
      ? { requiredFinalDelivery: input.requiredFinalDelivery }
      : {}),
    ...(input.finalDeliveryDelivered !== undefined
      ? { finalDeliveryDelivered: input.finalDeliveryDelivered }
      : {}),
    ...(normalizeStringList(input.internalRunIds)
      ? { internalRunIds: normalizeStringList(input.internalRunIds) }
      : {}),
    ...(normalizeStringList(input.internalWorkerIds)
      ? { internalWorkerIds: normalizeStringList(input.internalWorkerIds) }
      : {}),
    ...(input.deliveryContext ? { deliveryContext: input.deliveryContext } : {}),
    ...(input.userFacingDeliveryFailed !== undefined
      ? { userFacingDeliveryFailed: input.userFacingDeliveryFailed }
      : {}),
    ...(normalizeString(input.failureReason)
      ? { failureReason: normalizeString(input.failureReason) }
      : {}),
    ...(input.visibleDeliveryCount !== undefined
      ? { visibleDeliveryCount: input.visibleDeliveryCount }
      : {}),
    ...(normalizeString(input.notes) ? { notes: normalizeString(input.notes) } : {}),
  };
}

function upsert(input: SourceDeliveryObligationInput): SourceDeliveryObligation | undefined {
  const dir = sourceDeliveryDir();
  if (!dir) {
    return undefined;
  }
  const filePath = path.join(dir, SOURCE_DELIVERY_FILE);
  const rows = readRows(filePath);
  const index = rows.findIndex((row) => row.id === input.id);
  const next = normalizeInput({
    ...(index >= 0 ? rows[index] : {}),
    ...input,
    acceptedAt: index >= 0 ? (rows[index]?.acceptedAt ?? input.acceptedAt) : input.acceptedAt,
  });
  const nextRows =
    index >= 0 ? rows.map((row, rowIndex) => (rowIndex === index ? next : row)) : [...rows, next];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify({ rows: nextRows }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return next;
}

export function buildSourceDeliveryObligationId(params: {
  sourceSessionKey?: string;
  parentRunId?: string;
  sourceMessageId?: string;
}): string {
  const session = normalizeString(params.sourceSessionKey) ?? "unknown-session";
  const run =
    normalizeString(params.parentRunId) ?? normalizeString(params.sourceMessageId) ?? "unknown-run";
  return `source:${session}:${run}`;
}

export function recordSourceDeliveryObligation(
  input: SourceDeliveryObligationInput,
): SourceDeliveryObligation | undefined {
  try {
    return upsert({
      ...input,
      requiredMilestoneDelivery: input.requiredMilestoneDelivery ?? true,
      requiredFinalDelivery: input.requiredFinalDelivery ?? true,
      finalDeliveryDelivered: input.finalDeliveryDelivered ?? false,
      visibleDeliveryCount: input.visibleDeliveryCount ?? 0,
      deliveryStatus: input.deliveryStatus ?? "accepted",
    });
  } catch {
    return undefined;
  }
}

export function recordSourceVisibleDelivery(params: {
  id: string;
  text?: string;
  final?: boolean;
  currentStage?: string;
  notes?: string;
}): SourceDeliveryObligation | undefined {
  if (!params.text?.trim() || isSilentReplyPayloadText(params.text)) {
    return recordSourceDeliveryFailure({
      id: params.id,
      reason: "source-visible delivery was empty or NO_REPLY",
      currentStage: params.currentStage,
    });
  }
  const deliveredAt = new Date().toISOString();
  return recordSourceDeliveryObligation({
    id: params.id,
    currentStage: params.currentStage,
    lastUserVisibleDeliveryAt: deliveredAt,
    deliveryStatus: params.final === true ? "final_delivered" : "progress_delivered",
    finalDeliveryDelivered: params.final === true ? true : undefined,
    visibleDeliveryCount: 1,
    notes: params.notes,
  });
}

export function recordSourceVisibleDeliveryIfPresent(params: {
  id: string;
  text?: string;
  final?: boolean;
  currentStage?: string;
  notes?: string;
}): SourceDeliveryObligation | undefined {
  const dir = sourceDeliveryDir();
  if (!dir) {
    return undefined;
  }
  const rows = readRows(path.join(dir, SOURCE_DELIVERY_FILE));
  if (!rows.some((row) => row.id === params.id)) {
    return undefined;
  }
  return recordSourceVisibleDelivery(params);
}

export function recordSourceDeliveryFailure(params: {
  id: string;
  reason: string;
  currentStage?: string;
  sourceChannel?: string;
  sourceSessionKey?: string;
  parentRunId?: string;
  deliveryContext?: DeliveryContext;
  notes?: string;
}): SourceDeliveryObligation | undefined {
  return recordSourceDeliveryObligation({
    id: params.id,
    sourceChannel: params.sourceChannel,
    sourceSessionKey: params.sourceSessionKey,
    parentRunId: params.parentRunId,
    deliveryContext: params.deliveryContext,
    currentStage: params.currentStage,
    deliveryStatus: "delivery_failed",
    userFacingDeliveryFailed: true,
    failureReason: params.reason,
    notes: params.notes,
  });
}

function timestampMs(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function evaluateSourceDeliveryObligation(
  row: SourceDeliveryObligation,
  options?: { nowMs?: number; staleMs?: number },
): SourceDeliveryEvaluation {
  if (row.userFacingDeliveryFailed || row.deliveryStatus === "delivery_failed") {
    return { ok: false, reason: "source_delivery_failed" };
  }
  if (row.finalDeliveryDelivered || row.deliveryStatus === "final_delivered") {
    return { ok: true, reason: "source_delivery_satisfied" };
  }
  const nowMs = options?.nowMs ?? Date.now();
  const staleMs = options?.staleMs ?? SOURCE_DELIVERY_STALE_MS;
  const acceptedMs = timestampMs(row.acceptedAt);
  const visibleMs = timestampMs(row.lastUserVisibleDeliveryAt);
  const ageMs = acceptedMs === undefined ? undefined : Math.max(0, nowMs - acceptedMs);
  const lastVisibleAgeMs = visibleMs === undefined ? undefined : Math.max(0, nowMs - visibleMs);
  if (visibleMs === undefined && ageMs !== undefined && ageMs >= staleMs) {
    return { ok: false, reason: "source_delivery_stale", ageMs };
  }
  if (lastVisibleAgeMs !== undefined && lastVisibleAgeMs >= staleMs) {
    return { ok: false, reason: "source_delivery_stale", ageMs, lastVisibleAgeMs };
  }
  return { ok: false, reason: "source_delivery_pending", ageMs, lastVisibleAgeMs };
}

export function listSourceDeliveryObligations(options?: {
  dir?: string;
}): SourceDeliveryObligation[] {
  const dir = options?.dir ?? sourceDeliveryDir();
  if (!dir) {
    return [];
  }
  return readRows(path.join(dir, SOURCE_DELIVERY_FILE));
}
