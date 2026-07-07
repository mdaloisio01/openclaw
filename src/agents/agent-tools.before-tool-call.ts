import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import {
  diagnosticErrorCategory,
  diagnosticHttpStatusCode,
} from "../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticToolParamsSummary,
  type DiagnosticToolSource,
} from "../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import {
  buildDirtyTreeHygieneReport,
  type DirtyTreeHygieneReport,
} from "../infra/dirty-tree-hygiene.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
} from "../infra/plugin-approvals.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { deriveToolParams } from "../plugins/host-tool-param-parsers.js";
import { copyPluginToolMeta, getPluginToolMeta } from "../plugins/tools.js";
import {
  getTrustedToolPolicyDiagnosticEntries,
  hasTrustedToolPolicies,
  runTrustedToolPolicies,
} from "../plugins/trusted-tool-policy.js";
import {
  PluginApprovalResolutions,
  type PluginApprovalResolution,
  type PluginHookBeforeToolCallResult,
  type PluginHookToolInputKind,
  type PluginHookToolKind,
} from "../plugins/types.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import {
  resolveSkillTelemetrySource,
  resolveSkillTelemetrySourceValue,
} from "../skills/loading/source.js";
import type { SkillSnapshot, SkillTelemetrySource } from "../skills/types.js";
import { resolveSkillWorkshopToolApproval } from "../skills/workshop/policy.js";
import { isPlainObject } from "../utils.js";
import { writeActiveWorkCheckpoint, type ActiveWorkCheckpoint } from "./active-work-checkpoint.js";
import { adjustedParamsByToolCallId } from "./agent-tools.before-tool-call.state.js";
import { copyChannelAgentToolMeta, getChannelAgentToolMeta } from "./channel-tools.js";
import {
  getCodeModeExecBeforeHookMetadata,
  getCodeModeExecBeforeHookMetadataForToolKind,
  normalizeCodeModeExecBeforeHookParams,
  normalizeCodeModeExecBeforeHookParamsForToolKind,
  reconcileCodeModeExecBeforeHookParams,
} from "./code-mode-control-tools.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { applyStopContractToSingleText, type EmbeddedRunStopContract } from "./stop-contract.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

export type ToolOutcomeObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
};

export type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void;

export function isAbortSignalCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (err === signal.reason) {
    return true;
  }
  return (
    err instanceof Error &&
    (err.name === "AbortError" || ("cause" in err && err.cause === signal.reason))
  );
}

export type HookContext = {
  agentId?: string;
  config?: OpenClawConfig;
  /** Tool execution cwd for host-derived path facts. */
  cwd?: string;
  /** Host workspace used to resolve relative tool params for diagnostics only. */
  workspaceDir?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  trigger?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  stopContract?: EmbeddedRunStopContract;
  trace?: DiagnosticTraceContext;
  channelId?: string;
  memoryFlushWritePath?: string;
  loopDetection?: ToolLoopDetectionConfig;
  onToolOutcome?: ToolOutcomeObserver;
  skillsSnapshot?: SkillSnapshot;
  skillCommand?: {
    commandName: string;
    skillName: string;
    skillSource?: SkillTelemetrySource;
    toolName?: string;
  };
  cleanupCrewRecovery?: {
    analysisMode?: boolean;
    stoppageId?: string;
    missionId?: string;
    nextAnalysisOwner?: string;
  };
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};

type HookBlockedKind = "veto" | "failure";
type HookBlockedReason =
  | "plugin-before-tool-call"
  | "plugin-approval"
  | "tool-loop"
  | "dirty-tree-hygiene"
  | "cleanup-crew-analysis-mode";
type HookOutcome =
  | {
      blocked: true;
      kind?: HookBlockedKind;
      deniedReason?: HookBlockedReason;
      reason: string;
      params?: unknown;
    }
  | {
      blocked: false;
      params: unknown;
      approvalResolution?: PluginApprovalResolution;
      deferredApproval?: DeferredPluginToolApproval;
    };
type PluginApprovalRequest = NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>;

function resolvePluginToolApprovalTimeoutMs(approval: PluginApprovalRequest): number {
  if (
    typeof approval.timeoutMs !== "number" ||
    !Number.isFinite(approval.timeoutMs) ||
    approval.timeoutMs <= 0
  ) {
    return DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
  }
  return Math.min(Math.floor(approval.timeoutMs), MAX_PLUGIN_APPROVAL_TIMEOUT_MS);
}

function resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs, 10_000) ?? DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000;
}

export type DeferredPluginToolApproval = {
  approval: PluginApprovalRequest;
  toolName: string;
  toolCallId?: string;
  ctx?: HookContext;
  baseParams: unknown;
  overrideParams?: unknown;
};

type BeforeToolCallWrapperOptions = {
  approvalMode?: "request" | "report" | "defer";
  emitDiagnostics: boolean;
};

export type BeforeToolCallPolicyDiagnosticState = {
  hasBeforeToolCallHook: boolean;
  trustedToolPolicies: Array<{
    id: string;
    pluginId: string;
    pluginName?: string;
  }>;
};

export function getBeforeToolCallPolicyDiagnosticState(): BeforeToolCallPolicyDiagnosticState {
  return {
    hasBeforeToolCallHook: getGlobalHookRunner()?.hasHooks("before_tool_call") === true,
    trustedToolPolicies: getTrustedToolPolicyDiagnosticEntries(),
  };
}

export function hasBeforeToolCallPolicy(): boolean {
  const state = getBeforeToolCallPolicyDiagnosticState();
  return state.hasBeforeToolCallHook || state.trustedToolPolicies.length > 0;
}

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS = Symbol("beforeToolCallDiagnosticOptions");
const BEFORE_TOOL_CALL_SOURCE_TOOL = Symbol("beforeToolCallSourceTool");
const BEFORE_TOOL_CALL_HOOK_CONTEXT = Symbol("beforeToolCallHookContext");
const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON =
  "Tool call blocked because before_tool_call hook failed";
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
const OPENCLAW_SOURCE_REPO_DIR = "/home/will/openclaw-source";
const OPENCLAW_GATEWAY_SERVICE_NAME = "openclaw-gateway.service";
const execFile = promisify(execFileCallback);
const SHELL_WRITE_RISK_RE =
  /\b(rm|mv|cp|touch|mkdir|rmdir|truncate|tee|patch|git\s+(?:add|reset|stash|clean|checkout|restore|commit|merge|rebase|pull|push|switch|worktree)|npm\s+run\s+build|pnpm\s+run\s+build|yarn\s+build)\b/;
