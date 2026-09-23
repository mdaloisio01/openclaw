import { runTaskInFlow } from "../tasks/task-executor.js";
import { getTaskFlowById } from "../tasks/task-flow-registry.js";
import { listTasksForFlowId } from "../tasks/task-registry.js";
import type { TaskRuntime } from "../tasks/task-registry.types.js";
import { evaluatePolicyDecision, type GiePolicyDecision } from "./policy-engine.js";

export const GIE_RUNTIME_PLATFORM_SURFACES = [
  "task-flow-registry",
  "task-executor",
  "task-registry",
  "dispatch",
  "receipts",
  "work-orders",
  "lane-outcomes",
  "proof",
] as const;

export type GieRuntimePlatformSurface = (typeof GIE_RUNTIME_PLATFORM_SURFACES)[number];

export type GieRuntimePlatformMap = {
  boundary: "phase2_soft_execution_under_phase1_policy";
  surfaces: readonly GieRuntimePlatformSurface[];
  stableInterfaces: {
    taskFlowLookup: "getTaskFlowById";
    taskLookup: "listTasksForFlowId";
    childDispatch: "runTaskInFlow";
    dispatchGate: "evaluatePolicyDecision";
  };
  proof: {
    rebuiltSourceTruth: true;
    phase1PolicyDominates: true;
    oldTaskFlowRevivalAllowed: false;
  };
};

export type GieSubstrateTruth = {
  flowId: string;
  flowFound: boolean;
  taskCount: number;
  surfaces: readonly GieRuntimePlatformSurface[];
  proofRefs: string[];
};

export type GieSoftExecutionDispatchInput = {
  flowId: string;
  runtime: TaskRuntime;
  task: string;
  ownerLane: string;
  ownerTarget: string;
  proofRefs: string[];
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
};

export type GieSoftExecutionDispatchResult = {
  dispatched: boolean;
  policyDecision: GiePolicyDecision;
  reason?: string;
  flowFound?: boolean;
  taskId?: string;
  runId?: string;
};

function cleanString(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanProofRefs(value: string[]): string[] {
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

export function getGieRuntimePlatformMap(): GieRuntimePlatformMap {
  return {
    boundary: "phase2_soft_execution_under_phase1_policy",
    surfaces: GIE_RUNTIME_PLATFORM_SURFACES,
    stableInterfaces: {
      taskFlowLookup: "getTaskFlowById",
      taskLookup: "listTasksForFlowId",
      childDispatch: "runTaskInFlow",
      dispatchGate: "evaluatePolicyDecision",
    },
    proof: {
      rebuiltSourceTruth: true,
      phase1PolicyDominates: true,
      oldTaskFlowRevivalAllowed: false,
    },
  };
}

export function readGieSubstrateTruth(params: {
  flowId: string;
  proofRefs?: string[];
}): GieSubstrateTruth {
  const flowId = cleanString(params.flowId);
  const flow = flowId ? getTaskFlowById(flowId) : undefined;
  const tasks = flow ? listTasksForFlowId(flow.flowId) : [];
  return {
    flowId,
    flowFound: Boolean(flow),
    taskCount: tasks.length,
    surfaces: GIE_RUNTIME_PLATFORM_SURFACES,
    proofRefs: cleanProofRefs(params.proofRefs ?? []),
  };
}

export function dispatchGieSoftExecution(
  input: GieSoftExecutionDispatchInput,
): GieSoftExecutionDispatchResult {
  const proofRefs = cleanProofRefs(input.proofRefs);
  const policyDecision = evaluatePolicyDecision({
    action: "dispatch_preflight",
    ownerLane: input.ownerLane,
    ownerTarget: input.ownerTarget,
    proofRefs,
  });

  if (!policyDecision.allowed) {
    return {
      dispatched: false,
      policyDecision,
      reason: policyDecision.reason,
    };
  }

  const task = cleanString(input.task);
  if (!task) {
    return {
      dispatched: false,
      policyDecision,
      reason: "Soft execution dispatch requires task text.",
    };
  }

  const result = runTaskInFlow({
    flowId: input.flowId,
    runtime: input.runtime,
    task,
    childSessionKey: input.childSessionKey,
    parentTaskId: input.parentTaskId,
    agentId: input.agentId,
    runId: input.runId,
    label: input.label,
    sourceId: "gie_runtime_platform",
    deliveryStatus: "pending",
  });

  if (!result.created || !result.task) {
    return {
      dispatched: false,
      policyDecision,
      flowFound: result.found,
      reason: result.reason,
    };
  }

  return {
    dispatched: true,
    policyDecision,
    flowFound: result.found,
    taskId: result.task.taskId,
    runId: result.task.runId,
  };
}
