import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { listActiveWorkCheckpoints } from "./active-work-checkpoint.js";
import {
  classifyGatewaySelfRestartCommand,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { setDirtyTreeHygieneStatusReaderForTest } from "./agent-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(),
  };
});

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("before_tool_call gateway restart checkpointing", () => {
  let tmpDir: string;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-restart-hook-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(false),
      runBeforeToolCall: vi.fn(),
    } as any);
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    setDirtyTreeHygieneStatusReaderForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("classifies gateway self-restart commands", () => {
    expect(
      classifyGatewaySelfRestartCommand("systemctl --user restart openclaw-gateway.service"),
    ).toMatchObject({
      detected: true,
      action: "restart",
      shouldUseSafeBroker: true,
      safeBrokerCommand: "openclaw gateway restart --safe",
    });
    expect(classifyGatewaySelfRestartCommand("openclaw gateway restart")).toMatchObject({
      detected: true,
      action: "restart",
      shouldUseSafeBroker: true,
      safeBrokerCommand: "openclaw gateway restart --safe",
    });
    expect(classifyGatewaySelfRestartCommand("openclaw gateway restart --safe")).toMatchObject({
      detected: true,
      action: "restart",
      shouldUseSafeBroker: false,
    });
    expect(classifyGatewaySelfRestartCommand("git status --short")).toEqual({ detected: false });
  });

  it("writes a checkpoint before allowing an in-band gateway self-restart", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "systemctl --user restart openclaw-gateway.service" },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:webchat",
        sessionId: "session-webchat",
        runId: "run-webchat",
      },
    });

    expect(result).toEqual({
      blocked: false,
      params: { command: "openclaw gateway restart --safe" },
    });
    const checkpoints = await listActiveWorkCheckpoints({ stateDir: tmpDir });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      sessionKey: "agent:main:webchat",
      sessionId: "session-webchat",
      runId: "run-webchat",
      restartCommand: "systemctl --user restart openclaw-gateway.service",
      restartIntent: "gateway restart",
      safeToAutoResume: true,
      requiresOperatorReview: false,
    });
  });

  it("does not treat gateway restart as source dirty-tree modification", async () => {
    const statusCalls: string[] = [];
    setDirtyTreeHygieneStatusReaderForTest(async (repoDir) => {
      statusCalls.push(repoDir);
      return " M src/agents/example.ts\n?? extensions/codex/example.ts\n";
    });

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "openclaw gateway restart --safe" },
      ctx: { agentId: "main", sessionKey: "agent:main:webchat" },
    });

    expect(result).toEqual({
      blocked: false,
      params: { command: "openclaw gateway restart --safe" },
    });
    expect(statusCalls).toEqual([]);
  });
});
