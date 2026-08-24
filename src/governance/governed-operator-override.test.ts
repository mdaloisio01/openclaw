import { describe, expect, it } from "vitest";
import {
  GOVERNED_OPERATOR_OVERRIDE_ALLOWED_CLASSES,
  GOVERNED_OPERATOR_OVERRIDE_PROHIBITED_CLASSES,
  evaluateGovernedOperatorOverride,
  missingGovernedOperatorOverrideFields,
  type GovernedOperatorOverrideRecord,
} from "./governed-operator-override.js";

const override: GovernedOperatorOverrideRecord = {
  schema: "openclaw.governed_operator_override.v1",
  overrideId: "override-1",
  operatorAuthority: {
    refId: "mark-approval",
    kind: "operator_approval",
    uri: "operator://mark/sop-enf-05",
    sha256: "approval-sha",
  },
  target: {
    missionId: "mission-1",
    actionId: "action-1",
    scopeHash: "scope-sha",
  },
  reason: "Operator approved a bounded mission policy exception.",
  expiresAt: "2026-08-22T05:00:00Z",
  reuse: {
    mode: "one_use",
    useCount: 0,
  },
  receiptRef: "override-receipt-1",
  allowableClasses: ["mission_policy_exception"],
  prohibitedClasses: [...GOVERNED_OPERATOR_OVERRIDE_PROHIBITED_CLASSES],
  revocationStatus: "active",
  cannotExpandBeyondHostAuthority: true,
  createdAt: "2026-08-22T04:22:00Z",
};

const context = {
  missionId: "mission-1",
  actionId: "action-1",
  scopeHash: "scope-sha",
  requestedClass: "mission_policy_exception" as const,
  hostAuthority: {
    openclawAllows: true,
    osAllows: true,
    hostAllows: true,
  },
  now: "2026-08-22T04:30:00Z",
};

describe("governed operator override foundation", () => {
  it("defines allowed and prohibited override classes", () => {
    expect(GOVERNED_OPERATOR_OVERRIDE_ALLOWED_CLASSES).toEqual([
      "mission_policy_exception",
      "tool_action_exception",
      "exec_action_exception",
      "child_delegation_exception",
      "closeout_repair_exception",
    ]);
    expect(GOVERNED_OPERATOR_OVERRIDE_PROHIBITED_CLASSES).toEqual([
      "expand_os_authority",
      "expand_openclaw_host_authority",
      "bypass_sandbox_boundary",
      "bypass_source_or_runtime_lock",
      "bypass_required_closeout",
      "bypass_release_gate",
    ]);
  });

  it("requires every SOP-ENF-05 override record field", () => {
    expect(missingGovernedOperatorOverrideFields(override)).toEqual([]);
    expect(
      missingGovernedOperatorOverrideFields({
        overrideId: "",
        target: { missionId: "", scopeHash: "" },
        allowableClasses: [],
        prohibitedClasses: [],
        cannotExpandBeyondHostAuthority: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        "overrideId",
        "reason",
        "expiresAt",
        "receiptRef",
        "createdAt",
        "operatorAuthority",
        "target.missionId",
        "target.scopeHash",
        "reuse",
        "allowableClasses",
        "prohibitedClasses",
        "revocationStatus",
        "cannotExpandBeyondHostAuthority",
      ]),
    );
  });

  it("accepts a bounded active override without creating a second bypass system", () => {
    expect(evaluateGovernedOperatorOverride(override, context)).toEqual({
      valid: true,
      overrideId: "override-1",
      class: "mission_policy_exception",
      receiptRef: "override-receipt-1",
    });
  });

  it("rejects stale, reused, mismatched, or revoked overrides", () => {
    expect(
      evaluateGovernedOperatorOverride(
        {
          ...override,
          expiresAt: "",
        },
        context,
      ),
    ).toMatchObject({ valid: false, reason: "missing_expiration" });
    expect(
      evaluateGovernedOperatorOverride(
        {
          ...override,
          expiresAt: "never",
        },
        context,
      ),
    ).toMatchObject({ valid: false, reason: "invalid_expiration" });
    expect(
      evaluateGovernedOperatorOverride(
        {
          ...override,
          expiresAt: "9999",
        },
        context,
      ),
    ).toMatchObject({ valid: false, reason: "invalid_expiration" });
    expect(
      evaluateGovernedOperatorOverride(
        {
          ...override,
          expiresAt: "2026-08-22T04:00:00Z",
        },
        context,
      ),
    ).toMatchObject({ valid: false, reason: "expired" });
    expect(
      evaluateGovernedOperatorOverride(
        {
          ...override,
          reuse: { mode: "one_use", useCount: 1 },
        },
        context,
      ),
    ).toMatchObject({ valid: false, reason: "reuse_exhausted" });
    expect(
      evaluateGovernedOperatorOverride(
        {
          ...override,
          target: { ...override.target, actionId: "other-action" },
        },
        context,
      ),
    ).toMatchObject({ valid: false, reason: "target_mismatch" });
    expect(
      evaluateGovernedOperatorOverride(
        {
          ...override,
          revocationStatus: "revoked",
        },
        context,
      ),
    ).toMatchObject({ valid: false, reason: "revoked_or_not_active" });
  });

  it("rejects prohibited classes and host authority expansion", () => {
    expect(
      evaluateGovernedOperatorOverride(override, {
        ...context,
        requestedClass: "bypass_release_gate",
      }),
    ).toMatchObject({ valid: false, reason: "class_prohibited" });
    expect(
      evaluateGovernedOperatorOverride(
        {
          ...override,
          allowableClasses: ["exec_action_exception"],
        },
        {
          ...context,
          requestedClass: "exec_action_exception",
          hostAuthority: {
            openclawAllows: true,
            osAllows: false,
            hostAllows: true,
          },
        },
      ),
    ).toMatchObject({ valid: false, reason: "host_authority_denied" });
  });
});
