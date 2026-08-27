import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { PluginHookReplyDispatchResult } from "../../plugins/hooks.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  createHookCtx,
  diagnosticMocks,
  emptyConfig,
  hookMocks,
  internalHookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  runtimePluginMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let sourceTurnDeliveryTempDir: string | undefined;
let previousSourceTurnDeliveryRegistryPath: string | undefined;

const SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV = "OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH";

type SourceTurnDeliveryRegistryForTest = {
  rows?: Array<{
    currentStage?: string;
    deliveryStatus?: string;
    finalDeliveryDelivered?: boolean;
    failureReason?: string;
    sourceTurnState?: string;
    visibleDeliveryCount?: number;
  }>;
};

async function useTempSourceTurnDeliveryRegistry(): Promise<string> {
  sourceTurnDeliveryTempDir = await mkdtemp(join(tmpdir(), "openclaw-source-turn-delivery-"));
  const registryPath = join(sourceTurnDeliveryTempDir, "source_delivery_obligations.json");
  process.env[SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV] = registryPath;
  return registryPath;
}

async function readSourceTurnDeliveryRows(registryPath: string) {
  const registry = JSON.parse(
    await readFile(registryPath, "utf8"),
  ) as SourceTurnDeliveryRegistryForTest;
  return registry.rows ?? [];
}

function createSourceTurnCtx(overrides: Partial<ReturnType<typeof createHookCtx>> = {}) {
  return {
    ...createHookCtx(),
    MessageSid: "source-turn-message-1",
    ...overrides,
  };
}

function createRoutedSourceTurnCtx() {
  return createSourceTurnCtx({
    OriginatingChannel: "discord",
    OriginatingTo: "source-user-1",
  });
}

function firstRuntimeLoadCall() {
  return runtimePluginMocks.ensureRuntimePluginsLoaded.mock.calls[0]?.[0] as
    | { config?: unknown; workspaceDir?: unknown }
    | undefined;
}

function firstReplyDispatchCall() {
  return hookMocks.runner.runReplyDispatch.mock.calls[0] as
    | [
        {
          sessionKey?: string;
          sendPolicy?: string;
          inboundAudio?: boolean;
        },
        {
          cfg?: unknown;
        },
      ]
    | undefined;
}

