import { describe, expect, it } from "vitest";
import {
  CLEANUP_WATCHDOG_CLEAN_DIMENSIONS,
  CLEANUP_WATCHDOG_POLICY_VERSION,
  getCleanupWatchdogPriority,
} from "../governance/cleanup-watchdog-policy.js";
import {
  CLEANUP_CREW_CANONICAL_POLICY_PROMPT,
  resolveCleanupCrewReportDeliveryRepair,
  resolveCleanupCrewStageTransition,
  resolveReportDeliveryGuard,
  validateMilestoneReportFormat,
} from "./report-delivery-guard.js";

const VALID_MILESTONE_REPORT = [
  "STATUS: In Progress",
  "MODE: Cleanup Crew execution",
  "STAGE COMPLETE: focused test complete",
  "RESULT: PASS",
  "PROOF: focused test output",
  "NEXT STAGE: continue",
  "SAFETY CHECK: no blockers",
  "BLOCKERS: none",
].join("\n");

describe("report delivery guard", () => {
  it("normalizes Cleanup Crew prompt guidance to the canonical governance policy", () => {
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(
      "cleanup-crew-governance-final-20260714T1454Z",
    );
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(CLEANUP_WATCHDOG_POLICY_VERSION);
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("ACTION_BLOCKED");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("MALFORMED_POLICY_INPUT");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("OWNER_DECISION_REQUIRED");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("EXTERNAL_DEPENDENCY");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("MISSION_ABORTED");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("mission-bound exhaustion receipt");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(
      `Watchdog active worker recovery priority: ${getCleanupWatchdogPriority("active_no_worker")}.`,
    );
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(
      `Report-delivery debt priority: ${getCleanupWatchdogPriority("pending_report_delivery")}.`,
    );
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(
      `Watchdog CLEAN requires dimensions: ${CLEANUP_WATCHDOG_CLEAN_DIMENSIONS.join(", ")}.`,
    );
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("worker_coverage");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("mission resumption");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("duplicate delivery");
  });

  it("blocks artifact-only report completion when chat body was not delivered", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        reportBodyDeliveredInChat: false,
      }),
    ).toEqual({
      state: "pending_report_delivery",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: getCleanupWatchdogPriority("pending_report_delivery"),
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "artifact_only_without_chat_body",
    });
  });

  it("passes when report body was delivered in chat with a report path", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        reportBodyDeliveredInChat: true,
      }),
    ).toEqual({
      state: "report_delivery_satisfied",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      allowed: true,
      reportDeliveryComplete: true,
      milestoneReportComplete: true,
      reason: "report_body_delivered",
    });
  });

  it("allows explicit artifact-only report delivery", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        explicitArtifactOnlyAllowed: true,
      }),
    ).toMatchObject({
      state: "report_delivery_satisfied",
      allowed: true,
      reportDeliveryComplete: true,
      reason: "explicit_artifact_only_allowed",
    });
  });

  it("blocks private-only final reports without source chat report body delivery", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        privateOnlyFinalResponse: true,
      }),
    ).toMatchObject({
      state: "blocked_private_only_report",
      allowed: false,
      reportDeliveryComplete: false,
      reason: "private_only_report_without_chat_body",
    });
  });

  it("blocks generated reports missing a report artifact path", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportBodyDeliveredInChat: true,
      }),
    ).toMatchObject({
      state: "blocked_missing_report_path",
      allowed: false,
      reportDeliveryComplete: false,
      reason: "missing_report_path",
    });
  });

  it("blocks completed milestone stages when the milestone report was not delivered", () => {
    expect(
      resolveReportDeliveryGuard({
        milestoneStageCompleted: true,
        milestoneReportRequired: true,
        milestoneReportDelivered: false,
      }),
    ).toEqual({
      state: "pending_milestone_report",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: getCleanupWatchdogPriority("pending_milestone_report"),
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "milestone_stage_report_missing",
    });
  });

  it("passes completed milestone stages when the milestone report was delivered", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        reportBodyDeliveredInChat: true,
        milestoneStageCompleted: true,
        milestoneReportRequired: true,
        milestoneReportDelivered: true,
      }),
    ).toMatchObject({
      state: "report_delivery_satisfied",
      allowed: true,
      reportDeliveryComplete: true,
      milestoneReportComplete: true,
    });
  });

  it("does not block ordinary non-report replies", () => {
    expect(resolveReportDeliveryGuard({})).toEqual({
      state: "not_required",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      allowed: true,
      reportDeliveryComplete: false,
      milestoneReportComplete: true,
      reason: "not_required",
    });
  });

  it("validates the required Cleanup Crew milestone report fields", () => {
    expect(validateMilestoneReportFormat(VALID_MILESTONE_REPORT)).toEqual({
      valid: true,
      missingFields: [],
    });
    expect(validateMilestoneReportFormat("STATUS: only")).toEqual({
      valid: false,
      missingFields: [
        "MODE:",
        "STAGE COMPLETE:",
        "RESULT:",
        "PROOF:",
        "NEXT STAGE:",
        "SAFETY CHECK:",
        "BLOCKERS:",
      ],
    });
  });

  it("continues after a delivered milestone report because reporting is visibility, not permission", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "proof_passes",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
      }),
    ).toMatchObject({
      state: "continue_after_visibility_report",
      shouldContinue: true,
      allowedToAdvance: true,
      requiredReportDelivered: true,
    });
  });

  it("blocks phase transition when the required milestone report is missing or malformed", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "asset_guard_complete",
        milestoneReportText: "STATUS: missing the other required fields",
        milestoneReportDelivered: true,
      }),
    ).toMatchObject({
      state: "pending_milestone_report",
      shouldContinue: false,
      allowedToAdvance: false,
      requiredReportDelivered: false,
    });
  });

  it("stops after a delivered report when the operator asked for report-only status", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "explicit_status_or_report_request",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
        explicitReportOnlyRequest: true,
      }),
    ).toMatchObject({
      state: "stop_after_report_only_request",
      shouldContinue: false,
      allowedToAdvance: false,
      requiredReportDelivered: true,
    });
  });

  it("routes watchdog NEEDS_REVIEW ahead of adjacent production after the report is delivered", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "watchdog_needs_review",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
        watchdogNeedsReview: true,
      }),
    ).toMatchObject({
      state: "pause_for_watchdog_needs_review",
      shouldContinue: true,
      allowedToAdvance: false,
      canonicalPriority: getCleanupWatchdogPriority("active_no_worker"),
      nextAction:
        "route watchdog alert to Cleanup Crew recovery: inspect latest watchdog receipt, analyze read-only, amend active plan, resume recovery, rerun watchdog",
    });
  });

  it("routes Grant FAIL into repair instead of allowing completion", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "grant_fail",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
        grantFailed: true,
      }),
    ).toMatchObject({
      state: "route_grant_fail_repair",
      canonicalPriority: getCleanupWatchdogPriority("review_required_for_safe_work"),
      shouldContinue: true,
      allowedToAdvance: false,
      nextAction: "convert Grant findings into the next lawful repair batch",
    });
  });

  it("treats interrupted or aborted proof as unproven and names recovery work", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "interruption_or_aborted_tool",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
        proofInterruptedOrAborted: true,
      }),
    ).toMatchObject({
      state: "proof_unproven_recovery_required",
      canonicalPriority: getCleanupWatchdogPriority("missing_correctness_proof"),
      shouldContinue: true,
      allowedToAdvance: false,
      nextAction: "report unproven proof status and rerun the interrupted proof check",
    });
  });

  it("turns failed report delivery into repair work instead of mission closeout", () => {
    expect(
      resolveCleanupCrewReportDeliveryRepair({
        missionId: "cleanup-crew-governance",
        reportId: "grant-pass-delivery",
        reportGenerated: true,
        reportArtifactPath: "/tmp/grant-pass.md",
        deliveryFailed: true,
        registryRowPresent: true,
        parentMissionOpen: true,
      }),
    ).toMatchObject({
      state: "schedule_delivery_repair_work",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: getCleanupWatchdogPriority("pending_report_delivery"),
      allowedToAdvance: false,
      allowedToCloseMission: false,
      missionRemainsOpen: true,
      registryWorkRequired: true,
      repairWorkRequired: true,
      acknowledgementAllowed: false,
    });
  });

  it("keeps idempotent report repair pending until visible delivery or settlement proof exists", () => {
    expect(
      resolveCleanupCrewReportDeliveryRepair({
        missionId: "cleanup-crew-governance",
        reportId: "grant-pass-delivery",
        reportGenerated: true,
        reportArtifactPath: "/tmp/grant-pass.md",
        deliveryFailed: true,
        registryRowPresent: true,
        repairWorkScheduled: true,
        parentMissionOpen: true,
      }),
    ).toMatchObject({
      state: "repair_work_pending",
      allowedToAdvance: false,
      allowedToCloseMission: false,
      acknowledgementAllowed: false,
      nextAction: "complete idempotent report-delivery repair work before acknowledgement",
    });
  });

  it("allows continuation after later verified delivery settlement without closing the parent mission", () => {
    expect(
      resolveCleanupCrewReportDeliveryRepair({
        missionId: "cleanup-crew-governance",
        reportId: "grant-pass-delivery",
        reportGenerated: true,
        reportArtifactPath: "/tmp/grant-pass.md",
        deliveryFailed: true,
        registryRowPresent: true,
        verifiedLaterSettlementProof: "/tmp/settlement-receipt.json",
        parentMissionOpen: true,
      }),
    ).toMatchObject({
      state: "settled_by_later_verified_delivery",
      allowedToAdvance: true,
      allowedToCloseMission: false,
      missionRemainsOpen: true,
      registryWorkRequired: true,
      repairWorkRequired: false,
      acknowledgementAllowed: true,
    });
  });

  it("rejects malformed report-delivery state and parent closeout attempts", () => {
    const decision = resolveCleanupCrewReportDeliveryRepair({
      reportId: "grant-pass-delivery",
      reportGenerated: true,
      deliveryFailed: true,
      attemptedMissionCloseout: true,
    });

    expect(decision.state).toBe("invalid_report_delivery_state");
    expect(decision.allowedToCloseMission).toBe(false);
    expect(decision.acknowledgementAllowed).toBe(false);
    expect(decision.validationErrors).toEqual([
      "mission_id_missing",
      "report_artifact_path_missing",
      "parent_mission_open_proof_missing",
      "report_delivery_attempted_parent_closeout",
    ]);
  });
});
