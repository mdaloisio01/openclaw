import {
  CLEANUP_WATCHDOG_POLICY_VERSION,
  type CleanupWatchdogFindingCategory,
  type CleanupWatchdogPriorityCode,
  getCleanupWatchdogPriority,
} from "../governance/cleanup-watchdog-policy.js";

export const WATCHDOG_RECONCILIATION_CLASSES = [
  "true active worker",
  "stale blocked flow",
  "stale running state",
  "missing closeout",
  "orphaned task",
  "corrupted taskflow pointer",
  "cron/watchdog state mismatch",
  "real production blocker",
] as const;

export type WatchdogReconciliationClass = (typeof WATCHDOG_RECONCILIATION_CLASSES)[number];

export type WatchdogReceiptItem = {
  entity_type?: string;
  entity_id?: string;
  label?: string | null;
  raw_status?: string | null;
  category?: string;
  reason?: string;
  real_worker_active?: boolean | null;
  lawful_blocker?: boolean | null;
  progress_recent?: boolean | null;
  next_action?: string;
  proof?: Record<string, unknown>;
  suggested_next_step?: {
    recommendation_code?: string;
    recommendation?: string;
    requires_separate_work_order?: boolean;
    owner_approval_required?: boolean;
  };
};

export type WatchdogReceiptLike = {
  checked_at?: string;
  label?: string;
  status?: string;
  policy_version?: string;
  clean_dimensions_required?: string[];
  summary?: {
    items_suspicious?: number;
  };
  decisions?: {
    suspicious_items?: WatchdogReceiptItem[];
  };
};

export type WatchdogReconciledItem = {
  entityType: string;
  entityId: string;
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  canonicalPriority?: CleanupWatchdogPriorityCode;
  classification: WatchdogReconciliationClass;
  repairRoute: "observe_active" | "cleanup_crew_repair" | "lawful_owner_route" | "blocker_artifact";
  validationRequired: "rerun_watchdog";
  stoppageClass: "watchdog_needs_review" | "watchdog_monitor_disabled";
  pauseForAnalysis: boolean;
  pauseAdjacentProduction: boolean;
  routeToCleanupCrewRecovery: boolean;
  cleanupRecoveryAllowed: boolean;
  markDecisionRequired: boolean;
  hardStopReason?: string;
  nextAnalysisOwner: "cleanup_crew_planning_dev_sop";
  planAmendmentRequired: boolean;
  nextExecutableCommand: "rerun_system_wide_active_work_watchdog";
  cleanupCrewRecoveryBridge?: WatchdogCleanupCrewRecoveryBridge;
  reason: string;
};

export type WatchdogCleanupCrewRecoveryBridge = {
  schema: "openclaw.watchdog_cleanup_crew_recovery_bridge.v1";
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  canonicalPriority?: CleanupWatchdogPriorityCode;
  stoppageReceipt: {
    stoppageClass: "watchdog_needs_review" | "watchdog_monitor_disabled";
    suspectedAffectedSurface: string;
    nextAnalysisOwner: "cleanup_crew_planning_dev_sop";
    commandSpec: "python3 scripts/system_wide_active_work_watchdog.py --mode report-only --write-receipt --stdout-json";
  };
  readOnlyAnalysis: {
    laneClassification: "lane_b_plan_driven_build_work";
    pathRisk: "MEDIUM_RISK_RUNTIME";
    diffIntent: "proof_or_receipt_shape" | "routing_or_catalog_recording";
    repairAction: string;
    targetSurfaces: string[];
  };
  planAmendment: {
    required: true;
    validationSteps: string[];
    proofArtifacts: string[];
    nextExecutableCommand: "rerun_system_wide_active_work_watchdog";
    stopConditions: string[];
  };
  resume: {
    requiresPlanReload: true;
    command: "rerun_system_wide_active_work_watchdog";
    proofTarget: "WATCHDOG STATUS: CLEAN | suspicious_count=0 plus worker/continuation/delivery/runtime/record-integrity/repair-closure/policy-version coverage";
  };
  durableRepairWork: {
    required: true;
    idempotencyKey: string;
    createBeforeAlertAcknowledgement: true;
    acknowledgementRule: "acknowledge_only_after_repair_completion_and_fresh_clean_watchdog";
    duplicateAlertHandling: "reuse_pending_repair_work";
  };
};

