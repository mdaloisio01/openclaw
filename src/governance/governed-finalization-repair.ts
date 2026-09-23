import type { JsonValue } from "../tasks/task-flow-registry.types.js";
import type { GovernedCloseoutValidationResult } from "./governed-closeout-validator.js";
import type { GovernedMissionFailureState } from "./governed-mission-contract.js";
import {
  buildGovernedMissionTaskFlowStatePatch,
  readGovernedMissionStateFromTaskFlow,
  updateGovernedMissionState,
  type GovernedMissionState,
  type GovernedMissionTaskFlowRecord,
  type GovernedMissionTaskFlowStatePatch,
} from "./governed-mission-state.js";

export const GOVERNED_FINALIZATION_REPAIR_STATE_KEY = "governedFinalizationRepairState";
export const GOVERNED_FINALIZATION_REPAIR_MAX_ATTEMPTS = 1;
export const GOVERNED_FINALIZATION_REPAIR_VERSION = "governed-finalization-repair-v1";

export type GovernedFinalizationRepairState = {
  schema: "openclaw.governed_finalization_repair_state.v1";
  missionId: string;
  runId: string;
  contractId: string;
  contractHash: string;
  repairPermitted: boolean;
  attemptCount: number;
  maxAttempts: typeof GOVERNED_FINALIZATION_REPAIR_MAX_ATTEMPTS;
  lastCloseoutReceiptRef?: string;
  lastCloseoutReceiptHash?: string;
  terminalFailureState?: GovernedMissionFailureState;
  updatedAt: string;
};

export type GovernedFinalizationRepairInput = {
  record: GovernedMissionTaskFlowRecord;
  runId: string;
  closeoutValidation: GovernedCloseoutValidationResult;
  repairPermitted: boolean;
  repairInstruction: string;
  now: string;
};

export type GovernedFinalizationRepairDecision =
  | {
      schema: "openclaw.governed_finalization_repair_decision.v1";
      action: "no_repair_needed";
      reason: "closeout_validation_passed";
      releaseAllowed: false;
      repairState: GovernedFinalizationRepairState;
      patch: GovernedMissionTaskFlowStatePatch;
    }
  | {
      schema: "openclaw.governed_finalization_repair_decision.v1";
      action: "revise_once";
      reason: "closeout_validation_failed_repair_permitted";
      releaseAllowed: false;
      retry: {
        instruction: string;
        idempotencyKey: string;
        maxAttempts: typeof GOVERNED_FINALIZATION_REPAIR_MAX_ATTEMPTS;
      };
      repairState: GovernedFinalizationRepairState;
      patch: GovernedMissionTaskFlowStatePatch;
    }
  | {
      schema: "openclaw.governed_finalization_repair_decision.v1";
      action: "terminal_failed_contract";
      reason: "repair_not_permitted" | "single_repair_attempt_exhausted";
      releaseAllowed: false;
      failureState: "FAILED_CONTRACT";
      repairState: GovernedFinalizationRepairState;
      patch: GovernedMissionTaskFlowStatePatch;
    };

export function decideGovernedFinalizationRepair(
  input: GovernedFinalizationRepairInput,
): GovernedFinalizationRepairDecision {
  const missionState = requireMissionState(input.record);
  requireCloseoutMatchesMission(input.closeoutValidation, missionState, input.runId);
  const existingRepairState = readGovernedFinalizationRepairStateFromTaskFlow(input.record);
  const baseRepairState = buildRepairState(input, existingRepairState);

  if (input.closeoutValidation.releaseAllowed) {
    const repairState = {
      ...baseRepairState,
      repairPermitted: input.repairPermitted,
      updatedAt: input.now,
    };
    return {
      schema: "openclaw.governed_finalization_repair_decision.v1",
      action: "no_repair_needed",
      reason: "closeout_validation_passed",
      releaseAllowed: false,
      repairState,
      patch: buildPatch(input.record, missionState, repairState),
    };
  }

  if (!input.repairPermitted) {
    return terminalFailedContract(
      input,
      missionState,
      {
        ...baseRepairState,
        repairPermitted: false,
        terminalFailureState: "FAILED_CONTRACT",
        updatedAt: input.now,
      },
      "repair_not_permitted",
    );
  }

  if (baseRepairState.attemptCount >= GOVERNED_FINALIZATION_REPAIR_MAX_ATTEMPTS) {
    return terminalFailedContract(
      input,
      missionState,
      {
        ...baseRepairState,
        terminalFailureState: "FAILED_CONTRACT",
        updatedAt: input.now,
      },
      "single_repair_attempt_exhausted",
    );
  }

  const repairState: GovernedFinalizationRepairState = {
    ...baseRepairState,
    attemptCount: baseRepairState.attemptCount + 1,
    updatedAt: input.now,
  };
  return {
    schema: "openclaw.governed_finalization_repair_decision.v1",
    action: "revise_once",
    reason: "closeout_validation_failed_repair_permitted",
    releaseAllowed: false,
    retry: {
      instruction: input.repairInstruction,
      idempotencyKey: `${missionState.missionId}:${input.runId}:finalization-repair`,
      maxAttempts: GOVERNED_FINALIZATION_REPAIR_MAX_ATTEMPTS,
    },
    repairState,
    patch: buildPatch(
      input.record,
      updateGovernedMissionState(missionState, {
        expectedRevision: missionState.revision,
        currentGovernedState: "repair_required",
        currentStep: "before_agent_finalize_repair_attempt_1",
        now: input.now,
      }),
      repairState,
    ),
  };
}

