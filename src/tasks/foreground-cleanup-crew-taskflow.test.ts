import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listOwnerRequestIntakeRecords } from "../agents/owner-request-intake-ledger.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import { resolveProductionWatchdogLifecycleDecision } from "./active-production-watchdog-lifecycle.js";
import {
  ensureForegroundCleanupCrewTaskFlow,
  isForegroundCleanupCrewProductionMission,
  supersedeForegroundCleanupCrewExecutor,
} from "./foreground-cleanup-crew-taskflow.js";
import { linkTaskToFlowById, listTasksForFlowId } from "./runtime-internal.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  getTaskFlowActiveProductionContinuation,
  getTaskFlowProductionContinuation,
  createTaskFlowForTask,
  getTaskFlowById,
  listTaskFlowRecords,
  recordFlowLawfulStop,
  resetTaskFlowRegistryForTests,
} from "./task-flow-runtime-internal.js";
import { createTaskRecord, markTaskLostById, resetTaskRegistryForTests } from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

function createInMemoryTaskRegistryStore() {
  const tasks = new Map<string, TaskRecord>();
  const deliveryStates = new Map<string, TaskDeliveryState>();
  return {
    loadSnapshot: () => ({
      tasks: new Map(tasks),
      deliveryStates: new Map(deliveryStates),
    }),
    saveSnapshot: (snapshot: {
      tasks: Map<string, TaskRecord>;
      deliveryStates: Map<string, TaskDeliveryState>;
    }) => {
      tasks.clear();
      deliveryStates.clear();
      for (const [taskId, task] of snapshot.tasks.entries()) {
        tasks.set(taskId, task);
      }
      for (const [taskId, state] of snapshot.deliveryStates.entries()) {
        deliveryStates.set(taskId, state);
      }
    },
    upsertTaskWithDeliveryState: (params: {
      task: TaskRecord;
      deliveryState?: TaskDeliveryState;
    }) => {
      tasks.set(params.task.taskId, params.task);
      if (params.deliveryState) {
        deliveryStates.set(params.deliveryState.taskId, params.deliveryState);
      } else {
        deliveryStates.delete(params.task.taskId);
      }
    },
    upsertTask: (task: TaskRecord) => {
      tasks.set(task.taskId, task);
    },
    deleteTaskWithDeliveryState: (taskId: string) => {
      tasks.delete(taskId);
      deliveryStates.delete(taskId);
    },
    deleteTask: (taskId: string) => {
      tasks.delete(taskId);
      deliveryStates.delete(taskId);
    },
    upsertDeliveryState: (state: TaskDeliveryState) => {
      deliveryStates.set(state.taskId, state);
    },
    deleteDeliveryState: (taskId: string) => {
      deliveryStates.delete(taskId);
    },
    close: () => {},
  };
}

function createInMemoryTaskFlowRegistryStore() {
  const flows = new Map<string, TaskFlowRecord>();
  return {
    loadSnapshot: () => ({
      flows: new Map(flows),
    }),
    saveSnapshot: (snapshot: { flows: Map<string, TaskFlowRecord> }) => {
      flows.clear();
      for (const [flowId, flow] of snapshot.flows.entries()) {
        flows.set(flowId, flow);
      }
    },
    upsertFlow: (flow: TaskFlowRecord) => {
      flows.set(flow.flowId, flow);
    },
    deleteFlow: (flowId: string) => {
      flows.delete(flowId);
    },
    close: () => {},
  };
}

function createLostAndReplacementTasks(flowId: string, suffix: string) {
  const lost = createTaskRecord({
    runtime: "cli",
    taskKind: "foreground_cleanup_crew_execution",
    sourceId: "cleanup-crew:foreground",
    requesterSessionKey: "webchat:direct:mark",
    ownerKey: "webchat:direct:mark",
    scopeKind: "session",
    parentFlowId: flowId,
    childSessionKey: "webchat:direct:mark",
    runId: `foreground-cleanup-crew:lost:${suffix}`,
    label: "Lost foreground executor",
    task: "Lost foreground executor",
    status: "lost",
    deliveryStatus: "session_queued",
    notifyPolicy: "silent",
    startedAt: 1000,
    lastEventAt: 1100,
    endedAt: 1100,
    terminalSummary: "backing session missing",
  });
  const replacement = createTaskRecord({
    runtime: "subagent",
    taskKind: "foreground_cleanup_crew_execution",
    sourceId: "cleanup-crew:foreground:supersession",
    requesterSessionKey: "webchat:direct:mark",
    ownerKey: "webchat:direct:mark",
    scopeKind: "session",
    childSessionKey: `webchat:direct:replacement:${suffix}`,
    runId: `foreground-cleanup-crew:replacement:${suffix}`,
    label: "Replacement foreground executor",
    task: "Replacement foreground executor",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    startedAt: 1200,
    lastEventAt: 1200,
    progressSummary: "Replacement worker heartbeat confirmed",
  });
  if (!lost || !replacement) {
    throw new Error("expected task setup to succeed");
  }
  return { lost, replacement };
}

