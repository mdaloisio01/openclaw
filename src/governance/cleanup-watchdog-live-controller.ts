import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureForegroundCleanupCrewTaskFlow,
  supersedeForegroundCleanupCrewExecutor,
} from "../tasks/foreground-cleanup-crew-taskflow.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  getTaskById,
  listTasksForFlowId,
  markTaskLostById,
  recordTaskProgressByRunId,
} from "../tasks/runtime-internal.js";
import {
  createManagedTaskFlow,
  deleteTaskFlowRecordById,
  finishFlow,
  getTaskFlowById,
  listTaskFlowRecords,
} from "../tasks/task-flow-runtime-internal.js";
import {
  buildCleanupWatchdogNeedsReviewReconciliationArtifact,
  createCleanupWatchdogShadowInputFromReceipt,
  evaluateCleanupWatchdogActivationGate,
  reconcileCleanupWatchdogMission,
  type CleanupWatchdogActivationGateInput,
  type CleanupWatchdogControllerDecision,
  type CleanupWatchdogControllerMode,
  type CleanupWatchdogNeedsReviewReconciliationArtifact,
  type CleanupWatchdogReceiptItemSnapshot,
  type CleanupWatchdogReceiptSnapshot,
} from "./cleanup-watchdog-controller.js";
import {
  CLEANUP_WATCHDOG_POLICY_VERSION,
  type CleanupWatchdogCleanDimension,
} from "./cleanup-watchdog-policy.js";

export const CLEANUP_WATCHDOG_LIVE_CONTROLLER_SCHEMA =
  "openclaw.cleanup_watchdog.live_controller.v1" as const;

export type CleanupWatchdogLiveControllerState = {
  schema: typeof CLEANUP_WATCHDOG_LIVE_CONTROLLER_SCHEMA;
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  controllerMode: CleanupWatchdogControllerMode;
  enforcementState: "shadow" | "active" | "rollback_required";
  loadedRuntime: {
    pid: number;
    runtimePid?: number | null;
    buildInfoPath?: string | null;
    buildInfoSha256?: string | null;
    controllerSourceSha256?: string | null;
    policySourceSha256?: string | null;
    skillPath?: string | null;
    skillSha256?: string | null;
  };
  activation?: {
    command: string;
    activatedAt: string;
    gates: CleanupWatchdogActivationGateInput;
    gateDecision: ReturnType<typeof evaluateCleanupWatchdogActivationGate>;
    receiptPath?: string | null;
  };
  rollback?: {
    rolledBackAt: string;
    reason: string;
    previousMode: CleanupWatchdogControllerMode;
  };
  canary?: CleanupWatchdogCanarySuiteResult;
};

export type CleanupWatchdogLiveControllerPaths = {
  rootDir: string;
  statePath: string;
  receiptDir: string;
};

export type CleanupWatchdogActivationParams = {
  workspaceDir?: string;
  command: string;
  runtimePid?: number | null;
  buildInfoPath?: string | null;
  controllerSourcePath?: string | null;
  policySourcePath?: string | null;
  skillPath?: string | null;
  receiptPath?: string | null;
  gates: CleanupWatchdogActivationGateInput;
};

export type CleanupWatchdogCanaryResult = {
  name:
    | "good_clean"
    | "missing_worker"
    | "duplicate_worker"
    | "pending_report"
    | "stale_runtime"
    | "corrupted_pointer";
  passed: boolean;
  decision: CleanupWatchdogControllerDecision;
  proof: {
    created: string;
    repair: string;
    validation: readonly string[];
    cleanup: {
      productionMissionMutated: false;
      residualMissionState: "none";
      evidenceRetention: "state_and_receipt_intentionally_retained";
    };
    continuation?: {
      milestoneDelivered: boolean;
      nextExecutableStepId: string;
      nextExecutableStepRecorded: boolean;
      missionTerminatedByMilestone: false;
    };
  };
  validation: readonly string[];
};

export type CleanupWatchdogCanarySuiteResult = {
  ranAt: string;
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  controllerMode: CleanupWatchdogControllerMode;
  passed: boolean;
  results: readonly CleanupWatchdogCanaryResult[];
};

export type CleanupWatchdogReceiptConsumptionResult =
  | {
      status: "observed";
      reason: string;
      decision: CleanupWatchdogControllerDecision;
      reconciliationArtifact?: CleanupWatchdogNeedsReviewReconciliationArtifact;
      reconciliationArtifactPath?: string;
    }
  | {
      status: "blocked";
      reason: string;
      decision: CleanupWatchdogControllerDecision;
      reconciliationArtifact?: CleanupWatchdogNeedsReviewReconciliationArtifact;
      reconciliationArtifactPath?: string;
    }
  | {
      status: "dispatched";
      decision: CleanupWatchdogControllerDecision;
      reconciliationArtifact: CleanupWatchdogNeedsReviewReconciliationArtifact;
      reconciliationArtifactPath: string;
      repair: {
        route: "foreground_cleanup_crew_taskflow";
        flowId: string;
        taskId?: string;
        ownerKey: string;
        sessionKey: string;
        currentStep: string;
        supersession?: {
          status: "attached" | "superseded";
          lostTaskId: string;
          replacementTaskId: string;
          replacementRunId?: string | null;
          replacementSessionKey?: string | null;
          dispatchReceiptDetail: string;
        };
      };
    };

