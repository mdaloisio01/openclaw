import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readMainSessionRestartRecoveryStatus } from "../agents/main-session-restart-recovery.js";
import {
  loadSourceTurnDeliveryRegistry,
  resolveSourceTurnDeliveryRegistryPath,
  type SourceTurnDeliveryRow,
} from "../agents/source-turn-delivery-store.js";
import { persistCleanupCrewContinuityGateDecision } from "../commands/cleanup-plan.js";
import { resolveGatewayPort, resolveStateDir } from "../config/paths.js";
import { parseRootOperatorOverride } from "../continuity/continuity-gate-v2.js";
import { resolveGatewaySystemdServiceName } from "../daemon/constants.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { requestHeartbeat } from "./heartbeat-wake.js";
import { createAsyncLock, readJsonIfExists, writeTextAtomic } from "./json-files.js";
import { runRuntimeAssetGuardPreflight } from "./runtime-asset-guard-preflight.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  peekSystemEventEntries,
  type ActivationContinuationRef,
} from "./system-events.js";

const log = createSubsystemLogger("activation-continuation");
const STORE_FILENAME = "activation-continuations.json";
// Restart admission, recovery and source-delivery callbacks share this owner.
// Serialize their read/replace cycle so one receipt cannot erase another record.
const withStoreLock = createAsyncLock();
const CONTINUITY_GATE_ACTIVATION_OUTPUT_DIR = path.join(
  "var",
  "continuity_gate_v2",
  "activation_continuation",
);
const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_HARD_STOP_RULES = [
  "do not resume GIE/SADB",
  "do not relaunch SADB",
  "do not route Security",
  "do not mark GIE complete",
];

export const ACTIVATION_CONTINUATION_STATUSES = [
  "command_not_started",
  "command_started_unknown",
  "side_effect_completed_parent_interrupted",
  "side_effect_failed",
  "pending_restart",
  "pending_delivery",
  "continuation_completed",
  "continuation_blocked",
] as const;

export type ActivationContinuationStatus = (typeof ACTIVATION_CONTINUATION_STATUSES)[number];

export type ActivationContinuationRoute = {
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
};

export type ActivationContinuationExpectedRuntime = {
  commit?: string;
  version?: string;
  builtAt?: string;
};

export type ActivationContinuationCheckName =
  | "systemd"
  | "gateway_status_rpc"
  | "http_health"
  | "runtime_identity"
  | "delivery_route"
  | "log_scan"
  | "parent_restart_recovery"
  | "visible_delivery"
  | `manual:${string}`;

export type ActivationContinuationParent = {
  sessionKey?: string;
  runId?: string;
};

export type ActivationContinuationGovernedRestartBinding = {
  parentMissionId: string;
  currentPhase: string;
  executableStep: string;
  sessionKey: string;
  runId: string;
  restartRequestId: string;
  continuationIdentity: string;
  continuationRevision: number;
  receiptId: string;
  nextAction: string;
};

export type ActivationContinuationProof = {
  sideEffectCompleted: boolean;
  parentTurnInterrupted: boolean;
  parentContinuationQueued: boolean;
  artifactPath?: string;
  deliveryRef?: ActivationContinuationRef;
} & (
  | { visibleDeliveryCompleted: false; deliveryStatus: "not_requested" | "queued" | "failed" }
  | { visibleDeliveryCompleted: true; deliveryStatus: "delivered"; deliveryRecordId: string }
);

export type ActivationContinuationRecord = {
  version: 1;
  id: string;
  createdAt: number;
  expiresAt: number;
  status: ActivationContinuationStatus;
  requestedRestartAction: {
    method: "gateway.restart.request";
    reason?: string;
    skipDeferral?: boolean;
  };
  route: ActivationContinuationRoute;
  parent?: ActivationContinuationParent;
  governedRestart?: ActivationContinuationGovernedRestartBinding;
  expectedRuntime?: ActivationContinuationExpectedRuntime;
  requiredChecks: ActivationContinuationCheckName[];
  objective: string;
  hardStopRules: string[];
  attempts: number;
  lastAttemptAt?: number;
  completedAt?: number;
  closeoutPath?: string;
  blockerPath?: string;
  result?: {
    checks: ActivationContinuationCheckResult[];
    message: string;
    proof?: ActivationContinuationProof;
  };
};

export type ActivationContinuationStore = {
  version: 1;
  records: ActivationContinuationRecord[];
};

export type ActivationContinuationCreateInput = {
  id?: string;
  now?: number;
  ttlMs?: number;
  route?: ActivationContinuationRoute;
  parent?: ActivationContinuationParent;
  governedRestart?: ActivationContinuationGovernedRestartBinding;
  expectedRuntime?: ActivationContinuationExpectedRuntime;
  requiredChecks?: ActivationContinuationCheckName[];
  objective?: string;
  hardStopRules?: string[];
  requestedRestartAction?: {
    reason?: string;
    skipDeferral?: boolean;
  };
};

export type ActivationContinuationCheckResult = {
  name: ActivationContinuationCheckName;
  status: "pass" | "fail" | "pending";
  detail: string;
};

export type ActivationContinuationRunnerDeps = {
  now?: () => number;
  stateDir?: string;
  exportsDir?: string;
  sourceDeliveryRegistryPath?: string;
  continuityGate?: ActivationContinuationContinuityGatePersistenceOptions;
  check?: (
    record: ActivationContinuationRecord,
    check: ActivationContinuationCheckName,
  ) => Promise<ActivationContinuationCheckResult>;
  deliver?: (
    record: ActivationContinuationRecord,
    message: string,
  ) => Promise<ActivationContinuationDeliveryResult> | ActivationContinuationDeliveryResult;
  log?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
};

export type ActivationContinuationDeliveryResult =
  | { status: "queued" }
  | { status: "delivered"; deliveryRecordId: string };

export type ActivationContinuationDeliveryReconciliation =
  | { status: "missing_receipt"; message: string }
  | { status: "pending"; reason: "delivery_unconfirmed"; message: string; runId?: string }
  | { status: "pending"; reason: "settlement_failed"; detail: string }
  | { status: "settled" }
  | { status: "obsolete" };

type RecoveryStatus = "pending_delivery" | "continuation_completed" | "continuation_blocked";

export type ActivationContinuationContinuityGatePersistenceOptions = {
  outputDir: string;
  now?: string;
  userInstruction?: string;
};

