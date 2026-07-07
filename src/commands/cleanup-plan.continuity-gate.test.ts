import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveCleanupCrewRepair } from "../continuity/continuity-gate-v2.js";
import {
  persistCleanupCrewContinuityGateDecision,
  persistCleanupCrewPlanAmendment,
  persistCleanupCrewStoppageReceipt,
  resolveCleanupCrewContinuityGateDecision,
} from "./cleanup-plan.js";

const NOW = "2026-07-04T18:10:00.000Z";

describe("cleanup plan Continuity Gate v2 integration", () => {
  it("persists stoppage receipts before Cleanup Crew analysis or repair resumes", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-stoppage-"));
    try {
      const result = await persistCleanupCrewStoppageReceipt({
        outputDir,
        receipt: {
          timestamp: NOW,
          missionId: "cleanup-crew-pause-analyze-plan-resume",
          taskFlowId: "flow-packet-f",
          packetId: "packet-1",
          stageId: "focused-validation",
          commandProcessId: "vitest-rerun-1",
          commandSpec:
            "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
          workingDirectory: "/home/will/openclaw-source",
          gitHead: "7fe95e210b51a365d9d08e013e34369fa0374a35",
          dirtyTreeSummary: " M src/commands/cleanup-plan.ts",
          stdoutTail: "[test] starting test/vitest/vitest.unit-fast.config.ts",
          stderrTail: "AssertionError: expected receipt to exist",
          proofArtifactPath: "var/cleanup/proof-gap.json",
          logPath: "var/cleanup/vitest.log",
          stoppageClass: "validation_nonzero_exit",
          suspectedAffectedSurface: "src/commands/cleanup-plan.ts",
          nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
        },
      });

      expect(result.writes).toHaveLength(1);
      expect(result.writes[0]?.kind).toBe("stoppage_receipt");
      expect(result.writes[0]?.path).toContain("cleanup_crew_stoppage_receipts");

      const receipt = JSON.parse(await readFile(result.writes[0]!.path, "utf8")) as {
        schema: string;
        mission_id: string;
        task_flow_id: string;
        command_spec: string;
        git_state: { head: string; dirty_tree_summary: string };
        captured_output: { stdout_tail: string; stderr_tail: string };
        stoppage_class: string;
        next_analysis_owner: string;
      };

      expect(receipt).toMatchObject({
        schema: "openclaw.cleanup_crew_stoppage_receipt.v1",
        mission_id: "cleanup-crew-pause-analyze-plan-resume",
        task_flow_id: "flow-packet-f",
        command_spec:
          "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
        git_state: {
          head: "7fe95e210b51a365d9d08e013e34369fa0374a35",
          dirty_tree_summary: " M src/commands/cleanup-plan.ts",
        },
        captured_output: {
          stdout_tail: "[test] starting test/vitest/vitest.unit-fast.config.ts",
          stderr_tail: "AssertionError: expected receipt to exist",
        },
        stoppage_class: "validation_nonzero_exit",
        next_analysis_owner: "cleanup_crew_planning_dev_sop",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("persists targeted active build plan amendments before repair execution resumes", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-plan-amendment-"));
    try {
      const planPath = path.join(outputDir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n\nPacket 3\n", "utf8");
      const repair = deriveCleanupCrewRepair({
        issue: {
          summary: "Proof gap requires planned retry.",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "proof_or_receipt_shape",
        },
        repairAction: "write proof receipt and rerun focused validation",
        targetSurfaces: ["src/commands/cleanup-plan.ts"],
        validationSteps: [
          "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
        ],
        proofArtifacts: ["var/cleanup/proof-gap.json"],
        nextExecutableCommand:
          "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
      });

      const write = await persistCleanupCrewPlanAmendment({
        activeBuildPlanPath: planPath,
        timestamp: NOW,
        stoppageId: "stoppage_receipt_cleanup_plan",
        derivedRepair: repair,
        diagnosis: "Proof gap has a technical repair path inside Cleanup Crew scope.",
        stopConditions: ["focused validation fails"],
        rollbackSafetyNotes: ["append-only amendment; no source rollback needed"],
      });
      const planText = await readFile(planPath, "utf8");

      expect(write.amendment.stoppage_id).toBe("stoppage_receipt_cleanup_plan");
      expect(write.amendedPlanHash).not.toBe(write.basePlanHash);
      expect(planText).toContain("Cleanup Crew Recovery Amendment");
      expect(planText).toContain('"next_executable_command"');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("continues technical cleanup blockers without creating a Mark question", () => {
    const decision = resolveCleanupCrewContinuityGateDecision({
      now: NOW,
      activeMission: "Cleanup Crew system repair",
      issue: {
        summary: "Dirty-tree proof artifact needs classification and focused repair.",
        blocker: "dirty tree",
        pathRisk: "MEDIUM_RISK_RUNTIME",
        diffIntent: "routing_or_catalog_recording",
      },
      authoritySources: [
        {
          kind: "active_mission_lock",
          id: "cleanup-crew-active",
          summary: "Cleanup Crew active mission",
          active: true,
        },
      ],
    });

    expect(decision.selectedState).toBe("CONTINUE_AFTER_REPO_HYGIENE_REPAIR");
    expect(decision.shouldContinue).toBe(true);
    expect(decision.askMark).toBe(false);
  });

  it("honors root inspect-only override before cleanup continuation", () => {
    const decision = resolveCleanupCrewContinuityGateDecision({
      now: NOW,
      activeMission: "Cleanup Crew system repair",
      userInstruction: "Inspect only. Just answer, do not do anything.",
      issue: {
        summary: "Technical cleanup path exists.",
        blocker: "tooling gap",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "bug_fix_same_behavior",
      },
      authoritySources: [
        {
          kind: "active_mission_lock",
          id: "cleanup-crew-active",
          summary: "Cleanup Crew active mission",
          active: true,
        },
      ],
    });

    expect(decision.selectedState).toBe("STOP_USER_ANSWER_ONLY_OVERRIDE");
    expect(decision.shouldContinue).toBe(false);
    expect(decision.askMark).toBe(false);
  });

  it("persists durable decision and continue receipt artifacts for technical continuation", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-gate-"));
    try {
      const result = await persistCleanupCrewContinuityGateDecision({
        outputDir,
        now: NOW,
        activeMission: "Cleanup Crew runtime continuation",
        issue: {
          summary: "Focused test failed after a mechanical proof-shape change.",
          blocker: "test failed",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "test_alignment",
          safeTechnicalPathDescription: "Repair the focused test and rerun it.",
        },
        authoritySources: [
          {
            kind: "active_build_plan",
            id: "continuity-gate-v2",
            summary: "Continuity Gate v2 build plan",
            active: true,
          },
        ],
        scope: {
          files: ["src/commands/cleanup-plan.ts"],
          commands: [
            "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
          ],
        },
        repairAction: "repair focused test",
        proofPath: "focused-proof.json",
        diagnostic: {
          tests: ["src/commands/cleanup-plan.continuity-gate.test.ts"],
          redactionStatus: "no_sensitive_payloads",
        },
      });

      expect(result.decision.selectedState).toBe("CONTINUE_AFTER_BUILD_OR_TEST_REPAIR");
      expect(result.decision.askMark).toBe(false);
      expect(result.writes.map((write) => write.kind)).toEqual([
        "decision_record",
        "continue_receipt",
        "diagnostic_trace",
      ]);

      const decisionRecordPath = result.writes.find(
        (write) => write.kind === "decision_record",
      )?.path;
      const continueReceiptPath = result.writes.find(
        (write) => write.kind === "continue_receipt",
      )?.path;
      expect(decisionRecordPath).toBeTruthy();
      expect(continueReceiptPath).toBeTruthy();

      const decisionRecord = JSON.parse(await readFile(decisionRecordPath!, "utf8")) as {
        schema: string;
        selected_state: string;
        scope: { files: string[]; commands: string[] };
      };
      const continueReceipt = JSON.parse(await readFile(continueReceiptPath!, "utf8")) as {
        schema: string;
        selected_state: string;
        repair_action: string;
        proof_path: string;
      };

      expect(decisionRecord).toMatchObject({
        schema: "openclaw.cleanup_crew_decision_record.v2",
        selected_state: "CONTINUE_AFTER_BUILD_OR_TEST_REPAIR",
        scope: {
          files: ["src/commands/cleanup-plan.ts"],
          commands: [
            "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
          ],
        },
      });
      expect(continueReceipt).toMatchObject({
        schema: "openclaw.cleanup_crew_continue_receipt.v2",
        selected_state: "CONTINUE_AFTER_BUILD_OR_TEST_REPAIR",
        repair_action: "repair focused test",
        proof_path: "focused-proof.json",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("persists stop report and diagnostic trace for product stop decisions", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-gate-"));
    try {
      const result = await persistCleanupCrewContinuityGateDecision({
        outputDir,
        now: NOW,
        activeMission: "Cleanup Crew runtime continuation",
        issue: {
          summary: "Choose a new user-facing cleanup approval flow.",
          pathRisk: "HIGH_RISK_BEHAVIOR",
          diffIntent: "new_feature_behavior",
          behaviorImpact: "ux_flow",
        },
        authoritySources: [
          {
            kind: "active_build_plan",
            id: "continuity-gate-v2",
            summary: "Continuity Gate v2 build plan",
            active: true,
          },
        ],
      });

      expect(result.decision.selectedState).toBe("STOP_HUMAN_PRODUCT_DECISION");
      expect(result.writes.map((write) => write.kind)).toEqual(["stop_report", "diagnostic_trace"]);

      const stopReportPath = result.writes.find((write) => write.kind === "stop_report")?.path;
      const diagnosticTracePath = result.writes.find(
        (write) => write.kind === "diagnostic_trace",
      )?.path;
      expect(stopReportPath).toBeTruthy();
      expect(diagnosticTracePath).toBeTruthy();
      const stopReport = JSON.parse(await readFile(stopReportPath!, "utf8")) as {
        schema: string;
        stop_state: string;
        plain_text_question: string;
        diagnostic_artifact: string;
      };

      expect(stopReport).toMatchObject({
        schema: "openclaw.cleanup_crew_stop_report.v2",
        stop_state: "STOP_HUMAN_PRODUCT_DECISION",
        plain_text_question: "What should the system do?",
        diagnostic_artifact: diagnosticTracePath,
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("persists stop report and diagnostic trace for unsafe SOP stop decisions without asking Mark", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-gate-"));
    try {
      const result = await persistCleanupCrewContinuityGateDecision({
        outputDir,
        now: NOW,
        activeMission: "Cleanup Crew runtime continuation",
        issue: {
          summary: "Live SOP safety block prevents the proposed technical path.",
          pathRisk: "CRITICAL_CONTROL",
          diffIntent: "bug_fix_same_behavior",
          ownerLevelBlockerAudit: "sop_safety_owner",
        },
        authoritySources: [
          {
            kind: "active_build_plan",
            id: "continuity-gate-v2",
            summary: "Continuity Gate v2 build plan",
            active: true,
          },
          {
            kind: "global_sop",
            id: "safety-stop",
            summary: "SOP safety stop",
            active: true,
            safetyBlock: true,
            proofPath: "sop-proof.md",
          },
        ],
        scope: {
          files: ["src/continuity/continuity-gate-v2.ts"],
          records: ["sop-proof.md"],
          commands: ["corepack pnpm tsgo:core"],
        },
        diagnostic: {
          surfaces: ["cleanup-plan-continuity-gate"],
          grantResult: "failed_high_stop_report_gap",
          proofRefs: ["sop-proof.md"],
          redactionStatus: "no_sensitive_payloads",
        },
      });

      expect(result.decision.selectedState).toBe("STOP_UNSAFE_BEHAVIOR_CHANGE");
      expect(result.decision.askMark).toBe(false);
      expect(result.writes.map((write) => write.kind)).toEqual(["stop_report", "diagnostic_trace"]);

      const stopReportPath = result.writes.find((write) => write.kind === "stop_report")?.path;
      const diagnosticTracePath = result.writes.find(
        (write) => write.kind === "diagnostic_trace",
      )?.path;
      expect(stopReportPath).toBeTruthy();
      expect(diagnosticTracePath).toBeTruthy();

      const stopReport = JSON.parse(await readFile(stopReportPath!, "utf8")) as {
        schema: string;
        stop_state: string;
        plain_text_question: string;
        diagnostic_artifact: string;
      };
      const trace = JSON.parse(await readFile(diagnosticTracePath!, "utf8")) as {
        owner_level_blocker_audit: string;
        risk_classification: { path_risk: string; diff_intent: string };
        technical_vs_product: { lane: string };
        scope: { surfaces: string[]; records: string[]; commands: string[] };
        grant_result: string;
        proof_refs: string[];
      };

      expect(stopReport).toMatchObject({
        schema: "openclaw.cleanup_crew_stop_report.v2",
        stop_state: "STOP_UNSAFE_BEHAVIOR_CHANGE",
        plain_text_question: "No operator action requested unless a human decision is required.",
        diagnostic_artifact: diagnosticTracePath,
      });
      expect(trace).toMatchObject({
        owner_level_blocker_audit: "sop_safety_owner",
        risk_classification: {
          path_risk: "CRITICAL_CONTROL",
          diff_intent: "bug_fix_same_behavior",
        },
        technical_vs_product: {
          lane: "true_unknown",
        },
        scope: {
          surfaces: ["cleanup-plan-continuity-gate"],
          records: ["sop-proof.md"],
          commands: ["corepack pnpm tsgo:core"],
        },
        grant_result: "failed_high_stop_report_gap",
        proof_refs: ["sop-proof.md"],
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("persists stop report and diagnostic trace for unresolved authority stops without asking Mark", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-gate-"));
    try {
      const result = await persistCleanupCrewContinuityGateDecision({
        outputDir,
        now: NOW,
        activeMission: "Cleanup Crew runtime continuation",
        issue: {
          summary: "Two live authorities conflict and require diagnosis.",
          pathRisk: "MEDIUM_RISK_RUNTIME",
          diffIntent: "routing_or_catalog_recording",
        },
        authoritySources: [
          {
            kind: "active_build_plan",
            id: "plan-a",
            summary: "Plan A",
            active: true,
            conflictWith: ["plan-b"],
          },
          {
            kind: "active_build_plan",
            id: "plan-b",
            summary: "Plan B",
            active: true,
            conflictWith: ["plan-a"],
          },
        ],
      });

      expect(result.decision.selectedState).toBe("STOP_UNRESOLVED_AUTHORITY_CONFLICT");
      expect(result.decision.askMark).toBe(false);
      expect(result.writes.map((write) => write.kind)).toEqual(["stop_report", "diagnostic_trace"]);

      const stopReportPath = result.writes.find((write) => write.kind === "stop_report")?.path;
      const diagnosticTracePath = result.writes.find(
        (write) => write.kind === "diagnostic_trace",
      )?.path;
      expect(stopReportPath).toBeTruthy();
      expect(diagnosticTracePath).toBeTruthy();
      const stopReport = JSON.parse(await readFile(stopReportPath!, "utf8")) as {
        stop_state: string;
        diagnostic_artifact: string;
      };

      expect(stopReport).toMatchObject({
        stop_state: "STOP_UNRESOLVED_AUTHORITY_CONFLICT",
        diagnostic_artifact: diagnosticTracePath,
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("persists diagnostic-only artifact shape for answer-only overrides", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-gate-"));
    try {
      const result = await persistCleanupCrewContinuityGateDecision({
        outputDir,
        now: NOW,
        activeMission: "Cleanup Crew runtime continuation",
        userInstruction: "Answer only. Do not do anything.",
        issue: {
          summary: "Technical path exists but user requested no action.",
          blocker: "tooling gap",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "bug_fix_same_behavior",
        },
        authoritySources: [
          {
            kind: "active_mission_lock",
            id: "cleanup-crew-active",
            summary: "Cleanup Crew active mission",
            active: true,
          },
        ],
      });

      expect(result.decision.selectedState).toBe("STOP_USER_ANSWER_ONLY_OVERRIDE");
      expect(result.decision.askMark).toBe(false);
      expect(result.writes.map((write) => write.kind)).toEqual(["diagnostic_trace"]);

      const trace = JSON.parse(await readFile(result.writes[0]!.path, "utf8")) as {
        schema: string;
        selected_state: string;
      };
      expect(trace).toMatchObject({
        schema: "openclaw.cleanup_crew_diagnostic_trace.v2",
        selected_state: "STOP_USER_ANSWER_ONLY_OVERRIDE",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
