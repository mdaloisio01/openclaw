export const GOVERNANCE_PROTECTED_SURFACE_KINDS = [
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
] as const;

export type GovernanceProtectedSurfaceKind = (typeof GOVERNANCE_PROTECTED_SURFACE_KINDS)[number];

export const GOVERNANCE_PROTECTION_LAYERS = [
  "trusted_tool_policy",
  "exec_restriction",
  "sandbox_host_boundary",
  "os_filesystem_control",
] as const;

export type GovernanceProtectionLayer = (typeof GOVERNANCE_PROTECTION_LAYERS)[number];

export const GOVERNANCE_AUTHORIZED_UPDATE_STEPS = [
  "fresh_source_runtime_lock",
  "explicit_change_package",
  "validation",
  "rollback",
  "operator_approval",
  "updated_authority_hash",
  "affected_mission_readmission",
] as const;

export type GovernanceAuthorizedUpdateStep = (typeof GOVERNANCE_AUTHORIZED_UPDATE_STEPS)[number];

export type GovernanceProtectedSurface = {
  id: string;
  kind: GovernanceProtectedSurfaceKind;
  label: string;
  authorityOwner: "openclaw_control_plane" | "operator" | "governed_policy";
  pathPatterns: readonly string[];
  requiredProtectionLayers: readonly GovernanceProtectionLayer[];
};

export type GovernanceAuthorizedUpdatePath = {
  schema: "openclaw.governance_authorized_update_path.v1";
  requiredSteps: readonly GovernanceAuthorizedUpdateStep[];
};

export type GovernanceSelfProtectionBoundary = {
  schema: "openclaw.governance_self_protection_boundary.v1";
  protectedSurfaces: readonly GovernanceProtectedSurface[];
  authorizedUpdatePath: GovernanceAuthorizedUpdatePath;
};

export type GovernanceSelfProtectionGap = {
  code: "missing_surface_kind" | "surface_missing_protection_layer" | "missing_update_step";
  surfaceId?: string;
  item: GovernanceProtectedSurfaceKind | GovernanceProtectionLayer | GovernanceAuthorizedUpdateStep;
};

const ALL_PROTECTION_LAYERS = [...GOVERNANCE_PROTECTION_LAYERS];

