import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureForegroundCleanupCrewTaskFlow } from "../tasks/foreground-cleanup-crew-taskflow.js";
import {
  createTaskRecord,
  listTasksForFlowId,
  markTaskLostById,
} from "../tasks/runtime-internal.js";
import { configureTaskFlowRegistryRuntime } from "../tasks/task-flow-registry.store.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  listTaskFlowRecords,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-runtime-internal.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import type { TaskDeliveryState, TaskRecord } from "../tasks/task-registry.types.js";
import {
  activateCleanupWatchdogLiveController,
  consumeReceiptWithLiveController,
  evaluateReceiptWithLiveController,
  getCleanupWatchdogLiveControllerState,
  rollbackCleanupWatchdogLiveController,
  runCleanupWatchdogControlledCanaries,
} from "./cleanup-watchdog-live-controller.js";
import { CLEANUP_WATCHDOG_POLICY_VERSION } from "./cleanup-watchdog-policy.js";

const tempDirs: string[] = [];

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-watchdog-live-controller-"));
  tempDirs.push(dir);
  return dir;
}

const allGates = {
  requestedMode: "enforce",
  policySchemaGenerated: true,
  sopParityValidated: true,
  sourceBuiltRuntimeMatch: true,
  watchdogClean: true,
  workerCoverageProven: true,
  shadowDecisionsStable: true,
  repairTasksDrained: true,
  grantReviewPassed: true,
  rollbackPlanVerified: true,
  productionPaused: true,
  trinityUnstarted: true,
  controlPlanePhase2Paused: true,
} as const;

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
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  configureTaskRegistryRuntime({
    store: createInMemoryTaskRegistryStore(),
  });
  configureTaskFlowRegistryRuntime({
    store: createInMemoryTaskFlowRegistryStore(),
  });
}

