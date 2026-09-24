import { redactToolPayloadText } from "../logging/redact.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";

export const LANE_READINESS_REPORT_SCHEMA = "openclaw.lane_readiness_report.v1" as const;

export type LaneReadinessPriority = "P0" | "P1";

export type LaneReadinessCheck = {
  readonly id: string;
  readonly description: string;
};

export type LaneReadinessLane = {
  readonly id: string;
  readonly label: string;
  readonly priority: LaneReadinessPriority;
  readonly currentOwner: string;
  readonly checks: readonly LaneReadinessCheck[];
};

function checks(
  ...entries: Array<[id: string, description: string]>
): readonly LaneReadinessCheck[] {
  return Object.freeze(entries.map(([id, description]) => Object.freeze({ id, description })));
}

const laneReadinessLanes = [
  {
    id: "will_controller",
    label: "Will/controller",
    priority: "P0",
    currentOwner: "Will/controller",
    checks: checks(
      ["intake_classification", "classify owner requests"],
      ["active_worker_proof", "prove active execution ownership"],
      ["closeout_truth", "preserve open and closed truth"],
      ["final_source_delivery", "prove final source delivery"],
    ),
  },
  {
    id: "cleanup_crew",
    label: "Cleanup Crew",
    priority: "P0",
    currentOwner: "Cleanup Crew",
    checks: checks(
      ["lane_spawn", "start a governed cleanup lane"],
      ["stale_worker", "detect stale workers"],
      ["repair_routing", "route repair to the lawful owner"],
      ["report_delivery", "deliver the repair report"],
      ["clean_watchdog", "obtain a bounded clean watchdog result"],
    ),
  },
  {
    id: "grant",
    label: "Grant",
    priority: "P0",
    currentOwner: "Grant",
    checks: checks(
      ["missing_field_reject", "reject incomplete review packets"],
      ["missing_proof_reject", "reject claims without proof"],
      ["valid_proof_review", "review a complete proof packet"],
      ["audit_receipt", "produce a bound review receipt"],
    ),
  },
  {
    id: "acp_acpx",
    label: "ACP/ACPX",
    priority: "P0",
    currentOwner: "ACP/ACPX",
    checks: checks(
      ["spawn", "spawn an ACP session"],
      ["prompt", "persist the accepted prompt"],
      ["response", "receive an ACP response"],
      ["session_metadata", "preserve session metadata"],
      ["intake_record", "bind durable intake bookkeeping"],
      ["delivery_proof", "prove response delivery"],
    ),
  },
  {
    id: "gateway_runtime",
    label: "Gateway/runtime",
    priority: "P0",
    currentOwner: "Gateway/runtime",
    checks: checks(
      ["build_info", "bind runtime build identity"],
      ["health", "pass the health probe"],
      ["method_smoke", "complete a method smoke"],
      ["restart_probe", "prove scoped restart or reload"],
      ["asset_guard", "verify loaded assets match the build"],
    ),
  },
  {
    id: "watchdog",
    label: "Watchdog",
    priority: "P0",
    currentOwner: "Watchdog",
    checks: checks(
      ["fixture_matrix", "classify the watchdog fixture matrix"],
      ["cron_freshness", "prove the recurring owner ran on schedule"],
      ["seven_dimensions", "cover all seven clean dimensions"],
      ["repair_closure", "verify routed repair closure"],
    ),
  },
  {
    id: "taskflow_session_continuity",
    label: "TaskFlow/session continuity",
    priority: "P0",
    currentOwner: "TaskFlow/session continuity",
    checks: checks(
      ["flow_lifecycle", "preserve the managed flow lifecycle"],
      ["cancel", "cancel without false completion"],
      ["child_completion", "apply child completion once"],
      ["parent_wake", "wake the owning parent"],
      ["compaction_resume", "resume after compaction"],
    ),
  },
  {
    id: "source_report_delivery",
    label: "Source/report delivery",
    priority: "P0",
    currentOwner: "Source/report delivery",
    checks: checks(
      ["obligation_round_trip", "round-trip the delivery obligation"],
      ["failure_notice", "surface failed delivery"],
      ["final_delivered", "prove visible final delivery"],
      ["no_duplicate", "suppress duplicate final delivery"],
    ),
  },
  {
    id: "sadb",
    label: "SADB",
    priority: "P1",
    currentOwner: "SADB",
    checks: checks(
      ["build_plan_admission", "admit the controlling build plan"],
      ["owner_routing", "route each slice to its owner"],
      ["slice_result", "record slice PASS or FAIL"],
      ["no_scope_drift", "hold the authorized scope"],
    ),
  },
  {
    id: "engineering_delivery",
    label: "Engineering Delivery",
    priority: "P1",
    currentOwner: "Engineering Delivery",
    checks: checks(
      ["focused_test", "run focused validation"],
      ["integration_test", "run boundary integration validation"],
      ["runtime_identity", "prove build and runtime identity"],
      ["handoff_receipt", "produce an implementation handoff receipt"],
    ),
  },
  {
    id: "file_hub_export",
    label: "File Hub/export",
    priority: "P1",
    currentOwner: "File Hub/export",
    checks: checks(
      ["write_export", "write the Mark-facing export"],
      ["dashboard_listing", "show it in the dashboard listing"],
      ["download_readback", "download and read back the export"],
      ["hash_match", "match source and downloaded hashes"],
    ),
  },
  {
    id: "memory_knowledge",
    label: "Memory/knowledge",
    priority: "P1",
    currentOwner: "Memory/knowledge",
    checks: checks(
      ["search", "search current knowledge"],
      ["sync", "synchronize the knowledge source"],
      ["qmd_scope", "hold QMD scope boundaries"],
      ["memory_flush", "flush required continuity memory"],
      ["resource_sample", "sample RSS and result volume"],
    ),
  },
] as const satisfies readonly LaneReadinessLane[];

