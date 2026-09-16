import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLEANUP_CREW_MISSION_ABORT_CONTINUATION_CLASSES,
  createCleanupCrewMissionAbortExhaustionReceipt,
  validateCleanupCrewMissionAbortExhaustionReceipt,
} from "../continuity/continuity-gate-v2.js";
import { handleBuildIssueAction } from "./build-issue-controller.js";
import {
  recordProductionExecutorAssignment,
  type ProductionExecutorCapability,
  type ProductionExecutorRole,
} from "./production-executor-assignment.js";
import { createTaskRecord, resetTaskRegistryForTests } from "./runtime-internal.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  resetTaskFlowRegistryForTests,
} from "./task-flow-runtime-internal.js";

let stateDir: string;
let flow: TaskFlowRecord;
let originalStateDir: string | undefined;
const ownerKey = "agent:owner:main";
const dispatch = vi.fn<Parameters<typeof handleBuildIssueAction>[0]["dispatch"]>();
const waitForRun = vi.fn<Parameters<typeof handleBuildIssueAction>[0]["waitForRun"]>();

beforeEach(async () => {
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "build-issue-controller-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  const plan = path.join(stateDir, "plan.md");
  await fs.writeFile(plan, "# Repair plan\n");
  const created = createManagedTaskFlow({
    ownerKey,
    controllerId: "build-owner",
    goal: "Finish the authorized repair",
    status: "running",
    notifyPolicy: "silent",
    continuation: { activeProductionRun: true, parentRunOpen: true },
    stateJson: {
      kind: "production_taskflow_slice",
      authorityPath: plan,
      buildItem: "repair",
      requiredOwnerLane: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
    },
  });
  if (!created) {
    throw new Error("flow setup failed");
  }
  flow = created;
  dispatch.mockReset().mockResolvedValue({
    ok: true,
    result: { details: { status: "accepted", runId: "dispatch-run" } },
  });
  waitForRun.mockReset().mockResolvedValue({ status: "timeout" });
});

afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});

function makeExecutor(label: string, overrides: { ownerKey?: string; assigned?: boolean } = {}) {
  const task = createTaskRecord({
    runtime: "subagent",
    ownerKey: overrides.ownerKey ?? ownerKey,
    requesterSessionKey: overrides.ownerKey ?? ownerKey,
    ...(overrides.ownerKey ? {} : { parentFlowId: flow.flowId }),
    scopeKind: "session",
    childSessionKey: `agent:worker:subagent:${label}`,
    runId: `original-run-${label}`,
    task: "Repair assigned work",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "silent",
  });
  if (!task?.runId) {
    throw new Error("task setup failed");
  }
  const candidate: {
    taskId: string;
    expectedRunId: string;
    ownerLane: string;
    role: ProductionExecutorRole;
    permitted: ProductionExecutorCapability[];
    prohibited: ProductionExecutorCapability[];
    evidenceRefs: string[];
  } = {
    taskId: task.taskId,
    expectedRunId: task.runId,
    ownerLane: "Coding Agent",
    role: "Coding Agent",
    permitted: ["repo_write", "production_dispatch"],
    prohibited: [],
    evidenceRefs: [`capability:${label}`],
  };
  if (!overrides.ownerKey && overrides.assigned !== false) {
    const assignment = recordProductionExecutorAssignment({
      flowId: flow.flowId,
      taskId: task.taskId,
      expectedRunId: task.runId,
      executorId: `worker-${label}`,
      ownerLane: candidate.ownerLane,
      role: candidate.role,
      permitted: candidate.permitted,
      prohibited: candidate.prohibited,
      evidenceRefs: candidate.evidenceRefs,
    });
    if (!assignment.applied) {
      throw new Error(`assignment setup failed: ${assignment.reason}`);
    }
  }
  return candidate;
}

function triage() {
  return {
    kind: "triage",
    flowId: flow.flowId,
    ownerKey,
    actionId: "action-1",
    occurrenceId: "occurrence-1",
    issueId: "issue-1",
    summary: "Unrelated parser failure",
    evidenceRefs: ["test-log:parser-failure"],
    impact: "non_blocking",
    resume: { executor: makeExecutor("resume"), message: "Continue the authorized repair." },
  };
}

function recovery() {
  return {
    kind: "recover_execution_surface",
    flowId: flow.flowId,
    ownerKey,
    actionId: "recovery-1",
    occurrenceId: "failure-1",
    issueId: "issue-surface",
    summary: "Primary executor cannot reach the execution surface",
    evidenceRefs: ["surface:observed-failure"],
    primaryFailure: {
      taskId: makeExecutor("primary").taskId,
      kind: "execution_unavailable",
      evidenceRefs: ["primary:failure"],
    },
    requiredCapability: "repo_write",
    executors: [makeExecutor("alternate")],
    message: "Repair the assigned file and report the actual result.",
  };
}

