import { describe, expect, it } from "vitest";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import {
  createGovernedMissionState,
  type GovernedMissionReplacementIdentity,
  type GovernedMissionState,
} from "./governed-mission-state.js";
import {
  evaluateGovernedMissionOperation,
  type GovernedMissionOperation,
  type GovernedMissionTransitionContext,
} from "./governed-mission-transition.js";
import type { GateKind } from "./mission-manifest.types.js";

const authorityRef = {
  refId: "plan",
  kind: "build_plan" as const,
  uri: "/safe/plan.md",
  sha256: "authority-hash",
};

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "mission-1",
  contractId: "contract-1",
  contractVersion: "1",
  contractHash: "contract-hash",
  authorityHash: "authority-hash",
  authorityRefs: [authorityRef],
  admissionReceiptRef: "admission-1",
  planRevisionId: "plan-1",
  sourceRevision: "source-1",
  runtimeBuildSha256: "build-1",
  policyVersion: "policy-1",
  skillSha256: "skill-1",
  mode: "enforce",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: "2026-09-17T00:00:00.000Z",
};

function createState(requiredProofs?: {
  rollback?: boolean;
  restoration?: boolean;
}): GovernedMissionState {
  return createGovernedMissionState({
    contract,
    authorityRef,
    currentStep: "admitted",
    ownerCorrelation: { owner: "Will", taskFlowId: "flow-1" },
    requiredProofs,
    now: "2026-09-17T00:00:00.000Z",
  });
}

type GovernedMissionOperationInput = GovernedMissionOperation extends infer Operation
  ? Operation extends GovernedMissionOperation
    ? Omit<
        Operation,
        "expectedRevision" | "idempotencyKey" | "owner" | "controllerId" | "bindings" | "occurredAt"
      >
    : never
  : never;

function operation(
  state: GovernedMissionState,
  request: GovernedMissionOperationInput | GovernedMissionOperation,
): GovernedMissionOperation {
  return {
    ...request,
    expectedRevision: state.revision,
    idempotencyKey: `${request.operation}-${state.revision}`,
    owner: "Will",
    controllerId: "controller-1",
    bindings: {
      contractHash: state.contractHash,
      authorityHash: state.authorityHash,
      planRevisionId: state.planRevisionId,
      sourceRevision: state.sourceRevision,
      runtimeBuildSha256: state.runtimeBuildSha256,
      policyVersion: state.policyVersion,
      skillSha256: state.skillSha256,
    },
    occurredAt: `2026-09-17T00:00:${String(state.revision).padStart(2, "0")}.000Z`,
  } as GovernedMissionOperation;
}

function apply(
  state: GovernedMissionState,
  request: GovernedMissionOperation,
  context?: GovernedMissionTransitionContext,
): GovernedMissionState {
  const decision = evaluateGovernedMissionOperation(state, request, context);
  expect(decision.status).toBe("applied");
  return decision.nextState;
}

