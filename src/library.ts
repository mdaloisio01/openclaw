import type { getReplyFromConfig as getReplyFromConfigRuntime } from "./auto-reply/reply.runtime.js";
import { applyTemplate } from "./auto-reply/templating.js";
import { createDefaultDeps } from "./cli/deps.js";
import type { promptYesNo as promptYesNoRuntime } from "./cli/prompt.js";
import { waitForever } from "./cli/wait.js";
import { loadConfig } from "./config/config.js";
import { resolveStorePath } from "./config/sessions/paths.js";
import { deriveSessionKey, resolveSessionKey } from "./config/sessions/session-key.js";
import { loadSessionStore, saveSessionStore } from "./config/sessions/store.js";
import type { ensureBinary as ensureBinaryRuntime } from "./infra/binaries.js";
import {
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./infra/ports.js";
import type { monitorWebChannel as monitorWebChannelRuntime } from "./plugins/runtime/runtime-web-channel-plugin.js";
import type {
  runCommandWithTimeout as runCommandWithTimeoutRuntime,
  runExec as runExecRuntime,
} from "./process/exec.js";
import { normalizeE164 } from "./utils.js";

type GetReplyFromConfig = typeof getReplyFromConfigRuntime;
type PromptYesNo = typeof promptYesNoRuntime;
type EnsureBinary = typeof ensureBinaryRuntime;
type RunExec = typeof runExecRuntime;
type RunCommandWithTimeout = typeof runCommandWithTimeoutRuntime;
type MonitorWebChannel = typeof monitorWebChannelRuntime;

let replyRuntimePromise: Promise<typeof import("./auto-reply/reply.runtime.js")> | null = null;
let promptRuntimePromise: Promise<typeof import("./cli/prompt.js")> | null = null;
let binariesRuntimePromise: Promise<typeof import("./infra/binaries.js")> | null = null;
let execRuntimePromise: Promise<typeof import("./process/exec.js")> | null = null;
let webChannelRuntimePromise: Promise<
  typeof import("./plugins/runtime/runtime-web-channel-plugin.js")
> | null = null;

function loadReplyRuntime() {
  replyRuntimePromise ??= import("./auto-reply/reply.runtime.js");
  return replyRuntimePromise;
}

function loadPromptRuntime() {
  promptRuntimePromise ??= import("./cli/prompt.js");
  return promptRuntimePromise;
}

function loadBinariesRuntime() {
  binariesRuntimePromise ??= import("./infra/binaries.js");
  return binariesRuntimePromise;
}

function loadExecRuntime() {
  execRuntimePromise ??= import("./process/exec.js");
  return execRuntimePromise;
}

function loadWebChannelRuntime() {
  webChannelRuntimePromise ??= import("./plugins/runtime/runtime-web-channel-plugin.js");
  return webChannelRuntimePromise;
}

export const getReplyFromConfig: GetReplyFromConfig = async (...args) =>
  (await loadReplyRuntime()).getReplyFromConfig(...args);
export const promptYesNo: PromptYesNo = async (...args) =>
  (await loadPromptRuntime()).promptYesNo(...args);
export const ensureBinary: EnsureBinary = async (...args) =>
  (await loadBinariesRuntime()).ensureBinary(...args);
export const runExec: RunExec = async (...args) => (await loadExecRuntime()).runExec(...args);
export const runCommandWithTimeout: RunCommandWithTimeout = async (...args) =>
  (await loadExecRuntime()).runCommandWithTimeout(...args);
export const monitorWebChannel: MonitorWebChannel = async (...args) =>
  (await loadWebChannelRuntime()).monitorWebChannel(...args);

export {
  applyTemplate,
  createDefaultDeps,
  deriveSessionKey,
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  loadConfig,
  loadSessionStore,
  normalizeE164,
  PortInUseError,
  resolveSessionKey,
  resolveStorePath,
  saveSessionStore,
  waitForever,
};

export {
  CLEANUP_WATCHDOG_ACCEPTED_READ_VERSIONS,
  CLEANUP_WATCHDOG_ACTIVATION_GATES,
  CLEANUP_WATCHDOG_CLEAN_DIMENSIONS,
  CLEANUP_WATCHDOG_COVERAGE_KINDS,
  CLEANUP_WATCHDOG_POLICY_VERSION,
  CLEANUP_WATCHDOG_PRIORITY_ORDER,
  compareCleanupWatchdogPriority,
  evaluateCleanupWatchdogCoverage,
  getCleanupWatchdogPriority,
  isCleanupWatchdogPolicyVersionCompatible,
  type CleanupWatchdogActivationGate,
  type CleanupWatchdogCleanDimension,
  type CleanupWatchdogCoverageDecision,
  type CleanupWatchdogCoverageInput,
  type CleanupWatchdogCoverageKind,
  type CleanupWatchdogFindingCategory,
  type CleanupWatchdogPolicyVersion,
  type CleanupWatchdogPriorityCode,
} from "./governance/cleanup-watchdog-policy.js";
export {
  createCleanupWatchdogShadowInputFromReceipt,
  evaluateCleanupWatchdogActivationGate,
  reconcileCleanupWatchdogMission,
  type CleanupWatchdogActivationGateDecision,
  type CleanupWatchdogActivationGateInput,
  type CleanupWatchdogActivationMode,
  type CleanupWatchdogControllerDecision,
  type CleanupWatchdogControllerFinding,
  type CleanupWatchdogControllerInput,
  type CleanupWatchdogControllerMode,
  type CleanupWatchdogReceiptItemSnapshot,
  type CleanupWatchdogReceiptSnapshot,
} from "./governance/cleanup-watchdog-controller.js";
export {
  CLEANUP_WATCHDOG_LIVE_CONTROLLER_SCHEMA,
  activateCleanupWatchdogLiveController,
  consumeReceiptWithLiveController,
  evaluateReceiptWithLiveController,
  getCleanupWatchdogLiveControllerState,
  resolveCleanupWatchdogLiveControllerPaths,
  rollbackCleanupWatchdogLiveController,
  runCleanupWatchdogLiveRecoveryExercise,
  runCleanupWatchdogControlledCanaries,
  type CleanupWatchdogActivationParams,
  type CleanupWatchdogCanaryResult,
  type CleanupWatchdogCanarySuiteResult,
  type CleanupWatchdogLiveRecoveryExerciseResult,
  type CleanupWatchdogReceiptConsumptionResult,
  type CleanupWatchdogLiveControllerPaths,
  type CleanupWatchdogLiveControllerState,
} from "./governance/cleanup-watchdog-live-controller.js";
export {
  evaluateFalseCloseoutAdmission,
  resolveFalseCloseoutAdmissionMode,
} from "./governance/false-closeout-admission-controller.js";
export {
  compileMissionPlan,
  type CompiledMissionPlan,
} from "./governance/mission-plan-compiler.js";
export { writeEvidenceReceipt, sha256Text } from "./governance/mission-evidence-store.js";
export { latestPassingReceiptForGate } from "./governance/mission-gate-registry.js";
export {
  reconcileTestManifest,
  type TestManifestReconciliation,
} from "./governance/test-manifest.js";
export {
  rollbackReceiptValid,
  restorationReceiptValid,
} from "./governance/rollback-restoration-state.js";
export { exportManifestComplete } from "./governance/mission-export-packager.js";
export { grantApprovalFresh } from "./agents/grant-evidence-review.js";
export type {
  AcceptanceGate,
  CloseoutAdmissionInput,
  CompletionDecision,
  CompletionDecisionState,
  CompletionRejection,
  CompletionRejectionCode,
  CompletionRequest,
  EvidenceReceipt,
  ExportManifest,
  GateKind,
  GrantApprovalReceipt,
  MissionIdentity,
  MissionManifest,
  MissionMode,
  RawTestResult,
  RepairWorkState,
  RequirementManifest,
  RequirementManifestItem,
  RequirementStatus,
  RestorationReceipt,
  RollbackReceipt,
  RuntimeCloseoutState,
  TestManifest,
  WatchdogState,
} from "./governance/mission-manifest.types.js";
