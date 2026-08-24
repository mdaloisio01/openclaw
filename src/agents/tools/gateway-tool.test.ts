import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { createGatewayTool } from "./gateway-tool.js";

type ScheduleGatewayRestartArgs = Parameters<typeof scheduleGatewaySigusr1Restart>[0];

const {
  callGatewayToolMock,
  extractDeliveryInfoMock,
  formatDoctorNonInteractiveHintMock,
  isRestartEnabledMock,
  markActivationContinuationCommandNotStartedMock,
  persistActivationContinuationBeforeRestartMock,
  removeRestartSentinelFileMock,
  scheduleGatewaySigusr1RestartMock,
  writeRestartSentinelMock,
} = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
  isRestartEnabledMock: vi.fn(() => true),
  persistActivationContinuationBeforeRestartMock: vi.fn(async () => ({
    id: "gateway-tool-activation",
  })),
  markActivationContinuationCommandNotStartedMock: vi.fn(async (_id: string) => undefined),
  extractDeliveryInfoMock: vi.fn(() => ({
    deliveryContext: {
      channel: "slack",
      to: "slack:C123",
      accountId: "workspace-1",
    },
    threadId: "thread-42",
  })),
  formatDoctorNonInteractiveHintMock: vi.fn(
    () =>
      "Recommended follow-up: run openclaw doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
  ),
  writeRestartSentinelMock: vi.fn(async (_payload: RestartSentinelPayload) => "/tmp/restart"),
  removeRestartSentinelFileMock: vi.fn(async (_path: string | null | undefined) => undefined),
  scheduleGatewaySigusr1RestartMock: vi.fn((_opts?: ScheduleGatewayRestartArgs) => ({
    scheduled: true,
    delayMs: 250,
  })),
}));

