import type { FinishedSession, ProcessSession } from "../agents/bash-process-registry.js";
import type { RunExit, RunRecord } from "../process/supervisor/types.js";
import type {
  GovernedMissionFailureState,
  SupervisorReceipt,
} from "./governed-mission-contract.js";
import { sha256Text } from "./mission-evidence-store.js";

export type GovernedSupervisorIdentity = Pick<
  SupervisorReceipt,
  "missionId" | "contractId" | "contractVersion" | "contractHash" | "authorityHash"
> & {
  policyVersion: string;
};

export type GovernedSupervisorRuntimeState =
  | "running"
  | "healthy"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "failed"
  | "completed";

export type GovernedSupervisorReceipt = SupervisorReceipt & {
  schema: "openclaw.governed_supervisor_receipt.v1";
  supervisorState: GovernedSupervisorRuntimeState;
  failureState?: GovernedMissionFailureState;
  sessionId: string;
  runId?: string;
  taskId?: string;
  flowId?: string;
  pid?: number;
  processGroupId?: number;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  cancelled: boolean;
  killed: boolean;
  stdoutSummary: string;
  stderrSummary: string;
  terminalResult: "running" | "succeeded" | "failed" | "blocked";
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  durationMs?: number;
  timedOut: boolean;
  noOutputTimedOut: boolean;
  evidenceRefs: string[];
};

export type GovernedSupervisorEvaluation = {
  schema: "openclaw.governed_supervisor_evaluation.v1";
  decision: "ALLOW" | "BLOCK";
  reasonCode:
    | "SUPERVISION_NOT_REQUIRED"
    | "SUPERVISOR_HEALTHY"
    | "SUPERVISOR_UNAVAILABLE"
    | "SUPERVISOR_TIMEOUT"
    | "SUPERVISOR_RECEIPT_MISSING";
  failureState?: GovernedMissionFailureState;
  obligations: string[];
};

export function evaluateGovernedSupervisorRequirement(params: {
  wrapperRequired: boolean;
  wrapperPresent: boolean;
  supervisorAvailable: boolean;
  receipt?: GovernedSupervisorReceipt;
}): GovernedSupervisorEvaluation {
  if (!params.wrapperRequired) {
    return allow("SUPERVISION_NOT_REQUIRED", []);
  }
  if (!params.wrapperPresent || !params.supervisorAvailable) {
    return block("SUPERVISOR_UNAVAILABLE", "FAILED_SUPERVISOR", [
      "route_through_governed_supervisor_wrapper",
      "write_supervisor_receipt",
    ]);
  }
  if (!params.receipt) {
    return block("SUPERVISOR_RECEIPT_MISSING", "FAILED_SUPERVISOR", ["write_supervisor_receipt"]);
  }
  if (params.receipt.supervisorState === "timeout") {
    return block("SUPERVISOR_TIMEOUT", params.receipt.failureState ?? "TIMED_OUT", [
      "record_supervisor_timeout",
      "write_supervisor_receipt",
    ]);
  }
  return allow("SUPERVISOR_HEALTHY", ["write_supervisor_receipt"]);
}

export function buildGovernedSupervisorReceipt(params: {
  identity: GovernedSupervisorIdentity;
  producer: string;
  session: ProcessSession | FinishedSession;
  runRecord?: RunRecord;
  exit?: RunExit;
  taskId?: string;
  flowId?: string;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  evidenceRefs?: string[];
  producedAt: string;
}): GovernedSupervisorReceipt {
  const state = resolveSupervisorState(params);
  const terminalResult = resolveTerminalResult(params, state);
  const stdoutSummary = summarizeOutput(params.exit?.stdout ?? params.session.aggregated ?? "");
  const stderrSummary = summarizeOutput(params.exit?.stderr ?? "");
  const receiptSeed = [
    params.identity.missionId,
    params.identity.contractId,
    params.session.id,
    params.runRecord?.runId ?? "",
    params.producedAt,
    state,
    terminalResult,
  ].join("\n");

  return {
    schema: "openclaw.governed_supervisor_receipt.v1",
    receiptKind: "supervisor",
    missionId: params.identity.missionId,
    contractId: params.identity.contractId,
    contractVersion: params.identity.contractVersion,
    contractHash: params.identity.contractHash,
    authorityHash: params.identity.authorityHash,
    receiptId: `supervisor:${sha256Text(receiptSeed).slice(0, 32)}`,
    producedAt: params.producedAt,
    producer: params.producer,
    state: mapContractSupervisorState(state, terminalResult),
    supervisorState: state,
    failureState: mapFailureState(params, state, terminalResult),
    sessionId: params.session.id,
    runId: params.runRecord?.runId,
    taskId: params.taskId,
    flowId: params.flowId,
    pid: params.runRecord?.pid ?? ("pid" in params.session ? params.session.pid : undefined),
    processGroupId: params.runRecord?.processGroupId,
    timeoutMs: params.timeoutMs,
    noOutputTimeoutMs: params.noOutputTimeoutMs,
    cancelled: params.runRecord?.terminationReason === "manual-cancel",
    killed: Boolean(params.runRecord?.exitSignal ?? params.exit?.exitSignal),
    stdoutSummary,
    stderrSummary,
    terminalResult,
    exitCode: params.runRecord?.exitCode ?? params.exit?.exitCode,
    exitSignal: params.runRecord?.exitSignal ?? params.exit?.exitSignal,
    durationMs: params.exit?.durationMs ?? finishedDuration(params.session),
    timedOut: params.exit?.timedOut === true || state === "timeout",
    noOutputTimedOut: params.exit?.noOutputTimedOut === true,
    evidenceRefs: params.evidenceRefs ?? [],
  };
}

