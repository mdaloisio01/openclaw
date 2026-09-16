import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MissionSettlementDecision } from "../agents/mission-settlement-tail.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getTaskFlowRegistryObservers,
  getTaskFlowRegistryStore,
  resetTaskFlowRegistryRuntimeForTests,
  type TaskFlowRegistryObserverEvent,
} from "./task-flow-registry.store.js";
import type {
  ActiveProductionBoundary,
  ActiveProductionContinuationReceipt,
  ActiveProductionContinuationState,
  ActiveProductionNextAction,
  TaskFlowRecord,
  TaskFlowStatus,
  TaskFlowSyncMode,
  JsonValue,
} from "./task-flow-registry.types.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/task-flow-registry");
const flows = new Map<string, TaskFlowRecord>();
let restoreAttempted = false;
let restoreFailureMessage: string | null = null;

type FlowRecordPatch = Omit<
  Partial<
    Pick<
      TaskFlowRecord,
      | "status"
      | "notifyPolicy"
      | "goal"
      | "currentStep"
      | "blockedTaskId"
      | "blockedSummary"
      | "controllerId"
      | "stateJson"
      | "waitJson"
      | "cancelRequestedAt"
      | "updatedAt"
      | "endedAt"
    >
  >,
  | "currentStep"
  | "blockedTaskId"
  | "blockedSummary"
  | "controllerId"
  | "stateJson"
  | "waitJson"
  | "cancelRequestedAt"
  | "endedAt"
> & {
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  controllerId?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  endedAt?: number | null;
};

type FlowRecordCreateFields = {
  ownerKey: string;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
  status?: TaskFlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number | null;
};

export type CreateFlowRecordParams = FlowRecordCreateFields & {
  syncMode?: TaskFlowSyncMode;
  controllerId?: string | null;
  revision?: number;
};

export type TaskFlowUpdateResult =
  | {
      applied: true;
      flow: TaskFlowRecord;
    }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict" | "persist_failed" | "guard_blocked";
      current?: TaskFlowRecord;
      blockedSummary?: string;
    };

export type TaskFlowSyncResult =
  | {
      ok: true;
      flow: TaskFlowRecord | null;
    }
  | {
      ok: false;
      reason: "persist_failed";
      current: TaskFlowRecord;
    };

export const BLIND_TEST_SLICE_CONTROLLER_ID = "governance/blind-test-slice";

export type ProductionContinuationStopReason =
  | "blocker"
  | "owner_decision"
  | "restart_or_reload"
  | "hard_stop"
  | "safety_stop"
  | "whole_run_complete";

export type ProductionContinuationEventType =
  | "ACTIVE_PRODUCTION_RUN_STARTED"
  | "BOUNDED_UNIT_STARTED"
  | "BOUNDED_UNIT_PASSED"
  | "PARENT_RUN_STILL_OPEN"
  | "BLOCKER_STATE_FALSE"
  | "CONTINUATION_REQUIRED_AFTER_LOCAL_SUCCESS"
  | "NEXT_EXECUTABLE_UNIT_IDENTIFIED"
  | "NEXT_EXECUTABLE_UNIT_LAUNCHED"
  | "PARENT_CONTINUITY_VIOLATION"
  | "LAWFUL_STOP_ALLOWED";

export type ProductionContinuationUnitStatus = "started" | "passed" | "blocked" | "completed";

export type ProductionContinuationEvent = {
  type: ProductionContinuationEventType;
  at: number;
  detail?: string;
};

export type ProductionContinuationState = {
  activeProductionRun: boolean;
  currentUnitStatus: ProductionContinuationUnitStatus;
  parentRunOpen: boolean;
  blockerPresent: boolean;
  ownerDecisionRequired: boolean;
  restartOrReloadRequired: boolean;
  hardStopPresent: boolean;
  safetyStopPresent: boolean;
  lawfulWholeRunCompletion: boolean;
  continuationRequiredAfterLocalSuccess: boolean;
  nextExecutableUnitIdentified: boolean;
  nextExecutableUnitLaunched: boolean;
  continuationViolation: boolean;
  lawfulStopReason?: ProductionContinuationStopReason;
  events: ProductionContinuationEvent[];
};

type BlindTestStageVerdict = "pending" | "passed" | "failed";
type BlindTestFailureStage = "draft" | "implementation" | "closeout";
type BlindTestHandbackStatus = "required" | "issued" | "completed";

type BlindTestStageState = {
  verdict: BlindTestStageVerdict;
  reviewedAt?: number;
  summary?: string;
};

type BlindTestReworkState = {
  owed: boolean;
  stage: BlindTestFailureStage;
  failCount: number;
  handbackStatus: BlindTestHandbackStatus;
  reviewedAt: number;
  summary?: string;
  outcomeCode?: string;
  transferOwner?: "Will";
};

export type BlindTestSliceState = {
  kind: "blind_test_slice";
  sliceKey: string;
  subjectAgent: string;
  draft: BlindTestStageState;
  implementation: BlindTestStageState;
  rework?: BlindTestReworkState;
  continuation?: ProductionContinuationState;
};

export type BlindTestSliceCreateResult =
  | {
      created: true;
      flow: TaskFlowRecord;
      previousFlow?: TaskFlowRecord;
    }
  | {
      created: false;
      reason: "previous_slice_not_found" | "previous_slice_not_complete" | "persist_failed";
      current?: TaskFlowRecord;
      blockedSummary: string;
    };

type ManagedControllerState = {
  kind?: string;
  productionContinuation?: ProductionContinuationState;
  activeProductionContinuation?: JsonValue;
  [key: string]: JsonValue | undefined;
};

function cloneStructuredValue<T>(value: T | undefined): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
  return {
    ...record,
    ...(record.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin)! }
      : {}),
    ...(record.stateJson !== undefined
      ? { stateJson: cloneStructuredValue(record.stateJson)! }
      : {}),
    ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson)! } : {}),
  };
}

function normalizeRestoredFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
  const syncMode = record.syncMode === "task_mirrored" ? "task_mirrored" : "managed";
  const controllerId =
    syncMode === "managed"
      ? (normalizeOptionalString(record.controllerId) ?? "core/legacy-restored")
      : undefined;
  return {
    ...record,
    syncMode,
    ownerKey: assertFlowOwnerKey(record.ownerKey),
    ...(record.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin)! }
      : {}),
    ...(controllerId ? { controllerId } : {}),
    currentStep: normalizeOptionalString(record.currentStep),
    blockedTaskId: normalizeOptionalString(record.blockedTaskId),
    blockedSummary: normalizeOptionalString(record.blockedSummary),
    ...(record.stateJson !== undefined
      ? { stateJson: cloneStructuredValue(record.stateJson)! }
      : {}),
    ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson)! } : {}),
    revision: Math.max(0, record.revision),
    cancelRequestedAt: record.cancelRequestedAt ?? undefined,
    endedAt: record.endedAt ?? undefined,
  };
}

function snapshotFlowRecords(source: ReadonlyMap<string, TaskFlowRecord>): TaskFlowRecord[] {
  return [...source.values()].map((record) => cloneFlowRecord(record));
}

function emitFlowRegistryObserverEvent(createEvent: () => TaskFlowRegistryObserverEvent): void {
  const observers = getTaskFlowRegistryObservers();
  if (!observers?.onEvent) {
    return;
  }
  try {
    observers.onEvent(createEvent());
  } catch {
    // Flow observers are best-effort only. They must not break registry writes.
  }
}

function ensureNotifyPolicy(notifyPolicy?: TaskNotifyPolicy): TaskNotifyPolicy {
  return notifyPolicy ?? "done_only";
}

function normalizeJsonBlob(value: JsonValue | null | undefined): JsonValue | undefined {
  return value === undefined ? undefined : cloneStructuredValue(value);
}

function normalizeBlindTestStageState(value: unknown): BlindTestStageState | null {
  if (!isRecord(value)) {
    return null;
  }
  const verdict =
    value.verdict === "pending" || value.verdict === "passed" || value.verdict === "failed"
      ? value.verdict
      : null;
  if (!verdict) {
    return null;
  }
  return {
    verdict,
    ...(typeof value.reviewedAt === "number" ? { reviewedAt: value.reviewedAt } : {}),
    ...(typeof value.summary === "string" && value.summary.trim()
      ? { summary: value.summary.trim() }
      : {}),
  };
}

