import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope-config.js";
import {
  externalCliDiscoveryForProviderAuth,
  externalCliDiscoveryForProviders,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  getRuntimeAuthProfileStoreSnapshot,
  listProfilesForProvider,
  type AuthProfileStore,
} from "./auth-profiles.js";
import {
  createRuntimeProviderAuthLookup,
  hasAvailableAuthForProvider,
  hasRuntimeAvailableProviderAuth,
  type RuntimeProviderAuthLookup,
} from "./model-auth.js";
import { loadModelCatalog } from "./model-catalog.js";
import { normalizeProviderId } from "./model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

// Prepared runtime fact: which providers have available auth given the
// current cfg + env. Populated explicitly at gateway startup and on config
// reload; consulted by hasAuthForModelProvider so every model-listing call
// (pickers, /models, status commands, CLI) skips the per-provider plugin
// discovery and external-CLI probing on the hot path.

type PreparedProviderAuthState = {
  agentId: string;
  configFingerprint: string;
  providers: ReadonlyMap<string, boolean>;
};

type ProviderAuthWarmTiming = {
  stages: string[];
  workerStartupTimings: string[];
  catalogTimings: string[];
  providerTimings: string[];
  providerCheckCount: number;
  duplicateProviderCheckCount: number;
  workerBootstrapMs?: number;
};

export type ProviderAuthWarmSnapshot = {
  agents: Array<{
    agentId: string;
    configFingerprint: string;
    providers: Array<[string, boolean]>;
  }>;
  timing?: ProviderAuthWarmTiming;
};

type ProviderAuthWarmWorkerResult =
  | {
      status: "ok";
      snapshot: ProviderAuthWarmSnapshot;
    }
  | {
      status: "failed";
      error: string;
    };

type ProviderAuthWarmRuntimeAuthStore = {
  agentDir?: string;
  store: AuthProfileStore;
};

type ProviderAuthWarmRuntimeAuthLookup = {
  agentId: string;
  lookup: RuntimeProviderAuthLookup;
};

type ProviderAuthWarmWorkerRunner = (params: {
  cfg: OpenClawConfig;
  runtimeAuthStores?: ProviderAuthWarmRuntimeAuthStore[];
  runtimeAuthLookups?: ProviderAuthWarmRuntimeAuthLookup[];
  omitFalseProviderAuth?: boolean;
  timeoutMs: number;
  isCancelled: () => boolean;
  workerUrl?: URL;
}) => Promise<ProviderAuthWarmSnapshot>;

type ProviderAuthCheckTimingRecorder = (stage: string, durationMs: number, extra?: string) => void;

const PROVIDER_AUTH_WARM_WORKER_TIMEOUT_MS = 120_000;
const PROVIDER_AUTH_WARM_CANCEL_POLL_MS = 25;
const PROVIDER_AUTH_WARM_PERF_INFO_THRESHOLD_MS = 250;
const PROVIDER_AUTH_WARM_PERF_WARN_THRESHOLD_MS = 1_000;
const log = createSubsystemLogger("model-provider-auth");

function formatProviderAuthWarmPerfMs(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "n/a";
}

function readProviderAuthWarmTimingMs(
  timings: readonly string[] | undefined,
  name: string,
): number | undefined {
  const prefix = `${name}=`;
  const value = timings?.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!value?.endsWith("ms")) {
    return undefined;
  }
  const parsed = Number(value.slice(0, -"ms".length));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createProviderAuthWarmStageTimer(): {
  mark: (name: string) => void;
  markValue: (name: string, durationMs: number) => void;
  totalMs: () => number;
  entries: () => string[];
  summary: () => string;
} {
  const started = performance.now();
  let last = started;
  const stages: string[] = [];
  return {
    mark(name: string) {
      const now = performance.now();
      stages.push(`${name}=${formatProviderAuthWarmPerfMs(now - last)}ms`);
      last = now;
    },
    markValue(name: string, durationMs: number) {
      stages.push(`${name}=${formatProviderAuthWarmPerfMs(durationMs)}ms`);
    },
    totalMs() {
      return performance.now() - started;
    },
    entries() {
      return [...stages];
    },
    summary() {
      return stages.join(" ");
    },
  };
}

function logProviderAuthWarmPerf(params: { durationMs: number; message: string }): void {
  if (params.durationMs < PROVIDER_AUTH_WARM_PERF_INFO_THRESHOLD_MS) {
    return;
  }
  const threshold =
    params.durationMs >= PROVIDER_AUTH_WARM_PERF_WARN_THRESHOLD_MS
      ? "slow_handler_warn"
      : "slow_handler_info";
  const line =
    `[perf:provider-auth-warm] durationMs=${formatProviderAuthWarmPerfMs(params.durationMs)} ` +
    `threshold=${threshold} ${params.message}`;
  if (params.durationMs >= PROVIDER_AUTH_WARM_PERF_WARN_THRESHOLD_MS) {
    log.warn(line);
  } else {
    log.info(line);
  }
}