function readmissionPackage(
  replacementIdentity: GovernedMissionReplacementIdentity,
  gateKinds: readonly GateKind[] = ["test"],
) {
  const gateIds = gateKinds.map((kind) => `REQ-1:${kind}`);
  return {
    replacementIdentity,
    replacementDeliveryRequired: false,
    replacementContract: {
      ...contract,
      contractId: replacementIdentity.contractId,
      contractVersion: replacementIdentity.contractVersion,
      contractHash: replacementIdentity.contractHash,
      authorityHash: replacementIdentity.authorityHash,
      authorityRefs: [replacementIdentity.authorityRef],
      planRevisionId: replacementIdentity.planRevisionId,
      sourceRevision: replacementIdentity.sourceRevision,
      runtimeBuildSha256: replacementIdentity.runtimeBuildSha256,
      policyVersion: replacementIdentity.policyVersion,
      skillSha256: replacementIdentity.skillSha256,
    },
    replacementCompiledPlan: {
      manifest: {
        schema: "openclaw.mission_manifest.v1" as const,
        missionId: contract.missionId,
        planRevisionId: replacementIdentity.planRevisionId,
        planSha256: "replacement-plan-sha",
        sourceRevision: replacementIdentity.sourceRevision,
        runtimeBuildSha256: replacementIdentity.runtimeBuildSha256,
        policyVersion: replacementIdentity.policyVersion,
        skillSha256: replacementIdentity.skillSha256,
        mode: "enforce" as const,
        scopeHash: "replacement-scope",
        authorizedScopeHash: "replacement-scope",
        planRevisionAuthorized: true,
        createdAt: "2026-09-17T00:00:00.000Z",
      },
      requirements: {
        schema: "openclaw.requirement_manifest.v1" as const,
        missionId: contract.missionId,
        planRevisionId: replacementIdentity.planRevisionId,
        requirements: [
          {
            id: "REQ-1",
            text: "Prove replacement mission",
            required: true,
            gateIds,
          },
        ],
      },
      gates: gateKinds.map((kind) => ({
        id: `REQ-1:${kind}`,
        requirementId: "REQ-1",
        kind,
        required: true,
      })),
    },
    replacementArtifactDeclarations: gateKinds.map((kind) => ({
      artifactId: `replacement-${kind}-proof`,
      artifactKind: "validation",
      missionId: contract.missionId,
      workOrderId: "work-2",
      gateId: `REQ-1:${kind}`,
      allowedRoot: "/safe",
      pathname: `/safe/replacement-${kind}-proof.json`,
      required: true,
      identityBindings: {
        missionId: contract.missionId,
        contractHash: replacementIdentity.contractHash,
        authorityHash: replacementIdentity.authorityHash,
        planRevisionId: replacementIdentity.planRevisionId,
        sourceRevision: replacementIdentity.sourceRevision,
        runtimeBuildSha256: replacementIdentity.runtimeBuildSha256,
        policyVersion: replacementIdentity.policyVersion,
        skillSha256: replacementIdentity.skillSha256,
      },
    })),
  };
}

