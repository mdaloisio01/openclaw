import { describe, expect, it } from "vitest";
import { setReplyPayloadMetadata, type ReplyPayload } from "../types.js";
import { testing as dispatchFromConfigTesting } from "./dispatch-from-config.js";

describe("dispatch-from-config active-run continuation inference", () => {
  it("infers still-open continuation truth from a local-slice-complete final payload", () => {
    const payload = {
      text: "Background task local slice complete: package updated.\nOpen/closed truth: local slice complete; broader mission still open.\nExact next action: continue the active halt-build repair path.",
    } satisfies ReplyPayload;

    expect(dispatchFromConfigTesting.inferActiveRunContinuationFromPayload(payload)).toEqual({
      stopAllowed: false,
      stopReason: "local_slice_complete_broader_mission_open",
      openTruth: "local slice complete; broader mission still open",
    });
  });

  it("keeps explicit continuation metadata authoritative when present", () => {
    const payload = setReplyPayloadMetadata(
      {
        text: "Open/closed truth: owner execution in progress, build still open.",
      } satisfies ReplyPayload,
      {
        activeRunContinuation: {
          stopAllowed: true,
          stopReason: "blocker",
          openTruth: "owner execution in progress, build still open.",
        },
      },
    );

    expect(dispatchFromConfigTesting.inferActiveRunContinuationFromPayload(payload)).toEqual({
      stopAllowed: true,
      stopReason: "blocker",
      openTruth: "owner execution in progress, build still open.",
    });
  });

  it("infers approval waiting as a lawful still-open stop", () => {
    const payload = {
      text: "paperwork/setup done, build still open. Waiting on operator approval to stage, restart, and live-validate.",
    } satisfies ReplyPayload;

    expect(dispatchFromConfigTesting.inferActiveRunContinuationFromPayload(payload)).toEqual({
      stopAllowed: true,
      stopReason: "approval_blocked",
      openTruth: "build still open; waiting on approval.",
    });
  });

  it("infers restart authorization waiting as a lawful still-open stop", () => {
    const payload = {
      text: "What is still not real yet: live activation. Open/closed truth: build still open; waiting on restart/reload authorization.",
    } satisfies ReplyPayload;

    expect(dispatchFromConfigTesting.inferActiveRunContinuationFromPayload(payload)).toEqual({
      stopAllowed: true,
      stopReason: "restart_or_reload",
      openTruth: "build still open; waiting on restart/reload authorization.",
    });
  });
});
