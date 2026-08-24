import { describe, expect, it } from "vitest";
import { setReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { buildGovernedWebChatFinalReleaseBeforeDeliver } from "../auto-reply/reply/governed-webchat-release-adapter.js";
import type { JsonValue } from "../tasks/task-flow-registry.types.js";
import { evaluateChildExecutionInheritance } from "./child-execution-inheritance.js";
import { reconcileCleanupWatchdogMission } from "./cleanup-watchdog-controller.js";
import {
  ENFORCEMENT_HEALTH_CAPABILITIES,
  evaluateEnforcementHealth,
  type EnforcementHealthCapabilityRecord,
} from "./enforcement-health.js";
import {
  isGovernanceUpdatePathAuthorized,
  type GovernanceAuthorizedUpdateStep,
} from "./governance-self-protection.js";
import {
  validateGovernedCloseoutAndBuildReleaseState,
  type GovernedCloseoutValidationResult,
} from "./governed-closeout-validator.js";
import { buildGovernedControlRegistrationProof } from "./governed-control-registration.js";
import { mayReleaseGovernedFinal } from "./governed-final-release-decision.js";
import {
  decideGovernedFinalizationRepair,
  GOVERNED_FINALIZATION_REPAIR_STATE_KEY,
  type GovernedFinalizationRepairState,
} from "./governed-finalization-repair.js";
import { admitGovernedMission } from "./governed-mission-admission.js";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import {
  GOVERNED_MISSION_TASKFLOW_STATE_KEY,
  createGovernedMissionState,
  updateGovernedMissionState,
  type GovernedMissionState,
  type GovernedMissionTaskFlowRecord,
} from "./governed-mission-state.js";
import { decideGovernedOperatorOverrideWorkflow } from "./governed-operator-override-workflow.js";
import { evaluateGovernedAction } from "./governed-policy-decision.js";
import { evaluateGovernedSupervisorRequirement } from "./governed-supervisor-receipt.js";
import { writeGovernedEvidenceReceipt } from "./mission-evidence-store.js";
import { evaluateMissionSpecificToolEnforcement } from "./mission-specific-tool-enforcement.js";

const now = "2026-08-24T01:41:00Z";

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "sop-enf-20-mission",
  contractId: "sop-enf-20-contract",
  contractVersion: "2026-08-24T01:40:00Z",
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
  createdAt: "2026-08-24T01:40:00Z",
};

const missionState = createGovernedMissionState({
  contract,
  authorityRef: contract.authorityRefs[0],
  currentStep: "adversarial_validation",
  ownerCorrelation: { owner: "Cleanup Crew", taskFlowId: "flow-sop-enf-20" },
  now,
});

const hostAllows = { trustedHost: true, openclawAllows: true, osAllows: true, hostAllows: true };
const hostDenied = { trustedHost: true, openclawAllows: true, osAllows: false, hostAllows: true };

const healthyCapabilities: EnforcementHealthCapabilityRecord[] =
  ENFORCEMENT_HEALTH_CAPABILITIES.map((capability) => ({
    capability,
    state: "known_healthy",
    observedAt: now,
  }));

type AdversarialCase = {
  id: number;
  name: string;
  actual: unknown;
  expected: unknown;
};

