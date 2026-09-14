import { describe, expect, it } from "vitest";
import {
  GOVERNED_MISSION_COMPLETION_RULE,
  GOVERNED_MISSION_FAILURE_STATES,
  GOVERNED_MISSION_LOCK_STATES,
  GOVERNED_REQUIRED_RECEIPT_KINDS,
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
      "tool_call",
      "exec_call",
      "evidence",
      "violation",
      "supervisor",
      "closeout",
      "release",
      "override",
      "rollback",
    ]);
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
      "GOVERNED_MISSION_PENDING_OVERRIDE",
      "AWAITING_CLOSEOUT",
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
        "requiredReceiptKinds.tool_call",
        "requiredReceiptKinds.exec_call",
        "requiredReceiptKinds.evidence",
        "requiredReceiptKinds.violation",
        "requiredReceiptKinds.supervisor",
        "requiredReceiptKinds.closeout",
        "requiredReceiptKinds.release",
        "requiredReceiptKinds.override",
        "requiredReceiptKinds.rollback",
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
