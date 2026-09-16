import type { TypingCallbacks } from "../../channels/typing.js";
import type { HumanDelayConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateSecureInt } from "../../infra/secure-random.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { sleep } from "../../utils.js";
import { getReplyPayloadProgressHeartbeat } from "../reply-payload.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { registerDispatcher } from "./dispatcher-registry.js";
import { normalizeReplyPayload, type NormalizeReplySkipReason } from "./normalize-reply.js";
import type {
  ReplyDispatchBeforeDeliver,
  ReplyDispatchKind,
  ReplyDispatchPrepareFinalBatch,
  ReplyDispatcher,
} from "./reply-dispatcher.types.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
import type { TypingController } from "./typing.js";

export type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

type ReplyDispatchErrorHandler = (
  err: unknown,
  info: { kind: ReplyDispatchKind },
) => Promise<void> | void;

type ReplyDispatchSkipHandler = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind; reason: NormalizeReplySkipReason },
) => void;

type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<unknown>;

export type { ReplyDispatchBeforeDeliver, ReplyDispatchPrepareFinalBatch };

const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;
const silentReplyLogger = createSubsystemLogger("silent-reply/dispatcher");

/** Generate a random delay within the configured range. */
function getHumanDelay(config: HumanDelayConfig | undefined): number {
  const mode = config?.mode ?? "off";
  if (mode === "off") {
    return 0;
  }
  const min =
    mode === "custom" ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS) : DEFAULT_HUMAN_DELAY_MIN_MS;
  const max =
    mode === "custom" ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS) : DEFAULT_HUMAN_DELAY_MAX_MS;
  if (max <= min) {
    return min;
  }
  return min + generateSecureInt(max - min + 1);
}

export type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  /** Keep a required final in one durable transport batch after preparation. */
  deliverFinalBatch?: (payloads: readonly ReplyPayload[]) => Promise<void>;
  silentReplyContext?: {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    surface?: string;
    conversationType?: SilentReplyConversationType;
  };
  responsePrefix?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  /** Static context for response prefix template interpolation. */
  responsePrefixContext?: ResponsePrefixContext;
  /** Dynamic context provider for response prefix template interpolation.
   * Called at normalization time, after model selection is complete. */
  responsePrefixContextProvider?: () => ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  onIdle?: () => Promise<void> | void;
  onError?: ReplyDispatchErrorHandler;
  // AIDEV-NOTE: onSkip lets channels detect silent/empty drops (e.g. Telegram empty-response fallback).
  onSkip?: ReplyDispatchSkipHandler;
  /** Human-like delay between block replies for natural rhythm. */
  humanDelay?: HumanDelayConfig;
  beforeDeliver?: ReplyDispatchBeforeDeliver;
};

export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
  typingCallbacks?: TypingCallbacks;
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => Promise<void> | void;
  onSettled?: () => unknown;
  onFreshSettledDelivery?: () => unknown;
  /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
  onCleanup?: () => void;
};

type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
  markDispatchIdle: () => void;
  /** Signal that the model run is complete so the typing controller can stop. */
  markRunComplete: () => void;
};

type NormalizeReplyPayloadInternalOptions = Pick<
  ReplyDispatcherOptions,
  | "responsePrefix"
  | "responsePrefixContext"
  | "responsePrefixContextProvider"
  | "onHeartbeatStrip"
  | "transformReplyPayload"
