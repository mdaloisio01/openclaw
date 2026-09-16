import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveCleanupCrewReportCloseoutAcceptance } from "../../agents/report-delivery-guard.js";
import { persistCleanupCrewContinuityGateDecision } from "../../commands/cleanup-plan.js";
import type {
  AuthoritySource,
  CleanupCrewTypedDecisionReceipt,
  ContinuityGateIssue,
} from "../../continuity/continuity-gate-v2.js";
import { createCleanupCrewBootstrapB0TypedDecisionReceipt } from "../../continuity/continuity-gate-v2.js";
import { classifyCurrentInboundInstruction } from "../../governance/current-inbound-instruction.js";
import { evaluateFalseCloseoutAdmission } from "../../governance/false-closeout-admission-controller.js";
import { writeFalseCloseoutAdmissionDecisionReceipt } from "../../governance/false-closeout-runtime-evidence.js";
import {
  resolveGovernedRunDurability,
  type GovernedRunDurabilityDecision,
} from "../../governance/governed-run-durability-contract.js";
import type { CompletionDecision, MissionMode } from "../../governance/mission-manifest.types.js";
import { isSystemwideDepartmentFlowAcknowledgementText } from "../../governance/systemwide-department-flow-acknowledgement.js";
import { getReplyPayloadMetadata, type ReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { buildRuntimeCloseoutAdmissionInput } from "./false-closeout-admission-producer.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

export type ActiveRunContinuationEventType =
  | "ACTIVE_RUN_STARTED"
  | "NON_TERMINAL_BUILD_UPDATE_EMITTED"
  | "OWNER_BOUNDARY_HANDOFF_RECORDED"
  | "BLOCKER_STATE"
  | "NEXT_EXECUTABLE_STEP_STARTED"
  | "TERMINAL_COMPLETION_PROOF_RECORDED"
  | "TERMINAL_CLOSEOUT_ATTEMPTED"
  | "TERMINAL_CLOSEOUT_ALLOWED"
  | "FALSE_CLOSEOUT_ADMISSION_OFF_BYPASSED"
  | "FALSE_CLOSEOUT_ADMISSION_SHADOW_REJECTED"
  | "FALSE_CLOSEOUT_ADMISSION_ENFORCED_REJECTED"
  | "FALSE_CLOSEOUT_ADMISSION_ALLOWED"
  | "CLEANUP_CREW_TERMINAL_CLOSEOUT_REJECTED"
  | "OPERATOR_PAUSE_HOLD_RECORDED"
  | "GOVERNED_RUN_DURABILITY_CONTRACT_REJECTED"
  | "GOVERNED_RUN_DURABILITY_OBLIGATION_WRITTEN"
  | "ACTIVE_RUN_CONTINUITY_VIOLATION";

export type ActiveRunContinuationEvent = {
  type: ActiveRunContinuationEventType;
  detail?: string;
};

type GuardState = {
  events: ActiveRunContinuationEvent[];
  activeRunStarted: boolean;
  lastUpdateWasNonTerminal: boolean;
  lastNonTerminalDetail?: string;
  blocker: boolean;
  blockerType?: string;
  ownerBoundaryHandoffRecorded: boolean;
  ownerBoundaryHandoffDetail?: string;
  operatorPauseHold: boolean;
  nextExecutableStepStarted: boolean;
  terminalCompletionProofRecorded: boolean;
  violationNoticeQueued: boolean;
  blockedCloseoutQueued: boolean;
  persistence?: ActiveRunContinuityGatePersistenceOptions;
  cleanupCrewFinalResponse?: CleanupCrewFinalResponseGuardContext;
  pendingPersistenceWrites: Promise<void>[];
  continuityGatePersistenceQueued: boolean;
};

const guardStateByDispatcher = new WeakMap<ReplyDispatcher, GuardState>();

export type ActiveRunContinuityGatePersistenceOptions = {
  outputDir: string;
  activeMission: string;
  authoritySources: AuthoritySource[];
  now?: string;
  sourceSurface?: string;
  proofRefs?: string[];
};

export type CleanupCrewFinalResponseGuardContext = {
  currentTurnText?: string;
  activeCleanupCrewMission?: boolean;
  falseCloseoutAdmissionMode?: MissionMode;
};

export type CleanupCrewFinalResponseGateDecision = {
  allowed: boolean;
  activeCleanupCrewMission: boolean;
  terminalAttempt: boolean;
  explicitReportOnlyRequest: boolean;
  explicitStopRequest: boolean;
  milestoneVisibilityReport: boolean;
  repairableBlocker: boolean;
  nextRepairPathKnown: boolean;
  hardBlockerNamedWithProof: boolean;
  blockerArtifactPresent: boolean;
  laneCDecisionRequired: boolean;
  typedDecisionReceipt: CleanupCrewTypedDecisionReceipt;
  violationReason?: string;
};

function recordEvent(
  state: GuardState,
  type: ActiveRunContinuationEventType,
  detail?: string,
): void {
  state.events.push(detail ? { type, detail } : { type });
}

function hasPendingContinuationRequirement(state: GuardState): boolean {
  return state.activeRunStarted && state.lastUpdateWasNonTerminal;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function isCleanupCrewText(text: string): boolean {
  return includesAny(text, ["cleanup crew", "cleanup-crew"]);
}

function isMilestoneVisibilityReport(text: string): boolean {
  return (
    text.includes("status:") &&
    text.includes("mode:") &&
    (text.includes("packet complete:") || text.includes("stage complete:")) &&
    (text.includes("next packet:") || text.includes("next stage:")) &&
    text.includes("safety check:") &&
    text.includes("blockers:")
  );
}

function reportNamesBroaderBuildOpen(text: string): boolean {
  const namesBroaderOpenFamily =
    /\bbroader\b.{0,96}\b(remains|is|still)\s+open\b/.test(text) ||
    /\b(entire|whole|historical)\b.{0,96}\bnot\b.{0,48}\b(closed|complete|globally closed)\b/.test(
      text,
    );
  if (namesBroaderOpenFamily) {
    return true;
  }
  return includesAny(text, [
    "broader build remains open",
    "broader mission remains open",
    "broader cleanup crew remains open",
    "broader issue family remains open",
    "broader issue remains open",
    "broader reliability family remains open",
    "cleanup crew issue-list repair remains open",
    "build still open",
    "mission still open",
    "repair remains open",
    "remaining work:",
  ]);
}

function reportNamesFullBuildComplete(text: string): boolean {
  if (reportNamesBroaderBuildOpen(text)) {
    return false;
  }
  return includesAny(text, [
    "broader build is complete",
    "broader mission is complete",
    "cleanup crew issue-list repair is truthfully closed",
    "cleanup crew issue-list repair is complete",
    "whole build is complete",
    "whole mission is complete",
    "mission closed with proof",
    "nothing remains open",
    "what is still not real yet: nothing",
    "whole run complete",
  ]);
}

function isTerminalAttemptText(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  if (text.includes("status: blocked") || text.includes("packet blocked:")) {
    return true;
  }
  if (text.includes("final closeout") || text.includes("closeout report")) {
    return true;
  }
  if (text.includes("terminal") && (text.includes("blocked") || text.includes("done"))) {
    return true;
  }
  if (
    text.includes("status: done") ||
    text.includes("status: complete") ||
    text.includes("status: closed")
  ) {
    return true;
  }
  return false;
}

function hasNextRepairPath(text: string): boolean {
  return includesAny(text, [
    "next repair path",
    "safe next action:",
    "next action:",
    "next steps:",
    "next packet:",
    "continue cleanup repair",
    "continue_cleanup_repair",
    "repair route",
    "repair classification",
    "rerun watchdog",
    "inspect latest watchdog receipt",
    "routed to cleanup crew recovery",
    "analyze/read-only",
    "amend plan",
    "update active build plan",
    "active build plan amendment",
    "resume from updated plan",
    "resume from plan",
    "next executable command",
    "next executable unit",
    "plan amendment required",
  ]);
}

function hasTerminalBlockerProofArtifacts(text: string): boolean {
  return (
    (text.includes("blocker:") || text.includes("packet blocked:")) &&
    (text.includes("proof:") || text.includes("why continuation is not lawful:")) &&
    hasBlockerArtifact(text)
  );
}

function hasBlockerArtifact(text: string): boolean {
  return (
    text.includes("blocker_artifact:") ||
    text.includes("blocker artifact:") ||
    text.includes("blocker artifact written") ||
    text.includes("blocker artifact path")
  );
}

function hasLaneCDecisionRequired(text: string): boolean {
  return (
    includesAny(text, [
      "lane c",
      "product behavior decision",
      "product/behavior decision",
      "mark decision required",
      "requires mark decision",
      "user-facing behavior decision",
    ]) &&
    (text.includes("blocker:") || text.includes("packet blocked:"))
  );
}

function typedDecisionContinuesRepair(receipt: CleanupCrewTypedDecisionReceipt): boolean {
  return (
    receipt.validation.ok &&
    receipt.outcome === "REPAIR_AND_CONTINUE" &&
    receipt.reason_code === "TECHNICAL_REPAIR"
  );
}

function typedDecisionNamesNextRepair(receipt: CleanupCrewTypedDecisionReceipt): boolean {
  return (
    typedDecisionContinuesRepair(receipt) &&
    receipt.next_action === "continue_cleanup_repair_through_canonical_policy"
  );
}

function typedDecisionBlocksTerminalCloseout(receipt: CleanupCrewTypedDecisionReceipt): boolean {
  return (
    !receipt.validation.ok ||
    receipt.outcome === "ACTION_BLOCKED" ||
    receipt.outcome === "PHASE_BLOCKED" ||
    receipt.outcome === "EXTERNAL_DEPENDENCY" ||
    receipt.outcome === "OWNER_DECISION_REQUIRED" ||
    receipt.outcome === "MISSION_ABORTED"
  );
}

function typedDecisionIsHardTerminalBlocker(receipt: CleanupCrewTypedDecisionReceipt): boolean {
  return (
    typedDecisionBlocksTerminalCloseout(receipt) &&
    receipt.impact === "MISSION" &&
    receipt.next_action === "record_lawful_blocker_artifact_before_terminal_closeout"
  );
}

export function resolveCleanupCrewFinalResponseGate(params: {
  currentTurnText?: string;
  responseText?: string;
  activeCleanupCrewMission?: boolean;
  falseCloseoutAdmissionMode?: MissionMode;
}): CleanupCrewFinalResponseGateDecision {
  const currentTurnText = normalizeText(params.currentTurnText);
  const responseText = normalizeText(params.responseText);
  const combinedText = `${currentTurnText}\n${responseText}`;
  const instruction = classifyCurrentInboundInstruction(params.currentTurnText);
  const activeCleanupCrewMission =
    instruction !== "planning_only" &&
    (params.activeCleanupCrewMission === true || isCleanupCrewText(combinedText));
  const explicitReportOnlyRequest =
    instruction === "planning_only" || instruction === "report_only";
  const explicitStopRequest = instruction === "no_work";
  const milestoneVisibilityReport = isMilestoneVisibilityReport(responseText);
  const terminalAttempt = isTerminalAttemptText(responseText);
  const fullBuildCompleteReport = reportNamesFullBuildComplete(responseText);
  const typedDecisionReceipt = createCleanupCrewBootstrapB0TypedDecisionReceipt({
    missionId: "cleanup-crew-b0-final-response-gate",
    phase: "phase5_mechanical_policy_unification_b0_adapter",
    owner: "Will",
    summary: responseText,
    blocker: responseText,
    nextRepairPathKnown: hasNextRepairPath(responseText) || milestoneVisibilityReport,
    evidence: ["active-run-continuation-guard:b0-compatibility-input"],
    rollbackProofRef: "active-run-continuation-guard:previous-local-classifier",
  });
  const repairableBlocker = typedDecisionContinuesRepair(typedDecisionReceipt);
  const nextRepairPathKnown = typedDecisionNamesNextRepair(typedDecisionReceipt);
  const blockerArtifactPresent = hasBlockerArtifact(responseText);
  const laneCDecisionRequired = hasLaneCDecisionRequired(responseText);
  const hardBlockerNamedWithProof =
    typedDecisionIsHardTerminalBlocker(typedDecisionReceipt) &&
    hasTerminalBlockerProofArtifacts(responseText);
  const typedTerminalBlocker = typedDecisionBlocksTerminalCloseout(typedDecisionReceipt);
  const reportCloseoutAcceptance = resolveCleanupCrewReportCloseoutAcceptance({
    currentTurnText: params.currentTurnText,
    reportText: params.responseText,
    activeCleanupCrewMission,
    reportBodyDeliveredInChat: true,
    milestoneStageCompleted: milestoneVisibilityReport,
    milestoneReportDelivered: milestoneVisibilityReport,
  });
  const reportAcceptanceAdvisoryOnly =
    params.falseCloseoutAdmissionMode === "shadow" || params.falseCloseoutAdmissionMode === "off";
  const postReportContinuationRequiresWork =
    reportCloseoutAcceptance.postReportContinuation.state === "continuation_dispatch_required" ||
    reportCloseoutAcceptance.postReportContinuation.state === "pending_continuation_action";

  if (!activeCleanupCrewMission || !terminalAttempt) {
    return {
      allowed: true,
      activeCleanupCrewMission,
      terminalAttempt,
      explicitReportOnlyRequest,
      explicitStopRequest,
      milestoneVisibilityReport,
      repairableBlocker,
      nextRepairPathKnown,
      hardBlockerNamedWithProof,
      blockerArtifactPresent,
      laneCDecisionRequired,
      typedDecisionReceipt,
    };
  }

  if (!reportAcceptanceAdvisoryOnly && !reportCloseoutAcceptance.allowedToAcceptReport) {
    return {
      allowed: false,
      activeCleanupCrewMission,
      terminalAttempt,
      explicitReportOnlyRequest,
      explicitStopRequest,
      milestoneVisibilityReport,
      repairableBlocker,
      nextRepairPathKnown,
      hardBlockerNamedWithProof,
      blockerArtifactPresent,
      laneCDecisionRequired,
      typedDecisionReceipt,
      violationReason: `Cleanup Crew report/closeout acceptance rejected final response: ${reportCloseoutAcceptance.reason}`,
    };
  }

  if (
    explicitReportOnlyRequest ||
    explicitStopRequest ||
    fullBuildCompleteReport ||
    hardBlockerNamedWithProof ||
    (laneCDecisionRequired && blockerArtifactPresent)
  ) {
    return {
      allowed: true,
      activeCleanupCrewMission,
      terminalAttempt,
      explicitReportOnlyRequest,
      explicitStopRequest,
      milestoneVisibilityReport,
      repairableBlocker,
      nextRepairPathKnown,
      hardBlockerNamedWithProof,
      blockerArtifactPresent,
      laneCDecisionRequired,
      typedDecisionReceipt,
    };
  }

  if (laneCDecisionRequired && !blockerArtifactPresent) {
    return {
      allowed: false,
      activeCleanupCrewMission,
      terminalAttempt,
      explicitReportOnlyRequest,
      explicitStopRequest,
      milestoneVisibilityReport,
      repairableBlocker,
      nextRepairPathKnown,
      hardBlockerNamedWithProof,
      blockerArtifactPresent,
      laneCDecisionRequired,
      typedDecisionReceipt,
      violationReason:
        "Cleanup Crew Lane C terminal stop requires a blocker artifact naming the Mark decision",
    };
  }

  if (
    typedTerminalBlocker &&
    typedDecisionIsHardTerminalBlocker(typedDecisionReceipt) &&
    !hardBlockerNamedWithProof
  ) {
    return {
      allowed: false,
      activeCleanupCrewMission,
      terminalAttempt,
      explicitReportOnlyRequest,
      explicitStopRequest,
      milestoneVisibilityReport,
      repairableBlocker,
      nextRepairPathKnown,
      hardBlockerNamedWithProof,
      blockerArtifactPresent,
      laneCDecisionRequired,
      typedDecisionReceipt,
      violationReason:
        "Cleanup Crew hard-blocker terminal close requires the exact hard blocker and proof",
    };
  }

  if (repairableBlocker || nextRepairPathKnown || postReportContinuationRequiresWork) {
    return {
      allowed: false,
      activeCleanupCrewMission,
      terminalAttempt,
      explicitReportOnlyRequest,
      explicitStopRequest,
      milestoneVisibilityReport,
      repairableBlocker,
      nextRepairPathKnown,
      hardBlockerNamedWithProof,
      blockerArtifactPresent,
      laneCDecisionRequired,
      typedDecisionReceipt,
      violationReason: postReportContinuationRequiresWork
        ? `Cleanup Crew final response attempted terminal closeout while broader work remains open: ${reportCloseoutAcceptance.postReportContinuation.reason}`
        : "Cleanup Crew final response attempted terminal blocked/done/closeout while a lawful repair path is known or derivable",
    };
  }

  return {
    allowed: true,
    activeCleanupCrewMission,
    terminalAttempt,
    explicitReportOnlyRequest,
    explicitStopRequest,
    milestoneVisibilityReport,
    repairableBlocker,
    nextRepairPathKnown,
    hardBlockerNamedWithProof,
    blockerArtifactPresent,
    laneCDecisionRequired,
    typedDecisionReceipt,
  };
}

function shouldRejectTerminalCloseout(state: GuardState): boolean {
  return !resolveActiveRunDurabilityDecision(state).allowedToSettle;
}

function resolveActiveRunDurabilityDecision(state: GuardState): GovernedRunDurabilityDecision {
  return resolveGovernedRunDurability({
    governedRunActive: state.activeRunStarted,
    nonTerminalUpdateEmitted: state.lastUpdateWasNonTerminal,
    nextExecutableStepStarted: state.nextExecutableStepStarted,
    ownerBoundaryHandoffRecorded: state.ownerBoundaryHandoffRecorded,
    lawfulBlockerRecorded: state.blocker || state.operatorPauseHold,
    terminalCompletionProofRecorded: state.terminalCompletionProofRecorded,
    idempotencyKey: buildActiveRunDurabilityIdempotencyKey(state, "active-run-continuation"),
  });
}

function buildActiveRunDurabilityIdempotencyKey(state: GuardState, reason: string): string {
  const seed = [
    state.persistence?.activeMission ?? "active-run-continuation",
    state.persistence?.sourceSurface ?? "active-run-continuation-guard",
    state.lastNonTerminalDetail ?? "no-detail",
    reason,
  ].join("|");
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function buildViolationNoticePayload(reason: string): ReplyPayload {
  return {
    text: `ACTIVE_RUN_CONTINUITY_VIOLATION: ${reason}`,
    isStatusNotice: true,
    isError: true,
  };
}

function buildBlockedCloseoutPayload(reason: string): ReplyPayload {
  return {
    text: `BLOCKED_CLOSEOUT: ${reason}`,
    isStatusNotice: true,
    isError: true,
  };
}

function buildOperatorPauseHoldPayload(reason: string): ReplyPayload {
  return {
    text: `OPERATOR_PAUSED: ${reason}`,
    isStatusNotice: true,
  };
}

function buildFalseCloseoutShadowPayload(decision: CompletionDecision): ReplyPayload {
  return {
    text: `FALSE_CLOSEOUT_SHADOW_REJECTED: ${decision.rejectionCodes.join(", ")}`,
    isStatusNotice: true,
  };
}

function persistFalseCloseoutAdmissionDecision(
  input: NonNullable<ReplyPayloadMetadata["falseCloseoutAdmission"]>,
  decision: CompletionDecision,
): string | undefined {
  try {
    return writeFalseCloseoutAdmissionDecisionReceipt({ input, decision }).path;
  } catch {
    return undefined;
  }
}

function emitViolationNotice(dispatcher: ReplyDispatcher, state: GuardState, reason: string): void {
  if (state.violationNoticeQueued) {
    return;
  }
  state.violationNoticeQueued = true;
  dispatcher.sendToolResult(buildViolationNoticePayload(reason));
}

function emitBlockedCloseout(state: GuardState): void {
  if (state.blockedCloseoutQueued) {
    return;
  }
  state.blockedCloseoutQueued = true;
  state.blocker = true;
  state.blockerType = "runtime_violation";
  recordEvent(state, "BLOCKER_STATE", "true:runtime_violation");
  recordEvent(state, "TERMINAL_CLOSEOUT_ALLOWED", "BLOCKED_CLOSEOUT");
}

function applyOperatorPauseHold(state: GuardState, currentTurnText: string | undefined): void {
  if (
    classifyCurrentInboundInstruction(currentTurnText) === "unrestricted" ||
    state.operatorPauseHold
  ) {
    return;
  }
  state.operatorPauseHold = true;
  state.blocker = true;
  state.blockerType = "operator_pause_hold";
  recordEvent(state, "OPERATOR_PAUSE_HOLD_RECORDED", "operator_pause_hold");
  recordEvent(state, "BLOCKER_STATE", "true:operator_pause_hold");
}

function createContinuityGateIssueForViolation(params: {
  reason: string;
  lastNonTerminalDetail?: string;
  kind: "terminal_closeout_rejected" | "blocked_closeout";
}): ContinuityGateIssue {
  return {
    summary: `Active-run continuation guard ${params.kind}: ${params.reason}`,
    blocker: "pending reply exists",
    pathRisk: "MEDIUM_RISK_RUNTIME",
    diffIntent: "routing_or_catalog_recording",
    safeTechnicalPathDescription:
      "Continue active-run execution by starting the next executable step or recording a lawful blocker before terminal closeout.",
    ownerLevelBlockerAudit: "active_run_continuation_guard",
    ...(params.lastNonTerminalDetail ? { behaviorImpact: "plan_driven" } : {}),
  };
}

async function persistActiveRunDurabilityObligation(
  state: GuardState,
  params: {
    reason: string;
    kind: "terminal_closeout_rejected" | "blocked_closeout";
    decision: GovernedRunDurabilityDecision;
  },
): Promise<void> {
  if (!state.persistence) {
    return;
  }
  const idempotencyKey = buildActiveRunDurabilityIdempotencyKey(state, params.reason);
  const outputDir = path.join(state.persistence.outputDir, "durability_obligations");
  const filePath = path.join(outputDir, `${idempotencyKey}.json`);
  const now = state.persistence.now ?? new Date().toISOString();
  const record = {
    kind: "openclaw.governed-run-durability-obligation",
    schemaVersion: 1,
    idempotencyKey,
    status: "open",
    createdAt: now,
    updatedAt: now,
    sourceSurface: state.persistence.sourceSurface ?? "active-run-continuation-guard",
    activeMission: state.persistence.activeMission,
    eventKind: params.kind,
    reason: params.reason,
    obligatedOwner: "active_run_controller",
    watchdogVisible: params.decision.watchdogVisible,
    requiredActions: params.decision.requiredActions,
    durabilityDecision: params.decision,
    lastNonTerminalDetail: state.lastNonTerminalDetail ?? null,
    ownerBoundaryHandoffDetail: state.ownerBoundaryHandoffDetail ?? null,
    proofRefs: state.persistence.proofRefs ?? [],
    authoritySources: state.persistence.authoritySources,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  recordEvent(state, "GOVERNED_RUN_DURABILITY_OBLIGATION_WRITTEN", filePath);
}

function persistContinuityGateDecision(
  state: GuardState,
  params: {
    reason: string;
    kind: "terminal_closeout_rejected" | "blocked_closeout";
  },
): void {
  if (!state.persistence) {
    return;
  }
  if (state.continuityGatePersistenceQueued) {
    return;
  }
  state.continuityGatePersistenceQueued = true;
  const durabilityDecision = resolveActiveRunDurabilityDecision(state);
  recordEvent(
    state,
    "GOVERNED_RUN_DURABILITY_CONTRACT_REJECTED",
    `${durabilityDecision.state}:${durabilityDecision.requiredActions.join(",")}`,
  );
  const durabilityWrite = persistActiveRunDurabilityObligation(state, {
    reason: params.reason,
    kind: params.kind,
    decision: durabilityDecision,
  }).then(
    () => undefined,
    () => undefined,
  );
  state.pendingPersistenceWrites.push(durabilityWrite);
  const write = persistCleanupCrewContinuityGateDecision({
    outputDir: state.persistence.outputDir,
    activeMission: state.persistence.activeMission,
    now: state.persistence.now,
    authoritySources: state.persistence.authoritySources,
    issue: createContinuityGateIssueForViolation({
      reason: params.reason,
      lastNonTerminalDetail: state.lastNonTerminalDetail,
      kind: params.kind,
    }),
    scope: {
      files: ["src/auto-reply/reply/active-run-continuation-guard.ts"],
      records: state.lastNonTerminalDetail ? [state.lastNonTerminalDetail] : [],
      commands: [],
    },
    repairAction: "start next executable step or record a lawful blocker before terminal closeout",
    proofPath: state.persistence.proofRefs?.[0] ?? "active_run_continuation_guard",
    diagnostic: {
      surfaces: [state.persistence.sourceSurface ?? "active-run-continuation-guard"],
      proofRefs: state.persistence.proofRefs ?? [],
      redactionStatus: "no_sensitive_payloads",
    },
  }).then(
    () => undefined,
    () => undefined,
  );
  state.pendingPersistenceWrites.push(write);
}

export function installActiveRunContinuationGuard(
  dispatcher: ReplyDispatcher,
  options?: {
    persistence?: ActiveRunContinuityGatePersistenceOptions;
    cleanupCrewFinalResponse?: CleanupCrewFinalResponseGuardContext;
  },
): void {
  if (guardStateByDispatcher.has(dispatcher)) {
    if (options?.persistence) {
      guardStateByDispatcher.get(dispatcher)!.persistence = options.persistence;
    }
    if (options?.cleanupCrewFinalResponse) {
      guardStateByDispatcher.get(dispatcher)!.cleanupCrewFinalResponse =
        options.cleanupCrewFinalResponse;
      applyOperatorPauseHold(
        guardStateByDispatcher.get(dispatcher)!,
        options.cleanupCrewFinalResponse.currentTurnText,
      );
    }
    return;
  }
  const state: GuardState = {
    events: [],
    activeRunStarted: false,
    lastUpdateWasNonTerminal: false,
    blocker: false,
    ownerBoundaryHandoffRecorded: false,
    operatorPauseHold: false,
    nextExecutableStepStarted: false,
    terminalCompletionProofRecorded: false,
    violationNoticeQueued: false,
    blockedCloseoutQueued: false,
    persistence: options?.persistence,
    cleanupCrewFinalResponse: options?.cleanupCrewFinalResponse,
    pendingPersistenceWrites: [],
    continuityGatePersistenceQueued: false,
  };
  applyOperatorPauseHold(state, options?.cleanupCrewFinalResponse?.currentTurnText);
  guardStateByDispatcher.set(dispatcher, state);
}

export function beginActiveRunContinuationGuard(dispatcher: ReplyDispatcher): void {
  // A dispatcher can be reused across inbound turns. Its prior mission/pause
  // evidence must not decide whether a new, unrelated turn can answer.
  guardStateByDispatcher.delete(dispatcher);
  installActiveRunContinuationGuard(dispatcher);
  recordActiveRunStarted(dispatcher);
}

export function recordActiveRunStarted(dispatcher: ReplyDispatcher): void {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state || state.activeRunStarted) {
    return;
  }
  state.activeRunStarted = true;
  recordEvent(state, "ACTIVE_RUN_STARTED");
}

export function recordNonTerminalBuildUpdateEmitted(
  dispatcher: ReplyDispatcher,
  detail?: string,
): void {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state) {
    return;
  }
  state.lastUpdateWasNonTerminal = true;
  state.lastNonTerminalDetail = detail;
  state.nextExecutableStepStarted = false;
  state.ownerBoundaryHandoffRecorded = false;
  state.ownerBoundaryHandoffDetail = undefined;
  state.terminalCompletionProofRecorded = false;
  state.continuityGatePersistenceQueued = false;
  recordEvent(state, "NON_TERMINAL_BUILD_UPDATE_EMITTED", detail);
  recordEvent(
    state,
    "BLOCKER_STATE",
    state.blocker ? `true:${state.blockerType ?? "unknown"}` : "false",
  );
}

export function recordOwnerBoundaryHandoff(dispatcher: ReplyDispatcher, detail?: string): void {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state) {
    return;
  }
  state.ownerBoundaryHandoffRecorded = true;
  state.ownerBoundaryHandoffDetail = detail;
  recordEvent(state, "OWNER_BOUNDARY_HANDOFF_RECORDED", detail);
}

export function recordNextExecutableStepStarted(
  dispatcher: ReplyDispatcher,
  detail?: string,
): void {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state || !state.lastUpdateWasNonTerminal || state.nextExecutableStepStarted) {
    return;
  }
  state.nextExecutableStepStarted = true;
  recordEvent(state, "NEXT_EXECUTABLE_STEP_STARTED", detail);
}

