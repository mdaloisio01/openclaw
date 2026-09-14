import { describe, expect, it } from "vitest";
import { resolveMissionSettlementTail } from "../agents/mission-settlement-tail.js";
import { CLEANUP_WATCHDOG_POLICY_VERSION } from "../governance/cleanup-watchdog-policy.js";
import {
  classifyWatchdogSuspiciousItem,
  projectMissionSettlementForWatchdog,
  resolveWatchdogNeedsReviewReconciliation,
} from "./active-work-watchdog-reconciliation.js";

describe("active work watchdog reconciliation", () => {
  it("projects delivery-failed settlement as delivery-tail blocker without work rerun", () => {
    const decision = resolveMissionSettlementTail({
      missionId: "mission-delivery-failed",
      workState: "completed",
      resultDurable: true,
      closeoutReady: true,
      closeout: {
        runLabel: "Mission delivery failed",
        targetHandled: "delivery tail",
        scopeHandled: "watchdog projection",
        actualExecutionOwner: "Cleanup Crew",
        artifactPaths: ["/tmp/closeout.md"],
        proofPaths: ["src/tasks/active-work-watchdog-reconciliation.test.ts"],
        whatIsMateriallyRealNow: "Work is complete.",
        whatIsStillNotRealYet: "Delivery failed.",
        whoLawfullyOwnsNextStep: "Will",
        openClosedTruth: "owner execution in progress, build still open.",
        exactNextAction: "retry delivery only",
        shortResult: "Delivery tail remains open.",
      },
      reportRequired: true,
      reportRendered: true,
      deliveryState: "failed",
    });

    expect(projectMissionSettlementForWatchdog(decision)).toEqual({
      schema: "openclaw.mission_settlement_watchdog_projection.v1",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      missionId: "mission-delivery-failed",
      settlementState: "DELIVERY_FAILED",
      classification: "real production blocker",
      canonicalPriority: "P7_PENDING_REPORT_DELIVERY",
      countsAsProductionLiveness: false,
      blocksMissionSettlement: true,
      recoveryMayRerunWork: false,
      recoveryBoundary: "delivery_retry",
      nextAction: "retry_delivery_only_with_idempotency",
      reason: "delivery_tail_open_completed_work_must_not_be_restarted",
    });
  });

  it("projects delivery-unknown settlement as reconciliation work without blind resend", () => {
    const decision = resolveMissionSettlementTail({
      missionId: "mission-delivery-unknown",
      workState: "completed",
      resultDurable: true,
      closeoutReady: true,
      closeout: {
        runLabel: "Mission delivery unknown",
        targetHandled: "delivery tail",
        scopeHandled: "watchdog projection",
        actualExecutionOwner: "Cleanup Crew",
        artifactPaths: ["/tmp/closeout.md"],
        proofPaths: ["src/tasks/active-work-watchdog-reconciliation.test.ts"],
        whatIsMateriallyRealNow: "Work is complete.",
        whatIsStillNotRealYet: "Delivery acknowledgement is unknown.",
        whoLawfullyOwnsNextStep: "Will",
        openClosedTruth: "owner execution in progress, build still open.",
        exactNextAction: "reconcile ambiguous delivery",
        shortResult: "Delivery acknowledgement remains unresolved.",
      },
      reportRequired: true,
      reportRendered: true,
      deliveryState: "unknown",
    });

    expect(projectMissionSettlementForWatchdog(decision)).toMatchObject({
      settlementState: "DELIVERY_UNKNOWN",
      classification: "real production blocker",
      countsAsProductionLiveness: false,
      blocksMissionSettlement: true,
      recoveryMayRerunWork: false,
      recoveryBoundary: "delivery_unknown",
      nextAction: "reconcile_ambiguous_delivery_ack",
    });
  });

  it("excludes watchdog and recovery work from production liveness", () => {
    const decision = resolveMissionSettlementTail({
      missionId: "mission-self-work",
      workState: "running",
    });

    expect(
      projectMissionSettlementForWatchdog(decision, { watchdogOrRecoverySelfWork: true }),
    ).toMatchObject({
      classification: "watchdog_self_work",
      countsAsProductionLiveness: false,
      blocksMissionSettlement: true,
      recoveryMayRerunWork: false,
      reason: "watchdog_or_recovery_work_is_subordinate_and_cannot_prove_original_mission_liveness",
    });
  });

  it("treats a clean watchdog receipt as closed only by fresh clean proof", () => {
    expect(
      resolveWatchdogNeedsReviewReconciliation({
        label: "CLEAN",
        summary: { items_suspicious: 0 },
        decisions: { suspicious_items: [] },
      }),
    ).toEqual({
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
    });
  });

  it("keeps MONITOR_DISABLED passive when no active mission is open", () => {
    expect(
      resolveWatchdogNeedsReviewReconciliation({
        label: "MONITOR_DISABLED",
        summary: { items_suspicious: 0 },
        decisions: { suspicious_items: [] },
      }),
    ).toMatchObject({
      status: "clean",
      pauseAdjacentProduction: false,
      validationRequired: "none",
      closureRule:
        "MONITOR_DISABLED is passive only when no active Cleanup Crew or active-production mission is open",
      items: [],
    });
  });

  it("turns MONITOR_DISABLED into repair work during an active Cleanup Crew mission", () => {
    const decision = resolveWatchdogNeedsReviewReconciliation(
      {
        label: "MONITOR_DISABLED",
        summary: { items_suspicious: 0 },
        decisions: { suspicious_items: [] },
      },
      {
        activeCleanupCrewMission: true,
        activeProductionFlowIds: ["flow-cleanup-1"],
      },
    );

    expect(decision).toMatchObject({
      status: "needs_review",
      pauseAdjacentProduction: true,
      duplicateSuppressionScope: "chat_delivery_only",
      inspectionRequired: true,
      classificationRequired: true,
      artifactRequired: true,
      validationRequired: "rerun_watchdog",
      finalTruthReportRequired: true,
    });
    expect(decision.closureRule).toContain("active monitor proof");
    expect(decision.closureRule).toContain("WATCHDOG STATUS: CLEAN | suspicious_count=0");
    expect(decision.items).toEqual([
      {
        entityType: "watchdog_monitor",
        entityId: "flow-cleanup-1",
        policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
        canonicalPriority: "P4_RESTART_OR_RUNTIME_RECOVERY",
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
        cleanupCrewRecoveryBridge: expect.objectContaining({
          schema: "openclaw.watchdog_cleanup_crew_recovery_bridge.v1",
          policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
          canonicalPriority: "P4_RESTART_OR_RUNTIME_RECOVERY",
          stoppageReceipt: expect.objectContaining({
            stoppageClass: "watchdog_monitor_disabled",
            nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
          }),
          planAmendment: expect.objectContaining({
            required: true,
            nextExecutableCommand: "rerun_system_wide_active_work_watchdog",
          }),
          resume: expect.objectContaining({
            requiresPlanReload: true,
            proofTarget:
              "WATCHDOG STATUS: CLEAN | suspicious_count=0 plus worker/continuation/delivery/runtime/record-integrity/repair-closure/policy-version coverage",
          }),
        }),
        reason:
          "MONITOR_DISABLED during active Cleanup Crew production is active repair work, not clean proof",
      },
    ]);
  });

  it("does not let MONITOR_DISABLED pass final closeout during active production", () => {
    const decision = resolveWatchdogNeedsReviewReconciliation(
      {
        status: "MONITOR_DISABLED",
        summary: { items_suspicious: 0 },
      },
      {
        activeProductionFlowIds: ["flow-active-production"],
      },
    );

    expect(decision.status).toBe("needs_review");
    expect(decision.pauseAdjacentProduction).toBe(true);
    expect(decision.validationRequired).toBe("rerun_watchdog");
    expect(decision.closureRule).not.toBe(
      "fresh watchdog run already proves WATCHDOG STATUS: CLEAN | suspicious_count=0",
    );
  });

  it("does not accept source/test watchdog output as live active-monitor proof", () => {
    const decision = resolveWatchdogNeedsReviewReconciliation(
      {
        label: "MONITOR_DISABLED",
        summary: { items_suspicious: 0 },
      },
      {
        activeCleanupCrewMission: true,
        sourceOnlyProof: true,
      },
    );

    expect(decision).toMatchObject({
      status: "needs_review",
      validationRequired: "rerun_watchdog",
      items: [
        expect.objectContaining({
          classification: "cron/watchdog state mismatch",
          repairRoute: "cleanup_crew_repair",
          reason:
            "source/test watchdog proof cannot substitute for live active-monitor proof during an active Cleanup Crew mission",
        }),
      ],
    });
  });

  it("requires inspection, artifact creation, rerun, and final truth for NEEDS_REVIEW", () => {
    const decision = resolveWatchdogNeedsReviewReconciliation({
      label: "NEEDS_REVIEW",
      summary: { items_suspicious: 1 },
      decisions: {
        suspicious_items: [
          {
            entity_type: "flow_run",
            entity_id: "flow-1",
            category: "stale",
            raw_status: "running",
            reason: "flow lacks recent progress",
            real_worker_active: false,
            lawful_blocker: false,
          },
        ],
      },
    });

    expect(decision).toMatchObject({
      status: "needs_review",
      pauseAdjacentProduction: true,
      duplicateSuppressionScope: "chat_delivery_only",
      inspectionRequired: true,
      classificationRequired: true,
      artifactRequired: true,
      validationRequired: "rerun_watchdog",
      finalTruthReportRequired: true,
    });
    expect(decision.closureRule).toContain("fresh WATCHDOG STATUS: CLEAN");
    expect(decision.items).toEqual([
      {
        entityType: "flow_run",
        entityId: "flow-1",
        policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
        canonicalPriority: "P3_CORRUPTED_STATE",
        classification: "stale running state",
        repairRoute: "cleanup_crew_repair",
        validationRequired: "rerun_watchdog",
        stoppageClass: "watchdog_needs_review",
        pauseForAnalysis: true,
        pauseAdjacentProduction: true,
        routeToCleanupCrewRecovery: true,
        cleanupRecoveryAllowed: true,
        markDecisionRequired: false,
        nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
        planAmendmentRequired: true,
        nextExecutableCommand: "rerun_system_wide_active_work_watchdog",
        cleanupCrewRecoveryBridge: expect.objectContaining({
          schema: "openclaw.watchdog_cleanup_crew_recovery_bridge.v1",
          stoppageReceipt: expect.objectContaining({
            stoppageClass: "watchdog_needs_review",
            suspectedAffectedSurface: "flow_run:flow-1:stale running state",
          }),
          readOnlyAnalysis: expect.objectContaining({
            laneClassification: "lane_b_plan_driven_build_work",
            pathRisk: "MEDIUM_RISK_RUNTIME",
          }),
          planAmendment: expect.objectContaining({
            required: true,
            nextExecutableCommand: "rerun_system_wide_active_work_watchdog",
          }),
          durableRepairWork: expect.objectContaining({
            required: true,
            createBeforeAlertAcknowledgement: true,
            acknowledgementRule:
              "acknowledge_only_after_repair_completion_and_fresh_clean_watchdog",
            duplicateAlertHandling: "reuse_pending_repair_work",
          }),
        }),
        reason: "flow lacks recent progress",
      },
    ]);
  });

  it("does not let duplicate suppression suppress reconciliation work", () => {
    const decision = resolveWatchdogNeedsReviewReconciliation({
      label: "NEEDS_REVIEW",
      summary: { items_suspicious: 1 },
      decisions: {
        suspicious_items: [
          {
            entity_type: "flow_run",
            entity_id: "flow-duplicate",
            category: "pending_milestone_report",
            reason: "duplicate chat delivery suppressed",
          },
        ],
      },
    });

    expect(decision.duplicateSuppressionScope).toBe("chat_delivery_only");
    expect(decision.inspectionRequired).toBe(true);
    expect(decision.classificationRequired).toBe(true);
    expect(decision.artifactRequired).toBe(true);
    expect(decision.validationRequired).toBe("rerun_watchdog");
    expect(decision.finalTruthReportRequired).toBe(true);
    expect(decision.items[0]).toMatchObject({
      stoppageClass: "watchdog_needs_review",
      pauseForAnalysis: true,
      pauseAdjacentProduction: true,
      routeToCleanupCrewRecovery: true,
      cleanupRecoveryAllowed: true,
      markDecisionRequired: false,
      planAmendmentRequired: true,
      nextExecutableCommand: "rerun_system_wide_active_work_watchdog",
    });
  });

  it("does not require a plan amendment when the suspicious item is a true active worker", () => {
    const decision = resolveWatchdogNeedsReviewReconciliation({
      label: "NEEDS_REVIEW",
      summary: { items_suspicious: 1 },
      decisions: {
        suspicious_items: [
          {
            entity_type: "subagent_run",
            entity_id: "run-active",
            category: "active_with_worker",
            real_worker_active: true,
            reason: "worker is actively producing output",
          },
        ],
      },
    });

    expect(decision.items[0]).toMatchObject({
      classification: "true active worker",
      repairRoute: "observe_active",
      pauseForAnalysis: true,
      pauseAdjacentProduction: true,
      routeToCleanupCrewRecovery: false,
      cleanupRecoveryAllowed: false,
      markDecisionRequired: false,
      planAmendmentRequired: false,
    });
  });

  it("routes active-no-worker and corrupted TaskFlow pointers into Cleanup Crew recovery by default", () => {
    const decision = resolveWatchdogNeedsReviewReconciliation({
      label: "NEEDS_REVIEW",
      summary: { items_suspicious: 1 },
      decisions: {
        suspicious_items: [
          {
            entity_type: "flow_run",
            entity_id: "flow-lost-child",
            category: "active_no_worker",
            reason:
              "running active production flow has a lost child task and no active child owner",
            proof: { invalid_backing_child_tasks: 1, lost_child_tasks: 1 },
          },
        ],
      },
    });

    expect(decision.items[0]).toMatchObject({
      classification: "corrupted taskflow pointer",
      repairRoute: "cleanup_crew_repair",
      pauseAdjacentProduction: true,
      routeToCleanupCrewRecovery: true,
      cleanupRecoveryAllowed: true,
      markDecisionRequired: false,
      planAmendmentRequired: true,
      cleanupCrewRecoveryBridge: expect.objectContaining({
        planAmendment: expect.objectContaining({
          proofArtifacts: expect.arrayContaining(["fresh system-wide watchdog receipt"]),
        }),
        resume: expect.objectContaining({
          command: "rerun_system_wide_active_work_watchdog",
        }),
      }),
    });
  });

  it("does not turn stale-worker investigation metadata into a false Mark approval gate", () => {
    const decision = resolveWatchdogNeedsReviewReconciliation({
      label: "NEEDS_REVIEW",
      summary: { items_suspicious: 1 },
      decisions: {
        suspicious_items: [
          {
            entity_type: "flow_run",
            entity_id: "flow-relaunch-risk",
            category: "active_no_worker",
            reason:
              "running active production flow has a lost child task and no active child owner",
            suggested_next_step: {
              recommendation_code: "investigate_active_no_worker",
              recommendation: "Investigate worker/session evidence before any restart.",
              owner_approval_required: true,
            },
          },
        ],
      },
    });

    expect(decision.items[0]).toMatchObject({
      classification: "corrupted taskflow pointer",
      repairRoute: "cleanup_crew_repair",
      pauseAdjacentProduction: true,
      routeToCleanupCrewRecovery: true,
      cleanupRecoveryAllowed: true,
      markDecisionRequired: false,
      planAmendmentRequired: true,
      cleanupCrewRecoveryBridge: expect.objectContaining({
        durableRepairWork: expect.objectContaining({
          idempotencyKey:
            "watchdog:watchdog_needs_review:flow_run:flow-relaunch-risk:corrupted_taskflow_pointer",
          createBeforeAlertAcknowledgement: true,
        }),
      }),
    });
    expect(decision.items[0]?.hardStopReason).toBeUndefined();
  });

  it("still hard-stops explicit owner-decision recommendations", () => {
    const decision = resolveWatchdogNeedsReviewReconciliation({
      label: "NEEDS_REVIEW",
      summary: { items_suspicious: 1 },
      decisions: {
        suspicious_items: [
          {
            entity_type: "flow_run",
            entity_id: "flow-owner-decision",
            category: "waiting_on_owner",
            reason: "owner decision is required before work can proceed",
            suggested_next_step: {
              recommendation_code: "owner_decision_required",
              recommendation: "Ask Mark for the pending owner decision.",
              owner_approval_required: true,
            },
          },
        ],
      },
    });

    expect(decision.items[0]).toMatchObject({
      classification: "real production blocker",
      routeToCleanupCrewRecovery: true,
      cleanupRecoveryAllowed: false,
      markDecisionRequired: true,
      hardStopReason: "owner_decision_required_before_worker_relaunch",
    });
    expect(decision.items[0]?.cleanupCrewRecoveryBridge).toBeUndefined();
  });

  it.each([
    [
      { entity_type: "subagent_run", category: "active_with_worker", real_worker_active: true },
      "true active worker",
    ],
    [
      { entity_type: "flow_run", raw_status: "blocked", category: "blocked_lawful" },
      "stale blocked flow",
    ],
    [{ category: "needs_final_delivery" }, "missing closeout"],
    [{ entity_type: "task_run", category: "lost" }, "orphaned task"],
    [
      {
        entity_type: "flow_run",
        category: "active_no_worker",
        proof: { invalid_backing_child_tasks: 1 },
      },
      "corrupted taskflow pointer",
    ],
    [{ entity_type: "cron_job", category: "cron_stale" }, "cron/watchdog state mismatch"],
    [{ category: "pending_report_delivery" }, "real production blocker"],
  ] as const)("classifies %j as %s", (item, expected) => {
    expect(classifyWatchdogSuspiciousItem(item)).toBe(expected);
  });
});