// One entry per configured agent, keyed by agentId. Populated by the provider
// auth warm path; consulted by hasAuthForModelProvider on every model-listing call.
let currentProviderAuthStates: ReadonlyMap<string, PreparedProviderAuthState> | null = null;
const configFingerprintCache = new WeakMap<OpenClawConfig, string>();
// Generation counter guards against an in-flight warm publishing stale
// state after a subsequent warm or clear has invalidated it.
let currentProviderAuthStateGeneration = 0;
let currentProviderAuthWarmWorker:
  | {
      worker: Worker;
      cancelled: boolean;
    }
  | undefined;

function cancelCurrentProviderAuthWarmWorker(): void {
  const current = currentProviderAuthWarmWorker;
  if (!current) {
    return;
  }
  current.cancelled = true;
  currentProviderAuthWarmWorker = undefined;
  void current.worker.terminate();
}

export function clearCurrentProviderAuthState(): void {
  currentProviderAuthStates = null;
  currentProviderAuthStateGeneration += 1;
  cancelCurrentProviderAuthWarmWorker();
}

function resolvePreparedStateForCaller(params: {
  states: ReadonlyMap<string, PreparedProviderAuthState> | null;
  cfg: OpenClawConfig | undefined;
  callerAgentId: string | undefined;
}): PreparedProviderAuthState | null {
  if (!params.states) {
    return null;
  }
  if (params.callerAgentId !== undefined) {
    return params.states.get(params.callerAgentId) ?? null;
  }
  // Caller didn't pass agentId: treat as a query against the default agent.
  if (!params.cfg) {
    return null;
  }
  return params.states.get(resolveDefaultAgentId(params.cfg)) ?? null;
}

function resolveProviderAuthConfigFingerprint(cfg: OpenClawConfig | undefined): string | null {
  if (!cfg) {
    return null;
  }
  const cached = configFingerprintCache.get(cfg);
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = hashRuntimeConfigValue(cfg);
  configFingerprintCache.set(cfg, fingerprint);
  return fingerprint;
}

