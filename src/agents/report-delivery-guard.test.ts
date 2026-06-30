import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { AssistantMessage } from "../llm/types.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import { enforceReportDeliveryText, validateReportDeliveryText } from "./report-delivery-guard.js";

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
});
