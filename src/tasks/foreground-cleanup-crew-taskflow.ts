import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createOwnerRequestIntakeRecord,
  markOwnerRequestMissionRegistered,
  markOwnerRequestPromptPersisted,
} from "../agents/owner-request-intake-ledger.js";
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry.js";
import {
  bindActiveSessionTaskToManagedFlowById,
  getTaskById,
  listTasksForFlowId,
  markTaskLostById,
  recordTaskProgressByRunId,
} from "./runtime-internal.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  getTaskFlowActiveProductionContinuation,
  createManagedTaskFlow,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  listTaskFlowRecords,
  listTaskFlowsForOwnerKey,
  recordFlowNextExecutableLaunch,
  resumeFlow,
} from "./task-flow-runtime-internal.js";
import { createTaskRecord } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

const FOREGROUND_CLEANUP_CREW_CONTROLLER_ID = "cleanup-crew/foreground-production";
const FOREGROUND_CLEANUP_CREW_TASK_KIND = "foreground_cleanup_crew_execution";
const FOREGROUND_CLEANUP_CREW_SOURCE_ID = "cleanup-crew:foreground";
const FOREGROUND_CLEANUP_CREW_SUPERSESSION_SOURCE_ID = "cleanup-crew:foreground:supersession";

export const FOREGROUND_CLEANUP_CREW_CHECKPOINT_KINDS = [
  "tool_batch_completed",
  "tool_error_recovery",
  "report_boundary",
  "validation_failure",
  "startup_proof_batch",
  "milestone_delivered",
] as const;

export type ForegroundCleanupCrewCheckpointKind =
  (typeof FOREGROUND_CLEANUP_CREW_CHECKPOINT_KINDS)[number];

type ForegroundCleanupCrewTracking = {
  packetId?: string;
  stageId?: string;
  activeValidationCommand?: string;
  checkpointKind?: ForegroundCleanupCrewCheckpointKind;
  checkpointSummary?: string;
  nextExecutableAction?: string;
};

export type ForegroundCleanupCrewTaskFlowRegistrationResult =
  | { status: "skipped"; reason: string }
  | { status: "registered"; flow: TaskFlowRecord; taskId?: string }
  | { status: "attached"; flow: TaskFlowRecord; taskId?: string }
  | { status: "blocked"; reason: string };

export type ForegroundCleanupCrewExecutorSupersessionResult =
  | {
      status: "superseded";
      flow: TaskFlowRecord;
      task: TaskRecord;
      dispatchReceiptDetail: string;
    }
  | {
      status: "attached";
      flow: TaskFlowRecord;
      task: TaskRecord;
      dispatchReceiptDetail: string;
    }
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

function isLawfullyBlockedWithoutLaunch(flow: TaskFlowRecord): boolean {
  const continuation = getTaskFlowProductionContinuation(flow);
  return (
    flow.status === "blocked" &&
    continuation?.activeProductionRun === true &&
    continuation.parentRunOpen === true &&
    continuation.currentUnitStatus === "blocked" &&
    continuation.lawfulStopReason === "blocker" &&
    continuation.nextExecutableUnitLaunched !== true
  );
}

function findForegroundCleanupCrewFlow(ownerKey: string): TaskFlowRecord | undefined {
  return listTaskFlowsForOwnerKey(ownerKey).find(isOpenProductionFlow);
}

function normalizeTracking(params: {
  packetId?: string | null;
  stageId?: string | null;
  activeValidationCommand?: string | null;
  checkpointKind?: string | null;
  checkpointSummary?: string | null;
  nextExecutableAction?: string | null;
}): ForegroundCleanupCrewTracking {
  const checkpointKind = normalizeOptionalString(params.checkpointKind);
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
    ...(checkpointKind &&
    FOREGROUND_CLEANUP_CREW_CHECKPOINT_KINDS.includes(
      checkpointKind as ForegroundCleanupCrewCheckpointKind,
    )
      ? { checkpointKind: checkpointKind as ForegroundCleanupCrewCheckpointKind }
      : {}),
    ...(normalizeOptionalString(params.checkpointSummary)
      ? { checkpointSummary: normalizeOptionalString(params.checkpointSummary)! }
      : {}),
    ...(normalizeOptionalString(params.nextExecutableAction)
      ? { nextExecutableAction: normalizeOptionalString(params.nextExecutableAction)! }
      : {}),
  };
}

