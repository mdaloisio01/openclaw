import { resolveTaskBuildExecutionTruth } from "./task-build-execution-truth.js";
import {
  getTaskFlowById,
  getTaskFlowProductionContinuation,
} from "./task-flow-runtime-internal.js";
import {
  compareTaskAuditFindingSortKeys,
  createEmptyTaskAuditSummary,
  type TaskAuditCode,
  type TaskAuditFinding,
  type TaskAuditSeverity,
  type TaskAuditSummary,
} from "./task-registry.audit.shared.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resolveEffectiveTaskCleanupAfter } from "./task-retention.js";

export type TaskAuditOptions = {
  now?: number;
  tasks?: TaskRecord[];
  staleQueuedMs?: number;
  staleRunningMs?: number;
};

export type RetainedLostTaskAuditSummary = {
  count: number;
  nextCleanupAfter?: number;
};

const DEFAULT_STALE_QUEUED_MS = 10 * 60_000;
const DEFAULT_STALE_RUNNING_MS = 30 * 60_000;
export { createEmptyTaskAuditSummary };
export type { TaskAuditCode, TaskAuditFinding, TaskAuditSeverity, TaskAuditSummary };

let taskAuditTaskProvider: () => TaskRecord[] = () => [];

export function configureTaskAuditTaskProvider(provider: () => TaskRecord[]): void {
  taskAuditTaskProvider = provider;
}

function createFinding(params: {
  severity: TaskAuditSeverity;
  code: TaskAuditCode;
  task: TaskRecord;
  detail: string;
  ageMs?: number;
}): TaskAuditFinding {
  return {
    severity: params.severity,
    code: params.code,
    task: params.task,
    detail: params.detail,
    ...(typeof params.ageMs === "number" ? { ageMs: params.ageMs } : {}),
  };
}

function taskReferenceAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

function findTimestampInconsistency(task: TaskRecord): TaskAuditFinding | null {
  if (task.startedAt && task.startedAt < task.createdAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      task,
      detail: "startedAt is earlier than createdAt",
    });
  }
  if (task.endedAt && task.startedAt && task.endedAt < task.startedAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      task,
      detail: "endedAt is earlier than startedAt",
    });
  }
  if ((task.status === "queued" || task.status === "running") && task.endedAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      task,
      detail: `${task.status} task should not already have endedAt`,
    });
  }
  return null;
}

function compareFindings(left: TaskAuditFinding, right: TaskAuditFinding): number {
  return compareTaskAuditFindingSortKeys(
    {
      severity: left.severity,
      ageMs: left.ageMs,
      createdAt: left.task.createdAt,
    },
    {
      severity: right.severity,
      ageMs: right.ageMs,
      createdAt: right.task.createdAt,
    },
  );
}

function taskMissionReferenceAt(task: TaskRecord): number {
  return (
    task.missionUpdatedAt ?? task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt
  );
}

