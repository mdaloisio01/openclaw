import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronServiceContract } from "../cron/service-contract.js";
import type { CronJob } from "../cron/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
  ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME,
  flowRequiresActiveWorkWatchdog,
  installProductionWatchdogLifecycleGate,
  reconcileProductionWatchdogCron,
  resetProductionWatchdogLifecycleGateForTests,
  resolveProductionWatchdogLifecycleDecision,
} from "./active-production-watchdog-lifecycle.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  recordFlowLawfulStop,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import { resetTaskRegistryForTests } from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createWatchdogJob(enabled: boolean): CronJob {
  return {
    id: ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
    name: ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME,
    enabled,
    agentId: "orchestrator",
    schedule: { kind: "cron", expr: "*/5 * * * *" },
    payload: { kind: "systemEvent", text: "watch active production" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    deleteAfterRun: false,
    createdAtMs: 100,
    updatedAtMs: 100,
    state: {},
  };
}

function createCronHarness(enabled: boolean): CronServiceContract & {
  job: CronJob;
  update: ReturnType<typeof vi.fn>;
} {
  const job = createWatchdogJob(enabled);
  return {
    job,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    status: vi.fn(async () => ({
      running: true,
      jobCount: 1,
      enabledJobCount: job.enabled ? 1 : 0,
    })),
    list: vi.fn(async () => [job]),
    listPage: vi.fn(async () => ({ items: [job], total: 1, limit: 50, offset: 0 })),
    add: vi.fn(),
    update: vi.fn(async (_id: string, patch: Partial<CronJob>) => {
      if (typeof patch.enabled === "boolean") {
        job.enabled = patch.enabled;
      }
      job.updatedAtMs += 1;
      return job;
    }),
    remove: vi.fn(),
    run: vi.fn(),
    enqueueRun: vi.fn(),
    getJob: vi.fn((id: string) => (id === job.id ? job : undefined)),
    readJob: vi.fn(async (id: string) => (id === job.id ? job : undefined)),
    getDefaultAgentId: vi.fn(() => "orchestrator"),
    wake: vi.fn(() => ({ ok: true as const })),
  } as unknown as CronServiceContract & { job: CronJob; update: ReturnType<typeof vi.fn> };
}

async function withTaskState<T>(run: () => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-production-watchdog-lifecycle-" },
    async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      resetProductionWatchdogLifecycleGateForTests();
      try {
        return await run();
      } finally {
        resetProductionWatchdogLifecycleGateForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("active production watchdog lifecycle", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetProductionWatchdogLifecycleGateForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("enables the active-work watchdog cron when active production continuation is open", async () => {
    await withTaskState(async () => {
      const cron = createCronHarness(false);
      const flow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "tests/production-watchdog",
        goal: "100% production run",
        status: "running",
        continuation: { activeProductionRun: true },
      });
      expect(flow).not.toBeNull();

      const result = await reconcileProductionWatchdogCron({ cron });

      expect(result).toMatchObject({
        ok: true,
        action: "enabled",
        jobId: ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
      });
      expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
        enabled: true,
      });
      expect(cron.job.enabled).toBe(true);
      expect(resolveProductionWatchdogLifecycleDecision().shouldRun).toBe(true);
    });
  });

  it("disables the watchdog cron after a lawful production stop", async () => {
    await withTaskState(async () => {
      const cron = createCronHarness(true);
      const flow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "tests/production-watchdog",
        goal: "100% production run",
        status: "running",
        continuation: { activeProductionRun: true },
      });
      expect(flow).not.toBeNull();
      const stopped = recordFlowLawfulStop({
        flowId: flow!.flowId,
        expectedRevision: flow!.revision,
        reason: "whole_run_complete",
        detail: "Production closed with proof.",
      });
      expect(stopped.applied).toBe(true);
      const latest = getTaskFlowById(flow!.flowId);
      expect(latest && flowRequiresActiveWorkWatchdog(latest)).toBe(false);

      const result = await reconcileProductionWatchdogCron({ cron });

      expect(result).toMatchObject({
        ok: true,
        action: "disabled",
        jobId: ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
      });
      expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
        enabled: false,
      });
      expect(cron.job.enabled).toBe(false);
    });
  });

  it("reacts to production flow creation through installed lifecycle observers", async () => {
    await withTaskState(async () => {
      const cron = createCronHarness(false);
      installProductionWatchdogLifecycleGate({ cron });
      await vi.waitFor(() =>
        expect(cron.update).not.toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
          enabled: true,
        }),
      );

      createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "tests/production-watchdog",
        goal: "100% production run",
        status: "running",
        continuation: { activeProductionRun: true },
      });

      await vi.waitFor(() =>
        expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
          enabled: true,
        }),
      );
      expect(cron.job.enabled).toBe(true);
    });
  });
});
