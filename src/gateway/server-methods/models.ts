import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  loadModelCatalogForBrowse,
  type ModelCatalogBrowseView,
} from "../../agents/model-catalog-browse.js";
import { resolveVisibleModelCatalog } from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import {
  createGatewayPerfStageTimer,
  formatGatewayPerfCpuUsage,
  logGatewayPerfSummary,
} from "./perf-logging.js";
import type { GatewayRequestHandlers } from "./types.js";

type ModelsListView = ModelCatalogBrowseView;

let loggedSlowModelsListCatalog = false;

// Unknown views are rejected by protocol validation first; this helper keeps the
// handler default explicit for older clients that omit the field.
function resolveModelsListView(params: Record<string, unknown>): ModelsListView {
  return typeof params.view === "string" ? (params.view as ModelsListView) : "default";
}

// Runtime-only model params are useful inside provider routing, but exposing
// them here would leak provider invocation details into the Control UI API.
function omitRuntimeModelParams(entry: ModelCatalogEntry): ModelCatalogEntry {
  const { params: _params, ...rest } = entry as ModelCatalogEntry & {
    params?: Record<string, unknown>;
  };
  return rest;
}

function omitRuntimeModelParamsFromCatalog(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.map(omitRuntimeModelParams);
}

// The gateway model list is a browse API, not an auth probe. It reuses the
// current runtime catalog snapshot and applies visibility rules without doing
// extra runtime discovery on each request.
export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    const perf = createGatewayPerfStageTimer();
    const cpuStarted = process.cpuUsage();
    const logPerf = (message: string) => {
      logGatewayPerfSummary({
        logger: context.logGateway,
        surface: "models.list",
        durationMs: perf.totalMs(),
        message: `${message} ${formatGatewayPerfCpuUsage(cpuStarted)} stages="${perf.summary()}"`,
      });
    };
    if (!validateModelsListParams(params)) {
      perf.mark("validate");
      logPerf("error=invalid_params");
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      perf.mark("config_read");
      const workspaceDir =
        resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) ??
        resolveDefaultAgentWorkspaceDir();
      perf.mark("workspace_resolve");
      const view = resolveModelsListView(params);
      perf.mark("view_resolve");
      const catalog = await loadModelCatalogForBrowse({
        cfg,
        view,
        loadCatalog: context.loadGatewayModelCatalog,
        onTimeout: (timeoutMs) => {
          if (loggedSlowModelsListCatalog) {
            return;
          }
          loggedSlowModelsListCatalog = true;
          context.logGateway.debug(
            `models.list continuing without model catalog after ${timeoutMs}ms`,
          );
        },
      });
      perf.mark("catalog_browse");
      if (view === "all") {
        const models = omitRuntimeModelParamsFromCatalog(catalog);
        perf.mark("response_build");
        logPerf(`view=${view} catalogEntries=${catalog.length} responseEntries=${models.length}`);
        respond(true, { models }, undefined);
        return;
      }
      const models = await resolveVisibleModelCatalog({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
        workspaceDir,
        view,
        runtimeAuthDiscovery: false,
      });
      perf.mark("visible_catalog");
      const responseModels = omitRuntimeModelParamsFromCatalog(models);
      perf.mark("response_build");
      logPerf(
        `view=${view} catalogEntries=${catalog.length} visibleEntries=${models.length} ` +
          `responseEntries=${responseModels.length}`,
      );
      respond(true, { models: responseModels }, undefined);
    } catch (err) {
      perf.mark("error");
      logPerf("error=true");
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
