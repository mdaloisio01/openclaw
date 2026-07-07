import { describe, expect, it } from "vitest";
import {
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
  it("blocks artifact-only report completion when chat body was not delivered", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        reportBodyDeliveredInChat: false,
      }),
    ).toEqual({
      state: "pending_report_delivery",
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
      shouldContinue: true,
      allowedToAdvance: false,
      nextAction: "report unproven proof status and rerun the interrupted proof check",
    });
  });
});
