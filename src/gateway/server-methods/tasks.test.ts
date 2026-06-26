import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronServiceContract } from "../../cron/service-contract.js";
import type { CronJob } from "../../cron/types.js";
import {
  ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
  ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME,
  installProductionWatchdogLifecycleGate,
  resetProductionWatchdogLifecycleGateForTests,
} from "../../tasks/active-production-watchdog-lifecycle.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  getTaskById,
  markTaskTerminalById,
  recordTaskProgressByRunId,
  resetTaskRegistryForTests,
} from "../../tasks/runtime-internal.js";
import {
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-flow-runtime-internal.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { tasksHandlers } from "./tasks.js";
import type { RespondFn } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
type TaskResponsePayload = {
  tasks?: Array<Record<string, unknown>>;
  task?: Record<string, unknown>;
  executorIdentityProof?: Record<string, unknown>;
  found?: boolean;
  cancelled?: boolean;
  ok?: boolean;
  flowId?: string;
  initialEnabled?: boolean;
  afterOpenEnabled?: boolean;
  afterCloseEnabled?: boolean;
  flowStatus?: string;
  flow?: Record<string, unknown>;
};

let stateDir: string;

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-tasks-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests({ persist: false });
  resetProductionWatchdogLifecycleGateForTests();
});

afterEach(async () => {
  resetProductionWatchdogLifecycleGateForTests();
  resetTaskFlowRegistryForTests({ persist: false });
  resetTaskRegistryForTests();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});

function captureRespond() {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  return { calls, respond };
}

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

function createContext(cron: CronServiceContract = createCronHarness(false)) {
  return {
    getRuntimeConfig: () => ({}),
    cron,
  } as never;
}

