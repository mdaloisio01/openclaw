import { evaluatePolicyDecision, type GiePolicyDecision } from "./policy-engine.js";

export const GIE_OPERATOR_DASHBOARD_QUEUES = [
  "operator_review",
  "approvals",
  "denials",
  "contradictions",
  "feedback_corrections",
  "learning_candidates",
  "promotion_rollbacks",
  "recurring_issues",
  "drift_alerts",
  "unsafe_pattern_alerts",
] as const;

export const GIE_OPERATOR_CONTROL_ACTIONS = [
  "inspect_proof",
  "inspect_state",
  "approve",
  "deny",
  "pause",
  "resume",
  "request_override",
  "freeze",
] as const;

export type GieOperatorDashboardQueue = (typeof GIE_OPERATOR_DASHBOARD_QUEUES)[number];
export type GieOperatorControlActionKind = (typeof GIE_OPERATOR_CONTROL_ACTIONS)[number];
export type GieOperatorControlActionStatus = "recorded" | "approval_required" | "blocked";

export type GieOperatorQueueItem = {
  itemId: string;
  queue: GieOperatorDashboardQueue;
  title: string;
  stateRef: string;
  proofRefs: string[];
  authorityRef: string;
  priority: "low" | "medium" | "high";
  createdAt: number;
};

export type GieProofVisibilityRecord = {
  targetRef: string;
  proofRefs: string[];
  receiptRefs: string[];
  visible: true;
};

export type GieStateVisibilityRecord = {
  targetRef: string;
  currentState: string;
  stateRef: string;
  visible: true;
};

export type GieOperatorDashboardState = {
  dashboardId: string;
  queues: Record<GieOperatorDashboardQueue, GieOperatorQueueItem[]>;
  proofVisibility: GieProofVisibilityRecord[];
  stateVisibility: GieStateVisibilityRecord[];
  authorityRef: string;
  proofRefs: string[];
  generatedAt: number;
};

export type GieOperatorControlAction = {
  actionId: string;
  action: GieOperatorControlActionKind;
  targetRef: string;
  requestedBy: string;
  status: GieOperatorControlActionStatus;
  policyDecision: GiePolicyDecision;
  approvalRef: string | null;
  reason: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
};

function cleanString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanRefs(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function requireTimestamp(value: number, error: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(error);
  }
}

function requireRefs(value: string[], error: string): void {
  if (value.length === 0) {
    throw new Error(error);
  }
}

function emptyQueues(): Record<GieOperatorDashboardQueue, GieOperatorQueueItem[]> {
  const queues = {} as Record<GieOperatorDashboardQueue, GieOperatorQueueItem[]>;
  for (const queue of GIE_OPERATOR_DASHBOARD_QUEUES) {
    queues[queue] = [];
  }
  return queues;
}

function requiresApproval(action: GieOperatorControlActionKind): boolean {
  return action === "approve" || action === "pause" || action === "resume" || action === "freeze";
}

function isOverrideAction(action: GieOperatorControlActionKind): boolean {
  return action === "request_override";
}

export function createGieOperatorQueueItem(params: {
  itemId: string;
  queue: GieOperatorDashboardQueue;
  title: string;
  stateRef: string;
  proofRefs: string[];
  authorityRef: string;
  priority: "low" | "medium" | "high";
  createdAt: number;
}): GieOperatorQueueItem {
  const proofRefs = cleanRefs(params.proofRefs);
  requireRefs(proofRefs, "gie_operator_queue_item_proof_required");
  const item: GieOperatorQueueItem = {
    itemId: cleanString(params.itemId),
    queue: params.queue,
    title: cleanString(params.title),
    stateRef: cleanString(params.stateRef),
    proofRefs,
    authorityRef: cleanString(params.authorityRef),
    priority: params.priority,
    createdAt: params.createdAt,
  };
  if (
    !item.itemId ||
    !GIE_OPERATOR_DASHBOARD_QUEUES.includes(item.queue) ||
    !item.title ||
    !item.stateRef ||
    !item.authorityRef
  ) {
    throw new Error("gie_operator_queue_item_required_fields_missing");
  }
  requireTimestamp(item.createdAt, "gie_operator_queue_item_timestamp_required");
  return item;
}