function normalizeBlindTestReworkState(value: unknown): BlindTestReworkState | null {
  if (!isRecord(value) || value.owed !== true) {
    return null;
  }
  const stage =
    value.stage === "draft" || value.stage === "implementation" || value.stage === "closeout"
      ? value.stage
      : null;
  const failCount =
    typeof value.failCount === "number" && Number.isFinite(value.failCount)
      ? Math.max(1, Math.trunc(value.failCount))
      : null;
  const handbackStatus =
    value.handbackStatus === "required" ||
    value.handbackStatus === "issued" ||
    value.handbackStatus === "completed"
      ? value.handbackStatus
      : null;
  const reviewedAt =
    typeof value.reviewedAt === "number" && Number.isFinite(value.reviewedAt)
      ? value.reviewedAt
      : null;
  if (!stage || !failCount || !handbackStatus || reviewedAt == null) {
    return null;
  }
  return {
    owed: true,
    stage,
    failCount,
    handbackStatus,
    reviewedAt,
    ...(typeof value.summary === "string" && value.summary.trim()
      ? { summary: value.summary.trim() }
      : {}),
    ...(typeof value.outcomeCode === "string" && value.outcomeCode.trim()
      ? { outcomeCode: value.outcomeCode.trim() }
      : {}),
    ...(value.transferOwner === "Will" ? { transferOwner: "Will" as const } : {}),
  };
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeProductionContinuationStopReason(
  value: unknown,
): ProductionContinuationStopReason | undefined {
  return value === "blocker" ||
    value === "owner_decision" ||
    value === "restart_or_reload" ||
    value === "hard_stop" ||
    value === "safety_stop" ||
    value === "whole_run_complete"
    ? value
    : undefined;
}

function normalizeProductionContinuationEventType(
  value: unknown,
): ProductionContinuationEventType | undefined {
  return value === "ACTIVE_PRODUCTION_RUN_STARTED" ||
    value === "BOUNDED_UNIT_STARTED" ||
    value === "BOUNDED_UNIT_PASSED" ||
    value === "PARENT_RUN_STILL_OPEN" ||
    value === "BLOCKER_STATE_FALSE" ||
    value === "CONTINUATION_REQUIRED_AFTER_LOCAL_SUCCESS" ||
    value === "NEXT_EXECUTABLE_UNIT_IDENTIFIED" ||
    value === "NEXT_EXECUTABLE_UNIT_LAUNCHED" ||
    value === "PARENT_CONTINUITY_VIOLATION" ||
    value === "LAWFUL_STOP_ALLOWED"
    ? value
    : undefined;
}

function normalizeProductionContinuationUnitStatus(
  value: unknown,
): ProductionContinuationUnitStatus | undefined {
  return value === "started" || value === "passed" || value === "blocked" || value === "completed"
    ? value
    : undefined;
}

function normalizeProductionContinuationEvent(value: unknown): ProductionContinuationEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = normalizeProductionContinuationEventType(value.type);
  const at =
    typeof value.at === "number" && Number.isFinite(value.at) ? Math.trunc(value.at) : undefined;
  if (!type || at === undefined) {
    return null;
  }
  return {
    type,
    at,
    ...(typeof value.detail === "string" && value.detail.trim()
      ? { detail: value.detail.trim() }
      : {}),
  };
}

function normalizeProductionContinuationState(value: unknown): ProductionContinuationState | null {
  if (!isRecord(value) || normalizeBoolean(value.activeProductionRun) !== true) {
    return null;
  }
  const currentUnitStatus = normalizeProductionContinuationUnitStatus(value.currentUnitStatus);
  if (!currentUnitStatus) {
    return null;
  }
  const events = Array.isArray(value.events)
    ? value.events
        .map((entry) => normalizeProductionContinuationEvent(entry))
        .filter((entry): entry is ProductionContinuationEvent => Boolean(entry))
    : [];
  return {
    activeProductionRun: true,
    currentUnitStatus,
    parentRunOpen: normalizeBoolean(value.parentRunOpen) ?? true,
    blockerPresent: normalizeBoolean(value.blockerPresent) ?? false,
    ownerDecisionRequired: normalizeBoolean(value.ownerDecisionRequired) ?? false,
    restartOrReloadRequired: normalizeBoolean(value.restartOrReloadRequired) ?? false,
    hardStopPresent: normalizeBoolean(value.hardStopPresent) ?? false,
    safetyStopPresent: normalizeBoolean(value.safetyStopPresent) ?? false,
    lawfulWholeRunCompletion: normalizeBoolean(value.lawfulWholeRunCompletion) ?? false,
    continuationRequiredAfterLocalSuccess:
      normalizeBoolean(value.continuationRequiredAfterLocalSuccess) ?? false,
    nextExecutableUnitIdentified: normalizeBoolean(value.nextExecutableUnitIdentified) ?? false,
    nextExecutableUnitLaunched: normalizeBoolean(value.nextExecutableUnitLaunched) ?? false,
    continuationViolation: normalizeBoolean(value.continuationViolation) ?? false,
    ...(normalizeProductionContinuationStopReason(value.lawfulStopReason)
      ? { lawfulStopReason: normalizeProductionContinuationStopReason(value.lawfulStopReason)! }
      : {}),
    events,
  };
}

function normalizeBlindTestSliceState(value: unknown): BlindTestSliceState | null {
  if (!isRecord(value) || value.kind !== "blind_test_slice") {
    return null;
  }
  const sliceKey = normalizeOptionalString(value.sliceKey);
  const subjectAgent = normalizeOptionalString(value.subjectAgent);
  const draft = normalizeBlindTestStageState(value.draft);
  const implementation = normalizeBlindTestStageState(value.implementation);
  const rework = normalizeBlindTestReworkState(value.rework);
  const continuation = normalizeProductionContinuationState(value.continuation);
  if (!sliceKey || !subjectAgent || !draft || !implementation) {
    return null;
  }
  return {
    kind: "blind_test_slice",
    sliceKey,
    subjectAgent,
    draft,
    implementation,
    ...(rework ? { rework } : {}),
    ...(continuation ? { continuation } : {}),
  };
}

function createBlindTestSliceState(params: {
  sliceKey: string;
  subjectAgent: string;
  createdAt?: number;
  continuation?: Partial<ProductionContinuationState>;
}): BlindTestSliceState {
  const createdAt = params.createdAt ?? Date.now();
  const continuation =
    params.continuation?.activeProductionRun === true
      ? createStartedProductionContinuationState({
          continuation: params.continuation,
          at: createdAt,
        })
      : undefined;
  return {
    kind: "blind_test_slice",
    sliceKey: params.sliceKey,
    subjectAgent: params.subjectAgent,
    draft: { verdict: "pending" },
    implementation: { verdict: "pending" },
    ...(continuation ? { continuation } : {}),
  };
}

function hasLawfulStopState(state: ProductionContinuationState | undefined): boolean {
  if (!state?.activeProductionRun) {
    return false;
  }
  return (
    state.blockerPresent ||
    state.ownerDecisionRequired ||
    state.restartOrReloadRequired ||
    state.hardStopPresent ||
    state.safetyStopPresent ||
    state.lawfulWholeRunCompletion
  );
}

function appendContinuationEvent(
  state: ProductionContinuationState,
  type: ProductionContinuationEventType,
  at: number,
  detail?: string,
): ProductionContinuationState {
  return {
    ...state,
    events: [
      ...state.events,
      {
        type,
        at,
        ...(detail?.trim() ? { detail: detail.trim() } : {}),
      },
    ],
  };
}

