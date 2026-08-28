import { describe, expect, it } from "vitest";
import {
  evaluateCleanupCrewRuntimeEnforcement,
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
      mutation: true,
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
    },
    traceEval: {
      required: true,
      tracesCaptured: true,
      replayCasesPassed: true,
      promptInjectionCasesPassed: true,
    },
  };
}

describe("Cleanup Crew runtime enforcement", () => {
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
        "source_build_runtime_revision_mismatch",
        "post_restart_asset_guard_missing",
        "post_restart_task_audit_missing",
        "post_restart_blocked_flow_proof_missing",
        "deny_runtime_closeout",
      ]),
    });
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
        "deny_child_execution",
      ]),
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
