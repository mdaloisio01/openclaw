export const CLEANUP_WATCHDOG_POLICY_VERSION =
  "cleanup-watchdog-governance-20260715T1442Z" as const;

export const CLEANUP_WATCHDOG_ACCEPTED_READ_VERSIONS = [
  CLEANUP_WATCHDOG_POLICY_VERSION,
  "cleanup-crew-governance-final-20260714T1454Z",
] as const;

export type CleanupWatchdogPolicyVersion = (typeof CLEANUP_WATCHDOG_ACCEPTED_READ_VERSIONS)[number];

export const GOVERNANCE_MISSION_STATES = [
  "created",
  "authorized",
  "running",
  "recovering",
  "deferred",
  "external_wait",
  "owner_wait",
  "blocked_verified",
  "complete",
  "aborted_verified",
  "superseded",
] as const;

export type GovernanceMissionState =
  | "created"
  | "authorized"
  | "running"
  | "recovering"
  | "deferred"
  | "external_wait"
  | "owner_wait"
  | "blocked_verified"
  | "complete"
  | "aborted_verified"
  | "superseded";

export const GOVERNANCE_PHASE_STATES = [
  "not_started",
  "ready",
  "running",
  "reporting",
  "dispatching_next",
  "recovering",
  "blocked_verified",
  "complete",
  "skipped_by_policy",
  "superseded",
] as const;

export type GovernancePhaseState =
  | "not_started"
  | "ready"
  | "running"
  | "reporting"
  | "dispatching_next"
  | "recovering"
  | "blocked_verified"
  | "complete"
  | "skipped_by_policy"
  | "superseded";

export const GOVERNANCE_ACTION_STATES = [
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed_retryable",
  "failed_recovering",
  "blocked_verified",
  "cancelled",
  "superseded",
] as const;

export type GovernanceActionState =
  | "queued"
  | "leased"
  | "running"
  | "succeeded"
  | "failed_retryable"
  | "failed_recovering"
  | "blocked_verified"
  | "cancelled"
  | "superseded";

export const GOVERNANCE_WORKER_STATES = [
  "candidate",
  "assigned",
  "leased",
  "heartbeat_current",
  "heartbeat_stale",
  "lost",
  "superseding",
  "superseded",
  "terminated",
  "unknown_invalid",
] as const;

export type GovernanceWorkerState =
  | "candidate"
  | "assigned"
  | "leased"
  | "heartbeat_current"
  | "heartbeat_stale"
  | "lost"
  | "superseding"
  | "superseded"
  | "terminated"
  | "unknown_invalid";

export const GOVERNANCE_CONTINUATION_STATES = [
  "none_invalid",
  "dispatch_pending",
  "dispatch_receipted",
  "resume_ready",
  "deferred_until_drain",
  "external_wait",
  "owner_wait",
  "blocked_verified",
  "completed",
  "superseded",
  "lost",
] as const;

export type GovernanceContinuationState =
  | "none_invalid"
  | "dispatch_pending"
  | "dispatch_receipted"
  | "resume_ready"
  | "deferred_until_drain"
  | "external_wait"
  | "owner_wait"
  | "blocked_verified"
  | "completed"
  | "superseded"
  | "lost";

export const GOVERNANCE_WATCHDOG_FINDING_STATES = [
  "detected",
  "delivered",
  "acknowledged",
  "owned",
  "repair_task_created",
  "repairing",
  "validation_pending",
  "closed_clean",
  "closed_verified_blocked",
  "superseded",
  "stale_obsolete",
] as const;

export type GovernanceWatchdogFindingState =
  | "detected"
  | "delivered"
  | "acknowledged"
  | "owned"
  | "repair_task_created"
  | "repairing"
  | "validation_pending"
  | "closed_clean"
  | "closed_verified_blocked"
  | "superseded"
  | "stale_obsolete";

export const GOVERNANCE_DELIVERY_STATES = [
  "not_required",
  "pending_report_delivery",
  "pending_milestone_report",
  "retrying",
  "delivered",
  "failed_blocking",
  "superseded_by_later_delivery",
] as const;

export type GovernanceDeliveryState =
  | "not_required"
  | "pending_report_delivery"
  | "pending_milestone_report"
  | "retrying"
  | "delivered"
  | "failed_blocking"
  | "superseded_by_later_delivery";

export const GOVERNANCE_DECISION_STATES = [
  "not_required",
  "owner_decision_required",
  "owner_decision_answered",
  "external_dependency",
  "external_dependency_resolved",
  "external_dependency_expired",
  "invalid_as_owner_decision",
] as const;