export async function hasAuthForModelProvider(params: {
  provider: string;
  modelApi?: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  store?: AuthProfileStore;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
  runtimeAuthLookup?: RuntimeProviderAuthLookup;
  resolveRuntimeAuthLookup?: () => RuntimeProviderAuthLookup;
  timingRecorder?: ProviderAuthCheckTimingRecorder;
}): Promise<boolean> {
  const checkStarted = performance.now();
  const recordTiming = (stage: string, started: number, extra?: string) => {
    params.timingRecorder?.(stage, performance.now() - started, extra);
  };
  const provider = normalizeProviderId(params.provider);
  // The prepared map is built by the provider auth warm path — one entry per
  // configured agent, keyed by agentId. Only consult it when the caller's
  // full auth context matches the warmed scope; otherwise fall through to
  // compute so callers that narrow the scope — e.g. gateway `models.list`
  // with `runtimeAuthDiscovery: false`, or callers with a non-warmed
  // workspaceDir — get the answer they asked for.
  const preparedStates = currentProviderAuthStates;
  const workspaceDir = params.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const configFingerprint = resolveProviderAuthConfigFingerprint(params.cfg);
  const preparedState = resolvePreparedStateForCaller({
    states: preparedStates,
    cfg: params.cfg,
    callerAgentId: params.agentId,
  });
  // workspaceDir is a pure function of (cfg, agentId), so we recompute the
  // warmer's expected value at read time rather than storing it. Caller can
  // still override workspaceDir explicitly — that forces a mismatch and
  // falls through to the compute path.
  const expectedWorkspaceDir =
    preparedState !== null && params.cfg
      ? resolveAgentWorkspaceDir(params.cfg, preparedState.agentId)
      : null;
  const expectedAgentDir =
    preparedState !== null && params.cfg
      ? resolveAgentDir(params.cfg, preparedState.agentId)
      : null;
  const matchesWarmedScope =
    preparedState !== null &&
    configFingerprint === preparedState.configFingerprint &&
    workspaceDir === expectedWorkspaceDir &&
    (params.agentDir === undefined || params.agentDir === expectedAgentDir) &&
    params.discoverExternalCliAuth !== false &&
    params.allowPluginSyntheticAuth !== false &&
    params.env === undefined &&
    params.store === undefined &&
    params.modelApi === undefined;
  if (matchesWarmedScope) {
    const preparedAnswer = preparedState.providers.get(provider);
    if (preparedAnswer !== undefined) {
      recordTiming(
        "prepared_state_hit",
        checkStarted,
        preparedAnswer ? "result_true" : "result_false",
      );
      return preparedAnswer;
    }
  }
  recordTiming("prepared_state_miss", checkStarted);
  const yieldStarted = performance.now();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  recordTiming("event_loop_yield", yieldStarted);
  const runtimeAuthStarted = performance.now();
  if (
    hasRuntimeAvailableProviderAuth({
      provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
      runtimeLookup: params.runtimeAuthLookup ?? params.resolveRuntimeAuthLookup?.(),
      modelApi: params.modelApi,
    })
  ) {
    recordTiming("runtime_auth", runtimeAuthStarted, "result_true");
    return true;
  }
  recordTiming("runtime_auth", runtimeAuthStarted, "result_false");
  const slowPathAgentDir =
    params.agentDir ??
    (params.agentId && params.cfg
      ? resolveAgentDir(params.cfg, params.agentId, params.env)
      : undefined);
  let externalCli: ReturnType<typeof externalCliDiscoveryForProviderAuth> | undefined;
  if (!params.store && params.discoverExternalCliAuth !== false) {
    const externalCliStarted = performance.now();
    externalCli = externalCliDiscoveryForProviderAuth({ cfg: params.cfg, provider });
    recordTiming("external_cli_config", externalCliStarted);
  }
  const authStoreStarted = performance.now();
  const store =
    params.store ??
    (params.discoverExternalCliAuth === false
      ? ensureAuthProfileStoreWithoutExternalProfiles(slowPathAgentDir, {
          allowKeychainPrompt: false,
        })
      : ensureAuthProfileStore(slowPathAgentDir, {
          ...(externalCli ? { externalCli } : {}),
        }));
  recordTiming("auth_store", authStoreStarted, params.store ? "provided_store" : "loaded_store");
  const profileListStarted = performance.now();
  const profiles = listProfilesForProvider(store, provider);
  recordTiming("profile_list", profileListStarted, `profiles_${profiles.length}`);
  if (profiles.length > 0) {
    if (params.modelApi === undefined) {
      recordTiming("complete", checkStarted, "result_true");
      return true;
    }
    const availableAuthStarted = performance.now();
    const available = await hasAvailableAuthForProvider({
      provider,
      modelApi: params.modelApi,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: slowPathAgentDir,
      store,
    });
    recordTiming(
      "available_auth",
      availableAuthStarted,
      available ? "result_true" : "result_false",
    );
    recordTiming("complete", checkStarted, available ? "result_true" : "result_false");
    return available;
  }
  recordTiming("complete", checkStarted, "result_false");
  return false;
}

export function createProviderAuthChecker(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
}): (provider: string, modelApi?: string) => Promise<boolean> {
  const authCache = new Map<string, boolean>();
  let runtimeAuthLookup: RuntimeProviderAuthLookup | undefined;
  return async (provider: string, modelApi?: string) => {
    const key = normalizeProviderId(provider);
    const cacheKey = modelApi === undefined ? key : `${key}\0${modelApi}`;
    const cached = authCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const value = await hasAuthForModelProvider({
      provider: key,
      modelApi,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      agentId: params.agentId,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
      discoverExternalCliAuth: params.discoverExternalCliAuth,
      resolveRuntimeAuthLookup: () =>
        (runtimeAuthLookup ??= createRuntimeProviderAuthLookup({
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          env: params.env,
          includePluginSyntheticAuth: params.allowPluginSyntheticAuth !== false,
        })),
    });
    authCache.set(cacheKey, value);
    return value;
  };
}

function serializeProviderAuthStates(
  states: ReadonlyMap<string, PreparedProviderAuthState>,
  timing?: ProviderAuthWarmTiming,
): ProviderAuthWarmSnapshot {
  return {
    agents: [...states.values()].map((state) => ({
      agentId: state.agentId,
      configFingerprint: state.configFingerprint,
      providers: [...state.providers.entries()],
    })),
    ...(timing ? { timing } : {}),
  };
}

function publishProviderAuthWarmSnapshot(snapshot: ProviderAuthWarmSnapshot): void {
  currentProviderAuthStates = new Map(
    snapshot.agents.map((state) => [
      state.agentId,
      {
        agentId: state.agentId,
        configFingerprint: state.configFingerprint,
        providers: new Map(state.providers),
      },
    ]),
  );
}

