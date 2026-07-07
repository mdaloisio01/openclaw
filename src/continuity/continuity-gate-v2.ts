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

function deterministicId(prefix: string, parts: unknown[]): string {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
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
