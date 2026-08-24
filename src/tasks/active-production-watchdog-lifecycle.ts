import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { persistCleanupCrewContinuityGateDecision } from "../commands/cleanup-plan.js";
import type { AuthoritySource } from "../continuity/continuity-gate-v2.js";
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
const ACTIVE_PRODUCTION_WATCHDOG_CRON_OPERATION_TIMEOUT_MS = 2_000;
const CONTINUITY_GATE_WATCHDOG_OUTPUT_DIR = path.join(
  "var",
  "continuity_gate_v2",
  "active_production_watchdog",
);

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

export type ProductionWatchdogContinuityGatePersistenceOptions = {
  outputDir: string;
  now?: string;
};

export type ResolveProductionWatchdogContinuityGatePersistenceParams = {
  stateDir?: string | null;
  now?: string;
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

async function withCronOperationTimeout<T>(
  operation: string,
  run: Promise<T>,
  timeoutMs = ACTIVE_PRODUCTION_WATCHDOG_CRON_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function normalizeAbsoluteDir(value: string | undefined | null): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized === "undefined" || !path.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}

export function resolveProductionWatchdogContinuityGatePersistence(
  params: ResolveProductionWatchdogContinuityGatePersistenceParams,
): ProductionWatchdogContinuityGatePersistenceOptions | undefined {
  const stateDir = normalizeAbsoluteDir(params.stateDir);
  if (!stateDir) {
    return undefined;
  }
  return {
    outputDir: path.join(stateDir, CONTINUITY_GATE_WATCHDOG_OUTPUT_DIR),
    now: params.now,
  };
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
    return continuation.parentRunOpen === true && continuation.nextExecutableUnitLaunched === true;
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

function resolveActiveWatchdogFlows(
  decision: ProductionWatchdogLifecycleDecision,
): TaskFlowRecord[] {
  const activeFlowIds = new Set(decision.activeProductionFlowIds);
  return listTaskFlowRecords().filter((flow) => activeFlowIds.has(flow.flowId));
}

function findUnsafeActiveWatchdogFlow(
  flows: TaskFlowRecord[],
): { flow: TaskFlowRecord; reason: string } | undefined {
  for (const flow of flows) {
    const continuation = getTaskFlowProductionContinuation(flow);
    if (!continuation?.activeProductionRun) {
      continue;
    }
    if (continuation.safetyStopPresent && !continuation.lawfulStopReason) {
      return {
        flow,
        reason: "active production continuation has an unresolved safety stop",
      };
    }
    if (continuation.hardStopPresent && !continuation.lawfulStopReason) {
      return {
        flow,
        reason: "active production continuation has an unresolved hard stop",
      };
    }
  }
  return undefined;
}

async function persistProductionWatchdogContinuityGateDecision(params: {
  decision: ProductionWatchdogLifecycleDecision;
  result: ProductionWatchdogLifecycleResult;
  continuityGate?: ProductionWatchdogContinuityGatePersistenceOptions;
  log?: GateLogger;
}): Promise<void> {
  const outputDir = normalizeAbsoluteDir(params.continuityGate?.outputDir);
  if (!outputDir || !params.decision.shouldRun) {
    return;
  }
  const flows = resolveActiveWatchdogFlows(params.decision);
  const unsafe = findUnsafeActiveWatchdogFlow(flows);
  const flowIds = params.decision.activeProductionFlowIds;
  const flowIdSummary = flowIds.length > 0 ? flowIds.join(", ") : "none";
  const authoritySources: AuthoritySource[] = unsafe
    ? [
        {
          kind: "global_sop",
          id: `active_production_watchdog:unsafe:${unsafe.flow.flowId}`,
          summary: unsafe.reason,
          active: true,
          safetyBlock: true,
          proofPath: unsafe.flow.flowId,
        },
      ]
    : [
        {
          kind: "active_mission_lock",
          id: `active_production_watchdog:${flowIds.join("|")}`,
          summary: `Active production watchdog continuation evidence for ${flowIdSummary}`,
          active: true,
        },
      ];
  const actionSummary =
    params.result.ok === false
      ? `repair active production watchdog lifecycle action ${params.result.action}`
      : `record active production watchdog lifecycle action ${params.result.action}`;
  try {
    await persistCleanupCrewContinuityGateDecision({
      outputDir,
      activeMission: `Active production watchdog continuation for ${flowIdSummary}`,
      now: params.continuityGate?.now,
      authoritySources,
      issue: unsafe
        ? {
            summary: unsafe.reason,
            blocker: "unsafe active production continuation state",
            pathRisk: "CRITICAL_CONTROL",
            diffIntent: "unknown_intent",
            behaviorImpact: "true_unknown",
            ownerLevelBlockerAudit: "active_production_watchdog",
          }
        : {
            summary: `Active production watchdog lifecycle result ${params.result.action} with ${params.decision.openTaskCount} open task(s).`,
            blocker: params.result.ok === false ? "tooling gap" : "artifact missing",
            pathRisk: "MEDIUM_RISK_RUNTIME",
            diffIntent: "proof_or_receipt_shape",
            behaviorImpact: "technical",
            safeTechnicalPathKnown: true,
            safeTechnicalPathDescription: actionSummary,
            scopeWithinMission: true,
            validationAvailable: true,
            rollbackOrProofPreserved: true,
            ownerLevelBlockerAudit: "active_production_watchdog",
          },
      scope: {
        files: ["src/tasks/active-production-watchdog-lifecycle.ts"],
        records: [
          ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
          ...flowIds,
          `watchdog_action:${params.result.action}`,
        ],
        commands: [],
      },
      repairAction: unsafe
        ? "stop active production watchdog continuation until the unsafe continuation state is diagnosed"
        : actionSummary,
      proofPath: flowIds[0] ?? ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
      diagnostic: {
        surfaces: ["active-production-watchdog-lifecycle"],
        proofRefs: [
          ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
          ...flowIds,
          `watchdog_action:${params.result.action}`,
        ],
        redactionStatus: "no_sensitive_payloads",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.log?.warn(
      { error: message, activeProductionFlowIds: flowIds },
      "active production watchdog Continuity Gate persistence failed",
    );
  }
}

export async function reconcileProductionWatchdogCron(params: {
  cron: CronServiceContract;
  log?: GateLogger;
  continuityGate?: ProductionWatchdogContinuityGatePersistenceOptions;
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
    const result = { ok: false, action: "missing-watchdog-cron", decision } as const;
    await persistProductionWatchdogContinuityGateDecision({
      decision,
      result,
      continuityGate: params.continuityGate,
      log: params.log,
    });
    return result;
  }
  if (job.enabled === decision.shouldRun) {
    const result = { ok: true, action: "already-correct", decision, jobId: job.id } as const;
    await persistProductionWatchdogContinuityGateDecision({
      decision,
      result,
      continuityGate: params.continuityGate,
      log: params.log,
    });
    return result;
  }
  try {
    await withCronOperationTimeout(
      "cron.update active production watchdog lifecycle",
      params.cron.update(job.id, { enabled: decision.shouldRun }),
    );
    params.log?.info(
      {
        jobId: job.id,
        enabled: decision.shouldRun,
        activeProductionFlowIds: decision.activeProductionFlowIds,
        openTaskCount: decision.openTaskCount,
      },
      "active production watchdog lifecycle gate updated cron state",
    );
    const result = {
      ok: true,
      action: decision.shouldRun ? "enabled" : "disabled",
      decision,
      jobId: job.id,
    } as const;
    await persistProductionWatchdogContinuityGateDecision({
      decision,
      result,
      continuityGate: params.continuityGate,
      log: params.log,
    });
    return result;
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
    const result = {
      ok: false,
      action: "update-failed",
      decision,
      jobId: job.id,
      error: message,
    } as const;
    await persistProductionWatchdogContinuityGateDecision({
      decision,
      result,
      continuityGate: params.continuityGate,
      log: params.log,
    });
    return result;
  }
}

export function installProductionWatchdogLifecycleGate(params: {
  cron: CronServiceContract;
  log?: GateLogger;
  continuityGate?: ProductionWatchdogContinuityGatePersistenceOptions;
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
