import {
  type CleanupWatchdogFindingCategory,
  type CleanupWatchdogPriorityCode,
  type CleanupWatchdogCoverageInput,
  CLEANUP_WATCHDOG_ACTIVATION_GATES,
  CLEANUP_WATCHDOG_POLICY_VERSION,
  canCleanupWatchdogCloseClean,
  compareCleanupWatchdogPriority,
  evaluateCleanupWatchdogCoverage,
  getCleanupWatchdogPriority,
  isCleanupWatchdogPolicyVersionCompatible,
} from "./cleanup-watchdog-policy.js";
import type { GovernedMissionStateValue } from "./governed-mission-state.js";

export type CleanupWatchdogControllerMode = "shadow_observe" | "enforce";

export type CleanupWatchdogControllerFinding = {
  findingId: string;
  category: CleanupWatchdogFindingCategory;
  entityType: string;
  entityId: string;
  evidence: readonly string[];
  priority?: CleanupWatchdogPriorityCode;
  repairTaskRequired: boolean;
  preemptsLowerPriorityWork: boolean;
  reason: string;
};

export type CleanupWatchdogControllerInput = {
  mode: CleanupWatchdogControllerMode;
  suspiciousCount: number;
  cleanDimensions: {
    record_integrity: boolean;
    worker_coverage: boolean;
    continuation_readiness: boolean;
    delivery_completeness: boolean;
    runtime_health: boolean;
    repair_closure: boolean;
    policy_version: boolean;
  };
  missionCoverage: CleanupWatchdogCoverageInput & {
    missionId: string;
  };
  findings?: readonly Omit<
    CleanupWatchdogControllerFinding,
    "priority" | "repairTaskRequired" | "preemptsLowerPriorityWork"
  >[];
  observedPolicyVersion?: string | null;
  governedMissionState?: {
    state: GovernedMissionStateValue;
    proofCurrent: boolean;
    authoritativeCloseoutPassed?: boolean;
    requiredReleaseDecisionPassed?: boolean;
    enforcementHealthOk?: boolean;
  };
};

export type CleanupWatchdogControllerDecision = {
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  mode: CleanupWatchdogControllerMode;
  canCloseClean: boolean;
  coverageOk: boolean;
  policyVersionOk: boolean;
  selectedPriority?: CleanupWatchdogPriorityCode;
  orderedFindings: readonly CleanupWatchdogControllerFinding[];
  requiredRepairTasks: readonly CleanupWatchdogControllerFinding[];
  enforcementActions: readonly string[];
  shadowDisagreements: readonly string[];
  governedPausedStateOk: boolean;
  watchdogMayDeclareMissionSuccess: false;
};

export type CleanupWatchdogActivationMode = "shadow_observe" | "enforce";

export type CleanupWatchdogActivationGateInput = {
  requestedMode: CleanupWatchdogActivationMode;
  policySchemaGenerated: boolean;
  sopParityValidated: boolean;
  sourceBuiltRuntimeMatch: boolean;
  watchdogClean: boolean;
  knownRepairStateCovered?: boolean;
  workerCoverageProven: boolean;
  shadowDecisionsStable: boolean;
  shadowDisagreements?: readonly string[];
  repairTasksDrained: boolean;
  grantReviewPassed: boolean;
  rollbackPlanVerified: boolean;
  productionPaused: boolean;
  trinityUnstarted: boolean;
  controlPlanePhase2Paused: boolean;
};

export type CleanupWatchdogActivationGateDecision = {
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  requestedMode: CleanupWatchdogActivationMode;
  effectiveMode: CleanupWatchdogActivationMode;
  state: "shadow_required" | "enforcement_allowed" | "rollback_required";
  allowedToEnforce: boolean;
  rollbackRequired: boolean;
  missingGates: readonly string[];
  requiredActions: readonly string[];
};

