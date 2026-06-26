import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfig } from "../config/config.js";
import { info } from "../globals.js";
import { runRuntimeAssetGuardPreflight } from "../infra/runtime-asset-guard-preflight.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { evaluateProductionOwnerLaneGuard } from "../tasks/production-owner-lane-guard.js";
import { listTasksForFlowId } from "../tasks/runtime-internal.js";
import { cancelFlowById, getFlowTaskSummary } from "../tasks/task-executor.js";
import type { ProductionContinuationStopReason } from "../tasks/task-flow-registry.js";
import type { TaskFlowRecord, TaskFlowStatus } from "../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  getTaskFlowProductionContinuation,
  getTaskFlowById,
  listTaskFlowRecords,
  recordFlowLawfulStop,
  resolveTaskFlowForLookupToken,
  resumeFlow,
} from "../tasks/task-flow-runtime-internal.js";

const ID_PAD = 10;
const STATUS_PAD = 10;
const MODE_PAD = 14;
const REV_PAD = 6;
const CTRL_PAD = 20;

function formatFlowLookupMiss(lookup: string): string {
  return `TaskFlow not found: ${lookup}. Run ${formatCliCommand("openclaw tasks flow list")} to see recent flow ids.`;
}

function failCommand(runtime: RuntimeEnv, message: string): void {
  runtime.error(message);
  runtime.exit(1);
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function safeFlowDisplayText(value: string | undefined, maxChars?: number): string {
  const sanitized = sanitizeTerminalText(value ?? "").trim();
  if (!sanitized) {
    return "n/a";
  }
  return typeof maxChars === "number" ? truncate(sanitized, maxChars) : sanitized;
}

function requireCliString(
  value: string | undefined,
  flag: string,
  runtime: RuntimeEnv,
): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    failCommand(runtime, `${flag} is required.`);
    return null;
  }
  return normalized;
}

function shortToken(value: string | undefined, maxChars = ID_PAD): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "n/a";
  }
  return truncate(trimmed, maxChars);
}

function formatFlowTimestamp(value: number | undefined | null): string {
  return timestampMsToIsoString(value) ?? "n/a";
}

function formatFlowStatusCell(status: TaskFlowStatus, rich: boolean) {
  const padded = status.padEnd(STATUS_PAD);
  if (!rich) {
    return padded;
  }
  if (status === "succeeded") {
    return theme.success(padded);
  }
  if (status === "failed" || status === "lost") {
    return theme.error(padded);
  }
  if (status === "running") {
    return theme.accentBright(padded);
  }
  if (status === "blocked") {
    return theme.warn(padded);
  }
  return theme.muted(padded);
}

function formatFlowRows(flows: TaskFlowRecord[], rich: boolean) {
  const header = [
    "TaskFlow".padEnd(ID_PAD),
    "Mode".padEnd(MODE_PAD),
    "Status".padEnd(STATUS_PAD),
    "Rev".padEnd(REV_PAD),
    "Controller".padEnd(CTRL_PAD),
    "Tasks".padEnd(14),
    "Goal",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const flow of flows) {
    const taskSummary = getFlowTaskSummary(flow.flowId);
    const counts = `${taskSummary.active} active/${taskSummary.total} total`;
    lines.push(
      [
        shortToken(flow.flowId).padEnd(ID_PAD),
        flow.syncMode.padEnd(MODE_PAD),
        formatFlowStatusCell(flow.status, rich),
        String(flow.revision).padEnd(REV_PAD),
        safeFlowDisplayText(flow.controllerId, CTRL_PAD).padEnd(CTRL_PAD),
        counts.padEnd(14),
        safeFlowDisplayText(flow.goal, 80),
      ].join(" "),
    );
  }
  return lines;
}

function formatFlowListSummary(flows: TaskFlowRecord[]) {
  const active = flows.filter(
    (flow) => flow.status === "queued" || flow.status === "running",
  ).length;
  const blocked = flows.filter((flow) => flow.status === "blocked").length;
  const cancelRequested = flows.filter((flow) => flow.cancelRequestedAt != null).length;
  return `${active} active · ${blocked} blocked · ${cancelRequested} cancel-requested · ${flows.length} total`;
}

