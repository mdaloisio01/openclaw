import type { ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

export type ActiveRunContinuationEventType =
  | "ACTIVE_RUN_STARTED"
  | "NON_TERMINAL_BUILD_UPDATE_EMITTED"
  | "BLOCKER_STATE"
  | "NEXT_EXECUTABLE_STEP_STARTED"
  | "TERMINAL_CLOSEOUT_ATTEMPTED"
  | "TERMINAL_CLOSEOUT_ALLOWED"
  | "ACTIVE_RUN_CONTINUITY_VIOLATION";

export type ActiveRunContinuationEvent = {
  type: ActiveRunContinuationEventType;
  detail?: string;
};

type GuardState = {
  events: ActiveRunContinuationEvent[];
  activeRunStarted: boolean;
  lastUpdateWasNonTerminal: boolean;
  blocker: boolean;
  blockerType?: string;
  nextExecutableStepStarted: boolean;
  violationNoticeQueued: boolean;
  blockedCloseoutQueued: boolean;
};

const guardStateByDispatcher = new WeakMap<ReplyDispatcher, GuardState>();

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

export function installActiveRunContinuationGuard(dispatcher: ReplyDispatcher): void {
  if (guardStateByDispatcher.has(dispatcher)) {
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
  state.nextExecutableStepStarted = false;
  state.blocker = false;
  state.blockerType = undefined;
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
): { allowed: boolean; violationReason?: string } {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state) {
    return { allowed: true };
  }
  recordEvent(state, "TERMINAL_CLOSEOUT_ATTEMPTED", kind);
  if (!shouldRejectTerminalCloseout(state)) {
    recordEvent(state, "TERMINAL_CLOSEOUT_ALLOWED", kind);
    return { allowed: true };
  }
  const violationReason =
    kind === "markComplete"
      ? "markComplete attempted before next executable step started after a non-terminal build update"
      : "non-terminal build update was followed by terminal closeout before the next executable step started";
  recordEvent(state, "ACTIVE_RUN_CONTINUITY_VIOLATION", violationReason);
  emitViolationNotice(dispatcher, state, violationReason);
  return { allowed: false, violationReason };
}

export async function flushBlockedCloseoutIfNeeded(dispatcher: ReplyDispatcher): Promise<void> {
  const state = guardStateByDispatcher.get(dispatcher);
  if (!state || !shouldRejectTerminalCloseout(state)) {
    return;
  }
  const reason =
    "active production run tried to close after a non-terminal build update before the next executable step started";
  recordEvent(state, "ACTIVE_RUN_CONTINUITY_VIOLATION", reason);
  emitViolationNotice(dispatcher, state, reason);
  emitBlockedCloseout(state);
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
};
