import type { JsonValue, TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { GovernedAuthorityRef, GovernedMissionContract } from "./governed-mission-contract.js";

export const GOVERNED_MISSION_STATE_VALUES = [
  "GOVERNED_MISSION_ACTIVE",
  "GOVERNED_MISSION_WAITING",
  "GOVERNED_MISSION_PENDING_OVERRIDE",
  "AWAITING_CLOSEOUT",
  "GOVERNED_MISSION_BLOCKED",
  "GOVERNED_MISSION_TERMINAL",
] as const;

export type GovernedMissionStateValue = (typeof GOVERNED_MISSION_STATE_VALUES)[number];

export const GOVERNED_MISSION_TERMINAL_STATUSES = [
  "not_terminal",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const;

export type GovernedMissionTerminalStatus = (typeof GOVERNED_MISSION_TERMINAL_STATUSES)[number];

export const GOVERNED_MISSION_BLOCKED_STATUSES = [
  "not_blocked",
  "stale_authority_hash",
  "contract_hash_mismatch",
  "revision_mismatch",
  "readmission_required",
] as const;

export type GovernedMissionBlockedStatus = (typeof GOVERNED_MISSION_BLOCKED_STATUSES)[number];

export const GOVERNED_OVERRIDE_STATUSES = [
  "none",
  "pending",
  "approved",
  "denied",
  "expired",
] as const;

export type GovernedOverrideStatus = (typeof GOVERNED_OVERRIDE_STATUSES)[number];

export type GovernedMissionOwnerCorrelation = {
  owner: string;
  sessionKey?: string;
  runId?: string;
  taskFlowId?: string;
  taskRegistryTaskId?: string;
  cleanupCrewRunId?: string;
};

export type GovernedMissionOverrideRef = {
  overrideId?: string;
  status: GovernedOverrideStatus;
};

export type GovernedMissionState = {
  schema: "openclaw.governed_mission_state.v1";
  missionId: string;
  contractId: string;
  contractVersion: string;
  contractHash: string;
  authorityHash: string;
  authorityRef: GovernedAuthorityRef;
  readmissionAuthorityRef?: GovernedAuthorityRef;
  parentMissionRef?: string;
  currentGovernedState: GovernedMissionStateValue;
  currentStep: string;
  ownerCorrelation: GovernedMissionOwnerCorrelation;
  overrideRef: GovernedMissionOverrideRef;
  terminalStatus: GovernedMissionTerminalStatus;
  blockedStatus: GovernedMissionBlockedStatus;
  revision: number;
  stateVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateGovernedMissionStateInput = {
  contract: GovernedMissionContract;
  authorityRef: GovernedAuthorityRef;
  currentStep: string;
  ownerCorrelation: GovernedMissionOwnerCorrelation;
  parentMissionRef?: string;
  now: string;
};

export type GovernedMissionStateUpdate = {
  expectedRevision: number;
  currentStep?: string;
  currentGovernedState?: GovernedMissionStateValue;
  ownerCorrelation?: GovernedMissionOwnerCorrelation;
  overrideRef?: GovernedMissionOverrideRef;
  terminalStatus?: GovernedMissionTerminalStatus;
  blockedStatus?: GovernedMissionBlockedStatus;
  now: string;
};

export type AuthoritySnapshot = {
  contractHash: string;
  authorityHash: string;
  authorityRef: GovernedAuthorityRef;
};

export type GovernedMissionReadmissionCheck =
  | {
      ok: true;
      state: GovernedMissionState;
    }
  | {
      ok: false;
      state: GovernedMissionState;
      reason: "contract_hash_mismatch" | "stale_authority_hash";
    };

export const GOVERNED_MISSION_TASKFLOW_STATE_KEY = "governedMissionState";

export type GovernedMissionTaskFlowRecord = Pick<
  TaskFlowRecord,
  "flowId" | "revision" | "stateJson"
>;

export type GovernedMissionTaskFlowStatePatch = {
  flowId: string;
  expectedFlowRevision: number;
  stateJson: JsonValue;
};

export function createGovernedMissionState(
  input: CreateGovernedMissionStateInput,
): GovernedMissionState {
  return {
    schema: "openclaw.governed_mission_state.v1",
    missionId: input.contract.missionId,
    contractId: input.contract.contractId,
    contractVersion: input.contract.contractVersion,
    contractHash: input.contract.contractHash,
    authorityHash: input.contract.authorityHash,
    authorityRef: input.authorityRef,
    parentMissionRef: input.parentMissionRef,
    currentGovernedState: "GOVERNED_MISSION_ACTIVE",
    currentStep: input.currentStep,
    ownerCorrelation: input.ownerCorrelation,
    overrideRef: { status: "none" },
    terminalStatus: "not_terminal",
    blockedStatus: "not_blocked",
    revision: 1,
    stateVersion: `${input.contract.contractVersion}:1`,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function updateGovernedMissionState(
  state: GovernedMissionState,
  update: GovernedMissionStateUpdate,
): GovernedMissionState {
  if (state.revision !== update.expectedRevision) {
    throw new Error("governed mission state revision mismatch");
  }
  const revision = state.revision + 1;
  return {
    ...state,
    currentStep: update.currentStep ?? state.currentStep,
    currentGovernedState: update.currentGovernedState ?? state.currentGovernedState,
    ownerCorrelation: update.ownerCorrelation ?? state.ownerCorrelation,
    overrideRef: update.overrideRef ?? state.overrideRef,
    terminalStatus: update.terminalStatus ?? state.terminalStatus,
    blockedStatus: update.blockedStatus ?? state.blockedStatus,
    revision,
    stateVersion: `${state.contractVersion}:${revision}`,
    updatedAt: update.now,
  };
}

export function requireGovernedMissionPinnedAuthority(
  state: GovernedMissionState,
  observed: AuthoritySnapshot,
  now: string,
): GovernedMissionReadmissionCheck {
  if (state.contractHash !== observed.contractHash) {
    return {
      ok: false,
      reason: "contract_hash_mismatch",
      state: blockForReadmission(state, "contract_hash_mismatch", observed.authorityRef, now),
    };
  }
  if (state.authorityHash !== observed.authorityHash) {
    return {
      ok: false,
      reason: "stale_authority_hash",
      state: blockForReadmission(state, "stale_authority_hash", observed.authorityRef, now),
    };
  }
  return { ok: true, state };
}

function blockForReadmission(
  state: GovernedMissionState,
  blockedStatus: Exclude<GovernedMissionBlockedStatus, "not_blocked" | "revision_mismatch">,
  readmissionAuthorityRef: GovernedAuthorityRef,
  now: string,
): GovernedMissionState {
  return updateGovernedMissionState(
    {
      ...state,
      readmissionAuthorityRef,
    },
    {
      expectedRevision: state.revision,
      currentGovernedState: "GOVERNED_MISSION_BLOCKED",
      blockedStatus,
      currentStep: "lawful_readmission_required",
      now,
    },
  );
}

export function buildGovernedMissionTaskFlowStatePatch(
  record: GovernedMissionTaskFlowRecord,
  state: GovernedMissionState,
): GovernedMissionTaskFlowStatePatch {
  if (state.ownerCorrelation.taskFlowId !== record.flowId) {
    throw new Error("governed mission state must be correlated to the TaskFlow record");
  }
  return {
    flowId: record.flowId,
    expectedFlowRevision: record.revision,
    stateJson: {
      ...jsonObject(record.stateJson),
      [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: state as unknown as JsonValue,
    },
  };
}

export function readGovernedMissionStateFromTaskFlow(
  record: GovernedMissionTaskFlowRecord,
): GovernedMissionState | undefined {
  const stateJson = jsonObject(record.stateJson);
  const value = stateJson[GOVERNED_MISSION_TASKFLOW_STATE_KEY];
  if (isGovernedMissionState(value)) {
    return value;
  }
  return undefined;
}

export function buildGovernedMissionTaskFlowUpdatePatch(
  record: GovernedMissionTaskFlowRecord,
  update: GovernedMissionStateUpdate,
): GovernedMissionTaskFlowStatePatch {
  const state = readGovernedMissionStateFromTaskFlow(record);
  if (!state) {
    throw new Error(`governed mission state not found on TaskFlow record: ${record.flowId}`);
  }
  return buildGovernedMissionTaskFlowStatePatch(record, updateGovernedMissionState(state, update));
}

function jsonObject(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function isGovernedMissionState(value: JsonValue | undefined): value is GovernedMissionState {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schema === "openclaw.governed_mission_state.v1" &&
    typeof value.missionId === "string" &&
    typeof value.contractId === "string" &&
    typeof value.revision === "number",
  );
}
