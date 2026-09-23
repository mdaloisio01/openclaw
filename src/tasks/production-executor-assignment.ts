import { createHash } from "node:crypto";
import { z } from "zod";
import {
  GOVERNED_MISSION_STATE_VALUES,
  type GovernedMissionStateValue,
} from "../governance/governed-mission-state.js";
import {
  findCurrentGovernedExecutionAttemptFromSqlite,
  hasCanonicalGovernedMissionProvenanceFromSqlite,
} from "./task-flow-registry.store.sqlite.js";
import type { JsonValue, TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  commitGovernedMissionLedger,
  getTaskFlowById,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

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
export const productionProofPurposeSchema = z.enum([
  "implementation",
  "validation",
  "review",
  "delivery",
]);

const identity = z.string().trim().min(1).max(256);
const evidenceRef = z.string().trim().min(1).max(4_096);
const assignmentSchema = z.strictObject({
  taskId: identity,
  expectedRunId: identity,
  executorId: identity,
  producerDeviceId: identity.optional(),
  ownerLane: identity,
  proofPurpose: productionProofPurposeSchema.optional(),
  governedMissionId: identity.optional(),
  governedContractHash: identity.optional(),
  governedPlanRevisionId: identity.optional(),
  governedAttemptReceiptId: identity.optional(),
  governedAttemptRunId: identity.optional(),
  governedMissionRevision: z.number().int().nonnegative().optional(),
  governedMissionState: z.enum(GOVERNED_MISSION_STATE_VALUES).optional(),
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
export type ProductionProofPurpose = z.infer<typeof productionProofPurposeSchema>;
export type ProductionExecutorAssignment = z.infer<typeof assignmentSchema>;

export function computeProductionExecutorAssignmentSha256(
  assignment: ProductionExecutorAssignment,
): string {
  // Zod normalizes the assignment into schema key order at dispatch. Bind the
  // completion receipt to that exact authority so reassignment cannot reuse it.
  return createHash("sha256").update(JSON.stringify(assignment)).digest("hex");
}

const PROOF_ASSIGNMENT_REQUIRED_STATE: Partial<
  Record<ProductionProofPurpose, GovernedMissionStateValue>
> = {
  implementation: "executing",
  validation: "implementation_complete",
  review: "validation_complete",
};

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

export function isProductionExecutorAssignmentCurrentGovernedAttempt(params: {
  flow: TaskFlowRecord;
  assignment: ProductionExecutorAssignment;
}): boolean {
  const state = flowState(params.flow);
  const mission = state?.governedMissionState;
  if (!mission || typeof mission !== "object" || Array.isArray(mission)) {
    return false;
  }
  const contractHash = typeof mission.contractHash === "string" ? mission.contractHash : undefined;
  const currentAttempt = contractHash
    ? findCurrentGovernedExecutionAttemptFromSqlite({ flowId: params.flow.flowId, contractHash })
    : undefined;
  return Boolean(
    currentAttempt &&
    params.assignment.governedMissionId === mission.missionId &&
    params.assignment.governedContractHash === mission.contractHash &&
    params.assignment.governedPlanRevisionId === mission.planRevisionId &&
    params.assignment.governedAttemptReceiptId === currentAttempt.receiptId &&
    params.assignment.governedAttemptRunId === currentAttempt.attemptId,
  );
}

export function recordProductionExecutorAssignment(params: {
  flowId: string;
  taskId: string;
  expectedRunId: string;
  executorId: string;
  producerDeviceId?: string;
  ownerLane: string;
  proofPurpose?: ProductionProofPurpose;
  role: ProductionExecutorRole;
  permitted: readonly ProductionExecutorCapability[];
  prohibited: readonly ProductionExecutorCapability[];
  evidenceRefs: readonly string[];
  assignedAt?: number;
  taskUpdate?: TaskRecord;
  taskDeliveryState?: TaskDeliveryState;
}):
  | { applied: true; assignment: ProductionExecutorAssignment; flow: TaskFlowRecord }
  | { applied: false; reason: string } {
  const flow = getTaskFlowById(params.flowId);
  const state = flow && flowState(flow);
  const previous = flow && readAssignments(flow);
  if (!flow || !state || !previous) {
    return { applied: false, reason: "production_executor_assignment_state_invalid" };
  }
  if (
    params.taskUpdate &&
    (params.taskUpdate.taskId !== params.taskId ||
      params.taskUpdate.runId !== params.expectedRunId ||
      params.taskUpdate.parentFlowId !== params.flowId ||
      params.taskUpdate.ownerKey !== flow.ownerKey)
  ) {
    return { applied: false, reason: "production_executor_assignment_task_mismatch" };
  }
  if (
    params.taskDeliveryState &&
    (!params.taskUpdate || params.taskDeliveryState.taskId !== params.taskUpdate.taskId)
  ) {
    return { applied: false, reason: "production_executor_assignment_delivery_state_mismatch" };
  }
  const parsed = assignmentSchema.safeParse({
    taskId: params.taskId,
    expectedRunId: params.expectedRunId,
    executorId: params.executorId,
    producerDeviceId: params.producerDeviceId,
    ownerLane: params.ownerLane,
    proofPurpose: params.proofPurpose,
    role: params.role,
    permitted: canonicalCapabilities(params.permitted),
    prohibited: canonicalCapabilities(params.prohibited),
    evidenceRefs: [...params.evidenceRefs],
    assignedAt: params.assignedAt ?? Date.now(),
  });
  if (!parsed.success) {
    return { applied: false, reason: "production_executor_assignment_invalid" };
  }
  let assignment = parsed.data;
  const governedMission = state.governedMissionState;
  if (governedMission && typeof governedMission === "object" && !Array.isArray(governedMission)) {
    const mission = governedMission as Record<string, JsonValue>;
    const missionId = typeof mission.missionId === "string" ? mission.missionId : undefined;
    const missionRevision =
      typeof mission.revision === "number" && Number.isSafeInteger(mission.revision)
        ? mission.revision
        : undefined;
    if (!missionId || missionRevision === undefined) {
      return { applied: false, reason: "production_executor_assignment_governance_invalid" };
    }
    if (!assignment.proofPurpose) {
      return { applied: false, reason: "production_executor_assignment_proof_purpose_missing" };
    }
    const currentGovernedState = GOVERNED_MISSION_STATE_VALUES.find(
      (candidate) => candidate === mission.currentGovernedState,
    );
    if (!currentGovernedState) {
      return { applied: false, reason: "production_executor_assignment_governance_invalid" };
    }
    const requiredState = PROOF_ASSIGNMENT_REQUIRED_STATE[assignment.proofPurpose];
    if (requiredState && currentGovernedState !== requiredState) {
      return { applied: false, reason: "production_executor_assignment_lifecycle_invalid" };
    }
    if (!hasCanonicalGovernedMissionProvenanceFromSqlite({ flow, missionId })) {
      return { applied: false, reason: "production_executor_assignment_governance_untrusted" };
    }
    const contractHash =
      typeof mission.contractHash === "string" ? mission.contractHash : undefined;
    const planRevisionId =
      typeof mission.planRevisionId === "string" ? mission.planRevisionId : undefined;
    const currentAttempt = contractHash
      ? findCurrentGovernedExecutionAttemptFromSqlite({ flowId: flow.flowId, contractHash })
      : undefined;
    if (!currentAttempt?.attemptId || !contractHash || !planRevisionId) {
      return { applied: false, reason: "production_executor_assignment_governed_attempt_missing" };
    }
    assignment = assignmentSchema.parse({
      ...assignment,
      governedMissionId: missionId,
      governedContractHash: contractHash,
      governedPlanRevisionId: planRevisionId,
      governedAttemptReceiptId: currentAttempt.receiptId,
      governedAttemptRunId: currentAttempt.attemptId,
      governedMissionRevision: missionRevision,
      governedMissionState: currentGovernedState,
    });
    const next = [...previous.filter((entry) => entry.taskId !== assignment.taskId), assignment];
    const details = assignment as unknown as JsonValue;
    const payloadSha256 = createHash("sha256").update(JSON.stringify(assignment)).digest("hex");
    const nextFlow: TaskFlowRecord = {
      ...flow,
      revision: flow.revision + 1,
      stateJson: { ...state, [ASSIGNMENTS_STATE_KEY]: next },
      updatedAt: assignment.assignedAt,
    };
    const committed = commitGovernedMissionLedger({
      nextFlow,
      ...(params.taskUpdate ? { taskUpdate: params.taskUpdate } : {}),
      ...(params.taskDeliveryState ? { taskDeliveryState: params.taskDeliveryState } : {}),
      receipt: {
        receiptId: `executor-assignment:${flow.flowId}:${assignment.taskId}`,
        missionId,
        flowId: flow.flowId,
        runId: assignment.expectedRunId,
        operation: "recordExecutorAssignment",
        receiptKind: "transition",
        fromState:
          typeof mission.currentGovernedState === "string"
            ? mission.currentGovernedState
            : undefined,
        toState:
          typeof mission.currentGovernedState === "string"
            ? mission.currentGovernedState
            : undefined,
        decision: "applied",
        reasonCode: "EXECUTOR_ASSIGNMENT_RECORDED",
        expectedRevision: missionRevision,
        resultingRevision: missionRevision,
        contractId: typeof mission.contractId === "string" ? mission.contractId : undefined,
        contractHash: typeof mission.contractHash === "string" ? mission.contractHash : undefined,
        authorityHash:
          typeof mission.authorityHash === "string" ? mission.authorityHash : undefined,
        planRevisionId:
          typeof mission.planRevisionId === "string" ? mission.planRevisionId : undefined,
        sourceRevision:
          typeof mission.sourceRevision === "string" ? mission.sourceRevision : undefined,
        runtimeBuildSha256:
          typeof mission.runtimeBuildSha256 === "string" ? mission.runtimeBuildSha256 : undefined,
        policyVersion:
          typeof mission.policyVersion === "string" ? mission.policyVersion : undefined,
        skillSha256: typeof mission.skillSha256 === "string" ? mission.skillSha256 : undefined,
        payloadSha256,
        producer: "openclaw.governed_mission_runtime.v1",
        idempotencyKey: `executor-assignment:${assignment.taskId}`,
        details,
        createdAt: assignment.assignedAt,
      },
    });
    if (committed.status !== "inserted" && committed.status !== "already_applied") {
      if (committed.status === "revision_conflict" && committed.reason === "untrusted_state") {
        return { applied: false, reason: "production_executor_assignment_governance_untrusted" };
      }
      return { applied: false, reason: `production_executor_assignment_write_${committed.status}` };
    }
    const savedFlow = getTaskFlowById(flow.flowId);
    const verified = savedFlow
      ? getProductionExecutorAssignment(savedFlow, assignment.taskId)
      : undefined;
    if (!savedFlow || !verified || JSON.stringify(verified) !== JSON.stringify(assignment)) {
      return { applied: false, reason: "production_executor_assignment_readback_failed" };
    }
    return { applied: true, assignment: verified, flow: savedFlow };
  }
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