export function recordTerminalCompletionProof(dispatcher: ReplyDispatcher, detail?: string): void {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state || state.terminalCompletionProofRecorded) {
    return;
  }
  state.terminalCompletionProofRecorded = true;
  recordEvent(state, "TERMINAL_COMPLETION_PROOF_RECORDED", detail);
}

export function recordLawfulBlocker(dispatcher: ReplyDispatcher, blockerType: string): void {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state) {
    return;
  }
  state.blocker = true;
  state.blockerType = blockerType;
  recordEvent(state, "BLOCKER_STATE", `true:${blockerType}`);
}

export function allowTerminalCloseout(
  dispatcher: ReplyDispatcher,
  kind: "sendFinalReply" | "markComplete",
  payload?: ReplyPayload,
): { allowed: boolean; violationReason?: string } {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state) {
    return { allowed: true };
  }
  recordEvent(state, "TERMINAL_CLOSEOUT_ATTEMPTED", kind);
  if (kind === "sendFinalReply") {
    if (isSystemwideDepartmentFlowAcknowledgementText(payload?.text)) {
      recordTerminalCompletionProof(dispatcher, "systemwide_department_flow_acknowledgement");
    }
    const cleanupCrewDecision = resolveCleanupCrewFinalResponseGate({
      currentTurnText: state.cleanupCrewFinalResponse?.currentTurnText,
      activeCleanupCrewMission: state.cleanupCrewFinalResponse?.activeCleanupCrewMission,
      responseText: payload?.text,
      falseCloseoutAdmissionMode: state.cleanupCrewFinalResponse?.falseCloseoutAdmissionMode,
    });
    const falseCloseoutAdmission =
      (payload ? getReplyPayloadMetadata(payload)?.falseCloseoutAdmission : undefined) ??
      buildRuntimeCloseoutAdmissionInput({
        activeCleanupCrewMission: cleanupCrewDecision.activeCleanupCrewMission,
        // Ending an explicitly requested report/hold is not a mission COMPLETE
        // transition. Explicit typed completion evidence above still applies.
        terminalAttempt:
          cleanupCrewDecision.terminalAttempt &&
          !cleanupCrewDecision.explicitReportOnlyRequest &&
          !cleanupCrewDecision.explicitStopRequest,
        currentTurnText: state.cleanupCrewFinalResponse?.currentTurnText,
        responseText: payload?.text,
        mode: state.cleanupCrewFinalResponse?.falseCloseoutAdmissionMode,
        activeRunStarted: state.activeRunStarted,
        executionRunningNow: getReplyPayloadMetadata(payload ?? {})?.activeRunContinuation
          ?.executionRunningNow,
        nextExecutableStepStarted: state.nextExecutableStepStarted,
        pendingContinuationRequirement: hasPendingContinuationRequirement(state),
        blocker: state.blocker,
      });
    if (falseCloseoutAdmission) {
      const decision = evaluateFalseCloseoutAdmission(falseCloseoutAdmission);
      const receiptPath = persistFalseCloseoutAdmissionDecision(falseCloseoutAdmission, decision);
      if (decision.mode === "off") {
        recordEvent(
          state,
          "FALSE_CLOSEOUT_ADMISSION_OFF_BYPASSED",
          `${decision.state}:${decision.rejectionCodes.join(",")}${receiptPath ? `:${receiptPath}` : ""}`,
        );
      } else if (decision.allowed) {
        recordEvent(
          state,
          "FALSE_CLOSEOUT_ADMISSION_ALLOWED",
          `${decision.mode}:${decision.state}${receiptPath ? `:${receiptPath}` : ""}`,
        );
      } else if (decision.mode === "enforce") {
        const violationReason = `False-closeout admission controller rejected terminal closeout: ${decision.rejectionCodes.join(", ")}`;
        recordEvent(
          state,
          "FALSE_CLOSEOUT_ADMISSION_ENFORCED_REJECTED",
          `${violationReason}${receiptPath ? ` receipt=${receiptPath}` : ""}`,
        );
        recordEvent(state, "ACTIVE_RUN_CONTINUITY_VIOLATION", violationReason);
        persistContinuityGateDecision(state, {
          reason: violationReason,
          kind: "terminal_closeout_rejected",
        });
        emitViolationNotice(dispatcher, state, violationReason);
        return { allowed: false, violationReason };
      } else if (decision.mode === "shadow") {
        recordEvent(
          state,
          "FALSE_CLOSEOUT_ADMISSION_SHADOW_REJECTED",
          `${decision.rejectionCodes.join(",")}${receiptPath ? `:${receiptPath}` : ""}`,
        );
        dispatcher.sendToolResult(buildFalseCloseoutShadowPayload(decision));
      }
    }
    if (
      cleanupCrewDecision.activeCleanupCrewMission &&
      cleanupCrewDecision.milestoneVisibilityReport &&
      !cleanupCrewDecision.terminalAttempt
    ) {
      if (state.nextExecutableStepStarted) {
        recordEvent(
          state,
          "NON_TERMINAL_BUILD_UPDATE_EMITTED",
          "cleanup_crew_milestone_visibility_report",
        );
      } else {
        recordNonTerminalBuildUpdateEmitted(dispatcher, "cleanup_crew_milestone_visibility_report");
      }
    }
    if (!cleanupCrewDecision.allowed) {
      const violationReason =
        cleanupCrewDecision.violationReason ??
        "Cleanup Crew terminal final response rejected by final-response gate";
      recordEvent(state, "CLEANUP_CREW_TERMINAL_CLOSEOUT_REJECTED", violationReason);
      recordEvent(state, "ACTIVE_RUN_CONTINUITY_VIOLATION", violationReason);
      persistContinuityGateDecision(state, {
        reason: violationReason,
        kind: "terminal_closeout_rejected",
      });
      emitViolationNotice(dispatcher, state, violationReason);
      return { allowed: false, violationReason };
    }
  }
  if (!shouldRejectTerminalCloseout(state)) {
    recordEvent(state, "TERMINAL_CLOSEOUT_ALLOWED", kind);
    return { allowed: true };
  }
  const violationReason =
    kind === "markComplete"
      ? "markComplete attempted before next executable step started after a non-terminal build update"
      : "non-terminal build update was followed by terminal closeout before the next executable step started";
  recordEvent(state, "ACTIVE_RUN_CONTINUITY_VIOLATION", violationReason);
  persistContinuityGateDecision(state, {
    reason: violationReason,
    kind: "terminal_closeout_rejected",
  });
  emitViolationNotice(dispatcher, state, violationReason);
  return { allowed: false, violationReason };
}

