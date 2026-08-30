import {
  CLEANUP_WATCHDOG_CLEAN_DIMENSIONS,
  CLEANUP_WATCHDOG_POLICY_VERSION,
  type CleanupWatchdogCleanDimension,
} from "./cleanup-watchdog-policy.js";

export const CLEANUP_CREW_RUNTIME_ENFORCEMENT_SCHEMA =
  "openclaw.cleanup_crew_runtime_enforcement.v1" as const;

export const CLEANUP_CREW_ENFORCEMENT_DECISION_SCHEMA =
  "openclaw.cleanup_crew_enforcement_decision.v1" as const;

export const CLEANUP_CREW_ADVISORY_RECEIPT_SCHEMA =
  "openclaw.cleanup_crew_advisory_receipt.v1" as const;

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

export type CleanupCrewRuntimeBoundaryId = CleanupCrewRuntimeGateId;

export type CleanupCrewRuntimeEnforcementMode =
  | "disabled"
  | "advisory"
  | "shadow_block"
  | "enforce";

export type CleanupCrewRuntimeDecisionValue =
  | "allow"
  | "would_allow"
  | "would_block"
  | "block"
  | "require_review";

export type CleanupCrewRuntimeBoundary = {
  id: CleanupCrewRuntimeBoundaryId;
  label: string;
  runtimeOwner: string;
  purpose: string;
  sourceRefs: readonly string[];
  firstImplementationSlice: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  behaviorChangingBeforeSlice: false | 2 | 3 | 4 | 5 | 6;
};

export type CleanupCrewRuntimeDecisionAction = {
  id: string;
  kind: CleanupCrewRuntimeBoundaryId;
  target: string;
};

export type CleanupCrewRuntimeDecisionProofRef = {
  kind: "source" | "authority" | "test" | "receipt" | "watchdog" | "runtime" | "closeout";
  ref: string;
  sha256?: string;
};

export type CleanupCrewRuntimeAuditSink = {
  kind: "none_slice_0" | "artifact" | "ledger" | "receipt";
  ref: string;
};

export type CleanupCrewRuntimeEnforcementDecisionRecord = {
  schema: typeof CLEANUP_CREW_ENFORCEMENT_DECISION_SCHEMA;
  mode: CleanupCrewRuntimeEnforcementMode;
  boundary: CleanupCrewRuntimeBoundaryId;
  action: CleanupCrewRuntimeDecisionAction;
  decision: CleanupCrewRuntimeDecisionValue;
  reason: string;
  proof: readonly CleanupCrewRuntimeDecisionProofRef[];
  sourcePolicyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  auditSink: CleanupCrewRuntimeAuditSink;
  evaluatedAt: string;
};

export type CleanupCrewRuntimeAdvisoryDecisionValue =
  | "would_allow"
  | "would_block"
  | "require_review";

export type CleanupCrewRuntimeCanaryExpectation = "would_allow" | "would_block";

export type CleanupCrewRuntimeCanaryMarkerKind =
  | "good_work_canary"
  | "bad_work_canary"
  | "shadow_observation";

export type CleanupCrewRuntimeCanaryAccuracy =
  | "matched_expectation"
  | "false_positive"
  | "false_negative"
  | "review_required";

export type CleanupCrewRuntimeCanaryInput = {
  id: string;
  kind: CleanupCrewRuntimeCanaryMarkerKind;
  expectation: CleanupCrewRuntimeCanaryExpectation;
};

export type CleanupCrewRuntimeCanaryMarker = CleanupCrewRuntimeCanaryInput & {
  actualDecision: CleanupCrewRuntimeAdvisoryDecisionValue;
  accuracy: CleanupCrewRuntimeCanaryAccuracy;
};