function createProductionContinuationState(params: {
  activeProductionRun: boolean;
  currentUnitStatus: ProductionContinuationUnitStatus;
  parentRunOpen?: boolean;
  blockerPresent?: boolean;
  ownerDecisionRequired?: boolean;
  restartOrReloadRequired?: boolean;
  hardStopPresent?: boolean;
  safetyStopPresent?: boolean;
  lawfulWholeRunCompletion?: boolean;
  continuationRequiredAfterLocalSuccess?: boolean;
  nextExecutableUnitIdentified?: boolean;
  nextExecutableUnitLaunched?: boolean;
  continuationViolation?: boolean;
  lawfulStopReason?: ProductionContinuationStopReason;
  at: number;
}): ProductionContinuationState {
  let state: ProductionContinuationState = {
    activeProductionRun: true,
    currentUnitStatus: params.currentUnitStatus,
    parentRunOpen: params.parentRunOpen ?? true,
    blockerPresent: params.blockerPresent ?? false,
    ownerDecisionRequired: params.ownerDecisionRequired ?? false,
    restartOrReloadRequired: params.restartOrReloadRequired ?? false,
    hardStopPresent: params.hardStopPresent ?? false,
    safetyStopPresent: params.safetyStopPresent ?? false,
    lawfulWholeRunCompletion: params.lawfulWholeRunCompletion ?? false,
    continuationRequiredAfterLocalSuccess: params.continuationRequiredAfterLocalSuccess ?? false,
    nextExecutableUnitIdentified: params.nextExecutableUnitIdentified ?? false,
    nextExecutableUnitLaunched: params.nextExecutableUnitLaunched ?? false,
    continuationViolation: params.continuationViolation ?? false,
    ...(params.lawfulStopReason ? { lawfulStopReason: params.lawfulStopReason } : {}),
    events: [],
  };
  state = appendContinuationEvent(state, "ACTIVE_PRODUCTION_RUN_STARTED", params.at);
  state = appendContinuationEvent(state, "BOUNDED_UNIT_STARTED", params.at);
  return state;
}

function createStartedProductionContinuationState(params: {
  continuation: Partial<ProductionContinuationState>;
  at: number;
}): ProductionContinuationState {
  return createProductionContinuationState({
    activeProductionRun: true,
    currentUnitStatus: "started",
    parentRunOpen: params.continuation.parentRunOpen ?? true,
    blockerPresent: params.continuation.blockerPresent ?? false,
    ownerDecisionRequired: params.continuation.ownerDecisionRequired ?? false,
    restartOrReloadRequired: params.continuation.restartOrReloadRequired ?? false,
    hardStopPresent: params.continuation.hardStopPresent ?? false,
    safetyStopPresent: params.continuation.safetyStopPresent ?? false,
    lawfulWholeRunCompletion: params.continuation.lawfulWholeRunCompletion ?? false,
    continuationRequiredAfterLocalSuccess:
      params.continuation.continuationRequiredAfterLocalSuccess ?? false,
    nextExecutableUnitIdentified: params.continuation.nextExecutableUnitIdentified ?? false,
    nextExecutableUnitLaunched: params.continuation.nextExecutableUnitLaunched ?? false,
    continuationViolation: params.continuation.continuationViolation ?? false,
    ...(params.continuation.lawfulStopReason
      ? { lawfulStopReason: params.continuation.lawfulStopReason }
      : {}),
    at: params.at,
  });
}

function updateContinuationAfterPass(
  state: ProductionContinuationState | undefined,
  at: number,
): ProductionContinuationState | undefined {
  if (!state?.activeProductionRun) {
    return state;
  }
  let next: ProductionContinuationState = {
    ...state,
    currentUnitStatus: "passed",
    continuationViolation: false,
  };
  next = appendContinuationEvent(next, "BOUNDED_UNIT_PASSED", at);
  if (next.parentRunOpen) {
    next = appendContinuationEvent(next, "PARENT_RUN_STILL_OPEN", at);
  }
  if (!hasLawfulStopState(next)) {
    next = {
      ...next,
      continuationRequiredAfterLocalSuccess: true,
    };
    next = appendContinuationEvent(next, "BLOCKER_STATE_FALSE", at);
    next = appendContinuationEvent(next, "CONTINUATION_REQUIRED_AFTER_LOCAL_SUCCESS", at);
  } else {
    next = {
      ...next,
      continuationRequiredAfterLocalSuccess: false,
    };
    next = appendContinuationEvent(next, "LAWFUL_STOP_ALLOWED", at, next.lawfulStopReason);
  }
  return next;
}

function updateContinuationAfterViolation(
  state: ProductionContinuationState | undefined,
  at: number,
  detail: string,
): ProductionContinuationState | undefined {
  if (!state?.activeProductionRun) {
    return state;
  }
  let next: ProductionContinuationState = {
    ...state,
    continuationViolation: true,
  };
  next = appendContinuationEvent(next, "PARENT_CONTINUITY_VIOLATION", at, detail);
  return next;
}

function updateContinuationAfterNextLaunch(
  state: ProductionContinuationState | undefined,
  at: number,
  detail: string,
): ProductionContinuationState | undefined {
  if (!state?.activeProductionRun) {
    return state;
  }
  const { lawfulStopReason: _lawfulStopReason, ...stateWithoutStopReason } = state;
  let next: ProductionContinuationState = {
    ...stateWithoutStopReason,
    currentUnitStatus: "started",
    blockerPresent: false,
    ownerDecisionRequired: false,
    restartOrReloadRequired: false,
    hardStopPresent: false,
    safetyStopPresent: false,
    nextExecutableUnitIdentified: true,
    nextExecutableUnitLaunched: true,
    continuationViolation: false,
  };
  next = appendContinuationEvent(next, "NEXT_EXECUTABLE_UNIT_IDENTIFIED", at, detail);
  next = appendContinuationEvent(next, "NEXT_EXECUTABLE_UNIT_LAUNCHED", at, detail);
  return next;
}

function mapContinuationStopReasonToBoundary(
  reason: ProductionContinuationStopReason | undefined,
): ActiveProductionBoundary {
  switch (reason) {
    case "blocker":
      return "technical_repair";
    case "owner_decision":
      return "operator_product_decision_required";
    case "restart_or_reload":
      return "runtime_restart_recovery";
    case "hard_stop":
      return "technical_impossibility";
    case "safety_stop":
      return "unsafe_destructive_action_required";
    case "whole_run_complete":
      return "complete";
    default:
      return "plan_next_step";
  }
}

function latestContinuationEventDetail(
  state: ProductionContinuationState,
  type: ProductionContinuationEventType,
): string | undefined {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (event?.type === type && event.detail?.trim()) {
      return event.detail.trim();
    }
  }
  return undefined;
}

function latestContinuationEventTime(
  state: ProductionContinuationState,
  type: ProductionContinuationEventType,
): number | undefined {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (event?.type === type) {
      return event.at;
    }
  }
  return undefined;
}

function buildActiveProductionContinuationFromLegacy(params: {
  flow: TaskFlowRecord;
  continuation: ProductionContinuationState;
}): ActiveProductionContinuationState {
  const { flow, continuation } = params;
  const broaderBuildOpen = continuation.parentRunOpen && !continuation.lawfulWholeRunCompletion;
  const boundary = broaderBuildOpen
    ? mapContinuationStopReasonToBoundary(continuation.lawfulStopReason)
    : "complete";
  const actionId = `${flow.flowId}:next-executable`;
  // A new checkpoint identifies the current action without launching it. Prior
  // execution remains in events for audit and must not replace the pending action.
  const actionDetail =
    (continuation.nextExecutableUnitLaunched
      ? latestContinuationEventDetail(continuation, "NEXT_EXECUTABLE_UNIT_LAUNCHED")
      : undefined) ??
    latestContinuationEventDetail(continuation, "NEXT_EXECUTABLE_UNIT_IDENTIFIED") ??
    flow.currentStep ??
    "Continue active production run";
  const nextAction: ActiveProductionNextAction | undefined =
    broaderBuildOpen && boundary !== "complete"
      ? {
          actionId,
          owner: flow.ownerKey,
          summary: actionDetail,
          boundary,
          surface: "taskflow_child",
          ...(continuation.nextExecutableUnitLaunched ? { dispatchProofRef: actionDetail } : {}),
        }
      : undefined;
  const launchedAt = latestContinuationEventTime(continuation, "NEXT_EXECUTABLE_UNIT_LAUNCHED");
  const dispatchReceipts: ActiveProductionContinuationReceipt[] =
    nextAction && continuation.nextExecutableUnitLaunched && launchedAt
      ? [
          {
            receiptId: `${actionId}:dispatch:${launchedAt}`,
            actionId,
            surface: nextAction.surface,
            boundary,
            dispatchedAt: launchedAt,
            owner: nextAction.owner,
            summary: nextAction.summary,
            proofRef: nextAction.dispatchProofRef ?? actionDetail,
          },
        ]
      : [];
  return {
    activeProductionRun: true,
    broaderBuildOpen,
    status: !broaderBuildOpen
      ? "complete"
      : hasLawfulStopState(continuation)
        ? "hard_boundary"
        : dispatchReceipts.length > 0
          ? "dispatched"
          : "dispatch_required",
    boundary,
    ...(nextAction ? { nextAction } : {}),
    dispatchReceipts,
    ...(dispatchReceipts[0] ? { lastDispatchReceiptId: dispatchReceipts[0].receiptId } : {}),
  };
}

