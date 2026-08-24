import type { OpenClawPluginApi } from "../plugins/types.js";

export const GOVERNED_CONTROL_PLUGIN_ID = "openclaw-governed-control";

export const GOVERNED_CONTROL_REQUIRED_HOOKS = [
  "before_agent_run",
  "before_tool_call",
  "after_tool_call",
  "before_agent_finalize",
] as const;

export type GovernedControlRequiredHook = (typeof GOVERNED_CONTROL_REQUIRED_HOOKS)[number];

export const GOVERNED_CONTROL_NATIVE_RELAY_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

export type GovernedControlNativeRelayEvent = (typeof GOVERNED_CONTROL_NATIVE_RELAY_EVENTS)[number];

export type GovernedControlRegistrationProof = {
  schema: "openclaw.governed_control_registration_proof.v1";
  pluginId: typeof GOVERNED_CONTROL_PLUGIN_ID;
  requiredHooks: readonly GovernedControlRequiredHook[];
  nativeRelayEvents: readonly GovernedControlNativeRelayEvent[];
  trustedToolPolicyId: string;
  lifecycleId: string;
  controlUiDescriptorId: string;
  targetSourceLockId: string;
  observedSourceLockId: string;
  sourceLockValidated: true;
  enforcementHealthObservable: true;
};

export type GovernedControlSourceLock = {
  lockId: string;
  sourceRevision: string;
  runtimeBuildSha256: string;
  authorityHash: string;
};

export type GovernedControlRegistrationInput = {
  targetSourceLock: GovernedControlSourceLock;
  observedSourceLock: GovernedControlSourceLock;
};

export type GovernedControlRegistrationHealth = {
  schema: "openclaw.governed_control_registration_health.v1";
  pluginId: typeof GOVERNED_CONTROL_PLUGIN_ID;
  sourceLockValidated: boolean;
  registeredPolicyIds: readonly string[];
  registeredLifecycleIds: readonly string[];
  registeredControlUiDescriptorIds: readonly string[];
  requiredHooks: readonly GovernedControlRequiredHook[];
  nativeRelayEvents: readonly GovernedControlNativeRelayEvent[];
};

export const GOVERNED_CONTROL_REGISTRATION_IDS = {
  trustedToolPolicyId: "governed-control-observe-only-policy",
  lifecycleId: "governed-control-runtime-lifecycle",
  controlUiDescriptorId: "governed-control-status",
} as const;

export function sourceLocksMatch(
  targetSourceLock: GovernedControlSourceLock,
  observedSourceLock: GovernedControlSourceLock,
): boolean {
  return (
    targetSourceLock.lockId === observedSourceLock.lockId &&
    targetSourceLock.sourceRevision === observedSourceLock.sourceRevision &&
    targetSourceLock.runtimeBuildSha256 === observedSourceLock.runtimeBuildSha256 &&
    targetSourceLock.authorityHash === observedSourceLock.authorityHash
  );
}

export function buildGovernedControlRegistrationProof(
  input: GovernedControlRegistrationInput,
): GovernedControlRegistrationProof {
  if (!sourceLocksMatch(input.targetSourceLock, input.observedSourceLock)) {
    throw new Error("governed control registration requires matching targetSourceLock");
  }
  return {
    schema: "openclaw.governed_control_registration_proof.v1",
    pluginId: GOVERNED_CONTROL_PLUGIN_ID,
    requiredHooks: GOVERNED_CONTROL_REQUIRED_HOOKS,
    nativeRelayEvents: GOVERNED_CONTROL_NATIVE_RELAY_EVENTS,
    ...GOVERNED_CONTROL_REGISTRATION_IDS,
    targetSourceLockId: input.targetSourceLock.lockId,
    observedSourceLockId: input.observedSourceLock.lockId,
    sourceLockValidated: true,
    enforcementHealthObservable: true,
  };
}

export function buildGovernedControlRegistrationHealth(
  proof: GovernedControlRegistrationProof,
): GovernedControlRegistrationHealth {
  return {
    schema: "openclaw.governed_control_registration_health.v1",
    pluginId: proof.pluginId,
    sourceLockValidated: proof.sourceLockValidated,
    registeredPolicyIds: [proof.trustedToolPolicyId],
    registeredLifecycleIds: [proof.lifecycleId],
    registeredControlUiDescriptorIds: [proof.controlUiDescriptorId],
    requiredHooks: proof.requiredHooks,
    nativeRelayEvents: proof.nativeRelayEvents,
  };
}

export const GOVERNED_CONTROL_TEST_SOURCE_LOCK: GovernedControlSourceLock = {
  lockId: "sop-enf-00-amended-live-authority-source-lock-2026-08-21T2214Z",
  sourceRevision: "31d50dc436ddada2c38cb02e33a9e68a20216959",
  runtimeBuildSha256: "openclaw-2026.6.2-a87590b",
  authorityHash: "sop-enforcement-master-build-plan-2026-08-21T1905Z",
};

export const GOVERNED_CONTROL_REGISTRATION_PROOF = buildGovernedControlRegistrationProof({
  targetSourceLock: GOVERNED_CONTROL_TEST_SOURCE_LOCK,
  observedSourceLock: GOVERNED_CONTROL_TEST_SOURCE_LOCK,
});

export function registerGovernedControlSubsystem(
  api: OpenClawPluginApi,
  input: GovernedControlRegistrationInput,
): GovernedControlRegistrationProof {
  const proof = buildGovernedControlRegistrationProof(input);
  api.registerTrustedToolPolicy({
    id: proof.trustedToolPolicyId,
    description: "Observe-only placeholder for governed-control policy registration proof.",
    evaluate: () => undefined,
  });
  api.registerRuntimeLifecycle({
    id: proof.lifecycleId,
    description: "Governed-control lifecycle registration proof.",
  });
  api.registerControlUiDescriptor({
    id: proof.controlUiDescriptorId,
    surface: "settings",
    label: "Governed control",
    description: "Governed-control registration status.",
  });
  return proof;
}