> & {
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

function normalizeReplyPayloadInternal(
  payload: ReplyPayload,
  opts: NormalizeReplyPayloadInternalOptions,
): ReplyPayload | null {
  // Prefer dynamic context provider over static context
  const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;

  return normalizeReplyPayload(payload, {
    responsePrefix: opts.responsePrefix,
    responsePrefixContext: prefixContext,
    onHeartbeatStrip: opts.onHeartbeatStrip,
    transformReplyPayload: opts.transformReplyPayload,
    onSkip: opts.onSkip,
  });
}

function resolveEffectiveDeliveryKind(
  requestedKind: ReplyDispatchKind,
  payload: ReplyPayload,
): ReplyDispatchKind {
  if (requestedKind !== "tool") {
    return requestedKind;
  }
  const heartbeat = getReplyPayloadProgressHeartbeat(payload);
  if (heartbeat?.activeRunContinues === true) {
    return "block";
  }
  return requestedKind;
}

export function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher {
  let beforeDeliver = options.beforeDeliver;
  let sendChain: Promise<void> = Promise.resolve();
  // Track in-flight deliveries so we can emit a reliable "idle" signal.
  // Start with pending=1 as a "reservation" to prevent premature gateway restart.
  // This is decremented when markComplete() is called to signal no more replies will come.
  let pending = 1;
  let completeCalled = false;
  // Track whether we've sent a block reply (for human delay - skip delay on first block).
  let sentFirstBlock = false;
  // Serialize outbound replies to preserve tool/block/final order.
  const queuedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  const failedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  const cancelledCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };

  // Register this dispatcher globally for gateway restart coordination.
  const { unregister } = registerDispatcher({
    pending: () => pending,
    waitForIdle: () => sendChain,
  });

  const normalizePayload = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const originalWasExactSilent = isSilentReplyText(payload.text, SILENT_REPLY_TOKEN);
    const normalized = normalizeReplyPayloadInternal(payload, {
      responsePrefix: options.responsePrefix,
      responsePrefixContext: options.responsePrefixContext,
      responsePrefixContextProvider: options.responsePrefixContextProvider,
      transformReplyPayload: options.transformReplyPayload,
      onHeartbeatStrip: options.onHeartbeatStrip,
      onSkip: (reason) => options.onSkip?.(payload, { kind, reason }),
    });
    if (!normalized && kind === "final" && originalWasExactSilent) {
      silentReplyLogger.debug("exact NO_REPLY final payload was skipped before delivery", {
        hasSessionKey: Boolean(options.silentReplyContext?.sessionKey),
        surface: options.silentReplyContext?.surface,
        conversationType: options.silentReplyContext?.conversationType,
      });
    }
    return normalized;
  };

  const applyBeforeDeliver = async (payload: ReplyPayload, kind: ReplyDispatchKind) => {
    const prepared = beforeDeliver ? await beforeDeliver(payload, { kind }) : payload;
    if (!prepared) {
      cancelledCounts[kind] += 1;
    }
    return prepared;
  };

  const releasePending = (count: number) => {
    pending -= count;
    // Keep the restart reservation until both the producer and all queued sends finish.
    if (pending === 1 && completeCalled) {
      pending -= 1;
    }
    if (pending === 0) {
      unregister();
      void options.onIdle?.();
    }
  };

  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const normalized = normalizePayload(kind, payload);
    if (!normalized) {
      return false;
    }
    queuedCounts[kind] += 1;
    pending += 1;

    // Determine if we should add human-like delay (only for block replies after the first).
    const shouldDelay = kind === "block" && sentFirstBlock;
    if (kind === "block") {
      sentFirstBlock = true;
    }

    sendChain = sendChain
      .then(async () => {
        // Add human-like delay between block replies for natural rhythm.
        if (shouldDelay) {
          const delayMs = getHumanDelay(options.humanDelay);
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        }
        const deliverPayload = beforeDeliver
          ? await applyBeforeDeliver(normalized, kind)
          : normalized;
        if (!deliverPayload) {
          return;
        }
        const effectiveKind = resolveEffectiveDeliveryKind(kind, deliverPayload);
        await options.deliver(deliverPayload, { kind: effectiveKind });
      })
      .catch((err: unknown) => {
        failedCounts[kind] += 1;
        void options.onError?.(err, { kind });
      })
      .finally(() => releasePending(1));
    return true;
  };

  const enqueueFinalBatch = (
    payloads: readonly ReplyPayload[],
    prepare: ReplyDispatchPrepareFinalBatch,
  ) => {
    const normalized = payloads.flatMap((payload) => normalizePayload("final", payload) ?? []);
    if (normalized.length === 0) {
      return false;
    }
    queuedCounts.final += normalized.length;
    pending += normalized.length;
    let unresolved = normalized.length;
    sendChain = sendChain
      .then(async () => {
        const postHook: ReplyPayload[] = [];
        for (const payload of normalized) {
          const prepared = await applyBeforeDeliver(payload, "final");
          if (prepared) {
            postHook.push(prepared);
          } else {
            unresolved -= 1;
          }
        }
        if (postHook.length === 0) {
          return;
        }
        // Persist the complete post-hook batch before any transport side effect.
        // Per-part identities may change here; rerunning hooks would invalidate that proof.
        const prepared = await prepare(postHook);
        if (prepared.length !== postHook.length) {
          throw new Error("Final batch preparation must preserve payload count");
        }
        if (options.deliverFinalBatch) {
          await options.deliverFinalBatch(prepared);
          unresolved = 0;
          return;
        }
        for (const payload of prepared) {
          await options.deliver(payload, { kind: "final" });
          unresolved -= 1;
        }
      })
      .catch((err: unknown) => {
        // A failed part stops this batch. Neither prior successes nor cancelled parts
        // can hide the failed part and its unsent remainder from closeout accounting.
        failedCounts.final += unresolved;
        void options.onError?.(err, { kind: "final" });
      })
      .finally(() => releasePending(normalized.length));
    return true;
  };

  const markComplete = () => {
    if (completeCalled) {
      return;
    }
    completeCalled = true;
    // If no replies were enqueued (pending is still 1 = just the reservation),
    // schedule clearing the reservation after current microtasks complete.
    // This gives any in-flight enqueue() calls a chance to increment pending.
    void Promise.resolve().then(() => {
      if (pending === 1 && completeCalled) {
        // Still just the reservation, no replies were enqueued
        pending -= 1;
        if (pending === 0) {
          unregister();
          void options.onIdle?.();
        }
      }
    });
  };

  return {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    sendFinalReplyBatch: enqueueFinalBatch,
    appendBeforeDeliver: (hook) => {
      const previousBeforeDeliver = beforeDeliver;
      beforeDeliver = previousBeforeDeliver
        ? async (payload, info) => {
            const previousPayload = await previousBeforeDeliver(payload, info);
            return previousPayload ? hook(previousPayload, info) : null;
          }
        : hook;
    },
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    getCancelledCounts: () => ({ ...cancelledCounts }),
    getFailedCounts: () => ({ ...failedCounts }),
    markComplete,
  };
}

