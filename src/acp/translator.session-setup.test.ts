import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { GatewayClient } from "../gateway/client.js";
import { AcpSessionManager } from "./control-plane/manager.js";
import { DEFAULT_DEPS } from "./control-plane/manager.types.js";
import {
  createNewSessionRequest,
  createLoadSessionRequest,
  createPromptRequest,
  expectConfigOption,
  sessionUpdatePayloads,
  expectSessionUpdate,
} from "./translator.bridge-test-helpers.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

describe("acp unsupported bridge session setup", () => {
  it("rejects per-session MCP servers on newSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    await expect(
      agent.newSession({
        ...createNewSessionRequest(),
        mcpServers: [{ name: "docs", command: "mcp-docs" }] as never[],
      }),
    ).rejects.toThrow(/does not support per-session MCP servers/i);

    expect(sessionStore.hasSession("docs-session")).toBe(false);
    expect(sessionUpdate).not.toHaveBeenCalled();
    sessionStore.clearAllSessionsForTest();
  });

  it("rejects per-session MCP servers on loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    await expect(
      agent.loadSession({
        ...createLoadSessionRequest("docs-session"),
        mcpServers: [{ name: "docs", command: "mcp-docs" }] as never[],
      }),
    ).rejects.toThrow(/does not support per-session MCP servers/i);

    expect(sessionStore.hasSession("docs-session")).toBe(false);
    expect(sessionUpdate).not.toHaveBeenCalled();
    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp session UX bridge behavior", () => {
  it("keeps generated bridge prompts separate from managed ACP session metadata", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    });
    const agent = new AcpGatewayAgent(
      connection,
      createAcpGateway(request as GatewayClient["request"]),
      {
        sessionStore,
      },
    );
    const outerKey = "agent:external-harness:acp:outer";
    const outerMeta: SessionAcpMeta = {
      backend: "acpx",
      agent: "external-harness",
      runtimeSessionName: outerKey,
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };
    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      readSessionEntry: ({ sessionKey }) =>
        sessionKey === outerKey
          ? {
              cfg: {},
              storePath: "/tmp/sessions.json",
              sessionKey,
              storeSessionKey: sessionKey,
              acp: outerMeta,
            }
          : null,
    });

    const result = await agent.newSession(createNewSessionRequest());
    const session = sessionStore.getSession(result.sessionId);
    const innerKey = `acp-bridge:${result.sessionId}`;

    expect(session?.sessionKey).toBe(innerKey);
    expect(manager.resolveSession({ cfg: {}, sessionKey: innerKey }).kind).toBe("none");
    expect(manager.resolveSession({ cfg: {}, sessionKey: outerKey })).toMatchObject({
      kind: "ready",
      meta: outerMeta,
    });
    expect(
      manager.resolveSession({ cfg: {}, sessionKey: "agent:external-harness:acp:missing" }),
    ).toMatchObject({
      kind: "stale",
      error: { code: "ACP_SESSION_INIT_FAILED" },
    });

    const prompt = agent.prompt(
      createPromptRequest(result.sessionId, "Return a bounded acknowledgement."),
    );
    const runId = session?.activeRunId;
    expect(runId).toBeTruthy();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({ sessionKey: innerKey, idempotencyKey: runId }),
        expect.anything(),
      ),
    );
    await agent.handleGatewayEvent({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: innerKey,
        runId,
        state: "final",
        stopReason: "end_turn",
        message: { content: [{ type: "text", text: '{"result":"pass"}' }] },
      },
    });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(connection["__sessionUpdateMock"]).toHaveBeenCalledWith({
      sessionId: result.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: '{"result":"pass"}' },
      },
    });
    expect(manager.resolveSession({ cfg: {}, sessionKey: outerKey })).toMatchObject({
      kind: "ready",
      meta: outerMeta,
    });
    expect(session?.activeRunId).toBeNull();

    sessionStore.clearAllSessionsForTest();
  });

  it("returns initial modes and thought-level config options for new sessions", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toStrictEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "adaptive",
    ]);
    expectConfigOption(result.configOptions, "thought_level", {
      currentValue: "adaptive",
      category: "thought_level",
    });
    expectConfigOption(result.configOptions, "verbose_level", { currentValue: "off" });
    expectConfigOption(result.configOptions, "reasoning_level", { currentValue: "off" });
    expectConfigOption(result.configOptions, "response_usage", { currentValue: "off" });
    expectConfigOption(result.configOptions, "elevated_level", { currentValue: "off" });

    sessionStore.clearAllSessionsForTest();
  });

  it("replays user text, assistant text, and hidden assistant thinking on loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "agent:main:work",
              label: "main-work",
              displayName: "Main work",
              derivedTitle: "Fix ACP bridge",
              kind: "direct",
              updatedAt: 1_710_000_000_000,
              thinkingLevel: "high",
              modelProvider: "openai",
              model: "gpt-5.4",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "medium", label: "medium" },
                { id: "max", label: "max" },
              ],
              verboseLevel: "full",
              reasoningLevel: "stream",
              responseUsage: "tokens",
              elevatedLevel: "ask",
              totalTokens: 4096,
              totalTokensFresh: true,
              contextTokens: 8192,
            },
          ],
        };
      }
      if (method === "sessions.get") {
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: "Question" }] },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Internal loop about NO_REPLY" },
                { type: "text", text: "Answer" },
              ],
            },
            { role: "system", content: [{ type: "text", text: "ignore me" }] },
            { role: "assistant", content: [{ type: "image", image: "skip" }] },
          ],
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.loadSession(createLoadSessionRequest("agent:main:work"));

    expect(result.modes?.currentModeId).toBe("high");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toEqual([
      "off",
      "medium",
      "max",
      "high",
    ]);
    expectConfigOption(result.configOptions, "thought_level", { currentValue: "high" });
    expectConfigOption(result.configOptions, "verbose_level", { currentValue: "full" });
    expectConfigOption(result.configOptions, "reasoning_level", { currentValue: "stream" });
    expectConfigOption(result.configOptions, "response_usage", { currentValue: "tokens" });
    expectConfigOption(result.configOptions, "elevated_level", { currentValue: "ask" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Question" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Internal loop about NO_REPLY" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });
    expectSessionUpdate(sessionUpdate, "agent:main:work", "available_commands_update");
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "session_info_update",
        title: "Fix ACP bridge",
        updatedAt: "2024-03-09T16:00:00.000Z",
        _meta: {
          sessionKey: "agent:main:work",
          kind: "direct",
        },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "usage_update",
        used: 4096,
        size: 8192,
        _meta: {
          source: "gateway-session-store",
          approximate: true,
        },
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("falls back to an empty transcript when sessions.get fails during loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "agent:main:recover",
              label: "recover",
              displayName: "Recover session",
              kind: "direct",
              updatedAt: 1_710_000_000_000,
              thinkingLevel: "adaptive",
              modelProvider: "openai",
              model: "gpt-5.4",
            },
          ],
        };
      }
      if (method === "sessions.get") {
        throw new Error("sessions.get unavailable");
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.loadSession(createLoadSessionRequest("agent:main:recover"));

    expect(result.modes?.currentModeId).toBe("adaptive");
    expectSessionUpdate(sessionUpdate, "agent:main:recover", "available_commands_update");
    expect(sessionUpdatePayloads(sessionUpdate, "user_message_chunk")).toEqual([]);

    sessionStore.clearAllSessionsForTest();
  });
});
