import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { StructuredMissionCloseout } from "../../agents/mission-settlement-tail.js";
import { loadSourceTurnDeliveryRegistry } from "../../agents/source-turn-delivery-store.js";
import type { PluginHookReplyDispatchResult } from "../../plugins/hooks.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { listTasksForFlowId, resetTaskRegistryForTests } from "../../tasks/runtime-internal.js";
import {
  getTaskFlowActiveProductionContinuation,
  getTaskFlowMissionSettlement,
  getTaskFlowProductionContinuation,
  listTaskFlowRecords,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-flow-runtime-internal.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
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
import { createReplyDispatcher } from "./reply-dispatcher.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let sourceTurnDeliveryTempDir: string | undefined;
let previousSourceTurnDeliveryRegistryPath: string | undefined;
let previousStateDir: string | undefined;
let previousFalseCloseoutAdmission: string | undefined;
let previousFalseCloseoutAdmissionMode: string | undefined;

const SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV = "OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH";
const STATE_DIR_ENV = "OPENCLAW_STATE_DIR";

type SourceTurnDeliveryRegistryForTest = {
  rows: Array<{
    currentStage?: string;
    deliveryContext?: {
      accountId?: string;
      channel?: string;
      threadId?: string | number;
      to?: string;
    };
    deliveryStatus?: string;
    finalDeliveryDelivered?: boolean;
    failureReason?: string;
    sourceChannel?: string;
    sourceMessageId?: string;
    sourceSessionKey?: string;
    sourceTurnState?: string;
    visibleDeliveryCount?: number;
  }>;
};

const CLEANUP_CREW_OPEN_MILESTONE_REPORT = [
  "STATUS: in progress",
  "MODE: Cleanup Crew execution",
  "STAGE COMPLETE: ISSUE-039 scoped closeout delivered",
  "RESULT: PASS",
  "PROOF: focused validation and Grant review passed",
  "NEXT STAGE: dispatch ISSUE-040 post-milestone continuation repair",
  "SAFETY CHECK: no SOP blocker",
  "BLOCKERS: none",
  "Open/closed truth: broader Cleanup Crew issue-list repair remains open.",
].join("\n");

const CLEANUP_CREW_FULL_BUILD_COMPLETE_REPORT = [
  "Cleanup Crew final closeout",
  "Status: closed",
  "Target handled: Cleanup Crew issue-list repair",
  "Scope handled: full build closeout delivery",
  "Actual execution owner: Cleanup Crew",
  "Artifact path(s): /home/will/.openclaw/workspace/file_hub/exports/cleanup_crew_closeout.md",
  "Proof path(s): /home/will/.openclaw/workspace/file_hub/exports/cleanup_crew_proof.json",
  "What is materially real now: Cleanup Crew issue-list repair is truthfully complete.",
  "What is still not real yet: nothing.",
  "Who lawfully owns the next step: none.",
  "Open/closed truth: Cleanup Crew issue-list repair is truthfully closed.",
  "Exact next action: none; whole run complete.",
].join("\n");

const CLEANUP_CREW_SCOPED_CLOSEOUT_WITHOUT_PARENT_CONTINUATION = [
  "Cleanup Crew scoped closeout",
  "Status: closed for this scoped slice",
  "Target handled: ISSUE-040 b84ac82 activation slice",
  "Scope handled: b84ac82 scoped activation slice",
  "Actual execution owner: Cleanup Crew",
  "Artifact path(s): /home/will/.openclaw/workspace/file_hub/exports/issue_040_b84ac82.md",
  "Proof path(s): /home/will/.openclaw/workspace/file_hub/exports/issue_040_b84ac82_proof.json",
  "What is materially real now: The b84ac82 scoped activation slice is closed.",
  "What is still not real yet: Broader ISSUE-040 remains open.",
  "Who lawfully owns the next step: Will / Cleanup Crew owns parent continuation.",
  "Open/closed truth: scoped slice closed; broader ISSUE-040 remains open.",
  "Exact next action: not recorded yet",
].join("\n");

const STRUCTURED_CLEANUP_CREW_CLOSEOUT: StructuredMissionCloseout = {
  runLabel: "Cleanup Crew structured final closeout",
  targetHandled: "Cleanup Crew issue-list repair",
  scopeHandled: "full build closeout delivery",
  actualExecutionOwner: "Cleanup Crew",
  artifactPaths: ["/home/will/.openclaw/workspace/file_hub/exports/cleanup_crew_closeout.md"],
  proofPaths: ["/home/will/.openclaw/workspace/file_hub/exports/cleanup_crew_proof.json"],
  whatIsMateriallyRealNow: "Cleanup Crew issue-list repair is truthfully complete.",
  whatIsStillNotRealYet: "nothing.",
  whoLawfullyOwnsNextStep: "none.",
  openClosedTruth: "Cleanup Crew issue-list repair is truthfully closed.",
  exactNextAction: "none; whole run complete.",
  shortResult: "Structured closeout metadata settles the mission tail.",
};

async function useTempSourceTurnDeliveryRegistry(): Promise<string> {
  sourceTurnDeliveryTempDir = await mkdtemp(join(tmpdir(), "openclaw-source-turn-delivery-"));
  const registryPath = join(sourceTurnDeliveryTempDir, "openclaw.sqlite");
  process.env[SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV] = registryPath;
  return registryPath;
}

async function readSourceTurnDeliveryRows(registryPath: string) {
  return (await loadSourceTurnDeliveryRegistry(registryPath))
    .rows as SourceTurnDeliveryRegistryForTest["rows"];
}

async function withCleanupCrewDispatchState(run: () => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cleanup-post-report-" },
    async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run();
      } finally {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
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
    previousStateDir = process.env[STATE_DIR_ENV];
    previousFalseCloseoutAdmission = process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION;
    previousFalseCloseoutAdmissionMode = process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION_MODE;
    delete process.env[SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV];
    delete process.env[STATE_DIR_ENV];
    delete process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION;
    delete process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION_MODE;
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
    closeOpenClawStateDatabaseForTest();
    if (previousSourceTurnDeliveryRegistryPath === undefined) {
      delete process.env[SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV];
    } else {
      process.env[SOURCE_TURN_DELIVERY_REGISTRY_PATH_ENV] = previousSourceTurnDeliveryRegistryPath;
    }
    if (previousStateDir === undefined) {
      delete process.env[STATE_DIR_ENV];
    } else {
      process.env[STATE_DIR_ENV] = previousStateDir;
    }
    if (previousFalseCloseoutAdmission === undefined) {
      delete process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION;
    } else {
      process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION = previousFalseCloseoutAdmission;
    }
    if (previousFalseCloseoutAdmissionMode === undefined) {
      delete process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION_MODE;
    } else {
      process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION_MODE = previousFalseCloseoutAdmissionMode;
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

  it("keeps parent-scope mission settlement open when a delivered scoped closeout has no real parent continuation coverage", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });

    await withCleanupCrewDispatchState(async () => {
      const dispatcher = createDispatcher();
      const result = await dispatchReplyFromConfig({
        ctx: createSourceTurnCtx({
          SessionKey: "webchat:direct:mark",
          Body: "run all of ISSUE-040 under Cleanup Crew",
          BodyForAgent: "run all of ISSUE-040 under Cleanup Crew",
          BodyForCommands: "run all of ISSUE-040 under Cleanup Crew",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => ({
          text: CLEANUP_CREW_SCOPED_CLOSEOUT_WITHOUT_PARENT_CONTINUATION,
        }),
      });

      expect(result.queuedFinal).toBe(false);
      const rows = await readSourceTurnDeliveryRows(registryPath);
      expect(rows).toHaveLength(1);
      expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("ACTIVE_RUN_CONTINUITY_VIOLATION"),
        }),
      );
      expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("broader_build_open_next_action_missing"),
        }),
      );
    });
  });

  it("does not turn a prose-only milestone into execution or delivery proof", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });

    await withCleanupCrewDispatchState(async () => {
      const dispatcher = createDispatcher();
      const result = await dispatchReplyFromConfig({
        ctx: createSourceTurnCtx({
          SessionKey: "webchat:direct:mark",
          Body: "Cleanup Crew production repair build.",
          BodyForAgent: "Cleanup Crew production repair build.",
          BodyForCommands: "Cleanup Crew production repair build.",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => ({ text: CLEANUP_CREW_OPEN_MILESTONE_REPORT }),
      });

      expect(result.queuedFinal).toBe(false);
      const rows = await readSourceTurnDeliveryRows(registryPath);
      expect(rows[0]?.finalDeliveryDelivered).toBe(false);
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalledWith({
        text: CLEANUP_CREW_OPEN_MILESTONE_REPORT,
      });
      const [flow] = listTaskFlowRecords();
      expect(flow).toBeDefined();
      expect(getTaskFlowProductionContinuation(flow)).toMatchObject({
        activeProductionRun: true,
        parentRunOpen: true,
        nextExecutableUnitIdentified: false,
        nextExecutableUnitLaunched: false,
        continuationRequiredAfterLocalSuccess: false,
      });
      expect(getTaskFlowActiveProductionContinuation(flow)).toMatchObject({
        broaderBuildOpen: true,
        status: "dispatch_required",
        boundary: "plan_next_step",
        dispatchReceipts: [],
      });
      expect(listTasksForFlowId(flow.flowId)).toHaveLength(1);
    });
  });

  it("admits an executed milestone and keeps its pending next action idempotent on duplicate delivery", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });

    await withCleanupCrewDispatchState(async () => {
      const ctx = createSourceTurnCtx({
        SessionKey: "webchat:direct:mark",
        Body: "Cleanup Crew production repair build.",
        BodyForAgent: "Cleanup Crew production repair build.",
        BodyForCommands: "Cleanup Crew production repair build.",
      });
      let executedReceiptId: string | undefined;
      const replyResolver = vi.fn(async (_ctx: unknown, opts?: GetReplyOptions) => {
        expect(opts?.onExecutionProgress).toEqual(expect.any(Function));
        await opts?.onExecutionProgress?.({
          runId: "repair-run-1",
          source: "tool",
          phase: "start",
          toolCallId: "exec-1",
          name: "exec",
        });
        const [executingFlow] = listTaskFlowRecords();
        const executing = getTaskFlowActiveProductionContinuation(executingFlow);
        expect(executing).toMatchObject({
          status: "dispatched",
          nextAction: { dispatchProofRef: "run:repair-run-1:tool:start:exec-1:exec" },
        });
        executedReceiptId = executing?.lastDispatchReceiptId;
        return { text: CLEANUP_CREW_OPEN_MILESTONE_REPORT };
      });
      const firstDispatcher = createDispatcher();
      const firstResult = await dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher: firstDispatcher,
        replyResolver,
      });
      expect(firstResult.queuedFinal).toBe(true);
      expect(firstDispatcher.sendFinalReply).toHaveBeenCalledWith({
        text: CLEANUP_CREW_OPEN_MILESTONE_REPORT,
      });
      expect((await readSourceTurnDeliveryRows(registryPath))[0]).toMatchObject({
        currentStage: "final_dispatch_delivered",
        finalDeliveryDelivered: true,
      });
      const [firstFlow] = listTaskFlowRecords();
      expect(firstFlow).toBeDefined();
      const firstTaskId = listTasksForFlowId(firstFlow.flowId)[0]?.taskId;
      const firstContinuation = getTaskFlowProductionContinuation(firstFlow);
      expect(firstFlow.currentStep).toBe("cleanup_crew_post_report_continuation");
      expect(firstFlow.stateJson).toMatchObject({
        currentCheckpointKind: "milestone_delivered",
        nextExecutableAction: "dispatch ISSUE-040 post-milestone continuation repair",
      });
      expect(firstContinuation?.nextExecutableUnitLaunched).toBe(false);

      const secondDispatcher = createDispatcher();
      await dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher: secondDispatcher,
        replyResolver,
      });

      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(secondDispatcher.sendFinalReply).not.toHaveBeenCalledWith({
        text: CLEANUP_CREW_OPEN_MILESTONE_REPORT,
      });
      const flows = listTaskFlowRecords();
      expect(flows).toHaveLength(1);
      const [secondFlow] = flows;
      expect(listTasksForFlowId(secondFlow.flowId).map((task) => task.taskId)).toEqual([
        firstTaskId,
      ]);
      expect(getTaskFlowActiveProductionContinuation(secondFlow)).toMatchObject({
        status: "dispatch_required",
        nextAction: {
          summary: "dispatch ISSUE-040 post-milestone continuation repair",
        },
      });
      expect(getTaskFlowActiveProductionContinuation(secondFlow)?.dispatchReceipts).toEqual([]);
      expect(
        getTaskFlowActiveProductionContinuation(secondFlow)?.lastDispatchReceiptId,
      ).toBeUndefined();
      expect(executedReceiptId).not.toBeUndefined();
      expect(getTaskFlowProductionContinuation(secondFlow)?.events).toEqual(
        firstContinuation?.events,
      );
      expect(firstContinuation?.events).toContainEqual(
        expect.objectContaining({
          type: "NEXT_EXECUTABLE_UNIT_LAUNCHED",
          detail: "run:repair-run-1:tool:start:exec-1:exec",
        }),
      );
    });
  });

  it("allows a delivered full-build complete Cleanup Crew report to stop without active-run violation", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });

    await withCleanupCrewDispatchState(async () => {
      const dispatcher = createDispatcher();
      const result = await dispatchReplyFromConfig({
        ctx: createSourceTurnCtx({
          SessionKey: "webchat:direct:mark",
          Body: "Cleanup Crew production repair build.",
          BodyForAgent: "Cleanup Crew production repair build.",
          BodyForCommands: "Cleanup Crew production repair build.",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => ({ text: CLEANUP_CREW_FULL_BUILD_COMPLETE_REPORT }),
      });

      expect(result.queuedFinal).toBe(true);
      expect(dispatcher.sendToolResult).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("ACTIVE_RUN_CONTINUITY_VIOLATION"),
        }),
      );
      const rows = await readSourceTurnDeliveryRows(registryPath);
      expect(rows[0]).toMatchObject({
        currentStage: "final_dispatch_delivered",
        deliveryStatus: "final_delivered",
      });
      const [flow] = listTaskFlowRecords();
      expect(flow).toBeDefined();
      expect(flow?.status).toBe("terminal_pending_watchdog");
      expect(flow?.currentStep).toBe("cleanup_crew_full_build_complete_report_delivered");
      expect(getTaskFlowMissionSettlement(flow)).toMatchObject({
        state: "SETTLED",
        settled: true,
        allowedToCloseMission: true,
        recoveryAction: "settlement_complete",
      });
      expect(getTaskFlowProductionContinuation(flow)).toMatchObject({
        activeProductionRun: true,
        parentRunOpen: false,
        lawfulWholeRunCompletion: true,
        lawfulStopReason: "whole_run_complete",
      });
    });
  });

  it("keeps full-build complete Cleanup Crew report open when final delivery fails", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);

    await withCleanupCrewDispatchState(async () => {
      const dispatcher = createDispatcher();
      vi.mocked(dispatcher.sendFinalReply).mockReturnValue(false);
      const result = await dispatchReplyFromConfig({
        ctx: createSourceTurnCtx({
          SessionKey: "webchat:direct:mark",
          Body: "Cleanup Crew production repair build.",
          BodyForAgent: "Cleanup Crew production repair build.",
          BodyForCommands: "Cleanup Crew production repair build.",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => ({ text: CLEANUP_CREW_FULL_BUILD_COMPLETE_REPORT }),
      });

      expect(result.queuedFinal).toBe(false);
      expect(dispatcher.sendToolResult).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("ACTIVE_RUN_CONTINUITY_VIOLATION"),
        }),
      );
      const rows = await readSourceTurnDeliveryRows(registryPath);
      expect(rows[0]).toMatchObject({
        currentStage: "final_dispatch_delivery_failed",
        deliveryStatus: "delivery_failed",
        sourceTurnState: "final_delivery_failed",
      });
      const [flow] = listTaskFlowRecords();
      expect(flow).toBeDefined();
      expect(flow?.status).toBe("running");
      expect(flow?.currentStep).toBe("mission_settlement_tail_delivery_retry");
      expect(getTaskFlowMissionSettlement(flow)).toMatchObject({
        state: "DELIVERY_FAILED",
        settled: false,
        allowedToCloseMission: false,
        workCompletionSettledSeparately: true,
        recoveryAction: "retry_delivery_only_with_idempotency",
        nextIncompleteBoundary: "delivery_retry",
      });
      expect(getTaskFlowProductionContinuation(flow)).toMatchObject({
        activeProductionRun: true,
        parentRunOpen: true,
      });
    });
  });

  it("settles Cleanup Crew mission tail from structured closeout metadata instead of prose parsing", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);

    await withCleanupCrewDispatchState(async () => {
      const structuredPayload = setReplyPayloadMetadata(
        {
          text: [
            "Cleanup Crew final closeout",
            "Status: closed",
            "What is materially real now: Cleanup Crew issue-list repair is truthfully complete.",
            "What is still not real yet: nothing.",
            "Who lawfully owns the next step: none.",
            "Open/closed truth: Cleanup Crew issue-list repair is truthfully closed.",
            "Exact next action: none; whole run complete.",
          ].join("\n"),
        },
        { structuredMissionCloseout: STRUCTURED_CLEANUP_CREW_CLOSEOUT },
      );
      const result = await dispatchReplyFromConfig({
        ctx: createSourceTurnCtx({
          SessionKey: "webchat:direct:mark",
          Body: "Cleanup Crew production repair build.",
          BodyForAgent: "Cleanup Crew production repair build.",
          BodyForCommands: "Cleanup Crew production repair build.",
        }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver: async () => structuredPayload,
      });

      expect(result.queuedFinal).toBe(true);
      const rows = await readSourceTurnDeliveryRows(registryPath);
      expect(rows[0]).toMatchObject({
        currentStage: "final_dispatch_delivered",
        deliveryStatus: "final_delivered",
        sourceTurnState: "final_delivered",
      });
      const [flow] = listTaskFlowRecords();
      expect(flow?.status).toBe("terminal_pending_watchdog");
      expect(flow?.currentStep).toBe("cleanup_crew_full_build_complete_report_delivered");
      expect(getTaskFlowMissionSettlement(flow)).toMatchObject({
        state: "SETTLED",
        settled: true,
        allowedToCloseMission: true,
        closeoutValidation: {
          valid: true,
          missingFields: [],
          missingSupportFields: [],
        },
      });
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

  it("uses the shared state database when the source-delivery override is unset", async () => {
    sourceTurnDeliveryTempDir = await mkdtemp(join(tmpdir(), "openclaw-source-turn-default-"));
    process.env[STATE_DIR_ENV] = sourceTurnDeliveryTempDir;
    hookMocks.runner.hasHooks.mockReturnValue(false);

    const result = await dispatchReplyFromConfig({
      ctx: createSourceTurnCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "visible final from default registry" }),
    });

    expect(result.queuedFinal).toBe(true);
    const registryPath = join(sourceTurnDeliveryTempDir, "state", "openclaw.sqlite");
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
      deliveryContext: {
        channel: "discord",
        to: "source-user-1",
      },
      deliveryStatus: "delivery_failed",
      failureReason: "delivery_tool_failed",
      finalDeliveryDelivered: false,
      sourceChannel: "discord",
      sourceMessageId: "source-turn-message-1",
      sourceSessionKey: "agent:test:session",
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

  it("prepares a rich-only WebChat final before dispatch can abort", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionId: "source-session",
      sessionKey: "agent:test:session",
    };
    sessionStoreMocks.readSessionEntry.mockReturnValue(sessionStoreMocks.currentEntry);
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new Error("dispatch bubble closed");
      },
    });
    const payload = {
      presentation: {
        title: "Approval required",
        blocks: [
          { type: "context" as const, text: "Review the proposed repair." },
          {
            type: "buttons" as const,
            buttons: [{ label: "Approve", value: "approve" }],
          },
        ],
      },
    };

    const result = await dispatchReplyFromConfig({
      ctx: createSourceTurnCtx({
        OriginatingChannel: "webchat",
        ParentYieldWaits: [{ parentRunId: "parent-run", waitId: "parent-wait" }],
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "required-source-run" },
      replyResolver: async () => payload,
    });

    expect(result.queuedFinal).toBe(true);
    const rows = await readSourceTurnDeliveryRows(registryPath);
    expect(rows[0]).toMatchObject({
      currentStage: "final_dispatch_prepared_pending_delivery",
      preparedSourceFinal: {
        kind: "source_session_transcript",
        parts: [
          {
            payload,
            webchatContent: {
              content: [
                {
                  type: "text",
                  text: "Approval required\nReview the proposed repair.\nApprove",
                },
              ],
            },
          },
        ],
      },
    });
  });

  it.each([
    { label: "transformed", nativeText: "Raw native answer.", unchanged: false },
    { label: "unchanged", nativeText: "The final answer is 42.", unchanged: true },
  ])(
    "prepares a $label WebChat final before its original source dispatch",
    async ({ nativeText, unchanged }) => {
      const registryPath = await useTempSourceTurnDeliveryRegistry();
      hookMocks.runner.hasHooks.mockReturnValue(false);
      sessionStoreMocks.currentEntry = {
        sessionId: "source-session",
        sessionKey: "agent:test:session",
      };
      sessionStoreMocks.readSessionEntry.mockImplementation(() => sessionStoreMocks.currentEntry);
      let createdAt = 0;
      const nativeAssistantTranscript = {
        sessionId: "source-session",
        sessionFile: "/tmp/source-session.jsonl",
        messageId: "native-final-entry",
        text: nativeText,
      };
      const dispatcher = createReplyDispatcher({
        deliver: async () => {
          throw new Error("original source dispatch interrupted");
        },
      });

      const result = await dispatchReplyFromConfig({
        ctx: createSourceTurnCtx({
          Provider: "webchat",
          Surface: "webchat",
          CommandTurn: { kind: "normal", source: "message", authorized: false, body: "hello" },
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: { runId: "ordinary-webchat-run" },
        replyResolver: async () => {
          createdAt = Date.now();
          sessionStoreMocks.currentEntry = {
            ...sessionStoreMocks.currentEntry,
            pendingFinalDelivery: true,
            pendingFinalDeliveryCreatedAt: createdAt,
          };
          return setReplyPayloadMetadata(
            { text: "The final answer is 42." },
            {
              nativeAssistantTranscript,
              ...(unchanged ? { canonicalAssistantTranscript: nativeAssistantTranscript } : {}),
            },
          );
        },
      });

      expect(result.queuedFinal).toBe(true);
      expect((await readSourceTurnDeliveryRows(registryPath))[0]).toMatchObject({
        currentStage: "final_dispatch_prepared_pending_delivery",
        finalDeliveryDelivered: false,
        sourceChannel: "webchat",
        preparedSourceFinal: {
          kind: "source_session_transcript",
          pendingFinalDeliveryCreatedAt: createdAt,
          parts: [
            {
              text: "The final answer is 42.",
              ...(unchanged
                ? { canonicalAssistantTranscript: nativeAssistantTranscript }
                : { nativeAssistantTranscript }),
            },
          ],
        },
      });
    },
  );

  it("leaves a WebChat reply without a model pending marker to its Gateway owner", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionId: "source-session",
      sessionKey: "agent:test:session",
    };
    sessionStoreMocks.readSessionEntry.mockReturnValue(sessionStoreMocks.currentEntry);
    const dispatcher = createDispatcher();

    await dispatchReplyFromConfig({
      ctx: createSourceTurnCtx({
        Provider: "webchat",
        Surface: "webchat",
        CommandTurn: { kind: "normal", source: "message", authorized: false, body: "hello" },
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "gateway-owned-run" },
      replyResolver: async () => ({ text: "Gateway-owned final" }),
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    expect((await readSourceTurnDeliveryRows(registryPath))[0]).toMatchObject({
      finalDeliveryDelivered: true,
      currentStage: "final_dispatch_delivered",
    });
    expect((await readSourceTurnDeliveryRows(registryPath))[0]).not.toHaveProperty(
      "preparedSourceFinal",
    );
  });

  it("keeps an error final deliverable when a WebChat pending marker exists", async () => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionId: "source-session",
      sessionKey: "agent:test:session",
    };
    sessionStoreMocks.readSessionEntry.mockImplementation(() => sessionStoreMocks.currentEntry);
    const dispatcher = createDispatcher();

    await dispatchReplyFromConfig({
      ctx: createSourceTurnCtx({
        Provider: "webchat",
        Surface: "webchat",
        CommandTurn: { kind: "normal", source: "message", authorized: false, body: "hello" },
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "webchat-error-run" },
      replyResolver: async () => {
        sessionStoreMocks.currentEntry = {
          ...sessionStoreMocks.currentEntry,
          pendingFinalDelivery: true,
          pendingFinalDeliveryCreatedAt: Date.now(),
        };
        return { text: "Model failed", isError: true };
      },
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Model failed", isError: true }),
    );
    expect((await readSourceTurnDeliveryRows(registryPath))[0]).not.toHaveProperty(
      "preparedSourceFinal",
    );
  });

  it.each([
    { name: "initial", tail: false },
    { name: "tail", tail: true },
  ])("routes an ACP $name handled final through required source persistence", async ({ tail }) => {
    const registryPath = await useTempSourceTurnDeliveryRegistry();
    sessionStoreMocks.currentEntry = {
      sessionId: "source-session",
      sessionKey: "agent:test:session",
    };
    sessionStoreMocks.readSessionEntry.mockReturnValue(sessionStoreMocks.currentEntry);
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });
    hookMocks.runner.runReplyDispatch.mockImplementation(
      async (eventUnknown: unknown, hookCtxUnknown: unknown) => {
        const event = eventUnknown as { isTailDispatch?: boolean };
        if (Boolean(event.isTailDispatch) !== tail) {
          return undefined;
        }
        const hookCtx = hookCtxUnknown as {
          deliverFinalBatch?: (payloads: Array<{ text: string }>) => Promise<{
            queuedFinal: boolean;
          }>;
        };
        if (!hookCtx.deliverFinalBatch) {
          throw new Error("required final batch delivery missing");
        }
        const final = await hookCtx.deliverFinalBatch([
          { text: `ACP ${tail ? "tail" : "initial"} final` },
        ]);
        return {
          handled: true,
          queuedFinal: final.queuedFinal,
          counts: dispatcher.getQueuedCounts(),
        };
      },
    );
    const ctx = createSourceTurnCtx({
      OriginatingChannel: "webchat",
      ParentYieldWaits: [{ parentRunId: "parent-run", waitId: "parent-wait" }],
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "required-acp-source-run" },
      replyResolver: async (resolverCtx) => {
        if (tail) {
          resolverCtx.AcpDispatchTailAfterReset = true;
        }
        return undefined;
      },
    });

    expect(result.queuedFinal).toBe(true);
    expect(delivered).toEqual([`ACP ${tail ? "tail" : "initial"} final`]);
    expect((await readSourceTurnDeliveryRows(registryPath))[0]).toMatchObject({
      currentStage: "final_dispatch_prepared_pending_delivery",
      preparedSourceFinal: {
        kind: "source_session_transcript",
        parts: [{ text: `ACP ${tail ? "tail" : "initial"} final` }],
      },
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
