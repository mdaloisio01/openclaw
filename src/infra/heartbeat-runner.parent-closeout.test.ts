import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { loadSourceTurnDeliveryRegistry } from "../agents/source-turn-delivery-store.js";
import * as sourceDeliveryStore from "../agents/source-turn-delivery-store.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../agents/subagent-lifecycle-events.js";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagent-registry-state.js";
import {
  addSubagentRunForTests,
  completeParentYieldWaitContinuationYield,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../agents/subagent-registry.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../agents/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/config.js";
import * as sourceTranscript from "../config/sessions/transcript.js";
import { readSessionMessageByIdAsync } from "../gateway/session-utils.fs.js";
import { drainPendingDeliveries as drainPluginPendingDeliveries } from "../plugin-sdk/delivery-queue-runtime.js";
import { getActivePluginRegistry, pinActivePluginChannelRegistry } from "../plugins/runtime.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import {
  persistActivationContinuationBeforeRestart,
  resumeActivationContinuation,
  testing as activationTesting,
  type ActivationContinuationRunnerDeps,
} from "./activation-continuation.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
// Load the real lazy dispatch boundary before individual test timeouts begin.
import "./heartbeat-runner.runtime.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import {
  HEARTBEAT_SKIP_CONTINUATION_SETTLEMENT_PENDING,
  resetHeartbeatWakeStateForTests,
  setHeartbeatsEnabled,
} from "./heartbeat-wake.js";
import { loadPendingDeliveries, loadPendingDelivery } from "./outbound/delivery-queue.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime();
beforeEach(() => {
  // Gateway startup pins channels independently of the per-workspace agent
  // registry. Keep that real boundary when dispatch loads its runtime plugins.
  pinActivePluginChannelRegistry(getActivePluginRegistry()!);
});
afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  subagentRegistryTesting.setDepsForTest();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetSystemEventsForTest();
  resetHeartbeatWakeStateForTests();
  setHeartbeatsEnabled(true);
});

const wait = { waitId: "wait-1", parentRunId: "parent-1" };
const finalText = "The parent work is complete.";
const realSourceDeliveryStore = {
  settleSourceTurnDeliveryFinal: sourceDeliveryStore.settleSourceTurnDeliveryFinal,
  transitionExternalSourceDelivery: sourceDeliveryStore.transitionExternalSourceDelivery,
} satisfies NonNullable<HeartbeatDeps["sourceDeliveryStore"]>;

function seedRequiredParentWait(sessionKey: string, channel: "webchat" | "telegram") {
  const now = Date.now();
  const child: SubagentRunRecord = {
    runId: "child-1",
    childSessionKey: "agent:main:subagent:child-1",
    controllerSessionKey: sessionKey,
    requesterSessionKey: sessionKey,
    requesterDisplayKey: sessionKey,
    requesterOrigin: { channel, to: "123" },
    task: "Complete the child work.",
    cleanup: "keep",
    createdAt: now - 4_000,
    startedAt: now - 3_000,
    endedAt: now - 2_000,
    outcome: { status: "ok" },
    parentYieldWait: {
      ...wait,
      parentSessionKey: sessionKey,
      expectedChildRunIds: ["child-1"],
      childSessionKeys: ["agent:main:subagent:child-1"],
      waitStartedAt: now - 3_000,
      staleAt: now + 60_000,
      requiredCloseout: true,
      terminalChildRunIds: ["child-1"],
      continuationScheduledAt: now - 1_000,
      status: "continuation_scheduled",
    },
  };
  saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
  addSubagentRunForTests(child);
  enqueueSystemEvent("Child work completed. Resume the parent.", {
    sessionKey,
    contextKey: "subagent:child-1:yield-wait-ready:wait-1",
    deliveryContext: { channel, to: "123" },
    parentYieldWait: wait,
  });
}

async function expectCanonicalSourceMessage(
  updates: SessionTranscriptUpdate[],
  storePath: string,
  sessionKey: string,
) {
  expect(updates).toHaveLength(1);
  const update = updates[0];
  expect(update).toMatchObject({ sessionKey, messageId: expect.any(String) });
  const readback = await readSessionMessageByIdAsync(
    "sid",
    storePath,
    update.sessionFile,
    update.messageId!,
  );
  expect(readback).toMatchObject({
    found: true,
    message: { role: "assistant", content: [{ type: "text", text: finalText }] },
  });
}