function buildBlindTestReworkState(params: {
  current: BlindTestSliceState;
  stage: BlindTestFailureStage;
  reviewedAt: number;
  summary?: string | null;
  outcomeCode?: string | null;
}): BlindTestReworkState {
  const previousCount = params.current.rework?.failCount ?? 0;
  const failCount = previousCount + 1;
  return {
    owed: true,
    stage: params.stage,
    failCount,
    handbackStatus: "required",
    reviewedAt: params.reviewedAt,
    ...(normalizeOptionalString(params.summary)
      ? { summary: normalizeOptionalString(params.summary)! }
      : {}),
    ...(normalizeOptionalString(params.outcomeCode)
      ? { outcomeCode: normalizeOptionalString(params.outcomeCode)! }
      : {}),
    ...(failCount >= 3 ? { transferOwner: "Will" as const } : {}),
  };
}

function isBlindTestSliceFlow(flow: TaskFlowRecord): boolean {
  return flow.syncMode === "managed" && flow.controllerId === BLIND_TEST_SLICE_CONTROLLER_ID;
}

function getBlindTestSliceState(flow: TaskFlowRecord): BlindTestSliceState | null {
  return normalizeBlindTestSliceState(flow.stateJson);
}

function getManagedControllerState(flow: TaskFlowRecord): ManagedControllerState | null {
  if (flow.syncMode !== "managed" || !isRecord(flow.stateJson)) {
    return null;
  }
  return flow.stateJson as ManagedControllerState;
}

function attachProductionContinuationToStateJson(params: {
  flow: TaskFlowRecord;
  stateJson?: JsonValue | null;
  continuation?: ProductionContinuationState;
}): JsonValue | undefined {
  const baseState = params.stateJson === undefined ? params.flow.stateJson : params.stateJson;
  const activeProductionContinuation = params.continuation?.activeProductionRun
    ? buildActiveProductionContinuationFromLegacy({
        flow: params.flow,
        continuation: params.continuation,
      })
    : undefined;
  if (isBlindTestSliceFlow(params.flow)) {
    const blindState =
      (baseState !== undefined ? normalizeBlindTestSliceState(baseState) : null) ??
      getBlindTestSliceState(params.flow);
    if (!blindState) {
      return normalizeJsonBlob(baseState);
    }
    return {
      ...blindState,
      ...(params.continuation ? { continuation: params.continuation } : {}),
      ...(activeProductionContinuation ? { activeProductionContinuation } : {}),
    };
  }
  if (isRecord(baseState)) {
    return {
      ...cloneStructuredValue(baseState),
      ...(params.continuation ? { productionContinuation: params.continuation } : {}),
      ...(activeProductionContinuation ? { activeProductionContinuation } : {}),
    };
  }
  if (!params.continuation) {
    return normalizeJsonBlob(baseState);
  }
  return {
    kind: "managed_controller_state",
    productionContinuation: params.continuation,
    ...(activeProductionContinuation ? { activeProductionContinuation } : {}),
  };
}

function cloneMissionSettlementDecision(decision: MissionSettlementDecision): JsonValue {
  return cloneStructuredValue(decision) as JsonValue;
}

export function attachMissionSettlementToTaskFlowStateJson(params: {
  stateJson?: JsonValue | null;
  settlement: MissionSettlementDecision;
}): JsonValue {
  const governedMissionSettlement = cloneMissionSettlementDecision(params.settlement);
  if (isRecord(params.stateJson)) {
    return {
      ...cloneStructuredValue(params.stateJson),
      governedMissionSettlement,
    };
  }
  return {
    kind: "managed_controller_state",
    governedMissionSettlement,
  };
}

export function getTaskFlowMissionSettlement(
  flow: TaskFlowRecord,
): MissionSettlementDecision | null {
  if (!isRecord(flow.stateJson)) {
    return null;
  }
  const settlement = flow.stateJson.governedMissionSettlement;
  if (
    !isRecord(settlement) ||
    settlement.schema !== "openclaw.mission_settlement_tail_decision.v1"
  ) {
    return null;
  }
  return cloneStructuredValue(settlement) as MissionSettlementDecision;
}

export function getBlindTestProductionContinuation(
  flow: TaskFlowRecord,
): ProductionContinuationState | null {
  return getBlindTestSliceState(flow)?.continuation ?? null;
}

export function getTaskFlowProductionContinuation(
  flow: TaskFlowRecord,
): ProductionContinuationState | null {
  if (isBlindTestSliceFlow(flow)) {
    return getBlindTestProductionContinuation(flow);
  }
  const managedState = getManagedControllerState(flow);
  if (!managedState) {
    return null;
  }
  return normalizeProductionContinuationState(managedState.productionContinuation);
}

export function getTaskFlowActiveProductionContinuation(
  flow: TaskFlowRecord,
): ActiveProductionContinuationState | null {
  const continuation = getTaskFlowProductionContinuation(flow);
  if (!continuation?.activeProductionRun) {
    return null;
  }
  return buildActiveProductionContinuationFromLegacy({ flow, continuation });
}

function buildGuardBlockedResult(
  current: TaskFlowRecord,
  blockedSummary: string,
): TaskFlowUpdateResult {
  return {
    applied: false,
    reason: "guard_blocked",
    current: cloneFlowRecord(current),
    blockedSummary,
  };
}

function buildMissionSettlementCloseBlockedSummary(decision: MissionSettlementDecision): string {
  return `Mission settlement tail is not settled: ${decision.state} at ${decision.nextIncompleteBoundary}; next action is ${decision.recoveryAction}.`;
}

function getBlockingTaskFlowMissionSettlement(
  flow: TaskFlowRecord,
): MissionSettlementDecision | null {
  const decision = getTaskFlowMissionSettlement(flow);
  if (!decision || decision.allowedToCloseMission || decision.settled) {
    return null;
  }
  return decision;
}

function assertFlowOwnerKey(ownerKey: string): string {
  const normalized = normalizeOptionalString(ownerKey);
  if (!normalized) {
    throw new Error("Flow ownerKey is required.");
  }
  return normalized;
}

function assertControllerId(controllerId?: string | null): string {
  const normalized = normalizeOptionalString(controllerId);
  if (!normalized) {
    throw new Error("Managed flow controllerId is required.");
  }
  return normalized;
}

function resolveFlowBlockedSummary(
  task: Pick<TaskRecord, "status" | "terminalOutcome" | "terminalSummary" | "progressSummary">,
): string | undefined {
  if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
    return undefined;
  }
  return (
    normalizeOptionalString(task.terminalSummary) ?? normalizeOptionalString(task.progressSummary)
  );
}

export function deriveTaskFlowStatusFromTask(
  task: Pick<TaskRecord, "status" | "terminalOutcome">,
): TaskFlowStatus {
  if (task.status === "queued") {
    return "queued";
  }
  if (task.status === "running") {
    return "running";
  }
  if (task.status === "succeeded") {
    return task.terminalOutcome === "blocked" ? "blocked" : "succeeded";
  }
  if (task.status === "cancelled") {
    return "cancelled";
  }
  if (task.status === "lost") {
    return "lost";
  }
  return "failed";
}

function isTerminalTaskFlowStatus(status: TaskFlowStatus): boolean {
  return (
    status === "succeeded" ||
    status === "terminal_pending_watchdog" ||
    status === "blocked" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function resolveTaskMirroredFlowTiming(
  task: Pick<TaskRecord, "createdAt" | "lastEventAt" | "endedAt">,
  isTerminal: boolean,
): { updatedAt: number; endedAt?: number } {
  if (!isTerminal) {
    return { updatedAt: task.lastEventAt ?? task.createdAt };
  }
  const endedAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return { updatedAt: endedAt, endedAt };
}

function ensureFlowRegistryReady() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = getTaskFlowRegistryStore().loadSnapshot();
    flows.clear();
    for (const [flowId, flow] of restored.flows) {
      flows.set(flowId, normalizeRestoredFlowRecord(flow));
    }
    restoreFailureMessage = null;
  } catch (error) {
    flows.clear();
    restoreFailureMessage = formatErrorMessage(error);
    log.warn("Failed to restore task-flow registry", { error });
    return;
  }
  emitFlowRegistryObserverEvent(() => ({
    kind: "restored",
    flows: snapshotFlowRecords(flows),
  }));
}

export function getTaskFlowRegistryRestoreFailure(): string | null {
  ensureFlowRegistryReady();
  return restoreFailureMessage;
}

