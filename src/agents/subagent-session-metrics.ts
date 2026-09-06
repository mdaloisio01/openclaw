import { isSystemwideDepartmentFlowAcknowledgementText } from "../governance/systemwide-department-flow-acknowledgement.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function resolveSubagentSessionStartedAtInternal(
  entry: Pick<SubagentRunRecord, "sessionStartedAt" | "startedAt" | "createdAt">,
): number | undefined {
  if (typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)) {
    return entry.sessionStartedAt;
  }
  if (typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)) {
    return entry.startedAt;
  }
  return typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
    ? entry.createdAt
    : undefined;
}

export function getSubagentSessionStartedAt(
  entry: Pick<SubagentRunRecord, "sessionStartedAt" | "startedAt" | "createdAt"> | null | undefined,
): number | undefined {
  return entry ? resolveSubagentSessionStartedAtInternal(entry) : undefined;
}

export function getSubagentSessionRuntimeMs(
  entry:
    | Pick<SubagentRunRecord, "startedAt" | "endedAt" | "accumulatedRuntimeMs">
    | null
    | undefined,
  now = Date.now(),
): number | undefined {
  if (!entry) {
    return undefined;
  }

  const accumulatedRuntimeMs =
    typeof entry.accumulatedRuntimeMs === "number" && Number.isFinite(entry.accumulatedRuntimeMs)
      ? Math.max(0, entry.accumulatedRuntimeMs)
      : 0;

  if (typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt)) {
    return entry.accumulatedRuntimeMs != null ? accumulatedRuntimeMs : undefined;
  }

  const currentRunEndedAt =
    typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt) ? entry.endedAt : now;
  return Math.max(0, accumulatedRuntimeMs + Math.max(0, currentRunEndedAt - entry.startedAt));
}

export function resolveSubagentSessionStatus(
  entry:
    | Pick<SubagentRunRecord, "endedAt" | "endedReason" | "outcome" | "completion">
    | null
    | undefined,
): "running" | "killed" | "failed" | "timeout" | "done" | undefined {
  if (!entry) {
    return undefined;
  }
  if (!entry.endedAt) {
    return "running";
  }
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return "killed";
  }
  if (entry.completion?.grantCloseoutGate?.requiresCorrectedCloseout === true) {
    return "failed";
  }
  const status = entry.outcome?.status;
  if (status === "error") {
    return "failed";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "done";
}

export function resolveSubagentMaterialProgressState(
  entry: Pick<SubagentRunRecord, "endedAt" | "outcome" | "completion"> | null | undefined,
):
  | "running_no_closeout_yet"
  | "closeout_rejected"
  | "closeout_review_passed"
  | "acknowledgement_schema_returned"
  | "runtime_completed_no_closeout_gate"
  | "runtime_failed"
  | "runtime_timeout"
  | undefined {
  if (!entry) {
    return undefined;
  }
  const gate = entry.completion?.grantCloseoutGate;
  if (gate?.requiresCorrectedCloseout === true || gate?.reviewStatus === "rejected") {
    return "closeout_rejected";
  }
  if (gate?.reviewStatus === "passed" || gate?.passed === true) {
    return "closeout_review_passed";
  }
  if (isSystemwideDepartmentFlowAcknowledgementText(entry.completion?.resultText ?? undefined)) {
    return "acknowledgement_schema_returned";
  }
  if (!entry.endedAt) {
    return "running_no_closeout_yet";
  }
  if (entry.outcome?.status === "error") {
    return "runtime_failed";
  }
  if (entry.outcome?.status === "timeout") {
    return "runtime_timeout";
  }
  return "runtime_completed_no_closeout_gate";
}
