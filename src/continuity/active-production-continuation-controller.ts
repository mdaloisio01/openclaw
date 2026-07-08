import type {
  ActiveProductionBoundary,
  ActiveProductionContinuationReceipt,
  ActiveProductionContinuationState,
  ActiveProductionDispatchSurface,
  ActiveProductionNextAction,
} from "../tasks/task-flow-registry.types.js";

export type ActiveProductionAttemptKind =
  | "status_update"
  | "milestone_report"
  | "closeout"
  | "watchdog_reconciliation"
  | "build_state_interpretation"
  | "final_answer"
  | "task_success";

export type ActiveProductionBoundaryResolverInput = {
  broaderBuildOpen: boolean;
  nextAction?: ActiveProductionNextAction;
  controllingBuildPlanPresent?: boolean;
  buildPlanStaleOrContradicted?: boolean;
  authorityConflict?: boolean;
  nextOwnerClear?: boolean;
  nextActionClear?: boolean;
  operatorProductDecisionRequired?: boolean;
  operatorScopeDecisionRequired?: boolean;
  destructiveActionRequired?: boolean;
  externalSideEffectRequired?: boolean;
  privacySensitiveActionRequired?: boolean;
  financialActionRequired?: boolean;
  proofSourceAvailable?: boolean;
  technicalImpossibility?: boolean;
  validationFailedNoRecoveryPath?: boolean;
  unsupportedRuntimeSurface?: boolean;
  explicitUserStop?: boolean;
};

export type ActiveProductionFinalityEvaluation = {
  allowed: boolean;
  result: "complete_allowed" | "continuation_required" | "hard_boundary";
  boundary: ActiveProductionBoundary;
  reason: string;
  receipt?: ActiveProductionContinuationReceipt;
};

export type ActiveProductionFinalityInput = {
  state: ActiveProductionContinuationState;
  attemptedFinalKind: ActiveProductionAttemptKind;
  now?: number;
};

const HARD_BOUNDARIES = new Set<ActiveProductionBoundary>([
  "operator_product_decision_required",
  "operator_scope_decision_required",
  "unsafe_destructive_action_required",
  "external_side_effect_required",
  "privacy_sensitive_action_required",
  "financial_action_required",
  "unresolved_authority_conflict",
  "missing_controlling_build_plan",
  "stale_or_contradicted_build_plan",
  "next_owner_unclear",
  "next_action_unclear",
  "proof_source_unavailable",
  "technical_impossibility",
  "validation_failed_no_recovery_path",
  "unsupported_runtime_surface",
  "explicit_user_stop",
]);

export function isActiveProductionHardBoundary(boundary: ActiveProductionBoundary): boolean {
  return HARD_BOUNDARIES.has(boundary);
}

export function resolveActiveProductionBoundary(
  input: ActiveProductionBoundaryResolverInput,
): ActiveProductionBoundary {
  if (!input.broaderBuildOpen) {
    return "complete";
  }
  if (input.explicitUserStop) {
    return "explicit_user_stop";
  }
  if (input.technicalImpossibility) {
    return "technical_impossibility";
  }
  if (input.unsupportedRuntimeSurface) {
    return "unsupported_runtime_surface";
  }
  if (input.validationFailedNoRecoveryPath) {
    return "validation_failed_no_recovery_path";
  }
  if (input.controllingBuildPlanPresent === false) {
    return "missing_controlling_build_plan";
  }
  if (input.buildPlanStaleOrContradicted) {
    return "stale_or_contradicted_build_plan";
  }
  if (input.authorityConflict) {
    return "unresolved_authority_conflict";
  }
  if (input.operatorProductDecisionRequired) {
    return "operator_product_decision_required";
  }
  if (input.operatorScopeDecisionRequired) {
    return "operator_scope_decision_required";
  }
  if (input.destructiveActionRequired) {
    return "unsafe_destructive_action_required";
  }
  if (input.externalSideEffectRequired) {
    return "external_side_effect_required";
  }
  if (input.privacySensitiveActionRequired) {
    return "privacy_sensitive_action_required";
  }
  if (input.financialActionRequired) {
    return "financial_action_required";
  }
  if (input.proofSourceAvailable === false) {
    return "proof_source_unavailable";
  }
  if (input.nextOwnerClear === false) {
    return "next_owner_unclear";
  }
  if (input.nextActionClear === false || !input.nextAction) {
    return "next_action_unclear";
  }
  return input.nextAction.boundary;
}