function resolveProviderConfigApi(
  cfg: OpenClawConfig | undefined,
  provider: string,
): string | undefined {
  const providers = cfg?.models?.providers ?? {};
  const direct = providers[provider];
  if (direct?.api) {
    return direct.api;
  }
  const normalized = normalizeProviderId(provider);
  const matched = Object.entries(providers).find(
    ([key]) => normalizeProviderId(key) === normalized,
  )?.[1];
  return matched?.api;
}

function shouldOmitFalsePreparedAuthForProcessSyntheticProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  runtimeAuthLookup: RuntimeProviderAuthLookup;
}): boolean {
  const syntheticRefs = params.runtimeAuthLookup.syntheticAuthProviderRefs;
  if (!syntheticRefs?.length) {
    return false;
  }
  const eligibleRefs = new Set(syntheticRefs.map((ref) => normalizeProviderId(ref)));
  const providerApi = resolveProviderConfigApi(params.cfg, params.provider);
  return [params.provider, providerApi]
    .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
    .some((ref) => eligibleRefs.has(normalizeProviderId(ref)));
}

async function hasAuthForProviderWarmSnapshot(params: {
  provider: string;
  cfg: OpenClawConfig;
  workspaceDir: string;
  store: AuthProfileStore;
  runtimeAuthLookup: RuntimeProviderAuthLookup;
  timingRecorder: ProviderAuthCheckTimingRecorder;
}): Promise<boolean> {
  const checkStarted = performance.now();
  const provider = normalizeProviderId(params.provider);
  const recordTiming = (stage: string, started: number, extra?: string) => {
    params.timingRecorder(stage, performance.now() - started, extra);
  };
  const runtimeAuthStarted = performance.now();
  if (
    hasRuntimeAvailableProviderAuth({
      provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      runtimeLookup: params.runtimeAuthLookup,
    })
  ) {
    recordTiming("runtime_auth", runtimeAuthStarted, "result_true");
    recordTiming("complete", checkStarted, "result_true");
    return true;
  }
  recordTiming("runtime_auth", runtimeAuthStarted, "result_false");
  const profileListStarted = performance.now();
  const profiles = listProfilesForProvider(params.store, provider);
  recordTiming("profile_list", profileListStarted, `profiles_${profiles.length}`);
  const available = profiles.length > 0;
  recordTiming("complete", checkStarted, available ? "result_true" : "result_false");
  return available;
}