function taskClaimsActiveExecutionWithoutProof(task: TaskRecord): boolean {
  const haystack = [
    task.task,
    task.label,
    task.progressSummary,
    task.terminalSummary,
    task.missionSummary,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .toLowerCase();
  if (!haystack) {
    return false;
  }
  return (
    haystack.includes("owner execution in progress") ||
    haystack.includes("active owner execution is underway") ||
    haystack.includes("active execution is underway")
  );
}

function taskHasQueuedSameSliceReworkWithoutLaunchProof(task: TaskRecord): boolean {
  if (task.status !== "queued" || !task.parentFlowId?.trim()) {
    return false;
  }
  const flow = getTaskFlowById(task.parentFlowId.trim());
  const rework =
    (flow?.stateJson as { rework?: { handbackStatus?: string; transferOwner?: string } } | null)
      ?.rework ?? null;
  return (
    rework?.handbackStatus === "required" &&
    rework.transferOwner !== "Will" &&
    typeof task.progressSummary === "string" &&
    task.progressSummary.includes("REWORK_EXECUTOR_LAUNCH_REQUIRED")
  );
}

function taskFlowReferenceAt(tasks: TaskRecord[]): number {
  return Math.max(
    ...tasks.map((task) => task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt),
  );
}

function hasActiveProductionParentFlow(parentFlowId: string): boolean {
  const flow = getTaskFlowById(parentFlowId);
  if (!flow || flow.status !== "running") {
    return false;
  }
  const continuation = getTaskFlowProductionContinuation(flow);
  if (!continuation?.activeProductionRun) {
    return false;
  }
  return (
    !continuation.lawfulWholeRunCompletion &&
    !continuation.blockerPresent &&
    !continuation.ownerDecisionRequired &&
    !continuation.restartOrReloadRequired &&
    !continuation.hardStopPresent &&
    !continuation.safetyStopPresent
  );
}

export function listTaskAuditFindings(options: TaskAuditOptions = {}): TaskAuditFinding[] {
  const tasks = options.tasks ?? taskAuditTaskProvider();
  const now = options.now ?? Date.now();
  const staleQueuedMs = options.staleQueuedMs ?? DEFAULT_STALE_QUEUED_MS;
  const staleRunningMs = options.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
  const findings: TaskAuditFinding[] = [];

  for (const task of tasks) {
    const referenceAt = taskReferenceAt(task);
    const ageMs = Math.max(0, now - referenceAt);

    if (task.status === "queued" && ageMs >= staleQueuedMs) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "stale_queued",
          task,
          ageMs,
          detail: "queued task has not advanced recently",
        }),
      );
    }

    if (task.status === "running" && ageMs >= staleRunningMs) {
      findings.push(
        createFinding({
          severity: "error",
          code: "stale_running",
          task,
          ageMs,
          detail: "running task appears stuck",
        }),
      );
    }

    if (task.status === "lost") {
      const retainedUntilCleanup =
        typeof task.cleanupAfter === "number" && resolveEffectiveTaskCleanupAfter(task) > now;
      findings.push(
        createFinding({
          severity: retainedUntilCleanup ? "warn" : "error",
          code: "lost",
          task,
          ageMs,
          detail: retainedUntilCleanup
            ? task.error?.trim() ||
              "task lost its backing session and is retained until cleanupAfter"
            : task.error?.trim() || "task lost its backing session",
        }),
      );
    }

    if (task.deliveryStatus === "failed" && task.notifyPolicy !== "silent") {
      findings.push(
        createFinding({
          severity: "warn",
          code: "delivery_failed",
          task,
          ageMs,
          detail: "terminal update delivery failed",
        }),
      );
    }

    if (
      task.status !== "lost" &&
      task.status !== "queued" &&
      task.status !== "running" &&
      typeof task.cleanupAfter !== "number"
    ) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "missing_cleanup",
          task,
          ageMs,
          detail: "terminal task is missing cleanupAfter",
        }),
      );
    }

    const inconsistency = findTimestampInconsistency(task);
    if (inconsistency) {
      findings.push(inconsistency);
    }
  }

  const tasksByMissionId = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const missionId = task.missionId?.trim();
    if (!missionId) {
      continue;
    }
    const current = tasksByMissionId.get(missionId);
    if (current) {
      current.push(task);
    } else {
      tasksByMissionId.set(missionId, [task]);
    }
  }

  for (const missionTasks of tasksByMissionId.values()) {
    const latestTask = [...missionTasks].toSorted((left, right) => {
      const diff = taskMissionReferenceAt(right) - taskMissionReferenceAt(left);
      if (diff !== 0) {
        return diff;
      }
      return right.createdAt - left.createdAt;
    })[0];
    if (!latestTask) {
      continue;
    }
    const truth = resolveTaskBuildExecutionTruth(latestTask);
    const latestAgeMs = Math.max(0, now - taskMissionReferenceAt(latestTask));
    const hasActiveExecutor = missionTasks.some((task) => task.status === "running");
    const allRelatedTasksTerminal = missionTasks.every(
      (task) => task.status !== "queued" && task.status !== "running",
    );

    if (taskHasQueuedSameSliceReworkWithoutLaunchProof(latestTask) && !hasActiveExecutor) {
      findings.push(
        createFinding({
          severity: "error",
          code: "rework_follow_through_violation",
          task: latestTask,
          ageMs: latestAgeMs,
          detail:
            "same-slice rework packet is queued, but no launched/running executor proof exists for the next lawful rework run",
        }),
      );
    }

    if (latestTask.status === "queued" && latestAgeMs >= staleQueuedMs) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "accepted_not_yet_proven_active_too_long",
          task: latestTask,
          ageMs: latestAgeMs,
          detail: "accepted task has stayed queued too long without proving active execution",
        }),
      );
      findings.push(
        createFinding({
          severity: "warn",
          code: "routed_to_owner_not_proven_active",
          task: latestTask,
          ageMs: latestAgeMs,
          detail: "work appears routed or accepted, but active owner execution is still not proven",
        }),
      );
    }

    if (truth.state === "continuation_required_after_local_success" && !hasActiveExecutor) {
      findings.push(
        createFinding({
          severity: "error",
          code: "parent_continuity_violation",
          task: latestTask,
          ageMs: latestAgeMs,
          detail:
            "active production continuation requires the next executable unit to launch, but no active executor is currently running",
        }),
      );
    }

    if (
      truth.state === "paused_pending_parent_review" &&
      !hasActiveExecutor &&
      latestAgeMs >= staleQueuedMs
    ) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "parent_review_state_without_active_executor",
          task: latestTask,
          ageMs: latestAgeMs,
          detail:
            "latest mission state is paused pending parent review, but no active executor is currently running",
        }),
      );
      findings.push(
        createFinding({
          severity: "warn",
          code: "owner_readout_finished_no_followthrough",
          task: latestTask,
          ageMs: latestAgeMs,
          detail:
            "local readout or review-ready work finished, but no next-owner execution followthrough is currently running",
        }),
      );
    }

    if (truth.broaderBuildOpen && !hasActiveExecutor && latestAgeMs >= staleQueuedMs) {
      findings.push(
        createFinding({
          severity: "error",
          code: "open_build_no_active_owner",
          task: latestTask,
          ageMs: latestAgeMs,
          detail:
            "latest mission state says the broader build is still open, but no task in that mission is actively running now",
        }),
      );
    }

    if (truth.broaderBuildOpen && allRelatedTasksTerminal && latestAgeMs >= staleQueuedMs) {
      findings.push(
        createFinding({
          severity: "error",
          code: "build_open_all_related_sessions_terminal",
          task: latestTask,
          ageMs: latestAgeMs,
          detail:
            "broader build is still open, but every related task in the mission is already terminal",
        }),
      );
    }

    if (truth.state !== "active_confirmed" && taskClaimsActiveExecutionWithoutProof(latestTask)) {
      findings.push(
        createFinding({
          severity: "error",
          code: "execution_truth_conflicts_with_status_text",
          task: latestTask,
          ageMs: latestAgeMs,
          detail:
            "task text claims active execution, but runtime execution truth does not prove an active executor",
        }),
      );
    }
  }

  const tasksByParentFlowId = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const parentFlowId = task.parentFlowId?.trim();
    if (!parentFlowId) {
      continue;
    }
    const current = tasksByParentFlowId.get(parentFlowId);
    if (current) {
      current.push(task);
    } else {
      tasksByParentFlowId.set(parentFlowId, [task]);
    }
  }

  for (const [parentFlowId, flowTasks] of tasksByParentFlowId.entries()) {
    if (!hasActiveProductionParentFlow(parentFlowId)) {
      continue;
    }
    const hasActiveExecutor = flowTasks.some(
      (task) => task.status === "queued" || task.status === "running",
    );
    const hasLostChild = flowTasks.some((task) => task.status === "lost");
    if (hasActiveExecutor || !hasLostChild) {
      continue;
    }
    const latestTask = [...flowTasks].toSorted((left, right) => {
      const diff = taskFlowReferenceAt([right]) - taskFlowReferenceAt([left]);
      if (diff !== 0) {
        return diff;
      }
      return right.createdAt - left.createdAt;
    })[0];
    if (!latestTask) {
      continue;
    }
    const latestAgeMs = Math.max(0, now - taskFlowReferenceAt(flowTasks));
    findings.push(
      createFinding({
        severity: "error",
        code: "open_build_no_active_owner",
        task: latestTask,
        ageMs: latestAgeMs,
        detail:
          "active production parent TaskFlow has a lost terminal child and no active child owner",
      }),
    );
    findings.push(
      createFinding({
        severity: "error",
        code: "build_open_all_related_sessions_terminal",
        task: latestTask,
        ageMs: latestAgeMs,
        detail:
          "active production parent TaskFlow is still open, but every linked child task is terminal",
      }),
    );
  }

  return findings.toSorted(compareFindings);
}

