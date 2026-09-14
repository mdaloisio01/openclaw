import { describe, expect, it, vi } from "vitest";
import {
  GOVERNED_FINAL_RELEASE_WITHHELD_NOTICE,
  type GovernedFinalReleaseDecision,
} from "../../governance/governed-final-release-decision.js";
import { setReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import { buildGovernedWebChatFinalReleaseBeforeDeliver } from "./governed-webchat-release-adapter.js";

const governedRelease = {
  missionId: "mission-release",
  runId: "run-1",
  contractId: "contract-release",
  contractHash: "contract-hash",
  payloadHash: "payload-hash-1",
};

function decision(allowed: boolean): GovernedFinalReleaseDecision {
  return {
    schema: "openclaw.governed_final_release_decision.v1",
    decisionVersion: "governed-final-release-decision-v1",
    allowed,
    reason: allowed ? "allowed" : "release_state_missing",
    check: governedRelease,
  };
}

function governedPayload(payload: ReplyPayload = { text: "model final" }): ReplyPayload {
  return setReplyPayloadMetadata(payload, {
    governedFinalRelease: governedRelease,
  });
}

describe("governed WebChat release adapter", () => {
  it("passes non-WebChat channels through without a release adapter", () => {
    expect(buildGovernedWebChatFinalReleaseBeforeDeliver({ channel: "telegram" })).toBeUndefined();
  });

  it("passes non-final and non-governed WebChat payloads through", async () => {
    const adapter = buildGovernedWebChatFinalReleaseBeforeDeliver({ channel: "webchat" });
    expect(adapter).toBeDefined();
    await expect(adapter?.(governedPayload(), { kind: "block" })).resolves.toEqual({
      text: "model final",
    });
    await expect(adapter?.({ text: "ordinary final" }, { kind: "final" })).resolves.toEqual({
      text: "ordinary final",
    });
  });

  it("allows governed WebChat final payloads only when the shared decision allows", async () => {
    const provider = vi.fn(async () => decision(true));
    const adapter = buildGovernedWebChatFinalReleaseBeforeDeliver({
      channel: "webchat",
      decisionProvider: provider,
    });
    const payload = governedPayload({ text: "approved final" });

    await expect(adapter?.(payload, { kind: "final" })).resolves.toBe(payload);
    expect(provider).toHaveBeenCalledWith(governedRelease);
  });

  it("withholds governed WebChat final payloads when the shared decision denies", async () => {
    const adapter = buildGovernedWebChatFinalReleaseBeforeDeliver({
      channel: "webchat",
      decisionProvider: async () => decision(false),
    });

    await expect(
      adapter?.(
        governedPayload({
          text: "unvalidated model final",
          mediaUrl: "file:///tmp/unsafe.png",
          presentation: { blocks: [{ type: "text", text: "unsafe" }] },
        }),
        { kind: "final" },
      ),
    ).resolves.toEqual({
      text: GOVERNED_FINAL_RELEASE_WITHHELD_NOTICE,
      isStatusNotice: true,
    });
  });

  it("withholds governed WebChat final payloads when the decision provider throws or times out", async () => {
    const throwing = buildGovernedWebChatFinalReleaseBeforeDeliver({
      channel: "webchat",
      decisionProvider: async () => {
        throw new Error("state unavailable");
      },
    });
    await expect(throwing?.(governedPayload(), { kind: "final" })).resolves.toEqual({
      text: GOVERNED_FINAL_RELEASE_WITHHELD_NOTICE,
      isStatusNotice: true,
    });

    vi.useFakeTimers();
    try {
      const timeout = buildGovernedWebChatFinalReleaseBeforeDeliver({
        channel: "webchat",
        timeoutMs: 5,
        decisionProvider: () =>
          new Promise<GovernedFinalReleaseDecision>((resolve) => {
            setTimeout(() => resolve(decision(true)), 50);
          }),
      });
      const result = timeout?.(governedPayload(), { kind: "final" });
      await vi.advanceTimersByTimeAsync(5);
      await expect(result).resolves.toEqual({
        text: GOVERNED_FINAL_RELEASE_WITHHELD_NOTICE,
        isStatusNotice: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
