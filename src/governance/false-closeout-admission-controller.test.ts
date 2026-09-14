import { describe, expect, it } from "vitest";
import {
  evaluateFalseCloseoutAdmission,
  resolveFalseCloseoutAdmissionMode,
} from "./false-closeout-admission-controller.js";
import type {
  AcceptanceGate,
  CloseoutAdmissionInput,
  EvidenceReceipt,
  MissionIdentity,
  MissionManifest,
  RequirementManifestItem,
} from "./mission-manifest.types.js";

const identity: MissionIdentity = {
  missionId: "mission-false-closeout",
  planRevisionId: "plan-r1",
  planSha256: "plan-sha",
  sourceRevision: "source-sha",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "policy-v1",
  skillSha256: "skill-sha",
};

const manifest: MissionManifest = {
  schema: "openclaw.mission_manifest.v1",
  ...identity,
  mode: "shadow",
  scopeHash: "scope-full",
  authorizedScopeHash: "scope-full",
  planRevisionAuthorized: true,
  createdAt: "2026-07-16T18:00:00Z",
};

const terminalPendingBinding = {
  requestedTransition: "terminal_pending_watchdog -> COMPLETE" as const,
  previousDecisionReceiptSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  transitionalWatchdogReceiptSha256:
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  parentExecutorSnapshotSha256: "1111111111111111111111111111111111111111111111111111111111111111",
};

const requirements: RequirementManifestItem[] = [
  {
    id: "REQ-FCAC-001",
    text: "all controlling requirements must pass",
    required: true,
    gateIds: ["gate-requirements"],
  },
  {
    id: "REQ-FCAC-002",
    text: "rollback and restoration proof required",
    required: true,
    gateIds: ["gate-rollback"],
    dependsOn: ["REQ-FCAC-001"],
  },
];

const gates: AcceptanceGate[] = [
  { id: "gate-requirements", requirementId: "REQ-FCAC-001", kind: "requirement", required: true },
  { id: "gate-rollback", requirementId: "REQ-FCAC-002", kind: "rollback", required: true },
];

