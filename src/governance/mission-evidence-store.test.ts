import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ViolationReceipt } from "./governed-mission-contract.js";
import {
  DEFAULT_GOVERNED_EVIDENCE_RETENTION,
  readGovernedEvidenceRunIndex,
  sha256Text,
  writeEvidenceReceipt,
  writeGovernedEvidenceHandoffPointer,
  writeGovernedEvidenceReceipt,
} from "./mission-evidence-store.js";
import type { EvidenceReceipt } from "./mission-manifest.types.js";

const receipt: EvidenceReceipt = {
  schema: "openclaw.evidence_receipt.v1",
  missionId: "mission/evidence:test",
  planRevisionId: "plan-r1",
  planSha256: "plan-sha",
  sourceRevision: "source-sha",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "policy-v1",
  skillSha256: "skill-sha",
  receiptId: "receipt-1",
  gateId: "gate-1",
  status: "passed",
  producedAt: "2026-07-17T13:30:00Z",
  artifactSha256: "artifact-sha",
};

const violationReceipt: ViolationReceipt = {
  schema: "openclaw.governed_violation_receipt.v1",
  missionId: "mission/evidence:test",
  contractId: "contract-1",
  contractVersion: "v1",
  contractHash: "contract-sha",
  authorityHash: "authority-sha",
  receiptId: "violation-1",
  receiptKind: "violation",
  producedAt: "2026-07-17T13:31:00Z",
  producer: "mission-specific-tool-enforcement",
  violationCode: "MISSING_GOVERNED_AUTHORITY",
  blocked: true,
  evidenceRefs: ["receipt-1"],
};

describe("mission evidence store", () => {
  it("writes a receipt with deterministic hash reporting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-evidence-store-"));
    const result = writeEvidenceReceipt({ directory: dir, receipt });
    const body = await readFile(result.path, "utf8");

    expect(result.path).toBe(join(dir, "receipt-1.json"));
    expect(JSON.parse(body)).toEqual(receipt);
    expect(result.sha256).toBe(sha256Text(body));
  });

  it("stores governed receipts in a bounded mission/work-order/run hierarchy with indexes", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "openclaw-governed-evidence-"));
    const locator = {
      storeRoot,
      missionId: "mission/evidence:test",
      workOrderId: "SOP-ENF-13",
      runId: "run:1",
    };

    const evidenceResult = writeGovernedEvidenceReceipt({
      locator,
      receipt,
      writtenAt: "2026-08-23T06:25:00Z",
    });
    const violationResult = writeGovernedEvidenceReceipt({
      locator,
      receipt: violationReceipt,
      writtenAt: "2026-08-23T06:26:00Z",
    });
    const index = readGovernedEvidenceRunIndex(locator);

    expect(evidenceResult.record.absolutePath).toContain(
      "governed-evidence/v1/missions/mission_evidence_test/work-orders/SOP-ENF-13/runs/run_1/receipts/evidence",
    );
    expect(evidenceResult.record.receiptKind).toBe("evidence");
    expect(evidenceResult.record.retention).toEqual(DEFAULT_GOVERNED_EVIDENCE_RETENTION);
    expect(evidenceResult.exportPointer).toMatchObject({
      schema: "openclaw.governed_evidence_export_pointer.v1",
      missionId: locator.missionId,
      workOrderId: locator.workOrderId,
      runId: locator.runId,
      receiptKind: "evidence",
    });
    expect(violationResult.record.absolutePath).toContain("/receipts/violation/");
    expect(index.records.map((record) => record.receiptKind).toSorted()).toEqual([
      "evidence",
      "violation",
    ]);
    expect(index.records.every((record) => record.absolutePath.startsWith(storeRoot))).toBe(true);
    expect(index.records.every((record) => record.relativePath.includes("file_hub/exports"))).toBe(
      false,
    );
  });

  it("records handoff pointers beside receipts without duplicating the runtime firehose into exports", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "openclaw-governed-evidence-"));
    const locator = {
      storeRoot,
      missionId: receipt.missionId,
      workOrderId: "SOP-ENF-13",
      runId: "run-2",
    };
    const receiptResult = writeGovernedEvidenceReceipt({
      locator,
      receipt,
      writtenAt: "2026-08-23T06:27:00Z",
    });

    const handoffResult = writeGovernedEvidenceHandoffPointer({
      locator,
      pointer: {
        schema: "openclaw.governed_evidence_handoff_pointer.v1",
        pointerId: "handoff-to-grant",
        missionId: locator.missionId,
        workOrderId: locator.workOrderId,
        runId: locator.runId,
        fromOwner: "Will",
        toOwner: "Grant",
        reason: "mandatory read-only review",
        evidenceRefs: [receiptResult.record.artifactId],
        createdAt: "2026-08-23T06:28:00Z",
      },
    });
    const index = JSON.parse(await readFile(handoffResult.indexPath, "utf8")) as {
      handoffPointers: Array<{ pointerId: string; absolutePath: string }>;
    };

    expect(handoffResult.record.absolutePath).toContain("/handoff-pointers/");
    expect(handoffResult.record.pointerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(index.handoffPointers).toEqual([
      expect.objectContaining({
        pointerId: "handoff-to-grant",
        absolutePath: handoffResult.record.absolutePath,
      }),
    ]);
  });

  it("uses deterministic artifact identity for the same receipt and locator", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "openclaw-governed-evidence-"));
    const locator = {
      storeRoot,
      missionId: receipt.missionId,
      workOrderId: "SOP-ENF-13",
      runId: "run-3",
    };

    const first = writeGovernedEvidenceReceipt({
      locator,
      receipt,
      writtenAt: "2026-08-23T06:29:00Z",
    });
    const second = writeGovernedEvidenceReceipt({
      locator,
      receipt,
      writtenAt: "2026-08-23T06:30:00Z",
    });

    expect(second.record.artifactId).toBe(first.record.artifactId);
    expect(second.record.absolutePath).toBe(first.record.absolutePath);
    expect(readGovernedEvidenceRunIndex(locator).records).toHaveLength(1);
  });

  it("rejects receipt and handoff records bound to another mission or run", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "openclaw-governed-evidence-"));
    const locator = {
      storeRoot,
      missionId: receipt.missionId,
      workOrderId: "SOP-ENF-13",
      runId: "run-4",
    };

    expect(() =>
      writeGovernedEvidenceReceipt({
        locator,
        receipt: { ...receipt, missionId: "other-mission" },
        writtenAt: "2026-08-23T06:31:00Z",
      }),
    ).toThrow(/does not match evidence locator/);
    expect(() =>
      writeGovernedEvidenceHandoffPointer({
        locator,
        pointer: {
          schema: "openclaw.governed_evidence_handoff_pointer.v1",
          pointerId: "bad-handoff",
          missionId: locator.missionId,
          workOrderId: locator.workOrderId,
          runId: "other-run",
          fromOwner: "Will",
          toOwner: "Grant",
          reason: "bad run",
          evidenceRefs: [],
          createdAt: "2026-08-23T06:32:00Z",
        },
      }),
    ).toThrow(/does not match evidence locator/);
  });
});