function checkpointRequiresNextAction(tracking: ForegroundCleanupCrewTracking): boolean {
  return Boolean(tracking.checkpointKind);
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
  if (tracking.checkpointKind) {
    parts.push(`checkpoint=${tracking.checkpointKind}`);
  }
  if (tracking.checkpointSummary) {
    parts.push(`summary=${tracking.checkpointSummary}`);
  }
  if (tracking.nextExecutableAction) {
    parts.push(`next=${tracking.nextExecutableAction}`);
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
    ...(tracking.checkpointKind ? { currentCheckpointKind: tracking.checkpointKind } : {}),
    ...(tracking.checkpointSummary ? { currentCheckpointSummary: tracking.checkpointSummary } : {}),
    ...(tracking.nextExecutableAction
      ? { nextExecutableAction: tracking.nextExecutableAction }
      : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settleObsoleteRestartBoundaryStateJson(params: {
  flow: TaskFlowRecord;
  stateJson: TaskFlowRecord["stateJson"];
  tracking: ForegroundCleanupCrewTracking;
  currentStep: string;
  now: number;
}): TaskFlowRecord["stateJson"] {
  if (!params.tracking.checkpointKind || !params.tracking.nextExecutableAction) {
    return params.stateJson;
  }
  const continuation = getTaskFlowProductionContinuation(params.flow);
  if (
    !continuation?.activeProductionRun ||
    continuation.lawfulStopReason !== "restart_or_reload" ||
    continuation.restartOrReloadRequired !== true
  ) {
    return params.stateJson;
  }
  const { lawfulStopReason: _obsoleteStopReason, ...continuationWithoutStopReason } = continuation;
  const detail = `Obsolete restart/reload boundary settled by ${params.tracking.checkpointKind}: ${params.tracking.nextExecutableAction}`;
  const settledContinuation = {
    ...continuationWithoutStopReason,
    currentUnitStatus: "started" as const,
    blockerPresent: false,
    ownerDecisionRequired: false,
    restartOrReloadRequired: false,
    hardStopPresent: false,
    safetyStopPresent: false,
    lawfulWholeRunCompletion: false,
    continuationRequiredAfterLocalSuccess: false,
    nextExecutableUnitIdentified: true,
    nextExecutableUnitLaunched: false,
    continuationViolation: false,
    events: [
      ...continuation.events,
      {
        type: "NEXT_EXECUTABLE_UNIT_IDENTIFIED" as const,
        at: params.now,
        detail,
      },
    ],
  };
  const baseState = isPlainRecord(params.stateJson) ? { ...params.stateJson } : {};
  const flowForProjection: TaskFlowRecord = {
    ...params.flow,
    currentStep: params.currentStep,
    stateJson: {
      ...baseState,
      productionContinuation: settledContinuation,
    },
  };
  const activeProductionContinuation =
    getTaskFlowActiveProductionContinuation(flowForProjection) ?? undefined;
  return {
    ...baseState,
    productionContinuation: settledContinuation,
    ...(activeProductionContinuation ? { activeProductionContinuation } : {}),
  };
}

function refreshCheckpointNextActionProjectionStateJson(params: {
  flow: TaskFlowRecord;
  stateJson: TaskFlowRecord["stateJson"];
  tracking: ForegroundCleanupCrewTracking;
  currentStep: string;
  now: number;
}): TaskFlowRecord["stateJson"] {
  if (!params.tracking.checkpointKind || !params.tracking.nextExecutableAction) {
    return params.stateJson;
  }
  const baseState = isPlainRecord(params.stateJson) ? { ...params.stateJson } : {};
  const flowForProjection: TaskFlowRecord = {
    ...params.flow,
    currentStep: params.currentStep,
    stateJson: baseState,
  };
  const continuation = getTaskFlowProductionContinuation(flowForProjection);
  const activeProductionContinuation = getTaskFlowActiveProductionContinuation(flowForProjection);
  if (
    !continuation ||
    activeProductionContinuation?.status !== "dispatch_required" ||
    !activeProductionContinuation.nextAction
  ) {
    return params.stateJson;
  }
  const refreshedContinuation = {
    ...continuation,
    nextExecutableUnitIdentified: true,
    nextExecutableUnitLaunched: false,
    events: [
      ...continuation.events,
      {
        type: "NEXT_EXECUTABLE_UNIT_IDENTIFIED" as const,
        at: params.now,
        detail: params.tracking.nextExecutableAction,
      },
    ],
  };
  const refreshedFlowForProjection: TaskFlowRecord = {
    ...flowForProjection,
    stateJson: {
      ...baseState,
      productionContinuation: refreshedContinuation,
    },
  };
  const refreshedActiveProductionContinuation =
    getTaskFlowActiveProductionContinuation(refreshedFlowForProjection) ??
    activeProductionContinuation;
  return {
    ...baseState,
    productionContinuation: refreshedContinuation,
    activeProductionContinuation: refreshedActiveProductionContinuation,
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
    runId: `foreground-cleanup-crew:${params.flow.flowId}:executor:${params.now}`,
    childSessionKey: params.sessionKey,
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

function findExistingForegroundSupersessionTask(params: {
  flowId: string;
  replacementTaskId: string;
  replacementRunId?: string;
  replacementSessionKey?: string;
}): TaskRecord | undefined {
  return listTasksForFlowId(params.flowId).find((task) => {
    if (task.status !== "queued" && task.status !== "running") {
      return false;
    }
    if (task.taskId === params.replacementTaskId) {
      return true;
    }
    if (task.sourceId !== FOREGROUND_CLEANUP_CREW_SUPERSESSION_SOURCE_ID) {
      return false;
    }
    const taskRunId = normalizeOptionalString(task.runId);
    const replacementRunId = normalizeOptionalString(params.replacementRunId);
    if (taskRunId && replacementRunId && taskRunId === replacementRunId) {
      return true;
    }
    const taskSessionKey = normalizeOptionalString(task.childSessionKey);
    const replacementSessionKey = normalizeOptionalString(params.replacementSessionKey);
    return Boolean(
      taskSessionKey && replacementSessionKey && taskSessionKey === replacementSessionKey,
    );
  });
}

function createForegroundSupersessionProjection(params: {
  flow: TaskFlowRecord;
  lostTaskId: string;
  replacementTask: TaskRecord;
  replacementTaskId: string;
  replacementSessionKey: string;
  now: number;
}): TaskRecord | null {
  const runId =
    normalizeOptionalString(params.replacementTask.runId) ??
    `foreground-cleanup-crew:replacement:${params.flow.flowId}:${params.replacementTaskId}`;
  const progressSummary = [
    `Replacement executor projection active for ${params.replacementTaskId}.`,
    params.replacementTask.progressSummary,
  ]
    .map((part) => normalizeOptionalString(part))
    .filter(Boolean)
    .join(" ");
  return createTaskRecord({
    runtime: params.replacementTask.runtime,
    taskKind: params.replacementTask.taskKind ?? FOREGROUND_CLEANUP_CREW_TASK_KIND,
    sourceId: FOREGROUND_CLEANUP_CREW_SUPERSESSION_SOURCE_ID,
    requesterSessionKey: params.flow.ownerKey,
    ownerKey: params.flow.ownerKey,
    scopeKind: "session",
    parentFlowId: params.flow.flowId,
    parentTaskId: params.lostTaskId,
    agentId: params.replacementTask.agentId,
    childSessionKey: params.replacementSessionKey,
    runId,
    label: "Replacement foreground Cleanup Crew executor",
    task: `Represent active replacement executor ${params.replacementTaskId} under foreground Cleanup Crew parent flow`,
    status: params.replacementTask.status,
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    startedAt: params.replacementTask.startedAt ?? params.now,
    lastEventAt: params.now,
    progressSummary,
  });
}

function getEndedBackingSubagentRun(task: TaskRecord) {
  const childSessionKey = normalizeOptionalString(task.childSessionKey);
  const runId = normalizeOptionalString(task.runId);
  if (!childSessionKey || !runId) {
    return null;
  }
  const run = getLatestSubagentRunByChildSessionKey(childSessionKey);
  if (!run || run.runId !== runId || typeof run.endedAt !== "number") {
    return null;
  }
  return run;
}

export function supersedeForegroundCleanupCrewExecutor(params: {
  flowId: string;
  lostTaskId: string;
  replacementTaskId: string;
  ownerKey: string;
  sessionKey: string;
  currentStep: string;
  detail?: string | null;
  now?: number;
}): ForegroundCleanupCrewExecutorSupersessionResult {
  const flow = listTaskFlowRecords().find((candidate) => candidate.flowId === params.flowId);
  if (!flow) {
    return { status: "blocked", reason: "parent_flow_not_found" };
  }
  if (!isOpenProductionFlow(flow)) {
    return { status: "blocked", reason: "parent_flow_not_open_production" };
  }
  if (normalizeOptionalString(flow.ownerKey) !== normalizeOptionalString(params.ownerKey)) {
    return { status: "blocked", reason: "parent_flow_owner_mismatch" };
  }
  const currentStep = normalizeOptionalString(params.currentStep);
  if (!currentStep) {
    return { status: "blocked", reason: "current_step_missing" };
  }
  const lostTaskId = normalizeOptionalString(params.lostTaskId);
  if (!lostTaskId) {
    return { status: "blocked", reason: "lost_task_id_missing" };
  }
  const lostTask = listTasksForFlowId(flow.flowId).find((task) => task.taskId === lostTaskId);
  if (!lostTask) {
    return { status: "blocked", reason: "lost_task_not_linked_to_parent_flow" };
  }
  const endedBackingRun = getEndedBackingSubagentRun(lostTask);
  if (lostTask.status !== "lost" && !endedBackingRun) {
    return { status: "blocked", reason: "lost_task_not_terminal_lost" };
  }
  const lostProof = `${lostTask.progressSummary ?? ""} ${lostTask.terminalSummary ?? ""} ${
    (lostTask as TaskRecord & { error?: string }).error ?? ""
  }`.toLowerCase();
  if (!lostProof.includes("backing session missing") && !endedBackingRun) {
    return { status: "blocked", reason: "lost_task_missing_backing_session_proof" };
  }
  const replacementTaskId = normalizeOptionalString(params.replacementTaskId);
  if (!replacementTaskId) {
    return { status: "blocked", reason: "replacement_task_id_missing" };
  }
  const replacementCandidate = getTaskById(replacementTaskId);
  if (!replacementCandidate) {
    return { status: "blocked", reason: "replacement_task_not_found" };
  }
  if (replacementCandidate.status !== "queued" && replacementCandidate.status !== "running") {
    return { status: "blocked", reason: "replacement_task_not_active" };
  }
  if (!normalizeOptionalString(replacementCandidate.childSessionKey)) {
    return { status: "blocked", reason: "replacement_task_missing_child_session" };
  }
  const replacementOwnerKey = normalizeOptionalString(replacementCandidate.ownerKey);
  const replacementSessionKey = normalizeOptionalString(replacementCandidate.childSessionKey);
  const requestedSessionKey = normalizeOptionalString(params.sessionKey);
  if (
    replacementOwnerKey !== normalizeOptionalString(params.ownerKey) &&
    (!requestedSessionKey || replacementSessionKey !== requestedSessionKey)
  ) {
    return { status: "blocked", reason: "replacement_task_owner_mismatch" };
  }
  const replacementParentFlowId = normalizeOptionalString(replacementCandidate.parentFlowId);
  if (replacementParentFlowId && replacementParentFlowId !== flow.flowId) {
    const replacementParentFlow = getTaskFlowById(replacementParentFlowId);
    if (!replacementParentFlow || replacementParentFlow.syncMode !== "task_mirrored") {
      return { status: "blocked", reason: "replacement_task_parent_flow_mismatch" };
    }
  }

  const now = params.now ?? Date.now();
  if (lostTask.status !== "lost" && endedBackingRun) {
    const endedAt = endedBackingRun.endedAt;
    if (typeof endedAt !== "number") {
      return { status: "blocked", reason: "lost_task_mark_lost_failed" };
    }
    const markedLost = markTaskLostById({
      taskId: lostTask.taskId,
      endedAt,
      lastEventAt: now,
      error: "backing subagent run ended",
    });
    if (!markedLost || markedLost.status !== "lost") {
      return { status: "blocked", reason: "lost_task_mark_lost_failed" };
    }
  }
  const dispatchReceiptDetail =
    normalizeOptionalString(params.detail) ??
    `Replacement executor launched for lost child ${lostTaskId}; current turn owns ${currentStep} under same parent mission.`;
  const existing =
    listTasksForFlowId(flow.flowId).find(
      (task) =>
        task.taskId === replacementTaskId &&
        (task.status === "queued" || task.status === "running"),
    ) ??
    findExistingForegroundSupersessionTask({
      flowId: flow.flowId,
      replacementTaskId,
      replacementRunId: replacementCandidate.runId,
      replacementSessionKey,
    });
  if (existing) {
    const launched = recordFlowNextExecutableLaunch({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      detail: dispatchReceiptDetail,
      currentStep,
      updatedAt: now,
    });
    return {
      status: "attached",
      flow: launched.applied ? launched.flow : flow,
      task: existing,
      dispatchReceiptDetail,
    };
  }

  const shouldProjectReplacement =
    (replacementParentFlowId && replacementParentFlowId !== flow.flowId) ||
    replacementOwnerKey !== normalizeOptionalString(params.ownerKey);
  const task = shouldProjectReplacement
    ? createForegroundSupersessionProjection({
        flow,
        lostTaskId,
        replacementTask: replacementCandidate,
        replacementTaskId,
        replacementSessionKey: replacementSessionKey!,
        now,
      })
    : bindActiveSessionTaskToManagedFlowById({
        taskId: replacementTaskId,
        targetFlowId: flow.flowId,
      });
  if (!task) {
    return { status: "blocked", reason: "replacement_task_parent_link_failed" };
  }
  const launched = recordFlowNextExecutableLaunch({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    detail: dispatchReceiptDetail,
    currentStep,
    updatedAt: now,
  });
  if (!launched.applied) {
    return { status: "blocked", reason: `parent_flow_launch_record_failed:${launched.reason}` };
  }
  return {
    status: "superseded",
    flow: launched.flow,
    task,
    dispatchReceiptDetail,
  };
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
  checkpointKind?: string | null;
  checkpointSummary?: string | null;
  nextExecutableAction?: string | null;
  intakeStateDir?: string;
  now?: number;
}): ForegroundCleanupCrewTaskFlowRegistrationResult {
  const currentTurnText = normalizeOptionalString(params.currentTurnText);
  if (!currentTurnText || !isForegroundCleanupCrewProductionMission(currentTurnText)) {
    return { status: "skipped", reason: "not_cleanup_crew_production_mission" };
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return { status: "blocked", reason: "active_mission_identity_missing" };
  }
  const ownerKey = sessionKey;
  const now = params.now ?? Date.now();
  const tracking = normalizeTracking(params);
  if (checkpointRequiresNextAction(tracking) && !tracking.nextExecutableAction) {
    return { status: "blocked", reason: "checkpoint_next_executable_action_missing" };
  }
  const intakeRecord = createOwnerRequestIntakeRecord({
    message: currentTurnText,
    sourceSessionKey: sessionKey,
    sourceChannel: "webchat",
    sourceProvider: "openclaw",
    classification: "cleanup_crew_production",
    expectedDurability: "taskflow_required",
    governed: true,
    status: "server_acknowledged",
    lastExecutableAction: "owner request accepted",
    nextExecutableAction: "persist foreground Cleanup Crew TaskFlow",
    stateDir: params.intakeStateDir,
    nowMs: now,
  });
  markOwnerRequestPromptPersisted({
    requestId: intakeRecord.requestId,
    stateDir: params.intakeStateDir,
    nowMs: now,
  });
  const existing = findForegroundCleanupCrewFlow(ownerKey);
  if (existing) {
    if (isLawfullyBlockedWithoutLaunch(existing)) {
      return {
        status: "blocked",
        reason: "foreground_cleanup_crew_flow_lawfully_blocked",
      };
    }
    const trackedStateJson = applyTrackingToStateJson(existing.stateJson, tracking);
    const currentStep =
      tracking.stageId ?? existing.currentStep ?? "foreground_cleanup_crew_resumed";
    const settledStateJson = settleObsoleteRestartBoundaryStateJson({
      flow: existing,
      stateJson: trackedStateJson,
      tracking,
      currentStep,
      now,
    });
    const nextActionStateJson = refreshCheckpointNextActionProjectionStateJson({
      flow: existing,
      stateJson: settledStateJson,
      tracking,
      currentStep,
      now,
    });
    const resumed = resumeFlow({
      flowId: existing.flowId,
      expectedRevision: existing.revision,
      status: "running",
      currentStep,
      stateJson: nextActionStateJson,
      updatedAt: now,
    });
    const flow = resumed.applied
      ? (findForegroundCleanupCrewFlow(ownerKey) ?? resumed.flow)
      : existing;
    return {
      status: "attached",
      flow,
      taskId: (() => {
        const taskId = ensureForegroundExecutionTask({ flow, ownerKey, sessionKey, now, tracking });
        markOwnerRequestMissionRegistered({
          requestId: intakeRecord.requestId,
          taskFlowId: flow.flowId,
          taskId,
          lastExecutableAction: "attached to existing foreground Cleanup Crew TaskFlow",
          nextExecutableAction: "continue active production run",
          stateDir: params.intakeStateDir,
          nowMs: now,
        });
        return taskId;
      })(),
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
      ...(tracking.checkpointKind ? { currentCheckpointKind: tracking.checkpointKind } : {}),
      ...(tracking.checkpointSummary
        ? { currentCheckpointSummary: tracking.checkpointSummary }
        : {}),
      ...(tracking.nextExecutableAction
        ? { nextExecutableAction: tracking.nextExecutableAction }
        : {}),
    },
    createdAt: now,
    updatedAt: now,
  });
  if (!flow) {
    return { status: "blocked", reason: "taskflow_persistence_failed" };
  }
  const taskId = ensureForegroundExecutionTask({ flow, ownerKey, sessionKey, now, tracking });
  markOwnerRequestMissionRegistered({
    requestId: intakeRecord.requestId,
    taskFlowId: flow.flowId,
    taskId,
    lastExecutableAction: "registered foreground Cleanup Crew TaskFlow",
    nextExecutableAction: "execute Cleanup Crew production mission",
    stateDir: params.intakeStateDir,
    nowMs: now,
  });
  return {
    status: "registered",
    flow,
    taskId,
  };
}
