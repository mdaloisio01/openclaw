import { persistCleanupCrewContinuityGateDecision } from "../../commands/cleanup-plan.js";
import type { AuthoritySource, ContinuityGateIssue } from "../../continuity/continuity-gate-v2.js";
import { classifyCleanupCrewBlocker } from "../../continuity/continuity-gate-v2.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

export type ActiveRunContinuationEventType =
  | "ACTIVE_RUN_STARTED"
  | "NON_TERMINAL_BUILD_UPDATE_EMITTED"
  | "BLOCKER_STATE"
  | "NEXT_EXECUTABLE_STEP_STARTED"
  | "TERMINAL_CLOSEOUT_ATTEMPTED"
  | "TERMINAL_CLOSEOUT_ALLOWED"
  | "CLEANUP_CREW_TERMINAL_CLOSEOUT_REJECTED"
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
  nextExecutableStepStarted: boolean;
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

function isExplicitReportOnlyRequest(text: string): boolean {
  return includesAny(text, [
    "report only",
    "report-only",
    "status only",
    "status-only",
    "only report",
    "just report",
    "no execution",
    "don't continue",
    "do not continue",
  ]);
}

function isExplicitStopRequest(text: string): boolean {
  return includesAny(text, [
    "explicitly stop",
    "stop after this",
    "stop now",
    "pause after this",
    "do not continue",
    "don't continue",
  ]);
}

function isMilestoneVisibilityReport(text: string): boolean {
  return (
    text.includes("status:") &&
    text.includes("mode:") &&
    (text.includes("packet complete:") || text.includes("stage complete:")) &&
    text.includes("next packet:") &&
    text.includes("safety check:") &&
    text.includes("blockers:")
  );
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
  if (text.includes("status: done") || text.includes("status: complete")) {
    return true;
  }
  return false;
}

function hasRepairableBlocker(text: string): boolean {
  return includesAny(text, [
    "repairable blocker",
    "repairable prerequisite blocker",
    "downstream phase blocked",
    "watchdog needs_review",
    "watchdog stoppage captured",
    "routed to cleanup crew recovery",
    "cleanup crew recovery",
    "needs_review",
    "phase 13 watchdog",
    "phase 13",
    "stop adjacent production",
    "stop_adjacent_phase",
    "stop_phase_transition",
    "continue cleanup repair",
    "continue_cleanup_repair",
    "next repair classification",
    "lawful repair path",
    "proof gap",
    "proof_gap",
    "stoppage captured",
    "plan amendment required",
    "recovery amendment",
    "lane a",
    "lane b",
    "memory append lane",
    "memory flush dirty-tree defect",
    "append-only memory",
  ]);
}

function hasNextRepairPath(text: string): boolean {
  return includesAny(text, [
    "next repair path",
    "safe next action:",
    "next action:",
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

function hasUnsupportedHardBlocker(text: string): boolean {
  return includesAny(text, [
    "raw db",
    "raw-db",
    "unsafe duplicate worker restart",
    "authority cannot be verified",
    "live path truth cannot be verified",
    "supported owner surface cannot be verified",
    "no lawful repair path",
    "no repair path",
    "continuation is impossible",
  ]);
}

function hasNamedHardBlockerProof(text: string): boolean {
  return (
    (text.includes("blocker:") || text.includes("packet blocked:")) &&
    (text.includes("proof:") || text.includes("why continuation is not lawful:")) &&
    hasBlockerArtifact(text) &&
    hasUnsupportedHardBlocker(text)
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

export function resolveCleanupCrewFinalResponseGate(params: {
  currentTurnText?: string;
  responseText?: string;
  activeCleanupCrewMission?: boolean;
}): CleanupCrewFinalResponseGateDecision {
  const currentTurnText = normalizeText(params.currentTurnText);
  const responseText = normalizeText(params.responseText);
  const combinedText = `${currentTurnText}\n${responseText}`;
  const activeCleanupCrewMission =
    params.activeCleanupCrewMission === true || isCleanupCrewText(combinedText);
  const explicitReportOnlyRequest = isExplicitReportOnlyRequest(currentTurnText);
  const explicitStopRequest = isExplicitStopRequest(currentTurnText);
  const milestoneVisibilityReport = isMilestoneVisibilityReport(responseText);
  const terminalAttempt = isTerminalAttemptText(responseText);
  const blockerClassification = classifyCleanupCrewBlocker({
    summary: responseText,
    blocker: responseText,
    nextRepairPathKnown: hasNextRepairPath(responseText) || milestoneVisibilityReport,
  });
  const repairableBlocker =
    hasRepairableBlocker(responseText) || blockerClassification.canContinueCleanupRepair;
  const nextRepairPathKnown =
    hasNextRepairPath(responseText) ||
    milestoneVisibilityReport ||
    blockerClassification.scopedStops.includes("continue_cleanup_repair");
  const blockerArtifactPresent = hasBlockerArtifact(responseText);
  const laneCDecisionRequired = hasLaneCDecisionRequired(responseText);
  const hardBlockerNamedWithProof = hasNamedHardBlockerProof(responseText);

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
    };
  }

  if (
    explicitReportOnlyRequest ||
    explicitStopRequest ||
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
      violationReason:
        "Cleanup Crew Lane C terminal stop requires a blocker artifact naming the Mark decision",
    };
  }

  if (
    hasUnsupportedHardBlocker(responseText) ||
    (blockerClassification.hardStopWholeMission && hardBlockerNamedWithProof === false)
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
      violationReason:
        "Cleanup Crew hard-blocker terminal close requires the exact hard blocker and proof",
    };
  }

  if (repairableBlocker || nextRepairPathKnown) {
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
      violationReason:
        "Cleanup Crew final response attempted terminal blocked/done/closeout while a lawful repair path is known or derivable",
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
  };
}

function shouldRejectTerminalCloseout(state: GuardState): boolean {
  return (
    hasPendingContinuationRequirement(state) &&
    state.blocker === false &&
    state.nextExecutableStepStarted === false
  );
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
    }
    return;
  }
  const state: GuardState = {
    events: [],
    activeRunStarted: false,
    lastUpdateWasNonTerminal: false,
    blocker: false,
    nextExecutableStepStarted: false,
    violationNoticeQueued: false,
    blockedCloseoutQueued: false,
    persistence: options?.persistence,
    cleanupCrewFinalResponse: options?.cleanupCrewFinalResponse,
    pendingPersistenceWrites: [],
    continuityGatePersistenceQueued: false,
  };
  guardStateByDispatcher.set(dispatcher, state);
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
  state.blocker = false;
  state.blockerType = undefined;
  state.continuityGatePersistenceQueued = false;
  recordEvent(state, "NON_TERMINAL_BUILD_UPDATE_EMITTED", detail);
  recordEvent(state, "BLOCKER_STATE", "false");
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
    const cleanupCrewDecision = resolveCleanupCrewFinalResponseGate({
      currentTurnText: state.cleanupCrewFinalResponse?.currentTurnText,
      activeCleanupCrewMission: state.cleanupCrewFinalResponse?.activeCleanupCrewMission,
      responseText: payload?.text,
    });
    if (
      cleanupCrewDecision.activeCleanupCrewMission &&
      cleanupCrewDecision.milestoneVisibilityReport &&
      cleanupCrewDecision.terminalAttempt === false
    ) {
      recordNonTerminalBuildUpdateEmitted(dispatcher, "cleanup_crew_milestone_visibility_report");
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
  if (!state || !shouldRejectTerminalCloseout(state)) {
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