function receipt(gateId: string, overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt {
  return {
    schema: "openclaw.evidence_receipt.v1",
    ...identity,
    receiptId: `receipt-${gateId}`,
    gateId,
    status: "passed",
    producedAt: "2026-07-16T18:01:00Z",
    artifactSha256: "artifact-sha",
    ...overrides,
  };
}

function validInput(overrides: Partial<CloseoutAdmissionInput> = {}): CloseoutAdmissionInput {
  return {
    manifest,
    requirements,
    gates,
    receipts: [receipt("gate-requirements"), receipt("gate-rollback")],
    testManifest: {
      schema: "openclaw.test_manifest.v1",
      ...identity,
      requestedFiles: ["a.test.ts", "b.test.ts"],
      expectedTotal: 3,
    },
    testResults: [
      { file: "a.test.ts", passed: 1, failed: 0 },
      { file: "b.test.ts", passed: 2, failed: 0 },
    ],
    rollbackReceipt: {
      schema: "openclaw.rollback_receipt.v1",
      ...identity,
      executed: true,
      producedAt: "2026-07-16T18:02:00Z",
      targetStateSha256: "rollback-state",
    },
    restorationReceipt: {
      schema: "openclaw.restoration_receipt.v1",
      ...identity,
      executed: true,
      producedAt: "2026-07-16T18:03:00Z",
      restoredStateSha256: "restored-state",
    },
    grantApproval: {
      schema: "openclaw.grant_approval.v1",
      ...identity,
      approved: true,
      approvedAt: "2026-07-16T18:04:00Z",
      evidenceManifestSha256: "evidence-manifest-sha",
      reviewer: "Grant",
    },
    exportManifest: {
      schema: "openclaw.export_manifest.v1",
      ...identity,
      items: [
        { path: "/exports/evidence.json", sha256: "export-sha", sizeBytes: 12, required: true },
      ],
    },
    runtimeState: {
      parentStatus: "terminal",
      activeExecutorCount: 0,
      staleExecutorCount: 0,
      openSessionCount: 0,
      openRunCount: 0,
      openLeaseCount: 0,
      openContinuationCount: 0,
      pendingDeliveryCount: 0,
    },
    watchdog: {
      label: "CLEAN",
      suspiciousCount: 0,
      checkedAt: "2026-07-16T18:05:00Z",
      postTerminal: true,
    },
    repairWork: { openCount: 0, openIds: [] },
    completionRequest: {
      schema: "openclaw.completion_request.v1",
      ...identity,
      requestedAt: "2026-07-16T18:06:00Z",
      claimedScopeHash: "scope-full",
      closeoutText: "complete",
      evidenceManifestSha256: "evidence-manifest-sha",
    },
    nextExecutableStepExists: false,
    reportContradictions: [],
    now: "2026-07-16T18:07:00Z",
    ...overrides,
  };
}

describe("false-closeout admission controller", () => {
  it("passes a valid complete mission in shadow mode", () => {
    const decision = evaluateFalseCloseoutAdmission(validInput());

    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe("shadow_would_allow_terminal_pending_watchdog");
    expect(decision.rejectionCodes).toEqual([]);
  });

  it("rejects milestone completion, silent scope narrowing, missing gates, and next executable work", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        manifest: { ...manifest, scopeHash: "scope-full", authorizedScopeHash: "scope-old" },
        requirements: [{ id: "REQ-MISSING", text: "must have gate", required: true, gateIds: [] }],
        gates: [],
        completionRequest: {
          ...validInput().completionRequest,
          claimedScopeHash: "scope-narrowed",
        },
        nextExecutableStepExists: true,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_SCOPE_NARROWED",
        "FCAC_PLAN_REVISION_UNAUTHORIZED",
        "FCAC_REQUIREMENT_HAS_NO_GATE",
        "FCAC_NEXT_EXECUTABLE_STEP_EXISTS",
      ]),
    );
  });

  it("rejects stale evidence bound to another revision", () => {
    const staleIdentity = { ...identity, planRevisionId: "old-plan" };
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        receipts: [receipt("gate-requirements", staleIdentity), receipt("gate-rollback")],
        grantApproval: {
          ...validInput().grantApproval!,
          planRevisionId: "old-plan",
        },
      }),
    );

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining(["FCAC_EVIDENCE_BOUND_TO_OTHER_REVISION"]),
    );
    expect(decision.rejectionCodes).not.toContain("FCAC_GRANT_STALE_OR_MISSING");
  });

  it("rejects partial tests and requested/executed file count mismatch", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        testManifest: {
          ...validInput().testManifest!,
          requestedFiles: [
            "a.test.ts",
            "b.test.ts",
            "c.test.ts",
            "d.test.ts",
            "e.test.ts",
            "f.test.ts",
            "g.test.ts",
          ],
          expectedTotal: 7,
        },
        testResults: [
          { file: "a.test.ts", passed: 1, failed: 0 },
          { file: "b.test.ts", passed: 1, failed: 0 },
          { file: "c.test.ts", passed: 1, failed: 0 },
          { file: "d.test.ts", passed: 1, failed: 0 },
        ],
      }),
    );

    expect(decision.rejectionCodes).toContain("FCAC_TEST_MANIFEST_MISMATCH");
  });

  it("rejects rollback metadata without execution and rollback without restoration", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        rollbackReceipt: {
          ...validInput().rollbackReceipt!,
          executed: false,
        },
        restorationReceipt: undefined,
      }),
    );

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_ROLLBACK_MISSING_OR_INVALID",
        "FCAC_RESTORATION_MISSING_OR_INVALID",
      ]),
    );
  });

  it("rejects running parent, active executor, missing post-terminal watchdog, and open repair work", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        runtimeState: {
          ...validInput().runtimeState,
          parentStatus: "running",
          activeExecutorCount: 1,
          openRunCount: 1,
        },
        watchdog: {
          label: "CLEAN",
          suspiciousCount: 0,
          checkedAt: "2026-07-16T18:05:00Z",
          postTerminal: false,
        },
        repairWork: { openCount: 1, openIds: ["f1049bed34711a6afa060e1d"] },
        completionRequest: {
          ...validInput().completionRequest,
          ...terminalPendingBinding,
        },
      }),
    );

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_PARENT_RUNNING",
        "FCAC_EXECUTOR_RUNNING_OR_STALE",
        "FCAC_REPORT_RUNTIME_CONTRADICTION",
        "FCAC_POST_TERMINAL_WATCHDOG_MISSING",
        "FCAC_REPAIR_OPEN",
      ]),
    );
  });

  it("rejects clean watchdog if the mission is still incomplete or report contradicts runtime", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        runtimeState: {
          ...validInput().runtimeState,
          parentStatus: "running",
        },
        reportContradictions: ["closeout says complete while parent flow is running"],
        completionRequest: {
          ...validInput().completionRequest,
          ...terminalPendingBinding,
        },
      }),
    );

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining(["FCAC_PARENT_RUNNING", "FCAC_REPORT_RUNTIME_CONTRADICTION"]),
    );
  });

  it("rejects missing exports and missing hashes", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        exportManifest: {
          ...validInput().exportManifest!,
          items: [{ path: "/exports/evidence.json", required: true }],
        },
      }),
    );

    expect(decision.rejectionCodes).toContain("FCAC_EXPORT_MANIFEST_INCOMPLETE");
  });

  it("rejects the known premature cleanup-watchdog closeout pattern", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        testResults: [{ file: "a.test.ts", passed: 1, failed: 0 }],
        rollbackReceipt: undefined,
        restorationReceipt: undefined,
        grantApproval: {
          ...validInput().grantApproval!,
          evidenceManifestSha256: "old-evidence-manifest",
        },
        runtimeState: {
          ...validInput().runtimeState,
          parentStatus: "running",
          activeExecutorCount: 1,
        },
        watchdog: {
          label: "NEEDS_REVIEW",
          suspiciousCount: 2,
          checkedAt: "2026-07-16T16:53:57Z",
          postTerminal: false,
        },
        repairWork: { openCount: 1, openIds: ["f1049bed34711a6afa060e1d"] },
        nextExecutableStepExists: true,
        reportContradictions: ["report states closed while watchdog receipt requires repair"],
        completionRequest: {
          ...validInput().completionRequest,
          claimedScopeHash: "main-repair-only",
          ...terminalPendingBinding,
        },
      }),
    );

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_SCOPE_NARROWED",
        "FCAC_TEST_MANIFEST_MISMATCH",
        "FCAC_ROLLBACK_MISSING_OR_INVALID",
        "FCAC_RESTORATION_MISSING_OR_INVALID",
        "FCAC_PARENT_RUNNING",
        "FCAC_EXECUTOR_RUNNING_OR_STALE",
        "FCAC_REPAIR_OPEN",
        "FCAC_WATCHDOG_NOT_CLEAN",
        "FCAC_POST_TERMINAL_WATCHDOG_MISSING",
        "FCAC_NEXT_EXECUTABLE_STEP_EXISTS",
        "FCAC_REPORT_RUNTIME_CONTRADICTION",
      ]),
    );
  });

  it("rejects canceled approval stalls instead of treating them as closeout", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        grantApproval: undefined,
        nextExecutableStepExists: true,
        reportContradictions: ["approval request was canceled before evidence review completed"],
      }),
    );

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_NEXT_EXECUTABLE_STEP_EXISTS",
        "FCAC_REPORT_RUNTIME_CONTRADICTION",
      ]),
    );
    expect(decision.rejectionCodes).not.toContain("FCAC_GRANT_STALE_OR_MISSING");
  });

  it("rejects restart-time stale runtime evidence bound to a previous build", () => {
    const staleRuntimeIdentity = { ...identity, runtimeBuildSha256: "previous-runtime-sha" };
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        receipts: [
          receipt("gate-requirements", staleRuntimeIdentity),
          receipt("gate-rollback", staleRuntimeIdentity),
        ],
        grantApproval: {
          ...validInput().grantApproval!,
          runtimeBuildSha256: "previous-runtime-sha",
        },
      }),
    );

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining(["FCAC_EVIDENCE_BOUND_TO_OTHER_REVISION"]),
    );
    expect(decision.rejectionCodes).not.toContain("FCAC_GRANT_STALE_OR_MISSING");
  });

  it("rejects worker loss during reviewer handoff", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        runtimeState: {
          ...validInput().runtimeState,
          staleExecutorCount: 1,
          openSessionCount: 1,
          openLeaseCount: 1,
        },
        reportContradictions: ["review handoff lost the backing worker session"],
        completionRequest: {
          ...validInput().completionRequest,
          ...terminalPendingBinding,
        },
      }),
    );

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_EXECUTOR_RUNNING_OR_STALE",
        "FCAC_REPORT_RUNTIME_CONTRADICTION",
      ]),
    );
  });

  it("rejects manual settlement and report-only recovery without receipts", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        receipts: [],
        repairWork: { openCount: 1, openIds: ["manual-settlement-not-supported"] },
        reportContradictions: ["operator-facing report claimed settlement without repair receipt"],
      }),
    );

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_REQUIREMENT_MISSING_RECEIPT",
        "FCAC_REPAIR_OPEN",
        "FCAC_REPORT_RUNTIME_CONTRADICTION",
      ]),
    );
  });

  it("rejects synthetic canary evidence substituted for real mission proof", () => {
    const syntheticIdentity = { ...identity, missionId: "synthetic-canary" };
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        receipts: [receipt("gate-requirements", syntheticIdentity), receipt("gate-rollback")],
      }),
    );

    expect(decision.rejectionCodes).toContain("FCAC_EVIDENCE_BOUND_TO_OTHER_REVISION");
  });

  it("keeps legitimate external waits and owner decisions open instead of complete", () => {
    const externalWait = evaluateFalseCloseoutAdmission(
      validInput({
        runtimeState: { ...validInput().runtimeState, parentStatus: "waiting" },
        reportContradictions: ["mission is waiting on external owner approval"],
        completionRequest: {
          ...validInput().completionRequest,
          ...terminalPendingBinding,
        },
      }),
    );
    const ownerDecision = evaluateFalseCloseoutAdmission(
      validInput({
        runtimeState: { ...validInput().runtimeState, parentStatus: "blocked" },
        reportContradictions: ["mission is blocked on an explicit owner decision"],
        completionRequest: {
          ...validInput().completionRequest,
          ...terminalPendingBinding,
        },
      }),
    );

    expect(externalWait.allowed).toBe(false);
    expect(ownerDecision.allowed).toBe(false);
    expect(externalWait.rejectionCodes).toEqual(
      expect.arrayContaining(["FCAC_PARENT_RUNNING", "FCAC_REPORT_RUNTIME_CONTRADICTION"]),
    );
    expect(ownerDecision.rejectionCodes).toEqual(
      expect.arrayContaining(["FCAC_PARENT_RUNNING", "FCAC_REPORT_RUNTIME_CONTRADICTION"]),
    );
  });

  it("allows true exhaustion only when all terminal gates and evidence are current", () => {
    const decision = evaluateFalseCloseoutAdmission(validInput());

    expect(decision.allowed).toBe(true);
    expect(decision.rejectionCodes).toEqual([]);
  });

  it("allows only terminal-pending admission before the watchdog transition", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        runtimeState: {
          ...validInput().runtimeState,
          parentStatus: "running",
          activeExecutorCount: 1,
          openRunCount: 1,
        },
        watchdog: {
          label: "UNKNOWN",
          suspiciousCount: 1,
          checkedAt: "2026-07-16T18:05:00Z",
          postTerminal: false,
        },
        completionRequest: {
          ...validInput().completionRequest,
          requestedTransition: "completion_request -> terminal_pending_watchdog",
        },
      }),
    );

    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe("shadow_would_allow_terminal_pending_watchdog");
    expect(decision.authorizedTransition).toBeUndefined();
  });

  it("authorizes true COMPLETE only from terminal-pending with bound watchdog and snapshot evidence", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        manifest: { ...manifest, mode: "enforce" },
        runtimeState: {
          ...validInput().runtimeState,
          parentStatus: "terminal_pending_watchdog",
        },
        completionRequest: {
          ...validInput().completionRequest,
          ...terminalPendingBinding,
        },
      }),
    );

    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe("complete");
    expect(decision.authorizedTransition).toBe("terminal_pending_watchdog -> COMPLETE");
  });

  it("does not require pre-COMPLETE Grant approval for the receipt that Grant must review", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        manifest: { ...manifest, mode: "enforce" },
        grantApproval: undefined,
        runtimeState: {
          ...validInput().runtimeState,
          parentStatus: "terminal_pending_watchdog",
        },
        completionRequest: {
          ...validInput().completionRequest,
          ...terminalPendingBinding,
        },
      }),
    );

    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe("complete");
    expect(decision.rejectionCodes).not.toContain("FCAC_GRANT_STALE_OR_MISSING");
    expect(decision.authorizedTransition).toBe("terminal_pending_watchdog -> COMPLETE");
  });

  it("does not require Grant approval before terminal-pending admission", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        manifest: { ...manifest, mode: "enforce" },
        grantApproval: undefined,
        completionRequest: {
          ...validInput().completionRequest,
          requestedTransition: "completion_request -> terminal_pending_watchdog",
        },
      }),
    );

    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe("terminal_pending_watchdog");
    expect(decision.rejectionCodes).not.toContain("FCAC_GRANT_STALE_OR_MISSING");
    expect(decision.authorizedTransition).toBe("completion_request -> terminal_pending_watchdog");
  });

  it("blocks final COMPLETE when terminal-pending receipt, watchdog, or snapshot bindings are missing", () => {
    const decision = evaluateFalseCloseoutAdmission(
      validInput({
        manifest: { ...manifest, mode: "enforce" },
        runtimeState: {
          ...validInput().runtimeState,
          parentStatus: "terminal_pending_watchdog",
        },
        completionRequest: {
          ...validInput().completionRequest,
          requestedTransition: "terminal_pending_watchdog -> COMPLETE",
        },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_TERMINAL_PENDING_RECEIPT_MISSING",
        "FCAC_TRANSITIONAL_WATCHDOG_BINDING_MISSING",
        "FCAC_PARENT_EXECUTOR_SNAPSHOT_MISSING",
      ]),
    );
  });

  it("resolves the feature-flag mode to shadow, enforce, or off with shadow fallback", () => {
    expect(resolveFalseCloseoutAdmissionMode("shadow")).toBe("shadow");
    expect(resolveFalseCloseoutAdmissionMode("enforce")).toBe("enforce");
    expect(resolveFalseCloseoutAdmissionMode("off")).toBe("off");
    expect(resolveFalseCloseoutAdmissionMode(undefined)).toBe("shadow");
    expect(resolveFalseCloseoutAdmissionMode("bogus")).toBe("shadow");
  });
});