function createFlowSnapshotWith(next?: TaskFlowRecord, deletedFlowId?: string) {
  const snapshot = new Map(snapshotFlowRecords(flows).map((flow) => [flow.flowId, flow]));
  if (deletedFlowId) {
    snapshot.delete(deletedFlowId);
  }
  if (next) {
    snapshot.set(next.flowId, cloneFlowRecord(next));
  }
  return snapshot;
}

function persistFlowRegistry(): boolean {
  try {
    getTaskFlowRegistryStore().saveSnapshot({
      flows: createFlowSnapshotWith(),
    });
    restoreFailureMessage = null;
    return true;
  } catch (error) {
    log.warn("Failed to persist task-flow registry snapshot", { error });
    return false;
  }
}

function persistFlowUpsert(flow: TaskFlowRecord) {
  const store = getTaskFlowRegistryStore();
  if (store.upsertFlow) {
    store.upsertFlow(cloneFlowRecord(flow));
    return;
  }
  store.saveSnapshot({
    flows: createFlowSnapshotWith(flow),
  });
}

function tryPersistFlowUpsert(flow: TaskFlowRecord, operation: string): boolean {
  try {
    persistFlowUpsert(flow);
    return true;
  } catch (error) {
    log.warn("Failed to persist task-flow registry upsert", {
      operation,
      flowId: flow.flowId,
      error,
    });
    return false;
  }
}

function persistFlowDelete(flowId: string) {
  const store = getTaskFlowRegistryStore();
  if (store.deleteFlow) {
    store.deleteFlow(flowId);
    return;
  }
  store.saveSnapshot({
    flows: createFlowSnapshotWith(undefined, flowId),
  });
}

function tryPersistFlowDelete(flowId: string): boolean {
  try {
    persistFlowDelete(flowId);
    return true;
  } catch (error) {
    log.warn("Failed to persist task-flow registry delete", {
      flowId,
      error,
    });
    return false;
  }
}

function buildFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord {
  const now = params.createdAt ?? Date.now();
  const syncMode = params.syncMode ?? "managed";
  const controllerId = syncMode === "managed" ? assertControllerId(params.controllerId) : undefined;
  return {
    flowId: crypto.randomUUID(),
    syncMode,
    ownerKey: assertFlowOwnerKey(params.ownerKey),
    ...(params.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(params.requesterOrigin)! }
      : {}),
    ...(controllerId ? { controllerId } : {}),
    revision: Math.max(0, params.revision ?? 0),
    status: params.status ?? "queued",
    notifyPolicy: ensureNotifyPolicy(params.notifyPolicy),
    goal: params.goal,
    currentStep: normalizeOptionalString(params.currentStep),
    blockedTaskId: normalizeOptionalString(params.blockedTaskId),
    blockedSummary: normalizeOptionalString(params.blockedSummary),
    ...(normalizeJsonBlob(params.stateJson) !== undefined
      ? { stateJson: normalizeJsonBlob(params.stateJson)! }
      : {}),
    ...(normalizeJsonBlob(params.waitJson) !== undefined
      ? { waitJson: normalizeJsonBlob(params.waitJson)! }
      : {}),
    ...(params.cancelRequestedAt != null ? { cancelRequestedAt: params.cancelRequestedAt } : {}),
    createdAt: now,
    updatedAt: params.updatedAt ?? now,
    ...(params.endedAt != null ? { endedAt: params.endedAt } : {}),
  };
}

function applyFlowPatch(current: TaskFlowRecord, patch: FlowRecordPatch): TaskFlowRecord {
  const controllerId =
    patch.controllerId === undefined
      ? current.controllerId
      : normalizeOptionalString(patch.controllerId);
  if (current.syncMode === "managed") {
    assertControllerId(controllerId);
  }
  return {
    ...current,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.notifyPolicy ? { notifyPolicy: patch.notifyPolicy } : {}),
    ...(patch.goal ? { goal: patch.goal } : {}),
    controllerId,
    currentStep:
      patch.currentStep === undefined
        ? current.currentStep
        : normalizeOptionalString(patch.currentStep),
    blockedTaskId:
      patch.blockedTaskId === undefined
        ? current.blockedTaskId
        : normalizeOptionalString(patch.blockedTaskId),
    blockedSummary:
      patch.blockedSummary === undefined
        ? current.blockedSummary
        : normalizeOptionalString(patch.blockedSummary),
    stateJson:
      patch.stateJson === undefined ? current.stateJson : normalizeJsonBlob(patch.stateJson),
    waitJson: patch.waitJson === undefined ? current.waitJson : normalizeJsonBlob(patch.waitJson),
    cancelRequestedAt:
      patch.cancelRequestedAt === undefined
        ? current.cancelRequestedAt
        : (patch.cancelRequestedAt ?? undefined),
    revision: current.revision + 1,
    updatedAt: patch.updatedAt ?? Date.now(),
    endedAt: patch.endedAt === undefined ? current.endedAt : (patch.endedAt ?? undefined),
  };
}

function writeFlowRecord(next: TaskFlowRecord, previous?: TaskFlowRecord): TaskFlowRecord | null {
  if (!tryPersistFlowUpsert(next, previous ? "update" : "create")) {
    return null;
  }
  restoreFailureMessage = null;
  flows.set(next.flowId, next);
  emitFlowRegistryObserverEvent(() => ({
    kind: "upserted",
    flow: cloneFlowRecord(next),
    ...(previous ? { previous: cloneFlowRecord(previous) } : {}),
  }));
  return cloneFlowRecord(next);
}

export function createFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord | null {
  ensureFlowRegistryReady();
  const record = buildFlowRecord(params);
  return writeFlowRecord(record);
}

export function createManagedTaskFlow(
  params: FlowRecordCreateFields & {
    controllerId: string;
    continuation?: Partial<ProductionContinuationState>;
  },
): TaskFlowRecord | null {
  const createdAt = params.createdAt ?? Date.now();
  const continuation =
    params.continuation?.activeProductionRun === true
      ? createStartedProductionContinuationState({
          continuation: params.continuation,
          at: createdAt,
        })
      : undefined;
  const flowPreview = {
    syncMode: "managed",
    controllerId: params.controllerId,
    stateJson: params.stateJson,
  } as TaskFlowRecord;
  return createFlowRecord({
    ...params,
    syncMode: "managed",
    controllerId: assertControllerId(params.controllerId),
    stateJson: attachProductionContinuationToStateJson({
      flow: flowPreview,
      stateJson: params.stateJson,
      continuation,
    }),
    createdAt,
  });
}

export function createBlindTestSliceFlow(params: {
  ownerKey: string;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  sliceKey: string;
  subjectAgent: string;
  createdAt?: number;
  updatedAt?: number;
  continuation?: Partial<ProductionContinuationState>;
}): TaskFlowRecord | null {
  return createManagedTaskFlow({
    ownerKey: params.ownerKey,
    requesterOrigin: params.requesterOrigin,
    controllerId: BLIND_TEST_SLICE_CONTROLLER_ID,
    notifyPolicy: params.notifyPolicy,
    status: "running",
    goal: params.goal,
    currentStep: "draft_review_required",
    stateJson: createBlindTestSliceState({
      sliceKey: params.sliceKey,
      subjectAgent: params.subjectAgent,
      createdAt: params.createdAt,
      continuation: params.continuation,
    }),
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  });
}

