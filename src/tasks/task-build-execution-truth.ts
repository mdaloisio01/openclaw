import {
  getTaskFlowById,
  getTaskFlowProductionContinuation,
} from "./task-flow-runtime-internal.js";
import type {
  TaskBuildExecutionTruth,
  TaskRecord,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

function hasParentReviewBoundary(
  task: Pick<
    TaskRecord,
    | "missionState"
    | "parentTaskId"
    | "parentFlowId"
    | "runtime"
    | "childSessionKey"
    | "status"
    | "terminalOutcome"
  >,
): boolean {
  if (
    task.missionState === "subordinate" ||
    task.parentTaskId?.trim() ||
    task.parentFlowId?.trim()
  ) {
    return true;
  }
  return (
    task.runtime === "acp" &&
    task.status === "succeeded" &&
    task.terminalOutcome !== "blocked" &&
    Boolean(task.childSessionKey?.trim())
  );
}

function isFailureLikeStatus(status: TaskStatus, terminalOutcome?: TaskTerminalOutcome): boolean {
  return (
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost" ||
    terminalOutcome === "blocked"
  );
}

function continuationRequiredAfterLocalSuccess(task: Pick<TaskRecord, "parentFlowId">): boolean {
  const parentFlowId = task.parentFlowId?.trim();
  if (!parentFlowId) {
    return false;
  }
  const flow = getTaskFlowById(parentFlowId);
  if (!flow) {
    return false;
  }
  const continuation = getTaskFlowProductionContinuation(flow);
  return (
    continuation?.activeProductionRun === true &&
    continuation.continuationRequiredAfterLocalSuccess === true &&
    continuation.nextExecutableUnitLaunched !== true &&
    continuation.lawfulWholeRunCompletion !== true &&
    continuation.blockerPresent !== true &&
    continuation.ownerDecisionRequired !== true &&
    continuation.restartOrReloadRequired !== true &&
    continuation.hardStopPresent !== true &&
    continuation.safetyStopPresent !== true
  );
}

export function resolveTaskBuildExecutionTruth(
  task: Pick<
    TaskRecord,
    | "status"
    | "terminalOutcome"
    | "missionState"
    | "parentTaskId"
    | "parentFlowId"
    | "runtime"
    | "childSessionKey"
  >,
): TaskBuildExecutionTruth {
  if (task.status === "queued") {
    return {
      state: "accepted",
      broaderBuildOpen: true,
      proofSummary: "Task is queued, so work is accepted but active execution is not yet proven.",
    };
  }
  if (task.status === "running") {
    return {
      state: "active_confirmed",
      broaderBuildOpen: true,
      proofSummary: "Task status is running, so this execution slice is actively running now.",
    };
  }
  if (isFailureLikeStatus(task.status, task.terminalOutcome)) {
    return {
      state: "blocked",
      broaderBuildOpen: true,
      proofSummary:
        task.terminalOutcome === "blocked"
          ? "Task reported a blocked terminal outcome, so the broader build remains open."
          : "Task ended in a non-success terminal state, so the broader build remains open.",
    };
  }
  if (task.status === "succeeded" && continuationRequiredAfterLocalSuccess(task)) {
    return {
      state: "continuation_required_after_local_success",
      broaderBuildOpen: true,
      proofSummary:
        "This local execution slice passed, but active production continuation still requires the next executable unit to launch before pause or closeout.",
    };
  }
  if (task.status === "succeeded" && hasParentReviewBoundary(task)) {
    return {
      state: "paused_pending_parent_review",
      broaderBuildOpen: true,
      proofSummary:
        "This task completed a local execution slice, but broader build execution remains open pending parent review.",
    };
  }
  return {
    state: "completed",
    broaderBuildOpen: false,
    proofSummary:
      "Task reached a successful terminal state with no remaining parent-review boundary.",
  };
}