describe.each(["webchat", "telegram"] as const)("%s parent continuation closeout", (channel) => {
  it.each([
    "delivered",
    "notice-and-final",
    "disabled-global",
    "disabled-agent",
    "disabled-interval",
    "quiet-hours",
    "alerts-disabled",
    "status-only",
    "error-only",
    "message-tool-only",
    "delivery-failed",
  ])(
    "settles only after the admitted source final is delivered (%s)",
    async (mode) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const registryPath = path.join(tmpDir, "delivery.json");
        vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: mode === "disabled-interval" ? "0m" : "5m",
                isolatedSession: true,
                model: "openai/gpt-5.5",
                lightContext: true,
                timeoutSeconds: 1,
                ...(mode === "quiet-hours"
                  ? { activeHours: { start: "00:00", end: "00:01", timezone: "UTC" } }
                  : {}),
              },
            },
            ...(mode === "disabled-agent"
              ? { list: [{ id: "main" }, { id: "ops", heartbeat: { every: "5m" } }] }
              : {}),
          },
          session: { store: storePath },
          ...(mode === "alerts-disabled"
            ? {
                channels: {
                  defaults: {
                    heartbeat: { showAlerts: false, showOk: false, useIndicator: false },
                  },
                },
              }
            : {}),
          ...(mode === "message-tool-only"
            ? { messages: { visibleReplies: "message_tool" as const } }
            : {}),
        };
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "another-conversation",
        });
        await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "");
        seedRequiredParentWait(sessionKey, channel);
        enqueueSystemEvent("Unrelated notification.", {
          sessionKey,
          contextKey: "unrelated",
          deliveryContext: { channel: "telegram", to: "another-conversation" },
        });
        let continuationRunId: string | undefined;
        replySpy.mockImplementation(async (ctx, opts) => {
          expect(ctx).toMatchObject({
            SessionKey: sessionKey,
            Provider: channel,
            OriginatingChannel: channel,
            OriginatingTo: "123",
            ParentYieldWaits: [wait],
          });
          expect(ctx.Body).toContain("Child work completed. Resume the parent.");
          expect(opts?.isHeartbeat).toBe(false);
          expect(opts?.heartbeatModelOverride).toBeUndefined();
          expect(opts?.bootstrapContextMode).toBeUndefined();
          expect(opts?.timeoutOverrideSeconds).toBeUndefined();
          continuationRunId = opts?.runId;
          expect(continuationRunId).toBeTruthy();
          if (mode === "delivery-failed" && channel === "webchat") {
            await fs.writeFile(storePath, "{}");
          }
          const final = {
            text: finalText,
            ...(mode === "status-only" ? { isStatusNotice: true } : {}),
            ...(mode === "error-only" ? { isError: true } : {}),
          };
          return mode === "notice-and-final"
            ? [
                { text: "A status update.", isStatusNotice: true },
                { text: "A recovered warning.", isError: true },
                final,
              ]
            : final;
        });
        const sendTelegram = vi.fn(async () => {
          if (mode === "delivery-failed") {
            throw new Error("source delivery rejected");
          }
          return { messageId: "sent-1", chatId: "123" };
        });
        const updates: SessionTranscriptUpdate[] = [];
        const stopUpdates = onSessionTranscriptUpdate((update) => updates.push(update));
        try {
          if (mode === "disabled-global") {
            setHeartbeatsEnabled(false);
          }
          const result = await runHeartbeatOnce({
            cfg,
            sessionKey,
            source: "subagent-progress",
            intent: "event",
            deps: {
              getReplyFromConfig: replySpy,
              getQueueSize: () => 0,
              telegram: sendTelegram,
              nowMs: () => Date.UTC(2026, 8, 15, 12),
            },
          });
          expect(replySpy).toHaveBeenCalledTimes(1);
          const registry = await loadSourceTurnDeliveryRegistry(registryPath);
          const child = loadSubagentRegistryFromSqlite().get("child-1");
          if (
            [
              "delivered",
              "notice-and-final",
              "disabled-global",
              "disabled-agent",
              "disabled-interval",
              "quiet-hours",
              "alerts-disabled",
            ].includes(mode)
          ) {
            expect(result.status).toBe("ran");
            expect(registry.rows).toHaveLength(1);
            expect(registry.rows[0]).toMatchObject({
              sourceSessionKey: sessionKey,
              sourceChannel: channel,
              sourceTurnState: "final_delivered",
              parentYieldWaits: [wait],
              obligationIdentity: { runId: continuationRunId },
            });
            expect(child?.parentYieldWait?.status).toBe("closeout_delivered");
            expect(peekSystemEventEntries(sessionKey)).toEqual([
              expect.objectContaining({ text: "Unrelated notification." }),
            ]);
            if (channel === "webchat") {
              await expectCanonicalSourceMessage(updates, storePath, sessionKey);
              expect(sendTelegram).not.toHaveBeenCalled();
            } else {
              expect(sendTelegram).toHaveBeenCalledExactlyOnceWith(
                "123",
                finalText,
                expect.any(Object),
              );
            }
          } else {
            expect(result.status).toBe("skipped");
            expect(registry.rows.every((row) => !row.finalDeliveryDelivered)).toBe(true);
            expect(child?.parentYieldWait?.status).toBe("continuation_scheduled");
            expect(peekSystemEventEntries(sessionKey)[0]).toMatchObject({ parentYieldWait: wait });
            if (mode !== "delivery-failed") {
              expect(sendTelegram).not.toHaveBeenCalled();
              expect(updates).toEqual([]);
            }
          }
        } finally {
          stopUpdates();
        }
      });
    },
    15_000,
  );
});