export type GovernanceDecisionState =
  | "not_required"
  | "owner_decision_required"
  | "owner_decision_answered"
  | "external_dependency"
  | "external_dependency_resolved"
  | "external_dependency_expired"
  | "invalid_as_owner_decision";

export type CleanupWatchdogPriorityCode =
  | "P1_SAFETY_OR_DUPLICATE_EXECUTION"
  | "P2_ACTIVE_NO_WORKER"
  | "P3_CORRUPTED_STATE"
  | "P4_RESTART_OR_RUNTIME_RECOVERY"
  | "P5_MISSING_PROOF_OR_POLICY_MIGRATION"
  | "P6_REVIEW_REQUIRED_FOR_SAFE_WORK"
  | "P7_PENDING_REPORT_DELIVERY"
  | "P8_STALE_ARTIFACT_DEBT";

export type CleanupWatchdogFindingCategory =
  | "safety_or_destructive_risk"
  | "duplicate_execution_or_fencing_failure"
  | "active_no_worker"
  | "lost_ownership"
  | "corrupted_state"
  | "corrupted_pointer"
  | "corrupted_identity"
  | "corrupted_continuation"
  | "stale_lease"
  | "revision_mismatch"
  | "restart_recovery_failure"
  | "runtime_recovery_failure"
  | "mission_resumption_missing"
  | "missing_correctness_proof"
  | "policy_version_mismatch"
  | "review_required_for_safe_work"
  | "pending_report_delivery"
  | "pending_milestone_report"
  | "stale_artifact"
  | "non_executable_reporting_debt";

export type CleanupWatchdogCleanDimension =
  | "record_integrity"
  | "worker_coverage"
  | "continuation_readiness"
  | "delivery_completeness"
  | "runtime_health"
  | "repair_closure"
  | "policy_version";

export const CLEANUP_WATCHDOG_CLEAN_DIMENSIONS = [
  "record_integrity",
  "worker_coverage",
  "continuation_readiness",
  "delivery_completeness",
  "runtime_health",
  "repair_closure",
  "policy_version",
] as const;

export type CleanupWatchdogCoverageKind =
  | "valid_executor"
  | "durable_defer"
  | "external_wait"
  | "owner_wait"
  | "verified_blocker";

export const CLEANUP_WATCHDOG_COVERAGE_KINDS = [
  "valid_executor",
  "durable_defer",
  "external_wait",
  "owner_wait",
  "verified_blocker",
] as const;

export type CleanupWatchdogActivationGate =
  | "policy_schema_generated"
  | "sop_parity_validated"
  | "source_built_runtime_match"
  | "watchdog_clean"
  | "worker_coverage_proven"
  | "shadow_decisions_stable"
  | "repair_tasks_drained"
  | "grant_review_passed"
  | "rollback_plan_verified"
  | "production_paused"
  | "trinity_unstarted"
  | "control_plane_phase2_paused";

export const CLEANUP_WATCHDOG_ACTIVATION_GATES = [
  "policy_schema_generated",
  "sop_parity_validated",
  "source_built_runtime_match",
  "watchdog_clean",
  "worker_coverage_proven",
  "shadow_decisions_stable",
  "repair_tasks_drained",
  "grant_review_passed",
  "rollback_plan_verified",
  "production_paused",
  "trinity_unstarted",
  "control_plane_phase2_paused",
] as const;

export type CleanupWatchdogCoverageInput = {
  unfinished: boolean;
  activeProduction: boolean;
  executorCount: number;
  executorLeaseCurrent?: boolean;
  durableDeferRecord?: boolean;
  externalWaitRecord?: boolean;
  ownerWaitRecord?: boolean;
  verifiedBlockerRecord?: boolean;
};

export type CleanupWatchdogCoverageDecision = {
  ok: boolean;
  kind?: CleanupWatchdogCoverageKind;
  reason: string;
};

export const CLEANUP_WATCHDOG_PRIORITY_ORDER: readonly CleanupWatchdogPriorityCode[] = [
  "P1_SAFETY_OR_DUPLICATE_EXECUTION",
  "P2_ACTIVE_NO_WORKER",
  "P3_CORRUPTED_STATE",
  "P4_RESTART_OR_RUNTIME_RECOVERY",
  "P5_MISSING_PROOF_OR_POLICY_MIGRATION",
  "P6_REVIEW_REQUIRED_FOR_SAFE_WORK",
  "P7_PENDING_REPORT_DELIVERY",
  "P8_STALE_ARTIFACT_DEBT",
] as const;