export function createNextBlindTestSliceFlow(params: {
  previousFlowId: string;
  expectedPreviousRevision: number;
  goal: string;
  sliceKey: string;
  subjectAgent: string;
  createdAt?: number;
  updatedAt?: number;
}): BlindTestSliceCreateResult {
  const previous = getTaskFlowById(params.previousFlowId);
  if (!previous || !isBlindTestSliceFlow(previous)) {
    return {
      created: false,
      reason: "previous_slice_not_found",
      blockedSummary: "Previous blind-test slice was not found.",
    };
  }
  if (previous.revision !== params.expectedPreviousRevision) {
    return {
      created: false,
      reason: "previous_slice_not_complete",
      current: previous,
      blockedSummary: "Previous blind-test slice changed before the next slice could start.",
    };
  }
  const previousState = getBlindTestSliceState(previous);
  const continuationAllowsPreCloseLaunch =
    previousState?.continuation?.continuationRequiredAfterLocalSuccess === true &&
    previousState.implementation.verdict === "passed";
  if (
    !previousState ||
    previousState.implementation.verdict !== "passed" ||
    (previous.status !== "succeeded" && !continuationAllowsPreCloseLaunch)
  ) {
    return {
      created: false,
      reason: "previous_slice_not_complete",
      current: previous,
      blockedSummary:
        "Next blind-test slice cannot start until the prior slice has a passing implementation review and is closed successfully.",
    };
  }
  let previousRevision = params.expectedPreviousRevision;
  let requesterOrigin = previous.requesterOrigin;
  let notifyPolicy = previous.notifyPolicy;
  let ownerKey = previous.ownerKey;
  if (
    continuationAllowsPreCloseLaunch &&
    previousState.continuation?.nextExecutableUnitLaunched !== true
  ) {
    const launchedAt = params.updatedAt ?? params.createdAt ?? Date.now();
    const launchedContinuation = updateContinuationAfterNextLaunch(
      previousState.continuation,
      launchedAt,
      `Launch blind-test slice ${params.sliceKey}`,
    );
    const updatedPrevious = updateFlowRecordByIdExpectedRevision({
      flowId: previous.flowId,
      expectedRevision: params.expectedPreviousRevision,
      patch: {
        status: "running",
        currentStep: "next_executable_unit_launched_ready_for_closeout",
        stateJson: {
          ...previousState,
          ...(launchedContinuation ? { continuation: launchedContinuation } : {}),
        },
        blockedSummary: null,
        updatedAt: launchedAt,
      },
    });
    if (!updatedPrevious.applied) {
      return {
        created: false,
        reason:
          updatedPrevious.reason === "persist_failed"
            ? "persist_failed"
            : "previous_slice_not_complete",
        ...(updatedPrevious.current ? { current: updatedPrevious.current } : {}),
        blockedSummary:
          updatedPrevious.blockedSummary ??
          "Previous blind-test slice changed before the next slice could start.",
      };
    }
    previousRevision = updatedPrevious.flow.revision;
    requesterOrigin = updatedPrevious.flow.requesterOrigin;
    notifyPolicy = updatedPrevious.flow.notifyPolicy;
    ownerKey = updatedPrevious.flow.ownerKey;
  }
  const flow = createBlindTestSliceFlow({
    ownerKey,
    requesterOrigin,
    notifyPolicy,
    goal: params.goal,
    sliceKey: params.sliceKey,
    subjectAgent: params.subjectAgent,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
    continuation:
      previousState.continuation?.activeProductionRun === true
        ? {
            activeProductionRun: true,
            parentRunOpen: previousState.continuation.parentRunOpen,
          }
        : undefined,
  });
  if (!flow) {
    return {
      created: false,
      reason: "persist_failed",
      blockedSummary: "Blind-test slice persistence failed.",
    };
  }
  return {
    created: true,
    flow,
    ...(previousRevision !== params.expectedPreviousRevision
      ? { previousFlow: getTaskFlowById(params.previousFlowId) ?? undefined }
      : {}),
  };
}

export function createTaskFlowForTask(params: {
  task: Pick<
    TaskRecord,
    | "ownerKey"
    | "taskId"
    | "notifyPolicy"
    | "status"
    | "terminalOutcome"
    | "label"
    | "task"
    | "createdAt"
    | "lastEventAt"
    | "endedAt"
    | "terminalSummary"
    | "progressSummary"
  >;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
}): TaskFlowRecord | null {
  const terminalFlowStatus = deriveTaskFlowStatusFromTask(params.task);
  const timing = resolveTaskMirroredFlowTiming(
    params.task,
    isTerminalTaskFlowStatus(terminalFlowStatus),
  );
  return createFlowRecord({
    syncMode: "task_mirrored",
    ownerKey: params.task.ownerKey,
    requesterOrigin: params.requesterOrigin,
    status: terminalFlowStatus,
    notifyPolicy: params.task.notifyPolicy,
    goal:
      normalizeOptionalString(params.task.label) ?? (params.task.task.trim() || "Background task"),
    blockedTaskId:
      terminalFlowStatus === "blocked" ? normalizeOptionalString(params.task.taskId) : undefined,
    blockedSummary: resolveFlowBlockedSummary(params.task),
    createdAt: params.task.createdAt,
    updatedAt: timing.updatedAt,
    ...(timing.endedAt !== undefined ? { endedAt: timing.endedAt } : {}),
  });
}

function updateFlowRecordByIdUnchecked(
  flowId: string,
  patch: FlowRecordPatch,
): TaskFlowRecord | null {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return null;
  }
  return writeFlowRecord(applyFlowPatch(current, patch), current);
}

export function updateFlowRecordByIdExpectedRevision(params: {
  flowId: string;
  expectedRevision: number;
  patch: FlowRecordPatch;
}): TaskFlowUpdateResult {
  ensureFlowRegistryReady();
  const current = flows.get(params.flowId);
  if (!current) {
    return {
      applied: false,
      reason: "not_found",
    };
  }
  if (current.revision !== params.expectedRevision) {
    return {
      applied: false,
      reason: "revision_conflict",
      current: cloneFlowRecord(current),
    };
  }
  const flow = writeFlowRecord(applyFlowPatch(current, params.patch), current);
  if (!flow) {
    return {
      applied: false,
      reason: "persist_failed",
      current: cloneFlowRecord(current),
    };
  }
  return {
    applied: true,
    flow,
  };
}

export function setFlowWaiting(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status:
        normalizeOptionalString(params.blockedTaskId) ||
        normalizeOptionalString(params.blockedSummary)
          ? "blocked"
          : "waiting",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: params.waitJson,
      blockedTaskId: params.blockedTaskId,
      blockedSummary: params.blockedSummary,
      endedAt: null,
      updatedAt: params.updatedAt,
    },
  });
}

export function resumeFlow(params: {
  flowId: string;
  expectedRevision: number;
  status?: Extract<TaskFlowStatus, "queued" | "running">;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: params.status ?? "queued",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt: null,
      updatedAt: params.updatedAt,
    },
  });
}

export function recordBlindTestDraftReview(params: {
  flowId: string;
  expectedRevision: number;
  verdict: Extract<BlindTestStageVerdict, "passed" | "failed">;
  summary?: string | null;
  reviewedAt?: number;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      applied: false,
      reason: "not_found",
    };
  }
  if (!isBlindTestSliceFlow(flow)) {
    return buildGuardBlockedResult(flow, "Draft review is only valid for blind-test slice flows.");
  }
  const currentState = getBlindTestSliceState(flow);
  if (!currentState) {
    return buildGuardBlockedResult(flow, "Blind-test slice state is missing or invalid.");
  }
  const reviewedAt = params.reviewedAt ?? params.updatedAt ?? Date.now();
  const nextState: BlindTestSliceState = {
    ...currentState,
    draft: {
      verdict: params.verdict,
      reviewedAt,
      ...(normalizeOptionalString(params.summary)
        ? { summary: normalizeOptionalString(params.summary)! }
        : {}),
    },
    implementation:
      params.verdict === "failed" ? { verdict: "pending" } : currentState.implementation,
    ...(params.verdict === "failed"
      ? {
          rework: buildBlindTestReworkState({
            current: currentState,
            stage: "draft",
            reviewedAt,
            summary: params.summary,
          }),
        }
      : { rework: undefined }),
  };
  const transferToWill = nextState.rework?.transferOwner === "Will";
  return updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: params.verdict === "passed" ? "running" : "blocked",
      currentStep:
        params.verdict === "passed"
          ? "implementation_review_required"
          : transferToWill
            ? "will_takeover_required"
            : "draft_rework_required",
      stateJson: nextState,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary:
        params.verdict === "failed"
          ? transferToWill
            ? "Blind-test slice failed three times. Transfer this same slice to Will now."
            : (normalizeOptionalString(params.summary) ?? "Draft review failed.")
          : null,
      endedAt: null,
      updatedAt: params.updatedAt ?? reviewedAt,
    },
  });
}

