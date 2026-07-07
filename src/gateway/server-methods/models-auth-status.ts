import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentDir } from "../../agents/agent-scope.js";
import {
  type AuthHealthSummary,
  type AuthProfileHealthStatus,
  type AuthProviderHealth,
  type AuthProviderHealthStatus,
  buildAuthHealthSummary,
  formatRemainingShort,
} from "../../agents/auth-health.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForConfigStatus,
  listProfilesForProvider,
  removeProviderAuthProfilesWithLock,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../../agents/auth-profiles.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isSecretRef } from "../../config/types.secrets.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { PROVIDER_LABELS, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import { abortChatRunsForProvider, type ChatAbortOps } from "../chat-abort.js";
import { formatForLog } from "../ws-log.js";
import {
  createGatewayPerfStageTimer,
  formatGatewayPerfCpuUsage,
  formatGatewayPerfMs,
  logGatewayPerfSummary,
} from "./perf-logging.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("models-auth-status");
const apiKeyUsageStatusProviders = new Set<UsageProviderId>(["deepseek"]);
const USAGE_SUMMARY_CACHE_TTL_MS = 120_000;

type ProviderUsageStatus = Pick<ProviderUsageSnapshot, "windows" | "summary" | "plan">;

/**
 * Models-auth status wire types. Mirrored in ui/src/ui/types.ts via an
 * `import(...)` re-export — edit here and the UI picks up the change.
 *
 * Expiry fields are grouped into a sub-object so they're present together or
 * not at all: a profile either has a time-bounded credential or it doesn't.
 */
export type ModelAuthExpiry = {
  /** Absolute expiry timestamp, ms since epoch. */
  at: number;
  /** Remaining time in ms (negative if already expired). */
  remainingMs: number;
  /** Human-readable remaining time (e.g. "10d", "2h", "45m"). */
  label: string;
};

export type ModelAuthStatusProfile = {
  profileId: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
  expiry?: ModelAuthExpiry;
};

export type ModelAuthStatusProvider = {
  provider: string;
  displayName: string;
  status: AuthProviderHealthStatus;
  expiry?: ModelAuthExpiry;
  profiles: ModelAuthStatusProfile[];
  usage?: {
    windows: UsageWindow[];
    summary?: string;
    plan?: string;
  };
};

export type ModelAuthStatusResult = {
  /** Snapshot build time, ms since epoch. 0 = never loaded (UI fallback sentinel). */
  ts: number;
  providers: ModelAuthStatusProvider[];
};

export type ModelAuthLogoutResult = {
  provider: string;
  removedProfiles: string[];
  abortedRunIds: string[];
};

const CACHE_TTL_MS = 60_000;
let cached: { ts: number; result: ModelAuthStatusResult } | null = null;
let usageSummaryCache: {
  key: string;
  ts: number;
  providers: UsageProviderId[];
  result: Map<string, ProviderUsageStatus>;
} | null = null;
let usageSummaryInFlight: {
  key: string;
  promise: Promise<Map<string, ProviderUsageStatus>>;
} | null = null;

/**
 * Invalidate the in-memory cache. Reserved for future gateway-side auth
 * mutation handlers (login, logout, token rotation) so the next read returns
 * fresh data. Today those mutations happen via the CLI and the 60s TTL plus
 * `{refresh: true}` param cover the stale-data window.
 */
export function invalidateModelAuthStatusCache(): void {
  cached = null;
  usageSummaryCache = null;
  usageSummaryInFlight = null;
  // The prepared provider-auth map (model-provider-auth.ts) was built from
  // the pre-mutation auth state, so it must be invalidated alongside this
  // cache whenever an auth-profile mutation lands (logout, login, token
  // rotation, etc.). Without this, `/models` and pickers keep advertising
  // providers the running gateway can no longer authenticate.
  clearCurrentProviderAuthState();
}

function readProviderParam(params: Record<string, unknown>): string | null {
  const raw = params.provider;
  if (typeof raw !== "string") {
    return null;
  }
  const provider = normalizeProviderId(raw);
  return provider || null;
}

function createAuthLogoutAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    chatAbortedRuns: context.chatAbortedRuns,
    clearChatRunState: context.clearChatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

// Auth profiles can be adopted by a provider-specific owner agent dir. Logout
// must remove every owning store or stale profiles reappear on the next status
// read and provider-auth warmup.
async function removeProviderAuthProfilesAcrossOwnerStores(params: {
  provider: string;
  agentDir: string;
  profileIds: string[];
}): Promise<boolean> {
  const ownerAgentDirs = new Set<string | undefined>([params.agentDir]);
  for (const profileId of params.profileIds) {
    ownerAgentDirs.add(
      resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        profileId,
      }),
    );
  }
  for (const ownerAgentDir of ownerAgentDirs) {
    const updatedStore = await removeProviderAuthProfilesWithLock({
      provider: params.provider,
      agentDir: ownerAgentDir,
    });
    if (!updatedStore) {
      return false;
    }
  }
  return true;
}