describe("SOP-ENF-20 end-to-end adversarial validation", () => {
  it("mechanically denies, blocks, or withholds every required prohibited transition", async () => {
    const release = allowedCloseout();
    const releaseState = release.releaseState;
    const wrongRunReleaseState = closeout({ runId: "wrong-run" }).releaseState;
    const cases: AdversarialCase[] = [
      {
        id: 1,
        name: "Protected action initiated from ordinary/casual conversation",
        actual: protectedTool({ conversationClassification: "ordinary", authority: undefined })
          .reasonCode,
        expected: "MISSING_GOVERNED_AUTHORITY",
      },
      {
        id: 2,
        name: "Missing governed contract",
        actual: admission({ contract: undefined }).reasonCode,
        expected: "MALFORMED_CONTRACT_STATE",
      },
      {
        id: 3,
        name: "Malformed contract",
        actual: admission({ contract: { missionId: contract.missionId } }).reasonCode,
        expected: "MALFORMED_CONTRACT_STATE",
      },
      {
        id: 4,
        name: "Stale contract",
        actual: admission({ contract: { ...contract, sourceRevision: "stale" } }).reasonCode,
        expected: "SOURCE_REVISION_MISMATCH",
      },
      {
        id: 5,
        name: "Contract hash changed after admission",
        actual: protectedTool({ observedContractHash: "changed-contract-hash" }).reasonCode,
        expected: "CONTRACT_HASH_MISMATCH",
      },
      {
        id: 6,
        name: "Authority/SOP changed during active mission",
        actual: protectedTool({ observedAuthorityHash: "changed-authority-hash" }).reasonCode,
        expected: "CONTRACT_AUTHORITY_HASH_MISMATCH",
      },
      {
        id: 7,
        name: "Attempt to edit enforcement plugin",
        actual: authorizedGovernanceUpdate(["fresh_source_runtime_lock"]),
        expected: false,
      },
      {
        id: 8,
        name: "Attempt to edit trusted policy/config",
        actual: authorizedGovernanceUpdate(["fresh_source_runtime_lock", "validation"]),
        expected: false,
      },
      {
        id: 9,
        name: "Attempt to edit release gate",
        actual: authorizedGovernanceUpdate([
          "fresh_source_runtime_lock",
          "explicit_change_package",
        ]),
        expected: false,
      },
      {
        id: 10,
        name: "Attempt to disable enforcement",
        actual: authorizedGovernanceUpdate(["operator_approval"]),
        expected: false,
      },
      {
        id: 11,
        name: "Direct exec bypass",
        actual: protectedTool({
          authority: undefined,
          command: "rm -rf var/state",
          toolName: "exec",
        }).reasonCode,
        expected: "MISSING_GOVERNED_AUTHORITY",
      },
      {
        id: 12,
        name: "Python/bash/node/script interpreter bypass",
        actual: protectedTool({
          command: "python3 repair.py",
          commandInterpreter: true,
          supervisorWrapperRequired: true,
          supervisorWrapperPresent: false,
        }).reasonCode,
        expected: "MISSING_SUPERVISOR_WRAPPER",
      },
      {
        id: 13,
        name: "Child/subagent authority laundering",
        actual: child({ childRank: "protected", parentRank: "governed" }).reasonCode,
        expected: "CHILD_AUTHORITY_EXCEEDS_PARENT",
      },
      {
        id: 14,
        name: "ACP/worker delegation bypass",
        actual: child({ runtime: "acp", childActions: ["exec_call"], parentActions: ["tool_call"] })
          .reasonCode,
        expected: "CHILD_ACTION_CLASS_EXCEEDS_PARENT",
      },
      {
        id: 15,
        name: "Cleanup Crew child bypass",
        actual: protectedTool({ childDelegation: true, childInheritance: undefined }).reasonCode,
        expected: "MISSING_CHILD_INHERITANCE",
      },
      {
        id: 16,
        name: "Parent-child scope widening",
        actual: child({ childActions: ["release"], parentActions: ["tool_call"] }).reasonCode,
        expected: "CHILD_ACTION_CLASS_EXCEEDS_PARENT",
      },
      {
        id: 17,
        name: "Expired override",
        actual: override({ expiresAt: "2026-08-24T01:00:00Z" }).evaluatorReason,
        expected: "expired",
      },
      {
        id: 18,
        name: "Wrong-scope override",
        actual: override({ staleContract: true }).reason,
        expected: "contract_state_mismatch",
      },
      {
        id: 19,
        name: "Override attempts host authority expansion",
        actual: override({
          hostAuthority: { openclawAllows: true, osAllows: false, hostAllows: true },
        }).evaluatorReason,
        expected: "host_authority_denied",
      },
      {
        id: 20,
        name: "Policy decision service unavailable",
        actual: policy({ enforcementHealth: { healthy: false, reason: "policy_unavailable" } })
          .reasonCode,
        expected: "ENFORCEMENT_HEALTH_UNHEALTHY",
      },
      {
        id: 21,
        name: "Plugin loaded but expected hook not firing",
        actual: health("governed_mutation", "critical_hook_registration_relay_healthy", "failed")
          .decision,
        expected: "BLOCKED",
      },
      {
        id: 22,
        name: "Hook timeout",
        actual: health("governed_mutation", "critical_hook_registration_relay_healthy", "stale")
          .reasons[0],
        expected: "critical_hook_registration_relay_healthy:stale:adversarial",
      },
      {
        id: 23,
        name: "Hook exception",
        actual: health("governed_mutation", "critical_action_enforcement_path_healthy", "failed")
          .reasons[0],
        expected: "critical_action_enforcement_path_healthy:failed:adversarial",
      },
      {
        id: 24,
        name: "Task Flow/state store unavailable",
        actual: health("governed_mutation", "durable_mission_state_owner_reachable", "unavailable")
          .decision,
        expected: "BLOCKED",
      },
      {
        id: 25,
        name: "State revision conflict",
        actual: revisionConflict(),
        expected: "governed mission state revision mismatch",
      },
      {
        id: 26,
        name: "Supervisor unavailable",
        actual: supervisor({ wrapperPresent: true, supervisorAvailable: false }).reasonCode,
        expected: "SUPERVISOR_UNAVAILABLE",
      },
      {
        id: 27,
        name: "Supervisor timeout",
        actual: supervisor({
          wrapperPresent: true,
          supervisorAvailable: true,
          receipt: { supervisorState: "timeout", failureState: "TIMED_OUT" },
        }).reasonCode,
        expected: "SUPERVISOR_TIMEOUT",
      },
      {
        id: 28,
        name: "Session loss during long-running action",
        actual: watchdog({ executorCount: 0 }).orderedFindings[0]?.category,
        expected: "active_no_worker",
      },
      {
        id: 29,
        name: "Gateway restart during governed action",
        actual: watchdog({ runtimeHealth: false }).orderedFindings[0]?.category,
        expected: "runtime_recovery_failure",
      },
      {
        id: 30,
        name: "Evidence missing",
        actual: closeout({ presentEvidenceReceiptRefs: [] }).rejectionCodes,
        expected: expect.arrayContaining(["REQUIRED_EVIDENCE_MISSING"]),
      },
      {
        id: 31,
        name: "Evidence stale",
        actual: watchdog({ staleProof: true }).orderedFindings[0]?.category,
        expected: "stale_lease",
      },
      {
        id: 32,
        name: "Evidence from wrong run",
        actual: releaseDecision(wrongRunReleaseState).reason,
        expected: "run_mismatch",
      },
      {
        id: 33,
        name: "Evidence hash mismatch",
        actual: releaseDecision({ ...releaseState, releaseStateHash: "tampered" }).reason,
        expected: "release_state_hash_invalid",
      },
      {
        id: 34,
        name: "False-success closeout",
        actual: closeout({ closeoutPassed: false }).rejectionCodes,
        expected: expect.arrayContaining(["CLOSEOUT_FAILED"]),
      },
      {
        id: 35,
        name: "Continue after FAILED_CONTRACT",
        actual: policy({ missionState: terminalFailedMissionState() }).reasonCode,
        expected: "TERMINAL_MISSION_NOT_EXECUTABLE",
      },
      {
        id: 36,
        name: "Closeout validator unavailable",
        actual: health("closeout_attempt", "closeout_validator_healthy", "unavailable").decision,
        expected: "BLOCKED",
      },
      {
        id: 37,
        name: "Finalization repair failure",
        actual: finalizationRepairExhausted().reason,
        expected: "single_repair_attempt_exhausted",
      },
      {
        id: 38,
        name: "Release decision unavailable",
        actual: health("governed_final_release", "release_decision_gate_healthy", "unavailable")
          .decision,
        expected: "BLOCKED",
      },
      {
        id: 39,
        name: "Release gate exception",
        actual: (
          await webChatWithheld(() => {
            throw new Error("release gate failed");
          })
        ).text,
        expected: "Governed result withheld because compliance state could not be verified.",
      },
      {
        id: 40,
        name: "Release gate timeout",
        actual: (
          await webChatWithheld(
            () =>
              new Promise((resolve) =>
                setTimeout(() => resolve(releaseDecision(releaseState)), 25),
              ),
            1,
          )
        ).text,
        expected: "Governed result withheld because compliance state could not be verified.",
      },
      {
        id: 41,
        name: "Release gate rollback/disable attempt",
        actual: releaseDecision(releaseState, { gateEnabled: false }).reason,
        expected: "gate_disabled",
      },
      {
        id: 42,
        name: "Payload changed after release approval",
        actual: releaseDecision(releaseState, { payloadHash: "changed-payload" }).reason,
        expected: "payload_hash_mismatch",
      },
      {
        id: 43,
        name: "Alternate delivery/output path bypass attempt",
        actual: policy({
          requestedAction: {
            actionId: "alternate-output",
            actionClass: "final_output",
            target: "alternate-delivery",
          },
          evidenceState: {
            requiredEvidencePresent: true,
            closeoutPassed: true,
            releaseAllowed: false,
          },
        }).reasonCode,
        expected: "FINAL_OUTPUT_RELEASE_NOT_READY",
      },
      {
        id: 44,
        name: "Concurrent governed missions",
        actual: protectedTool({ missionState: { ...missionState, missionId: "other-mission" } })
          .reasonCode,
        expected: "MISSION_IDENTITY_MISMATCH",
      },
      {
        id: 45,
        name: "Ordinary non-governed conversation remains usable",
        actual: [
          admission({ classification: "casual" }).decision,
          protectedTool({ signals: {}, conversationClassification: "ordinary" }).decision,
        ],
        expected: ["IRRELEVANT", "ALLOW"],
      },
    ];

    expect(cases.map(({ id }) => id)).toEqual(Array.from({ length: 45 }, (_, idx) => idx + 1));
    for (const testCase of cases) {
      expect(testCase.actual, `${testCase.id}. ${testCase.name}`).toEqual(testCase.expected);
    }
  });

  it("keeps successful control registration and evidence writes on the lawful path", () => {
    expect(() =>
      buildGovernedControlRegistrationProof({
        targetSourceLock: {
          lockId: "lock",
          sourceRevision: "source",
          runtimeBuildSha256: "runtime",
          authorityHash: "authority",
        },
        observedSourceLock: {
          lockId: "other-lock",
          sourceRevision: "source",
          runtimeBuildSha256: "runtime",
          authorityHash: "authority",
        },
      }),
    ).toThrow("governed control registration requires matching targetSourceLock");

    const written = writeGovernedEvidenceReceipt({
      locator: {
        storeRoot: "/tmp/sop-enf-20-evidence",
        missionId: contract.missionId,
        workOrderId: "SOP-ENF-20",
        runId: "run-1",
      },
      receipt: closeout({}).closeoutReceipt,
      writtenAt: now,
    });
    expect(written.exportPointer.receiptKind).toBe("closeout");
  });
});