export async function buildCurrentProviderAuthStateSnapshot(
  cfg: OpenClawConfig,
  options: {
    isCancelled?: () => boolean;
    readOnlyAuthStore?: boolean;
    runtimeAuthLookups?: ReadonlyMap<string, RuntimeProviderAuthLookup>;
    omitFalseProviderAuth?: boolean;
    workerBootstrapMs?: number;
    workerStartupTimings?: string[];
  } = {},
): Promise<ProviderAuthWarmSnapshot> {
  const perf = createProviderAuthWarmStageTimer();
  const catalogTimings: string[] = [];
  const providerTimings: string[] = [];
  const workerStartupTimings = options.workerStartupTimings
    ? [...options.workerStartupTimings]
    : [];
  const seenProviderChecks = new Set<string>();
  let providerCheckCount = 0;
  let duplicateProviderCheckCount = 0;
  if (options.workerBootstrapMs !== undefined) {
    perf.markValue("worker_startup_bootstrap", options.workerBootstrapMs);
  }
  const isWarmStale = () => options.isCancelled?.() === true;
  perf.mark("auth_snapshot_start");
  const catalog = await loadModelCatalog({
    config: cfg,
    readOnly: true,
    timingRecorder: (stage, durationMs, extra) => {
      catalogTimings.push(
        `catalog_${sanitizeProviderAuthWarmMetricPart(stage)}=${formatProviderAuthWarmPerfMs(
          durationMs,
        )}ms${extra ? `(${sanitizeProviderAuthWarmMetricPart(extra)})` : ""}`,
      );
    },
  });
  perf.mark("catalog_load");
  if (isWarmStale()) {
    return {
      agents: [],
      timing: {
        stages: perf.entries(),
        workerStartupTimings,
        catalogTimings,
        providerTimings,
        providerCheckCount,
        duplicateProviderCheckCount,
        ...(options.workerBootstrapMs !== undefined
          ? { workerBootstrapMs: options.workerBootstrapMs }
          : {}),
      },
    };
  }
  const providers = new Set<string>();
  for (const entry of catalog) {
    providers.add(normalizeProviderId(entry.provider));
  }
  const providerList = [...providers];
  perf.mark("provider_enumeration");
  const agentIds = listAgentIds(cfg);
  perf.mark("agent_list_build");
  const configFingerprint = resolveProviderAuthConfigFingerprint(cfg) ?? "";
  perf.mark("config_fingerprint");
  const states = new Map<string, PreparedProviderAuthState>();
  // Warm one entry per configured agent so callers hit the prepared map for
  // any agentId. The catalog above is shared across agents; the per-agent
  // work is the auth-discovery sweep against that agent's store.
  for (const agentId of agentIds) {
    if (isWarmStale()) {
      return {
        agents: [],
        timing: {
          stages: perf.entries(),
          workerStartupTimings,
          catalogTimings,
          providerTimings,
          providerCheckCount,
          duplicateProviderCheckCount,
          ...(options.workerBootstrapMs !== undefined
            ? { workerBootstrapMs: options.workerBootstrapMs }
            : {}),
        },
      };
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
    perf.mark(`agent_${sanitizeProviderAuthWarmMetricPart(agentId)}_scope_resolve`);
    const runtimeAuthLookup =
      options.runtimeAuthLookups?.get(agentId) ??
      createRuntimeProviderAuthLookup({
        cfg,
        workspaceDir,
      });
    perf.mark(`agent_${sanitizeProviderAuthWarmMetricPart(agentId)}_runtime_lookup`);
    // One AuthProfileStore scoped to every candidate provider; without this
    // the per-provider externalCli discovery rebuilds the store ~N times.
    const externalCli = externalCliDiscoveryForProviders({
      cfg,
      providers: providerList,
    });
    perf.mark(`agent_${sanitizeProviderAuthWarmMetricPart(agentId)}_external_cli_config`);
    const store = options.readOnlyAuthStore
      ? ensureAuthProfileStore(agentDir, {
          config: cfg,
          externalCli,
          readOnly: true,
          syncExternalCli: false,
        })
      : ensureAuthProfileStore(agentDir, {
          config: cfg,
          externalCli,
        });
    perf.mark(`agent_${sanitizeProviderAuthWarmMetricPart(agentId)}_auth_store_read`);
    const state = new Map<string, boolean>();
    perf.mark(`agent_${sanitizeProviderAuthWarmMetricPart(agentId)}_provider_task_build`);
    for (const provider of providers) {
      if (isWarmStale()) {
        return {
          agents: [],
          timing: {
            stages: perf.entries(),
            workerStartupTimings,
            catalogTimings,
            providerTimings,
            providerCheckCount,
            duplicateProviderCheckCount,
            ...(options.workerBootstrapMs !== undefined
              ? { workerBootstrapMs: options.workerBootstrapMs }
              : {}),
          },
        };
      }
      providerCheckCount += 1;
      const providerCheckKey = `${agentId}\0${provider}`;
      if (seenProviderChecks.has(providerCheckKey)) {
        duplicateProviderCheckCount += 1;
      } else {
        seenProviderChecks.add(providerCheckKey);
      }
      const providerCheckStart = performance.now();
      const value = await hasAuthForProviderWarmSnapshot({
        provider,
        cfg,
        workspaceDir,
        store,
        runtimeAuthLookup,
        timingRecorder: (stage, durationMs, extra) => {
          providerTimings.push(
            `provider_auth_check_phase_${sanitizeProviderAuthWarmMetricPart(
              agentId,
            )}_${sanitizeProviderAuthWarmMetricPart(
              provider,
            )}_${sanitizeProviderAuthWarmMetricPart(stage)}=${formatProviderAuthWarmPerfMs(
              durationMs,
            )}ms${extra ? `(${sanitizeProviderAuthWarmMetricPart(extra)})` : ""}`,
          );
        },
      });
      providerTimings.push(
        `provider_auth_check_${sanitizeProviderAuthWarmMetricPart(agentId)}_${sanitizeProviderAuthWarmMetricPart(provider)}=${formatProviderAuthWarmPerfMs(
          performance.now() - providerCheckStart,
        )}ms`,
      );
      if (
        !value &&
        (options.omitFalseProviderAuth ||
          shouldOmitFalsePreparedAuthForProcessSyntheticProvider({
            cfg,
            provider,
            runtimeAuthLookup,
          }))
      ) {
        continue;
      }
      state.set(provider, value);
    }
    states.set(agentId, {
      agentId,
      configFingerprint,
      providers: state,
    });
    perf.mark(`agent_${sanitizeProviderAuthWarmMetricPart(agentId)}_complete`);
  }
  perf.mark("result_aggregation");
  perf.mark("serialize_snapshot");
  return serializeProviderAuthStates(states, {
    stages: perf.entries(),
    workerStartupTimings,
    catalogTimings,
    providerTimings,
    providerCheckCount,
    duplicateProviderCheckCount,
    ...(options.workerBootstrapMs !== undefined
      ? { workerBootstrapMs: options.workerBootstrapMs }
      : {}),
  });
}

export async function warmCurrentProviderAuthState(
  cfg: OpenClawConfig,
  options: { isCancelled?: () => boolean } = {},
): Promise<void> {
  // Claim a fresh generation; any concurrent warm or clear bumps this and
  // turns our published state stale.
  currentProviderAuthStateGeneration += 1;
  const ownGeneration = currentProviderAuthStateGeneration;
  const isWarmStale = () =>
    options.isCancelled?.() === true || ownGeneration !== currentProviderAuthStateGeneration;
  const snapshot = await buildCurrentProviderAuthStateSnapshot(cfg, {
    isCancelled: isWarmStale,
  });
  if (isWarmStale()) {
    return;
  }
  if (options.isCancelled?.() || ownGeneration !== currentProviderAuthStateGeneration) {
    // A newer warm or clear ran while we were building; skip publication so
    // the newer answer wins.
    return;
  }
  publishProviderAuthWarmSnapshot(snapshot);
}

function resolveProviderAuthWarmWorkerUrl(currentModuleUrl: string): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const distMarker = `${path.sep}dist${path.sep}`;
  const distIndex = currentPath.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length - 1);
    return pathToFileURL(path.join(distRoot, "agents", "model-provider-auth.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./model-provider-auth.worker${extension}`, currentModuleUrl);
}

function isProviderAuthWarmSnapshot(value: unknown): value is ProviderAuthWarmSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { agents?: unknown }).agents)
  ) {
    return false;
  }
  return (value as ProviderAuthWarmSnapshot).agents.every(
    (agent) =>
      typeof agent.agentId === "string" &&
      typeof agent.configFingerprint === "string" &&
      Array.isArray(agent.providers) &&
      agent.providers.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "boolean",
      ),
  );
}