async function waitForCronEnabled(cron: { job: CronJob }, enabled: boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (cron.job.enabled === enabled) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for watchdog enabled=${enabled}`);
}

async function runTaskHandler(
  method:
    | "tasks.list"
    | "tasks.get"
    | "tasks.cancel"
    | "tasks.startProductionFlow"
    | "tasks.resumeProductionFlow"
    | "tasks.runTaskInFlow"
    | "tasks.recordTaskInFlowProgress"
    | "tasks.completeTaskInFlow"
    | "tasks.recordProductionFlowLawfulStop"
    | "tasks.probeProductionWatchdogLifecycle",
  params: Record<string, unknown>,
  options?: { cron?: CronServiceContract },
) {
  const { calls, respond } = captureRespond();
  await tasksHandlers[method]({
    req: { type: "req", id: `req-${method}`, method },
    params,
    respond,
    context: createContext(options?.cron),
    client: null,
    isWebchatConnect: () => false,
  });
  return {
    calls,
    payload: calls[0]?.[1] as TaskResponsePayload | undefined,
  };
}

async function writeTestBuildPlan(name = "build-plan.md"): Promise<string> {
  const planPath = path.join(stateDir, name);
  await fs.writeFile(planPath, "# Test Build Plan\n", "utf8");
  return planPath;
}

async function getTaskPayload(taskId: string) {
  const { calls, payload } = await runTaskHandler("tasks.get", { taskId });
  expect(calls[0]?.[0]).toBe(true);
  expect(payload?.task?.id).toBe(taskId);
  return { calls, payload };
}

describe("tasks gateway handlers", () => {
  it("lists task summaries with SDK-facing statuses and filters", async () => {
    const running = createTaskRecord({
      runtime: "subagent",
      taskKind: "investigation",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      agentId: "main",
      runId: "run-running",
      task: "Investigate issue",
      status: "running",
      deliveryStatus: "pending",
    });
    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:other:main",
      ownerKey: "agent:other:main",
      scopeKind: "session",
      runId: "run-other",
      task: "Other task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.list", {
      status: "running",
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.tasks).toHaveLength(1);
    const listedTask = payload?.tasks?.[0];
    expect(listedTask?.id).toBe(running.taskId);
    expect(listedTask?.taskId).toBe(running.taskId);
    expect(listedTask?.kind).toBe("investigation");
    expect(listedTask?.runtime).toBe("subagent");
    expect(listedTask?.status).toBe("running");
    expect(listedTask?.title).toBe("Investigate issue");
    expect(listedTask?.agentId).toBe("main");
    expect(listedTask?.sessionKey).toBe("agent:main:main");
    expect(listedTask?.childSessionKey).toBe("agent:worker:subagent:child");
    expect(listedTask?.runId).toBe("run-running");
  });

  it("gets completed tasks with stable completed status", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-completed",
      task: "Done task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
    });

    const { payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.status).toBe("completed");
    expect(payload?.task?.title).toBe("Done task");
  });

  it("sanitizes task text before exposing SDK summaries", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-sanitized",
      label:
        "Compile artifact\nOpenClaw runtime context (internal): Keep internal details private.",
      task: "Compile artifact",
      status: "running",
      deliveryStatus: "pending",
    });
    recordTaskProgressByRunId({
      runId: "run-sanitized",
      progressSummary:
        "Bundling output\nOpenClaw runtime context (internal): Keep internal details private.",
    });
    markTaskTerminalById({
      taskId: task.taskId,
      status: "failed",
      endedAt: Date.now(),
      terminalSummary:
        "Failed after build\nOpenClaw runtime context (internal): Keep internal details private.",
      error: "Tool failed\nOpenClaw runtime context (internal): Keep internal details private.",
    });

    const { calls, payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.title).toBe("Compile artifact");
    expect(payload?.task?.terminalSummary).toBe("Failed after build");
    expect(payload?.task?.error).toBe("Tool failed");
    expect(JSON.stringify(calls[0]?.[1])).not.toContain("OpenClaw runtime context");
  });

  it("cancels running task records and returns the updated task", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-cancel",
      task: "Cancelable task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "user stopped task",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(true);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("cancelled");
    expect(payload?.task?.error).toBe("user stopped task");
  });

  it("probes active production watchdog lifecycle through the installed gateway observer", async () => {
    const cron = createCronHarness(false);
    installProductionWatchdogLifecycleGate({ cron });

    const { calls, payload } = await runTaskHandler(
      "tasks.probeProductionWatchdogLifecycle",
      {},
      { cron },
    );

    expect(calls[0]?.[0]).toBe(true);
    expect(payload).toMatchObject({
      ok: true,
      initialEnabled: false,
      afterOpenEnabled: true,
      afterCloseEnabled: false,
      flowStatus: "succeeded",
    });
    expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
      enabled: true,
    });
    expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
      enabled: false,
    });
    const flowId = payload?.flowId;
    expect(typeof flowId).toBe("string");
    const flow = getTaskFlowById(flowId!);
    expect(flow?.status).toBe("succeeded");
  });

  it("starts and lawfully blocks a production flow through gateway observer state", async () => {
    const cron = createCronHarness(false);
    installProductionWatchdogLifecycleGate({ cron });
    const authorityPath = await writeTestBuildPlan("gie-authority-build-plan.md");

    const started = await runTaskHandler(
      "tasks.startProductionFlow",
      {
        ownerKey: "agent:orchestrator:main",
        controllerId: "gie/authority-mirror-decision",
        goal: "GIE authority mirror decision",
        sliceId: "gie-authority-mirror-decision-2026-06-22T0236Z",
        sliceOwner: "Will / Top-Level Governance",
        authorityPath,
        authorityBasis: "controlling build-state interpretation",
        buildItem: "GIE authority mirror decision",
        requiredOwnerLane: "Will / Top-Level Governance",
        attemptedOwnerLane: "Will / Top-Level Governance",
        attemptedExecutor: "will-orchestrator",
        executorRole: "governance_decision",
        lawfulRouteRequired: "Will / Top-Level Governance decision",
        currentStep: "authority_decision",
        blockers: ["department_registry_mirror_alignment", "blocking_authority_state"],
      },
      { cron },
    );

    expect(started.calls[0]?.[0]).toBe(true);
    await waitForCronEnabled(cron, true);
    expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
      enabled: true,
    });
    const flowId = String(started.payload?.flow?.flowId);
    const flow = getTaskFlowById(flowId);
    expect(flow?.status).toBe("running");
    expect(getTaskFlowProductionContinuation(flow!)?.activeProductionRun).toBe(true);

    const stopped = await runTaskHandler(
      "tasks.recordProductionFlowLawfulStop",
      {
        lookup: flowId,
        reason: "blocker",
        detail: "authority decision remains blocked",
        currentStep: "authority_blocked",
      },
      { cron },
    );

    expect(stopped.calls[0]?.[0]).toBe(true);
    await waitForCronEnabled(cron, false);
    expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
      enabled: false,
    });
    const stoppedFlow = getTaskFlowById(flowId);
    expect(stoppedFlow?.status).toBe("blocked");
    expect(stoppedFlow?.blockedSummary).toBe("authority decision remains blocked");
    expect(getTaskFlowProductionContinuation(stoppedFlow!)?.lawfulStopReason).toBe("blocker");
  });

  it("blocks Will from starting a Will-owned production flow for SADB-owned work", async () => {
    const authorityPath = await writeTestBuildPlan("gie-v2-build-plan.md");

    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-v2-phase0-owner-surface-verification-constitution-2026-06-22T2022Z",
      controllerId: "will-orchestrator",
      goal: "Verify owner surfaces and issue GIE constitution",
      sliceId: "gie-v2-phase0-owner-surface-verification-constitution-2026-06-22T2022Z",
      sliceOwner: "Will / Top-Level Governance",
      authorityPath,
      authorityBasis: "GIE v2 controlling build plan Phase 0",
      buildItem: "Phase 0 - Owner-Surface Verification And GIE Constitution",
      requiredOwnerLane: "SADB",
      attemptedOwnerLane: "Will",
      attemptedExecutor: "will-orchestrator",
      executorRole: "direct_execution",
      lawfulRouteRequired: "dispatch bounded owner-surface discovery support to SADB",
    });

    expect(started.calls[0]?.[0]).toBe(false);
    expect(started.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: {
        buildPlanRef: authorityPath,
        buildItem: "Phase 0 - Owner-Surface Verification And GIE Constitution",
        requiredOwnerLane: "SADB",
        attemptedOwnerLane: "Will",
        attemptedExecutor: "will-orchestrator",
        lawfulRouteRequired: "dispatch bounded owner-surface discovery support to SADB",
        operatorOverrideExists: false,
      },
    });
    expect(started.calls[0]?.[2]?.message).toContain("will_self_perform_forbidden");
  });

  it("blocks missing owner/lane metadata before production flow creation", async () => {
    const authorityPath = await writeTestBuildPlan("missing-owner-route-plan.md");

    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "agent:orchestrator:main",
      controllerId: "gie/missing-owner",
      goal: "Missing owner route",
      sliceId: "gie-missing-owner-route",
      sliceOwner: "Will",
      authorityPath,
      authorityBasis: "test plan",
    });

    expect(started.calls[0]?.[0]).toBe(false);
    expect(started.calls[0]?.[2]?.message).toContain("buildItem is required");
  });

  it("does not treat parent production flow start as child execution proof", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-plan.md");

    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });

    expect(started.calls[0]?.[0]).toBe(true);
    expect(started.payload?.executorIdentityProof).toBeUndefined();
    const flowId = String(started.payload?.flow?.flowId);
    const flow = getTaskFlowById(flowId);
    expect(flow?.status).toBe("running");
    expect(started.payload?.flow?.stateJson).toMatchObject({
      ownerLaneGuard: {
        requiredOwnerLane: "sadb_decomposition_review",
        attemptedExecutor: "sadb_decomposition_review",
      },
    });
  });

  it("blocks child task execution without lawful handoff proof", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-handoff-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);

    const child = await runTaskHandler("tasks.runTaskInFlow", {
      lookup: flowId,
      runtime: "cli",
      workPacketRef: "/tmp/sadb-packet.md",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
      handoffAcceptedBy: "sadb_decomposition_review",
      task: "Run SADB decomposition",
    });

    expect(child.calls[0]?.[0]).toBe(false);
    expect(child.calls[0]?.[2]?.message).toContain("child_task_handoff_missing");
  });

  it("blocks Will from directly running a SADB child task", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-will-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);

    const child = await runTaskHandler("tasks.runTaskInFlow", {
      lookup: flowId,
      runtime: "cli",
      workPacketRef: "/tmp/sadb-packet.md",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "Will",
      attemptedExecutor: "will-orchestrator",
      executorRole: "direct_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
      handoffRef: "handoff:sadb",
      handoffAcceptedBy: "sadb_decomposition_review",
      task: "Run SADB decomposition",
    });

    expect(child.calls[0]?.[0]).toBe(false);
    expect(child.calls[0]?.[2]?.message).toContain("child_task_executor_identity_mismatch");
    expect(child.calls[0]?.[2]?.message).toContain("will_self_perform_forbidden");
  });

  it("blocks production child dispatch without a backing child session", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-child-session-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);

    const child = await runTaskHandler("tasks.runTaskInFlow", {
      lookup: flowId,
      runtime: "cli",
      sourceId: "/tmp/sadb-packet.md",
      workPacketRef: "/tmp/sadb-packet.md",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
      handoffRef: "handoff:sadb",
      handoffAcceptedBy: "sadb_decomposition_review",
      task: "Run SADB decomposition",
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      status: "running",
    });

    expect(child.calls[0]?.[0]).toBe(false);
    expect(child.calls[0]?.[2]?.message).toContain("child_task_backing_session_missing");
  });

  it("blocks production child completion when backing child session proof is missing", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-child-completion-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);
    createTaskRecord({
      runtime: "cli",
      ownerKey: "gie-phase1-sadb-runtime",
      requesterSessionKey: "gie-phase1-sadb-runtime",
      scopeKind: "session",
      parentFlowId: flowId,
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      task: "Run SADB decomposition",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    const completed = await runTaskHandler("tasks.completeTaskInFlow", {
      lookup: flowId,
      runId: "gie-phase1-sadb-child-run",
      runtime: "cli",
      status: "succeeded",
      terminalSummary: "SADB completed",
    });

    expect(completed.calls[0]?.[0]).toBe(false);
    expect(completed.calls[0]?.[2]?.message).toContain("child_task_backing_session_missing");
  });

  it("blocks production child success without continuation launch proof", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-continuation-required.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);
    const task = createTaskRecord({
      runtime: "cli",
      ownerKey: "gie-phase1-sadb-runtime",
      requesterSessionKey: "gie-phase1-sadb-runtime",
      scopeKind: "session",
      childSessionKey: "agent:sadb:phase1-child",
      parentFlowId: flowId,
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      task: "Run SADB decomposition",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    const completed = await runTaskHandler("tasks.completeTaskInFlow", {
      lookup: flowId,
      runId: "gie-phase1-sadb-child-run",
      runtime: "cli",
      status: "succeeded",
      terminalSummary: "SADB completed",
    });

    expect(completed.calls[0]?.[0]).toBe(false);
    expect(completed.calls[0]?.[2]?.message).toContain(
      "child_task_completion_requires_continuation_proof",
    );
    expect(getTaskFlowById(flowId)?.status).toBe("running");
    expect(getTaskById(task.taskId)?.status).toBe("running");
  });

  it("records next executable launch proof when completing a production child", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-continuation-launched.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);
    createTaskRecord({
      runtime: "cli",
      ownerKey: "gie-phase1-sadb-runtime",
      requesterSessionKey: "gie-phase1-sadb-runtime",
      scopeKind: "session",
      childSessionKey: "agent:sadb:phase1-child",
      parentFlowId: flowId,
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      task: "Run SADB decomposition",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    const completed = await runTaskHandler("tasks.completeTaskInFlow", {
      lookup: flowId,
      runId: "gie-phase1-sadb-child-run",
      runtime: "cli",
      status: "succeeded",
      terminalSummary: "SADB completed",
      nextExecutableLaunch: {
        detail: "Launch Phase 1 Security safety audit",
        currentStep: "phase1_security_safety_audit_running",
      },
    });

    expect(completed.calls[0]?.[0]).toBe(true);
    expect(completed.payload?.task?.status).toBe("completed");
    expect(completed.payload?.flow?.currentStep).toBe("phase1_security_safety_audit_running");
    const continuation = getTaskFlowProductionContinuation(getTaskFlowById(flowId)!);
    expect(continuation?.continuationRequiredAfterLocalSuccess).toBe(true);
    expect(continuation?.nextExecutableUnitLaunched).toBe(true);
  });

  it("runs a lawful SADB child task and emits executor identity proof", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-child-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);

    const child = await runTaskHandler("tasks.runTaskInFlow", {
      lookup: flowId,
      runtime: "cli",
      sourceId: "/tmp/sadb-packet.md",
      workPacketRef: "/tmp/sadb-packet.md",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
      handoffRef: "handoff:sadb",
      handoffAcceptedBy: "sadb_decomposition_review",
      childSessionKey: "agent:sadb:phase1-child",
      task: "Run SADB decomposition",
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      status: "running",
    });

    expect(child.calls[0]?.[0]).toBe(true);
    expect(child.payload?.task).toMatchObject({
      runtime: "cli",
      status: "running",
      runId: "gie-phase1-sadb-child-run",
      flowId,
    });
    expect(child.payload?.executorIdentityProof).toMatchObject({
      kind: "production_taskflow_child_execution_proof",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      workPacketRef: "/tmp/sadb-packet.md",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      handoffRef: "handoff:sadb",
      handoffAcceptedBy: "sadb_decomposition_review",
      parentFlowId: flowId,
      childSessionKey: "agent:sadb:phase1-child",
      deliveryStatus: "pending",
    });
    expect(child.payload?.executorIdentityProof?.childTaskId).toBe(child.payload?.task?.taskId);
  });

  it("allows a scoped explicit operator override for a production flow", async () => {
    const authorityPath = await writeTestBuildPlan("override-plan.md");

    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-override-test",
      controllerId: "sadb-runtime",
      goal: "Override scoped work",
      sliceId: "gie-override-test",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "test plan",
      buildItem: "Phase 4 - Contradiction Resolver",
      requiredOwnerLane: "Governance/Authority",
      attemptedOwnerLane: "SADB",
      attemptedExecutor: "sadb",
      executorRole: "runtime_implementation",
      lawfulRouteRequired: "dispatch to Governance/Authority",
      operatorOverride: {
        explicitOperatorApproval: true,
        targetWorkItem: "Phase 4 - Contradiction Resolver",
        normalRequiredOwnerLane: "Governance/Authority",
        approvedAlternateExecutor: "sadb",
        reason: "bounded approved implementation support",
        scope: "this test slice only",
        oneTimeUse: true,
      },
    });

    expect(started.calls[0]?.[0]).toBe(true);
    expect(started.payload?.flow?.stateJson).toMatchObject({
      buildItem: "Phase 4 - Contradiction Resolver",
      requiredOwnerLane: "Governance/Authority",
      attemptedOwnerLane: "SADB",
      attemptedExecutor: "sadb",
      ownerLaneGuard: {
        operatorOverrideExists: true,
      },
    });
  });
});
