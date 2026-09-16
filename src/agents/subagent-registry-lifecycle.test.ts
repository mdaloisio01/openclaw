import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../gateway/call.js";
import {
  drainSystemEventEntries,
  enqueueSystemEvent,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { createTaskRecord, resetTaskRegistryForTests } from "../tasks/runtime-internal.js";
import { listTaskFlowAuditFindings } from "../tasks/task-flow-registry.audit.js";
import {
  createBlindTestSliceFlow,
  createManagedTaskFlow,
  getTaskFlowById,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-runtime-internal.js";
import { listTaskAuditFindings } from "../tasks/task-registry.audit.js";
import { findLatestTaskForSessionKey } from "../tasks/task-registry.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleControllerParams = Parameters<typeof createSubagentRegistryLifecycleController>[0];
afterEach(resetSystemEventsForTest);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const grantRetirementRequestScriptPath = path.join(
  repoRoot,
  "scripts",
  "grant-retirement-request.mjs",
);

function requireCreatedFlow<T>(flow: T | null): T {
  if (!flow) {
    throw new Error("Expected test task flow to be created");
  }
  return flow;
}

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(async (_opts: CallGatewayOptions) => ({})),
}));

const helperMocks = vi.hoisted(() => ({
  persistSubagentSessionTiming: vi.fn(async () => {}),
  safeRemoveAttachmentsDir: vi.fn(async () => {}),
  logAnnounceGiveUp: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const lifecycleEventMocks = vi.hoisted(() => ({
  emitSessionLifecycleEvent: vi.fn(),
}));

const browserLifecycleCleanupMocks = vi.hoisted(() => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

vi.mock("../tasks/detached-task-runtime.js", () => ({
  completeTaskRunByRunId: taskExecutorMocks.completeTaskRunByRunId,
  failTaskRunByRunId: taskExecutorMocks.failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId: taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId,
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: lifecycleEventMocks.emitSessionLifecycleEvent,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd:
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
}));

vi.mock("./agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: runtimeMocks.log,
  },
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (origin: unknown) => origin ?? "agent",
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: vi.fn(async () => false),
}));

vi.mock("./subagent-registry-cleanup.js", () => ({
  resolveCleanupCompletionReason: () => SUBAGENT_ENDED_REASON_COMPLETE,
  resolveDeferredCleanupDecision: () => ({ kind: "give-up", reason: "retry-limit" }),
}));

vi.mock("./subagent-registry-helpers.js", () => ({
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS: 30 * 60_000,
  ANNOUNCE_EXPIRY_MS: 5 * 60_000,
  MAX_ANNOUNCE_RETRY_COUNT: 3,
  MIN_ANNOUNCE_RETRY_DELAY_MS: 1_000,
  capFrozenResultText: (text: string) => text.trim(),
  logAnnounceGiveUp: helperMocks.logAnnounceGiveUp,
  persistSubagentSessionTiming: helperMocks.persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs: (retryCount: number) =>
    Math.min(1_000 * 2 ** Math.max(0, retryCount - 1), 8_000),
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
}));

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    createdAt: 1_000,
    startedAt: 2_000,
    ...overrides,
  };
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

async function readOnlyJsonArtifact<T>(dir: string, subdir: string): Promise<T> {
  const artifactDir = path.join(dir, subdir);
  const files = await fs.readdir(artifactDir);
  expect(files).toHaveLength(1);
  return JSON.parse(await fs.readFile(path.join(artifactDir, files[0]), "utf8")) as T;
}

function firstCall(mock: ReturnType<typeof vi.fn>): ReadonlyArray<unknown> {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected first mock call");
  }
  return call;
}

function firstCallArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [arg] = firstCall(mock);
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first call argument object");
  }
  return arg as Record<string, unknown>;
}

function findCallArg(
  mock: ReturnType<typeof vi.fn>,
  predicate: (arg: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const [arg] of mock.mock.calls) {
    if (arg && typeof arg === "object" && predicate(arg as Record<string, unknown>)) {
      return arg as Record<string, unknown>;
    }
  }
  throw new Error("expected matching mock call");
}

function hasDeliveredTaskStatusUpdate(runId: string): boolean {
  return taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mock.calls.some(([arg]) => {
    const record = arg as { runId?: unknown; deliveryStatus?: unknown } | undefined;
    return record?.runId === runId && record.deliveryStatus === "delivered";
  });
}

function buildExpectedAnnounceIdempotencyKey(entry: SubagentRunRecord): string {
  return buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    }),
  );
}

function createLifecycleController({
  entry,
  runs = new Map([[entry.runId, entry]]),
  ...overrides
}: {
  entry: SubagentRunRecord;
  runs?: Map<string, SubagentRunRecord>;
} & Partial<Parameters<typeof createSubagentRegistryLifecycleController>[0]>) {
  const params: LifecycleControllerParams = {
    runs,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    persist: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    suppressAnnounceForSteerRestart: () => false,
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    assertParentYieldWaitAllowsRestart: vi.fn(async () => {}),
    replaceSubagentRunAfterSteer: vi.fn(async () => true),
    callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> =>
      (await gatewayMocks.callGateway(opts)) as T,
    captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    runSubagentAnnounceFlow: vi.fn(async () => true),
    warn: vi.fn(),
  };
  Object.assign(params, overrides);
  return createSubagentRegistryLifecycleController(params);
}

async function runNoReplyMirrorScenario(params: {
  timestamp: number;
  text?: string;
  idempotencyKey?: string;
  idempotencyKeyForEntry?: (entry: SubagentRunRecord) => string;
}): Promise<SubagentRunRecord> {
  const entry = createRunEntry({
    endedAt: 4_000,
    expectsCompletionMessage: true,
    retainAttachmentsOnKeep: true,
  });
  const text = params.text ?? "final completion reply";
  const idempotencyKey =
    params.idempotencyKeyForEntry?.(entry) ??
    params.idempotencyKey ??
    `${buildExpectedAnnounceIdempotencyKey(entry)}:internal-source-reply:0`;
  const runSubagentAnnounceFlow = vi.fn(
    async (announceParams: {
      onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
    }) => {
      announceParams.onDeliveryResult?.({
        delivered: false,
        path: "direct",
        error: "completion agent did not produce a visible reply",
      });
      return false;
    },
  );
  gatewayMocks.callGateway.mockResolvedValueOnce({
    messages: [
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: text,
        timestamp: params.timestamp,
        idempotencyKey,
      },
    ],
  });

  await createLifecycleController({
    entry,
    captureSubagentCompletionReply: vi.fn(async () => text),
    persist: vi.fn(),
    runSubagentAnnounceFlow,
  }).completeSubagentRun({
    runId: entry.runId,
    endedAt: 4_000,
    outcome: { status: "ok" },
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    triggerCleanup: true,
  });
  return entry;
}