export type CleanupCrewRuntimeAdvisoryReceipt = {
  schema: typeof CLEANUP_CREW_ADVISORY_RECEIPT_SCHEMA;
  mode: "advisory";
  advisoryOnly: true;
  executionAllowed: true;
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  decisionRecord: CleanupCrewRuntimeEnforcementDecisionRecord;
  enforcementEvaluation: CleanupCrewRuntimeEnforcementDecision;
  failedGate?: CleanupCrewRuntimeGateDecision;
  falsePositiveMarker?: boolean;
  falseNegativeMarker?: boolean;
  canary?: CleanupCrewRuntimeCanaryMarker;
  ledgerShape: {
    sink: CleanupCrewRuntimeAuditSink;
    summaryKey: string;
  };
};

export type CleanupCrewRuntimeAdvisoryInput = {
  facts: CleanupCrewRuntimeEnforcementFacts;
  action: CleanupCrewRuntimeDecisionAction;
  auditSink?: CleanupCrewRuntimeAuditSink;
  proof?: readonly CleanupCrewRuntimeDecisionProofRef[];
  evaluatedAt: string;
  canary?: CleanupCrewRuntimeCanaryInput;
};

export type CleanupCrewRuntimeAdvisorySummary = {
  schema: "openclaw.cleanup_crew_advisory_summary.v1";
  total: number;
  wouldAllow: number;
  wouldBlock: number;
  requireReview: number;
  falsePositiveMarkers: number;
  falseNegativeMarkers: number;
};

