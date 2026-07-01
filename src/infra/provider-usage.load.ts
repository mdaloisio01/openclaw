import { performance } from "node:perf_hooks";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { resolveProviderUsageSnapshotWithPlugin } from "../plugins/provider-runtime.js";
import { resolveFetch } from "./fetch.js";
import { type ProviderAuth, resolveProviderAuths } from "./provider-usage.auth.js";
import {
  DEFAULT_TIMEOUT_MS,
  ignoredErrors,
  PROVIDER_LABELS,
  usageProviders,
  withTimeout,
} from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

async function fetchProviderUsageSnapshotFallback(params: {
  auth: ProviderAuth;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  void params.timeoutMs;
  void params.fetchFn;
  return {
    provider: params.auth.provider,
    displayName: PROVIDER_LABELS[params.auth.provider] ?? params.auth.provider,
    windows: [],
    error: "Unsupported provider",
  };
}

type UsageSummaryOptions = {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  skipPluginAuthWithoutCredentialSource?: boolean;
  onPerfMark?: (name: string) => void;
  onPerfMeasure?: (name: string, durationMs: number) => void;
};

async function fetchProviderUsageSnapshot(params: {
  auth: ProviderAuth;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  const pluginSnapshot = await resolveProviderUsageSnapshotWithPlugin({
    provider: params.auth.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    context: {
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
      provider: params.auth.provider,
      token: params.auth.token,
      accountId: params.auth.accountId,
      timeoutMs: params.timeoutMs,
      fetchFn: params.fetchFn,
    },
  });
  if (pluginSnapshot) {
    return pluginSnapshot;
  }
  return await fetchProviderUsageSnapshotFallback({
    auth: params.auth,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
  });
}

function usageAuthKey(auth: ProviderAuth): string {
  return `${auth.provider}\0${auth.accountId ?? ""}\0${auth.token}`;
}

function dedupeProviderAuths(auths: ProviderAuth[]): ProviderAuth[] {
  const seen = new Set<string>();
  const result: ProviderAuth[] = [];
  for (const auth of auths) {
    const key = usageAuthKey(auth);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(auth);
  }
  return result;
}

export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const config = opts.config ?? getRuntimeConfig();
  opts.onPerfMark?.("config_resolve");
  const env = opts.env ?? process.env;
  const fetchFn = resolveFetch(opts.fetch);
  opts.onPerfMark?.("fetch_resolve");
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const auths = await resolveProviderAuths({
    providers: opts.providers ?? usageProviders,
    auth: opts.auth,
    agentDir: opts.agentDir,
    config,
    env,
    skipPluginAuthWithoutCredentialSource: opts.skipPluginAuthWithoutCredentialSource,
    onPerfMark: (name) => opts.onPerfMark?.(`auth_${name}`),
  });
  opts.onPerfMark?.("auth_resolve");
  if (auths.length === 0) {
    opts.onPerfMark?.("no_auth_response");
    return { updatedAt: now, providers: [] };
  }
  const providerAuths = dedupeProviderAuths(auths);
  opts.onPerfMark?.("provider_enumeration");
  if (providerAuths.length !== auths.length) {
    opts.onPerfMark?.("provider_auth_dedupe");
  }

  const tasks = providerAuths.map((auth) => {
    const failureSnapshot = (error: string): ProviderUsageSnapshot => ({
      provider: auth.provider,
      displayName: PROVIDER_LABELS[auth.provider] ?? auth.provider,
      windows: [],
      error,
    });
    const started = performance.now();
    return withTimeout(
      fetchProviderUsageSnapshot({
        auth,
        config,
        env,
        agentDir: opts.agentDir,
        workspaceDir: opts.workspaceDir,
        timeoutMs,
        fetchFn,
      }),
      timeoutMs + 1000,
      {
        provider: auth.provider,
        displayName: PROVIDER_LABELS[auth.provider],
        windows: [],
        error: "Timeout",
      },
    )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return failureSnapshot(message.trim() || "Fetch failed");
      })
      .finally(() => {
        opts.onPerfMeasure?.(`provider_fetch_${auth.provider}`, performance.now() - started);
      });
  });
  opts.onPerfMark?.("provider_tasks_build");

  const snapshots = await Promise.all(tasks);
  opts.onPerfMark?.("provider_fetch_aggregate");
  const providers = snapshots.filter((entry) => {
    if (entry.windows.length > 0) {
      return true;
    }
    if (entry.summary?.trim()) {
      return true;
    }
    if (!entry.error) {
      return true;
    }
    return !ignoredErrors.has(entry.error);
  });
  opts.onPerfMark?.("provider_filter");

  return { updatedAt: now, providers };
}
