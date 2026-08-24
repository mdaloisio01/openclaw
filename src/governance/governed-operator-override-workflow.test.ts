import { describe, expect, it } from "vitest";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import {
  GOVERNED_MISSION_TASKFLOW_STATE_KEY,
  createGovernedMissionState,
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
  mode: "shadow",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: "2026-08-24T01:31:00Z",
};

const missionState = createGovernedMissionState({
  contract,
  authorityRef: contract.authorityRefs[0],
  currentStep: "operator_override_workflow",
  ownerCorrelation: { owner: "Cleanup Crew", taskFlowId: "flow-override-1" },
  now: "2026-08-24T01:31:00Z",
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
    expect(decision.patch.stateJson[GOVERNED_MISSION_TASKFLOW_STATE_KEY]).toMatchObject({
      currentGovernedState: "GOVERNED_MISSION_PENDING_OVERRIDE",
      currentStep: "operator_override_pending",
      overrideRef: { overrideId: "override-19-1", status: "pending" },
    });
  });

  it("creates a bounded approved override receipt, record, and state patch", () => {
    const decision = decideGovernedOperatorOverrideWorkflow(baseInput);

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
    expect(decision.patch.stateJson[GOVERNED_MISSION_TASKFLOW_STATE_KEY]).toMatchObject({
      currentGovernedState: "GOVERNED_MISSION_ACTIVE",
      currentStep: "operator_override_approved",
      overrideRef: { overrideId: "override-19-1", status: "approved" },
    });
    expect(decision.patch.stateJson.governedOperatorOverrideWorkflow).toMatchObject({
      decision: "approved",
      receiptRef: decision.receipt.receiptId,
    });
  });

  it("denies approved-looking overrides that would expand host authority", () => {
    const decision = decideGovernedOperatorOverrideWorkflow({
      ...baseInput,
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
    expect(decision.patch.stateJson[GOVERNED_MISSION_TASKFLOW_STATE_KEY]).toMatchObject({
      currentGovernedState: "GOVERNED_MISSION_ACTIVE",
      currentStep: "operator_override_denied",
      overrideRef: { overrideId: "override-19-1", status: "denied" },
    });
  });

  it("denies explicit operator denial with an auditable receipt and no override record", () => {
    const decision = decideGovernedOperatorOverrideWorkflow({
      ...baseInput,
      decisionStatus: "denied",
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
});