export const CLEANUP_CREW_RUNTIME_BOUNDARIES = [
  {
    id: "mission_admission",
    label: "Cleanup Crew mission admission",
    runtimeOwner: "governance mission admission",
    purpose:
      "Confirm the active mission, controlling plan, lawful owner, scope, proof, and stop conditions before Cleanup Crew work starts.",
    sourceRefs: [
      "src/governance/governed-mission-admission.ts",
      "src/governance/governed-mission-contract.ts",
      "src/governance/cleanup-crew-runtime-enforcement.ts",
    ],
    firstImplementationSlice: 0,
    behaviorChangingBeforeSlice: false,
  },
  {
    id: "tool_preflight",
    label: "Protected tool preflight",
    runtimeOwner: "agent before-tool-call seam",
    purpose:
      "Classify risky, mutating, external, admin, taskflow, cron, gateway, restart, and file actions before side effects happen.",
    sourceRefs: [
      "src/agents/agent-tools.before-tool-call.ts",
      "src/governance/mission-specific-tool-enforcement.ts",
      "src/governance/protected-action-policy.ts",
    ],
    firstImplementationSlice: 2,
    behaviorChangingBeforeSlice: 2,
  },
  {
    id: "tool_result",
    label: "Tool result classification",
    runtimeOwner: "agent tool-result middleware",
    purpose:
      "Classify failed, partial, interrupted, ambiguous, pending, or live-proof-contradicted tool results before closeout can rely on them.",
    sourceRefs: [
      "src/agents/harness/tool-result-middleware.ts",
      "src/plugins/agent-tool-result-middleware.ts",
      "src/plugins/agent-tool-result-middleware-types.ts",
    ],
    firstImplementationSlice: 2,
    behaviorChangingBeforeSlice: 2,
  },
  {
    id: "report_delivery",
    label: "Report and closeout acceptance",
    runtimeOwner: "report delivery guard",
    purpose:
      "Require Mark-facing delivery, export proof, and closeout truth fields before a Cleanup Crew report can settle work as done.",
    sourceRefs: [
      "src/agents/report-delivery-guard.ts",
      "src/governance/governed-closeout-validator.ts",
      "src/governance/false-closeout-admission-controller.ts",
    ],
    firstImplementationSlice: 3,
    behaviorChangingBeforeSlice: 3,
  },
  {
    id: "post_report_continuation",
    label: "Post-report continuation",
    runtimeOwner: "Cleanup Crew TaskFlow continuation",
    purpose:
      "Prevent milestone reports from becoming terminal stops while broader Cleanup Crew work remains open.",
    sourceRefs: [
      "src/agents/report-delivery-guard.ts",
      "src/tasks/foreground-cleanup-crew-taskflow.ts",
      "src/plugins/runtime/runtime-taskflow.ts",
    ],
    firstImplementationSlice: 4,
    behaviorChangingBeforeSlice: 4,
  },
  {
    id: "watchdog_clean",
    label: "Watchdog NEEDS_REVIEW handling",
    runtimeOwner: "Cleanup Watchdog controller",
    purpose:
      "Keep NEEDS_REVIEW as repair/routing work until a fresh clean watchdog receipt proves every required dimension.",
    sourceRefs: [
      "src/governance/cleanup-watchdog-policy.ts",
      "src/governance/cleanup-watchdog-controller.ts",
      "src/governance/cleanup-watchdog-live-controller.ts",
    ],
    firstImplementationSlice: 4,
    behaviorChangingBeforeSlice: 4,
  },
  {
    id: "live_runtime_proof",
    label: "Restart and live runtime proof",
    runtimeOwner: "Gateway restart and runtime identity",
    purpose:
      "Require source, build, live runtime identity, asset guard, task audit, and blocked-flow proof before restart-dependent work can close.",
    sourceRefs: [
      "src/gateway/server-methods/restart.ts",
      "src/infra/restart.ts",
      "src/infra/restart-handoff.ts",
    ],
    firstImplementationSlice: 5,
    behaviorChangingBeforeSlice: 5,
  },
  {
    id: "handoff_inheritance",
    label: "Handoff inheritance",
    runtimeOwner: "child execution and restart recovery",
    purpose:
      "Require child or resumed work to inherit the parent mission law, scope, and coverage before it can execute as Cleanup Crew.",
    sourceRefs: [
      "src/governance/child-execution-inheritance.ts",
      "src/agents/main-session-restart-recovery.ts",
      "src/agents/subagent-orphan-recovery.ts",
    ],
    firstImplementationSlice: 5,
    behaviorChangingBeforeSlice: 5,
  },
  {
    id: "trace_eval_replay",
    label: "Advisory and shadow replay",
    runtimeOwner: "advisory activation evidence",
    purpose:
      "Compare advisory and shadow decisions against controlled good/bad cases before any hard enforcement activation.",
    sourceRefs: [
      "src/governance/cleanup-crew-runtime-enforcement.ts",
      "scripts/cleanup-watchdog-live-controller.mjs",
      "src/governance/sop-enforcement-adversarial-validation.test.ts",
    ],
    firstImplementationSlice: 6,
    behaviorChangingBeforeSlice: 6,
  },
] as const satisfies readonly CleanupCrewRuntimeBoundary[];

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
  riskClasses?: readonly CleanupCrewRuntimeToolRiskClass[];
  mutation?: boolean;
  activeMissionScopePresent?: boolean;
  controllingBuildPlanPresent?: boolean;
  permissionMode?: CleanupCrewRuntimeToolPermissionMode;
  idempotencyKeyPresent?: boolean;
  rollbackProofPreserved?: boolean;
  approvalClassSatisfied?: boolean;
  lawfulOwnerMatched?: boolean;
};

export const CLEANUP_CREW_RUNTIME_TOOL_RISK_CLASSES = [
  "read",
  "write",
  "admin",
  "destructive",
  "external-send",
  "restart",
  "taskflow",
  "cron",
  "file-write",
  "shell",
  "plugin-management",
  "node-action",
] as const;

export type CleanupCrewRuntimeToolRiskClass =
  (typeof CLEANUP_CREW_RUNTIME_TOOL_RISK_CLASSES)[number];

export type CleanupCrewRuntimeToolPermissionMode =
  | "read_only"
  | "scoped_write"
  | "admin"
  | "restart"
  | "external_send";