function isProviderAuthWarmWorkerResult(value: unknown): value is ProviderAuthWarmWorkerResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as ProviderAuthWarmWorkerResult;
  if (result.status === "failed") {
    return typeof result.error === "string";
  }
  return result.status === "ok" && isProviderAuthWarmSnapshot(result.snapshot);
}

function createProviderAuthWarmPresenceStore(store: AuthProfileStore): AuthProfileStore {
  const profiles: AuthProfileStore["profiles"] = {};
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    profiles[profileId] = {
      type: "api_key",
      provider: credential.provider,
    };
  }
  return {
    version: store.version,
    profiles,
  };
}

function collectProviderAuthWarmRuntimeAuthStores(
  cfg: OpenClawConfig,
): ProviderAuthWarmRuntimeAuthStore[] {
  const entries: ProviderAuthWarmRuntimeAuthStore[] = [];
  const seen = new Set<string | undefined>();
  const addStore = (agentDir?: string) => {
    if (seen.has(agentDir)) {
      return;
    }
    seen.add(agentDir);
    const store = getRuntimeAuthProfileStoreSnapshot(agentDir);
    if (!store) {
      return;
    }
    entries.push({
      ...(agentDir === undefined ? {} : { agentDir }),
      store: createProviderAuthWarmPresenceStore(store),
    });
  };

  addStore();
  for (const agentId of listAgentIds(cfg)) {
    addStore(resolveAgentDir(cfg, agentId));
  }
  return entries;
}

function collectProviderAuthWarmRuntimeAuthLookups(cfg: OpenClawConfig): {
  entries: ProviderAuthWarmRuntimeAuthLookup[];
  omitFalseProviderAuth: boolean;
} {
  const entries: ProviderAuthWarmRuntimeAuthLookup[] = [];
  let omitFalseProviderAuth = false;
  for (const agentId of listAgentIds(cfg)) {
    const lookup = createRuntimeProviderAuthLookup({
      cfg,
      workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    });
    if (lookup.syntheticAuthProviderRefsComplete === false) {
      omitFalseProviderAuth = true;
    }
    entries.push({ agentId, lookup });
  }
  return { entries, omitFalseProviderAuth };
}

