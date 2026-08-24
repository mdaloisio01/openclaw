import type { JsonValue } from "../tasks/task-flow-registry.types.js";
import type {
  GovernedAuthorityRef,
  GovernedMissionContract,
  OverrideReceipt,
} from "./governed-mission-contract.js";
import {
  buildGovernedMissionTaskFlowStatePatch,
  readGovernedMissionStateFromTaskFlow,
  updateGovernedMissionState,
  type GovernedMissionState,
  type GovernedMissionTaskFlowRecord,
  type GovernedMissionTaskFlowStatePatch,
} from "./governed-mission-state.js";
import {
  evaluateGovernedOperatorOverride,
  type GovernedOperatorOverrideAllowedClass,
  type GovernedOperatorOverrideRecord,
  type GovernedOperatorOverrideReuse,
} from "./governed-operator-override.js";
import { sha256Text } from "./mission-evidence-store.js";

export const GOVERNED_OPERATOR_OVERRIDE_WORKFLOW_VERSION = "governed-operator-override-workflow-v1";

export type GovernedOperatorOverrideWorkflowDecisionStatus = "pending" | "approved" | "denied";

export type GovernedOperatorOverrideWorkflowInput = {
  record: GovernedMissionTaskFlowRecord;
  contract: GovernedMissionContract;
  overrideId: string;
  operatorAuthority: GovernedAuthorityRef;
  decisionStatus: GovernedOperatorOverrideWorkflowDecisionStatus;
  approverRef?: string;
  actionId?: string;
  requestedClass: GovernedOperatorOverrideAllowedClass;
  reason: string;
  expiresAt: string;
  reuse: GovernedOperatorOverrideReuse;
  hostAuthority: {
    openclawAllows: boolean;
    osAllows: boolean;
    hostAllows: boolean;
  };
  now: string;
  producer: string;
};

export type GovernedOperatorOverrideWorkflowDecision =
  | {
      schema: "openclaw.governed_operator_override_workflow_decision.v1";
      workflowVersion: typeof GOVERNED_OPERATOR_OVERRIDE_WORKFLOW_VERSION;
      decision: "pending";
      reason: "operator_approval_pending";
      patch: GovernedMissionTaskFlowStatePatch;
    }
  | {
      schema: "openclaw.governed_operator_override_workflow_decision.v1";
      workflowVersion: typeof GOVERNED_OPERATOR_OVERRIDE_WORKFLOW_VERSION;
      decision: "approved";
      reason: "valid_operator_override";
      override: GovernedOperatorOverrideRecord;
      receipt: OverrideReceipt;
      patch: GovernedMissionTaskFlowStatePatch;
    }
  | {
      schema: "openclaw.governed_operator_override_workflow_decision.v1";
      workflowVersion: typeof GOVERNED_OPERATOR_OVERRIDE_WORKFLOW_VERSION;
      decision: "denied";
      reason:
        | "operator_approval_denied"
        | "missing_approver_ref"
        | "contract_state_mismatch"
        | "invalid_operator_override";
      override?: GovernedOperatorOverrideRecord;
      receipt: OverrideReceipt;
      evaluatorReason?: string;
      patch: GovernedMissionTaskFlowStatePatch;
    };

export function decideGovernedOperatorOverrideWorkflow(
  input: GovernedOperatorOverrideWorkflowInput,
): GovernedOperatorOverrideWorkflowDecision {
  const missionState = requireMissionState(input.record);
  if (!missionMatchesContract(missionState, input.contract)) {
    const receipt = buildOverrideReceipt(input, false, missionState);
    return denied(input, missionState, receipt, "contract_state_mismatch");
  }

  if (input.decisionStatus === "pending") {
    const pendingState = updateGovernedMissionState(missionState, {
      expectedRevision: missionState.revision,
      currentGovernedState: "GOVERNED_MISSION_PENDING_OVERRIDE",
      currentStep: "operator_override_pending",
      overrideRef: {
        overrideId: input.overrideId,
        status: "pending",
      },
      now: input.now,
    });
    return {
      schema: "openclaw.governed_operator_override_workflow_decision.v1",
      workflowVersion: GOVERNED_OPERATOR_OVERRIDE_WORKFLOW_VERSION,
      decision: "pending",
      reason: "operator_approval_pending",
      patch: buildPatch(input.record, pendingState),
    };
  }

  const approved = input.decisionStatus === "approved";
  const receipt = buildOverrideReceipt(input, approved, missionState);
  if (!approved) {
    return denied(input, missionState, receipt, "operator_approval_denied");
  }
  if (!input.approverRef) {
    return denied(input, missionState, receipt, "missing_approver_ref");
  }

  const override = buildOverrideRecord(input, receipt, missionState);
  const evaluatorDecision = evaluateGovernedOperatorOverride(override, {
    missionId: missionState.missionId,
    actionId: input.actionId,
    scopeHash: missionState.authorityHash,
    requestedClass: input.requestedClass,
    hostAuthority: input.hostAuthority,
    now: input.now,
  });
  if (!evaluatorDecision.valid) {
    return denied(input, missionState, receipt, "invalid_operator_override", {
      override,
      evaluatorReason: evaluatorDecision.reason,
    });
  }

  const approvedState = updateGovernedMissionState(missionState, {
    expectedRevision: missionState.revision,
    currentGovernedState: "GOVERNED_MISSION_ACTIVE",
    currentStep: "operator_override_approved",
    overrideRef: {
      overrideId: input.overrideId,
      status: "approved",
    },
    now: input.now,
  });
  return {
    schema: "openclaw.governed_operator_override_workflow_decision.v1",
    workflowVersion: GOVERNED_OPERATOR_OVERRIDE_WORKFLOW_VERSION,
    decision: "approved",
    reason: "valid_operator_override",
    override,
    receipt,
    patch: buildPatch(input.record, approvedState, {
      governedOperatorOverrideWorkflow: {
        schema: "openclaw.governed_operator_override_workflow_state.v1",
        overrideId: input.overrideId,
        decision: "approved",
        receiptRef: receipt.receiptId,
        updatedAt: input.now,
      },
    }),
  };
}

