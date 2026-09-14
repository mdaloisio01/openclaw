export type SessionExecutionTruthLiveState =
  | "active_confirmed"
  | "not_running_terminal"
  | "not_yet_proven";

export type SessionExecutionTruthSessionStatus =
  | "running"
  | "done"
  | "failed"
  | "killed"
  | "timeout";

export type SharedSessionExecutionTruth = {
  runningNow: boolean;
  liveExecutionState: SessionExecutionTruthLiveState;
  sessionStatusSnapshot?: SessionExecutionTruthSessionStatus;
  subagentRunStateSnapshot?: string;
  proofSummary: string;
};

function readSessionExecutionTruthSessionStatus(
  value: string | undefined,
): SessionExecutionTruthSessionStatus | undefined {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : undefined;
}

export function buildSessionExecutionTruthFromSnapshot(params: {
  status?: string;
  subagentRunState?: string;
  hasActiveSubagentRun?: boolean;
  endedAt?: number;
  sourceLabel?: string;
  suppressWhenEmpty?: boolean;
}): SharedSessionExecutionTruth | undefined {
  const sourceLabel = params.sourceLabel?.trim() || "Session snapshot";
  const hasActiveSubagentRun = params.hasActiveSubagentRun === true;
  const status = readSessionExecutionTruthSessionStatus(params.status);
  const subagentRunState = params.subagentRunState;
  const endedAt = params.endedAt;

  if (hasActiveSubagentRun || status === "running") {
    return {
      runningNow: true,
      liveExecutionState: "active_confirmed",
      ...(status ? { sessionStatusSnapshot: status } : {}),
      subagentRunStateSnapshot: subagentRunState,
      proofSummary: `${sourceLabel} shows an active run right now.`,
    };
  }
  if (
    status === "done" ||
    status === "failed" ||
    status === "killed" ||
    status === "timeout" ||
    typeof endedAt === "number"
  ) {
    return {
      runningNow: false,
      liveExecutionState: "not_running_terminal",
      ...(status ? { sessionStatusSnapshot: status } : {}),
      subagentRunStateSnapshot: subagentRunState,
      proofSummary: `${sourceLabel} is terminal, so it is not actively running now.`,
    };
  }
  if (params.suppressWhenEmpty && !status && !subagentRunState && !hasActiveSubagentRun) {
    return undefined;
  }
  return {
    runningNow: false,
    liveExecutionState: "not_yet_proven",
    ...(status ? { sessionStatusSnapshot: status } : {}),
    subagentRunStateSnapshot: subagentRunState,
    proofSummary: `${sourceLabel} does not prove an active run right now.`,
  };
}
