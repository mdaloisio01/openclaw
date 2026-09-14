import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFalseCloseoutAdmissionMode } from "./false-closeout-admission-controller.js";
import type {
  AcceptanceGate,
  CloseoutAdmissionInput,
  CompletionDecision,
  CompletionTransition,
  EvidenceReceipt,
  ExportManifest,
  GrantApprovalReceipt,
  MissionIdentity,
  MissionMode,
  RawTestResult,
  RequirementManifestItem,
  RestorationReceipt,
  RollbackReceipt,
  RuntimeCloseoutState,
  TestManifest,
  WatchdogState,
} from "./mission-manifest.types.js";

export type FalseCloseoutAdmissionProducerInput = {
  activeCleanupCrewMission: boolean;
  terminalAttempt: boolean;
  identity?: MissionIdentity;
  evidenceManifestSha256?: string;
  currentTurnText?: string;
  responseText?: string;
  mode?: MissionMode;
  activeRunStarted?: boolean;
  executionRunningNow?: boolean;
  nextExecutableStepStarted?: boolean;
  pendingContinuationRequirement?: boolean;
  blocker?: boolean;
  runtimeState?: Partial<RuntimeCloseoutState>;
  watchdog?: Partial<WatchdogState>;
  repairWork?: { openCount?: number; openIds?: string[] };
  requirements?: RequirementManifestItem[];
  gates?: AcceptanceGate[];
  receipts?: EvidenceReceipt[];
  testManifest?: TestManifest;
  testResults?: RawTestResult[];
  rollbackReceipt?: RollbackReceipt;
  restorationReceipt?: RestorationReceipt;
  grantApproval?: GrantApprovalReceipt;
  exportManifest?: ExportManifest;
  nextExecutableStepExists?: boolean;
  reportContradictions?: string[];
  now?: string;
  requestedTransition?: CompletionTransition;
  previousDecisionReceiptSha256?: string;
  transitionalWatchdogReceiptSha256?: string;
  parentExecutorSnapshotSha256?: string;
};

export type FalseCloseoutDecisionReceipt = {
  schema: "openclaw.false_closeout_admission_decision_receipt.v1";
  decision: CompletionDecision;
  input: CloseoutAdmissionInput;
  writtenAt: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 16);
}

function defaultWorkspaceDir(): string {
  return (
    process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw", "workspace-orchestrator")
  );
}

export function resolveFalseCloseoutAdmissionDecisionReceiptDir(
  workspaceDir = defaultWorkspaceDir(),
) {
  return path.join(workspaceDir, "var", "false_closeout_admission", "decisions");
}

function safeReceiptName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._:-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 160) || `decision-${Date.now()}`
  );
}