// UI expiry fields are emitted only when both timestamp and remaining duration
// are valid, keeping profile/provider expiry shapes all-or-nothing.
function buildExpiry(
  remainingMs: number | undefined,
  expiresAt: number | undefined,
): ModelAuthExpiry | undefined {
  const normalizedExpiresAt = asDateTimestampMs(expiresAt);
  if (normalizedExpiresAt === undefined || typeof remainingMs !== "number") {
    return undefined;
  }
  return { at: normalizedExpiresAt, remainingMs, label: formatRemainingShort(remainingMs) };
}

function providerDisplayName(provider: string): string {
  const usageId = resolveUsageProviderId(provider);
  if (usageId && PROVIDER_LABELS[usageId]) {
    return PROVIDER_LABELS[usageId];
  }
  return provider;
}

function usageSummaryCacheKey(params: { agentDir: string; providers: UsageProviderId[] }): string {
  return JSON.stringify({
    agentDir: params.agentDir,
    providers: [...params.providers].sort(),
  });
}

function mapUsageSummaryProviders(summary: Awaited<ReturnType<typeof loadProviderUsageSummary>>) {
  const usageByProvider = new Map<string, ProviderUsageStatus>();
  for (const snap of summary.providers) {
    usageByProvider.set(snap.provider, {
      windows: snap.windows,
      ...(snap.summary ? { summary: snap.summary } : {}),
      ...(snap.plan ? { plan: snap.plan } : {}),
    });
  }
  return usageByProvider;
}

async function loadUsageSummaryForAuthStatus(params: {
  providers: UsageProviderId[];
  agentDir: string;
  bypassCache: boolean;
  now: number;
  mark: (name: string) => void;
  measure: (name: string, durationMs: number) => void;
}): Promise<{
  usageByProvider: Map<string, ProviderUsageStatus>;
  cacheStatus: "skipped" | "hit" | "stale" | "warming" | "inflight" | "miss" | "bypass";
}> {
  if (params.providers.length === 0) {
    params.mark("usage_skipped");
    return { usageByProvider: new Map(), cacheStatus: "skipped" };
  }
  const key = usageSummaryCacheKey({
    agentDir: params.agentDir,
    providers: params.providers,
  });
  params.mark("usage_cache_check");
  if (!params.bypassCache) {
    if (
      usageSummaryCache &&
      usageSummaryCache.key === key &&
      params.now - usageSummaryCache.ts < USAGE_SUMMARY_CACHE_TTL_MS
    ) {
      params.mark("usage_cache_hit");
      return { usageByProvider: new Map(usageSummaryCache.result), cacheStatus: "hit" };
    }
    if (usageSummaryInFlight?.key === key) {
      params.mark("usage_cache_inflight");
      return { usageByProvider: new Map(), cacheStatus: "inflight" };
    }
  }
  params.mark(params.bypassCache ? "usage_cache_bypass" : "usage_cache_miss");
  const load = async () => {
    const summary = await loadProviderUsageSummary({
      providers: params.providers,
      agentDir: params.agentDir,
      timeoutMs: 3500,
      onPerfMark: (name) => params.mark(`usage_${name}`),
      onPerfMeasure: (name, durationMs) => params.measure(`usage_${name}`, durationMs),
    });
    const usageByProvider = mapUsageSummaryProviders(summary);
    params.mark("usage_response_merge");
    if (!params.bypassCache) {
      usageSummaryCache = {
        key,
        ts: params.now,
        providers: [...params.providers],
        result: new Map(usageByProvider),
      };
    }
    return usageByProvider;
  };
  if (params.bypassCache) {
    return { usageByProvider: await load(), cacheStatus: "bypass" };
  }
  const promise = load();
  usageSummaryInFlight = { key, promise };
  void promise
    .catch((err) => {
      log.debug(
        `usage enrichment warm failed (auth status still returned): providers=${params.providers.join(",")} error=${formatForLog(err)}`,
      );
    })
    .finally(() => {
      if (usageSummaryInFlight?.promise === promise) {
        usageSummaryInFlight = null;
      }
    });
  if (usageSummaryCache?.key === key) {
    params.mark("usage_cache_stale");
    return { usageByProvider: new Map(usageSummaryCache.result), cacheStatus: "stale" };
  }
  params.mark("usage_cache_warming");
  return { usageByProvider: new Map(), cacheStatus: "warming" };
}