export type CleanupCrewRuntimeToolPreflightInput = {
  toolName: string;
  params?: unknown;
  targetPath?: string;
  contract?: CleanupCrewRuntimeMissionContract;
  activeMissionScope?: string;
  permissionMode?: CleanupCrewRuntimeToolPermissionMode;
  approvalClassSatisfied?: boolean;
  lawfulOwnerMatched?: boolean;
  idempotencyKeyPresent?: boolean;
  rollbackProofPreserved?: boolean;
};

export type CleanupCrewRuntimeToolPreflightDecision = {
  riskClasses: CleanupCrewRuntimeToolRiskClass[];
  facts: CleanupCrewRuntimeToolPreflightFacts;
  gate: CleanupCrewRuntimeGateDecision;
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
  activeWorkPreflightPassed?: boolean;
  restartDeferralStatus?: "not_deferred" | "deferred" | "blocked" | "stale";
  controllingPlanPresent?: boolean;
  restartCheckpointCreated?: boolean;
  restartHandoffCheckpointCreated?: boolean;
  allowedRestartMode?: "safe" | "safe_skip_deferral" | "supervisor_handoff";
  restartRequestStatus?: "scheduled" | "deferred" | "blocked" | "failed" | "coalesced" | "noop";
  postRestartResumeProofPresent?: boolean;
  sourceRevision?: string;
  buildRevision?: string;
  liveRuntimeRevision?: string;
  postRestartAssetGuardPassed?: boolean;
  taskAuditPassed?: boolean;
  blockedFlowProofPassed?: boolean;
};