function admission(
  overrides: Partial<Parameters<typeof admitGovernedMission>[0]> = {},
): ReturnType<typeof admitGovernedMission> {
  return admitGovernedMission({
    hookName: "before_agent_run",
    classification: "governed_required",
    actor: { actorId: "will", runId: "run-1" },
    contract,
    observedAuthority: {
      contractHash: contract.contractHash,
      authorityHash: contract.authorityHash,
      authorityRef: contract.authorityRefs[0],
      planRevisionId: contract.planRevisionId,
      sourceRevision: contract.sourceRevision,
      runtimeBuildSha256: contract.runtimeBuildSha256,
      policyVersion: contract.policyVersion,
    },
    ownerCorrelation: { owner: "Cleanup Crew", taskFlowId: "flow-sop-enf-20" },
    enforcementCapabilities: healthyCapabilities,
    hostAuthority: { openclawAllows: true, osAllows: true, hostAllows: true },
    now,
    ...overrides,
  });
}

function protectedTool(
  overrides: {
    signals?: Parameters<typeof evaluateMissionSpecificToolEnforcement>[0]["signals"];
    conversationClassification?: "ordinary" | "governed" | "ambiguous";
    authority?: Parameters<typeof evaluateMissionSpecificToolEnforcement>[0]["authority"];
    observedContractHash?: string;
    observedAuthorityHash?: string;
    missionState?: GovernedMissionState;
    childInheritance?: Parameters<
      typeof evaluateMissionSpecificToolEnforcement
    >[0]["authority"] extends infer Authority
      ? Authority extends { childInheritance?: infer Child }
        ? Child
        : never
      : never;
    command?: string;
    commandInterpreter?: boolean;
    supervisorWrapperRequired?: boolean;
    supervisorWrapperPresent?: boolean;
    childDelegation?: boolean;
    toolName?: string;
  } = {},
): ReturnType<typeof evaluateMissionSpecificToolEnforcement> {
  const signals = overrides.signals ?? {
    toolName: overrides.toolName ?? "exec",
    command: overrides.command ?? "apply_patch src/governance/file.ts",
    commandInterpreter: overrides.commandInterpreter,
    supervisorWrapperRequired: overrides.supervisorWrapperRequired,
    supervisorWrapperPresent: overrides.supervisorWrapperPresent,
    childDelegation: overrides.childDelegation,
    targetPath: "src/governance/file.ts",
  };
  const authorityProvided = Object.prototype.hasOwnProperty.call(overrides, "authority");
  return evaluateMissionSpecificToolEnforcement({
    actionId: "protected-action",
    actor: { actorId: "will", runId: "run-1" },
    toolName: signals.toolName ?? "exec",
    target: signals.targetPath ?? "src/governance/file.ts",
    signals,
    conversationClassification: overrides.conversationClassification ?? "governed",
    trustedHostPolicy: hostAllows,
    authority: authorityProvided
      ? overrides.authority
      : overrides.conversationClassification === "ordinary"
        ? undefined
        : {
            governedMissionAdmitted: true,
            contract,
            missionState: overrides.missionState ?? missionState,
            expectedCurrentStep: "adversarial_validation",
            observedContractHash: overrides.observedContractHash ?? contract.contractHash,
            observedAuthorityHash: overrides.observedAuthorityHash ?? contract.authorityHash,
            requiredEvidencePresent: true,
            childInheritance: overrides.childInheritance,
            supervisorAvailable: true,
            enforcementHealth: { healthy: true },
          },
    now,
  });
}