export type WatchdogNeedsReviewReconciliation = {
  status: "clean" | "needs_review";
  pauseAdjacentProduction: boolean;
  duplicateSuppressionScope: "chat_delivery_only";
  inspectionRequired: boolean;
  classificationRequired: boolean;
  artifactRequired: boolean;
  validationRequired: "none" | "rerun_watchdog";
  finalTruthReportRequired: boolean;
  closureRule: string;
  items: WatchdogReconciledItem[];
};

export type WatchdogReconciliationContext = {
  activeCleanupCrewMission?: boolean;
  activeProductionFlowIds?: string[];
  lifecycleProbeAvailable?: boolean;
  sourceOnlyProof?: boolean;
};

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function classifyWatchdogSuspiciousItem(
  item: WatchdogReceiptItem,
): WatchdogReconciliationClass {
  const category = normalize(item.category);
  const entityType = normalize(item.entity_type);
  const rawStatus = normalize(item.raw_status);
  const reason = normalize(item.reason);
  const proof = item.proof ?? {};
  const recommendation = normalize(item.suggested_next_step?.recommendation_code);

  if (item.real_worker_active === true || category === "active_with_worker") {
    return "true active worker";
  }
  if (
    category === "blocked_lawful" ||
    item.lawful_blocker === true ||
    (entityType === "flow_run" && rawStatus === "blocked")
  ) {
    return "stale blocked flow";
  }
  if (
    category === "needs_final_delivery" ||
    category === "already_completed_not_closed_cleanly" ||
    recommendation.includes("replay")
  ) {
    return "missing closeout";
  }
  if (
    category === "queued_no_dispatch" ||
    category === "lost" ||
    entityType === "task_run" ||
    reason.includes("orphan")
  ) {
    return "orphaned task";
  }
  if (
    category === "active_no_worker" ||
    Number(proof.invalid_backing_child_tasks ?? 0) > 0 ||
    reason.includes("invalid backing") ||
    reason.includes("pointer")
  ) {
    return "corrupted taskflow pointer";
  }
  if (entityType === "cron_job" || category.includes("cron")) {
    return "cron/watchdog state mismatch";
  }
  if (
    category === "waiting_on_owner" ||
    category === "pending_report_delivery" ||
    category === "pending_milestone_report" ||
    category === "source_delivery_stale" ||
    category === "source_delivery_failed"
  ) {
    return "real production blocker";
  }
  return "stale running state";
}

function routeForClassification(
  classification: WatchdogReconciliationClass,
): WatchdogReconciledItem["repairRoute"] {
  if (classification === "true active worker") {
    return "observe_active";
  }
  if (
    classification === "stale blocked flow" ||
    classification === "missing closeout" ||
    classification === "real production blocker"
  ) {
    return "lawful_owner_route";
  }
  return "cleanup_crew_repair";
}

function canonicalCategoryForItem(
  item: WatchdogReceiptItem,
  classification: WatchdogReconciliationClass,
): CleanupWatchdogFindingCategory | undefined {
  const category = normalize(item.category);
  if (category === "active_no_worker") return "active_no_worker";
  if (category === "pending_report_delivery") return "pending_report_delivery";
  if (category === "pending_milestone_report") return "pending_milestone_report";
  if (category === "source_delivery_stale" || category === "source_delivery_failed") {
    return "pending_report_delivery";
  }
  if (category === "lost") return "lost_ownership";
  if (category === "stale") return "corrupted_state";
  if (category === "queued_no_dispatch") return "corrupted_continuation";
  if (category === "already_completed_not_closed_cleanly" || category === "needs_final_delivery") {
    return "missing_correctness_proof";
  }
  if (category === "monitor_disabled") return "runtime_recovery_failure";
  if (category === "blocked_lawful" || category === "waiting_on_owner") {
    return "review_required_for_safe_work";
  }
  if (classification === "cron/watchdog state mismatch") return "runtime_recovery_failure";
  if (classification === "corrupted taskflow pointer") return "corrupted_pointer";
  if (classification === "orphaned task") return "lost_ownership";
  if (classification === "missing closeout") return "missing_correctness_proof";
  if (classification === "real production blocker") return "review_required_for_safe_work";
  if (classification === "stale running state") return "corrupted_state";
  return undefined;
}