export async function flushBlockedCloseoutIfNeeded(dispatcher: ReplyDispatcher): Promise<void> {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state) {
    return;
  }
  if (
    hasPendingContinuationRequirement(state) &&
    state.operatorPauseHold &&
    !state.blockedCloseoutQueued
  ) {
    state.blockedCloseoutQueued = true;
    const reason =
      "active production run is held by the operator's status-only/pause instruction. Mission remains open and resumable; no premature closeout violation is recorded.";
    recordEvent(state, "TERMINAL_CLOSEOUT_ALLOWED", "OPERATOR_PAUSED");
    dispatcher.sendFinalReply(buildOperatorPauseHoldPayload(reason));
    return;
  }
  if (!shouldRejectTerminalCloseout(state)) {
    return;
  }
  const reason =
    "active production run tried to close after a non-terminal build update before the next executable step started or a lawful blocker was recorded. Next action: start the next executable step, or record a lawful blocker such as approval_blocked, approval_unavailable, restart_or_reload, hard_stop, or safety_stop.";
  recordEvent(state, "ACTIVE_RUN_CONTINUITY_VIOLATION", reason);
  persistContinuityGateDecision(state, {
    reason,
    kind: "blocked_closeout",
  });
  emitViolationNotice(dispatcher, state, reason);
  emitBlockedCloseout(state);
  await Promise.all(state.pendingPersistenceWrites);
  dispatcher.sendFinalReply(buildBlockedCloseoutPayload(reason));
}

export const testing = {
  getEvents(dispatcher: ReplyDispatcher): ActiveRunContinuationEvent[] {
    return guardStateByDispatcher.get(dispatcher)?.events.slice() ?? [];
  },
  hasGuard(dispatcher: ReplyDispatcher): boolean {
    return guardStateByDispatcher.has(dispatcher);
  },
  reset(dispatcher: ReplyDispatcher): void {
    guardStateByDispatcher.delete(dispatcher);
  },
  async flushPersistence(dispatcher: ReplyDispatcher): Promise<void> {
    const state = guardStateByDispatcher.get(dispatcher);
    if (!state) {
      return;
    }
    await Promise.all(state.pendingPersistenceWrites);
  },
};
