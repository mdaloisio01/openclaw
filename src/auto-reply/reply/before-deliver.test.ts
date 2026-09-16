import { afterEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { clearAllDispatchers, getTotalPendingReplies } from "./dispatcher-registry.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

afterEach(() => {
  clearAllDispatchers();
});

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("beforeDeliver in reply dispatcher", () => {
  it("cancels delivery before queueing when transformReplyPayload returns null", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      transformReplyPayload: (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    expect(dispatcher.sendFinalReply({ text: "blocked reply" })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: "safe reply" })).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("cancels delivery when beforeDeliver returns null", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "blocked reply" });
    dispatcher.sendFinalReply({ text: "safe reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 2 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
  });

  it("allows modifying payload in beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("error")) {
          return { ...payload, text: "replaced" };
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "some error occurred" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["replaced"]);
  });

  it("delivers normally without beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    dispatcher.sendFinalReply({ text: "plain reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["plain reply"]);
  });
});

describe("final reply batch preparation", () => {
  it("prepares every post-hook final before transport and preserves surrounding send order", async () => {
    const toolStarted = createGate();
    const toolRelease = createGate();
    const prepareStarted = createGate();
    const prepareRelease = createGate();
    const order: string[] = [];
    const delivered: ReplyPayload[] = [];
    const transformReplyPayload = vi.fn((payload: ReplyPayload) => ({
      ...payload,
      text: `normalized:${payload.text}`,
    }));
    const beforeDeliver = vi.fn((payload: ReplyPayload) => ({
      ...payload,
      text: `${payload.text}:hooked`,
    }));
    const appendedHook = vi.fn((payload: ReplyPayload) => ({
      ...payload,
      text: `${payload.text}:appended`,
    }));
    const onIdle = vi.fn();
    const dispatcher = createReplyDispatcher({
      transformReplyPayload,
      beforeDeliver,
      onIdle,
      deliver: async (payload, { kind }) => {
        if (kind === "tool") {
          toolStarted.release();
          await toolRelease.promise;
        }
        order.push(`deliver:${kind}:${payload.text}`);
        delivered.push(payload);
      },
    });
    dispatcher.appendBeforeDeliver!(appendedHook);
    const prepare = vi.fn(async (payloads: readonly ReplyPayload[]) => {
      order.push("prepare");
      prepareStarted.release();
      await prepareRelease.promise;
      return payloads.map((payload, index) => ({ ...payload, replyToId: `saved-part-${index}` }));
    });

    dispatcher.sendToolResult({ text: "tool" });
    dispatcher.sendBlockReply({ text: "block" });
    expect(dispatcher.sendFinalReplyBatch!([{ text: "one" }, { text: "two" }], prepare)).toBe(true);
    dispatcher.sendFinalReply({ text: "after" });
    dispatcher.markComplete();
    await toolStarted.promise;
    expect(prepare).not.toHaveBeenCalled();
    toolRelease.release();
    await prepareStarted.promise;

    expect(prepare).toHaveBeenCalledExactlyOnceWith([
      { text: "normalized:one:hooked:appended" },
      { text: "normalized:two:hooked:appended" },
    ]);
    expect(delivered.map((payload) => payload.text)).toEqual([
      "normalized:tool:hooked:appended",
      "normalized:block:hooked:appended",
    ]);
    expect(getTotalPendingReplies()).toBe(4);
    expect(onIdle).not.toHaveBeenCalled();
    prepareRelease.release();
    await dispatcher.waitForIdle();

    expect(order).toEqual([
      "deliver:tool:normalized:tool:hooked:appended",
      "deliver:block:normalized:block:hooked:appended",
      "prepare",
      "deliver:final:normalized:one:hooked:appended",
      "deliver:final:normalized:two:hooked:appended",
      "deliver:final:normalized:after:hooked:appended",
    ]);
    expect(delivered.slice(2, 4).map((payload) => payload.replyToId)).toEqual([
      "saved-part-0",
      "saved-part-1",
    ]);
    expect(transformReplyPayload).toHaveBeenCalledTimes(5);
    expect(beforeDeliver).toHaveBeenCalledTimes(5);
    expect(appendedHook).toHaveBeenCalledTimes(5);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 1, block: 1, final: 3 });
    expect(dispatcher.getCancelledCounts!()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(getTotalPendingReplies()).toBe(0);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("prepares only surviving finals and counts normalization skips separately from hook cancellations", async () => {
    const deliver = vi.fn(async (_payload: ReplyPayload) => {});
    const onSkip = vi.fn();
    const beforeDeliver = vi.fn((payload: ReplyPayload) =>
      payload.text === "cancel" ? null : payload,
    );
    const dispatcher = createReplyDispatcher({
      deliver,
      onSkip,
      beforeDeliver,
      transformReplyPayload: (payload) => (payload.text === "normalize-drop" ? null : payload),
    });
    const prepare = vi.fn((payloads: readonly ReplyPayload[]) => payloads);
    expect(
      dispatcher.sendFinalReplyBatch!(
        [
          {},
          { text: SILENT_REPLY_TOKEN },
          { text: "normalize-drop" },
          { text: "cancel" },
          { text: "one" },
          { text: "two" },
        ],
        prepare,
      ),
    ).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(onSkip.mock.calls.map(([, info]) => info.reason)).toEqual(["empty", "silent"]);
    expect(beforeDeliver).toHaveBeenCalledTimes(3);
    expect(prepare).toHaveBeenCalledExactlyOnceWith([{ text: "one" }, { text: "two" }]);
    expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual(["one", "two"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 3 });
    expect(dispatcher.getCancelledCounts!()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(getTotalPendingReplies()).toBe(0);
  });

  it.each([
    {
      reason: "normalization",
      payloads: [{ text: SILENT_REPLY_TOKEN }],
      admitted: false,
      count: 0,
    },
    { reason: "hooks", payloads: [{ text: "cancel" }], admitted: true, count: 1 },
  ])(
    "does not prepare or send a batch entirely removed by $reason",
    async ({ payloads, admitted, count }) => {
      const deliver = vi.fn(async () => {});
      const prepare = vi.fn((finals: readonly ReplyPayload[]) => finals);
      const dispatcher = createReplyDispatcher({ deliver, beforeDeliver: () => null });
      expect(dispatcher.sendFinalReplyBatch!(payloads, prepare)).toBe(admitted);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(prepare).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(dispatcher.getQueuedCounts().final).toBe(count);
      expect(dispatcher.getCancelledCounts!().final).toBe(count);
      expect(dispatcher.getFailedCounts().final).toBe(0);
      expect(getTotalPendingReplies()).toBe(0);
    },
  );

  it.each(["hook", "prepare", "count"] as const)(
    "sends no partial batch when %s fails and releases every reservation",
    async (failure) => {
      const deliver = vi.fn(async () => {});
      const onError = vi.fn();
      const onIdle = vi.fn();
      const dispatcher = createReplyDispatcher({
        deliver,
        onError,
        onIdle,
        beforeDeliver: (payload) => {
          if (payload.text === "cancel") {
            return null;
          }
          if (failure === "hook" && payload.text === "two") {
            throw new Error("hook rejected");
          }
          return payload;
        },
      });
      const prepare = vi.fn(async (payloads: readonly ReplyPayload[]) => {
        if (failure === "prepare") {
          throw new Error("receipt store unavailable");
        }
        return failure === "count" ? payloads.slice(1) : payloads;
      });
      dispatcher.sendFinalReplyBatch!(
        [{ text: "cancel" }, { text: "one" }, { text: "two" }],
        prepare,
      );
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(deliver).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledTimes(failure === "hook" ? 0 : 1);
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(Error), { kind: "final" });
      expect(dispatcher.getQueuedCounts().final).toBe(3);
      expect(dispatcher.getCancelledCounts!().final).toBe(1);
      expect(dispatcher.getFailedCounts().final).toBe(2);
      expect(getTotalPendingReplies()).toBe(0);
      expect(onIdle).toHaveBeenCalledTimes(1);
    },
  );

  it("counts the failed part and unsent remainder after partial transport failure", async () => {
    const sent: string[] = [];
    const onError = vi.fn();
    const dispatcher = createReplyDispatcher({
      onError,
      beforeDeliver: (payload) => (payload.text === "cancel" ? null : payload),
      deliver: async (payload) => {
        if (payload.text === "two") {
          throw new Error("transport unavailable");
        }
        sent.push(payload.text!);
      },
    });
    const prepare = vi.fn((payloads: readonly ReplyPayload[]) => payloads);
    dispatcher.sendFinalReplyBatch!(
      [{ text: "one" }, { text: "cancel" }, { text: "two" }, { text: "three" }],
      prepare,
    );
    dispatcher.sendToolResult({ text: "next" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(prepare).toHaveBeenCalledExactlyOnceWith([
      { text: "one" },
      { text: "two" },
      { text: "three" },
    ]);
    expect(sent).toEqual(["one", "next"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 1, block: 0, final: 4 });
    expect(dispatcher.getCancelledCounts!()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 2 });
    expect(getTotalPendingReplies()).toBe(0);
  });
});
