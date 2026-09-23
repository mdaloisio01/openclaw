import { describe, expect, it } from "vitest";
import { ENFORCEMENT_HEALTH_CAPABILITIES } from "./enforcement-health.js";
import {
  admitGovernedMission,
  type GovernedMissionAdmissionInput,
} from "./governed-mission-admission.js";
import {
  GOVERNED_RUNTIME_RECEIPT_KINDS,
  type GovernedAuthorityRef,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import { createGovernedMissionState } from "./governed-mission-state.js";

const now = "2026-08-22T04:55:00Z";

const authorityRef: GovernedAuthorityRef = {
  refId: "sop-enf-08-plan",
  kind: "work_order",
  uri: "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/sop_enforcement_master_build_plan_2026-08-21T1905Z.md#SOP-ENF-08",
  sha256: "authority-hash",
};

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "mission-sop-enf-08",
  contractId: "contract-sop-enf-08",
  contractVersion: "v1",
  contractHash: "contract-hash",
  authorityHash: "authority-hash",
  authorityRefs: [authorityRef],
  admissionReceiptRef: "admission:mission-sop-enf-08",
  planRevisionId: "plan-revision-1",
  sourceRevision: "source-revision-1",
  runtimeBuildSha256: "runtime-build-sha",
  policyVersion: "policy-v1",
  skillSha256: "skill-sha",
  mode: "enforce",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_RUNTIME_RECEIPT_KINDS],
  createdAt: "2026-08-22T04:50:00Z",
};

const baseInput: GovernedMissionAdmissionInput = {
  hookName: "before_agent_run",
  classification: "governed_required",
  actor: {
    actorId: "will-controller",
    sessionKey: "session-key",
    runId: "run-id",
  },
  contract,
  observedAuthority: {
    contractHash: contract.contractHash,
    authorityHash: contract.authorityHash,
    authorityRef,
    planRevisionId: contract.planRevisionId,
    sourceRevision: contract.sourceRevision,
    runtimeBuildSha256: contract.runtimeBuildSha256,
    policyVersion: contract.policyVersion,
    skillSha256: contract.skillSha256,
  },
  ownerCorrelation: {
    owner: "Cleanup Crew",
    sessionKey: "session-key",
    runId: "run-id",
    taskFlowId: "task-flow-id",
    cleanupCrewRunId: "cleanup-run-id",
  },
  enforcementCapabilities: ENFORCEMENT_HEALTH_CAPABILITIES.map((capability) => ({
    capability,
    state: "known_healthy",
    observedAt: now,
  })),
  hostAuthority: {
    openclawAllows: true,
    osAllows: true,
    hostAllows: true,
  },
  now,
};