export const GOVERNANCE_SELF_PROTECTION_BOUNDARY: GovernanceSelfProtectionBoundary = {
  schema: "openclaw.governance_self_protection_boundary.v1",
  protectedSurfaces: [
    {
      id: "governed-run-control-code",
      kind: "governed_run_control_code",
      label: "Governed-run plugin and control code",
      authorityOwner: "openclaw_control_plane",
      pathPatterns: [
        "src/plugins/**",
        "src/governance/**",
        "src/agents/harness/native-hook-relay.ts",
        "extensions/codex/src/app-server/native-hook-relay.ts",
      ],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
    {
      id: "plugin-activation-configuration",
      kind: "plugin_activation_configuration",
      label: "Plugin activation and configuration",
      authorityOwner: "openclaw_control_plane",
      pathPatterns: [
        "/home/will/.openclaw/openclaw.json",
        "/home/will/.openclaw/workspace/.codex/config.toml",
        "/home/will/.openclaw/acpx/codex-home/config.toml",
      ],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
    {
      id: "trusted-policy-definitions",
      kind: "trusted_policy_definitions",
      label: "Trusted policy definitions",
      authorityOwner: "governed_policy",
      pathPatterns: [
        "src/plugin-sdk/security-runtime.ts",
        "extensions/codex/src/app-server/native-hook-relay.ts",
        "extensions/browser/src/sdk-security-runtime.ts",
      ],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
    {
      id: "machine-contract-authority",
      kind: "machine_contract_authority",
      label: "Machine contract authority",
      authorityOwner: "governed_policy",
      pathPatterns: [
        "src/governance/governed-mission-contract.ts",
        "src/governance/governance-self-protection.ts",
      ],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
    {
      id: "sop-governance-authority-files",
      kind: "sop_governance_authority_files",
      label: "SOP and governance authority files",
      authorityOwner: "operator",
      pathPatterns: [
        "/home/will/.openclaw/workspace-orchestrator/AGENTS.md",
        "/home/will/.openclaw/workspace-orchestrator/SOUL.md",
        "/home/will/.openclaw/workspace-orchestrator/USER.md",
        "/home/will/.openclaw/workspace-orchestrator/MEMORY.md",
        "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/sop_enforcement_*",
      ],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
    {
      id: "release-decision-gate-code",
      kind: "release_decision_gate_code",
      label: "Release decision and gate code",
      authorityOwner: "openclaw_control_plane",
      pathPatterns: ["src/auto-reply/reply/agent-runner.ts", "src/gateway/server-methods/chat.ts"],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
    {
      id: "enforcement-health-state",
      kind: "enforcement_health_state",
      label: "Enforcement-health state",
      authorityOwner: "openclaw_control_plane",
      pathPatterns: [
        "/home/will/.openclaw/state/**",
        "/home/will/.openclaw/tasks/**",
        "/home/will/.openclaw/flows/**",
      ],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
    {
      id: "evidence-authority",
      kind: "evidence_authority",
      label: "Evidence authority",
      authorityOwner: "governed_policy",
      pathPatterns: [
        "src/governance/mission-evidence-store.ts",
        "/home/will/.openclaw/state/**",
        "/home/will/.openclaw/workspace-orchestrator/var/**",
      ],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
    {
      id: "operator-override-authority",
      kind: "operator_override_authority",
      label: "Operator override authority",
      authorityOwner: "operator",
      pathPatterns: [
        "src/governance/governed-mission-contract.ts",
        "/home/will/.openclaw/state/**",
      ],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
    {
      id: "enforcement-feature-gates",
      kind: "enforcement_feature_gates",
      label: "Enable/disable feature gates controlling enforcement",
      authorityOwner: "openclaw_control_plane",
      pathPatterns: [
        "/home/will/.openclaw/openclaw.json",
        "src/config/**",
        "packages/gateway-protocol/src/schema/config.ts",
      ],
      requiredProtectionLayers: ALL_PROTECTION_LAYERS,
    },
  ],
  authorizedUpdatePath: {
    schema: "openclaw.governance_authorized_update_path.v1",
    requiredSteps: [...GOVERNANCE_AUTHORIZED_UPDATE_STEPS],
  },
};

export function findGovernanceSelfProtectionGaps(
  boundary: GovernanceSelfProtectionBoundary,
): GovernanceSelfProtectionGap[] {
  const gaps: GovernanceSelfProtectionGap[] = [];
  const presentSurfaceKinds = new Set(boundary.protectedSurfaces.map((surface) => surface.kind));
  for (const kind of GOVERNANCE_PROTECTED_SURFACE_KINDS) {
    if (!presentSurfaceKinds.has(kind)) {
      gaps.push({ code: "missing_surface_kind", item: kind });
    }
  }

  for (const surface of boundary.protectedSurfaces) {
    const layers = new Set(surface.requiredProtectionLayers);
    for (const layer of GOVERNANCE_PROTECTION_LAYERS) {
      if (!layers.has(layer)) {
        gaps.push({
          code: "surface_missing_protection_layer",
          surfaceId: surface.id,
          item: layer,
        });
      }
    }
  }

  const updateSteps = new Set(boundary.authorizedUpdatePath.requiredSteps);
  for (const step of GOVERNANCE_AUTHORIZED_UPDATE_STEPS) {
    if (!updateSteps.has(step)) {
      gaps.push({ code: "missing_update_step", item: step });
    }
  }
  return gaps;
}

export function isGovernanceUpdatePathAuthorized(
  completedSteps: readonly GovernanceAuthorizedUpdateStep[],
): boolean {
  const completed = new Set(completedSteps);
  return GOVERNANCE_AUTHORIZED_UPDATE_STEPS.every((step) => completed.has(step));
}
