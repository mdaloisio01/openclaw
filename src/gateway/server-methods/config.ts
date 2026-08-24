import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConfigApplyParams,
  validateConfigGetParams,
  validateConfigPatchParams,
  validateConfigSchemaLookupParams,
  validateConfigSchemaLookupResult,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  createConfigIO,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "../../config/config.js";
import { evaluateControlPlaneActivation } from "../../config/control-plane-protection.js";
import { stampConfigWriteMetadata } from "../../config/io.meta.js";
import { createMergePatch, projectSourceOntoRuntimeShape } from "../../config/io.write-prepare.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import {
  redactConfigObject,
  redactConfigSnapshot,
  restoreRedactedValues,
} from "../../config/redact-snapshot.js";
import { loadGatewayRuntimeConfigSchema } from "../../config/runtime-schema.js";
import { lookupConfigSchema, type ConfigSchemaResponse } from "../../config/schema.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../../config/types.openclaw.js";
import { isBuiltInModelProviderOverlayId } from "../../config/zod-schema.core.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import {
  prepareSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../../secrets/runtime.js";
import { diffConfigPaths } from "../config-diff.js";
import { resolveConfigReloadMetadata } from "../config-reload-plan.js";
import {
  formatControlPlaneActor,
  resolveControlPlaneActor,
  summarizeChangedPaths,
} from "../control-plane-audit.js";
import { resolveBaseHashParam } from "./base-hash.js";
import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  didSharedGatewayAuthChange,
  type ConfigWriteOptions,
  resolveGatewayConfigPath,
  resolveGatewayConfigWriteRestartScope,
  resolveGatewayConfigRestartWriteResult,
} from "./config-write-flow.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE = 3;
const CONFIG_SCHEMA_RESPONSE_CACHE_TTL_MS = 5_000;

let configSchemaResponseCache: {
  expiresAtMs: number;
  response: ConfigSchemaResponse;
} | null = null;

type ConfigOpenCommand = {
  command: string;
  args: string[];
};
type ConfigRedactionHints = Parameters<typeof redactConfigObject>[1];
type ConfigWriteCommitResult = Awaited<ReturnType<typeof commitGatewayConfigWrite>>;
type ConfigRestartWriteKind = Parameters<typeof resolveGatewayConfigRestartWriteResult>[0]["kind"];
type ConfigRestartWriteMode = Parameters<typeof resolveGatewayConfigRestartWriteResult>[0]["mode"];
type ControlPlaneWriteParams = {
  controlPlaneManifest?: unknown;
  controlPlaneApproval?: unknown;
};
type ControlPlaneWriteApproval = {
  candidateConfig: OpenClawConfig;
  candidateRaw: string;
  candidateSha256: string;
  writeOptions: ConfigWriteOptions;
};

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash unavailable; re-run config.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHashParam(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash required; re-run config.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config changed since last load; re-run config.get and retry",
      ),
    );
    return false;
  }
  return true;
}

async function readConfigWriteSnapshotOrRespond(
  params: unknown,
  respond: RespondFn,
): Promise<Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>> | null> {
  const result = await readConfigFileSnapshotForWrite();
  if (!requireConfigBaseHash(params, result.snapshot, respond)) {
    return null;
  }
  return result;
}

function parseRawConfigOrRespond(
  params: unknown,
  requestName: string,
  respond: RespondFn,
): string | null {
  const rawValue = (params as { raw?: unknown }).raw;
  if (typeof rawValue !== "string") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${requestName} params: raw (string) required`,
      ),
    );
    return null;
  }
  return rawValue;
}

function sanitizeLookupPathForLog(path: string): string {
  const sanitized = Array.from(path, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "?" : char;
  }).join("");
  return sanitized.length > 120 ? `${sanitized.slice(0, 117)}...` : sanitized;
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replaceAll("'", "''");
}

export function resolveConfigOpenCommand(
  configPath: string,
  platform: NodeJS.Platform = process.platform,
): ConfigOpenCommand {
  if (platform === "win32") {
    // Use a PowerShell string literal so the path stays data, not code.
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -LiteralPath '${escapePowerShellSingleQuotedString(configPath)}'`,
      ],
    };
  }
  return {
    command: platform === "darwin" ? "open" : "xdg-open",
    args: [configPath],
  };
}

