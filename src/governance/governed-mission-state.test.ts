import { describe, expect, it } from "vitest";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import {
  GOVERNED_MISSION_STATE_VALUES,
  buildGovernedMissionTaskFlowStatePatch,
  buildGovernedMissionTaskFlowUpdatePatch,
  createGovernedMissionState,
  governedMissionStateBlocksChildCreation,
  readGovernedMissionStateFromTaskFlow,
  requireGovernedMissionPinnedAuthority,
} from "./governed-mission-state.js";

const authorityRef = {
  refId: "sop-enforcement-plan",
  kind: "build_plan" as const,
  uri: "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/sop_enforcement_master_build_plan_2026-08-21T1905Z.md",
  sha256: "authority-sha",
};

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "sop-enf-04",
  contractId: "sop-enf-contract",
  contractVersion: "2026-08-22T0407Z",
  contractHash: "contract-hash",
  authorityHash: "authority-hash",
  authorityRefs: [authorityRef],
  admissionReceiptRef: "admission-receipt",
  planRevisionId: "sop-enforcement-master-build-plan-2026-08-21T1905Z",
  sourceRevision: "31d50dc436ddada2c38cb02e33a9e68a20216959",
  runtimeBuildSha256: "openclaw-2026.6.2-a87590b",
  policyVersion: "sop-enforcement-v1",
  skillSha256: "skill-sha",
  mode: "shadow",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: "2026-08-22T04:07:00Z",
};

