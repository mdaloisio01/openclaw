import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLEANUP_CREW_ADVISORY_RECEIPT_SCHEMA,
  CLEANUP_CREW_ENFORCEMENT_DECISION_SCHEMA,
  CLEANUP_CREW_RUNTIME_BOUNDARIES,
  CLEANUP_CREW_RUNTIME_GATE_IDS,
  evaluateCleanupCrewRuntimeAdvisory,
  evaluateCleanupCrewRuntimeEnforcement,
  summarizeCleanupCrewRuntimeAdvisoryReceipts,
  type CleanupCrewRuntimeAdvisoryInput,
  type CleanupCrewRuntimeEnforcementDecisionRecord,
  type CleanupCrewRuntimeMissionContract,
} from "./cleanup-crew-runtime-enforcement.js";
import {
  CLEANUP_WATCHDOG_CLEAN_DIMENSIONS,
  CLEANUP_WATCHDOG_POLICY_VERSION,
} from "./cleanup-watchdog-policy.js";

const contract: CleanupCrewRuntimeMissionContract = {
  missionId: "cleanupcrew-sop-runtime-enforcement",
  controllingPlanRef: "cleanupcrew_sop_runtime_enforcement_build_plan_2026-08-28T1102PDT.md",
  lawfulOwner: "Cleanup Crew",
  allowedTools: ["functions.apply_patch", "functions.exec_command", "openclaw.session_status"],
  forbiddenTools: ["raw_db_edit", "gateway.force_restart"],
  allowedPaths: ["/home/will/openclaw-source/src/governance"],
  forbiddenPaths: ["/home/will/openclaw-source/var/raw-db"],
  requiredProof: ["focused_tests", "watchdog_clean", "report_delivered"],
  doneCriteria: ["all_gates_pass", "final_report_delivered"],
  stopConditions: ["authority_conflict", "raw_db_mutation_required"],
  requiredReportMoments: ["milestone", "final"],
  continuationRequired: true,
  watchdogCleanDimensions: [...CLEANUP_WATCHDOG_CLEAN_DIMENSIONS],
  policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
};

function allGreen() {
  return {
    contract,
    toolPreflight: {
      toolName: "functions.apply_patch",
      targetPath: "/home/will/openclaw-source/src/governance/cleanup-crew-runtime-enforcement.ts",
      riskClasses: ["write", "file-write"],
      mutation: true,
      activeMissionScopePresent: true,
      controllingBuildPlanPresent: true,
      permissionMode: "scoped_write" as const,
      idempotencyKeyPresent: true,
      rollbackProofPreserved: true,
      approvalClassSatisfied: true,
      lawfulOwnerMatched: true,
    },
    toolResult: {
      status: "passed" as const,
      proofPresent: true,
    },
    report: {
      reportRequired: true,
      reportArtifactPath: "/exports/closeout.md",
      chatDeliveryVerified: true,
    },
    continuation: {
      broaderMissionOpen: true,
      reportDelivered: true,
      nextExecutableAction: "run next Cleanup Crew validation harness",
    },
    watchdog: {
      suspiciousCount: 0,
      dimensions: Object.fromEntries(CLEANUP_WATCHDOG_CLEAN_DIMENSIONS.map((key) => [key, true])),
      duplicateSuppressedOnlyChat: true,
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    },
    runtimeProof: {
      runtimeChangeRequired: true,
      activeWorkPreflightPassed: true,
      restartDeferralStatus: "not_deferred" as const,
      controllingPlanPresent: true,
      restartCheckpointCreated: true,
      restartHandoffCheckpointCreated: true,
      allowedRestartMode: "safe" as const,
      restartRequestStatus: "scheduled" as const,
      postRestartResumeProofPresent: true,
      sourceRevision: "5134da5",
      buildRevision: "5134da5",
      liveRuntimeRevision: "5134da5",
      postRestartAssetGuardPassed: true,
      taskAuditPassed: true,
      blockedFlowProofPassed: true,
    },
    handoff: {
      childExecutionRequested: true,
      parentMissionContractInherited: true,
      childScopeWithinParent: true,
      parentCoverageValid: true,
      lawfulNextOwner: "Engineering Delivery",
      exactNextAction: "resume post-restart Slice 5 validation",
      proofRefs: ["activation-continuations.json:activation-live"],
      openClosedTruth: "open" as const,
    },
    traceEval: {
      required: true,
      tracesCaptured: true,
      replayCasesPassed: true,
      promptInjectionCasesPassed: true,
    },
  };
}