describe("governed mission lifecycle", () => {
  it("requires the persisted execution lease to close before accepting proof", () => {
    let state = createState();
    state = apply(state, operation(state, { operation: "startWorkOrder" }));
    state = apply(
      state,
      operation(state, {
        operation: "openExecutionLease",
        runId: "run-1",
        processId: process.pid,
        runtimeInstanceId: "runtime-1",
      }),
    );

    expect(
      evaluateGovernedMissionOperation(
        state,
        operation(state, { operation: "recordImplementationResult", passed: true }),
      ),
    ).toMatchObject({
      status: "repair_required",
      reasonCode: "ACTIVE_EXECUTION_LEASE_OPEN",
      missingProof: ["execution_quiescence"],
    });
    expect(
      evaluateGovernedMissionOperation(
        state,
        operation(state, {
          operation: "blockForRepair",
          reasonCode: "TEST_REPAIR_REQUIRED",
          nextAction: "Repair after the active attempt closes.",
        }),
      ),
    ).toMatchObject({
      status: "repair_required",
      reasonCode: "ACTIVE_EXECUTION_LEASE_OPEN",
      stateChanged: false,
      missingProof: ["execution_quiescence"],
      nextState: { currentGovernedState: "executing", activeExecutionLease: { runId: "run-1" } },
    });
    for (const operationName of ["cancelMission", "stopMission"] as const) {
      expect(
        evaluateGovernedMissionOperation(
          state,
          operation(state, { operation: operationName } as GovernedMissionOperation),
        ),
      ).toMatchObject({
        status: "repair_required",
        reasonCode: "ACTIVE_EXECUTION_LEASE_OPEN",
        stateChanged: false,
        missingProof: ["execution_quiescence"],
      });
    }

    expect(
      evaluateGovernedMissionOperation(
        state,
        operation(state, { operation: "closeExecutionLease", runId: "other-run" }),
        { cancellationPending: true },
      ),
    ).toMatchObject({
      status: "conflict",
      reasonCode: "EXECUTION_LEASE_MISMATCH",
      stateChanged: false,
    });
    state = apply(state, operation(state, { operation: "closeExecutionLease", runId: "run-1" }), {
      cancellationPending: true,
    });
    expect(state.activeExecutionLease).toBeUndefined();
    expect(
      evaluateGovernedMissionOperation(
        state,
        operation(state, { operation: "recordImplementationResult", passed: true }),
      ).status,
    ).toBe("applied");
  });

  it("advances through the complete legal lifecycle", () => {
    let state = createState();
    state = apply(
      state,
      operation(state, { operation: "startWorkOrder" } as GovernedMissionOperation),
    );
    state = apply(
      state,
      operation(state, {
        operation: "recordImplementationResult",
        passed: true,
      } as GovernedMissionOperation),
    );
    state = apply(
      state,
      operation(state, {
        operation: "recordValidationResult",
        passed: true,
      } as GovernedMissionOperation),
    );
    state = apply(
      state,
      operation(state, {
        operation: "recordReviewResult",
        passed: true,
      } as GovernedMissionOperation),
    );
    state = apply(
      state,
      operation(state, { operation: "requestCloseout" } as GovernedMissionOperation),
    );
    state = apply(
      state,
      operation(state, {
        operation: "verifyRequiredArtifacts",
        passed: true,
      } as GovernedMissionOperation),
    );
    for (const openWorkCount of [-1, Number.NaN]) {
      expect(
        evaluateGovernedMissionOperation(
          state,
          operation(state, {
            operation: "admitTerminalPendingWatchdog",
            parentScopeClosed: true,
            openWorkCount,
          } as GovernedMissionOperation),
        ),
      ).toMatchObject({
        status: "repair_required",
        reasonCode: "TERMINAL_PENDING_PROOF_MISSING",
        missingProof: ["open_work"],
        stateChanged: false,
      });
    }
    state = apply(
      state,
      operation(state, {
        operation: "admitTerminalPendingWatchdog",
        parentScopeClosed: true,
        openWorkCount: 0,
      } as GovernedMissionOperation),
    );
    const watchdogRevision = state.revision;
    state = apply(
      state,
      operation(state, {
        operation: "recordPostTerminalWatchdog",
        passed: true,
        boundRevision: watchdogRevision,
        boundRuntimeBuildSha256: state.runtimeBuildSha256,
      } as GovernedMissionOperation),
    );
    expect(
      evaluateGovernedMissionOperation(
        state,
        operation(state, {
          operation: "releaseFinalResult",
        } as GovernedMissionOperation),
        { cancellationPending: true },
      ),
    ).toMatchObject({
      status: "denied",
      reasonCode: "CANCELLATION_PENDING",
      stateChanged: false,
    });
    state = apply(
      state,
      operation(state, {
        operation: "releaseFinalResult",
      } as GovernedMissionOperation),
      { releaseAuthorization: { allowed: true, reasonCode: "FINAL_RELEASE_AUTHORIZED" } },
    );

    expect(state.currentGovernedState).toBe("released");
    expect(state.terminalStatus).toBe("succeeded");
    expect(state.proofs).toMatchObject({
      implementation: "passed",
      validation: "passed",
      review: "passed",
      artifacts: "passed",
      postTerminalWatchdog: "passed",
    });
  });

  it("leaves state unchanged and gives one repair path when required proof is missing", () => {
    let state = createState();
    state = apply(
      state,
      operation(state, { operation: "startWorkOrder" } as GovernedMissionOperation),
    );
    const decision = evaluateGovernedMissionOperation(
      state,
      operation(state, {
        operation: "recordImplementationResult",
        passed: false,
        failureCodes: ["test_failed"],
      } as GovernedMissionOperationInput),
    );

    expect(decision).toMatchObject({
      status: "repair_required",
      reasonCode: "IMPLEMENTATION_PROOF_MISSING",
      stateChanged: false,
      missingProof: ["implementation"],
    });
    expect(decision.nextState).toEqual(state);
    expect(decision.nextAction).toContain("Repair the implementation");
  });

  it("rejects illegal edges, stale revisions, owner mismatch, and identity drift", () => {
    const state = createState();
    expect(
      evaluateGovernedMissionOperation(
        state,
        operation(state, { operation: "requestCloseout" } as GovernedMissionOperation),
      ).reasonCode,
    ).toBe("CLOSEOUT_PROOF_MISSING");

    const stale = operation(state, { operation: "startWorkOrder" } as GovernedMissionOperation);
    stale.expectedRevision -= 1;
    expect(evaluateGovernedMissionOperation(state, stale).status).toBe("conflict");

    const wrongOwner = operation(state, {
      operation: "startWorkOrder",
    } as GovernedMissionOperation);
    wrongOwner.owner = "someone-else";
    expect(evaluateGovernedMissionOperation(state, wrongOwner).reasonCode).toBe("OWNER_MISMATCH");

    const invalidDrift = operation(state, {
      operation: "startWorkOrder",
    } as GovernedMissionOperation);
    invalidDrift.idempotencyKey = "";
    invalidDrift.bindings.runtimeBuildSha256 = "other-build";
    expect(evaluateGovernedMissionOperation(state, invalidDrift)).toMatchObject({
      status: "denied",
      reasonCode: "IDEMPOTENCY_KEY_MISSING",
      stateChanged: false,
    });

    const drift = operation(state, { operation: "startWorkOrder" } as GovernedMissionOperation);
    drift.bindings.runtimeBuildSha256 = "other-build";
    const driftDecision = evaluateGovernedMissionOperation(state, drift);
    expect(driftDecision).toMatchObject({
      status: "denied",
      reasonCode: "RUNTIME_BUILD_MISMATCH",
      stateChanged: true,
      nextState: {
        currentGovernedState: "readmission_required",
        blockedStatus: "runtime_build_mismatch",
      },
    });
    const repairBypass = evaluateGovernedMissionOperation(
      driftDecision.nextState,
      operation(driftDecision.nextState, {
        operation: "blockForRepair",
        reasonCode: "TRY_TO_BYPASS_READMISSION",
        nextAction: "Resume old work",
      } as GovernedMissionOperation),
    );
    expect(repairBypass).toMatchObject({
      status: "denied",
      reasonCode: "READMISSION_REQUIRED",
      stateChanged: false,
      nextState: { currentGovernedState: "readmission_required" },
    });

    const readmitted = evaluateGovernedMissionOperation(
      driftDecision.nextState,
      operation(driftDecision.nextState, {
        operation: "requestReadmission",
        ...readmissionPackage({
          contractId: contract.contractId,
          contractVersion: "2",
          contractHash: "replacement-contract",
          authorityHash: "replacement-authority",
          authorityRef: { ...authorityRef, sha256: "replacement-authority" },
          planRevisionId: "plan-2",
          sourceRevision: "source-2",
          runtimeBuildSha256: "other-build",
          policyVersion: "policy-2",
          skillSha256: "skill-2",
        }),
      } as GovernedMissionOperationInput),
    );
    expect(readmitted).toMatchObject({
      status: "applied",
      stateChanged: true,
      nextState: {
        currentGovernedState: "admitted",
        contractVersion: "2",
        contractHash: "replacement-contract",
        runtimeBuildSha256: "other-build",
        blockedStatus: "not_blocked",
      },
    });

    const driftedAgain = evaluateGovernedMissionOperation(readmitted.nextState, {
      ...operation(readmitted.nextState, {
        operation: "startWorkOrder",
      } as GovernedMissionOperation),
      bindings: {
        ...operation(readmitted.nextState, {
          operation: "startWorkOrder",
        } as GovernedMissionOperation).bindings,
        policyVersion: "policy-3",
      },
    });
    const mismatchedAuthority = operation(driftedAgain.nextState, {
      operation: "requestReadmission",
      ...readmissionPackage({
        contractId: contract.contractId,
        contractVersion: "3",
        contractHash: "replacement-contract-3",
        authorityHash: "replacement-authority-3",
        authorityRef: { ...authorityRef, sha256: "different-authority" },
        planRevisionId: "plan-3",
        sourceRevision: "source-3",
        runtimeBuildSha256: "build-3",
        policyVersion: "policy-3",
        skillSha256: "skill-3",
      }),
    } as GovernedMissionOperationInput);
    expect(
      evaluateGovernedMissionOperation(driftedAgain.nextState, mismatchedAuthority),
    ).toMatchObject({
      status: "denied",
      reasonCode: "READMISSION_IDENTITY_MISSING",
      stateChanged: false,
    });

    const unpinnedIdentity: GovernedMissionReplacementIdentity = {
      contractId: contract.contractId,
      contractVersion: "3",
      contractHash: "replacement-contract-3",
      authorityHash: "replacement-authority-3",
      authorityRef: { ...authorityRef, sha256: "replacement-authority-3" },
      planRevisionId: "plan-3",
      sourceRevision: "source-3",
      runtimeBuildSha256: "build-3",
      policyVersion: "policy-3",
      skillSha256: "skill-3",
    };
    const unpinnedPackage = readmissionPackage(unpinnedIdentity);
    unpinnedPackage.replacementContract.authorityRefs = [
      { ...unpinnedIdentity.authorityRef, refId: "different-authority-ref" },
    ];
    expect(
      evaluateGovernedMissionOperation(
        driftedAgain.nextState,
        operation(driftedAgain.nextState, {
          operation: "requestReadmission",
          ...unpinnedPackage,
        } as GovernedMissionOperationInput),
      ),
    ).toMatchObject({
      status: "denied",
      reasonCode: "READMISSION_CONTRACT_MISMATCH",
      stateChanged: false,
    });
  });

  it("recomputes readmission proof requirements from the replacement plan", () => {
    const replacementIdentity: GovernedMissionReplacementIdentity = {
      contractId: contract.contractId,
      contractVersion: "2",
      contractHash: "replacement-contract",
      authorityHash: "replacement-authority",
      authorityRef: { ...authorityRef, sha256: "replacement-authority" },
      planRevisionId: "plan-2",
      sourceRevision: "source-2",
      runtimeBuildSha256: "build-2",
      policyVersion: "policy-2",
      skillSha256: "skill-2",
    };
    const enterReadmission = (state: GovernedMissionState) => {
      const drift = operation(state, { operation: "startWorkOrder" } as GovernedMissionOperation);
      drift.bindings.runtimeBuildSha256 = replacementIdentity.runtimeBuildSha256;
      return evaluateGovernedMissionOperation(state, drift).nextState;
    };

    const previouslyRequired = enterReadmission(createState({ rollback: true, restoration: true }));
    const removed = evaluateGovernedMissionOperation(
      previouslyRequired,
      operation(previouslyRequired, {
        operation: "requestReadmission",
        ...readmissionPackage(replacementIdentity),
      } as GovernedMissionOperationInput),
    );
    expect(removed.nextState.proofs).toMatchObject({
      rollback: "not_required",
      restoration: "not_required",
    });

    const previouslyOptional = enterReadmission(createState());
    const added = evaluateGovernedMissionOperation(
      previouslyOptional,
      operation(previouslyOptional, {
        operation: "requestReadmission",
        ...readmissionPackage(replacementIdentity, ["test", "rollback", "restoration"]),
      } as GovernedMissionOperationInput),
    );
    expect(added.nextState.proofs).toMatchObject({
      rollback: "pending",
      restoration: "pending",
    });

    const deliveryAddedPackage = readmissionPackage(replacementIdentity);
    deliveryAddedPackage.replacementDeliveryRequired = true;
    const deliveryAdded = evaluateGovernedMissionOperation(
      previouslyOptional,
      operation(previouslyOptional, {
        operation: "requestReadmission",
        ...deliveryAddedPackage,
      } as GovernedMissionOperationInput),
    );
    expect(deliveryAdded.nextState.proofs.delivery).toBe("pending");

    const deliveryPreviouslyRequired = {
      ...previouslyOptional,
      proofs: { ...previouslyOptional.proofs, delivery: "pending" as const },
    };
    const deliveryRemoved = evaluateGovernedMissionOperation(
      deliveryPreviouslyRequired,
      operation(deliveryPreviouslyRequired, {
        operation: "requestReadmission",
        ...readmissionPackage(replacementIdentity),
      } as GovernedMissionOperationInput),
    );
    expect(deliveryRemoved.nextState.proofs.delivery).toBe("not_required");
  });

  it("accepts a fully validated replacement package from a nonterminal state", () => {
    const state = createState();
    const replacementIdentity: GovernedMissionReplacementIdentity = {
      contractId: contract.contractId,
      contractVersion: "2",
      contractHash: "replacement-contract",
      authorityHash: "replacement-authority",
      authorityRef: { ...authorityRef, sha256: "replacement-authority" },
      planRevisionId: "plan-2",
      sourceRevision: "source-2",
      runtimeBuildSha256: "build-2",
      policyVersion: "policy-2",
      skillSha256: "skill-2",
    };

    const readmitted = evaluateGovernedMissionOperation(
      state,
      operation(state, {
        operation: "requestReadmission",
        ...readmissionPackage(replacementIdentity),
      } as GovernedMissionOperationInput),
    );

    expect(readmitted).toMatchObject({
      status: "applied",
      stateChanged: true,
      nextState: {
        currentGovernedState: "admitted",
        contractVersion: "2",
        contractHash: "replacement-contract",
      },
    });
  });

  it("does not skip review or enter terminal pending while parent work remains open", () => {
    let state = createState();
    state = apply(
      state,
      operation(state, { operation: "startWorkOrder" } as GovernedMissionOperation),
    );
    state = apply(
      state,
      operation(state, {
        operation: "recordImplementationResult",
        passed: true,
      } as GovernedMissionOperation),
    );
    expect(
      evaluateGovernedMissionOperation(
        state,
        operation(state, { operation: "requestCloseout" } as GovernedMissionOperation),
      ),
    ).toMatchObject({
      status: "repair_required",
      missingProof: ["review", "validation"],
      stateChanged: false,
    });

    state = apply(
      state,
      operation(state, {
        operation: "recordValidationResult",
        passed: true,
      } as GovernedMissionOperation),
    );
    state = apply(
      state,
      operation(state, {
        operation: "recordReviewResult",
        passed: true,
      } as GovernedMissionOperation),
    );
    state = apply(
      state,
      operation(state, { operation: "requestCloseout" } as GovernedMissionOperation),
    );
    state = apply(
      state,
      operation(state, {
        operation: "verifyRequiredArtifacts",
        passed: true,
      } as GovernedMissionOperation),
    );
    expect(
      evaluateGovernedMissionOperation(
        state,
        operation(state, {
          operation: "admitTerminalPendingWatchdog",
          parentScopeClosed: false,
          openWorkCount: 1,
        } as GovernedMissionOperation),
      ),
    ).toMatchObject({
      status: "repair_required",
      missingProof: ["open_work", "parent_scope"],
      stateChanged: false,
    });
  });

  it("requires declared rollback and restoration proof before terminal pending", () => {
    let state = createState({ rollback: true, restoration: true });
    state = apply(
      state,
      operation(state, { operation: "startWorkOrder" } as GovernedMissionOperation),
    );
    for (const request of [
      { operation: "recordImplementationResult", passed: true },
      { operation: "recordValidationResult", passed: true },
      { operation: "recordReviewResult", passed: true },
      { operation: "requestCloseout" },
    ] as GovernedMissionOperation[]) {
      state = apply(state, operation(state, request));
    }
    state = apply(
      state,
      operation(state, {
        operation: "verifyRequiredArtifacts",
        passed: true,
      } as GovernedMissionOperation),
    );
    expect(
      evaluateGovernedMissionOperation(
        state,
        operation(state, {
          operation: "admitTerminalPendingWatchdog",
          parentScopeClosed: true,
          openWorkCount: 0,
        } as GovernedMissionOperation),
      ),
    ).toMatchObject({
      status: "repair_required",
      missingProof: ["restoration", "rollback"],
      stateChanged: false,
    });

    state = {
      ...state,
      currentGovernedState: "closeout_ready",
    };
    state = apply(
      state,
      operation(state, {
        operation: "verifyRequiredArtifacts",
        passed: true,
        satisfiedProofs: ["rollback", "restoration"],
      } as GovernedMissionOperationInput),
    );
    expect(state.proofs).toMatchObject({ rollback: "passed", restoration: "passed" });
  });

  it("resets stale proof when a repair attempt restarts", () => {
    const state = {
      ...createState({ rollback: true, restoration: true }),
      currentGovernedState: "repair_required" as const,
      proofs: {
        implementation: "passed" as const,
        validation: "passed" as const,
        review: "passed" as const,
        artifacts: "passed" as const,
        rollback: "passed" as const,
        restoration: "passed" as const,
        postTerminalWatchdog: "passed" as const,
        delivery: "not_required" as const,
      },
      postTerminalWatchdogBinding: {
        boundRevision: 1,
        runtimeBuildSha256: contract.runtimeBuildSha256,
      },
    };

    const restarted = evaluateGovernedMissionOperation(
      state,
      operation(state, { operation: "startWorkOrder" } as GovernedMissionOperation),
    );

    expect(restarted.status).toBe("applied");
    expect(restarted.nextState.proofs).toEqual({
      implementation: "pending",
      validation: "pending",
      review: "pending",
      artifacts: "pending",
      rollback: "pending",
      restoration: "pending",
      postTerminalWatchdog: "pending",
      delivery: "not_required",
    });
    expect(restarted.nextState.postTerminalWatchdogBinding).toBeUndefined();
  });
});
