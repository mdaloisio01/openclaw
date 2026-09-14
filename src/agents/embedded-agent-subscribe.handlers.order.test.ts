import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";

const mocks = vi.hoisted(() => ({
  handleAgentStart: vi.fn(),
  handleAgentEnd: vi.fn(async () => {}),
  handleCompactionStart: vi.fn(),
  handleCompactionEnd: vi.fn(),
  handleMessageStart: vi.fn(),
  handleMessageUpdate: vi.fn(),
  handleMessageEnd: vi.fn(async () => {}),
  handleToolExecutionStart: vi.fn(async () => {}),
  handleToolExecutionUpdate: vi.fn(),
  handleToolExecutionEnd: vi.fn(async () => {}),
}));

vi.mock("./embedded-agent-subscribe.handlers.lifecycle.js", () => ({
  handleAgentStart: mocks.handleAgentStart,
  handleAgentEnd: mocks.handleAgentEnd,
  handleCompactionStart: mocks.handleCompactionStart,
  handleCompactionEnd: mocks.handleCompactionEnd,
}));

vi.mock("./embedded-agent-subscribe.handlers.messages.js", () => ({
  handleMessageStart: mocks.handleMessageStart,
  handleMessageUpdate: mocks.handleMessageUpdate,
  handleMessageEnd: mocks.handleMessageEnd,
}));

vi.mock("./embedded-agent-subscribe.handlers.tools.js", () => ({
  handleToolExecutionStart: mocks.handleToolExecutionStart,
  handleToolExecutionUpdate: mocks.handleToolExecutionUpdate,
  handleToolExecutionEnd: mocks.handleToolExecutionEnd,
}));

import { createEmbeddedAgentSessionEventHandler } from "./embedded-agent-subscribe.handlers.js";

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  if (!resolve) {
    throw new Error("expected deferred resolver");
  }
  return { promise, resolve };
}

function createContext(): EmbeddedAgentSubscribeContext {
  return {
    log: {
      debug: vi.fn(),
    },
  } as unknown as EmbeddedAgentSubscribeContext;
}

async function waitForAssertion(assertion: () => void) {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await Promise.resolve();
    }
  }
  assertion();
  throw lastError;
}

describe("createEmbeddedAgentSessionEventHandler ordering", () => {
  beforeEach(() => {
    mocks.handleAgentStart.mockReset();
    mocks.handleAgentEnd.mockReset().mockResolvedValue(undefined);
    mocks.handleCompactionStart.mockReset();
    mocks.handleCompactionEnd.mockReset();
    mocks.handleMessageStart.mockReset();
    mocks.handleMessageUpdate.mockReset();
    mocks.handleMessageEnd.mockReset().mockResolvedValue(undefined);
    mocks.handleToolExecutionStart.mockReset().mockResolvedValue(undefined);
    mocks.handleToolExecutionUpdate.mockReset();
    mocks.handleToolExecutionEnd.mockReset().mockResolvedValue(undefined);
  });

  it("waits for tool_execution_end before handling agent_end", async () => {
    const gate = deferred();
    mocks.handleToolExecutionEnd.mockImplementationOnce(async () => {
      await gate.promise;
    });

    const handler = createEmbeddedAgentSessionEventHandler(createContext());

    handler({
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call-long-running",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    } as never);
    handler({
      type: "agent_end",
    } as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.handleToolExecutionEnd).toHaveBeenCalledTimes(1);
    expect(mocks.handleAgentEnd).not.toHaveBeenCalled();

    gate.resolve();

    await waitForAssertion(() => expect(mocks.handleAgentEnd).toHaveBeenCalledTimes(1));
    expect(mocks.handleToolExecutionEnd.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.handleAgentEnd.mock.invocationCallOrder[0],
    );
  });
});
