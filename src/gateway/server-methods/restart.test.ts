import { beforeEach, describe, expect, it, vi } from "vitest";
import { restartHandlers } from "./restart.js";

const requestSafeGatewayRestart = vi.hoisted(() => vi.fn());
const persistActivationContinuationBeforeRestart = vi.hoisted(() => vi.fn());
const markActivationContinuationCommandNotStarted = vi.hoisted(() => vi.fn());

vi.mock("../../infra/activation-continuation.js", () => ({
  persistActivationContinuationBeforeRestart: (opts: unknown) =>
    persistActivationContinuationBeforeRestart(opts),
  markActivationContinuationCommandNotStarted: (id: string) =>
    markActivationContinuationCommandNotStarted(id),
}));

vi.mock("../../infra/restart-coordinator.js", () => ({
  createSafeGatewayRestartPreflight: vi.fn(() => ({
    safe: true,
    counts: {
      queueSize: 0,
      pendingReplies: 0,
      embeddedRuns: 0,
      activeTasks: 0,
      totalActive: 0,
    },
    blockers: [],
    summary: "safe to restart now",
  })),
  requestSafeGatewayRestart: (opts: unknown) => requestSafeGatewayRestart(opts),
}));

function invokeRestartRequest(params: Record<string, unknown>) {
  const respond = vi.fn();
  const handler = restartHandlers["gateway.restart.request"];
  return Promise.resolve(
    handler({
      respond,
      params,
      // The handler only reads `params` and `respond`; remaining fields are unused.
    } as unknown as Parameters<typeof handler>[0]),
  ).then(() => respond);
}

function mockScheduledRestart(preflight: { safe: boolean; summary: string }) {
  requestSafeGatewayRestart.mockReturnValueOnce({
    ok: true,
    status: "scheduled",
    preflight: { ...preflight, counts: {}, blockers: [] },
    restart: {
      ok: true,
      pid: 0,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    },
  });
}

function expectRestartRequest(skipDeferral: boolean) {
  expect(requestSafeGatewayRestart).toHaveBeenCalledWith({
    reason: "operator",
    delayMs: 0,
    skipDeferral,
  });
}