export function recordBlindTestImplementationReview(params: {
  flowId: string;
  expectedRevision: number;
  verdict: Extract<BlindTestStageVerdict, "passed" | "failed">;
  summary?: string | null;
  reviewedAt?: number;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      applied: false,
      reason: "not_found",
    };
  }
  if (!isBlindTestSliceFlow(flow)) {
    return buildGuardBlockedResult(
      flow,
      "Implementation review is only valid for blind-test slice flows.",
    );
  }
  const currentState = getBlindTestSliceState(flow);
  if (!currentState) {
    return buildGuardBlockedResult(flow, "Blind-test slice state is missing or invalid.");
  }
  if (currentState.draft.verdict !== "passed") {
    return buildGuardBlockedResult(
      flow,
      "Implementation review cannot complete until the blind-test draft review passes.",
    );
  }
  const reviewedAt = params.reviewedAt ?? params.updatedAt ?? Date.now();
  const continuation: ProductionContinuationState | undefined =
    params.verdict === "passed"
      ? updateContinuationAfterPass(currentState.continuation, reviewedAt)
      : currentState.continuation
        ? {
            ...currentState.continuation,
            currentUnitStatus: "blocked",
          }
        : undefined;
  const nextState: BlindTestSliceState = {
    ...currentState,
    implementation: {
      verdict: params.verdict,
      reviewedAt,
      ...(normalizeOptionalString(params.summary)
        ? { summary: normalizeOptionalString(params.summary)! }
        : {}),
    },
    ...(params.verdict === "failed"
      ? {
          rework: buildBlindTestReworkState({
            current: currentState,
            stage: "implementation",
            reviewedAt,
            summary: params.summary,
          }),
        }
      : { rework: undefined }),
    ...(continuation ? { continuation } : {}),
  };
  const transferToWill = nextState.rework?.transferOwner === "Will";
  return updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: params.verdict === "passed" ? "running" : "blocked",
      currentStep:
        params.verdict === "passed"
          ? "implementation_passed_ready_for_closeout"
          : transferToWill
            ? "will_takeover_required"
            : "implementation_rework_required",
      stateJson: nextState,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary:
        params.verdict === "failed"
          ? transferToWill
            ? "Blind-test slice failed three times. Transfer this same slice to Will now."
            : (normalizeOptionalString(params.summary) ?? "Implementation review failed.")
          : null,
      endedAt: null,
      updatedAt: params.updatedAt ?? reviewedAt,
    },
  });
}

export function recordBlindTestCloseoutFailure(params: {
  flowId: string;
  expectedRevision: number;
  summary?: string | null;
  outcomeCode?: string | null;
  reviewedAt?: number;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      applied: false,
      reason: "not_found",
    };
  }
  if (!isBlindTestSliceFlow(flow)) {
    return buildGuardBlockedResult(
      flow,
      "Closeout review is only valid for blind-test slice flows.",
    );
  }
  const currentState = getBlindTestSliceState(flow);
  if (!currentState) {
    return buildGuardBlockedResult(flow, "Blind-test slice state is missing or invalid.");
  }
  const reviewedAt = params.reviewedAt ?? params.updatedAt ?? Date.now();
  const rework = buildBlindTestReworkState({
    current: currentState,
    stage: "closeout",
    reviewedAt,
    summary: params.summary,
    outcomeCode: params.outcomeCode,
  });
  const transferToWill = rework.transferOwner === "Will";
  return updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: "blocked",
      currentStep: transferToWill ? "will_takeover_required" : "closeout_rework_required",
      stateJson: {
        ...currentState,
        rework,
      },
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: transferToWill
        ? "Blind-test slice failed three times. Transfer this same slice to Will now."
        : (normalizeOptionalString(params.summary) ?? "Closeout review failed."),
      endedAt: null,
      updatedAt: params.updatedAt ?? reviewedAt,
    },
  });
}

export function finishFlow(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
  endedAt?: number;
}): TaskFlowUpdateResult {
  const current = getTaskFlowById(params.flowId);
  if (!current) {
    return {
      applied: false,
      reason: "not_found",
    };
  }
  const missionSettlement = getBlockingTaskFlowMissionSettlement(current);
  if (missionSettlement) {
    const detail = buildMissionSettlementCloseBlockedSummary(missionSettlement);
    const blockedAt = params.updatedAt ?? params.endedAt ?? Date.now();
    const violationUpdate = updateFlowRecordByIdExpectedRevision({
      flowId: current.flowId,
      expectedRevision: params.expectedRevision,
      patch: {
        status: "blocked",
        currentStep: "mission_settlement_tail_open",
        blockedSummary: detail,
        endedAt: null,
        updatedAt: blockedAt,
      },
    });
    return {
      applied: false,
      reason: "guard_blocked",
      ...(violationUpdate.applied ? { current: violationUpdate.flow } : { current }),
      blockedSummary: detail,
    };
  }
  if (isBlindTestSliceFlow(current)) {
    const state = getBlindTestSliceState(current);
    if (!state) {
      return buildGuardBlockedResult(
        current,
        "Blind-test slice cannot close because its state is missing or invalid.",
      );
    }
    if (state.implementation.verdict !== "passed") {
      return buildGuardBlockedResult(
        current,
        "Blind-test slice cannot close until the implemented slice passes review.",
      );
    }
    if (
      state.continuation?.activeProductionRun === true &&
      state.continuation.continuationRequiredAfterLocalSuccess &&
      !state.continuation.nextExecutableUnitLaunched &&
      !hasLawfulStopState(state.continuation)
    ) {
      const violationAt = params.updatedAt ?? params.endedAt ?? Date.now();
      const detail =
        "Active production run cannot pause or close after a passed bounded unit before the next executable unit launches.";
      const violationState: BlindTestSliceState = {
        ...state,
        continuation: updateContinuationAfterViolation(state.continuation, violationAt, detail),
      };
      const violationUpdate = updateFlowRecordByIdExpectedRevision({
        flowId: current.flowId,
        expectedRevision: params.expectedRevision,
        patch: {
          status: "blocked",
          currentStep: "continuation_launch_required",
          stateJson: violationState,
          blockedSummary: detail,
          updatedAt: violationAt,
        },
      });
      return {
        applied: false,
        reason: "guard_blocked",
        ...(violationUpdate.applied ? { current: violationUpdate.flow } : { current }),
        blockedSummary: detail,
      };
    }
  }
  const terminalAt = params.endedAt ?? params.updatedAt ?? Date.now();
  let stateJson = params.stateJson;
  const continuation = getTaskFlowProductionContinuation(current);
  if (continuation?.activeProductionRun === true) {
    const passedContinuation =
      continuation.currentUnitStatus === "passed" || continuation.currentUnitStatus === "completed"
        ? continuation
        : updateContinuationAfterPass(continuation, terminalAt);
    if (
      passedContinuation?.continuationRequiredAfterLocalSuccess &&
      !passedContinuation.nextExecutableUnitLaunched &&
      !hasLawfulStopState(passedContinuation)
    ) {
      const detail =
        "Active production run cannot pause or close after a passed bounded unit before the next executable unit launches.";
      const violationContinuation = updateContinuationAfterViolation(
        passedContinuation,
        terminalAt,
        detail,
      );
      const violationUpdate = updateFlowRecordByIdExpectedRevision({
        flowId: current.flowId,
        expectedRevision: params.expectedRevision,
        patch: {
          status: "blocked",
          currentStep: "continuation_launch_required",
          stateJson: attachProductionContinuationToStateJson({
            flow: current,
            stateJson: params.stateJson,
            continuation: violationContinuation,
          }),
          blockedSummary: detail,
          updatedAt: terminalAt,
        },
      });
      return {
        applied: false,
        reason: "guard_blocked",
        ...(violationUpdate.applied ? { current: violationUpdate.flow } : { current }),
        blockedSummary: detail,
      };
    }
    stateJson = attachProductionContinuationToStateJson({
      flow: current,
      stateJson,
      continuation: passedContinuation,
    });
  }
  const endedAt = terminalAt;
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: "succeeded",
      currentStep: params.currentStep,
      stateJson,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt,
      updatedAt: params.updatedAt ?? endedAt,
    },
  });
}

function updateContinuationForLawfulStop(params: {
  state: ProductionContinuationState | undefined;
  reason: ProductionContinuationStopReason;
  at: number;
  detail?: string;
}): ProductionContinuationState | undefined {
  if (!params.state?.activeProductionRun) {
    return params.state;
  }
  let next: ProductionContinuationState = {
    ...params.state,
    currentUnitStatus:
      params.reason === "whole_run_complete"
        ? "completed"
        : params.reason === "blocker"
          ? "blocked"
          : params.state.currentUnitStatus,
    blockerPresent: params.reason === "blocker",
    ownerDecisionRequired: params.reason === "owner_decision",
    restartOrReloadRequired: params.reason === "restart_or_reload",
    hardStopPresent: params.reason === "hard_stop",
    safetyStopPresent: params.reason === "safety_stop",
    lawfulWholeRunCompletion: params.reason === "whole_run_complete",
    parentRunOpen: params.reason === "whole_run_complete" ? false : params.state.parentRunOpen,
    continuationRequiredAfterLocalSuccess: false,
    continuationViolation: false,
    lawfulStopReason: params.reason,
  };
  next = appendContinuationEvent(
    next,
    "LAWFUL_STOP_ALLOWED",
    params.at,
    params.detail ?? params.reason,
  );
  return next;
}

