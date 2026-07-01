import { parentPort, workerData } from "node:worker_threads";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { replaceRuntimeAuthProfileStoreSnapshots, type AuthProfileStore } from "./auth-profiles.js";
import type { RuntimeProviderAuthLookup } from "./model-auth.js";
import { buildCurrentProviderAuthStateSnapshot } from "./model-provider-auth.js";

const workerModuleLoadedAtEpochMs = Date.now();

type ProviderAuthWarmRuntimeAuthStore = {
  agentDir?: string;
  store: AuthProfileStore;
};

type ProviderAuthWarmWorkerInput = {
  cfg: OpenClawConfig;
  parentStartedAtEpochMs?: number;
  runtimeAuthStores?: ProviderAuthWarmRuntimeAuthStore[];
  runtimeAuthLookups?: Array<{
    agentId: string;
    lookup: RuntimeProviderAuthLookup;
  }>;
  omitFalseProviderAuth?: boolean;
};

type ProviderAuthWarmWorkerResult =
  | {
      status: "ok";
      snapshot: Awaited<ReturnType<typeof buildCurrentProviderAuthStateSnapshot>>;
    }
  | {
      status: "failed";
      error: string;
    };

function isWorkerInput(value: unknown): value is ProviderAuthWarmWorkerInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    "cfg" in record &&
    (!("parentStartedAtEpochMs" in record) || typeof record.parentStartedAtEpochMs === "number") &&
    (!("runtimeAuthStores" in record) || Array.isArray(record.runtimeAuthStores)) &&
    (!("runtimeAuthLookups" in record) || Array.isArray(record.runtimeAuthLookups)) &&
    (!("omitFalseProviderAuth" in record) || typeof record.omitFalseProviderAuth === "boolean")
  );
}

export async function runProviderAuthWarmWorkerInput(
  input: unknown,
): Promise<ProviderAuthWarmWorkerResult> {
  if (!isWorkerInput(input)) {
    return {
      status: "failed",
      error: "invalid provider auth warm worker input",
    };
  }
  try {
    const inputValidatedAtEpochMs = Date.now();
    if (input.runtimeAuthStores?.length) {
      replaceRuntimeAuthProfileStoreSnapshots(input.runtimeAuthStores);
    }
    const runtimeStoresRestoredAtEpochMs = Date.now();
    const workerStartupTimings =
      typeof input.parentStartedAtEpochMs === "number"
        ? [
            `worker_startup_process_module_load=${Math.max(
              0,
              workerModuleLoadedAtEpochMs - input.parentStartedAtEpochMs,
            )}ms`,
            `worker_startup_input_validate=${Math.max(
              0,
              inputValidatedAtEpochMs - workerModuleLoadedAtEpochMs,
            )}ms`,
            `worker_startup_runtime_store_restore=${Math.max(
              0,
              runtimeStoresRestoredAtEpochMs - inputValidatedAtEpochMs,
            )}ms`,
            `worker_startup_before_auth_snapshot=${Math.max(
              0,
              runtimeStoresRestoredAtEpochMs - input.parentStartedAtEpochMs,
            )}ms`,
          ]
        : undefined;
    const snapshot = await buildCurrentProviderAuthStateSnapshot(input.cfg, {
      readOnlyAuthStore: true,
      runtimeAuthLookups: new Map(
        input.runtimeAuthLookups?.map(({ agentId, lookup }) => [agentId, lookup]),
      ),
      omitFalseProviderAuth: input.omitFalseProviderAuth,
      ...(typeof input.parentStartedAtEpochMs === "number"
        ? { workerBootstrapMs: Date.now() - input.parentStartedAtEpochMs }
        : {}),
      ...(workerStartupTimings ? { workerStartupTimings } : {}),
    });
    if (typeof input.parentStartedAtEpochMs === "number") {
      snapshot.timing?.workerStartupTimings.push(
        `worker_result_ready=${Math.max(0, Date.now() - input.parentStartedAtEpochMs)}ms`,
      );
    }
    return {
      status: "ok",
      snapshot,
    };
  } catch (error) {
    return {
      status: "failed",
      error: String(error),
    };
  }
}

if (parentPort) {
  const sendToParent: (message: ProviderAuthWarmWorkerResult) => void =
    parentPort.postMessage.bind(parentPort);
  const result = await runProviderAuthWarmWorkerInput(workerData);
  if (
    result.status === "ok" &&
    isWorkerInput(workerData) &&
    typeof workerData.parentStartedAtEpochMs === "number"
  ) {
    result.snapshot.timing?.workerStartupTimings.push(
      `worker_result_message_send=${Math.max(0, Date.now() - workerData.parentStartedAtEpochMs)}ms`,
    );
  }
  sendToParent(result);
}