describe("subagent registry lifecycle hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskExecutorMocks.completeTaskRunByRunId.mockReset();
    taskExecutorMocks.failTaskRunByRunId.mockReset();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockReset();
    gatewayMocks.callGateway.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({});
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockResolvedValue(true);
  });

  it("does not reject completion when task finalization throws", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    taskExecutorMocks.completeTaskRunByRunId.mockImplementation(() => {
      throw new Error("task store boom");
    });

    const controller = createLifecycleController({ entry, runs, persist, warn });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const [warning, warningFields] = firstCall(warn);
    expect(warning).toBe("failed to finalize subagent background task state");
    expectFields(warningFields, {
      error: { name: "Error", message: "task store boom" },
      runId: "***",
      childSessionKey: "agent:main:…",
      outcomeStatus: "ok",
    });
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(1);
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });
  });

  it("marks required progress-only completions blocked without failing the task", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => "I'll inspect the repo now."),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary: "I'll inspect the repo now.",
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    });
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("marks missing required completions blocked while preserving real final reports", async () => {
    const missingEntry = createRunEntry({
      expectsCompletionMessage: true,
    });
    await createLifecycleController({
      entry: missingEntry,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
    }).completeSubagentRun({
      runId: missingEntry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: missingEntry.runId,
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    });

    taskExecutorMocks.completeTaskRunByRunId.mockClear();
    const finalEntry = createRunEntry({
      runId: "run-final",
      expectsCompletionMessage: true,
    });
    await createLifecycleController({
      entry: finalEntry,
      captureSubagentCompletionReply: vi.fn(
        async () => "Fixed the crash and verified the regression tests pass.",
      ),
    }).completeSubagentRun({
      runId: finalEntry.runId,
      endedAt: 5_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const finalArg = firstCallArg(taskExecutorMocks.completeTaskRunByRunId);
    expectFields(finalArg, {
      runId: finalEntry.runId,
      runtime: "subagent",
      sessionKey: finalEntry.childSessionKey,
      progressSummary: "Fixed the crash and verified the regression tests pass.",
      terminalSummary: null,
    });
    expect(finalArg.terminalOutcome).toBeUndefined();
  });

  it("keeps required completions successful when final output follows progress text", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    await createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(
        async () => "I'll inspect the repo now. The crash is a missing null check in src/foo.ts.",
      ),
    }).completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const finalArg = firstCallArg(taskExecutorMocks.completeTaskRunByRunId);
    expectFields(finalArg, {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary:
        "I'll inspect the repo now. The crash is a missing null check in src/foo.ts.",
      terminalSummary: null,
    });
    expect(finalArg.terminalOutcome).toBeUndefined();
  });

  it("keeps required completions successful when final output follows a separator", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    await createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(
        async () => "I'll inspect the repo now - the crash is a missing null check in src/foo.ts.",
      ),
    }).completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const finalArg = firstCallArg(taskExecutorMocks.completeTaskRunByRunId);
    expectFields(finalArg, {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary:
        "I'll inspect the repo now - the crash is a missing null check in src/foo.ts.",
      terminalSummary: null,
    });
    expect(finalArg.terminalOutcome).toBeUndefined();
  });

  it("keeps required completions blocked when progress text only adds follow-up planning", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    await createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(
        async () => "I'll inspect the repo now. Then I'll run tests and report back.",
      ),
    }).completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary: "I'll inspect the repo now. Then I'll run tests and report back.",
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    });
  });

  it("does not reject cleanup give-up when task delivery status update throws", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockImplementation(() => {
      throw new Error("delivery state boom");
    });

    const controller = createLifecycleController({
      entry,
      persist,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
      warn,
    });

    await expect(
      controller.finalizeResumedAnnounceGiveUp({
        runId: entry.runId,
        entry,
        reason: "retry-limit",
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const [warning, warningFields] = firstCall(warn);
    expect(warning).toBe("failed to update subagent background task delivery state");
    expectFields(warningFields, {
      error: { name: "Error", message: "delivery state boom" },
      runId: "***",
      childSessionKey: "agent:main:…",
      deliveryStatus: "failed",
    });
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(persist).toHaveBeenCalled();
  });

  it("cleans up tracked browser sessions before subagent cleanup flow", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    const browserCleanupArg = firstCallArg(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    );
    expectFields(browserCleanupArg, { sessionKeys: [entry.childSessionKey] });
    expect(browserCleanupArg.onWarn).toBeTypeOf("function");
    expectFields(firstCallArg(runSubagentAnnounceFlow), {
      childSessionKey: entry.childSessionKey,
    });
  });

  it("records completion announcement timestamps from transcript delivery", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const delivery: SubagentAnnounceDeliveryResult = {
      delivered: true,
      path: "steered",
      enqueuedAt: 4_100,
      deliveredAt: 12_300,
    };
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        announceParams.onDeliveryResult?.(delivery);
        return true;
      },
    );

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => expect(entry.delivery?.announcedAt).toBe(12_300));
    expect(entry.delivery?.enqueuedAt).toBe(4_100);
    expect(entry.delivery?.deliveredAt).toBe(12_300);
    expect(entry.delivery?.lastDropReason).toBeUndefined();
    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: entry.runId,
      deliveryStatus: "delivered",
    });
  });

  it("skips announce delivery when completion messages are disabled", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    const browserCleanupArg = firstCallArg(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    );
    expectFields(browserCleanupArg, { sessionKeys: [entry.childSessionKey] });
    expect(browserCleanupArg.onWarn).toBeTypeOf("function");
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(false);
    await vi.waitFor(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.delivery?.status).toBe("not_required");
    expect(entry.delivery?.announcedAt).toBeUndefined();
  });

  it("retains delete-mode child proof until the delivered parent wake is retired", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: true });
    const wait = {
      waitId: "parent-wait",
      parentRunId: "parent-run",
      parentSessionKey: entry.requesterSessionKey,
      expectedChildRunIds: [entry.runId],
      childSessionKeys: [entry.childSessionKey],
      waitStartedAt: 1_000,
      staleAt: 2_000,
      continuationScheduledAt: 3_000,
      status: "continuation_scheduled" as const,
      requiredCloseout: true,
    };
    entry.parentYieldWait = wait;
    const runs = new Map([[entry.runId, entry]]);
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const controller = createLifecycleController({ entry, runs, runSubagentAnnounceFlow });
    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await vi.waitFor(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(runs.has(entry.runId)).toBe(true);
    expect(entry.completion?.resultText).toBe("final completion reply");
    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({ cleanup: "keep" }),
    );
    expect(helperMocks.safeRemoveAttachmentsDir).not.toHaveBeenCalled();
    entry.parentYieldWait = {
      ...wait,
      status: "closeout_delivered",
      closeout: {
        parentRunId: "parent-run",
        deliveryRecordId: "final",
        deliveryIdempotencyKey: "final-key",
        deliveryRegistryPath: "/isolated/delivery.json",
        deliveredAt: 5_000,
      },
    };
    enqueueSystemEvent("Resume parent", {
      sessionKey: wait.parentSessionKey,
      parentYieldWait: { waitId: wait.waitId, parentRunId: wait.parentRunId },
    });
    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "delete",
      completedAt: 5_000,
    });
    expect(runs.has(entry.runId)).toBe(true);
    expect(entry.completion?.resultText).toBe("final completion reply");
    drainSystemEventEntries(wait.parentSessionKey);
    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "delete",
      completedAt: 5_000,
    });
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("archives delete-mode sessions when completion messages are disabled", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      spawnMode: "session",
    });
    const runs = new Map([[entry.runId, entry]]);
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({
      entry,
      runs,
      persist,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
        method: "sessions.delete",
        params: {
          key: entry.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: true,
        },
        timeoutMs: 10_000,
      }),
    );
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(false);
    await vi.waitFor(() => expect(runs.has(entry.runId)).toBe(false));
    expect(entry.delivery?.announcedAt).toBeUndefined();
  });

  it("retires bundle MCP runtimes when run-mode cleanup completes", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      spawnMode: "run",
    });

    const controller = createLifecycleController({ entry });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    const retireArg = findCallArg(
      bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
      (arg) => arg.reason === "subagent-run-cleanup",
    );
    expectFields(retireArg, {
      sessionKey: entry.childSessionKey,
      reason: "subagent-run-cleanup",
    });
    expect(retireArg.onError).toBeTypeOf("function");
  });

  it("keeps bundle MCP runtimes warm for persistent session-mode cleanup", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      spawnMode: "session",
    });

    const controller = createLifecycleController({ entry });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("enriches registered-run outcomes with persisted timing before cleanup", async () => {
    const persist = vi.fn();
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const entry = createRunEntry({
      startedAt: 2_000,
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_250,
        outcome: { status: "timeout" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    const enrichedOutcome = {
      status: "timeout" as const,
      startedAt: 2_000,
      endedAt: 4_250,
      elapsedMs: 2_250,
    };
    expect(entry.outcome).toEqual(enrichedOutcome);
    expectFields(firstCallArg(taskExecutorMocks.failTaskRunByRunId), { status: "timed_out" });
    expectFields(firstCallArg(runSubagentAnnounceFlow), {
      startedAt: 2_000,
      endedAt: 4_250,
      outcome: enrichedOutcome,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("persists timing when a preexisting outcome matches without timing", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      startedAt: 2_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: false,
    });

    const controller = createLifecycleController({ entry, persist });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_250,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(entry.outcome).toEqual({
      status: "ok",
      startedAt: 2_000,
      endedAt: 4_250,
      elapsedMs: 2_250,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("does not wait for a completion reply when the run does not expect one", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      runSubagentAnnounceFlow: vi.fn(async () => false),
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(captureSubagentCompletionReply).toHaveBeenCalledWith(entry.childSessionKey, {
      waitForReply: false,
      outcome: {
        status: "ok",
        startedAt: 2_000,
        endedAt: 4_000,
        elapsedMs: 2_000,
      },
    });
  });

  it("does not freeze stale reply text for terminal error outcomes", async () => {
    const persist = vi.fn();
    const captureSubagentCompletionReply = vi.fn(async () => "stale assistant text");
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({
      entry,
      persist,
      captureSubagentCompletionReply,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "error", error: "All models failed (2): timeout" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(entry.completion?.resultText).toBeNull();
    expectFields(firstCallArg(taskExecutorMocks.failTaskRunByRunId), {
      status: "failed",
      error: "All models failed (2): timeout",
      progressSummary: undefined,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("does not re-run announce flow after completion was already delivered", async () => {
    const entry = createRunEntry({
      delivery: { status: "delivered", announcedAt: 3_500, deliveredAt: 3_500 },
      endedAt: 4_000,
    });
    const persist = vi.fn();
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});

    const controller = createLifecycleController({
      entry,
      persist,
      notifyContextEngineSubagentEnded,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(typeof entry.cleanupCompletedAt).toBe("number");
    expect(entry.cleanupCompletedAt).toBeGreaterThanOrEqual(4_000);
    expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith({
      childSessionKey: entry.childSessionKey,
      reason: "completed",
      workspaceDir: entry.workspaceDir,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("emits ended hook while retrying cleanup after completion was already delivered", async () => {
    const entry = createRunEntry({
      delivery: { status: "delivered", announcedAt: 3_500, deliveredAt: 3_500 },
      endedAt: 4_000,
      expectsCompletionMessage: true,
    });
    const emitSubagentEndedHookForRun = vi.fn(async () => {});

    const controller = createLifecycleController({
      entry,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(emitSubagentEndedHookForRun).toHaveBeenCalledTimes(1);
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledWith({
      entry,
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
    });
  });

  it("produces valid cleanupCompletedAt on give-up path when completionAnnouncedAt is undefined", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });

    const controller = createLifecycleController({
      entry,
      persist,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
    });

    expect(entry.delivery?.announcedAt).toBeUndefined();

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "retry-limit",
    });

    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(Number.isNaN(entry.cleanupCompletedAt)).toBe(false);
  });

  it("suspends successful keep-mode final delivery instead of completing cleanup on retry exhaustion", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "final answer" },
      delivery: { status: "pending", lastError: "gateway request timeout for agent" },
      outcome: { status: "ok" },
      retainAttachmentsOnKeep: true,
    });

    const controller = createLifecycleController({
      entry,
      persist,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
    });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "retry-limit",
    });

    expect(entry.delivery?.status).toBe("suspended");
    expect(entry.delivery?.payload).toMatchObject({
      requesterSessionKey: entry.requesterSessionKey,
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      frozenResultText: "final answer",
    });
    expect(entry.delivery?.suspendedAt).toBeTypeOf("number");
    expect(entry.delivery?.suspendedReason).toBe("retry-limit");
    expect(entry.cleanupHandled).toBe(false);
    expect(entry.cleanupCompletedAt).toBeUndefined();
    expect(helperMocks.safeRemoveAttachmentsDir).not.toHaveBeenCalled();
    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      deliveryStatus: "failed",
      error: "gateway request timeout for agent",
    });
    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary: "final answer",
      terminalOutcome: "succeeded",
      terminalSummary:
        "Required completion delivery failed before reaching the requester: gateway request timeout for agent.",
    });
    expect(persist).toHaveBeenCalled();
  });

  it.each([
    {
      name: "timeout",
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout" as const },
    },
    {
      name: "error",
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error" as const, error: "child failed" },
    },
    {
      name: "killed",
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: undefined,
    },
  ])(
    "keeps $name completion cleanup terminal on retry exhaustion",
    async ({ endedReason, outcome }) => {
      const persist = vi.fn();
      const entry = createRunEntry({
        endedAt: 4_000,
        endedReason,
        expectsCompletionMessage: true,
        delivery: { status: "pending", lastError: "gateway request timeout for agent" },
        outcome,
        retainAttachmentsOnKeep: true,
      });

      const controller = createLifecycleController({
        entry,
        persist,
        captureSubagentCompletionReply: vi.fn(async () => undefined),
      });

      await controller.finalizeResumedAnnounceGiveUp({
        runId: entry.runId,
        entry,
        reason: "retry-limit",
      });

      expect(entry.delivery?.payload).toBeUndefined();
      expect(entry.delivery?.suspendedAt).toBeUndefined();
      expect(entry.delivery?.suspendedReason).toBeUndefined();
      expect(entry.cleanupCompletedAt).toBeTypeOf("number");
      expect(persist).toHaveBeenCalled();
    },
  );

  it("continues cleanup when delivery-status persistence throws after announce delivery", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: false,
    });
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockImplementation(() => {
      throw new Error("delivery status boom");
    });

    const controller = createLifecycleController({
      entry,
      persist,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
      warn,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const [warning, warningFields] = firstCall(warn);
    expect(warning).toBe("failed to update subagent background task delivery state");
    expectFields(warningFields, {
      error: { name: "Error", message: "delivery status boom" },
      deliveryStatus: "delivered",
    });
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledTimes(1);
    expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledTimes(1);
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(persist).toHaveBeenCalled();
  });

  it("persists the concrete announce delivery error when cleanup gives up", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    const runSubagentAnnounceFlow = vi.fn(
      async (announceParams: {
        onDeliveryResult?: (delivery: {
          delivered: false;
          path: "direct";
          error: string;
          phases: Array<{
            phase: "direct-primary" | "steer-fallback";
            delivered: boolean;
            path: "direct" | "none";
            error?: string;
          }>;
        }) => void;
      }) => {
        announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: "UNAVAILABLE: requester wake failed",
          phases: [
            {
              phase: "direct-primary",
              delivered: false,
              path: "direct",
              error: "UNAVAILABLE: requester wake failed",
            },
            {
              phase: "steer-fallback",
              delivered: false,
              path: "none",
            },
          ],
        });
        return false;
      },
    );

    const controller = createLifecycleController({
      entry,
      persist,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      deliveryStatus: "failed",
      error:
        "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
    });
    expect(entry.delivery?.lastError).toBe(
      "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
    );
    expect(entry.delivery?.status).toBe("suspended");
    expect(entry.delivery?.payload).toMatchObject({
      requesterSessionKey: entry.requesterSessionKey,
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    });
    expect(entry.delivery?.suspendedAt).toBeTypeOf("number");
    expect(entry.delivery?.suspendedReason).toBe("retry-limit");
    expect(entry.cleanupCompletedAt).toBeUndefined();
    expectFields(
      findCallArg(
        taskExecutorMocks.completeTaskRunByRunId,
        (arg) =>
          arg.terminalSummary ===
          "Required completion delivery failed before reaching the requester: UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed.",
      ),
      {
        runId: entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        terminalOutcome: "succeeded",
        terminalSummary:
          "Required completion delivery failed before reaching the requester: UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed.",
      },
    );
    expect(persist).toHaveBeenCalled();
  });

  it("credits only current-run requester delivery mirrors before retrying NO_REPLY", async () => {
    const entry = await runNoReplyMirrorScenario({ timestamp: 12_345 });

    await vi.waitFor(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: entry.requesterSessionKey, limit: 25, maxChars: 128 * 1024 },
      timeoutMs: 5_000,
    });
    expect(entry.delivery?.deliveredAt).toBe(12_345);
    expect(entry.delivery?.announcedAt).toBe(12_345);
    expect(entry.delivery?.lastError).toBeUndefined();
    expect(entry.delivery?.payload).toBeUndefined();
    expect(entry.delivery?.attemptCount).toBeUndefined();
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(true);
    expect(helperMocks.logAnnounceGiveUp).not.toHaveBeenCalled();

    vi.clearAllMocks();
    gatewayMocks.callGateway.mockResolvedValue({});
    const longMirrorEntry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      text: "long completion reply ".repeat(500),
    });

    await vi.waitFor(() => expect(longMirrorEntry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(longMirrorEntry.delivery?.deliveredAt).toBe(12_345);
    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: longMirrorEntry.requesterSessionKey, limit: 25, maxChars: 128 * 1024 },
      timeoutMs: 5_000,
    });

    vi.clearAllMocks();
    gatewayMocks.callGateway.mockResolvedValue({});
    const messageToolAnnounceEntry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      idempotencyKeyForEntry: (candidate) =>
        `${buildExpectedAnnounceIdempotencyKey(candidate)}:message-tool:internal-source-reply:0`,
    });

    await vi.waitFor(() =>
      expect(messageToolAnnounceEntry.cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(messageToolAnnounceEntry.delivery?.deliveredAt).toBe(12_345);

    vi.clearAllMocks();
    gatewayMocks.callGateway.mockResolvedValue({});
    const childRunMirrorEntry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      idempotencyKeyForEntry: (candidate) => `${candidate.runId}:message-tool:1`,
    });

    await vi.waitFor(() => expect(childRunMirrorEntry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(childRunMirrorEntry.delivery?.deliveredAt).toBe(12_345);

    vi.clearAllMocks();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({});
    const staleEntry = await runNoReplyMirrorScenario({ timestamp: 1_999 });

    await vi.waitFor(() => expect(staleEntry.delivery?.suspendedAt).toBeTypeOf("number"));
    expect(staleEntry.delivery?.deliveredAt).toBeUndefined();
    expect(staleEntry.delivery?.announcedAt).toBeUndefined();
    expect(staleEntry.delivery?.lastError).toBe("completion agent did not produce a visible reply");
    expect(hasDeliveredTaskStatusUpdate(staleEntry.runId)).toBe(false);
    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: staleEntry.runId,
      runtime: "subagent",
      sessionKey: staleEntry.childSessionKey,
      deliveryStatus: "failed",
      error: "completion agent did not produce a visible reply",
    });
    expect(helperMocks.logAnnounceGiveUp).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: staleEntry.runId,
        requesterSessionKey: staleEntry.requesterSessionKey,
      }),
      "retry-limit",
    );

    vi.clearAllMocks();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({});
    const sameWindowSiblingEntry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      idempotencyKey: `${buildAnnounceIdempotencyKey(
        buildAnnounceIdFromChildRun({
          childSessionKey: "agent:main:subagent:sibling",
          childRunId: "run-sibling",
        }),
      )}:internal-source-reply:0`,
    });

    await vi.waitFor(() =>
      expect(sameWindowSiblingEntry.delivery?.suspendedAt).toBeTypeOf("number"),
    );
    expect(sameWindowSiblingEntry.delivery?.deliveredAt).toBeUndefined();
    expect(sameWindowSiblingEntry.delivery?.announcedAt).toBeUndefined();
    expect(sameWindowSiblingEntry.delivery?.lastError).toBe(
      "completion agent did not produce a visible reply",
    );
    expect(hasDeliveredTaskStatusUpdate(sameWindowSiblingEntry.runId)).toBe(false);
  });

  it("skips browser cleanup when steer restart suppresses cleanup flow", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({
      entry,
      suppressAnnounceForSteerRestart: () => true,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("dedupes browser cleanup when two callers complete the same run in parallel", async () => {
    // registerSubagentRun fires both an in-process listener (phase='end') and a
    // gateway waitForSubagentCompletion RPC; in embedded mode both resolve to
    // the same runId and call completeSubagentRun. Without a per-entry dispatch
    // guard, cleanupBrowserSessionsForLifecycleEnd fires once per caller,
    // duplicating browser driver tab-close IPC.
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
    });

    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    };

    await Promise.all([
      controller.completeSubagentRun(completeParams),
      controller.completeSubagentRun(completeParams),
    ]);

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).toHaveBeenCalledTimes(1);
    expect(entry.browserCleanupDispatchedAt).toBeTypeOf("number");
  });

  it("drains the retire + announce tail for a duplicate completion held behind a slow first browser cleanup", async () => {
    // The dispatch flag dedupes only the browser tab-close IPC. A duplicate
    // completion caller must still reach retireRunModeBundleMcpRuntime and
    // startSubagentAnnounceCleanupFlow while the first caller's cleanup
    // promise is still pending, so a slow browser driver cannot strand
    // completion delivery behind it.
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    let releaseFirstCleanup: (() => void) | undefined;
    let firstCleanupEntered: (() => void) | undefined;
    const firstCleanupEnteredPromise = new Promise<void>((resolve) => {
      firstCleanupEntered = resolve;
    });
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      () => {
        firstCleanupEntered?.();
        return new Promise<void>((resolve) => {
          releaseFirstCleanup = resolve;
        });
      },
    );

    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    };

    // First caller takes the dispatch flag and parks inside the cleanup wrapper.
    const firstCompletion = controller.completeSubagentRun(completeParams);
    await firstCleanupEnteredPromise;

    // Second caller observes the flag set, skips the cleanup wrapper, and must
    // still drain the retire + announce tail without waiting on the first
    // caller's still-pending cleanup.
    await controller.completeSubagentRun(completeParams);

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).toHaveBeenCalledTimes(1);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).toHaveBeenCalled();

    // Release the held first cleanup so the first caller can settle too.
    releaseFirstCleanup?.();
    await expect(firstCompletion).resolves.toBeUndefined();
  });

  it("materializes a Grant retirement request artifact from the canonical template", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-retirement-helper-"));
    await fs.mkdir(path.join(workspaceDir, "docs", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "contracts", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "templates", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "var", "grant"), { recursive: true });
    const proofPath = path.join(workspaceDir, "proof.txt");
    await fs.writeFile(proofPath, "proof", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
      [
        "# Grant Doctrine",
        "",
        "Grant hardening v1 may be called closed only for the current scoped hardening build.",
        "Grant remains a bounded governed execution owner under Will.",
        "Will remains the packet-sharpening and top command layer.",
        "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
        "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
      [
        "# Grant Corrections Matrix",
        "",
        "## Active corrections",
        "",
        "<!-- grant-generated-correction:rejected_proof_missing -->",
        "",
        "### GC-006: Do not cite proof that is not materially there",
        "",
        "- Trigger:",
        "  - Grant cites proof paths that are missing, unreadable, or not concretely named",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "contracts", "grant", "grant_hardening_operating_contract.json"),
      JSON.stringify(
        {
          boundary_lock: {
            scoped_closeout_rule:
              "Grant hardening v1 may be called closed only for the current scoped hardening build.",
            owner_rule: "Grant remains a bounded governed execution owner under Will.",
            command_rule: "Will remains the packet-sharpening and top command layer.",
            ambiguity_rule:
              "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
            promotion_rule:
              "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(
        workspaceDir,
        "templates",
        "grant",
        "grant_correction_retirement_request_template.json",
      ),
      JSON.stringify(
        {
          schema_version: "0.1.0",
          artifact_type: "grant_correction_retirement_request",
          requestedBy: "Will",
          approvedBy: "Will",
          outcomeCode: "",
          reason: "obsolete_rule",
          evidence: "",
          resolutionProofPaths: [],
          notes: "",
          requestedAt: "",
          approvedAt: "",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "var", "grant", "grant_correction_retirements.jsonl"),
      `${JSON.stringify({
        queuedAt: "2026-06-06T05:02:00.000Z",
        requestedBy: "Will",
        approvedBy: "Will",
        outcomeCode: "rejected_proof_missing",
        reason: "capability_materially_fixed",
        evidence: "Runtime gate now has stronger proof handling.",
        resolutionProofPaths: [proofPath],
        notes: "generated during test",
      })}\n`,
      "utf8",
    );
    const entry = createRunEntry({
      label: "Grant - retirement helper",
      task: "execution owner: Grant",
      workspaceDir,
    });
    const completionText = [
      "Run label: Grant - retirement helper",
      "Target handled: retire generated correction",
      `Artifact path(s): ${path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md")}`,
      `Proof path(s): ${proofPath}`,
      "What is materially real now: the retirement helper path is active",
      "What is still not real yet: broader end-to-end proof",
      "Who lawfully owns the next step: Will",
      "Open/closed truth: owner execution in progress, build still open.",
      "Exact next action: continue hardening",
    ].join("\n");
    const controller = createLifecycleController({ entry });
    await controller.testing.persistGrantCloseoutGateAudit({
      entry,
      result: {
        assessment: {
          applies: true,
          passed: true,
          outcomeCode: "accepted_closeout_fields_present",
          missingFields: [],
          missingProofPaths: [],
        },
        findings: completionText,
        rawFindings: completionText,
        taskLabel: "Grant - retirement helper",
        statusLabel: "passed",
      },
    });

    const requestDir = path.join(workspaceDir, "var", "grant", "retirement_requests");
    await vi.waitFor(async () => {
      const matrixAfter = await fs.readFile(
        path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
        "utf8",
      );
      expect(matrixAfter).not.toContain("grant-generated-correction:rejected_proof_missing");
    });
    const requestDirEntries = await vi.waitFor(async () => {
      const entries = await fs.readdir(requestDir);
      expect(entries).toHaveLength(1);
      return entries;
    });
    const requestArtifact = JSON.parse(
      await fs.readFile(path.join(requestDir, requestDirEntries[0] ?? ""), "utf8"),
    ) as Record<string, unknown>;
    expect(requestArtifact.artifact_type).toBe("grant_correction_retirement_request");
    expect(requestArtifact.outcomeCode).toBe("rejected_proof_missing");
    expect(requestArtifact.reason).toBe("capability_materially_fixed");
    expect(requestArtifact.grantRulebook).toMatchObject({
      doctrinePath: path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
      correctionsPath: path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
    });

    const archiveRaw = await fs.readFile(
      path.join(workspaceDir, "var", "grant", "grant_correction_retirements.archive.jsonl"),
      "utf8",
    );
    expect(archiveRaw).toContain('"archiveReason":"retired_from_corrections_matrix"');
    expect(archiveRaw).toContain('"requestPath"');
  });

  it("fails closed when retirement request materialization cannot load the canonical template", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "grant-retirement-helper-missing-"),
    );
    await fs.mkdir(path.join(workspaceDir, "docs", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "contracts", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "var", "grant"), { recursive: true });
    const proofPath = path.join(workspaceDir, "proof.txt");
    await fs.writeFile(proofPath, "proof", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
      [
        "# Grant Doctrine",
        "",
        "Grant hardening v1 may be called closed only for the current scoped hardening build.",
        "Grant remains a bounded governed execution owner under Will.",
        "Will remains the packet-sharpening and top command layer.",
        "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
        "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
      [
        "# Grant Corrections Matrix",
        "",
        "## Active corrections",
        "",
        "<!-- grant-generated-correction:rejected_proof_missing -->",
        "",
        "### GC-006: Do not cite proof that is not materially there",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "contracts", "grant", "grant_hardening_operating_contract.json"),
      JSON.stringify(
        {
          boundary_lock: {
            scoped_closeout_rule:
              "Grant hardening v1 may be called closed only for the current scoped hardening build.",
            owner_rule: "Grant remains a bounded governed execution owner under Will.",
            command_rule: "Will remains the packet-sharpening and top command layer.",
            ambiguity_rule:
              "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
            promotion_rule:
              "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "var", "grant", "grant_correction_retirements.jsonl"),
      `${JSON.stringify({
        queuedAt: "2026-06-06T05:02:00.000Z",
        requestedBy: "Will",
        approvedBy: "Will",
        outcomeCode: "rejected_proof_missing",
        reason: "capability_materially_fixed",
        evidence: "Runtime gate now has stronger proof handling.",
        resolutionProofPaths: [proofPath],
      })}\n`,
      "utf8",
    );
    const entry = createRunEntry({
      label: "Grant - retirement helper missing template",
      task: "execution owner: Grant",
      workspaceDir,
    });
    const completionText = [
      "Run label: Grant - retirement helper missing template",
      "Target handled: retire generated correction",
      `Artifact path(s): ${path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md")}`,
      `Proof path(s): ${proofPath}`,
      "What is materially real now: the runtime evaluated the retirement queue",
      "What is still not real yet: the canonical template file is missing",
      "Who lawfully owns the next step: Will",
      "Open/closed truth: owner execution in progress, build still open.",
      "Exact next action: restore the template",
    ].join("\n");
    const controller = createLifecycleController({ entry });
    await controller.testing.persistGrantCloseoutGateAudit({
      entry,
      result: {
        assessment: {
          applies: true,
          passed: true,
          outcomeCode: "accepted_closeout_fields_present",
          missingFields: [],
          missingProofPaths: [],
        },
        findings: completionText,
        rawFindings: completionText,
        taskLabel: "Grant - retirement helper missing template",
        statusLabel: "passed",
      },
    });

    await vi.waitFor(async () => {
      const matrixAfter = await fs.readFile(
        path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
        "utf8",
      );
      expect(matrixAfter).toContain("grant-generated-correction:rejected_proof_missing");
    });

    const rejectedArchiveRaw = await vi.waitFor(
      async () =>
        await fs.readFile(
          path.join(workspaceDir, "var", "grant", "grant_correction_retirements.rejected.jsonl"),
          "utf8",
        ),
    );
    expect(rejectedArchiveRaw).toContain("retirement request template missing or unreadable");
  });

  it("fails closed when the lifecycle helper path sees a stale Grant doctrine without the boundary rule", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-retirement-helper-stale-"));
    await fs.mkdir(path.join(workspaceDir, "docs", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "contracts", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "templates", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "var", "grant"), { recursive: true });
    const proofPath = path.join(workspaceDir, "proof.txt");
    await fs.writeFile(proofPath, "proof", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
      "# Grant Doctrine\nOld doctrine body only.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
      [
        "# Grant Corrections Matrix",
        "",
        "## Active corrections",
        "",
        "<!-- grant-generated-correction:rejected_proof_missing -->",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "contracts", "grant", "grant_hardening_operating_contract.json"),
      JSON.stringify(
        {
          boundary_lock: {
            scoped_closeout_rule:
              "Grant hardening v1 may be called closed only for the current scoped hardening build.",
            owner_rule: "Grant remains a bounded governed execution owner under Will.",
            command_rule: "Will remains the packet-sharpening and top command layer.",
            ambiguity_rule:
              "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
            promotion_rule:
              "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(
        workspaceDir,
        "templates",
        "grant",
        "grant_correction_retirement_request_template.json",
      ),
      JSON.stringify(
        {
          schema_version: "0.1.0",
          artifact_type: "grant_correction_retirement_request",
          requestedBy: "Will",
          approvedBy: "Will",
          outcomeCode: "",
          reason: "obsolete_rule",
          evidence: "",
          resolutionProofPaths: [],
          notes: "",
          requestedAt: "",
          approvedAt: "",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "var", "grant", "grant_correction_retirements.jsonl"),
      `${JSON.stringify({
        queuedAt: "2026-06-06T05:02:00.000Z",
        requestedBy: "Will",
        approvedBy: "Will",
        outcomeCode: "rejected_proof_missing",
        reason: "capability_materially_fixed",
        evidence: "Runtime gate now has stronger proof handling.",
        resolutionProofPaths: [proofPath],
      })}\n`,
      "utf8",
    );
    const entry = createRunEntry({
      label: "Grant - stale doctrine helper",
      task: "execution owner: Grant",
      workspaceDir,
    });
    const completionText = [
      "Run label: Grant - stale doctrine helper",
      "Target handled: retire generated correction",
      `Artifact path(s): ${path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md")}`,
      `Proof path(s): ${proofPath}`,
      "What is materially real now: the runtime evaluated the retirement queue",
      "What is still not real yet: the doctrine boundary lock is stale",
      "Who lawfully owns the next step: Will",
      "Open/closed truth: owner execution in progress, build still open.",
      "Exact next action: restore the Grant doctrine boundary lock",
    ].join("\n");
    const controller = createLifecycleController({ entry });
    await controller.testing.persistGrantCloseoutGateAudit({
      entry,
      result: {
        assessment: {
          applies: true,
          passed: true,
          outcomeCode: "accepted_closeout_fields_present",
          missingFields: [],
          missingProofPaths: [],
        },
        findings: completionText,
        rawFindings: completionText,
        taskLabel: "Grant - stale doctrine helper",
        statusLabel: "passed",
      },
    });

    const rejectedArchiveRaw = await vi.waitFor(
      async () =>
        await fs.readFile(
          path.join(workspaceDir, "var", "grant", "grant_correction_retirements.rejected.jsonl"),
          "utf8",
        ),
    );
    expect(rejectedArchiveRaw).toContain("Grant doctrine missing required boundary rule");
  });

  it("does not queue a duplicate Grant correction candidate when that generated correction is already active", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-correction-dedupe-"));
    await fs.mkdir(path.join(workspaceDir, "docs", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "var", "grant"), { recursive: true });
    const proofPath = path.join(workspaceDir, "proof.txt");
    await fs.writeFile(proofPath, "proof", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
      [
        "# Grant Corrections Matrix",
        "",
        "## Active corrections",
        "",
        "<!-- grant-generated-correction:rejected_proof_missing -->",
        "",
        "### GC-006: Do not cite proof that is not materially there",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceDir, "var", "grant", "audits"), { recursive: true });
    await fs.writeFile(
      path.join(
        workspaceDir,
        "var",
        "grant",
        "audits",
        "2026-06-10T000000Z_prior-grant-audit_run-old.md",
      ),
      [
        "# Grant After-Action Audit",
        "",
        "[Grant Closeout Gate Result] rejected_proof_missing",
      ].join("\n"),
      "utf8",
    );

    const entry = createRunEntry({
      label: "Grant - duplicate correction guard",
      task: "execution owner: Grant",
      workspaceDir,
    });
    const completionText = [
      "Run label: Grant - duplicate correction guard",
      "Target handled: do not queue duplicate Grant correction candidates",
      `Artifact path(s): ${path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md")}`,
      `Proof path(s): ${proofPath}`,
      "What is materially real now: the Grant gate failure was captured",
      "What is still not real yet: broader live proof",
      "Who lawfully owns the next step: Will",
      "Open/closed truth: owner execution in progress, build still open.",
      "Exact next action: keep the active correction and avoid duplicate queue churn",
    ].join("\n");
    const controller = createLifecycleController({ entry });

    await controller.testing.persistGrantCloseoutGateAudit({
      entry,
      result: {
        assessment: {
          applies: true,
          passed: false,
          outcomeCode: "rejected_proof_missing",
          missingFields: [],
          missingProofPaths: ["no readable proof path found"],
        },
        findings: completionText,
        rawFindings: completionText,
        taskLabel: "Grant - duplicate correction guard",
        statusLabel: "failed",
      },
    });

    await vi.waitFor(async () => {
      const auditPath = entry.completion?.grantCloseoutGate?.auditReceiptPath;
      expect(auditPath).toBeTruthy();
      const raw = await fs.readFile(auditPath!, "utf8");
      expect(raw).toContain("- none");
      expect(raw).toContain("- candidate label: n/a");
      expect(raw).toContain("- audit note only");
    });

    await expect(
      fs.readFile(
        path.join(workspaceDir, "var", "grant", "grant_correction_candidates.jsonl"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("retires a generated correction from a real operator-created retirement request", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-retirement-end-to-end-"));
    await fs.mkdir(path.join(workspaceDir, "docs", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "contracts", "grant"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "templates", "grant"), { recursive: true });
    const proofPath = path.join(workspaceDir, "proof.txt");
    await fs.writeFile(proofPath, "proof", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
      [
        "# Grant Doctrine",
        "",
        "Grant hardening v1 may be called closed only for the current scoped hardening build.",
        "Grant remains a bounded governed execution owner under Will.",
        "Will remains the packet-sharpening and top command layer.",
        "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
        "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
      [
        "# Grant Corrections Matrix",
        "",
        "## Active corrections",
        "",
        "<!-- grant-generated-correction:rejected_proof_missing -->",
        "",
        "### GC-006: Do not cite proof that is not materially there",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "contracts", "grant", "grant_hardening_operating_contract.json"),
      JSON.stringify(
        {
          boundary_lock: {
            scoped_closeout_rule:
              "Grant hardening v1 may be called closed only for the current scoped hardening build.",
            owner_rule: "Grant remains a bounded governed execution owner under Will.",
            command_rule: "Will remains the packet-sharpening and top command layer.",
            ambiguity_rule:
              "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
            promotion_rule:
              "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(
        workspaceDir,
        "templates",
        "grant",
        "grant_correction_retirement_request_template.json",
      ),
      JSON.stringify(
        {
          schema_version: "0.1.0",
          artifact_type: "grant_correction_retirement_request",
          requestedBy: "Will",
          approvedBy: "Will",
          outcomeCode: "",
          reason: "obsolete_rule",
          evidence: "",
          resolutionProofPaths: [],
          notes: "",
          requestedAt: "",
          approvedAt: "",
        },
        null,
        2,
      ),
      "utf8",
    );

    const commandResult = spawnSync(
      process.execPath,
      [
        grantRetirementRequestScriptPath,
        "--workspace",
        workspaceDir,
        "--outcome-code",
        "rejected_proof_missing",
        "--reason",
        "capability_materially_fixed",
        "--evidence",
        "Integrated end-to-end retirement proof.",
        "--proof-path",
        proofPath,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(commandResult.status).toBe(0);
    const commandStdout = JSON.parse(commandResult.stdout) as {
      requestPath: string;
      queuePath: string;
    };
    expect(commandStdout.requestPath).toContain(path.join("var", "grant", "retirement_requests"));
    expect(commandStdout.queuePath).toContain(
      path.join("var", "grant", "grant_correction_retirements.jsonl"),
    );

    const entry = createRunEntry({
      label: "Grant - operator request end to end",
      task: "execution owner: Grant",
      workspaceDir,
    });
    const completionText = [
      "Run label: Grant - operator request end to end",
      "Target handled: retire generated correction via real operator command",
      `Artifact path(s): ${path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md")}`,
      `Proof path(s): ${proofPath}`,
      "What is materially real now: the operator command and runtime path both executed",
      "What is still not real yet: broader live runtime proof beyond focused tests",
      "Who lawfully owns the next step: Will",
      "Open/closed truth: owner execution in progress, build still open.",
      "Exact next action: continue hardening",
    ].join("\n");
    const controller = createLifecycleController({ entry });
    await controller.testing.persistGrantCloseoutGateAudit({
      entry,
      result: {
        assessment: {
          applies: true,
          passed: true,
          outcomeCode: "accepted_closeout_fields_present",
          missingFields: [],
          missingProofPaths: [],
        },
        findings: completionText,
        rawFindings: completionText,
        taskLabel: "Grant - operator request end to end",
        statusLabel: "passed",
      },
    });

    const matrixAfter = await fs.readFile(
      path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
      "utf8",
    );
    expect(matrixAfter).not.toContain("grant-generated-correction:rejected_proof_missing");

    const archiveRaw = await fs.readFile(
      path.join(workspaceDir, "var", "grant", "grant_correction_retirements.archive.jsonl"),
      "utf8",
    );
    expect(archiveRaw).toContain('"archiveReason":"retired_from_corrections_matrix"');
    expect(archiveRaw).toContain(commandStdout.requestPath);
  });

  it("forces Grant gate failures into blocked same-slice follow-up and flow rework state", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-closeout-flow-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = workspaceDir;
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const entry = createRunEntry({
        label: "Grant closeout continuity",
        task: "Grant blind-test slice continuity",
        workspaceDir,
      });
      const flow = requireCreatedFlow(
        createBlindTestSliceFlow({
          ownerKey: entry.requesterSessionKey,
          goal: "Grant blind-test slice continuity",
          sliceKey: "grant-slice-9",
          subjectAgent: "Grant",
          continuation: {
            activeProductionRun: true,
            parentRunOpen: true,
          },
        }),
      );
      createTaskRecord({
        runtime: "subagent",
        ownerKey: entry.requesterSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        scopeKind: "session",
        childSessionKey: entry.childSessionKey,
        parentFlowId: flow.flowId,
        runId: entry.runId,
        task: "Grant slice closeout",
        missionId: "mission-grant-slice-9",
        missionSummary: "Correct the same Grant blind-test slice 9 closeout",
        missionState: "active",
        status: "succeeded",
        deliveryStatus: "pending",
      });
      const controller = createLifecycleController({
        entry,
        callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
          ({ runId: "run-grant-slice-9-rework" }) as T,
      });
      const completionText = [
        "Run label: Grant closeout continuity",
        "What is materially real now: slice output exists",
        "What is still not real yet: proof packet is not readable",
        "Who lawfully owns the next step: Will",
        "Open/closed truth: owner execution in progress, build still open.",
        "Exact next action: retry the same slice with readable proof",
      ].join("\n");

      await controller.testing.persistGrantCloseoutGateAudit({
        entry,
        result: {
          assessment: {
            applies: true,
            passed: false,
            outcomeCode: "rejected_proof_missing",
            missingFields: [],
            missingProofPaths: ["no readable proof path found"],
          },
          findings: completionText,
          rawFindings: completionText,
          taskLabel: entry.label ?? entry.runId,
          statusLabel: "completed",
        },
      });

      expectFields(
        findCallArg(
          taskExecutorMocks.completeTaskRunByRunId,
          (arg) => arg.runId === entry.runId && arg.terminalOutcome === "blocked",
        ),
        {
          runId: entry.runId,
          runtime: "subagent",
          sessionKey: entry.childSessionKey,
          terminalOutcome: "blocked",
        },
      );
      const updatedFlow = getTaskFlowById(flow.flowId);
      expect(updatedFlow?.currentStep).toBe("closeout_rework_running");
      expect(updatedFlow?.blockedSummary ?? null).toBeNull();
      expect(entry.productionContinuation).toMatchObject({
        activeProductionRun: true,
        parentFlowId: flow.flowId,
        nextExecutableUnitIdentified: true,
        nextExecutableUnitLaunched: true,
      });
      expect(findLatestTaskForSessionKey(entry.childSessionKey)).toMatchObject({
        task: "Grant slice closeout rework",
        missionId: "mission-grant-slice-9",
        missionState: "active",
        runId: "run-grant-slice-9-rework",
        status: "running",
      });
      expect(
        listTaskAuditFindings({
          now: Date.now(),
          tasks: [findLatestTaskForSessionKey(entry.childSessionKey)!],
        }).map((finding) => finding.code),
      ).not.toContain("rework_follow_through_violation");
      expect(
        listTaskFlowAuditFindings({ now: Date.now() }).some(
          (finding) =>
            finding.code === "continuation_required_not_launched" &&
            finding.flow?.flowId === flow.flowId,
        ),
      ).toBe(false);
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("persists Continuity Gate continuation artifacts for mechanical Grant proof failures", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-continuity-mechanical-"));
    try {
      const entry = createRunEntry({
        label: "Grant closeout continuity mechanical",
        task: "Grant closeout proof repair",
        workspaceDir,
      });
      const controller = createLifecycleController({ entry });
      const findings =
        "Run label: Grant closeout continuity mechanical\nWhat is materially real now: slice output exists\nWhat is still not real yet: proof packet is not readable\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: retry the same slice with readable proof";

      await controller.testing.persistGrantCloseoutGateAudit({
        entry,
        result: {
          assessment: {
            applies: true,
            passed: false,
            outcomeCode: "rejected_proof_missing",
            missingFields: [],
            missingProofPaths: ["no readable proof path found"],
          },
          findings,
          rawFindings: findings,
          taskLabel: entry.label ?? entry.runId,
          statusLabel: "completed",
        },
      });

      const outputDir = path.join(workspaceDir, "var", "continuity_gate_v2", "grant_closeout_gate");
      const decisionRecord = await readOnlyJsonArtifact<{
        selected_state: string;
        authority_resolution: { winner: string; winnerId: string };
        technical_vs_product: { lane: string };
      }>(outputDir, "cleanup_crew_decision_records");
      const continueReceipt = await readOnlyJsonArtifact<{
        selected_state: string;
        repair_action: string;
      }>(outputDir, "cleanup_crew_continue_receipts");
      const trace = await readOnlyJsonArtifact<{
        selected_state: string;
        owner_level_blocker_audit: string;
        grant_result: string;
        scope: { surfaces: string[]; records: string[] };
        proof_refs: string[];
      }>(outputDir, "cleanup_crew_diagnostic_traces");

      expect(decisionRecord).toMatchObject({
        selected_state: "CONTINUE_AFTER_REPAIRABLE_GRANT_REJECTION",
        authority_resolution: {
          winner: "active_mission_lock",
          winnerId: expect.stringMatching(/^grant_retry_/),
        },
        technical_vs_product: {
          lane: "technical",
        },
      });
      expect(continueReceipt).toMatchObject({
        selected_state: "CONTINUE_AFTER_REPAIRABLE_GRANT_REJECTION",
      });
      expect(continueReceipt.repair_action).toContain(
        "Grant closeout failed (rejected_proof_missing)",
      );
      expect(trace).toMatchObject({
        selected_state: "CONTINUE_AFTER_REPAIRABLE_GRANT_REJECTION",
        owner_level_blocker_audit: "grant_closeout_gate",
        grant_result: "continue_repair:MECHANICAL_PROOF_LINK:attempt_1_of_3",
        scope: {
          surfaces: ["subagent-registry-lifecycle:grant-closeout-gate"],
          records: expect.arrayContaining(["rejected_proof_missing"]),
        },
      });
      expect(trace.proof_refs).toContain("no readable proof path found");
      await expect(
        fs.readdir(path.join(outputDir, "cleanup_crew_stop_reports")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not persist Continuity Gate Grant artifacts for missing or unsafe workspace values", async () => {
    const relativeWorkspace = `relative-grant-continuity-${Date.now()}`;
    const unsafeCases: Array<{
      label: string;
      workspaceDir?: string;
      forbiddenArtifactDir: string;
    }> = [
      {
        label: "missing workspace",
        workspaceDir: undefined,
        forbiddenArtifactDir: path.join(
          process.cwd(),
          "var",
          "continuity_gate_v2",
          "grant_closeout_gate",
        ),
      },
      {
        label: "undefined workspace",
        workspaceDir: "undefined",
        forbiddenArtifactDir: path.join(
          process.cwd(),
          "undefined",
          "var",
          "continuity_gate_v2",
          "grant_closeout_gate",
        ),
      },
      {
        label: "relative workspace",
        workspaceDir: relativeWorkspace,
        forbiddenArtifactDir: path.join(
          process.cwd(),
          relativeWorkspace,
          "var",
          "continuity_gate_v2",
          "grant_closeout_gate",
        ),
      },
    ];

    for (const unsafeCase of unsafeCases) {
      const entry = createRunEntry({
        runId: `run-${unsafeCase.label.replace(/[^a-z]+/g, "-")}`,
        label: `Grant closeout ${unsafeCase.label}`,
        task: "Grant closeout unsafe workspace regression",
        workspaceDir: unsafeCase.workspaceDir,
      });
      const controller = createLifecycleController({ entry });

      await controller.testing.persistGrantCloseoutGateAudit({
        entry,
        result: {
          assessment: {
            applies: true,
            passed: false,
            outcomeCode: "rejected_proof_missing",
            missingFields: [],
            missingProofPaths: ["no readable proof path found"],
          },
          findings:
            "Run label: Grant closeout unsafe workspace\nWhat is materially real now: slice output exists\nWhat is still not real yet: proof packet is not readable\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: retry the same slice with readable proof",
          rawFindings:
            "Run label: Grant closeout unsafe workspace\nWhat is materially real now: slice output exists\nWhat is still not real yet: proof packet is not readable\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: retry the same slice with readable proof",
          taskLabel: entry.label ?? entry.runId,
          statusLabel: "completed",
        },
      });

      await expect(fs.stat(unsafeCase.forbiddenArtifactDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("does not advance Grant Continuity Gate retry attempts from unrelated same-outcome audits", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-continuity-retry-scope-"));
    try {
      const auditDir = path.join(workspaceDir, "var", "grant", "after_action_audits");
      await fs.mkdir(auditDir, { recursive: true });
      await fs.writeFile(
        path.join(auditDir, "unrelated_same_outcome.md"),
        [
          "# Grant After-Action Audit",
          "",
          "[Grant Closeout Gate Result] rejected_proof_missing",
          "",
          "This receipt belongs to an unrelated run and must not count against this retry surface.",
        ].join("\n"),
        "utf8",
      );

      const entry = createRunEntry({
        label: "Grant closeout retry scope",
        task: "Grant closeout retry surface scoping",
        workspaceDir,
      });
      const controller = createLifecycleController({ entry });
      const findings =
        "Run label: Grant closeout retry scope\nWhat is materially real now: slice output exists\nWhat is still not real yet: proof packet is not readable\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: retry the same slice with readable proof";

      await controller.testing.persistGrantCloseoutGateAudit({
        entry,
        result: {
          assessment: {
            applies: true,
            passed: false,
            outcomeCode: "rejected_proof_missing",
            missingFields: [],
            missingProofPaths: ["no readable proof path found"],
          },
          findings,
          rawFindings: findings,
          taskLabel: entry.label ?? entry.runId,
          statusLabel: "completed",
        },
      });

      const outputDir = path.join(workspaceDir, "var", "continuity_gate_v2", "grant_closeout_gate");
      const trace = await readOnlyJsonArtifact<{
        grant_result: string;
      }>(outputDir, "cleanup_crew_diagnostic_traces");

      expect(trace.grant_result).toBe("continue_repair:MECHANICAL_PROOF_LINK:attempt_1_of_3");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("persists Continuity Gate stop artifacts for semantic Grant safety failures", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-continuity-semantic-"));
    try {
      const entry = createRunEntry({
        label: "Grant closeout continuity semantic",
        task: "Grant semantic safety closeout",
        workspaceDir,
      });
      const controller = createLifecycleController({ entry });
      const findings =
        "Run label: Grant closeout continuity semantic\nWhat is materially real now: slice output is disputed\nWhat is still not real yet: safety truth is unresolved\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: stop and diagnose the semantic safety issue";

      await controller.testing.persistGrantCloseoutGateAudit({
        entry,
        result: {
          assessment: {
            applies: true,
            passed: false,
            outcomeCode: "rejected_semantic_safety",
            missingFields: [],
            missingProofPaths: [],
          },
          findings,
          rawFindings: findings,
          taskLabel: entry.label ?? entry.runId,
          statusLabel: "completed",
        },
      });

      const outputDir = path.join(workspaceDir, "var", "continuity_gate_v2", "grant_closeout_gate");
      const stopReport = await readOnlyJsonArtifact<{
        stop_state: string;
        plain_text_question: string;
      }>(outputDir, "cleanup_crew_stop_reports");
      const trace = await readOnlyJsonArtifact<{
        selected_state: string;
        grant_result: string;
        technical_vs_product: { lane: string };
      }>(outputDir, "cleanup_crew_diagnostic_traces");

      expect(stopReport).toMatchObject({
        stop_state: "STOP_TRUE_UNKNOWN_BLOCKER",
        plain_text_question: "No operator action requested unless a human decision is required.",
      });
      expect(trace).toMatchObject({
        selected_state: "STOP_TRUE_UNKNOWN_BLOCKER",
        grant_result: "stop_or_true_blocker:SEMANTIC_SAFETY:attempt_1_of_1",
        technical_vs_product: {
          lane: "true_unknown",
        },
      });
      await expect(
        fs.readdir(path.join(outputDir, "cleanup_crew_continue_receipts")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("records a lawful blocked closeout when same-slice rework cannot be relaunched", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-closeout-blocked-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = workspaceDir;
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const entry = createRunEntry({
        label: "Grant closeout blocked",
        task: "Grant blind-test slice blocked",
        workspaceDir,
      });
      const flow = requireCreatedFlow(
        createBlindTestSliceFlow({
          ownerKey: entry.requesterSessionKey,
          goal: "Grant blind-test slice blocked",
          sliceKey: "grant-slice-blocked",
          subjectAgent: "Grant",
          continuation: {
            activeProductionRun: true,
            parentRunOpen: true,
          },
        }),
      );
      createTaskRecord({
        runtime: "subagent",
        ownerKey: entry.requesterSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        scopeKind: "session",
        childSessionKey: entry.childSessionKey,
        parentFlowId: flow.flowId,
        runId: entry.runId,
        task: "Grant slice closeout",
        missionId: "mission-grant-slice-blocked",
        missionSummary: "Correct the same Grant blind-test slice blocked closeout",
        missionState: "active",
        status: "succeeded",
        deliveryStatus: "pending",
      });
      const controller = createLifecycleController({
        entry,
        callGateway: async <T = Record<string, unknown>>(): Promise<T> => ({}) as T,
      });

      await controller.testing.persistGrantCloseoutGateAudit({
        entry,
        result: {
          assessment: {
            applies: true,
            passed: false,
            outcomeCode: "rejected_proof_missing",
            missingFields: [],
            missingProofPaths: ["no readable proof path found"],
          },
          findings:
            "Run label: Grant closeout blocked\nWhat is materially real now: slice output exists\nWhat is still not real yet: proof packet is not readable\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: retry the same slice with readable proof",
          rawFindings:
            "Run label: Grant closeout blocked\nWhat is materially real now: slice output exists\nWhat is still not real yet: proof packet is not readable\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: retry the same slice with readable proof",
          taskLabel: entry.label ?? entry.runId,
          statusLabel: "completed",
        },
      });

      const blockedFlow = getTaskFlowById(flow.flowId);
      expect(blockedFlow?.currentStep).toBe("rework_launch_blocked");
      expect(blockedFlow?.blockedSummary).toContain("REWORK_FOLLOW_THROUGH_VIOLATION");
      expect(entry.productionContinuation).toMatchObject({
        activeProductionRun: true,
        lawfulStopReason: "blocker",
      });
      expect(findLatestTaskForSessionKey(entry.childSessionKey)?.status).not.toBe("running");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not create a rework launch requirement when the Grant closeout gate passes", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-closeout-pass-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = workspaceDir;
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const entry = createRunEntry({
        label: "Grant closeout passed",
        task: "Grant blind-test slice passed",
        workspaceDir,
      });
      const flow = requireCreatedFlow(
        createBlindTestSliceFlow({
          ownerKey: entry.requesterSessionKey,
          goal: "Grant blind-test slice passed",
          sliceKey: "grant-slice-passed",
          subjectAgent: "Grant",
          continuation: {
            activeProductionRun: true,
            parentRunOpen: true,
          },
        }),
      );
      createTaskRecord({
        runtime: "subagent",
        ownerKey: entry.requesterSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        scopeKind: "session",
        childSessionKey: entry.childSessionKey,
        parentFlowId: flow.flowId,
        runId: entry.runId,
        task: "Grant slice closeout",
        missionId: "mission-grant-slice-passed",
        missionSummary: "Pass the same Grant blind-test slice closeout",
        missionState: "active",
        status: "succeeded",
        deliveryStatus: "pending",
      });
      const controller = createLifecycleController({ entry });

      await controller.testing.persistGrantCloseoutGateAudit({
        entry,
        result: {
          assessment: {
            applies: true,
            passed: true,
            outcomeCode: "accepted_closeout_fields_present",
            missingFields: [],
            missingProofPaths: [],
          },
          findings:
            "Run label: Grant closeout passed\nWhat is materially real now: proof packet is readable\nWhat is still not real yet: broader build remains open\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: continue to the next lawful step",
          rawFindings:
            "Run label: Grant closeout passed\nWhat is materially real now: proof packet is readable\nWhat is still not real yet: broader build remains open\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: continue to the next lawful step",
          taskLabel: entry.label ?? entry.runId,
          statusLabel: "passed",
        },
      });

      expect(findLatestTaskForSessionKey(entry.childSessionKey)?.runId).toBe(entry.runId);
      expect(listTaskFlowAuditFindings({ now: Date.now() })).toStrictEqual([]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("mirrors generic managed production continuation proof into the persisted subagent record", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "grant-generic-continuation-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = workspaceDir;
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const entry = createRunEntry({
        label: "Grant managed continuation mirror",
        task: "Grant bounded managed controller",
        workspaceDir,
      });
      const flow = requireCreatedFlow(
        createManagedTaskFlow({
          ownerKey: entry.requesterSessionKey,
          controllerId: "tests/managed-flow",
          goal: "Mirror generic continuation proof",
          status: "running",
          continuation: {
            activeProductionRun: true,
            parentRunOpen: true,
            continuationRequiredAfterLocalSuccess: true,
            currentUnitStatus: "passed",
          },
        }),
      );
      createTaskRecord({
        runtime: "subagent",
        ownerKey: entry.requesterSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        scopeKind: "session",
        childSessionKey: entry.childSessionKey,
        parentFlowId: flow.flowId,
        runId: entry.runId,
        task: "Grant managed continuation closeout",
        missionId: "mission-managed-continuation",
        missionSummary: "Mirror generic continuation proof",
        missionState: "active",
        status: "succeeded",
        deliveryStatus: "pending",
      });
      const controller = createLifecycleController({ entry });

      await controller.testing.persistGrantCloseoutGateAudit({
        entry,
        result: {
          assessment: {
            applies: true,
            passed: true,
            missingFields: [],
            missingProofPaths: [],
          },
          findings:
            "Run label: Grant managed continuation mirror\nWhat is materially real now: proof mirrored\nWhat is still not real yet: broader build open\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: launch the next bounded unit.",
          rawFindings:
            "Run label: Grant managed continuation mirror\nWhat is materially real now: proof mirrored\nWhat is still not real yet: broader build open\nWho lawfully owns the next step: Will\nOpen/closed truth: owner execution in progress, build still open.\nExact next action: launch the next bounded unit.",
          taskLabel: entry.label ?? entry.runId,
          statusLabel: "passed",
        },
      });

      expect(entry.productionContinuation).toMatchObject({
        activeProductionRun: true,
        continuationRequiredAfterLocalSuccess: true,
        nextExecutableUnitLaunched: false,
        parentFlowId: flow.flowId,
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
});