export function isRetainedLostTaskAuditFinding(
  finding: TaskAuditFinding,
  now = Date.now(),
): boolean {
  const cleanupAfter = resolveEffectiveTaskCleanupAfter(finding.task);
  return (
    finding.code === "lost" &&
    finding.task.status === "lost" &&
    typeof finding.task.cleanupAfter === "number" &&
    cleanupAfter > now
  );
}

export function summarizeTaskAuditFindings(findings: Iterable<TaskAuditFinding>): TaskAuditSummary {
  const summary = createEmptyTaskAuditSummary();
  for (const finding of findings) {
    summary.total += 1;
    summary.byCode[finding.code] += 1;
    if (finding.severity === "error") {
      summary.errors += 1;
    } else {
      summary.warnings += 1;
    }
  }
  return summary;
}

export function summarizeActionableTaskAuditFindings(
  findings: Iterable<TaskAuditFinding>,
  options: { now?: number } = {},
): TaskAuditSummary {
  const now = options.now ?? Date.now();
  return summarizeTaskAuditFindings(
    Array.from(findings).filter((finding) => !isRetainedLostTaskAuditFinding(finding, now)),
  );
}

export function summarizeRetainedLostTaskAuditFindings(
  findings: Iterable<TaskAuditFinding>,
  options: { now?: number } = {},
): RetainedLostTaskAuditSummary {
  const now = options.now ?? Date.now();
  let count = 0;
  let nextCleanupAfter: number | undefined;
  for (const finding of findings) {
    if (!isRetainedLostTaskAuditFinding(finding, now)) {
      continue;
    }
    count += 1;
    const cleanupAfter = resolveEffectiveTaskCleanupAfter(finding.task);
    if (
      typeof cleanupAfter === "number" &&
      (nextCleanupAfter === undefined || cleanupAfter < nextCleanupAfter)
    ) {
      nextCleanupAfter = cleanupAfter;
    }
  }
  return {
    count,
    ...(nextCleanupAfter !== undefined ? { nextCleanupAfter } : {}),
  };
}
