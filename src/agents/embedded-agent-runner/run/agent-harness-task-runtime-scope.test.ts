import { describe, expect, it } from "vitest";
import {
  createManagedTaskFlow,
  finishFlow,
  resetTaskFlowRegistryForTests,
} from "../../../tasks/task-flow-runtime-internal.js";
import { createTaskRecord, resetTaskRegistryForTests } from "../../../tasks/task-registry.js";
import { resolveAgentHarnessTaskRuntimeScope } from "./agent-harness-task-runtime-scope.js";

describe("resolveAgentHarnessTaskRuntimeScope", () => {
  it("inherits active parent production linkage when the requester has a real active mission", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:parent",
      controllerId: "tests/embedded-runner-harness-scope",
      goal: "Continue parent-linked harness run",
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
      throw new Error("Expected continuation-required harness scope parent flow");
    }
    const missionTask = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:parent",
      requesterSessionKey: "agent:main:parent",
      scopeKind: "session",
      parentFlowId: blockedClose.current.flowId,
      task: "Harness scope parent mission",
      missionId: "mission-harness-scope-parent",
      missionSummary: "Launch the next harness unit before pause",
      missionState: "active",
      status: "running",
      deliveryStatus: "pending",
    });
    if (!missionTask) {
      throw new Error("Expected harness scope mission task");
    }

    expect(
      resolveAgentHarnessTaskRuntimeScope({
        requesterSessionKey: "agent:main:parent",
      }),
    ).toMatchObject({
      requesterSessionKey: "agent:main:parent",
      parentFlowId: blockedClose.current.flowId,
      parentTaskId: missionTask.taskId,
    });
  });

  it("does not invent parent linkage for standalone requester sessions", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const scope = resolveAgentHarnessTaskRuntimeScope({
      requesterSessionKey: "agent:main:standalone",
    });

    expect(scope).toMatchObject({
      requesterSessionKey: "agent:main:standalone",
    });
    expect(scope).not.toHaveProperty("parentFlowId");
    expect(scope).not.toHaveProperty("parentTaskId");
  });
});
