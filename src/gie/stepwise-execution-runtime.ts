export const GIE_STEP_STATES = [
  "unresolved",
  "selected",
  "materialized",
  "dispatched",
  "running",
  "verification_pending",
  "verified",
  "fix_required",
  "fixed",
  "completed",
  "failed",
  "reconciled",
  "hard_stopped",
] as const;

export type GieStepState = (typeof GIE_STEP_STATES)[number];

export const GIE_PRODUCTION_ITEM_KINDS = [
  "taskflow",
  "task",
  "work_order",
  "lane_outcome",
  "receipt",
] as const;
export type GieProductionItemKind = (typeof GIE_PRODUCTION_ITEM_KINDS)[number];

export type GieStepAuditEvent = {
  from: GieStepState | null;
  to: GieStepState;
  action: string;
  actor: string;
  timestamp: number;
  proofRefs: string[];
  note?: string;
};

export type GieStepwiseExecution = {
  workItemId: string;
  stepId: string;
  state: GieStepState;
  ownerLane: string;
  ownerTarget: string;
  proofRefs: string[];
  currentStepOnly: true;
  materializedRef?: string;
  dispatchRef?: string;
  runReceiptRef?: string;
  verifierReceiptRef?: string;
  fixRef?: string;
  failureRef?: string;
  reconciliationRef?: string;
  hardStopRef?: string;
  hardStopReason?: string;
  auditLog: GieStepAuditEvent[];
};

type TransitionInput = {
  action: string;
  actor?: string;
  to: GieStepState;
  now?: number;
  proofRefs?: string[];
  note?: string;
  patch?: Partial<Omit<GieStepwiseExecution, "auditLog" | "state">>;
};

const TERMINAL_STATES = new Set<GieStepState>([
  "completed",
  "failed",
  "reconciled",
  "hard_stopped",
]);

const ALLOWED_TRANSITIONS: Record<GieStepState, GieStepState[]> = {
  unresolved: ["selected", "failed", "hard_stopped"],
  selected: ["materialized", "failed", "hard_stopped"],
  materialized: ["dispatched", "failed", "hard_stopped"],
  dispatched: ["running", "failed", "hard_stopped"],
  running: ["verification_pending", "failed", "hard_stopped"],
  verification_pending: ["verified", "fix_required", "failed", "hard_stopped"],
  verified: ["completed", "reconciled", "hard_stopped"],
  fix_required: ["fixed", "failed", "hard_stopped"],
  fixed: ["verification_pending", "failed", "hard_stopped"],
  completed: ["reconciled"],
  failed: ["reconciled", "hard_stopped"],
  reconciled: [],
  hard_stopped: [],
};

function cleanString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanProofRefs(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function assertOwnerAndProof(
  execution: Pick<GieStepwiseExecution, "ownerLane" | "ownerTarget" | "proofRefs">,
): void {
  if (
    !cleanString(execution.ownerLane) ||
    !cleanString(execution.ownerTarget) ||
    cleanProofRefs(execution.proofRefs).length === 0
  ) {
    throw new Error("gie_step_owner_and_proof_required");
  }
}

function assertCanTransition(from: GieStepState, to: GieStepState): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`illegal_gie_step_transition:${from}->${to}`);
  }
}

function transition(execution: GieStepwiseExecution, input: TransitionInput): GieStepwiseExecution {
  assertCanTransition(execution.state, input.to);
  const proofRefs = cleanProofRefs([...(input.proofRefs ?? []), ...execution.proofRefs]);
  const event: GieStepAuditEvent = {
    from: execution.state,
    to: input.to,
    action: input.action,
    actor: cleanString(input.actor) || "gie_stepwise_runtime",
    timestamp: input.now ?? Date.now(),
    proofRefs,
    ...(input.note ? { note: input.note } : {}),
  };
  return {
    ...execution,
    ...input.patch,
    state: input.to,
    proofRefs,
    auditLog: [...execution.auditLog, event],
  };
}

export function createGieStepwiseExecution(params: {
  workItemId: string;
  stepId: string;
  ownerLane: string;
  ownerTarget: string;
  proofRefs: string[];
  now?: number;
}): GieStepwiseExecution {
  const execution: GieStepwiseExecution = {
    workItemId: cleanString(params.workItemId),
    stepId: cleanString(params.stepId),
    state: "unresolved",
    ownerLane: cleanString(params.ownerLane),
    ownerTarget: cleanString(params.ownerTarget),
    proofRefs: cleanProofRefs(params.proofRefs),
    currentStepOnly: true,
    auditLog: [],
  };
  return {
    ...execution,
    auditLog: [
      {
        from: null,
        to: "unresolved",
        action: "create",
        actor: "gie_stepwise_runtime",
        timestamp: params.now ?? Date.now(),
        proofRefs: execution.proofRefs,
      },
    ],
  };
}

export function materializeGieProductionItem(params: {
  itemId: string;
  itemKind: GieProductionItemKind;
  ownerLane: string;
  ownerTarget: string;
  proofRefs: string[];
  materializedRef: string;
  now?: number;
}): GieStepwiseExecution {
  const itemId = cleanString(params.itemId);
  const materializedRef = cleanString(params.materializedRef);
  if (!itemId) {
    throw new Error("gie_production_item_id_required");
  }
  if (!GIE_PRODUCTION_ITEM_KINDS.includes(params.itemKind)) {
    throw new Error(`unsupported_gie_production_item_kind:${params.itemKind}`);
  }
  let execution = createGieStepwiseExecution({
    workItemId: itemId,
    stepId: `${params.itemKind}:${itemId}`,
    ownerLane: params.ownerLane,
    ownerTarget: params.ownerTarget,
    proofRefs: params.proofRefs,
    now: params.now,
  });
  execution = selectGieStep(execution, {
    selectedBy: "gie_production_item_mapper",
    now: params.now,
  });
  return materializeGieStep(execution, { materializedRef, now: params.now });
}