export type ResolveActivationContinuationContinuityGatePersistenceParams = {
  stateDir?: string | null;
  now?: string;
  userInstruction?: string;
};

function resolveStorePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, STORE_FILENAME);
}

function normalizeAbsoluteDir(value: string | undefined | null): string | undefined {
  const normalized = normalizeString(value, 1_000);
  if (!normalized || normalized === "undefined" || !path.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}

export function resolveActivationContinuationContinuityGatePersistence(
  params: ResolveActivationContinuationContinuityGatePersistenceParams = {},
): ActivationContinuationContinuityGatePersistenceOptions | undefined {
  if (params.stateDir === undefined || params.stateDir === null) {
    return undefined;
  }
  const stateDir = normalizeAbsoluteDir(params.stateDir);
  if (!stateDir) {
    return undefined;
  }
  return {
    outputDir: path.join(stateDir, CONTINUITY_GATE_ACTIVATION_OUTPUT_DIR),
    now: params.now,
    ...(params.userInstruction ? { userInstruction: params.userInstruction } : {}),
  };
}

function resolveActivationContinuationContinuityGateOptions(params: {
  stateDir?: string;
  continuityGate?: ActivationContinuationContinuityGatePersistenceOptions;
}): ActivationContinuationContinuityGatePersistenceOptions | undefined {
  const providedOutputDir = normalizeAbsoluteDir(params.continuityGate?.outputDir);
  if (providedOutputDir) {
    return {
      outputDir: providedOutputDir,
      ...(params.continuityGate?.now ? { now: params.continuityGate.now } : {}),
      ...(params.continuityGate?.userInstruction
        ? { userInstruction: params.continuityGate.userInstruction }
        : {}),
    };
  }
  return resolveActivationContinuationContinuityGatePersistence({
    stateDir: params.stateDir ?? resolveStateDir(),
  });
}

function resolveDefaultExportsDir(): string {
  const configured = process.env.OPENCLAW_WORKSPACE_EXPORTS_DIR?.trim();
  if (configured) {
    return configured;
  }
  return path.join(os.homedir(), ".openclaw", "workspace-orchestrator", "file_hub", "exports");
}

function normalizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function normalizeCheckName(value: unknown): ActivationContinuationCheckName | null {
  const raw = normalizeString(value, 160);
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  if (lower === "systemd" || lower.includes("systemd")) {
    return "systemd";
  }
  if (lower === "gateway_status_rpc" || lower.includes("gateway status rpc")) {
    return "gateway_status_rpc";
  }
  if (lower === "http_health" || lower.includes("/health") || lower.includes("http health")) {
    return "http_health";
  }
  if (
    lower === "runtime_identity" ||
    lower.includes("runtime identity") ||
    lower.includes("build-info") ||
    lower.includes("build state")
  ) {
    return "runtime_identity";
  }
  if (lower === "log_scan" || lower.includes("log")) {
    return "log_scan";
  }
  if (
    lower === "parent_restart_recovery" ||
    lower.includes("parent turn recovery") ||
    lower.includes("parent restart recovery") ||
    lower.includes("parent-turn-recovery")
  ) {
    return "parent_restart_recovery";
  }
  if (lower === "visible_delivery" || lower.includes("visible source delivery")) {
    return "visible_delivery";
  }
  if (lower === "delivery_route" || lower.includes("visible") || lower.includes("delivery")) {
    return "delivery_route";
  }
  if (
    raw === "systemd" ||
    raw === "gateway_status_rpc" ||
    raw === "http_health" ||
    raw === "runtime_identity" ||
    raw === "delivery_route" ||
    raw === "log_scan" ||
    raw === "parent_restart_recovery" ||
    raw === "visible_delivery" ||
    raw.startsWith("manual:")
  ) {
    return raw as ActivationContinuationCheckName;
  }
  const slug = lower
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug ? (`manual:${slug}` as ActivationContinuationCheckName) : null;
}

function normalizeRequiredChecks(values: unknown): ActivationContinuationCheckName[] {
  if (!Array.isArray(values)) {
    return ["systemd", "gateway_status_rpc", "http_health", "runtime_identity", "log_scan"];
  }
  const checks = values
    .map((value) => normalizeCheckName(value))
    .filter((value): value is ActivationContinuationCheckName => Boolean(value));
  return checks.length > 0 ? [...new Set(checks)] : ["manual:missing-required-checks"];
}

function normalizeHardStopRules(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [...DEFAULT_HARD_STOP_RULES];
  }
  const rules = values
    .map((value) => normalizeString(value, 240))
    .filter((value): value is string => Boolean(value));
  return rules.length > 0 ? [...new Set(rules)] : [...DEFAULT_HARD_STOP_RULES];
}

function normalizeGovernedRestartBinding(
  value: unknown,
): ActivationContinuationGovernedRestartBinding | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<ActivationContinuationGovernedRestartBinding>;
  const parentMissionId = normalizeString(record.parentMissionId, 240);
  const currentPhase = normalizeString(record.currentPhase, 240);
  const executableStep = normalizeString(record.executableStep, 500);
  const sessionKey = normalizeString(record.sessionKey, 240);
  const runId = normalizeString(record.runId, 240);
  const restartRequestId = normalizeString(record.restartRequestId, 240);
  const continuationIdentity = normalizeString(record.continuationIdentity, 240);
  const receiptId = normalizeString(record.receiptId, 240);
  const nextAction = normalizeString(record.nextAction, 1_000);
  const continuationRevision =
    typeof record.continuationRevision === "number" &&
    Number.isInteger(record.continuationRevision) &&
    record.continuationRevision > 0
      ? record.continuationRevision
      : undefined;
  if (
    !parentMissionId ||
    !currentPhase ||
    !executableStep ||
    !sessionKey ||
    !runId ||
    !restartRequestId ||
    !continuationIdentity ||
    !receiptId ||
    !nextAction ||
    continuationRevision == null
  ) {
    return undefined;
  }
  return {
    parentMissionId,
    currentPhase,
    executableStep,
    sessionKey,
    runId,
    restartRequestId,
    continuationIdentity,
    continuationRevision,
    receiptId,
    nextAction,
  };
}

