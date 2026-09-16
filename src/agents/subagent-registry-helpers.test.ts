import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainSystemEventEntries,
  enqueueSystemEvent,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";
import {
  logAnnounceGiveUp,
  reconcileOrphanedRun,
  resolveSubagentRunOrphanReason,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    retainAttachmentsOnKeep: true,
    createdAt: 500,
    startedAt: 1_000,
    ...overrides,
  };
}

describe("reconcileOrphanedRun", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetSystemEventsForTest();
  });

  it("keeps terminal parent proof through orphan recovery until its delivered wake is retired", () => {
    const entry = createRunEntry({ endedAt: 4_000, outcome: { status: "ok" } });
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
    const args = {
      runId: entry.runId,
      entry,
      reason: "missing-session-entry" as const,
      source: "restore" as const,
      runs,
      resumedRuns: new Set<string>(),
    };
    expect(resolveSubagentRunOrphanReason({ entry })).toBeNull();
    expect(reconcileOrphanedRun(args)).toBe(false);
    expect(runs.has(entry.runId)).toBe(true);
    expect(entry.outcome).toEqual({ status: "ok" });
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
    expect(resolveSubagentRunOrphanReason({ entry })).toBeNull();
    expect(reconcileOrphanedRun(args)).toBe(false);
    expect(runs.has(entry.runId)).toBe(true);
    expect(entry.outcome).toEqual({ status: "ok" });
    drainSystemEventEntries(wait.parentSessionKey);
    expect(reconcileOrphanedRun(args)).toBe(true);
    expect(runs.has(entry.runId)).toBe(false);
  });

  it.each([false, true])(
    "preserves actual orphan failure timing with parent wait %s",
    (parentWait) => {
      vi.useFakeTimers();
      vi.setSystemTime(4_000);
      const entry = createRunEntry();
      if (parentWait) {
        entry.parentYieldWait = {
          waitId: "parent-wait",
          parentRunId: "parent-run",
          parentSessionKey: entry.requesterSessionKey,
          expectedChildRunIds: [entry.runId],
          childSessionKeys: [entry.childSessionKey],
          waitStartedAt: 1_000,
          staleAt: 2_000,
          status: "waiting",
          requiredCloseout: true,
        };
        entry.pauseReason = "sessions_yield";
      }
      const runs = new Map([[entry.runId, entry]]);
      const resumedRuns = new Set([entry.runId]);

      expect(
        reconcileOrphanedRun({
          runId: entry.runId,
          entry,
          reason: "missing-session-id",
          source: "resume",
          runs,
          resumedRuns,
        }),
      ).toBe(true);

      expect(entry.endedAt).toBe(4_000);
      expect(entry.outcome).toEqual({
        status: "error",
        error: "orphaned subagent run (missing-session-id)",
        startedAt: 1_000,
        endedAt: 4_000,
        elapsedMs: 3_000,
      });
      expect(runs.has(entry.runId)).toBe(parentWait);
      expect(entry.pauseReason).toBeUndefined();
      expect(resumedRuns.has(entry.runId)).toBe(false);
    },
  );
});

describe("logAnnounceGiveUp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes the last delivery error in retry-limit warnings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000);
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      endedAt: 4_000,
      delivery: {
        status: "failed",
        attemptCount: 3,
        lastError: "direct-primary: routed-dispatch-did-not-queue-final",
      },
    });

    logAnnounceGiveUp(entry, "retry-limit");

    expect(logSpy).toHaveBeenCalledWith(
      '[warn] Subagent announce give up (retry-limit) run=run-1 child=agent:main:subagent:child requester=agent:main:main retries=3 endedAgo=5s deliveryError="direct-primary: routed-dispatch-did-not-queue-final"',
    );
    logSpy.mockRestore();
  });

  it("normalizes multiline delivery errors onto one gateway log line", () => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      delivery: {
        status: "failed",
        lastError: "gateway timeout\nphase: routed dispatch failed",
      },
    });

    logAnnounceGiveUp(entry, "expiry");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('deliveryError="gateway timeout phase: routed dispatch failed"'),
    );
    logSpy.mockRestore();
  });
});
