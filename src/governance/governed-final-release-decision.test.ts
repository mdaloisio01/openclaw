import { describe, expect, it } from "vitest";
import { validateGovernedCloseoutAndBuildReleaseState } from "./governed-closeout-validator.js";
import {
  GOVERNED_FINAL_RELEASE_WITHHELD_NOTICE,
  mayReleaseGovernedFinal,
} from "./governed-final-release-decision.js";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "mission-release",
  contractId: "contract-release",
  contractVersion: "2026-08-23T1419Z",
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
  planRevisionId: "sop-enf-17",
  sourceRevision: "31d50dc436ddada2c38cb02e33a9e68a20216959",
  runtimeBuildSha256: "openclaw-2026.6.2-a87590b",
  policyVersion: "sop-enforcement-v1",
  mode: "shadow",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: "2026-08-23T14:19:00Z",
};

function releaseState() {
  return validateGovernedCloseoutAndBuildReleaseState({
    contract,
    runId: "run-1",
    observedContractHash: contract.contractHash,
    observedAuthorityHash: contract.authorityHash,
    requestedCompletionOwner: "governed_mission_state",
    requiredEvidenceReceiptRefs: ["admission:1", "policy:1", "closeout-proof:1"],
    presentEvidenceReceiptRefs: ["admission:1", "policy:1", "closeout-proof:1"],
    closeoutPassed: true,
    noBlockingState: true,
    payloadHash: "payload-hash-1",
    producedAt: "2026-08-23T14:19:00Z",
    decisionSequence: 1,
    producer: "closeout-validator",
  }).releaseState;
}

describe("governed final release decision", () => {
  it("allows a final payload only when pinned release state matches the mission and payload", () => {
    expect(
      mayReleaseGovernedFinal({
        missionId: contract.missionId,
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
        payloadHash: "payload-hash-1",
        releaseState: releaseState(),
      }),
    ).toMatchObject({
      allowed: true,
      reason: "allowed",
      releaseStateHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("fails closed for missing state, disabled gate, denied state, and mismatches", () => {
    const state = releaseState();
    const deniedState = validateGovernedCloseoutAndBuildReleaseState({
      contract,
      runId: "run-1",
      observedContractHash: contract.contractHash,
      observedAuthorityHash: contract.authorityHash,
      requestedCompletionOwner: "governed_mission_state",
      requiredEvidenceReceiptRefs: ["admission:1", "policy:1", "closeout-proof:1"],
      presentEvidenceReceiptRefs: ["admission:1", "policy:1", "closeout-proof:1"],
      closeoutPassed: false,
      noBlockingState: true,
      payloadHash: "payload-hash-1",
      producedAt: "2026-08-23T14:19:00Z",
      decisionSequence: 2,
      producer: "closeout-validator",
    }).releaseState;
    expect(
      mayReleaseGovernedFinal({
        missionId: contract.missionId,
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
      }),
    ).toMatchObject({ allowed: false, reason: "release_state_missing" });
    expect(
      mayReleaseGovernedFinal({
        missionId: contract.missionId,
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
        releaseState: state,
        gateEnabled: false,
      }),
    ).toMatchObject({ allowed: false, reason: "gate_disabled" });
    expect(
      mayReleaseGovernedFinal({
        missionId: contract.missionId,
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
        payloadHash: "payload-hash-1",
        releaseState: deniedState,
      }),
    ).toMatchObject({ allowed: false, reason: "release_state_denied" });
    expect(
      mayReleaseGovernedFinal({
        missionId: "other-mission",
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
        payloadHash: "payload-hash-1",
        releaseState: state,
      }),
    ).toMatchObject({ allowed: false, reason: "mission_mismatch" });
    expect(
      mayReleaseGovernedFinal({
        missionId: contract.missionId,
        runId: "other-run",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
        payloadHash: "payload-hash-1",
        releaseState: state,
      }),
    ).toMatchObject({ allowed: false, reason: "run_mismatch" });
    expect(
      mayReleaseGovernedFinal({
        missionId: contract.missionId,
        runId: "run-1",
        contractId: "other-contract",
        contractHash: contract.contractHash,
        payloadHash: "payload-hash-1",
        releaseState: state,
      }),
    ).toMatchObject({ allowed: false, reason: "contract_mismatch" });
    expect(
      mayReleaseGovernedFinal({
        missionId: contract.missionId,
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: "other-contract-hash",
        payloadHash: "payload-hash-1",
        releaseState: state,
      }),
    ).toMatchObject({ allowed: false, reason: "contract_hash_mismatch" });
    expect(
      mayReleaseGovernedFinal({
        missionId: contract.missionId,
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
        payloadHash: "payload-hash-2",
        releaseState: state,
      }),
    ).toMatchObject({ allowed: false, reason: "payload_hash_mismatch" });
  });

  it("fails closed when release state hash is tampered", () => {
    expect(
      mayReleaseGovernedFinal({
        missionId: contract.missionId,
        runId: "run-1",
        contractId: contract.contractId,
        contractHash: contract.contractHash,
        payloadHash: "payload-hash-1",
        releaseState: { ...releaseState(), releaseStateHash: "tampered" },
      }),
    ).toMatchObject({ allowed: false, reason: "release_state_hash_invalid" });
  });

  it("exports the static host-authored withheld notice", () => {
    expect(GOVERNED_FINAL_RELEASE_WITHHELD_NOTICE).toBe(
      "Governed result withheld because compliance state could not be verified.",
    );
  });
});