function summarizeWait(flow: TaskFlowRecord): string {
  if (flow.waitJson == null) {
    return "n/a";
  }
  if (
    typeof flow.waitJson === "string" ||
    typeof flow.waitJson === "number" ||
    typeof flow.waitJson === "boolean"
  ) {
    return String(flow.waitJson);
  }
  if (Array.isArray(flow.waitJson)) {
    return `array(${flow.waitJson.length})`;
  }
  return Object.keys(flow.waitJson).toSorted().join(", ") || "object";
}

function summarizeFlowState(flow: TaskFlowRecord): string | null {
  if (flow.status === "blocked") {
    if (flow.blockedSummary) {
      return flow.blockedSummary;
    }
    if (flow.blockedTaskId) {
      return `blocked by ${flow.blockedTaskId}`;
    }
    return "blocked";
  }
  if (flow.status === "waiting" && flow.waitJson != null) {
    return summarizeWait(flow);
  }
  return null;
}

export async function flowsListCommand(
  opts: { json?: boolean; status?: string },
  runtime: RuntimeEnv,
) {
  const statusFilter = opts.status?.trim();
  const flows = listTaskFlowRecords().filter((flow) => {
    if (statusFilter && flow.status !== statusFilter) {
      return false;
    }
    return true;
  });

  if (opts.json) {
    writeRuntimeJson(runtime, {
      count: flows.length,
      status: statusFilter ?? null,
      flows: flows.map((flow) => ({
        ...flow,
        tasks: listTasksForFlowId(flow.flowId),
        taskSummary: getFlowTaskSummary(flow.flowId),
      })),
    });
    return;
  }

  runtime.log(info(`TaskFlows: ${flows.length}`));
  runtime.log(info(`TaskFlow pressure: ${formatFlowListSummary(flows)}`));
  if (statusFilter) {
    runtime.log(info(`Status filter: ${statusFilter}`));
  }
  if (flows.length === 0) {
    runtime.log(
      `No TaskFlows found. Run ${formatCliCommand("openclaw tasks list")} to inspect standalone background tasks.`,
    );
    return;
  }
  const rich = isRich();
  for (const line of formatFlowRows(flows, rich)) {
    runtime.log(line);
  }
}

