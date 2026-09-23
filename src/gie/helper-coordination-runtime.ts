import { evaluatePolicyDecision, type GiePolicyDecision } from "./policy-engine.js";
import type { GieStepState, GieStepwiseExecution } from "./stepwise-execution-runtime.js";

export const GIE_HELPER_EXECUTION_STATES = [
  "created",
  "handoff_ready",
  "dispatched",
  "running",
  "validation_required",
  "validated",
  "fix_required",
  "continued",
  "failed",
  "hard_stopped",
] as const;

export type GieHelperExecutionState = (typeof GIE_HELPER_EXECUTION_STATES)[number];
export type GieHelperTerminalOutcome = "succeeded" | "failed" | "blocked";

export type GieHelperAuditEvent = {
  from: GieHelperExecutionState | null;
  to: GieHelperExecutionState;
  action: string;
  actor: string;
  timestamp: number;
  proofRefs: string[];
  note?: string;
};

export type GieHelperWorkOrder = {
  workOrderId: string;
  issueKey: string;
  ownerLane: string;
  ownerTarget: string;
  helperLane: string;
  helperTarget: string;
  taskText: string;
  allowedScope: string[];
  proofRefs: string[];
  validationRequirements: string[];
  antiParallelLockKey: string;
  requestedBy: string;
  selfPerformanceApprovalRef: string | null;
};

export type GieHelperHandoffPacket = {
  workOrderId: string;
  issueKey: string;
  parentStepId: string;
  parentStepState: GieStepState;
  workOrder: GieHelperWorkOrder;
  authorityRef: string;
  handoffRef: string;
  handoffAccepted: true;
  proofRefs: string[];
  createdAt: number;
};

export type GieHelperExecutionRecord = {
  workOrder: GieHelperWorkOrder;
  state: GieHelperExecutionState;
  handoffPacket?: GieHelperHandoffPacket;
  policyDecision?: GiePolicyDecision;
  taskId?: string;
  flowId?: string;
  dispatchReceiptRef?: string;
  resultRef?: string;
  terminalOutcome?: GieHelperTerminalOutcome;
  validatorIdentity?: string;
  validationProofRef?: string;
  continuationRef?: string;
  nextExecutableUnitLaunched?: boolean;
  auditLog: GieHelperAuditEvent[];
};

type DispatchResult = {
  taskId: string;
  flowId: string;
  dispatchReceiptRef: string;
};

const HANDOFF_ALLOWED_PARENT_STATES = new Set<GieStepState>([
  "materialized",
  "dispatched",
  "running",
  "fixed",
]);
const ACTIVE_HELPER_STATES = new Set<GieHelperExecutionState>([
  "created",
  "handoff_ready",
  "dispatched",
  "running",
  "validation_required",
  "validated",
  "fix_required",
]);

function cleanString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function isWillLikeRequester(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "will" || normalized === "mark" || normalized === "operator";
}

function transition(
  record: GieHelperExecutionRecord,
  params: {
    to: GieHelperExecutionState;
    action: string;
    actor?: string;
    proofRefs?: string[];
    now?: number;
    note?: string;
    patch?: Partial<Omit<GieHelperExecutionRecord, "workOrder" | "auditLog" | "state">>;
  },
): GieHelperExecutionRecord {
  const proofRefs = cleanList([...(params.proofRefs ?? []), ...record.workOrder.proofRefs]);
  const event: GieHelperAuditEvent = {
    from: record.state,
    to: params.to,
    action: params.action,
    actor: cleanString(params.actor) || "gie_helper_coordination_runtime",
    timestamp: params.now ?? Date.now(),
    proofRefs,
    ...(params.note ? { note: params.note } : {}),
  };
  return {
    ...record,
    ...params.patch,
    state: params.to,
    auditLog: [...record.auditLog, event],
  };
}