function runProviderAuthWarmWorker(params: {
  cfg: OpenClawConfig;
  runtimeAuthStores?: ProviderAuthWarmRuntimeAuthStore[];
  runtimeAuthLookups?: ProviderAuthWarmRuntimeAuthLookup[];
  omitFalseProviderAuth?: boolean;
  timeoutMs: number;
  isCancelled: () => boolean;
  workerUrl?: URL;
}): Promise<ProviderAuthWarmSnapshot> {
  const parentStartedAtEpochMs = Date.now();
  let workerConstructorReturnedAtEpochMs = parentStartedAtEpochMs;
  let workerOnlineAtEpochMs: number | undefined;
  const worker = new Worker(params.workerUrl ?? resolveProviderAuthWarmWorkerUrl(import.meta.url), {
    workerData: {
      cfg: params.cfg,
      parentStartedAtEpochMs,
      ...(params.runtimeAuthStores?.length ? { runtimeAuthStores: params.runtimeAuthStores } : {}),
      ...(params.runtimeAuthLookups?.length
        ? { runtimeAuthLookups: params.runtimeAuthLookups }
        : {}),
      ...(params.omitFalseProviderAuth ? { omitFalseProviderAuth: true } : {}),
    },
  });
  workerConstructorReturnedAtEpochMs = Date.now();
  worker.unref?.();
  const handle = {
    worker,
    cancelled: false,
  };
  const appendParentStartupTimings = (snapshot: ProviderAuthWarmSnapshot) => {
    const messageReceivedAtEpochMs = Date.now();
    const messageReceivedSinceStartMs = Math.max(
      0,
      messageReceivedAtEpochMs - parentStartedAtEpochMs,
    );
    const timing = snapshot.timing;
    if (!timing) {
      return;
    }
    timing.workerStartupTimings.push(
      `worker_parent_constructor_return=${Math.max(
        0,
        workerConstructorReturnedAtEpochMs - parentStartedAtEpochMs,
      )}ms`,
    );
    if (workerOnlineAtEpochMs !== undefined) {
      const workerOnlineSinceStartMs = Math.max(0, workerOnlineAtEpochMs - parentStartedAtEpochMs);
      const appendOnlineDelta = (targetName: string, derivedName: string) => {
        const targetMs = readProviderAuthWarmTimingMs(timing.workerStartupTimings, targetName);
        if (targetMs === undefined) {
          return;
        }
        timing.workerStartupTimings.push(
          `${derivedName}=${Math.max(0, targetMs - workerOnlineSinceStartMs)}ms`,
        );
      };
      timing.workerStartupTimings.push(`worker_parent_online=${workerOnlineSinceStartMs}ms`);
      appendOnlineDelta(
        "worker_startup_process_module_load",
        "worker_parent_online_to_module_load",
      );
      appendOnlineDelta(
        "worker_startup_before_auth_snapshot",
        "worker_parent_online_to_auth_snapshot_start",
      );
      appendOnlineDelta("worker_auth_snapshot_end", "worker_parent_online_to_auth_snapshot_end");
      appendOnlineDelta("worker_result_ready", "worker_parent_online_to_result_ready");
      appendOnlineDelta(
        "worker_result_message_send",
        "worker_parent_online_to_worker_message_send",
      );
      timing.workerStartupTimings.push(
        `worker_parent_online_to_message=${Math.max(
          0,
          messageReceivedAtEpochMs - workerOnlineAtEpochMs,
        )}ms`,
      );
      const workerMessageSendMs = readProviderAuthWarmTimingMs(
        timing.workerStartupTimings,
        "worker_result_message_send",
      );
      if (workerMessageSendMs !== undefined) {
        timing.workerStartupTimings.push(
          `worker_parent_worker_send_to_message=${Math.max(
            0,
            messageReceivedSinceStartMs - workerMessageSendMs,
          )}ms`,
        );
      }
    }
    timing.workerStartupTimings.push(
      `worker_parent_message_received=${messageReceivedSinceStartMs}ms`,
    );
  };
  currentProviderAuthWarmWorker = handle;
  return new Promise<ProviderAuthWarmSnapshot>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (currentProviderAuthWarmWorker === handle) {
        currentProviderAuthWarmWorker = undefined;
      }
      if (timer) {
        clearTimeout(timer);
      }
      if (cancelTimer) {
        clearInterval(cancelTimer);
      }
      complete();
    };
    const cancelWorker = () => {
      handle.cancelled = true;
      void worker.terminate();
      finish(() => resolve({ agents: [] }));
    };
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      handle.cancelled = true;
      void worker.terminate();
      finish(() => reject(new Error("provider auth warm worker timed out")));
    }, params.timeoutMs);
    timer.unref?.();
    const cancelTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      if (params.isCancelled()) {
        cancelWorker();
      }
    }, PROVIDER_AUTH_WARM_CANCEL_POLL_MS);
    cancelTimer.unref?.();
    worker.once("online", () => {
      workerOnlineAtEpochMs = Date.now();
    });
    worker.once("message", (message: unknown) => {
      void worker.terminate();
      finish(() => {
        if (handle.cancelled) {
          resolve({ agents: [] });
          return;
        }
        if (!isProviderAuthWarmWorkerResult(message)) {
          reject(new Error("invalid provider auth warm worker response"));
          return;
        }
        if (message.status === "failed") {
          reject(new Error(message.error));
          return;
        }
        appendParentStartupTimings(message.snapshot);
        resolve(message.snapshot);
      });
    });
    worker.once("error", (error) => {
      finish(() => {
        if (handle.cancelled) {
          resolve({ agents: [] });
          return;
        }
        reject(toLintErrorObject(error, "Non-Error rejection"));
      });
    });
    worker.once("exit", (code) => {
      if (settled || code === 0) {
        return;
      }
      finish(() => {
        if (handle.cancelled) {
          resolve({ agents: [] });
          return;
        }
        reject(new Error(`provider auth warm worker exited with code ${code}`));
      });
    });
    if (params.isCancelled()) {
      cancelWorker();
    }
  });
}

