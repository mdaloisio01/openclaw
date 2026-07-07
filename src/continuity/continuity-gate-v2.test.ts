import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCleanupCrewBlocker,
  classifyBuildContextConstraint,
  classifyGrantRejection,
  appendCleanupCrewPlanAmendment,
  createCleanupCrewDecisionRecord,
  createCleanupCrewResumeUnit,
  createCleanupCrewStoppageReceipt,
  createCleanupCrewRecoveryTelemetryEvent,
  createContinueReceipt,
  createDiagnosticTrace,
  createGrantRetryKey,
  createStopReport,
  deriveCleanupCrewRepair,
  evaluateContinuityGateV2,
  parseRootOperatorOverride,
  resolveAuthority,
  resolveCleanupCrewRepairExecutionGate,
  resolveCleanupCrewResumeGate,
  resolveCleanupCrewTelemetryCloseoutGate,
  resolveGrantRetry,
  writeCleanupCrewDurableArtifacts,
  type AuthoritySource,
  type BuildContextConstraint,
} from "./continuity-gate-v2.js";

const NOW = "2026-07-04T18:02:00.000Z";

function source(
  kind: AuthoritySource["kind"],
  id: string,
  overrides: Partial<AuthoritySource> = {},
): AuthoritySource {
  return {
    kind,
    id,
    summary: `${kind}:${id}`,
    active: true,
    createdAt: NOW,
    ...overrides,
  };
}