function policy(
  overrides: Partial<Parameters<typeof evaluateGovernedAction>[0]> = {},
): ReturnType<typeof evaluateGovernedAction> {
  return evaluateGovernedAction({
    policyVersion: contract.policyVersion,
    actor: { actorId: "will", runId: "run-1" },
    contract,
    missionState,
    requestedAction: { actionId: "action-1", actionClass: "tool_call", target: "tool:exec" },
    hostAuthority: { openclawAllows: true, osAllows: true, hostAllows: true },
    evidenceState: { requiredEvidencePresent: true, closeoutPassed: true, releaseAllowed: true },
    enforcementHealth: { healthy: true },
    now,
    ...overrides,
  });
}

function authorizedGovernanceUpdate(completedSteps: GovernanceAuthorizedUpdateStep[]): boolean {
  return isGovernanceUpdatePathAuthorized(completedSteps);
}

function child(overrides: {
  runtime?: "subagent" | "acp";
  parentRank?: "none" | "read_only" | "governed" | "protected";
  childRank?: "none" | "read_only" | "governed" | "protected";
  parentActions?: Array<"tool_call" | "exec_call" | "release">;
  childActions?: Array<"tool_call" | "exec_call" | "release">;
}): ReturnType<typeof evaluateChildExecutionInheritance> {
  return evaluateChildExecutionInheritance({
    actionId: "child-1",
    parent: {
      missionId: contract.missionId,
      contractId: contract.contractId,
      contractHash: contract.contractHash,
      authorityHash: contract.authorityHash,
      policy: {
        authorityRank: overrides.parentRank ?? "governed",
        allowedActionClasses: overrides.parentActions ?? ["tool_call"],
      },
    },
    child: {
      runtime: overrides.runtime ?? "subagent",
      policy: {
        authorityRank: overrides.childRank ?? "governed",
        allowedActionClasses: overrides.childActions ?? ["tool_call"],
      },
    },
    now,
  });
}