describe("gateway.restart.request handler", () => {
  beforeEach(() => {
    requestSafeGatewayRestart.mockReset();
    persistActivationContinuationBeforeRestart.mockReset();
    markActivationContinuationCommandNotStarted.mockReset();
  });

  it("defaults to skipDeferral: false when the param is absent", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "operator" });

    expectRestartRequest(false);
  });

  it("forwards skipDeferral: true only when params.skipDeferral === true", async () => {
    mockScheduledRestart({ safe: false, summary: "" });

    await invokeRestartRequest({ reason: "operator", skipDeferral: true });

    expectRestartRequest(true);
  });

  it("normalizes truthy non-boolean skipDeferral values to false", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "operator", skipDeferral: "true" });

    expectRestartRequest(false);
  });

  it("forwards skipDeferral: false explicitly when the param is sent as false", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "operator", skipDeferral: false });

    expectRestartRequest(false);
  });

  it("persists activation continuation before scheduling restart dispatch", async () => {
    persistActivationContinuationBeforeRestart.mockResolvedValueOnce({ id: "activation-live" });
    requestSafeGatewayRestart.mockImplementationOnce(() => ({
      ok: true,
      status: "scheduled",
      preflight: { safe: true, counts: {}, blockers: [], summary: "safe" },
      restart: {
        ok: true,
        pid: 0,
        signal: "SIGUSR1",
        delayMs: 0,
        mode: "emit",
        coalesced: false,
        cooldownMsApplied: 0,
      },
    }));

    await invokeRestartRequest({
      reason: "operator",
      skipDeferral: true,
      activationContinuation: {
        id: "activation-live",
        sessionKey: "main",
        requiredChecks: ["http_health"],
        objective: "activate patched gateway",
        hardStopRules: ["do not resume GIE/SADB"],
        expectedRuntime: { commit: "abc" },
      },
    });

    expect(persistActivationContinuationBeforeRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "activation-live",
        route: { sessionKey: "main" },
        requiredChecks: ["http_health"],
        objective: "activate patched gateway",
        hardStopRules: ["do not resume GIE/SADB"],
        expectedRuntime: { commit: "abc" },
        requestedRestartAction: { reason: "operator", skipDeferral: true },
      }),
    );
    expect(requestSafeGatewayRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "operator",
        skipDeferral: true,
        emitHooks: expect.objectContaining({
          afterEmitRejected: expect.any(Function),
        }),
      }),
    );
  });

  it("fails closed when activation continuation persistence fails before restart scheduling", async () => {
    persistActivationContinuationBeforeRestart.mockRejectedValueOnce(new Error("state readonly"));

    const respond = await invokeRestartRequest({
      reason: "operator",
      skipDeferral: true,
      activationContinuation: {
        id: "activation-fail",
        sessionKey: "main",
        requiredChecks: ["http_health"],
        objective: "activate patched gateway",
        expectedRuntime: { commit: "abc" },
      },
    });

    expect(requestSafeGatewayRestart).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("restart not scheduled"),
      }),
    );
  });

  it("marks the continuation command_not_started when restart emission is rejected", async () => {
    persistActivationContinuationBeforeRestart.mockResolvedValueOnce({ id: "activation-rejected" });
    requestSafeGatewayRestart.mockImplementationOnce(() => ({
      ok: true,
      status: "coalesced",
      preflight: { safe: true, counts: {}, blockers: [], summary: "safe" },
      restart: {
        ok: true,
        pid: 0,
        signal: "SIGUSR1",
        delayMs: 0,
        mode: "emit",
        coalesced: true,
        cooldownMsApplied: 0,
      },
    }));

    await invokeRestartRequest({
      reason: "operator",
      activationContinuation: {
        id: "activation-rejected",
        sessionKey: "main",
        requiredChecks: ["http_health"],
        objective: "activate patched gateway",
        expectedRuntime: { commit: "abc" },
      },
    });
    const opts = requestSafeGatewayRestart.mock.calls[0]?.[0] as {
      emitHooks?: {
        afterEmitRejected?: () => Promise<void>;
      };
    };
    await opts.emitHooks?.afterEmitRejected?.();

    expect(markActivationContinuationCommandNotStarted).toHaveBeenCalledWith("activation-rejected");
  });

  it("accepts prompt aliases and maps human check names without dropping proof", async () => {
    persistActivationContinuationBeforeRestart.mockResolvedValueOnce({ id: "activation-alias" });
    requestSafeGatewayRestart.mockImplementationOnce(() => ({
      ok: true,
      status: "scheduled",
      preflight: { safe: true, counts: {}, blockers: [], summary: "safe" },
      restart: {
        ok: true,
        pid: 0,
        signal: "SIGUSR1",
        delayMs: 0,
        mode: "emit",
        coalesced: false,
        cooldownMsApplied: 0,
      },
    }));

    await invokeRestartRequest({
      reason: "operator",
      skipDeferral: true,
      activationContinuation: {
        id: "activation-alias",
        sessionKey: "agent:main:main",
        originalObjective: "prove restart continuation",
        expectedBuild: { commit: "abc", version: "2026.6.2" },
        requiredChecks: [
          "systemd service active/running",
          "gateway status RPC ok",
          "HTTP /health returns ok/live",
          "live build-info matches expected build state",
          "no restart continuation stuck pending after completed side effect",
        ],
        hardStopRules: ["do not resume GIE/SADB"],
      },
    });

    expect(persistActivationContinuationBeforeRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "activation-alias",
        route: { sessionKey: "agent:main:main" },
        parent: { sessionKey: "agent:main:main" },
        objective: "prove restart continuation",
        expectedRuntime: { commit: "abc", version: "2026.6.2" },
        requiredChecks: [
          "systemd",
          "gateway_status_rpc",
          "http_health",
          "runtime_identity",
          "parent_restart_recovery",
        ],
      }),
    );
  });

  it("rejects unregistered required checks before scheduling a restart", async () => {
    const respond = await invokeRestartRequest({
      reason: "operator",
      activationContinuation: {
        id: "activation-unknown-check",
        sessionKey: "main",
        objective: "prove restart continuation",
        expectedRuntime: { commit: "abc" },
        requiredChecks: ["HTTP /health returns ok/live", "made up smoke check"],
      },
    });

    expect(requestSafeGatewayRestart).not.toHaveBeenCalled();
    expect(persistActivationContinuationBeforeRestart).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("unregistered continuation check"),
      }),
    );
  });

  it("rejects unrouteable activation continuations instead of restarting with defaults", async () => {
    const respond = await invokeRestartRequest({
      reason: "operator",
      activationContinuation: {
        id: "activation-bad",
        originalObjective: "prove restart continuation",
        expectedBuild: { commit: "abc" },
        requiredChecks: ["HTTP /health returns ok/live"],
      },
    });

    expect(requestSafeGatewayRestart).not.toHaveBeenCalled();
    expect(persistActivationContinuationBeforeRestart).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("sessionKey"),
      }),
    );
  });
});
