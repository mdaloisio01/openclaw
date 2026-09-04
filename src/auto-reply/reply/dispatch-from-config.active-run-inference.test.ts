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

  it("infers routed owner-boundary stops as lawful still-open stops", () => {
    const payload = {
      text: "routed to lawful owner, build still open.",
    } satisfies ReplyPayload;

    expect(dispatchFromConfigTesting.inferActiveRunContinuationFromPayload(payload)).toEqual({
      stopAllowed: true,
      stopReason: "owner_boundary_stop",
      openTruth: "routed to lawful owner, build still open.",
    });
  });

  it("infers blocked SOP section reports with a lawful next action as lawful blockers", () => {
    const payload = {
      text: [
        "Status: blocked, build still open.",
        "Phase: ACP/session path verification.",
        "Current blocker: ACP route failed before acknowledgement.",
        "Who lawfully owns the next step: Will routes to ACP setup/rebind.",
        "Exact next action: repair the ACP route, then rerun only this bounded acknowledgement slice.",
      ].join("\n"),
    } satisfies ReplyPayload;

    expect(dispatchFromConfigTesting.inferActiveRunContinuationFromPayload(payload)).toEqual({
      stopAllowed: true,
      stopReason: "blocker",
      openTruth: "blocked with lawful next action recorded.",
    });
  });

  it("infers route/session binding failures as hard-stop blockers", () => {
    const payload = {
      text: "Phase 5 is open and blocked. The ACP session initialization failed because metadata is missing and the route must be recreated/rebound.",
    } satisfies ReplyPayload;

    expect(dispatchFromConfigTesting.inferActiveRunContinuationFromPayload(payload)).toEqual({
      stopAllowed: true,
      stopReason: "hard_stop",
      openTruth: "build still open; route/session binding blocker recorded.",
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
