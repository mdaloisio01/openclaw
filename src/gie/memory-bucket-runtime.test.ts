import { describe, expect, it } from "vitest";
import {
  GIE_MEMORY_BUCKETS,
  createGieMemoryRecord,
  evaluateGieMemoryBeforeAction,
  retrieveGieMemory,
} from "./memory-bucket-runtime.js";

const NOW = Date.parse("2026-07-21T22:02:00Z");

describe("GIE memory bucket runtime", () => {
  it("defines every required Phase 7 memory bucket", () => {
    expect(GIE_MEMORY_BUCKETS).toEqual([
      "task_history",
      "failure_history",
      "fix_history",
      "human_corrections",
      "approved_best_practices",
      "rejected_patterns",
      "department_specific_knowledge",
      "global_rules",
      "confidence_history",
      "performance_history",
    ]);
  });

  it("creates bucketed records with authority and proof refs", () => {
    const record = createGieMemoryRecord({
      recordId: "m1",
      bucket: "approved_best_practices",
      subjectKey: "phase7",
      summary: "Use verifier receipts before closeout.",
      confidence: 0.9,
      sourceRef: "receipt",
      authorityRef: "phase7-plan",
      proofRefs: ["proof"],
      updatedAt: NOW,
    });

    expect(record.bucket).toBe("approved_best_practices");
    expect(record.confidence).toBe(0.9);
    expect(record.proofRefs).toEqual(["proof"]);
  });

  it("requires memory-before-action and returns applicable records", () => {
    const approved = createGieMemoryRecord({
      recordId: "approved",
      bucket: "approved_best_practices",
      subjectKey: "routing",
      summary: "Reuse the verified router.",
      confidence: 0.8,
      sourceRef: "receipt",
      authorityRef: "plan",
      proofRefs: ["proof"],
      updatedAt: NOW,
    });
    const unrelated = createGieMemoryRecord({
      recordId: "unrelated",
      bucket: "task_history",
      subjectKey: "other",
      summary: "Other task.",
      confidence: 0.5,
      sourceRef: "receipt",
      authorityRef: "plan",
      proofRefs: ["proof"],
      updatedAt: NOW,
    });

    const retrieved = retrieveGieMemory({
      records: [approved, unrelated],
      subjectKey: "routing",
      now: NOW,
    });

    expect(retrieved.checked).toBe(true);
    expect(retrieved.records.map((item) => item.recordId)).toEqual(["approved"]);
  });

  it("blocks action when memory has not been checked", () => {
    const decision = evaluateGieMemoryBeforeAction({
      retrieval: {
        checked: false,
        subjectKey: "routing",
        records: [],
        staleRecords: [],
        approvedPatterns: [],
        rejectedPatterns: [],
      },
      liveProofRefs: ["live-proof"],
      authorityRefs: ["authority"],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("memory_before_action_required");
  });

  it("reuses approved patterns when current and proof-backed", () => {
    const approved = createGieMemoryRecord({
      recordId: "approved",
      bucket: "approved_best_practices",
      subjectKey: "routing",
      summary: "Use receipt-first closeout.",
      confidence: 0.9,
      sourceRef: "receipt",
      authorityRef: "plan",
      proofRefs: ["proof"],
      updatedAt: NOW,
    });
    const retrieval = retrieveGieMemory({ records: [approved], subjectKey: "routing", now: NOW });
    const decision = evaluateGieMemoryBeforeAction({
      retrieval,
      liveProofRefs: ["live-proof"],
      authorityRefs: ["authority"],
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reusePatternRefs).toEqual(["approved"]);
  });

  it("blocks rejected patterns even when live proof exists", () => {
    const rejected = createGieMemoryRecord({
      recordId: "rejected",
      bucket: "rejected_patterns",
      subjectKey: "routing",
      summary: "Claim closeout without verifier receipt.",
      confidence: 1,
      sourceRef: "issue-list",
      authorityRef: "plan",
      proofRefs: ["proof"],
      updatedAt: NOW,
    });
    const retrieval = retrieveGieMemory({ records: [rejected], subjectKey: "routing", now: NOW });
    const decision = evaluateGieMemoryBeforeAction({
      retrieval,
      liveProofRefs: ["live-proof"],
      authorityRefs: ["authority"],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("rejected_pattern_blocked");
    expect(decision.blockedPatternRefs).toEqual(["rejected"]);
  });

  it("does not let stale memory outrank live proof or authority", () => {
    const stale = createGieMemoryRecord({
      recordId: "stale-approved",
      bucket: "approved_best_practices",
      subjectKey: "routing",
      summary: "Old pattern.",
      confidence: 0.95,
      sourceRef: "old-memory",
      authorityRef: "old-plan",
      proofRefs: ["old-proof"],
      updatedAt: NOW - 90 * 24 * 60 * 60 * 1000,
    });
    const retrieval = retrieveGieMemory({ records: [stale], subjectKey: "routing", now: NOW });
    const decision = evaluateGieMemoryBeforeAction({
      retrieval,
      liveProofRefs: ["live-proof"],
      authorityRefs: ["current-authority"],
    });

    expect(retrieval.staleRecords.map((item) => item.recordId)).toEqual(["stale-approved"]);
    expect(decision.allowed).toBe(true);
    expect(decision.reusePatternRefs).toEqual([]);
    expect(decision.staleMemoryOverriddenByLiveProof).toBe(true);
  });
});