describe("parent delivery recovery", () => {
  it.each(["delivered", "second-part", "final-state"] as const)(
    "persists one complete external batch and requires its actual receipt (%s)",
    async (mode) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const registryPath = path.join(tmpDir, "delivery.json");
        vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
          session: { store: storePath },
        };
        const payloads = [
          { text: "First external final part." },
          { text: "Second external final part.", replyToId: "77" },
        ];
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "later-conversation",
          pendingFinalDelivery: true,
          pendingFinalDeliveryText: payloads.map((payload) => payload.text).join("\n\n"),
          pendingFinalDeliveryCreatedAt: Date.now(),
        });
        seedRequiredParentWait(sessionKey, "telegram");
        replySpy.mockResolvedValue(payloads);
        let queueId: string | undefined;
        let sendCount = 0;
        const sendTelegram = vi.fn(async (to: string, text: string) => {
          sendCount += 1;
          expect(to).toBe("123");
          expect(text).toBe(payloads[sendCount - 1].text);
          const source = await loadSourceTurnDeliveryRegistry(registryPath);
          expect(source.rows).toHaveLength(1);
          const prepared = source.rows[0].preparedSourceFinal;
          expect(prepared).toMatchObject({
            kind: "external_channel",
            expectedPartCount: 2,
            parts: payloads.map((payload) => ({ payload })),
            outboundDelivery: { status: "queued", queueId: expect.any(String) },
          });
          if (
            prepared?.kind !== "external_channel" ||
            prepared.outboundDelivery.status !== "queued"
          ) {
            throw new Error("external intent was not bound before platform send");
          }
          queueId ??= prepared.outboundDelivery.queueId;
          expect(prepared.outboundDelivery.queueId).toBe(queueId);
          // Inspect real SQLite at the first side effect: the unsent second
          // part and its reply target must already belong to this same intent.
          expect(await loadPendingDelivery(queueId)).toMatchObject({
            channel: "telegram",
            to: "123",
            payloads,
            session: { key: sessionKey },
          });
          if (mode === "second-part" && sendCount === 2) {
            throw new Error("platform outcome unknown during second part");
          }
          return { messageId: `sent-${sendCount}`, chatId: "123" };
        });
        const transition = sourceDeliveryStore.transitionExternalSourceDelivery;
        const transitionSpy = vi.fn(async (params: Parameters<typeof transition>[0]) => {
          if (params.delivery.status === "delivered") {
            expect(await loadPendingDelivery(params.delivery.queueId)).toMatchObject({
              recoveryState: "unknown_after_send",
            });
          }
          return transition(params);
        });
        const settle = sourceDeliveryStore.settleSourceTurnDeliveryFinal;
        let interrupted = false;
        const settleSpy = vi.fn(async (params: Parameters<typeof settle>[0]) => {
          if (mode === "final-state" && !interrupted) {
            interrupted = true;
            throw new Error("interrupted after saved transport receipt");
          }
          return settle(params);
        });
        const request = {
          cfg,
          sessionKey,
          source: "subagent-progress" as const,
          intent: "event" as const,
          deps: {
            getReplyFromConfig: replySpy,
            getQueueSize: () => 0,
            telegram: sendTelegram,
            sourceDeliveryStore: {
              ...realSourceDeliveryStore,
              settleSourceTurnDeliveryFinal: settleSpy,
              transitionExternalSourceDelivery: transitionSpy,
            },
          },
        };
        const first = await runHeartbeatOnce(request);
        expect(transitionSpy).toHaveBeenCalled();
        if (mode === "final-state") {
          expect(settleSpy).toHaveBeenCalled();
        }
        expect(first.status).toBe(mode === "delivered" ? "ran" : "skipped");
        expect(sendTelegram).toHaveBeenCalledTimes(2);
        const saved = (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0];
        expect(saved.preparedSourceFinal).toMatchObject({
          kind: "external_channel",
          parts: payloads.map((payload) => ({ payload })),
          outboundDelivery: {
            queueId,
            status: mode === "second-part" ? "queued" : "delivered",
            ...(mode === "second-part"
              ? {}
              : { receipt: { platformMessageIds: ["sent-1", "sent-2"] } }),
          },
        });
        expect(saved.finalDeliveryDelivered).toBe(mode === "delivered");
        if (mode === "second-part") {
          expect(await loadPendingDeliveries()).toEqual([
            expect.objectContaining({ id: queueId, payloads }),
          ]);
          expect(await runHeartbeatOnce(request)).toEqual({
            status: "skipped",
            reason: HEARTBEAT_SKIP_CONTINUATION_SETTLEMENT_PENDING,
          });
          expect(loadSubagentRegistryFromSqlite().get("child-1")?.parentYieldWait?.status).toBe(
            "continuation_scheduled",
          );
          expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        } else {
          expect(await loadPendingDeliveries()).toEqual([]);
          if (mode === "final-state") {
            expect(interrupted).toBe(true);
            expect((await runHeartbeatOnce(request)).status).toBe("ran");
          }
          const settled = (await loadSourceTurnDeliveryRegistry(registryPath)).rows;
          expect(settled).toHaveLength(1);
          expect(settled[0]).toMatchObject({
            id: saved.id,
            obligationIdentity: saved.obligationIdentity,
            preparedSourceFinal: saved.preparedSourceFinal,
            finalDeliveryDelivered: true,
          });
          expect(loadSubagentRegistryFromSqlite().get("child-1")?.parentYieldWait?.status).toBe(
            "closeout_delivered",
          );
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
          const sessions = JSON.parse(await fs.readFile(storePath, "utf8"));
          expect(sessions[sessionKey].pendingFinalDelivery).toBeUndefined();
        }
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(sendTelegram).toHaveBeenCalledTimes(2);
      });
    },
    15_000,
  );

  it("settles its prepared source obligation through shared reconnect recovery", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const registryPath = path.join(tmpDir, "delivery.json");
      vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
        session: { store: storePath },
      };
      const payloads = [
        { text: "First recovered external final part." },
        { text: "Second recovered external final part.", replyToId: "77" },
      ];
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "later-conversation",
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: payloads.map((payload) => payload.text).join("\n\n"),
        pendingFinalDeliveryCreatedAt: Date.now(),
      });
      seedRequiredParentWait(sessionKey, "telegram");
      replySpy.mockResolvedValue(payloads);
      const sendTelegram = vi.fn();
      const transition = sourceDeliveryStore.transitionExternalSourceDelivery;
      let interrupted = false;
      const transitionSpy = vi.fn(async (params: Parameters<typeof transition>[0]) => {
        if (params.delivery.status === "queued" && !interrupted) {
          interrupted = true;
          throw new Error("interrupted before source owner binding");
        }
        return transition(params);
      });
      const request = {
        cfg,
        sessionKey,
        source: "subagent-progress" as const,
        intent: "event" as const,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          telegram: sendTelegram,
          sourceDeliveryStore: {
            ...realSourceDeliveryStore,
            transitionExternalSourceDelivery: transitionSpy,
          },
        },
      };
      expect((await runHeartbeatOnce(request)).status).toBe("skipped");
      expect(interrupted).toBe(true);
      expect(sendTelegram).not.toHaveBeenCalled();
      expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows[0]).toMatchObject({
        preparedSourceFinal: {
          kind: "external_channel",
          outboundDelivery: { status: "prepared" },
        },
      });
      const queued = (await loadPendingDeliveries())[0];
      expect(queued).toMatchObject({
        channel: "telegram",
        to: "123",
        payloads,
        session: { key: sessionKey },
        owner: { kind: "source_turn_delivery", key: expect.any(String) },
      });
      if (!queued) {
        throw new Error("Expected queued external source delivery");
      }
      expect(
        await sourceDeliveryStore.inspectExternalSourceDeliveryQueueOwner({
          registryPath,
          identity: {
            queueId: queued.id,
            channel: queued.channel,
            to: queued.to,
            ...(queued.accountId !== undefined ? { accountId: queued.accountId } : {}),
            ...(queued.threadId !== undefined ? { threadId: queued.threadId } : {}),
            payloads: queued.payloads,
            ...(queued.owner ? { owner: queued.owner } : {}),
          },
        }),
      ).toEqual({ status: "pending", sourceSessionKey: sessionKey });

      const deliver = vi.fn(async () => [
        { channel: "telegram" as const, messageId: "recovered-1" },
        { channel: "telegram" as const, messageId: "recovered-2" },
      ]);
      await drainPluginPendingDeliveries({
        drainKey: "telegram:default",
        logLabel: "Telegram reconnect drain",
        deliver,
        cfg,
        stateDir: tmpDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        selectEntry: (entry) => ({
          match: entry.id === queued.id,
          bypassBackoff: true,
        }),
      });
      resetHeartbeatWakeStateForTests();

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingDeliveries()).toEqual([]);
      const recovered = (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0];
      expect(recovered).toMatchObject({
        sourceSessionKey: sessionKey,
        finalDeliveryDelivered: false,
        preparedSourceFinal: {
          kind: "external_channel",
          outboundDelivery: {
            status: "delivered",
            queueId: queued.id,
            receipt: { platformMessageIds: ["recovered-1", "recovered-2"] },
          },
        },
      });

      expect((await runHeartbeatOnce(request)).status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(
        (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0].finalDeliveryDelivered,
      ).toBe(true);
      expect(loadSubagentRegistryFromSqlite().get("child-1")?.parentYieldWait?.status).toBe(
        "closeout_delivered",
      );
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  }, 15_000);

  it("does not inherit a later external destination when the queued source route is incomplete", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "later-conversation",
      });
      enqueueSystemEvent("The original report still needs source delivery.", {
        sessionKey,
        deliveryContext: { channel: "telegram" },
        activationContinuation: {
          id: "original-activation",
          createdAt: 1,
          reportId: "original-report",
        },
      });
      const sendTelegram = vi.fn();
      const updates: SessionTranscriptUpdate[] = [];
      const stopUpdates = onSessionTranscriptUpdate((update) => updates.push(update));
      try {
        expect(
          await runHeartbeatOnce({
            cfg,
            sessionKey,
            deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0, telegram: sendTelegram },
          }),
        ).toEqual({ status: "failed", reason: "parent-closeout-delivery-target-missing" });
        expect(replySpy).not.toHaveBeenCalled();
        expect(sendTelegram).not.toHaveBeenCalled();
        expect(updates).toEqual([]);
        expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
      } finally {
        stopUpdates();
      }
    });
  });

  it("reconciles a native answer through its exact hidden receipt without duplicate visible output", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const registryPath = path.join(tmpDir, "delivery.json");
      vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "webchat",
        lastTo: "123",
      });
      seedRequiredParentWait(sessionKey, "webchat");
      const nativeKey = "native-thread:actual-parent-turn:assistant";
      replySpy.mockImplementation(async () => {
        const native = await sourceTranscript.appendExactAssistantMessageToSessionTranscript({
          sessionKey,
          storePath,
          idempotencyKey: nativeKey,
          message: {
            role: "assistant",
            content: [{ type: "text", text: finalText }],
            provider: "openai",
            model: "gpt-5.5",
            api: "openai-responses",
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              totalTokens: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
            },
          },
        });
        if (!native.ok) {
          throw new Error(native.reason);
        }
        const nativeReference = {
          sessionId: "sid",
          sessionFile: native.sessionFile,
          messageId: native.messageId,
          idempotencyKey: nativeKey,
          text: finalText,
        };
        return setReplyPayloadMetadata(
          { text: finalText },
          {
            canonicalAssistantTranscript: nativeReference,
            nativeAssistantTranscript: nativeReference,
          },
        );
      });
      const settle = sourceDeliveryStore.settleSourceTurnDeliveryFinal;
      let interrupted = false;
      const settleSpy = vi.fn(async (params: Parameters<typeof settle>[0]) => {
        if (!interrupted) {
          interrupted = true;
          throw new Error("injected receipt interruption");
        }
        return settle(params);
      });
      const updates: SessionTranscriptUpdate[] = [];
      const stopUpdates = onSessionTranscriptUpdate((update) => updates.push(update));
      const request = {
        cfg,
        sessionKey,
        source: "subagent-progress" as const,
        intent: "event" as const,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          sourceDeliveryStore: {
            ...realSourceDeliveryStore,
            settleSourceTurnDeliveryFinal: settleSpy,
          },
        },
      };
      try {
        expect(await runHeartbeatOnce(request)).toEqual({
          status: "skipped",
          reason: HEARTBEAT_SKIP_CONTINUATION_SETTLEMENT_PENDING,
        });
        const prepared = (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0]
          .preparedSourceFinal!;
        expect(prepared.parts[0].canonicalAssistantTranscript?.idempotencyKey).toBe(nativeKey);
        expect((await runHeartbeatOnce(request)).status).toBe("ran");
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(updates).toHaveLength(2);
        expect(updates[1].message).toMatchObject({
          display: false,
          sourceDelivery: { visibleMessageId: updates[0].messageId },
          idempotencyKey: prepared.parts[0].idempotencyKey,
        });
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        stopUpdates();
      }
    });
  }, 15_000);

  it.each(["second-part", "final-receipt"] as const)(
    "recovers the complete saved batch after %s failure without repeating execution",
    async (failure) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const registryPath = path.join(tmpDir, "delivery.json");
        vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
          session: { store: storePath },
        };
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "webchat",
          lastProvider: "webchat",
          lastTo: "123",
          pendingFinalDelivery: true,
          pendingFinalDeliveryText: "First saved final part.\n\nSecond saved final part.",
          pendingFinalDeliveryCreatedAt: Date.now(),
        });
        seedRequiredParentWait(sessionKey, "webchat");
        replySpy.mockResolvedValue([
          { text: "First saved final part." },
          { text: "Second saved final part." },
        ]);
        const settle = sourceDeliveryStore.settleSourceTurnDeliveryFinal;
        const append = sourceTranscript.appendExactAssistantMessageToSessionTranscript;
        let interrupted = false;
        let allowSecondPart = false;
        const settleSpy = vi.fn(async (params: Parameters<typeof settle>[0]) => {
          if (failure === "final-receipt" && !interrupted) {
            interrupted = true;
            throw new Error("injected receipt interruption");
          }
          return settle(params);
        });
        const appendSpy = vi
          .spyOn(sourceTranscript, "appendExactAssistantMessageToSessionTranscript")
          .mockImplementation(async (params) => {
            if (
              failure === "second-part" &&
              Array.isArray(params.message.content) &&
              params.message.content.some(
                (block) => block.type === "text" && block.text === "Second saved final part.",
              ) &&
              !allowSecondPart
            ) {
              interrupted = true;
              throw new Error("injected publication interruption");
            }
            return append(params);
          });
        const updates: SessionTranscriptUpdate[] = [];
        const stopUpdates = onSessionTranscriptUpdate((update) => updates.push(update));
        const request = {
          cfg,
          sessionKey,
          source: "subagent-progress" as const,
          intent: "event" as const,
          deps: {
            getReplyFromConfig: replySpy,
            getQueueSize: () => 0,
            sourceDeliveryStore: {
              ...realSourceDeliveryStore,
              settleSourceTurnDeliveryFinal: settleSpy,
            },
          },
        };
        try {
          expect(await runHeartbeatOnce(request)).toEqual({
            status: "skipped",
            reason: HEARTBEAT_SKIP_CONTINUATION_SETTLEMENT_PENDING,
          });
          expect(interrupted).toBe(true);
          allowSecondPart = true;
          const pending = await loadSourceTurnDeliveryRegistry(registryPath);
          expect(pending.rows).toHaveLength(1);
          expect(pending.rows[0].finalDeliveryDelivered).toBe(false);
          expect(pending.rows[0].preparedSourceFinal).toMatchObject({
            sessionId: "sid",
            expectedPartCount: 2,
            parts: [
              { text: "First saved final part.", idempotencyKey: expect.any(String) },
              { text: "Second saved final part.", idempotencyKey: expect.any(String) },
            ],
          });
          expect(updates).toHaveLength(failure === "second-part" ? 1 : 2);
          expect((await runHeartbeatOnce(request)).status).toBe("ran");
          expect(replySpy).toHaveBeenCalledTimes(1);
          expect(updates).toHaveLength(2);
          const closed = await loadSourceTurnDeliveryRegistry(registryPath);
          expect(closed.rows).toHaveLength(1);
          expect(closed.rows[0]).toMatchObject({
            id: pending.rows[0].id,
            obligationIdentity: pending.rows[0].obligationIdentity,
            preparedSourceFinal: pending.rows[0].preparedSourceFinal,
            finalDeliveryDelivered: true,
          });
          expect(loadSubagentRegistryFromSqlite().get("child-1")?.parentYieldWait?.status).toBe(
            "closeout_delivered",
          );
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
          const sessions = JSON.parse(await fs.readFile(storePath, "utf8"));
          expect(sessions[sessionKey].pendingFinalDelivery).toBeUndefined();
        } finally {
          appendSpy.mockRestore();
          stopUpdates();
        }
      });
    },
    15_000,
  );

  it("does not repeat an accepted execution whose terminal outcome is unknown", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const registryPath = path.join(tmpDir, "delivery.json");
      vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "webchat",
        lastTo: "123",
      });
      seedRequiredParentWait(sessionKey, "webchat");
      await sourceDeliveryStore.persistSourceTurnDeliveryState({
        registryPath,
        id: "accepted-parent-final",
        runId: "original-execution",
        sourceSessionKey: sessionKey,
        sourceChannel: "webchat",
        deliveryContext: { channel: "webchat", to: "123" },
        parentYieldWaits: [wait],
        facts: {},
        currentStage: "accepted",
      });
      expect(
        await runHeartbeatOnce({
          cfg,
          sessionKey,
          source: "subagent-progress",
          intent: "event",
          deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
        }),
      ).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CONTINUATION_SETTLEMENT_PENDING });
      expect(replySpy).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
    });
  }, 15_000);

  it.each(["returned", "restored", "requested-only"] as const)(
    "retains the original closeout through a second child round (%s)",
    async (yieldBoundary) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const registryPath = path.join(tmpDir, "delivery.json");
        vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
          session: { store: storePath },
        };
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "webchat",
          lastProvider: "webchat",
          lastTo: "123",
        });
        seedRequiredParentWait(sessionKey, "webchat");
        const originalWait = loadSubagentRegistryFromSqlite().get("child-1")!.parentYieldWait!;
        subagentRegistryTesting.setDepsForTest({
          getRuntimeConfig: () => cfg,
          runSubagentAnnounceFlow: async () => false,
          captureSubagentCompletionReply: async () => "The child work is complete.",
        });
        const runIds: string[] = [];
        replySpy.mockImplementation(async (_ctx, opts) => {
          const runId = opts!.runId!;
          runIds.push(runId);
          if (runIds.length > 1) {
            return { text: finalText };
          }
          expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows[0]).toMatchObject({
            obligationIdentity: { runId },
            parentYieldWaits: [wait],
            finalDeliveryDelivered: false,
          });
          const secondChild: SubagentRunRecord = {
            runId: "child-2",
            childSessionKey: "agent:main:subagent:child-2",
            controllerSessionKey: sessionKey,
            requesterSessionKey: sessionKey,
            requesterDisplayKey: sessionKey,
            requesterOrigin: { channel: "webchat", to: "123" },
            task: "Complete the newly discovered second step.",
            cleanup: "keep",
            expectsCompletionMessage: true,
            createdAt: Date.now(),
            startedAt: Date.now(),
          };
          addSubagentRunForTests(secondChild);
          const onYield = vi.fn();
          const tool = createOpenClawTools({
            config: cfg,
            agentSessionKey: sessionKey,
            sessionId: "sid",
            runId,
            onYield,
            disablePluginTools: true,
            disableMessageTool: true,
            wrapBeforeToolCallHook: false,
          }).find((entry) => entry.name === "sessions_yield")!;
          await tool.execute("second-round-yield", { message: "Wait for the second step." });
          expect(onYield).toHaveBeenCalledOnce();
          const requested = loadSubagentRegistryFromSqlite().get("child-2")!.parentYieldWait!;
          expect(requested).toMatchObject({
            ...wait,
            waitStartedAt: originalWait.waitStartedAt,
            expectedChildRunIds: ["child-1", "child-2"],
            status: "waiting",
            continuation: { runId, phase: "yield_requested" },
          });
          expect(requested.yieldedContinuations).toBeUndefined();
          if (yieldBoundary === "requested-only") {
            throw new Error("Backend interrupted after the yield request, before return");
          }
          // The backend boundary is mocked here; the common runner's actual
          // returned-yield gate is covered in sessions-yield.orchestration.test.ts.
          completeParentYieldWaitContinuationYield({ controllerSessionKey: sessionKey, runId });
          return { text: "The second step is still running." };
        });
        const request = {
          cfg,
          sessionKey,
          source: "subagent-progress" as const,
          intent: "event" as const,
          deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
        };
        const updates: SessionTranscriptUpdate[] = [];
        const stopUpdates = onSessionTranscriptUpdate((update) => updates.push(update));
        try {
          const first = await runHeartbeatOnce(request);
          const accepted = (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0];
          if (yieldBoundary === "requested-only") {
            expect(first.status).not.toBe("ran");
          } else {
            expect(first.status).toBe("ran");
            expect(accepted.preparedSourceFinal).toBeUndefined();
            expect(updates).toEqual([]);
            expect(peekSystemEventEntries(sessionKey)).toEqual([]);
          }
          expect(accepted.finalDeliveryDelivered).toBe(false);
          await subagentRegistryTesting.completeSubagentRunForTests({
            runId: "child-2",
            endedAt: Date.now(),
            outcome: { status: "ok" },
            reason: SUBAGENT_ENDED_REASON_COMPLETE,
            triggerCleanup: false,
          });
          if (yieldBoundary === "requested-only") {
            expect(await runHeartbeatOnce(request)).toEqual({
              status: "skipped",
              reason: HEARTBEAT_SKIP_CONTINUATION_SETTLEMENT_PENDING,
            });
            expect(replySpy).toHaveBeenCalledTimes(1);
            expect(
              loadSubagentRegistryFromSqlite().get("child-2")!.parentYieldWait?.status,
            ).not.toBe("closeout_delivered");
            return;
          }
          if (yieldBoundary === "restored") {
            resetSubagentRegistryForTests({ persist: false });
            resetSystemEventsForTest();
            subagentRegistryTesting.setDepsForTest({
              getRuntimeConfig: () => cfg,
              runSubagentAnnounceFlow: async () => false,
              captureSubagentCompletionReply: async () => "The child work is complete.",
            });
            await initSubagentRegistry({ gatewayStartup: true });
          }
          expect(
            peekSystemEventEntries(sessionKey).filter((event) => event.parentYieldWait),
          ).toHaveLength(1);
          expect((await runHeartbeatOnce(request)).status).toBe("ran");
          expect(replySpy).toHaveBeenCalledTimes(2);
          expect(runIds[1]).not.toBe(runIds[0]);
          await expectCanonicalSourceMessage(updates, storePath, sessionKey);
          const rows = (await loadSourceTurnDeliveryRegistry(registryPath)).rows;
          expect(rows).toHaveLength(2);
          expect(rows.find((row) => row.id === accepted.id)).toMatchObject({
            sourceTurnId: accepted.sourceTurnId,
            acceptedAt: accepted.acceptedAt,
            obligationIdentity: { runId: runIds[0] },
            sourceTurnState: "settled_resolved_later",
            finalDeliveryDelivered: false,
          });
          expect(rows.find((row) => row.obligationIdentity.runId === runIds[1])).toMatchObject({
            parentYieldWaits: [wait],
            sourceTurnState: "final_delivered",
            finalDeliveryDelivered: true,
          });
          const children = loadSubagentRegistryFromSqlite();
          for (const childId of ["child-1", "child-2"]) {
            expect(children.get(childId)?.parentYieldWait).toMatchObject({
              ...wait,
              waitStartedAt: originalWait.waitStartedAt,
              expectedChildRunIds: ["child-1", "child-2"],
              status: "closeout_delivered",
              yieldedContinuations: [{ runId: runIds[0], endedAt: expect.any(Number) }],
            });
          }
          expect(peekSystemEventEntries(sessionKey).some((event) => event.parentYieldWait)).toBe(
            false,
          );
        } finally {
          stopUpdates();
        }
      });
    },
    15_000,
  );

  it("reconciles a durable final after child-store failure without another execution or delivery", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const registryPath = path.join(tmpDir, "delivery.json");
      vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "webchat",
        lastTo: "123",
      });
      seedRequiredParentWait(sessionKey, "webchat");
      let failuresRemaining = 2;
      subagentRegistryTesting.setDepsForTest({
        persistSubagentRunsToDiskOrThrow(runs) {
          if (
            [...runs.values()].some(
              (run) => run.parentYieldWait?.status === "closeout_delivered",
            ) &&
            failuresRemaining > 0
          ) {
            failuresRemaining--;
            throw new Error("injected parent commit failure");
          }
          persistSubagentRunsToDiskOrThrow(runs);
        },
      });
      // The sink must use the actual delivered payload and configured source store.
      replySpy.mockResolvedValue(
        setReplyPayloadMetadata(
          { text: finalText },
          {
            deliverDespiteSourceReplySuppression: true,
            sourceReplyTranscriptMirror: {
              sessionKey,
              text: "stale pre-hook text",
              idempotencyKey: "source-final-1",
            },
          },
        ),
      );
      const updates: SessionTranscriptUpdate[] = [];
      const stopUpdates = onSessionTranscriptUpdate((update) => updates.push(update));
      const request = {
        cfg,
        sessionKey,
        source: "subagent-progress" as const,
        intent: "event" as const,
        deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
      };
      try {
        expect(await runHeartbeatOnce(request)).toEqual({
          status: "skipped",
          reason: HEARTBEAT_SKIP_CONTINUATION_SETTLEMENT_PENDING,
        });
        expect(replySpy).toHaveBeenCalledTimes(1);
        await expectCanonicalSourceMessage(updates, storePath, sessionKey);
        const firstReceipt = await loadSourceTurnDeliveryRegistry(registryPath);
        expect(firstReceipt.rows[0]?.sourceTurnState).toBe("final_delivered");
        expect(loadSubagentRegistryFromSqlite().get("child-1")?.parentYieldWait?.status).toBe(
          "continuation_scheduled",
        );
        expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        expect(await runHeartbeatOnce(request)).toEqual({
          status: "skipped",
          reason: HEARTBEAT_SKIP_CONTINUATION_SETTLEMENT_PENDING,
        });
        expect((await runHeartbeatOnce(request)).status).toBe("ran");
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(updates).toHaveLength(1);
        expect(await loadSourceTurnDeliveryRegistry(registryPath)).toEqual(firstReceipt);
        expect(loadSubagentRegistryFromSqlite().get("child-1")?.parentYieldWait?.status).toBe(
          "closeout_delivered",
        );
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        stopUpdates();
      }
    });
  }, 15_000);
});

