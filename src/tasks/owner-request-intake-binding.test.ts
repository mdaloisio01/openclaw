import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOwnerRequestIntakeBinding } from "./owner-request-intake-binding.js";
import type { TaskRecord } from "./task-registry.types.js";

const mocks = vi.hoisted(() => ({ entry: vi.fn(), tasks: vi.fn(), flow: vi.fn() }));
vi.mock("../acp/runtime/session-meta.js", () => ({
  findAcpSessionEntryByBackendSessionId: mocks.entry,
}));
vi.mock("./task-registry.js", () => ({ listTasksForSessionKey: mocks.tasks }));
vi.mock("./task-flow-registry.js", () => ({ getTaskFlowById: mocks.flow }));

describe("managed owner request intake binding", () => {
  const outerKey = "agent:worker:acp:outer";
  const task: TaskRecord = {
    taskId: "outer-task",
    runId: "outer-run",
    runtime: "acp",
    childSessionKey: outerKey,
    ownerKey: "agent:main:main",
    requesterSessionKey: "agent:main:main",
    scopeKind: "session",
    task: "bounded acknowledgement",
    status: "running",
    createdAt: 1,
    startedAt: 2,
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
  };
  const params = {
    sessionKey: "agent:main:acp-bridge:backend-session",
    expectedDurability: "taskflow_or_exemption",
    cfg: {},
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entry.mockReturnValue({ sessionKey: outerKey, acp: { state: "running" } });
    mocks.tasks.mockReturnValue([task]);
    mocks.flow.mockReturnValue(undefined);
  });

  it("binds the unique active outer execution using the backend session identity", () => {
    expect(resolveOwnerRequestIntakeBinding(params)).toEqual({ taskId: "outer-task" });
    expect(mocks.entry).toHaveBeenCalledWith({ backendSessionId: "backend-session", cfg: {} });
    expect(mocks.tasks).toHaveBeenCalledWith(outerKey);
  });

  it.each([
    { name: "missing", tasks: [] },
    { name: "terminal", tasks: [{ ...task, status: "succeeded", endedAt: 3 }] },
    { name: "ambiguous", tasks: [task, { ...task, taskId: "competing-task" }] },
  ])("keeps $name execution unbound", ({ tasks }) => {
    mocks.tasks.mockReturnValue(tasks);
    expect(resolveOwnerRequestIntakeBinding(params)).toBeUndefined();
  });

  it("does not bind an absent or idle bridge owner", () => {
    mocks.entry.mockReturnValue(undefined);
    expect(resolveOwnerRequestIntakeBinding(params)).toBeUndefined();
    mocks.entry.mockReturnValue({ sessionKey: outerKey, acp: { state: "idle" } });
    expect(resolveOwnerRequestIntakeBinding(params)).toBeUndefined();
    expect(mocks.tasks).not.toHaveBeenCalled();
  });

  it("requires an actual active parent flow for taskflow-required work", () => {
    expect(
      resolveOwnerRequestIntakeBinding({ ...params, expectedDurability: "taskflow_required" }),
    ).toBeUndefined();
    mocks.tasks.mockReturnValue([{ ...task, parentFlowId: "parent-flow" }]);
    mocks.flow.mockReturnValue({ flowId: "parent-flow", status: "running" });
    expect(
      resolveOwnerRequestIntakeBinding({ ...params, expectedDurability: "taskflow_required" }),
    ).toEqual({ taskId: "outer-task", taskFlowId: "parent-flow" });
    mocks.flow.mockReturnValue({ flowId: "parent-flow", status: "succeeded" });
    expect(resolveOwnerRequestIntakeBinding(params)).toBeUndefined();
  });
});