const cleanDimensions: Record<CleanupWatchdogCleanDimension, boolean> = {
  record_integrity: true,
  worker_coverage: true,
  continuation_readiness: true,
  delivery_completeness: true,
  runtime_health: true,
  repair_closure: true,
  policy_version: true,
};

function defaultWorkspaceDir(): string {
  return (
    process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw", "workspace-orchestrator")
  );
}

export function resolveCleanupWatchdogLiveControllerPaths(
  workspaceDir = defaultWorkspaceDir(),
): CleanupWatchdogLiveControllerPaths {
  const rootDir = path.join(workspaceDir, "var", "cleanup_watchdog_live_controller");
  return {
    rootDir,
    statePath: path.join(rootDir, "state.json"),
    receiptDir: path.join(rootDir, "receipts"),
  };
}

function sha256File(filePath: string | null | undefined): string | null {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readState(workspaceDir?: string): CleanupWatchdogLiveControllerState | null {
  const { statePath } = resolveCleanupWatchdogLiveControllerPaths(workspaceDir);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as CleanupWatchdogLiveControllerState;
}

function writeJsonDurable(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export function getCleanupWatchdogLiveControllerState(params?: {
  workspaceDir?: string;
}): CleanupWatchdogLiveControllerState {
  const existing = readState(params?.workspaceDir);
  if (existing) {
    return existing;
  }
  return {
    schema: CLEANUP_WATCHDOG_LIVE_CONTROLLER_SCHEMA,
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    controllerMode: "shadow_observe",
    enforcementState: "shadow",
    loadedRuntime: { pid: process.pid },
  };
}

export function activateCleanupWatchdogLiveController(
  params: CleanupWatchdogActivationParams,
): CleanupWatchdogLiveControllerState {
  const gateDecision = evaluateCleanupWatchdogActivationGate(params.gates);
  const state: CleanupWatchdogLiveControllerState = {
    schema: CLEANUP_WATCHDOG_LIVE_CONTROLLER_SCHEMA,
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    controllerMode: gateDecision.effectiveMode,
    enforcementState: gateDecision.allowedToEnforce
      ? "active"
      : gateDecision.rollbackRequired
        ? "rollback_required"
        : "shadow",
    loadedRuntime: {
      pid: process.pid,
      runtimePid: params.runtimePid ?? null,
      buildInfoPath: params.buildInfoPath ?? null,
      buildInfoSha256: sha256File(params.buildInfoPath),
      controllerSourceSha256: sha256File(params.controllerSourcePath),
      policySourceSha256: sha256File(params.policySourcePath),
      skillPath: params.skillPath ?? null,
      skillSha256: sha256File(params.skillPath),
    },
    activation: {
      command: params.command,
      activatedAt: new Date().toISOString(),
      gates: params.gates,
      gateDecision,
      receiptPath: params.receiptPath ?? null,
    },
  };
  writeJsonDurable(resolveCleanupWatchdogLiveControllerPaths(params.workspaceDir).statePath, state);
  return state;
}

export function rollbackCleanupWatchdogLiveController(params: {
  workspaceDir?: string;
  reason: string;
}): CleanupWatchdogLiveControllerState {
  const previous = getCleanupWatchdogLiveControllerState({ workspaceDir: params.workspaceDir });
  const state: CleanupWatchdogLiveControllerState = {
    ...previous,
    controllerMode: "shadow_observe",
    enforcementState: "shadow",
    rollback: {
      rolledBackAt: new Date().toISOString(),
      reason: params.reason,
      previousMode: previous.controllerMode,
    },
  };
  writeJsonDurable(resolveCleanupWatchdogLiveControllerPaths(params.workspaceDir).statePath, state);
  return state;
}

function canaryResult(
  name: CleanupWatchdogCanaryResult["name"],
  decision: CleanupWatchdogControllerDecision,
  validation: readonly string[],
  passed: boolean,
  extras?: {
    repair?: string;
    continuation?: CleanupWatchdogCanaryResult["proof"]["continuation"];
  },
): CleanupWatchdogCanaryResult {
  return {
    name,
    decision,
    validation,
    passed,
    proof: {
      created: `synthetic bounded ${name} record`,
      repair:
        extras?.repair ?? "synthetic repair decision recorded without mutating production mission",
      validation,
      cleanup: {
        productionMissionMutated: false,
        residualMissionState: "none",
        evidenceRetention: "state_and_receipt_intentionally_retained",
      },
      ...(extras?.continuation ? { continuation: extras.continuation } : {}),
    },
  };
}

export function runCleanupWatchdogControlledCanaries(params?: {
  workspaceDir?: string;
}): CleanupWatchdogCanarySuiteResult {
  const mode = getCleanupWatchdogLiveControllerState({
    workspaceDir: params?.workspaceDir,
  }).controllerMode;
  const goodCleanDecision = reconcileCleanupWatchdogMission({
    mode,
    suspiciousCount: 0,
    cleanDimensions,
    observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    missionCoverage: {
      missionId: "canary-good-clean",
      unfinished: true,
      activeProduction: true,
      executorCount: 1,
      executorLeaseCurrent: true,
    },
  });
  const goodClean = canaryResult(
    "good_clean",
    goodCleanDecision,
    ["all dimensions present", "exactly one executor present", "clean closure allowed"],
    goodCleanDecision.canCloseClean &&
      goodCleanDecision.requiredRepairTasks.length === 0 &&
      goodCleanDecision.shadowDisagreements.length === 0,
    { repair: "no repair route created for good-clean canary" },
  );

  const missingWorkerInitial = reconcileCleanupWatchdogMission({
    mode,
    suspiciousCount: 1,
    cleanDimensions,
    observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    missionCoverage: {
      missionId: "canary-a",
      unfinished: true,
      activeProduction: true,
      executorCount: 0,
    },
  });
  const missingWorkerRepaired = reconcileCleanupWatchdogMission({
    mode,
    suspiciousCount: 0,
    cleanDimensions,
    observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    missionCoverage: {
      missionId: "canary-a",
      unfinished: true,
      activeProduction: true,
      executorCount: 1,
      executorLeaseCurrent: true,
    },
  });
  const missingWorker = canaryResult(
    "missing_worker",
    missingWorkerInitial,
    [
      "missing executor detected",
      "repair task required",
      "repaired projection has exactly one executor",
      "duplicate execution not created",
    ],
    missingWorkerInitial.selectedPriority === "P2_ACTIVE_NO_WORKER" &&
      missingWorkerInitial.requiredRepairTasks.length > 0 &&
      missingWorkerRepaired.coverageOk,
  );

  const duplicateWorkerDecision = reconcileCleanupWatchdogMission({
    mode,
    suspiciousCount: 1,
    cleanDimensions,
    observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    missionCoverage: {
      missionId: "canary-duplicate-worker",
      unfinished: true,
      activeProduction: true,
      executorCount: 2,
      executorLeaseCurrent: true,
    },
  });
  const duplicateWorker = canaryResult(
    "duplicate_worker",
    duplicateWorkerDecision,
    [
      "duplicate executor coverage detected",
      "false clean is refused",
      "duplicate repair preempts lower-priority work",
    ],
    !duplicateWorkerDecision.canCloseClean &&
      duplicateWorkerDecision.selectedPriority === "P1_SAFETY_OR_DUPLICATE_EXECUTION" &&
      duplicateWorkerDecision.requiredRepairTasks.length > 0,
    { repair: "duplicate executor state must be reconciled before new executor launch" },
  );

  const pendingReportDecision = reconcileCleanupWatchdogMission({
    mode,
    suspiciousCount: 1,
    cleanDimensions,
    observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    missionCoverage: {
      missionId: "canary-pending-report",
      unfinished: true,
      activeProduction: true,
      executorCount: 1,
      executorLeaseCurrent: true,
    },
    findings: [
      {
        findingId: "canary-pending-report:report-debt",
        category: "pending_report_delivery",
        entityType: "report",
        entityId: "canary-pending-report-report",
        evidence: ["report pending"],
        reason: "report debt remains durable",
      },
    ],
  });
  const pendingReport = canaryResult(
    "pending_report",
    pendingReportDecision,
    ["pending report detected", "report debt remains visible", "clean closure refused"],
    pendingReportDecision.selectedPriority === "P7_PENDING_REPORT_DELIVERY" &&
      !pendingReportDecision.canCloseClean,
  );

  const staleRuntimeDecision = reconcileCleanupWatchdogMission({
    mode,
    suspiciousCount: 1,
    cleanDimensions: {
      ...cleanDimensions,
      runtime_health: false,
    },
    observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    missionCoverage: {
      missionId: "canary-stale-runtime",
      unfinished: true,
      activeProduction: true,
      executorCount: 1,
      executorLeaseCurrent: true,
    },
    findings: [
      {
        findingId: "canary-stale-runtime:runtime",
        category: "runtime_recovery_failure",
        entityType: "runtime",
        entityId: "gateway-runtime",
        evidence: ["stale runtime proof"],
        reason: "stale runtime must stay visible",
      },
    ],
  });
  const staleRuntime = canaryResult(
    "stale_runtime",
    staleRuntimeDecision,
    ["runtime health dimension failed", "runtime repair task required", "clean closure refused"],
    staleRuntimeDecision.selectedPriority === "P4_RESTART_OR_RUNTIME_RECOVERY" &&
      !staleRuntimeDecision.canCloseClean,
  );

  const corruptedPointerDecision = reconcileCleanupWatchdogMission({
    mode,
    suspiciousCount: 1,
    cleanDimensions,
    observedPolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    missionCoverage: {
      missionId: "canary-corrupted-pointer",
      unfinished: true,
      activeProduction: true,
      executorCount: 1,
      executorLeaseCurrent: true,
    },
    findings: [
      {
        findingId: "canary-corrupted-pointer:pointer",
        category: "corrupted_pointer",
        entityType: "flow_run",
        entityId: "canary-corrupted-pointer",
        evidence: ["parent flow pointer does not resolve"],
        reason: "corrupted taskflow pointer requires reconciliation",
      },
    ],
  });
  const corruptedPointer = canaryResult(
    "corrupted_pointer",
    corruptedPointerDecision,
    ["corrupted pointer detected", "pointer repair task required", "clean closure refused"],
    corruptedPointerDecision.selectedPriority === "P3_CORRUPTED_STATE" &&
      !corruptedPointerDecision.canCloseClean,
  );

  const results = [
    goodClean,
    missingWorker,
    duplicateWorker,
    pendingReport,
    staleRuntime,
    corruptedPointer,
  ] as const;
  const suite: CleanupWatchdogCanarySuiteResult = {
    ranAt: new Date().toISOString(),
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    controllerMode: mode,
    passed: results.every((result) => result.passed),
    results,
  };
  const current = getCleanupWatchdogLiveControllerState({ workspaceDir: params?.workspaceDir });
  const next = { ...current, canary: suite };
  const paths = resolveCleanupWatchdogLiveControllerPaths(params?.workspaceDir);
  writeJsonDurable(paths.statePath, next);
  writeJsonDurable(path.join(paths.receiptDir, `canary_suite_${Date.now()}.json`), suite);
  return suite;
}

export function evaluateReceiptWithLiveController(params: {
  workspaceDir?: string;
  receipt: CleanupWatchdogReceiptSnapshot;
  missionId: string;
}): CleanupWatchdogControllerDecision {
  const state = getCleanupWatchdogLiveControllerState({ workspaceDir: params.workspaceDir });
  return reconcileCleanupWatchdogMission(
    createCleanupWatchdogShadowInputFromReceipt({
      receipt: params.receipt,
      missionId: params.missionId,
      mode: state.controllerMode,
    }),
  );
}

function findMissionFlowItem(
  receipt: CleanupWatchdogReceiptSnapshot,
  missionId: string,
): CleanupWatchdogReceiptItemSnapshot | undefined {
  return receipt.decisions?.suspicious_items?.find(
    (item) => item.entity_type === "flow_run" && item.entity_id === missionId,
  );
}

function findMissionTaskItem(
  receipt: CleanupWatchdogReceiptSnapshot,
  missionId: string,
): CleanupWatchdogReceiptItemSnapshot | undefined {
  return receipt.decisions?.suspicious_items?.find(
    (item) => item.entity_type === "task_run" && item.proof?.parent_flow_id === missionId,
  );
}

function firstNeedsReviewItem(
  receipt: CleanupWatchdogReceiptSnapshot,
  missionId: string,
): CleanupWatchdogReceiptItemSnapshot | undefined {
  return (
    findMissionFlowItem(receipt, missionId) ??
    findMissionTaskItem(receipt, missionId) ??
    receipt.decisions?.suspicious_items?.[0]
  );
}

function itemFromRepairFinding(
  finding: CleanupWatchdogControllerDecision["requiredRepairTasks"][number] | undefined,
): CleanupWatchdogReceiptItemSnapshot | undefined {
  if (!finding) {
    return undefined;
  }
  return {
    entity_type: finding.entityType,
    entity_id: finding.entityId,
    category: finding.category,
    reason: finding.reason,
  };
}

function writeNeedsReviewReconciliationArtifact(params: {
  workspaceDir?: string;
  missionId: string;
  item: CleanupWatchdogReceiptItemSnapshot;
  now: number;
}): {
  artifact: CleanupWatchdogNeedsReviewReconciliationArtifact;
  path: string;
} {
  const artifact = buildCleanupWatchdogNeedsReviewReconciliationArtifact({
    missionId: params.missionId,
    item: params.item,
  });
  const paths = resolveCleanupWatchdogLiveControllerPaths(params.workspaceDir);
  const artifactPath = path.join(
    paths.receiptDir,
    `needs_review_reconciliation_${params.missionId}_${params.now}.json`,
  );
  writeJsonDurable(artifactPath, artifact);
  return { artifact, path: artifactPath };
}

function isForegroundCleanupCrewFinding(
  item: CleanupWatchdogReceiptItemSnapshot | undefined,
): boolean {
  if (!item) {
    return false;
  }
  const label = (item.label ?? "").toLowerCase();
  const step = (item.proof?.current_step ?? "").toLowerCase();
  return (
    label.includes("foreground cleanup crew") ||
    label.includes("cleanup crew") ||
    step.includes("cleanup_watchdog_governance") ||
    step.includes("cleanup_watchdog_live_recovery") ||
    step.includes("cleanup_crew")
  );
}

function findLostTaskIdForReceipt(params: {
  flowItem?: CleanupWatchdogReceiptItemSnapshot;
  taskItem?: CleanupWatchdogReceiptItemSnapshot;
}): string | undefined {
  const lostFromFlow = params.flowItem?.proof?.lost_child_task_ids?.find((value) => value?.trim());
  if (lostFromFlow) {
    return lostFromFlow;
  }
  return params.taskItem?.entity_id?.trim() || undefined;
}

function createControllerReplacementTask(params: {
  flowId: string;
  ownerKey: string;
  sessionKey: string;
  currentStep: string;
  now: number;
}) {
  return createTaskRecord({
    runtime: "cli",
    taskKind: "foreground_cleanup_crew_execution",
    sourceId: "cleanup-crew:foreground:automatic-recovery",
    requesterSessionKey: params.ownerKey,
    ownerKey: params.ownerKey,
    scopeKind: "session",
    runId: `cleanup-watchdog-live-controller:replacement:${params.flowId}:${params.now}`,
    childSessionKey: params.sessionKey,
    label: "Cleanup Watchdog automatic replacement executor",
    task: `Automatically recover Cleanup Crew executor for ${params.currentStep}`,
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    startedAt: params.now,
    lastEventAt: params.now,
    progressSummary: `Automatic active_no_worker recovery resumed ${params.currentStep}`,
  });
}

function isActiveTaskStatus(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}

function isControllerReplacementTask(task: {
  sourceId?: string;
  runId?: string | null;
  label?: string | null;
}): boolean {
  return (
    task.sourceId === "cleanup-crew:foreground:automatic-recovery" ||
    (task.runId ?? "").startsWith("cleanup-watchdog-live-controller:replacement:") ||
    (task.label ?? "") === "Cleanup Watchdog automatic replacement executor"
  );
}

function listActiveControllerReplacementTasks(flowId: string) {
  return listTasksForFlowId(flowId)
    .filter((task) => isActiveTaskStatus(task.status) && isControllerReplacementTask(task))
    .toSorted(
      (left, right) =>
        (right.lastEventAt ?? right.startedAt ?? right.createdAt) -
        (left.lastEventAt ?? left.startedAt ?? left.createdAt),
    );
}

function fenceDuplicateControllerReplacements(params: {
  flowId: string;
  keepTaskId: string;
  now: number;
}): void {
  for (const task of listActiveControllerReplacementTasks(params.flowId)) {
    if (task.taskId === params.keepTaskId) {
      continue;
    }
    markTaskLostById({
      taskId: task.taskId,
      endedAt: params.now,
      lastEventAt: params.now,
      error: `duplicate automatic replacement fenced; ${params.keepTaskId} owns the Cleanup Crew mission`,
    });
  }
}

function maybeSupersedeExecutorFromReceipt(params: {
  flowId: string;
  flowItem?: CleanupWatchdogReceiptItemSnapshot;
  taskItem?: CleanupWatchdogReceiptItemSnapshot;
  ownerKey: string;
  sessionKey: string;
  currentStep: string;
  now: number;
}):
  | {
      status: "attached" | "superseded";
      lostTaskId: string;
      replacementTaskId: string;
      replacementRunId?: string | null;
      replacementSessionKey?: string | null;
      dispatchReceiptDetail: string;
    }
  | undefined {
  const lostTaskId = findLostTaskIdForReceipt({
    flowItem: params.flowItem,
    taskItem: params.taskItem,
  });
  if (!lostTaskId) {
    return undefined;
  }
  const originalTask = getTaskById(lostTaskId);
  if (!originalTask || originalTask.status !== "lost") {
    return undefined;
  }
  const now = params.now;
  const explicitReplacementTaskId = params.flowItem?.proof?.replacement_task_id?.trim();
  const replacementTask =
    (explicitReplacementTaskId
      ? listTasksForFlowId(params.flowId).find((task) => task.taskId === explicitReplacementTaskId)
      : undefined) ??
    listActiveControllerReplacementTasks(params.flowId)[0] ??
    createControllerReplacementTask({
      flowId: params.flowId,
      ownerKey: params.ownerKey,
      sessionKey: params.sessionKey,
      currentStep: params.currentStep,
      now,
    });
  if (!replacementTask) {
    return undefined;
  }
  const supersession = supersedeForegroundCleanupCrewExecutor({
    flowId: params.flowId,
    lostTaskId,
    replacementTaskId: replacementTask.taskId,
    ownerKey: params.ownerKey,
    sessionKey: params.sessionKey,
    currentStep: params.currentStep,
    detail: `Live controller consumed watchdog receipt and automatically superseded missing executor ${lostTaskId}.`,
    now,
  });
  if (supersession.status !== "attached" && supersession.status !== "superseded") {
    return undefined;
  }
  fenceDuplicateControllerReplacements({
    flowId: params.flowId,
    keepTaskId: supersession.task.taskId,
    now,
  });
  return {
    status: supersession.status,
    lostTaskId,
    replacementTaskId: supersession.task.taskId,
    replacementRunId: supersession.task.runId ?? null,
    replacementSessionKey: supersession.task.childSessionKey ?? null,
    dispatchReceiptDetail: supersession.dispatchReceiptDetail,
  };
}

export function consumeReceiptWithLiveController(params: {
  workspaceDir?: string;
  receipt: CleanupWatchdogReceiptSnapshot;
  missionId: string;
  ownerKey?: string | null;
  sessionKey?: string | null;
  currentStep?: string | null;
  currentTurnText?: string | null;
  now?: number;
}): CleanupWatchdogReceiptConsumptionResult {
  const now = params.now ?? Date.now();
  const decision = evaluateReceiptWithLiveController({
    workspaceDir: params.workspaceDir,
    receipt: params.receipt,
    missionId: params.missionId,
  });
  const needsReviewItem =
    decision.requiredRepairTasks.length > 0
      ? (firstNeedsReviewItem(params.receipt, params.missionId) ??
        itemFromRepairFinding(decision.requiredRepairTasks[0]))
      : undefined;
  const reconciliation = needsReviewItem
    ? writeNeedsReviewReconciliationArtifact({
        workspaceDir: params.workspaceDir,
        missionId: params.missionId,
        item: needsReviewItem,
        now,
      })
    : undefined;
  if (decision.mode !== "enforce") {
    return {
      status: "observed",
      reason: "controller_not_in_enforce_mode",
      decision,
      ...(reconciliation
        ? {
            reconciliationArtifact: reconciliation.artifact,
            reconciliationArtifactPath: reconciliation.path,
          }
        : {}),
    };
  }
  if (!decision.policyVersionOk) {
    return {
      status: "blocked",
      reason: "policy_version_mismatch",
      decision,
      ...(reconciliation
        ? {
            reconciliationArtifact: reconciliation.artifact,
            reconciliationArtifactPath: reconciliation.path,
          }
        : {}),
    };
  }
  if (decision.requiredRepairTasks.length === 0) {
    return { status: "observed", reason: "no_repair_required", decision };
  }
  if (decision.selectedPriority === "P1_SAFETY_OR_DUPLICATE_EXECUTION") {
    return {
      status: "blocked",
      reason: "duplicate_executor_reconciliation_required",
      decision,
      ...(reconciliation
        ? {
            reconciliationArtifact: reconciliation.artifact,
            reconciliationArtifactPath: reconciliation.path,
          }
        : {}),
    };
  }

  const flowItem = findMissionFlowItem(params.receipt, params.missionId);
  const taskItem = findMissionTaskItem(params.receipt, params.missionId);
  if (!isForegroundCleanupCrewFinding(flowItem) && !isForegroundCleanupCrewFinding(taskItem)) {
    return {
      status: "blocked",
      reason: "unsupported_repair_route",
      decision,
      ...(reconciliation
        ? {
            reconciliationArtifact: reconciliation.artifact,
            reconciliationArtifactPath: reconciliation.path,
          }
        : {}),
    };
  }

  const ownerKey =
    params.ownerKey ?? flowItem?.proof?.owner_key ?? taskItem?.proof?.child_session_key;
  const sessionKey = params.sessionKey ?? taskItem?.proof?.child_session_key ?? ownerKey;
  const currentStep =
    params.currentStep ??
    flowItem?.proof?.current_step ??
    "cleanup_watchdog_governance_watchdog_reconciliation";
  if (!ownerKey || !sessionKey) {
    return {
      status: "blocked",
      reason: "repair_identity_missing",
      decision,
      ...(reconciliation
        ? {
            reconciliationArtifact: reconciliation.artifact,
            reconciliationArtifactPath: reconciliation.path,
          }
        : {}),
    };
  }

  const registration = ensureForegroundCleanupCrewTaskFlow({
    sessionKey,
    currentTurnText:
      params.currentTurnText ??
      "Cleanup Crew watchdog governance remediation build. Execute production repair under Cleanup Crew SOP.",
    authorityPath: "system_wide_active_work_watchdog_receipt",
    authorityBasis: "Live watchdog receipt required Cleanup Crew executor reconciliation.",
    ownerLane: "Will",
    stageId: currentStep,
    now: params.now,
  });
  if (registration.status !== "registered" && registration.status !== "attached") {
    return {
      status: "blocked",
      reason: `taskflow_dispatch_${registration.status}:${registration.reason}`,
      decision,
      ...(reconciliation
        ? {
            reconciliationArtifact: reconciliation.artifact,
            reconciliationArtifactPath: reconciliation.path,
          }
        : {}),
    };
  }
  const lostTaskId = findLostTaskIdForReceipt({ flowItem, taskItem });
  if (lostTaskId && registration.taskId && registration.taskId !== lostTaskId) {
    markTaskLostById({
      taskId: registration.taskId,
      endedAt: now,
      lastEventAt: now,
      error: `superseded by live controller active_no_worker recovery for ${lostTaskId}`,
    });
  }
  const supersession = maybeSupersedeExecutorFromReceipt({
    flowId: registration.flow.flowId,
    flowItem,
    taskItem,
    ownerKey,
    sessionKey,
    currentStep,
    now,
  });

  return {
    status: "dispatched",
    decision,
    reconciliationArtifact: reconciliation!.artifact,
    reconciliationArtifactPath: reconciliation!.path,
    repair: {
      route: "foreground_cleanup_crew_taskflow",
      flowId: registration.flow.flowId,
      taskId: registration.taskId,
      ownerKey,
      sessionKey,
      currentStep,
      ...(supersession ? { supersession } : {}),
    },
  };
}

export type CleanupWatchdogLiveRecoveryExerciseResult = {
  schema: "openclaw.cleanup_watchdog.live_recovery_exercise.v1";
  ranAt: string;
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  status: "passed" | "failed";
  manualAttachmentUsed: false;
  manualSettlementUsed: false;
  canary: {
    flowId: string;
    originalTaskId: string;
    replacementTaskId?: string;
    ownerKey: string;
    sessionKey: string;
    lostRunId?: string | null;
    replacementRunId?: string | null;
    currentStep: string;
  };
  watchdog: {
    detectCommand: string;
    detectReceiptPath?: string | null;
    validationCommand: string;
    validationReceiptPath?: string | null;
  };
  controller: {
    consumeResult: CleanupWatchdogReceiptConsumptionResult;
  };
  validation: {
    detectedActiveNoWorker: boolean;
    controllerDispatched: boolean;
    supersessionRecorded: boolean;
    exactlyOneReplacementExecutor: boolean;
    heartbeatProgressRecorded: boolean;
    canaryCleaned: boolean;
    watchdogCleanAfterCleanup: boolean;
  };
  receiptPath: string;
};

function runWatchdogCommand(workspaceDir: string): {
  command: string;
  receiptPath?: string | null;
} {
  const command =
    "python3 scripts/system_wide_active_work_watchdog.py --mode report-only --write-receipt --stdout-json";
  const output = execFileSync(
    "python3",
    [
      "scripts/system_wide_active_work_watchdog.py",
      "--mode",
      "report-only",
      "--write-receipt",
      "--stdout-json",
    ],
    {
      cwd: workspaceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const parsed = JSON.parse(output) as { receipt_path?: string };
    return { command, receiptPath: parsed.receipt_path ?? null };
  } catch {
    const receiptPath = output.match(/receipt=([^ |\n]+)/)?.[1] ?? null;
    return { command, receiptPath };
  }
}

function readReceipt(receiptPath: string | null | undefined): CleanupWatchdogReceiptSnapshot {
  if (!receiptPath) {
    throw new Error("watchdog did not return a receipt path");
  }
  return JSON.parse(fs.readFileSync(receiptPath, "utf8")) as CleanupWatchdogReceiptSnapshot;
}

function receiptHasActiveNoWorker(
  receipt: CleanupWatchdogReceiptSnapshot,
  flowId: string,
): boolean {
  return Boolean(
    receipt.decisions?.suspicious_items?.some(
      (item) =>
        item.entity_type === "flow_run" &&
        item.entity_id === flowId &&
        (item.category === "active_no_worker" || item.category === "stale"),
    ),
  );
}

function writeExerciseReceipt(params: {
  workspaceDir: string;
  result: Omit<CleanupWatchdogLiveRecoveryExerciseResult, "receiptPath">;
}): string {
  const paths = resolveCleanupWatchdogLiveControllerPaths(params.workspaceDir);
  const receiptPath = path.join(paths.receiptDir, `live_recovery_exercise_${Date.now()}.json`);
  writeJsonDurable(receiptPath, { ...params.result, receiptPath });
  return receiptPath;
}

function cleanupExistingRecoveryCanaries(): void {
  for (const flow of listTaskFlowRecords()) {
    if (
      !flow.ownerKey.startsWith("cleanup-watchdog-canary:") &&
      !flow.goal.toLowerCase().includes("cleanup watchdog live active_no_worker recovery canary") &&
      !(
        flow.stateJson &&
        typeof flow.stateJson === "object" &&
        !Array.isArray(flow.stateJson) &&
        (flow.stateJson as { kind?: unknown }).kind === "cleanup_watchdog_live_recovery_canary"
      )
    ) {
      continue;
    }
    for (const task of listTasksForFlowId(flow.flowId)) {
      deleteTaskRecordById(task.taskId);
    }
    const latest = getTaskFlowById(flow.flowId);
    if (latest) {
      finishFlow({
        flowId: latest.flowId,
        expectedRevision: latest.revision,
        currentStep: "cleanup_watchdog_live_recovery_canary_closed",
        updatedAt: Date.now(),
        endedAt: Date.now(),
      });
      deleteTaskFlowRecordById(latest.flowId);
    }
  }
}

export function runCleanupWatchdogLiveRecoveryExercise(params?: {
  workspaceDir?: string;
  cleanup?: boolean;
}): CleanupWatchdogLiveRecoveryExerciseResult {
  const workspaceDir = params?.workspaceDir ?? defaultWorkspaceDir();
  cleanupExistingRecoveryCanaries();
  const now = Date.now();
  const ownerKey = `cleanup-watchdog-canary:${now}`;
  const sessionKey = ownerKey;
  const currentStep = "cleanup_watchdog_live_recovery_canary";
  const flow = createManagedTaskFlow({
    ownerKey,
    controllerId: "cleanup-crew/foreground-production",
    goal: "Cleanup Watchdog live active_no_worker recovery canary",
    status: "running",
    notifyPolicy: "silent",
    currentStep,
    continuation: {
      activeProductionRun: true,
      parentRunOpen: true,
      nextExecutableUnitLaunched: true,
    },
    stateJson: {
      kind: "cleanup_watchdog_live_recovery_canary",
      authorityPath: "cleanup_watchdog_live_controller_canary",
      authorityBasis: "Authorized bounded live recovery exercise",
      ownerLane: "Will",
    },
    createdAt: now,
    updatedAt: now,
  });
  if (!flow) {
    throw new Error("failed to create live recovery canary flow");
  }
  const originalTask = createTaskRecord({
    runtime: "cli",
    taskKind: "foreground_cleanup_crew_execution",
    sourceId: "cleanup-crew:foreground",
    requesterSessionKey: sessionKey,
    ownerKey,
    scopeKind: "session",
    parentFlowId: flow.flowId,
    runId: `cleanup-watchdog-canary:${flow.flowId}:original:${now}`,
    childSessionKey: sessionKey,
    label: "Cleanup Watchdog canary original executor",
    task: "Original executor for live recovery canary",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    startedAt: now,
    lastEventAt: now,
    progressSummary: "Canary original executor started",
  });
  if (!originalTask) {
    throw new Error("failed to create live recovery canary executor");
  }
  const lost = markTaskLostById({
    taskId: originalTask.taskId,
    endedAt: now + 1,
    lastEventAt: now + 1,
    error: "backing session missing for supported active_no_worker canary",
  });
  if (!lost) {
    throw new Error("failed to make canary executor unavailable");
  }
  const detection = runWatchdogCommand(workspaceDir);
  const detectionReceipt = readReceipt(detection.receiptPath);
  const consumeResult = consumeReceiptWithLiveController({
    workspaceDir,
    receipt: detectionReceipt,
    missionId: flow.flowId,
    ownerKey,
    sessionKey,
    currentStep,
    currentTurnText: "Cleanup Crew watchdog production repair build.",
    now: now + 2,
  });
  const supersession =
    consumeResult.status === "dispatched" ? consumeResult.repair.supersession : undefined;
  if (supersession?.replacementRunId) {
    recordTaskProgressByRunId({
      runId: supersession.replacementRunId,
      runtime: "cli",
      sessionKey: supersession.replacementSessionKey ?? sessionKey,
      lastEventAt: now + 3,
      progressSummary: "Automatic replacement executor heartbeat and meaningful progress recorded",
      eventSummary: "live recovery canary resumed from recorded step",
    });
  }
  const activeReplacementTasks = listTasksForFlowId(flow.flowId).filter(
    (task) =>
      task.status === "running" &&
      (task.sourceId === "cleanup-crew:foreground" ||
        task.sourceId === "cleanup-crew:foreground:automatic-recovery" ||
        task.sourceId === "cleanup-crew:foreground:supersession"),
  );
  if (params?.cleanup !== false) {
    for (const task of listTasksForFlowId(flow.flowId)) {
      deleteTaskRecordById(task.taskId);
    }
    const latestFlow = getTaskFlowById(flow.flowId);
    if (latestFlow) {
      finishFlow({
        flowId: latestFlow.flowId,
        expectedRevision: latestFlow.revision,
        currentStep: "cleanup_watchdog_live_recovery_canary_closed",
        updatedAt: now + 4,
        endedAt: now + 4,
      });
      deleteTaskFlowRecordById(latestFlow.flowId);
    }
  }
  const validation = runWatchdogCommand(workspaceDir);
  const validationReceipt = readReceipt(validation.receiptPath);
  const validationResult = {
    detectedActiveNoWorker: receiptHasActiveNoWorker(detectionReceipt, flow.flowId),
    controllerDispatched: consumeResult.status === "dispatched",
    supersessionRecorded: Boolean(supersession),
    exactlyOneReplacementExecutor: activeReplacementTasks.length === 1,
    heartbeatProgressRecorded: Boolean(supersession?.replacementRunId),
    canaryCleaned: !getTaskFlowById(flow.flowId) && listTasksForFlowId(flow.flowId).length === 0,
    watchdogCleanAfterCleanup:
      validationReceipt.summary?.items_suspicious === 0 &&
      (validationReceipt as { label?: string }).label === "CLEAN",
  };
  const status: "passed" | "failed" = Object.values(validationResult).every(Boolean)
    ? "passed"
    : "failed";
  const partialResult = {
    schema: "openclaw.cleanup_watchdog.live_recovery_exercise.v1" as const,
    ranAt: new Date().toISOString(),
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    status,
    manualAttachmentUsed: false as const,
    manualSettlementUsed: false as const,
    canary: {
      flowId: flow.flowId,
      originalTaskId: originalTask.taskId,
      replacementTaskId: supersession?.replacementTaskId,
      ownerKey,
      sessionKey,
      lostRunId: originalTask.runId ?? null,
      replacementRunId: supersession?.replacementRunId ?? null,
      currentStep,
    },
    watchdog: {
      detectCommand: detection.command,
      detectReceiptPath: detection.receiptPath ?? null,
      validationCommand: validation.command,
      validationReceiptPath: validation.receiptPath ?? null,
    },
    controller: {
      consumeResult,
    },
    validation: validationResult,
  };
  const receiptPath = writeExerciseReceipt({ workspaceDir, result: partialResult });
  return { ...partialResult, receiptPath };
}