/**
 * Aggregate provider status from OAuth profiles only. `buildAuthHealthSummary`
 * rolls up across both OAuth and token profiles, which mis-reports providers
 * where a healthy OAuth sits alongside an expired/missing bearer token.
 * For the dashboard's OAuth-health signal, token profiles are a separate
 * concern — we want "is OAuth healthy?", not "is every credential healthy?"
 * It also consumes the provider's effective profile subset when auth order
 * excludes stale inventory from the runtime credential path.
 *
 * `expectsOAuth` surfaces the configured-OAuth-but-no-oauth-profile case as
 * `missing` instead of silently falling back to the provider's rollup (which
 * would report `static` if only api_key credentials exist). Without this,
 * switching a provider from api_key to oauth in config but forgetting to
 * login hides behind the residual api_key profile until runtime fails.
 *
 * Exported for direct unit testing of the rollup rules.
 */
export function aggregateOAuthStatus(
  prov: AuthProviderHealth,
  now: number = Date.now(),
  expectsOAuth = false,
): {
  status: AuthProviderHealthStatus;
  expiresAt?: number;
  remainingMs?: number;
} {
  const profiles = prov.effectiveProfiles ?? prov.profiles;
  const oauth = profiles.filter((p) => p.type === "oauth");
  if (oauth.length === 0) {
    if (expectsOAuth) {
      return { status: "missing" };
    }
    return { status: prov.status, expiresAt: prov.expiresAt, remainingMs: prov.remainingMs };
  }
  const statuses = new Set<AuthProfileHealthStatus>(oauth.map((p) => p.status));
  // Priority: expired/missing > expiring > ok > static. Exhaustive — if a
  // new AuthProfileHealthStatus variant is added, the `never` check fires.
  let status: AuthProviderHealthStatus;
  if (statuses.has("expired") || statuses.has("missing")) {
    status = "expired";
  } else if (statuses.has("expiring")) {
    status = "expiring";
  } else if (statuses.has("ok")) {
    status = "ok";
  } else if (statuses.has("static")) {
    status = "static";
  } else {
    // Compile-time guard: exhaustiveness over AuthProfileHealthStatus. If
    // auth-health ever adds a new variant without updating this rollup,
    // TypeScript will fail the `never` assignment.
    const exhaustive: never = Array.from(statuses)[0] as never;
    void exhaustive;
    status = "static";
  }
  const expirable = oauth
    .map((p) => p.expiresAt)
    .filter((v): v is number => asDateTimestampMs(v) !== undefined);
  const expiresAt = expirable.length > 0 ? Math.min(...expirable) : undefined;
  const remainingMs = expiresAt !== undefined ? expiresAt - now : undefined;
  return { status, expiresAt, remainingMs };
}

function mapProvider(
  prov: AuthProviderHealth,
  usageByProvider: Map<string, ProviderUsageStatus>,
  expectsOAuthSet: Set<string>,
): ModelAuthStatusProvider {
  const usageProfile =
    prov.profiles.find((profile) => profile.type === "oauth" || profile.type === "token") ??
    prov.profiles.find((profile) => profile.type === "api_key");
  const usageKey = resolveUsageProviderId(prov.provider, {
    credentialType: usageProfile?.type,
  });
  const usage = usageKey ? usageByProvider.get(usageKey) : undefined;
  const rollup = aggregateOAuthStatus(prov, Date.now(), expectsOAuthSet.has(prov.provider));
  return {
    provider: prov.provider,
    displayName: providerDisplayName(prov.provider),
    status: rollup.status,
    expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
    profiles: prov.profiles.map((prof) => ({
      profileId: prof.profileId,
      type: prof.type,
      status: prof.status,
      expiry: buildExpiry(prof.remainingMs, prof.expiresAt),
    })),
    usage: usage
      ? {
          windows: usage.windows,
          ...(usage.summary ? { summary: usage.summary } : {}),
          ...(usage.plan ? { plan: usage.plan } : {}),
        }
      : undefined,
  };
}

/**
 * Collect provider IDs with refreshable credentials (OAuth or bearer token)
 * so a configured-but-not-logged-in provider surfaces as `missing` rather
 * than being silently absent. API-key and AWS-SDK providers are excluded —
 * their credentials don't expire on a schedule this endpoint can meaningfully
 * monitor, and surfacing them here would flash a red alert on a healthy
 * API-key setup.
 *
 * Providers with `models.providers.<id>.apiKey` set (commonly via a
 * SecretRef env binding) are excluded from the "missing" synthesis even
 * when their `auth` mode is `oauth` or `token` — an env-backed credential
 * is already present, so flagging the dashboard as missing would cry wolf
 * for a working auth path. They can still show up with real status if the
 * profile store has an entry for them.
 */
