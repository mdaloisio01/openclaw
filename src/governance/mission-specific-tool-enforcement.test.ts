import { describe, expect, it } from "vitest";
import type { ProcessSession } from "../agents/bash-process-registry.js";
import type { RunRecord } from "../process/supervisor/types.js";
import { evaluateChildExecutionInheritance } from "./child-execution-inheritance.js";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import { createGovernedMissionState } from "./governed-mission-state.js";
import {
  buildGovernedSupervisorReceipt,
  type GovernedSupervisorIdentity,
} from "./governed-supervisor-receipt.js";
import {
  evaluateMissionSpecificToolEnforcement,
  type MissionSpecificToolEnforcementAuthority,
} from "./mission-specific-tool-enforcement.js";
import type { TrustedHostPolicy } from "./protected-action-policy.js";

const now = "2026-08-23T02:41:00Z";

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "mission-1",
  contractId: "contract-1",
  contractVersion: "2026-08-23T0241Z",
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
  mode: "shadow",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: now,
};

const missionState = createGovernedMissionState({
  contract,
  authorityRef: contract.authorityRefs[0],
  currentStep: "SOP-ENF-10",
  ownerCorrelation: { owner: "Cleanup Crew", taskFlowId: "flow-1" },
  now,
});

const trustedHostPolicy: TrustedHostPolicy = {
  trustedHost: true,
  openclawAllows: true,
  osAllows: true,
  hostAllows: true,
};

const authority: MissionSpecificToolEnforcementAuthority = {
  governedMissionAdmitted: true,
  contract,
  missionState,
  expectedCurrentStep: "SOP-ENF-10",
  observedContractHash: "contract-hash",
  observedAuthorityHash: "authority-hash",
  requiredEvidencePresent: true,
  enforcementHealth: { healthy: true },
};

const childInheritance = evaluateChildExecutionInheritance({
  actionId: "child-spawn-1",
  parent: {
    missionId: contract.missionId,
    contractId: contract.contractId,
    contractHash: contract.contractHash,
    authorityHash: contract.authorityHash,
    sessionKey: "agent:orchestrator:main",
    runId: "parent-run",
    taskFlowId: "flow-1",
    taskId: "task-1",
    policy: {
      authorityRank: "governed",
      allowedActionClasses: ["tool_call", "exec_call", "child_delegation"],
    },
  },
  child: {
    runtime: "subagent",
    sessionKey: "agent:grant:subagent:child",
    runId: "child-run",
    taskFlowId: "flow-1",
    taskId: "task-2",
    policy: {
      authorityRank: "read_only",
      allowedActionClasses: ["tool_call"],
    },
  },
  now,
});

const supervisorIdentity: GovernedSupervisorIdentity = {
  missionId: contract.missionId,
  contractId: contract.contractId,
  contractVersion: contract.contractVersion,
  contractHash: contract.contractHash,
  authorityHash: contract.authorityHash,
  policyVersion: contract.policyVersion,
};

const supervisorSession: ProcessSession = {
  id: "supervisor-session-1",
  command: "bash scripts/repair.sh",
  startedAt: 100,
  cwd: "/repo",
  maxOutputChars: 10_000,
  totalOutputChars: 2,
  pendingStdout: [],
  pendingStderr: [],
  pendingStdoutChars: 0,
  pendingStderrChars: 0,
  aggregated: "ok",
  tail: "ok",
  exited: false,
  truncated: false,
  backgrounded: true,
  cursorKeyMode: "normal",
  pid: 4242,
};

function supervisorRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "supervisor-run-1",
    sessionId: "supervisor-session-1",
    backendId: "exec",
    pid: 4242,
    processGroupId: 4242,
    state: "running",
    startedAtMs: 100,
    lastOutputAtMs: 100,
    createdAtMs: 100,
    updatedAtMs: 100,
    ...overrides,
  };
}

const supervisorReceipt = buildGovernedSupervisorReceipt({
  identity: supervisorIdentity,
  producer: "exec-supervisor",
  session: supervisorSession,
  runRecord: supervisorRunRecord(),
  producedAt: now,
});

const baseInput = {
  actionId: "tool-1",
  actor: {
    actorId: "will",
    sessionKey: "agent:orchestrator:main",
    runId: "run-1",
  },
  toolName: "functions.apply_patch",
  target: "tool:functions.apply_patch",
  signals: {
    toolName: "functions.apply_patch",
    targetPath: "src/governance/mission-specific-tool-enforcement.ts",
  },
  conversationClassification: "ordinary" as const,
  trustedHostPolicy,
  now,
};