for (const lane of laneReadinessLanes) {
  Object.freeze(lane);
}

export const LANE_READINESS_LANES: readonly LaneReadinessLane[] = Object.freeze(laneReadinessLanes);

export type LaneReadinessCheckExecution = {
  runLabel: string;
  sourceRevision: string;
  executedAt: string;
  status: "PASS" | "FAIL";
  proofPaths?: readonly string[];
  detail?: string;
};

export type LaneReadinessCheckResult = {
  checkId: string;
  description: string;
  status: "PASS" | "FAIL";
  proofPaths: string[];
  blocker?: {
    code:
      | "check_failed"
      | "check_threw"
      | "check_timed_out"
      | "recurrence_timed_out"
      | "run_timed_out"
      | "invalid_check_result"
      | "missing_check_result"
      | "missing_proof_path"
      | "unsafe_proof_path";
    detail: string;
  };
};

export type LaneReadinessLaneResult = {
  laneId: string;
  label: string;
  priority: LaneReadinessPriority;
  currentOwner: string;
  status: "PASS" | "FAIL";
  checks: LaneReadinessCheckResult[];
};

export type LaneReadinessReport = {
  schema: typeof LANE_READINESS_REPORT_SCHEMA;
  runLabel: string;
  sourceRevision: string;
  checkedAt: string;
  nextRunDueAt: string;
  status: "PASS" | "FAIL";
  summary: {
    laneCount: number;
    passedLaneCount: number;
    failedLaneCount: number;
    p0FailedLaneCount: number;
    p1FailedLaneCount: number;
    integrityFailureCount: number;
  };
  integrityFailures: Array<{
    code: "invalid_handle" | "unexpected_handle";
    count: number;
    detail: string;
  }>;
  cancellationRequests: LaneReadinessCancellationRequest[];
  lanes: LaneReadinessLaneResult[];
};

export type LaneReadinessCancellationRequest = {
  laneId: string;
  checkId: string;
  reason:
    | "check_timed_out"
    | "duplicate_handle"
    | "recurrence_timed_out"
    | "unexpected_handle"
    | "run_timed_out";
};

type LaneReadinessTimeoutReason = "check_timed_out" | "recurrence_timed_out" | "run_timed_out";

declare const laneReadinessHandleBrand: unique symbol;

export type LaneReadinessCheckHandle = Readonly<{
  [laneReadinessHandleBrand]: true;
}>;

type LaneReadinessCheckHandleState = {
  laneId: string;
  checkId: string;
  completion: Promise<LaneReadinessCheckSettlement>;
  settlement?: LaneReadinessCheckSettlement;
};