function configureInMemoryRegistries() {
  configureTaskRegistryRuntime({
    store: createInMemoryTaskRegistryStore(),
  });
  configureTaskFlowRegistryRuntime({
    store: createInMemoryTaskFlowRegistryStore(),
  });
}

describe("foreground Cleanup Crew TaskFlow registration", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    configureInMemoryRegistries();
  });

  it("detects production Cleanup Crew missions but skips report-only turns", () => {
    expect(
      isForegroundCleanupCrewProductionMission(
        "Cleanup Crew runtime repair build. Execute packets in order.",
      ),
    ).toBe(true);
    expect(
      isForegroundCleanupCrewProductionMission("Cleanup Crew report only. Do not continue."),
    ).toBe(false);
  });

  it("creates an active-production TaskFlow and foreground execution task", () => {
    const intakeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-foreground-intake-"));
    const result = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew runtime repair build. Execute Packet C.",
      packetId: "packet-6",
      stageId: "active-work-tracking",
      activeValidationCommand:
        "node scripts/run-vitest.mjs run src/tasks/foreground-cleanup-crew-taskflow.test.ts",
      intakeStateDir,
      now: 1000,
    });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") {
      throw new Error("expected registered result");
    }
    const continuation = getTaskFlowProductionContinuation(result.flow);
    expect(continuation).toMatchObject({
      activeProductionRun: true,
      parentRunOpen: true,
      currentUnitStatus: "started",
      lawfulWholeRunCompletion: false,
    });
    expect(result.flow.currentStep).toBe("foreground_cleanup_crew_registered");
    expect(result.flow.stateJson).toMatchObject({
      kind: "cleanup_crew_foreground_production",
      ownerLane: "Will",
      foregroundExecutionRepresented: true,
      currentPacketId: "packet-6",
      currentStageId: "active-work-tracking",
      activeValidationCommand:
        "node scripts/run-vitest.mjs run src/tasks/foreground-cleanup-crew-taskflow.test.ts",
    });
    const tasks = listTasksForFlowId(result.flow.flowId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskKind: "foreground_cleanup_crew_execution",
      ownerKey: "webchat:direct:mark",
      requesterSessionKey: "webchat:direct:mark",
      parentFlowId: result.flow.flowId,
      status: "running",
      progressSummary:
        "Foreground Cleanup Crew mission is active in this source conversation. packet=packet-6 stage=active-work-tracking validation=node scripts/run-vitest.mjs run src/tasks/foreground-cleanup-crew-taskflow.test.ts",
    });
    expect(resolveProductionWatchdogLifecycleDecision()).toMatchObject({
      shouldRun: true,
      activeProductionFlowIds: [result.flow.flowId],
      openTaskCount: 1,
    });
    expect(listOwnerRequestIntakeRecords({ stateDir: intakeStateDir })).toMatchObject([
      {
        status: "mission_registered",
        governed: true,
        classification: "cleanup_crew_production",
        expectedDurability: "taskflow_required",
        taskFlowId: result.flow.flowId,
        taskId: result.taskId,
        lastExecutableAction: "registered foreground Cleanup Crew TaskFlow",
        nextExecutableAction: "execute Cleanup Crew production mission",
      },
    ]);
    fs.rmSync(intakeStateDir, { recursive: true, force: true });
  });

  it("creates a fresh foreground executor when the previous fixed-run child is lost", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    expect(first.status).toBe("registered");
    if (first.status !== "registered" || !first.taskId) {
      throw new Error("expected registered result with task");
    }
    const markedLost = markTaskLostById({
      taskId: first.taskId,
      endedAt: 1100,
      lastEventAt: 1100,
      error: "backing session missing",
    });
    expect(markedLost?.status).toBe("lost");

    const legacyLost = createTaskRecord({
      runtime: "cli",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground",
      requesterSessionKey: "webchat:direct:mark",
      ownerKey: "webchat:direct:mark",
      scopeKind: "session",
      parentFlowId: first.flow.flowId,
      childSessionKey: "webchat:direct:mark",
      runId: `foreground-cleanup-crew:${first.flow.flowId}`,
      label: "Foreground Cleanup Crew execution",
      task: "Represent foreground Cleanup Crew execution inside active-production TaskFlow",
      status: "lost",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1100,
      endedAt: 1200,
      lastEventAt: 1200,
      error: "backing session missing",
    });
    expect(legacyLost).not.toBeNull();

    const second = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "active_no_worker_repair_running",
      now: 2000,
    });

    expect(second.status).toBe("attached");
    if (second.status !== "attached" || !second.taskId) {
      throw new Error("expected attached result with task");
    }
    expect(second.taskId).not.toBe(legacyLost!.taskId);
    const activeTasks = listTasksForFlowId(first.flow.flowId).filter(
      (task) => task.status === "queued" || task.status === "running",
    );
    expect(activeTasks).toHaveLength(1);
    expect(activeTasks[0]).toMatchObject({
      taskId: second.taskId,
      status: "running",
      runId: `foreground-cleanup-crew:${first.flow.flowId}:executor:2000`,
      childSessionKey: "webchat:direct:mark",
      progressSummary:
        "Foreground Cleanup Crew mission is active in this source conversation. stage=active_no_worker_repair_running",
    });
  });

  it("attaches duplicate foreground Cleanup Crew turns to the existing open flow", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }

    const second = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build, continue Packet C.",
      packetId: "packet-6",
      stageId: "validation-command-running",
      activeValidationCommand:
        "node scripts/run-vitest.mjs run src/tasks/foreground-cleanup-crew-taskflow.test.ts",
      now: 2000,
    });

    expect(second.status).toBe("attached");
    if (second.status !== "attached") {
      throw new Error("expected attached result");
    }
    expect(second.flow.flowId).toBe(first.flow.flowId);
    expect(listTaskFlowRecords()).toHaveLength(1);
    expect(listTasksForFlowId(first.flow.flowId)).toHaveLength(1);
    expect(second.flow.currentStep).toBe("validation-command-running");
    expect(second.flow.stateJson).toMatchObject({
      currentPacketId: "packet-6",
      currentStageId: "validation-command-running",
      activeValidationCommand:
        "node scripts/run-vitest.mjs run src/tasks/foreground-cleanup-crew-taskflow.test.ts",
    });
    expect(listTasksForFlowId(first.flow.flowId)[0]?.progressSummary).toContain(
      "stage=validation-command-running",
    );
  });

  it("refreshes the parent flow heartbeat when reattaching the same foreground step", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "same-step",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }

    const second = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "same-step",
      now: 2000,
    });

    expect(second.status).toBe("attached");
    if (second.status !== "attached") {
      throw new Error("expected attached result");
    }
    expect(second.flow.flowId).toBe(first.flow.flowId);
    expect(second.flow.updatedAt).toBe(2000);
    expect(second.flow.revision).toBeGreaterThan(first.flow.revision);
    expect(listTasksForFlowId(first.flow.flowId)).toHaveLength(1);
  });

  it("records report-boundary and tool-batch checkpoints with the next executable action", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "scope_lock_complete",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }

    const checkpoint = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "issue_040_tool_batch_checkpoint",
      checkpointKind: "tool_batch_completed",
      checkpointSummary: "scope and source reads completed without a SOP blocker",
      nextExecutableAction: "write design lock and patch the selected source owner",
      now: 2000,
    });

    expect(checkpoint.status).toBe("attached");
    if (checkpoint.status !== "attached") {
      throw new Error("expected attached result");
    }
    expect(checkpoint.flow.currentStep).toBe("issue_040_tool_batch_checkpoint");
    expect(checkpoint.flow.stateJson).toMatchObject({
      currentStageId: "issue_040_tool_batch_checkpoint",
      currentCheckpointKind: "tool_batch_completed",
      currentCheckpointSummary: "scope and source reads completed without a SOP blocker",
      nextExecutableAction: "write design lock and patch the selected source owner",
    });
    expect(listTasksForFlowId(first.flow.flowId)[0]?.progressSummary).toContain(
      "checkpoint=tool_batch_completed",
    );
    expect(listTasksForFlowId(first.flow.flowId)[0]?.progressSummary).toContain(
      "next=write design lock and patch the selected source owner",
    );
    expect(getTaskFlowProductionContinuation(checkpoint.flow)).toMatchObject({
      nextExecutableUnitIdentified: true,
      nextExecutableUnitLaunched: true,
    });
    expect(getTaskFlowActiveProductionContinuation(checkpoint.flow)).toMatchObject({
      status: "dispatched",
      boundary: "plan_next_step",
      lastDispatchReceiptId: expect.stringContaining(":next-executable:dispatch:"),
    });
    expect(
      getTaskFlowActiveProductionContinuation(checkpoint.flow)?.dispatchReceipts[0]?.proofRef,
    ).toBe("write design lock and patch the selected source owner");
  });

  it("preserves dispatched checkpoint state when a later foreground attach has no tracking", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });

    expect(first.status).toBe("registered");
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }

    const checkpoint = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "issue_040_checkpoint_dispatch_activation_closeout_delivered",
      checkpointKind: "milestone_delivered",
      checkpointSummary: "checkpoint-dispatch activation proof passed",
      nextExecutableAction: "re-triage the remaining ISSUE-040 family",
      now: 1500,
    });

    expect(checkpoint.status).toBe("attached");
    if (checkpoint.status !== "attached") {
      throw new Error("expected attached result");
    }
    const activeContinuation = getTaskFlowActiveProductionContinuation(checkpoint.flow);
    expect(activeContinuation).toMatchObject({
      status: "dispatched",
      lastDispatchReceiptId: expect.stringContaining(":next-executable:dispatch:"),
    });
    expect(activeContinuation?.dispatchReceipts[0]?.proofRef).toBe(
      "re-triage the remaining ISSUE-040 family",
    );

    const laterAttach = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 2000,
    });

    expect(laterAttach.status).toBe("attached");
    if (laterAttach.status !== "attached") {
      throw new Error("expected attached result");
    }
    expect(laterAttach.flow.revision).toBe(checkpoint.flow.revision);
    expect(getTaskFlowProductionContinuation(laterAttach.flow)).toMatchObject({
      nextExecutableUnitLaunched: true,
    });
    expect(getTaskFlowActiveProductionContinuation(laterAttach.flow)).toMatchObject({
      status: "dispatched",
      lastDispatchReceiptId: activeContinuation?.lastDispatchReceiptId,
    });
    expect(
      getTaskFlowActiveProductionContinuation(laterAttach.flow)?.dispatchReceipts[0]?.proofRef,
    ).toBe("re-triage the remaining ISSUE-040 family");
  });

  it("settles an obsolete restart boundary when a later checkpoint advances the foreground run", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "issue_040_gateway_restart_proof",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }
    const stopped = recordFlowLawfulStop({
      flowId: first.flow.flowId,
      expectedRevision: first.flow.revision,
      reason: "restart_or_reload",
      detail: "runtime restart required for loaded-proof stage",
      currentStep: "issue_040_gateway_restart_proof",
      updatedAt: 1500,
    });
    expect(stopped.applied).toBe(true);
    if (!stopped.applied) {
      throw new Error("expected stopped flow");
    }
    expect(getTaskFlowProductionContinuation(stopped.flow)).toMatchObject({
      restartOrReloadRequired: true,
      lawfulStopReason: "restart_or_reload",
    });

    const checkpoint = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "issue_040_remaining_family_retriage",
      checkpointKind: "report_boundary",
      checkpointSummary: "runtime proof already passed; re-triage selected next family target",
      nextExecutableAction: "write the active-production continuation settlement package",
      now: 2000,
    });

    expect(checkpoint.status).toBe("attached");
    if (checkpoint.status !== "attached") {
      throw new Error("expected attached result");
    }
    const continuation = getTaskFlowProductionContinuation(checkpoint.flow);
    const activeContinuation = getTaskFlowActiveProductionContinuation(checkpoint.flow);
    expect(checkpoint.flow.currentStep).toBe("issue_040_remaining_family_retriage");
    expect(continuation).toMatchObject({
      activeProductionRun: true,
      parentRunOpen: true,
      currentUnitStatus: "started",
      restartOrReloadRequired: false,
      lawfulWholeRunCompletion: false,
      nextExecutableUnitIdentified: true,
      nextExecutableUnitLaunched: true,
      continuationViolation: false,
    });
    expect(continuation?.lawfulStopReason).toBeUndefined();
    expect(activeContinuation).toMatchObject({
      broaderBuildOpen: true,
      status: "dispatched",
      boundary: "plan_next_step",
    });
    expect(activeContinuation?.nextAction?.summary).toContain(
      "write the active-production continuation settlement package",
    );
    expect(activeContinuation?.dispatchReceipts[0]?.proofRef).toBe(
      "write the active-production continuation settlement package",
    );

    const closeoutCheckpoint = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "issue_040_active_production_continuation_settlement_closeout_delivered",
      checkpointKind: "milestone_delivered",
      checkpointSummary: "settlement closeout and register update were delivered",
      nextExecutableAction: "re-triage the remaining ISSUE-040 family",
      now: 3000,
    });

    expect(closeoutCheckpoint.status).toBe("attached");
    if (closeoutCheckpoint.status !== "attached") {
      throw new Error("expected attached result");
    }
    expect(
      getTaskFlowActiveProductionContinuation(closeoutCheckpoint.flow)?.nextAction?.summary,
    ).toBe("re-triage the remaining ISSUE-040 family");
    expect(
      getTaskFlowActiveProductionContinuation(closeoutCheckpoint.flow)?.dispatchReceipts[0]
        ?.proofRef,
    ).toBe("re-triage the remaining ISSUE-040 family");
  });

  it("preserves restart boundaries when foreground progress lacks an explicit checkpoint", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }
    const stopped = recordFlowLawfulStop({
      flowId: first.flow.flowId,
      expectedRevision: first.flow.revision,
      reason: "restart_or_reload",
      detail: "runtime restart required for loaded-proof stage",
      currentStep: "issue_040_gateway_restart_proof",
      updatedAt: 1500,
    });
    expect(stopped.applied).toBe(true);
    if (!stopped.applied) {
      throw new Error("expected stopped flow");
    }

    const resumed = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      stageId: "issue_040_runtime_status_check",
      now: 2000,
    });

    expect(resumed.status).toBe("attached");
    if (resumed.status !== "attached") {
      throw new Error("expected attached result");
    }
    expect(getTaskFlowProductionContinuation(resumed.flow)).toMatchObject({
      restartOrReloadRequired: true,
      lawfulStopReason: "restart_or_reload",
    });
    expect(getTaskFlowActiveProductionContinuation(resumed.flow)).toMatchObject({
      status: "hard_boundary",
      boundary: "runtime_restart_recovery",
    });
  });

  it("blocks checkpoint registration when the next executable action is missing", () => {
    expect(
      ensureForegroundCleanupCrewTaskFlow({
        sessionKey: "webchat:direct:mark",
        currentTurnText: "Cleanup Crew production repair build.",
        stageId: "report_boundary_without_next_action",
        checkpointKind: "report_boundary",
        checkpointSummary: "final report artifact was prepared",
        now: 1000,
      }),
    ).toEqual({
      status: "blocked",
      reason: "checkpoint_next_executable_action_missing",
    });
    expect(listTaskFlowRecords()).toHaveLength(0);
  });

  it("does not resume a lawfully blocked foreground Cleanup Crew flow", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }

    const stopped = recordFlowLawfulStop({
      flowId: first.flow.flowId,
      expectedRevision: first.flow.revision,
      reason: "blocker",
      detail: "Lost child has no active backing session; no relaunch authorized.",
      currentStep: "foreground_cleanup_crew_blocked_lost_child",
      updatedAt: 1500,
    });
    expect(stopped.applied).toBe(true);

    const second = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew watchdog repair status.",
      packetId: "watchdog",
      stageId: "repair",
      now: 2000,
    });

    expect(second).toEqual({
      status: "blocked",
      reason: "foreground_cleanup_crew_flow_lawfully_blocked",
    });
    const [flow] = listTaskFlowRecords();
    expect(flow?.status).toBe("blocked");
    expect(flow?.currentStep).toBe("foreground_cleanup_crew_blocked_lost_child");
    expect(listTasksForFlowId(first.flow.flowId)).toHaveLength(1);
    expect(getTaskFlowProductionContinuation(flow)?.lawfulStopReason).toBe("blocker");
  });

  it("supersedes a lost foreground executor under the same parent mission", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }
    const { lost, replacement } = createLostAndReplacementTasks(first.flow.flowId, "one");

    const result = supersedeForegroundCleanupCrewExecutor({
      flowId: first.flow.flowId,
      lostTaskId: lost.taskId,
      replacementTaskId: replacement.taskId,
      ownerKey: "webchat:direct:mark",
      sessionKey: "webchat:direct:mark",
      currentStep: "governance_remediation_current_truth_reconciliation",
      now: 2000,
    });

    expect(result.status).toBe("superseded");
    if (result.status !== "superseded") {
      throw new Error("expected superseded result");
    }
    expect(result.flow.status).toBe("running");
    expect(result.flow.currentStep).toBe("governance_remediation_current_truth_reconciliation");
    expect(result.task).toMatchObject({
      sourceId: "cleanup-crew:foreground:supersession",
      parentFlowId: first.flow.flowId,
      ownerKey: "webchat:direct:mark",
      requesterSessionKey: "webchat:direct:mark",
      childSessionKey: "webchat:direct:replacement:one",
      status: "running",
    });
    const continuation = getTaskFlowProductionContinuation(result.flow);
    const activeContinuation = getTaskFlowActiveProductionContinuation(result.flow);
    expect(continuation).toMatchObject({
      activeProductionRun: true,
      parentRunOpen: true,
      nextExecutableUnitIdentified: true,
      nextExecutableUnitLaunched: true,
    });
    expect(activeContinuation?.lastDispatchReceiptId).toContain(":next-executable:dispatch:");
    expect(activeContinuation?.dispatchReceipts[0]?.proofRef).toContain(
      `lost child ${lost.taskId}`,
    );
  });

  it("restores a lawfully stopped foreground parent when replacing a lost executor", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }
    const stopped = recordFlowLawfulStop({
      flowId: first.flow.flowId,
      expectedRevision: first.flow.revision,
      reason: "blocker",
      detail: "lost backing session requires executor replacement",
      currentStep: "foreground_cleanup_crew_blocked_lost_child",
      updatedAt: 1500,
    });
    expect(stopped.applied).toBe(true);
    if (!stopped.applied) {
      throw new Error("expected stopped flow");
    }
    const { lost, replacement } = createLostAndReplacementTasks(stopped.flow.flowId, "blocked");

    const result = supersedeForegroundCleanupCrewExecutor({
      flowId: stopped.flow.flowId,
      lostTaskId: lost.taskId,
      replacementTaskId: replacement.taskId,
      ownerKey: "webchat:direct:mark",
      sessionKey: "webchat:direct:mark",
      currentStep: "active_no_worker_forensic_repair_and_executor_recovery",
      now: 2000,
    });

    expect(result.status).toBe("superseded");
    if (result.status !== "superseded") {
      throw new Error("expected superseded result");
    }
    const continuation = getTaskFlowProductionContinuation(result.flow);
    expect(result.flow.status).toBe("running");
    expect(continuation).toMatchObject({
      currentUnitStatus: "started",
      blockerPresent: false,
      nextExecutableUnitLaunched: true,
      continuationViolation: false,
    });
    expect(continuation?.lawfulStopReason).toBeUndefined();
  });

  it("binds an already-running subagent replacement executor to the foreground parent", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }
    const stopped = recordFlowLawfulStop({
      flowId: first.flow.flowId,
      expectedRevision: first.flow.revision,
      reason: "blocker",
      detail: "lost backing session requires executor replacement",
      currentStep: "foreground_cleanup_crew_blocked_lost_child",
      updatedAt: 1500,
    });
    expect(stopped.applied).toBe(true);
    if (!stopped.applied) {
      throw new Error("expected stopped flow");
    }
    const { lost } = createLostAndReplacementTasks(stopped.flow.flowId, "subagent");
    const replacement = createTaskRecord({
      runtime: "subagent",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground:supersession",
      requesterSessionKey: "agent:orchestrator:main",
      ownerKey: "agent:orchestrator:subagent:replacement",
      scopeKind: "session",
      childSessionKey: "agent:orchestrator:subagent:replacement",
      runId: "foreground-cleanup-crew:replacement-subagent",
      label: "Replacement foreground executor",
      task: "Replacement foreground executor",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1800,
      lastEventAt: 1800,
      progressSummary: "Replacement worker heartbeat confirmed",
    });
    expect(replacement).not.toBeNull();

    const result = supersedeForegroundCleanupCrewExecutor({
      flowId: stopped.flow.flowId,
      lostTaskId: lost.taskId,
      replacementTaskId: replacement!.taskId,
      ownerKey: "webchat:direct:mark",
      sessionKey: "agent:orchestrator:subagent:replacement",
      currentStep: "active_no_worker_forensic_repair_and_executor_recovery",
      now: 2000,
    });

    expect(result.status).toBe("superseded");
    if (result.status !== "superseded") {
      throw new Error("expected superseded result");
    }
    expect(result.task).toMatchObject({
      parentFlowId: stopped.flow.flowId,
      parentTaskId: lost.taskId,
      ownerKey: "webchat:direct:mark",
      childSessionKey: "agent:orchestrator:subagent:replacement",
      status: "running",
      sourceId: "cleanup-crew:foreground:supersession",
    });
    expect(result.task.taskId).not.toBe(replacement!.taskId);
    expect(result.task.progressSummary).toContain(replacement!.taskId);
    expect(result.flow.status).toBe("running");
    expect(result.flow.currentStep).toBe("active_no_worker_forensic_repair_and_executor_recovery");
    expect(getTaskFlowProductionContinuation(result.flow)).toMatchObject({
      currentUnitStatus: "started",
      blockerPresent: false,
      nextExecutableUnitLaunched: true,
      continuationViolation: false,
    });
  });

  it("adopts a running replacement executor from its task-mirrored flow", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "agent:orchestrator:main",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }
    const stopped = recordFlowLawfulStop({
      flowId: first.flow.flowId,
      expectedRevision: first.flow.revision,
      reason: "blocker",
      detail: "lost backing session requires executor replacement",
      currentStep: "foreground_cleanup_crew_blocked_lost_child",
      updatedAt: 1500,
    });
    expect(stopped.applied).toBe(true);
    if (!stopped.applied) {
      throw new Error("expected stopped flow");
    }
    const lost = createTaskRecord({
      runtime: "cli",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground",
      requesterSessionKey: "agent:orchestrator:main",
      ownerKey: "agent:orchestrator:main",
      scopeKind: "session",
      parentFlowId: stopped.flow.flowId,
      childSessionKey: "agent:orchestrator:main",
      runId: "foreground-cleanup-crew:lost:mirrored-subagent",
      label: "Lost foreground executor",
      task: "Lost foreground executor",
      status: "lost",
      deliveryStatus: "session_queued",
      notifyPolicy: "silent",
      startedAt: 1000,
      lastEventAt: 1100,
      endedAt: 1100,
      terminalSummary: "backing session missing",
    });
    expect(lost).not.toBeNull();
    const replacement = createTaskRecord({
      runtime: "subagent",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground:supersession",
      requesterSessionKey: "agent:orchestrator:main",
      ownerKey: "agent:orchestrator:subagent:replacement",
      scopeKind: "session",
      childSessionKey: "agent:orchestrator:subagent:replacement",
      runId: "foreground-cleanup-crew:replacement-mirrored-subagent",
      label: "Replacement foreground executor",
      task: "Replacement foreground executor",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "silent",
      startedAt: 1800,
      lastEventAt: 1800,
      progressSummary: "Replacement worker heartbeat confirmed",
    });
    expect(replacement).not.toBeNull();
    const mirrored = createTaskFlowForTask({ task: replacement! });
    expect(mirrored).not.toBeNull();
    expect(
      linkTaskToFlowById({
        taskId: replacement!.taskId,
        flowId: mirrored!.flowId,
      })?.parentFlowId,
    ).toBe(mirrored!.flowId);

    const result = supersedeForegroundCleanupCrewExecutor({
      flowId: stopped.flow.flowId,
      lostTaskId: lost!.taskId,
      replacementTaskId: replacement!.taskId,
      ownerKey: "agent:orchestrator:main",
      sessionKey: "agent:orchestrator:subagent:replacement",
      currentStep: "active_no_worker_forensic_repair_and_executor_recovery",
      now: 2000,
    });

    expect(result.status).toBe("superseded");
    if (result.status !== "superseded") {
      throw new Error("expected superseded result");
    }
    expect(result.task.parentFlowId).toBe(stopped.flow.flowId);
    expect(result.task.parentTaskId).toBe(lost!.taskId);
    expect(result.task.ownerKey).toBe("agent:orchestrator:main");
    expect(result.task.childSessionKey).toBe("agent:orchestrator:subagent:replacement");
    expect(result.task.taskId).not.toBe(replacement!.taskId);
    expect(getTaskFlowById(mirrored!.flowId)).toBeDefined();
    expect(result.flow.status).toBe("running");
    expect(result.flow.currentStep).toBe("active_no_worker_forensic_repair_and_executor_recovery");
    expect(getTaskFlowProductionContinuation(result.flow)).toMatchObject({
      currentUnitStatus: "started",
      blockerPresent: false,
      nextExecutableUnitLaunched: true,
      continuationViolation: false,
    });
  });

  it("reuses an existing foreground executor supersession on duplicate recovery", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }
    const { lost, replacement } = createLostAndReplacementTasks(first.flow.flowId, "duplicate");

    const superseded = supersedeForegroundCleanupCrewExecutor({
      flowId: first.flow.flowId,
      lostTaskId: lost.taskId,
      replacementTaskId: replacement.taskId,
      ownerKey: "webchat:direct:mark",
      sessionKey: "webchat:direct:mark",
      currentStep: "first_recovery_step",
      now: 2000,
    });
    expect(superseded.status).toBe("superseded");

    const duplicate = supersedeForegroundCleanupCrewExecutor({
      flowId: first.flow.flowId,
      lostTaskId: lost.taskId,
      replacementTaskId: replacement.taskId,
      ownerKey: "webchat:direct:mark",
      sessionKey: "webchat:direct:mark",
      currentStep: "duplicate_recovery_step",
      now: 3000,
    });

    expect(duplicate.status).toBe("attached");
    if (duplicate.status !== "attached" || superseded.status !== "superseded") {
      throw new Error("expected attached duplicate result");
    }
    expect(duplicate.task.taskId).toBe(superseded.task.taskId);
    expect(
      listTasksForFlowId(first.flow.flowId).filter((task) => task.status === "running"),
    ).toHaveLength(2);
    expect(
      listTasksForFlowId(first.flow.flowId).filter(
        (task) => task.sourceId === "cleanup-crew:foreground:supersession",
      ),
    ).toHaveLength(1);
    expect(duplicate.flow.currentStep).toBe("duplicate_recovery_step");
  });

  it("supersedes a parent-owned projection whose backing subagent run already ended", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "agent:orchestrator:main",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }
    const staleProjection = createTaskRecord({
      runtime: "subagent",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground:supersession",
      requesterSessionKey: "agent:orchestrator:main",
      ownerKey: "agent:orchestrator:main",
      scopeKind: "session",
      parentFlowId: first.flow.flowId,
      parentTaskId: "prior-lost-task",
      childSessionKey: "agent:orchestrator:subagent:ended",
      runId: "run-ended-projection",
      label: "Replacement foreground Cleanup Crew executor",
      task: "Stale replacement executor projection",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1200,
      lastEventAt: 1300,
      progressSummary: "Projection was active before the subagent completed",
    });
    const replacement = createTaskRecord({
      runtime: "subagent",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground:supersession",
      requesterSessionKey: "agent:orchestrator:main",
      ownerKey: "agent:orchestrator:subagent:replacement",
      scopeKind: "session",
      childSessionKey: "agent:orchestrator:subagent:replacement-next",
      runId: "run-replacement-next",
      label: "Replacement foreground executor",
      task: "Replacement foreground executor",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1800,
      lastEventAt: 1800,
      progressSummary: "Replacement worker heartbeat confirmed",
    });
    expect(staleProjection).not.toBeNull();
    expect(replacement).not.toBeNull();
    addSubagentRunForTests({
      runId: "run-ended-projection",
      childSessionKey: "agent:orchestrator:subagent:ended",
      requesterSessionKey: "agent:orchestrator:main",
      requesterDisplayKey: "main",
      task: "stale projection",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1200,
      endedAt: 1600,
      cleanupHandled: false,
    });

    const result = supersedeForegroundCleanupCrewExecutor({
      flowId: first.flow.flowId,
      lostTaskId: staleProjection!.taskId,
      replacementTaskId: replacement!.taskId,
      ownerKey: "agent:orchestrator:main",
      sessionKey: "agent:orchestrator:subagent:replacement-next",
      currentStep: "next_governance_remediation_step",
      now: 2000,
    });

    expect(result.status).toBe("superseded");
    if (result.status !== "superseded") {
      throw new Error("expected superseded result");
    }
    const staleAfter = listTasksForFlowId(first.flow.flowId).find(
      (task) => task.taskId === staleProjection!.taskId,
    );
    expect(staleAfter).toMatchObject({
      status: "lost",
      endedAt: 1600,
      error: "backing subagent run ended",
    });
    expect(result.task).toMatchObject({
      parentFlowId: first.flow.flowId,
      parentTaskId: staleProjection!.taskId,
      ownerKey: "agent:orchestrator:main",
      childSessionKey: "agent:orchestrator:subagent:replacement-next",
      status: "running",
    });
    expect(result.task.taskId).not.toBe(replacement!.taskId);
  });

  it("blocks executor supersession when parent identity or next step is invalid", () => {
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered result");
    }
    const { lost, replacement } = createLostAndReplacementTasks(first.flow.flowId, "invalid");

    expect(
      supersedeForegroundCleanupCrewExecutor({
        flowId: first.flow.flowId,
        lostTaskId: lost.taskId,
        replacementTaskId: replacement.taskId,
        ownerKey: "webchat:direct:someone-else",
        sessionKey: "webchat:direct:mark",
        currentStep: "repair",
        now: 2000,
      }),
    ).toEqual({ status: "blocked", reason: "parent_flow_owner_mismatch" });
    expect(
      supersedeForegroundCleanupCrewExecutor({
        flowId: first.flow.flowId,
        lostTaskId: lost.taskId,
        replacementTaskId: replacement.taskId,
        ownerKey: "webchat:direct:mark",
        sessionKey: "webchat:direct:mark",
        currentStep: " ",
        now: 2000,
      }),
    ).toEqual({ status: "blocked", reason: "current_step_missing" });
  });

  it("does not record a lawful stop or whole-run completion during registration", () => {
    const result = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew 100% production runtime repair.",
      now: 1000,
    });
    if (result.status !== "registered") {
      throw new Error("expected registered result");
    }

    const continuation = getTaskFlowProductionContinuation(result.flow);
    expect(continuation?.lawfulStopReason).toBeUndefined();
    expect(continuation?.lawfulWholeRunCompletion).toBe(false);
    expect(continuation?.parentRunOpen).toBe(true);
  });

  it("blocks registration when active mission identity is missing", () => {
    expect(
      ensureForegroundCleanupCrewTaskFlow({
        currentTurnText: "Cleanup Crew production repair build.",
      }),
    ).toEqual({
      status: "blocked",
      reason: "active_mission_identity_missing",
    });
  });
});
