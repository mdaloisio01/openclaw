import { findAcpSessionEntryByBackendSessionId } from "../acp/runtime/session-meta.js";
import type { OwnerRequestIntakeExpectedDurability } from "../agents/owner-request-intake-ledger.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getTaskFlowById } from "./task-flow-registry.js";
import { listTasksForSessionKey } from "./task-registry.js";

export function resolveOwnerRequestIntakeBinding(params: {
  sessionKey: string;
  expectedDurability: OwnerRequestIntakeExpectedDurability;
  cfg: OpenClawConfig;
}): { taskId: string; taskFlowId?: string } | undefined {
  const localKey = parseAgentSessionKey(params.sessionKey)?.rest ?? params.sessionKey;
  const bridgeSessionId = localKey.startsWith("acp-bridge:")
    ? localKey.slice("acp-bridge:".length)
    : undefined;
  const outer = bridgeSessionId
    ? findAcpSessionEntryByBackendSessionId({ backendSessionId: bridgeSessionId, cfg: params.cfg })
    : undefined;
  if (bridgeSessionId && outer?.acp?.state !== "running") {
    return undefined;
  }
  const ownerSessionKey = outer?.sessionKey ?? params.sessionKey;
  const tasks = listTasksForSessionKey(ownerSessionKey).filter(
    (task) =>
      task.childSessionKey === ownerSessionKey &&
      task.status === "running" &&
      !task.endedAt &&
      Boolean(task.runId) &&
      (!bridgeSessionId || task.runtime === "acp"),
  );
  // A session name alone cannot choose between competing executions.
  // Bind while the outer owner is active, before oneshot cleanup removes metadata.
  if (tasks.length !== 1) {
    return undefined;
  }
  const task = tasks[0];
  const flow = task.parentFlowId ? getTaskFlowById(task.parentFlowId) : undefined;
  if (task.parentFlowId && (!flow || !["running", "waiting"].includes(flow.status))) {
    return undefined;
  }
  if (params.expectedDurability === "taskflow_required" && !flow) {
    return undefined;
  }
  return { taskId: task.taskId, ...(flow ? { taskFlowId: flow.flowId } : {}) };
}
