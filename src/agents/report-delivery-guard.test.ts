import { describe, expect, it } from "vitest";
import {
  CLEANUP_WATCHDOG_CLEAN_DIMENSIONS,
  CLEANUP_WATCHDOG_POLICY_VERSION,
  getCleanupWatchdogPriority,
} from "../governance/cleanup-watchdog-policy.js";
import {
  CLEANUP_CREW_CANONICAL_POLICY_PROMPT,
  REQUIRED_CLEANUP_CREW_CLOSEOUT_TRUTH_FIELDS,
  resolveCleanupCrewPostReportContinuation,
  resolveCleanupCrewReportCloseoutAcceptance,
  resolveCleanupCrewReportDeliveryRepair,
  resolveCleanupCrewStageTransition,
  resolveReportDeliveryGuard,
  validateMilestoneReportFormat,
} from "./report-delivery-guard.js";

const VALID_MILESTONE_REPORT = [
  "STATUS: In Progress",
  "MODE: Cleanup Crew execution",
  "STAGE COMPLETE: focused test complete",
  "RESULT: PASS",
  "PROOF: focused test output",
  "NEXT STAGE: continue",
  "SAFETY CHECK: no blockers",
  "BLOCKERS: none",
].join("\n");

const VALID_CLEANUP_CREW_CLOSEOUT = [
  "Cleanup Crew Runtime Enforcement Integration Slice 3 closeout",
  "Artifact path(s):",
  "- /home/will/.openclaw/workspace/file_hub/exports/slice_3_closeout.md",
  "Proof path(s):",
  "- src/agents/report-delivery-guard.ts",
  "What is materially real now:",
  "Slice 3 report/closeout acceptance is implemented.",
  "What is still not real yet:",
  "Slice 4 continuation/watchdog work has not started.",
  "Who lawfully owns the next step:",
  "Grant owns Slice 3 review.",
  "Open/closed truth:",
  "Slice 3 is locally closed; broader build remains open.",
  "Exact next action:",
  "Route the proof packet to Grant.",
  "Short slice result:",
  "Report acceptance gate passed focused proof.",
].join("\n");

