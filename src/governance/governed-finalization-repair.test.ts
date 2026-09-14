import { describe, expect, it } from "vitest";
import type { JsonValue, TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { validateGovernedCloseoutAndBuildReleaseState } from "./governed-closeout-validator.js";
import {
  decideGovernedFinalizationRepair,
  GOVERNED_FINALIZATION_REPAIR_STATE_KEY,
  readGovernedFinalizationRepairStateFromTaskFlow,
} from "./governed-finalization-repair.js";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import {
  createGovernedMissionState,
  GOVERNED_MISSION_TASKFLOW_STATE_KEY,
} from "./governed-mission-state.js";

const now = "2026-08-23T14:10:00Z";

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "mission-finalize",
  contractId: "contract-finalize",
  contractVersion: "2026-08-23T1410Z",
  contractHash: "contract-hash",
  authorityHash: "authority-hash",
  authorityRefs: [
    {
      refId: "plan",
      kind: "build_plan",
      uri: "/exports/sop_enforcement_master_build_plan_2026-08-21T1905Z.md",
      sha256: "authority-hash",
    },
  ],
  admissionReceiptRef: "admission-1",
  planRevisionId: "sop-enf-16",
  sourceRevision: "31d50dc436ddada2c38cb02e33a9e68a20216959",
  runtimeBuildSha256: "openclaw-2026.6.2-a87590b",
  policyVersion: "sop-enforcement-v1",
  mode: "shadow",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: now,
};