describe("governed mission state foundation", () => {
  it("includes governed waiting states required by Cleanup Crew and watchdog reconciliation", () => {
    expect(GOVERNED_MISSION_STATE_VALUES).toEqual(
      expect.arrayContaining(["pending_override", "closeout_ready"]),
    );
  });

  it("closes child creation while pinned authority requires readmission", () => {
    const state = createGovernedMissionState({
      contract,
      authorityRef,
      currentStep: "lawful_readmission_required",
      ownerCorrelation: { owner: "Cleanup Crew" },
      now: "2026-08-22T04:07:00Z",
    });

    expect(
      governedMissionStateBlocksChildCreation({
        governedMissionState: {
          ...state,
          currentGovernedState: "readmission_required",
          blockedStatus: "stale_authority_hash",
        },
      }),
    ).toBe(true);
  });

  it("creates the minimum authoritative state for later policy decisions", () => {
    const state = createGovernedMissionState({
      contract,
      authorityRef,
      parentMissionRef: "sop-enforcement-build",
      currentStep: "minimum_durable_state",
      ownerCorrelation: {
        owner: "Cleanup Crew",
        sessionKey: "agent:orchestrator:main",
        runId: "run-1",
        taskFlowId: "flow-1",
        taskRegistryTaskId: "task-1",
        cleanupCrewRunId: "cleanup-crew-1",
      },
      now: "2026-08-22T04:07:00Z",
    });

    expect(state).toMatchObject({
      schema: "openclaw.governed_mission_state.v2",
      missionId: "sop-enf-04",
      contractId: "sop-enf-contract",
      contractVersion: "2026-08-22T0407Z",
      contractHash: "contract-hash",
      authorityHash: "authority-hash",
      authorityRef,
      parentMissionRef: "sop-enforcement-build",
      currentGovernedState: "admitted",
      currentStep: "minimum_durable_state",
      overrideRef: { status: "none" },
      terminalStatus: "not_terminal",
      blockedStatus: "not_blocked",
      revision: 1,
      stateVersion: "2026-08-22T0407Z:1",
    });
    expect(state.ownerCorrelation).toEqual({
      owner: "Cleanup Crew",
      sessionKey: "agent:orchestrator:main",
      runId: "run-1",
      taskFlowId: "flow-1",
      taskRegistryTaskId: "task-1",
      cleanupCrewRunId: "cleanup-crew-1",
    });
  });

  it("creates, reads, and revision-checks state through existing TaskFlow stateJson", () => {
    const state = createGovernedMissionState({
      contract,
      authorityRef,
      currentStep: "minimum_durable_state",
      ownerCorrelation: {
        owner: "Cleanup Crew",
        sessionKey: "agent:orchestrator:main",
        runId: "run-1",
        taskFlowId: "flow-1",
        taskRegistryTaskId: "task-1",
        cleanupCrewRunId: "cleanup-crew-1",
      },
      now: "2026-08-22T04:07:00Z",
    });

    const patch = buildGovernedMissionTaskFlowStatePatch(
      {
        flowId: "flow-1",
        revision: 9,
        stateJson: { existing: "kept" },
      },
      state,
    );

    expect(patch).toMatchObject({
      flowId: "flow-1",
      expectedFlowRevision: 9,
      stateJson: {
        existing: "kept",
        governedMissionState: {
          missionId: "sop-enf-04",
          revision: 1,
        },
      },
    });
    expect(
      readGovernedMissionStateFromTaskFlow({
        flowId: "flow-1",
        revision: 10,
        stateJson: patch.stateJson,
      }),
    ).toMatchObject({ missionId: "sop-enf-04", revision: 1 });

    const updatePatch = buildGovernedMissionTaskFlowUpdatePatch(
      {
        flowId: "flow-1",
        revision: 10,
        stateJson: patch.stateJson,
      },
      {
        expectedRevision: 1,
        currentStep: "state_revision_check",
        now: "2026-08-22T04:08:00Z",
      },
    );
    expect(updatePatch).toMatchObject({
      flowId: "flow-1",
      expectedFlowRevision: 10,
      stateJson: {
        governedMissionState: {
          currentStep: "state_revision_check",
          revision: 2,
          stateVersion: "2026-08-22T0407Z:2",
        },
      },
    });
    expect(() =>
      buildGovernedMissionTaskFlowUpdatePatch(
        {
          flowId: "flow-1",
          revision: 11,
          stateJson: updatePatch.stateJson,
        },
        {
          expectedRevision: 1,
          currentStep: "stale_update",
          now: "2026-08-22T04:09:00Z",
        },
      ),
    ).toThrow("governed mission state revision mismatch");
    expect(() =>
      buildGovernedMissionTaskFlowUpdatePatch(
        {
          flowId: "flow-1",
          revision: 11,
          stateJson: {},
        },
        {
          expectedRevision: 1,
          currentStep: "missing_state",
          now: "2026-08-22T04:09:00Z",
        },
      ),
    ).toThrow("governed mission state not found on TaskFlow record: flow-1");
  });

  it("rejects TaskFlow persistence when the state is not correlated to the flow", () => {
    expect(() =>
      buildGovernedMissionTaskFlowStatePatch(
        {
          flowId: "flow-2",
          revision: 1,
          stateJson: {},
        },
        createGovernedMissionState({
          contract,
          authorityRef,
          currentStep: "minimum_durable_state",
          ownerCorrelation: { owner: "Cleanup Crew", taskFlowId: "flow-1" },
          now: "2026-08-22T04:07:00Z",
        }),
      ),
    ).toThrow("governed mission state must be correlated to the TaskFlow record");
  });

  it("ignores malformed persisted governed state instead of exposing a partial object", () => {
    expect(
      readGovernedMissionStateFromTaskFlow({
        flowId: "flow-1",
        revision: 1,
        stateJson: {
          governedMissionState: {
            schema: "openclaw.governed_mission_state.v2",
            missionId: "mission-without-owner-or-proofs",
            contractId: "contract-1",
            contractVersion: "1",
            contractHash: "contract-hash",
            authorityHash: "authority-hash",
            planRevisionId: "plan-1",
            sourceRevision: "source-1",
            runtimeBuildSha256: "build-1",
            policyVersion: "policy-1",
            skillSha256: "skill-1",
            currentGovernedState: "admitted",
            revision: 1,
          },
        },
      }),
    ).toBeUndefined();
  });

  it("keeps active missions on pinned authority when hashes still match", () => {
    const state = createGovernedMissionState({
      contract,
      authorityRef,
      currentStep: "policy_decision_input",
      ownerCorrelation: { owner: "Cleanup Crew" },
      now: "2026-08-22T04:07:00Z",
    });

    expect(
      requireGovernedMissionPinnedAuthority(
        state,
        {
          contractHash: "contract-hash",
          authorityHash: "authority-hash",
          authorityRef,
        },
        "2026-08-22T04:08:00Z",
      ),
    ).toEqual({ ok: true, state });
  });

  it("turns stale authority or contract mismatches into explicit blocked readmission state", () => {
    const state = createGovernedMissionState({
      contract,
      authorityRef,
      currentStep: "policy_decision_input",
      ownerCorrelation: { owner: "Cleanup Crew" },
      now: "2026-08-22T04:07:00Z",
    });

    const staleAuthority = requireGovernedMissionPinnedAuthority(
      state,
      {
        contractHash: "contract-hash",
        authorityHash: "changed-authority",
        authorityRef: { ...authorityRef, sha256: "changed-authority" },
      },
      "2026-08-22T04:08:00Z",
    );
    expect(staleAuthority).toMatchObject({
      ok: false,
      reason: "stale_authority_hash",
      state: {
        authorityRef,
        readmissionAuthorityRef: { ...authorityRef, sha256: "changed-authority" },
        currentGovernedState: "readmission_required",
        blockedStatus: "stale_authority_hash",
        currentStep: "lawful_readmission_required",
        revision: 2,
      },
    });

    const contractMismatch = requireGovernedMissionPinnedAuthority(
      state,
      {
        contractHash: "changed-contract",
        authorityHash: "authority-hash",
        authorityRef,
      },
      "2026-08-22T04:08:00Z",
    );
    expect(contractMismatch).toMatchObject({
      ok: false,
      reason: "contract_hash_mismatch",
      state: {
        authorityRef,
        readmissionAuthorityRef: authorityRef,
        currentGovernedState: "readmission_required",
        blockedStatus: "contract_hash_mismatch",
        currentStep: "lawful_readmission_required",
      },
    });
  });
});
