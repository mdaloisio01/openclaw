import { beforeEach, describe, expect, it } from "vitest";
import { resolveProductionWatchdogLifecycleDecision } from "./active-production-watchdog-lifecycle.js";
import {
  ensureForegroundCleanupCrewTaskFlow,
  isForegroundCleanupCrewProductionMission,
} from "./foreground-cleanup-crew-taskflow.js";
import { listTasksForFlowId } from "./runtime-internal.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  getTaskFlowProductionContinuation,
  listTaskFlowRecords,
  resetTaskFlowRegistryForTests,
} from "./task-flow-runtime-internal.js";
import { resetTaskRegistryForTests } from "./task-registry.js";
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
    const result = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "webchat:direct:mark",
      currentTurnText: "Cleanup Crew runtime repair build. Execute Packet C.",
      packetId: "packet-6",
      stageId: "active-work-tracking",
      activeValidationCommand:
        "node scripts/run-vitest.mjs run src/tasks/foreground-cleanup-crew-taskflow.test.ts",
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