function run(input: unknown) {
  return handleBuildIssueAction({ input, dispatch, waitForRun });
}

describe("production build issue controller", () => {
  it("persists and reads the issue before dispatch, then reconciles the exact accepted run without resending", async () => {
    const input = triage();
    dispatch.mockImplementationOnce(async () => {
      // Reload the SQLite owner to prove the issue survives process-memory loss.
      resetTaskFlowRegistryForTests({ persist: false });
      expect(getTaskFlowById(flow.flowId)?.stateJson).toMatchObject({
        buildIssueActions: [
          {
            input: { issueId: "issue-1" },
            execution: { state: "dispatch_pending" },
          },
        ],
      });
      return { ok: true, result: { details: { status: "accepted", runId: "dispatch-run" } } };
    });
    const accepted = await run(input);
    expect(accepted.decision).toBe("log_deferred_issue_and_resume");
    expect(accepted.execution).toMatchObject({ state: "awaiting_result", runId: "dispatch-run" });
    waitForRun.mockResolvedValueOnce({ status: "ok", startedAt: 2, endedAt: 3 });
    expect((await run(input)).execution).toMatchObject({
      state: "terminal_result_observed",
      runId: "dispatch-run",
    });
    expect(waitForRun).toHaveBeenCalledWith("dispatch-run");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(getTaskFlowProductionContinuation(getTaskFlowById(flow.flowId)!)).toMatchObject({
      parentRunOpen: true,
    });
  });

  it("records a duplicate occurrence while rejecting conflicting idempotency identities", async () => {
    const input = triage();
    await run(input);
    const duplicate = await run({ ...input, actionId: "action-2", occurrenceId: "occurrence-2" });
    expect(duplicate).toMatchObject({
      decision: "record_duplicate_and_resume",
      duplicateOfFlowId: flow.flowId,
    });
    await expect(run({ ...input, summary: "Different side effect" })).rejects.toThrow(
      "idempotency_conflict",
    );
    await expect(run({ ...input, actionId: "new-id-for-same-occurrence" })).rejects.toThrow(
      "idempotency_conflict",
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(["ok", "error"] as const)(
    "reconciles a sessions_send error with a known run to its terminal %s outcome without replay",
    async (status) => {
      const input = triage();
      dispatch.mockResolvedValueOnce({
        ok: true,
        result: { details: { status: "error", runId: "uncertain-run", error: "RPC disconnected" } },
      });
      expect((await run(input)).execution).toMatchObject({
        state: "awaiting_result",
        runId: "uncertain-run",
      });
      resetTaskFlowRegistryForTests({ persist: false });
      expect((await run(input)).execution.state).toBe("awaiting_result");
      waitForRun.mockResolvedValueOnce({ status, startedAt: 2, endedAt: 3 });
      expect((await run(input)).execution).toMatchObject({
        state: "terminal_result_observed",
        runId: "uncertain-run",
        resultStatus: status,
      });
      expect(waitForRun).toHaveBeenCalledWith("uncertain-run");
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(getTaskFlowById(flow.flowId)?.status).toBe("running");
    },
  );

  it("keeps a polling timeout pending, then records a terminal timeout without replay", async () => {
    const input = triage();
    expect((await run(input)).execution).toMatchObject({
      state: "awaiting_result",
      runId: "dispatch-run",
    });
    resetTaskFlowRegistryForTests({ persist: false });

    waitForRun.mockResolvedValueOnce({ status: "timeout", startedAt: 2 });
    expect((await run(input)).execution).toMatchObject({
      state: "awaiting_result",
      runId: "dispatch-run",
    });

    waitForRun.mockResolvedValueOnce({
      status: "timeout",
      startedAt: 2,
      endedAt: 3,
      stopReason: "hard_timeout",
    });
    expect((await run(input)).execution).toMatchObject({
      state: "terminal_result_observed",
      runId: "dispatch-run",
      resultStatus: "timeout",
    });
    expect((await run(input)).execution).toMatchObject({
      state: "terminal_result_observed",
      runId: "dispatch-run",
      resultStatus: "timeout",
    });
    expect(waitForRun).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a proven pre-dispatch rejection terminal without polling its synthetic run ID", async () => {
    const input = triage();
    dispatch.mockResolvedValueOnce({
      ok: true,
      result: {
        details: {
          status: "error",
          dispatchState: "not_dispatched",
          runId: "response-correlation-only",
          error: "sessions_send cannot target a thread session",
        },
      },
    });
    const receipt = await run(input);
    expect(receipt.execution).toEqual({
      state: "dispatch_failed",
      reason: "sessions_send cannot target a thread session",
    });
    resetTaskFlowRegistryForTests({ persist: false });
    expect((await run(input)).execution).toEqual(receipt.execution);
    expect(waitForRun).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["current_blocker", "unsafe", "dishonest", "impossible", "operator_decision"])(
    "records %s without dispatching dependent work",
    async (impact) => {
      const input = triage();
      const receipt = await run({ ...input, impact });
      expect(receipt.decision).toBe(
        impact === "operator_decision"
          ? "stop_for_operator_decision"
          : "record_current_blocker_and_stop",
      );
      expect(receipt.execution.state).toBe("not_dispatched");
      expect(dispatch).not.toHaveBeenCalled();
      expect(getTaskFlowById(flow.flowId)?.status).toBe("blocked");
    },
  );

  it("does not replay an interrupted dispatch after restart", async () => {
    const input = triage();
    dispatch.mockRejectedValueOnce(new Error("lost connection after send"));
    expect((await run(input)).execution.state).toBe("dispatch_unknown");
    resetTaskFlowRegistryForTests({ persist: false });
    expect((await run(input)).execution.state).toBe("dispatch_unknown");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("routes a failed primary surface to a permitted owner-bound alternate and observes its actual result", async () => {
    const input = recovery();
    dispatch.mockResolvedValueOnce({
      ok: true,
      result: { details: { status: "ok", runId: "alternate-result", reply: "Patch verified." } },
    });
    const receipt = await run(input);
    expect(receipt).toMatchObject({
      decision: "route_to_available_executor",
      execution: {
        state: "terminal_result_observed",
        taskId: input.executors[0].taskId,
        runId: "alternate-result",
        reply: "Patch verified.",
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:worker:subagent:alternate", ownerKey }),
    );
  });

  it.each([
    "stale",
    "foreign_owner",
    "unassigned",
    "forged_lane",
    "forged_role",
    "forged_permitted",
    "forged_prohibited",
  ])("does not dispatch a %s executor assertion", async (mode) => {
    const input = recovery();
    if (mode === "stale") {
      input.executors[0].expectedRunId = "old-run";
    }
    if (mode === "foreign_owner") {
      input.executors = [makeExecutor("foreign", { ownerKey: "agent:other:main" })];
    }
    if (mode === "unassigned") {
      input.executors = [makeExecutor("unassigned", { assigned: false })];
    }
    if (mode === "forged_lane") {
      input.executors[0].ownerLane = "Will";
    }
    if (mode === "forged_role") {
      input.executors[0].role = "Will";
    }
    if (mode === "forged_permitted") {
      input.executors[0].permitted = ["repo_write", "production_dispatch", "grant_review"];
    }
    if (mode === "forged_prohibited") {
      input.executors[0].prohibited = ["repo_write"];
    }
    const receipt = await run(input);
    expect(receipt.execution.state).toBe("not_dispatched");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves policy denial even when a capable alternate exists", async () => {
    const input = recovery();
    const receipt = await run({
      ...input,
      primaryFailure: { ...input.primaryFailure, kind: "policy_denied" },
    });
    expect(receipt.decision).toBe("policy_denial_requires_authorized_resolution");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retains a gateway policy rejection without treating it as executed", async () => {
    dispatch.mockResolvedValueOnce({ ok: false, status: 403, error: { message: "policy denial" } });
    const receipt = await run(triage());
    expect(receipt.execution).toEqual({ state: "dispatch_failed", reason: "policy denial" });
  });

  it("requires all exhaustion classes and exact mission identity while leaving the mission open", async () => {
    const input = { ...recovery(), executors: [] };
    const exhaustion = createCleanupCrewMissionAbortExhaustionReceipt({
      missionId: flow.flowId,
      entries: CLEANUP_CREW_MISSION_ABORT_CONTINUATION_CLASSES.map((kind) => ({
        class: kind,
        status: "unavailable",
        evidence: `evaluated:${kind}`,
      })),
    });
    await expect(
      run({ ...input, exhaustion: { ...exhaustion, entries: [null] } }),
    ).rejects.toThrow();
    expect(
      validateCleanupCrewMissionAbortExhaustionReceipt({ ...exhaustion, entries: [null] }),
    ).toMatchObject({ ok: false });
    expect(
      validateCleanupCrewMissionAbortExhaustionReceipt({
        ...exhaustion,
        receipt_id: 7,
        created_at: {},
        mission_id: false,
        entries: [{ class: "repair", status: "unavailable", evidence: 42 }],
      }),
    ).toMatchObject({ ok: false });
    await expect(
      run({ ...input, exhaustion: { ...exhaustion, mission_id: "other" } }),
    ).rejects.toThrow("mission_id_mismatch");
    const receipt = await run({ ...input, exhaustion });
    expect(receipt.decision).toBe("mission_bound_exhaustion_recorded");
    expect(receipt.execution.state).toBe("not_dispatched");
    expect(dispatch).not.toHaveBeenCalled();
    expect(getTaskFlowById(flow.flowId)?.endedAt).toBeUndefined();
  });
});
