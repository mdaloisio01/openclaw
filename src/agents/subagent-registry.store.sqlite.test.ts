import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-one",
    childSessionKey: "agent:main:subagent:one",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "check sqlite persistence",
    cleanup: "keep",
    createdAt: 100,
    startedAt: 110,
    endedAt: 250,
    outcome: { status: "ok", startedAt: 110, endedAt: 250, elapsedMs: 140 },
    expectsCompletionMessage: true,
    completion: {
      required: true,
      resultText: "done",
      capturedAt: 260,
    },
    delivery: {
      status: "pending",
      createdAt: 270,
      lastAttemptAt: 280,
      attemptCount: 2,
      lastError: "retry later",
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey: "agent:main:subagent:one",
        childRunId: "run-one",
        task: "check sqlite persistence",
        startedAt: 110,
        endedAt: 250,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
      },
    },
    ...overrides,
  };
}

describe("subagent registry sqlite store", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-sqlite-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("persists subagent runs in the shared sqlite state database", async () => {
    const run = createRun();

    saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

    const restored = loadSubagentRegistryFromSqlite();
    expect(restored.get(run.runId)).toMatchObject({
      runId: run.runId,
      childSessionKey: run.childSessionKey,
      requesterSessionKey: run.requesterSessionKey,
      task: run.task,
      endedAt: run.endedAt,
      outcome: run.outcome,
      completion: run.completion,
      delivery: run.delivery,
    });
    expect(await fs.stat(path.join(tempStateDir!, "state", "openclaw.sqlite"))).toBeTruthy();
    await expect(fs.stat(path.join(tempStateDir!, "subagents", "runs.json"))).rejects.toThrow();
  });

  it("uses save calls as whole-registry snapshots", () => {
    const first = createRun({ runId: "run-one", childSessionKey: "agent:main:subagent:one" });
    const second = createRun({ runId: "run-two", childSessionKey: "agent:main:subagent:two" });

    saveSubagentRegistryToSqlite(
      new Map([
        [first.runId, first],
        [second.runId, second],
      ]),
    );
    saveSubagentRegistryToSqlite(new Map([[second.runId, second]]));

    expect([...loadSubagentRegistryFromSqlite().keys()]).toEqual(["run-two"]);
  });

  it("imports the legacy json registry when sqlite has no runs", async () => {
    const legacyRun = createRun({
      runId: "legacy-run",
      childSessionKey: "agent:main:subagent:legacy",
      task: "import legacy registry",
    });
    const registryPath = path.join(tempStateDir!, "subagents", "runs.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify({ version: 2, runs: { [legacyRun.runId]: legacyRun } })}\n`,
      "utf8",
    );

    const imported = loadSubagentRegistryFromSqlite();

    expect(imported.get(legacyRun.runId)?.task).toBe("import legacy registry");
    await expect(fs.stat(registryPath)).rejects.toThrow();
    expect(loadSubagentRegistryFromSqlite().get(legacyRun.runId)?.task).toBe(
      "import legacy registry",
    );
    expect(
      openOpenClawStateDatabase().db.prepare("SELECT COUNT(*) AS count FROM subagent_runs").get(),
    ).toEqual({ count: 1 });
  });

  it("does not let a stale in-memory run overwrite newer persisted replay proof", () => {
    const staleRun = createRun({
      runId: "run-stale",
      childSessionKey: "agent:main:subagent:stale",
      delivery: {
        status: "suspended",
        createdAt: 270,
        lastAttemptAt: 280,
        attemptCount: 2,
        lastError: "retry later",
        suspendedAt: 280,
        suspendedReason: "retry-limit",
        payload: {
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          childSessionKey: "agent:main:subagent:stale",
          childRunId: "run-stale",
          task: "check sqlite persistence",
          startedAt: 110,
          endedAt: 250,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          frozenResultText: "done",
        },
      },
    });
    const repairedRun = createRun({
      runId: "run-stale",
      childSessionKey: "agent:main:subagent:stale",
      delivery: {
        status: "delivered",
        announcedAt: 400,
        deliveredAt: 400,
        replayRepair: {
          repairedAt: 400,
          reason: "owner-approved replay repair",
        },
      } as SubagentRunRecord["delivery"] & {
        replayRepair: { repairedAt: number; reason: string };
      },
    });

    saveSubagentRegistryToSqlite(new Map([[repairedRun.runId, repairedRun]]));
    saveSubagentRegistryToSqlite(new Map([[staleRun.runId, staleRun]]));

    const restored = loadSubagentRegistryFromSqlite().get(staleRun.runId);
    expect(restored?.delivery).toMatchObject({
      status: "delivered",
      announcedAt: 400,
      deliveredAt: 400,
      replayRepair: {
        repairedAt: 400,
        reason: "owner-approved replay repair",
      },
    });
  });
});
