import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTaskFlowById,
  getTaskFlowProductionContinuation,
} from "../../tasks/task-flow-registry.js";
import { getTaskById } from "../../tasks/task-registry.js";
import {
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";

function requireCreatedFlow<T>(flow: T | null): T {
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

afterEach(() => {
  resetRuntimeTaskTestState({ persist: false });
});

describe("runtime TaskFlow", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  it("binds managed TaskFlow operations to a session key", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
      },
    });

    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Triage inbox",
        currentStep: "classify",
        stateJson: { lane: "inbox" },
      }),
    );

    expect(created.syncMode).toBe("managed");
    expect(created.ownerKey).toBe("agent:main:main");
    expect(created.controllerId).toBe("tests/runtime-taskflow");
    expect(created.requesterOrigin?.channel).toBe("telegram");
    expect(created.requesterOrigin?.to).toBe("telegram:123");
    expect(created.goal).toBe("Triage inbox");
    expect(taskFlow.get(created.flowId)?.flowId).toBe(created.flowId);
    expect(taskFlow.findLatest()?.flowId).toBe(created.flowId);
    expect(taskFlow.resolve("agent:main:main")?.flowId).toBe(created.flowId);
  });

  it("binds TaskFlows from trusted tool context", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.fromToolContext({
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        threadId: "thread:456",
      },
    });

    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Review queue",
      }),
    );

    expect(created.requesterOrigin?.channel).toBe("discord");
    expect(created.requesterOrigin?.to).toBe("channel:123");
    expect(created.requesterOrigin?.threadId).toBe("thread:456");
  });

  it("rejects tool contexts without a bound session key", () => {
    const runtime = createRuntimeTaskFlow();
    expect(() =>
      runtime.fromToolContext({
        sessionKey: undefined,
        deliveryContext: undefined,
      }),
    ).toThrow("TaskFlow runtime requires tool context with a sessionKey.");
  });

  it("keeps TaskFlow reads owner-scoped and runs child tasks under the bound TaskFlow", () => {
    const runtime = createRuntimeTaskFlow();
    const ownerTaskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskFlow = runtime.bindSession({
      sessionKey: "agent:main:other",
    });

    const created = requireCreatedFlow(
      ownerTaskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Inspect PR batch",
      }),
    );

    expect(otherTaskFlow.get(created.flowId)).toBeUndefined();
    expect(otherTaskFlow.list()).toStrictEqual([]);

    const child = ownerTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-taskflow-child",
      task: "Inspect PR 1",
      status: "running",
      startedAt: 10,
      lastEventAt: 10,
    });

    expect(child.created).toBe(true);
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }
    expect(child.flow.flowId).toBe(created.flowId);
    expect(child.task.parentFlowId).toBe(created.flowId);
    expect(child.task.ownerKey).toBe("agent:main:main");
    expect(child.task.runId).toBe("runtime-taskflow-child");

    const storedTask = getTaskById(child.task.taskId);
    expect(storedTask?.parentFlowId).toBe(created.flowId);
    expect(storedTask?.ownerKey).toBe("agent:main:main");
    expect(getTaskFlowById(created.flowId)?.flowId).toBe(created.flowId);
    const summary = ownerTaskFlow.getTaskSummary(created.flowId);
    if (!summary) {
      throw new Error("expected task summary for created flow");
    }
    expect(summary.total).toBe(1);
    expect(summary.active).toBe(1);
  });

  it("returns guard_blocked when a blind-test slice tries to finish before implementation review passes", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
    });

    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "governance/blind-test-slice",
        goal: "Blind test Grant slice 1",
        currentStep: "implementation_review_required",
        stateJson: {
          kind: "blind_test_slice",
          sliceKey: "slice-1",
          subjectAgent: "Grant",
          draft: { verdict: "passed", reviewedAt: 100 },
          implementation: { verdict: "pending" },
        },
      }),
    );

    const result = taskFlow.finish({
      flowId: created.flowId,
      expectedRevision: created.revision,
      endedAt: 200,
    });

    expect(result).toMatchObject({
      applied: false,
      code: "guard_blocked",
      current: {
        flowId: created.flowId,
        status: "queued",
      },
    });
  });

  it("blocks managed flow finish until the next executable unit launches in an active production run", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
    });

    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Run bounded managed controller",
        status: "running",
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      }),
    );

    const blockedClose = taskFlow.finish({
      flowId: created.flowId,
      expectedRevision: created.revision,
      endedAt: 200,
    });
    expect(blockedClose).toMatchObject({
      applied: false,
      code: "guard_blocked",
      current: {
        flowId: created.flowId,
        status: "blocked",
        currentStep: "continuation_launch_required",
      },
    });
    if (blockedClose.applied || !blockedClose.current) {
      throw new Error("Expected blocked managed finish snapshot");
    }

    const launched = taskFlow.recordNextExecutableLaunch({
      flowId: created.flowId,
      expectedRevision: blockedClose.current.revision,
      detail: "Launch bounded unit 2",
      currentStep: "bounded_unit_2_running",
      updatedAt: 210,
    });
    expect(launched.applied).toBe(true);
    if (!launched.applied) {
      throw new Error("Expected next-launch mutation to apply");
    }
    expect(getTaskFlowProductionContinuation(launched.flow)?.nextExecutableUnitLaunched).toBe(true);

    const closed = taskFlow.finish({
      flowId: created.flowId,
      expectedRevision: launched.flow.revision,
      endedAt: 220,
    });
    expect(closed.applied).toBe(true);
  });

  it("allows runtime-managed lawful blocker state without pretending the flow can close", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
    });

    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Wait on real blocker",
        status: "running",
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      }),
    );

    const blocked = taskFlow.recordLawfulStop({
      flowId: created.flowId,
      expectedRevision: created.revision,
      reason: "blocker",
      detail: "Approval token missing.",
      currentStep: "approval_blocked",
      updatedAt: 230,
    });
    expect(blocked.applied).toBe(true);
    if (!blocked.applied) {
      throw new Error("Expected lawful blocker mutation to apply");
    }
    expect(blocked.flow.status).toBe("blocked");
    expect(getTaskFlowProductionContinuation(blocked.flow)?.lawfulStopReason).toBe("blocker");
    expect(getTaskFlowById(created.flowId)?.currentStep).toBe("approval_blocked");
  });
});
