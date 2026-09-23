import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const TaskLedgerStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
]);

const TimestampSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);

export const TaskSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    kind: Type.Optional(Type.String()),
    runtime: Type.Optional(Type.String()),
    status: TaskLedgerStatusSchema,
    title: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    childSessionKey: Type.Optional(Type.String()),
    ownerKey: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    flowId: Type.Optional(Type.String()),
    parentTaskId: Type.Optional(Type.String()),
    sourceId: Type.Optional(Type.String()),
    createdAt: Type.Optional(TimestampSchema),
    updatedAt: Type.Optional(TimestampSchema),
    startedAt: Type.Optional(TimestampSchema),
    endedAt: Type.Optional(TimestampSchema),
    progressSummary: Type.Optional(Type.String()),
    terminalSummary: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TasksListParamsSchema = Type.Object(
  {
    status: Type.Optional(Type.Union([TaskLedgerStatusSchema, Type.Array(TaskLedgerStatusSchema)])),
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TasksListResultSchema = Type.Object(
  {
    tasks: Type.Array(TaskSummarySchema),
    nextCursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TasksGetParamsSchema = Type.Object(
  {
    taskId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TasksGetResultSchema = Type.Object(
  {
    task: TaskSummarySchema,
  },
  { additionalProperties: false },
);

export const TasksCancelParamsSchema = Type.Object(
  {
    taskId: NonEmptyString,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TasksCancelResultSchema = Type.Object(
  {
    found: Type.Boolean(),
    cancelled: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    task: Type.Optional(TaskSummarySchema),
  },
  { additionalProperties: false },
);

const GovernedOperationSchema = Type.Union([
  Type.Literal("startWorkOrder"),
  Type.Literal("openExecutionLease"),
  Type.Literal("closeExecutionLease"),
  Type.Literal("recordImplementationResult"),
  Type.Literal("recordValidationResult"),
  Type.Literal("recordReviewResult"),
  Type.Literal("requestCloseout"),
  Type.Literal("verifyRequiredArtifacts"),
  Type.Literal("admitTerminalPendingWatchdog"),
  Type.Literal("recordPostTerminalWatchdog"),
  Type.Literal("releaseFinalResult"),
  Type.Literal("recordDeliveryResult"),
  Type.Literal("blockForRepair"),
  Type.Literal("requestReadmission"),
  Type.Literal("cancelMission"),
  Type.Literal("stopMission"),
]);

const GovernedPublicOperationSchema = Type.Union([
  Type.Literal("startWorkOrder"),
  Type.Literal("recordImplementationResult"),
  Type.Literal("recordValidationResult"),
  Type.Literal("recordReviewResult"),
  Type.Literal("requestCloseout"),
  Type.Literal("verifyRequiredArtifacts"),
  Type.Literal("admitTerminalPendingWatchdog"),
  Type.Literal("recordPostTerminalWatchdog"),
  Type.Literal("releaseFinalResult"),
  Type.Literal("recordDeliveryResult"),
  Type.Literal("blockForRepair"),
  Type.Literal("requestReadmission"),
  Type.Literal("cancelMission"),
  Type.Literal("stopMission"),
]);

const GovernedMissionStateSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("admitted"),
  Type.Literal("executing"),
  Type.Literal("implementation_complete"),
  Type.Literal("validation_complete"),
  Type.Literal("review_complete"),
  Type.Literal("closeout_ready"),
  Type.Literal("artifact_verified"),
  Type.Literal("terminal_pending_watchdog"),
  Type.Literal("released"),
  Type.Literal("waiting"),
  Type.Literal("blocked"),
  Type.Literal("pending_override"),
  Type.Literal("readmission_required"),
  Type.Literal("repair_required"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
  Type.Literal("lost"),
  Type.Literal("operator_stopped"),
]);

const GovernedProofStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("not_required"),
]);

const GovernedMissionProjectionSchema = Type.Object(
  {
    schema: Type.Literal("openclaw.governed_mission_state.v2"),
    missionId: NonEmptyString,
    contractId: NonEmptyString,
    contractVersion: NonEmptyString,
    contractHash: NonEmptyString,
    authorityHash: NonEmptyString,
    authorityRef: Type.Object(
      {
        refId: NonEmptyString,
        kind: Type.Union([
          Type.Literal("sop"),
          Type.Literal("build_plan"),
          Type.Literal("work_order"),
          Type.Literal("operator_approval"),
          Type.Literal("policy"),
          Type.Literal("source_lock"),
          Type.Literal("runtime_lock"),
        ]),
        sha256: Type.Union([NonEmptyString, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    planRevisionId: NonEmptyString,
    sourceRevision: NonEmptyString,
    runtimeBuildSha256: NonEmptyString,
    policyVersion: NonEmptyString,
    skillSha256: NonEmptyString,
    currentGovernedState: GovernedMissionStateSchema,
    currentStep: NonEmptyString,
    owner: NonEmptyString,
    taskFlowId: Type.Union([NonEmptyString, Type.Null()]),
    terminalStatus: Type.Union([
      Type.Literal("not_terminal"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("lost"),
    ]),
    blockedStatus: Type.Union([
      Type.Literal("not_blocked"),
      Type.Literal("stale_authority_hash"),
      Type.Literal("contract_hash_mismatch"),
      Type.Literal("plan_revision_mismatch"),
      Type.Literal("source_revision_mismatch"),
      Type.Literal("runtime_build_mismatch"),
      Type.Literal("policy_version_mismatch"),
      Type.Literal("revision_mismatch"),
      Type.Literal("readmission_required"),
      Type.Literal("required_proof_missing"),
      Type.Literal("artifact_verification_failed"),
    ]),
    proofs: Type.Object(
      {
        implementation: GovernedProofStatusSchema,
        validation: GovernedProofStatusSchema,
        review: GovernedProofStatusSchema,
        artifacts: GovernedProofStatusSchema,
        rollback: GovernedProofStatusSchema,
        restoration: GovernedProofStatusSchema,
        postTerminalWatchdog: GovernedProofStatusSchema,
        delivery: GovernedProofStatusSchema,
      },
      { additionalProperties: false },
    ),
    revision: Type.Integer({ minimum: 0 }),
    stateVersion: NonEmptyString,
    createdAt: NonEmptyString,
    updatedAt: NonEmptyString,
  },
  { additionalProperties: false },
);

const GovernedReceiptProjectionSchema = Type.Object(
  {
    receiptId: NonEmptyString,
    operation: NonEmptyString,
    receiptKind: Type.Union([
      Type.Literal("transition"),
      Type.Literal("artifact_verification"),
      Type.Literal("watchdog_observation"),
      Type.Literal("release"),
      Type.Literal("delivery"),
      Type.Literal("false_closeout"),
      Type.Literal("durability_obligation"),
      Type.Literal("legacy_import"),
    ]),
    fromState: Type.Union([Type.String(), Type.Null()]),
    toState: Type.Union([Type.String(), Type.Null()]),
    decision: NonEmptyString,
    reasonCode: NonEmptyString,
    expectedRevision: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    resultingRevision: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    payloadSha256: NonEmptyString,
    producer: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const GovernedTransitionDecisionProjectionSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("applied"),
      Type.Literal("denied"),
      Type.Literal("conflict"),
      Type.Literal("irrelevant"),
      Type.Literal("repair_required"),
    ]),
    operation: GovernedOperationSchema,
    reasonCode: NonEmptyString,
    receiptKind: GovernedReceiptProjectionSchema.properties.receiptKind,
    stateChanged: Type.Boolean(),
    nextAction: Type.String(),
    missingProof: Type.Array(NonEmptyString),
    currentMission: GovernedMissionProjectionSchema,
    proposedMission: GovernedMissionProjectionSchema,
  },
  { additionalProperties: false },
);

export const TasksGovernanceStatusParamsSchema = Type.Object(
  {
    lookup: NonEmptyString,
    receiptLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const TasksGovernanceStatusResultSchema = Type.Object(
  {
    flowId: NonEmptyString,
    flowRevision: Type.Integer({ minimum: 0 }),
    governed: Type.Boolean(),
    malformed: Type.Boolean(),
    canonical: Type.Boolean(),
    mission: Type.Union([GovernedMissionProjectionSchema, Type.Null()]),
    receipts: Type.Array(GovernedReceiptProjectionSchema),
  },
  { additionalProperties: false },
);

export const TasksGovernancePreviewParamsSchema = Type.Object(
  {
    lookup: NonEmptyString,
    operation: GovernedPublicOperationSchema,
    payloadHash: Type.Optional(NonEmptyString),
    reasonCode: Type.Optional(NonEmptyString),
    nextAction: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

const TasksGovernancePreviewSchema = Type.Union([
  Type.Object({ status: Type.Literal("not_found") }, { additionalProperties: false }),
  Type.Object(
    {
      status: Type.Union([Type.Literal("not_governed"), Type.Literal("untrusted_governed_state")]),
      flowId: NonEmptyString,
      flowRevision: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("preview"),
      flowId: NonEmptyString,
      flowRevision: Type.Integer({ minimum: 0 }),
      decision: GovernedTransitionDecisionProjectionSchema,
    },
    { additionalProperties: false },
  ),
]);

export const TasksGovernancePreviewResultSchema = Type.Object(
  { preview: TasksGovernancePreviewSchema },
  { additionalProperties: false },
);

const GovernedProofResultActionFields = {
  proofTaskId: NonEmptyString,
};

const TasksGovernanceApplyActionSchema = Type.Union([
  Type.Object({ operation: Type.Literal("startWorkOrder") }, { additionalProperties: false }),
  Type.Object(
    { operation: Type.Literal("recordImplementationResult"), ...GovernedProofResultActionFields },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("recordValidationResult"), ...GovernedProofResultActionFields },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("recordReviewResult"), ...GovernedProofResultActionFields },
    { additionalProperties: false },
  ),
  Type.Object({ operation: Type.Literal("requestCloseout") }, { additionalProperties: false }),
  Type.Object(
    { operation: Type.Literal("verifyRequiredArtifacts") },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("admitTerminalPendingWatchdog") },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("recordPostTerminalWatchdog") },
    { additionalProperties: false },
  ),
  Type.Object({ operation: Type.Literal("releaseFinalResult") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("recordDeliveryResult"),
      releaseReceiptId: NonEmptyString,
      payloadHash: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("requestReadmission"),
      authorityPath: NonEmptyString,
      governedMission: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("blockForRepair"),
      reasonCode: NonEmptyString,
      nextAction: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("cancelMission"),
      reasonCode: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("stopMission"),
      reasonCode: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
]);

export const TasksGovernanceApplyParamsSchema = Type.Object(
  {
    lookup: NonEmptyString,
    expectedRevision: Type.Integer({ minimum: 0 }),
    idempotencyKey: NonEmptyString,
    action: TasksGovernanceApplyActionSchema,
  },
  { additionalProperties: false },
);

export const TasksGovernanceApplyResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("applied"),
      Type.Literal("already_applied"),
      Type.Literal("denied"),
      Type.Literal("repair_required"),
      Type.Literal("irrelevant"),
      Type.Literal("conflict"),
      Type.Literal("not_found"),
      Type.Literal("not_governed"),
      Type.Literal("untrusted_governed_state"),
    ]),
    flowId: Type.Optional(NonEmptyString),
    flowRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    reasonCode: Type.Optional(NonEmptyString),
    receipt: Type.Optional(GovernedReceiptProjectionSchema),
    decision: Type.Optional(GovernedTransitionDecisionProjectionSchema),
    releasedPayload: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