function execConfigOpenCommand(command: ConfigOpenCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command.command, command.args, (error) => {
      if (error) {
        reject(toErrorObject(error, "Non-Error rejection"));
        return;
      }
      resolve();
    });
  });
}

function formatConfigOpenError(error: unknown): string {
  if (
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function hasOwnRecordValue(value: unknown, key: string): boolean {
  return isRecord(value) && Object.hasOwn(value, key);
}

function stripBundledProviderRuntimeDefaults(params: {
  candidate: unknown;
  sourceConfig: unknown;
}): unknown {
  if (!isRecord(params.candidate)) {
    return params.candidate;
  }
  const models = params.candidate.models;
  if (!isRecord(models) || !isRecord(models.providers)) {
    return params.candidate;
  }
  const sourceModels = isRecord(params.sourceConfig) ? params.sourceConfig.models : undefined;
  const sourceProviders = isRecord(sourceModels) ? sourceModels.providers : undefined;

  let nextProviders: Record<string, unknown> | undefined;
  for (const [providerId, provider] of Object.entries(models.providers)) {
    // Runtime overlays can materialize empty defaults that should not become persisted config.
    if (!isBuiltInModelProviderOverlayId(providerId) || !isRecord(provider)) {
      continue;
    }
    const sourceProvider = isRecord(sourceProviders) ? sourceProviders[providerId] : undefined;
    let nextProvider: Record<string, unknown> | undefined;
    if (provider.baseUrl === "" && !hasOwnRecordValue(sourceProvider, "baseUrl")) {
      nextProvider = { ...provider };
      delete nextProvider.baseUrl;
    }
    if (
      Array.isArray(provider.models) &&
      provider.models.length === 0 &&
      !hasOwnRecordValue(sourceProvider, "models")
    ) {
      nextProvider ??= { ...provider };
      delete nextProvider.models;
    }
    if (nextProvider) {
      nextProviders ??= { ...models.providers };
      nextProviders[providerId] = nextProvider;
    }
  }
  if (!nextProviders) {
    return params.candidate;
  }
  return {
    ...params.candidate,
    models: {
      ...models,
      providers: nextProviders,
    },
  };
}

export function prepareConfigWriteCandidateForControlPlane(params: {
  raw: string;
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
}): { config: OpenClawConfig; writeConfig: OpenClawConfig; schema: ConfigSchemaResponse } {
  const parsedRes = parseConfigJson5(params.raw);
  if (!parsedRes.ok) {
    throw new Error(parsedRes.error);
  }
  const schema = loadSchemaWithPlugins();
  const restored = restoreRedactedValues(parsedRes.parsed, params.snapshot.config, schema.uiHints);
  if (!restored.ok) {
    throw new Error(restored.humanReadableMessage ?? "invalid config");
  }
  // Validate against runtime shape, but write the source-shaped config the operator submitted.
  const projectedValidationCandidate = params.snapshot.valid
    ? applyMergePatch(
        projectSourceOntoRuntimeShape(params.snapshot.resolved, params.snapshot.config),
        createMergePatch(params.snapshot.config, restored.result),
      )
    : restored.result;
  const validationCandidate = stripBundledProviderRuntimeDefaults({
    candidate: projectedValidationCandidate,
    sourceConfig: params.snapshot.parsed,
  });
  const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate);
  if (!sourceValidated.ok) {
    throw Object.assign(new Error(summarizeConfigValidationIssues(sourceValidated.issues)), {
      issues: sourceValidated.issues,
    });
  }
  const validated = validateConfigObjectWithPlugins(validationCandidate);
  if (!validated.ok) {
    throw Object.assign(new Error(summarizeConfigValidationIssues(validated.issues)), {
      issues: validated.issues,
    });
  }
  return {
    config: validated.config,
    writeConfig: validationCandidate as OpenClawConfig,
    schema,
  };
}

export function prepareConfigPatchCandidateForControlPlane(params: {
  raw: string;
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
}): { config: OpenClawConfig; writeConfig: OpenClawConfig; schema: ConfigSchemaResponse } {
  const parsedRes = parseConfigJson5(params.raw);
  if (!parsedRes.ok) {
    throw new Error(parsedRes.error);
  }
  if (
    !parsedRes.parsed ||
    typeof parsedRes.parsed !== "object" ||
    Array.isArray(parsedRes.parsed)
  ) {
    throw new Error("config.patch raw must be an object");
  }
  const merged = applyMergePatch(params.snapshot.config, parsedRes.parsed, {
    // Arrays with stable ids behave like maps for partial control-plane edits.
    mergeObjectArraysById: true,
  });
  const schema = loadSchemaWithPlugins();
  const restoredMerge = restoreRedactedValues(merged, params.snapshot.config, schema.uiHints);
  if (!restoredMerge.ok) {
    throw new Error(restoredMerge.humanReadableMessage ?? "invalid config");
  }
  const projectedValidationCandidate = applyMergePatch(
    projectSourceOntoRuntimeShape(params.snapshot.resolved, params.snapshot.config),
    createMergePatch(params.snapshot.config, restoredMerge.result),
  );
  const validationCandidate = stripBundledProviderRuntimeDefaults({
    candidate: projectedValidationCandidate,
    sourceConfig: params.snapshot.parsed,
  });
  const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate);
  if (!sourceValidated.ok) {
    throw Object.assign(new Error(summarizeConfigValidationIssues(sourceValidated.issues)), {
      issues: sourceValidated.issues,
    });
  }
  const validated = validateConfigObjectWithPlugins(validationCandidate);
  if (!validated.ok) {
    throw Object.assign(new Error(summarizeConfigValidationIssues(validated.issues)), {
      issues: validated.issues,
    });
  }
  return {
    config: validated.config,
    writeConfig: validationCandidate as OpenClawConfig,
    schema,
  };
}

