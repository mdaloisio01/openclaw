import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import {
  buildPrivateMessageToolFinalDeliveryError,
  resolvePrivateMessageToolFinalRepairText,
  shouldWarnAboutPrivateMessageToolFinal,
} from "./private-message-tool-final.js";

const base = {
  sourceReplyDeliveryMode: "message_tool_only" as const,
  sendPolicyDenied: false,
  successfulSourceReplyDelivery: false,
  finalText:
    "Here is the answer the user asked for. It includes enough detail to look like a visible response rather than an internal no-op note.",
};

describe("shouldWarnAboutPrivateMessageToolFinal", () => {
  it("flags a short substantive private final that was never delivered via the message tool (#85714)", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({
        ...base,
        finalText: "Yes, I can handle that.",
      }),
    ).toBe(true);
  });

  it("flags a multi-sentence private final that was never delivered via the message tool (#85714)", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal(base)).toBe(true);
  });

  it("flags a long private final even without multiple sentence terminators", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({
        ...base,
        finalText: "x".repeat(280),
      }),
    ).toBe(true);
  });

  it("does not flag automatic delivery mode (final text is delivered normally)", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, sourceReplyDeliveryMode: "automatic" }),
    ).toBe(false);
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, sourceReplyDeliveryMode: undefined }),
    ).toBe(false);
  });

  it("does not flag when the message tool already delivered this turn", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, successfulSourceReplyDelivery: true }),
    ).toBe(false);
  });

  it("does not flag silent sentinel variants (intentional silence)", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "NO_REPLY" })).toBe(false);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "  no_reply  " })).toBe(
      false,
    );
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "NO_REPLY\n\nNO_REPLY" }),
    ).toBe(false);
  });

  it("does not flag empty or whitespace-only final text", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "" })).toBe(false);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "   \n " })).toBe(false);
  });

  it("does not flag when delivery was intentionally denied by send policy", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, sendPolicyDenied: true })).toBe(false);
  });

  it("captures trimmed repair text for private finals that missed the message tool", () => {
    expect(
      resolvePrivateMessageToolFinalRepairText({
        ...base,
        finalText: "  Visible answer  ",
      }),
    ).toBe("Visible answer");
  });

  it("does not create repair text when the source reply was already delivered", () => {
    expect(
      resolvePrivateMessageToolFinalRepairText({
        ...base,
        successfulSourceReplyDelivery: true,
      }),
    ).toBeUndefined();
  });

  it("builds a visible delivery error without exposing the private final body", () => {
    const payload = buildPrivateMessageToolFinalDeliveryError();
    expect(payload.isError).toBe(true);
    expect(payload.text).toContain("did not use the required source delivery tool");
    expect(payload.text).toContain("private reply body was withheld");
    expect(payload.text).toContain("requires recovery");
    expect(payload.text).not.toContain(base.finalText);
    expect(getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression).toBe(true);
  });
});
