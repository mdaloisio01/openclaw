import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listTasksForFlowId, recordTaskProgressByRunId } from "./runtime-internal.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  getTaskFlowProductionContinuation,
  listTaskFlowsForOwnerKey,
  resumeFlow,
} from "./task-flow-runtime-internal.js";
import { createTaskRecord } from "./task-registry.js";

const FOREGROUND_CLEANUP_CREW_CONTROLLER_ID = "cleanup-crew/foreground-production";
const FOREGROUND_CLEANUP_CREW_TASK_KIND = "foreground_cleanup_crew_execution";
const FOREGROUND_CLEANUP_CREW_SOURCE_ID = "cleanup-crew:foreground";

type ForegroundCleanupCrewTracking = {
  packetId?: string;
  stageId?: string;
  activeValidationCommand?: string;
};

export type ForegroundCleanupCrewTaskFlowRegistrationResult =
  | { status: "skipped"; reason: string }
  | { status: "registered"; flow: TaskFlowRecord; taskId?: string }
  | { status: "attached"; flow: TaskFlowRecord; taskId?: string }
  | { status: "blocked"; reason: string };

function normalizeText(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function isExplicitReportOnlyOrStop(text: string): boolean {
  return [
    "report only",
    "report-only",
    "status only",
    "status-only",
    "only report",
    "just report",
    "stop after this",
    "stop now",
    "do not continue",
    "don't continue",
  ].some((phrase) => text.includes(phrase));
}

export function isForegroundCleanupCrewProductionMission(text: string | undefined): boolean {
  const normalized = normalizeText(text);
  if (!normalized.includes("cleanup crew") && !normalized.includes("cleanup-crew")) {
    return false;
  }
  if (isExplicitReportOnlyOrStop(normalized)) {
    return false;
  }
  return [
    "production",
    "build",
    "repair",
    "runtime",
    "packet",
    "100%",
    "full validation",
    "watchdog",
  ].some((phrase) => normalized.includes(phrase));
}

function isOpenProductionFlow(flow: TaskFlowRecord): boolean {
  const continuation = getTaskFlowProductionContinuation(flow);
  return (
    flow.syncMode === "managed" &&
    flow.controllerId === FOREGROUND_CLEANUP_CREW_CONTROLLER_ID &&
    (flow.status === "queued" || flow.status === "running" || flow.status === "blocked") &&
    continuation?.activeProductionRun === true &&
    continuation.parentRunOpen === true &&
    continuation.lawfulWholeRunCompletion !== true
  );
}

function findForegroundCleanupCrewFlow(ownerKey: string): TaskFlowRecord | undefined {
  return listTaskFlowsForOwnerKey(ownerKey).find(isOpenProductionFlow);
}

function normalizeTracking(params: {
  packetId?: string | null;
  stageId?: string | null;
  activeValidationCommand?: string | null;
}): ForegroundCleanupCrewTracking {
  return {
    ...(normalizeOptionalString(params.packetId)
      ? { packetId: normalizeOptionalString(params.packetId)! }
      : {}),
    ...(normalizeOptionalString(params.stageId)
      ? { stageId: normalizeOptionalString(params.stageId)! }
      : {}),
    ...(normalizeOptionalString(params.activeValidationCommand)
      ? { activeValidationCommand: normalizeOptionalString(params.activeValidationCommand)! }
      : {}),
  };
}

function buildProgressSummary(tracking: ForegroundCleanupCrewTracking): string {
  const parts = ["Foreground Cleanup Crew mission is active in this source conversation."];
  if (tracking.packetId) {
    parts.push(`packet=${tracking.packetId}`);
  }
  if (tracking.stageId) {
    parts.push(`stage=${tracking.stageId}`);
  }
  if (tracking.activeValidationCommand) {
    parts.push(`validation=${tracking.activeValidationCommand}`);
  }
  return parts.join(" ");
}

function applyTrackingToStateJson(
  stateJson: TaskFlowRecord["stateJson"],
  tracking: ForegroundCleanupCrewTracking,
): TaskFlowRecord["stateJson"] {
  const current =
    stateJson && typeof stateJson === "object" && !Array.isArray(stateJson) ? stateJson : {};
  return {
    ...current,
    ...(tracking.packetId ? { currentPacketId: tracking.packetId } : {}),
    ...(tracking.stageId ? { currentStageId: tracking.stageId } : {}),
    ...(tracking.activeValidationCommand
      ? { activeValidationCommand: tracking.activeValidationCommand }
      : {}),
  };
}

function ensureForegroundExecutionTask(params: {
  flow: TaskFlowRecord;
  ownerKey: string;
  sessionKey: string;
  now: number;
  tracking?: ForegroundCleanupCrewTracking;
}): string | undefined {
  const existing = listTasksForFlowId(params.flow.flowId).find(
    (task) =>
      task.sourceId === FOREGROUND_CLEANUP_CREW_SOURCE_ID &&
      (task.status === "queued" || task.status === "running"),
  );
  if (existing) {
    if (existing.runId) {
      const progressSummary = buildProgressSummary(params.tracking ?? {});
      recordTaskProgressByRunId({
        runId: existing.runId,
        runtime: existing.runtime,
        sessionKey: existing.childSessionKey,
        lastEventAt: params.now,
        progressSummary,
        eventSummary: progressSummary,
      });
    }
    return existing.taskId;
  }
  const progressSummary = buildProgressSummary(params.tracking ?? {});
  const task = createTaskRecord({
    runtime: "cli",
    taskKind: FOREGROUND_CLEANUP_CREW_TASK_KIND,
    sourceId: FOREGROUND_CLEANUP_CREW_SOURCE_ID,
    requesterSessionKey: params.sessionKey,
    ownerKey: params.ownerKey,
    scopeKind: "session",
    parentFlowId: params.flow.flowId,
    runId: `foreground-cleanup-crew:${params.flow.flowId}`,
    label: "Foreground Cleanup Crew execution",
    task: "Represent foreground Cleanup Crew execution inside active-production TaskFlow",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    startedAt: params.now,
    lastEventAt: params.now,
    progressSummary,
  });
  return task?.taskId;
}

export function ensureForegroundCleanupCrewTaskFlow(params: {
  sessionKey?: string | null;
  currentTurnText?: string | null;
  authorityPath?: string | null;
  authorityBasis?: string | null;
  ownerLane?: string | null;
  packetId?: string | null;
  stageId?: string | null;
  activeValidationCommand?: string | null;
  now?: number;
}): ForegroundCleanupCrewTaskFlowRegistrationResult {
  const currentTurnText = normalizeOptionalString(params.currentTurnText);
  if (!isForegroundCleanupCrewProductionMission(currentTurnText)) {
    return { status: "skipped", reason: "not_cleanup_crew_production_mission" };
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return { status: "blocked", reason: "active_mission_identity_missing" };
  }
  const ownerKey = sessionKey;
  const now = params.now ?? Date.now();
  const tracking = normalizeTracking(params);
  const existing = findForegroundCleanupCrewFlow(ownerKey);
  if (existing) {
    const trackedStateJson = applyTrackingToStateJson(existing.stateJson, tracking);
    const flow =
      existing.status === "running" &&
      JSON.stringify(existing.stateJson) === JSON.stringify(trackedStateJson)
        ? existing
        : resumeFlow({
              flowId: existing.flowId,
              expectedRevision: existing.revision,
              status: "running",
              currentStep: tracking.stageId ?? "foreground_cleanup_crew_resumed",
              stateJson: trackedStateJson,
              updatedAt: now,
            }).applied
          ? (findForegroundCleanupCrewFlow(ownerKey) ?? existing)
          : existing;
    return {
      status: "attached",
      flow,
      taskId: ensureForegroundExecutionTask({ flow, ownerKey, sessionKey, now, tracking }),
    };
  }

  const authorityPath =
    normalizeOptionalString(params.authorityPath) ?? "foreground_cleanup_crew_user_instruction";
  const authorityBasis =
    normalizeOptionalString(params.authorityBasis) ??
    "Mark requested a foreground Cleanup Crew production mission.";
  const ownerLane = normalizeOptionalString(params.ownerLane) ?? "Will";
  const flow = createManagedTaskFlow({
    ownerKey,
    controllerId: FOREGROUND_CLEANUP_CREW_CONTROLLER_ID,
    goal: "Foreground Cleanup Crew production mission",
    status: "running",
    notifyPolicy: "done_only",
    currentStep: "foreground_cleanup_crew_registered",
    continuation: {
      activeProductionRun: true,
      parentRunOpen: true,
    },
    stateJson: {
      kind: "cleanup_crew_foreground_production",
      authorityPath,
      authorityBasis,
      ownerLane,
      foregroundExecutionRepresented: true,
      ...(tracking.packetId ? { currentPacketId: tracking.packetId } : {}),
      ...(tracking.stageId ? { currentStageId: tracking.stageId } : {}),
      ...(tracking.activeValidationCommand
        ? { activeValidationCommand: tracking.activeValidationCommand }
        : {}),
    },
    createdAt: now,
    updatedAt: now,
  });
  if (!flow) {
    return { status: "blocked", reason: "taskflow_persistence_failed" };
  }
  return {
    status: "registered",
    flow,
    taskId: ensureForegroundExecutionTask({ flow, ownerKey, sessionKey, now, tracking }),
  };
}
