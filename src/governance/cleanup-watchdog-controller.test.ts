import { describe, expect, it } from "vitest";
import {
  buildCleanupWatchdogNeedsReviewReconciliationArtifact,
  classifyCleanupWatchdogNeedsReviewItem,
  createCleanupWatchdogShadowInputFromReceipt,
  evaluateCleanupWatchdogActivationGate,
  reconcileCleanupWatchdogMission,
} from "./cleanup-watchdog-controller.js";
import {
  CLEANUP_WATCHDOG_POLICY_VERSION,
  type CleanupWatchdogCleanDimension,
} from "./cleanup-watchdog-policy.js";

const allCleanDimensions: Record<CleanupWatchdogCleanDimension, boolean> = {
  record_integrity: true,
  worker_coverage: true,
  continuation_readiness: true,
  delivery_completeness: true,
  runtime_health: true,
  repair_closure: true,
  policy_version: true,
};

const allActivationGates = {
  policySchemaGenerated: true,
  sopParityValidated: true,
  sourceBuiltRuntimeMatch: true,
  watchdogClean: true,
  workerCoverageProven: true,
  shadowDecisionsStable: true,
  repairTasksDrained: true,
  grantReviewPassed: true,
  rollbackPlanVerified: true,
  productionPaused: true,
  trinityUnstarted: true,
  controlPlanePhase2Paused: true,
} as const;

