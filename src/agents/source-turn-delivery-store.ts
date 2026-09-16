import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withFileLock } from "@openclaw/fs-safe/file-lock";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { MessageReceipt } from "../channels/message/types.js";
import type {
  CanonicalAssistantTranscript,
  PreparedWebchatSourceContent,
} from "../config/sessions/transcript.js";
import {
  resolveGovernedRunDurability,
  type GovernedRunDeliveryObligationStage,
  type GovernedRunDurabilityDecision,
} from "../governance/governed-run-durability-contract.js";
import { resolveRequiredOsHomeDir } from "../infra/home-dir.js";
import { prepareDeliveryQueuePayload } from "../infra/outbound/delivery-queue-payload.js";
import type { DeliveryQueueOwnerReference } from "../infra/outbound/delivery-queue.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { shouldRemoveDeadOwnerOrExpiredLock } from "../infra/stale-lock-file.js";
import type { ParentYieldWaitRef } from "../infra/system-events.js";
import { hasOutboundReplyContent } from "../plugin-sdk/reply-payload.js";
import { getProcessStartTime } from "../shared/pid-alive.js";
import {
  resolveSourceTurnDeliveryState,
  type SourceTurnDeliveryDecision,
  type SourceTurnDeliveryFacts,
  type SourceTurnDeliveryState,
} from "./source-turn-delivery-state.js";

export const SOURCE_TURN_DELIVERY_ROW_KIND = "openclaw.source-delivery-obligation";
export const SOURCE_TURN_DELIVERY_QUEUE_OWNER_KIND = "source_turn_delivery";
const SOURCE_TURN_DELIVERY_LOCK_STALE_MS = 30_000;
const LOCK_OWNER_STARTTIME = getProcessStartTime(process.pid) ?? undefined;

export function resolveSourceTurnDeliveryRegistryPath(): string {
  const override = normalizeOptionalString(process.env.OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH);
  if (override) {
    return override;
  }
  // Worker-local HOME must remain authoritative: native os.homedir() reads
  // the host environment and can send isolated writes into the live registry.
  const workspaceDir =
    normalizeOptionalString(process.env.OPENCLAW_WORKSPACE_ORCHESTRATOR_DIR) ??
    join(resolveRequiredOsHomeDir(), ".openclaw", "workspace-orchestrator");
  return join(
    workspaceDir,
    "var",
    "source_delivery_obligations",
    "source_delivery_obligations.json",
  );
}