export function selectGieStep(
  execution: GieStepwiseExecution,
  params: {
    selectedBy: string;
    now?: number;
  },
): GieStepwiseExecution {
  assertOwnerAndProof(execution);
  return transition(execution, {
    action: "select",
    actor: params.selectedBy,
    to: "selected",
    now: params.now,
  });
}

export function materializeGieStep(
  execution: GieStepwiseExecution,
  params: {
    materializedRef: string;
    now?: number;
  },
): GieStepwiseExecution {
  const materializedRef = cleanString(params.materializedRef);
  if (!materializedRef) {
    throw new Error("gie_step_materialized_ref_required");
  }
  return transition(execution, {
    action: "materialize",
    to: "materialized",
    now: params.now,
    proofRefs: [materializedRef],
    patch: { materializedRef },
  });
}

export function dispatchGieStep(
  execution: GieStepwiseExecution,
  params: {
    dispatchRef: string;
    now?: number;
  },
): GieStepwiseExecution {
  const dispatchRef = cleanString(params.dispatchRef);
  if (!dispatchRef) {
    throw new Error("gie_step_dispatch_ref_required");
  }
  const dispatched = transition(execution, {
    action: "dispatch",
    to: "dispatched",
    now: params.now,
    proofRefs: [dispatchRef],
    patch: { dispatchRef },
  });
  return transition(dispatched, {
    action: "run_started",
    to: "running",
    now: params.now,
    proofRefs: [dispatchRef],
  });
}

export function submitGieStepForVerification(
  execution: GieStepwiseExecution,
  params: {
    runReceiptRef: string;
    now?: number;
  },
): GieStepwiseExecution {
  const runReceiptRef = cleanString(params.runReceiptRef);
  if (!runReceiptRef) {
    throw new Error("gie_step_run_receipt_ref_required");
  }
  return transition(execution, {
    action: "submit_for_verification",
    to: "verification_pending",
    now: params.now,
    proofRefs: [runReceiptRef],
    patch: { runReceiptRef },
  });
}

export function verifyGieStep(
  execution: GieStepwiseExecution,
  params: {
    verifierReceiptRef: string;
    passed: boolean;
    now?: number;
  },
): GieStepwiseExecution {
  const verifierReceiptRef = cleanString(params.verifierReceiptRef);
  if (!verifierReceiptRef) {
    throw new Error("gie_step_verifier_receipt_ref_required");
  }
  const verifiedOrFix = transition(execution, {
    action: params.passed ? "verify_pass" : "verify_fix_required",
    to: params.passed ? "verified" : "fix_required",
    now: params.now,
    proofRefs: [verifierReceiptRef],
    patch: { verifierReceiptRef },
  });
  if (!params.passed) {
    return verifiedOrFix;
  }
  return transition(verifiedOrFix, {
    action: "complete_current_step",
    to: "completed",
    now: params.now,
    proofRefs: [verifierReceiptRef],
  });
}

export function fixGieStep(
  execution: GieStepwiseExecution,
  params: {
    fixRef: string;
    now?: number;
  },
): GieStepwiseExecution {
  const fixRef = cleanString(params.fixRef);
  if (!fixRef) {
    throw new Error("gie_step_fix_ref_required");
  }
  return transition(execution, {
    action: "fix",
    to: "fixed",
    now: params.now,
    proofRefs: [fixRef],
    patch: { fixRef },
  });
}

export function failGieStep(
  execution: GieStepwiseExecution,
  params: {
    failureRef: string;
    now?: number;
  },
): GieStepwiseExecution {
  const failureRef = cleanString(params.failureRef);
  if (!failureRef) {
    throw new Error("gie_step_failure_ref_required");
  }
  if (TERMINAL_STATES.has(execution.state)) {
    throw new Error(`illegal_gie_step_transition:${execution.state}->failed`);
  }
  return transition(execution, {
    action: "fail",
    to: "failed",
    now: params.now,
    proofRefs: [failureRef],
    patch: { failureRef },
  });
}

export function reconcileGieStep(
  execution: GieStepwiseExecution,
  params: {
    reconciliationRef: string;
    now?: number;
  },
): GieStepwiseExecution {
  const reconciliationRef = cleanString(params.reconciliationRef);
  if (!reconciliationRef) {
    throw new Error("gie_step_reconciliation_ref_required");
  }
  return transition(execution, {
    action: "reconcile",
    to: "reconciled",
    now: params.now,
    proofRefs: [reconciliationRef],
    patch: { reconciliationRef },
  });
}

export function hardStopGieStep(
  execution: GieStepwiseExecution,
  params: {
    hardStopRef: string;
    reason: string;
    now?: number;
  },
): GieStepwiseExecution {
  const hardStopRef = cleanString(params.hardStopRef);
  const reason = cleanString(params.reason);
  if (!hardStopRef || !reason) {
    throw new Error("gie_step_hard_stop_ref_and_reason_required");
  }
  if (execution.state === "hard_stopped") {
    throw new Error("illegal_gie_step_transition:hard_stopped->hard_stopped");
  }
  return transition(execution, {
    action: "hard_stop",
    to: "hard_stopped",
    now: params.now,
    proofRefs: [hardStopRef],
    note: reason,
    patch: { hardStopRef, hardStopReason: reason },
  });
}