beforeEach(() => {
  configureInMemoryRegistries();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cleanup-watchdog live controller", () => {
  it("defaults to shadow state until activated", () => {
    const state = getCleanupWatchdogLiveControllerState({ workspaceDir: tempWorkspace() });

    expect(state).toMatchObject({
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      controllerMode: "shadow_observe",
      enforcementState: "shadow",
    });
  });

  it("persists active enforcement only when every gate passes", () => {
    const workspaceDir = tempWorkspace();
    const state = activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: allGates,
    });

    expect(state.controllerMode).toBe("enforce");
    expect(state.enforcementState).toBe("active");
    expect(state.activation?.gateDecision).toMatchObject({
      effectiveMode: "enforce",
      state: "enforcement_allowed",
      missingGates: [],
    });
    expect(getCleanupWatchdogLiveControllerState({ workspaceDir }).controllerMode).toBe("enforce");
  });

  it("fails closed to rollback-required state when an enforcement gate is missing", () => {
    const workspaceDir = tempWorkspace();
    const state = activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: { ...allGates, watchdogClean: false },
    });

    expect(state.controllerMode).toBe("shadow_observe");
    expect(state.enforcementState).toBe("rollback_required");
    expect(state.activation?.gateDecision.missingGates).toContain("watchdog_clean");
  });

  it("rolls active enforcement back to shadow without deleting state", () => {
    const workspaceDir = tempWorkspace();
    activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: allGates,
    });

    const rolledBack = rollbackCleanupWatchdogLiveController({
      workspaceDir,
      reason: "test rollback",
    });

    expect(rolledBack.controllerMode).toBe("shadow_observe");
    expect(rolledBack.enforcementState).toBe("shadow");
    expect(rolledBack.rollback).toMatchObject({
      reason: "test rollback",
      previousMode: "enforce",
    });
  });

  it("runs all controlled canaries under active mode without mutating production missions", () => {
    const workspaceDir = tempWorkspace();
    activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: allGates,
    });

    const result = runCleanupWatchdogControlledCanaries({ workspaceDir });

    expect(result.controllerMode).toBe("enforce");
    expect(result.passed).toBe(true);
    expect(result.results.map((item) => item.name)).toEqual([
      "good_clean",
      "missing_worker",
      "duplicate_worker",
      "pending_report",
      "stale_runtime",
      "corrupted_pointer",
    ]);
    const goodClean = result.results.find((item) => item.name === "good_clean");
    expect(goodClean?.decision.canCloseClean).toBe(true);
    expect(goodClean?.decision.requiredRepairTasks).toEqual([]);

    const duplicateWorker = result.results.find((item) => item.name === "duplicate_worker");
    expect(duplicateWorker?.decision.canCloseClean).toBe(false);
    expect(duplicateWorker?.decision.selectedPriority).toBe("P1_SAFETY_OR_DUPLICATE_EXECUTION");

    const missingWorker = result.results.find((item) => item.name === "missing_worker");
    expect(missingWorker?.decision.selectedPriority).toBe("P2_ACTIVE_NO_WORKER");

    expect(
      result.results.every(
        (item) =>
          !item.proof.cleanup.productionMissionMutated &&
          item.proof.cleanup.residualMissionState === "none" &&
          item.proof.cleanup.evidenceRetention === "state_and_receipt_intentionally_retained",
      ),
    ).toBe(true);
  });

  it("evaluates a watchdog receipt using the persisted live controller mode", () => {
    const workspaceDir = tempWorkspace();
    activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: allGates,
    });

    const decision = evaluateReceiptWithLiveController({
      workspaceDir,
      missionId: "flow-1",
      receipt: {
        policy_version: "stale-policy",
        summary: { items_suspicious: 0 },
        decisions: {
          healthy_items: [
            {
              entity_type: "task_run",
              category: "active_with_worker",
              proof: { parent_flow_id: "flow-1" },
            },
          ],
          suspicious_items: [],
        },
      },
    });

    expect(decision.mode).toBe("enforce");
    expect(decision.canCloseClean).toBe(false);
    expect(decision.selectedPriority).toBe("P5_MISSING_PROOF_OR_POLICY_MIGRATION");
  });

  it("consumes an enforced active-no-worker receipt by dispatching foreground TaskFlow repair", () => {
    const workspaceDir = tempWorkspace();
    activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: allGates,
    });

    const result = consumeReceiptWithLiveController({
      workspaceDir,
      missionId: "flow-1",
      receipt: {
        policy_version: CLEANUP_WATCHDOG_POLICY_VERSION,
        summary: { items_suspicious: 1 },
        decisions: {
          healthy_items: [],
          suspicious_items: [
            {
              entity_type: "flow_run",
              entity_id: "flow-1",
              category: "stale",
              label: "Foreground Cleanup Crew production mission",
              proof: {
                active_child_tasks: 0,
                current_step: "cleanup_watchdog_governance_repair",
                owner_key: "agent:orchestrator:main",
              },
              reason: "running flow shows no recent progress",
            },
          ],
        },
      },
      now: 1000,
    });

    expect(result.status).toBe("dispatched");
    if (result.status !== "dispatched") {
      throw new Error("expected dispatched result");
    }
    expect(result.decision.mode).toBe("enforce");
    expect(result.decision.selectedPriority).toBe("P2_ACTIVE_NO_WORKER");
    expect(result.reconciliationArtifact).toMatchObject({
      trigger: "watchdog_needs_review",
      classification: "stale_blocked_flow",
      repairRoute: "foreground_cleanup_crew_taskflow",
      validationResult: "repair_required",
    });
    expect(fs.existsSync(result.reconciliationArtifactPath)).toBe(true);
    expect(result.repair).toMatchObject({
      route: "foreground_cleanup_crew_taskflow",
      ownerKey: "agent:orchestrator:main",
      sessionKey: "agent:orchestrator:main",
      currentStep: "cleanup_watchdog_governance_repair",
    });
    expect(listTaskFlowRecords()).toHaveLength(1);
    expect(listTasksForFlowId(result.repair.flowId)).toHaveLength(1);
  });

  it("automatically supersedes a lost executor when the receipt names the lost child task", () => {
    const workspaceDir = tempWorkspace();
    activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: allGates,
    });
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "agent:orchestrator:main",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered TaskFlow");
    }
    const originalTask = createTaskRecord({
      runtime: "cli",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground:supersession",
      requesterSessionKey: "agent:orchestrator:main",
      ownerKey: "agent:orchestrator:main",
      scopeKind: "session",
      parentFlowId: first.flow.flowId,
      runId: "cleanup-watchdog-lost-run",
      childSessionKey: "agent:orchestrator:main",
      label: "Lost foreground executor",
      task: "Lost foreground executor",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1100,
      lastEventAt: 1100,
      progressSummary: "Lost executor before controller recovery",
    });
    if (!originalTask) {
      throw new Error("expected task creation");
    }
    markTaskLostById({
      taskId: originalTask.taskId,
      endedAt: 1200,
      lastEventAt: 1200,
      error: "backing session missing for active_no_worker test",
    });

    const result = consumeReceiptWithLiveController({
      workspaceDir,
      missionId: first.flow.flowId,
      receipt: {
        policy_version: CLEANUP_WATCHDOG_POLICY_VERSION,
        summary: { items_suspicious: 1 },
        decisions: {
          healthy_items: [],
          suspicious_items: [
            {
              entity_type: "flow_run",
              entity_id: first.flow.flowId,
              category: "active_no_worker",
              label: "Foreground Cleanup Crew production mission",
              proof: {
                active_child_tasks: 0,
                current_step: "cleanup_watchdog_governance_repair",
                owner_key: "agent:orchestrator:main",
                lost_child_task_ids: [originalTask.taskId],
              },
              reason: "running flow has no valid executor",
            },
          ],
        },
      },
      now: 1300,
    });

    expect(result.status).toBe("dispatched");
    if (result.status !== "dispatched") {
      throw new Error("expected dispatched result");
    }
    expect(result.repair.supersession).toMatchObject({
      status: "superseded",
      lostTaskId: originalTask.taskId,
    });
    const runningTasks = listTasksForFlowId(first.flow.flowId).filter(
      (task) => task.status === "running",
    );
    expect(runningTasks).toHaveLength(1);
    expect(runningTasks[0]?.runId).toContain("cleanup-watchdog-live-controller:replacement");
  });

  it("reuses the current automatic replacement and fences duplicate replacements", () => {
    const workspaceDir = tempWorkspace();
    activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: allGates,
    });
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "agent:orchestrator:main",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered") {
      throw new Error("expected registered TaskFlow");
    }
    const lostTask = createTaskRecord({
      runtime: "cli",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground",
      requesterSessionKey: "agent:orchestrator:main",
      ownerKey: "agent:orchestrator:main",
      scopeKind: "session",
      parentFlowId: first.flow.flowId,
      runId: "cleanup-watchdog-lost-run",
      childSessionKey: "agent:orchestrator:main",
      label: "Lost foreground executor",
      task: "Lost foreground executor",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1100,
      lastEventAt: 1100,
      progressSummary: "Lost executor before controller recovery",
    });
    const olderReplacement = createTaskRecord({
      runtime: "cli",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground:automatic-recovery",
      requesterSessionKey: "agent:orchestrator:main",
      ownerKey: "agent:orchestrator:main",
      scopeKind: "session",
      parentFlowId: first.flow.flowId,
      runId: `cleanup-watchdog-live-controller:replacement:${first.flow.flowId}:1200`,
      childSessionKey: "agent:orchestrator:main",
      label: "Cleanup Watchdog automatic replacement executor",
      task: "Older automatic replacement executor",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1200,
      lastEventAt: 1200,
      progressSummary: "Older automatic replacement",
    });
    const currentReplacement = createTaskRecord({
      runtime: "cli",
      taskKind: "foreground_cleanup_crew_execution",
      sourceId: "cleanup-crew:foreground:automatic-recovery",
      requesterSessionKey: "agent:orchestrator:main",
      ownerKey: "agent:orchestrator:main",
      scopeKind: "session",
      parentFlowId: first.flow.flowId,
      runId: `cleanup-watchdog-live-controller:replacement:${first.flow.flowId}:1300`,
      childSessionKey: "agent:orchestrator:main",
      label: "Cleanup Watchdog automatic replacement executor",
      task: "Current automatic replacement executor",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1300,
      lastEventAt: 1300,
      progressSummary: "Current automatic replacement",
    });
    if (!lostTask || !olderReplacement || !currentReplacement) {
      throw new Error("expected task creation");
    }
    markTaskLostById({
      taskId: lostTask.taskId,
      endedAt: 1400,
      lastEventAt: 1400,
      error: "backing session missing for active_no_worker test",
    });

    const result = consumeReceiptWithLiveController({
      workspaceDir,
      missionId: first.flow.flowId,
      receipt: {
        policy_version: CLEANUP_WATCHDOG_POLICY_VERSION,
        summary: { items_suspicious: 1 },
        decisions: {
          healthy_items: [],
          suspicious_items: [
            {
              entity_type: "flow_run",
              entity_id: first.flow.flowId,
              category: "stale",
              label: "Foreground Cleanup Crew production mission",
              proof: {
                active_child_tasks: 2,
                current_step: "cleanup_watchdog_governance_repair",
                owner_key: "agent:orchestrator:main",
                lost_child_task_ids: [lostTask.taskId],
              },
              reason: "running flow shows no recent progress",
            },
          ],
        },
      },
      now: 1500,
    });

    expect(result.status).toBe("dispatched");
    if (result.status !== "dispatched") {
      throw new Error("expected dispatched result");
    }
    expect(result.repair.supersession).toMatchObject({
      status: "attached",
      lostTaskId: lostTask.taskId,
      replacementTaskId: currentReplacement.taskId,
    });
    const activeAutomaticReplacements = listTasksForFlowId(first.flow.flowId).filter(
      (task) =>
        task.status === "running" && task.sourceId === "cleanup-crew:foreground:automatic-recovery",
    );
    expect(activeAutomaticReplacements.map((task) => task.taskId)).toEqual([
      currentReplacement.taskId,
    ]);
    expect(
      listTasksForFlowId(first.flow.flowId).find((task) => task.taskId === olderReplacement.taskId)
        ?.status,
    ).toBe("lost");
  });

  it("blocks duplicate executor receipts without launching another replacement", () => {
    const workspaceDir = tempWorkspace();
    activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: allGates,
    });
    const result = consumeReceiptWithLiveController({
      workspaceDir,
      missionId: "flow-duplicate",
      receipt: {
        policy_version: CLEANUP_WATCHDOG_POLICY_VERSION,
        summary: { items_suspicious: 1 },
        decisions: {
          healthy_items: [],
          suspicious_items: [
            {
              entity_type: "flow_run",
              entity_id: "flow-duplicate",
              category: "duplicate_execution_or_fencing_failure",
              label: "Foreground Cleanup Crew production mission",
              proof: {
                active_child_tasks: 2,
                current_step: "cleanup_watchdog_governance_repair",
                owner_key: "agent:orchestrator:main",
              },
              reason: "duplicate executor coverage for unfinished mission",
            },
          ],
        },
      },
      now: 1600,
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("duplicate_executor_reconciliation_required");
    expect(result.reconciliationArtifact).toMatchObject({
      trigger: "watchdog_needs_review",
      repairRoute: "production_blocker_reconciliation",
    });
    expect(listTaskFlowRecords()).toHaveLength(0);
  });

  it("does not create a replacement when the named original executor is not proven lost", () => {
    const workspaceDir = tempWorkspace();
    activateCleanupWatchdogLiveController({
      workspaceDir,
      command: "cleanup-watchdog-live-controller activate",
      gates: allGates,
    });
    const first = ensureForegroundCleanupCrewTaskFlow({
      sessionKey: "agent:orchestrator:main",
      currentTurnText: "Cleanup Crew production repair build.",
      now: 1000,
    });
    if (first.status !== "registered" || !first.taskId) {
      throw new Error("expected registered TaskFlow");
    }

    const result = consumeReceiptWithLiveController({
      workspaceDir,
      missionId: first.flow.flowId,
      receipt: {
        policy_version: CLEANUP_WATCHDOG_POLICY_VERSION,
        summary: { items_suspicious: 1 },
        decisions: {
          healthy_items: [],
          suspicious_items: [
            {
              entity_type: "flow_run",
              entity_id: first.flow.flowId,
              category: "active_no_worker",
              label: "Foreground Cleanup Crew production mission",
              proof: {
                active_child_tasks: 0,
                current_step: "cleanup_watchdog_governance_repair",
                owner_key: "agent:orchestrator:main",
                lost_child_task_ids: [first.taskId],
              },
              reason: "receipt claims no valid executor but original task is still running",
            },
          ],
        },
      },
      now: 1700,
    });

    expect(result.status).toBe("dispatched");
    if (result.status !== "dispatched") {
      throw new Error("expected dispatched repair route without supersession");
    }
    expect(result.repair.supersession).toBeUndefined();
    expect(
      listTasksForFlowId(first.flow.flowId).filter((task) => task.status === "running"),
    ).toHaveLength(1);
  });

  it("does not dispatch receipt repair while in shadow mode", () => {
    const result = consumeReceiptWithLiveController({
      workspaceDir: tempWorkspace(),
      missionId: "flow-1",
      receipt: {
        policy_version: CLEANUP_WATCHDOG_POLICY_VERSION,
        summary: { items_suspicious: 1 },
        decisions: {
          healthy_items: [],
          suspicious_items: [
            {
              entity_type: "flow_run",
              entity_id: "flow-1",
              category: "stale",
              label: "Foreground Cleanup Crew production mission",
              proof: { current_step: "cleanup_watchdog_governance_repair" },
            },
          ],
        },
      },
      now: 1000,
    });

    expect(result.status).toBe("observed");
    expect(listTaskFlowRecords()).toHaveLength(0);
  });
});
