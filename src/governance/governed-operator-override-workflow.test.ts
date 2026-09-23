import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import {
  GOVERNED_MISSION_TASKFLOW_STATE_KEY,
  createGovernedMissionState,
  updateGovernedMissionState,
  type GovernedMissionTaskFlowRecord,
} from "./governed-mission-state.js";
import { decideGovernedOperatorOverrideWorkflow } from "./governed-operator-override-workflow.js";

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "mission-override-1",
  contractId: "contract-override-1",
  contractVersion: "2026-08-24T01:31:00Z",
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
  planRevisionId: "plan-revision",
  sourceRevision: "31d50dc436ddada2c38cb02e33a9e68a20216959",
  runtimeBuildSha256: "openclaw-2026.6.2-a87590b",
  policyVersion: "sop-enforcement-v1",
  skillSha256: "skill-sha",
  mode: "shadow",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: "2026-08-24T01:31:00Z",
};

const admittedMissionState = createGovernedMissionState({
  contract,
  authorityRef: contract.authorityRefs[0],
  currentStep: "operator_override_workflow",
  ownerCorrelation: { owner: "Cleanup Crew", taskFlowId: "flow-override-1" },
  now: "2026-08-24T01:31:00Z",
});
const missionState = updateGovernedMissionState(admittedMissionState, {
  expectedRevision: admittedMissionState.revision,
  currentGovernedState: "executing",
  currentStep: "execute_governed_work",
  now: "2026-08-24T01:31:30Z",
});

