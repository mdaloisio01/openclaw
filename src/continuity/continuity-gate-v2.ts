import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ContinueState =
  | "CONTINUE_TECHNICAL_REPAIR"
  | "CONTINUE_PLAN_NEXT_STEP"
  | "CONTINUE_AFTER_REPAIRABLE_GRANT_REJECTION"
  | "CONTINUE_AFTER_AUTHORITY_CONFLICT_DIAGNOSIS"
  | "CONTINUE_AFTER_STALE_BLOCKER_RECONCILIATION"
  | "CONTINUE_AFTER_REPO_HYGIENE_REPAIR"
  | "CONTINUE_AFTER_BUILD_OR_TEST_REPAIR"
  | "CONTINUE_AFTER_RUNTIME_PROOF_REPAIR";

export type StopState =
  | "STOP_USER_ANSWER_ONLY_OVERRIDE"
  | "STOP_HUMAN_PRODUCT_DECISION"
  | "STOP_TRUE_UNKNOWN_BLOCKER"
  | "STOP_UNSAFE_BEHAVIOR_CHANGE"
  | "STOP_UNRESOLVED_AUTHORITY_CONFLICT"
  | "COMPLETE";

export type ContinuityGateState = ContinueState | StopState;

export type CleanupCrewBlockerCategory =
  | "repairable_prerequisite_blocker"
  | "downstream_phase_blocked_cleanup_continues"
  | "hard_sop_blocker"
  | "authority_scope_blocker"
  | "unsafe_destructive_blocker"
  | "raw_db_required_blocker"
  | "unsupported_surface_missing_blocker"
  | "proof_source_unavailable_blocker";

export type CleanupCrewCanonicalOutcome =
  | "CONTINUE"
  | "REPAIR_AND_CONTINUE"
  | "RETRY"
  | "DEFER_UNTIL_DRAIN"
  | "ACTION_BLOCKED"
  | "PHASE_BLOCKED"
  | "EXTERNAL_DEPENDENCY"
  | "OWNER_DECISION_REQUIRED"
  | "MISSION_ABORTED"
  | "COMPLETE";

export type CleanupCrewImpactLevel = "ACTION" | "PHASE" | "MISSION";

export type CleanupCrewOwnerDecisionClass =
  | "OWNER_GOAL_CHANGE"
  | "SCOPE_EXPANSION"
  | "PUBLIC_OR_USER_CONTRACT_CHANGE"
  | "BUSINESS_RULE_CHOICE"
  | "RISK_ACCEPTANCE_CHANGE"
  | "DESTRUCTIVE_NO_ROLLBACK"
  | "EXTERNAL_SIDE_EFFECT_REQUIRES_OWNER_CHOICE"
  | "CREDENTIAL_OR_PRIVILEGE_DECISION_REQUIRED"
  | "UNRESOLVED_AUTHORITY_CONFLICT";

export type CleanupCrewExternalDependencyClass =
  | "ROOT_OR_CREDENTIAL_UNAVAILABLE"
  | "EXTERNAL_APPROVAL_UNAVAILABLE";

export type CleanupCrewGovernanceReasonCode =
  | CleanupCrewOwnerDecisionClass
  | CleanupCrewExternalDependencyClass
  | "TECHNICAL_REPAIR"
  | "RETRYABLE_TRANSIENT"
  | "PROOF_PRODUCTION_AVAILABLE"
  | "PROOF_PRODUCER_UNAVAILABLE"
  | "OWNER_CHOICE_REQUIRED"
  | "MALFORMED_POLICY_INPUT"
  | "SCOPE_RISK_UNCLASSIFIED"
  | "ROLE_CAPABILITY_UNAVAILABLE"
  | "REVIEWER_UNAVAILABLE"
  | "ACTIVE_WORK_DRAIN"
  | "STALE_STATE_RECONCILIATION"
  | "REPORT_DELIVERY_REPAIR"
  | "RESTART_DRAIN_WAIT"
  | "PROTECTED_ACTION_DENIED"
  | "ROLLBACK_UNAVAILABLE"
  | "FORBIDDEN_SCOPE"
  | "AUTHORITY_CONFLICT"
  | "REPAIR_BUDGET_EXHAUSTED"
  | "MISSION_EXHAUSTION_PROVEN"
  | "COMPLETE_PROVEN"
  | "SUPERSEDED_MISSION";

export type CleanupCrewGovernanceTaxonomyInput = {
  ownerDecisionClass?: CleanupCrewOwnerDecisionClass;
  ownerChoiceRequired?: boolean;
  ownerChoiceAlreadyMade?: boolean;
  externalDependencyClass?: CleanupCrewExternalDependencyClass;
  technicalPersistenceOrIdentityDefect?: boolean;
  safeTechnicalOptionsAvailable?: boolean;
  malformedOrUnknownInput?: boolean;
  summary?: string;
};

export type CleanupCrewGovernanceTaxonomyDecision = {
  outcome: CleanupCrewCanonicalOutcome;
  reasonCode: CleanupCrewGovernanceReasonCode;
  ownerApprovalRequired: boolean;
  ownerDecisionClass?: CleanupCrewOwnerDecisionClass;
  externalDependencyClass?: CleanupCrewExternalDependencyClass;
  nextAction: string;
  classification: string;
};

export const CLEANUP_CREW_OWNER_DECISION_CLASSES: readonly CleanupCrewOwnerDecisionClass[] = [
  "OWNER_GOAL_CHANGE",
  "SCOPE_EXPANSION",
  "PUBLIC_OR_USER_CONTRACT_CHANGE",
  "BUSINESS_RULE_CHOICE",
  "RISK_ACCEPTANCE_CHANGE",
  "DESTRUCTIVE_NO_ROLLBACK",
  "EXTERNAL_SIDE_EFFECT_REQUIRES_OWNER_CHOICE",
  "CREDENTIAL_OR_PRIVILEGE_DECISION_REQUIRED",
  "UNRESOLVED_AUTHORITY_CONFLICT",
] as const;

export const CLEANUP_CREW_CANONICAL_OUTCOMES: readonly CleanupCrewCanonicalOutcome[] = [
  "CONTINUE",
  "REPAIR_AND_CONTINUE",
  "RETRY",
  "DEFER_UNTIL_DRAIN",
  "ACTION_BLOCKED",
  "PHASE_BLOCKED",
  "EXTERNAL_DEPENDENCY",
  "OWNER_DECISION_REQUIRED",
  "MISSION_ABORTED",
  "COMPLETE",
] as const;

export const CLEANUP_CREW_IMPACT_LEVELS: readonly CleanupCrewImpactLevel[] = [
  "ACTION",
  "PHASE",
  "MISSION",
] as const;

export const CLEANUP_CREW_EXTERNAL_DEPENDENCY_CLASSES: readonly CleanupCrewExternalDependencyClass[] =
  ["ROOT_OR_CREDENTIAL_UNAVAILABLE", "EXTERNAL_APPROVAL_UNAVAILABLE"] as const;

export const CLEANUP_CREW_GOVERNANCE_REASON_CODES: readonly CleanupCrewGovernanceReasonCode[] = [
  "TECHNICAL_REPAIR",
  "RETRYABLE_TRANSIENT",
  "PROOF_PRODUCTION_AVAILABLE",
  "PROOF_PRODUCER_UNAVAILABLE",
  "ROOT_OR_CREDENTIAL_UNAVAILABLE",
  "EXTERNAL_APPROVAL_UNAVAILABLE",
  "OWNER_CHOICE_REQUIRED",
  "MALFORMED_POLICY_INPUT",
  "SCOPE_RISK_UNCLASSIFIED",
  "ROLE_CAPABILITY_UNAVAILABLE",
  "REVIEWER_UNAVAILABLE",
  "ACTIVE_WORK_DRAIN",
  "STALE_STATE_RECONCILIATION",
  "REPORT_DELIVERY_REPAIR",
  "RESTART_DRAIN_WAIT",
  "PROTECTED_ACTION_DENIED",
  "ROLLBACK_UNAVAILABLE",
  "FORBIDDEN_SCOPE",
  "AUTHORITY_CONFLICT",
  "REPAIR_BUDGET_EXHAUSTED",
  "MISSION_EXHAUSTION_PROVEN",
  "COMPLETE_PROVEN",
  "SUPERSEDED_MISSION",
  ...CLEANUP_CREW_OWNER_DECISION_CLASSES,
] as const;

export const CLEANUP_CREW_POLICY_SCHEMA_VERSION =
  "cleanup-crew-governance-final-20260714T1454Z" as const;

function isCleanupCrewOwnerDecisionClass(value: unknown): value is CleanupCrewOwnerDecisionClass {
  return (
    typeof value === "string" &&
    CLEANUP_CREW_OWNER_DECISION_CLASSES.includes(value as CleanupCrewOwnerDecisionClass)
  );
}

function isCleanupCrewExternalDependencyClass(
  value: unknown,
): value is CleanupCrewExternalDependencyClass {
  return (
    typeof value === "string" &&
    CLEANUP_CREW_EXTERNAL_DEPENDENCY_CLASSES.includes(value as CleanupCrewExternalDependencyClass)
  );
}

function isCleanupCrewCanonicalOutcome(value: unknown): value is CleanupCrewCanonicalOutcome {
  return (
    typeof value === "string" &&
    CLEANUP_CREW_CANONICAL_OUTCOMES.includes(value as CleanupCrewCanonicalOutcome)
  );
}

function isCleanupCrewImpactLevel(value: unknown): value is CleanupCrewImpactLevel {
  return (
    typeof value === "string" &&
    CLEANUP_CREW_IMPACT_LEVELS.includes(value as CleanupCrewImpactLevel)
  );
}

function isCleanupCrewGovernanceReasonCode(
  value: unknown,
): value is CleanupCrewGovernanceReasonCode {
  return (
    typeof value === "string" &&
    CLEANUP_CREW_GOVERNANCE_REASON_CODES.includes(value as CleanupCrewGovernanceReasonCode)
  );
}

export type CleanupCrewScopedStopState =
  | "stop_adjacent_phase"
  | "stop_phase_transition"
  | "stop_final_closeout"
  | "continue_cleanup_repair"
  | "hard_stop_whole_mission";

export type CleanupCrewBlockerClassification = {
  category: CleanupCrewBlockerCategory;
  scopedStops: CleanupCrewScopedStopState[];
  status: "in_progress" | "blocked";
  canContinueCleanupRepair: boolean;
  hardStopWholeMission: boolean;
  reason: string;
};

export type CleanupCrewBootstrapB0DecisionInput = {
  missionId: string;
  phase: string;
  owner: string;
  summary?: string;
  blocker?: string;
  rawDbRequired?: boolean;
  emergencySopAuthorized?: boolean;
  unsupportedSurfaceMissing?: boolean;
  lawfulDiscoveryPathAvailable?: boolean;
  proofSourceUnavailable?: boolean;
  alternateProofSourceAvailable?: boolean;
  unsafeOrDestructive?: boolean;
  authorityOrScopeMissing?: boolean;
  nextRepairPathKnown?: boolean;
  evidence?: string[];
  rollbackProofRef: string;
  timestamp?: string;
};

export type AuthoritySourceKind =
  | "root_user_instruction"
  | "active_mission_lock"
  | "active_build_plan"
  | "pass_resume_target"
  | "run_local_verifier_artifact"
  | "phase_closeout_ledger"
  | "historical_closeout"
  | "global_sop"
  | "system_authority";

export type AuthorityConflictType =
  | "no_conflict"
  | "stale_artifact"
  | "plan_supersedes_prior_closeout"
  | "user_instruction_overrides_plan"
  | "sop_safety_blocks_plan"
  | "true_live_authority_conflict"
  | "unresolved_authority_conflict";

export type TechnicalVsProductLane =
  | "technical"
  | "plan_driven"
  | "product_behavior"
  | "ux_flow"
  | "gui_flow"
  | "system_purpose"
  | "true_unknown";

export type PathRiskClass =
  | "LOW_RISK_TECHNICAL"
  | "MEDIUM_RISK_RUNTIME"
  | "HIGH_RISK_BEHAVIOR"
  | "CRITICAL_CONTROL";

export type DiffIntent =
  | "mechanical_format"
  | "test_alignment"
  | "bug_fix_same_behavior"
  | "proof_or_receipt_shape"
  | "routing_or_catalog_recording"
  | "behavior_semantics_change"
  | "new_feature_behavior"
  | "external_side_effect_change"
  | "unknown_intent";

export type GrantRejectionType =
  | "MECHANICAL_CLOSEOUT_FORMAT"
  | "MECHANICAL_PROOF_LINK"
  | "VALIDATION_MISMATCH"
  | "SEMANTIC_SAFETY"
  | "SCOPE_EXPANSION"
  | "UNKNOWN_REVIEW_BLOCKER";

export type CleanupCrewRepairLane =
  | "lane_a_technical_repair"
  | "lane_b_plan_driven_build_work"
  | "lane_c_product_behavior_decision";

export type AuthoritySource = {
  kind: AuthoritySourceKind;
  id: string;
  summary: string;
  active: boolean;
  createdAt?: string;
  proofPath?: string;
  conflictWith?: string[];
  safetyBlock?: boolean;
};

export type AuthorityResolution = {
  winner: AuthoritySourceKind | "none";
  winnerId?: string;
  losing_sources: string[];
  sources_checked: string[];
  conflict_type: AuthorityConflictType;
  reason: string;
  continue_state?: ContinueState;
  stop_state?: StopState;
  proof_path?: string;
};

export type ContinuityGateIssue = {
  summary: string;
  blocker?: string;
  pathRisk: PathRiskClass;
  diffIntent: DiffIntent;
  behaviorImpact?: TechnicalVsProductLane;
  safeTechnicalPathKnown?: boolean;
  safeTechnicalPathDescription?: string;
  scopeWithinMission?: boolean;
  validationAvailable?: boolean;
  rollbackOrProofPreserved?: boolean;
  ownerLevelBlockerAudit?: string;
};

export type EvaluateContinuityGateV2Params = {
  now?: string;
  activeMission: string;
  userInstruction?: string;
  issue: ContinuityGateIssue;
  authoritySources: AuthoritySource[];
  constraints?: BuildContextConstraint[];
};

export type StopReportEnvelope = {
  schema: "openclaw.cleanup_crew_stop_report.v2";
  stop_state: StopState;
  impact: string;
  blast_radius: string;
  plain_text_question: string;
  recommended_option?: string;
  why_this_is_not_technical: string;
  diagnostic_artifact: string;
};

export type ContinuityGateDecision = {
  decisionId: string;
  createdAt: string;
  activeMission: string;
  selectedState: ContinuityGateState;
  shouldContinue: boolean;
  askMark: boolean;
  authorityResolution: AuthorityResolution;
  lane: TechnicalVsProductLane;
  pathRisk: PathRiskClass;
  diffIntent: DiffIntent;
  grantReviewRequired: boolean;
  continueReason: string;
  invalidStopReasonRejected?: string;
  ownerLevelBlockerAudit: string;
  stopReport?: StopReportEnvelope;
  constraints?: BuildContextConstraintStatus[];
};

export type CleanupCrewDecisionRecord = {
  schema: "openclaw.cleanup_crew_decision_record.v2";
  decision_id: string;
  created_at: string;
  active_mission: string;
  selected_state: ContinuityGateState;
  authority_resolution: AuthorityResolution;
  technical_vs_product: {
    lane: TechnicalVsProductLane;
    reason: string;
    path_risk: PathRiskClass;
    diff_intent: DiffIntent;
  };
  scope: {
    files: string[];
    records: string[];
    commands: string[];
  };
  validation_plan: string[];
  grant_review_required: boolean;
  continue_reason: string;
  rollback_or_evidence_path: string;
};

export type CleanupCrewScopeRiskDiffInput = {
  missionId: string;
  phase: string;
  owner: string;
  beforeAuthoritySummary: string;
  proposedAuthoritySummary: string;
  changedSurfaces: string[];
  diffSummary: string;
  evidence: string[];
  rollbackProofRef: string;
  changedMeaning?: boolean;
  scopeWithinMission?: boolean;
  ownerGoalChange?: boolean;
  scopeExpansion?: boolean;
  publicOrUserContractChange?: boolean;
  businessRuleChoice?: boolean;
  riskAcceptanceChange?: boolean;
  destructiveNoRollback?: boolean;
  externalSideEffectRequiresOwnerChoice?: boolean;
  credentialOrPrivilegeDecisionRequired?: boolean;
  unresolvedAuthorityConflict?: boolean;
  safeTechnicalRepairAvailable?: boolean;
  timestamp?: string;
};

