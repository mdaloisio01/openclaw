import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import {
  getProviderUsageSnapshotWithPluginMock,
  resetProviderUsageSnapshotWithPluginMock,
} from "./provider-usage-plugin-runtime.test-mocks.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { ignoredErrors } from "./provider-usage.shared.js";
import {
  loadUsageWithAuth,
  type ProviderUsageAuth,
  usageNow,
} from "./provider-usage.test-support.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

type ProviderAuth = ProviderUsageAuth<typeof loadProviderUsageSummary>;
const googleGeminiCliProvider = "google-gemini-cli" as unknown as ProviderAuth["provider"];
const resolveProviderUsageSnapshotWithPluginMock = getProviderUsageSnapshotWithPluginMock();

describe("provider-usage.load", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetProviderUsageSnapshotWithPluginMock();
  });

  it("loads snapshots for copilot gemini codex and Xiaomi providers", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        switch (provider) {
          case "github-copilot":
            return {
              provider,
              displayName: "GitHub Copilot",
              windows: [{ label: "Chat", usedPercent: 20 }],
            };
          case googleGeminiCliProvider:
            return {
              provider,
              displayName: "Gemini CLI",
              windows: [{ label: "Pro", usedPercent: 40 }],
            };
          case "openai":
            return {
              provider,
              displayName: "Codex",
              windows: [{ label: "3h", usedPercent: 12 }],
            };
          case "xiaomi":
            return {
              provider,
              displayName: "Xiaomi",
              windows: [],
            };
          case "xiaomi-token-plan":
            return {
              provider,
              displayName: "Xiaomi Token Plan",
              windows: [{ label: "Token Plan", usedPercent: 15 }],
            };
          default:
            return null;
        }
      },
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "github-copilot", token: "copilot-token" },
        { provider: googleGeminiCliProvider, token: "gemini-token" },
        { provider: "openai", token: "codex-token", accountId: "acc-1" },
        { provider: "xiaomi", token: "xiaomi-token" },
        { provider: "xiaomi-token-plan", token: "xiaomi-token-plan-token" },
      ],
      mockFetch,
    );

    expect(summary.providers.map((provider) => provider.provider)).toEqual([
      "github-copilot",
      googleGeminiCliProvider,
      "openai",
      "xiaomi",
      "xiaomi-token-plan",
    ]);
    expect(
      summary.providers.find((provider) => provider.provider === "github-copilot")?.windows,
    ).toEqual([{ label: "Chat", usedPercent: 20 }]);
    expect(
      summary.providers.find((provider) => provider.provider === googleGeminiCliProvider)
        ?.windows[0]?.label,
    ).toBe("Pro");
    expect(
      summary.providers.find((provider) => provider.provider === "openai")?.windows[0]?.label,
    ).toBe("3h");
    expect(summary.providers.find((provider) => provider.provider === "xiaomi")?.windows).toEqual(
      [],
    );
    expect(
      summary.providers.find((provider) => provider.provider === "xiaomi-token-plan")?.windows,
    ).toEqual([{ label: "Token Plan", usedPercent: 15 }]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty provider list when auth resolves to none", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(loadProviderUsageSummary, [], mockFetch);
    expect(summary).toEqual({ updatedAt: usageNow, providers: [] });
  });

  it("marks provider usage load subphases for callers that collect perf attribution", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "openai",
      displayName: "Codex",
      windows: [{ label: "3h", usedPercent: 12 }],
    });
    const marks: string[] = [];
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    await loadProviderUsageSummary({
      now: usageNow,
      auth: [{ provider: "openai", token: "codex-token" }],
      fetch: mockFetch as unknown as typeof fetch,
      onPerfMark: (name) => marks.push(name),
    });

    expect(marks).toEqual([
      "config_resolve",
      "fetch_resolve",
      "auth_injected_auth",
      "auth_resolve",
      "provider_enumeration",
      "provider_tasks_build",
      "provider_fetch_aggregate",
      "provider_filter",
    ]);
  });

  it("measures each provider usage fetch inside the aggregate", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => ({
        provider: provider as ProviderUsageSnapshot["provider"],
        displayName: String(provider),
        windows: [{ label: "3h", usedPercent: 12 }],
      }),
    );
    const measures: Array<{ name: string; durationMs: number }> = [];
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    await loadProviderUsageSummary({
      now: usageNow,
      auth: [
        { provider: "anthropic", token: "token-a" },
        { provider: "openai", token: "token-codex" },
      ],
      fetch: mockFetch as unknown as typeof fetch,
      onPerfMeasure: (name, durationMs) => measures.push({ name, durationMs }),
    });

    expect(measures.map((measure) => measure.name).sort()).toEqual([
      "provider_fetch_anthropic",
      "provider_fetch_openai",
    ]);
    expect(measures.every((measure) => Number.isFinite(measure.durationMs))).toBe(true);
  });

  it("fetches independent provider usage snapshots in parallel", async () => {
    let active = 0;
    let peakActive = 0;
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          provider: provider as ProviderUsageSnapshot["provider"],
          displayName: String(provider),
          windows: [{ label: "3h", usedPercent: 12 }],
        };
      },
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "anthropic", token: "token-a" },
        { provider: "openai", token: "token-codex" },
      ],
      mockFetch,
    );

    expect(peakActive).toBe(2);
  });

  it("dedupes exact duplicate provider auth entries before fetching usage", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue({
      provider: "openai",
      displayName: "Codex",
      windows: [{ label: "3h", usedPercent: 12 }],
    });
    const marks: string[] = [];
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadProviderUsageSummary({
      now: usageNow,
      auth: [
        { provider: "openai", token: "codex-token", accountId: "acct-1" },
        { provider: "openai", token: "codex-token", accountId: "acct-1" },
      ],
      fetch: mockFetch as unknown as typeof fetch,
      onPerfMark: (name) => marks.push(name),
    });

    expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledOnce();
    expect(summary.providers).toEqual([
      {
        provider: "openai",
        displayName: "Codex",
        windows: [{ label: "3h", usedPercent: 12 }],
      },
    ]);
    expect(marks).toContain("provider_auth_dedupe");
  });

  it("returns unsupported provider snapshots for unknown provider ids", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [{ provider: "unsupported-provider", token: "token-u" }] as unknown as ProviderAuth[],
      mockFetch,
    );
    expect(summary.providers).toHaveLength(1);
    expect(summary.providers[0]?.error).toBe("Unsupported provider");
  });

  it("filters errors that are marked as ignored", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: "HTTP 500",
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });
    ignoredErrors.add("HTTP 500");
    try {
      const summary = await loadUsageWithAuth(
        loadProviderUsageSummary,
        [{ provider: "anthropic", token: "token-a" }],
        mockFetch,
      );
      expect(summary.providers).toStrictEqual([]);
    } finally {
      ignoredErrors.delete("HTTP 500");
    }
  });

  it("keeps balance-only summary snapshots", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "deepseek",
      displayName: "DeepSeek",
      windows: [],
      summary: "Balance ¥42.50",
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [{ provider: "deepseek", token: "token-d" }],
      mockFetch,
    );

    expect(summary.providers).toEqual([
      {
        provider: "deepseek",
        displayName: "DeepSeek",
        windows: [],
        summary: "Balance ¥42.50",
      },
    ]);
  });

  it("keeps usage summary available when one provider fetch rejects", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        if (provider === "anthropic") {
          throw new Error("fetch failed");
        }
        const usageProvider = provider as ProviderUsageSnapshot["provider"];
        return {
          provider: usageProvider,
          displayName: "Codex",
          windows: [{ label: "3h", usedPercent: 12 }],
        };
      },
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "anthropic", token: "token-a" },
        { provider: "openai", token: "token-codex" },
      ],
      mockFetch,
    );

    expect(summary.providers).toEqual([
      {
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        error: "fetch failed",
      },
      {
        provider: "openai",
        displayName: "Codex",
        windows: [{ label: "3h", usedPercent: 12 }],
      },
    ]);
  });

  it("throws when fetch is unavailable", async () => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(
        loadProviderUsageSummary({
          now: usageNow,
          auth: [{ provider: "xiaomi", token: "token-x" }],
          fetch: undefined,
        }),
      ).rejects.toThrow("fetch is not available");
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
});
