import { describe, expect, it } from "vitest";
import {
  isPinnedReleaseStateValidForPayload,
  recomputePinnedReleaseStateHash,
  validateIssueFamilyClosureAdmission,
  validateGovernedCloseoutAndBuildReleaseState,
} from "./governed-closeout-validator.js";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";

const now = "2026-08-23T13:57:00Z";

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "mission-closeout",
  contractId: "contract-closeout",
  contractVersion: "2026-08-23T1357Z",
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
  planRevisionId: "sop-enf-15",
  sourceRevision: "31d50dc436ddada2c38cb02e33a9e68a20216959",
  runtimeBuildSha256: "openclaw-2026.6.2-a87590b",
  policyVersion: "sop-enforcement-v1",
  mode: "shadow",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: now,
};

const requiredEvidence = ["admission:1", "policy:1", "closeout-proof:1"];

function validate(
  overrides: Partial<Parameters<typeof validateGovernedCloseoutAndBuildReleaseState>[0]> = {},
) {
  return validateGovernedCloseoutAndBuildReleaseState({
    contract,
    runId: "run-1",
    observedContractHash: contract.contractHash,
    observedAuthorityHash: contract.authorityHash,
    requestedCompletionOwner: "governed_mission_state",
    requiredEvidenceReceiptRefs: requiredEvidence,
    presentEvidenceReceiptRefs: requiredEvidence,
    closeoutPassed: true,
    noBlockingState: true,
    payloadHash: "payload-hash-1",
    producedAt: now,
    decisionSequence: 1,
    producer: "closeout-validator",
    ...overrides,
  });
}