export type CleanupCrewScopeRiskDiffEvaluation = {
  schema: "openclaw.cleanup_crew_scope_risk_diff_evaluation.v1";
  evaluation_id: string;
  created_at: string;
  policy_version: typeof CLEANUP_CREW_POLICY_SCHEMA_VERSION;
  mission_id: string;
  phase: string;
  changed_meaning: boolean | null;
  scope_within_mission: boolean | null;
  changed_surfaces: string[];
  classification:
    | "technical_reconciliation"
    | "closed_owner_decision"
    | "authority_conflict"
    | "scope_risk_unclassified";
  owner_decision_class?: CleanupCrewOwnerDecisionClass;
  outcome: CleanupCrewCanonicalOutcome;
  impact: CleanupCrewImpactLevel;
  reason_code: CleanupCrewGovernanceReasonCode;
  next_action: string;
  grant_review_required: boolean;
};

export type CleanupCrewOperationalReconciliationRecord = {
  schema: "openclaw.cleanup_crew_operational_reconciliation_ledger_record.v1";
  record_id: string;
  created_at: string;
  policy_version: typeof CLEANUP_CREW_POLICY_SCHEMA_VERSION;
  mission_id: string;
  phase: string;
  owner: string;
  before_authority_summary: string;
  proposed_authority_summary: string;
  diff_summary: string;
  changed_surfaces: string[];
  evidence: string[];
  rollback_proof_ref: string;
  evaluation: CleanupCrewScopeRiskDiffEvaluation;
  typed_decision_receipt: CleanupCrewTypedDecisionReceipt;
};

export type CleanupCrewContinueReceipt = {
  schema: "openclaw.cleanup_crew_continue_receipt.v2";
  receipt_id: string;
  decision_id: string;
  created_at: string;
  selected_state: ContinueState;
  repair_action: string;
  continue_reason: string;
  proof_path: string;
};

export type CleanupCrewDiagnosticTrace = {
  schema: "openclaw.cleanup_crew_diagnostic_trace.v2";
  trace_id: string;
  decision_id: string;
  created_at: string;
  selected_state: ContinuityGateState;
  files_touched: string[];
  tests: string[];
  owner_level_blocker_audit: string;
  risk_classification: {
    path_risk: PathRiskClass;
    diff_intent: DiffIntent;
  };
  technical_vs_product: {
    lane: TechnicalVsProductLane;
    reason: string;
  };
  scope: {
    surfaces: string[];
    records: string[];
    commands: string[];
  };
  grant_result?: string;
  proof_refs: string[];
  authority_resolution: AuthorityResolution;
  grant_review_required: boolean;
  redaction_status: string;
};

export type GrantRetryDecision = {
  schema: "openclaw.grant_rejection_repair_receipt.v2";
  retry_surface_id: string;
  rejection_type: GrantRejectionType;
  attempt: number;
  maxAttempts: number;
  result: "continue_repair" | "stop_or_true_blocker" | "stop_or_plan_update_required";
  continueState?: ContinueState;
};

export type CleanupCrewStoppageClass =
  | "validation_nonzero_exit"
  | "proof_gap"
  | "external_turn_interruption"
  | "shell_session_aborted"
  | "command_timeout"
  | "subprocess_signal_exit"
  | "subprocess_error_event"
  | "lost_output_tail"
  | "watchdog_needs_review"
  | "watchdog_monitor_disabled"
  | "grant_fail"
  | "dirty_tree_block"
  | "restart_failure"
  | "runtime_proof_failure"
  | "hard_sop_blocker"
  | "user_report_only"
  | "user_explicit_stop";

export type CleanupCrewStoppageReceiptInput = {
  missionId: string;
  taskFlowId?: string;
  packetId?: string;
  stageId?: string;
  commandProcessId?: string;
  commandSpec?: string;
  workingDirectory: string;
  gitHead: string;
  dirtyTreeSummary: string;
  stdoutTail?: string;
  stderrTail?: string;
  proofArtifactPath?: string;
  logPath?: string;
  timestamp?: string;
  stoppageClass: CleanupCrewStoppageClass;
  suspectedAffectedSurface: string;
  nextAnalysisOwner: string;
};

export type CleanupCrewStoppageReceipt = {
  schema: "openclaw.cleanup_crew_stoppage_receipt.v1";
  receipt_id: string;
  created_at: string;
  mission_id: string;
  task_flow_id?: string;
  packet_id?: string;
  stage_id?: string;
  command_process_id?: string;
  command_spec?: string;
  working_directory: string;
  git_state: {
    head: string;
    dirty_tree_summary: string;
  };
  captured_output: {
    stdout_tail: string;
    stderr_tail: string;
    tail_truncated: boolean;
  };
  proof: {
    artifact_path?: string;
    log_path?: string;
  };
  stoppage_class: CleanupCrewStoppageClass;
  suspected_affected_surface: string;
  next_analysis_owner: string;
};

export type CleanupCrewDerivedRepair = {
  schema: "openclaw.cleanup_crew_derived_repair.v1";
  lane: CleanupCrewRepairLane;
  can_execute_autonomously: boolean;
  requires_plan_amendment: boolean;
  requires_mark_decision: boolean;
  path_risk: PathRiskClass;
  diff_intent: DiffIntent;
  reason: string;
  repair_action: string;
  target_surfaces: string[];
  validation_steps: string[];
  proof_artifacts: string[];
  next_executable_command?: string;
  stop_state?: StopState;
};

export type CleanupCrewPlanAmendment = {
  schema: "openclaw.cleanup_crew_plan_amendment.v1";
  amendment_id: string;
  created_at: string;
  active_build_plan_path: string;
  base_plan_hash: string;
  stoppage_id: string;
  lane_classification: CleanupCrewRepairLane;
  diagnosis: string;
  path_risk: PathRiskClass;
  diff_intent: DiffIntent;
  repair_step: string;
  target_surfaces: string[];
  validation_steps: string[];
  proof_artifacts: string[];
  next_executable_command: string;
  stop_conditions: string[];
  rollback_safety_notes: string[];
};

export type CleanupCrewPlanAmendmentWrite = {
  amendment: CleanupCrewPlanAmendment;
  planPath: string;
  basePlanHash: string;
  amendedPlanHash: string;
};

export type CleanupCrewPlanAmendmentInput = {
  activeBuildPlanPath: string;
  expectedPlanHash?: string;
  timestamp?: string;
  stoppageId: string;
  derivedRepair: CleanupCrewDerivedRepair;
  diagnosis: string;
  stopConditions: string[];
  rollbackSafetyNotes: string[];
};

export type CleanupCrewResumeUnitInput = {
  amendmentWrite: CleanupCrewPlanAmendmentWrite;
  workingDirectory: string;
};

export type CleanupCrewRepairExecutionGate =
  | {
      allowed: true;
      amendmentId: string;
      planPath: string;
      planHash: string;
      nextExecutableCommand: string;
    }
  | {
      allowed: false;
      reason:
        | "plan_amendment_required"
        | "lane_c_mark_decision_required"
        | "stale_plan_amendment"
        | "next_executable_missing";
      detail: string;
    };

export type CleanupCrewResumeUnit = {
  schema: "openclaw.cleanup_crew_resume_unit.v1";
  resume_id: string;
  amendment_id: string;
  plan_path: string;
  plan_hash: string;
  command: string;
  cwd: string;
  idempotency_key: string;
  proof_artifacts: string[];
  stop_conditions: string[];
};

export type CleanupCrewResumeGate =
  | {
      allowed: true;
      action: "execute_resume_unit";
      command: string;
      cwd: string;
      idempotencyKey: string;
    }
  | {
      allowed: false;
      action: "do_not_resume" | "record_lawful_stop";
      reason:
        | "report_only"
        | "explicit_stop"
        | "resume_unit_required"
        | "stale_plan"
        | "command_not_in_amended_plan";
      recoveryCommand?: string;
      detail: string;
    };

export type CleanupCrewRecoveryEventType =
  | "stoppage_detected"
  | "proof_gap_written"
  | "analysis_started"
  | "analysis_completed"
  | "lane_classified"
  | "plan_amended"
  | "resume_started"
  | "validation_command_started"
  | "validation_command_completed"
  | "validation_command_interrupted"
  | "watchdog_receipt_ingested"
  | "grant_rejection_handled"
  | "final_response_gate_decision"
  | "blocker_artifact_written";

export type CleanupCrewRecoveryTelemetryEvent = {
  schema: "openclaw.cleanup_crew_recovery_event.v1";
  event_id: string;
  event_type: CleanupCrewRecoveryEventType;
  mission_id: string;
  task_flow_id?: string;
  timestamp: string;
  git_state: {
    head: string;
    dirty_source_detected: boolean;
  };
  active_lane: CleanupCrewRepairLane | "none";
  path_risk_evaluation: PathRiskClass | "not_evaluated";
  grant_retry_count: number;
  from_state: string;
  to_state: string;
  reason_code: string;
  diagnostic_ref: string;
  next_executable_unit: {
    command: string;
    cwd: string;
  };
};

export type CleanupCrewRecoveryTelemetryInput = {
  eventType: CleanupCrewRecoveryEventType;
  missionId: string;
  taskFlowId?: string;
  timestamp?: string;
  gitHead: string;
  dirtySourceDetected: boolean;
  activeLane?: CleanupCrewRecoveryTelemetryEvent["active_lane"];
  pathRiskEvaluation?: CleanupCrewRecoveryTelemetryEvent["path_risk_evaluation"];
  grantRetryCount?: number;
  fromState: string;
  toState: string;
  reasonCode: string;
  diagnosticRef: string;
  nextExecutableCommand: string;
  nextExecutableCwd: string;
};

export type CleanupCrewMissionAbortContinuationClass =
  | "repair"
  | "retry"
  | "proof_production"
  | "internal_owner_routing"
  | "alternate_executor"
  | "quarantine"
  | "rollback"
  | "compensation"
  | "safe_parallel_work"
  | "durable_wait"
  | "external_dependency"
  | "action_block"
  | "phase_block"
  | "completion";

export type CleanupCrewMissionAbortExhaustionEntry = {
  class: CleanupCrewMissionAbortContinuationClass;
  status: "unavailable" | "inapplicable";
  evidence: string;
};

export type CleanupCrewMissionAbortExhaustionReceipt = {
  schema: "openclaw.cleanup_crew_mission_abort_exhaustion_receipt.v1";
  receipt_id: string;
  created_at: string;
  mission_id: string;
  policy_version: typeof CLEANUP_CREW_POLICY_SCHEMA_VERSION;
  entries: CleanupCrewMissionAbortExhaustionEntry[];
};

export type CleanupCrewRepairAttemptResult =
  | "progress"
  | "no_progress"
  | "proof_produced"
  | "malformed_evidence"
  | "rollback_required"
  | "unsafe_mutation_denied";

export type CleanupCrewRepairAttemptReceipt = {
  schema: "openclaw.cleanup_crew_repair_attempt_receipt.v1";
  receipt_id: string;
  created_at: string;
  mission_id: string;
  reason_code: string;
  attempt_identity: string;
  attempt_number: number;
  input_ref: string;
  action: string;
  evidence: string[];
  result: CleanupCrewRepairAttemptResult;
  delta_summary: string;
  rollback_required: boolean;
  rollback_available: boolean;
};

export type CleanupCrewRepairLoopDecision = {
  schema: "openclaw.cleanup_crew_repair_loop_decision.v1";
  decision_id: string;
  mission_id: string;
  reason_code: string;
  attempt_count: number;
  identical_no_progress_count: number;
  retry_budget: number;
  outcome:
    | "continue_repair"
    | "quarantine_and_investigate_alternate"
    | "phase_blocked_budget_exhausted"
    | "action_blocked_rollback_required"
    | "action_blocked_malformed_evidence";
  mission_remains_active: boolean;
  safe_parallel_work_continues: boolean;
  quarantine_required: boolean;
  alternate_path_required: boolean;
  next_action: string;
  evidence: string[];
};

export type CleanupCrewDurableWaitKind =
  | "drain"
  | "external_dependency"
  | "lost_session"
  | "report_delivery"
  | "child_session"
  | "restart";

export type CleanupCrewResumeProbeKind =
  | "source_turn_drain"
  | "report_delivery"
  | "child_session"
  | "external_dependency"
  | "restart_activation";

export type CleanupCrewDurableWaitRecord = {
  schema: "openclaw.cleanup_crew_durable_wait_record.v1";
  wait_id: string;
  created_at: string;
  mission_id: string;
  wait_kind: CleanupCrewDurableWaitKind;
  reason_code: CleanupCrewGovernanceReasonCode;
  owner: string;
  evidence: string[];
  timeout_at: string;
  resume_probe: {
    kind: CleanupCrewResumeProbeKind;
    target: string;
    condition: string;
    next_probe_at: string;
  };
  continuation_receipt_required: boolean;
  mission_remains_open: boolean;
};

export type CleanupCrewDurableWaitResolution = {
  schema: "openclaw.cleanup_crew_durable_wait_resolution.v1";
  wait_id: string;
  mission_id: string;
  outcome:
    | "wait_valid"
    | "resume_probe_due"
    | "wait_expired_probe_required"
    | "invalid_wait_record";
  canonical_outcome: CleanupCrewCanonicalOutcome;
  mission_remains_open: boolean;
  pending_report_delivery_can_close_mission: boolean;
  next_action: string;
  validation_errors: string[];
};

export type CleanupCrewNonterminalContinuationDecision = {
  schema: "openclaw.cleanup_crew_nonterminal_continuation_decision.v1";
  decision_id: string;
  mission_id: string;
  allowed_to_emit_nonterminal_response: boolean;
  allowed_to_close_parent_mission: boolean;
  required_durable_wait: boolean;
  next_action: string;
  validation_errors: string[];
};

export type CleanupCrewExecutorCapability =
  | "repo_read"
  | "repo_write"
  | "runtime_restart"
  | "watchdog_repair"
  | "taskflow_reconciliation"
  | "grant_review"
  | "report_delivery"
  | "production_dispatch";

export type CleanupCrewExecutorCapabilityRecord = {
  schema: "openclaw.cleanup_crew_executor_capability_record.v1";
  executor_id: string;
  role: "Will" | "Grant" | "Coding Agent" | "TaskFlow" | "Watchdog" | "SADB";
  session_key?: string;
  task_id?: string;
  run_id?: string;
  lease_revision?: number;
  available: boolean;
  stale: boolean;
  permitted: CleanupCrewExecutorCapability[];
  prohibited: CleanupCrewExecutorCapability[];
  receipt_requirements: string[];
};

export type CleanupCrewCapabilityRouteDecision = {
  schema: "openclaw.cleanup_crew_capability_route_decision.v1";
  decision_id: string;
  mission_id: string;
  required_capability: CleanupCrewExecutorCapability;
  outcome:
    | "route_to_available_executor"
    | "capability_mismatch_blocked"
    | "reviewer_unavailable_wait"
    | "stale_identity_reconciliation_required"
    | "identity_missing_blocked";
  selected_executor_id?: string;
  canonical_outcome: CleanupCrewCanonicalOutcome;
  reason_code: CleanupCrewGovernanceReasonCode;
  next_action: string;
  duplicate_spawn_allowed: boolean;
  evidence: string[];
};

export type CleanupCrewRestartDrainRegistration = {
  schema: "openclaw.cleanup_crew_restart_drain_registration.v1";
  registration_id: string;
  created_at: string;
  mission_id: string;
  owner: string;
  restart_target: string;
  drain_reason: string;
  active_work_ref: string;
  timeout_at: string;
  post_restart_proof_required: string[];
};

export type CleanupCrewRestartContinuationDecision = {
  schema: "openclaw.cleanup_crew_restart_continuation_decision.v1";
  decision_id: string;
  mission_id: string;
  outcome:
    | "restart_registered_defer_until_drain"
    | "restart_missing_registration_blocked"
    | "post_restart_proof_missing_blocked"
    | "post_restart_proof_passed_continue";
  canonical_outcome: CleanupCrewCanonicalOutcome;
  reason_code: CleanupCrewGovernanceReasonCode;
  mission_remains_open: boolean;
  allowed_to_close: boolean;
  next_action: string;
  evidence: string[];
};

