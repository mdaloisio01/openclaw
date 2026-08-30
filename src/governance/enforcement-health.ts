export const ENFORCEMENT_HEALTH_CAPABILITIES = [
  "governed_controller_plugin_loaded",
  "policy_version_known",
  "contract_schema_version_known",
  "durable_mission_state_owner_reachable",
  "central_policy_decision_healthy",
  "critical_action_enforcement_path_healthy",
  "supervisor_integration_healthy",
  "closeout_validator_healthy",
  "release_decision_gate_healthy",
  "runtime_harness_compatibility_known",
  "critical_hook_registration_relay_healthy",
] as const;

export type EnforcementHealthCapability = (typeof ENFORCEMENT_HEALTH_CAPABILITIES)[number];

export const ENFORCEMENT_HEALTH_STATES = [
  "known_healthy",
  "unknown",
  "stale",
  "unavailable",
  "failed",
] as const;

export type EnforcementHealthState = (typeof ENFORCEMENT_HEALTH_STATES)[number];

export type EnforcementHealthCapabilityRecord = {
  capability: EnforcementHealthCapability;
  state: EnforcementHealthState;
  reason?: string;
  observedAt?: string;
};

export type EnforcementHealthOperation =
  | "casual_chat"
  | "governed_mutation"
  | "wrapper_required_action"
  | "closeout_attempt"
  | "governed_final_release";

export type EnforcementHealthInput = {
  operation: EnforcementHealthOperation;
  capabilities: readonly EnforcementHealthCapabilityRecord[];
  now: string;
};

export type EnforcementHealthEvaluation = {
  schema: "openclaw.enforcement_health_evaluation.v1";
  operation: EnforcementHealthOperation;
  decision: "IRRELEVANT" | "HEALTHY" | "BLOCKED";
  missingCriticalCapabilities: EnforcementHealthCapability[];
  failedCapabilities: EnforcementHealthCapabilityRecord[];
  reasons: string[];
  evaluatedAt: string;
};

const PROTECTED_MUTATION_REQUIRED: EnforcementHealthCapability[] = [
  "governed_controller_plugin_loaded",
  "policy_version_known",
  "contract_schema_version_known",
  "durable_mission_state_owner_reachable",
  "central_policy_decision_healthy",
  "critical_action_enforcement_path_healthy",
  "runtime_harness_compatibility_known",
  "critical_hook_registration_relay_healthy",
];

const WRAPPER_REQUIRED_EXTRA: EnforcementHealthCapability[] = ["supervisor_integration_healthy"];

const CLOSEOUT_EXTRA: EnforcementHealthCapability[] = ["closeout_validator_healthy"];

const FINAL_RELEASE_EXTRA: EnforcementHealthCapability[] = [
  "closeout_validator_healthy",
  "release_decision_gate_healthy",
];

export function evaluateEnforcementHealth(
  input: EnforcementHealthInput,
): EnforcementHealthEvaluation {
  const required = requiredCapabilitiesForOperation(input.operation);
  if (required.length === 0) {
    return {
      schema: "openclaw.enforcement_health_evaluation.v1",
      operation: input.operation,
      decision: "IRRELEVANT",
      missingCriticalCapabilities: [],
      failedCapabilities: [],
      reasons: [],
      evaluatedAt: input.now,
    };
  }

  const byCapability = new Map(
    input.capabilities.map((record) => [record.capability, record] as const),
  );
  const missingCriticalCapabilities: EnforcementHealthCapability[] = [];
  const failedCapabilities: EnforcementHealthCapabilityRecord[] = [];
  for (const capability of required) {
    const record = byCapability.get(capability);
    if (!record) {
      missingCriticalCapabilities.push(capability);
      continue;
    }
    if (record.state !== "known_healthy") {
      failedCapabilities.push(record);
    }
  }

  const blocked = missingCriticalCapabilities.length > 0 || failedCapabilities.length > 0;
  return {
    schema: "openclaw.enforcement_health_evaluation.v1",
    operation: input.operation,
    decision: blocked ? "BLOCKED" : "HEALTHY",
    missingCriticalCapabilities,
    failedCapabilities,
    reasons: [
      ...missingCriticalCapabilities.map((capability) => `${capability}:missing`),
      ...failedCapabilities.map(
        (record) =>
          `${record.capability}:${record.state}${record.reason ? `:${record.reason}` : ""}`,
      ),
    ],
    evaluatedAt: input.now,
  };
}

export function requiredCapabilitiesForOperation(
  operation: EnforcementHealthOperation,
): EnforcementHealthCapability[] {
  switch (operation) {
    case "casual_chat":
      return [];
    case "governed_mutation":
      return [...PROTECTED_MUTATION_REQUIRED];
    case "wrapper_required_action":
      return [...PROTECTED_MUTATION_REQUIRED, ...WRAPPER_REQUIRED_EXTRA];
    case "closeout_attempt":
      return [...PROTECTED_MUTATION_REQUIRED, ...CLOSEOUT_EXTRA];
    case "governed_final_release":
      return [...PROTECTED_MUTATION_REQUIRED, ...FINAL_RELEASE_EXTRA];
  }
  return [];
}
