import {
  CLEANUP_WATCHDOG_CLEAN_DIMENSIONS,
  CLEANUP_WATCHDOG_POLICY_VERSION,
  type CleanupWatchdogCleanDimension,
} from "./cleanup-watchdog-policy.js";

export const CLEANUP_CREW_RUNTIME_ENFORCEMENT_SCHEMA =
  "openclaw.cleanup_crew_runtime_enforcement.v1" as const;

export const CLEANUP_CREW_RUNTIME_GATE_IDS = [
  "mission_admission",
  "tool_preflight",
  "tool_result",
  "report_delivery",
  "post_report_continuation",
  "watchdog_clean",
  "live_runtime_proof",
  "handoff_inheritance",
  "trace_eval_replay",
] as const;

export type CleanupCrewRuntimeGateId = (typeof CLEANUP_CREW_RUNTIME_GATE_IDS)[number];

export type CleanupCrewRuntimeGateState = "pass" | "fail" | "not_required";

export type CleanupCrewRuntimeGateDecision = {
  gate: CleanupCrewRuntimeGateId;
  state: CleanupCrewRuntimeGateState;
  reason: string;
  obligations: string[];
};

export type CleanupCrewRuntimeMissionContract = {
  missionId?: string;
  controllingPlanRef?: string;
  lawfulOwner?: string;
  allowedTools?: readonly string[];
  forbiddenTools?: readonly string[];
  allowedPaths?: readonly string[];
  forbiddenPaths?: readonly string[];
  requiredProof?: readonly string[];
  doneCriteria?: readonly string[];
  stopConditions?: readonly string[];
  requiredReportMoments?: readonly string[];
  continuationRequired?: boolean;
  watchdogCleanDimensions?: readonly CleanupWatchdogCleanDimension[];
  policyVersion?: string;
};

export type CleanupCrewRuntimeToolPreflightFacts = {
  toolName?: string;
  targetPath?: string;
  mutation?: boolean;
  idempotencyKeyPresent?: boolean;
  rollbackProofPreserved?: boolean;
  approvalClassSatisfied?: boolean;
  lawfulOwnerMatched?: boolean;
};

export type CleanupCrewRuntimeToolResultFacts = {
  status?: "passed" | "failed" | "partial" | "interrupted" | "ambiguous" | "side_effect_pending";
  proofPresent?: boolean;
  contradictedByLiveProof?: boolean;
};

export type CleanupCrewRuntimeReportFacts = {
  reportRequired?: boolean;
  reportArtifactPath?: string;
  chatDeliveryVerified?: boolean;
  laterSettlementVerified?: boolean;
  explicitArtifactOnlyAllowed?: boolean;
  deliveryFailureVisible?: boolean;
};

export type CleanupCrewRuntimeContinuationFacts = {
  broaderMissionOpen?: boolean;
  reportDelivered?: boolean;
  nextExecutableAction?: string;
  durableCoverageKind?:
    | "valid_executor"
    | "durable_defer"
    | "external_wait"
    | "owner_wait"
    | "verified_blocker";
  operatorStopRequested?: boolean;
  wholeMissionComplete?: boolean;
  verifiedHardStop?: boolean;
};

export type CleanupCrewRuntimeWatchdogFacts = {
  suspiciousCount?: number;
  dimensions?: Partial<Record<CleanupWatchdogCleanDimension, boolean>>;
  needsReview?: boolean;
  duplicateSuppressedOnlyChat?: boolean;
  policyVersion?: string;
};

export type CleanupCrewRuntimeProofFacts = {
  runtimeChangeRequired?: boolean;
  sourceRevision?: string;
  buildRevision?: string;
  liveRuntimeRevision?: string;
  postRestartAssetGuardPassed?: boolean;
  taskAuditPassed?: boolean;
  blockedFlowProofPassed?: boolean;
};

export type CleanupCrewRuntimeHandoffFacts = {
  childExecutionRequested?: boolean;
  parentMissionContractInherited?: boolean;
  childScopeWithinParent?: boolean;
  parentCoverageValid?: boolean;
};

export type CleanupCrewRuntimeTraceEvalFacts = {
  required?: boolean;
  tracesCaptured?: boolean;
  replayCasesPassed?: boolean;
  promptInjectionCasesPassed?: boolean;
};

export type CleanupCrewRuntimeEnforcementFacts = {
  contract?: CleanupCrewRuntimeMissionContract;
  toolPreflight?: CleanupCrewRuntimeToolPreflightFacts;
  toolResult?: CleanupCrewRuntimeToolResultFacts;
  report?: CleanupCrewRuntimeReportFacts;
  continuation?: CleanupCrewRuntimeContinuationFacts;
  watchdog?: CleanupCrewRuntimeWatchdogFacts;
  runtimeProof?: CleanupCrewRuntimeProofFacts;
  handoff?: CleanupCrewRuntimeHandoffFacts;
  traceEval?: CleanupCrewRuntimeTraceEvalFacts;
};

