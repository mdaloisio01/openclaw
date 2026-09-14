import { describe, expect, it } from "vitest";
import {
  PROTECTED_ACTION_CLASSES,
  PROTECTED_ACTION_INVENTORY,
  classifyProtectedAction,
  evaluateProtectedAction,
  protectedActionInventoryByClass,
  type GovernedAuthorityForProtectedAction,
  type TrustedHostPolicy,
} from "./protected-action-policy.js";

const now = "2026-08-22T16:58:00Z";

const trustedHostPolicy: TrustedHostPolicy = {
  trustedHost: true,
  openclawAllows: true,
  osAllows: true,
  hostAllows: true,
};

const governedAuthority: GovernedAuthorityForProtectedAction = {
  governedMissionAdmitted: true,
  contractValid: true,
  sourceLockValid: true,
  policyDecision: {
    schema: "openclaw.governed_policy_decision.v1",
    decision: "ALLOW",
    reasonCode: "POLICY_ALLOW",
    policyVersion: "sop-enforcement-policy-v1",
    contractId: "contract-1",
    contractHash: "contract-hash",
    obligations: ["write_policy_decision_receipt"],
    receiptMetadata: {
      missionId: "mission-1",
      actionId: "action-1",
      actorId: "will",
      producedAt: now,
    },
  },
};

describe("protected action and trusted host policy foundation", () => {
  it("maps the protected inventory from explicit authority sources", () => {
    expect(PROTECTED_ACTION_CLASSES).toContain("production_source_mutation");
    expect(PROTECTED_ACTION_CLASSES).toContain("protected_exec_script");
    expect(PROTECTED_ACTION_CLASSES).toContain("child_execution_delegation");
    expect(PROTECTED_ACTION_CLASSES).toContain("external_side_effect");
    expect(PROTECTED_ACTION_INVENTORY).toHaveLength(PROTECTED_ACTION_CLASSES.length);
    for (const actionClass of PROTECTED_ACTION_CLASSES) {
      expect(protectedActionInventoryByClass(actionClass).authoritySources.length).toBeGreaterThan(
        0,
      );
    }
    expect(protectedActionInventoryByClass("protected_exec_script").authoritySources).toEqual([
      "exec_policy",
      "trusted_host_policy",
      "approval_policy",
    ]);
  });

  it("classifies protected actions from trusted policy, exec, surface, and project signals", () => {
    expect(classifyProtectedAction({ targetPath: "src/agents/tool.ts" })).toBe(
      "production_source_mutation",
    );
    expect(classifyProtectedAction({ targetPath: "src/governance/policy.ts" })).toBe(
      "sop_governance_authority_mutation",
    );
    expect(classifyProtectedAction({ targetPath: ".openclaw/openclaw.json" })).toBe(
      "openclaw_config_mutation",
    );
    expect(
      classifyProtectedAction({ toolName: "functions.exec_command", command: "npm test" }),
    ).toBe("protected_exec_script");
    expect(classifyProtectedAction({ command: "python -c 'print(1)'" })).toBe(
      "protected_exec_script",
    );
    expect(
      classifyProtectedAction({ toolName: "functions.exec_command", elevatedMode: true }),
    ).toBe("protected_exec_script");
    expect(classifyProtectedAction({ command: "systemctl restart openclaw" })).toBe(
      "service_restart",
    );
    expect(classifyProtectedAction({ command: "rm -rf dist" })).toBe(
      "destructive_filesystem_action",
    );
    expect(classifyProtectedAction({ childDelegation: true, childRuntime: "subagent" })).toBe(
      "child_execution_delegation",
    );
    expect(classifyProtectedAction({ gatewayMethod: "plugin.approval.resolve" })).toBe(
      "plugin_mutation",
    );
    expect(classifyProtectedAction({ externalSideEffect: true })).toBe("external_side_effect");
    expect(classifyProtectedAction({ projectDefinedHighAuthority: true })).toBe(
      "project_defined_high_authority",
    );
  });

  it("allows ordinary unprotected actions without governed authority", () => {
    expect(
      evaluateProtectedAction({
        actionId: "ordinary-1",
        conversationClassification: "ordinary",
        signals: { targetPath: "README.md" },
        trustedHostPolicy,
        now,
      }),
    ).toEqual({
      schema: "openclaw.protected_action_decision.v1",
      actionId: "ordinary-1",
      protected: false,
      decision: "ALLOW",
      reasonCode: "UNPROTECTED_ACTION",
      obligations: [],
      evaluatedAt: now,
    });
  });

  it("denies protected actions when governed authority is missing regardless of conversation classification", () => {
    expect(
      evaluateProtectedAction({
        actionId: "source-write-1",
        conversationClassification: "ordinary",
        signals: { targetPath: "src/agents/tool.ts" },
        trustedHostPolicy,
        now,
      }),
    ).toMatchObject({
      protected: true,
      actionClass: "production_source_mutation",
      decision: "DENY",
      reasonCode: "MISSING_GOVERNED_AUTHORITY",
      obligations: expect.arrayContaining(["invoke_governed_authority_check"]),
    });
  });

  it("denies protected actions when trusted host policy does not allow execution", () => {
    expect(
      evaluateProtectedAction({
        actionId: "exec-1",
        conversationClassification: "governed",
        signals: { toolName: "exec_command", command: "npm test" },
        governedAuthority,
        trustedHostPolicy: { ...trustedHostPolicy, trustedHost: false, reason: "unknown_host" },
        now,
      }),
    ).toMatchObject({
      protected: true,
      actionClass: "protected_exec_script",
      decision: "DENY",
      reasonCode: "TRUSTED_HOST_POLICY_DENIED",
      obligations: expect.arrayContaining(["repair_or_verify_trusted_host_policy"]),
    });
  });

  it("allows protected actions only when governed authority and trusted host policy pass", () => {
    expect(
      evaluateProtectedAction({
        actionId: "governed-source-write-1",
        conversationClassification: "governed",
        signals: { targetPath: "src/governance/protected-action-policy.ts" },
        governedAuthority,
        trustedHostPolicy,
        now,
      }),
    ).toMatchObject({
      protected: true,
      actionClass: "sop_governance_authority_mutation",
      decision: "ALLOW",
      reasonCode: "PROTECTED_ACTION_ALLOWED",
      obligations: ["write_policy_decision_receipt"],
    });
  });
});