describe("activation source delivery", () => {
  it.each(["none", "accepted-only", "final-receipt"] as const)(
    "publishes the immutable report after %s interruption",
    async (interruption) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const registryPath = path.join(tmpDir, "delivery.json");
        const exportsDir = path.join(tmpDir, "exports");
        vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
        vi.stubEnv("OPENCLAW_WORKSPACE_EXPORTS_DIR", exportsDir);
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
          session: { store: storePath },
        };
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "stale-destination",
        });
        const check = vi.fn<NonNullable<ActivationContinuationRunnerDeps["check"]>>(
          async (_record, name) => ({
            name,
            status: "pass" as const,
            detail: "verified runtime",
          }),
        );
        const record = await persistActivationContinuationBeforeRestart(
          {
            id: "activation-source-proof",
            now: Date.now() - 1_000,
            route: { sessionKey, deliveryContext: { channel: "webchat", to: "123" } },
            requiredChecks: ["http_health", "visible_delivery"],
          },
          { stateDir: tmpDir },
        );
        const pending = await resumeActivationContinuation(record, {
          stateDir: tmpDir,
          exportsDir,
          check,
        });
        expect(pending.status).toBe("pending_delivery");
        const persist = sourceDeliveryStore.persistSourceTurnDeliveryState;
        const acceptedRunId = "accepted-activation-run";
        const acceptedId = `source:${sessionKey}:${acceptedRunId}`;
        if (interruption === "accepted-only") {
          const ref = pending.result!.proof!.deliveryRef!;
          await persist({
            registryPath,
            id: acceptedId,
            sourceTurnId: acceptedId,
            sourceMessageId: acceptedRunId,
            sourceSessionKey: sessionKey,
            sourceChannel: "webchat",
            deliveryContext: { channel: "webchat", to: "123" },
            runId: acceptedRunId,
            deliveryId: ref.id,
            generation: ref.createdAt,
            reportId: ref.reportId,
            facts: {},
            currentStage: "accepted",
          });
        }
        let interrupted = false;
        const settle = sourceDeliveryStore.settleSourceTurnDeliveryFinal;
        const settleSpy = vi.fn(async (params: Parameters<typeof settle>[0]) => {
          if (interruption === "final-receipt" && !interrupted) {
            interrupted = true;
            throw new Error("injected activation publication interruption");
          }
          return settle(params);
        });
        const updates: SessionTranscriptUpdate[] = [];
        const stopUpdates = onSessionTranscriptUpdate((update) => updates.push(update));
        const request = {
          cfg,
          sessionKey,
          source: "restart-sentinel" as const,
          intent: "event" as const,
          deps: {
            getReplyFromConfig: replySpy,
            getQueueSize: () => 0,
            sourceDeliveryStore: {
              ...realSourceDeliveryStore,
              settleSourceTurnDeliveryFinal: settleSpy,
            },
          },
        };
        try {
          const first = await runHeartbeatOnce(request);
          if (interruption === "final-receipt") {
            expect(first).toEqual({
              status: "skipped",
              reason: HEARTBEAT_SKIP_CONTINUATION_SETTLEMENT_PENDING,
            });
            expect((await activationTesting.readStore(tmpDir)).records[0].status).toBe(
              "pending_delivery",
            );
            const previous = await loadSourceTurnDeliveryRegistry(registryPath);
            expect(previous.rows).toHaveLength(1);
            const retry = await runHeartbeatOnce(request);
            expect(
              retry,
              JSON.stringify(await loadSourceTurnDeliveryRegistry(registryPath)),
            ).toMatchObject({
              status: "ran",
            });
            const recovered = await loadSourceTurnDeliveryRegistry(registryPath);
            expect(recovered.rows).toHaveLength(1);
            expect(recovered.rows[0]).toMatchObject({
              id: previous.rows[0].id,
              sourceTurnId: previous.rows[0].sourceTurnId,
              obligationIdentity: previous.rows[0].obligationIdentity,
              acceptedAt: previous.rows[0].acceptedAt,
            });
          } else {
            expect(first.status).toBe("ran");
          }
          const delivered = await loadSourceTurnDeliveryRegistry(registryPath);
          expect(delivered.rows).toHaveLength(1);
          expect(delivered.rows[0].sourceTurnState).toBe("final_delivered");
          if (interruption === "accepted-only") {
            expect(delivered.rows[0]).toMatchObject({
              id: acceptedId,
              sourceMessageId: acceptedRunId,
              obligationIdentity: { runId: acceptedRunId },
            });
          }
          expect(replySpy).not.toHaveBeenCalled();
          expect(check).toHaveBeenCalledTimes(1);
          expect(updates).toHaveLength(1);
          expect(updates[0].message).toMatchObject({
            content: [{ type: "text", text: pending.result!.message }],
          });
          expect((await activationTesting.readStore(tmpDir)).records[0]).toMatchObject({
            status: "continuation_completed",
            result: { proof: { visibleDeliveryCompleted: true, deliveryStatus: "delivered" } },
          });
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        } finally {
          stopUpdates();
        }
      });
    },
    15_000,
  );
});