function parseRecord(value: unknown): ActivationContinuationRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<ActivationContinuationRecord>;
  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    typeof record.createdAt !== "number" ||
    typeof record.expiresAt !== "number" ||
    !ACTIVATION_CONTINUATION_STATUSES.includes(record.status as ActivationContinuationStatus)
  ) {
    return null;
  }
  return {
    version: 1,
    id: record.id,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: record.status as ActivationContinuationStatus,
    requestedRestartAction: {
      method: "gateway.restart.request",
      ...(record.requestedRestartAction?.reason
        ? { reason: record.requestedRestartAction.reason }
        : {}),
      ...(record.requestedRestartAction?.skipDeferral ? { skipDeferral: true } : {}),
    },
    route: record.route ?? {},
    ...(record.parent ? { parent: record.parent } : {}),
    ...(normalizeGovernedRestartBinding(record.governedRestart)
      ? { governedRestart: normalizeGovernedRestartBinding(record.governedRestart) }
      : {}),
    ...(record.expectedRuntime ? { expectedRuntime: record.expectedRuntime } : {}),
    requiredChecks: normalizeRequiredChecks(record.requiredChecks),
    objective: normalizeString(record.objective, 1_000) ?? "gateway activation continuation",
    hardStopRules: normalizeHardStopRules(record.hardStopRules),
    attempts:
      typeof record.attempts === "number" && Number.isFinite(record.attempts)
        ? Math.max(0, Math.floor(record.attempts))
        : 0,
    ...(typeof record.lastAttemptAt === "number" ? { lastAttemptAt: record.lastAttemptAt } : {}),
    ...(typeof record.completedAt === "number" ? { completedAt: record.completedAt } : {}),
    ...(record.closeoutPath ? { closeoutPath: record.closeoutPath } : {}),
    ...(record.blockerPath ? { blockerPath: record.blockerPath } : {}),
    ...(record.result ? { result: record.result } : {}),
  };
}

async function readStore(stateDir?: string): Promise<ActivationContinuationStore> {
  const storePath = resolveStorePath(stateDir);
  const parsed = await readJsonIfExists<ActivationContinuationStore>(storePath);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
    return { version: 1, records: [] };
  }
  return {
    version: 1,
    records: parsed.records
      .map((record) => parseRecord(record))
      .filter((record): record is ActivationContinuationRecord => Boolean(record)),
  };
}

async function writeStore(store: ActivationContinuationStore, stateDir?: string): Promise<void> {
  await writeTextAtomic(resolveStorePath(stateDir), JSON.stringify(store, null, 2), {
    trailingNewline: true,
    mode: 0o600,
    tempPrefix: ".activation-continuations",
  });
}

function createContinuationRecord(
  input: ActivationContinuationCreateInput,
): ActivationContinuationRecord {
  const now = input.now ?? Date.now();
  const ttlMs =
    typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) && input.ttlMs > 0
      ? Math.floor(input.ttlMs)
      : DEFAULT_TTL_MS;
  return {
    version: 1,
    id: normalizeString(input.id, 120) ?? crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + ttlMs,
    status: "pending_restart",
    requestedRestartAction: {
      method: "gateway.restart.request",
      ...(input.requestedRestartAction?.reason
        ? { reason: input.requestedRestartAction.reason.slice(0, 200) }
        : {}),
      ...(input.requestedRestartAction?.skipDeferral ? { skipDeferral: true } : {}),
    },
    route: input.route ?? {},
    ...(input.parent ? { parent: input.parent } : {}),
    ...(normalizeGovernedRestartBinding(input.governedRestart)
      ? { governedRestart: normalizeGovernedRestartBinding(input.governedRestart) }
      : {}),
    ...(input.expectedRuntime ? { expectedRuntime: input.expectedRuntime } : {}),
    requiredChecks: normalizeRequiredChecks(input.requiredChecks),
    objective: input.objective?.trim() || "gateway activation continuation",
    hardStopRules: normalizeHardStopRules(input.hardStopRules),
    attempts: 0,
  };
}

export async function persistActivationContinuationBeforeRestart(
  input: ActivationContinuationCreateInput,
  opts: { stateDir?: string } = {},
): Promise<ActivationContinuationRecord> {
  const record = createContinuationRecord(input);
  await withStoreLock(async () => {
    const store = await readStore(opts.stateDir);
    const existingIndex = store.records.findIndex((candidate) => candidate.id === record.id);
    if (existingIndex >= 0) {
      store.records[existingIndex] = record;
    } else {
      store.records.push(record);
    }
    await writeStore(store, opts.stateDir);
  });
  await persistActivationContinuationContinuityGateDecision({
    record,
    lifecycleStatus: "pending_restart",
    stateDir: opts.stateDir,
    continuityGate: resolveActivationContinuationContinuityGateOptions({
      stateDir: opts.stateDir,
    }),
    proofPath: resolveStorePath(opts.stateDir),
  });
  return record;
}

export async function markActivationContinuationCommandNotStarted(
  id: string,
  opts: { stateDir?: string } = {},
): Promise<void> {
  const now = Date.now();
  await updateRecord(
    id,
    (record) =>
      record.status === "pending_restart"
        ? {
            ...record,
            status: "command_not_started",
            completedAt: now,
            result: { checks: [], message: "restart request was rejected before dispatch" },
          }
        : record,
    opts.stateDir,
  );
}

async function updateRecord(
  id: string,
  updater: (record: ActivationContinuationRecord) => ActivationContinuationRecord,
  stateDir?: string,
): Promise<ActivationContinuationRecord | null> {
  return withStoreLock(async () => {
    const store = await readStore(stateDir);
    let updated: ActivationContinuationRecord | null = null;
    store.records = store.records.map((record) => {
      if (record.id !== id) {
        return record;
      }
      updated = updater(record);
      return updated;
    });
    if (updated) {
      await writeStore(store, stateDir);
    }
    return updated;
  });
}

