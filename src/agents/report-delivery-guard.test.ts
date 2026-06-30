import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { AssistantMessage } from "../llm/types.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import {
  buildPendingMilestoneReportNotice,
  enforceReportDeliveryText,
  validateMilestoneReportText,
  validateReportDeliveryText,
  validateReportGovernedStageAdvance,
} from "./report-delivery-guard.js";

const artifactPath =
  "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/security_review_report_2026-06-29T2341Z.md";

describe("report delivery guard", () => {
  it("fails artifact-only delivery when report delivery is required", () => {
    const result = validateReportDeliveryText(`Report written here: ${artifactPath}`);

    expect(result).toMatchObject({
      ok: false,
      reason: "missing_chat_report_body",
      pendingReportDelivery: true,
      artifactPaths: [artifactPath],
    });
  });

  it("passes a full chat report that also includes the artifact path", () => {
    const result = validateReportDeliveryText(
      [
        "STATUS: Success",
        "MODE: Security review",
        "ACTION TAKEN: Reviewed the target and wrote the proof artifact.",
        "TESTS / PROOF: Static review passed.",
        "BLOCKERS: None.",
        `ARTIFACT: ${artifactPath}`,
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: true,
      reason: "report_body_present",
      artifactPaths: [artifactPath],
    });
  });

  it("allows artifact-only delivery only when explicitly marked as requested", () => {
    const result = validateReportDeliveryText(`Report written here: ${artifactPath}`, {
      explicitArtifactOnlyAllowed: true,
    });

    expect(result).toMatchObject({
      ok: true,
      reason: "artifact_only_allowed",
      artifactPaths: [artifactPath],
    });
  });

  it("does not let a short TLDR override report body delivery", () => {
    const result = validateReportDeliveryText(
      `TL;DR: done.\nReport saved: file_hub/exports/runtime_fix_closeout_2026-06-29T2341Z.md`,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_chat_report_body");
  });

  it("rejects report-written-only wording even without a parsed artifact path", () => {
    const result = validateReportDeliveryText("Report written here.");

    expect(result.ok).toBe(false);
    expect(result.pendingReportDelivery).toBe(true);
  });

  it("corrects missing chat report body into a visible pending delivery failure", () => {
    const result = enforceReportDeliveryText(`Report saved: ${artifactPath}`);

    expect(result.text).toContain("STATUS: Blocked");
    expect(result.text).toContain("MODE: System-wide report delivery validator");
    expect(result.text).toContain("pending_report_delivery");
    expect(result.text).toContain(artifactPath);
  });

  it("applies outside Cleanup Crew reports", () => {
    const result = validateReportDeliveryText(
      "Research pass report saved: file_hub/exports/r_and_d_review_report_2026-06-29T2341Z.md",
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_chat_report_body");
  });

  it("marks final payloads with pending report delivery metadata", () => {
    const finalText = `Report written here: ${artifactPath}`;
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [finalText],
      toolMetas: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: finalText }],
      } as AssistantMessage,
      currentAssistant: undefined,
      isCronTrigger: false,
      sessionKey: "session:webchat",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("STATUS: Blocked");
    expect(payloads[0]?.text).toContain("pending_report_delivery");
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      pendingReportDelivery: {
        reason: "missing_chat_report_body",
        artifactPaths: [artifactPath],
      },
    });
  });

  it("requires a build-complete milestone report before asset guard", () => {
    const result = validateReportGovernedStageAdvance({
      report_governed_mission: true,
      current_stage: "build",
      next_stage: "asset guard",
      stage_complete_pending_report: true,
      milestone_report_delivered: false,
      final_closeout_required: true,
      final_closeout_delivered: false,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "missing_milestone_report",
      pendingMilestoneReport: true,
      currentStage: "build",
      nextStage: "asset guard",
    });
  });

  it("requires an asset-guard milestone report before restart", () => {
    const result = validateReportGovernedStageAdvance({
      report_governed_mission: true,
      current_stage: "asset guard",
      next_stage: "gateway restart",
      stage_complete_pending_report: true,
      milestone_report_delivered: false,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_milestone_report");
    expect(buildPendingMilestoneReportNotice(result)).toContain("pending_milestone_report");
  });

  it("requires a restart-complete milestone report before runtime proof", () => {
    const result = validateReportGovernedStageAdvance({
      report_governed_mission: true,
      current_stage: "gateway restart",
      next_stage: "runtime proof",
      stage_complete_pending_report: true,
      milestone_report_delivered: false,
    });

    expect(result.ok).toBe(false);
    expect(result.currentStage).toBe("gateway restart");
    expect(result.nextStage).toBe("runtime proof");
  });

  it("accepts a delivered milestone report before advancing", () => {
    const result = validateReportGovernedStageAdvance({
      report_governed_mission: true,
      current_stage: "test",
      next_stage: "commit",
      stage_complete_pending_report: true,
      milestone_report_delivered: true,
    });

    expect(result.ok).toBe(true);
  });

  it("validates the minimum milestone report body", () => {
    const result = validateMilestoneReportText(
      [
        "STATUS: Success",
        "MODE: System-wide reporting law repair",
        "STAGE COMPLETE: Build",
        "RESULT: Build passed.",
        "PROOF: npm run build exited 0.",
        "NEXT STAGE: Asset guard.",
        "SAFETY CHECK: No forbidden scope.",
        "BLOCKERS: None.",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: true,
      reason: "milestone_body_present",
    });
  });

  it("records interrupted restart or tool calls as not-proven milestone obligations", () => {
    const result = validateReportGovernedStageAdvance({
      report_governed_mission: true,
      current_stage: "gateway restart",
      next_stage: "runtime proof",
      interrupted_stage_pending_report: true,
      milestone_report_delivered: false,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "interrupted_stage_not_reported",
      pendingMilestoneReport: true,
    });
    expect(buildPendingMilestoneReportNotice(result)).toContain("not-proven report");
  });

  it("applies milestone enforcement outside Cleanup Crew", () => {
    const result = validateReportGovernedStageAdvance({
      report_governed_mission: true,
      current_stage: "research proof",
      next_stage: "readiness decision",
      stage_complete_pending_report: true,
      milestone_report_delivered: false,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_milestone_report");
  });

  it("allows milestone suppression only when explicitly marked by the caller", () => {
    const result = validateReportGovernedStageAdvance(
      {
        report_governed_mission: true,
        current_stage: "build",
        next_stage: "asset guard",
        stage_complete_pending_report: true,
        milestone_report_delivered: false,
      },
      { explicitNoUpdatesAllowed: true },
    );

    expect(result).toMatchObject({
      ok: true,
      reason: "milestone_updates_explicitly_suppressed",
    });
  });
});