describe("required WebChat complete media dispatch", () => {
  it.each(["data-image", "sensitive-local", "missing-local"] as const)(
    "preserves full media identity and privacy through the actual dispatcher (%s)",
    async (mode) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const registryPath = path.join(tmpDir, "delivery.json");
        vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
          session: { store: storePath },
        };
        const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
          await import("../config/runtime-snapshot.js");
        setRuntimeConfigSnapshot(cfg);
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "webchat",
          lastProvider: "webchat",
          lastTo: "123",
        });
        const imageBytes = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXcZ0AAAAASUVORK5CYII=",
          "base64",
        );
        const localPath = path.join(tmpDir, "private.png");
        if (mode === "sensitive-local") {
          await fs.writeFile(localPath, imageBytes);
        }
        replySpy.mockResolvedValue({
          text: finalText,
          mediaUrl:
            mode === "data-image"
              ? `data:image/png;base64,${imageBytes.toString("base64")}`
              : localPath,
          ...(mode === "sensitive-local" ? { sensitiveMedia: true } : {}),
        });
        seedRequiredParentWait(sessionKey, "webchat");
        const updates: SessionTranscriptUpdate[] = [];
        const stopUpdates = onSessionTranscriptUpdate((update) => updates.push(update));
        try {
          const result = await runHeartbeatOnce({
            cfg,
            sessionKey,
            source: "subagent-progress",
            intent: "event",
            deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
          });
          expect(replySpy).toHaveBeenCalledTimes(1);
          const registry = await loadSourceTurnDeliveryRegistry(registryPath);
          const child = loadSubagentRegistryFromSqlite().get("child-1");
          if (mode !== "data-image") {
            expect(result.status).toBe("skipped");
            expect(registry.rows.every((row) => !row.finalDeliveryDelivered)).toBe(true);
            expect(updates).toEqual([]);
            expect(child?.parentYieldWait?.status).toBe("continuation_scheduled");
            expect(peekSystemEventEntries(sessionKey)[0]).toMatchObject({ parentYieldWait: wait });
            if (mode === "sensitive-local") {
              // A late privacy check would already have copied these bytes into
              // generic outbound media even though publication was then refused.
              expect(
                await fs.readdir(path.join(tmpDir, "media"), { recursive: true }).catch(() => []),
              ).toEqual([]);
            }
            return;
          }
          expect(result.status).toBe("ran");
          expect(registry.rows).toHaveLength(1);
          expect(registry.rows[0].finalDeliveryDelivered).toBe(true);
          const part = registry.rows[0].preparedSourceFinal!.parts[0];
          expect(part.webchatContent!.content).toEqual([
            { type: "text", text: finalText },
            expect.objectContaining({ type: "image", mimeType: "image/png" }),
          ]);
          expect(updates).toHaveLength(1);
          const update = updates[0];
          expect(
            await readSessionMessageByIdAsync(
              "sid",
              storePath,
              update.sessionFile,
              update.messageId!,
            ),
          ).toMatchObject({
            found: true,
            message: { content: part.webchatContent!.content, idempotencyKey: part.idempotencyKey },
          });
          const { readManagedOutgoingAttachmentProof } =
            await import("../gateway/managed-image-attachments.js");
          expect(
            await readManagedOutgoingAttachmentProof({
              sessionKey,
              messageId: update.messageId!,
              blocks: part.webchatContent!.content,
            }),
          ).toEqual(part.webchatContent!.assets);
          expect(child?.parentYieldWait?.status).toBe("closeout_delivered");
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        } finally {
          stopUpdates();
          clearRuntimeConfigSnapshot();
        }
      });
    },
    15_000,
  );
});