describe("Continuity Gate v2", () => {
  it("creates stoppage receipts with required proof-gap metadata and bounded output tails", () => {
    const receipt = createCleanupCrewStoppageReceipt({
      timestamp: NOW,
      missionId: "cleanup-crew-runtime-repair",
      taskFlowId: "flow-123",
      packetId: "packet-1",
      stageId: "validation",
      commandProcessId: "cmd-456",
      commandSpec: "node scripts/run-vitest.mjs run src/example.test.ts",
      workingDirectory: "/home/will/openclaw-source",
      gitHead: "7fe95e210b51a365d9d08e013e34369fa0374a35",
      dirtyTreeSummary: " M src/continuity/continuity-gate-v2.ts",
      stdoutTail: `${"x".repeat(4100)}stdout-end`,
      stderrTail: "expected failure tail",
      proofArtifactPath: "var/proof/receipt.json",
      logPath: "var/log/test.log",
      stoppageClass: "validation_nonzero_exit",
      suspectedAffectedSurface: "scripts/run-vitest.mjs",
      nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
    });

    expect(receipt).toMatchObject({
      schema: "openclaw.cleanup_crew_stoppage_receipt.v1",
      created_at: NOW,
      mission_id: "cleanup-crew-runtime-repair",
      task_flow_id: "flow-123",
      packet_id: "packet-1",
      stage_id: "validation",
      command_process_id: "cmd-456",
      command_spec: "node scripts/run-vitest.mjs run src/example.test.ts",
      working_directory: "/home/will/openclaw-source",
      git_state: {
        head: "7fe95e210b51a365d9d08e013e34369fa0374a35",
        dirty_tree_summary: " M src/continuity/continuity-gate-v2.ts",
      },
      captured_output: {
        stderr_tail: "expected failure tail",
        tail_truncated: true,
      },
      proof: {
        artifact_path: "var/proof/receipt.json",
        log_path: "var/log/test.log",
      },
      stoppage_class: "validation_nonzero_exit",
      suspected_affected_surface: "scripts/run-vitest.mjs",
      next_analysis_owner: "cleanup_crew_planning_dev_sop",
    });
    expect(receipt.receipt_id).toMatch(/^stoppage_receipt_/);
    expect(receipt.captured_output.stdout_tail).toHaveLength(4000);
    expect(receipt.captured_output.stdout_tail.endsWith("stdout-end")).toBe(true);
  });

  it("classifies Lane A technical repairs as autonomous only after plan amendment", () => {
    const repair = deriveCleanupCrewRepair({
      issue: {
        summary: "Missing proof receipt link can be repaired mechanically.",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "proof_or_receipt_shape",
        behaviorImpact: "technical",
      },
      repairAction: "write missing receipt ref",
      targetSurfaces: ["src/commands/cleanup-plan.ts"],
      validationSteps: [
        "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
      ],
      proofArtifacts: ["var/cleanup/proof-gap.json"],
      nextExecutableCommand:
        "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
    });

    expect(repair).toMatchObject({
      schema: "openclaw.cleanup_crew_derived_repair.v1",
      lane: "lane_a_technical_repair",
      can_execute_autonomously: true,
      requires_plan_amendment: true,
      requires_mark_decision: false,
      path_risk: "LOW_RISK_TECHNICAL",
      diff_intent: "proof_or_receipt_shape",
    });
  });

  it("classifies Lane B plan-driven build work inside the active plan boundary", () => {
    const repair = deriveCleanupCrewRepair({
      activeBuildPlanAuthorizesWork: true,
      issue: {
        summary: "Packet validation retry is already authorized by the active build plan.",
        pathRisk: "MEDIUM_RISK_RUNTIME",
        diffIntent: "test_alignment",
        behaviorImpact: "plan_driven",
        scopeWithinMission: true,
      },
      repairAction: "rerun focused validation from amended plan",
    });

    expect(repair).toMatchObject({
      lane: "lane_b_plan_driven_build_work",
      can_execute_autonomously: true,
      requires_plan_amendment: true,
      requires_mark_decision: false,
      path_risk: "MEDIUM_RISK_RUNTIME",
      diff_intent: "test_alignment",
    });
  });

  it("classifies Lane C product or behavior changes as Mark decisions", () => {
    const repair = deriveCleanupCrewRepair({
      issue: {
        summary: "Choose a new user-facing recovery flow.",
        pathRisk: "HIGH_RISK_BEHAVIOR",
        diffIntent: "new_feature_behavior",
        behaviorImpact: "ux_flow",
      },
      repairAction: "change user-facing recovery UX",
    });

    expect(repair).toMatchObject({
      lane: "lane_c_product_behavior_decision",
      can_execute_autonomously: false,
      requires_plan_amendment: false,
      requires_mark_decision: true,
      stop_state: "STOP_HUMAN_PRODUCT_DECISION",
    });
  });

  it("blocks repair execution before a plan amendment exists", () => {
    const repair = deriveCleanupCrewRepair({
      issue: {
        summary: "Repair focused validation proof.",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "test_alignment",
      },
      repairAction: "rerun focused validation",
      nextExecutableCommand: "node scripts/run-vitest.mjs run src/example.test.ts",
    });

    expect(resolveCleanupCrewRepairExecutionGate({ derivedRepair: repair })).toMatchObject({
      allowed: false,
      reason: "plan_amendment_required",
    });
  });

  it("appends active build plan amendments and authorizes exact resumed command after reload", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-plan-amendment-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n\nPacket 3\n", "utf8");
      const repair = deriveCleanupCrewRepair({
        activeBuildPlanAuthorizesWork: true,
        issue: {
          summary: "Focused validation failed and needs a planned retry.",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "test_alignment",
          behaviorImpact: "plan_driven",
        },
        repairAction: "rerun focused validation",
        targetSurfaces: ["src/continuity/continuity-gate-v2.ts"],
        validationSteps: [
          "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
        ],
        proofArtifacts: ["var/cleanup/packet3-proof.json"],
        nextExecutableCommand:
          "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
      });

      const write = await appendCleanupCrewPlanAmendment({
        activeBuildPlanPath: planPath,
        timestamp: NOW,
        stoppageId: "stoppage_receipt_packet3",
        derivedRepair: repair,
        diagnosis: "Focused validation failed after schema change; retry is inside plan.",
        stopConditions: ["validation fails again"],
        rollbackSafetyNotes: ["no raw DB/state edits"],
      });
      const amendedPlan = await readFile(planPath, "utf8");

      expect(write.amendment).toMatchObject({
        schema: "openclaw.cleanup_crew_plan_amendment.v1",
        active_build_plan_path: planPath,
        stoppage_id: "stoppage_receipt_packet3",
        lane_classification: "lane_b_plan_driven_build_work",
        next_executable_command:
          "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
      });
      expect(write.amendedPlanHash).not.toBe(write.basePlanHash);
      expect(amendedPlan).toContain("Cleanup Crew Recovery Amendment");
      expect(amendedPlan).toContain('"stoppage_id": "stoppage_receipt_packet3"');

      expect(
        resolveCleanupCrewRepairExecutionGate({
          derivedRepair: repair,
          amendment: write.amendment,
          currentPlanHash: write.amendedPlanHash,
          amendedPlanHash: write.amendedPlanHash,
        }),
      ).toMatchObject({
        allowed: true,
        amendmentId: write.amendment.amendment_id,
        nextExecutableCommand:
          "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks stale active plan amendments before resumed execution", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-plan-amendment-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n", "utf8");
      const repair = deriveCleanupCrewRepair({
        issue: {
          summary: "Repair proof gap.",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "proof_or_receipt_shape",
        },
        repairAction: "write proof receipt",
        nextExecutableCommand:
          "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
      });
      const write = await appendCleanupCrewPlanAmendment({
        activeBuildPlanPath: planPath,
        timestamp: NOW,
        stoppageId: "stoppage_receipt_stale",
        derivedRepair: repair,
        diagnosis: "Proof receipt missing.",
        stopConditions: ["proof still missing"],
        rollbackSafetyNotes: ["append-only plan amendment"],
      });

      expect(
        resolveCleanupCrewRepairExecutionGate({
          derivedRepair: repair,
          amendment: write.amendment,
          currentPlanHash: "not-the-current-plan-hash",
          amendedPlanHash: write.amendedPlanHash,
        }),
      ).toMatchObject({
        allowed: false,
        reason: "stale_plan_amendment",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prevents Lane C repairs from becoming executable plan amendments", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-plan-amendment-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n", "utf8");
      const repair = deriveCleanupCrewRepair({
        issue: {
          summary: "Choose new user-facing product behavior.",
          pathRisk: "HIGH_RISK_BEHAVIOR",
          diffIntent: "new_feature_behavior",
          behaviorImpact: "product_behavior",
        },
        repairAction: "change product behavior",
      });

      await expect(
        appendCleanupCrewPlanAmendment({
          activeBuildPlanPath: planPath,
          timestamp: NOW,
          stoppageId: "stoppage_receipt_lane_c",
          derivedRepair: repair,
          diagnosis: "Product decision needed.",
          stopConditions: ["Mark decision missing"],
          rollbackSafetyNotes: ["do not execute product behavior change"],
        }),
      ).rejects.toThrow("Lane C repair requires Mark decision");
      expect(resolveCleanupCrewRepairExecutionGate({ derivedRepair: repair })).toMatchObject({
        allowed: false,
        reason: "lane_c_mark_decision_required",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds resume units from active plan amendments and allows only the amended command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-resume-unit-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n", "utf8");
      const interruptedBundle =
        "node scripts/run-vitest.mjs run src/tasks/task-flow-registry.test.ts src/tasks/active-production-watchdog-lifecycle.test.ts";
      const repair = deriveCleanupCrewRepair({
        activeBuildPlanAuthorizesWork: true,
        issue: {
          summary: "Interrupted Packet F validation bundle must rerun from the plan.",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "test_alignment",
          behaviorImpact: "plan_driven",
        },
        repairAction: "rerun interrupted validation bundle",
        validationSteps: [interruptedBundle],
        proofArtifacts: ["var/cleanup/packet-f-validation.log"],
        nextExecutableCommand: interruptedBundle,
      });
      const write = await appendCleanupCrewPlanAmendment({
        activeBuildPlanPath: planPath,
        timestamp: NOW,
        stoppageId: "stoppage_interrupted_bundle",
        derivedRepair: repair,
        diagnosis: "Validation proof was interrupted; exact bundle rerun is required.",
        stopConditions: ["bundle exits nonzero", "output tail lost again"],
        rollbackSafetyNotes: ["rerun only; no source mutation"],
      });
      const resumeUnit = createCleanupCrewResumeUnit({
        amendmentWrite: write,
        workingDirectory: "/home/will/openclaw-source",
      });

      expect(resumeUnit).toMatchObject({
        schema: "openclaw.cleanup_crew_resume_unit.v1",
        amendment_id: write.amendment.amendment_id,
        plan_path: planPath,
        plan_hash: write.amendedPlanHash,
        command: interruptedBundle,
        cwd: "/home/will/openclaw-source",
        proof_artifacts: ["var/cleanup/packet-f-validation.log"],
      });
      expect(resumeUnit.idempotency_key).toMatch(/^resume_unit_key_/);
      expect(
        resolveCleanupCrewResumeGate({
          resumeUnit,
          requestedCommand: interruptedBundle,
          currentPlanHash: write.amendedPlanHash,
        }),
      ).toMatchObject({
        allowed: true,
        action: "execute_resume_unit",
        command: interruptedBundle,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks arbitrary retries that are not loaded from the amended plan", () => {
    const repair = deriveCleanupCrewRepair({
      issue: {
        summary: "Recover proof gap.",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "test_alignment",
      },
      repairAction: "rerun focused validation",
      nextExecutableCommand: "node scripts/run-vitest.mjs run src/expected.test.ts",
    });

    expect(resolveCleanupCrewResumeGate({ requestedCommand: "pnpm test" })).toMatchObject({
      allowed: false,
      reason: "resume_unit_required",
    });
    expect(
      resolveCleanupCrewRepairExecutionGate({
        derivedRepair: repair,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "plan_amendment_required",
    });
  });

  it("blocks requested commands that differ from the resume unit command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-resume-unit-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n", "utf8");
      const repair = deriveCleanupCrewRepair({
        issue: {
          summary: "Rerun exact proof command.",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "test_alignment",
        },
        repairAction: "rerun exact proof command",
        nextExecutableCommand: "node scripts/run-vitest.mjs run src/expected.test.ts",
      });
      const write = await appendCleanupCrewPlanAmendment({
        activeBuildPlanPath: planPath,
        timestamp: NOW,
        stoppageId: "stoppage_exact_command",
        derivedRepair: repair,
        diagnosis: "Exact command required.",
        stopConditions: ["validation fails"],
        rollbackSafetyNotes: ["no mutation"],
      });
      const resumeUnit = createCleanupCrewResumeUnit({
        amendmentWrite: write,
        workingDirectory: "/home/will/openclaw-source",
      });

      expect(
        resolveCleanupCrewResumeGate({
          resumeUnit,
          requestedCommand: "node scripts/run-vitest.mjs run src/other.test.ts",
          currentPlanHash: write.amendedPlanHash,
        }),
      ).toMatchObject({
        allowed: false,
        reason: "command_not_in_amended_plan",
        recoveryCommand: "node scripts/run-vitest.mjs run src/expected.test.ts",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not resume for report-only and records explicit stop with recovery command", () => {
    const resumeUnit = {
      schema: "openclaw.cleanup_crew_resume_unit.v1" as const,
      resume_id: "resume_unit_test",
      amendment_id: "plan_amendment_test",
      plan_path: "/tmp/plan.md",
      plan_hash: "hash",
      command: "node scripts/run-vitest.mjs run src/expected.test.ts",
      cwd: "/home/will/openclaw-source",
      idempotency_key: "resume_unit_key_test",
      proof_artifacts: [],
      stop_conditions: [],
    };

    expect(resolveCleanupCrewResumeGate({ resumeUnit, reportOnly: true })).toMatchObject({
      allowed: false,
      action: "do_not_resume",
      reason: "report_only",
    });
    expect(resolveCleanupCrewResumeGate({ resumeUnit, explicitStop: true })).toMatchObject({
      allowed: false,
      action: "record_lawful_stop",
      reason: "explicit_stop",
      recoveryCommand: "node scripts/run-vitest.mjs run src/expected.test.ts",
    });
  });

  it("creates structured recovery telemetry events with required transition fields", () => {
    const event = createCleanupCrewRecoveryTelemetryEvent({
      eventType: "stoppage_detected",
      missionId: "cleanup-crew-pause-analyze-plan-resume",
      taskFlowId: "flow-1",
      timestamp: NOW,
      gitHead: "7fe95e210b51a365d9d08e013e34369fa0374a35",
      dirtySourceDetected: true,
      activeLane: "lane_a_technical_repair",
      pathRiskEvaluation: "LOW_RISK_TECHNICAL",
      grantRetryCount: 0,
      fromState: "running",
      toState: "paused_for_analysis",
      reasonCode: "validation_nonzero_exit",
      diagnosticRef: "stoppage_receipt_1",
      nextExecutableCommand:
        "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
      nextExecutableCwd: "/home/will/openclaw-source",
    });

    expect(event).toMatchObject({
      schema: "openclaw.cleanup_crew_recovery_event.v1",
      event_type: "stoppage_detected",
      mission_id: "cleanup-crew-pause-analyze-plan-resume",
      task_flow_id: "flow-1",
      timestamp: NOW,
      git_state: {
        head: "7fe95e210b51a365d9d08e013e34369fa0374a35",
        dirty_source_detected: true,
      },
      active_lane: "lane_a_technical_repair",
      path_risk_evaluation: "LOW_RISK_TECHNICAL",
      grant_retry_count: 0,
      from_state: "running",
      to_state: "paused_for_analysis",
      reason_code: "validation_nonzero_exit",
      diagnostic_ref: "stoppage_receipt_1",
      next_executable_unit: {
        command: "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
        cwd: "/home/will/openclaw-source",
      },
    });
    expect(event.event_id).toMatch(/^recovery_event_/);
  });

  it("blocks closeout when required telemetry events are missing and ignores debug logs", () => {
    const event = createCleanupCrewRecoveryTelemetryEvent({
      eventType: "proof_gap_written",
      missionId: "cleanup-crew-pause-analyze-plan-resume",
      timestamp: NOW,
      gitHead: "head",
      dirtySourceDetected: false,
      fromState: "paused",
      toState: "proof_gap_written",
      reasonCode: "proof_gap",
      diagnosticRef: "stoppage_receipt",
      nextExecutableCommand: "node scripts/run-vitest.mjs run src/example.test.ts",
      nextExecutableCwd: "/home/will/openclaw-source",
    });

    expect(
      resolveCleanupCrewTelemetryCloseoutGate({
        events: [
          event,
          {
            schema: "debug.log",
            event_type: "plan_amended",
            message: "this is not a receipt",
          },
        ],
        requiredEventTypes: ["proof_gap_written", "plan_amended"],
      }),
    ).toMatchObject({
      allowed: false,
      reason: "missing_required_telemetry",
      missingEventTypes: ["plan_amended"],
    });
  });

  it("writes durable recovery telemetry artifacts", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telemetry-"));
    try {
      const event = createCleanupCrewRecoveryTelemetryEvent({
        eventType: "plan_amended",
        missionId: "cleanup-crew-pause-analyze-plan-resume",
        timestamp: NOW,
        gitHead: "head",
        dirtySourceDetected: false,
        activeLane: "lane_b_plan_driven_build_work",
        pathRiskEvaluation: "MEDIUM_RISK_RUNTIME",
        fromState: "analysis_completed",
        toState: "plan_amended",
        reasonCode: "active_plan_recovery_amendment",
        diagnosticRef: "plan_amendment_1",
        nextExecutableCommand: "node scripts/run-vitest.mjs run src/example.test.ts",
        nextExecutableCwd: "/home/will/openclaw-source",
      });
      const writes = await writeCleanupCrewDurableArtifacts({
        outputDir,
        telemetryEvents: [event],
      });

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        kind: "telemetry_event",
      });
      expect(writes[0]?.path).toContain("cleanup_crew_recovery_events");
      const saved = JSON.parse(await readFile(writes[0]!.path, "utf8")) as { schema: string };
      expect(saved.schema).toBe("openclaw.cleanup_crew_recovery_event.v1");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("runs adversarial stoppage drills through pause, analysis, plan amendment or stop decision", async () => {
    const recoverableDrills = [
      ["validation_nonzero_exit", "validation failed", "test_alignment"],
      ["external_turn_interruption", "foreground turn interrupted", "proof_or_receipt_shape"],
      ["lost_output_tail", "output tail was lost", "proof_or_receipt_shape"],
      [
        "watchdog_needs_review",
        "watchdog NEEDS_REVIEW requires planned repair",
        "proof_or_receipt_shape",
      ],
      [
        "watchdog_monitor_disabled",
        "watchdog MONITOR_DISABLED during active work",
        "proof_or_receipt_shape",
      ],
      ["grant_fail", "Grant rejected mechanical proof link", "mechanical_format"],
      [
        "dirty_tree_block",
        "dirty tree block requires planned source hygiene",
        "routing_or_catalog_recording",
      ],
      ["restart_failure", "restart proof failed", "proof_or_receipt_shape"],
      ["runtime_proof_failure", "runtime proof failed", "proof_or_receipt_shape"],
      ["shell_session_aborted", "shell session aborted", "proof_or_receipt_shape"],
      ["command_timeout", "command timed out", "test_alignment"],
      ["subprocess_signal_exit", "subprocess exited by signal", "test_alignment"],
      ["subprocess_error_event", "subprocess error event", "test_alignment"],
    ] as const;

    for (const [stoppageClass, summary, diffIntent] of recoverableDrills) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-adversarial-drill-"));
      try {
        const planPath = path.join(dir, "active-build-plan.md");
        await writeFile(planPath, "# Active Build Plan\n", "utf8");
        const receipt = createCleanupCrewStoppageReceipt({
          timestamp: NOW,
          missionId: "cleanup-crew-adversarial-drills",
          packetId: "packet-11",
          stageId: stoppageClass,
          commandProcessId: `cmd-${stoppageClass}`,
          commandSpec: "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
          workingDirectory: "/home/will/openclaw-source",
          gitHead: "head",
          dirtyTreeSummary: " M src/continuity/continuity-gate-v2.ts",
          stdoutTail: summary,
          stderrTail: "",
          proofArtifactPath: "var/cleanup/stoppage.json",
          stoppageClass,
          suspectedAffectedSurface: "src/continuity/continuity-gate-v2.ts",
          nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
        });
        const repair = deriveCleanupCrewRepair({
          activeBuildPlanAuthorizesWork: true,
          issue: {
            summary,
            pathRisk: "LOW_RISK_TECHNICAL",
            diffIntent,
            behaviorImpact: "plan_driven",
            scopeWithinMission: true,
          },
          repairAction: `recover ${stoppageClass}`,
          targetSurfaces: ["src/continuity/continuity-gate-v2.ts"],
          validationSteps: [
            "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
          ],
          proofArtifacts: [receipt.receipt_id],
          nextExecutableCommand:
            "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
        });
        const amendment = await appendCleanupCrewPlanAmendment({
          activeBuildPlanPath: planPath,
          timestamp: NOW,
          stoppageId: receipt.receipt_id,
          derivedRepair: repair,
          diagnosis: summary,
          stopConditions: ["same stoppage repeats"],
          rollbackSafetyNotes: ["no raw DB/state edits"],
        });
        const resumeUnit = createCleanupCrewResumeUnit({
          amendmentWrite: amendment,
          workingDirectory: "/home/will/openclaw-source",
        });
        const telemetry = createCleanupCrewRecoveryTelemetryEvent({
          eventType: "plan_amended",
          missionId: "cleanup-crew-adversarial-drills",
          timestamp: NOW,
          gitHead: "head",
          dirtySourceDetected: true,
          activeLane: repair.lane,
          pathRiskEvaluation: repair.path_risk,
          fromState: "analysis_completed",
          toState: "plan_amended",
          reasonCode: stoppageClass,
          diagnosticRef: amendment.amendment.amendment_id,
          nextExecutableCommand: resumeUnit.command,
          nextExecutableCwd: resumeUnit.cwd,
        });

        expect(repair.requires_plan_amendment).toBe(true);
        expect(
          resolveCleanupCrewResumeGate({
            resumeUnit,
            requestedCommand: resumeUnit.command,
            currentPlanHash: amendment.amendedPlanHash,
          }),
        ).toMatchObject({ allowed: true });
        expect(
          resolveCleanupCrewTelemetryCloseoutGate({
            events: [telemetry],
            requiredEventTypes: ["plan_amended"],
          }),
        ).toMatchObject({ allowed: true });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    expect(
      deriveCleanupCrewRepair({
        issue: {
          summary: "Lane C product change",
          pathRisk: "HIGH_RISK_BEHAVIOR",
          diffIntent: "new_feature_behavior",
          behaviorImpact: "product_behavior",
        },
        repairAction: "change product behavior",
      }),
    ).toMatchObject({
      lane: "lane_c_product_behavior_decision",
      requires_mark_decision: true,
    });
    expect(classifyCleanupCrewBlocker({ rawDbRequired: true })).toMatchObject({
      category: "raw_db_required_blocker",
      hardStopWholeMission: true,
    });
    expect(classifyCleanupCrewBlocker({ unsafeOrDestructive: true })).toMatchObject({
      category: "unsafe_destructive_blocker",
      hardStopWholeMission: true,
    });
    expect(
      classifyCleanupCrewBlocker({
        summary: "stale active TaskFlow needs analysis with safe next action",
        nextRepairPathKnown: true,
      }),
    ).toMatchObject({
      status: "in_progress",
    });
    expect(
      classifyCleanupCrewBlocker({
        summary: "orphaned lost child task has repair route",
        nextRepairPathKnown: true,
      }),
    ).toMatchObject({
      canContinueCleanupRepair: true,
    });
    expect(resolveCleanupCrewResumeGate({ reportOnly: true })).toMatchObject({
      allowed: false,
      reason: "report_only",
    });
    expect(resolveCleanupCrewResumeGate({ explicitStop: true })).toMatchObject({
      allowed: false,
      action: "record_lawful_stop",
      reason: "explicit_stop",
    });
    expect(classifyCleanupCrewBlocker({ authorityOrScopeMissing: true })).toMatchObject({
      category: "authority_scope_blocker",
      hardStopWholeMission: true,
    });
  });

  it("continues through technical repair blockers without asking Mark", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Grant rejected closeout for missing proof path.",
        blocker: "proof missing",
        pathRisk: "MEDIUM_RISK_RUNTIME",
        diffIntent: "proof_or_receipt_shape",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    expect(decision.selectedState).toBe("CONTINUE_TECHNICAL_REPAIR");
    expect(decision.shouldContinue).toBe(true);
    expect(decision.askMark).toBe(false);
    expect(decision.invalidStopReasonRejected).toBe("proof missing");
  });

  it("classifies repairable prerequisite blockers as continue cleanup repair", () => {
    expect(
      classifyCleanupCrewBlocker({
        blocker: "repairable prerequisite blocker",
        nextRepairPathKnown: true,
      }),
    ).toMatchObject({
      category: "repairable_prerequisite_blocker",
      status: "in_progress",
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
      scopedStops: ["stop_final_closeout", "continue_cleanup_repair"],
    });
  });

  it("classifies downstream phase stops without stopping the whole mission", () => {
    expect(
      classifyCleanupCrewBlocker({
        summary: "Phase 13 watchdog blocker should stop Phase 14 but continue Cleanup Crew repair.",
        blocker: "downstream phase blocked",
      }),
    ).toMatchObject({
      category: "downstream_phase_blocked_cleanup_continues",
      status: "in_progress",
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
      scopedStops: [
        "stop_adjacent_phase",
        "stop_phase_transition",
        "stop_final_closeout",
        "continue_cleanup_repair",
      ],
    });
  });

  it("classifies raw DB required without emergency SOP as a hard whole-mission stop", () => {
    expect(
      classifyCleanupCrewBlocker({
        rawDbRequired: true,
        emergencySopAuthorized: false,
      }),
    ).toMatchObject({
      category: "raw_db_required_blocker",
      status: "blocked",
      canContinueCleanupRepair: false,
      hardStopWholeMission: true,
      scopedStops: ["stop_final_closeout", "hard_stop_whole_mission"],
    });
  });

  it("hard-stops unsupported missing surfaces only when no lawful discovery path exists", () => {
    expect(
      classifyCleanupCrewBlocker({
        unsupportedSurfaceMissing: true,
        lawfulDiscoveryPathAvailable: false,
      }),
    ).toMatchObject({
      category: "unsupported_surface_missing_blocker",
      status: "blocked",
      hardStopWholeMission: true,
    });

    expect(
      classifyCleanupCrewBlocker({
        unsupportedSurfaceMissing: true,
        lawfulDiscoveryPathAvailable: true,
      }),
    ).toMatchObject({
      category: "unsupported_surface_missing_blocker",
      status: "in_progress",
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
      scopedStops: ["stop_final_closeout", "continue_cleanup_repair"],
    });
  });

  it("routes proof-source unavailable to recovery when alternate lawful proof exists", () => {
    expect(
      classifyCleanupCrewBlocker({
        proofSourceUnavailable: true,
        alternateProofSourceAvailable: true,
      }),
    ).toMatchObject({
      category: "proof_source_unavailable_blocker",
      status: "in_progress",
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
    });
  });

  it("classifies the Phase 13 watchdog pattern as phase stop plus cleanup repair continuation", () => {
    expect(
      classifyCleanupCrewBlocker({
        summary:
          "Phase 13 watchdog NEEDS_REVIEW blocks Phase 14/final closeout; inspect latest watchdog receipt and rerun watchdog.",
      }),
    ).toMatchObject({
      category: "downstream_phase_blocked_cleanup_continues",
      status: "in_progress",
      scopedStops: [
        "stop_adjacent_phase",
        "stop_phase_transition",
        "stop_final_closeout",
        "continue_cleanup_repair",
      ],
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
    });
  });

  it("stops for root answer-only and inspect-only overrides", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      userInstruction: "Inspect only. Do not do anything yet.",
      issue: {
        summary: "technical proof repair exists",
        blocker: "test failed",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "bug_fix_same_behavior",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    expect(decision.selectedState).toBe("STOP_USER_ANSWER_ONLY_OVERRIDE");
    expect(decision.shouldContinue).toBe(false);
    expect(decision.askMark).toBe(false);
  });

  it("ignores answer-only phrases inside code fences and historical excerpts", () => {
    expect(
      parseRootOperatorOverride(
        "Continue Cleanup Crew.\n\n```text\nDo not do anything, just answer yes or no.\n```",
      ),
    ).toBeUndefined();
    expect(
      parseRootOperatorOverride(
        "Continue Cleanup Crew.\n\n> Prior log: inspect only and do not mutate.",
      ),
    ).toBeUndefined();
  });

  it("stops for product, UX, GUI, and system-purpose decisions", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Choose whether the dashboard workflow should add a new approval screen.",
        pathRisk: "HIGH_RISK_BEHAVIOR",
        diffIntent: "new_feature_behavior",
        behaviorImpact: "ux_flow",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    expect(decision.selectedState).toBe("STOP_HUMAN_PRODUCT_DECISION");
    expect(decision.askMark).toBe(true);
    expect(decision.stopReport?.why_this_is_not_technical).toContain("ux_flow");
  });

  it("diagnoses authority conflicts before stopping", () => {
    const resolved = resolveAuthority([
      source("historical_closeout", "old-closeout", { active: false }),
      source("active_build_plan", "current-plan"),
    ]);

    expect(resolved.winner).toBe("active_build_plan");
    expect(resolved.conflict_type).toBe("stale_artifact");
    expect(resolved.continue_state).toBe("CONTINUE_AFTER_AUTHORITY_CONFLICT_DIAGNOSIS");
  });

  it("stops on unresolved live authority conflict", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Two active live authorities conflict.",
        pathRisk: "MEDIUM_RISK_RUNTIME",
        diffIntent: "routing_or_catalog_recording",
      },
      authoritySources: [
        source("active_build_plan", "plan-a", { conflictWith: ["plan-b"] }),
        source("active_build_plan", "plan-b", { conflictWith: ["plan-a"] }),
      ],
    });

    expect(decision.selectedState).toBe("STOP_UNRESOLVED_AUTHORITY_CONFLICT");
    expect(decision.shouldContinue).toBe(false);
    expect(decision.askMark).toBe(false);
  });

  it("stops unsafe SOP-blocked behavior without asking Mark as a technical question", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Proposed repair conflicts with a live SOP safety block.",
        pathRisk: "CRITICAL_CONTROL",
        diffIntent: "bug_fix_same_behavior",
      },
      authoritySources: [
        source("active_build_plan", "continuity-gate-v2"),
        source("global_sop", "safety-stop", {
          safetyBlock: true,
          proofPath: "sop-proof.md",
        }),
      ],
    });

    expect(decision.selectedState).toBe("STOP_UNSAFE_BEHAVIOR_CHANGE");
    expect(decision.shouldContinue).toBe(false);
    expect(decision.askMark).toBe(false);
  });

  it("uses path risk plus diff intent instead of absolute path bans", () => {
    const proofShape = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Record already-authorized verifier proof ref.",
        pathRisk: "HIGH_RISK_BEHAVIOR",
        diffIntent: "proof_or_receipt_shape",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });
    const semantics = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Change user-facing GUI flow semantics.",
        pathRisk: "HIGH_RISK_BEHAVIOR",
        diffIntent: "behavior_semantics_change",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    expect(proofShape.shouldContinue).toBe(true);
    expect(proofShape.grantReviewRequired).toBe(true);
    expect(semantics.selectedState).toBe("STOP_HUMAN_PRODUCT_DECISION");
  });

  it("classifies Grant mechanical failures as repairable within ceilings", () => {
    const rejection = classifyGrantRejection("missing artifact path(s)");
    const retry = resolveGrantRetry({
      retrySurfaceId: "grant_closeout:continuity_gate:artifact_fields",
      rejectionType: rejection,
      priorAttempts: 2,
    });

    expect(rejection).toBe("MECHANICAL_CLOSEOUT_FORMAT");
    expect(retry.result).toBe("continue_repair");
    expect(retry.attempt).toBe(3);
    expect(retry.maxAttempts).toBe(3);
    expect(retry.continueState).toBe("CONTINUE_AFTER_REPAIRABLE_GRANT_REJECTION");
  });

  it("generates deterministic Grant retry keys from rejection type, surface hash, and artifact id", () => {
    const key = createGrantRetryKey({
      rejectionType: "MECHANICAL_PROOF_LINK",
      fileSurfaceHash: "abc123",
      artifactId: "grant-closeout-artifact",
    });

    expect(key).toBe(
      createGrantRetryKey({
        rejectionType: "MECHANICAL_PROOF_LINK",
        fileSurfaceHash: "abc123",
        artifactId: "grant-closeout-artifact",
      }),
    );
    expect(key).not.toBe(
      createGrantRetryKey({
        rejectionType: "SEMANTIC_SAFETY",
        fileSurfaceHash: "abc123",
        artifactId: "grant-closeout-artifact",
      }),
    );
    expect(key).toMatch(/^grant_retry_/);
  });

  it.each([
    ["MECHANICAL_CLOSEOUT_FORMAT", 2, "continue_repair", 3],
    ["MECHANICAL_CLOSEOUT_FORMAT", 3, "stop_or_true_blocker", 3],
    ["MECHANICAL_PROOF_LINK", 2, "continue_repair", 3],
    ["MECHANICAL_PROOF_LINK", 3, "stop_or_true_blocker", 3],
    ["SEMANTIC_SAFETY", 0, "stop_or_true_blocker", 1],
    ["SCOPE_EXPANSION", 0, "stop_or_plan_update_required", 0],
  ] as const)(
    "enforces Grant retry ceiling for %s after %s prior attempt(s)",
    (rejectionType, priorAttempts, result, maxAttempts) => {
      expect(
        resolveGrantRetry({
          retrySurfaceId: createGrantRetryKey({
            rejectionType,
            fileSurfaceHash: "surface",
            artifactId: "artifact",
          }),
          rejectionType,
          priorAttempts,
        }),
      ).toMatchObject({
        result,
        maxAttempts,
      });
    },
  );

  it("does not force Grant semantic safety or scope expansion failures", () => {
    expect(
      resolveGrantRetry({
        retrySurfaceId: "grant:safety",
        rejectionType: "SEMANTIC_SAFETY",
        priorAttempts: 1,
      }).result,
    ).toBe("stop_or_true_blocker");
    expect(
      resolveGrantRetry({
        retrySurfaceId: "grant:scope",
        rejectionType: "SCOPE_EXPANSION",
        priorAttempts: 0,
      }).result,
    ).toBe("stop_or_plan_update_required");
  });

  it("refreshes expired build-context constraints instead of stopping", () => {
    const constraint: BuildContextConstraint = {
      schema: "openclaw.build_context_constraint.v2",
      constraint_id: "current_trinity_exclusion_2026_07",
      label: "Trinity excluded from current cleanup chain",
      source_artifact: "artifact.md",
      created_at: "2026-07-04T15:00:00.000Z",
      expires_at: "2026-07-04T17:00:00.000Z",
      max_major_phase_count: 1,
      refresh_probe: "verify_active_plan_and_shared_file_overlap",
      on_expiry: "REFRESH_THEN_RECLASSIFY",
      status: "active",
    };

    expect(classifyBuildContextConstraint(constraint, NOW)).toMatchObject({
      status: "expired",
      action: "REFRESH_THEN_RECLASSIFY",
      selectedState: "CONTINUE_PLAN_NEXT_STEP",
    });
  });

  it("creates decision records, continue receipts, stop reports, and diagnostic traces", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "test failed but fix is known",
        blocker: "test failed",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "test_alignment",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    const record = createCleanupCrewDecisionRecord(decision);
    const receipt = createContinueReceipt(decision, {
      repairAction: "repair focused test",
      proofPath: "proof.json",
    });
    const stop = createStopReport(
      evaluateContinuityGateV2({
        now: NOW,
        activeMission: "Cleanup Crew repair",
        issue: {
          summary: "new product decision",
          pathRisk: "HIGH_RISK_BEHAVIOR",
          diffIntent: "new_feature_behavior",
          behaviorImpact: "product_behavior",
        },
        authoritySources: [source("active_build_plan", "continuity-gate-v2")],
      }),
      { diagnosticArtifact: "diagnostic.json" },
    );
    const trace = createDiagnosticTrace(decision, {
      filesTouched: ["src/continuity/continuity-gate-v2.ts"],
      tests: ["continuity-gate-v2.test.ts"],
      surfaces: ["cleanup-plan"],
      records: ["decision-record"],
      commands: ["node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts"],
      grantResult: "not_requested",
      proofRefs: ["proof.json"],
      redactionStatus: "no_sensitive_payloads",
    });

    expect(record.schema).toBe("openclaw.cleanup_crew_decision_record.v2");
    expect(receipt.schema).toBe("openclaw.cleanup_crew_continue_receipt.v2");
    expect(stop.schema).toBe("openclaw.cleanup_crew_stop_report.v2");
    expect(trace.schema).toBe("openclaw.cleanup_crew_diagnostic_trace.v2");
    expect(trace).toMatchObject({
      owner_level_blocker_audit: "technical_owner",
      risk_classification: {
        path_risk: "LOW_RISK_TECHNICAL",
        diff_intent: "test_alignment",
      },
      technical_vs_product: {
        lane: "technical",
      },
      scope: {
        surfaces: ["cleanup-plan"],
        records: ["decision-record"],
        commands: ["node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts"],
      },
      grant_result: "not_requested",
      proof_refs: ["proof.json"],
    });
  });

  it("writes durable decision, receipt, stop-report, and diagnostic artifacts", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-gate-"));
    try {
      const decision = evaluateContinuityGateV2({
        now: NOW,
        activeMission: "Cleanup Crew repair",
        issue: {
          summary: "missing proof but repair path is known",
          blocker: "proof missing",
          pathRisk: "MEDIUM_RISK_RUNTIME",
          diffIntent: "proof_or_receipt_shape",
        },
        authoritySources: [source("active_build_plan", "continuity-gate-v2")],
      });
      const stopDecision = evaluateContinuityGateV2({
        now: NOW,
        activeMission: "Cleanup Crew repair",
        issue: {
          summary: "new UX behavior decision",
          pathRisk: "HIGH_RISK_BEHAVIOR",
          diffIntent: "new_feature_behavior",
          behaviorImpact: "ux_flow",
        },
        authoritySources: [source("active_build_plan", "continuity-gate-v2")],
      });
      const record = createCleanupCrewDecisionRecord(decision);
      const receipt = createContinueReceipt(decision, {
        repairAction: "repair proof path",
        proofPath: "proof.json",
      });
      const stopReport = createStopReport(stopDecision, {
        diagnosticArtifact: "diagnostic.json",
      });
      const trace = createDiagnosticTrace(decision, {
        filesTouched: ["src/continuity/continuity-gate-v2.ts"],
        tests: ["src/continuity/continuity-gate-v2.test.ts"],
        redactionStatus: "no_sensitive_payloads",
      });

      const writes = await writeCleanupCrewDurableArtifacts({
        outputDir,
        decisionRecord: record,
        continueReceipt: receipt,
        stopReport,
        diagnosticTrace: trace,
      });

      expect(writes.map((write) => write.kind)).toEqual([
        "decision_record",
        "continue_receipt",
        "stop_report",
        "diagnostic_trace",
      ]);
      const persistedRecord = JSON.parse(await readFile(writes[0]!.path, "utf8")) as {
        schema: string;
        decision_id: string;
      };
      expect(persistedRecord).toMatchObject({
        schema: "openclaw.cleanup_crew_decision_record.v2",
        decision_id: decision.decisionId,
      });
      expect(writes.every((write) => write.path.startsWith(outputDir))).toBe(true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