export function readGovernedFinalizationRepairStateFromTaskFlow(
  record: GovernedMissionTaskFlowRecord,
): GovernedFinalizationRepairState | undefined {
  const stateJson = jsonObject(record.stateJson);
  const value = stateJson[GOVERNED_FINALIZATION_REPAIR_STATE_KEY];
  return isGovernedFinalizationRepairState(value) ? value : undefined;
}

function buildRepairState(
  input: GovernedFinalizationRepairInput,
  existing: GovernedFinalizationRepairState | undefined,
): GovernedFinalizationRepairState {
  return {
    schema: "openclaw.governed_finalization_repair_state.v1",
    missionId: input.closeoutValidation.closeoutReceipt.missionId,
    runId: input.runId,
    contractId: input.closeoutValidation.closeoutReceipt.contractId,
    contractHash: input.closeoutValidation.closeoutReceipt.contractHash,
    repairPermitted: input.repairPermitted,
    attemptCount: existing?.attemptCount ?? 0,
    maxAttempts: GOVERNED_FINALIZATION_REPAIR_MAX_ATTEMPTS,
    lastCloseoutReceiptRef: input.closeoutValidation.closeoutReceipt.receiptId,
    lastCloseoutReceiptHash: input.closeoutValidation.releaseState.closeoutReceiptHash,
    updatedAt: input.now,
  };
}

function terminalFailedContract(
  input: GovernedFinalizationRepairInput,
  missionState: GovernedMissionState,
  repairState: GovernedFinalizationRepairState,
  reason: "repair_not_permitted" | "single_repair_attempt_exhausted",
): GovernedFinalizationRepairDecision {
  return {
    schema: "openclaw.governed_finalization_repair_decision.v1",
    action: "terminal_failed_contract",
    reason,
    releaseAllowed: false,
    failureState: "FAILED_CONTRACT",
    repairState,
    patch: buildPatch(
      input.record,
      updateGovernedMissionState(missionState, {
        expectedRevision: missionState.revision,
        currentGovernedState: "failed",
        currentStep: "before_agent_finalize_failed_contract",
        terminalStatus: "failed",
        now: input.now,
      }),
      repairState,
    ),
  };
}

function buildPatch(
  record: GovernedMissionTaskFlowRecord,
  missionState: GovernedMissionState,
  repairState: GovernedFinalizationRepairState,
): GovernedMissionTaskFlowStatePatch {
  const missionPatch = buildGovernedMissionTaskFlowStatePatch(record, missionState);
  return {
    ...missionPatch,
    stateJson: {
      ...jsonObject(missionPatch.stateJson),
      [GOVERNED_FINALIZATION_REPAIR_STATE_KEY]: repairState as unknown as JsonValue,
    },
  };
}

function requireMissionState(record: GovernedMissionTaskFlowRecord): GovernedMissionState {
  const state = readGovernedMissionStateFromTaskFlow(record);
  if (!state) {
    throw new Error(`governed mission state not found on TaskFlow record: ${record.flowId}`);
  }
  return state;
}

function requireCloseoutMatchesMission(
  closeoutValidation: GovernedCloseoutValidationResult,
  missionState: GovernedMissionState,
  runId: string,
): void {
  if (
    closeoutValidation.closeoutReceipt.missionId !== missionState.missionId ||
    closeoutValidation.closeoutReceipt.contractId !== missionState.contractId ||
    closeoutValidation.closeoutReceipt.contractHash !== missionState.contractHash ||
    closeoutValidation.releaseState.runId !== runId
  ) {
    throw new Error("finalization repair requires closeout validation for the pinned mission/run");
  }
}

function isGovernedFinalizationRepairState(
  value: unknown,
): value is GovernedFinalizationRepairState {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as GovernedFinalizationRepairState).schema ===
      "openclaw.governed_finalization_repair_state.v1"
  );
}

function jsonObject(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as { [key: string]: JsonValue };
  }
  return {};
}