function writeJsonDurable(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function writeFalseCloseoutAdmissionDecisionReceipt(params: {
  input: CloseoutAdmissionInput;
  decision: CompletionDecision;
  workspaceDir?: string;
}): { path: string; sha256: string } {
  const directory = resolveFalseCloseoutAdmissionDecisionReceiptDir(params.workspaceDir);
  const receipt: FalseCloseoutDecisionReceipt = {
    schema: "openclaw.false_closeout_admission_decision_receipt.v1",
    input: params.input,
    decision: params.decision,
    writtenAt: new Date().toISOString(),
  };
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  const filePath = path.join(directory, `${safeReceiptName(params.decision.decisionId)}.json`);
  writeJsonDurable(filePath, receipt);
  return { path: filePath, sha256: sha256(body) };
}

function resolveRuntimeAdmissionMode(explicitMode?: MissionMode): MissionMode {
  return (
    explicitMode ??
    resolveFalseCloseoutAdmissionMode(
      process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION ??
        process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION_MODE,
    )
  );
}

export function buildRuntimeCloseoutAdmissionInput(
  input: FalseCloseoutAdmissionProducerInput,
): CloseoutAdmissionInput | undefined {
  if (!input.activeCleanupCrewMission || !input.terminalAttempt) {
    return undefined;
  }
  const now = input.now ?? new Date().toISOString();
  const currentTurnText = input.currentTurnText ?? "";
  const responseText = input.responseText ?? "";
  const scopeHash = sha256(currentTurnText);
  const closeoutSha256 = sha256(responseText);
  const mode = resolveRuntimeAdmissionMode(input.mode);
  const identity: MissionIdentity = input.identity ?? {
    missionId: `cleanup-crew-runtime-closeout-${shortHash(`${currentTurnText}\n${responseText}`)}`,
    planRevisionId: "runtime-closeout-attempt-v1",
    planSha256: scopeHash,
    sourceRevision: "runtime-unbound",
    runtimeBuildSha256: "runtime-unbound",
    policyVersion: "active-run-continuation-guard",
    skillSha256: "runtime-unbound",
  };
  const evidenceManifestSha256 = input.evidenceManifestSha256 ?? "runtime-unbound";
  const parentStillOpen =
    input.activeRunStarted === true ||
    input.executionRunningNow === true ||
    input.pendingContinuationRequirement === true ||
    input.nextExecutableStepStarted === true;
  const requirements = input.requirements ?? [
    {
      id: "REQ-RUNTIME-CLOSEOUT-AUTHORITY",
      text: "Terminal closeout requires complete runtime, evidence, review, export, rollback, restoration, and watchdog proof.",
      required: true,
      gateIds: ["GATE-RUNTIME-CLOSEOUT-AUTHORITY"],
    },
  ];
  const gates = input.gates ?? [
    {
      id: "GATE-RUNTIME-CLOSEOUT-AUTHORITY",
      requirementId: "REQ-RUNTIME-CLOSEOUT-AUTHORITY",
      kind: "terminal_state",
      required: true,
    },
  ];
  const runtimeState: RuntimeCloseoutState = {
    parentStatus: parentStillOpen ? "running" : "terminal",
    activeExecutorCount: input.executionRunningNow || parentStillOpen ? 1 : 0,
    staleExecutorCount: 0,
    openSessionCount: input.executionRunningNow ? 1 : 0,
    openRunCount: input.executionRunningNow || parentStillOpen ? 1 : 0,
    openLeaseCount: 0,
    openContinuationCount: input.pendingContinuationRequirement ? 1 : 0,
    pendingDeliveryCount: 0,
    ...input.runtimeState,
  };
  const watchdog: WatchdogState = {
    label: "UNKNOWN",
    suspiciousCount: parentStillOpen ? 1 : 0,
    checkedAt: now,
    postTerminal: false,
    ...input.watchdog,
  };
  const openRepairIds =
    input.repairWork?.openIds ?? (input.blocker ? ["active-run-continuation-guard-blocker"] : []);
  const reportContradictions =
    input.reportContradictions ??
    (parentStillOpen
      ? ["terminal closeout attempted while active runtime state remains open"]
      : ["terminal closeout lacks bound evidence package"]);
  return {
    manifest: {
      schema: "openclaw.mission_manifest.v1",
      ...identity,
      mode,
      scopeHash,
      authorizedScopeHash: scopeHash,
      planRevisionAuthorized: true,
      createdAt: now,
    },
    requirements,
    gates,
    receipts: input.receipts ?? [],
    ...(input.testManifest ? { testManifest: input.testManifest } : {}),
    ...(input.testResults ? { testResults: input.testResults } : {}),
    ...(input.rollbackReceipt ? { rollbackReceipt: input.rollbackReceipt } : {}),
    ...(input.restorationReceipt ? { restorationReceipt: input.restorationReceipt } : {}),
    ...(input.grantApproval ? { grantApproval: input.grantApproval } : {}),
    ...(input.exportManifest ? { exportManifest: input.exportManifest } : {}),
    runtimeState,
    watchdog,
    repairWork: {
      openCount: input.repairWork?.openCount ?? openRepairIds.length,
      openIds: openRepairIds,
    },
    completionRequest: {
      schema: "openclaw.completion_request.v1",
      ...identity,
      requestedAt: now,
      claimedScopeHash: scopeHash,
      closeoutText: responseText,
      closeoutSha256,
      evidenceManifestSha256,
      requestedTransition: input.requestedTransition ?? "terminal_pending_watchdog -> COMPLETE",
      ...(input.previousDecisionReceiptSha256
        ? { previousDecisionReceiptSha256: input.previousDecisionReceiptSha256 }
        : {}),
      ...(input.transitionalWatchdogReceiptSha256
        ? { transitionalWatchdogReceiptSha256: input.transitionalWatchdogReceiptSha256 }
        : {}),
      ...(input.parentExecutorSnapshotSha256
        ? { parentExecutorSnapshotSha256: input.parentExecutorSnapshotSha256 }
        : {}),
    },
    nextExecutableStepExists:
      input.nextExecutableStepExists ??
      (input.pendingContinuationRequirement === true && input.nextExecutableStepStarted !== true),
    reportContradictions,
    now,
  };
}