vi.mock("../../config/commands.js", () => ({
  isRestartEnabled: isRestartEnabledMock,
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

vi.mock("../../infra/activation-continuation.js", () => ({
  persistActivationContinuationBeforeRestart: persistActivationContinuationBeforeRestartMock,
  markActivationContinuationCommandNotStarted: markActivationContinuationCommandNotStartedMock,
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    formatDoctorNonInteractiveHint: formatDoctorNonInteractiveHintMock,
    removeRestartSentinelFile: removeRestartSentinelFileMock,
    writeRestartSentinel: writeRestartSentinelMock,
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: vi.fn(),
  })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: vi.fn(() => ({})),
}));

function requireRestartSentinelPayload(): RestartSentinelPayload {
  const calls = writeRestartSentinelMock.mock.calls;
  const payload = calls[calls.length - 1]?.[0];
  if (!payload) {
    throw new Error("expected restart sentinel payload");
  }
  return payload;
}

function requireScheduledRestartArgs(): NonNullable<ScheduleGatewayRestartArgs> {
  const calls = scheduleGatewaySigusr1RestartMock.mock.calls;
  const args = calls[calls.length - 1]?.[0];
  if (!args) {
    throw new Error("expected scheduled restart args");
  }
  return args;
}

describe("gateway tool restart continuation", () => {
  beforeEach(() => {
    isRestartEnabledMock.mockReset();
    isRestartEnabledMock.mockReturnValue(true);
    extractDeliveryInfoMock.mockReset();
    extractDeliveryInfoMock.mockReturnValue({
      deliveryContext: {
        channel: "slack",
        to: "slack:C123",
        accountId: "workspace-1",
      },
      threadId: "thread-42",
    });
    formatDoctorNonInteractiveHintMock.mockReset();
    formatDoctorNonInteractiveHintMock.mockReturnValue(
      "Recommended follow-up: run openclaw doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
    );
    persistActivationContinuationBeforeRestartMock.mockReset();
    persistActivationContinuationBeforeRestartMock.mockResolvedValue({
      id: "gateway-tool-activation",
    });
    markActivationContinuationCommandNotStartedMock.mockReset();
    writeRestartSentinelMock.mockReset();
    writeRestartSentinelMock.mockResolvedValue("/tmp/restart");
    removeRestartSentinelFileMock.mockClear();
    scheduleGatewaySigusr1RestartMock.mockReset();
    scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true, delayMs: 250 });
    callGatewayToolMock.mockReset();
  });

  it("does not expose system-event continuations to the agent tool", async () => {
    const tool = createGatewayTool();

    const parameters = tool.parameters as {
      properties?: {
        continuationKind?: unknown;
      };
    };
    expect(parameters.properties?.continuationKind).toBeUndefined();
  });

  it("advertises restart delays as non-negative integers", async () => {
    const tool = createGatewayTool();

    const parameters = tool.parameters as {
      properties?: {
        delayMs?: { minimum?: number; type?: string };
        restartDelayMs?: { minimum?: number; type?: string };
        timeoutMs?: { minimum?: number; type?: string };
      };
    };
    expect(parameters.properties?.delayMs).toMatchObject({ type: "integer", minimum: 0 });
    expect(parameters.properties?.restartDelayMs).toMatchObject({ type: "integer", minimum: 0 });
    expect(parameters.properties?.timeoutMs).toMatchObject({ type: "integer", minimum: 1 });
  });

  it("advertises control-plane envelope fields for governed config writes", async () => {
    const tool = createGatewayTool();

    const parameters = tool.parameters as {
      properties?: {
        controlPlaneApproval?: { type?: string };
        controlPlaneManifest?: { type?: string };
      };
    };
    expect(parameters.properties?.controlPlaneManifest).toBeDefined();
    expect(parameters.properties?.controlPlaneApproval).toBeDefined();
  });

  it("instructs agents to use continuationMessage for internal post-restart work", async () => {
    const tool = createGatewayTool();

    expect(tool.description).toContain("post-restart work must continue internally");
    expect(tool.description).toContain(
      "visible follow-up from that turn must use the message tool",
    );
    expect(tool.description).toContain("continuationMessage");
    expect(tool.description).toContain("Do not write restart sentinel files directly");
  });

  it("persists activation continuation before scheduling an agent-scoped restart", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    const result = await tool.execute?.("tool-call-1", {
      action: "restart",
      delayMs: 250,
      reason: "continue after reboot",
      note: "Gateway restarting now",
      continuationMessage: "Reply with exactly: Yay! I did it!",
      activationContinuation: {
        id: "activation-tool",
        objective: "prove post restart work",
        expectedRuntime: { commit: "abc", version: "2026.6.2" },
        requiredChecks: ["http_health", "runtime_identity", "visible_delivery"],
        hardStopRules: ["do not resume production"],
        parent: { sessionKey: "agent:main:main", runId: "run-1" },
      },
    });

    expect(persistActivationContinuationBeforeRestartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "activation-tool",
        route: {
          sessionKey: "agent:main:main",
          deliveryContext: {
            channel: "slack",
            to: "slack:C123",
            accountId: "workspace-1",
            threadId: "thread-42",
          },
        },
        parent: { sessionKey: "agent:main:main", runId: "run-1" },
        expectedRuntime: { commit: "abc", version: "2026.6.2" },
        requiredChecks: ["http_health", "runtime_identity", "visible_delivery"],
        objective: "prove post restart work",
        hardStopRules: ["do not resume production"],
        requestedRestartAction: { reason: "continue after reboot" },
      }),
    );
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
    await requireScheduledRestartArgs().emitHooks?.beforeEmit?.();

    const payload = requireRestartSentinelPayload();
    expect(payload.kind).toBe("restart");
    expect(payload.status).toBe("ok");
    expect(payload.sessionKey).toBe("agent:main:main");
    expect(payload.deliveryContext).toEqual({
      channel: "slack",
      to: "slack:C123",
      accountId: "workspace-1",
    });
    expect(payload.threadId).toBe("thread-42");
    expect(payload.message).toBe("Gateway restarting now");
    expect(payload.continuation).toEqual({
      kind: "agentTurn",
      message: "Reply with exactly: Yay! I did it!",
    });
    const restartArgs = requireScheduledRestartArgs();
    expect(restartArgs.delayMs).toBe(250);
    expect(restartArgs.reason).toBe("continue after reboot");
    expect(typeof restartArgs.emitHooks?.beforeEmit).toBe("function");
    expect(typeof restartArgs.emitHooks?.afterEmitRejected).toBe("function");
    expect(result?.details).toEqual({ scheduled: true, delayMs: 250 });
  });

  it("fails closed when activation continuation persistence fails", async () => {
    persistActivationContinuationBeforeRestartMock.mockRejectedValueOnce(
      new Error("state readonly"),
    );
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await expect(
      tool.execute?.("tool-call-persist-fail", {
        action: "restart",
        reason: "restart with durable continuation",
        continuationMessage: "continue after restart",
      }),
    ).rejects.toThrow("state readonly");

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, "soon"])("rejects invalid restart delayMs value %s", async (delayMs) => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await expect(
      tool.execute?.("tool-call-invalid-delay", {
        action: "restart",
        delayMs,
      }),
    ).rejects.toThrow("delayMs must be a non-negative integer");
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("accepts string restart delayMs values through the shared numeric reader", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-string-delay", {
      action: "restart",
      delayMs: "250",
    });

    expect(requireScheduledRestartArgs().delayMs).toBe(250);
  });

  it("coerces legacy continuationKind inputs to an agentTurn", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-1", {
      action: "restart",
      continuationKind: "systemEvent",
      continuationMessage: "Reply after restart",
    });

    await requireScheduledRestartArgs().emitHooks?.beforeEmit?.();

    expect(requireRestartSentinelPayload().continuation).toEqual({
      kind: "agentTurn",
      message: "Reply after restart",
    });
  });

  it("infers a durable continuation for session-scoped restarts", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-1", {
      action: "restart",
      delayMs: 250,
      reason: "restart requested",
    });

    await requireScheduledRestartArgs().emitHooks?.beforeEmit?.();

    const payload = requireRestartSentinelPayload();
    expect(payload.sessionKey).toBe("agent:main:main");
    expect(payload.continuation).toBeNull();
    expect(persistActivationContinuationBeforeRestartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ sessionKey: "agent:main:main" }),
        parent: { sessionKey: "agent:main:main" },
        objective: "restart requested",
      }),
    );
  });

  it("removes the prepared sentinel when restart emission is rejected", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-1", {
      action: "restart",
    });

    const scheduledArgs = requireScheduledRestartArgs();
    await scheduledArgs.emitHooks?.beforeEmit?.();
    await scheduledArgs.emitHooks?.afterEmitRejected?.();

    expect(removeRestartSentinelFileMock).toHaveBeenCalledWith("/tmp/restart");
    expect(markActivationContinuationCommandNotStartedMock).toHaveBeenCalledWith(
      "gateway-tool-activation",
    );
  });

  it("forwards caller-provided control-plane envelope for config.patch", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });
    const controlPlaneManifest = {
      manifestId: "manifest-1",
      candidateSha256: "sha",
      activationTimestamp: "2026-07-14T20:00:00.000Z",
    };
    const controlPlaneApproval = {
      approvalId: "approval-1",
      manifestId: "manifest-1",
      candidateSha256: "sha",
      approved: true,
    };
    callGatewayToolMock.mockImplementation(async (toolName: string) => {
      if (toolName === "config.get") {
        return {
          config: {
            messages: {
              visibleReplies: false,
            },
          },
          hash: "base-hash",
        };
      }
      if (toolName === "config.patch") {
        return { ok: true, config: { redacted: true } };
      }
      throw new Error(`unexpected gateway call ${toolName}`);
    });

    await tool.execute?.("tool-call-config-patch", {
      action: "config.patch",
      raw: JSON.stringify({ messages: { visibleReplies: true } }),
      note: "repair visible replies",
      controlPlaneManifest,
      controlPlaneApproval,
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "config.patch",
      {},
      {
        raw: JSON.stringify({ messages: { visibleReplies: true } }),
        baseHash: "base-hash",
        sessionKey: "agent:main:main",
        note: "repair visible replies",
        restartDelayMs: undefined,
        controlPlaneManifest,
        controlPlaneApproval,
      },
    );
  });
});