type LaneReadinessCheckExecutionSnapshot = {
  status: "PASS" | "FAIL";
  proofPaths: string[];
  unsafeProofPath: boolean;
  detail?: string;
};

type LaneReadinessCheckSettlement =
  | { status: "fulfilled"; value: unknown; settledAtMs: number }
  | { status: "rejected"; value: unknown; settledAtMs: number }
  | { status: "timed_out"; value: unknown; settledAtMs: number };

const DEFAULT_CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_EXECUTION_JSON_LENGTH = 64 * 1024;
const MAX_PROOF_PATH_COUNT = 32;
const MAX_PROOF_PATH_LENGTH = 4_096;
const MAX_FAILURE_DETAIL_LENGTH = 4_096;
const SAFE_HANDLE_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_RUN_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SOURCE_REVISION_RE = /^[0-9a-f]{7,64}$/;
const CHECK_TIMEOUT = Symbol("lane readiness check timeout");
const handleStates = new WeakMap<LaneReadinessCheckHandle, LaneReadinessCheckHandleState>();

function isSafePersistedIdentifier(value: unknown, pattern: RegExp): value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    return false;
  }
  try {
    return redactToolPayloadText(value) === value;
  } catch {
    return false;
  }
}

export function createLaneReadinessCheckHandle(
  laneId: string,
  checkId: string,
): {
  handle: LaneReadinessCheckHandle;
  resolve: (executionJson: string) => void;
  reject: (executionJson: string) => void;
  timeout: (executionJson: string) => void;
} {
  if (
    !isSafePersistedIdentifier(laneId, SAFE_HANDLE_ID_RE) ||
    !isSafePersistedIdentifier(checkId, SAFE_HANDLE_ID_RE)
  ) {
    throw new Error("lane readiness handle requires bounded snake-case laneId and checkId");
  }
  let settleCompletion: (settlement: LaneReadinessCheckSettlement) => void = () => {};
  const completion = new Promise<LaneReadinessCheckSettlement>((resolve) => {
    settleCompletion = resolve;
  });
  const handle = Object.freeze({}) as LaneReadinessCheckHandle;
  const state: LaneReadinessCheckHandleState = { laneId, checkId, completion };
  handleStates.set(handle, state);
  const settle = (status: LaneReadinessCheckSettlement["status"], executionJson: string) => {
    if (state.settlement) {
      return;
    }
    const settlement: LaneReadinessCheckSettlement = {
      status,
      value:
        typeof executionJson === "string" && executionJson.length <= MAX_EXECUTION_JSON_LENGTH
          ? executionJson
          : "",
      settledAtMs: Date.now(),
    };
    state.settlement = settlement;
    settleCompletion(settlement);
  };
  return Object.freeze({
    handle,
    resolve: (executionJson: string) => settle("fulfilled", executionJson),
    // Rejections use the same bounded identity envelope as fulfilled checks so
    // stale owner failures cannot be rebound to the current recurrence.
    reject: (executionJson: string) => settle("rejected", executionJson),
    timeout: (executionJson: string) => settle("timed_out", executionJson),
  });
}

function hasCredentialBearingUrlData(value: string): boolean {
  // Proof references are persisted verbatim, so reject percent-encoded data
  // rather than trying to prove every reversible nested representation safe.
  if (/%[0-9a-f]{2}/i.test(value)) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(value, "https://lane-readiness.invalid/");
  } catch {
    return true;
  }
  // Query and fragment data are unnecessary for durable proof identity and
  // have an open-ended credential vocabulary, so persisted references omit both.
  return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
}

function normalizeProofPaths(paths: unknown): {
  paths: string[];
  unsafe: boolean;
  invalid: boolean;
} {
  if (!Array.isArray(paths)) {
    return { paths: [], unsafe: false, invalid: paths !== undefined };
  }
  if (paths.length > MAX_PROOF_PATH_COUNT) {
    return { paths: [], unsafe: false, invalid: true };
  }
  const normalized = new Set<string>();
  let unsafe = false;
  for (const path of paths) {
    if (typeof path !== "string" || path.length > MAX_PROOF_PATH_LENGTH) {
      return { paths: [], unsafe: false, invalid: true };
    }
    const value = path.trim();
    if (value !== path) {
      return { paths: [], unsafe: false, invalid: true };
    }
    if (value) {
      const redacted = redactReportDetail(value, "[redacted proof path]");
      if (redacted !== value || hasCredentialBearingUrlData(value)) {
        unsafe = true;
      } else {
        normalized.add(value);
      }
    }
  }
  return { paths: [...normalized].toSorted(), unsafe, invalid: false };
}