describe("dispatchReplyFromConfig reply_dispatch hook", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  });

  beforeEach(() => {
    previousSourceTurnDeliveryRegistryPath = process.env[SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV];
    delete process.env[SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV];
    sourceTurnDeliveryTempDir = undefined;
    clearAgentHarnesses();
    setDiscordTestRegistry();
    resetInboundDedupe();
    mocks.routeReply.mockReset().mockResolvedValue({ ok: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset().mockResolvedValue({
      handled: false,
      aborted: false,
    });
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runInboundClaim.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockReset().mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runBeforeDispatch.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockReset().mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent.mockReset();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset().mockResolvedValue(undefined);
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
    sessionStoreMocks.readSessionEntry.mockReset().mockReturnValue(undefined);
    sessionStoreMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/mock-sessions.json");
    sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
    sessionStoreMocks.updateSessionStoreEntry.mockClear();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockImplementation(() => ({
      resolveSession: () => ({ kind: "none" as const }),
      getObservabilitySnapshot: () => ({
        runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
        turns: {
          active: 0,
          queueDepth: 0,
          completed: 0,
          failed: 0,
          averageLatencyMs: 0,
          maxLatencyMs: 0,
        },
        errorsByCode: {},
      }),
      runTurn: vi.fn(),
    }));
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    runtimePluginMocks.ensureRuntimePluginsLoaded.mockReset();
    resetPluginTtsAndThreadMocks();
  });

  afterEach(async () => {
    if (previousSourceTurnDeliveryRegistryPath === undefined) {
      delete process.env[SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV];
    } else {
      process.env[SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV] = previousSourceTurnDeliveryRegistryPath;
    }
    if (sourceTurnDeliveryTempDir) {
      await rm(sourceTurnDeliveryTempDir, { force: true, recursive: true });
      sourceTurnDeliveryTempDir = undefined;
    }
  });

  it("returns handled dispatch results from plugins", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      fastAbortResolver: async () => ({ handled: false, aborted: false }),
      formatAbortReplyTextResolver: () => "⚙️ Agent was aborted.",
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(runtimePluginMocks.ensureRuntimePluginsLoaded).toHaveBeenCalledOnce();
    const runtimeLoadCall = firstRuntimeLoadCall();
    expect(runtimeLoadCall?.config).toBe(emptyConfig);
    expect(typeof runtimeLoadCall?.workspaceDir).toBe("string");
    expect(String(runtimeLoadCall?.workspaceDir).length).toBeGreaterThan(0);

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledOnce();
    const [replyDispatchEvent, replyDispatchRuntime] = firstReplyDispatchCall() ?? [];
    expect(replyDispatchEvent?.sessionKey).toBe("agent:test:session");
    expect(replyDispatchEvent?.sendPolicy).toBe("allow");
    expect(replyDispatchEvent?.inboundAudio).toBe(false);
    expect(replyDispatchRuntime?.cfg).toBe(emptyConfig);
    expect(result).toEqual({
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });
  });
  it("still applies send-policy deny after an unhandled plugin dispatch", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: false,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    } satisfies PluginHookReplyDispatchResult);

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: {
        ...emptyConfig,
        session: {
          sendPolicy: { default: "deny" },
        },
      },
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sendPolicyDenied: true,
      noVisibleReplyFallbackEligible: true,
    });
  });

  it("clears pending final delivery after final dispatch succeeds", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "durable reply",
      pendingFinalDeliveryCreatedAt: 1,
      pendingFinalDeliveryLastAttemptAt: 2,
      pendingFinalDeliveryAttemptCount: 3,
      pendingFinalDeliveryLastError: "previous failure",
      pendingFinalDeliveryContext: { source: "heartbeat" },
    };
    sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: sessionStoreMocks.currentEntry,
    });
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "durable reply" }),
    });

    expect(result.queuedFinal).toBe(true);
    expect(sessionStoreMocks.updateSessionStoreEntry).toHaveBeenCalledOnce();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastError).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryContext).toBeUndefined();
  });

  it("records routed final proof as source-turn final delivered", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });

    const result = await dispatchReplyFromConfig({
      ctx: createRoutedSourceTurnCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "visible final" }),
    });

    expect(result.queuedFinal).toBe(true);
    const rows = await readSourceTurnDeliveryRows(registryPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currentStage: "final_dispatch_delivered",
      deliveryStatus: "final_delivered",
      finalDeliveryDelivered: true,
      sourceTurnState: "final_delivered",
      visibleDeliveryCount: 1,
    });
  });

  it("records direct dispatcher final proof as source-turn final delivered", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);

    const result = await dispatchReplyFromConfig({
      ctx: createSourceTurnCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "visible final" }),
    });

    expect(result.queuedFinal).toBe(true);
    const rows = await readSourceTurnDeliveryRows(registryPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currentStage: "final_dispatch_delivered",
      deliveryStatus: "final_delivered",
      finalDeliveryDelivered: true,
      sourceTurnState: "final_delivered",
      visibleDeliveryCount: 1,
    });
  });

  it("records final dispatch failure instead of false delivered", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    mocks.routeReply.mockResolvedValue({ ok: false, error: "provider failed" } as never);

    const result = await dispatchReplyFromConfig({
      ctx: createRoutedSourceTurnCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "visible final" }),
    });

    expect(result.queuedFinal).toBe(false);
    const rows = await readSourceTurnDeliveryRows(registryPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currentStage: "final_dispatch_delivery_failed",
      deliveryStatus: "delivery_failed",
      failureReason: "delivery_tool_failed",
      finalDeliveryDelivered: false,
      sourceTurnState: "final_delivery_failed",
      visibleDeliveryCount: 0,
    });
  });

  it("records pending final delivery before dispatch can abort", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    vi.mocked(dispatcher.sendFinalReply).mockImplementation(() => {
      throw new Error("dispatch bubble closed");
    });

    await expect(
      dispatchReplyFromConfig({
        ctx: createSourceTurnCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => ({ text: "visible final" }),
      }),
    ).rejects.toThrow("dispatch bubble closed");

    const rows = await readSourceTurnDeliveryRows(registryPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currentStage: "final_dispatch_prepared_pending_delivery",
      deliveryStatus: "blocked",
      failureReason: "missing_visible_final_delivery_proof",
      finalDeliveryDelivered: false,
      sourceTurnState: "blocked_refused",
      visibleDeliveryCount: 0,
    });
  });

  it("records message-tool-only private final as refused, not delivered", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);

    const result = await dispatchReplyFromConfig({
      ctx: createSourceTurnCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
      replyResolver: async () => ({ text: "private-only final" }),
    });

    expect(result.queuedFinal).toBe(false);
    const rows = await readSourceTurnDeliveryRows(registryPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currentStage: "final_dispatch_suppressed_private_only",
      deliveryStatus: "blocked",
      failureReason: "private_final_without_visible_delivery",
      finalDeliveryDelivered: false,
      sourceTurnState: "blocked_refused",
      visibleDeliveryCount: 0,
    });
  });

  it("preserves pending final delivery when final dispatch fails", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "durable reply",
      pendingFinalDeliveryCreatedAt: 1,
    };
    sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: sessionStoreMocks.currentEntry,
    });
    const dispatcher = createDispatcher();
    vi.mocked(dispatcher.sendFinalReply).mockReturnValue(false);

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "durable reply" }),
    });

    expect(result.queuedFinal).toBe(false);
    expect(sessionStoreMocks.updateSessionStoreEntry).not.toHaveBeenCalled();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBe(true);
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBe("durable reply");
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBe(1);
  });
});
