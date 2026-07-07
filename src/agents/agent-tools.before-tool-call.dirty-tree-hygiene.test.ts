import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  runBeforeToolCallHook,
  setDirtyTreeHygieneStatusReaderForTest,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";

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

describe("before_tool_call dirty-tree hygiene gate", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    hookRunner = {
      hasHooks: vi.fn().mockReturnValue(false),
      runBeforeToolCall: vi.fn(),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  });

  afterEach(() => {
    setDirtyTreeHygieneStatusReaderForTest();
  });

  function setStatus(status: string, calls?: string[]): void {
    setDirtyTreeHygieneStatusReaderForTest(async (repoDir) => {
      calls?.push(`git -C ${repoDir} status --short`);
      return status;
    });
  }

  function broadMixedStatus(): string {
    return [
      " M src/agents/agent-tools.before-tool-call.ts",
      " M src/infra/restart.ts",
      " M src/auto-reply/reply/agent-runner.ts",
      " M scripts/build-all.mjs",
      "?? docs/gateway/build-integrity.md",
    ].join("\n");
  }

  function createWrappedPatchTool(name = "apply_patch") {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "patched" }],
      details: { ok: true },
    });
    return {
      execute,
      tool: wrapToolWithBeforeToolCallHook({ name, execute } as any, {
        agentId: "main",
      }),
    };
  }

  function requireBlockedResult(result: unknown): Record<string, unknown> {
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    const record = result as Record<string, unknown>;
    expect(record.details).toMatchObject({
      status: "blocked",
      deniedReason: "dirty-tree-hygiene",
    });
    return record;
  }

  function getBlockedText(result: unknown): string {
    const record = requireBlockedResult(result);
    const content = record.content;
    expect(Array.isArray(content)).toBe(true);
    const firstContent = Array.isArray(content) ? content[0] : undefined;
    expect(typeof firstContent).toBe("object");
    expect(firstContent).not.toBeNull();
    return String((firstContent as Record<string, unknown>).text);
  }

  it("allows source-modifying tool calls when the tree is clean", async () => {
    setStatus("");
    const { execute, tool } = createWrappedPatchTool("functions.apply_patch");

    const result = await tool.execute(
      "patch-clean",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ details: { ok: true } });
  });

  it("blocks source mutation during Cleanup Crew read-only analysis mode", async () => {
    setStatus("");
    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { patch: "*** Begin Patch\n*** End Patch" },
      ctx: {
        agentId: "main",
        cleanupCrewRecovery: {
          analysisMode: true,
          missionId: "cleanup-crew-pause-analyze-plan-resume",
          stoppageId: "stoppage_receipt_123",
          nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "cleanup-crew-analysis-mode",
    });
    expect(result.blocked ? result.reason : "").toContain("read-only inspection only");
  });

  it("allows read-only diagnostics during Cleanup Crew analysis mode", async () => {
    const params = { cmd: "git status --short" };
    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params,
      ctx: {
        agentId: "main",
        cleanupCrewRecovery: {
          analysisMode: true,
          missionId: "cleanup-crew-pause-analyze-plan-resume",
          stoppageId: "stoppage_receipt_123",
        },
      },
    });

    expect(result).toEqual({ blocked: false, params });
  });

  it("blocks shell mutation during Cleanup Crew analysis mode before dirty-tree evaluation", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { cmd: "touch src/continuity/tmp.txt" },
      ctx: {
        agentId: "main",
        cleanupCrewRecovery: {
          analysisMode: true,
          missionId: "cleanup-crew-pause-analyze-plan-resume",
          stoppageId: "stoppage_receipt_123",
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      deniedReason: "cleanup-crew-analysis-mode",
    });
    expect(statusCalls).toEqual([]);
  });

  it("does not hard-block a narrow coherent dirty package", async () => {
    setStatus(" M src/infra/dirty-tree-hygiene.ts\n?? src/infra/new-helper.ts\n");
    const { execute, tool } = createWrappedPatchTool();

    const result = await tool.execute(
      "patch-narrow",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ details: { ok: true } });
  });

  it("does not let generated output clutter turn narrow source work into broad mixed risk", async () => {
    setStatus(
      [
        " M src/infra/dirty-tree-hygiene.ts",
        "?? dist.broken-2026-07-07T055954357Z/",
        "?? file_hub/exports/cleanup-proof.md",
      ].join("\n"),
    );
    const { execute, tool } = createWrappedPatchTool();

    const result = await tool.execute(
      "patch-generated-clutter",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ details: { ok: true } });
  });

  it("blocks source-modifying tool calls when the dirty tree is broad and mixed", async () => {
    setStatus(
      [
        "M  extensions/codex/src/app-server/confirmation-gate.ts",
        " M src/infra/dirty-tree-hygiene.ts",
        "?? src/infra/heartbeat-runner-new.ts",
      ].join("\n"),
    );
    const { execute, tool } = createWrappedPatchTool();

    const result = await tool.execute(
      "patch-broad",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(execute).not.toHaveBeenCalled();
    const text = getBlockedText(result);
    expect(text).toContain("broad/mixed");
    expect(text).toContain("codex-app-server");
    expect(text).toContain("production-flow-watchdog");
    expect(text).toContain("staged=1");
    expect(text).toContain("unstaged=1");
    expect(text).toContain("untracked=1");
  });

  it("allows canonical memory flush writes with matching metadata during broad mixed dirty-tree risk", async () => {
    const statusCalls: string[] = [];
    const params = {
      path: "memory/2026-06-28.md",
      content: "durable note",
    };
    setStatus(broadMixedStatus(), statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params,
      ctx: {
        agentId: "main",
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-06-28.md",
      },
    });

    expect(result).toEqual({ blocked: false, params });
    expect(statusCalls).toEqual([]);
  });

  it("allows namespaced memory flush write tools with append-only metadata", async () => {
    const statusCalls: string[] = [];
    const params = {
      path: "memory/2026-06-28.md",
      content: "durable note",
      mode: "append",
      appendOnly: true,
      operation: "operational_memory_append",
    };
    setStatus(broadMixedStatus(), statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "functions.write",
      params,
      ctx: {
        agentId: "main",
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-06-28.md",
      },
    });

    expect(result).toEqual({ blocked: false, params });
    expect(statusCalls).toEqual([]);
  });

  it("allows canonical memory flush writes when the tree is clean", async () => {
    const params = {
      path: "memory/2026-06-28.md",
      content: "durable note",
    };
    setStatus("");

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params,
      ctx: {
        agentId: "main",
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-06-28.md",
      },
    });

    expect(result).toEqual({ blocked: false, params });
  });

  it.each([
    {
      name: "normal webchat write to the canonical memory path",
      params: { path: "memory/2026-06-28.md", content: "durable note" },
      ctx: { agentId: "main" },
    },
    {
      name: "mismatched memory flush path",
      params: { path: "memory/2026-06-27.md", content: "durable note" },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "absolute memory path",
      params: {
        path: "/home/will/.openclaw/workspace-orchestrator/memory/2026-06-28.md",
        content: "durable note",
      },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "bootstrap reference write",
      params: { path: "AGENTS.md", content: "do not write" },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "memory overwrite-shaped write",
      params: {
        path: "memory/2026-06-28.md",
        content: "durable note",
        mode: "overwrite",
      },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "false append-only metadata",
      params: {
        path: "memory/2026-06-28.md",
        content: "durable note",
        appendOnly: false,
      },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "malformed memory target",
      params: { path: "memory/today.md", content: "durable note" },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "path escape from memory root",
      params: { path: "memory/../src/agents/agent-tools.before-tool-call.ts", content: "nope" },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "normal source write",
      params: { path: "src/agents/agent-tools.before-tool-call.ts", content: "do not write" },
      ctx: { agentId: "main" },
    },
  ])("blocks $name during broad mixed dirty-tree risk", async ({ params, ctx }) => {
    setStatus(broadMixedStatus());

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params,
      ctx,
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "dirty-tree-hygiene",
    });
  });

  it("allows read-only diagnostic shell commands during broad mixed dirty-tree risk", async () => {
    const statusCalls: string[] = [];
    setStatus(
      " M extensions/codex/src/app-server/run-attempt.ts\n?? src/tasks/probe.ts\n",
      statusCalls,
    );

    const result = await runBeforeToolCallHook({
      toolName: "functions.exec_command",
      params: { cmd: "git status --short" },
      ctx: { agentId: "main" },
    });

    expect(result).toEqual({ blocked: false, params: { cmd: "git status --short" } });
    expect(statusCalls).toEqual([]);
  });

  it("uses only read-only git status for dirty-tree hygiene checks", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);
    const { tool } = createWrappedPatchTool();

    await tool.execute(
      "patch-read-only-gate",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(statusCalls).toEqual(["git -C /home/will/openclaw-source status --short"]);
    expect(statusCalls.join("\n")).not.toMatch(/\b(reset|stash|clean|add|rm)\b/);
  });

  it("leaves stale confirmation-policy behavior unaffected", async () => {
    setStatus("");

    const result = await runBeforeToolCallHook({
      toolName: "message",
      params: { text: "update" },
      ctx: { agentId: "main" },
    });

    expect(result).toEqual({ blocked: false, params: { text: "update" } });
  });
});