describe("report delivery guard", () => {
  it("normalizes Cleanup Crew prompt guidance to the canonical governance policy", () => {
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(
      "cleanup-crew-governance-final-20260714T1454Z",
    );
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(CLEANUP_WATCHDOG_POLICY_VERSION);
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("ACTION_BLOCKED");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("MALFORMED_POLICY_INPUT");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("OWNER_DECISION_REQUIRED");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("EXTERNAL_DEPENDENCY");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("MISSION_ABORTED");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("mission-bound exhaustion receipt");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(
      `Watchdog active worker recovery priority: ${getCleanupWatchdogPriority("active_no_worker")}.`,
    );
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(
      `Report-delivery debt priority: ${getCleanupWatchdogPriority("pending_report_delivery")}.`,
    );
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain(
      `Watchdog CLEAN requires dimensions: ${CLEANUP_WATCHDOG_CLEAN_DIMENSIONS.join(", ")}.`,
    );
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("worker_coverage");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("mission resumption");
    expect(CLEANUP_CREW_CANONICAL_POLICY_PROMPT).toContain("duplicate delivery");
  });

  it("blocks artifact-only report completion when chat body was not delivered", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        reportBodyDeliveredInChat: false,
      }),
    ).toEqual({
      state: "pending_report_delivery",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: getCleanupWatchdogPriority("pending_report_delivery"),
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "artifact_only_without_chat_body",
    });
  });

  it("passes when report body was delivered in chat with a report path", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        reportBodyDeliveredInChat: true,
      }),
    ).toEqual({
      state: "report_delivery_satisfied",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      allowed: true,
      reportDeliveryComplete: true,
      milestoneReportComplete: true,
      reason: "report_body_delivered",
    });
  });

  it("blocks generated reports until required Mark-facing export proof exists", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath:
          "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/report.md",
        reportBodyDeliveredInChat: true,
        markFacingExportRequired: true,
        markFacingExportPath: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
        markFacingExportVerified: false,
      }),
    ).toEqual({
      state: "pending_mark_facing_export_delivery",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: getCleanupWatchdogPriority("pending_report_delivery"),
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "missing_mark_facing_export_proof",
    });
  });

  it("passes generated reports with chat body and Mark-facing export proof", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
        reportBodyDeliveredInChat: true,
        markFacingExportRequired: true,
        markFacingExportPath: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
        markFacingExportVerified: true,
      }),
    ).toMatchObject({
      state: "report_delivery_satisfied",
      allowed: true,
      reportDeliveryComplete: true,
      reason: "report_body_delivered",
    });
  });

  it("allows explicit artifact-only report delivery", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        explicitArtifactOnlyAllowed: true,
      }),
    ).toMatchObject({
      state: "report_delivery_satisfied",
      allowed: true,
      reportDeliveryComplete: true,
      reason: "explicit_artifact_only_allowed",
    });
  });

  it("blocks private-only final reports without source chat report body delivery", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        privateOnlyFinalResponse: true,
      }),
    ).toMatchObject({
      state: "blocked_private_only_report",
      allowed: false,
      reportDeliveryComplete: false,
      reason: "private_only_report_without_chat_body",
    });
  });

  it("blocks generated reports missing a report artifact path", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportBodyDeliveredInChat: true,
      }),
    ).toMatchObject({
      state: "blocked_missing_report_path",
      allowed: false,
      reportDeliveryComplete: false,
      reason: "missing_report_path",
    });
  });

  it("blocks completed milestone stages when the milestone report was not delivered", () => {
    expect(
      resolveReportDeliveryGuard({
        milestoneStageCompleted: true,
        milestoneReportRequired: true,
        milestoneReportDelivered: false,
      }),
    ).toEqual({
      state: "pending_milestone_report",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: getCleanupWatchdogPriority("pending_milestone_report"),
      allowed: false,
      reportDeliveryComplete: false,
      milestoneReportComplete: false,
      reason: "milestone_stage_report_missing",
    });
  });

  it("passes completed milestone stages when the milestone report was delivered", () => {
    expect(
      resolveReportDeliveryGuard({
        reportGenerated: true,
        reportArtifactPath: "/tmp/report.md",
        reportBodyDeliveredInChat: true,
        milestoneStageCompleted: true,
        milestoneReportRequired: true,
        milestoneReportDelivered: true,
      }),
    ).toMatchObject({
      state: "report_delivery_satisfied",
      allowed: true,
      reportDeliveryComplete: true,
      milestoneReportComplete: true,
    });
  });

  it("does not block ordinary non-report replies", () => {
    expect(resolveReportDeliveryGuard({})).toEqual({
      state: "not_required",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      allowed: true,
      reportDeliveryComplete: false,
      milestoneReportComplete: true,
      reason: "not_required",
    });
  });

  it("validates the required Cleanup Crew milestone report fields", () => {
    expect(validateMilestoneReportFormat(VALID_MILESTONE_REPORT)).toEqual({
      valid: true,
      missingFields: [],
    });
    expect(validateMilestoneReportFormat("STATUS: only")).toEqual({
      valid: false,
      missingFields: [
        "MODE:",
        "STAGE COMPLETE:",
        "RESULT:",
        "PROOF:",
        "NEXT STAGE:",
        "SAFETY CHECK:",
        "BLOCKERS:",
      ],
    });
  });

  it("continues after a delivered milestone report because reporting is visibility, not permission", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "proof_passes",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
      }),
    ).toMatchObject({
      state: "continue_after_visibility_report",
      shouldContinue: true,
      allowedToAdvance: true,
      requiredReportDelivered: true,
    });
  });

  it("requires continuation dispatch when a delivered milestone leaves the broader build open", () => {
    expect(
      resolveCleanupCrewPostReportContinuation({
        currentTurnText: "Cleanup Crew production repair build.",
        reportText: [
          VALID_MILESTONE_REPORT,
          "Open/closed truth: local slice closed; broader Cleanup Crew issue-list repair remains open.",
          "Exact next action: dispatch ISSUE-041 scope/source/authority lock.",
        ].join("\n"),
        finalDeliveryDelivered: true,
      }),
    ).toMatchObject({
      state: "continuation_dispatch_required",
      activeCleanupCrewMission: true,
      broaderBuildOpen: true,
      finalDeliveryDelivered: true,
      stopAllowed: false,
      checkpointKind: "milestone_delivered",
      nextExecutableAction: "dispatch ISSUE-041 scope/source/authority lock.",
      pendingContinuationVisible: false,
    });
  });

  it("treats broader issue-family wording as open work requiring continuation coverage", () => {
    expect(
      resolveCleanupCrewPostReportContinuation({
        currentTurnText: "Run Cleanup Crew SOP.",
        reportText: [
          "ISSUE-040 scoped slice closeout",
          "STATUS: Closed for the scoped first source slice.",
          "MODE: Cleanup Crew SOP.",
          "Open/closed truth: Scoped first slice closed. Broader ISSUE-040 reliability family remains open.",
          "Exact next action: continue ISSUE-040 family triage from the updated register.",
        ].join("\n"),
        finalDeliveryDelivered: true,
      }),
    ).toMatchObject({
      state: "continuation_dispatch_required",
      activeCleanupCrewMission: true,
      broaderBuildOpen: true,
      stopAllowed: false,
      nextExecutableAction: "continue ISSUE-040 family triage from the updated register.",
    });
  });

  it("allows post-report stop when the full Cleanup Crew build is complete", () => {
    expect(
      resolveCleanupCrewPostReportContinuation({
        currentTurnText: "Cleanup Crew production repair build.",
        reportText: [
          "Cleanup Crew final closeout",
          "Status: closed",
          "Open/closed truth: Cleanup Crew issue-list repair is truthfully closed.",
          "What is still not real yet: nothing.",
        ].join("\n"),
        finalDeliveryDelivered: true,
      }),
    ).toMatchObject({
      state: "terminal_stop_allowed_full_build_complete",
      broaderBuildOpen: false,
      stopAllowed: true,
      pendingContinuationVisible: false,
    });
  });

  it.each([
    "Give me a Cleanup Crew production report only.",
    "Give me the current Cleanup Crew production report only.",
    "Cleanup Crew report only. Do not continue.",
    "Cleanup Crew production repair: status only and do not continue.",
    "Pause Cleanup Crew. Proceed with the Cleanup Crew status report only.",
    "Stop. Start the Cleanup Crew report only.",
    "Proceed with the Cleanup Crew production status report only because I don't authorize changes.",
    "Proceed with the Cleanup Crew production status report only because I will review it and execute the changes myself.",
    "Proceed with the Cleanup Crew production status report only and I will review it and execute the changes myself.",
    "Please proceed with the Cleanup Crew production status report only and I will review it and execute the changes myself.",
    "Please, proceed with the Cleanup Crew production status report only and I will review it and execute the changes myself.",
    "Do not continue with the Cleanup Crew build, please.",
    "Do not continue with the Cleanup Crew build because I only want a status update.",
    "Do not continue with the Cleanup Crew build for now.",
    "Pause the Cleanup Crew production repair.",
    "Don't run.",
    "Do not resume.",
    "Do not start.",
    "Do not proceed.",
    "Stop the execution.",
    "Do not do any work on this production build.",
    "Cleanup Crew production repair: do not continue, please.",
    "Cleanup Crew production repair: stop for the moment, please.",
    "Cleanup Crew production repair: stop all work.",
    "Cleanup Crew production repair: do not do any work, just answer.",
  ])("delivers the requested hold report while keeping the mission open: %s", (currentTurnText) => {
    const decision = resolveCleanupCrewReportCloseoutAcceptance({
      currentTurnText,
      reportText: VALID_CLEANUP_CREW_CLOSEOUT,
      reportBodyDeliveredInChat: true,
    });
    expect(decision).toMatchObject({
      state: "stop_after_report_only_request",
      allowedToAcceptReport: true,
      allowedToCloseMission: false,
      postReportContinuation: {
        state: "terminal_stop_allowed_operator_stop",
        broaderBuildOpen: true,
        finalDeliveryDelivered: true,
        stopAllowed: true,
      },
    });
  });

  it.each([
    "Cleanup Crew production repair: fix pause/resume handling and run its tests.",
    "Cleanup Crew production repair: fix status-only/report-only classification.",
    "Cleanup Crew production repair: fix the 'status only and do not continue' regression and run its tests.",
    "Cleanup Crew production repair: stop the repair helper and run the remaining checks.",
    "Cleanup Crew production repair: do not do any work on the repair helper; run remaining checks.",
    "Pause Cleanup Crew. Start the build now.",
    "Stop. Proceed with the Cleanup Crew repair now.",
    "Proceed with the Cleanup Crew production status report only because I will review it and then execute the Cleanup Crew repair.",
    "Proceed with the Cleanup Crew production status report only and I will review it and then execute the Cleanup Crew repair.",
    "Please proceed with the Cleanup Crew production status report only and I will review it and then execute the Cleanup Crew repair.",
    "Please, proceed with the Cleanup Crew production status report only and I will review it and then execute the Cleanup Crew repair.",
    "Give me a Cleanup Crew production build plan. Execute it now.",
  ])("keeps the same report nonterminal under a production instruction: %s", (currentTurnText) => {
    expect(
      resolveCleanupCrewReportCloseoutAcceptance({
        currentTurnText,
        reportText: VALID_CLEANUP_CREW_CLOSEOUT,
        reportBodyDeliveredInChat: true,
      }),
    ).toMatchObject({
      state: "accepted_report_continue",
      allowedToAcceptReport: true,
      allowedToCloseMission: false,
      postReportContinuation: {
        state: "continuation_dispatch_required",
        stopAllowed: false,
      },
    });
  });

  it("does not infer execution from a requested plan containing Cleanup Crew report examples", () => {
    expect(
      resolveCleanupCrewReportCloseoutAcceptance({
        currentTurnText: "Only draft a Cleanup Crew build plan.",
        activeCleanupCrewMission: true,
        reportText: VALID_CLEANUP_CREW_CLOSEOUT,
        reportBodyDeliveredInChat: true,
      }),
    ).toMatchObject({
      state: "not_cleanup_crew_report",
      activeCleanupCrewMission: false,
      postReportContinuation: { state: "not_cleanup_crew_report" },
    });
  });

  it("requires continuation when a blocker report lacks hard-stop or exhaustion proof", () => {
    expect(
      resolveCleanupCrewPostReportContinuation({
        currentTurnText: "Cleanup Crew production repair build.",
        reportText: [
          "STATUS: blocked",
          "MODE: Cleanup Crew execution",
          "BLOCKER: lawful blocker observed during cleanup.",
          "PROOF: live status shows a restart boundary.",
          "BLOCKER_ARTIFACT: /tmp/cleanup-crew-blocker.json",
          "Exact next action: run the next lawful recovery command.",
          "Open/closed truth: broader Cleanup Crew issue-list repair remains open.",
        ].join("\n"),
        finalDeliveryDelivered: true,
      }),
    ).toMatchObject({
      state: "continuation_dispatch_required",
      broaderBuildOpen: true,
      stopAllowed: false,
      pendingContinuationVisible: false,
      nextExecutableAction: "run the next lawful recovery command.",
    });
  });

  it("allows post-report stop only for verified hard stop or exhausted recovery", () => {
    expect(
      resolveCleanupCrewPostReportContinuation({
        currentTurnText: "Cleanup Crew production repair build.",
        reportText: [
          "STATUS: blocked",
          "MODE: Cleanup Crew execution",
          "BLOCKER: true hard stop requires Mark decision before continuation.",
          "WHY CONTINUATION IS NOT LAWFUL: owner decision required after all lawful recovery paths exhausted.",
          "PROOF: live authority check has no lawful owner route and alternate execution surfaces exhausted.",
          "BLOCKER_ARTIFACT: /tmp/cleanup-crew-blocker.json",
          "Open/closed truth: broader Cleanup Crew issue-list repair remains open.",
        ].join("\n"),
        finalDeliveryDelivered: true,
      }),
    ).toMatchObject({
      state: "terminal_stop_allowed_verified_hard_stop",
      broaderBuildOpen: true,
      stopAllowed: true,
      pendingContinuationVisible: false,
    });
  });

  it("leaves visible pending continuation when an open delivered report omits the next action", () => {
    expect(
      resolveCleanupCrewPostReportContinuation({
        currentTurnText: "Cleanup Crew production repair build.",
        reportText: [
          "Cleanup Crew scoped closeout",
          "Status: closed for the local slice",
          "Open/closed truth: broader Cleanup Crew issue-list repair remains open.",
        ].join("\n"),
        finalDeliveryDelivered: true,
      }),
    ).toMatchObject({
      state: "pending_continuation_action",
      broaderBuildOpen: true,
      stopAllowed: false,
      pendingContinuationVisible: true,
      checkpointKind: "report_boundary",
    });
  });

  it("does not treat non-action wording as executable continuation coverage", () => {
    expect(
      resolveCleanupCrewPostReportContinuation({
        currentTurnText: "Cleanup Crew production repair build.",
        reportText: [
          "Cleanup Crew scoped closeout",
          "Status: closed for the local slice",
          "Open/closed truth: broader ISSUE-040 remains open.",
          "Exact next action: not recorded yet",
        ].join("\n"),
        finalDeliveryDelivered: true,
      }),
    ).toMatchObject({
      state: "pending_continuation_action",
      broaderBuildOpen: true,
      stopAllowed: false,
      pendingContinuationVisible: true,
      reason: "broader_build_open_next_action_missing",
    });
  });

  it("blocks phase transition when the required milestone report is missing or malformed", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "asset_guard_complete",
        milestoneReportText: "STATUS: missing the other required fields",
        milestoneReportDelivered: true,
      }),
    ).toMatchObject({
      state: "pending_milestone_report",
      shouldContinue: false,
      allowedToAdvance: false,
      requiredReportDelivered: false,
    });
  });

  it("stops after a delivered report when the operator asked for report-only status", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "explicit_status_or_report_request",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
        explicitReportOnlyRequest: true,
      }),
    ).toMatchObject({
      state: "stop_after_report_only_request",
      shouldContinue: false,
      allowedToAdvance: false,
      requiredReportDelivered: true,
    });
  });

  it("routes watchdog NEEDS_REVIEW ahead of adjacent production after the report is delivered", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "watchdog_needs_review",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
        watchdogNeedsReview: true,
      }),
    ).toMatchObject({
      state: "pause_for_watchdog_needs_review",
      shouldContinue: true,
      allowedToAdvance: false,
      canonicalPriority: getCleanupWatchdogPriority("active_no_worker"),
      nextAction:
        "route watchdog alert to Cleanup Crew recovery: inspect latest watchdog receipt, analyze read-only, amend active plan, resume recovery, rerun watchdog",
    });
  });

  it("routes Grant FAIL into repair instead of allowing completion", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "grant_fail",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
        grantFailed: true,
      }),
    ).toMatchObject({
      state: "route_grant_fail_repair",
      canonicalPriority: getCleanupWatchdogPriority("review_required_for_safe_work"),
      shouldContinue: true,
      allowedToAdvance: false,
      nextAction: "convert Grant findings into the next lawful repair batch",
    });
  });

  it("treats interrupted or aborted proof as unproven and names recovery work", () => {
    expect(
      resolveCleanupCrewStageTransition({
        moment: "interruption_or_aborted_tool",
        milestoneReportText: VALID_MILESTONE_REPORT,
        milestoneReportDelivered: true,
        proofInterruptedOrAborted: true,
      }),
    ).toMatchObject({
      state: "proof_unproven_recovery_required",
      canonicalPriority: getCleanupWatchdogPriority("missing_correctness_proof"),
      shouldContinue: true,
      allowedToAdvance: false,
      nextAction: "report unproven proof status and rerun the interrupted proof check",
    });
  });

  it("turns failed report delivery into repair work instead of mission closeout", () => {
    expect(
      resolveCleanupCrewReportDeliveryRepair({
        missionId: "cleanup-crew-governance",
        reportId: "grant-pass-delivery",
        reportGenerated: true,
        reportArtifactPath: "/tmp/grant-pass.md",
        deliveryFailed: true,
        registryRowPresent: true,
        parentMissionOpen: true,
      }),
    ).toMatchObject({
      state: "schedule_delivery_repair_work",
      policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
      canonicalPriority: getCleanupWatchdogPriority("pending_report_delivery"),
      allowedToAdvance: false,
      allowedToCloseMission: false,
      missionRemainsOpen: true,
      registryWorkRequired: true,
      repairWorkRequired: true,
      acknowledgementAllowed: false,
    });
  });

  it("requires Mark-facing export proof before acknowledging report-delivery repair", () => {
    const decision = resolveCleanupCrewReportDeliveryRepair({
      missionId: "cleanup-crew-governance",
      reportId: "grant-pass-delivery",
      reportGenerated: true,
      reportArtifactPath:
        "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/grant-pass.md",
      markFacingExportRequired: true,
      markFacingExportPath: "/home/will/.openclaw/workspace/file_hub/exports/grant-pass.md",
      markFacingExportVerified: false,
      reportBodyDeliveredInChat: true,
      registryRowPresent: true,
      parentMissionOpen: true,
    });

    expect(decision.state).toBe("invalid_report_delivery_state");
    expect(decision.allowedToAdvance).toBe(false);
    expect(decision.allowedToCloseMission).toBe(false);
    expect(decision.acknowledgementAllowed).toBe(false);
    expect(decision.validationErrors).toContain("mark_facing_export_proof_missing");
  });

  it("keeps idempotent report repair pending until visible delivery or settlement proof exists", () => {
    expect(
      resolveCleanupCrewReportDeliveryRepair({
        missionId: "cleanup-crew-governance",
        reportId: "grant-pass-delivery",
        reportGenerated: true,
        reportArtifactPath: "/tmp/grant-pass.md",
        deliveryFailed: true,
        registryRowPresent: true,
        repairWorkScheduled: true,
        parentMissionOpen: true,
      }),
    ).toMatchObject({
      state: "repair_work_pending",
      allowedToAdvance: false,
      allowedToCloseMission: false,
      acknowledgementAllowed: false,
      nextAction: "complete idempotent report-delivery repair work before acknowledgement",
    });
  });

  it("allows continuation after later verified delivery settlement without closing the parent mission", () => {
    expect(
      resolveCleanupCrewReportDeliveryRepair({
        missionId: "cleanup-crew-governance",
        reportId: "grant-pass-delivery",
        reportGenerated: true,
        reportArtifactPath: "/tmp/grant-pass.md",
        deliveryFailed: true,
        registryRowPresent: true,
        verifiedLaterSettlementProof: "/tmp/settlement-receipt.json",
        parentMissionOpen: true,
      }),
    ).toMatchObject({
      state: "settled_by_later_verified_delivery",
      allowedToAdvance: true,
      allowedToCloseMission: false,
      missionRemainsOpen: true,
      registryWorkRequired: true,
      repairWorkRequired: false,
      acknowledgementAllowed: true,
    });
  });

  it("acceptance gate keeps pending report delivery from closing a report-governed mission", () => {
    expect(
      resolveCleanupCrewReportCloseoutAcceptance({
        currentTurnText: "Cleanup Crew Runtime Enforcement Integration build.",
        reportText: VALID_CLEANUP_CREW_CLOSEOUT,
        reportBodyDeliveredInChat: false,
      }),
    ).toMatchObject({
      state: "pending_report_delivery",
      activeCleanupCrewMission: true,
      allowedToAcceptReport: false,
      allowedToCloseMission: false,
      reportDelivery: {
        state: "pending_report_delivery",
        reason: "artifact_only_without_chat_body",
      },
    });
  });

  it("acceptance gate treats pending milestone report as visibility work before closeout", () => {
    expect(
      resolveCleanupCrewReportCloseoutAcceptance({
        currentTurnText: "Cleanup Crew Runtime Enforcement Integration build.",
        reportText: VALID_CLEANUP_CREW_CLOSEOUT,
        reportBodyDeliveredInChat: true,
        milestoneStageCompleted: true,
        milestoneReportRequired: true,
        milestoneReportDelivered: false,
      }),
    ).toMatchObject({
      state: "pending_milestone_report",
      allowedToAcceptReport: false,
      allowedToCloseMission: false,
      reportDelivery: {
        state: "pending_milestone_report",
      },
    });
  });

  it("acceptance gate requires Mark-facing export proof when required", () => {
    const decision = resolveCleanupCrewReportCloseoutAcceptance({
      currentTurnText: "Cleanup Crew Runtime Enforcement Integration build.",
      reportText: VALID_CLEANUP_CREW_CLOSEOUT,
      reportBodyDeliveredInChat: true,
      markFacingExportRequired: true,
      markFacingExportPath: "/home/will/.openclaw/workspace/file_hub/exports/slice_3_closeout.md",
      markFacingExportVerified: false,
    });

    expect(decision).toMatchObject({
      state: "pending_mark_facing_export_delivery",
      allowedToAcceptReport: false,
      allowedToCloseMission: false,
      reportDelivery: {
        reason: "missing_mark_facing_export_proof",
      },
    });
  });

  it("acceptance gate rejects private-only final responses for Cleanup Crew closeouts", () => {
    expect(
      resolveCleanupCrewReportCloseoutAcceptance({
        currentTurnText: "Cleanup Crew Runtime Enforcement Integration build.",
        reportText: VALID_CLEANUP_CREW_CLOSEOUT,
        reportBodyDeliveredInChat: false,
        privateOnlyFinalResponse: true,
      }),
    ).toMatchObject({
      state: "blocked_private_only_report",
      allowedToAcceptReport: false,
      allowedToCloseMission: false,
    });
  });

  it("acceptance gate rejects false complete paperwork-only closeouts", () => {
    expect(
      resolveCleanupCrewReportCloseoutAcceptance({
        currentTurnText: "Cleanup Crew Runtime Enforcement Integration build.",
        reportText: [
          VALID_CLEANUP_CREW_CLOSEOUT,
          "Status: closed.",
          "Result: paperwork/setup done.",
        ].join("\n"),
        reportBodyDeliveredInChat: true,
      }),
    ).toMatchObject({
      state: "blocked_paperwork_only_closeout",
      allowedToAcceptReport: false,
      allowedToCloseMission: false,
      reason: "paperwork_only_work_cannot_close_cleanup_crew_mission",
    });
  });

  it("acceptance gate accepts valid closeouts with exact truth fields and export proof", () => {
    const decision = resolveCleanupCrewReportCloseoutAcceptance({
      currentTurnText: "Cleanup Crew Runtime Enforcement Integration build.",
      reportText: VALID_CLEANUP_CREW_CLOSEOUT,
      reportBodyDeliveredInChat: true,
    });

    expect(decision.missingTruthFields).toEqual([]);
    expect(decision).toMatchObject({
      state: "accepted_report_continue",
      allowedToAcceptReport: true,
      allowedToCloseMission: false,
      nextAction: "Route the proof packet to Grant.",
    });
  });

  it("acceptance gate reports every exact missing truth field", () => {
    const decision = resolveCleanupCrewReportCloseoutAcceptance({
      currentTurnText: "Cleanup Crew Runtime Enforcement Integration build.",
      reportText: [
        "Cleanup Crew Runtime Enforcement Integration Slice 3 closeout",
        "Artifact path(s):",
        "- /home/will/.openclaw/workspace/file_hub/exports/slice_3_closeout.md",
      ].join("\n"),
      reportBodyDeliveredInChat: true,
    });

    expect(decision).toMatchObject({
      state: "blocked_missing_truth_fields",
      allowedToAcceptReport: false,
      allowedToCloseMission: false,
    });
    expect(decision.missingTruthFields).toEqual(REQUIRED_CLEANUP_CREW_CLOSEOUT_TRUTH_FIELDS);
  });

  it("rejects malformed report-delivery state and parent closeout attempts", () => {
    const decision = resolveCleanupCrewReportDeliveryRepair({
      reportId: "grant-pass-delivery",
      reportGenerated: true,
      deliveryFailed: true,
      attemptedMissionCloseout: true,
    });

    expect(decision.state).toBe("invalid_report_delivery_state");
    expect(decision.allowedToCloseMission).toBe(false);
    expect(decision.acknowledgementAllowed).toBe(false);
    expect(decision.validationErrors).toEqual([
      "mission_id_missing",
      "report_artifact_path_missing",
      "parent_mission_open_proof_missing",
      "report_delivery_attempted_parent_closeout",
    ]);
  });
});