describe("cleanup-watchdog-controller", () => {
  it("allows clean in shadow mode only when coverage, dimensions, and policy version pass", () => {
    const decision = reconcileCleanupWatchdogMission({
      mode: "shadow_observe",
      suspiciousCount: 0,
      cleanDimensions: allCleanDimensions,
      observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionCoverage: {
        missionId: "mission-1",
        unfinished: true,
        activeProduction: true,
        executorCount: 1,
        executorLeaseCurrent: true,
      },
    });

    expect(decision).toMatchObject({
      canCloseClean: true,
      coverageOk: true,
      policyVersionOk: true,
      requiredRepairTasks: [],
      shadowDisagreements: [],
    });
  });

  it("creates a P2 repair task when active production has no executor coverage", () => {
    const decision = reconcileCleanupWatchdogMission({
      mode: "shadow_observe",
      suspiciousCount: 0,
      cleanDimensions: allCleanDimensions,
      observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionCoverage: {
        missionId: "mission-2",
        unfinished: true,
        activeProduction: true,
        executorCount: 0,
      },
    });

    expect(decision.canCloseClean).toBe(false);
    expect(decision.selectedPriority).toBe("P2_ACTIVE_NO_WORKER");
    expect(decision.requiredRepairTasks[0]).toMatchObject({
      findingId: "mission-2:worker-coverage",
      category: "active_no_worker",
      repairTaskRequired: true,
      preemptsLowerPriorityWork: true,
    });
    expect(decision.shadowDisagreements).toContain(
      "legacy clean would be unsafe without worker coverage",
    );
  });

  it("orders duplicate execution risk ahead of report delivery debt", () => {
    const decision = reconcileCleanupWatchdogMission({
      mode: "enforce",
      suspiciousCount: 2,
      cleanDimensions: allCleanDimensions,
      observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionCoverage: {
        missionId: "mission-3",
        unfinished: true,
        activeProduction: true,
        executorCount: 1,
        executorLeaseCurrent: true,
      },
      findings: [
        {
          findingId: "report-1",
          category: "pending_report_delivery",
          entityType: "report",
          entityId: "report-1",
          evidence: ["chat report pending"],
          reason: "chat report delivery is pending",
        },
        {
          findingId: "mission-3:fencing",
          category: "duplicate_execution_or_fencing_failure",
          entityType: "mission",
          entityId: "mission-3",
          evidence: ["two current leases"],
          reason: "duplicate executor lease",
        },
      ],
    });

    expect(decision.orderedFindings.map((finding) => finding.findingId)).toEqual([
      "mission-3:fencing",
      "report-1",
    ]);
    expect(decision.selectedPriority).toBe("P1_SAFETY_OR_DUPLICATE_EXECUTION");
    expect(decision.enforcementActions).toContain("create_or_update_repair_task:mission-3:fencing");
  });

  it("keeps policy-version mismatch visible until migrated", () => {
    const decision = reconcileCleanupWatchdogMission({
      mode: "shadow_observe",
      suspiciousCount: 0,
      cleanDimensions: allCleanDimensions,
      observedPolicyVersion: "stale-policy",
      missionCoverage: {
        missionId: "mission-4",
        unfinished: true,
        activeProduction: true,
        executorCount: 1,
        executorLeaseCurrent: true,
      },
    });

    expect(decision.canCloseClean).toBe(false);
    expect(decision.policyVersionOk).toBe(false);
    expect(decision.selectedPriority).toBe("P5_MISSING_PROOF_OR_POLICY_MIGRATION");
    expect(decision.requiredRepairTasks[0]).toMatchObject({
      findingId: "mission-4:policy-version",
      category: "policy_version_mismatch",
    });
  });

  it("respects a current pending override as governed paused coverage without success ownership", () => {
    const decision = reconcileCleanupWatchdogMission({
      mode: "shadow_observe",
      suspiciousCount: 0,
      cleanDimensions: allCleanDimensions,
      observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionCoverage: {
        missionId: "mission-pending-override",
        unfinished: true,
        activeProduction: true,
        executorCount: 0,
      },
      governedMissionState: {
        state: "pending_override",
        proofCurrent: true,
      },
    });

    expect(decision.coverageOk).toBe(true);
    expect(decision.governedPausedStateOk).toBe(true);
    expect(decision.requiredRepairTasks).toEqual([]);
    expect(decision.watchdogMayDeclareMissionSuccess).toBe(false);
  });

  it("keeps stale governed paused-state proof from closing clean even with worker coverage", () => {
    const decision = reconcileCleanupWatchdogMission({
      mode: "shadow_observe",
      suspiciousCount: 0,
      cleanDimensions: allCleanDimensions,
      observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionCoverage: {
        missionId: "mission-stale-paused-proof",
        unfinished: true,
        activeProduction: true,
        executorCount: 1,
        executorLeaseCurrent: true,
      },
      governedMissionState: {
        state: "pending_override",
        proofCurrent: false,
      },
    });

    expect(decision.canCloseClean).toBe(false);
    expect(decision.governedPausedStateOk).toBe(false);
    expect(decision.selectedPriority).toBe("P3_CORRUPTED_STATE");
    expect(decision.requiredRepairTasks[0]).toMatchObject({
      findingId: "mission-stale-paused-proof:governed-paused-state-proof",
      category: "stale_lease",
      reason: "governed paused-state proof is missing, stale, or invalid",
    });
    expect(decision.shadowDisagreements).toContain(
      "legacy clean would be unsafe with stale governed paused-state proof",
    );
  });

  it("keeps awaiting-closeout missions visible until authoritative closeout proof passes", () => {
    const decision = reconcileCleanupWatchdogMission({
      mode: "shadow_observe",
      suspiciousCount: 0,
      cleanDimensions: allCleanDimensions,
      observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionCoverage: {
        missionId: "mission-awaiting-closeout",
        unfinished: true,
        activeProduction: true,
        executorCount: 0,
      },
      governedMissionState: {
        state: "closeout_ready",
        proofCurrent: true,
        authoritativeCloseoutPassed: false,
      },
    });

    expect(decision.coverageOk).toBe(true);
    expect(decision.canCloseClean).toBe(false);
    expect(decision.requiredRepairTasks[0]).toMatchObject({
      findingId: "mission-awaiting-closeout:awaiting-closeout",
      category: "pending_report_delivery",
      reason: "governed mission is awaiting authoritative closeout proof",
    });
  });

  it("blocks clean status when governed enforcement health has failed", () => {
    const decision = reconcileCleanupWatchdogMission({
      mode: "shadow_observe",
      suspiciousCount: 0,
      cleanDimensions: allCleanDimensions,
      observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionCoverage: {
        missionId: "mission-health-failed",
        unfinished: true,
        activeProduction: true,
        executorCount: 1,
        executorLeaseCurrent: true,
      },
      governedMissionState: {
        state: "executing",
        proofCurrent: true,
        enforcementHealthOk: false,
      },
    });

    expect(decision.canCloseClean).toBe(false);
    expect(decision.selectedPriority).toBe("P4_RESTART_OR_RUNTIME_RECOVERY");
    expect(decision.requiredRepairTasks[0]).toMatchObject({
      findingId: "mission-health-failed:enforcement-health",
      category: "runtime_recovery_failure",
    });
    expect(decision.shadowDisagreements).toContain(
      "legacy clean would be unsafe with failed enforcement health",
    );
  });

  it("derives a clean shadow decision from a receipt with exactly one active executor", () => {
    const input = createCleanupWatchdogShadowInputFromReceipt({
      missionId: "flow-1",
      receipt: {
        policy_version: CLEANUP_WATCHDOG_POLICY_VERSION,
        summary: { items_suspicious: 0 },
        decisions: {
          healthy_items: [
            {
              entity_type: "task_run",
              entity_id: "task-1",
              category: "active_with_worker",
              proof: { parent_flow_id: "flow-1" },
            },
            {
              entity_type: "flow_run",
              entity_id: "flow-1",
              category: "active_with_worker",
              proof: { active_child_tasks: 1 },
            },
          ],
          suspicious_items: [],
        },
      },
    });

    const decision = reconcileCleanupWatchdogMission(input);

    expect(input.cleanDimensions).toMatchObject({
      worker_coverage: true,
      continuation_readiness: true,
      policy_version: true,
    });
    expect(decision).toMatchObject({
      canCloseClean: true,
      coverageOk: true,
      policyVersionOk: true,
      requiredRepairTasks: [],
    });
  });

  it("derives P2 recovery work from an active-no-worker receipt replay", () => {
    const input = createCleanupWatchdogShadowInputFromReceipt({
      missionId: "flow-2",
      receipt: {
        policy_version: CLEANUP_WATCHDOG_POLICY_VERSION,
        summary: { items_suspicious: 1 },
        decisions: {
          healthy_items: [],
          suspicious_items: [
            {
              entity_type: "flow_run",
              entity_id: "flow-2",
              category: "active_no_worker",
              reason: "running flow has no active child worker",
            },
          ],
        },
      },
    });

    const decision = reconcileCleanupWatchdogMission(input);

    expect(input.missionCoverage.executorCount).toBe(0);
    expect(decision.canCloseClean).toBe(false);
    expect(decision.selectedPriority).toBe("P2_ACTIVE_NO_WORKER");
    expect(decision.requiredRepairTasks.map((finding) => finding.category)).toContain(
      "active_no_worker",
    );
  });

  it("classifies watchdog NEEDS_REVIEW items into required repair-route families", () => {
    expect(
      classifyCleanupWatchdogNeedsReviewItem({
        entity_type: "task_run",
        entity_id: "worker-1",
        category: "active_with_worker",
      }),
    ).toBe("true_active_worker");
    expect(
      classifyCleanupWatchdogNeedsReviewItem({
        entity_type: "flow_run",
        entity_id: "flow-stale",
        category: "stale",
        reason: "blocked flow stale",
      }),
    ).toBe("stale_blocked_flow");
    expect(
      classifyCleanupWatchdogNeedsReviewItem({
        entity_type: "runtime",
        entity_id: "gateway",
        category: "runtime_recovery_failure",
        reason: "stale runtime identity",
      }),
    ).toBe("stale_running_state");
    expect(
      classifyCleanupWatchdogNeedsReviewItem({
        entity_type: "task_run",
        entity_id: "task-orphan",
        category: "active_no_worker",
      }),
    ).toBe("orphaned_task");
    expect(
      classifyCleanupWatchdogNeedsReviewItem({
        entity_type: "report",
        entity_id: "report-1",
        category: "pending_report_delivery",
      }),
    ).toBe("missing_closeout");
    expect(
      classifyCleanupWatchdogNeedsReviewItem({
        entity_type: "flow_run",
        entity_id: "flow-corrupt",
        category: "corrupted_pointer",
      }),
    ).toBe("corrupted_taskflow_pointer");
    expect(
      classifyCleanupWatchdogNeedsReviewItem({
        entity_type: "cron",
        entity_id: "cron-watchdog",
        category: "missing_correctness_proof",
        reason: "cron/watchdog state mismatch",
      }),
    ).toBe("cron_watchdog_state_mismatch");
    expect(
      classifyCleanupWatchdogNeedsReviewItem({
        entity_type: "flow_run",
        entity_id: "flow-blocker",
        category: "review_required_for_safe_work",
        reason: "real production blocker",
      }),
    ).toBe("real_production_blocker");
  });

  it("builds a required reconciliation artifact for watchdog NEEDS_REVIEW routing", () => {
    expect(
      buildCleanupWatchdogNeedsReviewReconciliationArtifact({
        missionId: "flow-corrupt",
        item: {
          entity_type: "flow_run",
          entity_id: "flow-corrupt",
          category: "corrupted_pointer",
          reason: "taskflow pointer does not resolve",
        },
      }),
    ).toMatchObject({
      schema: "openclaw.cleanup_watchdog.needs_review_reconciliation.v1",
      trigger: "watchdog_needs_review",
      classification: "corrupted_taskflow_pointer",
      repairRoute: "taskflow_pointer_repair",
      validationResult: "repair_required",
      suspiciousEntity: {
        type: "flow_run",
        id: "flow-corrupt",
      },
    });
  });

  it("allows enforcement only after activation, rollback, shadow, watchdog, and safety gates pass", () => {
    expect(
      evaluateCleanupWatchdogActivationGate({
        requestedMode: "enforce",
        ...allActivationGates,
      }),
    ).toEqual({
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      requestedMode: "enforce",
      effectiveMode: "enforce",
      state: "enforcement_allowed",
      allowedToEnforce: true,
      rollbackRequired: false,
      missingGates: [],
      requiredActions: ["activate_controller_enforcement_incrementally"],
    });
  });

  it("rolls an enforcement request back to shadow mode when required proof is missing", () => {
    const decision = evaluateCleanupWatchdogActivationGate({
      requestedMode: "enforce",
      ...allActivationGates,
      watchdogClean: false,
      workerCoverageProven: false,
      grantReviewPassed: false,
    });

    expect(decision).toMatchObject({
      effectiveMode: "shadow_observe",
      state: "rollback_required",
      allowedToEnforce: false,
      rollbackRequired: true,
    });
    expect(decision.missingGates).toEqual([
      "watchdog_clean",
      "worker_coverage_proven",
      "grant_review_passed",
    ]);
    expect(decision.requiredActions).toContain("disable_controller_repair_mode_keep_observe_only");
  });

  it("keeps shadow mode active until shadow disagreements are repaired", () => {
    const decision = evaluateCleanupWatchdogActivationGate({
      requestedMode: "shadow_observe",
      ...allActivationGates,
      shadowDisagreements: ["legacy clean would be unsafe without worker coverage"],
    });

    expect(decision).toMatchObject({
      effectiveMode: "shadow_observe",
      state: "shadow_required",
      allowedToEnforce: false,
      rollbackRequired: false,
    });
    expect(decision.missingGates).toEqual(["shadow_disagreements_empty"]);
    expect(decision.requiredActions).toContain("keep_shadow_observe");
  });
});
