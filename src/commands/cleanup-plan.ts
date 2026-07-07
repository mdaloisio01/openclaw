import {
  getRuntimeConfig,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createCleanupCrewDecisionRecord,
  createCleanupCrewStoppageReceipt,
  createContinueReceipt,
  createDiagnosticTrace,
  createStopReport,
  appendCleanupCrewPlanAmendment,
  evaluateContinuityGateV2,
  writeCleanupCrewDurableArtifacts,
  type AuthoritySource,
  type BuildContextConstraint,
  type CleanupCrewPlanAmendmentInput,
  type CleanupCrewPlanAmendmentWrite,
  type CleanupCrewStoppageReceiptInput,
  type ContinuityGateDecision,
  type ContinuityGateIssue,
  type CleanupCrewDurableArtifactWrite,
  type ContinuityGateState,
} from "../continuity/continuity-gate-v2.js";
import { buildCleanupPlan } from "./cleanup-utils.js";

export function resolveCleanupPlanFromDisk(): {
  cfg: OpenClawConfig;
  stateDir: string;
  configPath: string;
  oauthDir: string;
  configInsideState: boolean;
  oauthInsideState: boolean;
  workspaceDirs: string[];
} {
  const cfg = getRuntimeConfig();
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const plan = buildCleanupPlan({ cfg, stateDir, configPath, oauthDir });
  return { cfg, stateDir, configPath, oauthDir, ...plan };
}

export function resolveCleanupCrewContinuityGateDecision(params: {
  activeMission: string;
  issue: ContinuityGateIssue;
  authoritySources: AuthoritySource[];
  userInstruction?: string;
  constraints?: BuildContextConstraint[];
  now?: string;
}): ContinuityGateDecision {
  return evaluateContinuityGateV2({
    now: params.now,
    activeMission: params.activeMission,
    userInstruction: params.userInstruction,
    issue: params.issue,
    authoritySources: params.authoritySources,
    constraints: params.constraints,
  });
}

export async function persistCleanupCrewContinuityGateDecision(params: {
  outputDir: string;
  activeMission: string;
  issue: ContinuityGateIssue;
  authoritySources: AuthoritySource[];
  userInstruction?: string;
  constraints?: BuildContextConstraint[];
  now?: string;
  scope?: { files?: string[]; records?: string[]; commands?: string[] };
  repairAction?: string;
  proofPath?: string;
  diagnostic?: {
    filesTouched?: string[];
    tests?: string[];
    redactionStatus?: string;
    surfaces?: string[];
    grantResult?: string;
    proofRefs?: string[];
  };
}): Promise<{ decision: ContinuityGateDecision; writes: CleanupCrewDurableArtifactWrite[] }> {
  const decision = resolveCleanupCrewContinuityGateDecision(params);
  const diagnosticTrace = createDiagnosticTrace(decision, {
    filesTouched: params.diagnostic?.filesTouched ?? params.scope?.files ?? [],
    tests: params.diagnostic?.tests ?? [],
    redactionStatus: params.diagnostic?.redactionStatus ?? "not_evaluated_by_cleanup_plan_seam",
    surfaces: params.diagnostic?.surfaces ?? [],
    records: params.scope?.records ?? [],
    commands: params.scope?.commands ?? [],
    ...(params.diagnostic?.grantResult ? { grantResult: params.diagnostic.grantResult } : {}),
    proofRefs: params.diagnostic?.proofRefs ?? (params.proofPath ? [params.proofPath] : []),
  });

  if (decision.shouldContinue) {
    const decisionRecord = createCleanupCrewDecisionRecord(decision, params.scope);
    const continueReceipt = createContinueReceipt(decision, {
      repairAction: params.repairAction ?? decision.continueReason,
      proofPath: params.proofPath ?? "pending_runtime_proof",
    });
    const writes = await writeCleanupCrewDurableArtifacts({
      outputDir: params.outputDir,
      decisionRecord,
      continueReceipt,
      diagnosticTrace,
    });
    return { decision, writes };
  }

  const stopReport = shouldWriteCleanupCrewStopReport(decision.selectedState)
    ? createStopReport(decision, { diagnosticArtifact: "pending_diagnostic_trace" })
    : undefined;
  if (!stopReport) {
    const writes = await writeCleanupCrewDurableArtifacts({
      outputDir: params.outputDir,
      diagnosticTrace,
    });
    return { decision, writes };
  }

  const diagnosticWrites = await writeCleanupCrewDurableArtifacts({
    outputDir: params.outputDir,
    diagnosticTrace,
  });
  const diagnosticPath = diagnosticWrites.find((write) => write.kind === "diagnostic_trace")?.path;
  const stopWrites = await writeCleanupCrewDurableArtifacts({
    outputDir: params.outputDir,
    stopReport: createStopReport(decision, {
      diagnosticArtifact: diagnosticPath ?? "missing_diagnostic_trace_path",
    }),
  });
  return { decision, writes: [...stopWrites, ...diagnosticWrites] };
}

export async function persistCleanupCrewStoppageReceipt(params: {
  outputDir: string;
  receipt: CleanupCrewStoppageReceiptInput;
}): Promise<{ writes: CleanupCrewDurableArtifactWrite[] }> {
  const stoppageReceipt = createCleanupCrewStoppageReceipt(params.receipt);
  const writes = await writeCleanupCrewDurableArtifacts({
    outputDir: params.outputDir,
    stoppageReceipt,
  });
  return { writes };
}

export async function persistCleanupCrewPlanAmendment(
  params: CleanupCrewPlanAmendmentInput,
): Promise<CleanupCrewPlanAmendmentWrite> {
  return appendCleanupCrewPlanAmendment(params);
}

function shouldWriteCleanupCrewStopReport(state: ContinuityGateState): boolean {
  return (
    state !== "STOP_USER_ANSWER_ONLY_OVERRIDE" &&
    state !== "COMPLETE" &&
    !state.startsWith("CONTINUE_")
  );
}
