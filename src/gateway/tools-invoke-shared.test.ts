import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { runBeforeToolCallHook as RunBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type HookArgs = Parameters<typeof RunBeforeToolCallHook>[0];
type HookResult = Awaited<ReturnType<typeof RunBeforeToolCallHook>>;

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(async (request: { method: string; params?: unknown }) => {
    if (request.method === "sessions.list") {
      return { sessions: [{ key: "agent:worker:subagent:child" }] };
    }
    if (request.method === "agent") {
      return { runId: "accepted-child-run" };
    }
    throw new Error(`unexpected Gateway method: ${request.method}`);
  }),
  beforeToolCall: vi.fn(
    async (args: HookArgs): Promise<HookResult> => ({
      blocked: false,
      params: args.params,
    }),
  ),
}));

vi.mock("./call.js", () => ({ callGateway: mocks.callGateway }));
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: mocks.beforeToolCall,
}));
vi.mock("../agents/tools/sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(),
}));
vi.mock("../agents/openclaw-tools.js", async () => {
  const { createSessionsSendTool } = await import("../agents/tools/sessions-send-tool.js");
  return {
    createOpenClawTools: (options: { agentSessionKey: string; config: OpenClawConfig }) => [
      createSessionsSendTool(options),
    ],
  };
});

import { invokeGatewayTool } from "./tools-invoke-shared.js";

describe("invokeGatewayTool policy surfaces", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-policy-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const input = {
    name: "sessions_send",
    sessionKey: "agent:main:main",
    args: {
      sessionKey: "agent:worker:subagent:child",
      message: "Continue the assigned task.",
      timeoutSeconds: 0,
    },
    idempotencyKey: "issue-action",
  };

  it("keeps the HTTP default denial and ignores a surface in wire input", async () => {
    const wireInput = { ...input, toolPolicySurface: "loopback" };
    const result = await invokeGatewayTool({
      cfg: {},
      input: wireInput,
      toolCallIdPrefix: "test",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("lets the internal loopback owner invoke the real tool for its owned cross-agent child", async () => {
    const result = await invokeGatewayTool({
      cfg: {},
      input,
      toolCallIdPrefix: "test",
      toolPolicySurface: "loopback",
    });
    expect(result).toMatchObject({
      ok: true,
      result: { details: { status: "accepted", runId: "accepted-child-run" } },
    });
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          sessionKey: input.args.sessionKey,
          deliver: false,
          sourceReplyDeliveryMode: "message_tool_only",
          inputProvenance: expect.objectContaining({ sourceSessionKey: input.sessionKey }),
        }),
      }),
    );
    expect(mocks.beforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "test-issue-action" }),
    );
  });

  it.each([
    { name: "Gateway deny", cfg: { gateway: { tools: { deny: ["sessions_send"] } } } },
    { name: "global deny", cfg: { tools: { deny: ["sessions_send"] } } },
    {
      name: "agent deny",
      cfg: { agents: { list: [{ id: "main", tools: { deny: ["sessions_send"] } }] } },
    },
    { name: "minimal profile", cfg: { tools: { profile: "minimal" as const } } },
  ])("preserves $name on the internal surface", async ({ cfg }) => {
    const result = await invokeGatewayTool({
      cfg,
      input,
      toolCallIdPrefix: "test",
      toolPolicySurface: "loopback",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unrelated cross-agent send",
      cfg: {
        tools: { sessions: { visibility: "all" as const }, agentToAgent: { enabled: false } },
      },
      target: "agent:other:main",
      reason: "Agent-to-agent messaging is disabled",
    },
    {
      name: "child send under self visibility",
      cfg: { tools: { sessions: { visibility: "self" as const } } },
      target: input.args.sessionKey,
      reason: "Session send visibility is restricted",
    },
  ])("lets the runtime tool deny $name", async ({ cfg, target, reason }) => {
    const result = await invokeGatewayTool({
      cfg,
      input: { ...input, args: { ...input.args, sessionKey: target } },
      toolCallIdPrefix: "test",
      toolPolicySurface: "loopback",
    });
    expect(result).toMatchObject({
      ok: true,
      result: { details: { status: "forbidden", error: expect.stringContaining(reason) } },
    });
    expect(mocks.callGateway.mock.calls.some(([request]) => request.method === "agent")).toBe(
      false,
    );
  });

  it("preserves the before-tool approval denial", async () => {
    mocks.beforeToolCall.mockResolvedValueOnce({
      blocked: true,
      reason: "Owner approval required",
      deniedReason: "plugin-approval",
    });
    const result = await invokeGatewayTool({
      cfg: {},
      input,
      toolCallIdPrefix: "test",
      toolPolicySurface: "loopback",
      approvalMode: "report",
    });
    expect(result).toMatchObject({ ok: false, status: 403, error: { requiresApproval: true } });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});
