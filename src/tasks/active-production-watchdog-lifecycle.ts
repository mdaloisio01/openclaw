import type { CronServiceContract } from "../cron/service-contract.js";
import type { Logger } from "../cron/service/state.js";
import { getTaskFlowProductionContinuation, listTaskFlowRecords } from "./task-flow-registry.js";
import {
  configureTaskFlowRegistryRuntime,
  getTaskFlowRegistryObservers,
} from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { listTaskRecords } from "./task-registry.js";
import { configureTaskRegistryRuntime, getTaskRegistryObservers } from "./task-registry.store.js";

export const ACTIVE_WORK_WATCHDOG_CRON_JOB_ID = "ce29b4c9-7166-474d-9596-1dd86e730574";
export const ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME = "system-wide-active-work-watchdog-report-only";

export type ProductionWatchdogLifecycleDecision = {
  shouldRun: boolean;
  activeProductionFlowIds: string[];
  openTaskCount: number;
};

export type ProductionWatchdogLifecycleResult =
  | {
      ok: true;
      action: "enabled" | "disabled" | "already-correct";
      decision: ProductionWatchdogLifecycleDecision;
      jobId: string;
    }
  | {
      ok: false;
      action: "missing-watchdog-cron";
      decision: ProductionWatchdogLifecycleDecision;
    }
  | {
      ok: false;
      action: "update-failed";
      decision: ProductionWatchdogLifecycleDecision;
      jobId: string;
      error: string;
    };

type GateLogger = Pick<Logger, "info" | "warn">;

let installed = false;
let pendingReconcile: Promise<ProductionWatchdogLifecycleResult> | null = null;
let reconcileAgain = false;

function isOpenTaskStatus(status: string): boolean {
  return (
    status === "queued" || status === "running" || status === "blocked" || status === "waiting"
  );
}

export function flowRequiresActiveWorkWatchdog(flow: TaskFlowRecord): boolean {
  const continuation = getTaskFlowProductionContinuation(flow);
  if (!continuation?.activeProductionRun) {
    return false;
  }
  if (
    continuation.lawfulWholeRunCompletion ||
    continuation.lawfulStopReason === "whole_run_complete"
  ) {
    return false;
  }
  if (continuation.lawfulStopReason && !continuation.continuationViolation) {
    return false;
  }
  if (
    (flow.status === "succeeded" ||
      flow.status === "failed" ||
      flow.status === "cancelled" ||
      flow.status === "lost") &&
    !continuation.continuationRequiredAfterLocalSuccess &&
    !continuation.continuationViolation
  ) {
    return false;
  }
  return true;
}

export function resolveProductionWatchdogLifecycleDecision(): ProductionWatchdogLifecycleDecision {
  const activeProductionFlowIds = listTaskFlowRecords()
    .filter(flowRequiresActiveWorkWatchdog)
    .map((flow) => flow.flowId);
  const activeProductionFlowIdSet = new Set(activeProductionFlowIds);
  const openTaskCount = listTaskRecords().filter(
    (task) =>
      isOpenTaskStatus(task.status) &&
      typeof task.parentFlowId === "string" &&
      activeProductionFlowIdSet.has(task.parentFlowId.trim()),
  ).length;
  return {
    shouldRun: activeProductionFlowIds.length > 0,
    activeProductionFlowIds,
    openTaskCount,
  };
}

async function resolveWatchdogCronJob(
  cron: CronServiceContract,
): Promise<{ id: string; enabled: boolean } | null> {
  const byId = await cron.readJob(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID);
  if (byId) {
    return { id: byId.id, enabled: byId.enabled };
  }
  const jobs = await cron.list({ includeDisabled: true });
  const byName = jobs.find((job) => job.name === ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME);
  return byName ? { id: byName.id, enabled: byName.enabled } : null;
}

export async function reconcileProductionWatchdogCron(params: {
  cron: CronServiceContract;
  log?: GateLogger;
}): Promise<ProductionWatchdogLifecycleResult> {
  const decision = resolveProductionWatchdogLifecycleDecision();
  const job = await resolveWatchdogCronJob(params.cron);
  if (!job) {
    params.log?.warn(
      {
        jobId: ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
        jobName: ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME,
        activeProductionFlowIds: decision.activeProductionFlowIds,
      },
      "active production watchdog lifecycle gate could not find managed cron job",
    );
    return { ok: false, action: "missing-watchdog-cron", decision };
  }
  if (job.enabled === decision.shouldRun) {
    return { ok: true, action: "already-correct", decision, jobId: job.id };
  }
  try {
    await params.cron.update(job.id, { enabled: decision.shouldRun });
    params.log?.info(
      {
        jobId: job.id,
        enabled: decision.shouldRun,
        activeProductionFlowIds: decision.activeProductionFlowIds,
        openTaskCount: decision.openTaskCount,
      },
      "active production watchdog lifecycle gate updated cron state",
    );
    return {
      ok: true,
      action: decision.shouldRun ? "enabled" : "disabled",
      decision,
      jobId: job.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.log?.warn(
      {
        jobId: job.id,
        enabled: decision.shouldRun,
        error: message,
      },
      "active production watchdog lifecycle gate failed to update cron state",
    );
    return { ok: false, action: "update-failed", decision, jobId: job.id, error: message };
  }
}

export function installProductionWatchdogLifecycleGate(params: {
  cron: CronServiceContract;
  log?: GateLogger;
}): void {
  if (installed) {
    return;
  }
  installed = true;
  const previousTaskObservers = getTaskRegistryObservers();
  const previousFlowObservers = getTaskFlowRegistryObservers();
  const scheduleReconcile = () => {
    if (pendingReconcile) {
      reconcileAgain = true;
      return;
    }
    pendingReconcile = reconcileProductionWatchdogCron(params).finally(() => {
      pendingReconcile = null;
      if (reconcileAgain) {
        reconcileAgain = false;
        scheduleReconcile();
      }
    });
  };
  configureTaskRegistryRuntime({
    observers: {
      onEvent: (event) => {
        previousTaskObservers?.onEvent?.(event);
        scheduleReconcile();
      },
    },
  });
  configureTaskFlowRegistryRuntime({
    observers: {
      onEvent: (event) => {
        previousFlowObservers?.onEvent?.(event);
        scheduleReconcile();
      },
    },
  });
  scheduleReconcile();
}

export function resetProductionWatchdogLifecycleGateForTests(): void {
  installed = false;
  pendingReconcile = null;
  reconcileAgain = false;
}
