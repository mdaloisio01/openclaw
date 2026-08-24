import { describe, expect, it } from "vitest";
import {
  ENFORCEMENT_HEALTH_CAPABILITIES,
  evaluateEnforcementHealth,
  requiredCapabilitiesForOperation,
  type EnforcementHealthCapability,
  type EnforcementHealthCapabilityRecord,
} from "./enforcement-health.js";

const healthyCapabilities: EnforcementHealthCapabilityRecord[] =
  ENFORCEMENT_HEALTH_CAPABILITIES.map((capability) => ({
    capability,
    state: "known_healthy",
    observedAt: "2026-08-22T04:45:00Z",
  }));

describe("enforcement health foundation", () => {
  it("names every SOP-ENF-07 enforcement health capability", () => {
    expect(ENFORCEMENT_HEALTH_CAPABILITIES).toEqual([
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
    ]);
  });

  it("lets casual chat continue when enforcement health is irrelevant", () => {
    expect(
      evaluateEnforcementHealth({
        operation: "casual_chat",
        capabilities: [],
        now: "2026-08-22T04:45:00Z",
      }),
    ).toEqual({
      schema: "openclaw.enforcement_health_evaluation.v1",
      operation: "casual_chat",
      decision: "IRRELEVANT",
      missingCriticalCapabilities: [],
      failedCapabilities: [],
      reasons: [],
      evaluatedAt: "2026-08-22T04:45:00Z",
    });
  });

  it("evaluates protected mutation capability-by-capability", () => {
    expect(requiredCapabilitiesForOperation("governed_mutation")).toEqual([
      "governed_controller_plugin_loaded",
      "policy_version_known",
      "contract_schema_version_known",
      "durable_mission_state_owner_reachable",
      "central_policy_decision_healthy",
      "critical_action_enforcement_path_healthy",
      "runtime_harness_compatibility_known",
      "critical_hook_registration_relay_healthy",
    ]);
    expect(
      evaluateEnforcementHealth({
        operation: "governed_mutation",
        capabilities: healthyCapabilities,
        now: "2026-08-22T04:45:00Z",
      }),
    ).toMatchObject({
      decision: "HEALTHY",
      missingCriticalCapabilities: [],
      failedCapabilities: [],
    });
  });

  it("blocks governed mutation on missing, unknown, stale, unavailable, or failed critical health", () => {
    const missing = evaluateEnforcementHealth({
      operation: "governed_mutation",
      capabilities: healthyCapabilities.filter(
        (record) => record.capability !== "central_policy_decision_healthy",
      ),
      now: "2026-08-22T04:45:00Z",
    });
    expect(missing).toMatchObject({
      decision: "BLOCKED",
      missingCriticalCapabilities: ["central_policy_decision_healthy"],
      reasons: ["central_policy_decision_healthy:missing"],
    });

    for (const state of ["unknown", "stale", "unavailable", "failed"] as const) {
      expect(
        evaluateEnforcementHealth({
          operation: "governed_mutation",
          capabilities: replaceCapability("critical_action_enforcement_path_healthy", {
            state,
            reason: "probe_not_green",
          }),
          now: "2026-08-22T04:45:00Z",
        }),
      ).toMatchObject({
        decision: "BLOCKED",
        failedCapabilities: [
          {
            capability: "critical_action_enforcement_path_healthy",
            state,
            reason: "probe_not_green",
          },
        ],
      });
    }
  });

  it("requires closeout/release health before governed closeout or final release", () => {
    expect(requiredCapabilitiesForOperation("closeout_attempt")).toContain(
      "closeout_validator_healthy",
    );
    expect(requiredCapabilitiesForOperation("governed_final_release")).toEqual(
      expect.arrayContaining(["closeout_validator_healthy", "release_decision_gate_healthy"]),
    );
    expect(
      evaluateEnforcementHealth({
        operation: "governed_final_release",
        capabilities: healthyCapabilities.filter(
          (record) => record.capability !== "release_decision_gate_healthy",
        ),
        now: "2026-08-22T04:45:00Z",
      }),
    ).toMatchObject({
      decision: "BLOCKED",
      missingCriticalCapabilities: ["release_decision_gate_healthy"],
    });
  });

  it("requires supervisor health for wrapper-required actions", () => {
    expect(requiredCapabilitiesForOperation("wrapper_required_action")).toContain(
      "supervisor_integration_healthy",
    );
  });
});

function replaceCapability(
  capability: EnforcementHealthCapability,
  patch: Partial<EnforcementHealthCapabilityRecord>,
): EnforcementHealthCapabilityRecord[] {
  return healthyCapabilities.map((record) =>
    record.capability === capability ? { ...record, ...patch } : record,
  );
}