function taskFlowRecord(
  stateJson?: JsonValue,
): Pick<TaskFlowRecord, "flowId" | "revision" | "stateJson"> {
  const missionState = createGovernedMissionState({
    contract,
    authorityRef: contract.authorityRefs[0],
    currentStep: "before_agent_finalize",
    ownerCorrelation: {
      owner: "Will",
      taskFlowId: "flow-1",
      runId: "run-1",
    },
    now,
  });
  return {
    flowId: "flow-1",
    revision: 7,
    stateJson: {
      [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: missionState,
      ...(stateJson && typeof stateJson === "object" && !Array.isArray(stateJson) ? stateJson : {}),
    } as JsonValue,
  };
}

function closeoutValidation(
  overrides: { closeoutPassed?: boolean; noBlockingState?: boolean } = {},
) {
  return validateGovernedCloseoutAndBuildReleaseState({
    contract,
    runId: "run-1",
    observedContractHash: contract.contractHash,
    observedAuthorityHash: contract.authorityHash,
    requestedCompletionOwner: "governed_mission_state",
    requiredEvidenceReceiptRefs: ["admission:1", "policy:1", "closeout-proof:1"],
    presentEvidenceReceiptRefs: ["admission:1", "policy:1", "closeout-proof:1"],
    closeoutPassed: overrides.closeoutPassed ?? false,
    noBlockingState: overrides.noBlockingState ?? true,
    payloadHash: "payload-hash-1",
    producedAt: now,
    decisionSequence: 1,
    producer: "closeout-validator",
  });
}

describe("governed finalization repair", () => {
  it("allows exactly one durable repair attempt when closeout validation fails and repair is permitted", () => {
    const decision = decideGovernedFinalizationRepair({
      record: taskFlowRecord(),
      runId: "run-1",
      closeoutValidation: closeoutValidation(),
      repairPermitted: true,
      repairInstruction: "repair the closeout evidence and revalidate once",
      now,
    });

    expect(decision).toMatchObject({
      action: "revise_once",
      reason: "closeout_validation_failed_repair_permitted",
      releaseAllowed: false,
      retry: {
        instruction: "repair the closeout evidence and revalidate once",
        idempotencyKey: "mission-finalize:run-1:finalization-repair",
        maxAttempts: 1,
      },
      repairState: {
        attemptCount: 1,
        maxAttempts: 1,
        repairPermitted: true,
      },
    });
    expect(decision.patch).toMatchObject({
      flowId: "flow-1",
      expectedFlowRevision: 7,
      stateJson: {
        [GOVERNED_FINALIZATION_REPAIR_STATE_KEY]: {
          attemptCount: 1,
          lastCloseoutReceiptRef: expect.stringMatching(/^closeout:/u),
        },
        [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: {
          currentGovernedState: "GOVERNED_MISSION_WAITING",
          currentStep: "before_agent_finalize_repair_attempt_1",
          revision: 2,
        },
      },
    });
  });

  it("transitions failed revalidation after the single repair to FAILED_CONTRACT without a second loop", () => {
    const first = decideGovernedFinalizationRepair({
      record: taskFlowRecord(),
      runId: "run-1",
      closeoutValidation: closeoutValidation(),
      repairPermitted: true,
      repairInstruction: "repair once",
      now,
    });
    const secondRecord = {
      flowId: first.patch.flowId,
      revision: 8,
      stateJson: first.patch.stateJson,
    };

    const second = decideGovernedFinalizationRepair({
      record: secondRecord,
      runId: "run-1",
      closeoutValidation: closeoutValidation(),
      repairPermitted: true,
      repairInstruction: "repair again",
      now: "2026-08-23T14:11:00Z",
    });

    expect(second).toMatchObject({
      action: "terminal_failed_contract",
      reason: "single_repair_attempt_exhausted",
      releaseAllowed: false,
      failureState: "FAILED_CONTRACT",
      repairState: {
        attemptCount: 1,
        terminalFailureState: "FAILED_CONTRACT",
      },
      patch: {
        expectedFlowRevision: 8,
        stateJson: {
          [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: {
            currentGovernedState: "GOVERNED_MISSION_TERMINAL",
            currentStep: "before_agent_finalize_failed_contract",
            terminalStatus: "failed",
          },
        },
      },
    });
    expect(second).not.toHaveProperty("retry");
  });

  it("terminally fails when the contract does not permit repair", () => {
    const decision = decideGovernedFinalizationRepair({
      record: taskFlowRecord(),
      runId: "run-1",
      closeoutValidation: closeoutValidation(),
      repairPermitted: false,
      repairInstruction: "not allowed",
      now,
    });

    expect(decision).toMatchObject({
      action: "terminal_failed_contract",
      reason: "repair_not_permitted",
      releaseAllowed: false,
      failureState: "FAILED_CONTRACT",
      repairState: {
        repairPermitted: false,
        attemptCount: 0,
        terminalFailureState: "FAILED_CONTRACT",
      },
    });
  });

  it("does not let repair release final output directly even when closeout validation passes", () => {
    const decision = decideGovernedFinalizationRepair({
      record: taskFlowRecord(),
      runId: "run-1",
      closeoutValidation: closeoutValidation({ closeoutPassed: true }),
      repairPermitted: true,
      repairInstruction: "unused",
      now,
    });

    expect(decision).toMatchObject({
      action: "no_repair_needed",
      reason: "closeout_validation_passed",
      releaseAllowed: false,
      repairState: {
        attemptCount: 0,
      },
    });
    expect(decision.patch.stateJson).toMatchObject({
      [GOVERNED_FINALIZATION_REPAIR_STATE_KEY]: {
        attemptCount: 0,
      },
    });
  });

  it("requires closeout validation to match the pinned mission and run", () => {
    expect(() =>
      decideGovernedFinalizationRepair({
        record: taskFlowRecord(),
        runId: "other-run",
        closeoutValidation: closeoutValidation(),
        repairPermitted: true,
        repairInstruction: "repair once",
        now,
      }),
    ).toThrow("finalization repair requires closeout validation for the pinned mission/run");
  });

  it("reads durable finalization repair state from TaskFlow state JSON", () => {
    const record = taskFlowRecord({
      [GOVERNED_FINALIZATION_REPAIR_STATE_KEY]: {
        schema: "openclaw.governed_finalization_repair_state.v1",
        missionId: "mission-finalize",
        runId: "run-1",
        contractId: "contract-finalize",
        contractHash: "contract-hash",
        repairPermitted: true,
        attemptCount: 1,
        maxAttempts: 1,
        updatedAt: now,
      },
    } as JsonValue);

    expect(readGovernedFinalizationRepairStateFromTaskFlow(record)).toMatchObject({
      attemptCount: 1,
      maxAttempts: 1,
    });
  });
});