const PRIORITY_BY_CATEGORY: Record<CleanupWatchdogFindingCategory, CleanupWatchdogPriorityCode> = {
  safety_or_destructive_risk: "P1_SAFETY_OR_DUPLICATE_EXECUTION",
  duplicate_execution_or_fencing_failure: "P1_SAFETY_OR_DUPLICATE_EXECUTION",
  active_no_worker: "P2_ACTIVE_NO_WORKER",
  lost_ownership: "P2_ACTIVE_NO_WORKER",
  corrupted_state: "P3_CORRUPTED_STATE",
  corrupted_pointer: "P3_CORRUPTED_STATE",
  corrupted_identity: "P3_CORRUPTED_STATE",
  corrupted_continuation: "P3_CORRUPTED_STATE",
  stale_lease: "P3_CORRUPTED_STATE",
  revision_mismatch: "P3_CORRUPTED_STATE",
  restart_recovery_failure: "P4_RESTART_OR_RUNTIME_RECOVERY",
  runtime_recovery_failure: "P4_RESTART_OR_RUNTIME_RECOVERY",
  mission_resumption_missing: "P4_RESTART_OR_RUNTIME_RECOVERY",
  missing_correctness_proof: "P5_MISSING_PROOF_OR_POLICY_MIGRATION",
  policy_version_mismatch: "P5_MISSING_PROOF_OR_POLICY_MIGRATION",
  review_required_for_safe_work: "P6_REVIEW_REQUIRED_FOR_SAFE_WORK",
  pending_report_delivery: "P7_PENDING_REPORT_DELIVERY",
  pending_milestone_report: "P7_PENDING_REPORT_DELIVERY",
  stale_artifact: "P8_STALE_ARTIFACT_DEBT",
  non_executable_reporting_debt: "P8_STALE_ARTIFACT_DEBT",
};

const PRIORITY_RANK = new Map(
  CLEANUP_WATCHDOG_PRIORITY_ORDER.map((priority, index) => [priority, index]),
);

export function getCleanupWatchdogPriority(
  category: CleanupWatchdogFindingCategory,
): CleanupWatchdogPriorityCode {
  return PRIORITY_BY_CATEGORY[category];
}

export function compareCleanupWatchdogPriority(
  left: CleanupWatchdogPriorityCode,
  right: CleanupWatchdogPriorityCode,
): number {
  return (
    (PRIORITY_RANK.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (PRIORITY_RANK.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function isCleanupWatchdogPolicyVersionCompatible(value: unknown): boolean {
  return (
    typeof value === "string" &&
    CLEANUP_WATCHDOG_ACCEPTED_READ_VERSIONS.includes(value as CleanupWatchdogPolicyVersion)
  );
}

export function evaluateCleanupWatchdogCoverage(
  input: CleanupWatchdogCoverageInput,
): CleanupWatchdogCoverageDecision {
  if (!input.unfinished || !input.activeProduction) {
    return { ok: true, reason: "coverage_not_required_for_terminal_or_nonproduction_item" };
  }
  if (input.executorCount === 1 && input.executorLeaseCurrent === true) {
    return { ok: true, kind: "valid_executor", reason: "exactly_one_current_executor" };
  }
  if (input.executorCount > 1) {
    return { ok: false, reason: "duplicate_executor_coverage_for_unfinished_mission" };
  }
  const durableCoverage: CleanupWatchdogCoverageKind[] = [];
  if (input.durableDeferRecord) durableCoverage.push("durable_defer");
  if (input.externalWaitRecord) durableCoverage.push("external_wait");
  if (input.ownerWaitRecord) durableCoverage.push("owner_wait");
  if (input.verifiedBlockerRecord) durableCoverage.push("verified_blocker");
  if (durableCoverage.length === 1) {
    return {
      ok: true,
      kind: durableCoverage[0],
      reason: `exactly_one_${durableCoverage[0]}_coverage_record`,
    };
  }
  if (durableCoverage.length > 1) {
    return { ok: false, reason: "multiple_durable_coverage_records_for_unfinished_mission" };
  }
  return { ok: false, reason: "unfinished_active_mission_missing_executor_or_durable_coverage" };
}

export function canCleanupWatchdogCloseClean(params: {
  suspiciousCount: number;
  dimensions: Record<CleanupWatchdogCleanDimension, boolean>;
}): boolean {
  return (
    params.suspiciousCount === 0 &&
    (Object.keys(params.dimensions) as CleanupWatchdogCleanDimension[]).every(
      (dimension) => params.dimensions[dimension] === true,
    )
  );
}