export type CleanupCrewTypedDecisionInput = {
  schema: "openclaw.cleanup_crew_typed_decision_input.v1";
  policyVersion: typeof CLEANUP_CREW_POLICY_SCHEMA_VERSION;
  phase: string;
  missionId: string;
  inputSummary: string;
  proposedOutcome: unknown;
  proposedImpact: unknown;
  proposedReasonCode: unknown;
  owner: string;
  nextAction: string;
  evidence: string[];
  rollback: {
    available: boolean;
    proofRef: string;
  };
  reportEffect: string;
  missionAbortExhaustion?: CleanupCrewMissionAbortExhaustionReceipt;
};

export type CleanupCrewTypedDecisionReceipt = {
  schema: "openclaw.cleanup_crew_typed_decision_receipt.v1";
  receipt_id: string;
  created_at: string;
  policy_version: typeof CLEANUP_CREW_POLICY_SCHEMA_VERSION;
  input_hash: string;
  phase: string;
  mission_id: string;
  outcome: CleanupCrewCanonicalOutcome;
  impact: CleanupCrewImpactLevel;
  reason_code: CleanupCrewGovernanceReasonCode;
  owner: string;
  next_action: string;
  evidence: string[];
  rollback: {
    available: boolean;
    proof_ref: string;
  };
  report_effect: string;
  validation: {
    ok: boolean;
    errors: string[];
  };
};

export type CleanupCrewLevelState =
  | "open"
  | "blocked"
  | "waiting_external_dependency"
  | "waiting_owner_decision"
  | "aborted"
  | "complete";

export type CleanupCrewLevelStateResolution = {
  schema: "openclaw.cleanup_crew_level_state_resolution.v1";
  receipt_id: string;
  policy_version: typeof CLEANUP_CREW_POLICY_SCHEMA_VERSION;
  outcome: CleanupCrewCanonicalOutcome;
  impact: CleanupCrewImpactLevel;
  reason_code: CleanupCrewGovernanceReasonCode;
  action_state: CleanupCrewLevelState;
  phase_state: CleanupCrewLevelState;
  mission_state: CleanupCrewLevelState;
  stop_levels: CleanupCrewImpactLevel[];
  resume_behavior: string;
  safe_parallel_work_continues: boolean;
};

export type CleanupCrewTelemetryCloseoutGate =
  | { allowed: true; presentEventTypes: CleanupCrewRecoveryEventType[] }
  | {
      allowed: false;
      reason: "missing_required_telemetry";
      missingEventTypes: CleanupCrewRecoveryEventType[];
    };

export type CleanupCrewDerivedRepairInput = {
  issue: ContinuityGateIssue;
  repairAction: string;
  targetSurfaces?: string[];
  validationSteps?: string[];
  proofArtifacts?: string[];
  nextExecutableCommand?: string;
  activeBuildPlanAuthorizesWork?: boolean;
};

export type CleanupCrewDurableArtifactKind =
  | "decision_record"
  | "continue_receipt"
  | "stop_report"
  | "diagnostic_trace"
  | "stoppage_receipt"
  | "telemetry_event";

export type CleanupCrewDurableArtifactWrite = {
  kind: CleanupCrewDurableArtifactKind;
  path: string;
};

export type WriteCleanupCrewDurableArtifactsParams = {
  outputDir: string;
  decisionRecord?: CleanupCrewDecisionRecord;
  continueReceipt?: CleanupCrewContinueReceipt;
  stopReport?: StopReportEnvelope;
  diagnosticTrace?: CleanupCrewDiagnosticTrace;
  stoppageReceipt?: CleanupCrewStoppageReceipt;
  telemetryEvents?: CleanupCrewRecoveryTelemetryEvent[];
};

export type BuildContextConstraint = {
  schema: "openclaw.build_context_constraint.v2";
  constraint_id: string;
  label: string;
  source_artifact: string;
  created_at: string;
  expires_at: string | null;
  max_major_phase_count: number;
  refresh_probe: string;
  on_expiry: "REFRESH_THEN_RECLASSIFY";
  status: "active" | "expired" | "refreshed" | "retired";
};

export type BuildContextConstraintStatus = {
  constraintId: string;
  status: BuildContextConstraint["status"];
  action: "KEEP_ACTIVE" | "REFRESH_THEN_RECLASSIFY" | "IGNORE_RETIRED";
  selectedState: ContinueState;
  reason: string;
};

const AUTHORITY_PRIORITY: Record<AuthoritySourceKind, number> = {
  root_user_instruction: 0,
  active_mission_lock: 1,
  active_build_plan: 2,
  pass_resume_target: 2,
  run_local_verifier_artifact: 3,
  phase_closeout_ledger: 3,
  historical_closeout: 4,
  global_sop: 5,
  system_authority: 5,
};

const INVALID_FINAL_STOP_REASONS = new Map<string, ContinueState>([
  ["grant rejected", "CONTINUE_AFTER_REPAIRABLE_GRANT_REJECTION"],
  ["test failed", "CONTINUE_AFTER_BUILD_OR_TEST_REPAIR"],
  ["build failed", "CONTINUE_AFTER_BUILD_OR_TEST_REPAIR"],
  ["repo sync needed", "CONTINUE_AFTER_REPO_HYGIENE_REPAIR"],
  ["proof missing", "CONTINUE_TECHNICAL_REPAIR"],
  ["authority file needs update", "CONTINUE_AFTER_AUTHORITY_CONFLICT_DIAGNOSIS"],
  ["pending reply exists", "CONTINUE_PLAN_NEXT_STEP"],
  ["restart deferred", "CONTINUE_AFTER_RUNTIME_PROOF_REPAIR"],
  ["artifact missing", "CONTINUE_TECHNICAL_REPAIR"],
  ["dirty tree", "CONTINUE_AFTER_REPO_HYGIENE_REPAIR"],
  ["tooling gap", "CONTINUE_TECHNICAL_REPAIR"],
]);

const GRANT_RETRY_CEILINGS: Record<GrantRejectionType, number> = {
  MECHANICAL_CLOSEOUT_FORMAT: 3,
  MECHANICAL_PROOF_LINK: 3,
  VALIDATION_MISMATCH: 2,
  SEMANTIC_SAFETY: 1,
  SCOPE_EXPANSION: 0,
  UNKNOWN_REVIEW_BLOCKER: 1,
};

const STOPPAGE_RECEIPT_TAIL_MAX_CHARS = 4_000;

export const CLEANUP_CREW_MISSION_ABORT_CONTINUATION_CLASSES: readonly CleanupCrewMissionAbortContinuationClass[] =
  [
    "repair",
    "retry",
    "proof_production",
    "internal_owner_routing",
    "alternate_executor",
    "quarantine",
    "rollback",
    "compensation",
    "safe_parallel_work",
    "durable_wait",
    "external_dependency",
    "action_block",
    "phase_block",
    "completion",
  ] as const;

