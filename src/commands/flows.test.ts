import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createRunningTaskRun as createRunningTaskRunOrNull } from "../tasks/task-executor.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  getTaskFlowProductionContinuation,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  createTaskRecord,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  flowsBlockedRowsCommand,
  flowsCancelCommand,
  flowsLawfulStopCommand,
  flowsListCommand,
  flowsResumeProductionCommand,
  flowsShowCommand,
  flowsStartProductionCommand,
  flowsSupersedeForegroundCleanupCrewExecutorCommand,
} from "./flows.js";

const runRuntimeAssetGuardPreflight = vi.hoisted(() =>
  vi.fn(() => ({
    ok: true,
    status: 0,
    operation: "production preflight",
    scriptPath: "/repo/scripts/runtime-asset-guard.mjs",
    message: "runtime asset guard passed",
    stdout: "{}",
    stderr: "",
  })),
);

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../infra/runtime-asset-guard-preflight.js", () => ({
  runRuntimeAssetGuardPreflight,
}));

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function jsonRoundTrip<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function createRunningTaskRun(
  params: Parameters<typeof createRunningTaskRunOrNull>[0],
): TaskRecord {
  const task = createRunningTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected running task creation to succeed");
  }
  return task;
}

type TestRuntime = RuntimeEnv & {
  writeStdout: ReturnType<typeof vi.fn>;
  writeJson: ReturnType<typeof vi.fn>;
};

function createRuntime(): TestRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

