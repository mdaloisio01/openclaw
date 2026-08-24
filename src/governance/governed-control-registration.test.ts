import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { capturePluginRegistration } from "../plugins/captured-registration.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  GOVERNED_CONTROL_NATIVE_RELAY_EVENTS,
  GOVERNED_CONTROL_REGISTRATION_PROOF,
  GOVERNED_CONTROL_REQUIRED_HOOKS,
  GOVERNED_CONTROL_TEST_SOURCE_LOCK,
  buildGovernedControlRegistrationHealth,
  registerGovernedControlSubsystem,
} from "./governed-control-registration.js";

function createGovernedControlTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

describe("governed control registration", () => {
  it("names the required governed control hooks and native relay events", () => {
    expect(GOVERNED_CONTROL_REQUIRED_HOOKS).toEqual([
      "before_agent_run",
      "before_tool_call",
      "after_tool_call",
      "before_agent_finalize",
    ]);
    expect(GOVERNED_CONTROL_NATIVE_RELAY_EVENTS).toEqual([
      "pre_tool_use",
      "post_tool_use",
      "permission_request",
      "before_agent_finalize",
    ]);
  });

  it("registers minimal host-visible control surfaces without enforcement activation", () => {
    const captured = capturePluginRegistration({
      id: GOVERNED_CONTROL_REGISTRATION_PROOF.pluginId,
      name: "OpenClaw Governed Control",
      register: (api) => {
        expect(
          registerGovernedControlSubsystem(api, {
            targetSourceLock: GOVERNED_CONTROL_TEST_SOURCE_LOCK,
            observedSourceLock: GOVERNED_CONTROL_TEST_SOURCE_LOCK,
          }),
        ).toEqual(GOVERNED_CONTROL_REGISTRATION_PROOF);
      },
    });

    expect(captured.trustedToolPolicies.map((policy) => policy.id)).toEqual([
      "governed-control-observe-only-policy",
    ]);
    expect(captured.runtimeLifecycles.map((lifecycle) => lifecycle.id)).toEqual([
      "governed-control-runtime-lifecycle",
    ]);
    expect(captured.controlUiDescriptors.map((descriptor) => descriptor.id)).toEqual([
      "governed-control-status",
    ]);
    expect(captured.tools).toEqual([]);
    expect(captured.agentHarnesses).toEqual([]);
    expect(captured.codexAppServerExtensionFactories).toEqual([]);
  });

  it("blocks registration before the target source lock is validated", () => {
    const captured = capturePluginRegistration({
      id: GOVERNED_CONTROL_REGISTRATION_PROOF.pluginId,
      name: "OpenClaw Governed Control",
      register: () => undefined,
    });

    expect(() =>
      registerGovernedControlSubsystem(captured.api, {
        targetSourceLock: GOVERNED_CONTROL_TEST_SOURCE_LOCK,
        observedSourceLock: {
          ...GOVERNED_CONTROL_TEST_SOURCE_LOCK,
          authorityHash: "changed-authority",
        },
      }),
    ).toThrow("governed control registration requires matching targetSourceLock");
    expect(captured.trustedToolPolicies).toEqual([]);
    expect(captured.runtimeLifecycles).toEqual([]);
    expect(captured.controlUiDescriptors).toEqual([]);
  });

  it("exposes enforcement-health observable registration inputs", () => {
    expect(buildGovernedControlRegistrationHealth(GOVERNED_CONTROL_REGISTRATION_PROOF)).toEqual({
      schema: "openclaw.governed_control_registration_health.v1",
      pluginId: "openclaw-governed-control",
      sourceLockValidated: true,
      registeredPolicyIds: ["governed-control-observe-only-policy"],
      registeredLifecycleIds: ["governed-control-runtime-lifecycle"],
      registeredControlUiDescriptorIds: ["governed-control-status"],
      requiredHooks: GOVERNED_CONTROL_REQUIRED_HOOKS,
      nativeRelayEvents: GOVERNED_CONTROL_NATIVE_RELAY_EVENTS,
    });
  });

  it("loads through the active plugin registry host path for runtime health observation", () => {
    const pluginRegistry = createGovernedControlTestRegistry();
    const record = createPluginRecord({
      id: GOVERNED_CONTROL_REGISTRATION_PROOF.pluginId,
      name: "OpenClaw Governed Control",
      origin: "bundled",
      source: "/bundled/openclaw-governed-control/index.ts",
      enabled: true,
      status: "loaded",
    });
    pluginRegistry.registry.plugins.push(record);

    const proof = registerGovernedControlSubsystem(
      pluginRegistry.createApi(record, {
        config: {} as OpenClawConfig,
        registrationMode: "full",
      }),
      {
        targetSourceLock: GOVERNED_CONTROL_TEST_SOURCE_LOCK,
        observedSourceLock: GOVERNED_CONTROL_TEST_SOURCE_LOCK,
      },
    );
    setActivePluginRegistry(pluginRegistry.registry);
    const activeRegistry = getActivePluginRegistry();

    expect(activeRegistry?.plugins).toContainEqual(record);
    expect(activeRegistry?.trustedToolPolicies.map((entry) => entry.policy.id)).toContain(
      proof.trustedToolPolicyId,
    );
    expect(activeRegistry?.runtimeLifecycles.map((entry) => entry.lifecycle.id)).toContain(
      proof.lifecycleId,
    );
    expect(activeRegistry?.controlUiDescriptors.map((entry) => entry.descriptor.id)).toContain(
      proof.controlUiDescriptorId,
    );
    expect(buildGovernedControlRegistrationHealth(proof)).toMatchObject({
      sourceLockValidated: true,
      registeredPolicyIds: [proof.trustedToolPolicyId],
      registeredLifecycleIds: [proof.lifecycleId],
      registeredControlUiDescriptorIds: [proof.controlUiDescriptorId],
    });
  });
});
