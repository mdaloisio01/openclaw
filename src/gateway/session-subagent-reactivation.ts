import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry-read.js";

async function loadSessionSubagentReactivationRuntime() {
  return import("./session-subagent-reactivation.runtime.js");
}

export async function reactivateCompletedSubagentSession(params: {
  sessionKey: string;
  runId?: string;
}): Promise<boolean> {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const existing = getLatestSubagentRunByChildSessionKey(params.sessionKey);
  if (!existing || typeof existing.endedAt !== "number") {
    return false;
  }
  const runtime = await loadSessionSubagentReactivationRuntime();
  if (existing.parentYieldWait?.requiredCloseout) {
    await runtime.assertParentYieldWaitAllowsRestart(existing.runId);
  }
  const replaced = await runtime.replaceSubagentRunAfterSteer({
    previousRunId: existing.runId,
    nextRunId: runId,
    fallback: existing,
    runTimeoutSeconds: existing.runTimeoutSeconds ?? 0,
  });
  if (!replaced && existing.parentYieldWait?.requiredCloseout) {
    throw new Error(
      "Child reactivation could not preserve its required parent wait; retry after settlement.",
    );
  }
  return replaced;
}