export function createGieHelperWorkOrder(params: {
  workOrderId: string;
  issueKey: string;
  ownerLane: string;
  ownerTarget: string;
  helperLane: string;
  helperTarget: string;
  taskText: string;
  allowedScope: string[];
  proofRefs: string[];
  validationRequirements: string[];
  antiParallelLockKey?: string | null;
  requestedBy?: string | null;
  selfPerformanceApprovalRef?: string | null;
  now?: number;
}): GieHelperWorkOrder & { state: "created"; auditLog: GieHelperAuditEvent[] } {
  const workOrder: GieHelperWorkOrder = {
    workOrderId: cleanString(params.workOrderId),
    issueKey: cleanString(params.issueKey),
    ownerLane: cleanString(params.ownerLane),
    ownerTarget: cleanString(params.ownerTarget),
    helperLane: cleanString(params.helperLane),
    helperTarget: cleanString(params.helperTarget),
    taskText: cleanString(params.taskText),
    allowedScope: cleanList(params.allowedScope),
    proofRefs: cleanList(params.proofRefs),
    validationRequirements: cleanList(params.validationRequirements),
    antiParallelLockKey: cleanString(params.antiParallelLockKey) || cleanString(params.issueKey),
    requestedBy: cleanString(params.requestedBy) || "Codex",
    selfPerformanceApprovalRef: cleanString(params.selfPerformanceApprovalRef) || null,
  };
  if (
    !workOrder.workOrderId ||
    !workOrder.issueKey ||
    !workOrder.ownerLane ||
    !workOrder.ownerTarget ||
    !workOrder.helperLane ||
    !workOrder.helperTarget ||
    !workOrder.taskText ||
    workOrder.allowedScope.length === 0 ||
    workOrder.proofRefs.length === 0 ||
    workOrder.validationRequirements.length === 0 ||
    !workOrder.antiParallelLockKey
  ) {
    throw new Error("gie_helper_work_order_required_fields_missing");
  }
  return {
    ...workOrder,
    state: "created",
    auditLog: [
      {
        from: null,
        to: "created",
        action: "create_helper_work_order",
        actor: "gie_helper_coordination_runtime",
        timestamp: params.now ?? Date.now(),
        proofRefs: workOrder.proofRefs,
      },
    ],
  };
}

export function preventDisconnectedParallelHelperWork(
  activeRecords: GieHelperExecutionRecord[],
  nextWorkOrder: Pick<GieHelperWorkOrder, "antiParallelLockKey" | "workOrderId"> & {
    retryOfWorkOrderId?: string | null;
    reworkOfWorkOrderId?: string | null;
  },
): void {
  const retryOf = cleanString(nextWorkOrder.retryOfWorkOrderId);
  const reworkOf = cleanString(nextWorkOrder.reworkOfWorkOrderId);
  const duplicate = activeRecords.find((record) => {
    if (!ACTIVE_HELPER_STATES.has(record.state)) {
      return false;
    }
    if (record.workOrder.antiParallelLockKey !== nextWorkOrder.antiParallelLockKey) {
      return false;
    }
    return record.workOrder.workOrderId !== retryOf && record.workOrder.workOrderId !== reworkOf;
  });
  if (duplicate) {
    throw new Error(`gie_helper_parallel_work_blocked:${nextWorkOrder.antiParallelLockKey}`);
  }
}

export function buildGieHelperHandoffPacket(params: {
  parentStep: GieStepwiseExecution;
  workOrder: GieHelperWorkOrder;
  authorityRef: string;
  handoffRef: string;
  now?: number;
}): GieHelperHandoffPacket {
  if (!HANDOFF_ALLOWED_PARENT_STATES.has(params.parentStep.state)) {
    throw new Error(`gie_helper_handoff_illegal_parent_state:${params.parentStep.state}`);
  }
  const authorityRef = cleanString(params.authorityRef);
  const handoffRef = cleanString(params.handoffRef);
  if (!authorityRef || !handoffRef) {
    throw new Error("gie_helper_handoff_authority_and_ref_required");
  }
  return {
    workOrderId: params.workOrder.workOrderId,
    issueKey: params.workOrder.issueKey,
    parentStepId: params.parentStep.stepId,
    parentStepState: params.parentStep.state,
    workOrder: params.workOrder,
    authorityRef,
    handoffRef,
    handoffAccepted: true,
    proofRefs: cleanList([
      ...params.parentStep.proofRefs,
      ...params.workOrder.proofRefs,
      authorityRef,
      handoffRef,
    ]),
    createdAt: params.now ?? Date.now(),
  };
}