function override(
  overrides: {
    expiresAt?: string;
    staleContract?: boolean;
    hostAuthority?: { openclawAllows: boolean; osAllows: boolean; hostAllows: boolean };
  } = {},
): ReturnType<typeof decideGovernedOperatorOverrideWorkflow> {
  return decideGovernedOperatorOverrideWorkflow({
    record: taskFlowRecord(missionState),
    contract: overrides.staleContract
      ? { ...contract, authorityHash: "other-authority" }
      : contract,
    overrideId: "override-1",
    operatorAuthority: {
      refId: "mark-approval",
      kind: "operator_approval",
      uri: "operator://mark/sop-enf-20",
    },
    decisionStatus: "approved",
    approverRef: "operator://mark/sop-enf-20",
    actionId: "action-1",
    requestedClass: "tool_action_exception",
    reason: "Bounded adversarial override.",
    expiresAt: overrides.expiresAt ?? "2026-08-24T02:00:00Z",
    reuse: { mode: "one_use", useCount: 0 },
    hostAuthority: overrides.hostAuthority ?? {
      openclawAllows: true,
      osAllows: true,
      hostAllows: true,
    },
    now,
    producer: "sop-enf-20-test",
  });
}

function health(
  operation: Parameters<typeof evaluateEnforcementHealth>[0]["operation"],
  failedCapability: EnforcementHealthCapabilityRecord["capability"],
  state: EnforcementHealthCapabilityRecord["state"],
): ReturnType<typeof evaluateEnforcementHealth> {
  return evaluateEnforcementHealth({
    operation,
    capabilities: healthyCapabilities.map((record) =>
      record.capability === failedCapability ? { ...record, state, reason: "adversarial" } : record,
    ),
    now,
  });
}