export async function warmCurrentProviderAuthStateOffMainThread(
  cfg: OpenClawConfig,
  options: {
    isCancelled?: () => boolean;
    timeoutMs?: number;
    workerUrl?: URL;
    runWorker?: ProviderAuthWarmWorkerRunner;
  } = {},
): Promise<void> {
  const perf = createProviderAuthWarmStageTimer();
  currentProviderAuthStateGeneration += 1;
  const ownGeneration = currentProviderAuthStateGeneration;
  cancelCurrentProviderAuthWarmWorker();
  perf.mark("generation_claim");
  const isWarmStale = () =>
    options.isCancelled?.() === true || ownGeneration !== currentProviderAuthStateGeneration;
  if (isWarmStale()) {
    perf.mark("cancelled_before_start");
    logProviderAuthWarmPerf({
      durationMs: perf.totalMs(),
      message: `cancelled=true phase=before_start stages="${perf.summary()}"`,
    });
    return;
  }
  const runtimeAuthStores = collectProviderAuthWarmRuntimeAuthStores(cfg);
  perf.mark("runtime_auth_state_read");
  const runtimeAuthLookups = collectProviderAuthWarmRuntimeAuthLookups(cfg);
  perf.mark("runtime_auth_lookup_build");
  const snapshot = await (options.runWorker ?? runProviderAuthWarmWorker)({
    cfg,
    ...(runtimeAuthStores.length ? { runtimeAuthStores } : {}),
    ...(runtimeAuthLookups.entries.length
      ? { runtimeAuthLookups: runtimeAuthLookups.entries }
      : {}),
    ...(runtimeAuthLookups.omitFalseProviderAuth ? { omitFalseProviderAuth: true } : {}),
    timeoutMs: options.timeoutMs ?? PROVIDER_AUTH_WARM_WORKER_TIMEOUT_MS,
    isCancelled: isWarmStale,
    workerUrl: options.workerUrl,
  });
  perf.mark("worker_run");
  if (isWarmStale()) {
    perf.mark("cancelled_after_worker");
    logProviderAuthWarmPerf({
      durationMs: perf.totalMs(),
      message:
        `cancelled=true phase=after_worker runtimeStores=${runtimeAuthStores.length} ` +
        `runtimeLookups=${runtimeAuthLookups.entries.length} agents=${snapshot.agents.length} ` +
        formatProviderAuthWarmTimingForLog(snapshot.timing) +
        `stages="${perf.summary()}"`,
    });
    return;
  }
  publishProviderAuthWarmSnapshot(snapshot);
  perf.mark("publish_snapshot");
  logProviderAuthWarmPerf({
    durationMs: perf.totalMs(),
    message:
      `cancelled=false runtimeStores=${runtimeAuthStores.length} ` +
      `runtimeLookups=${runtimeAuthLookups.entries.length} agents=${snapshot.agents.length} ` +
      `providerEntries=${snapshot.agents.reduce((sum, agent) => sum + agent.providers.length, 0)} ` +
      formatProviderAuthWarmTimingForLog(snapshot.timing) +
      `stages="${perf.summary()}"`,
  });
}

function sanitizeProviderAuthWarmMetricPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "unknown";
}

function formatProviderAuthWarmTimingForLog(timing: ProviderAuthWarmTiming | undefined): string {
  if (!timing) {
    return "";
  }
  return (
    `workerStages="${timing.stages.join(" ")}" ` +
    `workerStartupTimings="${timing.workerStartupTimings.join(" ")}" ` +
    `catalogLoadTimings="${timing.catalogTimings.join(" ")}" ` +
    `providerAuthTimings="${timing.providerTimings.join(" ")}" ` +
    `providerAuthChecks=${timing.providerCheckCount} ` +
    `duplicateProviderAuthChecks=${timing.duplicateProviderCheckCount} `
  );
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
