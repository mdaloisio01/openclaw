import type { JsonValue, TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { GovernedAuthorityRef, GovernedMissionContract } from "./governed-mission-contract.js";

export const GOVERNED_MISSION_STATE_VALUES = [
  "planned",
  "admitted",
  "executing",
  "implementation_complete",
  "validation_complete",
  "review_complete",
  "closeout_ready",
  "artifact_verified",
  "terminal_pending_watchdog",
  "released",
  "waiting",
  "blocked",
  "pending_override",
  "readmission_required",
  "repair_required",
  "cancelled",
  "failed",
  "lost",
  "operator_stopped",
] as const;

export type GovernedMissionStateValue = (typeof GOVERNED_MISSION_STATE_VALUES)[number];

export const GOVERNED_MISSION_TERMINAL_STATUSES = [
  "not_terminal",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const;

export type GovernedMissionTerminalStatus = (typeof GOVERNED_MISSION_TERMINAL_STATUSES)[number];

export const GOVERNED_MISSION_BLOCKED_STATUSES = [
  "not_blocked",
  "stale_authority_hash",
  "contract_hash_mismatch",
  "plan_revision_mismatch",
  "source_revision_mismatch",
  "runtime_build_mismatch",
  "policy_version_mismatch",
  "revision_mismatch",
  "readmission_required",
  "required_proof_missing",
  "artifact_verification_failed",
] as const;

export type GovernedMissionBlockedStatus = (typeof GOVERNED_MISSION_BLOCKED_STATUSES)[number];

export const GOVERNED_OVERRIDE_STATUSES = [
  "none",
  "pending",
  "approved",
  "denied",
  "expired",
] as const;

export type GovernedOverrideStatus = (typeof GOVERNED_OVERRIDE_STATUSES)[number];

export type GovernedMissionOwnerCorrelation = {
  owner: string;
  sessionKey?: string;
  runId?: string;
  taskFlowId?: string;
  taskRegistryTaskId?: string;
  cleanupCrewRunId?: string;
};

export type GovernedMissionOverrideRef = {
  overrideId?: string;
  status: GovernedOverrideStatus;
};

export const GOVERNED_MISSION_PROOF_STATUSES = [
  "pending",
  "passed",
  "failed",
  "not_required",
] as const;

export type GovernedMissionProofStatus = (typeof GOVERNED_MISSION_PROOF_STATUSES)[number];

export type GovernedMissionProofState = {
  implementation: GovernedMissionProofStatus;
  validation: GovernedMissionProofStatus;
  review: GovernedMissionProofStatus;
  artifacts: GovernedMissionProofStatus;
  rollback: GovernedMissionProofStatus;
  restoration: GovernedMissionProofStatus;
  postTerminalWatchdog: GovernedMissionProofStatus;
  delivery: GovernedMissionProofStatus;
};

export type GovernedPostTerminalWatchdogBinding = {
  boundRevision: number;
  runtimeBuildSha256: string;
};

export type GovernedMissionExecutionLease = {
  runId: string;
  processId: number;
  /** Linux /proc starttime used to distinguish a live owner from PID reuse. */
  processStartTime?: number;
  runtimeInstanceId: string;
  openedAt: string;
};

export type GovernedMissionTrustedHostPolicy = {
  trustedHost: boolean;
  openclawAllows: boolean;
  osAllows: boolean;
  hostAllows: boolean;
  reason?: string;
};

export type GovernedMissionReplacementIdentity = {
  contractId: string;
  contractVersion: string;
  contractHash: string;
  authorityHash: string;
  authorityRef: GovernedAuthorityRef;
  planRevisionId: string;
  sourceRevision: string;
  runtimeBuildSha256: string;
  policyVersion: string;
  skillSha256: string;
};

export type GovernedMissionState = {
  schema: "openclaw.governed_mission_state.v2";
  missionId: string;
  contractId: string;
  contractVersion: string;
  contractHash: string;
  authorityHash: string;
  authorityRef: GovernedAuthorityRef;
  planRevisionId: string;
  sourceRevision: string;
  runtimeBuildSha256: string;
  policyVersion: string;
  skillSha256: string;
  readmissionAuthorityRef?: GovernedAuthorityRef;
  parentMissionRef?: string;
  currentGovernedState: GovernedMissionStateValue;
  currentStep: string;
  ownerCorrelation: GovernedMissionOwnerCorrelation;
  overrideRef: GovernedMissionOverrideRef;
  terminalStatus: GovernedMissionTerminalStatus;
  blockedStatus: GovernedMissionBlockedStatus;
  proofs: GovernedMissionProofState;
  trustedHostPolicy: GovernedMissionTrustedHostPolicy;
  activeExecutionLease?: GovernedMissionExecutionLease;
  postTerminalWatchdogBinding?: GovernedPostTerminalWatchdogBinding;
  revision: number;
  stateVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateGovernedMissionStateInput = {
  contract: GovernedMissionContract;
  authorityRef: GovernedAuthorityRef;
  currentStep: string;
  ownerCorrelation: GovernedMissionOwnerCorrelation;
  parentMissionRef?: string;
  requiredProofs?: Partial<Record<keyof GovernedMissionProofState, boolean>>;
  trustedHostPolicy?: GovernedMissionTrustedHostPolicy;
  now: string;
};

export type GovernedMissionStateUpdate = {
  expectedRevision: number;
  currentStep?: string;
  currentGovernedState?: GovernedMissionStateValue;
  ownerCorrelation?: GovernedMissionOwnerCorrelation;
  overrideRef?: GovernedMissionOverrideRef;
  terminalStatus?: GovernedMissionTerminalStatus;
  blockedStatus?: GovernedMissionBlockedStatus;
  proofs?: GovernedMissionProofState;
  activeExecutionLease?: GovernedMissionExecutionLease;
  clearActiveExecutionLease?: boolean;
  postTerminalWatchdogBinding?: GovernedPostTerminalWatchdogBinding;
  clearPostTerminalWatchdogBinding?: boolean;
  replacementIdentity?: GovernedMissionReplacementIdentity;
  now: string;
};

export type AuthoritySnapshot = {
  contractHash: string;
  authorityHash: string;
  authorityRef: GovernedAuthorityRef;
};

export type GovernedMissionReadmissionCheck =
  | {
      ok: true;
      state: GovernedMissionState;
    }
  | {
      ok: false;
      state: GovernedMissionState;
      reason: "contract_hash_mismatch" | "stale_authority_hash";
    };

export const GOVERNED_MISSION_TASKFLOW_STATE_KEY = "governedMissionState";

const GOVERNED_MISSION_CHILD_CREATION_CLOSED_STATES = new Set<GovernedMissionStateValue>([
  "readmission_required",
  "pending_override",
  "closeout_ready",
  "artifact_verified",
  "terminal_pending_watchdog",
  "released",
]);

export type GovernedMissionTaskFlowRecord = Pick<
  TaskFlowRecord,
  "flowId" | "revision" | "stateJson"
>;

export type GovernedMissionTaskFlowStatePatch = {
  flowId: string;
  expectedFlowRevision: number;
  stateJson: JsonValue;
};

export function createGovernedMissionState(
  input: CreateGovernedMissionStateInput,
): GovernedMissionState {
  return {
    schema: "openclaw.governed_mission_state.v2",
    missionId: input.contract.missionId,
    contractId: input.contract.contractId,
    contractVersion: input.contract.contractVersion,
    contractHash: input.contract.contractHash,
    authorityHash: input.contract.authorityHash,
    authorityRef: input.authorityRef,
    planRevisionId: input.contract.planRevisionId,
    sourceRevision: input.contract.sourceRevision,
    runtimeBuildSha256: input.contract.runtimeBuildSha256,
    policyVersion: input.contract.policyVersion,
    skillSha256: input.contract.skillSha256,
    parentMissionRef: input.parentMissionRef,
    currentGovernedState: "admitted",
    currentStep: input.currentStep,
    ownerCorrelation: input.ownerCorrelation,
    overrideRef: { status: "none" },
    terminalStatus: "not_terminal",
    blockedStatus: "not_blocked",
    proofs: createInitialProofState(input.requiredProofs),
    trustedHostPolicy: input.trustedHostPolicy ?? {
      trustedHost: false,
      openclawAllows: false,
      osAllows: false,
      hostAllows: false,
      reason: "trusted host policy was not established at admission",
    },
    revision: 1,
    stateVersion: `${input.contract.contractVersion}:1`,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function updateGovernedMissionState(
  state: GovernedMissionState,
  update: GovernedMissionStateUpdate,
): GovernedMissionState {
  if (state.revision !== update.expectedRevision) {
    throw new Error("governed mission state revision mismatch");
  }
  const revision = state.revision + 1;
  const identity = update.replacementIdentity;
  const contractVersion = identity?.contractVersion ?? state.contractVersion;
  return {
    ...state,
    ...identity,
    currentStep: update.currentStep ?? state.currentStep,
    currentGovernedState: update.currentGovernedState ?? state.currentGovernedState,
    ownerCorrelation: update.ownerCorrelation ?? state.ownerCorrelation,
    overrideRef: update.overrideRef ?? state.overrideRef,
    terminalStatus: update.terminalStatus ?? state.terminalStatus,
    blockedStatus: update.blockedStatus ?? state.blockedStatus,
    proofs: update.proofs ?? state.proofs,
    activeExecutionLease: update.clearActiveExecutionLease
      ? undefined
      : (update.activeExecutionLease ?? state.activeExecutionLease),
    postTerminalWatchdogBinding: update.clearPostTerminalWatchdogBinding
      ? undefined
      : (update.postTerminalWatchdogBinding ?? state.postTerminalWatchdogBinding),
    revision,
    stateVersion: `${contractVersion}:${revision}`,
    updatedAt: update.now,
  };
}

export function requireGovernedMissionPinnedAuthority(
  state: GovernedMissionState,
  observed: AuthoritySnapshot,
  now: string,
): GovernedMissionReadmissionCheck {
  if (state.contractHash !== observed.contractHash) {
    return {
      ok: false,
      reason: "contract_hash_mismatch",
      state: blockForReadmission(state, "contract_hash_mismatch", observed.authorityRef, now),
    };
  }
  if (state.authorityHash !== observed.authorityHash) {
    return {
      ok: false,
      reason: "stale_authority_hash",
      state: blockForReadmission(state, "stale_authority_hash", observed.authorityRef, now),
    };
  }
  return { ok: true, state };
}

function blockForReadmission(
  state: GovernedMissionState,
  blockedStatus: Exclude<GovernedMissionBlockedStatus, "not_blocked" | "revision_mismatch">,
  readmissionAuthorityRef: GovernedAuthorityRef,
  now: string,
): GovernedMissionState {
  return updateGovernedMissionState(
    {
      ...state,
      readmissionAuthorityRef,
    },
    {
      expectedRevision: state.revision,
      currentGovernedState: "readmission_required",
      blockedStatus,
      currentStep: "lawful_readmission_required",
      now,
    },
  );
}

export function buildGovernedMissionTaskFlowStatePatch(
  record: GovernedMissionTaskFlowRecord,
  state: GovernedMissionState,
): GovernedMissionTaskFlowStatePatch {
  if (state.ownerCorrelation.taskFlowId !== record.flowId) {
    throw new Error("governed mission state must be correlated to the TaskFlow record");
  }
  return {
    flowId: record.flowId,
    expectedFlowRevision: record.revision,
    stateJson: {
      ...jsonObject(record.stateJson),
      [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: state as unknown as JsonValue,
    },
  };
}

export function readGovernedMissionStateFromTaskFlow(
  record: GovernedMissionTaskFlowRecord,
): GovernedMissionState | undefined {
  const stateJson = jsonObject(record.stateJson);
  const value = stateJson[GOVERNED_MISSION_TASKFLOW_STATE_KEY];
  if (isGovernedMissionState(value)) {
    return value;
  }
  return undefined;
}

export function hasGovernedMissionStateValue(record: GovernedMissionTaskFlowRecord): boolean {
  const stateJson = jsonObject(record.stateJson);
  return Object.hasOwn(stateJson, GOVERNED_MISSION_TASKFLOW_STATE_KEY);
}

export function governedMissionStateBlocksChildCreation(stateJson: JsonValue | undefined): boolean {
  const values = jsonObject(stateJson);
  if (!Object.hasOwn(values, GOVERNED_MISSION_TASKFLOW_STATE_KEY)) {
    return false;
  }
  const state = values[GOVERNED_MISSION_TASKFLOW_STATE_KEY];
  // A declared but malformed governed state cannot safely authorize more work.
  return (
    !isGovernedMissionState(state) ||
    GOVERNED_MISSION_CHILD_CREATION_CLOSED_STATES.has(state.currentGovernedState)
  );
}

export function buildGovernedMissionTaskFlowUpdatePatch(
  record: GovernedMissionTaskFlowRecord,
  update: GovernedMissionStateUpdate,
): GovernedMissionTaskFlowStatePatch {
  const state = readGovernedMissionStateFromTaskFlow(record);
  if (!state) {
    throw new Error(`governed mission state not found on TaskFlow record: ${record.flowId}`);
  }
  return buildGovernedMissionTaskFlowStatePatch(record, updateGovernedMissionState(state, update));
}

function jsonObject(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function createInitialProofState(
  required: Partial<Record<keyof GovernedMissionProofState, boolean>> | undefined,
): GovernedMissionProofState {
  const status = (name: keyof GovernedMissionProofState, defaultRequired: boolean) =>
    (required?.[name] ?? defaultRequired) ? "pending" : "not_required";
  return {
    implementation: status("implementation", true),
    validation: status("validation", true),
    review: status("review", true),
    artifacts: status("artifacts", true),
    rollback: status("rollback", false),
    restoration: status("restoration", false),
    postTerminalWatchdog: status("postTerminalWatchdog", true),
    delivery: status("delivery", false),
  };
}

function isGovernedMissionState(value: JsonValue | undefined): value is GovernedMissionState {
  if (!isJsonObject(value)) {
    return false;
  }
  const requiredStrings = [
    "missionId",
    "contractId",
    "contractVersion",
    "contractHash",
    "authorityHash",
    "planRevisionId",
    "sourceRevision",
    "runtimeBuildSha256",
    "policyVersion",
    "skillSha256",
    "currentStep",
    "stateVersion",
    "createdAt",
    "updatedAt",
  ] as const;
  if (
    value.schema !== "openclaw.governed_mission_state.v2" ||
    requiredStrings.some((field) => typeof value[field] !== "string" || !value[field].trim()) ||
    !isStringEnum(value.currentGovernedState, GOVERNED_MISSION_STATE_VALUES) ||
    !isStringEnum(value.terminalStatus, GOVERNED_MISSION_TERMINAL_STATUSES) ||
    !isStringEnum(value.blockedStatus, GOVERNED_MISSION_BLOCKED_STATUSES) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !isAuthorityRef(value.authorityRef) ||
    (value.readmissionAuthorityRef !== undefined &&
      !isAuthorityRef(value.readmissionAuthorityRef)) ||
    (value.parentMissionRef !== undefined && typeof value.parentMissionRef !== "string") ||
    !isOwnerCorrelation(value.ownerCorrelation) ||
    !isOverrideRef(value.overrideRef) ||
    !isProofState(value.proofs) ||
    !isTrustedHostPolicy(value.trustedHostPolicy)
  ) {
    return false;
  }
  const lease = value.activeExecutionLease;
  if (
    lease !== undefined &&
    (!isJsonObject(lease) ||
      typeof lease.runId !== "string" ||
      !lease.runId.trim() ||
      !Number.isSafeInteger(lease.processId) ||
      (lease.processId as number) <= 0 ||
      (lease.processStartTime !== undefined &&
        (!Number.isSafeInteger(lease.processStartTime) ||
          (lease.processStartTime as number) < 0)) ||
      typeof lease.runtimeInstanceId !== "string" ||
      !lease.runtimeInstanceId.trim() ||
      typeof lease.openedAt !== "string" ||
      !lease.openedAt.trim())
  ) {
    return false;
  }
  const binding = value.postTerminalWatchdogBinding;
  return (
    binding === undefined ||
    (isJsonObject(binding) &&
      Number.isSafeInteger(binding.boundRevision) &&
      (binding.boundRevision as number) >= 1 &&
      typeof binding.runtimeBuildSha256 === "string" &&
      Boolean(binding.runtimeBuildSha256.trim()))
  );
}

function isTrustedHostPolicy(value: JsonValue | undefined): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    typeof value.trustedHost === "boolean" &&
    typeof value.openclawAllows === "boolean" &&
    typeof value.osAllows === "boolean" &&
    typeof value.hostAllows === "boolean" &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringEnum(value: JsonValue | undefined, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function isAuthorityRef(value: JsonValue | undefined): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    typeof value.refId === "string" &&
    Boolean(value.refId.trim()) &&
    typeof value.uri === "string" &&
    Boolean(value.uri.trim()) &&
    isStringEnum(value.kind, [
      "sop",
      "build_plan",
      "work_order",
      "operator_approval",
      "policy",
      "source_lock",
      "runtime_lock",
    ]) &&
    (value.sha256 === undefined || typeof value.sha256 === "string")
  );
}

function isOwnerCorrelation(value: JsonValue | undefined): boolean {
  if (!isJsonObject(value) || typeof value.owner !== "string" || !value.owner.trim()) {
    return false;
  }
  return ["sessionKey", "runId", "taskFlowId", "taskRegistryTaskId", "cleanupCrewRunId"].every(
    (field) => value[field] === undefined || typeof value[field] === "string",
  );
}

function isOverrideRef(value: JsonValue | undefined): boolean {
  return (
    isJsonObject(value) &&
    isStringEnum(value.status, GOVERNED_OVERRIDE_STATUSES) &&
    (value.overrideId === undefined || typeof value.overrideId === "string")
  );
}

function isProofState(value: JsonValue | undefined): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return [
    "implementation",
    "validation",
    "review",
    "artifacts",
    "rollback",
    "restoration",
    "postTerminalWatchdog",
    "delivery",
  ].every((field) => isStringEnum(value[field], GOVERNED_MISSION_PROOF_STATUSES));
}
