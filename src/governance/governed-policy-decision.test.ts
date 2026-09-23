import { describe, expect, it } from "vitest";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import { createGovernedMissionState } from "./governed-mission-state.js";
import type { GovernedOperatorOverrideRecord } from "./governed-operator-override.js";
import { GOVERNED_ACTION_CLASSES, evaluateGovernedAction } from "./governed-policy-decision.js";

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "mission-1",
  contractId: "contract-1",
  contractVersion: "2026-08-22T0436Z",
  contractHash: "contract-hash",
  authorityHash: "authority-hash",
  authorityRefs: [
    {
      refId: "plan",
      kind: "build_plan",
      uri: "/exports/sop_enforcement_master_build_plan_2026-08-21T1905Z.md",
      sha256: "authority-hash",
    },
  ],
  admissionReceiptRef: "admission-1",
  planRevisionId: "plan-revision",
  sourceRevision: "31d50dc436ddada2c38cb02e33a9e68a20216959",
  runtimeBuildSha256: "openclaw-2026.6.2-a87590b",
  policyVersion: "sop-enforcement-v1",
  skillSha256: "skill-sha",
  mode: "shadow",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: "2026-08-22T04:36:00Z",
};

const missionState = createGovernedMissionState({
  contract,
  authorityRef: contract.authorityRefs[0],
  currentStep: "policy_decision",
  ownerCorrelation: { owner: "Cleanup Crew", taskFlowId: "flow-1" },
  now: "2026-08-22T04:36:00Z",
});

const baseContext = {
  policyVersion: "sop-enforcement-policy-v1",
  actor: {
    actorId: "will",
    sessionKey: "agent:orchestrator:main",
    runId: "run-1",
  },
  contract,
  missionState,
  requestedAction: {
    actionId: "tool-1",
    actionClass: "tool_call" as const,
    target: "tool:exec",
  },
  hostAuthority: {
    openclawAllows: true,
    osAllows: true,
    hostAllows: true,
  },
  evidenceState: {
    requiredEvidencePresent: true,
    closeoutPassed: true,
    releaseAllowed: true,
  },
  enforcementHealth: {
    healthy: true,
  },
  now: "2026-08-22T04:36:00Z",
};

const override: GovernedOperatorOverrideRecord = {
  schema: "openclaw.governed_operator_override.v1",
  overrideId: "override-1",
  operatorAuthority: {
    refId: "mark-approval",
    kind: "operator_approval",
    uri: "operator://mark/sop-enf-06",
  },
  target: {
    missionId: "mission-1",
    actionId: "tool-1",
    scopeHash: "authority-hash",
  },
  reason: "Bounded tool exception.",
  expiresAt: "2026-08-22T05:00:00Z",
  reuse: { mode: "one_use", useCount: 0 },
  receiptRef: "override-receipt-1",
  allowableClasses: ["tool_action_exception"],
  prohibitedClasses: [
    "expand_os_authority",
    "expand_openclaw_host_authority",
    "bypass_sandbox_boundary",
    "bypass_source_or_runtime_lock",
    "bypass_required_closeout",
    "bypass_release_gate",
  ],
  revocationStatus: "active",
  cannotExpandBeyondHostAuthority: true,
  createdAt: "2026-08-22T04:36:00Z",
};

