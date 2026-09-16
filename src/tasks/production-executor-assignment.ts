import { z } from "zod";
import type { JsonValue, TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  getTaskFlowById,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";

export const productionExecutorCapabilitySchema = z.enum([
  "repo_read",
  "repo_write",
  "runtime_restart",
  "watchdog_repair",
  "taskflow_reconciliation",
  "grant_review",
  "report_delivery",
  "production_dispatch",
]);
export const productionExecutorRoleSchema = z.enum([
  "Will",
  "Grant",
  "Coding Agent",
  "TaskFlow",
  "Watchdog",
  "SADB",
]);

const identity = z.string().trim().min(1).max(256);
const evidenceRef = z.string().trim().min(1).max(4_096);
const assignmentSchema = z.strictObject({
  taskId: identity,
  expectedRunId: identity,
  executorId: identity,
  ownerLane: identity,
  role: productionExecutorRoleSchema,
  permitted: z.array(productionExecutorCapabilitySchema).min(1),
  prohibited: z.array(productionExecutorCapabilitySchema),
  evidenceRefs: z.array(evidenceRef).min(1).max(32),
  assignedAt: z.number().int().nonnegative(),
});
const assignmentAuthoritySchema = z.strictObject({
  role: productionExecutorRoleSchema,
  permitted: z.array(productionExecutorCapabilitySchema).min(1),
  prohibited: z.array(productionExecutorCapabilitySchema),
});
const assignmentsSchema = z.array(assignmentSchema);

export type ProductionExecutorCapability = z.infer<typeof productionExecutorCapabilitySchema>;
export type ProductionExecutorRole = z.infer<typeof productionExecutorRoleSchema>;
export type ProductionExecutorAssignment = z.infer<typeof assignmentSchema>;

const ASSIGNMENTS_STATE_KEY = "productionExecutorAssignments";

function flowState(flow: TaskFlowRecord): Record<string, JsonValue> | undefined {
  const state = flow.stateJson;
  return state && typeof state === "object" && !Array.isArray(state) ? state : undefined;
}

function readAssignments(flow: TaskFlowRecord): ProductionExecutorAssignment[] | undefined {
  const state = flowState(flow);
  if (!state) {
    return undefined;
  }
  const value = state[ASSIGNMENTS_STATE_KEY];
  if (value === undefined) {
    return [];
  }
  const parsed = assignmentsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function canonicalCapabilities(
  values: readonly ProductionExecutorCapability[],
): ProductionExecutorCapability[] {
  return [...new Set(values)].toSorted();
}

export function parseProductionExecutorAssignmentAuthority(input: {
  role: unknown;
  permitted: unknown;
  prohibited: unknown;
}):
  | {
      ok: true;
      role: ProductionExecutorRole;
      permitted: ProductionExecutorCapability[];
      prohibited: ProductionExecutorCapability[];
    }
  | { ok: false } {
  const parsed = assignmentAuthoritySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false };
  }
  return {
    ok: true,
    role: parsed.data.role,
    permitted: canonicalCapabilities(parsed.data.permitted),
    prohibited: canonicalCapabilities(parsed.data.prohibited),
  };
}

export function getProductionExecutorAssignment(
  flow: TaskFlowRecord,
  taskId: string,
): ProductionExecutorAssignment | undefined {
  return readAssignments(flow)?.find((assignment) => assignment.taskId === taskId);
}

export function recordProductionExecutorAssignment(params: {
  flowId: string;
  taskId: string;
  expectedRunId: string;
  executorId: string;
  ownerLane: string;
  role: ProductionExecutorRole;
  permitted: readonly ProductionExecutorCapability[];
  prohibited: readonly ProductionExecutorCapability[];
  evidenceRefs: readonly string[];
  assignedAt?: number;
}):
  | { applied: true; assignment: ProductionExecutorAssignment; flow: TaskFlowRecord }
  | { applied: false; reason: string } {
  const flow = getTaskFlowById(params.flowId);
  const state = flow && flowState(flow);
  const previous = flow && readAssignments(flow);
  if (!flow || !state || !previous) {
    return { applied: false, reason: "production_executor_assignment_state_invalid" };
  }
  const parsed = assignmentSchema.safeParse({
    taskId: params.taskId,
    expectedRunId: params.expectedRunId,
    executorId: params.executorId,
    ownerLane: params.ownerLane,
    role: params.role,
    permitted: canonicalCapabilities(params.permitted),
    prohibited: canonicalCapabilities(params.prohibited),
    evidenceRefs: [...params.evidenceRefs],
    assignedAt: params.assignedAt ?? Date.now(),
  });
  if (!parsed.success) {
    return { applied: false, reason: "production_executor_assignment_invalid" };
  }
  const assignment = parsed.data;
  const next = [...previous.filter((entry) => entry.taskId !== assignment.taskId), assignment];
  const saved = updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    patch: {
      stateJson: { ...state, [ASSIGNMENTS_STATE_KEY]: next },
      updatedAt: assignment.assignedAt,
    },
  });
  if (!saved.applied) {
    return { applied: false, reason: `production_executor_assignment_write_${saved.reason}` };
  }
  const verified = getProductionExecutorAssignment(saved.flow, assignment.taskId);
  if (!verified || JSON.stringify(verified) !== JSON.stringify(assignment)) {
    return { applied: false, reason: "production_executor_assignment_readback_failed" };
  }
  return { applied: true, assignment: verified, flow: saved.flow };
}