function canonicalPriorityForItem(
  item: WatchdogReceiptItem,
  classification: WatchdogReconciliationClass,
): CleanupWatchdogPriorityCode | undefined {
  const category = canonicalCategoryForItem(item, classification);
  return category ? getCleanupWatchdogPriority(category) : undefined;
}

function resolveHardStopReason(item: WatchdogReceiptItem): string | undefined {
  const recommendationCode = normalize(item.suggested_next_step?.recommendation_code);
  const recommendation = normalize(item.suggested_next_step?.recommendation);
  const reason = normalize(item.reason);
  const nextAction = normalize(item.next_action);
  const combined = `${recommendationCode} ${recommendation} ${reason} ${nextAction}`;

  if (combined.includes("raw db") || combined.includes("raw-db") || combined.includes("db edit")) {
    return "raw_db_state_repair_requires_emergency_sop";
  }
  if (
    combined.includes("duplicate worker") ||
    combined.includes("auto-restart") ||
    combined.includes("unsafe restart")
  ) {
    return "unsafe_duplicate_worker_restart_requires_proof";
  }
  if (
    item.suggested_next_step?.owner_approval_required === true &&
    (recommendationCode.includes("owner_decision_required") ||
      recommendationCode.includes("prepare_owner_approved_replay") ||
      recommendationCode.includes("triage_pending_delivery_debt") ||
      combined.includes("ask mark") ||
      combined.includes("owner decision"))
  ) {
    return "owner_decision_required_before_worker_relaunch";
  }
  return undefined;
}