const READ_ONLY_DIAGNOSTIC_COMMAND_RE =
  /^(?:git\s+(?:status|diff|log|show|rev-parse|branch)(?:\s|$)|rg(?:\s|$)|grep(?:\s|$)|sed(?:\s|$)|cat(?:\s|$)|ls(?:\s|$)|find(?:\s|$)|pwd(?:\s|$)|wc(?:\s|$)|head(?:\s|$)|tail(?:\s|$)|nl(?:\s|$)|jq(?:\s|$)|vitest(?:\s|$)|npx\s+vitest(?:\s|$)|pnpm\s+vitest(?:\s|$)|npm\s+test(?:\s|$)|pnpm\s+test(?:\s|$)|yarn\s+test(?:\s|$))/;

type DirtyTreeStatusReader = (repoDir: string) => Promise<string>;
let dirtyTreeStatusReader: DirtyTreeStatusReader = readGitStatusShort;

export function setDirtyTreeHygieneStatusReaderForTest(reader?: DirtyTreeStatusReader): void {
  dirtyTreeStatusReader = reader ?? readGitStatusShort;
}

/**
 * Error used when before_tool_call intentionally vetoes a tool call.
 */
export class BeforeToolCallBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BeforeToolCallBlockedError";
  }
}

async function readGitStatusShort(repoDir: string): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, "status", "--short"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function getStringParam(params: unknown, keys: string[]): string | undefined {
  if (!isPlainObject(params)) {
    return undefined;
  }
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function withStringParam(params: unknown, nextValue: string): unknown {
  if (!isPlainObject(params)) {
    return params;
  }
  for (const key of ["cmd", "command", "script", "input"]) {
    if (typeof params[key] === "string" && params[key].trim().length > 0) {
      return { ...params, [key]: nextValue };
    }
  }
  return params;
}

function isShellTool(toolName: string): boolean {
  return matchesToolName(toolName, [
    "bash",
    "shell",
    "exec",
    "exec_command",
    "terminal",
    "run_command",
  ]);
}

function isKnownSourceModifyingTool(toolName: string): boolean {
  return matchesToolName(toolName, [
    "apply_patch",
    "edit",
    "write",
    "multi_edit",
    "delete",
    "move",
    "rename",
    "create_file",
    "file_write",
  ]);
}

function matchesToolName(toolName: string, candidates: string[]): boolean {
  return candidates.some(
    (candidate) => toolName === candidate || toolName.endsWith(`.${candidate}`),
  );
}

function isReadOnlyDiagnosticShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  if (/[;&|`$<>]/.test(trimmed)) {
    return false;
  }
  if (SHELL_WRITE_RISK_RE.test(trimmed)) {
    return false;
  }
  return READ_ONLY_DIAGNOSTIC_COMMAND_RE.test(trimmed);
}

export type GatewaySelfRestartCommand =
  | {
      detected: true;
      action: "restart" | "start" | "stop";
      command: string;
      shouldUseSafeBroker: boolean;
      safeBrokerCommand?: string;
    }
  | { detected: false };

function tokenizeSimpleCommand(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$<>]/.test(trimmed)) {
    return undefined;
  }
  const matches = trimmed.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!matches) {
    return undefined;
  }
  return matches.map((token) => token.replace(/^["']|["']$/g, ""));
}

function basenameToken(value: string | undefined): string {
  return path.basename(value ?? "");
}

export function classifyGatewaySelfRestartCommand(
  command: string | undefined,
): GatewaySelfRestartCommand {
  if (!command) {
    return { detected: false };
  }
  const tokens = tokenizeSimpleCommand(command);
  if (!tokens?.length) {
    return { detected: false };
  }
  const executable = basenameToken(tokens[0]);
  if (executable === "systemctl") {
    const hasUserFlag = tokens.includes("--user");
    const action = tokens.find(
      (token) => token === "restart" || token === "start" || token === "stop",
    );
    if (
      hasUserFlag &&
      (action === "restart" || action === "start" || action === "stop") &&
      tokens.includes(OPENCLAW_GATEWAY_SERVICE_NAME)
    ) {
      return {
        detected: true,
        action,
        command: command.trim(),
        shouldUseSafeBroker: action === "restart",
        ...(action === "restart" ? { safeBrokerCommand: "openclaw gateway restart --safe" } : {}),
      };
    }
  }
  if (executable === "openclaw") {
    const [second, third] = tokens.slice(1);
    if (second === "gateway" && third === "restart") {
      return {
        detected: true,
        action: "restart",
        command: command.trim(),
        shouldUseSafeBroker: !tokens.includes("--safe"),
        safeBrokerCommand: tokens.includes("--safe") ? command.trim() : `${command.trim()} --safe`,
      };
    }
  }
  return { detected: false };
}

function isGatewaySelfRestartToolCall(
  toolName: string,
  params: unknown,
): GatewaySelfRestartCommand {
  if (!isShellTool(toolName)) {
    return { detected: false };
  }
  return classifyGatewaySelfRestartCommand(
    getStringParam(params, ["cmd", "command", "script", "input"]),
  );
}

function buildGatewayRestartCheckpointInput(params: {
  command: GatewaySelfRestartCommand & { detected: true };
  toolName: string;
  ctx?: HookContext;
}): Parameters<typeof writeActiveWorkCheckpoint>[0]["input"] {
  return {
    source: "gateway_restart",
    sessionKey: params.ctx?.sessionKey,
    sessionId: params.ctx?.sessionId,
    runId: params.ctx?.runId,
    requestingAgentToolPath: params.toolName,
    restartCommand: params.command.command,
    restartIntent: `gateway ${params.command.action}`,
    activeObjective:
      "Gateway self-restart requested from an active OpenClaw tool turn; side-effect status must be verified after any interruption.",
    currentPhase: "pre-side-effect gateway restart tool call",
    lastCompletedProof:
      "Gateway self-restart command was detected before execution and routed through the safe restart broker when available.",
    nextValidationStep:
      "Treat aborted, timed-out, or transport-lost restart output as unknown-not-noop. Verify gateway PID/start time, health/ready/RPC status, and activation-continuation or recovery status before reporting or stopping.",
    stopConditions: [
      "Gateway live state cannot be verified after the side-effecting restart command.",
      "Gateway health, readiness, or RPC status fails after restart.",
      "Activation-continuation or restart-recovery proof is missing when the parent turn was interrupted.",
      "A current-truth closeout or blocker artifact cannot be produced before stopping.",
      "Continuation would require destructive operations.",
      "Continuation would require private context export.",
      "The interrupted transcript cannot be safely resumed.",
    ],
    pendingApprovalState: "none",
    safeToAutoResume: true,
    requiresOperatorReview: false,
  };
}

async function resolveGatewaySelfRestartCheckpoint(args: {
  toolName: string;
  params: unknown;
  ctx?: HookContext;
}): Promise<{ checkpoint: ActiveWorkCheckpoint; params: unknown } | undefined> {
  const restartCommand = isGatewaySelfRestartToolCall(args.toolName, args.params);
  if (!restartCommand.detected) {
    return undefined;
  }
  const checkpoint = await writeActiveWorkCheckpoint({
    input: buildGatewayRestartCheckpointInput({
      command: restartCommand,
      toolName: args.toolName,
      ctx: args.ctx,
    }),
  });
  log.warn(
    `gateway restart checkpoint written checkpointId=${checkpoint.checkpointId} action=${restartCommand.action} safeToAutoResume=${checkpoint.safeToAutoResume}`,
  );
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...(args.ctx?.runId && { runId: args.ctx.runId }),
    ...(args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey }),
    ...(args.ctx?.sessionId && { sessionId: args.ctx.sessionId }),
    toolName: "gateway-self-restart-checkpoint",
    toolSource: "core",
    paramsSummary: { kind: "object" },
  });
  if (restartCommand.shouldUseSafeBroker && restartCommand.safeBrokerCommand) {
    return {
      checkpoint,
      params: withStringParam(args.params, restartCommand.safeBrokerCommand),
    };
  }
  return { checkpoint, params: args.params };
}

function isSourceModifyingToolCall(toolName: string, params: unknown): boolean {
  if (isKnownSourceModifyingTool(toolName)) {
    return true;
  }
  if (!isShellTool(toolName)) {
    return false;
  }
  const command = getStringParam(params, ["cmd", "command", "script", "input"]);
  if (!command) {
    return true;
  }
  if (classifyGatewaySelfRestartCommand(command).detected) {
    return false;
  }
  return !isReadOnlyDiagnosticShellCommand(command);
}

function formatDirtyTreeHygieneBlockMessage(report: DirtyTreeHygieneReport): string {
  const groups = report.groups.map((group) => `${group.group} (${group.paths.length})`).join(", ");
  return [
    "Dirty-tree hygiene blocked this source-modifying tool call.",
    "The working tree is broad/mixed across package boundaries.",
    `Package groups detected: ${groups || "unknown"}.`,
    `Risk counts: staged=${report.stagedCount}, unstaged=${report.unstagedCount}, untracked=${report.untrackedCount}.`,
    "Run read-only status/diff review first, then package or clean the unrelated work before continuing.",
  ].join(" ");
}

function resolveCleanupCrewAnalysisModeBlock(args: {
  toolName: string;
  params: unknown;
  ctx?: HookContext;
}): HookOutcome | undefined {
  if (args.ctx?.cleanupCrewRecovery?.analysisMode !== true) {
    return undefined;
  }
  if (!isSourceModifyingToolCall(args.toolName, args.params)) {
    return undefined;
  }
  if (isAllowedMemoryFlushWrite(args)) {
    return undefined;
  }
  const mission = args.ctx.cleanupCrewRecovery.missionId ?? "active Cleanup Crew mission";
  const stoppage = args.ctx.cleanupCrewRecovery.stoppageId ?? "unrecorded stoppage";
  return {
    blocked: true,
    kind: "veto",
    deniedReason: "cleanup-crew-analysis-mode",
    reason: [
      "Cleanup Crew analysis mode blocked this source-modifying tool call.",
      `Mission: ${mission}.`,
      `Stoppage: ${stoppage}.`,
      "Pause/analyze mode permits read-only inspection only; write the active build plan amendment before repair execution resumes.",
    ].join(" "),
    params: args.params,
  };
}

async function resolveDirtyTreeHygieneBlock(args: {
  toolName: string;
  params: unknown;
  ctx?: HookContext;
}): Promise<HookOutcome | undefined> {
  if (!isSourceModifyingToolCall(args.toolName, args.params)) {
    return undefined;
  }
  if (isAllowedMemoryFlushWrite(args)) {
    return undefined;
  }
  let statusShortOutput: string;
  try {
    statusShortOutput = await dirtyTreeStatusReader(OPENCLAW_SOURCE_REPO_DIR);
  } catch (err) {
    return {
      blocked: true,
      kind: "veto",
      deniedReason: "dirty-tree-hygiene",
      reason: `Dirty-tree hygiene could not read git status for ${OPENCLAW_SOURCE_REPO_DIR}: ${String(err)}`,
      params: args.params,
    };
  }
  const report = buildDirtyTreeHygieneReport(statusShortOutput);
  if (report.risk !== "broad-mixed") {
    return undefined;
  }
  return {
    blocked: true,
    kind: "veto",
    deniedReason: "dirty-tree-hygiene",
    reason: formatDirtyTreeHygieneBlockMessage(report),
    params: args.params,
  };
}

function normalizeMemoryFlushRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
  return /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(normalized) ? normalized : undefined;
}

function isWriteToolName(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return (
    normalized === "write" ||
    normalized === "write_file" ||
    normalized.endsWith(".write") ||
    normalized.endsWith(".write_file") ||
    normalized.endsWith("__write") ||
    normalized.endsWith("__write_file")
  );
}

function isAllowedMemoryFlushWriteMetadata(key: string, value: unknown): boolean {
  if (key === "mode" || key === "operation") {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return normalized === "append" || normalized === "operational_memory_append";
  }
  if (key === "append" || key === "appendOnly") {
    return value === true;
  }
  return false;
}

function isAllowedMemoryFlushWrite(args: {
  toolName: string;
  params: unknown;
  ctx?: HookContext;
}): boolean {
  if (args.ctx?.trigger !== "memory") {
    return false;
  }
  const allowedPath = normalizeMemoryFlushRelativePath(args.ctx?.memoryFlushWritePath);
  if (!allowedPath || !isWriteToolName(args.toolName)) {
    return false;
  }
  const record = isPlainObject(args.params) ? args.params : {};
  const keys = Object.keys(record);
  if (
    keys.some(
      (key) =>
        key !== "path" && key !== "content" && !isAllowedMemoryFlushWriteMetadata(key, record[key]),
    )
  ) {
    return false;
  }
  const requestedPath = normalizeMemoryFlushRelativePath(record.path);
  return requestedPath === allowedPath && typeof record.content === "string";
}

export function recordAdjustedParamsForToolCall(
  toolCallId: string | undefined,
  params: unknown,
  runId?: string,
): void {
  if (!toolCallId) {
    return;
  }
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  adjustedParamsByToolCallId.set(adjustedParamsKey, params);
  if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
    const oldest = adjustedParamsByToolCallId.keys().next().value;
    if (oldest) {
      adjustedParamsByToolCallId.delete(oldest);
    }
  }
}

/**
 * Returns true when an error represents an intentional before_tool_call veto.
 */
export function isBeforeToolCallBlockedError(err: unknown): err is BeforeToolCallBlockedError {
  return err instanceof BeforeToolCallBlockedError;
}

const loadBeforeToolCallRuntime = createLazyRuntimeSurface(
  () => import("./agent-tools.before-tool-call.runtime.js"),
  ({ beforeToolCallRuntime }) => beforeToolCallRuntime,
);

function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

function mergeParamsWithApprovalOverrides(
  originalParams: unknown,
  approvalParams?: unknown,
): unknown {
  if (approvalParams && isPlainObject(approvalParams)) {
    if (isPlainObject(originalParams)) {
      return { ...originalParams, ...approvalParams };
    }
    return approvalParams;
  }
  return originalParams;
}

function applySourceReplyStopContractToToolParams(
  toolName: string,
  params: unknown,
  ctx?: HookContext,
): unknown {
  if (
    toolName !== "message" ||
    ctx?.sourceReplyDeliveryMode !== "message_tool_only" ||
    !ctx.stopContract ||
    !isPlainObject(params)
  ) {
    return params;
  }
  const action = normalizeOptionalString(params.action) ?? "";
  if (action !== "send") {
    return params;
  }
  const textField = ["message", "content", "text"].find(
    (field) => typeof params[field] === "string",
  );
  if (!textField) {
    return params;
  }
  const adjustedText = applyStopContractToSingleText(params[textField] as string, ctx.stopContract);
  if (!adjustedText || adjustedText === params[textField]) {
    return params;
  }
  return {
    ...params,
    [textField]: adjustedText,
  };
}

function unwrapErrorCause(err: unknown): unknown {
  try {
    if (!(err instanceof Error)) {
      return err;
    }
    const cause = Object.getOwnPropertyDescriptor(err, "cause");
    if (cause && "value" in cause && cause.value !== undefined) {
      return cause.value;
    }
  } catch {
    return err;
  }
  return err;
}

type ToolDiagnosticIdentity = {
  toolSource: DiagnosticToolSource;
  toolOwner?: string;
};

function resolveToolDiagnosticIdentity(tool: AnyAgentTool): ToolDiagnosticIdentity {
  const pluginMeta = getPluginToolMeta(tool);
  if (pluginMeta) {
    return pluginMeta.pluginId === "bundle-mcp"
      ? { toolSource: "mcp", toolOwner: pluginMeta.pluginId }
      : { toolSource: "plugin", toolOwner: pluginMeta.pluginId };
  }
  const channelMeta = getChannelAgentToolMeta(tool as never);
  if (channelMeta) {
    return { toolSource: "channel", toolOwner: channelMeta.channelId };
  }
  return { toolSource: "core" };
}

type SkillUsageMatch = {
  skillName: string;
  skillSource: SkillTelemetrySource;
  activation: "command" | "read";
};

function resolveRelativeToolPath(candidate: string, ctx?: HookContext): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  const base = ctx?.workspaceDir ?? ctx?.cwd;
  return base ? path.resolve(base, trimmed) : undefined;
}

function readToolPathCandidates(params: unknown, ctx?: HookContext): string[] {
  if (!isPlainObject(params)) {
    return [];
  }
  const candidates = typeof params.path === "string" ? [params.path] : [];
  return candidates
    .map((candidate) => resolveRelativeToolPath(candidate, ctx))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function skillInstructionPaths(snapshot: SkillSnapshot | undefined): Map<string, SkillUsageMatch> {
  const matches = new Map<string, SkillUsageMatch>();
  for (const skill of snapshot?.resolvedSkills ?? []) {
    const skillName = typeof skill.name === "string" ? skill.name.trim() : "";
    if (!skillName) {
      continue;
    }
    const match = {
      skillName,
      skillSource: resolveSkillTelemetrySource(skill),
      activation: "read" as const,
    };
    const filePath = typeof skill.filePath === "string" ? skill.filePath.trim() : "";
    if (filePath && path.isAbsolute(filePath)) {
      matches.set(path.resolve(filePath), match);
    }
    const baseDir = typeof skill.baseDir === "string" ? skill.baseDir.trim() : "";
    if (baseDir && path.isAbsolute(baseDir)) {
      matches.set(path.resolve(baseDir, "SKILL.md"), match);
    }
  }
  return matches;
}

function findSkillUsageMatch(params: {
  toolName: string;
  toolParams: unknown;
  ctx?: HookContext;
}): SkillUsageMatch | undefined {
  const command = params.ctx?.skillCommand;
  if (command) {
    const commandToolName = normalizeToolName(command.toolName ?? params.toolName);
    if (!commandToolName || commandToolName === params.toolName) {
      return {
        skillName: command.skillName,
        skillSource: resolveSkillTelemetrySourceValue(command.skillSource),
        activation: "command",
      };
    }
  }

  if (params.toolName !== "read" || !params.ctx?.skillsSnapshot?.resolvedSkills?.length) {
    return undefined;
  }
  const skillPaths = skillInstructionPaths(params.ctx.skillsSnapshot);
  for (const candidate of readToolPathCandidates(params.toolParams, params.ctx)) {
    const match = skillPaths.get(candidate);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function emitSkillUsedDiagnostic(params: {
  ctx?: HookContext;
  match: SkillUsageMatch;
  toolName: string;
  toolCallId?: string;
}): void {
  const trace = params.ctx?.trace
    ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(params.ctx.trace))
    : undefined;
  emitTrustedDiagnosticEvent({
    type: "skill.used",
    ...(params.ctx?.runId && { runId: params.ctx.runId }),
    ...(params.ctx?.sessionKey && { sessionKey: params.ctx.sessionKey }),
    ...(params.ctx?.sessionId && { sessionId: params.ctx.sessionId }),
    ...(params.ctx?.agentId && { agentId: params.ctx.agentId }),
    ...(trace && { trace }),
    skillName: params.match.skillName,
    skillSource: params.match.skillSource,
    activation: params.match.activation,
    toolName: params.toolName,
    ...(params.toolCallId && { toolCallId: params.toolCallId }),
  });
}

function notifyPluginApprovalResolution(
  approval: PluginApprovalRequest,
  resolution: PluginApprovalResolution,
): void {
  const onResolution = approval.onResolution;
  if (typeof onResolution !== "function") {
    return;
  }
  try {
    void Promise.resolve(onResolution(resolution)).catch((err: unknown) => {
      log.warn(`plugin onResolution callback failed: ${String(err)}`);
    });
  } catch (err) {
    log.warn(`plugin onResolution callback failed: ${String(err)}`);
  }
}

async function requestPluginToolApproval(params: {
  approval: PluginApprovalRequest;
  toolName: string;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  baseParams: unknown;
  overrideParams?: unknown;
}): Promise<HookOutcome> {
  const approval = params.approval;
  const timeoutMs = resolvePluginToolApprovalTimeoutMs(approval);
  const gatewayTimeoutMs = resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs);
  try {
    const requestResult: {
      id?: string;
      status?: string;
      decision?: string | null;
    } = await callGatewayTool(
      "plugin.approval.request",
      // Buffer beyond the approval timeout so the gateway can clean up
      // and respond before the client-side RPC timeout fires.
      { timeoutMs: gatewayTimeoutMs },
      {
        pluginId: approval.pluginId,
        title: approval.title,
        description: approval.description,
        severity: approval.severity,
        allowedDecisions: approval.allowedDecisions,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        agentId: params.ctx?.agentId,
        sessionKey: params.ctx?.sessionKey,
        timeoutMs,
        twoPhase: true,
      },
      { expectFinal: false },
    );
    const id = requestResult?.id;
    if (!id) {
      notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
      return {
        blocked: true,
        kind: "failure",
        deniedReason: "plugin-approval",
        reason: approval.description || "Plugin approval request failed",
        params: params.baseParams,
      };
    }
    const hasImmediateDecision = Object.hasOwn(requestResult ?? {}, "decision");
    let decision: string | null | undefined;
    if (hasImmediateDecision) {
      decision = requestResult?.decision;
      if (decision === null) {
        notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
        return {
          blocked: true,
          kind: "failure",
          deniedReason: "plugin-approval",
          reason: "Plugin approval unavailable (no approval route)",
          params: params.baseParams,
        };
      }
    } else {
      // Wait for the decision, but abort early if the agent run is cancelled
      // so the user isn't blocked for the full approval timeout.
      const waitPromise: Promise<{
        id?: string;
        decision?: string | null;
      }> = callGatewayTool(
        "plugin.approval.waitDecision",
        // Buffer beyond the approval timeout so the gateway can clean up
        // and respond before the client-side RPC timeout fires.
        { timeoutMs: gatewayTimeoutMs },
        { id },
      );
      let waitResult: { id?: string; decision?: string | null } | undefined;
      if (params.signal) {
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          if (params.signal!.aborted) {
            reject(toLintErrorObject(params.signal!.reason, "Non-Error rejection"));
            return;
          }
          onAbort = () => reject(toLintErrorObject(params.signal!.reason, "Non-Error rejection"));
          params.signal!.addEventListener("abort", onAbort, { once: true });
        });
        try {
          waitResult = await Promise.race([waitPromise, abortPromise]);
        } finally {
          if (onAbort) {
            params.signal.removeEventListener("abort", onAbort);
          }
        }
      } else {
        waitResult = await waitPromise;
      }
      decision = waitResult?.decision;
    }
    const resolution: PluginApprovalResolution =
      decision === PluginApprovalResolutions.ALLOW_ONCE ||
      decision === PluginApprovalResolutions.ALLOW_ALWAYS ||
      decision === PluginApprovalResolutions.DENY
        ? decision
        : PluginApprovalResolutions.TIMEOUT;
    notifyPluginApprovalResolution(approval, resolution);
    if (
      decision === PluginApprovalResolutions.ALLOW_ONCE ||
      decision === PluginApprovalResolutions.ALLOW_ALWAYS
    ) {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams),
        approvalResolution: resolution,
      };
    }
    if (decision === PluginApprovalResolutions.DENY) {
      return {
        blocked: true,
        kind: "failure",
        deniedReason: "plugin-approval",
        reason: "Denied by user",
        params: params.baseParams,
      };
    }
    const timeoutBehavior = approval.timeoutBehavior ?? "deny";
    if (timeoutBehavior === "allow") {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams),
        approvalResolution: resolution,
      };
    }
    return {
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: "Approval timed out",
      params: params.baseParams,
    };
  } catch (err) {
    notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
    if (isAbortSignalCancellation(err, params.signal)) {
      log.warn(`plugin approval wait cancelled by run abort: ${String(err)}`);
      return {
        blocked: true,
        kind: "failure",
        deniedReason: "plugin-approval",
        reason: "Approval cancelled (run aborted)",
        params: params.baseParams,
      };
    }
    log.warn(`plugin approval gateway request failed; blocking tool call: ${String(err)}`);
    return {
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: "Plugin approval required (gateway unavailable)",
      params: params.baseParams,
    };
  }
}

export async function requestDeferredPluginToolApproval(params: {
  deferredApproval: DeferredPluginToolApproval;
  signal?: AbortSignal;
}): Promise<HookOutcome> {
  const deferred = params.deferredApproval;
  return requestPluginToolApproval({
    approval: deferred.approval,
    toolName: deferred.toolName,
    ...(deferred.toolCallId ? { toolCallId: deferred.toolCallId } : {}),
    ...(deferred.ctx ? { ctx: deferred.ctx } : {}),
    signal: params.signal,
    baseParams: deferred.baseParams,
    overrideParams: deferred.overrideParams,
  });
}

export function cancelDeferredPluginToolApproval(
  deferredApproval: DeferredPluginToolApproval,
): void {
  notifyPluginApprovalResolution(deferredApproval.approval, PluginApprovalResolutions.CANCELLED);
}

async function resolveBeforeToolCallApprovalOutcome(params: {
  result: PluginHookBeforeToolCallResult | undefined;
  approvalMode?: "request" | "report" | "defer";
  toolName: string;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  baseParams: unknown;
}): Promise<HookOutcome | undefined> {
  const approval = params.result?.requireApproval;
  if (!approval) {
    return undefined;
  }
  if (params.approvalMode === "defer") {
    return {
      blocked: false,
      params: params.baseParams,
      deferredApproval: {
        approval,
        toolName: params.toolName,
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        ...(params.ctx ? { ctx: params.ctx } : {}),
        baseParams: params.baseParams,
        overrideParams: params.result?.params,
      },
    };
  }
  if (params.approvalMode === "report") {
    notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
    return {
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: approval.description || approval.title || "Plugin approval required",
      params: params.baseParams,
    };
  }
  return await requestPluginToolApproval({
    approval,
    toolName: params.toolName,
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    ...(params.ctx ? { ctx: params.ctx } : {}),
    signal: params.signal,
    baseParams: params.baseParams,
    overrideParams: params.result?.params,
  });
}

async function resolveSkillWorkshopApprovalForFinalParams(params: {
  toolName: string;
  params: unknown;
  approvalMode?: "request" | "report" | "defer";
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
}): Promise<HookOutcome | undefined> {
  const result = resolveSkillWorkshopToolApproval({
    toolName: params.toolName,
    toolParams: isPlainObject(params.params) ? params.params : {},
    ...(params.ctx?.config ? { config: params.ctx.config } : {}),
  });
  return await resolveBeforeToolCallApprovalOutcome({
    result,
    approvalMode: params.approvalMode,
    toolName: params.toolName,
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    ...(params.ctx ? { ctx: params.ctx } : {}),
    signal: params.signal,
    baseParams: params.params,
  });
}

export function buildBlockedToolResult(params: {
  reason: string;
  deniedReason?: HookBlockedReason;
}) {
  return {
    content: [{ type: "text" as const, text: params.reason }],
    details: {
      status: "blocked",
      deniedReason: params.deniedReason ?? "plugin-before-tool-call",
      reason: params.reason,
    },
  };
}

function summarizeToolParams(params: unknown): DiagnosticToolParamsSummary {
  if (params === null) {
    return { kind: "null" };
  }
  if (params === undefined) {
    return { kind: "undefined" };
  }
  if (Array.isArray(params)) {
    return { kind: "array", length: params.length };
  }
  if (typeof params === "object") {
    return { kind: "object" };
  }
  if (typeof params === "string") {
    return { kind: "string", length: params.length };
  }
  if (typeof params === "number") {
    return { kind: "number" };
  }
  if (typeof params === "boolean") {
    return { kind: "boolean" };
  }
  return { kind: "other" };
}

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey && !args.ctx?.sessionId) {
    return;
  }
  let recordedOutcome: ToolOutcomeObservation | undefined;
  try {
    const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx.sessionId,
    });
    const record = recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
      ...(args.ctx.runId && { runId: args.ctx.runId }),
    });
    if (record?.resultHash && args.ctx.onToolOutcome) {
      recordedOutcome = {
        toolName: record.toolName,
        argsHash: record.argsHash,
        resultHash: record.resultHash,
      };
    }
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
  if (recordedOutcome) {
    args.ctx.onToolOutcome?.(recordedOutcome);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolKind?: PluginHookToolKind;
  toolInputKind?: PluginHookToolInputKind;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  approvalMode?: "request" | "report" | "defer";
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  let params = applySourceReplyStopContractToToolParams(toolName, args.params, args.ctx);

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } =
      await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx.sessionId,
    });

    const loopScope = args.ctx.runId ? { runId: args.ctx.runId } : undefined;
    const loopResult = detectToolCallLoop(
      sessionState,
      toolName,
      params,
      args.ctx.loopDetection,
      loopScope,
    );

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx.sessionId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          kind: "veto",
          deniedReason: "tool-loop",
          reason: loopResult.message,
          params,
        };
      }
      const baseWarningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
      const warningKey = args.ctx.runId ? `${args.ctx.runId}:${baseWarningKey}` : baseWarningKey;
      if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
        log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx.sessionId,
          toolName,
          level: "warning",
          action: "warn",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
      }
    }

    if (args.ctx.loopDetection?.enabled !== false) {
      recordToolCall(
        sessionState,
        toolName,
        params,
        args.toolCallId,
        args.ctx.loopDetection,
        loopScope,
      );
    }
  }

  const cleanupCrewAnalysisBlock = resolveCleanupCrewAnalysisModeBlock({
    toolName,
    params,
    ctx: args.ctx,
  });
  if (cleanupCrewAnalysisBlock) {
    return cleanupCrewAnalysisBlock;
  }

  const gatewayRestartCheckpoint = await resolveGatewaySelfRestartCheckpoint({
    toolName,
    params,
    ctx: args.ctx,
  });
  if (gatewayRestartCheckpoint) {
    params = gatewayRestartCheckpoint.params;
  }

  const dirtyTreeHygieneBlock = await resolveDirtyTreeHygieneBlock({
    toolName,
    params,
    ctx: args.ctx,
  });
  if (dirtyTreeHygieneBlock) {
    return dirtyTreeHygieneBlock;
  }

  const hookRunner = getGlobalHookRunner();
  try {
    const hasBeforeToolCallHooks = hookRunner?.hasHooks("before_tool_call") === true;
    const shouldRunTrustedPolicies = hasTrustedToolPolicies();
    const normalizedParams = isPlainObject(params) ? params : {};
    const initialCorePolicyResult = resolveSkillWorkshopToolApproval({
      toolName,
      toolParams: normalizedParams,
      ...(args.ctx?.config ? { config: args.ctx.config } : {}),
    });
    if (!initialCorePolicyResult && !shouldRunTrustedPolicies && !hasBeforeToolCallHooks) {
      return { blocked: false, params };
    }
    const deriveOptions =
      args.ctx?.cwd || args.ctx?.sandbox
        ? {
            ...(args.ctx.cwd ? { cwd: args.ctx.cwd } : {}),
            ...(args.ctx.sandbox ? { sandbox: args.ctx.sandbox } : {}),
          }
        : undefined;
    const derivedToolParams = deriveToolParams(toolName, normalizedParams, deriveOptions);
    const deriveToolEventParams = (candidateParams: Record<string, unknown>) => {
      const derived = deriveToolParams(toolName, candidateParams, deriveOptions);
      return derived.derivedPaths ? { derivedPaths: derived.derivedPaths } : {};
    };
    const toolIdentity = {
      ...(args.toolKind && { toolKind: args.toolKind }),
      ...(args.toolInputKind && { toolInputKind: args.toolInputKind }),
    };
    const buildToolContext = (identity: typeof toolIdentity) => ({
      toolName,
      ...identity,
      ...(args.ctx?.agentId && { agentId: args.ctx.agentId }),
      ...(args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey }),
      ...(args.ctx?.sessionId && { sessionId: args.ctx.sessionId }),
      ...(args.ctx?.runId && { runId: args.ctx.runId }),
      ...(args.ctx?.trigger && { trigger: args.ctx.trigger }),
      ...(args.ctx?.memoryFlushWritePath && {
        memoryFlushWritePath: args.ctx.memoryFlushWritePath,
      }),
      ...(args.ctx?.trace && { trace: freezeDiagnosticTraceContext(args.ctx.trace) }),
      ...(args.toolCallId && { toolCallId: args.toolCallId }),
      ...(args.ctx?.channelId && { channelId: args.ctx.channelId }),
    });
    const toolContext = buildToolContext(toolIdentity);
    const trustedPolicyResult = shouldRunTrustedPolicies
      ? await runTrustedToolPolicies(
          {
            toolName,
            params: normalizedParams,
            ...toolIdentity,
            ...(args.ctx?.runId && { runId: args.ctx.runId }),
            ...(args.toolCallId && { toolCallId: args.toolCallId }),
            ...(derivedToolParams.derivedPaths
              ? { derivedPaths: derivedToolParams.derivedPaths }
              : {}),
          },
          toolContext,
          {
            ...(args.ctx?.config ? { config: args.ctx.config } : {}),
            deriveEvent: deriveToolEventParams,
            normalizeEvent(eventValue) {
              const normalizedEventParams = normalizeCodeModeExecBeforeHookParamsForToolKind({
                toolKind: eventValue.toolKind,
                params: eventValue.params,
              });
              if (!isPlainObject(normalizedEventParams)) {
                return undefined;
              }
              const normalizedEventIdentity = getCodeModeExecBeforeHookMetadataForToolKind({
                toolKind: eventValue.toolKind,
                params: normalizedEventParams,
              });
              return {
                params: normalizedEventParams,
                ...(normalizedEventIdentity
                  ? { event: normalizedEventIdentity, ctx: normalizedEventIdentity }
                  : {}),
              };
            },
          },
        )
      : undefined;
    if (trustedPolicyResult?.block) {
      return {
        blocked: true,
        kind: "veto",
        deniedReason: "plugin-before-tool-call",
        reason: trustedPolicyResult.blockReason || "Tool call blocked by trusted plugin policy",
        params,
      };
    }
    let trustedApprovalParams: unknown;
    let trustedApprovalResolution: PluginApprovalResolution | undefined;
    if (trustedPolicyResult?.requireApproval) {
      const approvalOutcome = await resolveBeforeToolCallApprovalOutcome({
        result: trustedPolicyResult,
        approvalMode: args.approvalMode,
        toolName,
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
        ...(args.ctx ? { ctx: args.ctx } : {}),
        signal: args.signal,
        baseParams: params,
      });
      if (approvalOutcome) {
        if (approvalOutcome.blocked) {
          return approvalOutcome;
        }
        if (approvalOutcome.deferredApproval) {
          return approvalOutcome;
        }
        trustedApprovalParams = approvalOutcome.params;
        trustedApprovalResolution = approvalOutcome.approvalResolution;
      }
    }
    const rawPolicyAdjustedParams = trustedApprovalParams ?? trustedPolicyResult?.params ?? params;
    const policyAdjustedParams = normalizeCodeModeExecBeforeHookParamsForToolKind({
      toolKind: args.toolKind,
      params: rawPolicyAdjustedParams,
    });
    const policyAdjustedToolIdentity =
      getCodeModeExecBeforeHookMetadataForToolKind({
        toolKind: args.toolKind,
        params: policyAdjustedParams,
      }) ?? toolIdentity;
    const policyAdjustedToolContext = buildToolContext(policyAdjustedToolIdentity);
    const policyAdjustedDerivedToolParams =
      trustedPolicyResult?.params && isPlainObject(policyAdjustedParams)
        ? deriveToolParams(toolName, policyAdjustedParams, deriveOptions)
        : derivedToolParams;
    if (!hasBeforeToolCallHooks) {
      const finalApprovalOutcome = await resolveSkillWorkshopApprovalForFinalParams({
        toolName,
        params: policyAdjustedParams,
        approvalMode: args.approvalMode,
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
        ...(args.ctx ? { ctx: args.ctx } : {}),
        signal: args.signal,
      });
      if (finalApprovalOutcome) {
        return finalApprovalOutcome;
      }
      const allowed: HookOutcome = {
        blocked: false as const,
        params: applySourceReplyStopContractToToolParams(toolName, policyAdjustedParams, args.ctx),
      };
      if (trustedApprovalResolution) {
        allowed.approvalResolution = trustedApprovalResolution;
      }
      return allowed;
    }
    const hookEventParams = isPlainObject(policyAdjustedParams) ? policyAdjustedParams : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: hookEventParams,
        ...policyAdjustedToolIdentity,
        ...(args.ctx?.runId && { runId: args.ctx.runId }),
        ...(args.toolCallId && { toolCallId: args.toolCallId }),
        ...(policyAdjustedDerivedToolParams.derivedPaths
          ? { derivedPaths: policyAdjustedDerivedToolParams.derivedPaths }
          : {}),
      },
      policyAdjustedToolContext,
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        kind: "veto",
        deniedReason: "plugin-before-tool-call",
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
        params: policyAdjustedParams,
      };
    }

    let finalParams = policyAdjustedParams;
    let finalApprovalResolution = trustedApprovalResolution;
    if (hookResult?.requireApproval) {
      const approvalOutcome = await resolveBeforeToolCallApprovalOutcome({
        result: hookResult,
        approvalMode: args.approvalMode,
        toolName,
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
        ...(args.ctx ? { ctx: args.ctx } : {}),
        signal: args.signal,
        baseParams: policyAdjustedParams,
      });
      if (approvalOutcome) {
        if (approvalOutcome.blocked) {
          return approvalOutcome;
        }
        if (approvalOutcome.deferredApproval) {
          return approvalOutcome;
        }
        finalParams = approvalOutcome.params;
        finalApprovalResolution = approvalOutcome.approvalResolution ?? finalApprovalResolution;
      }
    }

    if (hookResult?.params) {
      finalParams = mergeParamsWithApprovalOverrides(finalParams, hookResult.params);
    }
    const finalApprovalOutcome = await resolveSkillWorkshopApprovalForFinalParams({
      toolName,
      params: finalParams,
      approvalMode: args.approvalMode,
      ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
      ...(args.ctx ? { ctx: args.ctx } : {}),
      signal: args.signal,
    });
    if (finalApprovalOutcome) {
      return finalApprovalOutcome;
    }
    const allowed: HookOutcome = {
      blocked: false as const,
      params: applySourceReplyStopContractToToolParams(toolName, finalParams, args.ctx),
    };
    if (finalApprovalResolution) {
      allowed.approvalResolution = finalApprovalResolution;
    }
    return allowed;
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    const cause = unwrapErrorCause(err);
    log.error(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(cause)}`);
    return {
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-before-tool-call",
      reason: BEFORE_TOOL_CALL_HOOK_FAILURE_REASON,
      params,
    };
  }
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
  options: { approvalMode?: "request" | "report"; emitDiagnostics?: boolean } = {},
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const diagnosticIdentity = resolveToolDiagnosticIdentity(tool);
  const hookOptions: BeforeToolCallWrapperOptions = {
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
    emitDiagnostics: options.emitDiagnostics !== false,
  };
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const hookParams = normalizeCodeModeExecBeforeHookParams({ tool, params });
      const hookMetadata = getCodeModeExecBeforeHookMetadata({ tool, params });
      const outcome = await runBeforeToolCallHook({
        toolName,
        params: hookParams,
        ...hookMetadata,
        toolCallId,
        ctx,
        signal,
        approvalMode: hookOptions.approvalMode,
      });
      if (outcome.blocked) {
        if (outcome.kind !== "veto") {
          throw new Error(outcome.reason);
        }
        const normalizedToolName = normalizeToolName(toolName || "tool");
        const trace = ctx?.trace
          ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace))
          : undefined;
        const eventBase = {
          ...(ctx?.runId && { runId: ctx.runId }),
          ...(ctx?.sessionKey && { sessionKey: ctx.sessionKey }),
          ...(ctx?.sessionId && { sessionId: ctx.sessionId }),
          ...(trace && { trace }),
          toolName: normalizedToolName,
          ...diagnosticIdentity,
          ...(toolCallId && { toolCallId }),
          paramsSummary: summarizeToolParams(outcome.params ?? hookParams),
        };
        if (hookOptions.emitDiagnostics) {
          emitTrustedDiagnosticEvent({
            type: "tool.execution.blocked",
            ...eventBase,
            reason: outcome.reason,
            deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
          });
        }
        const blockedResult = buildBlockedToolResult({
          reason: outcome.reason,
          deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params ?? hookParams,
          toolCallId,
          result: blockedResult,
        });
        return blockedResult;
      }
      const executeParams = reconcileCodeModeExecBeforeHookParams({
        tool,
        originalParams: params,
        hookParams,
        adjustedParams: outcome.params,
      });
      recordAdjustedParamsForToolCall(toolCallId, executeParams, ctx?.runId);
      const normalizedToolName = normalizeToolName(toolName || "tool");
      const trace = ctx?.trace
        ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace))
        : undefined;
      const eventBase = {
        ...(ctx?.runId && { runId: ctx.runId }),
        ...(ctx?.sessionKey && { sessionKey: ctx.sessionKey }),
        ...(ctx?.sessionId && { sessionId: ctx.sessionId }),
        ...(trace && { trace }),
        toolName: normalizedToolName,
        ...diagnosticIdentity,
        ...(toolCallId && { toolCallId }),
        paramsSummary: summarizeToolParams(executeParams),
      };
      if (hookOptions.emitDiagnostics) {
        emitTrustedDiagnosticEvent({
          type: "tool.execution.started",
          ...eventBase,
        });
      }
      const startedAt = Date.now();
      try {
        const result = await execute(toolCallId, executeParams, signal, onUpdate);
        const durationMs = Date.now() - startedAt;
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: executeParams,
          toolCallId,
          result,
        });
        const skillMatch = findSkillUsageMatch({
          toolName: normalizedToolName,
          toolParams: executeParams,
          ctx,
        });
        if (hookOptions.emitDiagnostics) {
          if (skillMatch) {
            emitSkillUsedDiagnostic({
              ctx,
              match: skillMatch,
              toolName: normalizedToolName,
              toolCallId,
            });
          }
          emitTrustedDiagnosticEvent({
            type: "tool.execution.completed",
            ...eventBase,
            durationMs,
          });
        }
        return result;
      } catch (err) {
        const cause = unwrapErrorCause(err);
        const errorCode = diagnosticHttpStatusCode(cause);
        if (hookOptions.emitDiagnostics) {
          emitTrustedDiagnosticEvent({
            type: "tool.execution.error",
            ...eventBase,
            durationMs: Date.now() - startedAt,
            errorCategory: diagnosticErrorCategory(cause),
            ...(errorCode ? { errorCode } : {}),
          });
        }
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: executeParams,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS, {
    value: hookOptions,
    enumerable: false,
  });
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_SOURCE_TOOL, {
    value: tool,
    enumerable: false,
  });
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_HOOK_CONTEXT, {
    value: ctx,
    enumerable: false,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  const options = taggedTool[BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS];
  if (options && typeof options === "object" && "emitDiagnostics" in options) {
    (options as { emitDiagnostics: boolean }).emitDiagnostics = enabled;
  }
}

