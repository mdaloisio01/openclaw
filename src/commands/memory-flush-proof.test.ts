import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDirtyTreeHygieneStatusReaderForTest } from "../agents/agent-tools.before-tool-call.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../plugins/memory-state.js";
import { runMemoryFlushProof } from "./memory-flush-proof.js";

const MEMORY_PATH = "memory/2026-07-07.md";

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-flush-proof-"));
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, MEMORY_PATH), "seed", "utf-8");
  for (const fileName of ["MEMORY.md", "SOUL.md", "USER.md", "TOOLS.md", "AGENTS.md"]) {
    await fs.writeFile(path.join(workspaceDir, fileName), `${fileName} protected\n`, "utf-8");
  }
  return workspaceDir;
}

function registerTestMemoryFlushPlan(relativePath = MEMORY_PATH): void {
  registerMemoryCapability("memory-core-test", {
    flushPlanResolver: () => ({
      softThresholdTokens: 4000,
      forceFlushTranscriptBytes: 2 * 1024 * 1024,
      reserveTokensFloor: 2000,
      prompt: "flush",
      systemPrompt: "flush",
      relativePath,
    }),
  });
}

describe("runMemoryFlushProof", () => {
  afterEach(() => {
    clearMemoryPluginState();
    setDirtyTreeHygieneStatusReaderForTest();
  });

  it("appends through the memory-triggered write path and returns the receipt", async () => {
    const workspaceDir = await createWorkspace();
    registerTestMemoryFlushPlan();
    setDirtyTreeHygieneStatusReaderForTest(async () =>
      [
        " M src/agents/agent-tools.before-tool-call.ts",
        " M src/infra/dirty-tree-hygiene.ts",
        "?? src/tasks/probe.ts",
      ].join("\n"),
    );

    try {
      const result = await runMemoryFlushProof({
        workspaceDir,
        agentId: "main",
        content: "proof note",
        nowMs: Date.parse("2026-07-07T21:00:00Z"),
      });

      expect(result.schema).toBe("openclaw.memory_flush_proof.v1");
      expect(result.target.path).toBe(MEMORY_PATH);
      expect(result.target.before.size).toBe(4);
      expect(result.target.after.size).toBeGreaterThan(result.target.before.size);
      expect(result.target.tailDelta).toBe("\nproof note");
      expect(result.receipt).toEqual({
        schema: "openclaw.memory_append_receipt.v1",
        path: MEMORY_PATH,
        approvedMemoryRoot: "memory",
        operation: "operational_memory_append",
        appendOnly: true,
      });
      expect(result.protectedFiles.every((entry) => entry.unchanged)).toBe(true);
      await expect(fs.readFile(path.join(workspaceDir, MEMORY_PATH), "utf-8")).resolves.toBe(
        "seed\nproof note",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects non-canonical memory flush plan targets", async () => {
    const workspaceDir = await createWorkspace();
    registerTestMemoryFlushPlan("memory/today.md");

    try {
      await expect(runMemoryFlushProof({ workspaceDir })).rejects.toThrow(
        "Memory flush append target must be memory/YYYY-MM-DD.md.",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