async function withTaskFlowCommandStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-flows-command-",
    },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run(state.stateDir);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("flows commands", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    runRuntimeAssetGuardPreflight.mockReset();
    runRuntimeAssetGuardPreflight.mockReturnValue({
      ok: true,
      status: 0,
      operation: "production preflight",
      scriptPath: "/repo/scripts/runtime-asset-guard.mjs",
      message: "runtime asset guard passed",
      stdout: "{}",
      stderr: "",
    });
  });

  it("lists TaskFlows as JSON with linked tasks and summaries", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect a PR cluster",
        status: "blocked",
        blockedSummary: "Waiting on child task",
        createdAt: 100,
        updatedAt: 100,
      });

      const childTask = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-child-1",
        label: "Inspect PR 123",
        task: "Inspect PR 123",
        startedAt: 100,
        lastEventAt: 100,
      });

      const runtime = createRuntime();
      await flowsListCommand({ json: true, status: "blocked" }, runtime);

      expect(runtime.log).not.toHaveBeenCalled();
      const payload = jsonRoundTrip(vi.mocked(runtime.writeJson).mock.calls[0]?.[0]);

      expect(payload).toStrictEqual({
        count: 1,
        status: "blocked",
        flows: [
          {
            ...jsonRoundTrip(flow),
            tasks: [jsonRoundTrip(childTask)],
            taskSummary: {
              total: 1,
              active: 1,
              terminal: 0,
              failures: 0,
              byStatus: {
                queued: 0,
                running: 1,
                succeeded: 0,
                failed: 0,
                timed_out: 0,
                cancelled: 0,
                lost: 0,
              },
              byRuntime: {
                subagent: 0,
                acp: 1,
                cli: 0,
                cron: 0,
              },
            },
          },
        ],
      });
    });
  });

  it("classifies blocked TaskFlow rows without mutating state", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const gieFlow = createManagedTaskFlow({
        ownerKey: "gie-phase1-sadb-runtime",
        controllerId: "will-orchestrator/gie",
        goal: "Dispatch GIE Phase 1 SADB runtime implementation",
        status: "blocked",
        currentStep: "blocked_sadb_child_lost_backing_session_missing",
        blockedSummary: "SADB child is lost because backing session is missing.",
        createdAt: 100,
        updatedAt: 100,
      });
      const historicalFlow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "tests/flows-command",
        goal: "Grant review slice",
        status: "blocked",
        blockedSummary: "CHILD_RESULT_REJECTED :: Grant closeout failed (rejected_proof_missing).",
        createdAt: 200,
        updatedAt: 200,
      });
      const staleFlow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "tests/flows-command",
        goal: "Foreground Cleanup Crew production mission",
        status: "blocked",
        currentStep: "foreground_cleanup_crew_lost_child_reconciled",
        blockedSummary: "lost child reconciled",
        createdAt: 300,
        updatedAt: 300,
      });

      const runtime = createRuntime();
      await flowsBlockedRowsCommand({ json: true }, runtime);

      expect(runtime.log).not.toHaveBeenCalled();
      const payload = jsonRoundTrip(vi.mocked(runtime.writeJson).mock.calls[0]?.[0]);

      expect(payload).toMatchObject({
        count: 3,
        byClassification: {
          current_lawful_blocker: 0,
          historical_closeout_proof_debt: 1,
          superseded: 1,
          requires_new_work_order: 1,
          unsupported_manual_review: 0,
        },
      });
      expect(payload.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            flowId: gieFlow.flowId,
            classification: "requires_new_work_order",
          }),
          expect.objectContaining({
            flowId: historicalFlow.flowId,
            classification: "historical_closeout_proof_debt",
          }),
          expect.objectContaining({
            flowId: staleFlow.flowId,
            classification: "superseded",
          }),
        ]),
      );
    });
  });

  it("shows one TaskFlow as JSON through the runtime JSON writer", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect a single flow",
        status: "running",
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: true }, runtime);

      expect(runtime.log).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.writeJson).mock.calls[0]?.[0]).toMatchObject({
        ...jsonRoundTrip(flow),
        tasks: [],
        taskSummary: {
          total: 0,
          active: 0,
          terminal: 0,
          failures: 0,
        },
      });
    });
  });

  it("shows one TaskFlow with linked task details in text mode", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Investigate a flaky queue",
        status: "blocked",
        currentStep: "spawn_child",
        blockedSummary: "Waiting on child task output",
        createdAt: 100,
        updatedAt: 100,
      });

      const task = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-child-2",
        label: "Collect logs",
        task: "Collect logs",
        startedAt: 100,
        lastEventAt: 100,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: false }, runtime);

      expect(vi.mocked(runtime.log).mock.calls.map(([line]) => String(line))).toEqual([
        "TaskFlow:",
        `flowId: ${flow.flowId}`,
        "status: blocked",
        "goal: Investigate a flaky queue",
        "currentStep: spawn_child",
        "owner: agent:main:main",
        "notify: done_only",
        "state: Waiting on child task output",
        "createdAt: 1970-01-01T00:00:00.100Z",
        "updatedAt: 1970-01-01T00:00:00.100Z",
        "endedAt: n/a",
        "tasks: 1 total · 1 active · 0 issues",
        "Linked tasks:",
        `- ${task.taskId} running run-child-2 Collect logs`,
      ]);
    });
  });

  it("shows TaskFlows with Date-invalid timestamps without crashing", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect malformed flow timestamp",
        status: "running",
        createdAt: 100,
        updatedAt: 8_700_000_000_000_000,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: false }, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      expect(lines).toContain(`flowId: ${flow.flowId}`);
      expect(lines).toContain("createdAt: 1970-01-01T00:00:00.100Z");
      expect(lines).toContain("updatedAt: n/a");
    });
  });

  it("sanitizes TaskFlow text output before printing to the terminal", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const unsafeOwnerKey = "agent:main:\u001b[31mowner";
      const flow = createManagedTaskFlow({
        ownerKey: unsafeOwnerKey,
        controllerId: "tests/flows-command",
        goal: "Investigate\nqueue\tstate",
        status: "blocked",
        currentStep: "spawn\u001b[2K_child",
        blockedSummary: "Waiting\u001b[31m on child\nforged: yes",
        createdAt: 100,
        updatedAt: 100,
      });

      const task = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: unsafeOwnerKey,
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-child-3",
        label: "Collect\nlogs\u001b[2K",
        task: "Collect logs",
        startedAt: 100,
        lastEventAt: 100,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: false }, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      expect(lines).toEqual([
        "TaskFlow:",
        `flowId: ${flow.flowId}`,
        "status: blocked",
        "goal: Investigate\\nqueue\\tstate",
        "currentStep: spawn_child",
        "owner: agent:main:owner",
        "notify: done_only",
        "state: Waiting on child\\nforged: yes",
        "createdAt: 1970-01-01T00:00:00.100Z",
        "updatedAt: 1970-01-01T00:00:00.100Z",
        "endedAt: n/a",
        "tasks: 1 total · 1 active · 0 issues",
        "Linked tasks:",
        `- ${task.taskId} running run-child-3 Collect\\nlogs`,
      ]);
      expect(lines.join("\n")).not.toContain("\u001b[");
    });
  });

  it("cancels a managed TaskFlow with no active children", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Stop detached work",
        status: "running",
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsCancelCommand({ lookup: flow.flowId }, runtime);

      expect(vi.mocked(runtime.error)).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.exit)).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.log).mock.calls.map(([line]) => String(line))).toEqual([
        `Cancelled ${flow.flowId} (managed) with status cancelled.`,
      ]);
    });
  });

  it("starts a governed production TaskFlow with authority metadata and active continuation", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const runtime = createRuntime();
      await flowsStartProductionCommand(
        {
          ownerKey: "agent:orchestrator:main",
          controllerId: "gie/authority-mirror-decision",
          goal: "GIE authority mirror decision",
          sliceId: "gie-authority-mirror-decision-2026-06-22T0236Z",
          sliceOwner: "Will / Top-Level Governance",
          authorityPath: `${process.cwd()}/AGENTS.md`,
          authorityBasis: "controlling build-state interpretation",
          buildItem: "GIE authority mirror decision",
          requiredOwnerLane: "Will / Top-Level Governance",
          attemptedOwnerLane: "Will / Top-Level Governance",
          attemptedExecutor: "will-orchestrator",
          executorRole: "governance_decision",
          lawfulRouteRequired: "Will / Top-Level Governance decision",
          currentStep: "authority_decision",
          blocker: ["department_registry_mirror_alignment", "blocking_authority_state"],
          json: true,
        },
        runtime,
      );

      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      const payload = vi.mocked(runtime.writeJson).mock.calls[0]?.[0] as { flow: TaskFlowRecord };
      expect(payload.flow).toMatchObject({
        syncMode: "managed",
        ownerKey: "agent:orchestrator:main",
        controllerId: "gie/authority-mirror-decision",
        status: "running",
        goal: "GIE authority mirror decision",
        currentStep: "authority_decision",
      });
      expect(payload.flow.stateJson).toMatchObject({
        kind: "production_taskflow_slice",
        sliceId: "gie-authority-mirror-decision-2026-06-22T0236Z",
        sliceOwner: "Will / Top-Level Governance",
        buildItem: "GIE authority mirror decision",
        requiredOwnerLane: "Will / Top-Level Governance",
        attemptedOwnerLane: "Will / Top-Level Governance",
        attemptedExecutor: "will-orchestrator",
        executorRole: "governance_decision",
        productionContinuation: {
          activeProductionRun: true,
          currentUnitStatus: "started",
        },
      });
      expect(getTaskFlowProductionContinuation(payload.flow)?.activeProductionRun).toBe(true);
    });
  });

  it("rejects production TaskFlow start without required authority fields", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const runtime = createRuntime();
      await flowsStartProductionCommand(
        {
          ownerKey: "agent:orchestrator:main",
          controllerId: "gie/authority-mirror-decision",
          goal: "GIE authority mirror decision",
          sliceId: "gie-authority-mirror-decision-2026-06-22T0236Z",
          sliceOwner: "Will / Top-Level Governance",
          authorityBasis: "controlling build-state interpretation",
        },
        runtime,
      );

      expect(runtime.error).toHaveBeenCalledWith("--authority-path is required.");
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.writeJson).not.toHaveBeenCalled();
    });
  });

  it("resumes only managed active-production TaskFlows", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "gie/authority-mirror-decision",
        goal: "GIE authority mirror decision",
        status: "blocked",
        currentStep: "blocked",
        continuation: { activeProductionRun: true },
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsResumeProductionCommand(
        { lookup: flow.flowId, currentStep: "authority_decision", json: true },
        runtime,
      );

      expect(runtime.error).not.toHaveBeenCalled();
      const payload = vi.mocked(runtime.writeJson).mock.calls[0]?.[0] as { flow: TaskFlowRecord };
      expect(payload.flow.status).toBe("running");
      expect(payload.flow.currentStep).toBe("authority_decision");
      expect(getTaskFlowProductionContinuation(payload.flow)?.activeProductionRun).toBe(true);
    });
  });

  it("blocks production TaskFlow resume when runtime guard fails", async () => {
    await withTaskFlowCommandStateDir(async () => {
      runRuntimeAssetGuardPreflight.mockReturnValue({
        ok: false,
        status: 1,
        operation: "production preflight",
        scriptPath: "/repo/scripts/runtime-asset-guard.mjs",
        message:
          "blocker=runtime_internal_import_missing; operation=production preflight importer=dist/index.js specifier=./missing.js missing=dist/missing.js",
        stdout: "{}",
        stderr: "",
      });
      const flow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "gie/authority-mirror-decision",
        goal: "GIE authority mirror decision",
        status: "blocked",
        currentStep: "blocked",
        continuation: { activeProductionRun: true },
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsResumeProductionCommand(
        { lookup: flow.flowId, currentStep: "authority_decision", json: true },
        runtime,
      );

      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Production resume blocked by runtime asset guard"),
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("runtime_internal_import_missing"),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.writeJson).not.toHaveBeenCalled();
    });
  });

  it("records lawful blocker stop so active-production watchdog no longer requires the flow", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "gie/authority-mirror-decision",
        goal: "GIE authority mirror decision",
        status: "running",
        currentStep: "authority_decision",
        continuation: { activeProductionRun: true },
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsLawfulStopCommand(
        {
          lookup: flow.flowId,
          reason: "blocker",
          detail: "department registry mirror authority decision remains blocked",
          currentStep: "authority_blocked",
          json: true,
        },
        runtime,
      );

      expect(runtime.error).not.toHaveBeenCalled();
      const payload = vi.mocked(runtime.writeJson).mock.calls[0]?.[0] as { flow: TaskFlowRecord };
      const continuation = getTaskFlowProductionContinuation(payload.flow);
      expect(payload.flow.status).toBe("blocked");
      expect(payload.flow.blockedSummary).toBe(
        "department registry mirror authority decision remains blocked",
      );
      expect(continuation).toMatchObject({
        activeProductionRun: true,
        currentUnitStatus: "blocked",
        blockerPresent: true,
        lawfulStopReason: "blocker",
        continuationRequiredAfterLocalSuccess: false,
      });
    });
  });

  it("supersedes foreground Cleanup Crew executor through the supported command", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:orchestrator:main",
        controllerId: "cleanup-crew/foreground-production",
        goal: "Foreground Cleanup Crew production mission",
        status: "blocked",
        currentStep: "governance_remediation_current_truth_reconciliation",
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
          currentUnitStatus: "blocked",
          blockerPresent: true,
          nextExecutableUnitLaunched: true,
          lawfulStopReason: "blocker",
        },
      });
      const lostTask = createTaskRecord({
        runtime: "cli",
        taskKind: "foreground_cleanup_crew_execution",
        sourceId: "cleanup-crew:foreground",
        requesterSessionKey: "agent:orchestrator:main",
        ownerKey: "agent:orchestrator:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        runId: "foreground-cleanup-crew:lost",
        label: "Lost foreground executor",
        task: "Lost foreground executor",
        status: "lost",
        deliveryStatus: "session_queued",
        notifyPolicy: "silent",
        startedAt: 100,
        lastEventAt: 200,
        endedAt: 200,
        childSessionKey: "agent:orchestrator:main",
        terminalSummary: "backing session missing",
      });
      const replacementTask = createTaskRecord({
        runtime: "subagent",
        taskKind: "foreground_cleanup_crew_execution",
        sourceId: "cleanup-crew:foreground:supersession",
        requesterSessionKey: "agent:orchestrator:main",
        ownerKey: "agent:orchestrator:main",
        scopeKind: "session",
        childSessionKey: "agent:orchestrator:subagent:replacement",
        runId: "foreground-cleanup-crew:replacement",
        label: "Replacement foreground executor",
        task: "Replacement foreground executor",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        startedAt: 300,
        lastEventAt: 300,
        progressSummary: "Replacement worker heartbeat confirmed",
      });
      expect(lostTask).not.toBeNull();
      expect(replacementTask).not.toBeNull();

      const runtime = createRuntime();
      await flowsSupersedeForegroundCleanupCrewExecutorCommand(
        {
          lookup: flow.flowId,
          lostTaskId: lostTask!.taskId,
          replacementTaskId: replacementTask!.taskId,
          ownerKey: "agent:orchestrator:main",
          sessionKey: "agent:orchestrator:main",
          currentStep: "active_no_worker_forensic_repair_and_executor_recovery",
          detail: "active_no_worker replacement executor",
          json: true,
        },
        runtime,
      );

      expect(runtime.error).not.toHaveBeenCalled();
      const payload = vi.mocked(runtime.writeJson).mock.calls[0]?.[0] as {
        result: { flow: TaskFlowRecord; task: TaskRecord; status: string };
      };
      expect(payload.result.status).toBe("superseded");
      expect(payload.result.flow.status).toBe("running");
      expect(payload.result.task.parentFlowId).toBe(flow.flowId);
      const continuation = getTaskFlowProductionContinuation(payload.result.flow);
      expect(continuation).toMatchObject({
        activeProductionRun: true,
        parentRunOpen: true,
        currentUnitStatus: "started",
        blockerPresent: false,
        nextExecutableUnitLaunched: true,
        continuationViolation: false,
      });
      expect(continuation?.lawfulStopReason).toBeUndefined();
    });
  });
});