export type CleanupWatchdogReceiptItemSnapshot = {
  entity_type?: string;
  entity_id?: string;
  category?: string;
  reason?: string;
  label?: string;
  proof?: {
    parent_flow_id?: string | null;
    owner_key?: string | null;
    child_session_key?: string | null;
    current_step?: string | null;
    run_id?: string | null;
    active_child_tasks?: number;
    lost_child_task_ids?: string[];
    replacement_task_id?: string | null;
  };
};

export type CleanupWatchdogReceiptSnapshot = {
  policy_version?: string | null;
  clean_dimensions_required?: readonly string[];
  summary?: {
    items_suspicious?: number;
  };
  decisions?: {
    healthy_items?: readonly CleanupWatchdogReceiptItemSnapshot[];
    suspicious_items?: readonly CleanupWatchdogReceiptItemSnapshot[];
  };
};

const ACTIVATION_GATE_KEYS = [
  ["policySchemaGenerated", "policy_schema_generated"],
  ["sopParityValidated", "sop_parity_validated"],
  ["sourceBuiltRuntimeMatch", "source_built_runtime_match"],
  ["watchdogClean", "watchdog_clean"],
  ["workerCoverageProven", "worker_coverage_proven"],
  ["shadowDecisionsStable", "shadow_decisions_stable"],
  ["repairTasksDrained", "repair_tasks_drained"],
  ["grantReviewPassed", "grant_review_passed"],
  ["rollbackPlanVerified", "rollback_plan_verified"],
  ["productionPaused", "production_paused"],
  ["trinityUnstarted", "trinity_unstarted"],
  ["controlPlanePhase2Paused", "control_plane_phase2_paused"],
] as const satisfies readonly (readonly [
  keyof CleanupWatchdogActivationGateInput,
  (typeof CLEANUP_WATCHDOG_ACTIVATION_GATES)[number],
])[];

const CANONICAL_RECEIPT_CATEGORIES = new Set<CleanupWatchdogFindingCategory>([
  "safety_or_destructive_risk",
  "duplicate_execution_or_fencing_failure",
  "active_no_worker",
  "lost_ownership",
  "corrupted_state",
  "corrupted_pointer",
  "corrupted_identity",
  "corrupted_continuation",
  "stale_lease",
  "revision_mismatch",
  "restart_recovery_failure",
  "runtime_recovery_failure",
  "mission_resumption_missing",
  "missing_correctness_proof",
  "policy_version_mismatch",
  "review_required_for_safe_work",
  "pending_report_delivery",
  "pending_milestone_report",
  "stale_artifact",
  "non_executable_reporting_debt",
]);

export function evaluateCleanupWatchdogActivationGate(
  input: CleanupWatchdogActivationGateInput,
): CleanupWatchdogActivationGateDecision {
  const missingGates: string[] = ACTIVATION_GATE_KEYS.filter(([key]) => input[key] !== true).map(
    ([, label]) => label,
  );
  if (input.watchdogClean !== true && input.knownRepairStateCovered === true) {
    const idx = missingGates.indexOf("watchdog_clean");
    if (idx >= 0) {
      missingGates.splice(idx, 1);
    }
  }
  const shadowDisagreements = input.shadowDisagreements ?? [];
  const unsafeShadow = shadowDisagreements.length > 0;
  if (unsafeShadow) {
    missingGates.push("shadow_disagreements_empty");
  }

  const allowedToEnforce = input.requestedMode === "enforce" && missingGates.length === 0;
  const rollbackRequired = input.requestedMode === "enforce" && !allowedToEnforce;
  return {
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    requestedMode: input.requestedMode,
    effectiveMode: allowedToEnforce ? "enforce" : "shadow_observe",
    state: allowedToEnforce
      ? "enforcement_allowed"
      : rollbackRequired
        ? "rollback_required"
        : "shadow_required",
    allowedToEnforce,
    rollbackRequired,
    missingGates,
    requiredActions: allowedToEnforce
      ? ["activate_controller_enforcement_incrementally"]
      : [
          rollbackRequired
            ? "disable_controller_repair_mode_keep_observe_only"
            : "keep_shadow_observe",
          "repair_missing_activation_gates",
          "rerun_shadow_comparison_and_watchdog",
        ],
  };
}