export async function flowsShowCommand(
  opts: { json?: boolean; lookup: string },
  runtime: RuntimeEnv,
) {
  const flow = resolveTaskFlowForLookupToken(opts.lookup);
  if (!flow) {
    runtime.error(formatFlowLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  const tasks = listTasksForFlowId(flow.flowId);
  const taskSummary = getFlowTaskSummary(flow.flowId);
  const stateSummary = summarizeFlowState(flow);

  if (opts.json) {
    writeRuntimeJson(runtime, {
      ...flow,
      tasks,
      taskSummary,
    });
    return;
  }

  const lines = [
    "TaskFlow:",
    `flowId: ${flow.flowId}`,
    `status: ${flow.status}`,
    `goal: ${safeFlowDisplayText(flow.goal)}`,
    `currentStep: ${safeFlowDisplayText(flow.currentStep)}`,
    `owner: ${safeFlowDisplayText(flow.ownerKey)}`,
    `notify: ${flow.notifyPolicy}`,
    ...(stateSummary ? [`state: ${safeFlowDisplayText(stateSummary)}`] : []),
    ...(flow.cancelRequestedAt
      ? [`cancelRequestedAt: ${formatFlowTimestamp(flow.cancelRequestedAt)}`]
      : []),
    `createdAt: ${formatFlowTimestamp(flow.createdAt)}`,
    `updatedAt: ${formatFlowTimestamp(flow.updatedAt)}`,
    `endedAt: ${formatFlowTimestamp(flow.endedAt)}`,
    `tasks: ${taskSummary.total} total · ${taskSummary.active} active · ${taskSummary.failures} issues`,
  ];
  for (const line of lines) {
    runtime.log(line);
  }
  if (tasks.length === 0) {
    runtime.log("Linked tasks: none");
    return;
  }
  runtime.log("Linked tasks:");
  for (const task of tasks) {
    const safeLabel = safeFlowDisplayText(task.label ?? task.task);
    runtime.log(`- ${task.taskId} ${task.status} ${task.runId ?? "n/a"} ${safeLabel}`);
  }
}

export async function flowsCancelCommand(opts: { lookup: string }, runtime: RuntimeEnv) {
  const flow = resolveTaskFlowForLookupToken(opts.lookup);
  if (!flow) {
    runtime.error(formatFlowLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  const result = await cancelFlowById({
    cfg: getRuntimeConfig(),
    flowId: flow.flowId,
  });
  if (!result.found) {
    runtime.error(result.reason ?? formatFlowLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  if (!result.cancelled) {
    runtime.error(result.reason ?? `Could not cancel TaskFlow: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const updated = getTaskFlowById(flow.flowId) ?? result.flow ?? flow;
  runtime.log(`Cancelled ${updated.flowId} (${updated.syncMode}) with status ${updated.status}.`);
}

export async function flowsStartProductionCommand(
  opts: {
    ownerKey?: string;
    controllerId?: string;
    goal?: string;
    sliceId?: string;
    sliceOwner?: string;
    authorityPath?: string;
    authorityBasis?: string;
    buildItem?: string;
    requiredOwnerLane?: string;
    attemptedOwnerLane?: string;
    attemptedExecutor?: string;
    executorRole?: string;
    lawfulRouteRequired?: string;
    currentStep?: string;
    blocker?: string[];
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const ownerKey = requireCliString(opts.ownerKey, "--owner-key", runtime);
  const controllerId = requireCliString(opts.controllerId, "--controller-id", runtime);
  const goal = requireCliString(opts.goal, "--goal", runtime);
  const sliceId = requireCliString(opts.sliceId, "--slice-id", runtime);
  const sliceOwner = requireCliString(opts.sliceOwner, "--slice-owner", runtime);
  const authorityPath = requireCliString(opts.authorityPath, "--authority-path", runtime);
  const authorityBasis = requireCliString(opts.authorityBasis, "--authority-basis", runtime);
  const buildItem = requireCliString(opts.buildItem, "--build-item", runtime);
  const requiredOwnerLane = requireCliString(
    opts.requiredOwnerLane,
    "--required-owner-lane",
    runtime,
  );
  const attemptedOwnerLane = requireCliString(
    opts.attemptedOwnerLane,
    "--attempted-owner-lane",
    runtime,
  );
  const attemptedExecutor = requireCliString(
    opts.attemptedExecutor,
    "--attempted-executor",
    runtime,
  );
  const executorRole = requireCliString(opts.executorRole, "--executor-role", runtime);
  const lawfulRouteRequired = requireCliString(
    opts.lawfulRouteRequired,
    "--lawful-route-required",
    runtime,
  );
  if (
    !ownerKey ||
    !controllerId ||
    !goal ||
    !sliceId ||
    !sliceOwner ||
    !authorityPath ||
    !authorityBasis ||
    !buildItem ||
    !requiredOwnerLane ||
    !attemptedOwnerLane ||
    !attemptedExecutor ||
    !executorRole ||
    !lawfulRouteRequired
  ) {
    return;
  }
  const ownerLaneGuard = evaluateProductionOwnerLaneGuard({
    buildPlanRef: authorityPath,
    buildItem,
    requiredOwnerLane,
    attemptedOwnerLane,
    attemptedExecutor,
    executorRole,
    lawfulRouteRequired,
  });
  if (!ownerLaneGuard.allowed) {
    failCommand(runtime, ownerLaneGuard.message);
    return;
  }

  const now = Date.now();
  const blockers = (opts.blocker ?? []).map((value) => value.trim()).filter(Boolean);
  const flow = createManagedTaskFlow({
    ownerKey,
    controllerId,
    goal,
    status: "running",
    notifyPolicy: "done_only",
    currentStep: normalizeOptionalString(opts.currentStep) ?? "production_slice_started",
    continuation: {
      activeProductionRun: true,
      parentRunOpen: true,
    },
    stateJson: {
      kind: "production_taskflow_slice",
      sliceId,
      sliceOwner,
      authorityPath,
      authorityBasis,
      buildItem,
      requiredOwnerLane,
      attemptedOwnerLane,
      attemptedExecutor,
      executorRole,
      lawfulRouteRequired,
      ownerLaneGuard: ownerLaneGuard.details,
      blockers,
    },
    createdAt: now,
    updatedAt: now,
  });
  if (!flow) {
    failCommand(runtime, "Failed to create production TaskFlow.");
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { flow });
    return;
  }
  runtime.log(`Started production TaskFlow ${flow.flowId} (${sliceId}).`);
}

export async function flowsResumeProductionCommand(
  opts: { lookup: string; currentStep?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const flow = resolveTaskFlowForLookupToken(opts.lookup);
  if (!flow) {
    failCommand(runtime, formatFlowLookupMiss(opts.lookup));
    return;
  }
  if (flow.syncMode !== "managed") {
    failCommand(runtime, `TaskFlow is not managed: ${flow.flowId}.`);
    return;
  }
  const continuation = getTaskFlowProductionContinuation(flow);
  if (!continuation?.activeProductionRun) {
    failCommand(runtime, `TaskFlow is not an active-production flow: ${flow.flowId}.`);
    return;
  }
  const runtimeGuard = runRuntimeAssetGuardPreflight({ operation: "production preflight" });
  if (!runtimeGuard.ok) {
    failCommand(
      runtime,
      `Production resume blocked by runtime asset guard: ${runtimeGuard.message}.`,
    );
    return;
  }
  const resumed = resumeFlow({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    status: "running",
    currentStep: normalizeOptionalString(opts.currentStep) ?? flow.currentStep,
  });
  if (!resumed.applied) {
    failCommand(runtime, `Failed to resume production TaskFlow: ${resumed.reason}.`);
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { flow: resumed.flow });
    return;
  }
  runtime.log(`Resumed production TaskFlow ${resumed.flow.flowId}.`);
}

export async function flowsLawfulStopCommand(
  opts: {
    lookup: string;
    reason?: ProductionContinuationStopReason;
    detail?: string;
    currentStep?: string;
    finish?: boolean;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const flow = resolveTaskFlowForLookupToken(opts.lookup);
  if (!flow) {
    failCommand(runtime, formatFlowLookupMiss(opts.lookup));
    return;
  }
  const reason = requireCliString(
    opts.reason,
    "--reason",
    runtime,
  ) as ProductionContinuationStopReason | null;
  const detail = requireCliString(opts.detail, "--detail", runtime);
  if (!reason || !detail) {
    return;
  }
  const stopped = recordFlowLawfulStop({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    reason,
    detail,
    currentStep: normalizeOptionalString(opts.currentStep) ?? flow.currentStep,
  });
  if (!stopped.applied) {
    failCommand(runtime, `Failed to record lawful stop: ${stopped.reason}.`);
    return;
  }
  let result = stopped.flow;
  if (opts.finish) {
    if (reason !== "whole_run_complete") {
      failCommand(runtime, "--finish is only valid with --reason whole_run_complete.");
      return;
    }
    const finished = await import("../tasks/task-flow-runtime-internal.js").then((module) =>
      module.finishFlow({
        flowId: stopped.flow.flowId,
        expectedRevision: stopped.flow.revision,
        currentStep: normalizeOptionalString(opts.currentStep) ?? stopped.flow.currentStep,
      }),
    );
    if (!finished.applied) {
      failCommand(runtime, `Failed to finish production TaskFlow: ${finished.reason}.`);
      return;
    }
    result = finished.flow;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { flow: result });
    return;
  }
  runtime.log(`Recorded lawful stop for production TaskFlow ${result.flowId}: ${reason}.`);
}