export function rewrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
  options: { approvalMode?: "request" | "report"; emitDiagnostics?: boolean } = {},
): AnyAgentTool {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  const source = taggedTool[BEFORE_TOOL_CALL_SOURCE_TOOL];
  const wrappedContext = taggedTool[BEFORE_TOOL_CALL_HOOK_CONTEXT];
  const preservedContext =
    wrappedContext && typeof wrappedContext === "object"
      ? (wrappedContext as HookContext)
      : undefined;
  return wrapToolWithBeforeToolCallHook(
    source && typeof source === "object" ? (source as AnyAgentTool) : tool,
    ctx ?? preservedContext,
    options,
  );
}

export function copyBeforeToolCallHookMarker(source: AnyAgentTool, target: AnyAgentTool): void {
  if (!isToolWrappedWithBeforeToolCallHook(source)) {
    return;
  }
  Object.defineProperty(target, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  const taggedSource = source as unknown as Record<symbol, unknown>;
  const sourceTool = taggedSource[BEFORE_TOOL_CALL_SOURCE_TOOL];
  if (sourceTool && typeof sourceTool === "object") {
    Object.defineProperty(target, BEFORE_TOOL_CALL_SOURCE_TOOL, {
      value: sourceTool,
      enumerable: false,
    });
  }
  const hookContext = taggedSource[BEFORE_TOOL_CALL_HOOK_CONTEXT];
  Object.defineProperty(target, BEFORE_TOOL_CALL_HOOK_CONTEXT, {
    value: hookContext,
    enumerable: false,
  });
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

export const testing = {
  BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS,
  BEFORE_TOOL_CALL_HOOK_CONTEXT,
  BEFORE_TOOL_CALL_SOURCE_TOOL,
  BEFORE_TOOL_CALL_WRAPPED,
  buildAdjustedParamsKey,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  mergeParamsWithApprovalOverrides,
  isPlainObject,
};
export { testing as __testing };

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value, { cause: value });
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