function canonicalReceiptCategory(value: string | undefined): CleanupWatchdogFindingCategory {
  if (value && CANONICAL_RECEIPT_CATEGORIES.has(value as CleanupWatchdogFindingCategory)) {
    return value as CleanupWatchdogFindingCategory;
  }
  if (value === "monitor_disabled") {
    return "runtime_recovery_failure";
  }
  if (value === "needs_final_delivery" || value === "source_delivery_failed") {
    return "pending_report_delivery";
  }
  if (value === "lost") {
    return "lost_ownership";
  }
  if (value === "stale") {
    return "stale_lease";
  }
  return "missing_correctness_proof";
}

export function createCleanupWatchdogShadowInputFromReceipt(params: {
  receipt: CleanupWatchdogReceiptSnapshot;
  missionId: string;
  mode?: CleanupWatchdogControllerMode;
}): CleanupWatchdogControllerInput {
  const healthyItems = params.receipt.decisions?.healthy_items ?? [];
  const suspiciousItems = params.receipt.decisions?.suspicious_items ?? [];
  const executorCount = healthyItems.filter(
    (item) =>
      item.entity_type === "task_run" &&
      item.category === "active_with_worker" &&
      item.proof?.parent_flow_id === params.missionId,
  ).length;
  const activeMission = healthyItems.find(
    (item) => item.entity_type === "flow_run" && item.entity_id === params.missionId,
  );
  const receiptSuspiciousCount = params.receipt.summary?.items_suspicious ?? suspiciousItems.length;
  const policyVersionOk = isCleanupWatchdogPolicyVersionCompatible(params.receipt.policy_version);
  return {
    mode: params.mode ?? "shadow_observe",
    suspiciousCount: receiptSuspiciousCount,
    observedPolicyVersion: params.receipt.policy_version ?? null,
    cleanDimensions: {
      record_integrity: true,
      worker_coverage: executorCount === 1,
      continuation_readiness:
        activeMission?.proof?.active_child_tasks === undefined ||
        activeMission.proof.active_child_tasks === executorCount,
      delivery_completeness: !suspiciousItems.some((item) =>
        ["pending_report_delivery", "pending_milestone_report", "needs_final_delivery"].includes(
          item.category ?? "",
        ),
      ),
      runtime_health: true,
      repair_closure: receiptSuspiciousCount === 0,
      policy_version: policyVersionOk,
    },
    missionCoverage: {
      missionId: params.missionId,
      unfinished: true,
      activeProduction: true,
      executorCount,
      executorLeaseCurrent: executorCount === 1,
    },
    findings: suspiciousItems.map((item, index) => ({
      findingId: `${params.missionId}:receipt:${item.entity_id ?? index}`,
      category: canonicalReceiptCategory(item.category),
      entityType: item.entity_type ?? "unknown",
      entityId: item.entity_id ?? "unknown",
      evidence: [item.category, item.reason].filter((value): value is string => Boolean(value)),
      reason: item.reason ?? "watchdog receipt suspicious item",
    })),
  };
}