describe("governed mission admission foundation", () => {
  it("creates a pinned mission state and admission receipt for valid governed admission", () => {
    const result = admitGovernedMission(baseInput);

    expect(result).toMatchObject({
      schema: "openclaw.governed_mission_admission.v1",
      hookName: "before_agent_run",
      decision: "ADMIT",
      reasonCode: "CREATED_PINNED_MISSION_STATE",
      missionId: contract.missionId,
      contractHash: contract.contractHash,
      authorityHash: contract.authorityHash,
      obligations: ["write_admission_receipt", "persist_governed_mission_state"],
    });
    expect(result.missionState).toMatchObject({
      schema: "openclaw.governed_mission_state.v2",
      missionId: contract.missionId,
      contractId: contract.contractId,
      contractHash: contract.contractHash,
      authorityHash: contract.authorityHash,
      currentStep: "before_agent_run_admission",
      currentGovernedState: "admitted",
    });
    expect(result.policyDecision).toMatchObject({
      decision: "ALLOW",
      reasonCode: "POLICY_ALLOW",
    });
    expect(result.admissionReceipt).toMatchObject({
      schema: "openclaw.governed_admission_receipt.v1",
      receiptKind: "admission",
      admitted: true,
      reason: "admitted",
    });
  });

  it("treats casual chat as irrelevant to governed mission admission", () => {
    expect(
      admitGovernedMission({
        ...baseInput,
        classification: "casual",
        contract: undefined,
        observedAuthority: undefined,
      }),
    ).toEqual({
      schema: "openclaw.governed_mission_admission.v1",
      hookName: "before_agent_run",
      decision: "IRRELEVANT",
      reasonCode: "GOVERNED_ADMISSION_NOT_REQUIRED",
      obligations: [],
    });
  });

  it("fails closed on ambiguous governed production or SOP work", () => {
    expect(
      admitGovernedMission({
        ...baseInput,
        classification: "ambiguous_governed_required",
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "AMBIGUOUS_GOVERNED_MISSION",
      obligations: ["operator_scope_lock_required"],
    });
  });

  it("fails closed on missing or malformed contract state", () => {
    expect(
      admitGovernedMission({
        ...baseInput,
        contract: {
          ...contract,
          contractHash: "",
          authorityRefs: [],
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "MALFORMED_CONTRACT_STATE",
      obligations: expect.arrayContaining(["missing:contractHash", "missing:authorityRefs"]),
    });
  });

  it("fails closed without throwing on malformed contract discriminants and references", () => {
    expect(
      admitGovernedMission({
        ...baseInput,
        contract: {
          ...contract,
          schema: "openclaw.governed_mission_contract.v2",
          mode: "observe",
          authorityRefs: [null],
        } as unknown as GovernedMissionContract,
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "MALFORMED_CONTRACT_STATE",
      obligations: expect.arrayContaining([
        "missing:schema.unsupported",
        "missing:mode.unsupported",
        "missing:authorityRefs.0.invalid",
      ]),
    });
  });

  it("fails closed when observed authority no longer matches the contract snapshot", () => {
    expect(
      admitGovernedMission({
        ...baseInput,
        observedAuthority: {
          ...baseInput.observedAuthority!,
          sourceRevision: "new-source-revision",
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "SOURCE_REVISION_MISMATCH",
      obligations: ["lawful_readmission_required"],
    });
  });

  it("rejects an authority reference that is not pinned by the contract", () => {
    expect(
      admitGovernedMission({
        ...baseInput,
        observedAuthority: {
          ...baseInput.observedAuthority!,
          authorityRef: {
            ...authorityRef,
            refId: "unrelated-authority",
            uri: "/safe/unrelated-authority.json",
          },
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "AUTHORITY_REFERENCE_MISMATCH",
      obligations: ["lawful_readmission_required"],
    });
  });

  it("binds existing pinned mission state without silently changing active rules", () => {
    const existingState = createGovernedMissionState({
      contract,
      authorityRef,
      currentStep: "already_admitted",
      ownerCorrelation: baseInput.ownerCorrelation,
      now,
    });

    expect(
      admitGovernedMission({
        ...baseInput,
        existingState,
      }),
    ).toMatchObject({
      decision: "ADMIT",
      reasonCode: "BOUND_PINNED_MISSION_STATE",
      missionState: {
        currentStep: "already_admitted",
        revision: 1,
      },
    });

    expect(
      admitGovernedMission({
        ...baseInput,
        existingState,
        observedAuthority: {
          ...baseInput.observedAuthority!,
          contractHash: "new-contract-hash",
        },
        contract: {
          ...contract,
          contractHash: "new-contract-hash",
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "contract_hash_mismatch",
      missionState: {
        currentGovernedState: "readmission_required",
        blockedStatus: "contract_hash_mismatch",
        currentStep: "lawful_readmission_required",
      },
    });

    expect(
      admitGovernedMission({
        ...baseInput,
        existingState: {
          ...existingState,
          missionId: "different-mission",
          contractId: "different-contract",
          contractVersion: "different-version",
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "mission_identity_mismatch",
      missionState: {
        currentGovernedState: "readmission_required",
        blockedStatus: "readmission_required",
        currentStep: "lawful_readmission_required",
      },
      obligations: ["lawful_readmission_required"],
      admissionReceipt: {
        admitted: false,
        reason: "mission_identity_mismatch",
      },
    });
  });

  it("fails closed when enforcement health is not proven healthy", () => {
    expect(
      admitGovernedMission({
        ...baseInput,
        enforcementCapabilities: baseInput.enforcementCapabilities.filter(
          (record) => record.capability !== "central_policy_decision_healthy",
        ),
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "ENFORCEMENT_HEALTH_BLOCKED",
      obligations: ["central_policy_decision_healthy:missing"],
      admissionReceipt: {
        admitted: false,
        reason: "ENFORCEMENT_HEALTH_BLOCKED",
      },
    });
  });

  it("fails closed when central policy denies admission", () => {
    expect(
      admitGovernedMission({
        ...baseInput,
        hostAuthority: {
          openclawAllows: true,
          osAllows: true,
          hostAllows: false,
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "POLICY_HOST_AUTHORITY_DENIED",
      policyDecision: {
        decision: "DENY",
        reasonCode: "HOST_AUTHORITY_DENIED",
      },
      admissionReceipt: {
        admitted: false,
        reason: "HOST_AUTHORITY_DENIED",
      },
    });
  });
});
