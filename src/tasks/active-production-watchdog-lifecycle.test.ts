import { promises as fs } from "node:fs";
import path from "node:path";
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
  resolveProductionWatchdogContinuityGatePersistence,
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

async function withTaskState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-production-watchdog-lifecycle-" },
    async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      resetProductionWatchdogLifecycleGateForTests();
      try {
        return await run(state.stateDir);
      } finally {
        resetProductionWatchdogLifecycleGateForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

async function readOnlyJsonArtifact<T>(dir: string, subdir: string): Promise<T> {
  const artifactDir = path.join(dir, subdir);
  const files = await fs.readdir(artifactDir);
  expect(files).toHaveLength(1);
  return JSON.parse(await fs.readFile(path.join(artifactDir, files[0]!), "utf8")) as T;
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

  it("classifies cron update stalls as structured lifecycle update failures", async () => {
    await withTaskState(async () => {
      const cron = createCronHarness(false);
      cron.update = vi.fn(async () => await new Promise<never>(() => {}));
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
        ok: false,
        action: "update-failed",
        jobId: ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
        error: expect.stringContaining(
          "cron.update active production watchdog lifecycle timed out",
        ),
      });
    });
  });

  it("disables the watchdog cron after a lawful production stop leaves no active production", async () => {
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

  it("keeps unfinished lawful-stopped production flows under watchdog when a launched executor was lost", async () => {
    await withTaskState(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "tests/production-watchdog",
        goal: "100% production run",
        status: "blocked",
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
          currentUnitStatus: "blocked",
          blockerPresent: true,
          lawfulStopReason: "blocker",
          nextExecutableUnitLaunched: true,
        },
      });
      expect(flow).not.toBeNull();

      expect(flow && flowRequiresActiveWorkWatchdog(flow)).toBe(true);
    });
  });

  it("reacts to production flow creation through installed lifecycle observers", async () => {
    await withTaskState(async () => {
      const cron = createCronHarness(false);
      installProductionWatchdogLifecycleGate({ cron });
      await vi.waitFor(() => expect(cron.job.enabled).toBe(false));
      cron.update.mockClear();

      createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "tests/production-watchdog",
        goal: "100% production run",
        status: "running",
        continuation: { activeProductionRun: true },
      });

      await vi.waitFor(() => expect(cron.job.enabled).toBe(true));
      expect(cron.update).not.toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
        enabled: false,
      });
      expect(cron.job.enabled).toBe(true);
    });
  });

  it("resolves Continuity Gate persistence only for absolute state directories", () => {
    expect(
      resolveProductionWatchdogContinuityGatePersistence({ stateDir: undefined }),
    ).toBeUndefined();
    expect(
      resolveProductionWatchdogContinuityGatePersistence({ stateDir: "undefined" }),
    ).toBeUndefined();
    expect(
      resolveProductionWatchdogContinuityGatePersistence({ stateDir: "relative/openclaw-state" }),
    ).toBeUndefined();
    expect(
      resolveProductionWatchdogContinuityGatePersistence({ stateDir: "/tmp/openclaw-state" }),
    ).toMatchObject({
      outputDir: path.join(
        "/tmp/openclaw-state",
        "var",
        "continuity_gate_v2",
        "active_production_watchdog",
      ),
    });
  });

  it("persists Continuity Gate technical continuation evidence when active work keeps the watchdog enabled", async () => {
    await withTaskState(async (stateDir) => {
      const cron = createCronHarness(false);
      const flow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "tests/production-watchdog",
        goal: "100% production run",
        status: "running",
        continuation: { activeProductionRun: true },
      });
      expect(flow).not.toBeNull();
      const continuityGate = resolveProductionWatchdogContinuityGatePersistence({
        stateDir,
        now: "2026-07-04T22:45:00.000Z",
      });

      const result = await reconcileProductionWatchdogCron({ cron, continuityGate });

      expect(result).toMatchObject({ ok: true, action: "enabled" });
      const outputDir = path.join(
        stateDir,
        "var",
        "continuity_gate_v2",
        "active_production_watchdog",
      );
      const decisionRecord = await readOnlyJsonArtifact<{
        selected_state: string;
        authority_resolution: { winner: string; winnerId: string };
        technical_vs_product: { lane: string };
      }>(outputDir, "cleanup_crew_decision_records");
      const continueReceipt = await readOnlyJsonArtifact<{
        selected_state: string;
        repair_action: string;
      }>(outputDir, "cleanup_crew_continue_receipts");
      const trace = await readOnlyJsonArtifact<{
        selected_state: string;
        technical_vs_product: { lane: string };
        scope: { surfaces: string[]; records: string[] };
      }>(outputDir, "cleanup_crew_diagnostic_traces");

      expect(decisionRecord).toMatchObject({
        selected_state: "CONTINUE_TECHNICAL_REPAIR",
        authority_resolution: {
          winner: "active_mission_lock",
          winnerId: `active_production_watchdog:${flow!.flowId}`,
        },
        technical_vs_product: {
          lane: "technical",
        },
      });
      expect(continueReceipt).toMatchObject({
        selected_state: "CONTINUE_TECHNICAL_REPAIR",
      });
      expect(continueReceipt.repair_action).toContain(
        "record active production watchdog lifecycle action enabled",
      );
      expect(trace).toMatchObject({
        selected_state: "CONTINUE_TECHNICAL_REPAIR",
        technical_vs_product: {
          lane: "technical",
        },
        scope: {
          surfaces: ["active-production-watchdog-lifecycle"],
          records: expect.arrayContaining([flow!.flowId, "watchdog_action:enabled"]),
        },
      });
      await expect(
        fs.readdir(path.join(outputDir, "cleanup_crew_stop_reports")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("persists Continuity Gate stop evidence for unresolved unsafe active-work states", async () => {
    await withTaskState(async (stateDir) => {
      const cron = createCronHarness(false);
      const flow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "tests/production-watchdog",
        goal: "100% production run",
        status: "running",
        continuation: { activeProductionRun: true, safetyStopPresent: true },
      });
      expect(flow).not.toBeNull();
      const continuityGate = resolveProductionWatchdogContinuityGatePersistence({
        stateDir,
        now: "2026-07-04T22:46:00.000Z",
      });

      const result = await reconcileProductionWatchdogCron({ cron, continuityGate });

      expect(result).toMatchObject({ ok: true, action: "enabled" });
      const outputDir = path.join(
        stateDir,
        "var",
        "continuity_gate_v2",
        "active_production_watchdog",
      );
      const stopReport = await readOnlyJsonArtifact<{
        stop_state: string;
        plain_text_question: string;
      }>(outputDir, "cleanup_crew_stop_reports");
      const trace = await readOnlyJsonArtifact<{
        selected_state: string;
        authority_resolution: { winner: string; winnerId: string };
        technical_vs_product: { lane: string };
      }>(outputDir, "cleanup_crew_diagnostic_traces");

      expect(stopReport).toMatchObject({
        stop_state: "STOP_UNSAFE_BEHAVIOR_CHANGE",
        plain_text_question: "No operator action requested unless a human decision is required.",
      });
      expect(trace).toMatchObject({
        selected_state: "STOP_UNSAFE_BEHAVIOR_CHANGE",
        authority_resolution: {
          winner: "global_sop",
          winnerId: `active_production_watchdog:unsafe:${flow!.flowId}`,
        },
        technical_vs_product: {
          lane: "true_unknown",
        },
      });
      await expect(
        fs.readdir(path.join(outputDir, "cleanup_crew_continue_receipts")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