export type CleanupCrewRuntimeEnforcementDecision = {
  schema: typeof CLEANUP_CREW_RUNTIME_ENFORCEMENT_SCHEMA;
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  allowedToAdvance: boolean;
  allowedToCloseMission: boolean;
  gates: CleanupCrewRuntimeGateDecision[];
  nextAction: string;
};

const REQUIRED_CONTRACT_FIELDS: Array<keyof CleanupCrewRuntimeMissionContract> = [
  "missionId",
  "controllingPlanRef",
  "lawfulOwner",
  "requiredProof",
  "doneCriteria",
  "stopConditions",
  "requiredReportMoments",
  "watchdogCleanDimensions",
  "policyVersion",
];

function pass(gate: CleanupCrewRuntimeGateId, reason: string): CleanupCrewRuntimeGateDecision {
  return { gate, state: "pass", reason, obligations: [] };
}

function notRequired(
  gate: CleanupCrewRuntimeGateId,
  reason: string,
): CleanupCrewRuntimeGateDecision {
  return { gate, state: "not_required", reason, obligations: [] };
}

function fail(
  gate: CleanupCrewRuntimeGateId,
  reason: string,
  obligations: string[],
): CleanupCrewRuntimeGateDecision {
  return { gate, state: "fail", reason, obligations };
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasValues(value: readonly unknown[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

function missingContractFields(contract: CleanupCrewRuntimeMissionContract | undefined): string[] {
  if (!contract) {
    return ["contract"];
  }
  const missing = REQUIRED_CONTRACT_FIELDS.filter((field) => {
    const value = contract[field];
    return Array.isArray(value) ? value.length === 0 : !value;
  }).map(String);
  const dimensions = new Set(contract.watchdogCleanDimensions ?? []);
  for (const dimension of CLEANUP_WATCHDOG_CLEAN_DIMENSIONS) {
    if (!dimensions.has(dimension)) {
      missing.push(`watchdogCleanDimensions.${dimension}`);
    }
  }
  if (contract.policyVersion !== CLEANUP_WATCHDOG_POLICY_VERSION) {
    missing.push("policyVersion.current");
  }
  return missing;
}

export function evaluateCleanupCrewMissionAdmissionGate(
  contract: CleanupCrewRuntimeMissionContract | undefined,
): CleanupCrewRuntimeGateDecision {
  const missing = missingContractFields(contract);
  if (missing.length > 0) {
    return fail("mission_admission", "cleanup crew mission contract is missing or incomplete", [
      ...missing.map((field) => `missing:${field}`),
      "deny_cleanup_crew_start",
    ]);
  }
  return pass("mission_admission", "cleanup crew mission contract is complete and current");
}

export function evaluateCleanupCrewToolPreflightGate(
  contract: CleanupCrewRuntimeMissionContract | undefined,
  facts: CleanupCrewRuntimeToolPreflightFacts | undefined,
): CleanupCrewRuntimeGateDecision {
  if (!facts?.mutation) {
    return notRequired(
      "tool_preflight",
      "read-only or non-mutating action does not require protected preflight",
    );
  }
  const admission = evaluateCleanupCrewMissionAdmissionGate(contract);
  if (admission.state !== "pass") {
    return fail("tool_preflight", "mutation blocked because mission admission is not valid", [
      "deny_mutation",
      ...admission.obligations,
    ]);
  }
  const toolName = facts.toolName ?? "";
  const targetPath = facts.targetPath ?? "";
  const obligations: string[] = [];
  if (!hasText(toolName)) {
    obligations.push("missing:toolName");
  }
  if (contract?.forbiddenTools?.includes(toolName)) {
    obligations.push("forbidden_tool");
  }
  if (hasValues(contract?.allowedTools) && !contract?.allowedTools?.includes(toolName)) {
    obligations.push("tool_not_allowlisted");
  }
  if (
    hasText(targetPath) &&
    contract?.forbiddenPaths?.some((path) => targetPath.startsWith(path))
  ) {
    obligations.push("forbidden_path");
  }
  if (
    hasText(targetPath) &&
    hasValues(contract?.allowedPaths) &&
    !contract?.allowedPaths?.some((path) => targetPath.startsWith(path))
  ) {
    obligations.push("path_not_allowlisted");
  }
  if (facts.idempotencyKeyPresent !== true) {
    obligations.push("missing_idempotency_key");
  }
  if (facts.rollbackProofPreserved !== true) {
    obligations.push("rollback_or_proof_not_preserved");
  }
  if (facts.approvalClassSatisfied !== true) {
    obligations.push("approval_class_not_satisfied");
  }
  if (facts.lawfulOwnerMatched !== true) {
    obligations.push("lawful_owner_mismatch");
  }
  if (obligations.length > 0) {
    return fail("tool_preflight", "mutation does not satisfy Cleanup Crew runtime preflight", [
      ...obligations,
      "deny_mutation",
    ]);
  }
  return pass("tool_preflight", "mutation satisfies Cleanup Crew runtime preflight");
}

export function evaluateCleanupCrewToolResultGate(
  facts: CleanupCrewRuntimeToolResultFacts | undefined,
): CleanupCrewRuntimeGateDecision {
  if (!facts?.status) {
    return notRequired("tool_result", "no tool result to classify");
  }
  if (facts.contradictedByLiveProof === true) {
    return fail("tool_result", "tool result is contradicted by live proof", [
      "run_read_only_reconciliation",
      "deny_closeout",
    ]);
  }
  if (facts.status !== "passed" || facts.proofPresent !== true) {
    return fail(
      "tool_result",
      "tool result is failed, partial, interrupted, ambiguous, pending, or unproven",
      ["route_cleanup_crew_recovery", "deny_closeout"],
    );
  }
  return pass("tool_result", "tool result passed with proof");
}

export function evaluateCleanupCrewReportDeliveryGate(
  facts: CleanupCrewRuntimeReportFacts | undefined,
): CleanupCrewRuntimeGateDecision {
  if (facts?.reportRequired !== true) {
    return notRequired("report_delivery", "report delivery is not required for this step");
  }
  if (!hasText(facts.reportArtifactPath)) {
    return fail("report_delivery", "required report artifact is missing", [
      "write_report_artifact",
      "deny_closeout",
    ]);
  }
  if (facts.chatDeliveryVerified === true || facts.laterSettlementVerified === true) {
    return pass("report_delivery", "Mark-facing report delivery is verified");
  }
  if (facts.explicitArtifactOnlyAllowed === true) {
    return pass("report_delivery", "operator explicitly allowed artifact-only delivery");
  }
  return fail(
    "report_delivery",
    "report artifact exists but Mark-facing delivery is not verified",
    [
      "create_or_update_pending_delivery_obligation",
      facts.deliveryFailureVisible === true
        ? "keep_delivery_failure_visible"
        : "record_delivery_failure_visibility",
      "deny_closeout",
    ],
  );
}

export function evaluateCleanupCrewPostReportContinuationGate(
  facts: CleanupCrewRuntimeContinuationFacts | undefined,
): CleanupCrewRuntimeGateDecision {
  if (facts?.broaderMissionOpen !== true || facts.reportDelivered !== true) {
    return notRequired("post_report_continuation", "no delivered report with broader open mission");
  }
  if (facts.operatorStopRequested === true) {
    return pass("post_report_continuation", "operator explicitly requested stop");
  }
  if (facts.wholeMissionComplete === true) {
    return pass("post_report_continuation", "whole mission is complete");
  }
  if (facts.verifiedHardStop === true || facts.durableCoverageKind) {
    return pass("post_report_continuation", "open mission has lawful durable coverage");
  }
  if (hasText(facts.nextExecutableAction)) {
    return pass(
      "post_report_continuation",
      "next executable action is present after report delivery",
    );
  }
  return fail(
    "post_report_continuation",
    "report delivered but open mission has no continuation or lawful coverage",
    ["dispatch_next_executable_action", "or_record_durable_coverage", "deny_terminal_stop"],
  );
}

export function evaluateCleanupCrewWatchdogCleanGate(
  facts: CleanupCrewRuntimeWatchdogFacts | undefined,
): CleanupCrewRuntimeGateDecision {
  if (!facts) {
    return notRequired("watchdog_clean", "watchdog clean was not requested");
  }
  const obligations: string[] = [];
  if (facts.needsReview === true) {
    obligations.push("route_watchdog_needs_review");
  }
  if (facts.suspiciousCount !== 0) {
    obligations.push("suspicious_count_not_zero");
  }
  for (const dimension of CLEANUP_WATCHDOG_CLEAN_DIMENSIONS) {
    if (facts.dimensions?.[dimension] !== true) {
      obligations.push(`missing_clean_dimension:${dimension}`);
    }
  }
  if (facts.policyVersion !== CLEANUP_WATCHDOG_POLICY_VERSION) {
    obligations.push("policy_version_mismatch");
  }
  if (facts.duplicateSuppressedOnlyChat !== true && facts.needsReview === true) {
    obligations.push("duplicate_suppression_must_not_suppress_action");
  }
  if (obligations.length > 0) {
    return fail("watchdog_clean", "watchdog cannot close clean without every required dimension", [
      ...obligations,
      "rerun_watchdog_after_repair",
    ]);
  }
  return pass("watchdog_clean", "watchdog clean dimensions and policy version pass");
}

export function evaluateCleanupCrewLiveRuntimeProofGate(
  facts: CleanupCrewRuntimeProofFacts | undefined,
): CleanupCrewRuntimeGateDecision {
  if (facts?.runtimeChangeRequired !== true) {
    return notRequired("live_runtime_proof", "runtime change proof is not required for this step");
  }
  const sameRevision =
    hasText(facts.sourceRevision) &&
    facts.sourceRevision === facts.buildRevision &&
    facts.sourceRevision === facts.liveRuntimeRevision;
  const obligations: string[] = [];
  if (!sameRevision) {
    obligations.push("source_build_runtime_revision_mismatch");
  }
  if (facts.postRestartAssetGuardPassed !== true) {
    obligations.push("post_restart_asset_guard_missing");
  }
  if (facts.taskAuditPassed !== true) {
    obligations.push("post_restart_task_audit_missing");
  }
  if (facts.blockedFlowProofPassed !== true) {
    obligations.push("post_restart_blocked_flow_proof_missing");
  }
  if (obligations.length > 0) {
    return fail("live_runtime_proof", "runtime-dependent closeout lacks live activation proof", [
      ...obligations,
      "deny_runtime_closeout",
    ]);
  }
  return pass("live_runtime_proof", "source, build, live runtime, and post-restart proof agree");
}

export function evaluateCleanupCrewHandoffInheritanceGate(
  facts: CleanupCrewRuntimeHandoffFacts | undefined,
): CleanupCrewRuntimeGateDecision {
  if (facts?.childExecutionRequested !== true) {
    return notRequired("handoff_inheritance", "child execution was not requested");
  }
  const obligations: string[] = [];
  if (facts.parentMissionContractInherited !== true) {
    obligations.push("inherit_parent_mission_contract");
  }
  if (facts.childScopeWithinParent !== true) {
    obligations.push("deny_child_scope_widening");
  }
  if (facts.parentCoverageValid !== true) {
    obligations.push("repair_parent_worker_coverage");
  }
  if (obligations.length > 0) {
    return fail(
      "handoff_inheritance",
      "child execution does not inherit the parent Cleanup Crew law",
      [...obligations, "deny_child_execution"],
    );
  }
  return pass("handoff_inheritance", "child execution inherits parent mission law and coverage");
}

export function evaluateCleanupCrewTraceEvalGate(
  facts: CleanupCrewRuntimeTraceEvalFacts | undefined,
): CleanupCrewRuntimeGateDecision {
  if (facts?.required !== true) {
    return notRequired("trace_eval_replay", "trace/eval replay is not required for this step");
  }
  const obligations: string[] = [];
  if (facts.tracesCaptured !== true) {
    obligations.push("capture_runtime_traces");
  }
  if (facts.replayCasesPassed !== true) {
    obligations.push("run_cleanup_crew_replay_cases");
  }
  if (facts.promptInjectionCasesPassed !== true) {
    obligations.push("run_prompt_injection_cases");
  }
  if (obligations.length > 0) {
    return fail("trace_eval_replay", "trace/eval replay requirements are incomplete", [
      ...obligations,
      "deny_final_closeout",
    ]);
  }
  return pass("trace_eval_replay", "trace/eval replay requirements pass");
}

export function evaluateCleanupCrewRuntimeEnforcement(
  facts: CleanupCrewRuntimeEnforcementFacts,
): CleanupCrewRuntimeEnforcementDecision {
  const gates = [
    evaluateCleanupCrewMissionAdmissionGate(facts.contract),
    evaluateCleanupCrewToolPreflightGate(facts.contract, facts.toolPreflight),
    evaluateCleanupCrewToolResultGate(facts.toolResult),
    evaluateCleanupCrewReportDeliveryGate(facts.report),
    evaluateCleanupCrewPostReportContinuationGate(facts.continuation),
    evaluateCleanupCrewWatchdogCleanGate(facts.watchdog),
    evaluateCleanupCrewLiveRuntimeProofGate(facts.runtimeProof),
    evaluateCleanupCrewHandoffInheritanceGate(facts.handoff),
    evaluateCleanupCrewTraceEvalGate(facts.traceEval),
  ];
  const failedGate = gates.find((gate) => gate.state === "fail");
  return {
    schema: CLEANUP_CREW_RUNTIME_ENFORCEMENT_SCHEMA,
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    allowedToAdvance: !failedGate,
    allowedToCloseMission: !failedGate,
    gates,
    nextAction: failedGate
      ? (failedGate.obligations[0] ?? `repair_${failedGate.gate}`)
      : "continue_cleanup_crew_execution",
  };
}