const record: GovernedMissionTaskFlowRecord = {
  flowId: "flow-override-1",
  revision: 7,
  stateJson: {
    [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: missionState,
  },
};

const baseInput = {
  record,
  contract,
  overrideId: "override-19-1",
  operatorAuthority: {
    refId: "mark-approval",
    kind: "operator_approval" as const,
    uri: "operator://mark/sop-enf-19",
    sha256: "operator-approval-sha",
  },
  decisionStatus: "approved" as const,
  approverRef: "operator://mark/sop-enf-19",
  actionId: "tool-call-1",
  requestedClass: "tool_action_exception" as const,
  reason: "Bounded operator-approved tool exception.",
  expiresAt: "2026-08-24T02:00:00Z",
  reuse: { mode: "one_use" as const, useCount: 0 },
  hostAuthority: {
    openclawAllows: true,
    osAllows: true,
    hostAllows: true,
  },
  now: "2026-08-24T01:32:00Z",
  producer: "sop-enf-19-test",
};

function resolutionInput(decisionStatus: "approved" | "denied") {
  const pending = decideGovernedOperatorOverrideWorkflow({
    ...baseInput,
    decisionStatus: "pending",
    approverRef: undefined,
  });
  if (pending.decision !== "pending") {
    throw new Error(`expected pending override, got ${pending.decision}`);
  }
  return {
    ...baseInput,
    decisionStatus,
    record: {
      flowId: record.flowId,
      revision: record.revision + 1,
      stateJson: pending.patch.stateJson,
    },
  };
}

describe("governed operator override workflow", () => {
  it("moves a mission into pending override without creating an override bypass", () => {
    const decision = decideGovernedOperatorOverrideWorkflow({
      ...baseInput,
      decisionStatus: "pending",
      approverRef: undefined,
    });

    expect(decision).toMatchObject({
      decision: "pending",
      reason: "operator_approval_pending",
      patch: {
        flowId: "flow-override-1",
        expectedFlowRevision: 7,
      },
    });
    expect(decision.patch.stateJson).toMatchObject({
      [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: {
        currentGovernedState: "pending_override",
        currentStep: "operator_override_pending",
        overrideRef: { overrideId: "override-19-1", status: "pending" },
      },
    });
  });

  it("creates a bounded approved override receipt, record, and state patch", () => {
    const decision = decideGovernedOperatorOverrideWorkflow(resolutionInput("approved"));

    expect(decision).toMatchObject({
      decision: "approved",
      reason: "valid_operator_override",
      receipt: {
        schema: "openclaw.governed_override_receipt.v1",
        receiptKind: "override",
        overrideId: "override-19-1",
        approved: true,
        approverRef: "operator://mark/sop-enf-19",
        scopeHash: "authority-hash",
      },
      override: {
        schema: "openclaw.governed_operator_override.v1",
        overrideId: "override-19-1",
        receiptRef: expect.stringMatching(/^override:/),
        allowableClasses: ["tool_action_exception"],
        cannotExpandBeyondHostAuthority: true,
        target: {
          missionId: "mission-override-1",
          actionId: "tool-call-1",
          scopeHash: "authority-hash",
        },
      },
    });
    assert(decision.decision === "approved");
    expect(decision.override.prohibitedClasses).toEqual(
      expect.arrayContaining([
        "expand_os_authority",
        "expand_openclaw_host_authority",
        "bypass_sandbox_boundary",
        "bypass_source_or_runtime_lock",
        "bypass_required_closeout",
        "bypass_release_gate",
      ]),
    );
    expect(decision.patch.stateJson).toMatchObject({
      [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: {
        currentGovernedState: "executing",
        currentStep: "execute_governed_work",
        overrideRef: { overrideId: "override-19-1", status: "approved" },
      },
      governedOperatorOverrideWorkflow: {
        decision: "approved",
        receiptRef: decision.receipt.receiptId,
      },
    });
  });

  it("denies approved-looking overrides that would expand host authority", () => {
    const decision = decideGovernedOperatorOverrideWorkflow({
      ...resolutionInput("approved"),
      hostAuthority: {
        openclawAllows: true,
        osAllows: false,
        hostAllows: true,
      },
    });

    expect(decision).toMatchObject({
      decision: "denied",
      reason: "invalid_operator_override",
      evaluatorReason: "host_authority_denied",
      receipt: {
        approved: true,
        overrideId: "override-19-1",
      },
    });
    expect(decision.patch.stateJson).toMatchObject({
      [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: {
        currentGovernedState: "executing",
        currentStep: "execute_governed_work",
        overrideRef: { overrideId: "override-19-1", status: "denied" },
      },
    });
  });

  it("denies explicit operator denial with an auditable receipt and no override record", () => {
    const decision = decideGovernedOperatorOverrideWorkflow({
      ...resolutionInput("denied"),
    });

    expect(decision).toMatchObject({
      decision: "denied",
      reason: "operator_approval_denied",
      receipt: {
        approved: false,
        overrideId: "override-19-1",
      },
    });
    expect("override" in decision).toBe(false);
  });

  it("denies stale authority instead of re-admitting silently", () => {
    const decision = decideGovernedOperatorOverrideWorkflow({
      ...baseInput,
      contract: {
        ...contract,
        authorityHash: "new-authority-hash",
      },
    });

    expect(decision).toMatchObject({
      decision: "denied",
      reason: "contract_state_mismatch",
      receipt: {
        approved: false,
        scopeHash: "authority-hash",
      },
    });
  });

  it("rejects override entry from admitted and closeout states without reopening them", () => {
    for (const state of [
      admittedMissionState,
      {
        ...missionState,
        currentGovernedState: "closeout_ready" as const,
        currentStep: "verify_closeout",
      },
    ]) {
      const decision = decideGovernedOperatorOverrideWorkflow({
        ...baseInput,
        record: {
          ...record,
          stateJson: { [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: state },
        },
        decisionStatus: "pending",
      });
      expect(decision).toMatchObject({
        decision: "denied",
        reason: "override_state_not_eligible",
        patch: {
          stateJson: {
            [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: {
              currentGovernedState: state.currentGovernedState,
              currentStep: state.currentStep,
            },
          },
        },
      });
    }
  });

  it("restores the exact waiting state after approval", () => {
    const waitingState = updateGovernedMissionState(admittedMissionState, {
      expectedRevision: admittedMissionState.revision,
      currentGovernedState: "waiting",
      currentStep: "wait_for_external_evidence",
      now: "2026-08-24T01:31:30Z",
    });
    const waitingRecord = {
      ...record,
      stateJson: { [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: waitingState },
    };
    const pending = decideGovernedOperatorOverrideWorkflow({
      ...baseInput,
      record: waitingRecord,
      decisionStatus: "pending",
    });
    if (pending.decision !== "pending") {
      throw new Error(`expected pending override, got ${pending.decision}`);
    }
    const approved = decideGovernedOperatorOverrideWorkflow({
      ...baseInput,
      record: {
        ...waitingRecord,
        revision: waitingRecord.revision + 1,
        stateJson: pending.patch.stateJson,
      },
      decisionStatus: "approved",
    });
    expect(approved.patch.stateJson).toMatchObject({
      [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: {
        currentGovernedState: "waiting",
        currentStep: "wait_for_external_evidence",
        overrideRef: { status: "approved" },
      },
    });
  });
});
