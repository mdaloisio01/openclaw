import { resolveTaskBuildExecutionTruth } from "./task-build-execution-truth.js";
import type { TaskEventRecord, TaskRecord, TaskStatus } from "./task-registry.types.js";
import { formatTaskStatusTitleText, sanitizeTaskStatusText } from "./task-status.js";

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function resolveTaskDisplayTitle(task: TaskRecord): string {
  return formatTaskStatusTitleText(
    task.label?.trim() ||
      (task.runtime === "acp"
        ? "ACP background task"
        : task.runtime === "subagent"
          ? "Subagent task"
          : task.task.trim() || "Background task"),
  );
}

function resolveTaskRunLabel(task: TaskRecord): string {
  return task.runId ? ` (run ${task.runId.slice(0, 8)})` : "";
}

function formatScopeConstrainedCompletionMessage(params: {
  title: string;
  runLabel: string;
  summary: string;
}): string {
  const { title, runLabel, summary } = params;
  const broaderMissionOpen = "Broader build execution is paused pending parent review.";
  return summary
    ? `Background task local result ready for review: ${title}${runLabel}. ${summary} ${broaderMissionOpen}`
    : `Background task local result ready for review: ${title}${runLabel}. ${broaderMissionOpen}`;
}

function formatContinuationRequiredCompletionMessage(params: {
  title: string;
  runLabel: string;
  summary: string;
}): string {
  const { title, runLabel, summary } = params;
  const continuationRequired =
    "Next executable unit must launch before this slice can truthfully pause or close. Broader build execution remains open.";
  return summary
    ? `Background task local result ready for follow-through: ${title}${runLabel}. ${summary} ${continuationRequired}`
    : `Background task local result ready for follow-through: ${title}${runLabel}. ${continuationRequired}`;
}

export function formatTaskTerminalMessage(
  task: TaskRecord,
  options: { surface?: "direct" | "parent_session" } = {},
): string {
  const title = resolveTaskDisplayTitle(task);
  const runLabel = resolveTaskRunLabel(task);
  const summary = sanitizeTaskStatusText(task.terminalSummary, {
    errorContext: task.status !== "succeeded" || task.terminalOutcome === "blocked",
  });
  const buildExecutionTruth = resolveTaskBuildExecutionTruth(task);
  const scopeConstrainedCompletion = buildExecutionTruth.state === "paused_pending_parent_review";
  const continuationRequired =
    buildExecutionTruth.state === "continuation_required_after_local_success";
  if (task.status === "succeeded") {
    if (task.terminalOutcome === "blocked") {
      return summary
        ? `Background task blocked: ${title}${runLabel}. ${summary}`
        : `Background task blocked: ${title}${runLabel}.`;
    }
    if (scopeConstrainedCompletion) {
      return formatScopeConstrainedCompletionMessage({
        title,
        runLabel,
        summary,
      });
    }
    if (continuationRequired) {
      return formatContinuationRequiredCompletionMessage({
        title,
        runLabel,
        summary,
      });
    }
    if (options.surface === "parent_session") {
      const reviewNext =
        "Next: parent will review/verify before calling it done. Broader build execution is paused pending parent review.";
      return summary
        ? `Background task ready for review: ${title}${runLabel}. ${summary} ${reviewNext}`
        : `Background task ready for review: ${title}${runLabel}. ${reviewNext}`;
    }
    return summary
      ? `Background task done: ${title}${runLabel}. ${summary}`
      : `Background task done: ${title}${runLabel}.`;
  }
  if (task.status === "timed_out") {
    return `Background task timed out: ${title}${runLabel}.`;
  }
  if (task.status === "lost") {
    const error = sanitizeTaskStatusText(task.error, { errorContext: true });
    const fallbackSummary = sanitizeTaskStatusText(task.terminalSummary, { errorContext: true });
    return `Background task lost: ${title}${runLabel}. ${error || fallbackSummary || "Backing session disappeared."}`;
  }
  if (task.status === "cancelled") {
    return `Background task cancelled: ${title}${runLabel}.`;
  }
  const error = sanitizeTaskStatusText(task.error, { errorContext: true });
  const fallbackSummary = sanitizeTaskStatusText(task.terminalSummary, { errorContext: true });
  return error
    ? `Background task failed: ${title}${runLabel}. ${error}`
    : fallbackSummary
      ? `Background task failed: ${title}${runLabel}. ${fallbackSummary}`
      : `Background task failed: ${title}${runLabel}.`;
}

export function shouldUseParentReviewTaskTerminalMessage(task: TaskRecord): boolean {
  return (
    task.runtime === "acp" &&
    task.status === "succeeded" &&
    task.terminalOutcome !== "blocked" &&
    Boolean(task.childSessionKey?.trim())
  );
}

export function formatTaskBlockedFollowupMessage(task: TaskRecord): string | null {
  if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
    return null;
  }
  const title = resolveTaskDisplayTitle(task);
  const runLabel = resolveTaskRunLabel(task);
  const summary =
    sanitizeTaskStatusText(task.terminalSummary, { errorContext: true }) ||
    "Task is blocked and needs follow-up.";
  return `Task needs follow-up: ${title}${runLabel}. ${summary}`;
}

export function formatTaskStateChangeMessage(
  task: TaskRecord,
  event: TaskEventRecord,
): string | null {
  const title = resolveTaskDisplayTitle(task);
  if (event.kind === "running") {
    return `Background task started: ${title}.`;
  }
  if (event.kind === "progress") {
    const summary = sanitizeTaskStatusText(event.summary);
    return summary ? `Background task update: ${title}. ${summary}` : null;
  }
  return null;
}

export function shouldAutoDeliverTaskTerminalUpdate(task: TaskRecord): boolean {
  if (task.notifyPolicy === "silent") {
    return false;
  }
  if (task.runtime === "subagent" && task.status !== "cancelled") {
    return false;
  }
  if (!isTerminalTaskStatus(task.status)) {
    return false;
  }
  return task.deliveryStatus === "pending";
}

export function shouldAutoDeliverTaskStateChange(task: TaskRecord): boolean {
  return (
    task.notifyPolicy === "state_changes" &&
    task.deliveryStatus === "pending" &&
    !isTerminalTaskStatus(task.status)
  );
}

export function shouldSuppressDuplicateTerminalDelivery(params: {
  task: TaskRecord;
  preferredTaskId?: string;
}): boolean {
  if (params.task.runtime !== "acp" || !params.task.runId?.trim()) {
    return false;
  }
  return Boolean(params.preferredTaskId && params.preferredTaskId !== params.task.taskId);
}