function denied(
  input: GovernedOperatorOverrideWorkflowInput,
  missionState: GovernedMissionState,
  receipt: OverrideReceipt,
  reason: Extract<GovernedOperatorOverrideWorkflowDecision, { decision: "denied" }>["reason"],
  options: {
    override?: GovernedOperatorOverrideRecord;
    evaluatorReason?: string;
  } = {},
): GovernedOperatorOverrideWorkflowDecision {
  const deniedState = updateGovernedMissionState(missionState, {
    expectedRevision: missionState.revision,
    currentGovernedState: "GOVERNED_MISSION_ACTIVE",
    currentStep: "operator_override_denied",
    overrideRef: {
      overrideId: input.overrideId,
      status: "denied",
    },
    now: input.now,
  });
  return {
    schema: "openclaw.governed_operator_override_workflow_decision.v1",
    workflowVersion: GOVERNED_OPERATOR_OVERRIDE_WORKFLOW_VERSION,
    decision: "denied",
    reason,
    ...(options.override ? { override: options.override } : {}),
    receipt,
    ...(options.evaluatorReason ? { evaluatorReason: options.evaluatorReason } : {}),
    patch: buildPatch(input.record, deniedState, {
      governedOperatorOverrideWorkflow: {
        schema: "openclaw.governed_operator_override_workflow_state.v1",
        overrideId: input.overrideId,
        decision: "denied",
        receiptRef: receipt.receiptId,
        ...(options.evaluatorReason ? { evaluatorReason: options.evaluatorReason } : {}),
        updatedAt: input.now,
      },
    }),
  };
}

function buildOverrideRecord(
  input: GovernedOperatorOverrideWorkflowInput,
  receipt: OverrideReceipt,
  missionState: GovernedMissionState,
): GovernedOperatorOverrideRecord {
  return {
    schema: "openclaw.governed_operator_override.v1",
    overrideId: input.overrideId,
    operatorAuthority: input.operatorAuthority,
    target: {
      missionId: missionState.missionId,
      ...(input.actionId ? { actionId: input.actionId } : {}),
      scopeHash: missionState.authorityHash,
    },
    reason: input.reason,
    expiresAt: input.expiresAt,
    reuse: input.reuse,
    receiptRef: receipt.receiptId,
    receipt,
    allowableClasses: [input.requestedClass],
    prohibitedClasses: [
      "expand_os_authority",
      "expand_openclaw_host_authority",
      "bypass_sandbox_boundary",
      "bypass_source_or_runtime_lock",
      "bypass_required_closeout",
      "bypass_release_gate",
    ],
    revocationStatus: "active",
    cannotExpandBeyondHostAuthority: true,
    createdAt: input.now,
  };
}

function buildOverrideReceipt(
  input: GovernedOperatorOverrideWorkflowInput,
  approved: boolean,
  missionState: GovernedMissionState,
): OverrideReceipt {
  return {
    schema: "openclaw.governed_override_receipt.v1",
    receiptKind: "override",
    missionId: missionState.missionId,
    contractId: missionState.contractId,
    contractVersion: missionState.contractVersion,
    contractHash: missionState.contractHash,
    authorityHash: missionState.authorityHash,
    receiptId: `override:${sha256Text(
      [
        missionState.missionId,
        missionState.contractId,
        input.overrideId,
        input.actionId ?? "",
        input.requestedClass,
        approved ? "approved" : "denied",
        input.expiresAt,
        input.now,
      ].join("\n"),
    ).slice(0, 32)}`,
    producedAt: input.now,
    producer: input.producer,
    overrideId: input.overrideId,
    approved,
    approverRef: input.approverRef ?? "missing_operator_approval",
    scopeHash: missionState.authorityHash,
    expiresAt: input.expiresAt,
  };
}

function buildPatch(
  record: GovernedMissionTaskFlowRecord,
  state: GovernedMissionState,
  extraState: { [key: string]: JsonValue } = {},
): GovernedMissionTaskFlowStatePatch {
  const missionPatch = buildGovernedMissionTaskFlowStatePatch(record, state);
  return {
    ...missionPatch,
    stateJson: {
      ...(missionPatch.stateJson as { [key: string]: JsonValue }),
      ...extraState,
    },
  };
}

function requireMissionState(record: GovernedMissionTaskFlowRecord): GovernedMissionState {
  const missionState = readGovernedMissionStateFromTaskFlow(record);
  if (!missionState) {
    throw new Error(`governed mission state not found on TaskFlow record: ${record.flowId}`);
  }
  return missionState;
}

function missionMatchesContract(
  state: GovernedMissionState,
  contract: GovernedMissionContract,
): boolean {
  return (
    state.missionId === contract.missionId &&
    state.contractId === contract.contractId &&
    state.contractVersion === contract.contractVersion &&
    state.contractHash === contract.contractHash &&
    state.authorityHash === contract.authorityHash
  );
}