const advisoryAction: CleanupCrewRuntimeAdvisoryInput["action"] = {
  id: "slice-1-canary",
  kind: "tool_preflight",
  target: "functions.apply_patch",
};
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Cleanup Crew runtime enforcement", () => {
  it("maps every Cleanup Crew runtime boundary without enabling behavior changes in Slice 0", () => {
    expect(CLEANUP_CREW_RUNTIME_BOUNDARIES.map((boundary) => boundary.id)).toEqual(
      CLEANUP_CREW_RUNTIME_GATE_IDS,
    );
    expect(CLEANUP_CREW_RUNTIME_BOUNDARIES).toHaveLength(9);
    expect(CLEANUP_CREW_RUNTIME_BOUNDARIES[0]).toMatchObject({
      id: "mission_admission",
      firstImplementationSlice: 0,
      behaviorChangingBeforeSlice: false,
    });

    for (const boundary of CLEANUP_CREW_RUNTIME_BOUNDARIES) {
      expect(boundary.label).not.toBe("");
      expect(boundary.runtimeOwner).not.toBe("");
      expect(boundary.purpose).not.toBe("");
      expect(boundary.sourceRefs.length).toBeGreaterThan(0);
      expect(
        boundary.sourceRefs.every((ref) => ref.startsWith("src/") || ref.startsWith("scripts/")),
      ).toBe(true);
    }
  });

  it("defines a shared decision record with mode, boundary, action, proof, policy, and audit sink", () => {
    const decision = {
      schema: CLEANUP_CREW_ENFORCEMENT_DECISION_SCHEMA,
      mode: "advisory",
      boundary: "tool_preflight",
      action: {
        id: "action-1",
        kind: "tool_preflight",
        target: "functions.exec_command",
      },
      decision: "would_block",
      reason: "mutation lacks Slice 2 preflight proof",
      proof: [
        {
          kind: "authority",
          ref: "/home/will/.openclaw/workspace/file_hub/exports/cleanup_crew_runtime_enforcement_integration_build_package_2026-08-29T0406Z.md",
        },
        {
          kind: "source",
          ref: "src/agents/agent-tools.before-tool-call.ts",
        },
      ],
      sourcePolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      auditSink: {
        kind: "none_slice_0",
        ref: "Slice 0 defines shape only; advisory ledger starts in Slice 1.",
      },
      evaluatedAt: "2026-08-29T04:45:00Z",
    } satisfies CleanupCrewRuntimeEnforcementDecisionRecord;

    expect(decision).toMatchObject({
      schema: "openclaw.cleanup_crew_enforcement_decision.v1",
      mode: "advisory",
      boundary: "tool_preflight",
      decision: "would_block",
      sourcePolicyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      auditSink: { kind: "none_slice_0" },
    });
    expect(decision.action.kind).toBe(decision.boundary);
    expect(decision.proof.map((proof) => proof.kind)).toEqual(["authority", "source"]);
  });

  it("emits a non-blocking advisory receipt for a good-work canary", () => {
    const receipt = evaluateCleanupCrewRuntimeAdvisory({
      facts: allGreen(),
      action: advisoryAction,
      evaluatedAt: "2026-08-29T05:10:00Z",
      canary: {
        id: "good-work-canary",
        kind: "good_work_canary",
        expectation: "would_allow",
      },
    });

    expect(receipt).toMatchObject({
      schema: CLEANUP_CREW_ADVISORY_RECEIPT_SCHEMA,
      mode: "advisory",
      advisoryOnly: true,
      executionAllowed: true,
      decisionRecord: {
        mode: "advisory",
        decision: "would_allow",
        boundary: "tool_preflight",
      },
      canary: {
        kind: "good_work_canary",
        actualDecision: "would_allow",
        accuracy: "matched_expectation",
      },
      falsePositiveMarker: false,
      falseNegativeMarker: false,
    });
    expect(receipt.enforcementEvaluation.allowedToAdvance).toBe(true);
  });

  it("flags a bad-work canary as would_block while still allowing execution in advisory mode", () => {
    const receipt = evaluateCleanupCrewRuntimeAdvisory({
      facts: {
        ...allGreen(),
        toolPreflight: {
          toolName: "raw_db_edit",
          targetPath: "/home/will/openclaw-source/var/raw-db/tasks.sqlite",
          mutation: true,
          idempotencyKeyPresent: false,
          rollbackProofPreserved: false,
          approvalClassSatisfied: true,
          lawfulOwnerMatched: true,
        },
      },
      action: {
        ...advisoryAction,
        id: "bad-work-canary",
        target: "raw_db_edit",
      },
      evaluatedAt: "2026-08-29T05:11:00Z",
      canary: {
        id: "bad-work-canary",
        kind: "bad_work_canary",
        expectation: "would_block",
      },
    });

    expect(receipt.executionAllowed).toBe(true);
    expect(receipt.decisionRecord).toMatchObject({
      mode: "advisory",
      boundary: "tool_preflight",
      decision: "would_block",
    });
    expect(receipt.failedGate).toMatchObject({
      gate: "tool_preflight",
      state: "fail",
      obligations: expect.arrayContaining(["deny_mutation"]),
    });
    expect(receipt.canary).toMatchObject({
      kind: "bad_work_canary",
      actualDecision: "would_block",
      accuracy: "matched_expectation",
    });
  });

  it("routes watchdog NEEDS_REVIEW to advisory require_review without blocking execution", () => {
    const receipt = evaluateCleanupCrewRuntimeAdvisory({
      facts: {
        ...allGreen(),
        watchdog: {
          suspiciousCount: 1,
          needsReview: true,
          dimensions: {},
          duplicateSuppressedOnlyChat: false,
          policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
        },
      },
      action: {
        id: "watchdog-needs-review",
        kind: "watchdog_clean",
        target: "var/system_wide_active_work_watchdog/latest.json",
      },
      evaluatedAt: "2026-08-29T05:12:00Z",
    });

    expect(receipt.executionAllowed).toBe(true);
    expect(receipt.decisionRecord.decision).toBe("require_review");
    expect(receipt.failedGate).toMatchObject({
      gate: "watchdog_clean",
      obligations: expect.arrayContaining(["route_watchdog_needs_review"]),
    });
  });

  it("marks advisory false positives and false negatives for later shadow proof", () => {
    const falsePositive = evaluateCleanupCrewRuntimeAdvisory({
      facts: {
        ...allGreen(),
        toolResult: { status: "ambiguous", proofPresent: false },
      },
      action: advisoryAction,
      evaluatedAt: "2026-08-29T05:13:00Z",
      canary: {
        id: "expected-good",
        kind: "shadow_observation",
        expectation: "would_allow",
      },
    });
    const falseNegative = evaluateCleanupCrewRuntimeAdvisory({
      facts: allGreen(),
      action: advisoryAction,
      evaluatedAt: "2026-08-29T05:14:00Z",
      canary: {
        id: "expected-bad",
        kind: "shadow_observation",
        expectation: "would_block",
      },
    });

    expect(falsePositive).toMatchObject({
      falsePositiveMarker: true,
      falseNegativeMarker: false,
      canary: { accuracy: "false_positive" },
    });
    expect(falseNegative).toMatchObject({
      falsePositiveMarker: false,
      falseNegativeMarker: true,
      canary: { accuracy: "false_negative" },
    });
  });

  it("summarizes advisory receipts without reading or writing a live ledger", () => {
    const receipts = [
      evaluateCleanupCrewRuntimeAdvisory({
        facts: allGreen(),
        action: advisoryAction,
        evaluatedAt: "2026-08-29T05:15:00Z",
      }),
      evaluateCleanupCrewRuntimeAdvisory({
        facts: {
          ...allGreen(),
          toolResult: { status: "failed", proofPresent: false },
        },
        action: advisoryAction,
        evaluatedAt: "2026-08-29T05:16:00Z",
      }),
    ];

    expect(summarizeCleanupCrewRuntimeAdvisoryReceipts(receipts)).toEqual({
      schema: "openclaw.cleanup_crew_advisory_summary.v1",
      total: 2,
      wouldAllow: 1,
      wouldBlock: 1,
      requireReview: 0,
      falsePositiveMarkers: 0,
      falseNegativeMarkers: 0,
    });
  });

  it("prints read-only advisory status from receipt JSON on stdin", () => {
    const receipts = [
      evaluateCleanupCrewRuntimeAdvisory({
        facts: allGreen(),
        action: advisoryAction,
        evaluatedAt: "2026-08-29T05:17:00Z",
      }),
      evaluateCleanupCrewRuntimeAdvisory({
        facts: {
          ...allGreen(),
          watchdog: {
            suspiciousCount: 1,
            needsReview: true,
            dimensions: {},
            duplicateSuppressedOnlyChat: false,
            policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
          },
        },
        action: {
          id: "reader-needs-review",
          kind: "watchdog_clean",
          target: "var/system_wide_active_work_watchdog/latest.json",
        },
        evaluatedAt: "2026-08-29T05:18:00Z",
      }),
    ];

    const result = spawnSync(process.execPath, ["scripts/cleanup-crew-advisory-summary.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: JSON.stringify({ receipts }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("status: advisory_attention");
    expect(result.stdout).toContain("would_allow: 1");
    expect(result.stdout).toContain("require_review: 1");
    expect(result.stdout).toContain("execution_effect: advisory_only_no_block");
  });

  it("prints advisory summary JSON from a receipt file without changing advisory execution", () => {
    const receipt = evaluateCleanupCrewRuntimeAdvisory({
      facts: {
        ...allGreen(),
        toolResult: { status: "failed", proofPresent: false },
      },
      action: advisoryAction,
      evaluatedAt: "2026-08-29T05:19:00Z",
    });
    const dir = mkdtempSync(path.join(tmpdir(), "cleanup-crew-advisory-reader-"));
    const file = path.join(dir, "receipt.json");
    writeFileSync(file, JSON.stringify(receipt), "utf8");

    const result = spawnSync(
      process.execPath,
      ["scripts/cleanup-crew-advisory-summary.mjs", "--file", file, "--json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(receipt.executionAllowed).toBe(true);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "openclaw.cleanup_crew_advisory_summary.v1",
      total: 1,
      wouldAllow: 0,
      wouldBlock: 1,
      requireReview: 0,
      falsePositiveMarkers: 0,
      falseNegativeMarkers: 0,
    });
  });

  it("allows advance and close only when every runtime gate passes", () => {
    expect(evaluateCleanupCrewRuntimeEnforcement(allGreen())).toMatchObject({
      allowedToAdvance: true,
      allowedToCloseMission: true,
      nextAction: "continue_cleanup_crew_execution",
    });
  });

  it("fails closed when the mission contract is missing", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({ ...allGreen(), contract: undefined });

    expect(decision.allowedToAdvance).toBe(false);
    expect(decision.gates[0]).toMatchObject({
      gate: "mission_admission",
      state: "fail",
      obligations: expect.arrayContaining(["missing:contract", "deny_cleanup_crew_start"]),
    });
  });

  it("blocks mutation when the tool is off plan or proof cannot be preserved", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      toolPreflight: {
        toolName: "raw_db_edit",
        targetPath: "/home/will/openclaw-source/var/raw-db/tasks.sqlite",
        mutation: true,
        idempotencyKeyPresent: false,
        rollbackProofPreserved: false,
        approvalClassSatisfied: true,
        lawfulOwnerMatched: true,
      },
    });

    expect(decision.allowedToAdvance).toBe(false);
    expect(decision.gates.find((gate) => gate.gate === "tool_preflight")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "forbidden_tool",
        "tool_not_allowlisted",
        "forbidden_path",
        "path_not_allowlisted",
        "missing_idempotency_key",
        "rollback_or_proof_not_preserved",
        "deny_mutation",
      ]),
    });
  });

  it("treats interrupted or unproven tool results as recovery work", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      toolResult: { status: "interrupted", proofPresent: false },
    });

    expect(decision.gates.find((gate) => gate.gate === "tool_result")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining(["route_cleanup_crew_recovery", "deny_closeout"]),
    });
  });

  it("keeps artifact-only reports open until delivery is verified", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      report: {
        reportRequired: true,
        reportArtifactPath: "/exports/closeout.md",
        chatDeliveryVerified: false,
        deliveryFailureVisible: true,
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "report_delivery")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "create_or_update_pending_delivery_obligation",
        "keep_delivery_failure_visible",
        "deny_closeout",
      ]),
    });
  });

  it("blocks post-report terminal stop while the broader mission is still open", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      continuation: {
        broaderMissionOpen: true,
        reportDelivered: true,
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "post_report_continuation")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "dispatch_next_executable_action",
        "or_record_durable_coverage",
        "deny_terminal_stop",
      ]),
    });
  });

  it("rejects watchdog clean claims with any missing dimension or NEEDS_REVIEW action", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      watchdog: {
        suspiciousCount: 1,
        needsReview: true,
        dimensions: {
          record_integrity: true,
          worker_coverage: true,
          continuation_readiness: true,
          delivery_completeness: false,
          runtime_health: true,
          repair_closure: true,
          policy_version: true,
        },
        duplicateSuppressedOnlyChat: false,
        policyVersion: "old-policy",
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "watchdog_clean")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "route_watchdog_needs_review",
        "suspicious_count_not_zero",
        "missing_clean_dimension:delivery_completeness",
        "policy_version_mismatch",
        "duplicate_suppression_must_not_suppress_action",
        "rerun_watchdog_after_repair",
      ]),
    });
  });

  it("rejects build-only runtime activation proof", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      runtimeProof: {
        runtimeChangeRequired: true,
        sourceRevision: "new",
        buildRevision: "new",
        liveRuntimeRevision: "old",
        postRestartAssetGuardPassed: false,
        taskAuditPassed: false,
        blockedFlowProofPassed: false,
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "live_runtime_proof")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "active_work_preflight_missing",
        "restart_deferral_not_clear",
        "controlling_plan_missing",
        "pre_restart_checkpoint_missing",
        "restart_handoff_checkpoint_missing",
        "allowed_restart_mode_missing",
        "restart_request_status_missing",
        "post_restart_resume_proof_missing",
        "source_build_runtime_revision_mismatch",
        "post_restart_asset_guard_missing",
        "post_restart_task_audit_missing",
        "post_restart_blocked_flow_proof_missing",
        "deny_runtime_closeout",
      ]),
    });
  });

  it("passes restart proof only after preflight, checkpoint, allowed mode, resume, and identity all pass", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      runtimeProof: {
        runtimeChangeRequired: true,
        activeWorkPreflightPassed: true,
        restartDeferralStatus: "not_deferred",
        controllingPlanPresent: true,
        restartCheckpointCreated: true,
        restartHandoffCheckpointCreated: true,
        allowedRestartMode: "safe_skip_deferral",
        restartRequestStatus: "scheduled",
        postRestartResumeProofPresent: true,
        sourceRevision: "abc123",
        buildRevision: "abc123",
        liveRuntimeRevision: "abc123",
        postRestartAssetGuardPassed: true,
        taskAuditPassed: true,
        blockedFlowProofPassed: true,
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "live_runtime_proof")).toMatchObject({
      state: "pass",
      obligations: [],
    });
  });

  it("blocks restart closeout while active work deferral has not cleared", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      runtimeProof: {
        ...allGreen().runtimeProof,
        restartDeferralStatus: "deferred",
      },
    });

    expect(decision.allowedToCloseMission).toBe(false);
    expect(decision.gates.find((gate) => gate.gate === "live_runtime_proof")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining(["restart_deferral_not_clear", "deny_runtime_closeout"]),
    });
  });

  it("blocks restart closeout when preflight proof is stale", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      runtimeProof: {
        ...allGreen().runtimeProof,
        activeWorkPreflightPassed: false,
        restartDeferralStatus: "stale",
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "live_runtime_proof")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "active_work_preflight_missing",
        "restart_preflight_stale",
        "deny_runtime_closeout",
      ]),
    });
  });

  it("requires checkpoint creation before restart handoff can satisfy runtime proof", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      runtimeProof: {
        ...allGreen().runtimeProof,
        restartCheckpointCreated: false,
        restartHandoffCheckpointCreated: false,
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "live_runtime_proof")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "pre_restart_checkpoint_missing",
        "restart_handoff_checkpoint_missing",
        "deny_runtime_closeout",
      ]),
    });
  });

  it("blocks activation closeout when post-restart runtime identity mismatches expected build", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      runtimeProof: {
        ...allGreen().runtimeProof,
        liveRuntimeRevision: "old",
      },
    });

    expect(decision.allowedToCloseMission).toBe(false);
    expect(decision.gates.find((gate) => gate.gate === "live_runtime_proof")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "source_build_runtime_revision_mismatch",
        "deny_runtime_closeout",
      ]),
    });
  });

  it("blocks failed restart closeout even when source and build revisions match", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      runtimeProof: {
        ...allGreen().runtimeProof,
        restartRequestStatus: "failed",
      },
    });

    expect(decision.allowedToCloseMission).toBe(false);
    expect(decision.gates.find((gate) => gate.gate === "live_runtime_proof")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "restart_request_not_completed:failed",
        "deny_runtime_closeout",
      ]),
    });
  });

  it("rejects coalesced and no-op restart requests as activation proof", () => {
    for (const restartRequestStatus of ["coalesced", "noop"] as const) {
      const decision = evaluateCleanupCrewRuntimeEnforcement({
        ...allGreen(),
        runtimeProof: {
          ...allGreen().runtimeProof,
          restartRequestStatus,
        },
      });

      expect(decision.gates.find((gate) => gate.gate === "live_runtime_proof")).toMatchObject({
        state: "fail",
        obligations: expect.arrayContaining([
          `restart_request_not_completed:${restartRequestStatus}`,
          "deny_runtime_closeout",
        ]),
      });
    }
  });

  it("blocks child work that does not inherit the parent mission law", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      handoff: {
        childExecutionRequested: true,
        parentMissionContractInherited: false,
        childScopeWithinParent: false,
        parentCoverageValid: false,
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "handoff_inheritance")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "inherit_parent_mission_contract",
        "deny_child_scope_widening",
        "repair_parent_worker_coverage",
        "record_lawful_next_owner",
        "record_exact_next_action",
        "record_handoff_proof",
        "record_open_closed_truth",
        "deny_child_execution",
      ]),
    });
  });

  it("allows restart handoff survival only when owner, next action, proof, and truth state are recorded", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      handoff: {
        handoffRequested: true,
        parentMissionContractInherited: true,
        childScopeWithinParent: true,
        parentCoverageValid: true,
        lawfulNextOwner: "Will",
        exactNextAction: "route Grant review after Slice 5 proof packet",
        proofRefs: [
          "/home/will/.openclaw/workspace/file_hub/exports/cleanup_crew_runtime_enforcement_integration_slice_5_closeout_2026-08-29T0615Z.md",
        ],
        openClosedTruth: "open",
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "handoff_inheritance")).toMatchObject({
      state: "pass",
      obligations: [],
    });
  });

  it("uses replay and prompt-injection cases as final-closeout gates", () => {
    const decision = evaluateCleanupCrewRuntimeEnforcement({
      ...allGreen(),
      traceEval: {
        required: true,
        tracesCaptured: true,
        replayCasesPassed: false,
        promptInjectionCasesPassed: false,
      },
    });

    expect(decision.gates.find((gate) => gate.gate === "trace_eval_replay")).toMatchObject({
      state: "fail",
      obligations: expect.arrayContaining([
        "run_cleanup_crew_replay_cases",
        "run_prompt_injection_cases",
        "deny_final_closeout",
      ]),
    });
  });
});
