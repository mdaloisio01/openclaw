import { describe, expect, it } from "vitest";
import {
  GOVERNED_MISSION_COMPLETION_RULE,
  GOVERNED_MISSION_FAILURE_STATES,
  GOVERNED_MISSION_LOCK_STATES,
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  GOVERNED_RUNTIME_RECEIPT_KINDS,
  missingGovernedContractFoundationFields,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";

const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "sop-enf-01",
  contractId: "contract-1",
  contractVersion: "2026-08-21T2227Z",
  contractHash: "contract-sha",
  authorityHash: "authority-sha",
  authorityRefs: [
    {
      refId: "plan",
      kind: "build_plan",
      uri: "/exports/sop_enforcement_master_build_plan_2026-08-21T1905Z.md",
      sha256: "plan-sha",
    },
  ],
  admissionReceiptRef: "admission-receipt",
  planRevisionId: "2026-08-21T2151Z-amended",
  sourceRevision: "31d50dc436ddada2c38cb02e33a9e68a20216959",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "sop-enforcement-v1",
  skillSha256: "skill-sha",
  mode: "shadow",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: "2026-08-21T22:27:00Z",
};

describe("governed mission contract foundation", () => {
  it("defines every receipt class required by SOP-ENF-01", () => {
    expect(GOVERNED_REQUIRED_RECEIPT_KINDS).toEqual([
      "admission",
      "policy_decision",
      "evidence",
      "supervisor",
      "closeout",
      "release",
    ]);
    expect(GOVERNED_RUNTIME_RECEIPT_KINDS).toEqual([
      ...GOVERNED_REQUIRED_RECEIPT_KINDS,
      "rollback",
    ]);
  });

  it("rejects receipt requirements the canonical runtime cannot emit", () => {
    expect(
      missingGovernedContractFoundationFields({
        ...contract,
        requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS, "override"],
      }),
    ).toEqual(["requiredReceiptKinds.unsupported.override"]);
  });

  it("rejects completion owners the canonical release runtime does not implement", () => {
    expect(
      missingGovernedContractFoundationFields({
        ...contract,
        authoritativeCompletionOwner: "task_flow",
      } as unknown as GovernedMissionContract),
    ).toContain("authoritativeCompletionOwner.unsupported");
  });

  it("rejects proof-producer device IDs that cannot match authenticated callers", () => {
    expect(
      missingGovernedContractFoundationFields({
        ...contract,
        proofProducers: {
          implementation: { deviceId: " implementation-device " },
          validation: { deviceId: "validation-device" },
          review: { deviceId: "review-device" },
          delivery: { deviceId: "delivery-device" },
        },
      }),
    ).toContain("proofProducers.invalid");
  });

  it("rejects unknown schemas, modes, and malformed authority references", () => {
    expect(
      missingGovernedContractFoundationFields({
        ...contract,
        schema: "openclaw.governed_mission_contract.v2",
        mode: "observe",
        authorityRefs: [null],
      } as unknown as GovernedMissionContract),
    ).toEqual(
      expect.arrayContaining(["schema.unsupported", "mode.unsupported", "authorityRefs.0.invalid"]),
    );
  });

  it("defines the required failure and governed wait states", () => {
    expect(GOVERNED_MISSION_FAILURE_STATES).toEqual(
      expect.arrayContaining([
        "DENIED_POLICY",
        "FAILED_PRECONDITION",
        "FAILED_CONTRACT",
        "FAILED_VALIDATION",
        "FAILED_TOOL",
        "FAILED_SUPERVISOR",
        "TIMED_OUT",
        "CANCELLED",
        "LOST",
        "BLOCKED",
        "SUCCEEDED",
        "FAILED_ENFORCEMENT_HEALTH",
      ]),
    );
    expect(GOVERNED_MISSION_LOCK_STATES).toEqual([
      "pending_override",
      "closeout_ready",
      "artifact_verified",
      "terminal_pending_watchdog",
      "released",
    ]);
  });

  it("requires pinned mission identity, authority, admission, owner, and receipts", () => {
    expect(missingGovernedContractFoundationFields(contract)).toEqual([]);

    expect(
      missingGovernedContractFoundationFields({
        ...contract,
        missionId: "",
        authorityRefs: [],
        requiredReceiptKinds: ["admission"],
      }),
    ).toEqual(
      expect.arrayContaining([
        "missionId",
        "authorityRefs",
        "requiredReceiptKinds.policy_decision",
        "requiredReceiptKinds.evidence",
        "requiredReceiptKinds.supervisor",
        "requiredReceiptKinds.closeout",
        "requiredReceiptKinds.release",
      ]),
    );
  });

  it("names a single authoritative completion owner and blocks independent success owners", () => {
    expect(GOVERNED_MISSION_COMPLETION_RULE).toMatchObject({
      authoritativeCompletionOwner: "governed_mission_state",
      succeededRequiresCloseoutPassed: true,
      succeededRequiresReleasePassedForGovernedFinalOutput: true,
      succeededRequiresNoUnresolvedBlockingState: true,
      independentSuccessOwnersForbidden: true,
    });
  });
});