export type CleanupCrewRuntimeHandoffFacts = {
  handoffRequested?: boolean;
  childExecutionRequested?: boolean;
  parentMissionContractInherited?: boolean;
  childScopeWithinParent?: boolean;
  parentCoverageValid?: boolean;
  lawfulNextOwner?: string;
  exactNextAction?: string;
  proofRefs?: readonly string[];
  openClosedTruth?: "open" | "closed";
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

function normalizedToolName(value: string): string {
  return value.trim().toLowerCase().replace(/_/gu, "-");
}

function commandParam(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  for (const key of ["cmd", "command", "script", "input"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function hasBooleanParam(params: unknown, keys: readonly string[]): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const record = params as Record<string, unknown>;
  return keys.some((key) => record[key] === true);
}

function addRisk(
  risks: Set<CleanupCrewRuntimeToolRiskClass>,
  risk: CleanupCrewRuntimeToolRiskClass,
): void {
  risks.add(risk);
}

export function classifyCleanupCrewRuntimeToolRisk(
  toolName: string,
  params?: unknown,
): CleanupCrewRuntimeToolRiskClass[] {
  const normalized = normalizedToolName(toolName);
  const command = commandParam(params)?.toLowerCase() ?? "";
  const risks = new Set<CleanupCrewRuntimeToolRiskClass>();
  if (/(^|\.|-)(read|find|grep|ls|search|fetch|open|status|show|view|list)$/u.test(normalized)) {
    addRisk(risks, "read");
  }
  if (
    /(^|\.|-)(write|edit|apply-patch|multi-edit|delete|move|rename|create-file|file-write)$/u.test(
      normalized,
    )
  ) {
    addRisk(risks, "write");
  }
  if (/(write|edit|apply-patch|file-write)/u.test(normalized)) {
    addRisk(risks, "file-write");
  }
  if (/(exec|shell|bash|terminal|run-command)/u.test(normalized) || command) {
    addRisk(risks, "shell");
  }
  if (/\b(rm|unlink|rmdir|git\s+reset|git\s+clean|dd|mkfs|truncate)\b/u.test(command)) {
    addRisk(risks, "destructive");
  }
  if (/\b(restart|reload|systemctl|service)\b/u.test(command) || normalized.includes("restart")) {
    addRisk(risks, "restart");
  }
  if (/(admin|config|permission|access|domain|deploy|database|gateway)/u.test(normalized)) {
    addRisk(risks, "admin");
  }
  if (/(message|send|email|slack|discord|telegram|sms|tweet|post|publish)/u.test(normalized)) {
    addRisk(risks, "external-send");
  }
  if (/(taskflow|task-flow|task|session|spawn|subagent)/u.test(normalized)) {
    addRisk(risks, "taskflow");
  }
  if (/(cron|schedule|remind)/u.test(normalized)) {
    addRisk(risks, "cron");
  }
  if (/(plugin|connector|app-permission|install|uninstall)/u.test(normalized)) {
    addRisk(risks, "plugin-management");
  }
  if (/(node|nodes|device)/u.test(normalized) || hasBooleanParam(params, ["nodeAction"])) {
    addRisk(risks, "node-action");
  }
  if (risks.size === 0) {
    addRisk(risks, "read");
  }
  return [...risks];
}

function requiresCleanupCrewAuthority(
  risks: readonly CleanupCrewRuntimeToolRiskClass[] | undefined,
): boolean {
  return (risks ?? []).some((risk) =>
    [
      "write",
      "admin",
      "destructive",
      "external-send",
      "restart",
      "taskflow",
      "cron",
      "file-write",
      "shell",
      "plugin-management",
      "node-action",
    ].includes(risk),
  );
}

function permissionModeAllowsRisk(
  permissionMode: CleanupCrewRuntimeToolPermissionMode | undefined,
  risk: CleanupCrewRuntimeToolRiskClass,
): boolean {
  if (risk === "read") {
    return true;
  }
  if (risk === "write" || risk === "file-write" || risk === "shell" || risk === "taskflow") {
    return permissionMode === "scoped_write" || permissionMode === "admin";
  }
  if (risk === "restart") {
    return permissionMode === "restart" || permissionMode === "admin";
  }
  if (risk === "external-send") {
    return permissionMode === "external_send" || permissionMode === "admin";
  }
  return permissionMode === "admin";
}

export function evaluateCleanupCrewToolPreflight(
  input: CleanupCrewRuntimeToolPreflightInput,
): CleanupCrewRuntimeToolPreflightDecision {
  const riskClasses = classifyCleanupCrewRuntimeToolRisk(input.toolName, input.params);
  const mutation = requiresCleanupCrewAuthority(riskClasses);
  const facts: CleanupCrewRuntimeToolPreflightFacts = {
    toolName: input.toolName,
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    riskClasses,
    mutation,
    activeMissionScopePresent: Boolean(input.activeMissionScope?.trim()),
    controllingBuildPlanPresent: Boolean(input.contract?.controllingPlanRef?.trim()),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    idempotencyKeyPresent: input.idempotencyKeyPresent ?? !mutation,
    rollbackProofPreserved: input.rollbackProofPreserved ?? !mutation,
    approvalClassSatisfied: input.approvalClassSatisfied ?? !mutation,
    lawfulOwnerMatched: input.lawfulOwnerMatched ?? Boolean(input.contract?.lawfulOwner?.trim()),
  };
  return {
    riskClasses,
    facts,
    gate: evaluateCleanupCrewToolPreflightGate(input.contract, facts),
  };
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
  if (facts.activeMissionScopePresent !== true) {
    obligations.push("missing_active_mission_scope");
  }
  if (facts.controllingBuildPlanPresent !== true) {
    obligations.push("missing_controlling_build_plan");
  }
  for (const risk of facts.riskClasses ?? []) {
    if (!permissionModeAllowsRisk(facts.permissionMode, risk)) {
      obligations.push(`permission_mode_not_allowed:${risk}`);
    }
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
  const obligations: string[] = [];
  if (facts.activeWorkPreflightPassed !== true) {
    obligations.push("active_work_preflight_missing");
  }
  if (facts.restartDeferralStatus !== "not_deferred") {
    obligations.push(
      facts.restartDeferralStatus === "stale"
        ? "restart_preflight_stale"
        : "restart_deferral_not_clear",
    );
  }
  if (facts.controllingPlanPresent !== true) {
    obligations.push("controlling_plan_missing");
  }
  if (facts.restartCheckpointCreated !== true) {
    obligations.push("pre_restart_checkpoint_missing");
  }
  if (facts.restartHandoffCheckpointCreated !== true) {
    obligations.push("restart_handoff_checkpoint_missing");
  }
  if (!facts.allowedRestartMode) {
    obligations.push("allowed_restart_mode_missing");
  }
  if (
    facts.restartRequestStatus === "blocked" ||
    facts.restartRequestStatus === "failed" ||
    facts.restartRequestStatus === "coalesced" ||
    facts.restartRequestStatus === "noop"
  ) {
    obligations.push(`restart_request_not_completed:${facts.restartRequestStatus}`);
  }
  if (!facts.restartRequestStatus) {
    obligations.push("restart_request_status_missing");
  }
  if (facts.postRestartResumeProofPresent !== true) {
    obligations.push("post_restart_resume_proof_missing");
  }
  const sameRevision =
    hasText(facts.sourceRevision) &&
    facts.sourceRevision === facts.buildRevision &&
    facts.sourceRevision === facts.liveRuntimeRevision;
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
    return fail(
      "live_runtime_proof",
      "runtime-dependent closeout lacks restart handoff and live activation proof",
      [...obligations, "deny_runtime_closeout"],
    );
  }
  return pass(
    "live_runtime_proof",
    "restart preflight, checkpoint, handoff, live runtime, and post-restart proof agree",
  );
}

export function evaluateCleanupCrewHandoffInheritanceGate(
  facts: CleanupCrewRuntimeHandoffFacts | undefined,
): CleanupCrewRuntimeGateDecision {
  const handoffRequested =
    facts?.handoffRequested === true || facts?.childExecutionRequested === true;
  if (!handoffRequested) {
    return notRequired("handoff_inheritance", "handoff or child execution was not requested");
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
  if (!hasText(facts.lawfulNextOwner)) {
    obligations.push("record_lawful_next_owner");
  }
  if (!hasText(facts.exactNextAction)) {
    obligations.push("record_exact_next_action");
  }
  if (!hasValues(facts.proofRefs)) {
    obligations.push("record_handoff_proof");
  }
  if (facts.openClosedTruth !== "open" && facts.openClosedTruth !== "closed") {
    obligations.push("record_open_closed_truth");
  }
  if (obligations.length > 0) {
    return fail(
      "handoff_inheritance",
      "handoff does not record parent Cleanup Crew law, owner, next action, proof, and truth state",
      [...obligations, "deny_child_execution"],
    );
  }
  return pass(
    "handoff_inheritance",
    "handoff inherits parent mission law and records owner, next action, proof, and truth state",
  );
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

function advisoryDecisionFor(
  failedGate: CleanupCrewRuntimeGateDecision | undefined,
): CleanupCrewRuntimeAdvisoryDecisionValue {
  if (!failedGate) {
    return "would_allow";
  }
  if (failedGate.obligations.some((obligation) => obligation.includes("needs_review"))) {
    return "require_review";
  }
  return "would_block";
}

function advisoryReasonFor(
  decision: CleanupCrewRuntimeAdvisoryDecisionValue,
  failedGate: CleanupCrewRuntimeGateDecision | undefined,
): string {
  if (decision === "would_allow") {
    return "all Cleanup Crew runtime gates would allow this action in advisory evaluation";
  }
  if (decision === "require_review") {
    return `advisory evaluation found ${failedGate?.gate ?? "a gate"} requires review`;
  }
  return `advisory evaluation found ${failedGate?.gate ?? "a gate"} would block this action`;
}

function canaryAccuracyFor(
  expected: CleanupCrewRuntimeCanaryExpectation,
  actual: CleanupCrewRuntimeAdvisoryDecisionValue,
): CleanupCrewRuntimeCanaryAccuracy {
  if (actual === "require_review") {
    return "review_required";
  }
  if (expected === actual) {
    return "matched_expectation";
  }
  return expected === "would_allow" ? "false_positive" : "false_negative";
}

function buildCanaryMarker(
  canary: CleanupCrewRuntimeCanaryInput | undefined,
  decision: CleanupCrewRuntimeAdvisoryDecisionValue,
): CleanupCrewRuntimeCanaryMarker | undefined {
  if (!canary) {
    return undefined;
  }
  return {
    ...canary,
    actualDecision: decision,
    accuracy: canaryAccuracyFor(canary.expectation, decision),
  };
}

function defaultAdvisorySink(): CleanupCrewRuntimeAuditSink {
  return {
    kind: "receipt",
    ref: "source-local advisory receipt; no live runtime ledger write in Slice 1",
  };
}

function defaultAdvisoryProof(): readonly CleanupCrewRuntimeDecisionProofRef[] {
  return [
    {
      kind: "source",
      ref: "src/governance/cleanup-crew-runtime-enforcement.ts",
    },
  ];
}

export function evaluateCleanupCrewRuntimeAdvisory(
  input: CleanupCrewRuntimeAdvisoryInput,
): CleanupCrewRuntimeAdvisoryReceipt {
  const enforcementEvaluation = evaluateCleanupCrewRuntimeEnforcement(input.facts);
  const failedGate = enforcementEvaluation.gates.find((gate) => gate.state === "fail");
  const decision = advisoryDecisionFor(failedGate);
  const canary = buildCanaryMarker(input.canary, decision);
  const auditSink = input.auditSink ?? defaultAdvisorySink();
  const boundary = failedGate?.gate ?? input.action.kind;
  const decisionRecord: CleanupCrewRuntimeEnforcementDecisionRecord = {
    schema: CLEANUP_CREW_ENFORCEMENT_DECISION_SCHEMA,
    mode: "advisory",
    boundary,
    action: input.action,
    decision,
    reason: advisoryReasonFor(decision, failedGate),
    proof: input.proof ?? defaultAdvisoryProof(),
    sourcePolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    auditSink,
    evaluatedAt: input.evaluatedAt,
  };

  return {
    schema: CLEANUP_CREW_ADVISORY_RECEIPT_SCHEMA,
    mode: "advisory",
    advisoryOnly: true,
    executionAllowed: true,
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    decisionRecord,
    enforcementEvaluation,
    ...(failedGate ? { failedGate } : {}),
    falsePositiveMarker: canary?.accuracy === "false_positive",
    falseNegativeMarker: canary?.accuracy === "false_negative",
    ...(canary ? { canary } : {}),
    ledgerShape: {
      sink: auditSink,
      summaryKey: `${boundary}:${decision}`,
    },
  };
}

export function summarizeCleanupCrewRuntimeAdvisoryReceipts(
  receipts: readonly CleanupCrewRuntimeAdvisoryReceipt[],
): CleanupCrewRuntimeAdvisorySummary {
  return {
    schema: "openclaw.cleanup_crew_advisory_summary.v1",
    total: receipts.length,
    wouldAllow: receipts.filter((receipt) => receipt.decisionRecord.decision === "would_allow")
      .length,
    wouldBlock: receipts.filter((receipt) => receipt.decisionRecord.decision === "would_block")
      .length,
    requireReview: receipts.filter(
      (receipt) => receipt.decisionRecord.decision === "require_review",
    ).length,
    falsePositiveMarkers: receipts.filter((receipt) => receipt.falsePositiveMarker === true).length,
    falseNegativeMarkers: receipts.filter((receipt) => receipt.falseNegativeMarker === true).length,
  };
}