function buildRepairWorkIdempotencyKey(params: {
  item: WatchdogReceiptItem;
  classification: WatchdogReconciliationClass;
  stoppageClass: "watchdog_needs_review" | "watchdog_monitor_disabled";
}): string {
  const entityType = stringValue(params.item.entity_type, "watchdog")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  const entityId = stringValue(params.item.entity_id, "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  const classification = params.classification.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return `watchdog:${params.stoppageClass}:${entityType}:${entityId}:${classification}`;
}

function buildRecoveryFlags(
  item: WatchdogReceiptItem,
  classification: WatchdogReconciliationClass,
) {
  const hardStopReason = resolveHardStopReason(item);
  const trueActiveWorker = classification === "true active worker";
  return {
    pauseAdjacentProduction: true,
    routeToCleanupCrewRecovery: !trueActiveWorker,
    cleanupRecoveryAllowed: !trueActiveWorker && !hardStopReason,
    markDecisionRequired: Boolean(hardStopReason),
    ...(hardStopReason ? { hardStopReason } : {}),
  };
}

function buildCleanupCrewRecoveryBridge(params: {
  item: WatchdogReceiptItem;
  classification: WatchdogReconciliationClass;
  stoppageClass: "watchdog_needs_review" | "watchdog_monitor_disabled";
  reason: string;
}): WatchdogCleanupCrewRecoveryBridge {
  const entityType = stringValue(params.item.entity_type, "watchdog");
  const entityId = stringValue(params.item.entity_id, "unknown");
  const surface = `${entityType}:${entityId}:${params.classification}`;
  const canonicalPriority = canonicalPriorityForItem(params.item, params.classification);
  return {
    schema: "openclaw.watchdog_cleanup_crew_recovery_bridge.v1",
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    ...(canonicalPriority ? { canonicalPriority } : {}),
    stoppageReceipt: {
      stoppageClass: params.stoppageClass,
      suspectedAffectedSurface: surface,
      nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
      commandSpec:
        "python3 scripts/system_wide_active_work_watchdog.py --mode report-only --write-receipt --stdout-json",
    },
    readOnlyAnalysis: {
      laneClassification: "lane_b_plan_driven_build_work",
      pathRisk: "MEDIUM_RISK_RUNTIME",
      diffIntent:
        params.classification === "missing closeout"
          ? "routing_or_catalog_recording"
          : "proof_or_receipt_shape",
      repairAction: `Pause adjacent production, reconcile watchdog item ${entityId} through Cleanup Crew recovery, then rerun watchdog proof. Diagnosis: ${params.reason}`,
      targetSurfaces: [
        "system_wide_active_work_watchdog receipt",
        surface,
        "active-work watchdog reconciliation",
      ],
    },
    planAmendment: {
      required: true,
      validationSteps: [
        "inspect latest watchdog receipt read-only",
        "classify suspicious item and lawful owner route",
        "apply supported TaskFlow/watchdog recovery only if authorized by amended plan",
        "rerun system-wide active-work watchdog",
      ],
      proofArtifacts: [
        "watchdog stoppage receipt",
        "active build plan recovery amendment",
        "fresh system-wide watchdog receipt",
      ],
      nextExecutableCommand: "rerun_system_wide_active_work_watchdog",
      stopConditions: [
        "raw DB/state edit required",
        "unsafe duplicate worker restart required",
        "owner/path authority cannot be verified",
        "Lane C product or behavior decision required",
        "fresh watchdog proof remains NEEDS_REVIEW with no lawful recovery path",
      ],
    },
    resume: {
      requiresPlanReload: true,
      command: "rerun_system_wide_active_work_watchdog",
      proofTarget:
        "WATCHDOG STATUS: CLEAN | suspicious_count=0 plus worker/continuation/delivery/runtime/record-integrity/repair-closure/policy-version coverage",
    },
    durableRepairWork: {
      required: true,
      idempotencyKey: buildRepairWorkIdempotencyKey(params),
      createBeforeAlertAcknowledgement: true,
      acknowledgementRule: "acknowledge_only_after_repair_completion_and_fresh_clean_watchdog",
      duplicateAlertHandling: "reuse_pending_repair_work",
    },
  };
}

export function resolveWatchdogNeedsReviewReconciliation(
  receipt: WatchdogReceiptLike,
  context: WatchdogReconciliationContext = {},
): WatchdogNeedsReviewReconciliation {
  const suspiciousItems = receipt.decisions?.suspicious_items ?? [];
  const suspiciousCount =
    typeof receipt.summary?.items_suspicious === "number"
      ? receipt.summary.items_suspicious
      : suspiciousItems.length;
  const label = normalize(receipt.label ?? receipt.status);
  const monitorDisabled = label === "monitor_disabled";
  const activeProductionFlowIds = context.activeProductionFlowIds ?? [];
  const activeMission =
    context.activeCleanupCrewMission === true || activeProductionFlowIds.length > 0;
  if (monitorDisabled && activeMission) {
    const flowSummary =
      activeProductionFlowIds.length > 0
        ? activeProductionFlowIds.join(", ")
        : "active Cleanup Crew mission";
    return {
      status: "needs_review",
      pauseAdjacentProduction: true,
      duplicateSuppressionScope: "chat_delivery_only",
      inspectionRequired: true,
      classificationRequired: true,
      artifactRequired: true,
      validationRequired: "rerun_watchdog",
      finalTruthReportRequired: true,
      closureRule:
        "MONITOR_DISABLED during active production closes only after active monitor proof and a fresh WATCHDOG STATUS: CLEAN | suspicious_count=0, or a hard-blocker report naming the exact remaining blocker",
      items: [
        {
          entityType: "watchdog_monitor",
          entityId: flowSummary,
          policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
          canonicalPriority: getCleanupWatchdogPriority("runtime_recovery_failure"),
          classification: "cron/watchdog state mismatch",
          repairRoute: "cleanup_crew_repair",
          validationRequired: "rerun_watchdog",
          stoppageClass: "watchdog_monitor_disabled",
          pauseForAnalysis: true,
          pauseAdjacentProduction: true,
          routeToCleanupCrewRecovery: true,
          cleanupRecoveryAllowed: true,
          markDecisionRequired: false,
          nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
          planAmendmentRequired: true,
          nextExecutableCommand: "rerun_system_wide_active_work_watchdog",
          cleanupCrewRecoveryBridge: buildCleanupCrewRecoveryBridge({
            item: {
              entity_type: "watchdog_monitor",
              entity_id: flowSummary,
              reason:
                context.sourceOnlyProof === true
                  ? "source/test watchdog proof cannot substitute for live active-monitor proof during an active Cleanup Crew mission"
                  : "MONITOR_DISABLED during active Cleanup Crew production is active repair work, not clean proof",
            },
            classification: "cron/watchdog state mismatch",
            stoppageClass: "watchdog_monitor_disabled",
            reason:
              context.sourceOnlyProof === true
                ? "source/test watchdog proof cannot substitute for live active-monitor proof during an active Cleanup Crew mission"
                : "MONITOR_DISABLED during active Cleanup Crew production is active repair work, not clean proof",
          }),
          reason:
            context.sourceOnlyProof === true
              ? "source/test watchdog proof cannot substitute for live active-monitor proof during an active Cleanup Crew mission"
              : "MONITOR_DISABLED during active Cleanup Crew production is active repair work, not clean proof",
        },
      ],
    };
  }
  if (monitorDisabled) {
    return {
      status: "clean",
      pauseAdjacentProduction: false,
      duplicateSuppressionScope: "chat_delivery_only",
      inspectionRequired: false,
      classificationRequired: false,
      artifactRequired: false,
      validationRequired: "none",
      finalTruthReportRequired: true,
      closureRule:
        "MONITOR_DISABLED is passive only when no active Cleanup Crew or active-production mission is open",
      items: [],
    };
  }
  const needsReview = label === "needs_review" || suspiciousCount > 0;

  if (!needsReview) {
    return {
      status: "clean",
      pauseAdjacentProduction: false,
      duplicateSuppressionScope: "chat_delivery_only",
      inspectionRequired: false,
      classificationRequired: false,
      artifactRequired: false,
      validationRequired: "none",
      finalTruthReportRequired: true,
      closureRule: "fresh watchdog run already proves WATCHDOG STATUS: CLEAN | suspicious_count=0",
      items: [],
    };
  }

  const items = suspiciousItems.map((item) => {
    const classification = classifyWatchdogSuspiciousItem(item);
    const canonicalPriority = canonicalPriorityForItem(item, classification);
    const recoveryFlags = buildRecoveryFlags(item, classification);
    const reason = stringValue(item.reason, "watchdog NEEDS_REVIEW item requires reconciliation");
    const cleanupCrewRecoveryBridge =
      recoveryFlags.cleanupRecoveryAllowed && recoveryFlags.routeToCleanupCrewRecovery
        ? buildCleanupCrewRecoveryBridge({
            item,
            classification,
            stoppageClass: "watchdog_needs_review",
            reason,
          })
        : undefined;
    return {
      entityType: stringValue(item.entity_type, "unknown"),
      entityId: stringValue(item.entity_id, "unknown"),
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      ...(canonicalPriority ? { canonicalPriority } : {}),
      classification,
      repairRoute: routeForClassification(classification),
      validationRequired: "rerun_watchdog" as const,
      stoppageClass: "watchdog_needs_review" as const,
      pauseForAnalysis: true,
      ...recoveryFlags,
      nextAnalysisOwner: "cleanup_crew_planning_dev_sop" as const,
      planAmendmentRequired: classification !== "true active worker",
      nextExecutableCommand: "rerun_system_wide_active_work_watchdog" as const,
      ...(cleanupCrewRecoveryBridge ? { cleanupCrewRecoveryBridge } : {}),
      reason,
    };
  });

  return {
    status: "needs_review",
    pauseAdjacentProduction: true,
    duplicateSuppressionScope: "chat_delivery_only",
    inspectionRequired: true,
    classificationRequired: true,
    artifactRequired: true,
    validationRequired: "rerun_watchdog",
    finalTruthReportRequired: true,
    closureRule:
      "close only after a fresh WATCHDOG STATUS: CLEAN | suspicious_count=0 or a final report naming the exact remaining suspicious item and blocker",
    items,
  };
}