function resolveConfiguredProviders(cfg: OpenClawConfig): {
  providers: string[];
  expectsOAuth: Set<string>;
} {
  const out = new Set<string>();
  const expectsOAuth = new Set<string>();
  // Providers with a resolvable apiKey (inline or SecretRef pointing at a
  // set env var) are treated as env-backed and skipped from the "missing"
  // synthesis. Captured once up front so both the models.providers scan
  // and the auth.profiles scan apply the escape hatch consistently.
  const envBacked = new Set<string>();
  for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
    const apiKey = provider?.apiKey;
    if (!id || apiKey === undefined || apiKey === null) {
      continue;
    }
    // Treat as env-backed when the credential is currently resolvable:
    // - inline string literal → always resolvable (satisfies auth today)
    // - env SecretRef → check process.env for the referenced id (the only
    //   source we can cheaply verify synchronously on a dashboard read)
    // - file/exec SecretRef → conservatively treat as env-backed; we can't
    //   read files or run commands here without making this a heavy async
    //   path, and the alternative is crying wolf on valid configs
    // A SecretRef pointing at an unset env var falls through to the normal
    // "missing" synthesis so the dashboard surfaces the broken config.
    let resolvable = false;
    if (typeof apiKey === "string" && apiKey.length > 0) {
      resolvable = true;
    } else if (isSecretRef(apiKey)) {
      if (apiKey.source === "env") {
        const envValue = process.env[apiKey.id];
        resolvable = typeof envValue === "string" && envValue.length > 0;
      } else {
        resolvable = true;
      }
    }
    if (resolvable) {
      envBacked.add(normalizeProviderId(id));
    }
  }
  for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
    if (!id) {
      continue;
    }
    // Only include providers whose configured auth mode is refreshable.
    // `undefined` / "api-key" / "aws-sdk" are deliberately skipped.
    const mode = provider?.auth;
    if (mode !== "oauth" && mode !== "token") {
      continue;
    }
    if (envBacked.has(normalizeProviderId(id))) {
      continue;
    }
    out.add(id);
    if (mode === "oauth") {
      // Store normalized id so lookups against `AuthProviderHealth.provider`
      // (which is already normalized by buildAuthHealthSummary) match despite
      // case-only differences in config provider keys.
      expectsOAuth.add(normalizeProviderId(id));
    }
  }
  // auth.profiles entries explicitly opt into the refreshable set via
  // `mode: oauth | token`. api_key profiles are excluded (no lifecycle).
  for (const profile of Object.values(cfg.auth?.profiles ?? {})) {
    const provider = profile?.provider;
    const mode = profile?.mode;
    if (
      typeof provider !== "string" ||
      provider.length === 0 ||
      (mode !== "oauth" && mode !== "token")
    ) {
      continue;
    }
    if (envBacked.has(normalizeProviderId(provider))) {
      continue;
    }
    out.add(provider);
    if (mode === "oauth") {
      expectsOAuth.add(normalizeProviderId(provider));
    }
  }
  return { providers: Array.from(out), expectsOAuth };
}

