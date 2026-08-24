import { describe, expect, it } from "vitest";
import type {
  MissionIdentity,
  RestorationReceipt,
  RollbackReceipt,
} from "./mission-manifest.types.js";
import { restorationReceiptValid, rollbackReceiptValid } from "./rollback-restoration-state.js";

const identity: MissionIdentity = {
  missionId: "mission-rollback-test",
  planRevisionId: "plan-r1",
  planSha256: "plan-sha",
  sourceRevision: "source-sha",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "policy-v1",
  skillSha256: "skill-sha",
};

const rollback: RollbackReceipt = {
  schema: "openclaw.rollback_receipt.v1",
  ...identity,
  executed: true,
  producedAt: "2026-07-17T13:30:00Z",
  targetStateSha256: "target-sha",
};

const restoration: RestorationReceipt = {
  schema: "openclaw.restoration_receipt.v1",
  ...identity,
  executed: true,
  producedAt: "2026-07-17T13:30:00Z",
  restoredStateSha256: "restored-sha",
};

describe("rollback/restoration state", () => {
  it("accepts executed receipts bound to the mission identity", () => {
    expect(rollbackReceiptValid(rollback, identity)).toBe(true);
    expect(restorationReceiptValid(restoration, identity)).toBe(true);
  });

  it("rejects missing execution, missing hashes, or identity drift", () => {
    expect(rollbackReceiptValid({ ...rollback, executed: false }, identity)).toBe(false);
    expect(rollbackReceiptValid({ ...rollback, targetStateSha256: undefined }, identity)).toBe(
      false,
    );
    expect(restorationReceiptValid({ ...restoration, executed: false }, identity)).toBe(false);
    expect(
      restorationReceiptValid({ ...restoration, runtimeBuildSha256: "other-runtime" }, identity),
    ).toBe(false);
  });
});
