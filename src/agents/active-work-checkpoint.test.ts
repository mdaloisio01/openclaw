import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_WORK_CHECKPOINT_SCHEMA_VERSION,
  listActiveWorkCheckpoints,
  updateActiveWorkCheckpointStatus,
  writeActiveWorkCheckpoint,
} from "./active-work-checkpoint.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-work-checkpoint-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function baseInput() {
  return {
    sessionKey: "agent:main:checkpoint-test",
    sessionId: "session-checkpoint",
    runId: "run-checkpoint",
    requestingAgentToolPath: "exec",
    restartCommand: "systemctl --user restart openclaw-gateway.service",
    restartIntent: "gateway restart",
    activeObjective: "Validate gateway restart.",
    currentPhase: "pre-restart",
    lastCompletedProof: "build info verified",
    nextValidationStep: "check gateway health",
    stopConditions: ["health fails"],
    pendingApprovalState: "none",
    safeToAutoResume: true,
    requiresOperatorReview: false,
  };
}

describe("active work checkpoints", () => {
  it("writes versioned TTL-bounded checkpoint JSON with private context capped out", async () => {
    const checkpoint = await writeActiveWorkCheckpoint({
      input: baseInput(),
      stateDir: tmpDir,
      nowMs: 1_000,
      ttlMs: 5_000,
    });

    expect(checkpoint.schemaVersion).toBe(ACTIVE_WORK_CHECKPOINT_SCHEMA_VERSION);
    expect(checkpoint.createdAtMs).toBe(1_000);
    expect(checkpoint.expiresAtMs).toBe(6_000);
    expect(checkpoint.status).toBe("pending");
    expect(checkpoint).not.toHaveProperty("transcript");

    const file = path.join(tmpDir, "active-work-checkpoints", `${checkpoint.checkpointId}.json`);
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(await fs.readFile(file, "utf8"), "utf8")).toBeLessThan(32 * 1024);
  });

  it("lists expired checkpoints distinctly instead of silently dropping them", async () => {
    await writeActiveWorkCheckpoint({
      input: baseInput(),
      stateDir: tmpDir,
      nowMs: 1_000,
      ttlMs: 5_000,
    });

    const checkpoints = await listActiveWorkCheckpoints({ stateDir: tmpDir, nowMs: 7_000 });

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.status).toBe("expired");
  });

  it("updates checkpoint status after continuation or blocked handling", async () => {
    const checkpoint = await writeActiveWorkCheckpoint({
      input: baseInput(),
      stateDir: tmpDir,
      nowMs: 1_000,
      ttlMs: 5_000,
    });

    await updateActiveWorkCheckpointStatus({
      checkpoint,
      status: "continued",
      reason: "queued continuation",
      stateDir: tmpDir,
      nowMs: 2_000,
    });

    const checkpoints = await listActiveWorkCheckpoints({
      stateDir: tmpDir,
      nowMs: 3_000,
      includeCompleted: true,
    });
    expect(checkpoints[0]).toMatchObject({
      status: "continued",
      completedAtMs: 2_000,
      completionReason: "queued continuation",
    });
  });
});