export function reconcileCleanupWatchdogMission(
  input: CleanupWatchdogControllerInput,
): CleanupWatchdogControllerDecision {
  const coverage = evaluateCleanupWatchdogCoverage(input.missionCoverage);
  const governedPausedStateOk = isCurrentGovernedPausedState(input.governedMissionState);
  const staleGovernedPausedStateProof = isStaleGovernedPausedStateProof(input.governedMissionState);
  const awaitingCloseout =
    input.governedMissionState?.state === "AWAITING_CLOSEOUT" &&
    input.governedMissionState.proofCurrent === true;
  const releasePending =
    input.governedMissionState?.requiredReleaseDecisionPassed === false &&
    input.governedMissionState.proofCurrent === true;
  const enforcementHealthFailed =
    input.governedMissionState?.enforcementHealthOk === false &&
    input.governedMissionState.proofCurrent === true;
  const coverageOk = coverage.ok || governedPausedStateOk;
  const policyVersionOk = isCleanupWatchdogPolicyVersionCompatible(input.observedPolicyVersion);
  const cleanDimensions = {
    ...input.cleanDimensions,
    continuation_readiness:
      input.cleanDimensions.continuation_readiness && !staleGovernedPausedStateProof,
    worker_coverage: input.cleanDimensions.worker_coverage && coverageOk,
    delivery_completeness:
      input.cleanDimensions.delivery_completeness &&
      !(awaitingCloseout && input.governedMissionState?.authoritativeCloseoutPassed !== true) &&
      !releasePending,
    runtime_health: input.cleanDimensions.runtime_health && !enforcementHealthFailed,
    policy_version: input.cleanDimensions.policy_version && policyVersionOk,
  };
  const canCloseClean = canCleanupWatchdogCloseClean({
    suspiciousCount: input.suspiciousCount,
    dimensions: cleanDimensions,
  });

  const coverageFinding: CleanupWatchdogControllerFinding | null = coverageOk
    ? null
    : {
        findingId: `${input.missionCoverage.missionId}:worker-coverage`,
        category:
          coverage.reason === "duplicate_executor_coverage_for_unfinished_mission"
            ? "duplicate_execution_or_fencing_failure"
            : "active_no_worker",
        entityType: "mission",
        entityId: input.missionCoverage.missionId,
        evidence: [coverage.reason],
        reason: coverage.reason,
        priority: getCleanupWatchdogPriority(
          coverage.reason === "duplicate_executor_coverage_for_unfinished_mission"
            ? "duplicate_execution_or_fencing_failure"
            : "active_no_worker",
        ),
        repairTaskRequired: true,
        preemptsLowerPriorityWork: true,
      };

  const closeoutFinding: CleanupWatchdogControllerFinding | null =
    awaitingCloseout && input.governedMissionState?.authoritativeCloseoutPassed !== true
      ? {
          findingId: `${input.missionCoverage.missionId}:awaiting-closeout`,
          category: "pending_report_delivery",
          entityType: "mission",
          entityId: input.missionCoverage.missionId,
          evidence: ["AWAITING_CLOSEOUT"],
          reason: "governed mission is awaiting authoritative closeout proof",
          priority: getCleanupWatchdogPriority("pending_report_delivery"),
          repairTaskRequired: true,
          preemptsLowerPriorityWork: true,
        }
      : null;

  const releaseFinding: CleanupWatchdogControllerFinding | null = releasePending
    ? {
        findingId: `${input.missionCoverage.missionId}:release-decision`,
        category: "pending_report_delivery",
        entityType: "mission",
        entityId: input.missionCoverage.missionId,
        evidence: ["governed_release_decision_pending"],
        reason: "required governed release decision has not passed",
        priority: getCleanupWatchdogPriority("pending_report_delivery"),
        repairTaskRequired: true,
        preemptsLowerPriorityWork: true,
      }
    : null;

  const enforcementHealthFinding: CleanupWatchdogControllerFinding | null = enforcementHealthFailed
    ? {
        findingId: `${input.missionCoverage.missionId}:enforcement-health`,
        category: "runtime_recovery_failure",
        entityType: "mission",
        entityId: input.missionCoverage.missionId,
        evidence: ["governed_enforcement_health_failed"],
        reason: "governed enforcement health is failed or stale",
        priority: getCleanupWatchdogPriority("runtime_recovery_failure"),
        repairTaskRequired: true,
        preemptsLowerPriorityWork: true,
      }
    : null;

  const staleGovernedPausedStateFinding: CleanupWatchdogControllerFinding | null =
    staleGovernedPausedStateProof
      ? {
          findingId: `${input.missionCoverage.missionId}:governed-paused-state-proof`,
          category: "stale_lease",
          entityType: "mission",
          entityId: input.missionCoverage.missionId,
          evidence: [input.governedMissionState?.state ?? "missing_governed_state"],
          reason: "governed paused-state proof is missing, stale, or invalid",
          priority: getCleanupWatchdogPriority("stale_lease"),
          repairTaskRequired: true,
          preemptsLowerPriorityWork: true,
        }
      : null;

  const policyFinding: CleanupWatchdogControllerFinding | null = policyVersionOk
    ? null
    : {
        findingId: `${input.missionCoverage.missionId}:policy-version`,
        category: "policy_version_mismatch",
        entityType: "mission",
        entityId: input.missionCoverage.missionId,
        evidence: [String(input.observedPolicyVersion ?? "missing")],
        reason: "policy version is missing or incompatible",
        priority: getCleanupWatchdogPriority("policy_version_mismatch"),
        repairTaskRequired: true,
        preemptsLowerPriorityWork: true,
      };

  const explicitFindings = (input.findings ?? []).map((finding) => {
    const priority = getCleanupWatchdogPriority(finding.category);
    return {
      ...finding,
      priority,
      repairTaskRequired: true,
      preemptsLowerPriorityWork: priority !== undefined,
    } satisfies CleanupWatchdogControllerFinding;
  });

  const orderedFindings = [
    ...explicitFindings,
    coverageFinding,
    closeoutFinding,
    releaseFinding,
    enforcementHealthFinding,
    staleGovernedPausedStateFinding,
    policyFinding,
  ]
    .filter((finding): finding is CleanupWatchdogControllerFinding => finding !== null)
    .toSorted((left, right) => {
      if (!left.priority && !right.priority) {
        return left.findingId.localeCompare(right.findingId);
      }
      if (!left.priority) {
        return 1;
      }
      if (!right.priority) {
        return -1;
      }
      const priorityDiff = compareCleanupWatchdogPriority(left.priority, right.priority);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return left.findingId.localeCompare(right.findingId);
    });

  const selectedPriority = orderedFindings.find((finding) => finding.priority)?.priority;
  const requiredRepairTasks = orderedFindings.filter((finding) => finding.repairTaskRequired);
  const enforcementActions =
    input.mode === "enforce"
      ? requiredRepairTasks.map((finding) => `create_or_update_repair_task:${finding.findingId}`)
      : [];
  const shadowDisagreements = canCloseClean
    ? []
    : [
        !coverageOk ? "legacy clean would be unsafe without worker coverage" : null,
        !policyVersionOk ? "legacy clean would be unsafe with policy-version mismatch" : null,
        enforcementHealthFailed
          ? "legacy clean would be unsafe with failed enforcement health"
          : null,
        staleGovernedPausedStateProof
          ? "legacy clean would be unsafe with stale governed paused-state proof"
          : null,
      ].filter((value): value is string => Boolean(value));

  return {
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    mode: input.mode,
    canCloseClean,
    coverageOk,
    policyVersionOk,
    selectedPriority,
    orderedFindings,
    requiredRepairTasks,
    enforcementActions,
    shadowDisagreements,
    governedPausedStateOk,
    watchdogMayDeclareMissionSuccess: false,
  };
}

function isCurrentGovernedPausedState(
  state: CleanupWatchdogControllerInput["governedMissionState"],
): boolean {
  return Boolean(
    state?.proofCurrent === true &&
    (state.state === "GOVERNED_MISSION_PENDING_OVERRIDE" || state.state === "AWAITING_CLOSEOUT"),
  );
}

function isStaleGovernedPausedStateProof(
  state: CleanupWatchdogControllerInput["governedMissionState"],
): boolean {
  return Boolean(
    state &&
    state.proofCurrent !== true &&
    (state.state === "GOVERNED_MISSION_PENDING_OVERRIDE" || state.state === "AWAITING_CLOSEOUT"),
  );
}