export function recordFlowNextExecutableLaunch(params: {
  flowId: string;
  expectedRevision: number;
  detail: string;
  currentStep?: string | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  const current = getTaskFlowById(params.flowId);
  if (!current) {
    return {
      applied: false,
      reason: "not_found",
    };
  }
  const continuation = getTaskFlowProductionContinuation(current);
  if (!continuation?.activeProductionRun) {
    return buildGuardBlockedResult(
      current,
      "Flow is not currently bound to an active production continuation contract.",
    );
  }
  const launchedAt = params.updatedAt ?? Date.now();
  const passedContinuation =
    continuation.currentUnitStatus === "passed" || continuation.currentUnitStatus === "completed"
      ? continuation
      : updateContinuationAfterPass(continuation, launchedAt);
  const launchedContinuation = updateContinuationAfterNextLaunch(
    passedContinuation,
    launchedAt,
    params.detail,
  );
  return updateFlowRecordByIdExpectedRevision({
    flowId: current.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: "running",
      currentStep: params.currentStep,
      stateJson: attachProductionContinuationToStateJson({
        flow: current,
        continuation: launchedContinuation,
      }),
      blockedSummary: null,
      endedAt: null,
      updatedAt: launchedAt,
    },
  });
}

export function recordFlowLawfulStop(params: {
  flowId: string;
  expectedRevision: number;
  reason: ProductionContinuationStopReason;
  status?: Extract<TaskFlowStatus, "blocked" | "cancelled">;
  detail?: string | null;
  currentStep?: string | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  const current = getTaskFlowById(params.flowId);
  if (!current) {
    return {
      applied: false,
      reason: "not_found",
    };
  }
  const continuation = getTaskFlowProductionContinuation(current);
  if (!continuation?.activeProductionRun) {
    return buildGuardBlockedResult(
      current,
      "Flow is not currently bound to an active production continuation contract.",
    );
  }
  if (params.reason === "whole_run_complete") {
    const missionSettlement = getBlockingTaskFlowMissionSettlement(current);
    if (missionSettlement) {
      const detail = buildMissionSettlementCloseBlockedSummary(missionSettlement);
      const blockedAt = params.updatedAt ?? Date.now();
      const violationUpdate = updateFlowRecordByIdExpectedRevision({
        flowId: current.flowId,
        expectedRevision: params.expectedRevision,
        patch: {
          status: "blocked",
          currentStep: "mission_settlement_tail_open",
          blockedSummary: detail,
          endedAt: null,
          updatedAt: blockedAt,
        },
      });
      return {
        applied: false,
        reason: "guard_blocked",
        ...(violationUpdate.applied ? { current: violationUpdate.flow } : { current }),
        blockedSummary: detail,
      };
    }
  }
  const updatedAt = params.updatedAt ?? Date.now();
  const nextContinuation = updateContinuationForLawfulStop({
    state: continuation,
    reason: params.reason,
    at: updatedAt,
    detail: normalizeOptionalString(params.detail) ?? undefined,
  });
  return updateFlowRecordByIdExpectedRevision({
    flowId: current.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status:
        params.reason === "whole_run_complete"
          ? "terminal_pending_watchdog"
          : (params.status ?? "blocked"),
      currentStep: params.currentStep,
      stateJson: attachProductionContinuationToStateJson({
        flow: current,
        continuation: nextContinuation,
      }),
      blockedSummary:
        params.reason === "whole_run_complete"
          ? null
          : (normalizeOptionalString(params.detail) ?? current.blockedSummary ?? null),
      endedAt: null,
      updatedAt,
    },
  });
}

export function failFlow(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  updatedAt?: number;
  endedAt?: number;
}): TaskFlowUpdateResult {
  const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: "failed",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: null,
      blockedTaskId: params.blockedTaskId,
      blockedSummary: params.blockedSummary,
      endedAt,
      updatedAt: params.updatedAt ?? endedAt,
    },
  });
}

export function requestFlowCancel(params: {
  flowId: string;
  expectedRevision: number;
  cancelRequestedAt?: number;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      cancelRequestedAt: params.cancelRequestedAt ?? params.updatedAt ?? Date.now(),
      updatedAt: params.updatedAt,
    },
  });
}

export function syncFlowFromTaskResult(
  task: Pick<
    TaskRecord,
    | "parentFlowId"
    | "status"
    | "terminalOutcome"
    | "notifyPolicy"
    | "label"
    | "task"
    | "lastEventAt"
    | "endedAt"
    | "taskId"
    | "terminalSummary"
    | "progressSummary"
  >,
): TaskFlowSyncResult {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return { ok: true, flow: null };
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return { ok: true, flow: null };
  }
  if (flow.syncMode !== "task_mirrored") {
    return { ok: true, flow };
  }
  const terminalFlowStatus = deriveTaskFlowStatusFromTask(task);
  const isTerminal = isTerminalTaskFlowStatus(terminalFlowStatus);
  const timing = resolveTaskMirroredFlowTiming(
    {
      createdAt: flow.createdAt,
      lastEventAt: task.lastEventAt,
      endedAt: task.endedAt,
    },
    isTerminal,
  );
  const updated = updateFlowRecordByIdUnchecked(flowId, {
    status: terminalFlowStatus,
    notifyPolicy: task.notifyPolicy,
    goal: normalizeOptionalString(task.label) ?? (task.task.trim() || "Background task"),
    blockedTaskId: terminalFlowStatus === "blocked" ? task.taskId.trim() || null : null,
    blockedSummary:
      terminalFlowStatus === "blocked" ? (resolveFlowBlockedSummary(task) ?? null) : null,
    waitJson: null,
    updatedAt: timing.updatedAt,
    ...(isTerminal
      ? {
          endedAt: timing.endedAt ?? timing.updatedAt,
        }
      : { endedAt: null }),
  });
  if (!updated) {
    return {
      ok: false,
      reason: "persist_failed",
      current: flow,
    };
  }
  return { ok: true, flow: updated };
}

export function syncFlowFromTask(
  task: Parameters<typeof syncFlowFromTaskResult>[0],
): TaskFlowRecord | null {
  const result = syncFlowFromTaskResult(task);
  return result.ok ? result.flow : null;
}

export function getTaskFlowById(flowId: string): TaskFlowRecord | undefined {
  ensureFlowRegistryReady();
  const flow = flows.get(flowId);
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function listTaskFlowsForOwnerKey(ownerKey: string): TaskFlowRecord[] {
  ensureFlowRegistryReady();
  const normalizedOwnerKey = ownerKey.trim();
  if (!normalizedOwnerKey) {
    return [];
  }
  return [...flows.values()]
    .filter((flow) => flow.ownerKey.trim() === normalizedOwnerKey)
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function findLatestTaskFlowForOwnerKey(ownerKey: string): TaskFlowRecord | undefined {
  const flow = listTaskFlowsForOwnerKey(ownerKey)[0];
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function resolveTaskFlowForLookupToken(token: string): TaskFlowRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return getTaskFlowById(lookup) ?? findLatestTaskFlowForOwnerKey(lookup);
}

export function listTaskFlowRecords(): TaskFlowRecord[] {
  ensureFlowRegistryReady();
  return [...flows.values()]
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function deleteTaskFlowRecordById(flowId: string): boolean {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return false;
  }
  if (!tryPersistFlowDelete(flowId)) {
    return false;
  }
  restoreFailureMessage = null;
  flows.delete(flowId);
  emitFlowRegistryObserverEvent(() => ({
    kind: "deleted",
    flowId,
    previous: cloneFlowRecord(current),
  }));
  return true;
}

export function resetTaskFlowRegistryForTests(opts?: { persist?: boolean }) {
  flows.clear();
  restoreAttempted = false;
  restoreFailureMessage = null;
  resetTaskFlowRegistryRuntimeForTests();
  if (opts?.persist !== false) {
    persistFlowRegistry();
  }
  getTaskFlowRegistryStore().close?.();
}