describe("governed policy decision foundation", () => {
  it("allows ordinary governed actions and emits receipt metadata", () => {
    expect(GOVERNED_ACTION_CLASSES).toEqual([
      "mission_admission",
      "tool_call",
      "exec_call",
      "child_delegation",
      "closeout",
      "release",
      "watchdog",
      "override",
      "final_output",
    ]);

    expect(evaluateGovernedAction(baseContext)).toEqual({
      schema: "openclaw.governed_policy_decision.v1",
      decision: "ALLOW",
      reasonCode: "POLICY_ALLOW",
      policyVersion: "sop-enforcement-policy-v1",
      contractId: "contract-1",
      contractHash: "contract-hash",
      obligations: ["write_policy_decision_receipt"],
      receiptMetadata: {
        missionId: "mission-1",
        actionId: "tool-1",
        actorId: "will",
        producedAt: "2026-08-22T04:36:00Z",
      },
    });
  });

  it("blocks unhealthy, blocked, missing-evidence, release, and final-output states", () => {
    expect(
      evaluateGovernedAction({
        ...baseContext,
        enforcementHealth: { healthy: false, reason: "registration_missing" },
      }),
    ).toMatchObject({ decision: "BLOCKED", reasonCode: "ENFORCEMENT_HEALTH_UNHEALTHY" });
    expect(
      evaluateGovernedAction({
        ...baseContext,
        missionState: { ...missionState, currentGovernedState: "blocked" },
      }),
    ).toMatchObject({ decision: "BLOCKED", reasonCode: "not_blocked" });
    expect(
      evaluateGovernedAction({
        ...baseContext,
        evidenceState: { ...baseContext.evidenceState, requiredEvidencePresent: false },
      }),
    ).toMatchObject({ decision: "BLOCKED", reasonCode: "REQUIRED_EVIDENCE_MISSING" });
    expect(
      evaluateGovernedAction({
        ...baseContext,
        requestedAction: { ...baseContext.requestedAction, actionClass: "release" },
        evidenceState: { ...baseContext.evidenceState, releaseAllowed: false },
      }),
    ).toMatchObject({ decision: "BLOCKED", reasonCode: "RELEASE_NOT_ALLOWED" });
    expect(
      evaluateGovernedAction({
        ...baseContext,
        requestedAction: { ...baseContext.requestedAction, actionClass: "final_output" },
        evidenceState: { ...baseContext.evidenceState, closeoutPassed: false },
      }),
    ).toMatchObject({ decision: "BLOCKED", reasonCode: "FINAL_OUTPUT_RELEASE_NOT_READY" });
  });

  it.each([
    "pending_override",
    "closeout_ready",
    "artifact_verified",
    "terminal_pending_watchdog",
    "released",
  ] as const)(
    "blocks protected actions while the mission is locked in %s",
    (currentGovernedState) => {
      expect(
        evaluateGovernedAction({
          ...baseContext,
          missionState: { ...missionState, currentGovernedState },
        }),
      ).toMatchObject({
        decision: "BLOCKED",
        reasonCode: "GOVERNED_MISSION_LOCKED",
        obligations: ["complete_current_governed_lock_step"],
      });
    },
  );

  it("denies host authority and child delegation failures", () => {
    expect(
      evaluateGovernedAction({
        ...baseContext,
        hostAuthority: { openclawAllows: true, osAllows: false, hostAllows: true },
      }),
    ).toMatchObject({ decision: "DENY", reasonCode: "HOST_AUTHORITY_DENIED" });
    expect(
      evaluateGovernedAction({
        ...baseContext,
        requestedAction: { ...baseContext.requestedAction, actionClass: "child_delegation" },
      }),
    ).toMatchObject({ decision: "DENY", reasonCode: "CHILD_DELEGATION_DENIED" });
    expect(
      evaluateGovernedAction({
        ...baseContext,
        requestedAction: { ...baseContext.requestedAction, actionClass: "child_delegation" },
        childContext: { delegationAllowed: false },
      }),
    ).toMatchObject({ decision: "DENY", reasonCode: "CHILD_DELEGATION_DENIED" });
  });

  it("requires approval unless a valid operator override exists", () => {
    expect(
      evaluateGovernedAction({
        ...baseContext,
        requestedAction: { ...baseContext.requestedAction, requiresApproval: true },
      }),
    ).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      reasonCode: "OPERATOR_APPROVAL_REQUIRED",
      requiredApproval: "operator",
    });
    expect(
      evaluateGovernedAction({
        ...baseContext,
        requestedAction: { ...baseContext.requestedAction, requiresApproval: true },
        operatorOverride: override,
      }),
    ).toMatchObject({
      decision: "ALLOW",
      reasonCode: "VALID_OPERATOR_OVERRIDE",
      obligations: ["override_receipt:override-receipt-1"],
    });
  });
});
