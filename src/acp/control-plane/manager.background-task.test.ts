import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTaskBuildExecutionTruth } from "../../tasks/task-build-execution-truth.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-runtime-internal.js";
import {
  createManagedTaskFlow,
  finishFlow,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  recordFlowLawfulStop,
} from "../../tasks/task-flow-runtime-internal.js";
import {
  createTaskRecord,
  findTaskByRunId,
  resetTaskRegistryForTests,
} from "../../tasks/task-registry.js";
import {
  createBackgroundTaskRecord,
  markBackgroundTaskTerminal,
  resolveBackgroundTaskContext,
} from "./manager.background-task.js";
import type { AcpSessionManagerDeps } from "./manager.types.js";

function makeDeps(entries: Record<string, Partial<SessionEntry>>): AcpSessionManagerDeps {
  return {
    listAcpSessions: () => [],
    readSessionEntry: ({ sessionKey }: { sessionKey: string }) => {
      const entry = entries[sessionKey];
      return entry
        ? {
            sessionKey,
            entry: entry as SessionEntry,
          }
        : undefined;
    },
    upsertSessionMeta: async () => {
      throw new Error("not used");
    },
    getRuntimeBackend: () => undefined,
    requireRuntimeBackend: () => {
      throw new Error("not used");
    },
  };
}

describe("acp background-task continuation linkage", () => {
  const cfg = {} as OpenClawConfig;

  it("inherits real active parent production linkage for ACP background task records", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:parent",
      controllerId: "tests/acp-background-parent",
      goal: "Continue ACP background production parent",
      status: "running",
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
    });
    const blockedClose = finishFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      endedAt: 200,
    });
    if (blockedClose.applied || !blockedClose.current) {
      throw new Error("Expected continuation-required ACP background parent flow");
    }
    const missionTask = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:parent",
      requesterSessionKey: "agent:main:parent",
      scopeKind: "session",
      parentFlowId: blockedClose.current.flowId,
      task: "ACP background parent run",
      missionId: "mission-acp-background-parent",
      missionSummary: "Launch the next ACP bounded unit before pause",
      missionState: "active",
      status: "running",
      deliveryStatus: "pending",
    });
    if (!missionTask) {
      throw new Error("Expected ACP background mission task");
    }

    const context = resolveBackgroundTaskContext({
      deps: makeDeps({
        "agent:main:child": {
          spawnedBy: "agent:main:parent",
          parentSessionKey: "agent:main:parent",
          label: "ACP background task",
        },
        "agent:main:parent": {},
      }),
      cfg,
      sessionKey: "agent:main:child",
      requestId: "acp-bg-run-1",
      text: "Write the next ACP bounded unit",
    });

    expect(context).toMatchObject({
      requesterSessionKey: "agent:main:parent",
      childSessionKey: "agent:main:child",
      parentFlowId: blockedClose.current.flowId,
      parentTaskId: missionTask.taskId,
    });

    createBackgroundTaskRecord(context!, 500);
    markBackgroundTaskTerminal("acp-bg-run-1", {
      sessionKey: "agent:main:child",
      status: "succeeded",
      endedAt: 550,
      lastEventAt: 550,
      terminalSummary: "ACP bounded unit passed.",
    });

    const task = findTaskByRunId("acp-bg-run-1");
    expect(task).toMatchObject({
      runtime: "acp",
      childSessionKey: "agent:main:child",
      parentFlowId: blockedClose.current.flowId,
      parentTaskId: missionTask.taskId,
      status: "succeeded",
    });
    expect(resolveTaskBuildExecutionTruth(task!)).toMatchObject({
      state: "continuation_required_after_local_success",
      broaderBuildOpen: true,
    });
  });

  it("does not invent parent linkage for standalone ACP background work", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const context = resolveBackgroundTaskContext({
      deps: makeDeps({
        "agent:main:child": {
          spawnedBy: "agent:main:standalone-parent",
          parentSessionKey: "agent:main:standalone-parent",
          label: "ACP background task",
        },
        "agent:main:standalone-parent": {},
      }),
      cfg,
      sessionKey: "agent:main:child",
      requestId: "acp-bg-run-standalone",
      text: "Standalone ACP bounded unit",
    });

    createBackgroundTaskRecord(context!, 600);
    markBackgroundTaskTerminal("acp-bg-run-standalone", {
      sessionKey: "agent:main:child",
      status: "succeeded",
      endedAt: 650,
      lastEventAt: 650,
      terminalSummary: "Standalone ACP bounded unit passed.",
    });

    const task = findTaskByRunId("acp-bg-run-standalone");
    const linkedFlow = getTaskFlowById(task!.parentFlowId!);
    expect(linkedFlow?.ownerKey).toBe("agent:main:standalone-parent");
    expect(getTaskFlowProductionContinuation(linkedFlow!)).toBeNull();
    expect(resolveTaskBuildExecutionTruth(task!)).toMatchObject({
      state: "paused_pending_parent_review",
      broaderBuildOpen: true,
    });
  });

  it("allows lawful blocker stop on the parent flow without inventing continuation debt", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:parent",
      controllerId: "tests/acp-background-lawful-stop",
      goal: "Blocked ACP parent",
      status: "running",
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
    });
    const blockedFlow = recordFlowLawfulStop({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      reason: "blocker",
      detail: "Waiting on ACP blocker.",
      updatedAt: 300,
    });
    if (!blockedFlow.applied) {
      throw new Error("Expected lawful-stop ACP background parent flow");
    }
    const missionTask = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:parent",
      requesterSessionKey: "agent:main:parent",
      scopeKind: "session",
      parentFlowId: blockedFlow.flow.flowId,
      task: "ACP blocked parent run",
      missionId: "mission-acp-background-lawful-stop",
      missionSummary: "Hold on blocker",
      missionState: "active",
      status: "running",
      deliveryStatus: "pending",
    });
    if (!missionTask) {
      throw new Error("Expected ACP lawful-stop mission task");
    }

    const context = resolveBackgroundTaskContext({
      deps: makeDeps({
        "agent:main:child": {
          spawnedBy: "agent:main:parent",
          parentSessionKey: "agent:main:parent",
          label: "ACP background task",
        },
        "agent:main:parent": {},
      }),
      cfg,
      sessionKey: "agent:main:child",
      requestId: "acp-bg-run-blocked",
      text: "ACP bounded unit with lawful parent blocker",
    });

    expect(context).toMatchObject({
      parentFlowId: blockedFlow.flow.flowId,
      parentTaskId: missionTask.taskId,
    });

    createBackgroundTaskRecord(context!, 700);
    markBackgroundTaskTerminal("acp-bg-run-blocked", {
      sessionKey: "agent:main:child",
      status: "succeeded",
      endedAt: 750,
      lastEventAt: 750,
      terminalSummary: "ACP bounded unit passed while parent blocker remained.",
    });

    expect(resolveTaskBuildExecutionTruth(findTaskByRunId("acp-bg-run-blocked")!)).toMatchObject({
      state: "paused_pending_parent_review",
      broaderBuildOpen: true,
    });
  });
});