describe("mission-specific tool enforcement", () => {
  it("allows ordinary unprotected tool calls without governed authority", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        toolName: "read",
        target: "tool:read",
        signals: { targetPath: "README.md" },
      }),
    ).toMatchObject({
      protected: false,
      decision: "ALLOW",
      reasonCode: "UNPROTECTED_ACTION",
      obligations: [],
    });
  });

  it("denies protected tools without governed authority regardless of conversation classification", () => {
    expect(evaluateMissionSpecificToolEnforcement(baseInput)).toMatchObject({
      protected: true,
      decision: "DENY",
      reasonCode: "MISSING_GOVERNED_AUTHORITY",
      obligations: expect.arrayContaining(["invoke_governed_authority_check"]),
    });
  });

  it("denies stale contract and authority mismatches before central allow", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority: {
          ...authority,
          missionState: { ...authority.missionState, missionId: "other-mission" },
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "MISSION_IDENTITY_MISMATCH",
      obligations: ["lawful_readmission_required"],
    });

    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority: {
          ...authority,
          missionState: { ...authority.missionState, contractId: "other-contract" },
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "CONTRACT_IDENTITY_MISMATCH",
      obligations: ["lawful_readmission_required"],
    });

    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority: {
          ...authority,
          missionState: { ...authority.missionState, contractHash: "other-contract-hash" },
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "CONTRACT_STATE_HASH_MISMATCH",
      obligations: ["lawful_readmission_required"],
    });

    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority: { ...authority, observedContractHash: "stale-contract" },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "CONTRACT_HASH_MISMATCH",
      obligations: ["lawful_readmission_required"],
    });

    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority: {
          ...authority,
          contract: { ...authority.contract, authorityHash: "other-authority-hash" },
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "CONTRACT_AUTHORITY_HASH_MISMATCH",
      obligations: ["lawful_readmission_required"],
    });

    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority: {
          ...authority,
          missionState: { ...authority.missionState, authorityHash: "stale-authority" },
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "STALE_AUTHORITY_HASH",
      obligations: ["lawful_readmission_required"],
    });
  });

  it("denies current-step mismatch", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority: { ...authority, expectedCurrentStep: "SOP-ENF-11" },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "CURRENT_STEP_MISMATCH",
      obligations: ["refresh_governed_mission_step"],
    });
  });

  it("preserves host policy maximum authority", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        trustedHostPolicy: { ...trustedHostPolicy, hostAllows: false, reason: "host_denied" },
        authority,
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "POLICY_DENY",
      obligations: ["do_not_execute"],
      policyDecision: expect.objectContaining({
        decision: "DENY",
        reasonCode: "HOST_AUTHORITY_DENIED",
      }),
    });
  });

  it("surfaces central approval requirements", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority: { ...authority, requiresApproval: true },
      }),
    ).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      reasonCode: "POLICY_REQUIRES_APPROVAL",
      obligations: ["obtain_operator_approval"],
      policyDecision: expect.objectContaining({
        decision: "REQUIRE_APPROVAL",
        reasonCode: "OPERATOR_APPROVAL_REQUIRED",
      }),
    });
  });

  it("blocks protected exec when supervisor wrapper is explicitly required but absent", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        toolName: "functions.exec_command",
        target: "tool:functions.exec_command",
        signals: {
          toolName: "functions.exec_command",
          command: "bash scripts/repair.sh",
          supervisorWrapperRequired: true,
        },
        authority,
      }),
    ).toMatchObject({
      protected: true,
      decision: "BLOCKED",
      reasonCode: "MISSING_SUPERVISOR_WRAPPER",
      obligations: ["route_exec_through_supervisor_wrapper", "write_violation_receipt"],
    });
  });

  it("allows protected exec with valid authority when the required supervisor wrapper is present", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        toolName: "functions.exec_command",
        target: "tool:functions.exec_command",
        signals: {
          toolName: "functions.exec_command",
          command: "bash scripts/repair.sh",
          supervisorWrapperRequired: true,
          supervisorWrapperPresent: true,
        },
        authority: { ...authority, supervisorReceipt },
      }),
    ).toMatchObject({
      protected: true,
      decision: "ALLOW",
      reasonCode: "PROTECTED_TOOL_ALLOWED",
      policyDecision: expect.objectContaining({
        decision: "ALLOW",
        reasonCode: "POLICY_ALLOW",
      }),
    });
  });

  it("blocks protected exec when the supervisor wrapper is present but receipt proof is missing", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        toolName: "functions.exec_command",
        target: "tool:functions.exec_command",
        signals: {
          toolName: "functions.exec_command",
          command: "bash scripts/repair.sh",
          supervisorWrapperRequired: true,
          supervisorWrapperPresent: true,
        },
        authority,
      }),
    ).toMatchObject({
      protected: true,
      decision: "BLOCKED",
      reasonCode: "MISSING_SUPERVISOR_RECEIPT",
      obligations: ["write_supervisor_receipt", "write_violation_receipt"],
    });
  });

  it("blocks protected exec when the supervisor receipt proves timeout", () => {
    const timeoutReceipt = buildGovernedSupervisorReceipt({
      identity: supervisorIdentity,
      producer: "exec-supervisor",
      session: supervisorSession,
      runRecord: supervisorRunRecord({
        state: "exited",
        terminationReason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGTERM",
      }),
      exit: {
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGTERM",
        durationMs: 30_000,
        stdout: "",
        stderr: "timeout",
        timedOut: true,
        noOutputTimedOut: false,
      },
      producedAt: now,
    });

    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        toolName: "functions.exec_command",
        target: "tool:functions.exec_command",
        signals: {
          toolName: "functions.exec_command",
          command: "bash scripts/repair.sh",
          supervisorWrapperRequired: true,
          supervisorWrapperPresent: true,
        },
        authority: { ...authority, supervisorReceipt: timeoutReceipt },
      }),
    ).toMatchObject({
      protected: true,
      decision: "BLOCKED",
      reasonCode: "SUPERVISOR_TIMEOUT",
      obligations: [
        "record_supervisor_timeout",
        "write_supervisor_receipt",
        "write_violation_receipt",
      ],
    });
  });

  it("blocks child delegation without an inheritance receipt", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        toolName: "sessions_spawn",
        target: "tool:sessions_spawn",
        signals: {
          toolName: "sessions_spawn",
          childDelegation: true,
          childRuntime: "subagent",
        },
        authority,
      }),
    ).toMatchObject({
      protected: true,
      decision: "BLOCKED",
      reasonCode: "MISSING_CHILD_INHERITANCE",
      obligations: [
        "deny_child_delegation",
        "require_child_inheritance_receipt",
        "write_violation_receipt",
      ],
    });
  });

  it("allows child delegation only with valid equal-or-narrower inheritance", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        toolName: "sessions_spawn",
        target: "tool:sessions_spawn",
        signals: {
          toolName: "sessions_spawn",
          childDelegation: true,
          childRuntime: "subagent",
        },
        authority: { ...authority, childInheritance },
      }),
    ).toMatchObject({
      protected: true,
      decision: "ALLOW",
      reasonCode: "PROTECTED_TOOL_ALLOWED",
      obligations: expect.arrayContaining([
        "write_policy_decision_receipt",
        "write_tool_call_receipt",
      ]),
      policyDecision: expect.objectContaining({
        decision: "ALLOW",
        reasonCode: "POLICY_ALLOW",
      }),
    });
  });

  it("allows protected tools only with valid authority and emits decision obligations", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority,
      }),
    ).toMatchObject({
      protected: true,
      decision: "ALLOW",
      reasonCode: "PROTECTED_TOOL_ALLOWED",
      obligations: expect.arrayContaining([
        "write_policy_decision_receipt",
        "write_tool_call_receipt",
      ]),
      protectedActionDecision: expect.objectContaining({
        decision: "ALLOW",
        reasonCode: "PROTECTED_ACTION_ALLOWED",
      }),
      policyDecision: expect.objectContaining({
        decision: "ALLOW",
        reasonCode: "POLICY_ALLOW",
      }),
    });
  });

  it("blocks when central policy cannot verify required evidence", () => {
    expect(
      evaluateMissionSpecificToolEnforcement({
        ...baseInput,
        authority: { ...authority, requiredEvidencePresent: false },
      }),
    ).toMatchObject({
      decision: "BLOCKED",
      reasonCode: "POLICY_BLOCKED",
      obligations: ["collect_required_evidence"],
      policyDecision: expect.objectContaining({
        decision: "BLOCKED",
        reasonCode: "REQUIRED_EVIDENCE_MISSING",
      }),
    });
  });
});