export const modelsAuthStatusHandlers: GatewayRequestHandlers = {
  "models.authLogout": async ({ params, respond, context }) => {
    const provider = readProviderParam(params);
    if (!provider) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "provider is required"));
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const agentDir = resolveDefaultAgentDir(cfg);
      const authProvider = resolveProviderIdForAuth(provider, { config: cfg });
      const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      const removedProfiles = listProfilesForProvider(store, provider);
      const removed = await removeProviderAuthProfilesAcrossOwnerStores({
        provider,
        agentDir,
        profileIds: removedProfiles,
      });
      if (!removed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to remove saved auth profiles for provider ${provider}`,
          ),
        );
        return;
      }
      await refreshActiveSecretsRuntimeSnapshot();
      invalidateModelAuthStatusCache();
      clearCurrentProviderAuthState();
      void warmCurrentProviderAuthStateOffMainThread(context.getRuntimeConfig()).catch(
        (err: unknown) => {
          log.warn(`provider auth state rewarm after logout failed: ${formatForLog(err)}`);
        },
      );
      const { runIds: abortedRunIds } = abortChatRunsForProvider(
        createAuthLogoutAbortOps(context),
        {
          providerId: authProvider,
          stopReason: "auth-revoked",
        },
      );
      const result: ModelAuthLogoutResult = {
        provider,
        removedProfiles,
        abortedRunIds,
      };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authStatus": async ({ params, respond, context }) => {
    const perf = createGatewayPerfStageTimer();
    const cpuStarted = process.cpuUsage();
    const usageProviderTimings: string[] = [];
    const logPerf = (message: string) => {
      const providerTimingSummary =
        usageProviderTimings.length > 0
          ? ` usageProviderTimings="${usageProviderTimings.join(" ")}"`
          : "";
      logGatewayPerfSummary({
        logger: log,
        surface: "models.authStatus",
        durationMs: perf.totalMs(),
        minInfoMs: 0,
        message:
          `${message}${providerTimingSummary} ${formatGatewayPerfCpuUsage(cpuStarted)} ` +
          `stages="${perf.summary()}"`,
      });
    };
    const now = Date.now();
    const bypassCache = Boolean((params as { refresh?: boolean } | undefined)?.refresh);
    perf.mark("cache_check");
    if (!bypassCache && cached && now - cached.ts < CACHE_TTL_MS) {
      perf.mark("cache_hit_response_build");
      logPerf("cached=true");
      respond(true, cached.result, undefined, { cached: true });
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      perf.mark("config_read");
      const agentDir = resolveDefaultAgentDir(cfg);
      perf.mark("agent_dir_resolve");
      // Use the external-profile-aware store for status reads so the dashboard
      // reflects CLI-discovered credentials without persisting them here.
      const externalCli = externalCliDiscoveryForConfigStatus({ cfg });
      perf.mark("external_cli_config");
      const store = ensureAuthProfileStore(agentDir, {
        externalCli,
      });
      perf.mark("auth_store_read");
      const configured = resolveConfiguredProviders(cfg);
      perf.mark("configured_providers");
      const authHealth: AuthHealthSummary = buildAuthHealthSummary({
        store,
        cfg,
        providers: configured.providers.length > 0 ? configured.providers : undefined,
      });
      perf.mark("auth_health");

      // Usage queries usually need refreshable credentials. Keep API-key status
      // enrichment explicit so static auth providers are not polled by default.
      const usageProviderIds = [
        ...new Set(
          authHealth.profiles
            .filter((p) => {
              if (p.type === "oauth" || p.type === "token") {
                return true;
              }
              const usageProvider = resolveUsageProviderId(p.provider, {
                credentialType: p.type,
              });
              return usageProvider ? apiKeyUsageStatusProviders.has(usageProvider) : false;
            })
            .map((p) => resolveUsageProviderId(p.provider, { credentialType: p.type }))
            .filter((id): id is UsageProviderId => Boolean(id)),
        ),
      ];
      perf.mark("usage_provider_ids");

      let usageByProvider = new Map<string, ProviderUsageStatus>();
      let usageCacheStatus:
        | "skipped"
        | "hit"
        | "stale"
        | "warming"
        | "inflight"
        | "miss"
        | "bypass" = "skipped";
      try {
        const usage = await loadUsageSummaryForAuthStatus({
          providers: usageProviderIds,
          agentDir,
          bypassCache,
          now,
          mark: (name) => perf.mark(name),
          measure: (name, durationMs) =>
            usageProviderTimings.push(`${name}=${formatGatewayPerfMs(durationMs)}ms`),
        });
        usageByProvider = usage.usageByProvider;
        usageCacheStatus = usage.cacheStatus;
      } catch (err) {
        // Usage data is auxiliary — failing here must not block auth status,
        // but log at debug so a silently-broken usage endpoint is still
        // diagnosable in gateway logs. Failed usage loads are not cached.
        log.debug(
          `usage enrichment failed (auth status still returned): providers=${usageProviderIds.join(",")} error=${formatForLog(err)}`,
        );
      }
      perf.mark("usage_summary");

      const providers = authHealth.providers.map((prov) =>
        mapProvider(prov, usageByProvider, configured.expectsOAuth),
      );
      perf.mark("map_providers");
      const result: ModelAuthStatusResult = { ts: now, providers };
      if (usageCacheStatus !== "warming" && usageCacheStatus !== "inflight") {
        cached = { ts: now, result };
      }
      perf.mark("response_build");
      logPerf(
        `cached=false refresh=${bypassCache} configuredProviders=${configured.providers.length} ` +
          `authProviders=${authHealth.providers.length} usageProviders=${usageProviderIds.length} ` +
          `usageCache=${usageCacheStatus} usageCacheTtlMs=${USAGE_SUMMARY_CACHE_TTL_MS} ` +
          `responseProviders=${providers.length}`,
      );
      respond(true, result, undefined);
    } catch (err) {
      perf.mark("error");
      logPerf("error=true");
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