export function createGieProofVisibilityRecord(params: {
  targetRef: string;
  proofRefs: string[];
  receiptRefs: string[];
}): GieProofVisibilityRecord {
  const proofRefs = cleanRefs(params.proofRefs);
  const receiptRefs = cleanRefs(params.receiptRefs);
  requireRefs(proofRefs, "gie_proof_visibility_proof_required");
  return {
    targetRef: cleanString(params.targetRef),
    proofRefs,
    receiptRefs,
    visible: true,
  };
}

export function createGieStateVisibilityRecord(params: {
  targetRef: string;
  currentState: string;
  stateRef: string;
}): GieStateVisibilityRecord {
  const record: GieStateVisibilityRecord = {
    targetRef: cleanString(params.targetRef),
    currentState: cleanString(params.currentState),
    stateRef: cleanString(params.stateRef),
    visible: true,
  };
  if (!record.targetRef || !record.currentState || !record.stateRef) {
    throw new Error("gie_state_visibility_required_fields_missing");
  }
  return record;
}

export function createGieOperatorDashboardState(params: {
  dashboardId: string;
  queueItems: GieOperatorQueueItem[];
  proofVisibility: GieProofVisibilityRecord[];
  stateVisibility: GieStateVisibilityRecord[];
  authorityRef: string;
  proofRefs: string[];
  generatedAt: number;
}): GieOperatorDashboardState {
  const proofRefs = cleanRefs(params.proofRefs);
  requireRefs(proofRefs, "gie_operator_dashboard_proof_required");
  const queues = emptyQueues();
  for (const item of params.queueItems) {
    queues[item.queue].push(item);
  }
  const state: GieOperatorDashboardState = {
    dashboardId: cleanString(params.dashboardId),
    queues,
    proofVisibility: params.proofVisibility,
    stateVisibility: params.stateVisibility,
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    generatedAt: params.generatedAt,
  };
  if (
    !state.dashboardId ||
    !state.authorityRef ||
    state.proofVisibility.length === 0 ||
    state.stateVisibility.length === 0
  ) {
    throw new Error("gie_operator_dashboard_required_fields_missing");
  }
  requireTimestamp(state.generatedAt, "gie_operator_dashboard_timestamp_required");
  return state;
}

export function createGieOperatorControlAction(params: {
  actionId: string;
  action: GieOperatorControlActionKind;
  targetRef: string;
  requestedBy: string;
  approvalRef?: string | null;
  reason: string;
  authorityRef: string;
  proofRefs: string[];
  createdAt: number;
}): GieOperatorControlAction {
  const action = params.action;
  const approvalRef = cleanString(params.approvalRef ?? "");
  const proofRefs = cleanRefs([...params.proofRefs, approvalRef]);
  requireRefs(proofRefs, "gie_operator_control_action_proof_required");
  if (requiresApproval(action) && !approvalRef) {
    throw new Error("gie_operator_control_action_approval_required");
  }
  const policyDecision = evaluatePolicyDecision({
    action: isOverrideAction(action) ? "operator_override" : "governed_dispatch",
    ownerLane: "operations",
    ownerTarget: "gie_operator_control_surface",
    proofRefs,
    approvalRef: approvalRef || null,
    requestedBy: cleanString(params.requestedBy),
  });
  const status: GieOperatorControlActionStatus = policyDecision.allowed
    ? "recorded"
    : policyDecision.decision === "approval_required"
      ? "approval_required"
      : "blocked";
  const controlAction: GieOperatorControlAction = {
    actionId: cleanString(params.actionId),
    action,
    targetRef: cleanString(params.targetRef),
    requestedBy: cleanString(params.requestedBy),
    status,
    policyDecision,
    approvalRef: approvalRef || null,
    reason: cleanString(params.reason),
    authorityRef: cleanString(params.authorityRef),
    proofRefs,
    createdAt: params.createdAt,
  };
  if (
    !controlAction.actionId ||
    !GIE_OPERATOR_CONTROL_ACTIONS.includes(controlAction.action) ||
    !controlAction.targetRef ||
    !controlAction.requestedBy ||
    !controlAction.reason ||
    !controlAction.authorityRef
  ) {
    throw new Error("gie_operator_control_action_required_fields_missing");
  }
  requireTimestamp(controlAction.createdAt, "gie_operator_control_action_timestamp_required");
  return controlAction;
}