function snapshotCheckExecution(params: {
  value: unknown;
  runLabel: string;
  sourceRevision: string;
  checkedAtMs: number;
  nextRunDueAtMs: number;
  receivedAtMs: number;
}): LaneReadinessCheckExecutionSnapshot | undefined {
  try {
    if (typeof params.value !== "string" || params.value.length > MAX_EXECUTION_JSON_LENGTH) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(params.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const execution = parsed as Record<string, unknown>;
    const executedAt =
      typeof execution.executedAt === "string"
        ? parseUtcTimestamp(execution.executedAt)
        : undefined;
    if (
      execution.runLabel !== params.runLabel ||
      execution.sourceRevision !== params.sourceRevision ||
      executedAt === undefined ||
      executedAt < params.checkedAtMs ||
      executedAt > params.nextRunDueAtMs ||
      executedAt > params.receivedAtMs ||
      params.receivedAtMs > params.nextRunDueAtMs
    ) {
      return undefined;
    }
    const status = execution.status;
    if (status !== "PASS" && status !== "FAIL") {
      return undefined;
    }
    const normalizedProofPaths = normalizeProofPaths(execution.proofPaths);
    if (normalizedProofPaths.invalid) {
      return undefined;
    }
    const detailValue = execution.detail;
    if (
      status === "FAIL" &&
      (typeof detailValue !== "string" ||
        !detailValue.trim() ||
        detailValue.length > MAX_FAILURE_DETAIL_LENGTH)
    ) {
      return undefined;
    }
    return {
      status,
      proofPaths: normalizedProofPaths.paths,
      unsafeProofPath: normalizedProofPaths.unsafe,
      ...(typeof detailValue === "string" ? { detail: detailValue } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseUtcTimestamp(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const normalized = new Date(parsed).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? parsed : undefined;
}

function timeoutResult(
  lane: LaneReadinessLane,
  check: LaneReadinessCheck,
  reason: LaneReadinessTimeoutReason,
): LaneReadinessCheckResult {
  return {
    checkId: check.id,
    description: check.description,
    status: "FAIL",
    proofPaths: [],
    blocker: {
      code: reason,
      detail:
        reason === "run_timed_out"
          ? `${lane.label}/${check.id} exceeded the whole-run readiness deadline`
          : reason === "recurrence_timed_out"
            ? `${lane.label}/${check.id} exceeded the readiness recurrence deadline`
            : `${lane.label}/${check.id} exceeded its readiness deadline`,
    },
  };
}

function requestCancellation(
  requests: LaneReadinessCancellationRequest[],
  handle: LaneReadinessCheckHandleState,
  reason: LaneReadinessCancellationRequest["reason"],
): void {
  // Cancellation is data-only here so owner callbacks cannot escape into the
  // recurring evaluator; the external supervisor cancels its isolated worker.
  requests.push({ laneId: handle.laneId, checkId: handle.checkId, reason });
}

function redactReportDetail(value: string, fallback: string): string {
  const normalized = value.trim() || fallback;
  try {
    return redactToolPayloadText(normalized.slice(0, 4_096)).trim() || fallback;
  } catch {
    return fallback;
  }
}

function formatThrownCheckError(
  error: unknown,
  lane: LaneReadinessLane,
  check: LaneReadinessCheck,
): string {
  const fallback = `${lane.label}/${check.id} threw without a usable error detail`;
  if (typeof error === "string") {
    return redactReportDetail(error, fallback);
  }
  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "symbol"
  ) {
    return redactReportDetail(String(error), fallback);
  }
  return fallback;
}

async function executeCheck(params: {
  lane: LaneReadinessLane;
  check: LaneReadinessCheck;
  handles: readonly LaneReadinessCheckHandleState[];
  timeoutMs: number;
  runLabel: string;
  sourceRevision: string;
  checkedAtMs: number;
  nextRunDueAtMs: number;
  cancellationRequests: LaneReadinessCancellationRequest[];
  timeoutReason: LaneReadinessTimeoutReason;
  deadlineMs: number;
}): Promise<LaneReadinessCheckResult> {
  if (params.handles.length !== 1) {
    for (const handle of params.handles) {
      requestCancellation(params.cancellationRequests, handle, "duplicate_handle");
    }
    return {
      checkId: params.check.id,
      description: params.check.description,
      status: "FAIL",
      proofPaths: [],
      blocker: {
        code: params.handles.length > 1 ? "invalid_check_result" : "missing_check_result",
        detail:
          params.handles.length > 1
            ? `${params.lane.label}/${params.check.id} has duplicate readiness handles`
            : `${params.lane.label}/${params.check.id} has no supervised readiness handle`,
      },
    };
  }
  const handle = params.handles[0];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const settlement = await (handle.settlement
      ? Promise.resolve(handle.settlement)
      : Promise.race([
          handle.completion,
          new Promise<typeof CHECK_TIMEOUT>((resolve) => {
            timeout = setTimeout(() => {
              requestCancellation(params.cancellationRequests, handle, params.timeoutReason);
              resolve(CHECK_TIMEOUT);
            }, params.timeoutMs);
          }),
        ]));
    if (settlement === CHECK_TIMEOUT) {
      return timeoutResult(params.lane, params.check, params.timeoutReason);
    }
    const evaluatedAtMs = Date.now();
    if (settlement.settledAtMs > params.deadlineMs) {
      requestCancellation(params.cancellationRequests, handle, params.timeoutReason);
      return timeoutResult(params.lane, params.check, params.timeoutReason);
    }
    const snapshot = snapshotCheckExecution({
      value: settlement.value,
      runLabel: params.runLabel,
      sourceRevision: params.sourceRevision,
      checkedAtMs: params.checkedAtMs,
      nextRunDueAtMs: params.nextRunDueAtMs,
      receivedAtMs: settlement.settledAtMs,
    });
    if (evaluatedAtMs > params.deadlineMs && snapshot?.status !== "FAIL") {
      return timeoutResult(params.lane, params.check, params.timeoutReason);
    }
    if (!snapshot || (settlement.status !== "fulfilled" && snapshot.status !== "FAIL")) {
      return {
        checkId: params.check.id,
        description: params.check.description,
        status: "FAIL",
        proofPaths: [],
        blocker: {
          code: "invalid_check_result",
          detail: `${params.lane.label}/${params.check.id} returned an invalid readiness result`,
        },
      };
    }
    const { status, proofPaths, unsafeProofPath, detail } = snapshot;
    if (unsafeProofPath) {
      return {
        checkId: params.check.id,
        description: params.check.description,
        status: "FAIL",
        proofPaths: [],
        blocker: {
          code: "unsafe_proof_path",
          detail: `${params.lane.label}/${params.check.id} returned a credential-bearing proof path`,
        },
      };
    }
    if (settlement.status === "timed_out") {
      return {
        checkId: params.check.id,
        description: params.check.description,
        status: "FAIL",
        proofPaths: [],
        blocker: {
          code: "check_timed_out",
          detail: redactReportDetail(
            detail ?? "",
            `${params.lane.label}/${params.check.id} exceeded its readiness deadline`,
          ),
        },
      };
    }
    if (settlement.status === "rejected") {
      return {
        checkId: params.check.id,
        description: params.check.description,
        status: "FAIL",
        proofPaths,
        blocker: {
          code: "check_threw",
          detail: redactReportDetail(
            detail ?? "",
            `${params.lane.label}/${params.check.id} threw without a usable error detail`,
          ),
        },
      };
    }
    if (status === "PASS" && proofPaths.length === 0) {
      return {
        checkId: params.check.id,
        description: params.check.description,
        status: "FAIL",
        proofPaths,
        blocker: {
          code: "missing_proof_path",
          detail: `${params.lane.label}/${params.check.id} passed without a proof path`,
        },
      };
    }
    return {
      checkId: params.check.id,
      description: params.check.description,
      status,
      proofPaths,
      ...(status === "FAIL"
        ? {
            blocker: {
              code: "check_failed" as const,
              detail: redactReportDetail(
                detail ?? "",
                `${params.lane.label}/${params.check.id} did not pass readiness`,
              ),
            },
          }
        : {}),
    };
  } catch (error) {
    return {
      checkId: params.check.id,
      description: params.check.description,
      status: "FAIL",
      proofPaths: [],
      blocker: {
        code: "check_threw",
        detail: formatThrownCheckError(error, params.lane, params.check),
      },
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function runLaneReadinessHarness(params: {
  runLabel: string;
  sourceRevision: string;
  checkedAt: string;
  recurrenceMs: number;
  checkTimeoutMs?: number;
  runTimeoutMs?: number;
  handles: readonly LaneReadinessCheckHandle[];
}): Promise<LaneReadinessReport> {
  const checkedAtMs = parseUtcTimestamp(params.checkedAt);
  if (checkedAtMs === undefined) {
    throw new Error("lane readiness checkedAt must be an explicit UTC timestamp");
  }
  if (!Number.isSafeInteger(params.recurrenceMs) || params.recurrenceMs <= 0) {
    throw new Error("lane readiness recurrenceMs must be a positive safe integer");
  }
  const runLabel = typeof params.runLabel === "string" ? params.runLabel.trim() : "";
  const sourceRevision =
    typeof params.sourceRevision === "string" ? params.sourceRevision.trim() : "";
  if (!isSafePersistedIdentifier(runLabel, SAFE_RUN_LABEL_RE)) {
    throw new Error("lane readiness runLabel must be a bounded safe identifier");
  }
  if (!isSafePersistedIdentifier(sourceRevision, SAFE_SOURCE_REVISION_RE)) {
    throw new Error("lane readiness sourceRevision must be a hexadecimal revision");
  }
  const nextRunDueAtMs = checkedAtMs + params.recurrenceMs;
  if (!Number.isFinite(nextRunDueAtMs) || Math.abs(nextRunDueAtMs) > 8_640_000_000_000_000) {
    throw new Error("lane readiness recurrence deadline is outside the supported date range");
  }
  const checkTimeoutMs = params.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const runTimeoutMs = params.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(checkTimeoutMs) ||
    checkTimeoutMs <= 0 ||
    checkTimeoutMs > MAX_TIMER_TIMEOUT_MS
  ) {
    throw new Error("lane readiness checkTimeoutMs must be a timer-safe positive integer");
  }
  if (
    !Number.isSafeInteger(runTimeoutMs) ||
    runTimeoutMs <= 0 ||
    runTimeoutMs > MAX_TIMER_TIMEOUT_MS
  ) {
    throw new Error("lane readiness runTimeoutMs must be a timer-safe positive integer");
  }
  const harnessStartedMs = Date.now();
  const checkDeadlineMs = harnessStartedMs + checkTimeoutMs;
  const runDeadlineMs = harnessStartedMs + runTimeoutMs;
  const declaredCheckKeys = new Set(
    LANE_READINESS_LANES.flatMap((lane) => lane.checks.map((check) => `${lane.id}\0${check.id}`)),
  );
  const handlesByCheck = new Map<string, LaneReadinessCheckHandleState[]>();
  const cancellationRequests: LaneReadinessCancellationRequest[] = [];
  let invalidHandleCount = 0;
  let unexpectedHandleCount = 0;
  for (const value of params.handles) {
    const handle =
      (typeof value === "object" && value !== null) || typeof value === "function"
        ? handleStates.get(value)
        : undefined;
    if (!handle) {
      invalidHandleCount += 1;
      continue;
    }
    const key = `${handle.laneId}\0${handle.checkId}`;
    if (!declaredCheckKeys.has(key)) {
      requestCancellation(cancellationRequests, handle, "unexpected_handle");
      unexpectedHandleCount += 1;
      continue;
    }
    const existing = handlesByCheck.get(key);
    if (existing) {
      existing.push(handle);
    } else {
      handlesByCheck.set(key, [handle]);
    }
  }

  const lanes = await Promise.all(
    LANE_READINESS_LANES.map(async (lane): Promise<LaneReadinessLaneResult> => {
      const declaredChecks = Object.freeze(lane.checks.map((check) => Object.freeze({ ...check })));
      const executorLane = Object.freeze({ ...lane, checks: declaredChecks });
      const results = await Promise.all(
        declaredChecks.map(async (check) => {
          const handles = handlesByCheck.get(`${executorLane.id}\0${check.id}`) ?? [];
          let deadlineMs = checkDeadlineMs;
          let timeoutReason: LaneReadinessTimeoutReason = "check_timed_out";
          if (runDeadlineMs < deadlineMs) {
            deadlineMs = runDeadlineMs;
            timeoutReason = "run_timed_out";
          }
          if (nextRunDueAtMs < deadlineMs) {
            deadlineMs = nextRunDueAtMs;
            timeoutReason = "recurrence_timed_out";
          }
          const remainingCheckMs = deadlineMs - Date.now();
          if (remainingCheckMs <= 0 && !handles[0]?.settlement) {
            for (const handle of handles) {
              requestCancellation(cancellationRequests, handle, timeoutReason);
            }
            return timeoutResult(executorLane, check, timeoutReason);
          }
          return await executeCheck({
            lane: executorLane,
            check,
            handles,
            timeoutMs: Math.max(0, remainingCheckMs),
            runLabel,
            sourceRevision,
            checkedAtMs,
            nextRunDueAtMs,
            cancellationRequests,
            timeoutReason,
            deadlineMs,
          });
        }),
      );
      const exactCheckSet =
        results.length === declaredChecks.length &&
        results.every((result, index) => result.checkId === declaredChecks[index]?.id);
      if (!exactCheckSet) {
        results.push({
          checkId: "harness_integrity",
          description: "preserve the declared readiness check set",
          status: "FAIL",
          proofPaths: [],
          blocker: {
            code: "invalid_check_result",
            detail: `${lane.label} did not execute its exact declared readiness check set`,
          },
        });
      }
      return {
        laneId: lane.id,
        label: lane.label,
        priority: lane.priority,
        currentOwner: lane.currentOwner,
        status:
          exactCheckSet && results.every((result) => result.status === "PASS") ? "PASS" : "FAIL",
        checks: results,
      };
    }),
  );

  const failed = lanes.filter((lane) => lane.status === "FAIL");
  const integrityFailures = [
    ...(invalidHandleCount > 0
      ? [
          {
            code: "invalid_handle" as const,
            count: invalidHandleCount,
            detail: "one or more readiness handles were malformed",
          },
        ]
      : []),
    ...(unexpectedHandleCount > 0
      ? [
          {
            code: "unexpected_handle" as const,
            count: unexpectedHandleCount,
            detail: "one or more readiness handles were not declared by the lane catalog",
          },
        ]
      : []),
  ];
  const normalizedCancellationRequests = [
    ...new Map(
      cancellationRequests.map((request) => [
        `${request.laneId}\0${request.checkId}\0${request.reason}`,
        request,
      ]),
    ).values(),
  ].toSorted((left, right) => {
    const leftKey = `${left.laneId}\0${left.checkId}\0${left.reason}`;
    const rightKey = `${right.laneId}\0${right.checkId}\0${right.reason}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const report: LaneReadinessReport = {
    schema: LANE_READINESS_REPORT_SCHEMA,
    runLabel,
    sourceRevision,
    checkedAt: new Date(checkedAtMs).toISOString(),
    nextRunDueAt: new Date(nextRunDueAtMs).toISOString(),
    status: failed.length === 0 && integrityFailures.length === 0 ? "PASS" : "FAIL",
    summary: {
      laneCount: lanes.length,
      passedLaneCount: lanes.length - failed.length,
      failedLaneCount: failed.length,
      p0FailedLaneCount: failed.filter((lane) => lane.priority === "P0").length,
      p1FailedLaneCount: failed.filter((lane) => lane.priority === "P1").length,
      integrityFailureCount: invalidHandleCount + unexpectedHandleCount,
    },
    integrityFailures,
    cancellationRequests: normalizedCancellationRequests,
    lanes,
  };
  return report;
}

export function isLaneReadinessReportCurrent(report: LaneReadinessReport, now: string): boolean {
  const nowMs = parseUtcTimestamp(now);
  const checkedAtMs = parseUtcTimestamp(report.checkedAt);
  const dueAtMs = parseUtcTimestamp(report.nextRunDueAt);
  return (
    nowMs !== undefined &&
    checkedAtMs !== undefined &&
    dueAtMs !== undefined &&
    nowMs >= checkedAtMs &&
    nowMs <= dueAtMs
  );
}
