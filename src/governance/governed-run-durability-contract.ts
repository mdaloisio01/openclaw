export const GOVERNED_RUN_DURABILITY_DECISION_STATES = [
  "settled",
  "needs_durable_continuation",
  "needs_delivery_recovery",
  "needs_run_failed_resume",
  "watchdog_needs_review",
  "blocked",
] as const;

export type GovernedRunDurabilityDecisionState =
  (typeof GOVERNED_RUN_DURABILITY_DECISION_STATES)[number];

export type GovernedRunDeliveryObligationStage =
  | "not_required"
  | "owed"
  | "prepared"
  | "delivery_attempted"
  | "delivered"
  | "failed"
  | "needs_review"
  | "settled_by_verified_later_delivery";

export type GovernedRunDurabilityRequiredAction =
  | "record_durable_next_executable_step"
  | "record_lawful_blocker"
  | "record_terminal_completion_proof"
  | "enqueue_delivery_retry"
  | "record_delivery_recovery_handoff"
  | "record_delivery_exhausted_blocker"
  | "record_run_failed_resume_item"
  | "rerun_watchdog_after_repair"
  | "settlement_complete";

export type GovernedRunDurabilityFacts = {
  governedRunActive?: boolean;
  nonTerminalUpdateEmitted?: boolean;
  nextExecutableStepStarted?: boolean;
  durableNextExecutableStepRecorded?: boolean;
  lawfulBlockerRecorded?: boolean;
  terminalCompletionProofRecorded?: boolean;
  finalDeliveryRequired?: boolean;
  deliveryObligationStage?: GovernedRunDeliveryObligationStage;
  deliveryRetryScheduled?: boolean;
  deliveryRecoveryHandoffRecorded?: boolean;
  deliveryExhaustedBlockerRecorded?: boolean;
  runFailed?: boolean;
  runFailedResumeRecorded?: boolean;
  watchdogProofClean?: boolean;
  watchdogNeedsReview?: boolean;
  idempotencyKey?: string;
};

export type GovernedRunDurabilityDecision = {
  schema: "openclaw.governed_run_durability_decision.v1";
  state: GovernedRunDurabilityDecisionState;
  allowedToSettle: boolean;
  watchdogVisible: boolean;
  requiredActions: GovernedRunDurabilityRequiredAction[];
  validationErrors: string[];
  reason: string;
};

function hasDurableContinuationCoverage(facts: GovernedRunDurabilityFacts): boolean {
  return (
    facts.nextExecutableStepStarted === true ||
    facts.durableNextExecutableStepRecorded === true ||
    facts.lawfulBlockerRecorded === true ||
    facts.terminalCompletionProofRecorded === true
  );
}

function hasDeliveryRecoveryCoverage(facts: GovernedRunDurabilityFacts): boolean {
  return (
    facts.deliveryRetryScheduled === true ||
    facts.deliveryRecoveryHandoffRecorded === true ||
    facts.deliveryExhaustedBlockerRecorded === true
  );
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function buildDecision(params: {
  state: GovernedRunDurabilityDecisionState;
  allowedToSettle: boolean;
  watchdogVisible: boolean;
  requiredActions: GovernedRunDurabilityRequiredAction[];
  validationErrors?: string[];
  reason: string;
}): GovernedRunDurabilityDecision {
  return {
    schema: "openclaw.governed_run_durability_decision.v1",
    state: params.state,
    allowedToSettle: params.allowedToSettle,
    watchdogVisible: params.watchdogVisible,
    requiredActions: params.requiredActions,
    validationErrors: params.validationErrors ?? [],
    reason: params.reason,
  };
}

export function resolveGovernedRunDurability(
  facts: GovernedRunDurabilityFacts,
): GovernedRunDurabilityDecision {
  const governedRunActive = facts.governedRunActive !== false;
  const finalDeliveryRequired = facts.finalDeliveryRequired === true;
  const deliveryStage = facts.deliveryObligationStage ?? "not_required";
  const validationErrors: string[] = [];

  if (!hasText(facts.idempotencyKey) && finalDeliveryRequired) {
    validationErrors.push("delivery_idempotency_key_missing");
  }

  if (facts.runFailed === true && facts.runFailedResumeRecorded !== true) {
    return buildDecision({
      state: "needs_run_failed_resume",
      allowedToSettle: false,
      watchdogVisible: true,
      requiredActions: ["record_run_failed_resume_item"],
      validationErrors,
      reason: "governed run failed before durable resume coverage was recorded",
    });
  }

  if (
    governedRunActive &&
    facts.nonTerminalUpdateEmitted === true &&
    !hasDurableContinuationCoverage(facts)
  ) {
    return buildDecision({
      state: "needs_durable_continuation",
      allowedToSettle: false,
      watchdogVisible: true,
      requiredActions: [
        "record_durable_next_executable_step",
        "record_lawful_blocker",
        "record_terminal_completion_proof",
      ],
      validationErrors,
      reason:
        "non-terminal governed update has no durable next executable step, lawful blocker, or terminal proof",
    });
  }

  if (
    finalDeliveryRequired &&
    (deliveryStage === "failed" || deliveryStage === "needs_review") &&
    !hasDeliveryRecoveryCoverage(facts)
  ) {
    return buildDecision({
      state: "needs_delivery_recovery",
      allowedToSettle: false,
      watchdogVisible: true,
      requiredActions: [
        "enqueue_delivery_retry",
        "record_delivery_recovery_handoff",
        "record_delivery_exhausted_blocker",
      ],
      validationErrors,
      reason: "required visible delivery is failed or unknown without retry, handoff, or blocker",
    });
  }

  if (facts.watchdogNeedsReview === true || facts.watchdogProofClean === false) {
    return buildDecision({
      state: "watchdog_needs_review",
      allowedToSettle: false,
      watchdogVisible: true,
      requiredActions: ["rerun_watchdog_after_repair"],
      validationErrors,
      reason: "watchdog proof is not clean for governed run settlement",
    });
  }

  if (validationErrors.length > 0) {
    return buildDecision({
      state: "blocked",
      allowedToSettle: false,
      watchdogVisible: true,
      requiredActions: ["record_delivery_recovery_handoff"],
      validationErrors,
      reason: "governed run durability contract is missing required identity or proof fields",
    });
  }

  return buildDecision({
    state: "settled",
    allowedToSettle: true,
    watchdogVisible: false,
    requiredActions: ["settlement_complete"],
    reason: "governed run durability obligations are settled",
  });
}
