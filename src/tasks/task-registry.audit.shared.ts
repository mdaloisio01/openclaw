import type { TaskRecord } from "./task-registry.types.js";

export type TaskAuditSeverity = "warn" | "error";
export type TaskAuditCode =
  | "stale_queued"
  | "stale_running"
  | "lost"
  | "delivery_failed"
  | "missing_cleanup"
  | "inconsistent_timestamps"
  | "accepted_not_yet_proven_active_too_long"
  | "parent_review_state_without_active_executor"
  | "open_build_no_active_owner"
  | "owner_readout_finished_no_followthrough"
  | "routed_to_owner_not_proven_active"
  | "build_open_all_related_sessions_terminal"
  | "execution_truth_conflicts_with_status_text"
  | "trb_gate_blocked_recovery_required"
  | "trb_gate_pending_recovery_required"
  | "parent_continuity_violation"
  | "rework_follow_through_violation";

export type TaskAuditFinding = {
  severity: TaskAuditSeverity;
  code: TaskAuditCode;
  task: TaskRecord;
  ageMs?: number;
  detail: string;
};

export type TaskAuditSummary = {
  total: number;
  warnings: number;
  errors: number;
  byCode: Record<TaskAuditCode, number>;
};

type TaskAuditComparableFinding = {
  severity: TaskAuditSeverity;
  ageMs?: number;
  createdAt: number;
};

export function createEmptyTaskAuditSummary(): TaskAuditSummary {
  return {
    total: 0,
    warnings: 0,
    errors: 0,
    byCode: {
      stale_queued: 0,
      stale_running: 0,
      lost: 0,
      delivery_failed: 0,
      missing_cleanup: 0,
      inconsistent_timestamps: 0,
      accepted_not_yet_proven_active_too_long: 0,
      parent_review_state_without_active_executor: 0,
      open_build_no_active_owner: 0,
      owner_readout_finished_no_followthrough: 0,
      routed_to_owner_not_proven_active: 0,
      build_open_all_related_sessions_terminal: 0,
      execution_truth_conflicts_with_status_text: 0,
      trb_gate_blocked_recovery_required: 0,
      trb_gate_pending_recovery_required: 0,
      parent_continuity_violation: 0,
      rework_follow_through_violation: 0,
    },
  };
}

export function compareTaskAuditFindingSortKeys(
  left: TaskAuditComparableFinding,
  right: TaskAuditComparableFinding,
): number {
  const severityRank = (severity: TaskAuditSeverity) => (severity === "error" ? 0 : 1);
  const severityDiff = severityRank(left.severity) - severityRank(right.severity);
  if (severityDiff !== 0) {
    return severityDiff;
  }
  const leftAge = left.ageMs ?? -1;
  const rightAge = right.ageMs ?? -1;
  if (leftAge !== rightAge) {
    return rightAge - leftAge;
  }
  return left.createdAt - right.createdAt;
}
