import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveMemoryFlushPlan } from "../plugins/memory-state.js";

const PROTECTED_REFERENCE_FILES = ["MEMORY.md", "SOUL.md", "USER.md", "TOOLS.md", "AGENTS.md"];

type FileSnapshot = {
  exists: boolean;
  size: number;
  mtimeMs: number | null;
  sha256: string | null;
};

export type MemoryFlushProofResult = {
  schema: "openclaw.memory_flush_proof.v1";
  ok: true;
  agentId: string;
  workspaceDir: string;
  target: {
    path: string;
    absolutePath: string;
    before: FileSnapshot;
    after: FileSnapshot;
    tailDelta: string;
    appendOnly: boolean;
  };
  dirtyTree: {
    sourceRepo: string;
    status: string;
  };
  receipt: unknown;
  protectedFiles: Array<{
    path: string;
    before: FileSnapshot;
    after: FileSnapshot;
    unchanged: boolean;
  }>;
};

export type MemoryFlushProofOptions = {
  agentId?: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  content?: string;
  nowMs?: number;
};

async function readFileSnapshot(filePath: string): Promise<FileSnapshot> {
  try {
    const [stat, buffer] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        exists: false,
        size: 0,
        mtimeMs: null,
        sha256: null,
      };
    }
    throw error;
  }
}

async function readUtf8IfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function requireTool(tools: AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Memory flush proof could not find required ${name} tool.`);
  }
  return tool;
}

function defaultProofContent(nowMs: number): string {
  return [
    "",
    `## Memory flush proof - ${new Date(nowMs).toISOString()}`,
    "",
    "- Supported memory-flush proof surface exercised the memory-triggered append path.",
  ].join("\n");
}

async function readDirtyTreeStatus(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", "/home/will/openclaw-source", "status", "--short"],
    {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    },
  );
  return stdout;
}

export async function runMemoryFlushProof(
  options: MemoryFlushProofOptions = {},
): Promise<MemoryFlushProofResult> {
  const nowMs = options.nowMs ?? Date.now();
  const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
  const agentId = options.agentId?.trim() || "main";
  const plan = resolveMemoryFlushPlan({ cfg: options.cfg, nowMs });
  if (!plan) {
    throw new Error("Memory flush proof requires an active memory flush plan resolver.");
  }
  const relativePath = plan.relativePath;
  const targetPath = path.resolve(workspaceDir, relativePath);
  const beforeTarget = await readFileSnapshot(targetPath);
  const beforeContent = await readUtf8IfExists(targetPath);
  const protectedBefore = await Promise.all(
    PROTECTED_REFERENCE_FILES.map(async (entry) => ({
      path: entry,
      before: await readFileSnapshot(path.resolve(workspaceDir, entry)),
    })),
  );
  const dirtyTreeStatus = await readDirtyTreeStatus();

  const tools = createOpenClawCodingTools({
    agentId,
    workspaceDir,
    cwd: workspaceDir,
    config: options.cfg,
    trigger: "memory",
    memoryFlushWritePath: relativePath,
    runId: `memory-flush-proof-${nowMs}`,
    sessionKey: `agent:${agentId}:memory-flush-proof`,
  });
  const writeTool = requireTool(tools, "write");
  const result = await writeTool.execute(`memory-flush-proof-${nowMs}`, {
    path: relativePath,
    content: options.content ?? defaultProofContent(nowMs),
    mode: "append",
    appendOnly: true,
    operation: "operational_memory_append",
  });
  const details = (result as { details?: unknown }).details;
  const afterTarget = await readFileSnapshot(targetPath);
  const afterContent = await readUtf8IfExists(targetPath);
  const protectedAfter = await Promise.all(
    protectedBefore.map(async (entry) => {
      const after = await readFileSnapshot(path.resolve(workspaceDir, entry.path));
      return {
        ...entry,
        after,
        unchanged: entry.before.sha256 === after.sha256 && entry.before.exists === after.exists,
      };
    }),
  );

  if (!afterContent.startsWith(beforeContent)) {
    throw new Error("Memory flush proof write was not append-only.");
  }

  return {
    schema: "openclaw.memory_flush_proof.v1",
    ok: true,
    agentId,
    workspaceDir,
    target: {
      path: relativePath,
      absolutePath: targetPath,
      before: beforeTarget,
      after: afterTarget,
      tailDelta: afterContent.slice(beforeContent.length),
      appendOnly: true,
    },
    dirtyTree: {
      sourceRepo: "/home/will/openclaw-source",
      status: dirtyTreeStatus,
    },
    receipt: details,
    protectedFiles: protectedAfter,
  };
}
