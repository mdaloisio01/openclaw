import { describe, expect, it } from "vitest";
import { latestPassingReceiptForGate } from "./mission-gate-registry.js";
import type { AcceptanceGate, EvidenceReceipt, MissionIdentity } from "./mission-manifest.types.js";

const identity: MissionIdentity = {
  missionId: "mission-gate-test",
  planRevisionId: "plan-r1",
  planSha256: "plan-sha",
  sourceRevision: "source-sha",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "policy-v1",
  skillSha256: "skill-sha",
};

const gate: AcceptanceGate = {
  id: "gate-1",
  requirementId: "REQ-1",
  kind: "requirement",
  required: true,
  freshnessMs: 60_000,
};

function receipt(params: Partial<EvidenceReceipt>): EvidenceReceipt {
  return {
    schema: "openclaw.evidence_receipt.v1",
    ...identity,
    receiptId: "receipt",
    gateId: "gate-1",
    status: "passed",
    producedAt: "2026-07-17T13:30:00Z",
    ...params,
  };
}

describe("latestPassingReceiptForGate", () => {
  it("selects the latest fresh passing receipt bound to the mission identity", () => {
    const latest = latestPassingReceiptForGate({
      gate,
      identity,
      now: "2026-07-17T13:30:30Z",
      receipts: [
        receipt({ receiptId: "older", producedAt: "2026-07-17T13:29:40Z" }),
        receipt({ receiptId: "failed", status: "failed", producedAt: "2026-07-17T13:30:20Z" }),
        receipt({ receiptId: "other-runtime", runtimeBuildSha256: "other-runtime" }),
        receipt({ receiptId: "latest", producedAt: "2026-07-17T13:30:10Z" }),
      ],
    });

    expect(latest?.receiptId).toBe("latest");
  });

  it("rejects stale receipts when the gate has a freshness window", () => {
    expect(
      latestPassingReceiptForGate({
        gate,
        identity,
        now: "2026-07-17T13:32:00Z",
        receipts: [receipt({ receiptId: "stale", producedAt: "2026-07-17T13:30:00Z" })],
      }),
    ).toBeUndefined();
  });
});
