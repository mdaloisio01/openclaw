import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemorySearchManagerMockCalls,
  getMemorySearchManagerMockConfigs,
  getMemorySearchManagerMockParams,
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryFileList,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemorySearchManagerImpl,
} from "./memory-tool-manager-mock.js";
import { createMemorySearchTool, testing as memoryToolsTesting } from "./tools.js";
import { MemoryGetSchema, MemorySearchSchema } from "./tools.shared.js";
import {
  asOpenClawConfig,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

const sessionStore = vi.hoisted(() => ({
  "agent:main:main": {
    sessionId: "thread-1",
    updatedAt: 1,
    sessionFile: "/tmp/sessions/thread-1.jsonl",
  },
}));

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({
      storePath: "(test)",
      store: sessionStore,
    })),
  };
});

describe("memory tool schemas", () => {
  it("uses flat corpus enums for provider tool compatibility", () => {
    const searchCorpus = MemorySearchSchema.properties.corpus as {
      anyOf?: unknown;
      enum?: unknown;
    };
    const getCorpus = MemoryGetSchema.properties.corpus as {
      anyOf?: unknown;
      enum?: unknown;
    };

    expect(searchCorpus.anyOf).toBeUndefined();
    expect(searchCorpus.enum).toEqual(["memory", "wiki", "all", "sessions"]);
    expect(getCorpus.anyOf).toBeUndefined();
    expect(getCorpus.enum).toEqual(["memory", "wiki", "all"]);
  });
});

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
    memoryToolsTesting.resetMemorySearchToolCooldowns();
  });

  it("rejects fractional maxResults before searching", async () => {
    const tool = createMemorySearchToolOrThrow();

    await expect(
      tool.execute("fractional-max-results", {
        query: "hello",
        maxResults: 1.5,
      }),
    ).rejects.toThrow("maxResults must be a positive integer");

    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("rejects malformed minScore before searching", async () => {
    const tool = createMemorySearchToolOrThrow();

    await expect(
      tool.execute("malformed-min-score", {
        query: "hello",
        minScore: "0.8junk",
      }),
    ).rejects.toThrow("minScore must be a finite number");

    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("passes string minScore through to memory search", async () => {
    let seenMinScore: number | undefined;
    setMemorySearchImpl(async (opts) => {
      seenMinScore = opts?.minScore;
      return [];
    });
    const tool = createMemorySearchToolOrThrow();

    await tool.execute("string-min-score", {
      query: "hello",
      minScore: "0.8",
    });

    expect(seenMinScore).toBe(0.8);
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("quota", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("returns explicit unavailable metadata for non-quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("generic", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });

  it("returns local memory fallback results when manager setup does not settle", async () => {
    vi.useFakeTimers();
    try {
      setMemorySearchManagerImpl(async () => await new Promise(() => {}));
      setMemoryFileList(["/workspace/MEMORY.md"]);
      setMemoryReadFileImpl(async (params) => ({
        path: params.relPath,
        from: params.from ?? 1,
        lines: 120,
        text: "Durable cleanup memory hygiene note.",
      }));
      const tool = createMemorySearchToolOrThrow();

      const resultPromise = tool.execute("manager-timeout", { query: "cleanup memory hygiene" });
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;
      expect(result.details).toMatchObject({
        provider: "local-fallback",
        model: "memory-files",
        degraded: true,
        mode: "local-fallback",
        results: [
          {
            corpus: "memory",
            path: "../../../../workspace/MEMORY.md",
            score: expect.any(Number),
            snippet: "Durable cleanup memory hygiene note.",
            source: "memory",
          },
        ],
        debug: {
          backend: "local-fallback",
          effectiveMode: "local-fallback",
          hits: 1,
          timeoutError: "memory_search timed out after 15s",
          localFallback: {
            used: true,
            staleIndexSuspected: true,
            scannedFiles: 1,
            scannedChunks: 1,
            matchedFiles: 1,
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns unavailable metadata when memory search does not settle", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      setMemorySearchImpl(async () => {
        searchCalls += 1;
        return await new Promise(() => {});
      });
      const tool = createMemorySearchToolOrThrow();

      const resultPromise = tool.execute("search-timeout", { query: "hello" });
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;
      expectUnavailableMemorySearchDetails(result.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search is unavailable due to an embedding/provider error.",
        action: "Check embedding provider configuration and retry memory_search.",
      });
      const cooldownResult = await tool.execute("search-cooldown", { query: "hello again" });
      expectUnavailableMemorySearchDetails(cooldownResult.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search is unavailable due to an embedding/provider error.",
        action: "Check embedding provider configuration and retry memory_search.",
      });
      expect(searchCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-resolves the manager once when a cached sqlite handle was closed", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        throw new Error("database is not open");
      }
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Thread-hidden codename: ORBIT-22.",
          source: "memory" as const,
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("closed-db", { query: "hidden thread codename" });

    expect((result.details as { results?: Array<{ path: string }> }).results).toEqual([
      {
        corpus: "memory",
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "Thread-hidden codename: ORBIT-22.",
        source: "memory",
      },
    ]);
    expect(searchCalls).toBe(2);
    expect(getMemorySearchManagerMockCalls()).toBe(2);
  });

  it("forces a sync and retries once when the first search has zero hits", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        return [];
      }
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Thread-hidden codename: ORBIT-22.",
          source: "memory" as const,
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("zero-hit-retry", { query: "hidden thread codename" });

    expect((result.details as { results?: Array<{ path: string }> }).results?.[0]?.path).toBe(
      "MEMORY.md",
    );
    expect(searchCalls).toBe(2);
  });

  it("falls back to bounded local memory scanning for exact filename history misses", async () => {
    setMemoryFileList(["/workspace/memory/2026-06-10.md"]);
    setMemoryReadFileImpl(async (params) => {
      if (params.relPath !== "memory/2026-06-10.md") {
        return { text: "", path: params.relPath, from: params.from ?? 1, lines: 0 };
      }
      if ((params.from ?? 1) === 1) {
        return {
          path: params.relPath,
          from: 1,
          lines: 120,
          truncated: true,
          nextFrom: 121,
          text: Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n"),
        };
      }
      if ((params.from ?? 1) === 121) {
        return {
          path: params.relPath,
          from: 121,
          lines: 120,
          truncated: true,
          nextFrom: 241,
          text: Array.from({ length: 120 }, (_, index) => `line ${index + 121}`).join("\n"),
        };
      }
      return {
        path: params.relPath,
        from: 241,
        lines: 6,
        text: [
          "291 filler",
          "292 filler",
          "293 filler",
          "GIE Self improvment update.md",
          "GIE Improvment Planning Task.md",
          "# GIE System-Wide Agent Capability promotion plan.txt",
        ].join("\n"),
      };
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("local-fallback-exact", {
      query:
        "GIE Self improvment update.md|GIE Improvment Planning Task.md|# GIE System-Wide Agent Capability promotion plan.txt",
    });
    const details = result.details as {
      results: Array<{ path: string; startLine: number; snippet: string }>;
      debug?: { localFallback?: { used?: boolean; staleIndexSuspected?: boolean } };
    };

    expect(details.results[0]?.path).toBe("memory/2026-06-10.md");
    expect(details.results[0]?.startLine).toBeGreaterThanOrEqual(241);
    expect(details.results[0]?.snippet).toContain("GIE Self improvment update.md");
    expect(details.debug?.localFallback?.used).toBe(true);
    expect(details.debug?.localFallback?.staleIndexSuspected).toBe(true);
  });

  it("falls back to bounded local memory scanning for ordered history wording misses", async () => {
    setMemoryFileList(["/workspace/memory/2026-06-09.md"]);
    setMemoryReadFileImpl(async (params) => ({
      path: params.relPath,
      from: params.from ?? 1,
      lines: 8,
      text: [
        "notes",
        "GIE Self improvment update.md",
        "GIE Improvment Planning Task.md",
        "# GIE System-Wide Agent Capability promotion plan.txt",
      ].join("\n"),
    }));

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("local-fallback-ordered", {
      query: "GIE self improvement planning promotion order",
    });
    const details = result.details as {
      results: Array<{ path: string; snippet: string }>;
      debug?: { localFallback?: { used?: boolean } };
    };

    expect(details.results[0]?.path).toBe("memory/2026-06-09.md");
    expect(details.results[0]?.snippet).toContain("GIE Improvment Planning Task.md");
    expect(details.debug?.localFallback?.used).toBe(true);
  });

  it("returns structured search debug metadata for qmd results", async () => {
    setMemoryBackend("qmd");
    setMemorySearchImpl(async (opts) => {
      opts?.onDebug?.({
        backend: "qmd",
        configuredMode: opts.qmdSearchModeOverride ?? "query",
        effectiveMode: "query",
        fallback: "unsupported-search-flags",
      });
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          snippet: "ramen",
          source: "memory",
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        plugins: {
          entries: {
            "active-memory": {
              config: {
                qmd: {
                  searchMode: "search",
                },
              },
            },
          },
        },
        memory: {
          backend: "qmd",
          qmd: {
            searchMode: "query",
            limits: {
              maxInjectedChars: 1000,
            },
          },
        },
      },
      agentSessionKey: "agent:main:main:active-memory:debug",
    });
    const result = await tool.execute("debug", { query: "favorite food" });
    const details = result.details as {
      mode?: unknown;
      debug?: {
        backend?: unknown;
        configuredMode?: unknown;
        effectiveMode?: unknown;
        fallback?: unknown;
        hits?: unknown;
        searchMs?: number;
      };
    };
    expect(details.mode).toBe("query");
    expect(details.debug?.backend).toBe("qmd");
    expect(details.debug?.configuredMode).toBe("search");
    expect(details.debug?.effectiveMode).toBe("query");
    expect(details.debug?.fallback).toBe("unsupported-search-flags");
    expect(details.debug?.hits).toBe(1);
    expect(details.debug?.searchMs).toBeGreaterThanOrEqual(0);
  });
});

describe("memory_search corpus labels", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("uses explicit plugin context agent over synthetic active-memory session keys", async () => {
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: {
          list: [
            { id: "main", default: true, memorySearch: { enabled: false } },
            { id: "recall", memorySearch: { enabled: true } },
          ],
        },
      }),
      agentId: "recall",
      agentSessionKey: "explicit:user-session:active-memory:abc123",
    });

    await tool.execute("recall", { query: "favorite food" });

    expect(getMemorySearchManagerMockParams().at(-1)?.agentId).toBe("recall");
  });

  it("re-resolves config when executing a previously created tool", async () => {
    const startupConfig = asOpenClawConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            model: "nomic-embed-text",
          },
        },
        list: [{ id: "main", default: true }],
      },
      memory: {
        backend: "builtin",
      },
    });
    const patchedConfig = asOpenClawConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
        list: [{ id: "main", default: true }],
      },
      memory: {
        backend: "builtin",
      },
    });
    let liveConfig = startupConfig;
    const tool = createMemorySearchTool({
      config: startupConfig,
      getConfig: () => liveConfig,
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    liveConfig = patchedConfig;
    await tool.execute("patched-config", { query: "provider switch" });

    expect(getMemorySearchManagerMockConfigs()).toEqual([patchedConfig]);
  });

  it("preserves source corpus labels for memory and session transcript hits", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 3,
        endLine: 4,
        score: 0.95,
        snippet: "Durable memory note",
        source: "memory" as const,
      },
      {
        path: "sessions/thread-1.jsonl",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "Thread transcript note",
        source: "sessions" as const,
      },
    ]);

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
        tools: { sessions: { visibility: "all" } },
      },
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("mixed", { query: "thread note" });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results).toEqual([
      {
        corpus: "memory",
        path: "MEMORY.md",
        startLine: 3,
        endLine: 4,
        score: 0.95,
        snippet: "Durable memory note",
        source: "memory",
      },
      {
        corpus: "sessions",
        path: "sessions/thread-1.jsonl",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "Thread transcript note",
        source: "sessions",
      },
    ]);
  });
});