async function isAbandonedDeliveryLock({
  lockPath,
  payload,
  staleMs,
  nowMs = Date.now(),
}: {
  lockPath: string;
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs?: number;
}): Promise<boolean> {
  const hasOwnerIdentity =
    (typeof payload?.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0) ||
    typeof payload?.createdAt === "string";
  if (hasOwnerIdentity) {
    return shouldRemoveDeadOwnerOrExpiredLock({ payload, staleMs, nowMs });
  }
  try {
    // An empty/partial payload can only precede the protected write. Age-gate
    // recovery, then let fs-safe compare the exact snapshot before removal.
    return nowMs - (await stat(lockPath)).mtimeMs > staleMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

export const SOURCE_TURN_DELIVERY_OBLIGATION_STAGES = [
  "owed",
  "prepared",
  "delivery_attempted",
  "delivered",
  "failed",
  "needs_review",
  "settled_by_verified_later_delivery",
] as const;

export type SourceTurnDeliveryObligationStage =
  (typeof SOURCE_TURN_DELIVERY_OBLIGATION_STAGES)[number];

export type SourceTurnDeliveryObligationIdentity = {
  missionId?: string;
  runId?: string;
  reportId?: string;
  deliveryId?: string;
  generation?: string | number;
};

export type SourceTurnDeliveryWatchdogReconciliation = {
  status?: string;
  action?: string;
  reason?: string;
  proofPath?: string;
  originalFinalDeliveryDelivered?: boolean;
  originalVisibleDeliveryCount?: number;
};

export type SourceTurnMarkFacingExportDelivery = {
  required: boolean;
  root?: string;
  path?: string;
  verified: boolean;
};

export type SourceTurnTrbRecoveryLinkage = {
  gateBlocked: boolean;
  gateDecisionRecordId?: string;
  gateDecisionStatus?: "pending" | "passed" | "blocked";
  recoveryRecordId?: string;
};

export type SourceTurnDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type PreparedSourceFinalPart = {
  idempotencyKey: string;
  text: string;
  mediaUrls?: string[];
  payload?: ReplyPayload;
  canonicalAssistantTranscript?: CanonicalAssistantTranscript;
  webchatContent?: PreparedWebchatSourceContent;
};

type PreparedExternalFinalDelivery =
  | { status: "prepared" }
  | { status: "queued"; queueId: string }
  | { status: "delivered"; queueId: string; receipt: MessageReceipt };

type PreparedSourceFinalBase = {
  sessionId: string;
  pendingFinalDeliveryCreatedAt?: number;
  expectedPartCount: number;
};

export type SourceTurnPreparedSourceFinal = PreparedSourceFinalBase &
  (
    | { kind: "source_session_transcript"; parts: PreparedSourceFinalPart[] }
    | {
        kind: "external_channel";
        parts: Array<PreparedSourceFinalPart & { payload: ReplyPayload }>;
        outboundDelivery: PreparedExternalFinalDelivery;
      }
  );

type PreparedSourceFinalInput<T = SourceTurnPreparedSourceFinal> =
  T extends SourceTurnPreparedSourceFinal
    ? Omit<T, "parts"> & { parts: Array<Omit<T["parts"][number], "idempotencyKey">> }
    : never;

export type SourceTurnDeliveryRow = {
  id: string;
  kind: typeof SOURCE_TURN_DELIVERY_ROW_KIND;
  sourceTurnId: string;
  sourceSessionKey?: string;
  sourceMessageId?: string;
  sourceChannel?: string;
  deliveryContext?: SourceTurnDeliveryContext;
  parentYieldWaits?: ParentYieldWaitRef[];
  preparedSourceFinal?: SourceTurnPreparedSourceFinal;
  acceptedAt: string;
  updatedAt: string;
  deliveryStatus: string;
  obligationStage: SourceTurnDeliveryObligationStage;
  obligationIdentity: SourceTurnDeliveryObligationIdentity;
  idempotencyKey: string;
  sourceTurnState: SourceTurnDeliveryState;
  finalDeliveryDelivered: boolean;
  visibleDeliveryCount: number;
  currentStage?: string;
  failureReason?: string;
  reportArtifactPaths?: string[];
  markFacingExport?: SourceTurnMarkFacingExportDelivery;
  trbRecovery?: SourceTurnTrbRecoveryLinkage;
  watchdogReconciliation?: SourceTurnDeliveryWatchdogReconciliation;
  deliveryDecision: SourceTurnDeliveryDecision;
  durabilityDecision: GovernedRunDurabilityDecision;
};

export type SourceTurnDeliveryRegistry = {
  rows: SourceTurnDeliveryRow[];
};

export type ExternalSourceDeliveryQueueIdentity = {
  queueId: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  payloads: readonly ReplyPayload[];
  owner?: DeliveryQueueOwnerReference;
};

export type ExternalSourceDeliveryQueueOwnerState =
  | { status: "not_owned" }
  | { status: "pending"; sourceSessionKey: string }
  | { status: "delivered"; sourceSessionKey: string };

export type ExternalSourceDeliveryTransition = Exclude<
  PreparedExternalFinalDelivery,
  { status: "prepared" }
>;

export function createSourceTurnDeliveryQueueOwnerReference(
  row: Pick<SourceTurnDeliveryRow, "idempotencyKey">,
): DeliveryQueueOwnerReference {
  return { kind: SOURCE_TURN_DELIVERY_QUEUE_OWNER_KIND, key: row.idempotencyKey };
}

export type PersistSourceTurnDeliveryParams = {
  registryPath: string;
  id: string;
  sourceTurnId?: string;
  sourceSessionKey?: string;
  sourceMessageId?: string;
  sourceChannel?: string;
  deliveryContext?: SourceTurnDeliveryContext;
  parentYieldWaits?: ParentYieldWaitRef[];
  preparedSourceFinal?: PreparedSourceFinalInput;
  preparedExternalFinalDelivery?: Exclude<PreparedExternalFinalDelivery, { status: "prepared" }>;
  facts: SourceTurnDeliveryFacts;
  now?: string;
  currentStage?: string;
  reportArtifactPaths?: string[];
  missionId?: string;
  runId?: string;
  reportId?: string;
  deliveryId?: string;
  generation?: string | number;
  reportPrepared?: boolean;
  deliveryAttempted?: boolean;
  needsReview?: boolean;
  watchdogReconciliation?: SourceTurnDeliveryWatchdogReconciliation;
};

export type SourceTurnDeliveryWatchdogStatus =
  | "non_blocking_delivered"
  | "non_blocking_settled"
  | "non_blocking_archived"
  | "blocking_failed"
  | "blocking_pending"
  | "blocking_refused";

function emptyRegistry(): SourceTurnDeliveryRegistry {
  return { rows: [] };
}

async function readRegistry(path: string): Promise<SourceTurnDeliveryRegistry> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const rows =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : Array.isArray(parsed)
          ? parsed
          : [];
    return {
      rows: rows.filter((row): row is SourceTurnDeliveryRow =>
        Boolean(
          row &&
          typeof row === "object" &&
          (row as { kind?: unknown }).kind === SOURCE_TURN_DELIVERY_ROW_KIND &&
          typeof (row as { id?: unknown }).id === "string",
        ),
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyRegistry();
    }
    throw error;
  }
}

async function writeRegistry(path: string, registry: SourceTurnDeliveryRegistry): Promise<void> {
  const dirMode = (await stat(dirname(path))).mode & 0o7777;
  await replaceFileAtomic({
    filePath: path,
    content: `${JSON.stringify(registry, null, 2)}\n`,
    mode: 0o600,
    dirMode,
    copyFallbackOnPermissionError: false,
    syncTempFile: true,
    syncParentDir: true,
  });
}

async function withSourceTurnDeliveryRegistryLock<T>(
  registryPath: string,
  run: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
  return await withFileLock(
    registryPath,
    {
      managerKey: "openclaw.source-turn-delivery",
      allowReentrant: false,
      staleMs: SOURCE_TURN_DELIVERY_LOCK_STALE_MS,
      timeoutMs: 30_000,
      retry: { minTimeout: 10, maxTimeout: 100, factor: 1.2 },
      staleRecovery: "remove-if-unchanged",
      shouldReclaim: isAbandonedDeliveryLock,
      shouldRemoveStaleLock: ({ lockPath, payload }) =>
        isAbandonedDeliveryLock({
          lockPath,
          payload,
          staleMs: SOURCE_TURN_DELIVERY_LOCK_STALE_MS,
        }),
      payload: () => ({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        starttime: LOCK_OWNER_STARTTIME,
      }),
    },
    run,
  );
}

function statusForDecision(decision: SourceTurnDeliveryDecision): string {
  if (decision.state === "final_delivery_failed") {
    return "delivery_failed";
  }
  if (decision.state === "final_delivery_unknown") {
    return "delivery_unknown";
  }
  if (decision.state === "failure_delivered") {
    return "failure_delivered";
  }
  if (decision.state === "blocked_refused") {
    return "blocked";
  }
  if (decision.state === "settled_resolved_later") {
    return "final_pending";
  }
  return decision.state;
}

function visibleDeliveryCountForDecision(decision: SourceTurnDeliveryDecision): number {
  if (
    decision.state === "progress_delivered" ||
    decision.state === "final_delivered" ||
    decision.state === "failure_delivered"
  ) {
    return 1;
  }
  return 0;
}

function normalizeIdentityPart(value: string | number | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeObligationIdentity(
  params: PersistSourceTurnDeliveryParams,
  existing?: SourceTurnDeliveryRow,
): SourceTurnDeliveryObligationIdentity {
  const missionId =
    normalizeIdentityPart(params.missionId) ??
    normalizeIdentityPart(existing?.obligationIdentity?.missionId);
  const runId =
    normalizeIdentityPart(params.runId) ??
    normalizeIdentityPart(existing?.obligationIdentity?.runId);
  const reportId =
    normalizeIdentityPart(params.reportId) ??
    normalizeIdentityPart(existing?.obligationIdentity?.reportId);
  const deliveryId =
    normalizeIdentityPart(params.deliveryId) ??
    normalizeIdentityPart(existing?.obligationIdentity?.deliveryId);
  const generation =
    normalizeIdentityPart(params.generation) ??
    normalizeIdentityPart(existing?.obligationIdentity?.generation);
  return {
    ...(missionId ? { missionId } : {}),
    ...(runId ? { runId } : {}),
    ...(reportId ? { reportId } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(generation ? { generation } : {}),
  };
}

function hasExplicitObligationIdentity(params: PersistSourceTurnDeliveryParams): boolean {
  return Boolean(
    normalizeIdentityPart(params.missionId) ||
    normalizeIdentityPart(params.runId) ||
    normalizeIdentityPart(params.reportId) ||
    normalizeIdentityPart(params.deliveryId) ||
    normalizeIdentityPart(params.generation),
  );
}

export function buildSourceTurnDeliveryObligationKey(params: {
  sourceTurnId: string;
  missionId?: string;
  runId?: string;
  reportId?: string;
  deliveryId?: string;
  generation?: string | number;
}): string {
  const identity = [
    ["source", params.sourceTurnId],
    ["mission", params.missionId],
    ["run", params.runId],
    ["report", params.reportId],
    ["delivery", params.deliveryId],
    ["generation", params.generation],
  ]
    .map(([label, value]) => {
      const normalized = normalizeIdentityPart(value);
      return normalized ? `${label}:${normalized}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  return identity.join("|");
}

function deriveObligationStage(params: {
  decision: SourceTurnDeliveryDecision;
  facts: SourceTurnDeliveryFacts;
  reportArtifactPaths?: string[];
  reportPrepared?: boolean;
  deliveryAttempted?: boolean;
  needsReview?: boolean;
}): SourceTurnDeliveryObligationStage {
  if (params.decision.state === "settled_resolved_later") {
    return "settled_by_verified_later_delivery";
  }
  if (params.decision.state === "final_delivered") {
    return "delivered";
  }
  if (params.decision.state === "final_delivery_failed") {
    return "failed";
  }
  if (params.decision.state === "final_delivery_unknown") {
    return "needs_review";
  }
  if (params.decision.state === "failure_delivered") {
    return "delivery_attempted";
  }
  if (params.decision.state === "progress_delivered") {
    return "delivery_attempted";
  }
  if (params.needsReview === true || params.decision.state === "blocked_refused") {
    return "needs_review";
  }
  if (params.deliveryAttempted === true || params.facts.deliveryToolFailed === true) {
    return "delivery_attempted";
  }
  if (
    params.reportPrepared === true ||
    Boolean(params.facts.reportArtifactPath?.trim()) ||
    (params.reportArtifactPaths ?? []).length > 0
  ) {
    return "prepared";
  }
  return "owed";
}

function toGovernedRunDeliveryObligationStage(
  stage: SourceTurnDeliveryObligationStage,
): GovernedRunDeliveryObligationStage {
  return stage;
}

function hasRetryOrRecoveryCoverage(
  reconciliation: SourceTurnDeliveryWatchdogReconciliation | undefined,
): boolean {
  return Boolean(
    reconciliation?.action ||
    reconciliation?.proofPath ||
    reconciliation?.status === "settled_resolved_later",
  );
}

function normalizeMarkFacingExportDelivery(
  facts: SourceTurnDeliveryFacts,
): SourceTurnMarkFacingExportDelivery | undefined {
  if (
    facts.markFacingExportRequired !== true &&
    !normalizeIdentityPart(facts.markFacingExportRoot) &&
    !normalizeIdentityPart(facts.markFacingExportPath) &&
    facts.markFacingExportVerified !== true
  ) {
    return undefined;
  }
  return {
    required: facts.markFacingExportRequired === true,
    ...(normalizeIdentityPart(facts.markFacingExportRoot)
      ? { root: normalizeIdentityPart(facts.markFacingExportRoot) }
      : {}),
    ...(normalizeIdentityPart(facts.markFacingExportPath)
      ? { path: normalizeIdentityPart(facts.markFacingExportPath) }
      : {}),
    verified:
      facts.markFacingExportVerified === true ||
      (facts.evidenceKinds ?? []).includes("mark_facing_export_visible"),
  };
}

function normalizeDeliveryContext(
  context: SourceTurnDeliveryContext | undefined,
): SourceTurnDeliveryContext | undefined {
  const channel = normalizeIdentityPart(context?.channel);
  const to = normalizeIdentityPart(context?.to);
  const accountId = normalizeIdentityPart(context?.accountId);
  const threadId = normalizeIdentityPart(context?.threadId);
  if (!channel && !to && !accountId && !threadId) {
    return undefined;
  }
  return {
    ...(channel ? { channel } : {}),
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function normalizeTrbRecoveryLinkage(
  facts: SourceTurnDeliveryFacts,
): SourceTurnTrbRecoveryLinkage | undefined {
  const gateDecisionRecordId = normalizeIdentityPart(facts.trbGateDecisionRecordId);
  const recoveryRecordId = normalizeIdentityPart(facts.trbRecoveryRecordId);
  const gateDecisionStatus = facts.trbGateDecisionStatus;
  if (
    facts.trbGateBlocked !== true &&
    !gateDecisionRecordId &&
    !recoveryRecordId &&
    !gateDecisionStatus
  ) {
    return undefined;
  }
  return {
    gateBlocked: facts.trbGateBlocked === true || gateDecisionStatus === "blocked",
    ...(gateDecisionRecordId ? { gateDecisionRecordId } : {}),
    ...(gateDecisionStatus ? { gateDecisionStatus } : {}),
    ...(recoveryRecordId ? { recoveryRecordId } : {}),
  };
}

function resolvePreparedSourceFinal(params: {
  prepared: PersistSourceTurnDeliveryParams["preparedSourceFinal"];
  existing: SourceTurnDeliveryRow | undefined;
  sourceSessionKey: string | undefined;
  sourceChannel: string | undefined;
  deliveryContext: SourceTurnDeliveryContext | undefined;
  parentYieldWaits: ParentYieldWaitRef[] | undefined;
  runId: string | undefined;
  obligationKey: string;
  externalDelivery: PersistSourceTurnDeliveryParams["preparedExternalFinalDelivery"];
}): SourceTurnPreparedSourceFinal | undefined {
  const previous = params.existing?.preparedSourceFinal;
  const prepared = params.prepared ?? previous;
  if (!prepared) {
    if (params.externalDelivery) {
      throw new Error("External transport receipt requires a prepared final");
    }
    return undefined;
  }
  if (!params.sourceSessionKey || !params.runId) {
    throw new Error("Prepared source final requires its source session and execution run");
  }
  // Preparation pins both the payload and its owner. Retrying an acknowledged
  // publication must not attach that final to another session, route, or wait.
  if (
    previous &&
    (params.existing?.sourceSessionKey !== params.sourceSessionKey ||
      params.existing?.sourceChannel !== params.sourceChannel ||
      !isDeepStrictEqual(params.existing?.deliveryContext, params.deliveryContext) ||
      !isDeepStrictEqual(params.existing?.parentYieldWaits, params.parentYieldWaits))
  ) {
    throw new Error("Prepared source final owner cannot change");
  }
  if (
    (prepared.kind !== "source_session_transcript" && prepared.kind !== "external_channel") ||
    !prepared.sessionId.trim() ||
    !Number.isSafeInteger(prepared.expectedPartCount) ||
    prepared.expectedPartCount < 1 ||
    prepared.parts.length < 1 ||
    prepared.parts.length > prepared.expectedPartCount ||
    (prepared.pendingFinalDeliveryCreatedAt !== undefined &&
      !Number.isFinite(prepared.pendingFinalDeliveryCreatedAt)) ||
    prepared.parts.some(
      (part) =>
        part.mediaUrls?.some((url) => !url.trim()) ||
        (part.webchatContent &&
          (!part.webchatContent.content.length ||
            part.webchatContent.assets.some(
              (asset) => !asset.url || !/^[a-f0-9]{64}$/.test(asset.sha256),
            ))),
    )
  ) {
    throw new Error("Prepared source final requires a session and sendable payload");
  }
  const partsHaveContent =
    prepared.kind === "external_channel"
      ? prepared.parts.every((part) => hasOutboundReplyContent(part.payload, { trimText: true }))
      : prepared.parts.every((part) =>
          Boolean(
            part.text.trim() || part.mediaUrls?.length || part.webchatContent?.content.length,
          ),
        );
  if (!partsHaveContent) {
    throw new Error("Prepared source final requires a session and sendable payload");
  }
  if (
    prepared.kind === "external_channel" &&
    (!params.sourceChannel ||
      params.sourceChannel === "webchat" ||
      params.deliveryContext?.channel !== params.sourceChannel ||
      !params.deliveryContext.to ||
      prepared.parts.length !== prepared.expectedPartCount)
  ) {
    throw new Error("Prepared external final requires its original channel and destination");
  }
  const base = {
    sessionId: prepared.sessionId,
    ...(prepared.pendingFinalDeliveryCreatedAt !== undefined
      ? { pendingFinalDeliveryCreatedAt: prepared.pendingFinalDeliveryCreatedAt }
      : {}),
    expectedPartCount: prepared.expectedPartCount,
  };
  const preparePart = (part: Omit<PreparedSourceFinalPart, "idempotencyKey">, ordinal: number) => {
    const identity = [params.obligationKey, params.sourceSessionKey, prepared.sessionId, ordinal];
    return {
      idempotencyKey: `source-session-final:${createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("hex")}`,
      text: part.text,
      ...(part.mediaUrls?.length ? { mediaUrls: [...part.mediaUrls] } : {}),
      ...(part.payload ? { payload: structuredClone(part.payload) } : {}),
      ...(part.canonicalAssistantTranscript
        ? { canonicalAssistantTranscript: { ...part.canonicalAssistantTranscript } }
        : {}),
      ...(part.webchatContent ? { webchatContent: structuredClone(part.webchatContent) } : {}),
    };
  };
  let next: SourceTurnPreparedSourceFinal;
  if (prepared.kind === "external_channel") {
    // The complete batch survives before enqueue. Bind its actual queue intent
    // before sending; only that same intent's receipt can advance delivery.
    const previousDelivery =
      previous?.kind === "external_channel" ? previous.outboundDelivery : undefined;
    const outboundDelivery =
      params.externalDelivery ?? previousDelivery ?? prepared.outboundDelivery;
    if (
      (outboundDelivery.status !== "prepared" && !outboundDelivery.queueId.trim()) ||
      (outboundDelivery.status === "delivered" &&
        (!previousDelivery ||
          previousDelivery.status === "prepared" ||
          !outboundDelivery.receipt.platformMessageIds.length)) ||
      (previousDelivery &&
        previousDelivery.status !== "prepared" &&
        (outboundDelivery.status === "prepared" ||
          outboundDelivery.queueId !== previousDelivery.queueId)) ||
      (previousDelivery?.status === "delivered" &&
        !isDeepStrictEqual(previousDelivery, outboundDelivery))
    ) {
      throw new Error("Prepared external final transport identity cannot change");
    }
    next = {
      ...base,
      kind: "external_channel",
      parts: prepared.parts.map((part, ordinal) => ({
        ...preparePart(part, ordinal),
        payload: structuredClone(part.payload),
      })),
      outboundDelivery: structuredClone(outboundDelivery),
    };
  } else {
    if (params.externalDelivery) {
      throw new Error("External transport receipt requires an external prepared final");
    }
    next = { ...base, kind: prepared.kind, parts: prepared.parts.map(preparePart) };
  }
  if (
    previous &&
    (previous.kind !== next.kind ||
      previous.sessionId !== next.sessionId ||
      previous.pendingFinalDeliveryCreatedAt !== next.pendingFinalDeliveryCreatedAt ||
      previous.expectedPartCount !== next.expectedPartCount ||
      !isDeepStrictEqual(previous.parts, next.parts.slice(0, previous.parts.length)))
  ) {
    throw new Error("Prepared source final payload cannot change");
  }
  return next;
}

export async function loadSourceTurnDeliveryRegistry(
  registryPath: string,
): Promise<SourceTurnDeliveryRegistry> {
  return readRegistry(registryPath);
}

function matchesExternalSourceDeliveryQueue(
  row: SourceTurnDeliveryRow,
  identity: ExternalSourceDeliveryQueueIdentity,
): boolean {
  const prepared = row.preparedSourceFinal;
  return (
    prepared?.kind === "external_channel" &&
    row.sourceChannel === identity.channel &&
    row.deliveryContext?.channel === identity.channel &&
    row.deliveryContext?.to === identity.to &&
    (row.deliveryContext?.accountId ?? "") === (identity.accountId ?? "") &&
    String(row.deliveryContext?.threadId ?? "") === String(identity.threadId ?? "") &&
    isDeepStrictEqual(
      prepared.parts.map((part) => prepareDeliveryQueuePayload(part.payload)),
      identity.payloads,
    )
  );
}

async function resolveExternalSourceDeliveryQueueOwner(params: {
  registryPath: string;
  identity: ExternalSourceDeliveryQueueIdentity;
}): Promise<
  | (SourceTurnDeliveryRow & {
      sourceSessionKey: string;
      preparedSourceFinal: Extract<SourceTurnPreparedSourceFinal, { kind: "external_channel" }>;
    })
  | undefined
> {
  const registry = await readRegistry(params.registryPath);
  const sourceOwner = params.identity.owner;
  if (sourceOwner && sourceOwner.kind !== SOURCE_TURN_DELIVERY_QUEUE_OWNER_KIND) {
    return undefined;
  }
  const queueOwners = sourceOwner
    ? registry.rows.filter((row) => row.idempotencyKey === sourceOwner.key)
    : registry.rows.filter((row) => {
        const prepared = row.preparedSourceFinal;
        return (
          prepared?.kind === "external_channel" &&
          prepared.outboundDelivery.status !== "prepared" &&
          prepared.outboundDelivery.queueId === params.identity.queueId
        );
      });
  if (queueOwners.length > 1) {
    throw new Error("External delivery queue identity has multiple source owners");
  }
  const owner = queueOwners[0];
  if (!owner) {
    if (sourceOwner) {
      throw new Error("External delivery queue source owner is missing");
    }
    return undefined;
  }
  if (!matchesExternalSourceDeliveryQueue(owner, params.identity)) {
    throw new Error("External delivery queue owner does not match its saved route and payload");
  }
  if (!owner.sourceSessionKey) {
    throw new Error("External delivery queue owner requires its source session");
  }
  const prepared = owner.preparedSourceFinal;
  if (
    prepared?.kind !== "external_channel" ||
    (prepared.outboundDelivery.status !== "prepared" &&
      prepared.outboundDelivery.queueId !== params.identity.queueId)
  ) {
    throw new Error("External delivery queue owner has a different transport identity");
  }
  return owner as SourceTurnDeliveryRow & {
    sourceSessionKey: string;
    preparedSourceFinal: Extract<SourceTurnPreparedSourceFinal, { kind: "external_channel" }>;
  };
}

export async function transitionExternalSourceDelivery(params: {
  registryPath?: string;
  owner: DeliveryQueueOwnerReference;
  delivery: ExternalSourceDeliveryTransition;
}): Promise<SourceTurnDeliveryRow> {
  const registryPath = params.registryPath ?? resolveSourceTurnDeliveryRegistryPath();
  if (params.owner.kind !== SOURCE_TURN_DELIVERY_QUEUE_OWNER_KIND) {
    throw new Error("External delivery transition requires a source delivery owner");
  }
  return await withSourceTurnDeliveryRegistryLock(registryPath, async () => {
    const registry = await readRegistry(registryPath);
    const owners = registry.rows.filter((row) => row.idempotencyKey === params.owner.key);
    if (owners.length !== 1) {
      throw new Error(
        owners.length === 0
          ? "External delivery queue source owner is missing"
          : "External delivery queue identity has multiple source owners",
      );
    }
    const owner = owners[0];
    const prepared = owner.preparedSourceFinal;
    if (prepared?.kind !== "external_channel") {
      throw new Error("External delivery transition requires a prepared external source final");
    }
    const current = prepared.outboundDelivery;
    if (current.status !== "prepared" && current.queueId !== params.delivery.queueId) {
      throw new Error("Prepared external final transport identity cannot change");
    }
    if (params.delivery.status === "delivered" && current.status === "prepared") {
      throw new Error(
        "Recovered external delivery must bind its queue owner before receipt commit",
      );
    }
    if (current.status === "delivered") {
      if (
        params.delivery.status === "delivered" &&
        !isDeepStrictEqual(current.receipt, params.delivery.receipt)
      ) {
        throw new Error("Prepared external final transport receipt cannot change");
      }
      return owner;
    }
    if (current.status === "queued" && params.delivery.status === "queued") {
      return owner;
    }
    const next: SourceTurnDeliveryRow = {
      ...owner,
      updatedAt: new Date().toISOString(),
      currentStage:
        params.delivery.status === "queued"
          ? "final_dispatch_transport_queued"
          : "final_dispatch_transport_delivered",
      preparedSourceFinal: {
        ...prepared,
        outboundDelivery: params.delivery,
      },
    };
    await writeRegistry(registryPath, {
      rows: registry.rows.map((row) => (row === owner ? next : row)),
    });
    return next;
  });
}

export async function settleSourceTurnDeliveryFinal(params: {
  registryPath?: string;
  owner: DeliveryQueueOwnerReference;
}): Promise<SourceTurnDeliveryRow> {
  const registryPath = params.registryPath ?? resolveSourceTurnDeliveryRegistryPath();
  if (params.owner.kind !== SOURCE_TURN_DELIVERY_QUEUE_OWNER_KIND) {
    throw new Error("Source final settlement requires a source delivery owner");
  }
  return await withSourceTurnDeliveryRegistryLock(registryPath, async () => {
    const registry = await readRegistry(registryPath);
    const owners = registry.rows.filter((row) => row.idempotencyKey === params.owner.key);
    if (owners.length !== 1) {
      throw new Error(
        owners.length === 0
          ? "Source final settlement owner is missing"
          : "Source final settlement has multiple owners",
      );
    }
    const owner = owners[0];
    const prepared = owner.preparedSourceFinal;
    if (
      !prepared ||
      prepared.parts.length !== prepared.expectedPartCount ||
      (prepared.kind === "external_channel" && prepared.outboundDelivery.status !== "delivered")
    ) {
      throw new Error("Incomplete prepared source final cannot be delivered");
    }
    if (owner.finalDeliveryDelivered) {
      return owner;
    }
    const decision = resolveSourceTurnDeliveryState({
      finalDeliveryRequired: true,
      finalDeliveryDelivered: true,
      evidenceKinds: ["source_chat_final"],
    });
    const durabilityDecision = resolveGovernedRunDurability({
      finalDeliveryRequired: true,
      deliveryObligationStage: "delivered",
      idempotencyKey: owner.idempotencyKey,
    });
    const next: SourceTurnDeliveryRow = {
      ...owner,
      updatedAt: new Date().toISOString(),
      deliveryStatus: statusForDecision(decision),
      obligationStage: "delivered",
      sourceTurnState: decision.state,
      finalDeliveryDelivered: true,
      visibleDeliveryCount: visibleDeliveryCountForDecision(decision),
      currentStage: "final_dispatch_delivered",
      deliveryDecision: decision,
      durabilityDecision,
    };
    delete next.failureReason;
    await writeRegistry(registryPath, {
      rows: registry.rows.map((row) => (row === owner ? next : row)),
    });
    return next;
  });
}

export async function prepareExternalSourceDeliveryQueueOwner(params: {
  registryPath?: string;
  identity: ExternalSourceDeliveryQueueIdentity;
}): Promise<ExternalSourceDeliveryQueueOwnerState> {
  const registryPath = params.registryPath ?? resolveSourceTurnDeliveryRegistryPath();
  const owner = await resolveExternalSourceDeliveryQueueOwner({
    registryPath,
    identity: params.identity,
  });
  if (!owner) {
    return { status: "not_owned" };
  }
  if (owner.preparedSourceFinal.outboundDelivery.status === "delivered") {
    return { status: "delivered", sourceSessionKey: owner.sourceSessionKey };
  }
  if (owner.preparedSourceFinal.outboundDelivery.status === "prepared") {
    // The queue persists this correlation before the live owner-binding hook.
    // Recovery completes that binding so a crash cannot publish an orphaned final.
    const transitioned = await transitionExternalSourceDelivery({
      registryPath,
      owner: createSourceTurnDeliveryQueueOwnerReference(owner),
      delivery: {
        status: "queued",
        queueId: params.identity.queueId,
      },
    });
    return {
      status:
        transitioned.preparedSourceFinal?.kind === "external_channel" &&
        transitioned.preparedSourceFinal.outboundDelivery.status === "delivered"
          ? "delivered"
          : "pending",
      sourceSessionKey: owner.sourceSessionKey,
    };
  }
  return { status: "pending", sourceSessionKey: owner.sourceSessionKey };
}

export async function inspectExternalSourceDeliveryQueueOwner(params: {
  registryPath?: string;
  identity: ExternalSourceDeliveryQueueIdentity;
}): Promise<ExternalSourceDeliveryQueueOwnerState> {
  const owner = await resolveExternalSourceDeliveryQueueOwner({
    registryPath: params.registryPath ?? resolveSourceTurnDeliveryRegistryPath(),
    identity: params.identity,
  });
  if (!owner) {
    return { status: "not_owned" };
  }
  return {
    status:
      owner.preparedSourceFinal.outboundDelivery.status === "delivered" ? "delivered" : "pending",
    sourceSessionKey: owner.sourceSessionKey,
  };
}

export async function recordRecoveredExternalSourceDelivery(params: {
  registryPath?: string;
  identity: ExternalSourceDeliveryQueueIdentity;
  receipt: MessageReceipt;
}): Promise<ExternalSourceDeliveryQueueOwnerState> {
  const registryPath = params.registryPath ?? resolveSourceTurnDeliveryRegistryPath();
  const owner = await resolveExternalSourceDeliveryQueueOwner({
    registryPath,
    identity: params.identity,
  });
  if (!owner) {
    return { status: "not_owned" };
  }
  const prepared = owner.preparedSourceFinal;
  if (prepared.outboundDelivery.status === "prepared") {
    throw new Error("Recovered external delivery must bind its queue owner before receipt commit");
  }
  await transitionExternalSourceDelivery({
    registryPath,
    owner: createSourceTurnDeliveryQueueOwnerReference(owner),
    delivery: {
      status: "delivered",
      queueId: params.identity.queueId,
      receipt: params.receipt,
    },
  });
  return { status: "delivered", sourceSessionKey: owner.sourceSessionKey };
}

export async function persistSourceTurnDeliveryState(
  params: PersistSourceTurnDeliveryParams,
): Promise<SourceTurnDeliveryRow> {
  // Serialize the entire update, including same-process callers. Reentrant locks
  // would permit overlapping reads; atomic replacement also protects live readers.
  return await withSourceTurnDeliveryRegistryLock(params.registryPath, async () => {
    const registry = await readRegistry(params.registryPath);
    const legacyExisting = registry.rows.find((row) => row.id === params.id);
    const decision = resolveSourceTurnDeliveryState(params.facts);
    const now = params.now ?? new Date().toISOString();
    const sourceTurnId = params.sourceTurnId ?? legacyExisting?.sourceTurnId ?? params.id;
    const obligationIdentity = normalizeObligationIdentity(params, legacyExisting);
    const idempotencyKey = buildSourceTurnDeliveryObligationKey({
      sourceTurnId,
      ...obligationIdentity,
    });
    const existing =
      registry.rows.find((row) => row.idempotencyKey === idempotencyKey) ??
      (hasExplicitObligationIdentity(params) ? undefined : legacyExisting);
    const obligationStage = deriveObligationStage({
      decision,
      facts: params.facts,
      reportArtifactPaths: params.reportArtifactPaths,
      reportPrepared: params.reportPrepared,
      deliveryAttempted: params.deliveryAttempted,
      needsReview: params.needsReview,
    });
    const markFacingExport = normalizeMarkFacingExportDelivery(params.facts);
    const trbRecovery = normalizeTrbRecoveryLinkage(params.facts);
    const sourceSessionKey =
      normalizeIdentityPart(params.sourceSessionKey) ??
      normalizeIdentityPart(existing?.sourceSessionKey);
    const sourceMessageId =
      normalizeIdentityPart(params.sourceMessageId) ??
      normalizeIdentityPart(existing?.sourceMessageId);
    const sourceChannel =
      normalizeIdentityPart(params.sourceChannel) ?? normalizeIdentityPart(existing?.sourceChannel);
    const deliveryContext =
      normalizeDeliveryContext(params.deliveryContext) ??
      normalizeDeliveryContext(existing?.deliveryContext);
    const retryOrRecoveryRecorded = hasRetryOrRecoveryCoverage(params.watchdogReconciliation);
    const durabilityDecision = resolveGovernedRunDurability({
      finalDeliveryRequired:
        params.facts.finalDeliveryRequired === true || params.facts.reportRequired === true,
      deliveryObligationStage: toGovernedRunDeliveryObligationStage(obligationStage),
      deliveryRetryScheduled: retryOrRecoveryRecorded,
      deliveryRecoveryHandoffRecorded: retryOrRecoveryRecorded,
      deliveryExhaustedBlockerRecorded:
        params.watchdogReconciliation?.status?.toLowerCase() === "closed_verified_blocked",
      idempotencyKey,
    });
    const parentYieldWaits = params.parentYieldWaits ?? existing?.parentYieldWaits;
    const preparedSourceFinal = resolvePreparedSourceFinal({
      prepared: params.preparedSourceFinal,
      existing,
      sourceSessionKey,
      sourceChannel,
      deliveryContext,
      parentYieldWaits,
      runId: obligationIdentity.runId,
      obligationKey: idempotencyKey,
      externalDelivery: params.preparedExternalFinalDelivery,
    });
    if (
      decision.finalDeliveryDelivered &&
      preparedSourceFinal &&
      (preparedSourceFinal.parts.length !== preparedSourceFinal.expectedPartCount ||
        (preparedSourceFinal.kind === "external_channel" &&
          preparedSourceFinal.outboundDelivery.status !== "delivered"))
    ) {
      throw new Error("Incomplete prepared source final cannot be delivered");
    }
    const row: SourceTurnDeliveryRow = {
      id: params.id,
      kind: SOURCE_TURN_DELIVERY_ROW_KIND,
      sourceTurnId,
      ...(sourceSessionKey ? { sourceSessionKey } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(sourceChannel ? { sourceChannel } : {}),
      ...(deliveryContext ? { deliveryContext } : {}),
      ...(parentYieldWaits?.length
        ? { parentYieldWaits: parentYieldWaits.map((wait) => Object.assign({}, wait)) }
        : {}),
      ...(preparedSourceFinal ? { preparedSourceFinal } : {}),
      acceptedAt: existing?.acceptedAt ?? now,
      updatedAt: now,
      deliveryStatus: statusForDecision(decision),
      obligationStage,
      obligationIdentity,
      idempotencyKey,
      sourceTurnState: decision.state,
      finalDeliveryDelivered: decision.finalDeliveryDelivered,
      visibleDeliveryCount: visibleDeliveryCountForDecision(decision),
      ...(params.currentStage ? { currentStage: params.currentStage } : {}),
      ...(decision.state === "final_delivery_failed" ||
      decision.state === "final_delivery_unknown" ||
      decision.state === "blocked_refused"
        ? { failureReason: decision.reason }
        : {}),
      ...(params.reportArtifactPaths && params.reportArtifactPaths.length > 0
        ? { reportArtifactPaths: [...params.reportArtifactPaths] }
        : {}),
      ...(markFacingExport ? { markFacingExport } : {}),
      ...(trbRecovery ? { trbRecovery } : {}),
      ...(params.watchdogReconciliation
        ? { watchdogReconciliation: params.watchdogReconciliation }
        : decision.state === "settled_resolved_later"
          ? {
              watchdogReconciliation: {
                status: "settled_resolved_later",
                action: "settle-source-resolved-later",
                reason: decision.reason,
                originalFinalDeliveryDelivered: false,
                originalVisibleDeliveryCount: 0,
              },
            }
          : {}),
      deliveryDecision: decision,
      durabilityDecision,
    };
    const nextRows = existing
      ? registry.rows.map((candidate) => (candidate === existing ? row : candidate))
      : [...registry.rows, row];
    // Readers do not acquire the writer lock, so a failed replacement must
    // leave the previous registry intact.
    await writeRegistry(params.registryPath, { rows: nextRows });
    return row;
  });
}

export function classifySourceTurnDeliveryWatchdogStatus(
  row: SourceTurnDeliveryRow,
): SourceTurnDeliveryWatchdogStatus {
  if (!row.durabilityDecision?.allowedToSettle && row.durabilityDecision?.watchdogVisible) {
    if (
      row.deliveryStatus === "delivery_failed" ||
      row.sourceTurnState === "final_delivery_failed"
    ) {
      return "blocking_failed";
    }
    if (
      row.deliveryStatus === "delivery_unknown" ||
      row.sourceTurnState === "final_delivery_unknown"
    ) {
      return "blocking_pending";
    }
    if (row.deliveryStatus === "blocked" || row.sourceTurnState === "blocked_refused") {
      return "blocking_refused";
    }
    return "blocking_pending";
  }
  const reconciliationStatus = row.watchdogReconciliation?.status?.toLowerCase() ?? "";
  const deliveryStatus = row.deliveryStatus.toLowerCase();
  if (row.finalDeliveryDelivered || deliveryStatus === "final_delivered") {
    return "non_blocking_delivered";
  }
  if (
    deliveryStatus === "archived_stale_or_orphaned" ||
    reconciliationStatus === "archived_stale_or_orphaned"
  ) {
    return "non_blocking_archived";
  }
  if (reconciliationStatus === "settled_resolved_later") {
    return "non_blocking_settled";
  }
  if (row.sourceTurnState === "failure_delivered" || deliveryStatus === "failure_delivered") {
    return "non_blocking_delivered";
  }
  if (deliveryStatus === "delivery_failed" || row.sourceTurnState === "final_delivery_failed") {
    return "blocking_failed";
  }
  if (deliveryStatus === "delivery_unknown" || row.sourceTurnState === "final_delivery_unknown") {
    return "blocking_pending";
  }
  if (deliveryStatus === "blocked" || row.sourceTurnState === "blocked_refused") {
    return "blocking_refused";
  }
  return "blocking_pending";
}

export function sourceTurnDeliveryBlocksWatchdog(row: SourceTurnDeliveryRow): boolean {
  return classifySourceTurnDeliveryWatchdogStatus(row).startsWith("blocking_");
}