export function createActiveProductionDispatchReceipt(params: {
  action: ActiveProductionNextAction;
  receiptId?: string;
  dispatchedAt?: number;
  proofRef?: string;
}): ActiveProductionContinuationReceipt {
  const proofRef = params.proofRef ?? params.action.dispatchProofRef;
  if (!proofRef?.trim()) {
    throw new Error("Active production continuation dispatch receipt requires proofRef.");
  }
  return {
    receiptId: params.receiptId ?? `${params.action.actionId}:dispatch`,
    actionId: params.action.actionId,
    surface: params.action.surface,
    boundary: params.action.boundary,
    dispatchedAt: params.dispatchedAt ?? Date.now(),
    owner: params.action.owner,
    summary: params.action.summary,
    proofRef: proofRef.trim(),
  };
}

export function hasValidContinuationDispatchReceipt(
  state: ActiveProductionContinuationState,
): boolean {
  const actionId = state.nextAction?.actionId;
  if (!state.activeProductionRun || !state.broaderBuildOpen || !actionId) {
    return false;
  }
  return state.dispatchReceipts.some(
    (receipt) =>
      receipt.actionId === actionId &&
      receipt.receiptId.trim().length > 0 &&
      receipt.proofRef.trim().length > 0 &&
      receipt.dispatchedAt > 0,
  );
}

export function evaluateActiveProductionFinality(
  input: ActiveProductionFinalityInput,
): ActiveProductionFinalityEvaluation {
  const { state, attemptedFinalKind } = input;
  if (!state.activeProductionRun) {
    return {
      allowed: true,
      result: "complete_allowed",
      boundary: "none",
      reason: `${attemptedFinalKind}: not an active production run`,
    };
  }
  if (!state.broaderBuildOpen || state.boundary === "complete" || state.status === "complete") {
    return {
      allowed: true,
      result: "complete_allowed",
      boundary: "complete",
      reason: `${attemptedFinalKind}: broader build is closed`,
    };
  }
  const boundary = resolveActiveProductionBoundary({
    broaderBuildOpen: state.broaderBuildOpen,
    nextAction: state.nextAction,
  });
  if (isActiveProductionHardBoundary(boundary)) {
    return {
      allowed: false,
      result: "hard_boundary",
      boundary,
      reason: `${attemptedFinalKind}: active production hit hard boundary ${boundary}`,
    };
  }
  const receipt = state.dispatchReceipts.find(
    (candidate) => candidate.actionId === state.nextAction?.actionId,
  );
  if (receipt && hasValidContinuationDispatchReceipt(state)) {
    return {
      allowed: true,
      result: "complete_allowed",
      boundary,
      receipt,
      reason: `${attemptedFinalKind}: continuation dispatch receipt is present`,
    };
  }
  return {
    allowed: false,
    result: "continuation_required",
    boundary,
    reason: `${attemptedFinalKind}: broader build is open and continuation dispatch proof is missing`,
  };
}

export function buildActiveProductionContinuationState(params: {
  activeProductionRun: boolean;
  broaderBuildOpen: boolean;
  boundary?: ActiveProductionBoundary;
  nextAction?: ActiveProductionNextAction;
  dispatchReceipts?: ActiveProductionContinuationReceipt[];
}): ActiveProductionContinuationState {
  const boundary =
    params.boundary ??
    resolveActiveProductionBoundary({
      broaderBuildOpen: params.broaderBuildOpen,
      nextAction: params.nextAction,
    });
  const dispatchReceipts = params.dispatchReceipts ?? [];
  const base: ActiveProductionContinuationState = {
    activeProductionRun: params.activeProductionRun,
    broaderBuildOpen: params.broaderBuildOpen,
    status: "inactive",
    boundary,
    dispatchReceipts,
  };
  if (!params.activeProductionRun) {
    return base;
  }
  if (!params.broaderBuildOpen || boundary === "complete") {
    return { ...base, status: "complete" };
  }
  if (isActiveProductionHardBoundary(boundary)) {
    return {
      ...base,
      status: "hard_boundary",
      ...(params.nextAction ? { nextAction: params.nextAction } : {}),
    };
  }
  const state: ActiveProductionContinuationState = {
    ...base,
    status: "dispatch_required",
    ...(params.nextAction ? { nextAction: params.nextAction } : {}),
  };
  return hasValidContinuationDispatchReceipt(state) ? { ...state, status: "dispatched" } : state;
}

export function buildTaskFlowDispatchAction(params: {
  actionId: string;
  owner: string;
  summary: string;
  boundary?: ActiveProductionBoundary;
  surface?: ActiveProductionDispatchSurface;
  dispatchProofRef?: string;
}): ActiveProductionNextAction {
  return {
    actionId: params.actionId,
    owner: params.owner,
    summary: params.summary,
    boundary: params.boundary ?? "plan_next_step",
    surface: params.surface ?? "taskflow_child",
    ...(params.dispatchProofRef ? { dispatchProofRef: params.dispatchProofRef } : {}),
  };
}
