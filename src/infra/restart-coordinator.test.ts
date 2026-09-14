import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLEANUP_WATCHDOG_POLICY_VERSION } from "../governance/cleanup-watchdog-policy.js";
import {
  SAFE_GATEWAY_RESTART_POST_RESTART_PROOF,
  createSafeGatewayRestartPreflight,
  requestSafeGatewayRestart,
} from "./restart-coordinator.js";

const scheduleGatewaySigusr1Restart = vi.hoisted(() => vi.fn());

vi.mock("./restart.js", () => ({
  scheduleGatewaySigusr1Restart: (opts: unknown) => scheduleGatewaySigusr1Restart(opts),
}));

function safeInspect(overrides = {}) {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    validateBuild: () => ({ ok: true }),
    ...overrides,
  };
}

describe("safe gateway restart coordinator", () => {
  beforeEach(() => {
    scheduleGatewaySigusr1Restart.mockReset();
  });

  it("reports safe when no restart blockers are active", () => {
    const preflight = createSafeGatewayRestartPreflight(safeInspect());

    expect(preflight).toEqual({
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      restartReadinessGate: "runtime_preflight",
      missionResumptionGate: "post_restart_proof_required",
      postRestartProofRequired: SAFE_GATEWAY_RESTART_POST_RESTART_PROOF,
      safe: true,
      counts: {
        queueSize: 0,
        pendingReplies: 0,
        embeddedRuns: 0,
        activeTasks: 0,
        totalActive: 0,
      },
      blockers: [],
      build: { ok: true },
      summary: "safe to restart now",
    });
  });

  it("returns structured blockers for active work", () => {
    const preflight = createSafeGatewayRestartPreflight(
      safeInspect({
        getQueueSize: () => 2,
        getPendingReplies: () => 1,
        getEmbeddedRuns: () => 1,
        getActiveTasks: () => 1,
        getTaskBlockers: () => [
          {
            taskId: "task-1",
            runId: "run-1",
            status: "running",
            runtime: "acp",
            label: "build",
            title: "Build branch",
          },
        ],
      }),
    );

    expect(preflight.safe).toBe(false);
    expect(preflight.policyVersion).toBe(CLEANUP_WATCHDOG_POLICY_VERSION);
    expect(preflight.postRestartProofRequired).toEqual([
      "runtime_identity_loaded",
      "mission_resumption_valid_executor_or_durable_wait",
      "watchdog_clean_with_execution_or_continuation_coverage",
    ]);
    expect(preflight.counts.totalActive).toBe(5);
    expect(preflight.blockers.map((blocker) => blocker.kind)).toEqual([
      "queue",
      "reply",
      "embedded-run",
      "task",
    ]);
    expect(preflight.summary).toContain("restart deferred");
    expect(preflight.summary).toContain("taskId=task-1");
  });

  it("blocks restart side effects when build/runtime validation fails", () => {
    const result = requestSafeGatewayRestart({
      reason: "test.bad-build",
      inspect: safeInspect({
        validateBuild: () => ({
          ok: false,
          reason: "dist stale/partial or runtime identity unverifiable",
          detail: "missing dist/entry.js",
        }),
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      error: "missing dist/entry.js",
      preflight: {
        safe: false,
        build: {
          ok: false,
          reason: "dist stale/partial or runtime identity unverifiable",
          detail: "missing dist/entry.js",
        },
      },
    });
    expect(result.preflight.blockers).toEqual([
      {
        kind: "build",
        count: 1,
        message: "dist stale/partial or runtime identity unverifiable",
      },
    ]);
    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
  });

  it("schedules one restart request and marks active work as deferred", () => {
    scheduleGatewaySigusr1Restart.mockReturnValueOnce({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    });

    const result = requestSafeGatewayRestart({
      reason: "test.safe",
      inspect: safeInspect({
        getQueueSize: () => 1,
      }),
    });

    expect(result.status).toBe("deferred");
    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 0,
      deferralTimeoutMs: 0,
      reason: "test.safe",
    });
  });

  it("surfaces coalesced restart requests", () => {
    scheduleGatewaySigusr1Restart.mockReturnValueOnce({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 500,
      mode: "emit",
      coalesced: true,
      cooldownMsApplied: 0,
    });

    const result = requestSafeGatewayRestart({
      inspect: safeInspect(),
    });

    expect(result.status).toBe("coalesced");
  });

  it("forwards skipDeferral to scheduleGatewaySigusr1Restart and marks status scheduled", () => {
    scheduleGatewaySigusr1Restart.mockReturnValueOnce({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    });

    const result = requestSafeGatewayRestart({
      reason: "test.skip-deferral",
      skipDeferral: true,
      inspect: safeInspect({
        getQueueSize: () => 1,
      }),
    });

    expect(result.status).toBe("scheduled");
    expect(result.preflight.safe).toBe(false);
    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 0,
      deferralTimeoutMs: 0,
      reason: "test.skip-deferral",
      skipDeferral: true,
    });
  });

  it("blocks forced restart bypass while source-turn reply work is active", () => {
    const result = requestSafeGatewayRestart({
      reason: "test.skip-deferral.active-reply",
      skipDeferral: true,
      inspect: safeInspect({
        getPendingReplies: () => 1,
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      error:
        "forced gateway restart blocked: active source turn work has pending replies or embedded runs",
      preflight: {
        counts: expect.objectContaining({ pendingReplies: 1 }),
      },
    });
    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
  });

  it("blocks forced restart bypass while embedded source-turn work is active", () => {
    const result = requestSafeGatewayRestart({
      reason: "test.skip-deferral.embedded-run",
      skipDeferral: true,
      inspect: safeInspect({
        getEmbeddedRuns: () => 1,
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      preflight: {
        counts: expect.objectContaining({ embeddedRuns: 1 }),
      },
    });
    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
  });

  it("omits skipDeferral when not requested", () => {
    scheduleGatewaySigusr1Restart.mockReturnValueOnce({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    });

    requestSafeGatewayRestart({
      reason: "test.no-skip",
      inspect: safeInspect(),
    });

    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 0,
      deferralTimeoutMs: 0,
      reason: "test.no-skip",
    });
  });

  it("forwards restart emit hooks so activation continuation can persist before signal", () => {
    const emitHooks = { beforeEmit: vi.fn(), afterEmitRejected: vi.fn() };
    scheduleGatewaySigusr1Restart.mockReturnValueOnce({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    });

    requestSafeGatewayRestart({
      reason: "test.continuation",
      emitHooks,
      inspect: safeInspect(),
    });

    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 0,
      deferralTimeoutMs: 0,
      reason: "test.continuation",
      emitHooks,
    });
  });
});
