import { describe, expect, it } from "vitest";
import { resolveTaskBuildExecutionTruth } from "../../tasks/task-build-execution-truth.js";
import {
  createManagedTaskFlow,
  finishFlow,
  recordFlowLawfulStop,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-flow-runtime-internal.js";
import {
  createTaskRecord,
  findTaskByRunId,
  resetTaskRegistryForTests,
} from "../../tasks/task-registry.js";
import { createMediaGenerationTaskLifecycle } from "./media-generate-background-shared.js";

function createLifecycle() {
  return createMediaGenerationTaskLifecycle({
    toolName: "image_generate",
    taskKind: "image-generate",
    label: "Image generation",
    queuedProgressSummary: "Queued image generation.",
    generatedLabel: "image",
    failureProgressSummary: "Image generation failed.",
    eventSource: "tool",
    announceType: "Image generation",
    completionLabel: "image",
  });
}

describe("media-generate-background-shared integration", () => {
  it("inherits real parent production linkage for media background task lifecycle calls", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:parent",
      controllerId: "tests/media-background-parent",
      goal: "Continue media background production parent",
      status: "running",
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
    });
    const blockedClose = finishFlow({
      flowId: flow!.flowId,
      expectedRevision: flow!.revision,
      endedAt: 10,
    });
    if (blockedClose.applied || !blockedClose.current) {
      throw new Error("Expected continuation-required media background parent flow");
    }
    const missionTask = createTaskRecord({
      runtime: "cli",
      ownerKey: "agent:main:parent",
      requesterSessionKey: "agent:main:parent",
      scopeKind: "session",
      parentFlowId: blockedClose.current.flowId,
      task: "Media background parent run",
      missionId: "mission-media-background-parent",
      missionSummary: "Launch the next media unit before pause",
      missionState: "active",
      status: "running",
      deliveryStatus: "pending",
    });
    if (!missionTask) {
      throw new Error("Expected media background mission task");
    }

    const lifecycle = createLifecycle();
    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:parent",
      prompt: "Generate a production image",
    });
    if (!handle) {
      throw new Error("Expected media background task handle");
    }

    lifecycle.completeTaskRun({
      handle,
      provider: "openai",
      model: "gpt-image-1",
      count: 1,
      paths: ["/tmp/output.png"],
    });

    const task = findTaskByRunId(handle.runId);
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

  it("does not invent parent linkage for standalone media background work", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const lifecycle = createLifecycle();
    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:standalone",
      prompt: "Generate a standalone image",
    });
    if (!handle) {
      throw new Error("Expected standalone media background task handle");
    }

    lifecycle.completeTaskRun({
      handle,
      provider: "openai",
      model: "gpt-image-1",
      count: 1,
      paths: ["/tmp/output.png"],
    });

    const task = findTaskByRunId(handle.runId);
    expect(task?.parentFlowId).toBeUndefined();
    expect(task?.parentTaskId).toBeUndefined();
    expect(resolveTaskBuildExecutionTruth(task!)).toMatchObject({
      state: "completed",
      broaderBuildOpen: false,
    });
  });

  it("allows lawful blocker parent state for media background work", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:parent",
      controllerId: "tests/media-background-lawful-stop",
      goal: "Blocked media parent",
      status: "running",
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
    });
    const blockedFlow = recordFlowLawfulStop({
      flowId: flow!.flowId,
      expectedRevision: flow!.revision,
      reason: "blocker",
      detail: "Waiting on media blocker.",
      updatedAt: 20,
    });
    if (!blockedFlow.applied) {
      throw new Error("Expected lawful-stop media background parent flow");
    }
    const missionTask = createTaskRecord({
      runtime: "cli",
      ownerKey: "agent:main:parent",
      requesterSessionKey: "agent:main:parent",
      scopeKind: "session",
      parentFlowId: blockedFlow.flow.flowId,
      task: "Media blocked parent run",
      missionId: "mission-media-background-lawful-stop",
      missionSummary: "Hold on blocker",
      missionState: "active",
      status: "running",
      deliveryStatus: "pending",
    });
    if (!missionTask) {
      throw new Error("Expected media lawful-stop mission task");
    }

    const lifecycle = createLifecycle();
    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:parent",
      prompt: "Generate a blocked image",
    });
    if (!handle) {
      throw new Error("Expected blocked media background task handle");
    }

    lifecycle.completeTaskRun({
      handle,
      provider: "openai",
      model: "gpt-image-1",
      count: 1,
      paths: ["/tmp/output.png"],
    });

    const task = findTaskByRunId(handle.runId);
    expect(task).toMatchObject({
      parentFlowId: blockedFlow.flow.flowId,
      parentTaskId: missionTask.taskId,
      status: "succeeded",
    });
    expect(resolveTaskBuildExecutionTruth(task!)).toMatchObject({
      state: "paused_pending_parent_review",
      broaderBuildOpen: true,
    });
  });
});