function revisionConflict(): string {
  try {
    updateGovernedMissionState(missionState, {
      expectedRevision: missionState.revision + 1,
      currentStep: "bad_revision",
      now,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
}

function supervisor(
  overrides: Partial<Parameters<typeof evaluateGovernedSupervisorRequirement>[0]>,
): ReturnType<typeof evaluateGovernedSupervisorRequirement> {
  return evaluateGovernedSupervisorRequirement({
    wrapperRequired: true,
    wrapperPresent: true,
    supervisorAvailable: true,
    ...overrides,
  });
}

function watchdog(overrides: {
  executorCount?: number;
  runtimeHealth?: boolean;
  staleProof?: boolean;
}): ReturnType<typeof reconcileCleanupWatchdogMission> {
  const executorCount = overrides.executorCount ?? 1;
  return reconcileCleanupWatchdogMission({
    mode: "enforce",
    suspiciousCount: 0,
    observedPolicyVersion: "cleanup-watchdog-policy-v1",
    cleanDimensions: {
      record_integrity: true,
      worker_coverage: executorCount === 1,
      continuation_readiness: true,
      delivery_completeness: true,
      runtime_health: overrides.runtimeHealth ?? true,
      repair_closure: true,
      policy_version: true,
    },
    missionCoverage: {
      missionId: contract.missionId,
      unfinished: true,
      activeProduction: true,
      executorCount,
      executorLeaseCurrent: executorCount === 1,
    },
    governedMissionState: overrides.staleProof
      ? { state: "GOVERNED_MISSION_PENDING_OVERRIDE", proofCurrent: false }
      : undefined,
    findings:
      overrides.runtimeHealth === false
        ? [
            {
              findingId: "runtime-restart",
              category: "runtime_recovery_failure",
              entityType: "gateway",
              entityId: "gateway",
              evidence: ["gateway_restart_during_governed_action"],
              reason: "gateway restart interrupted governed action",
            },
          ]
        : undefined,
  });
}

function closeout(
  overrides: Partial<Parameters<typeof validateGovernedCloseoutAndBuildReleaseState>[0]>,
): GovernedCloseoutValidationResult {
  return validateGovernedCloseoutAndBuildReleaseState({
    contract,
    runId: "run-1",
    observedContractHash: contract.contractHash,
    observedAuthorityHash: contract.authorityHash,
    requestedCompletionOwner: "governed_mission_state",
    requiredEvidenceReceiptRefs: ["evidence-1"],
    presentEvidenceReceiptRefs: ["evidence-1"],
    closeoutPassed: true,
    noBlockingState: true,
    payloadHash: "payload-1",
    producedAt: now,
    decisionSequence: 1,
    producer: "sop-enf-20-test",
    ...overrides,
  });
}

function allowedCloseout(): GovernedCloseoutValidationResult {
  return closeout({});
}

function releaseDecision(
  releaseState: Parameters<typeof mayReleaseGovernedFinal>[0]["releaseState"],
  overrides: Partial<Parameters<typeof mayReleaseGovernedFinal>[0]> = {},
): ReturnType<typeof mayReleaseGovernedFinal> {
  return mayReleaseGovernedFinal({
    missionId: contract.missionId,
    runId: "run-1",
    contractId: contract.contractId,
    contractHash: contract.contractHash,
    payloadHash: "payload-1",
    releaseState,
    ...overrides,
  });
}

async function webChatWithheld(
  decisionProvider: Parameters<
    typeof buildGovernedWebChatFinalReleaseBeforeDeliver
  >[0]["decisionProvider"],
  timeoutMs = 1000,
): Promise<ReplyPayload> {
  const beforeDeliver = buildGovernedWebChatFinalReleaseBeforeDeliver({
    channel: "webchat",
    decisionProvider,
    timeoutMs,
  });
  if (!beforeDeliver) {
    throw new Error("expected WebChat beforeDeliver hook");
  }
  const payload: ReplyPayload = {
    text: "governed final",
  };
  setReplyPayloadMetadata(payload, {
    governedFinalRelease: {
      missionId: contract.missionId,
      runId: "run-1",
      contractId: contract.contractId,
      contractHash: contract.contractHash,
      payloadHash: "payload-1",
    },
  });
  return (await beforeDeliver(payload, { kind: "final" })) ?? { text: "null" };
}

function terminalFailedMissionState(): GovernedMissionState {
  return updateGovernedMissionState(missionState, {
    expectedRevision: missionState.revision,
    currentGovernedState: "GOVERNED_MISSION_TERMINAL",
    terminalStatus: "failed",
    currentStep: "failed_contract",
    now,
  });
}

function finalizationRepairExhausted(): ReturnType<typeof decideGovernedFinalizationRepair> {
  const failedCloseout = closeout({ closeoutPassed: false });
  const repairState: GovernedFinalizationRepairState = {
    schema: "openclaw.governed_finalization_repair_state.v1",
    missionId: contract.missionId,
    runId: "run-1",
    contractId: contract.contractId,
    contractHash: contract.contractHash,
    repairPermitted: true,
    attemptCount: 1,
    maxAttempts: 1,
    updatedAt: now,
  };
  return decideGovernedFinalizationRepair({
    record: taskFlowRecord(missionState, {
      [GOVERNED_FINALIZATION_REPAIR_STATE_KEY]: repairState as unknown as JsonValue,
    }),
    runId: "run-1",
    closeoutValidation: failedCloseout,
    repairPermitted: true,
    repairInstruction: "repair once",
    now,
  });
}

function taskFlowRecord(
  state: GovernedMissionState,
  extraState: { [key: string]: JsonValue } = {},
): GovernedMissionTaskFlowRecord {
  return {
    flowId: "flow-sop-enf-20",
    revision: 1,
    stateJson: {
      [GOVERNED_MISSION_TASKFLOW_STATE_KEY]: state as unknown as JsonValue,
      ...extraState,
    },
  };
}
