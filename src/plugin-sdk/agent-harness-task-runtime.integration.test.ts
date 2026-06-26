import { describe, expect, it } from "vitest";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { resolveTaskBuildExecutionTruth } from "../tasks/task-build-execution-truth.js";
import {
  createManagedTaskFlow,
  finishFlow,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-runtime-internal.js";
import {
  createTaskRecord,
  findTaskByRunId,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { createAgentHarnessTaskRuntime } from "./agent-harness-task-runtime.js";

describe("agent-harness-task-runtime integration", () => {
  it("persists host-issued parent continuation linkage into detached task records", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:parent",
      controllerId: "tests/agent-harness-parent",
      goal: "Continue harness-linked production parent",
      status: "running",
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
    });
    const blockedClose = finishFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      endedAt: 10,
    });
    if (blockedClose.applied || !blockedClose.current) {
      throw new Error("Expected continuation-required harness parent flow");
    }
    const missionTask = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:parent",
      requesterSessionKey: "agent:main:parent",
      scopeKind: "session",
      parentFlowId: blockedClose.current.flowId,
      task: "Harness parent mission",
      missionId: "mission-agent-harness-parent",
      missionSummary: "Launch the next harness unit before pause",
      missionState: "active",
      status: "running",
      deliveryStatus: "pending",
    });
    if (!missionTask) {
      throw new Error("Expected harness mission task");
    }

    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "example-harness",
      scope: createAgentHarnessTaskRuntimeScope({
        requesterSessionKey: "agent:main:parent",
        parentFlowId: blockedClose.current.flowId,
        parentTaskId: missionTask.taskId,
      }),
      runIdPrefix: "example:",
    });

    runtime.createRunningTaskRun({
      runId: "example:child-1",
      sourceId: "example:child-1",
      task: "Do linked harness work",
      label: "worker",
    });
    runtime.finalizeTaskRunByRunId({
      runId: "example:child-1",
      status: "succeeded",
      endedAt: 20,
    });

    const task = findTaskByRunId("example:child-1");
    expect(task).toMatchObject({
      parentFlowId: blockedClose.current.flowId,
      parentTaskId: missionTask.taskId,
      status: "succeeded",
    });
    expect(resolveTaskBuildExecutionTruth(task!)).toMatchObject({
      state: "continuation_required_after_local_success",
      broaderBuildOpen: true,
    });
  });

  it("keeps standalone harness work standalone in continuation terms", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "example-harness",
      scope: createAgentHarnessTaskRuntimeScope({
        requesterSessionKey: "agent:main:standalone",
      }),
      runIdPrefix: "example:",
    });

    runtime.createRunningTaskRun({
      runId: "example:child-standalone",
      sourceId: "example:child-standalone",
      task: "Do standalone harness work",
      label: "worker",
    });
    runtime.finalizeTaskRunByRunId({
      runId: "example:child-standalone",
      status: "succeeded",
      endedAt: 20,
    });

    const task = findTaskByRunId("example:child-standalone");
    const linkedFlow = getTaskFlowById(task!.parentFlowId!);
    expect(getTaskFlowProductionContinuation(linkedFlow!)).toBeNull();
    expect(resolveTaskBuildExecutionTruth(task!)).toMatchObject({
      state: "paused_pending_parent_review",
      broaderBuildOpen: true,
    });
  });
});