export async function waitForReplyDispatcherIdle(
  dispatcher: Pick<ReplyDispatcher, "waitForIdle">,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!abortSignal) {
    await dispatcher.waitForIdle();
    return;
  }
  if (abortSignal.aborted) {
    return;
  }
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    abortSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([dispatcher.waitForIdle(), aborted]);
  } finally {
    removeAbortListener?.();
  }
}

export function createReplyDispatcherWithTyping(
  options: ReplyDispatcherWithTypingOptions,
): ReplyDispatcherWithTypingResult {
  const {
    typingCallbacks,
    onReplyStart,
    onIdle,
    onSettled: _onSettled,
    onFreshSettledDelivery: _onFreshSettledDelivery,
    onCleanup,
    ...dispatcherOptions
  } = options;
  const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
  const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
  const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;
  let typingController: TypingController | undefined;
  const dispatcher = createReplyDispatcher({
    ...dispatcherOptions,
    onIdle: () => {
      typingController?.markDispatchIdle();
      return resolvedOnIdle?.();
    },
  });

  return {
    dispatcher,
    replyOptions: {
      onReplyStart: resolvedOnReplyStart,
      onTypingCleanup: resolvedOnCleanup,
      onTypingController: (typing) => {
        typingController = typing;
      },
    },
    markDispatchIdle: () => {
      typingController?.markDispatchIdle();
      resolvedOnIdle?.();
    },
    markRunComplete: () => {
      typingController?.markRunComplete();
    },
  };
}