function allow(
  reasonCode: GovernedSupervisorEvaluation["reasonCode"],
  obligations: string[],
): GovernedSupervisorEvaluation {
  return {
    schema: "openclaw.governed_supervisor_evaluation.v1",
    decision: "ALLOW",
    reasonCode,
    obligations,
  };
}

function block(
  reasonCode: GovernedSupervisorEvaluation["reasonCode"],
  failureState: GovernedMissionFailureState,
  obligations: string[],
): GovernedSupervisorEvaluation {
  return {
    schema: "openclaw.governed_supervisor_evaluation.v1",
    decision: "BLOCK",
    reasonCode,
    failureState,
    obligations,
  };
}

function resolveSupervisorState(params: {
  session: ProcessSession | FinishedSession;
  runRecord?: RunRecord;
  exit?: RunExit;
}): GovernedSupervisorRuntimeState {
  const reason = params.runRecord?.terminationReason ?? params.exit?.reason;
  if (reason === "overall-timeout" || reason === "no-output-timeout") {
    return "timeout";
  }
  if (reason === "manual-cancel") {
    return "cancelled";
  }
  if (
    params.runRecord?.state === "running" ||
    (!("status" in params.session) && !params.session.exited)
  ) {
    return "running";
  }
  if ("status" in params.session && params.session.status === "completed") {
    return "completed";
  }
  if (params.exit?.exitCode === 0 && params.exit.reason === "exit") {
    return "completed";
  }
  return "failed";
}

function resolveTerminalResult(
  params: {
    session: ProcessSession | FinishedSession;
    exit?: RunExit;
  },
  state: GovernedSupervisorRuntimeState,
): GovernedSupervisorReceipt["terminalResult"] {
  if (state === "running" || state === "healthy") {
    return "running";
  }
  if (state === "timeout" || state === "cancelled" || state === "unavailable") {
    return "blocked";
  }
  if ("status" in params.session && params.session.status === "completed") {
    return "succeeded";
  }
  if (params.exit?.exitCode === 0 && params.exit.reason === "exit") {
    return "succeeded";
  }
  return "failed";
}

function mapContractSupervisorState(
  state: GovernedSupervisorRuntimeState,
  terminalResult: GovernedSupervisorReceipt["terminalResult"],
): SupervisorReceipt["state"] {
  if (state === "running") {
    return "running";
  }
  if (state === "timeout" || state === "unavailable") {
    return "stale";
  }
  if (terminalResult === "succeeded") {
    return "healthy";
  }
  return "terminal";
}

function mapFailureState(
  params: {
    session: ProcessSession | FinishedSession;
    exit?: RunExit;
  },
  state: GovernedSupervisorRuntimeState,
  terminalResult: GovernedSupervisorReceipt["terminalResult"],
): GovernedMissionFailureState | undefined {
  if (terminalResult === "succeeded" || state === "running" || state === "healthy") {
    return undefined;
  }
  if (state === "timeout") {
    return "TIMED_OUT";
  }
  if (state === "cancelled") {
    return "CANCELLED";
  }
  if (state === "unavailable") {
    return "FAILED_SUPERVISOR";
  }
  if ("status" in params.session && params.session.status === "killed") {
    return "CANCELLED";
  }
  return "FAILED_TOOL";
}

function finishedDuration(session: ProcessSession | FinishedSession): number | undefined {
  if (!("endedAt" in session)) {
    return undefined;
  }
  return Math.max(0, session.endedAt - session.startedAt);
}

function summarizeOutput(value: string, maxChars = 400): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, maxChars - 1) + "…";
}