describe("governed closeout validator", () => {
  it("emits integrity-bound closeout and release state when all requirements pass", () => {
    const result = validate();

    expect(result).toMatchObject({
      schema: "openclaw.governed_closeout_validation_result.v1",
      verdict: "ALLOW_RELEASE",
      releaseAllowed: true,
      rejectionCodes: [],
      missingEvidenceReceiptRefs: [],
      closeoutReceipt: {
        schema: "openclaw.governed_closeout_receipt.v1",
        receiptKind: "closeout",
        missionId: "mission-closeout",
        passed: true,
        evidenceRefs: ["admission:1", "closeout-proof:1", "policy:1"],
      },
      releaseReceipt: {
        schema: "openclaw.governed_release_receipt.v1",
        receiptKind: "release",
        releaseAllowed: true,
      },
      releaseState: {
        schema: "openclaw.governed_pinned_release_state.v1",
        missionId: "mission-closeout",
        runId: "run-1",
        contractId: "contract-closeout",
        contractVersion: "2026-08-23T1357Z",
        contractHash: "contract-hash",
        payloadHash: "payload-hash-1",
        validatorVerdict: "ALLOW_RELEASE",
        validatorVersion: "governed-closeout-validator-v1",
        decisionSequence: 1,
        releaseAllowed: true,
      },
    });
    expect(result.releaseState.closeoutReceiptHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.releaseState.releaseStateHash).toBe(
      recomputePinnedReleaseStateHash(result.releaseState),
    );
    expect(result.releaseReceipt.releaseStateHash).toBe(result.releaseState.releaseStateHash);
    expect(result.releaseReceipt.closeoutReceiptRef).toBe(result.closeoutReceipt.receiptId);
  });

  it("denies release when required durable evidence is missing", () => {
    const result = validate({ presentEvidenceReceiptRefs: ["admission:1"] });

    expect(result).toMatchObject({
      verdict: "DENY_RELEASE",
      releaseAllowed: false,
      rejectionCodes: ["REQUIRED_EVIDENCE_MISSING"],
      missingEvidenceReceiptRefs: ["policy:1", "closeout-proof:1"],
      closeoutReceipt: {
        passed: false,
        failureState: "FAILED_VALIDATION",
      },
      releaseReceipt: {
        releaseAllowed: false,
      },
    });
  });

  it("denies release for stale contract or authority hashes", () => {
    expect(validate({ observedContractHash: "stale-contract" }).rejectionCodes).toContain(
      "CONTRACT_HASH_MISMATCH",
    );
    expect(validate({ observedAuthorityHash: "stale-authority" }).rejectionCodes).toContain(
      "AUTHORITY_HASH_MISMATCH",
    );
  });

  it("denies release when a non-authoritative completion owner tries to close the mission", () => {
    const result = validate({ requestedCompletionOwner: "task_flow" });

    expect(result).toMatchObject({
      verdict: "DENY_RELEASE",
      releaseAllowed: false,
      rejectionCodes: ["AUTHORITATIVE_COMPLETION_OWNER_MISMATCH"],
      closeoutReceipt: {
        passed: false,
        failureState: "FAILED_CONTRACT",
      },
    });
  });

  it("denies succeeded state when closeout failed or blocking state remains", () => {
    expect(validate({ closeoutPassed: false }).rejectionCodes).toContain("CLOSEOUT_FAILED");
    expect(validate({ noBlockingState: false }).rejectionCodes).toContain(
      "BLOCKING_STATE_UNRESOLVED",
    );
  });

  it("does not let a different payload inherit an existing release approval", () => {
    const result = validate();

    expect(
      isPinnedReleaseStateValidForPayload(result.releaseState, {
        missionId: contract.missionId,
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
        payloadHash: "payload-hash-1",
      }),
    ).toBe(true);
    expect(
      isPinnedReleaseStateValidForPayload(result.releaseState, {
        missionId: contract.missionId,
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
        payloadHash: "payload-hash-2",
      }),
    ).toBe(false);
  });

  describe("issue-family closure admission", () => {
    function closureInput(
      overrides: Partial<Parameters<typeof validateIssueFamilyClosureAdmission>[0]> = {},
    ): Parameters<typeof validateIssueFamilyClosureAdmission>[0] {
      return {
        issueFamilyId: "ISSUE-040",
        missionId: contract.missionId,
        requestedClosureScope: "whole_family",
        evidenceScope: "whole_family",
        releaseState: validate().releaseState,
        finalVisibleDeliveryProof: true,
        finalCloseoutArtifactProof: true,
        grantAcceptanceProof: true,
        watchdogCleanProof: true,
        openSettlementRows: 0,
        issueRegisterActionProof: true,
        ...overrides,
      };
    }

    it("allows whole-family issue closure only after every same-identity gate passes", () => {
      expect(validateIssueFamilyClosureAdmission(closureInput())).toEqual({
        schema: "openclaw.issue_family_closure_admission_result.v1",
        issueFamilyId: "ISSUE-040",
        missionId: contract.missionId,
        closureAllowed: true,
        requestedClosureScope: "whole_family",
        evidenceScope: "whole_family",
        rejectionCodes: [],
        nextAction: "write issue-register closure row for the same governed mission identity",
      });
    });

    it("rejects artifact or register proof without visible final delivery", () => {
      expect(
        validateIssueFamilyClosureAdmission(
          closureInput({
            finalVisibleDeliveryProof: false,
          }),
        ),
      ).toMatchObject({
        closureAllowed: false,
        rejectionCodes: ["FINAL_VISIBLE_DELIVERY_PROOF_MISSING"],
        nextAction: "deliver the final Mark-facing report visibly and record proof before closure",
      });
    });

    it("rejects scoped evidence when whole-family closure is requested", () => {
      expect(
        validateIssueFamilyClosureAdmission(
          closureInput({
            evidenceScope: "scoped_slice",
          }),
        ),
      ).toMatchObject({
        closureAllowed: false,
        rejectionCodes: ["SCOPED_SLICE_CANNOT_CLOSE_WHOLE_FAMILY"],
        nextAction: "use scoped closure only for the slice or collect whole-family evidence",
      });
    });

    it("rejects missing Grant, watchdog, closeout, and settlement proof", () => {
      expect(
        validateIssueFamilyClosureAdmission(
          closureInput({
            finalCloseoutArtifactProof: false,
            grantAcceptanceProof: false,
            watchdogCleanProof: false,
            openSettlementRows: 2,
          }),
        ),
      ).toMatchObject({
        closureAllowed: false,
        rejectionCodes: [
          "FINAL_CLOSEOUT_ARTIFACT_PROOF_MISSING",
          "GRANT_ACCEPTANCE_PROOF_MISSING",
          "WATCHDOG_CLEAN_PROOF_MISSING",
          "OPEN_SETTLEMENT_ROWS_REMAIN",
        ],
      });
    });

    it("rejects release and mission identity mismatch before register closure", () => {
      const releaseState = validate().releaseState;

      expect(
        validateIssueFamilyClosureAdmission(
          closureInput({
            missionId: "different-mission",
            releaseState,
          }),
        ),
      ).toMatchObject({
        closureAllowed: false,
        rejectionCodes: ["MISSION_IDENTITY_MISMATCH"],
      });
    });

    it("requires issue-register action proof or a lawful no-update reason", () => {
      expect(
        validateIssueFamilyClosureAdmission(
          closureInput({
            issueRegisterActionProof: false,
          }),
        ),
      ).toMatchObject({
        closureAllowed: false,
        rejectionCodes: ["ISSUE_REGISTER_ACTION_PROOF_MISSING"],
      });

      expect(
        validateIssueFamilyClosureAdmission(
          closureInput({
            issueRegisterActionProof: false,
            lawfulNoIssueUpdateReason: "closure row already exists for this mission identity",
          }),
        ),
      ).toMatchObject({
        closureAllowed: true,
        rejectionCodes: [],
      });
    });

    it("rejects denied release state before issue-family closure", () => {
      expect(
        validateIssueFamilyClosureAdmission(
          closureInput({
            releaseState: validate({ noBlockingState: false }).releaseState,
          }),
        ),
      ).toMatchObject({
        closureAllowed: false,
        rejectionCodes: ["RELEASE_NOT_ALLOWED"],
        nextAction: "obtain an allowed governed release state before issue-family closure",
      });
    });
  });
});
