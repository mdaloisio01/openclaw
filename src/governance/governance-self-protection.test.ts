import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_AUTHORIZED_UPDATE_STEPS,
  GOVERNANCE_PROTECTED_SURFACE_KINDS,
  GOVERNANCE_PROTECTION_LAYERS,
  GOVERNANCE_SELF_PROTECTION_BOUNDARY,
  findGovernanceSelfProtectionGaps,
  isGovernanceUpdatePathAuthorized,
  type GovernanceSelfProtectionBoundary,
} from "./governance-self-protection.js";

describe("governance self-protection boundary", () => {
  it("names every protected governance surface required by SOP-ENF-02", () => {
    expect(GOVERNANCE_PROTECTED_SURFACE_KINDS).toEqual([
      "governed_run_control_code",
      "plugin_activation_configuration",
      "trusted_policy_definitions",
      "machine_contract_authority",
      "sop_governance_authority_files",
      "release_decision_gate_code",
      "enforcement_health_state",
      "evidence_authority",
      "operator_override_authority",
      "enforcement_feature_gates",
    ]);

    expect(findGovernanceSelfProtectionGaps(GOVERNANCE_SELF_PROTECTION_BOUNDARY)).toEqual([]);
  });

  it("requires OpenClaw, exec, sandbox/host, and OS/filesystem protection for each surface", () => {
    for (const surface of GOVERNANCE_SELF_PROTECTION_BOUNDARY.protectedSurfaces) {
      expect(surface.requiredProtectionLayers).toEqual(GOVERNANCE_PROTECTION_LAYERS);
      expect(surface.pathPatterns.length).toBeGreaterThan(0);
      expect(surface.authorityOwner).toMatch(/^(openclaw_control_plane|operator|governed_policy)$/);
    }
  });

  it("defines the explicit operator-controlled governance update path", () => {
    expect(GOVERNANCE_SELF_PROTECTION_BOUNDARY.authorizedUpdatePath.requiredSteps).toEqual([
      "fresh_source_runtime_lock",
      "explicit_change_package",
      "validation",
      "rollback",
      "operator_approval",
      "updated_authority_hash",
      "affected_mission_readmission",
    ]);
    expect(isGovernanceUpdatePathAuthorized(GOVERNANCE_AUTHORIZED_UPDATE_STEPS)).toBe(true);
    expect(isGovernanceUpdatePathAuthorized(["fresh_source_runtime_lock"])).toBe(false);
  });

  it("reports missing protected surfaces, protection layers, and update steps", () => {
    const incomplete: GovernanceSelfProtectionBoundary = {
      schema: "openclaw.governance_self_protection_boundary.v1",
      protectedSurfaces: [
        {
          id: "governed-run-control-code",
          kind: "governed_run_control_code",
          label: "Governed-run plugin and control code",
          authorityOwner: "openclaw_control_plane",
          pathPatterns: ["src/plugins/**"],
          requiredProtectionLayers: ["trusted_tool_policy"],
        },
      ],
      authorizedUpdatePath: {
        schema: "openclaw.governance_authorized_update_path.v1",
        requiredSteps: ["fresh_source_runtime_lock"],
      },
    };

    expect(findGovernanceSelfProtectionGaps(incomplete)).toEqual(
      expect.arrayContaining([
        { code: "missing_surface_kind", item: "plugin_activation_configuration" },
        {
          code: "surface_missing_protection_layer",
          surfaceId: "governed-run-control-code",
          item: "exec_restriction",
        },
        { code: "missing_update_step", item: "operator_approval" },
      ]),
    );
  });
});