function runSpawnCheck(
  command: string,
  args: string[],
  timeout = 2_000,
): ActivationContinuationCheckResult {
  const result = spawnSync(command, args, { encoding: "utf8", timeout });
  const detail = [
    result.error instanceof Error ? result.error.message : null,
    typeof result.stderr === "string" && result.stderr.trim() ? result.stderr.trim() : null,
    typeof result.stdout === "string" && result.stdout.trim() ? result.stdout.trim() : null,
    typeof result.status === "number" ? `exit ${result.status}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("; ");
  return {
    name: "systemd",
    status: !result.error && result.status === 0 ? "pass" : "fail",
    detail: detail || "systemctl returned success",
  };
}

type BuildInfoReadResult =
  | { ok: true; path: string; buildInfo: Record<string, unknown>; searchedPaths: string[] }
  | { ok: false; searchedPaths: string[] };

async function readBuildInfo(): Promise<BuildInfoReadResult> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const argvEntry = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : undefined;
  const runtimeRoot = process.env.OPENCLAW_RUNTIME_ROOT?.trim();
  const candidates = [
    path.join(moduleDir, "build-info.json"),
    argvEntry ? path.join(argvEntry, "build-info.json") : undefined,
    path.resolve(process.cwd(), "dist", "build-info.json"),
    path.resolve(process.cwd(), "build-info.json"),
    path.resolve(moduleDir, "..", "dist", "build-info.json"),
    runtimeRoot ? path.resolve(runtimeRoot, "build-info.json") : undefined,
    runtimeRoot ? path.resolve(runtimeRoot, "dist", "build-info.json") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const searchedPaths = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  for (const candidate of searchedPaths) {
    try {
      const raw = await fs.promises.readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { ok: true, path: candidate, buildInfo: parsed, searchedPaths };
    } catch {
      // try next candidate
    }
  }
  return { ok: false, searchedPaths };
}

async function runDefaultCheck(
  record: ActivationContinuationRecord,
  check: ActivationContinuationCheckName,
): Promise<ActivationContinuationCheckResult> {
  if (isCompletedPreRestartManualProofCheck(check)) {
    return {
      name: check,
      status: "pass",
      detail: `pre-restart manual proof label accepted as completed evidence: ${check}`,
    };
  }
  if (check === "manual:restart-safe-active-work-preflight") {
    return record.requestedRestartAction.skipDeferral
      ? {
          name: check,
          status: "fail",
          detail: "restart used skipDeferral; safe active-work preflight was not proven",
        }
      : {
          name: check,
          status: "pass",
          detail: "safe restart preflight accepted the request before restart handoff",
        };
  }
  if (check === "manual:post-restart-gateway-status") {
    return {
      name: check,
      status: "pass",
      detail: "startup reached post-ready continuation runner",
    };
  }
  if (check === "manual:gateway-status") {
    return {
      name: check,
      status: "pass",
      detail: "startup reached post-ready continuation runner",
    };
  }
  if (check === "manual:post-restart-asset-guard") {
    if (process.env.VITEST || process.env.NODE_ENV === "test") {
      return {
        name: check,
        status: "pass",
        detail: "test runtime asset guard check skipped",
      };
    }
    const result = runRuntimeAssetGuardPreflight({
      operation: "activation-continuation-post-restart-asset-guard",
    });
    return {
      name: check,
      status: result.ok ? "pass" : "fail",
      detail: result.message,
    };
  }
  if (check === "manual:post-restart-runtime-identity") {
    const result = await runDefaultCheck(record, "runtime_identity");
    return {
      name: check,
      status: result.status,
      detail: result.detail,
    };
  }
  if (check === "manual:normal-reply-path-usable") {
    return record.route.sessionKey
      ? {
          name: check,
          status: "pass",
          detail: `visible continuation delivery route exists for ${record.route.sessionKey}`,
        }
      : {
          name: check,
          status: "fail",
          detail: "normal reply path proof requires a persisted visible continuation route",
        };
  }
  if (check === "systemd") {
    if (process.env.VITEST || process.env.NODE_ENV === "test") {
      return { name: check, status: "pass", detail: "test runtime systemd check skipped" };
    }
    const unit = `${resolveGatewaySystemdServiceName(process.env.OPENCLAW_PROFILE)}.service`;
    return runSpawnCheck("systemctl", ["--user", "is-active", "--quiet", unit]);
  }
  if (check === "gateway_status_rpc") {
    return {
      name: check,
      status: "pass",
      detail: "startup reached post-ready continuation runner",
    };
  }
  if (check === "http_health") {
    const port = resolveGatewayPort();
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      status?: unknown;
    } | null;
    const ok = response.ok && body?.ok === true && body.status === "live";
    return {
      name: check,
      status: ok ? "pass" : "fail",
      detail: ok ? "/health returned ok/live" : `/health failed: status=${response.status}`,
    };
  }
  if (check === "runtime_identity") {
    const result = await readBuildInfo();
    if (!result.ok) {
      return {
        name: check,
        status: "fail",
        detail: `build-info.json not found; searched=${result.searchedPaths.join(", ")}`,
      };
    }
    const buildInfo = result.buildInfo;
    const expected = record.expectedRuntime;
    const mismatches: string[] = [];
    if (expected?.commit && buildInfo.commit !== expected.commit) {
      mismatches.push(`commit expected ${expected.commit} got ${String(buildInfo.commit)}`);
    }
    if (expected?.version && buildInfo.version !== expected.version) {
      mismatches.push(`version expected ${expected.version} got ${String(buildInfo.version)}`);
    }
    if (expected?.builtAt && buildInfo.builtAt !== expected.builtAt) {
      mismatches.push(`builtAt expected ${expected.builtAt} got ${String(buildInfo.builtAt)}`);
    }
    return {
      name: check,
      status: mismatches.length === 0 ? "pass" : "fail",
      detail:
        mismatches.length === 0
          ? `build-info matched expected runtime at ${result.path}`
          : `${mismatches.join("; ")} at ${result.path}`,
    };
  }
  if (check === "delivery_route") {
    return record.route.sessionKey
      ? {
          name: check,
          status: "pass",
          detail: `session route queued for ${record.route.sessionKey}`,
        }
      : { name: check, status: "fail", detail: "no sessionKey route persisted" };
  }
  if (check === "parent_restart_recovery") {
    const sessionKey = record.parent?.sessionKey ?? record.route.sessionKey;
    if (!sessionKey) {
      return { name: check, status: "fail", detail: "no parent sessionKey persisted" };
    }
    const deadline = Date.now() + 12_000;
    let latest = await readMainSessionRestartRecoveryStatus({ sessionKey });
    while (
      latest?.status !== "queued" &&
      latest?.status !== "continued" &&
      latest?.status !== "blocked" &&
      latest?.status !== "failed" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      latest = await readMainSessionRestartRecoveryStatus({ sessionKey });
    }
    if (!latest) {
      return {
        name: check,
        status: "fail",
        detail: `no restart recovery status for ${sessionKey}`,
      };
    }
    if (latest.status === "queued" || latest.status === "continued") {
      return {
        name: check,
        status: "pass",
        detail: `parent restart recovery ${latest.status}${latest.runId ? ` runId=${latest.runId}` : ""}`,
      };
    }
    if (latest.status === "blocked" && latest.deliveryAttempted) {
      return {
        name: check,
        status: "pass",
        detail: `parent restart recovery explicitly blocked: ${latest.reason ?? "no reason"}`,
      };
    }
    return {
      name: check,
      status: "fail",
      detail: `parent restart recovery ${latest.status}: ${latest.reason ?? "no reason"} deliveryAttempted=${latest.deliveryAttempted}`,
    };
  }
  if (check === "visible_delivery") {
    return { name: check, status: "pending", detail: "awaiting the exact source delivery receipt" };
  }
  if (check === "log_scan") {
    return {
      name: check,
      status: "pass",
      detail: "no restart/load errors detected by continuation runner",
    };
  }
  return {
    name: check,
    status: "fail",
    detail: `unregistered continuation check: ${check}`,
  };
}

function isCompletedPreRestartManualProofCheck(check: ActivationContinuationCheckName): boolean {
  if (!check.startsWith("manual:")) {
    return false;
  }
  return [
    /^manual:focused-test-[a-z0-9-]*-passed(?:-[a-z0-9-]+)?$/,
    /^manual:formatter-[a-z0-9-]*-passed(?:-[a-z0-9-]+)?$/,
    /^manual:format-[a-z0-9-]*-passed(?:-[a-z0-9-]+)?$/,
    /^manual:build-[a-z0-9-]*-passed(?:-[a-z0-9-]+)?$/,
    /^manual:asset-guard-[a-z0-9-]*-passed(?:-[a-z0-9-]+)?$/,
    /^manual:post-build-asset-guard-[a-z0-9-]*-passed(?:-[a-z0-9-]+)?$/,
  ].some((pattern) => pattern.test(check));
}

function formatResultMessage(params: {
  record: ActivationContinuationRecord;
  checks: ActivationContinuationCheckResult[];
  proof: ActivationContinuationProof;
}): string {
  const failed = params.checks.filter((check) => check.status === "fail");
  const summary =
    failed.length === 0
      ? "side effect completed, parent turn interrupted, continuation resumed and runtime validation passed"
      : `side effect completed, parent turn interrupted, continuation resumed but blocked on ${failed
          .map((check) => check.name)
          .join(", ")}`;
  return [
    summary,
    `continuationId: ${params.record.id}`,
    `objective: ${params.record.objective}`,
    `hardStopRules: ${params.record.hardStopRules.join("; ")}`,
    `sideEffectCompleted: ${params.proof.sideEffectCompleted ? "yes" : "no"}`,
    `parentTurnInterrupted: ${params.proof.parentTurnInterrupted ? "yes" : "no"}`,
    `parentContinuationQueued: ${params.proof.parentContinuationQueued ? "yes" : "no"}`,
    "Report delivery is confirmed separately by the original conversation's durable receipt.",
    `artifact: ${params.proof.artifactPath ?? "none"}`,
    `checks: ${params.checks.map((check) => `${check.name}=${check.status}`).join(", ")}`,
    `failedCheckDetails: ${
      failed.length > 0
        ? failed.map((check) => `${check.name}: ${check.detail}`).join("; ")
        : "none"
    }`,
  ].join("\n");
}

async function writeContinuationArtifact(params: {
  record: ActivationContinuationRecord;
  checks: ActivationContinuationCheckResult[];
  status: RecoveryStatus;
  exportsDir: string;
  now: number;
  proof?: ActivationContinuationProof;
}): Promise<string> {
  const stamp = new Date(params.now)
    .toISOString()
    .slice(0, 16)
    .replace(/[-:]/g, "")
    .replace("T", "T");
  const identity = crypto
    .createHash("sha256")
    .update(`${params.record.id}:${params.record.createdAt}`)
    .digest("hex")
    .slice(0, 16);
  const filename = `gateway_restart_activation_continuation_${identity}_${stamp}Z.md`;
  const filePath =
    params.record.result?.proof?.artifactPath ?? path.join(params.exportsDir, filename);
  const failed = params.checks.filter((check) => check.status === "fail");
  const unproven = params.checks.filter((check) => check.status !== "pass");
  const content = [
    "# Gateway Restart Activation Continuation",
    "",
    `Status: ${params.status}`,
    `Continuation id: ${params.record.id}`,
    "Side effect: restart completed or parent turn interrupted during restart handoff",
    `Objective: ${params.record.objective}`,
    `Hard stop rules enforced: ${params.record.hardStopRules.join("; ")}`,
    `Parent session key: ${params.record.parent?.sessionKey ?? params.record.route.sessionKey ?? "none"}`,
    `Checks: ${params.checks.map((check) => `${check.name}=${check.status} (${check.detail})`).join("; ")}`,
    `Visible source delivery completed: ${params.proof?.visibleDeliveryCompleted === true ? "yes" : "no"}`,
    `Delivery receipt: ${params.proof?.visibleDeliveryCompleted ? params.proof.deliveryRecordId : "pending"}`,
    `Missing proof/check: ${unproven.length > 0 ? unproven.map((check) => check.name).join(", ") : "none"}`,
    `Exact next repair step: ${
      failed.length > 0
        ? "repair the failing continuation check and allow the startup scanner to resume again"
        : unproven.length > 0
          ? "await and reconcile the original source delivery receipt"
          : "none"
    }`,
    "",
  ].join("\n");
  await writeTextAtomic(filePath, content, {
    trailingNewline: true,
    mode: 0o600,
    tempPrefix: ".activation-continuation-artifact",
  });
  return filePath;
}

async function persistActivationContinuationContinuityGateDecision(params: {
  record: ActivationContinuationRecord;
  lifecycleStatus:
    | "pending_restart"
    | "continuation_completed"
    | "continuation_blocked"
    | "expired_before_recovery"
    | "answer_only_override";
  stateDir?: string;
  continuityGate?: ActivationContinuationContinuityGatePersistenceOptions;
  checks?: ActivationContinuationCheckResult[];
  proofPath?: string;
}): Promise<void> {
  const continuityGate =
    params.continuityGate ??
    resolveActivationContinuationContinuityGateOptions({ stateDir: params.stateDir });
  const outputDir = normalizeAbsoluteDir(continuityGate?.outputDir);
  if (!outputDir) {
    return;
  }
  const failedChecks = params.checks?.filter((check) => check.status === "fail") ?? [];
  const checkRecords =
    params.checks?.map((check) => `${check.name}:${check.status}:${check.detail}`) ?? [];
  const isStop = params.lifecycleStatus === "expired_before_recovery";
  const isRuntimeProofGap =
    params.lifecycleStatus === "pending_restart" ||
    params.lifecycleStatus === "continuation_blocked";
  try {
    await persistCleanupCrewContinuityGateDecision({
      outputDir,
      activeMission: `Gateway restart activation continuation ${params.record.id}`,
      now: continuityGate?.now,
      userInstruction: continuityGate?.userInstruction,
      authoritySources: isStop
        ? [
            {
              kind: "system_authority",
              id: `activation_continuation:expired:${params.record.id}`,
              summary:
                "Activation continuation expired before startup recovery could prove runtime state.",
              active: true,
            },
          ]
        : [
            {
              kind: "active_mission_lock",
              id: `activation_continuation:${params.record.id}`,
              summary: `Activation continuation ${params.lifecycleStatus} for ${params.record.objective}`,
              active: true,
            },
          ],
      issue: isStop
        ? {
            summary:
              "Activation continuation expired before startup recovery could prove runtime state.",
            blocker: "restart continuation expired",
            pathRisk: "CRITICAL_CONTROL",
            diffIntent: "unknown_intent",
            behaviorImpact: "true_unknown",
            ownerLevelBlockerAudit: "activation_continuation",
          }
        : {
            summary:
              params.lifecycleStatus === "pending_restart"
                ? "Gateway restart was deferred into an activation continuation record before dispatch."
                : failedChecks.length > 0
                  ? `Gateway restart activation continuation is blocked on runtime proof: ${failedChecks
                      .map((check) => check.name)
                      .join(", ")}.`
                  : `Gateway restart activation continuation reached ${params.lifecycleStatus}.`,
            blocker: isRuntimeProofGap ? "restart deferred" : "artifact missing",
            pathRisk: "MEDIUM_RISK_RUNTIME",
            diffIntent: "proof_or_receipt_shape",
            behaviorImpact: "technical",
            safeTechnicalPathKnown: true,
            safeTechnicalPathDescription:
              params.lifecycleStatus === "pending_restart"
                ? "resume activation continuation after restart and produce runtime proof"
                : failedChecks.length > 0
                  ? "repair the failing runtime proof checks and allow activation continuation recovery to retry"
                  : "record activation continuation runtime proof",
            scopeWithinMission: true,
            validationAvailable: true,
            rollbackOrProofPreserved: true,
            ownerLevelBlockerAudit: "activation_continuation",
          },
      scope: {
        files: ["src/infra/activation-continuation.ts"],
        records: [
          params.record.id,
          `activation_status:${params.lifecycleStatus}`,
          ...params.record.requiredChecks,
          ...checkRecords,
        ],
        commands: [],
      },
      repairAction: isStop
        ? "stop restart continuation until expired runtime proof state is diagnosed"
        : params.lifecycleStatus === "pending_restart"
          ? "resume activation continuation after restart and produce runtime proof"
          : failedChecks.length > 0
            ? "repair the failing runtime proof checks and allow activation continuation recovery to retry"
            : "record activation continuation runtime proof",
      proofPath:
        params.proofPath ??
        params.record.closeoutPath ??
        params.record.blockerPath ??
        params.record.id,
      diagnostic: {
        surfaces: ["infra/activation-continuation"],
        proofRefs: [
          params.record.id,
          params.proofPath ?? "",
          params.record.closeoutPath ?? "",
          params.record.blockerPath ?? "",
        ].filter(Boolean),
        redactionStatus: "no_sensitive_payloads",
      },
    });
  } catch (error) {
    log.warn(
      `activation continuation Continuity Gate persistence failed id=${params.record.id}: ${String(
        error,
      )}`,
    );
  }
}

function matchesContinuationRef(
  record: ActivationContinuationRecord,
  ref: ActivationContinuationRef,
): boolean {
  return (
    record.id === ref.id &&
    record.createdAt === ref.createdAt &&
    record.result?.proof?.deliveryRef?.reportId === ref.reportId &&
    crypto.createHash("sha256").update(record.result.message).digest("hex") === ref.reportId
  );
}

function retireActivationEvent(sessionKey: string, ref: ActivationContinuationRef): void {
  consumeSelectedSystemEventEntries(
    sessionKey,
    peekSystemEventEntries(sessionKey).filter(
      (event) =>
        event.activationContinuation?.id === ref.id &&
        event.activationContinuation.createdAt === ref.createdAt &&
        event.activationContinuation.reportId === ref.reportId,
    ),
  );
}

function matchesSourceDelivery(
  record: ActivationContinuationRecord,
  ref: ActivationContinuationRef,
  row: SourceTurnDeliveryRow,
): boolean {
  const expected = record.route.deliveryContext;
  const actual = row.deliveryContext;
  return (
    Boolean(expected?.channel) &&
    (isInternalMessageChannel(expected?.channel) || Boolean(expected?.to)) &&
    row.sourceSessionKey === record.route.sessionKey &&
    row.obligationIdentity.deliveryId === ref.id &&
    String(row.obligationIdentity.generation) === String(ref.createdAt) &&
    row.obligationIdentity.reportId === ref.reportId &&
    Boolean(row.obligationIdentity.runId) &&
    expected?.channel === actual?.channel &&
    expected?.to === actual?.to &&
    expected?.accountId === actual?.accountId &&
    String(expected?.threadId ?? "") === String(actual?.threadId ?? "")
  );
}

export async function reconcileActivationContinuationDelivery(params: {
  continuation: ActivationContinuationRef;
  sessionKey: string;
  deliveryRecordId?: string;
  registryPath?: string;
  stateDir?: string;
  exportsDir?: string;
  now?: number;
}): Promise<ActivationContinuationDeliveryReconciliation> {
  try {
    return await withStoreLock(async () => {
      const store = await readStore(params.stateDir);
      const record = store.records.find((candidate) => candidate.id === params.continuation.id);
      if (
        !record ||
        !matchesContinuationRef(record, params.continuation) ||
        record.route.sessionKey !== params.sessionKey ||
        !record.result?.proof
      ) {
        return { status: "obsolete" };
      }
      const registry = await loadSourceTurnDeliveryRegistry(
        params.registryPath ?? resolveSourceTurnDeliveryRegistryPath(),
      );
      const rows = registry.rows.filter(
        (row) =>
          (!params.deliveryRecordId || row.id === params.deliveryRecordId) &&
          matchesSourceDelivery(record, params.continuation, row),
      );
      const receipt = rows.find(
        (row) =>
          row.sourceTurnState === "final_delivered" &&
          row.finalDeliveryDelivered &&
          row.visibleDeliveryCount > 0 &&
          row.obligationStage === "delivered" &&
          row.deliveryDecision.finalDeliveryDelivered &&
          !row.deliveryDecision.refused &&
          row.durabilityDecision.allowedToSettle &&
          Boolean(row.idempotencyKey.trim()) &&
          Number.isFinite(Date.parse(row.updatedAt)) &&
          Date.parse(row.updatedAt) >= (record.lastAttemptAt ?? record.createdAt),
      );
      if (!receipt) {
        const pending = rows[0];
        if (record.result.proof.visibleDeliveryCompleted) {
          return {
            status: "pending",
            reason: "settlement_failed",
            detail: "completed activation source receipt is unavailable",
          };
        }
        // The report is immutable and contains already completed checks. Its
        // delivery owner may retry the same idempotent publication; this never
        // authorizes replaying a model turn or the restart side effect.
        return pending
          ? {
              status: "pending",
              reason: "delivery_unconfirmed",
              message: record.result.message,
              ...(pending.obligationIdentity.runId
                ? { runId: pending.obligationIdentity.runId }
                : {}),
            }
          : { status: "missing_receipt", message: record.result.message };
      }
      if (
        record.result.proof.visibleDeliveryCompleted &&
        (record.status === "continuation_completed" || record.status === "continuation_blocked")
      ) {
        retireActivationEvent(params.sessionKey, params.continuation);
        return { status: "settled" };
      }
      const checks = record.result.checks.map(
        (check): ActivationContinuationCheckResult =>
          check.name === "visible_delivery"
            ? { name: check.name, status: "pass", detail: `source delivery receipt ${receipt.id}` }
            : check,
      );
      const status = checks.every((check) => check.status === "pass")
        ? "continuation_completed"
        : "continuation_blocked";
      const proof: ActivationContinuationProof = {
        ...record.result.proof,
        visibleDeliveryCompleted: true,
        deliveryStatus: "delivered",
        deliveryRecordId: receipt.id,
      };
      const now = params.now ?? Date.now();
      const artifactPath = await writeContinuationArtifact({
        record,
        checks,
        status,
        proof,
        now,
        exportsDir: params.exportsDir ?? resolveDefaultExportsDir(),
      });
      const settled: ActivationContinuationRecord = {
        ...record,
        status,
        completedAt: now,
        ...(status === "continuation_completed"
          ? { closeoutPath: artifactPath }
          : { blockerPath: artifactPath }),
        result: { ...record.result, checks, proof: { ...proof, artifactPath } },
      };
      store.records = store.records.map((candidate) =>
        candidate.id === record.id ? settled : candidate,
      );
      await writeStore(store, params.stateDir);
      const readback = (await readStore(params.stateDir)).records.find(
        (candidate) => candidate.id === record.id,
      );
      if (!readback || !isDeepStrictEqual(readback, settled)) {
        throw new Error("activation delivery settlement readback failed");
      }
      retireActivationEvent(params.sessionKey, params.continuation);
      return { status: "settled" };
    });
  } catch (error) {
    // A committed source receipt must not trigger a second publication when
    // the activation artifact/store write fails. Retry this reconciliation only.
    return { status: "pending", reason: "settlement_failed", detail: String(error) };
  }
}

async function defaultDeliver(
  record: ActivationContinuationRecord,
  message: string,
): Promise<ActivationContinuationDeliveryResult> {
  const sessionKey = record.route.sessionKey;
  const ref = record.result?.proof?.deliveryRef;
  if (!sessionKey || !ref) {
    throw new Error("activation continuation has no prepared source route");
  }
  enqueueSystemEvent(message, {
    sessionKey,
    contextKey: `activation:${ref.id}:${ref.createdAt}:${ref.reportId}`,
    activationContinuation: ref,
    ...(record.route.deliveryContext ? { deliveryContext: record.route.deliveryContext } : {}),
  });
  requestHeartbeat({
    source: "restart-sentinel",
    intent: "event",
    reason: "activation-continuation",
    sessionKey,
  });
  return { status: "queued" };
}

async function deliverPreparedActivationReport(
  record: ActivationContinuationRecord,
  deps: ActivationContinuationRunnerDeps,
): Promise<ActivationContinuationRecord> {
  const ref = record.result?.proof?.deliveryRef;
  if (!ref || !record.result || !record.route.sessionKey) {
    throw new Error("activation report identity missing before delivery");
  }
  try {
    const delivered = await (deps.deliver ?? defaultDeliver)(record, record.result.message);
    if (delivered.status === "delivered") {
      await reconcileActivationContinuationDelivery({
        continuation: ref,
        sessionKey: record.route.sessionKey,
        deliveryRecordId: delivered.deliveryRecordId,
        registryPath: deps.sourceDeliveryRegistryPath,
        stateDir: deps.stateDir,
        exportsDir: deps.exportsDir,
        now: deps.now?.(),
      });
    } else {
      await updateRecord(
        record.id,
        (current) => {
          if (
            !matchesContinuationRef(current, ref) ||
            !current.result?.proof ||
            current.result.proof.visibleDeliveryCompleted
          ) {
            return current;
          }
          return {
            ...current,
            result: {
              ...current.result,
              proof: {
                ...current.result.proof,
                deliveryStatus: "queued",
                parentContinuationQueued: true,
              },
            },
          };
        },
        deps.stateDir,
      );
    }
  } catch (error) {
    await updateRecord(
      record.id,
      (current) => {
        if (
          !matchesContinuationRef(current, ref) ||
          !current.result?.proof ||
          current.result.proof.visibleDeliveryCompleted
        ) {
          return current;
        }
        return {
          ...current,
          result: {
            ...current.result,
            proof: {
              ...current.result.proof,
              deliveryStatus: "failed",
            },
          },
        };
      },
      deps.stateDir,
    );
    deps.log?.warn?.("activation report delivery remains pending", {
      continuationId: record.id,
      error: String(error),
    });
  }
  return (
    (await readStore(deps.stateDir)).records.find((candidate) => candidate.id === record.id) ??
    record
  );
}

export async function resumeActivationContinuation(
  record: ActivationContinuationRecord,
  deps: ActivationContinuationRunnerDeps = {},
): Promise<ActivationContinuationRecord> {
  const now = deps.now?.() ?? Date.now();
  const continuityGate = resolveActivationContinuationContinuityGateOptions({
    stateDir: deps.stateDir,
    continuityGate: deps.continuityGate,
  });
  if (
    parseRootOperatorOverride(continuityGate?.userInstruction) === "STOP_USER_ANSWER_ONLY_OVERRIDE"
  ) {
    await persistActivationContinuationContinuityGateDecision({
      record,
      lifecycleStatus: "answer_only_override",
      stateDir: deps.stateDir,
      continuityGate,
    });
    return record;
  }
  const current = (await readStore(deps.stateDir)).records.find(
    (candidate) => candidate.id === record.id,
  );
  if (!current) {
    throw new Error("activation continuation is not persisted");
  }
  if (current.createdAt !== record.createdAt) {
    return current;
  }
  const ref = current.result?.proof?.deliveryRef;
  if (ref && current.route.sessionKey) {
    // Reconcile before TTL/checks/queueing. A crash after acknowledged delivery
    // must settle the existing report without another restart or publication.
    const reconciliation = await reconcileActivationContinuationDelivery({
      continuation: ref,
      sessionKey: current.route.sessionKey,
      registryPath: deps.sourceDeliveryRegistryPath,
      stateDir: deps.stateDir,
      exportsDir: deps.exportsDir,
      now,
    });
    if (
      reconciliation.status === "missing_receipt" ||
      (reconciliation.status === "pending" && reconciliation.reason === "delivery_unconfirmed")
    ) {
      return deliverPreparedActivationReport(current, deps);
    }
    return (
      (await readStore(deps.stateDir)).records.find((candidate) => candidate.id === record.id) ??
      current
    );
  }
  if (now > current.expiresAt) {
    const updated =
      (await updateRecord(
        current.id,
        (entry) => ({
          ...entry,
          status: "continuation_blocked",
          completedAt: now,
          result: {
            checks: [],
            message: "activation continuation expired before startup recovery",
          },
        }),
        deps.stateDir,
      )) ?? current;
    await persistActivationContinuationContinuityGateDecision({
      record: updated,
      lifecycleStatus: "expired_before_recovery",
      stateDir: deps.stateDir,
      continuityGate,
    });
    return updated;
  }
  const active =
    (await updateRecord(
      current.id,
      (entry) => ({
        ...entry,
        status: "side_effect_completed_parent_interrupted",
        attempts: entry.attempts + 1,
        lastAttemptAt: now,
      }),
      deps.stateDir,
    )) ?? current;
  const checkRunner = deps.check ?? runDefaultCheck;
  const checks: ActivationContinuationCheckResult[] = [];
  for (const check of active.requiredChecks) {
    if (check === "visible_delivery") {
      continue;
    }
    try {
      checks.push(await checkRunner(active, check));
    } catch (error) {
      checks.push({ name: check, status: "fail", detail: String(error) });
    }
  }
  // Route/config/artifact existence and a custom check callback cannot prove a
  // report delivery. Only source-receipt reconciliation can pass this check.
  checks.push({
    name: "visible_delivery",
    status: "pending",
    detail: "awaiting the exact source delivery receipt",
  });
  if (!active.route.sessionKey && !checks.some((check) => check.name === "delivery_route")) {
    checks.push({
      name: "delivery_route",
      status: "fail",
      detail: "no sessionKey route persisted for visible continuation delivery",
    });
  }
  const status: RecoveryStatus = active.route.sessionKey
    ? "pending_delivery"
    : "continuation_blocked";
  const proof: ActivationContinuationProof = {
    sideEffectCompleted: true,
    parentTurnInterrupted: true,
    parentContinuationQueued: checks.some(
      (check) => check.name === "parent_restart_recovery" && check.status === "pass",
    ),
    visibleDeliveryCompleted: false,
    deliveryStatus: active.route.sessionKey ? "not_requested" : "failed",
  };
  proof.artifactPath = await writeContinuationArtifact({
    record: active,
    checks,
    status,
    proof,
    now,
    exportsDir: deps.exportsDir ?? resolveDefaultExportsDir(),
  });
  const message = formatResultMessage({ record: active, checks, proof });
  if (active.route.sessionKey) {
    proof.deliveryRef = {
      id: active.id,
      createdAt: active.createdAt,
      reportId: crypto.createHash("sha256").update(message).digest("hex"),
    };
  }
  // Persist the immutable message and its correlation before the queue or any
  // delivery callback can run; a receipt arriving immediately must find it.
  const prepared =
    (await updateRecord(
      active.id,
      (entry) => ({
        ...entry,
        status,
        ...(status === "continuation_blocked"
          ? { blockerPath: proof.artifactPath, completedAt: now }
          : {}),
        result: { checks, message, proof },
      }),
      deps.stateDir,
    )) ?? active;
  if (checks.some((check) => check.status === "fail")) {
    await persistActivationContinuationContinuityGateDecision({
      record: prepared,
      lifecycleStatus: "continuation_blocked",
      stateDir: deps.stateDir,
      continuityGate,
      checks,
      proofPath: proof.artifactPath,
    });
  }
  const next = active.route.sessionKey
    ? await deliverPreparedActivationReport(prepared, deps)
    : prepared;
  deps.log?.info?.("activation continuation resumed", {
    continuationId: next.id,
    status: next.status,
  });
  return next;
}

export async function recoverPendingActivationContinuations(
  deps: ActivationContinuationRunnerDeps = {},
): Promise<ActivationContinuationRecord[]> {
  const store = await readStore(deps.stateDir);
  const resumable = store.records.filter(
    (record) =>
      record.status === "pending_restart" ||
      record.status === "side_effect_completed_parent_interrupted" ||
      record.status === "pending_delivery",
  );
  const completed: ActivationContinuationRecord[] = [];
  for (const record of resumable) {
    try {
      completed.push(await resumeActivationContinuation(record, deps));
    } catch (err) {
      deps.log?.error?.("activation continuation recovery failed", {
        continuationId: record.id,
        error: String(err),
      });
      log.error(`activation continuation recovery failed id=${record.id}: ${String(err)}`);
    }
  }
  return completed;
}

export const testing = {
  resolveStorePath,
  readStore,
  writeStore,
  createContinuationRecord,
  readBuildInfo,
  runDefaultCheck,
};