function deterministicId(prefix: string, parts: unknown[]): string {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function classifyCleanupCrewGovernanceTaxonomy(
  input: CleanupCrewGovernanceTaxonomyInput,
): CleanupCrewGovernanceTaxonomyDecision {
  const ownerDecisionClass = isCleanupCrewOwnerDecisionClass(input.ownerDecisionClass)
    ? input.ownerDecisionClass
    : undefined;
  const externalDependencyClass = isCleanupCrewExternalDependencyClass(
    input.externalDependencyClass,
  )
    ? input.externalDependencyClass
    : undefined;

  if (
    input.malformedOrUnknownInput ||
    (input.ownerDecisionClass && !ownerDecisionClass) ||
    (input.externalDependencyClass && !externalDependencyClass)
  ) {
    return {
      outcome: "ACTION_BLOCKED",
      reasonCode: "MALFORMED_POLICY_INPUT",
      ownerApprovalRequired: false,
      nextAction: "diagnose_policy_input_and_rerun_classifier",
      classification: "malformed_input_not_owner_decision",
    };
  }

  if (input.ownerChoiceRequired && ownerDecisionClass) {
    return {
      outcome: "OWNER_DECISION_REQUIRED",
      reasonCode: ownerDecisionClass,
      ownerApprovalRequired: true,
      ownerDecisionClass,
      ...(externalDependencyClass ? { externalDependencyClass } : {}),
      nextAction: "record_owner_decision_before_dependency_wait",
      classification: "closed_owner_decision_first",
    };
  }

  if (input.ownerChoiceRequired && !input.ownerDecisionClass) {
    return {
      outcome: "ACTION_BLOCKED",
      reasonCode: "SCOPE_RISK_UNCLASSIFIED",
      ownerApprovalRequired: false,
      ...(externalDependencyClass ? { externalDependencyClass } : {}),
      nextAction: "classify_closed_owner_decision_or_internal_repair_path",
      classification: "owner_route_rejected_without_closed_class",
    };
  }

  if (externalDependencyClass) {
    return {
      outcome: "EXTERNAL_DEPENDENCY",
      reasonCode: externalDependencyClass,
      ownerApprovalRequired: false,
      externalDependencyClass,
      nextAction: "record_dependency_wait_until_capability_arrives",
      classification: input.ownerChoiceAlreadyMade
        ? "owner_choice_already_made_dependency_wait"
        : "dependency_wait_no_owner_choice_required",
    };
  }

  if (input.technicalPersistenceOrIdentityDefect || input.safeTechnicalOptionsAvailable) {
    return {
      outcome: "REPAIR_AND_CONTINUE",
      reasonCode: "TECHNICAL_REPAIR",
      ownerApprovalRequired: false,
      nextAction: "execute_authorized_technical_repair_path",
      classification: "technical_repair_not_owner_decision",
    };
  }

  return {
    outcome: "ACTION_BLOCKED",
    reasonCode: "SCOPE_RISK_UNCLASSIFIED",
    ownerApprovalRequired: false,
    nextAction: "gather_evidence_and_classify_decision_or_dependency",
    classification: "insufficient_evidence_not_owner_decision",
  };
}

function firstClosedOwnerDecisionClass(
  input: CleanupCrewScopeRiskDiffInput,
): CleanupCrewOwnerDecisionClass | undefined {
  if (input.ownerGoalChange) {
    return "OWNER_GOAL_CHANGE";
  }
  if (input.scopeExpansion) {
    return "SCOPE_EXPANSION";
  }
  if (input.publicOrUserContractChange) {
    return "PUBLIC_OR_USER_CONTRACT_CHANGE";
  }
  if (input.businessRuleChoice) {
    return "BUSINESS_RULE_CHOICE";
  }
  if (input.riskAcceptanceChange) {
    return "RISK_ACCEPTANCE_CHANGE";
  }
  if (input.destructiveNoRollback) {
    return "DESTRUCTIVE_NO_ROLLBACK";
  }
  if (input.externalSideEffectRequiresOwnerChoice) {
    return "EXTERNAL_SIDE_EFFECT_REQUIRES_OWNER_CHOICE";
  }
  if (input.credentialOrPrivilegeDecisionRequired) {
    return "CREDENTIAL_OR_PRIVILEGE_DECISION_REQUIRED";
  }
  if (input.unresolvedAuthorityConflict) {
    return "UNRESOLVED_AUTHORITY_CONFLICT";
  }
  return undefined;
}

export function evaluateCleanupCrewScopeRiskDiff(
  input: CleanupCrewScopeRiskDiffInput,
): CleanupCrewScopeRiskDiffEvaluation {
  const createdAt = optionalText(input.timestamp) ?? new Date().toISOString();
  const missionId = requiredText(input.missionId, "missionId");
  const phase = requiredText(input.phase, "phase");
  requiredText(input.owner, "owner");
  requiredText(input.beforeAuthoritySummary, "beforeAuthoritySummary");
  requiredText(input.proposedAuthoritySummary, "proposedAuthoritySummary");
  requiredText(input.diffSummary, "diffSummary");
  requiredText(input.rollbackProofRef, "rollbackProofRef");
  const changedSurfaces = input.changedSurfaces.map((surface) =>
    requiredText(surface, "changedSurfaces[]"),
  );
  const closedOwnerClass = firstClosedOwnerDecisionClass(input);
  const changedMeaning = typeof input.changedMeaning === "boolean" ? input.changedMeaning : null;
  const scopeWithinMission =
    typeof input.scopeWithinMission === "boolean" ? input.scopeWithinMission : null;

  let classification: CleanupCrewScopeRiskDiffEvaluation["classification"] =
    "scope_risk_unclassified";
  let outcome: CleanupCrewCanonicalOutcome = "ACTION_BLOCKED";
  let impact: CleanupCrewImpactLevel = "ACTION";
  let reasonCode: CleanupCrewGovernanceReasonCode = "SCOPE_RISK_UNCLASSIFIED";
  let nextAction = "classify_scope_risk_diff_with_evidence_and_grant_review";
  let grantReviewRequired = true;

  if (closedOwnerClass) {
    classification =
      closedOwnerClass === "UNRESOLVED_AUTHORITY_CONFLICT"
        ? "authority_conflict"
        : "closed_owner_decision";
    outcome =
      closedOwnerClass === "UNRESOLVED_AUTHORITY_CONFLICT"
        ? "ACTION_BLOCKED"
        : "OWNER_DECISION_REQUIRED";
    impact =
      closedOwnerClass === "OWNER_GOAL_CHANGE" ||
      closedOwnerClass === "PUBLIC_OR_USER_CONTRACT_CHANGE" ||
      closedOwnerClass === "UNRESOLVED_AUTHORITY_CONFLICT"
        ? "MISSION"
        : "PHASE";
    reasonCode =
      closedOwnerClass === "UNRESOLVED_AUTHORITY_CONFLICT"
        ? "AUTHORITY_CONFLICT"
        : closedOwnerClass;
    nextAction =
      closedOwnerClass === "UNRESOLVED_AUTHORITY_CONFLICT"
        ? "diagnose_authority_conflict_before_plan_amendment"
        : "record_closed_owner_decision_before_plan_amendment";
    grantReviewRequired = true;
  } else if (
    input.safeTechnicalRepairAvailable === true &&
    changedMeaning === false &&
    scopeWithinMission === true
  ) {
    classification = "technical_reconciliation";
    outcome = "REPAIR_AND_CONTINUE";
    impact = "ACTION";
    reasonCode = "TECHNICAL_REPAIR";
    nextAction = "record_operational_reconciliation_and_continue";
    grantReviewRequired = false;
  }

  return {
    schema: "openclaw.cleanup_crew_scope_risk_diff_evaluation.v1",
    evaluation_id: deterministicId("scope_risk_diff", [
      missionId,
      phase,
      createdAt,
      input.beforeAuthoritySummary,
      input.proposedAuthoritySummary,
      changedSurfaces,
      input.diffSummary,
    ]),
    created_at: createdAt,
    policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
    mission_id: missionId,
    phase,
    changed_meaning: changedMeaning,
    scope_within_mission: scopeWithinMission,
    changed_surfaces: changedSurfaces,
    classification,
    ...(closedOwnerClass && classification === "closed_owner_decision"
      ? { owner_decision_class: closedOwnerClass }
      : {}),
    outcome,
    impact,
    reason_code: reasonCode,
    next_action: nextAction,
    grant_review_required: grantReviewRequired,
  };
}

export function createCleanupCrewOperationalReconciliationRecord(
  input: CleanupCrewScopeRiskDiffInput,
): CleanupCrewOperationalReconciliationRecord {
  const createdAt = optionalText(input.timestamp) ?? new Date().toISOString();
  const missionId = requiredText(input.missionId, "missionId");
  const phase = requiredText(input.phase, "phase");
  const owner = requiredText(input.owner, "owner");
  const beforeAuthoritySummary = requiredText(
    input.beforeAuthoritySummary,
    "beforeAuthoritySummary",
  );
  const proposedAuthoritySummary = requiredText(
    input.proposedAuthoritySummary,
    "proposedAuthoritySummary",
  );
  const diffSummary = requiredText(input.diffSummary, "diffSummary");
  const changedSurfaces = input.changedSurfaces.map((surface) =>
    requiredText(surface, "changedSurfaces[]"),
  );
  const evidence = input.evidence.map((entry) => requiredText(entry, "evidence[]"));
  const rollbackProofRef = requiredText(input.rollbackProofRef, "rollbackProofRef");
  const evaluation = evaluateCleanupCrewScopeRiskDiff({ ...input, timestamp: createdAt });
  const typedDecisionReceipt = createCleanupCrewTypedDecisionReceipt(
    {
      schema: "openclaw.cleanup_crew_typed_decision_input.v1",
      policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
      phase,
      missionId,
      inputSummary: `${beforeAuthoritySummary}\n${proposedAuthoritySummary}\n${diffSummary}`,
      proposedOutcome: evaluation.outcome,
      proposedImpact: evaluation.impact,
      proposedReasonCode: evaluation.reason_code,
      owner,
      nextAction: evaluation.next_action,
      evidence: evidence.length > 0 ? evidence : changedSurfaces,
      rollback: {
        available: true,
        proofRef: rollbackProofRef,
      },
      reportEffect: evaluation.classification,
    },
    { timestamp: createdAt },
  );

  return {
    schema: "openclaw.cleanup_crew_operational_reconciliation_ledger_record.v1",
    record_id: deterministicId("operational_reconciliation", [
      missionId,
      phase,
      createdAt,
      beforeAuthoritySummary,
      proposedAuthoritySummary,
      diffSummary,
      changedSurfaces,
      evidence,
    ]),
    created_at: createdAt,
    policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
    mission_id: missionId,
    phase,
    owner,
    before_authority_summary: beforeAuthoritySummary,
    proposed_authority_summary: proposedAuthoritySummary,
    diff_summary: diffSummary,
    changed_surfaces: changedSurfaces,
    evidence,
    rollback_proof_ref: rollbackProofRef,
    evaluation,
    typed_decision_receipt: typedDecisionReceipt,
  };
}

function requiredText(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function requiredRawText(value: string, fieldName: string): string {
  if (!value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function truncateTail(value: string | undefined): { text: string; truncated: boolean } {
  const text = value ?? "";
  if (text.length <= STOPPAGE_RECEIPT_TAIL_MAX_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(text.length - STOPPAGE_RECEIPT_TAIL_MAX_CHARS),
    truncated: true,
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashCleanupCrewTypedDecisionInput(input: CleanupCrewTypedDecisionInput): string {
  return sha256Text(canonicalJson(input));
}

export function createCleanupCrewMissionAbortExhaustionReceipt(params: {
  missionId: string;
  entries: CleanupCrewMissionAbortExhaustionEntry[];
  timestamp?: string;
}): CleanupCrewMissionAbortExhaustionReceipt {
  const createdAt = optionalText(params.timestamp) ?? new Date().toISOString();
  const missionId = requiredText(params.missionId, "missionId");
  const entries = params.entries.map((entry) => ({
    class: entry.class,
    status: entry.status,
    evidence: requiredText(entry.evidence, "missionAbortExhaustion.entries[].evidence"),
  }));
  return {
    schema: "openclaw.cleanup_crew_mission_abort_exhaustion_receipt.v1",
    receipt_id: deterministicId("mission_abort_exhaustion", [missionId, createdAt, entries]),
    created_at: createdAt,
    mission_id: missionId,
    policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
    entries,
  };
}

export function validateCleanupCrewMissionAbortExhaustionReceipt(
  value: unknown,
  params: { missionId?: string } = {},
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const receipt = value as Partial<CleanupCrewMissionAbortExhaustionReceipt> | undefined;
  if (!receipt || typeof receipt !== "object") {
    return { ok: false, errors: ["mission_abort_exhaustion_receipt_missing"] };
  }
  if (receipt.schema !== "openclaw.cleanup_crew_mission_abort_exhaustion_receipt.v1") {
    errors.push("mission_abort_exhaustion_schema_invalid");
  }
  if (!optionalText(receipt.receipt_id)) {
    errors.push("mission_abort_exhaustion_receipt_id_missing");
  }
  if (!optionalText(receipt.created_at)) {
    errors.push("mission_abort_exhaustion_created_at_missing");
  }
  const missionId = optionalText(receipt.mission_id);
  if (!missionId) {
    errors.push("mission_abort_exhaustion_mission_id_missing");
  }
  const expectedMissionId = optionalText(params.missionId);
  if (missionId && expectedMissionId && missionId !== expectedMissionId) {
    errors.push("mission_abort_exhaustion_mission_id_mismatch");
  }
  if (receipt.policy_version !== CLEANUP_CREW_POLICY_SCHEMA_VERSION) {
    errors.push("mission_abort_exhaustion_policy_version_invalid");
  }
  if (!Array.isArray(receipt.entries)) {
    errors.push("mission_abort_exhaustion_entries_missing");
    return { ok: false, errors };
  }
  const byClass = new Map<
    CleanupCrewMissionAbortContinuationClass,
    CleanupCrewMissionAbortExhaustionEntry
  >();
  for (const entry of receipt.entries) {
    if (!CLEANUP_CREW_MISSION_ABORT_CONTINUATION_CLASSES.includes(entry.class)) {
      errors.push(`mission_abort_exhaustion_unknown_class:${String(entry.class)}`);
      continue;
    }
    if (entry.status !== "unavailable" && entry.status !== "inapplicable") {
      errors.push(`mission_abort_exhaustion_status_invalid:${entry.class}`);
    }
    if (!optionalText(entry.evidence)) {
      errors.push(`mission_abort_exhaustion_evidence_missing:${entry.class}`);
    }
    if (byClass.has(entry.class)) {
      errors.push(`mission_abort_exhaustion_duplicate_class:${entry.class}`);
    }
    byClass.set(entry.class, entry);
  }
  for (const requiredClass of CLEANUP_CREW_MISSION_ABORT_CONTINUATION_CLASSES) {
    if (!byClass.has(requiredClass)) {
      errors.push(`mission_abort_exhaustion_class_missing:${requiredClass}`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function createCleanupCrewTypedDecisionReceipt(
  input: CleanupCrewTypedDecisionInput,
  params: { timestamp?: string } = {},
): CleanupCrewTypedDecisionReceipt {
  const createdAt = optionalText(params.timestamp) ?? new Date().toISOString();
  const errors: string[] = [];
  const inputHash = hashCleanupCrewTypedDecisionInput(input);
  const outcome = isCleanupCrewCanonicalOutcome(input.proposedOutcome)
    ? input.proposedOutcome
    : undefined;
  const impact = isCleanupCrewImpactLevel(input.proposedImpact) ? input.proposedImpact : undefined;
  const reasonCode = isCleanupCrewGovernanceReasonCode(input.proposedReasonCode)
    ? input.proposedReasonCode
    : undefined;

  if (input.schema !== "openclaw.cleanup_crew_typed_decision_input.v1") {
    errors.push("typed_decision_input_schema_invalid");
  }
  if (input.policyVersion !== CLEANUP_CREW_POLICY_SCHEMA_VERSION) {
    errors.push("typed_decision_policy_version_invalid");
  }
  if (!outcome) {
    errors.push("typed_decision_outcome_invalid");
  }
  if (!impact) {
    errors.push("typed_decision_impact_invalid");
  }
  if (!reasonCode) {
    errors.push("typed_decision_reason_code_invalid");
  }
  if (!optionalText(input.phase)) {
    errors.push("typed_decision_phase_missing");
  }
  if (!optionalText(input.missionId)) {
    errors.push("typed_decision_mission_id_missing");
  }
  if (!optionalText(input.owner)) {
    errors.push("typed_decision_owner_missing");
  }
  if (!optionalText(input.nextAction)) {
    errors.push("typed_decision_next_action_missing");
  }
  if (!Array.isArray(input.evidence) || input.evidence.some((entry) => !optionalText(entry))) {
    errors.push("typed_decision_evidence_invalid");
  }
  if (!input.rollback || !optionalText(input.rollback.proofRef)) {
    errors.push("typed_decision_rollback_proof_missing");
  }
  if (!optionalText(input.reportEffect)) {
    errors.push("typed_decision_report_effect_missing");
  }
  if (outcome === "MISSION_ABORTED") {
    const exhaustionValidation = validateCleanupCrewMissionAbortExhaustionReceipt(
      input.missionAbortExhaustion,
      { missionId: input.missionId },
    );
    if (!exhaustionValidation.ok) {
      errors.push(...exhaustionValidation.errors);
    }
    if (reasonCode && reasonCode !== "MISSION_EXHAUSTION_PROVEN") {
      errors.push("mission_abort_reason_code_must_be_mission_exhaustion_proven");
    }
    if (impact && impact !== "MISSION") {
      errors.push("mission_abort_impact_must_be_mission");
    }
  }

  const valid = errors.length === 0;
  return {
    schema: "openclaw.cleanup_crew_typed_decision_receipt.v1",
    receipt_id: deterministicId("typed_decision_receipt", [inputHash, createdAt]),
    created_at: createdAt,
    policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
    input_hash: inputHash,
    phase: optionalText(input.phase) ?? "unknown",
    mission_id: optionalText(input.missionId) ?? "unknown",
    outcome: valid ? outcome! : "ACTION_BLOCKED",
    impact: valid ? impact! : "ACTION",
    reason_code: valid ? reasonCode! : "MALFORMED_POLICY_INPUT",
    owner: optionalText(input.owner) ?? "Will",
    next_action: valid
      ? requiredText(input.nextAction, "nextAction")
      : "diagnose_policy_input_and_rerun_classifier",
    evidence: valid ? input.evidence.map((entry) => requiredText(entry, "evidence[]")) : [],
    rollback: {
      available: input.rollback?.available === true,
      proof_ref: optionalText(input.rollback?.proofRef) ?? "missing_rollback_proof",
    },
    report_effect: valid ? requiredText(input.reportEffect, "reportEffect") : "action_blocked",
    validation: {
      ok: valid,
      errors,
    },
  };
}

function impactIncludesLevel(
  impact: CleanupCrewImpactLevel,
  level: CleanupCrewImpactLevel,
): boolean {
  if (impact === "MISSION") {
    return true;
  }
  if (impact === "PHASE") {
    return level === "ACTION" || level === "PHASE";
  }
  return level === "ACTION";
}

function blockedLevelsForImpact(impact: CleanupCrewImpactLevel): CleanupCrewImpactLevel[] {
  if (impact === "MISSION") {
    return ["ACTION", "PHASE", "MISSION"];
  }
  if (impact === "PHASE") {
    return ["ACTION", "PHASE"];
  }
  return ["ACTION"];
}

export function resolveCleanupCrewLevelState(
  receipt: CleanupCrewTypedDecisionReceipt,
): CleanupCrewLevelStateResolution {
  let actionState: CleanupCrewLevelState = "open";
  let phaseState: CleanupCrewLevelState = "open";
  let missionState: CleanupCrewLevelState = "open";
  let stopLevels: CleanupCrewImpactLevel[] = [];
  let resumeBehavior = receipt.next_action;
  let safeParallelWorkContinues = true;

  if (!receipt.validation.ok) {
    actionState = "blocked";
    stopLevels = ["ACTION"];
    resumeBehavior = "diagnose_policy_input_and_rerun_classifier";
  } else if (
    receipt.outcome === "CONTINUE" ||
    receipt.outcome === "REPAIR_AND_CONTINUE" ||
    receipt.outcome === "RETRY" ||
    receipt.outcome === "DEFER_UNTIL_DRAIN"
  ) {
    resumeBehavior = receipt.next_action;
  } else if (receipt.outcome === "COMPLETE") {
    actionState = "complete";
    phaseState = receipt.impact === "ACTION" ? "open" : "complete";
    missionState = receipt.impact === "MISSION" ? "complete" : "open";
    safeParallelWorkContinues = receipt.impact !== "MISSION";
  } else if (receipt.outcome === "MISSION_ABORTED") {
    actionState = "aborted";
    phaseState = "aborted";
    missionState = "aborted";
    stopLevels = ["ACTION", "PHASE", "MISSION"];
    safeParallelWorkContinues = false;
  } else {
    const blockedState: CleanupCrewLevelState =
      receipt.outcome === "EXTERNAL_DEPENDENCY"
        ? "waiting_external_dependency"
        : receipt.outcome === "OWNER_DECISION_REQUIRED"
          ? "waiting_owner_decision"
          : "blocked";
    stopLevels = blockedLevelsForImpact(receipt.impact);
    if (impactIncludesLevel(receipt.impact, "ACTION")) {
      actionState = blockedState;
    }
    if (impactIncludesLevel(receipt.impact, "PHASE")) {
      phaseState = blockedState;
    }
    if (impactIncludesLevel(receipt.impact, "MISSION")) {
      missionState = blockedState;
    }
    safeParallelWorkContinues = receipt.impact !== "MISSION";
  }

  return {
    schema: "openclaw.cleanup_crew_level_state_resolution.v1",
    receipt_id: receipt.receipt_id,
    policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
    outcome: receipt.outcome,
    impact: receipt.impact,
    reason_code: receipt.reason_code,
    action_state: actionState,
    phase_state: phaseState,
    mission_state: missionState,
    stop_levels: stopLevels,
    resume_behavior: resumeBehavior,
    safe_parallel_work_continues: safeParallelWorkContinues,
  };
}

function textIncludesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function uniqueScopedStops(stops: CleanupCrewScopedStopState[]): CleanupCrewScopedStopState[] {
  return [...new Set(stops)];
}

function cleanupClassification(params: {
  category: CleanupCrewBlockerCategory;
  scopedStops: CleanupCrewScopedStopState[];
  reason: string;
}): CleanupCrewBlockerClassification {
  const scopedStops = uniqueScopedStops(params.scopedStops);
  const hardStopWholeMission = scopedStops.includes("hard_stop_whole_mission");
  const canContinueCleanupRepair =
    scopedStops.includes("continue_cleanup_repair") && !hardStopWholeMission;
  return {
    category: params.category,
    scopedStops,
    status: hardStopWholeMission ? "blocked" : "in_progress",
    canContinueCleanupRepair,
    hardStopWholeMission,
    reason: params.reason,
  };
}

export function classifyCleanupCrewBlocker(params: {
  summary?: string;
  blocker?: string;
  rawDbRequired?: boolean;
  emergencySopAuthorized?: boolean;
  unsupportedSurfaceMissing?: boolean;
  lawfulDiscoveryPathAvailable?: boolean;
  proofSourceUnavailable?: boolean;
  alternateProofSourceAvailable?: boolean;
  unsafeOrDestructive?: boolean;
  authorityOrScopeMissing?: boolean;
  nextRepairPathKnown?: boolean;
}): CleanupCrewBlockerClassification {
  const text = normalizeText(`${params.summary ?? ""}\n${params.blocker ?? ""}`);
  const nextRepairPathKnown =
    params.nextRepairPathKnown === true ||
    textIncludesAny(text, [
      "safe next action",
      "next action",
      "next repair",
      "repair route",
      "lawful repair path",
      "continue cleanup repair",
      "continue_cleanup_repair",
      "rerun watchdog",
      "inspect latest watchdog receipt",
      "alternate lawful proof",
    ]);

  if (params.rawDbRequired === true || textIncludesAny(text, ["raw db", "raw-db"])) {
    if (params.emergencySopAuthorized === true) {
      return cleanupClassification({
        category: "repairable_prerequisite_blocker",
        scopedStops: ["stop_final_closeout", "continue_cleanup_repair"],
        reason:
          "Raw DB risk is covered by an emergency SOP path, so Cleanup Crew repair may continue through that supported authority.",
      });
    }
    return cleanupClassification({
      category: "raw_db_required_blocker",
      scopedStops: ["stop_final_closeout", "hard_stop_whole_mission"],
      reason: "Continuation would require raw DB/state editing without emergency SOP authority.",
    });
  }

  if (
    params.unsafeOrDestructive === true ||
    textIncludesAny(text, ["unsafe duplicate worker restart", "destructive", "unsafe restart"])
  ) {
    return cleanupClassification({
      category: "unsafe_destructive_blocker",
      scopedStops: ["stop_final_closeout", "hard_stop_whole_mission"],
      reason:
        "Continuation would require unsafe or destructive action without live death proof and SOP permission.",
    });
  }

  if (
    params.authorityOrScopeMissing === true ||
    textIncludesAny(text, ["authority cannot be verified", "scope cannot be verified"])
  ) {
    return cleanupClassification({
      category: "authority_scope_blocker",
      scopedStops: ["stop_final_closeout", "hard_stop_whole_mission"],
      reason: "Authority or scope cannot be verified for the next repair.",
    });
  }

  if (
    params.unsupportedSurfaceMissing === true ||
    textIncludesAny(text, [
      "unsupported surface missing",
      "supported owner surface cannot be verified",
    ])
  ) {
    if (params.lawfulDiscoveryPathAvailable === true || nextRepairPathKnown) {
      return cleanupClassification({
        category: "unsupported_surface_missing_blocker",
        scopedStops: ["stop_final_closeout", "continue_cleanup_repair"],
        reason:
          "The surface is missing, but a lawful discovery or repair route is still available.",
      });
    }
    return cleanupClassification({
      category: "unsupported_surface_missing_blocker",
      scopedStops: ["stop_final_closeout", "hard_stop_whole_mission"],
      reason:
        "The required supported surface is missing and no lawful discovery or repair path is known.",
    });
  }

  if (
    params.proofSourceUnavailable === true ||
    textIncludesAny(text, ["proof source unavailable", "proof unavailable"])
  ) {
    if (params.alternateProofSourceAvailable === true || nextRepairPathKnown) {
      return cleanupClassification({
        category: "proof_source_unavailable_blocker",
        scopedStops: ["stop_final_closeout", "continue_cleanup_repair"],
        reason: "The first proof source is unavailable, but an alternate lawful proof path exists.",
      });
    }
    return cleanupClassification({
      category: "proof_source_unavailable_blocker",
      scopedStops: ["stop_final_closeout", "hard_stop_whole_mission"],
      reason: "Required proof source is unavailable and no alternate lawful proof path is known.",
    });
  }

  if (
    textIncludesAny(text, [
      "phase 13 watchdog",
      "watchdog needs_review",
      "needs_review",
      "downstream phase blocked",
      "phase 14 blocked",
      "stop adjacent production",
      "stop_adjacent_phase",
      "stop_phase_transition",
    ])
  ) {
    return cleanupClassification({
      category: "downstream_phase_blocked_cleanup_continues",
      scopedStops: [
        "stop_adjacent_phase",
        "stop_phase_transition",
        "stop_final_closeout",
        "continue_cleanup_repair",
      ],
      reason:
        "Adjacent production or phase transition is blocked, but Cleanup Crew repair classification must continue.",
    });
  }

  if (
    nextRepairPathKnown ||
    textIncludesAny(text, ["repairable blocker", "repairable prerequisite blocker"])
  ) {
    return cleanupClassification({
      category: "repairable_prerequisite_blocker",
      scopedStops: ["stop_final_closeout", "continue_cleanup_repair"],
      reason:
        "The blocker is a repairable prerequisite and a lawful next repair path is known or derivable.",
    });
  }

  return cleanupClassification({
    category: "hard_sop_blocker",
    scopedStops: ["stop_final_closeout", "hard_stop_whole_mission"],
    reason:
      "No lawful Cleanup Crew repair path is known or derivable from the available classifier facts.",
  });
}

export function createCleanupCrewBootstrapB0TypedDecisionReceipt(
  input: CleanupCrewBootstrapB0DecisionInput,
): CleanupCrewTypedDecisionReceipt {
  const classification = classifyCleanupCrewBlocker(input);
  const outcome: CleanupCrewCanonicalOutcome = classification.canContinueCleanupRepair
    ? "REPAIR_AND_CONTINUE"
    : classification.scopedStops.includes("stop_phase_transition")
      ? "PHASE_BLOCKED"
      : "ACTION_BLOCKED";
  const impact: CleanupCrewImpactLevel =
    outcome === "PHASE_BLOCKED"
      ? "PHASE"
      : classification.hardStopWholeMission
        ? "MISSION"
        : "ACTION";
  const reasonCode: CleanupCrewGovernanceReasonCode = classification.canContinueCleanupRepair
    ? "TECHNICAL_REPAIR"
    : classification.category === "raw_db_required_blocker"
      ? "PROTECTED_ACTION_DENIED"
      : classification.category === "unsafe_destructive_blocker"
        ? "PROTECTED_ACTION_DENIED"
        : classification.category === "authority_scope_blocker"
          ? "AUTHORITY_CONFLICT"
          : classification.category === "proof_source_unavailable_blocker"
            ? "PROOF_PRODUCER_UNAVAILABLE"
            : "SCOPE_RISK_UNCLASSIFIED";
  const nextAction = classification.canContinueCleanupRepair
    ? "continue_cleanup_repair_through_canonical_policy"
    : "record_lawful_blocker_artifact_before_terminal_closeout";

  return createCleanupCrewTypedDecisionReceipt(
    {
      schema: "openclaw.cleanup_crew_typed_decision_input.v1",
      policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
      phase: input.phase,
      missionId: input.missionId,
      inputSummary: `${input.summary ?? ""}\n${input.blocker ?? ""}`.trim(),
      proposedOutcome: outcome,
      proposedImpact: impact,
      proposedReasonCode: reasonCode,
      owner: input.owner,
      nextAction,
      evidence:
        input.evidence && input.evidence.length > 0
          ? input.evidence
          : [classification.reason, classification.category],
      rollback: {
        available: true,
        proofRef: input.rollbackProofRef,
      },
      reportEffect: classification.canContinueCleanupRepair
        ? "b0_compatibility_repair_continues"
        : "b0_compatibility_terminal_stop_requires_blocker_proof",
    },
    { timestamp: input.timestamp },
  );
}

function stripNonRootInstructionBlocks(message: string): string {
  let root = message.replace(/```[\s\S]*?```/g, "");
  root = root
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith(">") && !trimmed.startsWith("[") && !trimmed.startsWith("System:");
    })
    .join("\n");
  return root.trim();
}

export function parseRootOperatorOverride(message: string | undefined): StopState | undefined {
  const root = normalizeText(stripNonRootInstructionBlocks(message ?? ""));
  if (!root) {
    return undefined;
  }
  const answerOnly =
    /\b(answer only|just answer|yes\/no only|yes or no only|dont do anything|don't do anything|do not do anything|no action|inspect only|review only)\b/.test(
      root,
    );
  return answerOnly ? "STOP_USER_ANSWER_ONLY_OVERRIDE" : undefined;
}

export function resolveAuthority(sources: AuthoritySource[]): AuthorityResolution {
  const sourcesChecked = sources.map((source) => `${source.kind}:${source.id}`);
  const active = sources.filter((source) => source.active);
  if (active.length === 0) {
    return {
      winner: "none",
      losing_sources: sourcesChecked,
      sources_checked: sourcesChecked,
      conflict_type: "unresolved_authority_conflict",
      reason: "No active authority source was provided.",
      stop_state: "STOP_UNRESOLVED_AUTHORITY_CONFLICT",
    };
  }

  const activeConflicts = active.filter((source) =>
    source.conflictWith?.some((id) => active.some((candidate) => candidate.id === id)),
  );
  if (activeConflicts.length > 0) {
    return {
      winner: "none",
      losing_sources: activeConflicts.map((source) => `${source.kind}:${source.id}`),
      sources_checked: sourcesChecked,
      conflict_type: "unresolved_authority_conflict",
      reason:
        "Active authority sources directly conflict and require diagnosis before continuation.",
      stop_state: "STOP_UNRESOLVED_AUTHORITY_CONFLICT",
    };
  }

  const safetyBlock = active.find((source) => source.safetyBlock);
  if (safetyBlock) {
    return {
      winner: safetyBlock.kind,
      winnerId: safetyBlock.id,
      losing_sources: active
        .filter((source) => source.id !== safetyBlock.id)
        .map((source) => source.id),
      sources_checked: sourcesChecked,
      conflict_type: "sop_safety_blocks_plan",
      reason: "A live safety/SOP authority blocks the proposed path.",
      stop_state: "STOP_UNSAFE_BEHAVIOR_CHANGE",
      proof_path: safetyBlock.proofPath,
    };
  }

  const winner = [...active].sort(
    (left, right) => AUTHORITY_PRIORITY[left.kind] - AUTHORITY_PRIORITY[right.kind],
  )[0]!;
  const losingSources = sources
    .filter((source) => source.id !== winner.id)
    .map((source) => source.id);
  const hasInactiveHistorical = sources.some(
    (source) =>
      !source.active &&
      (source.kind === "historical_closeout" || source.kind === "phase_closeout_ledger"),
  );
  const activePlanWon =
    winner.kind === "active_build_plan" ||
    winner.kind === "pass_resume_target" ||
    winner.kind === "active_mission_lock";

  let conflictType: AuthorityConflictType = "no_conflict";
  let continueState: ContinueState | undefined;
  let reason = `${winner.kind}:${winner.id} is the highest-priority active authority.`;
  if (hasInactiveHistorical && activePlanWon) {
    conflictType = "stale_artifact";
    continueState = "CONTINUE_AFTER_AUTHORITY_CONFLICT_DIAGNOSIS";
    reason = "Active mission or plan supersedes stale lower-priority artifact.";
  } else if (winner.kind === "root_user_instruction" && active.length > 1) {
    conflictType = "user_instruction_overrides_plan";
    continueState = "CONTINUE_PLAN_NEXT_STEP";
    reason = "Root user instruction is the highest-priority active authority.";
  }

  return {
    winner: winner.kind,
    winnerId: winner.id,
    losing_sources: losingSources,
    sources_checked: sourcesChecked,
    conflict_type: conflictType,
    reason,
    ...(continueState ? { continue_state: continueState } : {}),
    ...(winner.proofPath ? { proof_path: winner.proofPath } : {}),
  };
}

export function classifyTechnicalVsProduct(issue: ContinuityGateIssue): TechnicalVsProductLane {
  if (issue.behaviorImpact && issue.behaviorImpact !== "technical") {
    return issue.behaviorImpact;
  }
  if (
    issue.diffIntent === "behavior_semantics_change" ||
    issue.diffIntent === "new_feature_behavior" ||
    issue.diffIntent === "external_side_effect_change"
  ) {
    return "product_behavior";
  }
  if (issue.diffIntent === "unknown_intent" && issue.pathRisk === "CRITICAL_CONTROL") {
    return "true_unknown";
  }
  if (issue.diffIntent === "routing_or_catalog_recording") {
    return "plan_driven";
  }
  return "technical";
}

function resolveContinueState(issue: ContinuityGateIssue): ContinueState {
  const blocker = normalizeText(issue.blocker);
  if (blocker && INVALID_FINAL_STOP_REASONS.has(blocker)) {
    return INVALID_FINAL_STOP_REASONS.get(blocker)!;
  }
  if (issue.diffIntent === "routing_or_catalog_recording") {
    return "CONTINUE_PLAN_NEXT_STEP";
  }
  if (issue.diffIntent === "test_alignment") {
    return "CONTINUE_AFTER_BUILD_OR_TEST_REPAIR";
  }
  if (issue.diffIntent === "proof_or_receipt_shape" || issue.diffIntent === "mechanical_format") {
    return "CONTINUE_TECHNICAL_REPAIR";
  }
  return "CONTINUE_TECHNICAL_REPAIR";
}

export function classifyCleanupCrewRepairLane(
  issue: Pick<
    ContinuityGateIssue,
    "behaviorImpact" | "diffIntent" | "pathRisk" | "scopeWithinMission"
  >,
  params: { activeBuildPlanAuthorizesWork?: boolean } = {},
): CleanupCrewRepairLane {
  const lane = issue.behaviorImpact;
  if (
    lane === "product_behavior" ||
    lane === "ux_flow" ||
    lane === "gui_flow" ||
    lane === "system_purpose" ||
    issue.diffIntent === "new_feature_behavior" ||
    issue.diffIntent === "behavior_semantics_change" ||
    issue.diffIntent === "external_side_effect_change"
  ) {
    return "lane_c_product_behavior_decision";
  }
  if (
    lane === "plan_driven" ||
    params.activeBuildPlanAuthorizesWork === true ||
    issue.scopeWithinMission === true
  ) {
    return "lane_b_plan_driven_build_work";
  }
  return "lane_a_technical_repair";
}

export function deriveCleanupCrewRepair(
  params: CleanupCrewDerivedRepairInput,
): CleanupCrewDerivedRepair {
  const lane = classifyCleanupCrewRepairLane(params.issue, {
    activeBuildPlanAuthorizesWork: params.activeBuildPlanAuthorizesWork,
  });
  const requiresMarkDecision = lane === "lane_c_product_behavior_decision";
  const targetSurfaces = params.targetSurfaces ?? [];
  const validationSteps = params.validationSteps ?? [];
  const proofArtifacts = params.proofArtifacts ?? [];
  const repairAction = requiredText(params.repairAction, "repairAction");
  return {
    schema: "openclaw.cleanup_crew_derived_repair.v1",
    lane,
    can_execute_autonomously: !requiresMarkDecision,
    requires_plan_amendment: !requiresMarkDecision,
    requires_mark_decision: requiresMarkDecision,
    path_risk: params.issue.pathRisk,
    diff_intent: params.issue.diffIntent,
    reason: requiresMarkDecision
      ? "Lane C product/behavior decision must stop for Mark."
      : "Lane A/B repair may continue only after the active build plan is amended.",
    repair_action: repairAction,
    target_surfaces: targetSurfaces,
    validation_steps: validationSteps,
    proof_artifacts: proofArtifacts,
    ...(optionalText(params.nextExecutableCommand)
      ? { next_executable_command: optionalText(params.nextExecutableCommand) }
      : {}),
    ...(requiresMarkDecision ? { stop_state: "STOP_HUMAN_PRODUCT_DECISION" as const } : {}),
  };
}

function formatPlanAmendmentBlock(amendment: CleanupCrewPlanAmendment): string {
  return [
    "",
    `## Cleanup Crew Recovery Amendment ${amendment.amendment_id}`,
    "",
    "```json",
    JSON.stringify(amendment, null, 2),
    "```",
    "",
  ].join("\n");
}

export async function appendCleanupCrewPlanAmendment(
  params: CleanupCrewPlanAmendmentInput,
): Promise<CleanupCrewPlanAmendmentWrite> {
  if (params.derivedRepair.requires_mark_decision) {
    throw new Error(
      "Lane C repair requires Mark decision and cannot amend the active plan for execution",
    );
  }
  const planPath = path.resolve(requiredText(params.activeBuildPlanPath, "activeBuildPlanPath"));
  const currentPlan = await readFile(planPath, "utf8");
  const basePlanHash = sha256Text(currentPlan);
  const expectedPlanHash = optionalText(params.expectedPlanHash);
  if (expectedPlanHash && expectedPlanHash !== basePlanHash) {
    throw new Error("Active build plan is stale; reload current plan before amendment");
  }
  const createdAt = optionalText(params.timestamp) ?? new Date().toISOString();
  const nextExecutableCommand = optionalText(params.derivedRepair.next_executable_command);
  if (!nextExecutableCommand) {
    throw new Error("nextExecutableCommand is required for active plan amendment");
  }
  const amendment: CleanupCrewPlanAmendment = {
    schema: "openclaw.cleanup_crew_plan_amendment.v1",
    amendment_id: deterministicId("plan_amendment", [
      planPath,
      basePlanHash,
      params.stoppageId,
      params.derivedRepair.lane,
      params.diagnosis,
      params.derivedRepair.repair_action,
      nextExecutableCommand,
      createdAt,
    ]),
    created_at: createdAt,
    active_build_plan_path: planPath,
    base_plan_hash: basePlanHash,
    stoppage_id: requiredText(params.stoppageId, "stoppageId"),
    lane_classification: params.derivedRepair.lane,
    diagnosis: requiredText(params.diagnosis, "diagnosis"),
    path_risk: params.derivedRepair.path_risk,
    diff_intent: params.derivedRepair.diff_intent,
    repair_step: params.derivedRepair.repair_action,
    target_surfaces: params.derivedRepair.target_surfaces,
    validation_steps: params.derivedRepair.validation_steps,
    proof_artifacts: params.derivedRepair.proof_artifacts,
    next_executable_command: nextExecutableCommand,
    stop_conditions: params.stopConditions.map((condition) =>
      requiredText(condition, "stopConditions[]"),
    ),
    rollback_safety_notes: params.rollbackSafetyNotes.map((note) =>
      requiredText(note, "rollbackSafetyNotes[]"),
    ),
  };
  await appendFile(planPath, formatPlanAmendmentBlock(amendment), "utf8");
  const amendedPlanHash = sha256Text(await readFile(planPath, "utf8"));
  return {
    amendment,
    planPath,
    basePlanHash,
    amendedPlanHash,
  };
}

export function resolveCleanupCrewRepairExecutionGate(params: {
  derivedRepair: CleanupCrewDerivedRepair;
  amendment?: CleanupCrewPlanAmendment;
  currentPlanHash?: string;
  amendedPlanHash?: string;
}): CleanupCrewRepairExecutionGate {
  if (params.derivedRepair.requires_mark_decision) {
    return {
      allowed: false,
      reason: "lane_c_mark_decision_required",
      detail: "Lane C product/behavior repairs require Mark decision before execution.",
    };
  }
  if (!params.amendment) {
    return {
      allowed: false,
      reason: "plan_amendment_required",
      detail: "Cleanup Crew repair execution requires an active build plan amendment.",
    };
  }
  if (!optionalText(params.amendment.next_executable_command)) {
    return {
      allowed: false,
      reason: "next_executable_missing",
      detail: "Plan amendment does not name the next executable command.",
    };
  }
  if (
    optionalText(params.currentPlanHash) &&
    optionalText(params.amendedPlanHash) &&
    params.currentPlanHash !== params.amendedPlanHash
  ) {
    return {
      allowed: false,
      reason: "stale_plan_amendment",
      detail: "Current plan hash no longer matches the amended plan hash; reload and amend again.",
    };
  }
  return {
    allowed: true,
    amendmentId: params.amendment.amendment_id,
    planPath: params.amendment.active_build_plan_path,
    planHash: params.amendedPlanHash ?? params.currentPlanHash ?? params.amendment.base_plan_hash,
    nextExecutableCommand: params.amendment.next_executable_command,
  };
}

export function createCleanupCrewResumeUnit(
  params: CleanupCrewResumeUnitInput,
): CleanupCrewResumeUnit {
  const amendment = params.amendmentWrite.amendment;
  const command = requiredText(amendment.next_executable_command, "nextExecutableCommand");
  const cwd = requiredText(params.workingDirectory, "workingDirectory");
  const idempotencyKey = deterministicId("resume_unit_key", [
    amendment.amendment_id,
    params.amendmentWrite.amendedPlanHash,
    command,
    cwd,
  ]);
  return {
    schema: "openclaw.cleanup_crew_resume_unit.v1",
    resume_id: deterministicId("resume_unit", [idempotencyKey]),
    amendment_id: amendment.amendment_id,
    plan_path: amendment.active_build_plan_path,
    plan_hash: params.amendmentWrite.amendedPlanHash,
    command,
    cwd,
    idempotency_key: idempotencyKey,
    proof_artifacts: amendment.proof_artifacts,
    stop_conditions: amendment.stop_conditions,
  };
}

export function resolveCleanupCrewResumeGate(params: {
  resumeUnit?: CleanupCrewResumeUnit;
  requestedCommand?: string;
  currentPlanHash?: string;
  reportOnly?: boolean;
  explicitStop?: boolean;
}): CleanupCrewResumeGate {
  if (params.reportOnly === true) {
    return {
      allowed: false,
      action: "do_not_resume",
      reason: "report_only",
      detail: "Operator requested report-only; Cleanup Crew must not resume execution.",
    };
  }
  if (params.explicitStop === true) {
    return {
      allowed: false,
      action: "record_lawful_stop",
      reason: "explicit_stop",
      recoveryCommand: params.resumeUnit?.command,
      detail: "Operator explicitly stopped execution; record lawful stop with recovery command.",
    };
  }
  if (!params.resumeUnit) {
    return {
      allowed: false,
      action: "do_not_resume",
      reason: "resume_unit_required",
      detail:
        "Cleanup Crew cannot retry a command until it is loaded from the amended active plan.",
    };
  }
  const currentPlanHash = optionalText(params.currentPlanHash);
  if (currentPlanHash && currentPlanHash !== params.resumeUnit.plan_hash) {
    return {
      allowed: false,
      action: "do_not_resume",
      reason: "stale_plan",
      detail: "Current active build plan hash does not match the resume unit plan hash.",
    };
  }
  const requestedCommand = requiredText(params.requestedCommand ?? "", "requestedCommand");
  if (requestedCommand !== params.resumeUnit.command) {
    return {
      allowed: false,
      action: "do_not_resume",
      reason: "command_not_in_amended_plan",
      recoveryCommand: params.resumeUnit.command,
      detail: "Requested retry command does not exactly match the amended active plan command.",
    };
  }
  return {
    allowed: true,
    action: "execute_resume_unit",
    command: params.resumeUnit.command,
    cwd: params.resumeUnit.cwd,
    idempotencyKey: params.resumeUnit.idempotency_key,
  };
}

export function createCleanupCrewRecoveryTelemetryEvent(
  params: CleanupCrewRecoveryTelemetryInput,
): CleanupCrewRecoveryTelemetryEvent {
  const timestamp = optionalText(params.timestamp) ?? new Date().toISOString();
  const missionId = requiredText(params.missionId, "missionId");
  const eventType = params.eventType;
  return {
    schema: "openclaw.cleanup_crew_recovery_event.v1",
    event_id: deterministicId("recovery_event", [
      eventType,
      missionId,
      params.taskFlowId,
      timestamp,
      params.fromState,
      params.toState,
      params.reasonCode,
      params.diagnosticRef,
    ]),
    event_type: eventType,
    mission_id: missionId,
    ...(optionalText(params.taskFlowId) ? { task_flow_id: optionalText(params.taskFlowId) } : {}),
    timestamp,
    git_state: {
      head: requiredText(params.gitHead, "gitHead"),
      dirty_source_detected: params.dirtySourceDetected,
    },
    active_lane: params.activeLane ?? "none",
    path_risk_evaluation: params.pathRiskEvaluation ?? "not_evaluated",
    grant_retry_count: Math.max(0, Math.floor(params.grantRetryCount ?? 0)),
    from_state: requiredText(params.fromState, "fromState"),
    to_state: requiredText(params.toState, "toState"),
    reason_code: requiredText(params.reasonCode, "reasonCode"),
    diagnostic_ref: requiredText(params.diagnosticRef, "diagnosticRef"),
    next_executable_unit: {
      command: requiredText(params.nextExecutableCommand, "nextExecutableCommand"),
      cwd: requiredText(params.nextExecutableCwd, "nextExecutableCwd"),
    },
  };
}

export function isCleanupCrewRecoveryTelemetryEvent(
  value: unknown,
): value is CleanupCrewRecoveryTelemetryEvent {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { schema?: unknown }).schema === "openclaw.cleanup_crew_recovery_event.v1" &&
    typeof (value as { event_id?: unknown }).event_id === "string" &&
    typeof (value as { event_type?: unknown }).event_type === "string"
  );
}

export function resolveCleanupCrewTelemetryCloseoutGate(params: {
  events: unknown[];
  requiredEventTypes: CleanupCrewRecoveryEventType[];
}): CleanupCrewTelemetryCloseoutGate {
  const presentEventTypes = params.events
    .filter(isCleanupCrewRecoveryTelemetryEvent)
    .map((event) => event.event_type);
  const present = new Set(presentEventTypes);
  const missingEventTypes = params.requiredEventTypes.filter(
    (eventType) => !present.has(eventType),
  );
  if (missingEventTypes.length > 0) {
    return {
      allowed: false,
      reason: "missing_required_telemetry",
      missingEventTypes,
    };
  }
  return {
    allowed: true,
    presentEventTypes,
  };
}

function requiresGrantReview(issue: ContinuityGateIssue, lane: TechnicalVsProductLane): boolean {
  if (lane !== "technical" && lane !== "plan_driven") {
    return true;
  }
  return issue.pathRisk === "MEDIUM_RISK_RUNTIME" || issue.pathRisk === "HIGH_RISK_BEHAVIOR";
}

export function evaluateContinuityGateV2(
  params: EvaluateContinuityGateV2Params,
): ContinuityGateDecision {
  const createdAt = params.now ?? new Date().toISOString();
  const override = parseRootOperatorOverride(params.userInstruction);
  const authorityResolution = resolveAuthority(params.authoritySources);
  const constraints = params.constraints?.map((constraint) =>
    classifyBuildContextConstraint(constraint, createdAt),
  );
  const baseIdParts = [
    createdAt,
    params.activeMission,
    params.issue.summary,
    params.issue.blocker,
    authorityResolution.winner,
    authorityResolution.conflict_type,
  ];

  if (override) {
    return {
      decisionId: deterministicId("cc_decision", [...baseIdParts, override]),
      createdAt,
      activeMission: params.activeMission,
      selectedState: override,
      shouldContinue: false,
      askMark: false,
      authorityResolution,
      lane: "technical",
      pathRisk: params.issue.pathRisk,
      diffIntent: params.issue.diffIntent,
      grantReviewRequired: false,
      continueReason: "Root operator answer-only/inspect-only override bypasses execution.",
      ownerLevelBlockerAudit: "operator_override",
      ...(constraints ? { constraints } : {}),
    };
  }

  if (authorityResolution.stop_state) {
    return {
      decisionId: deterministicId("cc_decision", [...baseIdParts, authorityResolution.stop_state]),
      createdAt,
      activeMission: params.activeMission,
      selectedState: authorityResolution.stop_state,
      shouldContinue: false,
      askMark: false,
      authorityResolution,
      lane: "true_unknown",
      pathRisk: params.issue.pathRisk,
      diffIntent: params.issue.diffIntent,
      grantReviewRequired: true,
      continueReason: authorityResolution.reason,
      ownerLevelBlockerAudit: params.issue.ownerLevelBlockerAudit ?? "authority_resolver",
      ...(constraints ? { constraints } : {}),
    };
  }

  const lane = classifyTechnicalVsProduct(params.issue);
  const stopState =
    lane === "true_unknown"
      ? "STOP_TRUE_UNKNOWN_BLOCKER"
      : lane === "product_behavior" ||
          lane === "ux_flow" ||
          lane === "gui_flow" ||
          lane === "system_purpose"
        ? "STOP_HUMAN_PRODUCT_DECISION"
        : undefined;

  if (stopState) {
    const decision: ContinuityGateDecision = {
      decisionId: deterministicId("cc_decision", [...baseIdParts, stopState, lane]),
      createdAt,
      activeMission: params.activeMission,
      selectedState: stopState,
      shouldContinue: false,
      askMark: stopState === "STOP_HUMAN_PRODUCT_DECISION",
      authorityResolution,
      lane,
      pathRisk: params.issue.pathRisk,
      diffIntent: params.issue.diffIntent,
      grantReviewRequired: true,
      continueReason: `${lane} requires human/system-behavior decision or deeper diagnosis.`,
      ownerLevelBlockerAudit: params.issue.ownerLevelBlockerAudit ?? "human_product_owner",
      ...(constraints ? { constraints } : {}),
    };
    return {
      ...decision,
      stopReport: createStopReport(decision, { diagnosticArtifact: "pending_diagnostic_artifact" }),
    };
  }

  const continueState = authorityResolution.continue_state ?? resolveContinueState(params.issue);
  const invalidStopReason = params.issue.blocker
    ? INVALID_FINAL_STOP_REASONS.has(normalizeText(params.issue.blocker))
      ? params.issue.blocker
      : undefined
    : undefined;

  return {
    decisionId: deterministicId("cc_decision", [...baseIdParts, continueState, lane]),
    createdAt,
    activeMission: params.activeMission,
    selectedState: continueState,
    shouldContinue: true,
    askMark: false,
    authorityResolution,
    lane,
    pathRisk: params.issue.pathRisk,
    diffIntent: params.issue.diffIntent,
    grantReviewRequired: requiresGrantReview(params.issue, lane),
    continueReason:
      params.issue.safeTechnicalPathDescription ??
      "Issue is technical or plan-driven, inside Cleanup Crew continuation authority, and proof can be preserved.",
    ...(invalidStopReason ? { invalidStopReasonRejected: invalidStopReason } : {}),
    ownerLevelBlockerAudit: params.issue.ownerLevelBlockerAudit ?? "technical_owner",
    ...(constraints ? { constraints } : {}),
  };
}

export function classifyGrantRejection(message: string): GrantRejectionType {
  const normalized = normalizeText(message);
  if (/\b(scope expansion|outside scope|scope expanded)\b/.test(normalized)) {
    return "SCOPE_EXPANSION";
  }
  if (/\b(safety|unsafe|hidden mutation|false success|fake success)\b/.test(normalized)) {
    return "SEMANTIC_SAFETY";
  }
  if (/\b(validation mismatch|test mismatch|result mismatch)\b/.test(normalized)) {
    return "VALIDATION_MISMATCH";
  }
  if (/\b(closeout|missing field|format|required field|artifact path)\b/.test(normalized)) {
    return "MECHANICAL_CLOSEOUT_FORMAT";
  }
  if (/\b(proof link|proof path|missing proof|unreadable proof)\b/.test(normalized)) {
    return "MECHANICAL_PROOF_LINK";
  }
  return "UNKNOWN_REVIEW_BLOCKER";
}

export function resolveGrantRetry(params: {
  retrySurfaceId: string;
  rejectionType: GrantRejectionType;
  priorAttempts: number;
}): GrantRetryDecision {
  const maxAttempts = GRANT_RETRY_CEILINGS[params.rejectionType];
  const attempt = params.priorAttempts + 1;
  if (params.rejectionType === "SCOPE_EXPANSION") {
    return {
      schema: "openclaw.grant_rejection_repair_receipt.v2",
      retry_surface_id: params.retrySurfaceId,
      rejection_type: params.rejectionType,
      attempt,
      maxAttempts,
      result: "stop_or_plan_update_required",
    };
  }
  if (attempt > maxAttempts || params.rejectionType === "SEMANTIC_SAFETY") {
    return {
      schema: "openclaw.grant_rejection_repair_receipt.v2",
      retry_surface_id: params.retrySurfaceId,
      rejection_type: params.rejectionType,
      attempt,
      maxAttempts,
      result: "stop_or_true_blocker",
    };
  }
  return {
    schema: "openclaw.grant_rejection_repair_receipt.v2",
    retry_surface_id: params.retrySurfaceId,
    rejection_type: params.rejectionType,
    attempt,
    maxAttempts,
    result: "continue_repair",
    continueState: "CONTINUE_AFTER_REPAIRABLE_GRANT_REJECTION",
  };
}

export function createGrantRetryKey(params: {
  rejectionType: GrantRejectionType;
  fileSurfaceHash: string;
  artifactId: string;
}): string {
  return deterministicId("grant_retry", [
    params.rejectionType,
    requiredText(params.fileSurfaceHash, "fileSurfaceHash"),
    requiredText(params.artifactId, "artifactId"),
  ]);
}

export function classifyBuildContextConstraint(
  constraint: BuildContextConstraint,
  nowIso: string,
): BuildContextConstraintStatus {
  if (constraint.status === "retired") {
    return {
      constraintId: constraint.constraint_id,
      status: "retired",
      action: "IGNORE_RETIRED",
      selectedState: "CONTINUE_PLAN_NEXT_STEP",
      reason: "Constraint is retired and must not steer current Cleanup Crew behavior.",
    };
  }
  const expiredByTime =
    constraint.expires_at !== null &&
    new Date(constraint.expires_at).getTime() <= new Date(nowIso).getTime();
  if (constraint.status === "expired" || expiredByTime) {
    return {
      constraintId: constraint.constraint_id,
      status: "expired",
      action: "REFRESH_THEN_RECLASSIFY",
      selectedState: "CONTINUE_PLAN_NEXT_STEP",
      reason:
        "Expired build context triggers live-truth refresh and reclassify, not automatic stop.",
    };
  }
  return {
    constraintId: constraint.constraint_id,
    status: constraint.status,
    action: "KEEP_ACTIVE",
    selectedState: "CONTINUE_PLAN_NEXT_STEP",
    reason: "Constraint remains active for current build context.",
  };
}

export function createCleanupCrewRepairAttemptReceipt(input: {
  missionId: string;
  reasonCode: string;
  attemptIdentity?: string;
  attemptNumber: number;
  inputRef: string;
  action: string;
  evidence: string[];
  result: CleanupCrewRepairAttemptResult;
  deltaSummary: string;
  rollbackRequired?: boolean;
  rollbackAvailable?: boolean;
  timestamp?: string;
}): CleanupCrewRepairAttemptReceipt {
  const createdAt = optionalText(input.timestamp) ?? new Date().toISOString();
  const missionId = requiredText(input.missionId, "missionId");
  const reasonCode = requiredText(input.reasonCode, "reasonCode");
  const inputRef = requiredText(input.inputRef, "inputRef");
  const action = requiredText(input.action, "action");
  const attemptIdentity =
    optionalText(input.attemptIdentity) ??
    deterministicId("repair_attempt_identity", [missionId, reasonCode, inputRef, action]);
  return {
    schema: "openclaw.cleanup_crew_repair_attempt_receipt.v1",
    receipt_id: deterministicId("repair_attempt", [
      missionId,
      reasonCode,
      attemptIdentity,
      input.attemptNumber,
      input.result,
      input.deltaSummary,
    ]),
    created_at: createdAt,
    mission_id: missionId,
    reason_code: reasonCode,
    attempt_identity: attemptIdentity,
    attempt_number: input.attemptNumber,
    input_ref: inputRef,
    action,
    evidence: input.evidence.map((entry) => requiredText(entry, "evidence[]")),
    result: input.result,
    delta_summary: requiredText(input.deltaSummary, "deltaSummary"),
    rollback_required: input.rollbackRequired === true,
    rollback_available: input.rollbackAvailable !== false,
  };
}

function defaultRepairRetryBudget(reasonCode: string): number {
  const normalized = normalizeText(reasonCode);
  if (normalized.includes("malformed") || normalized.includes("unsafe")) {
    return 1;
  }
  if (normalized.includes("watchdog") || normalized.includes("stale_state")) {
    return 3;
  }
  if (normalized.includes("proof")) {
    return 2;
  }
  return 3;
}

export function resolveCleanupCrewRepairLoop(input: {
  missionId: string;
  reasonCode: string;
  attempts: CleanupCrewRepairAttemptReceipt[];
  retryBudgetByReasonCode?: Record<string, number>;
  safeParallelWorkAvailable?: boolean;
}): CleanupCrewRepairLoopDecision {
  const missionId = requiredText(input.missionId, "missionId");
  const reasonCode = requiredText(input.reasonCode, "reasonCode");
  const matchingAttempts = input.attempts.filter(
    (attempt) => attempt.mission_id === missionId && attempt.reason_code === reasonCode,
  );
  const retryBudget =
    input.retryBudgetByReasonCode?.[reasonCode] ?? defaultRepairRetryBudget(reasonCode);
  const latest = matchingAttempts[matchingAttempts.length - 1];
  const evidence = matchingAttempts.map((attempt) => attempt.receipt_id);
  const safeParallelWorkContinues = input.safeParallelWorkAvailable !== false;

  if (latest?.rollback_required === true && latest.rollback_available !== true) {
    return {
      schema: "openclaw.cleanup_crew_repair_loop_decision.v1",
      decision_id: deterministicId("repair_loop", [missionId, reasonCode, evidence, "rollback"]),
      mission_id: missionId,
      reason_code: reasonCode,
      attempt_count: matchingAttempts.length,
      identical_no_progress_count: 0,
      retry_budget: retryBudget,
      outcome: "action_blocked_rollback_required",
      mission_remains_active: true,
      safe_parallel_work_continues: safeParallelWorkContinues,
      quarantine_required: false,
      alternate_path_required: false,
      next_action: "perform_or_restore_rollback_before_retry_budget_can_continue",
      evidence,
    };
  }

  if (latest?.result === "malformed_evidence") {
    return {
      schema: "openclaw.cleanup_crew_repair_loop_decision.v1",
      decision_id: deterministicId("repair_loop", [missionId, reasonCode, evidence, "malformed"]),
      mission_id: missionId,
      reason_code: reasonCode,
      attempt_count: matchingAttempts.length,
      identical_no_progress_count: 0,
      retry_budget: retryBudget,
      outcome: "action_blocked_malformed_evidence",
      mission_remains_active: true,
      safe_parallel_work_continues: safeParallelWorkContinues,
      quarantine_required: false,
      alternate_path_required: true,
      next_action: "repair_or_replace_malformed_proof_producer_before_retrying",
      evidence,
    };
  }

  const latestIdentity = latest?.attempt_identity;
  const identicalNoProgressCount = latestIdentity
    ? matchingAttempts.filter(
        (attempt) =>
          attempt.attempt_identity === latestIdentity && attempt.result === "no_progress",
      ).length
    : 0;

  if (identicalNoProgressCount >= retryBudget) {
    return {
      schema: "openclaw.cleanup_crew_repair_loop_decision.v1",
      decision_id: deterministicId("repair_loop", [missionId, reasonCode, evidence, "quarantine"]),
      mission_id: missionId,
      reason_code: reasonCode,
      attempt_count: matchingAttempts.length,
      identical_no_progress_count: identicalNoProgressCount,
      retry_budget: retryBudget,
      outcome: safeParallelWorkContinues
        ? "quarantine_and_investigate_alternate"
        : "phase_blocked_budget_exhausted",
      mission_remains_active: true,
      safe_parallel_work_continues: safeParallelWorkContinues,
      quarantine_required: true,
      alternate_path_required: true,
      next_action: safeParallelWorkContinues
        ? "quarantine_affected_change_and_investigate_alternate_path"
        : "write_phase_blocker_budget_exhausted_with_no_alternate",
      evidence,
    };
  }

  return {
    schema: "openclaw.cleanup_crew_repair_loop_decision.v1",
    decision_id: deterministicId("repair_loop", [missionId, reasonCode, evidence, "continue"]),
    mission_id: missionId,
    reason_code: reasonCode,
    attempt_count: matchingAttempts.length,
    identical_no_progress_count: identicalNoProgressCount,
    retry_budget: retryBudget,
    outcome: "continue_repair",
    mission_remains_active: true,
    safe_parallel_work_continues: safeParallelWorkContinues,
    quarantine_required: false,
    alternate_path_required: false,
    next_action: "continue_repair_within_retry_budget_and_record_next_attempt",
    evidence,
  };
}

function defaultWaitReasonCode(kind: CleanupCrewDurableWaitKind): CleanupCrewGovernanceReasonCode {
  if (kind === "report_delivery") {
    return "REPORT_DELIVERY_REPAIR";
  }
  if (kind === "restart") {
    return "RESTART_DRAIN_WAIT";
  }
  if (kind === "external_dependency") {
    return "ROOT_OR_CREDENTIAL_UNAVAILABLE";
  }
  if (kind === "lost_session" || kind === "child_session") {
    return "STALE_STATE_RECONCILIATION";
  }
  return "ACTIVE_WORK_DRAIN";
}

function defaultProbeKind(kind: CleanupCrewDurableWaitKind): CleanupCrewResumeProbeKind {
  if (kind === "report_delivery") {
    return "report_delivery";
  }
  if (kind === "restart") {
    return "restart_activation";
  }
  if (kind === "external_dependency") {
    return "external_dependency";
  }
  if (kind === "lost_session" || kind === "child_session") {
    return "child_session";
  }
  return "source_turn_drain";
}

export function createCleanupCrewDurableWaitRecord(input: {
  missionId: string;
  waitKind: CleanupCrewDurableWaitKind;
  owner: string;
  evidence: string[];
  timeoutAt: string;
  resumeProbeTarget: string;
  resumeCondition: string;
  nextProbeAt?: string;
  reasonCode?: CleanupCrewGovernanceReasonCode;
  resumeProbeKind?: CleanupCrewResumeProbeKind;
  continuationReceiptRequired?: boolean;
  timestamp?: string;
}): CleanupCrewDurableWaitRecord {
  const createdAt = optionalText(input.timestamp) ?? new Date().toISOString();
  const missionId = requiredText(input.missionId, "missionId");
  const waitKind = input.waitKind;
  const reasonCode = input.reasonCode ?? defaultWaitReasonCode(waitKind);
  const resumeProbeKind = input.resumeProbeKind ?? defaultProbeKind(waitKind);
  return {
    schema: "openclaw.cleanup_crew_durable_wait_record.v1",
    wait_id: deterministicId("durable_wait", [
      missionId,
      waitKind,
      reasonCode,
      input.resumeProbeTarget,
      input.resumeCondition,
      createdAt,
    ]),
    created_at: createdAt,
    mission_id: missionId,
    wait_kind: waitKind,
    reason_code: reasonCode,
    owner: requiredText(input.owner, "owner"),
    evidence: input.evidence.map((entry) => requiredText(entry, "evidence[]")),
    timeout_at: requiredText(input.timeoutAt, "timeoutAt"),
    resume_probe: {
      kind: resumeProbeKind,
      target: requiredText(input.resumeProbeTarget, "resumeProbeTarget"),
      condition: requiredText(input.resumeCondition, "resumeCondition"),
      next_probe_at: requiredText(input.nextProbeAt ?? input.timeoutAt, "nextProbeAt"),
    },
    continuation_receipt_required: input.continuationReceiptRequired !== false,
    mission_remains_open: true,
  };
}

export function resolveCleanupCrewDurableWait(input: {
  record: CleanupCrewDurableWaitRecord;
  now: string;
  resumeConditionSatisfied?: boolean;
}): CleanupCrewDurableWaitResolution {
  const record = input.record;
  const validationErrors: string[] = [];
  if (record.schema !== "openclaw.cleanup_crew_durable_wait_record.v1") {
    validationErrors.push("durable_wait_schema_invalid");
  }
  if (!optionalText(record.mission_id)) {
    validationErrors.push("durable_wait_mission_id_missing");
  }
  if (!optionalText(record.owner)) {
    validationErrors.push("durable_wait_owner_missing");
  }
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    validationErrors.push("durable_wait_evidence_missing");
  }
  if (!optionalText(record.timeout_at)) {
    validationErrors.push("durable_wait_timeout_missing");
  }
  if (!optionalText(record.resume_probe?.target) || !optionalText(record.resume_probe?.condition)) {
    validationErrors.push("durable_wait_resume_probe_missing");
  }
  if (!isCleanupCrewGovernanceReasonCode(record.reason_code)) {
    validationErrors.push("durable_wait_reason_code_invalid");
  }
  if (record.mission_remains_open !== true) {
    validationErrors.push("durable_wait_must_keep_mission_open");
  }

  if (validationErrors.length > 0) {
    return {
      schema: "openclaw.cleanup_crew_durable_wait_resolution.v1",
      wait_id: optionalText(record.wait_id) ?? "invalid_wait",
      mission_id: optionalText(record.mission_id) ?? "unknown",
      outcome: "invalid_wait_record",
      canonical_outcome: "ACTION_BLOCKED",
      mission_remains_open: true,
      pending_report_delivery_can_close_mission: false,
      next_action: "repair_durable_wait_record_before_nonterminal_response",
      validation_errors: validationErrors,
    };
  }

  const nowMs = new Date(input.now).getTime();
  const timeoutMs = new Date(record.timeout_at).getTime();
  const nextProbeMs = new Date(record.resume_probe.next_probe_at).getTime();
  const canonicalOutcome: CleanupCrewCanonicalOutcome =
    record.wait_kind === "external_dependency" ? "EXTERNAL_DEPENDENCY" : "DEFER_UNTIL_DRAIN";

  if (input.resumeConditionSatisfied === true || nowMs >= timeoutMs) {
    return {
      schema: "openclaw.cleanup_crew_durable_wait_resolution.v1",
      wait_id: record.wait_id,
      mission_id: record.mission_id,
      outcome: nowMs >= timeoutMs ? "wait_expired_probe_required" : "resume_probe_due",
      canonical_outcome: canonicalOutcome,
      mission_remains_open: true,
      pending_report_delivery_can_close_mission: false,
      next_action: `run_resume_probe:${record.resume_probe.kind}:${record.resume_probe.target}`,
      validation_errors: [],
    };
  }

  if (nowMs >= nextProbeMs) {
    return {
      schema: "openclaw.cleanup_crew_durable_wait_resolution.v1",
      wait_id: record.wait_id,
      mission_id: record.mission_id,
      outcome: "resume_probe_due",
      canonical_outcome: "DEFER_UNTIL_DRAIN",
      mission_remains_open: true,
      pending_report_delivery_can_close_mission: false,
      next_action: `run_resume_probe:${record.resume_probe.kind}:${record.resume_probe.target}`,
      validation_errors: [],
    };
  }

  return {
    schema: "openclaw.cleanup_crew_durable_wait_resolution.v1",
    wait_id: record.wait_id,
    mission_id: record.mission_id,
    outcome: "wait_valid",
    canonical_outcome: canonicalOutcome,
    mission_remains_open: true,
    pending_report_delivery_can_close_mission: false,
    next_action: "keep_durable_wait_until_resume_probe_or_timeout",
    validation_errors: [],
  };
}

export function resolveCleanupCrewNonterminalContinuation(input: {
  missionId: string;
  parentMissionOpen: boolean;
  localStageComplete: boolean;
  durableWait?: CleanupCrewDurableWaitRecord;
  continuationReceiptPresent?: boolean;
  attemptedParentCloseout?: boolean;
}): CleanupCrewNonterminalContinuationDecision {
  const missionId = requiredText(input.missionId, "missionId");
  const errors: string[] = [];
  if (input.parentMissionOpen && !input.continuationReceiptPresent && !input.durableWait) {
    errors.push("continuation_receipt_missing");
  }
  if (input.parentMissionOpen && input.attemptedParentCloseout === true) {
    errors.push("parent_mission_closeout_forbidden_while_open");
  }
  return {
    schema: "openclaw.cleanup_crew_nonterminal_continuation_decision.v1",
    decision_id: deterministicId("nonterminal_continuation", [
      missionId,
      input.parentMissionOpen,
      input.localStageComplete,
      input.continuationReceiptPresent,
      input.durableWait?.wait_id,
      input.attemptedParentCloseout,
    ]),
    mission_id: missionId,
    allowed_to_emit_nonterminal_response: errors.length === 0,
    allowed_to_close_parent_mission: input.parentMissionOpen !== true && errors.length === 0,
    required_durable_wait: input.parentMissionOpen === true && input.localStageComplete !== true,
    next_action:
      errors.length === 0
        ? "continue_from_recorded_wait_or_next_executable_step"
        : "write_continuation_receipt_or_durable_wait_before_response",
    validation_errors: errors,
  };
}

function hasExecutorIdentity(executor: CleanupCrewExecutorCapabilityRecord): boolean {
  return Boolean(executor.session_key || executor.task_id || executor.run_id);
}

function canExecutorPerform(
  executor: CleanupCrewExecutorCapabilityRecord,
  capability: CleanupCrewExecutorCapability,
): boolean {
  return (
    executor.available === true &&
    executor.stale !== true &&
    executor.permitted.includes(capability) &&
    !executor.prohibited.includes(capability) &&
    hasExecutorIdentity(executor)
  );
}

export function createCleanupCrewExecutorCapabilityRecord(input: {
  executorId: string;
  role: CleanupCrewExecutorCapabilityRecord["role"];
  sessionKey?: string;
  taskId?: string;
  runId?: string;
  leaseRevision?: number;
  available?: boolean;
  stale?: boolean;
  permitted: CleanupCrewExecutorCapability[];
  prohibited?: CleanupCrewExecutorCapability[];
  receiptRequirements?: string[];
}): CleanupCrewExecutorCapabilityRecord {
  return {
    schema: "openclaw.cleanup_crew_executor_capability_record.v1",
    executor_id: requiredText(input.executorId, "executorId"),
    role: input.role,
    ...(optionalText(input.sessionKey) ? { session_key: optionalText(input.sessionKey)! } : {}),
    ...(optionalText(input.taskId) ? { task_id: optionalText(input.taskId)! } : {}),
    ...(optionalText(input.runId) ? { run_id: optionalText(input.runId)! } : {}),
    ...(typeof input.leaseRevision === "number" ? { lease_revision: input.leaseRevision } : {}),
    available: input.available !== false,
    stale: input.stale === true,
    permitted: input.permitted,
    prohibited: input.prohibited ?? [],
    receipt_requirements: input.receiptRequirements ?? [],
  };
}

export function resolveCleanupCrewCapabilityRoute(input: {
  missionId: string;
  requiredCapability: CleanupCrewExecutorCapability;
  executors: CleanupCrewExecutorCapabilityRecord[];
  preferredExecutorId?: string;
  requiresGrantReview?: boolean;
  evidence: string[];
}): CleanupCrewCapabilityRouteDecision {
  const missionId = requiredText(input.missionId, "missionId");
  const requiredCapability = input.requiredCapability;
  const evidence = input.evidence.map((entry) => requiredText(entry, "evidence[]"));
  const preferred = optionalText(input.preferredExecutorId);
  const preferredExecutor = preferred
    ? input.executors.find((executor) => executor.executor_id === preferred)
    : undefined;

  const staleIdentity = input.executors.find(
    (executor) =>
      executor.stale === true &&
      (executor.permitted.includes(requiredCapability) ||
        executor.prohibited.includes(requiredCapability)),
  );
  if (staleIdentity) {
    return {
      schema: "openclaw.cleanup_crew_capability_route_decision.v1",
      decision_id: deterministicId("capability_route", [
        missionId,
        requiredCapability,
        staleIdentity.executor_id,
        "stale",
      ]),
      mission_id: missionId,
      required_capability: requiredCapability,
      outcome: "stale_identity_reconciliation_required",
      canonical_outcome: "ACTION_BLOCKED",
      reason_code: "STALE_STATE_RECONCILIATION",
      next_action: "reconcile_stale_executor_identity_before_spawn_or_mutation",
      duplicate_spawn_allowed: false,
      evidence,
    };
  }

  const candidates = [
    ...(preferredExecutor ? [preferredExecutor] : []),
    ...input.executors.filter((executor) => executor.executor_id !== preferred),
  ];
  const selected = candidates.find((executor) => canExecutorPerform(executor, requiredCapability));
  if (selected) {
    return {
      schema: "openclaw.cleanup_crew_capability_route_decision.v1",
      decision_id: deterministicId("capability_route", [
        missionId,
        requiredCapability,
        selected.executor_id,
        "route",
      ]),
      mission_id: missionId,
      required_capability: requiredCapability,
      outcome: "route_to_available_executor",
      selected_executor_id: selected.executor_id,
      canonical_outcome: "CONTINUE",
      reason_code: "TECHNICAL_REPAIR",
      next_action: `route_work_to_executor:${selected.executor_id}`,
      duplicate_spawn_allowed: false,
      evidence,
    };
  }

  if (input.requiresGrantReview === true || requiredCapability === "grant_review") {
    return {
      schema: "openclaw.cleanup_crew_capability_route_decision.v1",
      decision_id: deterministicId("capability_route", [
        missionId,
        requiredCapability,
        "grant_unavailable",
      ]),
      mission_id: missionId,
      required_capability: requiredCapability,
      outcome: "reviewer_unavailable_wait",
      canonical_outcome: "PHASE_BLOCKED",
      reason_code: "REVIEWER_UNAVAILABLE",
      next_action: "write_reviewer_unavailable_wait_and_resume_probe",
      duplicate_spawn_allowed: false,
      evidence,
    };
  }

  const identityPoor = input.executors.some(
    (executor) =>
      executor.available === true &&
      executor.stale !== true &&
      executor.permitted.includes(requiredCapability) &&
      !hasExecutorIdentity(executor),
  );
  if (identityPoor) {
    return {
      schema: "openclaw.cleanup_crew_capability_route_decision.v1",
      decision_id: deterministicId("capability_route", [
        missionId,
        requiredCapability,
        "identity_missing",
      ]),
      mission_id: missionId,
      required_capability: requiredCapability,
      outcome: "identity_missing_blocked",
      canonical_outcome: "ACTION_BLOCKED",
      reason_code: "ROLE_CAPABILITY_UNAVAILABLE",
      next_action: "attach_executor_identity_and_receipt_requirements_before_routing",
      duplicate_spawn_allowed: false,
      evidence,
    };
  }

  return {
    schema: "openclaw.cleanup_crew_capability_route_decision.v1",
    decision_id: deterministicId("capability_route", [missionId, requiredCapability, "mismatch"]),
    mission_id: missionId,
    required_capability: requiredCapability,
    outcome: "capability_mismatch_blocked",
    canonical_outcome: "ACTION_BLOCKED",
    reason_code: "ROLE_CAPABILITY_UNAVAILABLE",
    next_action: "find_lawful_executor_or_write_capability_wait",
    duplicate_spawn_allowed: false,
    evidence,
  };
}

export function createCleanupCrewRestartDrainRegistration(input: {
  missionId: string;
  owner: string;
  restartTarget: string;
  drainReason: string;
  activeWorkRef: string;
  timeoutAt: string;
  postRestartProofRequired: string[];
  timestamp?: string;
}): CleanupCrewRestartDrainRegistration {
  const createdAt = optionalText(input.timestamp) ?? new Date().toISOString();
  const missionId = requiredText(input.missionId, "missionId");
  const restartTarget = requiredText(input.restartTarget, "restartTarget");
  const activeWorkRef = requiredText(input.activeWorkRef, "activeWorkRef");
  return {
    schema: "openclaw.cleanup_crew_restart_drain_registration.v1",
    registration_id: deterministicId("restart_drain_registration", [
      missionId,
      restartTarget,
      activeWorkRef,
      createdAt,
    ]),
    created_at: createdAt,
    mission_id: missionId,
    owner: requiredText(input.owner, "owner"),
    restart_target: restartTarget,
    drain_reason: requiredText(input.drainReason, "drainReason"),
    active_work_ref: activeWorkRef,
    timeout_at: requiredText(input.timeoutAt, "timeoutAt"),
    post_restart_proof_required: input.postRestartProofRequired.map((entry) =>
      requiredText(entry, "postRestartProofRequired[]"),
    ),
  };
}

export function resolveCleanupCrewRestartContinuation(input: {
  missionId: string;
  restartRequested: boolean;
  activeWorkPresent: boolean;
  registration?: CleanupCrewRestartDrainRegistration;
  postRestartProof?: string[];
  attemptedCloseout?: boolean;
}): CleanupCrewRestartContinuationDecision {
  const missionId = requiredText(input.missionId, "missionId");
  const evidence = [
    ...(input.registration ? [input.registration.registration_id] : []),
    ...(input.postRestartProof ?? []),
  ];
  if (input.restartRequested && input.activeWorkPresent && !input.registration) {
    return {
      schema: "openclaw.cleanup_crew_restart_continuation_decision.v1",
      decision_id: deterministicId("restart_continuation", [missionId, "missing_registration"]),
      mission_id: missionId,
      outcome: "restart_missing_registration_blocked",
      canonical_outcome: "ACTION_BLOCKED",
      reason_code: "RESTART_DRAIN_WAIT",
      mission_remains_open: true,
      allowed_to_close: false,
      next_action: "write_restart_registration_before_drain_or_restart",
      evidence,
    };
  }

  if (input.registration && input.activeWorkPresent) {
    return {
      schema: "openclaw.cleanup_crew_restart_continuation_decision.v1",
      decision_id: deterministicId("restart_continuation", [
        missionId,
        input.registration.registration_id,
        "defer",
      ]),
      mission_id: missionId,
      outcome: "restart_registered_defer_until_drain",
      canonical_outcome: "DEFER_UNTIL_DRAIN",
      reason_code: "RESTART_DRAIN_WAIT",
      mission_remains_open: true,
      allowed_to_close: false,
      next_action: "defer_restart_until_registered_active_work_drains_then_probe",
      evidence,
    };
  }

  const requiredProof = input.registration?.post_restart_proof_required ?? [];
  const proof = new Set(input.postRestartProof ?? []);
  const missingProof = requiredProof.filter((entry) => !proof.has(entry));
  if (input.registration && missingProof.length > 0) {
    return {
      schema: "openclaw.cleanup_crew_restart_continuation_decision.v1",
      decision_id: deterministicId("restart_continuation", [
        missionId,
        input.registration.registration_id,
        "proof_missing",
        missingProof,
      ]),
      mission_id: missionId,
      outcome: "post_restart_proof_missing_blocked",
      canonical_outcome: "ACTION_BLOCKED",
      reason_code: "RESTART_DRAIN_WAIT",
      mission_remains_open: true,
      allowed_to_close: false,
      next_action: "prove_post_restart_target_surface_loaded_before_closeout",
      evidence,
    };
  }

  return {
    schema: "openclaw.cleanup_crew_restart_continuation_decision.v1",
    decision_id: deterministicId("restart_continuation", [missionId, "proof_passed", evidence]),
    mission_id: missionId,
    outcome: "post_restart_proof_passed_continue",
    canonical_outcome: "CONTINUE",
    reason_code: "TECHNICAL_REPAIR",
    mission_remains_open: input.attemptedCloseout !== true,
    allowed_to_close: input.attemptedCloseout === true,
    next_action: "continue_after_post_restart_target_surface_proof",
    evidence,
  };
}

export function createCleanupCrewDecisionRecord(
  decision: ContinuityGateDecision,
  scope: { files?: string[]; records?: string[]; commands?: string[] } = {},
): CleanupCrewDecisionRecord {
  return {
    schema: "openclaw.cleanup_crew_decision_record.v2",
    decision_id: decision.decisionId,
    created_at: decision.createdAt,
    active_mission: decision.activeMission,
    selected_state: decision.selectedState,
    authority_resolution: decision.authorityResolution,
    technical_vs_product: {
      lane: decision.lane,
      reason: decision.continueReason,
      path_risk: decision.pathRisk,
      diff_intent: decision.diffIntent,
    },
    scope: {
      files: scope.files ?? [],
      records: scope.records ?? [],
      commands: scope.commands ?? [],
    },
    validation_plan: [],
    grant_review_required: decision.grantReviewRequired,
    continue_reason: decision.continueReason,
    rollback_or_evidence_path: "not_written_by_pure_decision_engine",
  };
}

export function createContinueReceipt(
  decision: ContinuityGateDecision,
  params: { repairAction: string; proofPath: string },
): CleanupCrewContinueReceipt {
  if (!decision.shouldContinue) {
    throw new Error(`Cannot create continue receipt for stop state ${decision.selectedState}`);
  }
  return {
    schema: "openclaw.cleanup_crew_continue_receipt.v2",
    receipt_id: randomUUID(),
    decision_id: decision.decisionId,
    created_at: decision.createdAt,
    selected_state: decision.selectedState as ContinueState,
    repair_action: params.repairAction,
    continue_reason: decision.continueReason,
    proof_path: params.proofPath,
  };
}

export function createStopReport(
  decision: ContinuityGateDecision,
  params: { diagnosticArtifact: string; recommendedOption?: string },
): StopReportEnvelope {
  if (decision.shouldContinue) {
    throw new Error(`Cannot create stop report for continue state ${decision.selectedState}`);
  }
  const stopState = decision.selectedState as StopState;
  return {
    schema: "openclaw.cleanup_crew_stop_report.v2",
    stop_state: stopState,
    impact: decision.continueReason,
    blast_radius: `${decision.pathRisk}:${decision.diffIntent}`,
    plain_text_question:
      stopState === "STOP_HUMAN_PRODUCT_DECISION"
        ? "What should the system do?"
        : "No operator action requested unless a human decision is required.",
    ...(params.recommendedOption ? { recommended_option: params.recommendedOption } : {}),
    why_this_is_not_technical: `${decision.lane} cannot be resolved as a safe technical repair.`,
    diagnostic_artifact: params.diagnosticArtifact,
  };
}

export function createDiagnosticTrace(
  decision: ContinuityGateDecision,
  params: {
    filesTouched: string[];
    tests: string[];
    redactionStatus: string;
    surfaces?: string[];
    records?: string[];
    commands?: string[];
    grantResult?: string;
    proofRefs?: string[];
  },
): CleanupCrewDiagnosticTrace {
  return {
    schema: "openclaw.cleanup_crew_diagnostic_trace.v2",
    trace_id: randomUUID(),
    decision_id: decision.decisionId,
    created_at: decision.createdAt,
    selected_state: decision.selectedState,
    files_touched: params.filesTouched,
    tests: params.tests,
    owner_level_blocker_audit: decision.ownerLevelBlockerAudit,
    risk_classification: {
      path_risk: decision.pathRisk,
      diff_intent: decision.diffIntent,
    },
    technical_vs_product: {
      lane: decision.lane,
      reason: decision.continueReason,
    },
    scope: {
      surfaces: params.surfaces ?? [],
      records: params.records ?? [],
      commands: params.commands ?? [],
    },
    ...(params.grantResult ? { grant_result: params.grantResult } : {}),
    proof_refs: params.proofRefs ?? [],
    authority_resolution: decision.authorityResolution,
    grant_review_required: decision.grantReviewRequired,
    redaction_status: params.redactionStatus,
  };
}

export function createCleanupCrewStoppageReceipt(
  params: CleanupCrewStoppageReceiptInput,
): CleanupCrewStoppageReceipt {
  const stdoutTail = truncateTail(params.stdoutTail);
  const stderrTail = truncateTail(params.stderrTail);
  const createdAt = optionalText(params.timestamp) ?? new Date().toISOString();
  const receiptId = deterministicId("stoppage_receipt", [
    params.missionId,
    params.taskFlowId,
    params.packetId,
    params.stageId,
    params.commandProcessId,
    params.commandSpec,
    params.workingDirectory,
    params.gitHead,
    params.stoppageClass,
    params.suspectedAffectedSurface,
    createdAt,
  ]);
  return {
    schema: "openclaw.cleanup_crew_stoppage_receipt.v1",
    receipt_id: receiptId,
    created_at: createdAt,
    mission_id: requiredText(params.missionId, "missionId"),
    ...(optionalText(params.taskFlowId) ? { task_flow_id: optionalText(params.taskFlowId) } : {}),
    ...(optionalText(params.packetId) ? { packet_id: optionalText(params.packetId) } : {}),
    ...(optionalText(params.stageId) ? { stage_id: optionalText(params.stageId) } : {}),
    ...(optionalText(params.commandProcessId)
      ? { command_process_id: optionalText(params.commandProcessId) }
      : {}),
    ...(optionalText(params.commandSpec) ? { command_spec: optionalText(params.commandSpec) } : {}),
    working_directory: requiredText(params.workingDirectory, "workingDirectory"),
    git_state: {
      head: requiredText(params.gitHead, "gitHead"),
      dirty_tree_summary: requiredRawText(params.dirtyTreeSummary, "dirtyTreeSummary"),
    },
    captured_output: {
      stdout_tail: stdoutTail.text,
      stderr_tail: stderrTail.text,
      tail_truncated: stdoutTail.truncated || stderrTail.truncated,
    },
    proof: {
      ...(optionalText(params.proofArtifactPath)
        ? { artifact_path: optionalText(params.proofArtifactPath) }
        : {}),
      ...(optionalText(params.logPath) ? { log_path: optionalText(params.logPath) } : {}),
    },
    stoppage_class: params.stoppageClass,
    suspected_affected_surface: requiredText(
      params.suspectedAffectedSurface,
      "suspectedAffectedSurface",
    ),
    next_analysis_owner: requiredText(params.nextAnalysisOwner, "nextAnalysisOwner"),
  };
}

function safeArtifactId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "artifact";
}

async function writeJsonArtifact(params: {
  outputDir: string;
  subdir: string;
  filename: string;
  payload: unknown;
}): Promise<string> {
  const dir = path.resolve(params.outputDir, params.subdir);
  await mkdir(dir, { recursive: true });
  const artifactPath = path.join(dir, params.filename);
  await writeFile(artifactPath, `${JSON.stringify(params.payload, null, 2)}\n`, "utf8");
  return artifactPath;
}

export async function writeCleanupCrewDurableArtifacts(
  params: WriteCleanupCrewDurableArtifactsParams,
): Promise<CleanupCrewDurableArtifactWrite[]> {
  const writes: CleanupCrewDurableArtifactWrite[] = [];
  if (params.decisionRecord) {
    writes.push({
      kind: "decision_record",
      path: await writeJsonArtifact({
        outputDir: params.outputDir,
        subdir: "cleanup_crew_decision_records",
        filename: `${safeArtifactId(params.decisionRecord.decision_id)}.json`,
        payload: params.decisionRecord,
      }),
    });
  }
  if (params.continueReceipt) {
    writes.push({
      kind: "continue_receipt",
      path: await writeJsonArtifact({
        outputDir: params.outputDir,
        subdir: "cleanup_crew_continue_receipts",
        filename: `${safeArtifactId(params.continueReceipt.receipt_id)}.json`,
        payload: params.continueReceipt,
      }),
    });
  }
  if (params.stopReport) {
    writes.push({
      kind: "stop_report",
      path: await writeJsonArtifact({
        outputDir: params.outputDir,
        subdir: "cleanup_crew_stop_reports",
        filename: `${safeArtifactId(params.stopReport.stop_state)}.json`,
        payload: params.stopReport,
      }),
    });
  }
  if (params.diagnosticTrace) {
    writes.push({
      kind: "diagnostic_trace",
      path: await writeJsonArtifact({
        outputDir: params.outputDir,
        subdir: "cleanup_crew_diagnostic_traces",
        filename: `${safeArtifactId(params.diagnosticTrace.trace_id)}.json`,
        payload: params.diagnosticTrace,
      }),
    });
  }
  if (params.stoppageReceipt) {
    writes.push({
      kind: "stoppage_receipt",
      path: await writeJsonArtifact({
        outputDir: params.outputDir,
        subdir: "cleanup_crew_stoppage_receipts",
        filename: `${safeArtifactId(params.stoppageReceipt.receipt_id)}.json`,
        payload: params.stoppageReceipt,
      }),
    });
  }
  for (const event of params.telemetryEvents ?? []) {
    writes.push({
      kind: "telemetry_event",
      path: await writeJsonArtifact({
        outputDir: params.outputDir,
        subdir: "cleanup_crew_recovery_events",
        filename: `${safeArtifactId(event.event_id)}.json`,
        payload: event,
      }),
    });
  }
  return writes;
}
