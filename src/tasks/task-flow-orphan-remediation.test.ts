import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRunningTaskRun as createRunningTaskRunOrNull } from "./task-executor.js";
import {
  planOrphanQueuedFlowSnapshotPath,
  runOrphanQueuedFlowRemediation,
} from "./task-flow-orphan-remediation.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function createRunningTaskRun(params: Parameters<typeof createRunningTaskRunOrNull>[0]) {
  const task = createRunningTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected running task creation to succeed");
  }
  return task;
}

async function withRemediationState(
  run: (params: { stateDir: string; receiptDir: string; dbPath: string }) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-task-flow-orphan-remediation-",
    },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
      try {
        await run({
          stateDir: state.stateDir,
          receiptDir: path.join(state.root, "receipts"),
          dbPath: path.join(state.stateDir, "openclaw.sqlite"),
        });
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests();
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("task-flow orphan queued remediation", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("dry-run identifies only stale queued managed flows without executor proof", async () => {
    await withRemediationState(async ({ stateDir, receiptDir }) => {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const now = 31 * 60_000;
      const stale = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/orphan-remediation",
        goal: "Stale queued flow",
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      });
      const fresh = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/orphan-remediation",
        goal: "Fresh queued flow",
        status: "queued",
        createdAt: now - 5 * 60_000,
        updatedAt: now - 5 * 60_000,
      });
      const withTask = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/orphan-remediation",
        goal: "Queued with task",
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      });
      createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: withTask.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-linked-task",
        task: "Inspect repo",
        startedAt: 1,
        lastEventAt: 1,
      });

      const result = runOrphanQueuedFlowRemediation({
        mode: "dry-run",
        receiptDir,
        now,
      });

      expect(result.receipt.candidates.flowRuns).toBe(1);
      expect(result.receipt.repaired.flowRuns).toBe(0);
      expect(result.receipt.skipped.byReason.not_stale).toBe(1);
      expect(result.receipt.skipped.byReason.has_linked_task).toBe(1);
      expect(result.receipt.before.queuedWithoutExecutorProof).toBe(1);
      expect(result.receipt.after.queuedWithoutExecutorProof).toBe(1);
      expect(result.receipt.perRowActions).toHaveLength(0);
      expect(result.receipt.skippedRows.some((row) => row.flowId === fresh.flowId)).toBe(true);
      expect(result.receipt.skippedRows.some((row) => row.flowId === withTask.flowId)).toBe(true);
      expect(result.receipt.skippedRows.some((row) => row.flowId === stale.flowId)).toBe(false);
      expect(fs.existsSync(result.receipt.receiptPath)).toBe(true);
    });
  });

  it("write mode refuses without a snapshot path", async () => {
    await withRemediationState(async ({ stateDir, receiptDir }) => {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/orphan-remediation",
        goal: "Stale queued flow",
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      });

      expect(() =>
        runOrphanQueuedFlowRemediation({
          mode: "write",
          receiptDir,
          now: 31 * 60_000,
        }),
      ).toThrow("Write mode requires a verified snapshot path.");
    });
  });

  it("write mode snapshots and repairs stale queued flows idempotently", async () => {
    await withRemediationState(async ({ stateDir, receiptDir, dbPath }) => {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const stale = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/orphan-remediation",
        goal: "Stale queued flow",
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      });

      const snapshotPath = planOrphanQueuedFlowSnapshotPath(dbPath, 31 * 60_000);
      const result = runOrphanQueuedFlowRemediation({
        mode: "write",
        receiptDir,
        snapshotPath,
        now: 31 * 60_000,
      });

      expect(fs.existsSync(snapshotPath)).toBe(true);
      expect(result.receipt.repaired.flowRuns).toBe(1);
      expect(result.receipt.after.queuedWithoutExecutorProof).toBe(0);
      expect(result.receipt.after.lostWithoutExecutorProof).toBe(1);
      expect(result.receipt.perRowActions).toEqual([
        {
          table: "flow_runs",
          id: stale.flowId,
          action: "mark_lost_unlaunched",
        },
      ]);

      const secondDryRun = runOrphanQueuedFlowRemediation({
        mode: "dry-run",
        receiptDir,
        now: 32 * 60_000,
      });
      expect(secondDryRun.receipt.candidates.flowRuns).toBe(0);
      expect(secondDryRun.receipt.before.queuedWithoutExecutorProof).toBe(0);
    });
  });
});