export function dispatchGieHelperWork(
  packet: GieHelperHandoffPacket,
  params: {
    dispatchTask: (workOrder: GieHelperWorkOrder, packet: GieHelperHandoffPacket) => DispatchResult;
    now?: number;
  },
): GieHelperExecutionRecord {
  if (
    isWillLikeRequester(packet.workOrder.requestedBy) &&
    packet.workOrder.helperLane !== packet.workOrder.ownerLane &&
    !packet.workOrder.selfPerformanceApprovalRef
  ) {
    throw new Error("gie_helper_self_performance_requires_approval");
  }
  const policyDecision = evaluatePolicyDecision({
    action: "governed_dispatch",
    ownerLane: packet.workOrder.helperLane,
    ownerTarget: packet.workOrder.helperTarget,
    proofRefs: packet.proofRefs,
  });
  if (!policyDecision.allowed) {
    throw new Error(`gie_helper_policy_blocked:${policyDecision.triggeredRule}`);
  }
  const base: GieHelperExecutionRecord = {
    workOrder: packet.workOrder,
    state: "handoff_ready",
    handoffPacket: packet,
    policyDecision,
    auditLog: [
      {
        from: null,
        to: "handoff_ready",
        action: "accept_handoff",
        actor: "gie_helper_coordination_runtime",
        timestamp: packet.createdAt,
        proofRefs: packet.proofRefs,
      },
    ],
  };
  const dispatchResult = params.dispatchTask(packet.workOrder, packet);
  if (
    !cleanString(dispatchResult.taskId) ||
    !cleanString(dispatchResult.flowId) ||
    !cleanString(dispatchResult.dispatchReceiptRef)
  ) {
    throw new Error("gie_helper_dispatch_result_incomplete");
  }
  const dispatched = transition(base, {
    to: "dispatched",
    action: "dispatch_helper_task",
    proofRefs: [dispatchResult.dispatchReceiptRef],
    now: params.now,
    patch: {
      taskId: dispatchResult.taskId,
      flowId: dispatchResult.flowId,
      dispatchReceiptRef: dispatchResult.dispatchReceiptRef,
    },
  });
  return transition(dispatched, {
    to: "running",
    action: "helper_task_running",
    proofRefs: [dispatchResult.dispatchReceiptRef],
    now: params.now,
  });
}

export function captureGieHelperResult(
  record: GieHelperExecutionRecord,
  params: {
    terminalOutcome: GieHelperTerminalOutcome;
    resultRef: string;
    proofRefs: string[];
    now?: number;
  },
): GieHelperExecutionRecord {
  if (record.state !== "running") {
    throw new Error(`gie_helper_result_capture_illegal_state:${record.state}`);
  }
  const resultRef = cleanString(params.resultRef);
  const proofRefs = cleanList(params.proofRefs);
  if (!resultRef || proofRefs.length === 0) {
    throw new Error("gie_helper_result_ref_and_proof_required");
  }
  if (params.terminalOutcome !== "succeeded") {
    return transition(record, {
      to: "fix_required",
      action: "capture_helper_non_success_result",
      proofRefs: [resultRef, ...proofRefs],
      now: params.now,
      patch: { resultRef, terminalOutcome: params.terminalOutcome },
    });
  }
  return transition(record, {
    to: "validation_required",
    action: "capture_helper_result",
    proofRefs: [resultRef, ...proofRefs],
    now: params.now,
    patch: { resultRef, terminalOutcome: params.terminalOutcome },
  });
}

export function validateGieHelperResult(
  record: GieHelperExecutionRecord,
  params: {
    validatorIdentity: string;
    validationProofRef: string;
    passed: boolean;
    now?: number;
  },
): GieHelperExecutionRecord {
  if (record.state !== "validation_required") {
    throw new Error(`gie_helper_validation_illegal_state:${record.state}`);
  }
  const validatorIdentity = cleanString(params.validatorIdentity);
  const validationProofRef = cleanString(params.validationProofRef);
  if (!validatorIdentity || !validationProofRef) {
    throw new Error("gie_helper_validator_and_proof_required");
  }
  return transition(record, {
    to: params.passed ? "validated" : "fix_required",
    action: params.passed ? "validate_helper_result_pass" : "validate_helper_result_fail",
    actor: validatorIdentity,
    proofRefs: [validationProofRef],
    now: params.now,
    patch: { validatorIdentity, validationProofRef },
  });
}

export function closeGieHelperContinuation(
  record: GieHelperExecutionRecord,
  params: {
    continuationRef: string;
    nextExecutableUnitLaunched: boolean;
    now?: number;
  },
): GieHelperExecutionRecord {
  if (record.state !== "validated") {
    throw new Error("gie_helper_validation_required_before_continuation");
  }
  const continuationRef = cleanString(params.continuationRef);
  if (!continuationRef || params.nextExecutableUnitLaunched !== true) {
    throw new Error("gie_helper_continuation_launch_proof_required");
  }
  return transition(record, {
    to: "continued",
    action: "continue_after_helper_closeout",
    proofRefs: [continuationRef],
    now: params.now,
    patch: {
      continuationRef,
      nextExecutableUnitLaunched: true,
    },
  });
}
