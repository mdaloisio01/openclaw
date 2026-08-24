import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listOwnerRequestIntakeRecords } from "../../agents/owner-request-intake-ledger.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext } from "./types.js";

function createMockContext() {
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const chatAbortControllers = new Map();
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map();

  return {
    broadcast,
    nodeSendToSession,
    chatAbortControllers,
    agentRunSeq,
    dedupe,
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    logGateway: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
  };
}

describe("chat.send error broadcast", () => {
  async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
    const previous = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-intake-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      return await run(stateDir);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previous;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }

  it("should broadcast error when addChatRun throws", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();

    // Make addChatRun throw synchronously (inside the try block at line 2470)
    ctx.addChatRun.mockImplementation(() => {
      throw Object.assign(new Error("LLM timeout"), { code: "TIMEOUT" });
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "test-run-1",
      },
      respond: respond as never,
      context: ctx as unknown as GatewayRequestContext,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    // Verify respond was called with error
    expect(respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ runId: "test-run-1", status: "error" }),
      expect.any(Object),
      expect.any(Object),
    );

    // Verify broadcastChatError was called (via context.broadcast)
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "test-run-1",
        state: "error",
        errorMessage: expect.stringContaining("LLM timeout"),
        message: expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("LLM timeout"),
            }),
          ],
        }),
      }),
    );
  });

  it("persists governed chat.send intake before agent work starts", async () => {
    await withTempStateDir(async (stateDir) => {
      const ctx = createMockContext();
      const respond = vi.fn();

      ctx.addChatRun.mockImplementation(() => {
        throw Object.assign(new Error("stop after intake"), { code: "TEST" });
      });

      await chatHandlers["chat.send"]({
        params: {
          sessionKey: "main",
          message: "perform a read-only system-wide inventory",
          idempotencyKey: "test-run-intake",
          clientSendAttemptId: "test-run-intake",
          clientSendAttemptAtMs: 1234,
        },
        respond: respond as never,
        context: ctx as unknown as GatewayRequestContext,
        req: {} as never,
        client: {
          connect: {
            client: { id: "openclaw-control-ui", mode: "webchat" },
          },
        } as never,
        isWebchatConnect: () => true,
      });

      expect(listOwnerRequestIntakeRecords({ stateDir })).toMatchObject([
        {
          status: "server_acknowledged",
          governed: true,
          classification: "read_only_reporting",
          expectedDurability: "taskflow_or_exemption",
          sourceSessionKey: "agent:main:main",
          sourceChannel: "webchat",
          clientSendAttemptId: "test-run-intake",
          clientSendAttemptAtMs: 1234,
        },
      ]);
    });
  });

  it("persists unresolved WebChat client send attempts before current agent work", async () => {
    await withTempStateDir(async (stateDir) => {
      const ctx = createMockContext();
      const respond = vi.fn();

      ctx.addChatRun.mockImplementation(() => {
        throw Object.assign(new Error("stop after pending attempt intake"), { code: "TEST" });
      });

      await chatHandlers["chat.send"]({
        params: {
          sessionKey: "main",
          message: "perform a read-only followup",
          idempotencyKey: "test-run-current",
          clientSendAttemptId: "test-run-current",
          clientSendAttemptAtMs: 2222,
          clientPendingSendAttempts: [
            {
              attemptId: "test-run-no-server-ack",
              attemptedAtMs: 1111,
              sessionKey: "main",
              messageHash: "hash-no-server-ack",
              messageSnippet: "perform a read-only system-wide inventory",
            },
          ],
        },
        respond: respond as never,
        context: ctx as unknown as GatewayRequestContext,
        req: {} as never,
        client: {
          connect: {
            client: { id: "openclaw-control-ui", mode: "webchat" },
          },
        } as never,
        isWebchatConnect: () => true,
      });

      expect(listOwnerRequestIntakeRecords({ stateDir })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "client_send_attempt",
            governed: true,
            classification: "read_only_reporting",
            expectedDurability: "taskflow_or_exemption",
            sourceChannel: "webchat",
            clientSendAttemptId: "test-run-no-server-ack",
            clientSendAttemptAtMs: 1111,
            lastExecutableAction: "webchat durably recorded client send attempt",
            nextExecutableAction: "server acknowledgement missing; repair or notify owner",
          }),
          expect.objectContaining({
            status: "server_acknowledged",
            clientSendAttemptId: "test-run-current",
          }),
        ]),
      );
    });
  });

  it("scopes selected-agent global errors to the linked agent", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();

    ctx.addChatRun.mockImplementation(() => {
      throw Object.assign(new Error("LLM timeout"), { code: "TIMEOUT" });
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "global",
        agentId: "main",
        message: "hello",
        idempotencyKey: "test-run-global",
      },
      respond: respond as never,
      context: ctx as unknown as GatewayRequestContext,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    expect(ctx.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "test-run-global",
        sessionKey: "global",
        agentId: "main",
        state: "error",
      }),
    );
    expect(ctx.nodeSendToSession).toHaveBeenCalledWith(
      "agent:main:global",
      "chat",
      expect.objectContaining({
        agentId: "main",
        state: "error",
      }),
    );
    expect(ctx.nodeSendToSession).toHaveBeenCalledWith(
      "global",
      "chat",
      expect.objectContaining({
        agentId: "main",
        state: "error",
        message: expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("LLM timeout"),
            }),
          ],
        }),
      }),
    );
  });
});
