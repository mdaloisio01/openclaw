import { createAgentHarnessTaskRuntimeScope } from "../../../tasks/agent-harness-task-runtime-scope.js";
import {
  getTaskFlowById,
  getTaskFlowProductionContinuation,
} from "../../../tasks/task-flow-runtime-internal.js";
import { findLatestActiveMissionForOwnerKey } from "../../../tasks/task-registry.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";

export function resolveAgentHarnessTaskRuntimeScope(params: {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
}) {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const activeMission = findLatestActiveMissionForOwnerKey(requesterSessionKey);
  const parentFlowId = activeMission?.parentFlowId?.trim();
  const linkedFlow = parentFlowId ? getTaskFlowById(parentFlowId) : undefined;
  const linkedContinuation = linkedFlow ? getTaskFlowProductionContinuation(linkedFlow) : null;
  return createAgentHarnessTaskRuntimeScope({
    requesterSessionKey,
    requesterOrigin: params.requesterOrigin,
    ...(linkedContinuation?.activeProductionRun && parentFlowId ? { parentFlowId } : {}),
    ...(linkedContinuation?.activeProductionRun && activeMission?.taskId?.trim()
      ? { parentTaskId: activeMission.taskId.trim() }
      : {}),
  });
}
