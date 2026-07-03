import { describe, expect, it } from "vitest";
import { resolveReportDeliveryGuard } from "./report-delivery-guard.js";

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
});