function parseValidateConfigFromRawOrRespond(
  params: unknown,
  requestName: string,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): { config: OpenClawConfig; writeConfig: OpenClawConfig; schema: ConfigSchemaResponse } | null {
  const rawValue = parseRawConfigOrRespond(params, requestName, respond);
  if (!rawValue) {
    return null;
  }
  try {
    return prepareConfigWriteCandidateForControlPlane({ raw: rawValue, snapshot });
  } catch (error) {
    const issues = isRecord(error) && Array.isArray(error.issues) ? error.issues : undefined;
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error), {
        ...(issues ? { details: { issues } } : {}),
      }),
    );
    return null;
  }
}

function summarizeConfigValidationIssues(issues: ReadonlyArray<ConfigValidationIssue>): string {
  const trimmed = issues.slice(0, MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE);
  const lines = normalizeStringEntries(
    formatConfigIssueLines(trimmed, "", { normalizeRoot: true }),
  );
  if (lines.length === 0) {
    return "invalid config";
  }
  const hiddenCount = Math.max(0, issues.length - lines.length);
  return `invalid config: ${lines.join("; ")}${
    hiddenCount > 0 ? ` (+${hiddenCount} more issue${hiddenCount === 1 ? "" : "s"})` : ""
  }`;
}

async function ensureResolvableSecretRefsOrRespond(params: {
  config: OpenClawConfig;
  respond: RespondFn;
}): Promise<PreparedSecretsRuntimeSnapshot | null> {
  try {
    return await prepareSecretsRuntimeSnapshot({
      config: params.config,
      includeAuthStoreRefs: false,
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid config: active SecretRef resolution failed (${details})`,
      ),
    );
    return null;
  }
}

export function clearConfigSchemaResponseCacheForTests() {
  configSchemaResponseCache = null;
}

export function loadConfigSchemaResponseForTests(): ConfigSchemaResponse {
  return loadSchemaWithPlugins();
}

function clearConfigSchemaResponseCache() {
  configSchemaResponseCache = null;
}

async function respondWithConfigRestartWrite(params: {
  requestParams: unknown;
  kind: ConfigRestartWriteKind;
  mode: ConfigRestartWriteMode;
  writeResult: ConfigWriteCommitResult;
  changedPaths: string[];
  actor: ReturnType<typeof resolveControlPlaneActor>;
  context: GatewayRequestContext | undefined;
  respond: RespondFn;
  uiHints: ConfigRedactionHints;
}): Promise<void> {
  clearConfigSchemaResponseCache();
  const { payload, sentinelPath, restart } = await resolveGatewayConfigRestartWriteResult({
    requestParams: params.requestParams,
    kind: params.kind,
    mode: params.mode,
    configPath: params.writeResult.path,
    changedPaths: params.changedPaths,
    nextConfig: params.writeResult.config,
    actor: params.actor,
    context: params.context,
  });
  params.respond(
    true,
    {
      ok: true,
      path: params.writeResult.path,
      config: redactConfigObject(params.writeResult.config, params.uiHints),
      restart,
      sentinel: {
        path: sentinelPath,
        payload,
      },
    },
    undefined,
  );
  params.writeResult.queueFollowUp();
}

function shouldDisconnectSharedAuthClientsForConfigWrite(params: {
  prevConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  preparedSecretsSnapshot: PreparedSecretsRuntimeSnapshot;
}): boolean {
  return (
    didSharedGatewayAuthChange(params.prevConfig, params.nextConfig) ||
    didActiveSharedGatewayAuthChange({
      fallbackPrev: params.prevConfig,
      next: params.preparedSecretsSnapshot.config,
    })
  );
}

function respondConfigPatchNoop(params: {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  config: OpenClawConfig;
  uiHints: ConfigRedactionHints;
  actor: ReturnType<typeof resolveControlPlaneActor>;
  context: GatewayRequestContext | undefined;
  respond: RespondFn;
}): void {
  params.context?.logGateway?.info(
    `config.patch noop ${formatControlPlaneActor(params.actor)} (no changed paths)`,
  );
  params.respond(
    true,
    {
      ok: true,
      noop: true,
      path: resolveGatewayConfigPath(params.snapshot),
      config: redactConfigObject(params.config, params.uiHints),
    },
    undefined,
  );
}

function loadSchemaWithPlugins(): ConfigSchemaResponse {
  const now = asDateTimestampMs(Date.now());
  const cachedExpiresAt =
    configSchemaResponseCache === null
      ? undefined
      : asDateTimestampMs(configSchemaResponseCache.expiresAtMs);
  if (
    configSchemaResponseCache &&
    now !== undefined &&
    cachedExpiresAt !== undefined &&
    cachedExpiresAt > now
  ) {
    return configSchemaResponseCache.response;
  }
  if (configSchemaResponseCache) {
    configSchemaResponseCache = null;
  }

  // Plugin schema loading is process-local; short caching avoids repeated UI lookups per render.
  const response = loadGatewayRuntimeConfigSchema();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(CONFIG_SCHEMA_RESPONSE_CACHE_TTL_MS);
  if (expiresAtMs !== undefined) {
    configSchemaResponseCache = {
      expiresAtMs,
      response,
    };
  }
  return response;
}

function formatCanonicalConfigCandidateRaw(config: OpenClawConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf-8").digest("hex");
}

function createControlPlaneApprovedCandidate(params: {
  writeOptions: ConfigWriteOptions;
  candidateConfig: OpenClawConfig;
  activationTimestamp: string;
}): ControlPlaneWriteApproval {
  const candidateConfig = stampConfigWriteMetadata(
    params.candidateConfig,
    params.activationTimestamp,
    params.writeOptions.lastTouchedVersionOverride,
  );
  const candidateRaw = formatCanonicalConfigCandidateRaw(candidateConfig);
  return {
    candidateConfig,
    candidateRaw,
    candidateSha256: sha256Text(candidateRaw),
    writeOptions: {
      ...params.writeOptions,
      lastTouchedAtOverride: params.activationTimestamp,
    },
  };
}

function resolveControlPlaneActivationTimestampOrRespond(params: {
  requestParams: unknown;
  respond: RespondFn;
}): string | null {
  const requestParams = (params.requestParams ?? {}) as ControlPlaneWriteParams;
  const manifest = requestParams.controlPlaneManifest;
  const activationTimestamp = isRecord(manifest) ? manifest.activationTimestamp : undefined;
  if (typeof activationTimestamp !== "string" || !activationTimestamp.trim()) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "control-plane manifest rejected (malformed_manifest): activationTimestamp is required",
        { details: { code: "malformed_manifest" } },
      ),
    );
    return null;
  }
  if (!Number.isFinite(Date.parse(activationTimestamp))) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "control-plane manifest rejected (malformed_manifest): activationTimestamp is invalid",
        { details: { code: "malformed_manifest" } },
      ),
    );
    return null;
  }
  return activationTimestamp;
}

function enforceControlPlaneManifestOrRespond(params: {
  requestParams: unknown;
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  candidateConfig: OpenClawConfig;
  candidateRaw: string;
  changedPaths: string[];
  actor: ReturnType<typeof resolveControlPlaneActor>;
  tool: "config.set" | "config.patch" | "config.apply";
  restartScope: "none" | "gateway";
  requestedServices: string[];
  respond: RespondFn;
}): boolean {
  if (params.changedPaths.length === 0) {
    return true;
  }
  const requestParams = (params.requestParams ?? {}) as ControlPlaneWriteParams;
  const decision = evaluateControlPlaneActivation({
    beforeConfig: params.snapshot.resolved,
    candidateConfig: params.candidateConfig,
    candidateRaw: params.candidateRaw,
    manifest: requestParams.controlPlaneManifest,
    approval: requestParams.controlPlaneApproval,
    now: new Date(),
    candidatePath: params.snapshot.path,
    stagingRoot: path.dirname(params.snapshot.path),
    actor: params.actor.actor,
    tool: params.tool,
    requestedServices: params.requestedServices,
    restartScope: params.restartScope,
    auditSinkAvailable: true,
    rollbackSinkAvailable: true,
  });
  if (decision.ok) {
    return true;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `control-plane manifest rejected (${decision.code}): ${decision.reason}`,
      {
        details: {
          code: decision.code,
          changedPaths: decision.changedPaths,
        },
      },
    ),
  );
  return false;
}

function verifyControlPlanePostWriteOrRespond(params: {
  approved: ControlPlaneWriteApproval;
  writeResult: ConfigWriteCommitResult;
  respond: RespondFn;
}): boolean {
  const persistedRaw = formatCanonicalConfigCandidateRaw(params.writeResult.config);
  const persistedSha256 = sha256Text(persistedRaw);
  if (
    params.writeResult.persistedHash === params.approved.candidateSha256 &&
    persistedSha256 === params.approved.candidateSha256 &&
    persistedRaw === params.approved.candidateRaw
  ) {
    return true;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      "control-plane post-write validation failed: persisted config does not match approved candidate",
      {
        details: {
          expectedSha256: params.approved.candidateSha256,
          persistedHash: params.writeResult.persistedHash,
          persistedSha256,
        },
      },
    ),
  );
  return false;
}

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) {
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    const schema = loadSchemaWithPlugins();
    respond(true, redactConfigSnapshot(snapshot, schema.uiHints), undefined);
  },
  "config.schema": ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSchemaParams, "config.schema", respond)) {
      return;
    }
    respond(true, loadSchemaWithPlugins(), undefined);
  },
  "config.schema.lookup": ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateConfigSchemaLookupParams, "config.schema.lookup", respond)
    ) {
      return;
    }
    const path = (params as { path: string }).path;
    const schema = loadSchemaWithPlugins();
    const result = lookupConfigSchema(schema, path, resolveConfigReloadMetadata);
    if (!result) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config schema path not found"),
      );
      return;
    }
    if (!validateConfigSchemaLookupResult(result)) {
      const errors = validateConfigSchemaLookupResult.errors ?? [];
      context.logGateway.warn(
        `config.schema.lookup produced invalid payload for ${sanitizeLookupPathForLog(path)}: ${formatValidationErrors(errors)}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "config.schema.lookup returned invalid payload", {
          details: { errors },
        }),
      );
      return;
    }
    respond(true, result, undefined);
  },
  "config.set": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigSetParams, "config.set", respond)) {
      return;
    }
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(params, respond);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.set", snapshot, respond);
    if (!parsed) {
      return;
    }
    if (!(await ensureResolvableSecretRefsOrRespond({ config: parsed.config, respond }))) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const changedPaths = diffConfigPaths(snapshot.config, parsed.config);
    const activationTimestamp = resolveControlPlaneActivationTimestampOrRespond({
      requestParams: params,
      respond,
    });
    if (!activationTimestamp) {
      return;
    }
    const approvedCandidate = createControlPlaneApprovedCandidate({
      writeOptions,
      candidateConfig: parsed.writeConfig,
      activationTimestamp,
    });
    if (
      !enforceControlPlaneManifestOrRespond({
        requestParams: params,
        snapshot,
        candidateConfig: approvedCandidate.candidateConfig,
        candidateRaw: approvedCandidate.candidateRaw,
        changedPaths,
        actor,
        tool: "config.set",
        restartScope: "none",
        requestedServices: [],
        respond,
      })
    ) {
      return;
    }
    const writeResult = await commitGatewayConfigWrite({
      snapshot,
      writeOptions: approvedCandidate.writeOptions,
      nextConfig: parsed.writeConfig,
      context,
    });
    if (
      !verifyControlPlanePostWriteOrRespond({ approved: approvedCandidate, writeResult, respond })
    ) {
      return;
    }
    clearConfigSchemaResponseCache();
    respond(
      true,
      {
        ok: true,
        path: writeResult.path,
        config: redactConfigObject(writeResult.config, parsed.schema.uiHints),
      },
      undefined,
    );
    writeResult.queueFollowUp();
  },
  "config.patch": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigPatchParams, "config.patch", respond)) {
      return;
    }
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(params, respond);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"),
      );
      return;
    }
    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid config.patch params: raw (string) required",
        ),
      );
      return;
    }
    let patchCandidate: ReturnType<typeof prepareConfigPatchCandidateForControlPlane>;
    try {
      patchCandidate = prepareConfigPatchCandidateForControlPlane({ raw: rawValue, snapshot });
    } catch (error) {
      const issues = isRecord(error) && Array.isArray(error.issues) ? error.issues : undefined;
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error), {
          ...(issues ? { details: { issues } } : {}),
        }),
      );
      return;
    }
    const restoredChangedPaths = diffConfigPaths(snapshot.resolved, patchCandidate.writeConfig);
    const actor = resolveControlPlaneActor(client);
    if (restoredChangedPaths.length === 0) {
      respondConfigPatchNoop({
        snapshot,
        config: snapshot.config,
        uiHints: patchCandidate.schema.uiHints,
        actor,
        context,
        respond,
      });
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: patchCandidate.config,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.resolved, patchCandidate.writeConfig);

    // No-op: if the validated config is identical to the current config,
    // skip the file write and SIGUSR1 restart entirely. This avoids a full
    // gateway restart (and the resulting connection drop) when a control-plane
    // client re-sends the same config (e.g. hot-apply with no actual changes).
    if (changedPaths.length === 0) {
      respondConfigPatchNoop({
        snapshot,
        config: patchCandidate.config,
        uiHints: patchCandidate.schema.uiHints,
        actor,
        context,
        respond,
      });
      return;
    }
    const restartScope = resolveGatewayConfigWriteRestartScope({
      changedPaths,
      nextConfig: patchCandidate.config,
    });
    const activationTimestamp = resolveControlPlaneActivationTimestampOrRespond({
      requestParams: params,
      respond,
    });
    if (!activationTimestamp) {
      return;
    }
    const approvedCandidate = createControlPlaneApprovedCandidate({
      writeOptions,
      candidateConfig: patchCandidate.writeConfig,
      activationTimestamp,
    });
    if (
      !enforceControlPlaneManifestOrRespond({
        requestParams: params,
        snapshot,
        candidateConfig: approvedCandidate.candidateConfig,
        candidateRaw: approvedCandidate.candidateRaw,
        changedPaths,
        actor,
        tool: "config.patch",
        restartScope: restartScope.restartScope,
        requestedServices: restartScope.requestedServices,
        respond,
      })
    ) {
      return;
    }

    context?.logGateway?.info(
      `config.patch write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.patch`,
    );
    // Compare before the write so we invalidate clients authenticated against the
    // previous shared secret immediately after the config update succeeds.
    const disconnectSharedAuthClients = shouldDisconnectSharedAuthClientsForConfigWrite({
      prevConfig: snapshot.config,
      nextConfig: patchCandidate.config,
      preparedSecretsSnapshot,
    });
    const writeResult = await commitGatewayConfigWrite({
      snapshot,
      writeOptions: approvedCandidate.writeOptions,
      nextConfig: patchCandidate.writeConfig,
      context,
      disconnectSharedAuthClients,
    });
    if (
      !verifyControlPlanePostWriteOrRespond({ approved: approvedCandidate, writeResult, respond })
    ) {
      return;
    }
    await respondWithConfigRestartWrite({
      requestParams: params,
      kind: "config-patch",
      mode: "config.patch",
      writeResult,
      changedPaths,
      actor,
      context,
      respond,
      uiHints: patchCandidate.schema.uiHints,
    });
  },
  "config.apply": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) {
      return;
    }
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(params, respond);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.apply", snapshot, respond);
    if (!parsed) {
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: parsed.config,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.config, parsed.config);
    const actor = resolveControlPlaneActor(client);
    const restartScope = resolveGatewayConfigWriteRestartScope({
      changedPaths,
      nextConfig: parsed.config,
    });
    const activationTimestamp = resolveControlPlaneActivationTimestampOrRespond({
      requestParams: params,
      respond,
    });
    if (!activationTimestamp) {
      return;
    }
    const approvedCandidate = createControlPlaneApprovedCandidate({
      writeOptions,
      candidateConfig: parsed.writeConfig,
      activationTimestamp,
    });
    if (
      !enforceControlPlaneManifestOrRespond({
        requestParams: params,
        snapshot,
        candidateConfig: approvedCandidate.candidateConfig,
        candidateRaw: approvedCandidate.candidateRaw,
        changedPaths,
        actor,
        tool: "config.apply",
        restartScope: restartScope.restartScope,
        requestedServices: restartScope.requestedServices,
        respond,
      })
    ) {
      return;
    }
    context?.logGateway?.info(
      `config.apply write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.apply`,
    );
    // Compare before the write so we invalidate clients authenticated against the
    // previous shared secret immediately after the config update succeeds.
    const disconnectSharedAuthClients = shouldDisconnectSharedAuthClientsForConfigWrite({
      prevConfig: snapshot.config,
      nextConfig: parsed.config,
      preparedSecretsSnapshot,
    });
    const writeResult = await commitGatewayConfigWrite({
      snapshot,
      writeOptions: approvedCandidate.writeOptions,
      nextConfig: parsed.writeConfig,
      context,
      disconnectSharedAuthClients,
    });
    if (
      !verifyControlPlanePostWriteOrRespond({ approved: approvedCandidate, writeResult, respond })
    ) {
      return;
    }
    await respondWithConfigRestartWrite({
      requestParams: params,
      kind: "config-apply",
      mode: "config.apply",
      writeResult,
      changedPaths,
      actor,
      context,
      respond,
      uiHints: parsed.schema.uiHints,
    });
  },
  "config.openFile": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.openFile", respond)) {
      return;
    }
    const configPath = createConfigIO().configPath;
    try {
      await execConfigOpenCommand(resolveConfigOpenCommand(configPath));
      respond(true, { ok: true, path: configPath }, undefined);
    } catch (error) {
      const errorMessage = formatConfigOpenError(error);
      const isHeadlessError =
        errorMessage.includes("xdg-open") && errorMessage.includes("no method available");
      const detailedError = isHeadlessError
        ? `Cannot open file in headless environment. File path: ${configPath}. This environment appears to lack a graphical or terminal browser handler.`
        : `Failed to open config file: ${errorMessage}`;
      context?.logGateway?.warn(
        `config.openFile failed path=${sanitizeLookupPathForLog(configPath)}: ${errorMessage}`,
      );
      respond(true, { ok: false, path: configPath, error: detailedError }, undefined);
    }
  },
};
