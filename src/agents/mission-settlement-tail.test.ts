import { describe, expect, it } from "vitest";
import {
  missionDeliveryStateFromSourceTurnDelivery,
  renderMissionCloseoutReport,
  resolveGovernedTurnSettlement,
  resolveMissionSettlementTail,
  resolveMissionSettlementTailFromSourceTurnDelivery,
  validateStructuredMissionCloseout,
  type StructuredMissionCloseout,
} from "./mission-settlement-tail.js";

const VALID_CLOSEOUT: StructuredMissionCloseout = {
  runLabel: "Mission settlement tail closeout",
  targetHandled: "final report delivery tail",
  scopeHandled: "structured closeout and delivery settlement",
  actualExecutionOwner: "Cleanup Crew",
  artifactPaths: ["/tmp/settlement-closeout.md"],
  proofPaths: ["src/agents/mission-settlement-tail.test.ts"],
  whatIsMateriallyRealNow: "Work result is durable and closeout state is structured.",
  whatIsStillNotRealYet: "Runtime activation is not claimed by this unit test.",
  whoLawfullyOwnsNextStep: "Will owns controller review.",
  openClosedTruth: "owner execution in progress, build still open.",
  exactNextAction: "run focused validation",
  shortResult: "Settlement tail state machine passed focused proof.",
};

describe("mission settlement tail", () => {
  describe("governed turn settlement", () => {
    const BASE_SETTLEMENT = {
      settlementId: "settlement-1",
      missionId: "issue-040",
      finalReportRequired: true,
      finalReportArtifactWritten: true,
      finalReportVisibleDeliveryProven: true,
      issueFamilyNamed: true,
      issueRegisterActionProven: true,
      broaderMissionOpen: false,
      toolBoundaryClean: true,
      watchdogProofCollected: true,
    };

    it("does not accept an artifact as final visible delivery proof", () => {
      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          finalReportVisibleDeliveryProven: false,
        }),
      ).toMatchObject({
        state: "unsettled",
        allowedToCloseMission: false,
        allowedToAcceptReport: false,
        watchdogVisible: true,
        recoveryAction: "deliver_final_report",
        nextIncompleteBoundary: "visible_final_delivery",
      });
    });

    it("settles a closed mission only after final visible delivery and issue action proof", () => {
      expect(resolveGovernedTurnSettlement(BASE_SETTLEMENT)).toMatchObject({
        state: "settled_delivered",
        allowedToCloseMission: true,
        allowedToAcceptReport: true,
        watchdogVisible: false,
        recoveryAction: "settlement_complete",
        nextIncompleteBoundary: "none",
      });
    });

    it("requires issue register proof or a lawful no-update reason when an issue family is named", () => {
      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          issueRegisterActionProven: false,
        }),
      ).toMatchObject({
        state: "unsettled",
        recoveryAction: "record_issue_register_action",
        nextIncompleteBoundary: "issue_register_action",
      });

      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          issueRegisterActionProven: false,
          lawfulNoIssueUpdateReason: "same current-blocker recurrence already logged in this turn",
        }),
      ).toMatchObject({
        state: "settled_delivered",
        allowedToCloseMission: true,
      });
    });

    it("keeps broader open work unsettled until next-step coverage exists", () => {
      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          broaderMissionOpen: true,
          nextExecutableStepStarted: false,
          durableWaitRecorded: false,
          lawfulBlockerRecorded: false,
        }),
      ).toMatchObject({
        state: "unsettled",
        watchdogVisible: true,
        recoveryAction: "record_next_step_coverage",
        nextIncompleteBoundary: "next_step_coverage",
      });

      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          broaderMissionOpen: true,
          nextExecutableStepStarted: true,
        }),
      ).toMatchObject({
        state: "settled_handoff",
        allowedToCloseMission: false,
        allowedToAcceptReport: true,
        recoveryAction: "continue_from_handoff",
      });
    });

    it("accepts a proven lawful blocker without closing the broader mission", () => {
      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          broaderMissionOpen: true,
          lawfulBlockerRecorded: true,
        }),
      ).toMatchObject({
        state: "settled_blocked",
        allowedToCloseMission: false,
        allowedToAcceptReport: true,
        recoveryAction: "keep_lawful_blocker_visible",
      });
    });

    it("requires tool boundary failure proof when tool integrity is dirty", () => {
      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          toolBoundaryClean: false,
          toolBoundaryFailureRecorded: false,
        }),
      ).toMatchObject({
        state: "unsettled",
        recoveryAction: "record_tool_boundary_failure",
        nextIncompleteBoundary: "tool_boundary_integrity",
      });

      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          toolBoundaryClean: false,
          toolBoundaryFailureRecorded: true,
          broaderMissionOpen: true,
          lawfulBlockerRecorded: true,
        }),
      ).toMatchObject({
        state: "settled_blocked",
        allowedToAcceptReport: true,
      });
    });

    it("requires watchdog proof when a governed settlement explicitly depends on it", () => {
      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          watchdogProofCollected: false,
        }),
      ).toMatchObject({
        state: "unsettled",
        recoveryAction: "collect_watchdog_proof",
        nextIncompleteBoundary: "watchdog_proof",
      });
    });

    it("fails closed when settlement identity is missing", () => {
      expect(
        resolveGovernedTurnSettlement({
          ...BASE_SETTLEMENT,
          settlementId: "",
          missionId: "",
        }),
      ).toMatchObject({
        state: "unsettled",
        recoveryAction: "record_settlement_identity",
        nextIncompleteBoundary: "settlement_identity",
        validationErrors: ["settlement_id_missing", "mission_id_missing"],
      });
    });
  });

  it("validates structured closeout state without reparsing human prose", () => {
    expect(validateStructuredMissionCloseout(VALID_CLOSEOUT)).toEqual({
      valid: true,
      missingFields: [],
      missingSupportFields: [],
    });

    expect(
      validateStructuredMissionCloseout({
        ...VALID_CLOSEOUT,
        whatIsMateriallyRealNow: "",
        proofPaths: [],
      }),
    ).toEqual({
      valid: false,
      missingFields: ["whatIsMateriallyRealNow"],
      missingSupportFields: ["proofPaths"],
    });
  });

  it("renders the required Mark-facing truth fields from structured closeout state", () => {
    const report = renderMissionCloseoutReport(VALID_CLOSEOUT);

    expect(report).toContain("What is materially real now:");
    expect(report).toContain("What is still not real yet:");
    expect(report).toContain("Who lawfully owns the next step:");
    expect(report).toContain("Open/closed truth:");
    expect(report).toContain("Exact next action:");
    expect(report).toContain("Work result is durable and closeout state is structured.");
  });

  it("keeps completed work separate from settled mission truth until result is durable", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-1",
        workState: "completed",
        resultDurable: false,
        reportRequired: true,
      }),
    ).toMatchObject({
      state: "WORK_COMPLETED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      recoveryAction: "persist_completed_result",
      nextIncompleteBoundary: "result_durable",
    });
  });

  it("repairs closeout only when work result is durable but structured closeout is invalid", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-2",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: { ...VALID_CLOSEOUT, exactNextAction: "" },
        reportRequired: true,
      }),
    ).toMatchObject({
      state: "CLOSEOUT_BLOCKED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      recoveryAction: "repair_structured_closeout_only",
      nextIncompleteBoundary: "closeout_validated",
      closeoutValidation: {
        valid: false,
        missingFields: ["exactNextAction"],
      },
    });
  });

  it("renders the human report only after structured closeout validates", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-3",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: VALID_CLOSEOUT,
        reportRequired: true,
        reportRendered: false,
      }),
    ).toMatchObject({
      state: "CLOSEOUT_VALIDATED",
      settled: false,
      recoveryAction: "render_human_report_from_validated_closeout",
      nextIncompleteBoundary: "report_rendered",
    });
  });

  it("persists delivery intent before attempting delivery", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-4",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: VALID_CLOSEOUT,
        reportRequired: true,
        reportRendered: true,
        deliveryState: "not_started",
      }),
    ).toMatchObject({
      state: "REPORT_RENDERED",
      settled: false,
      recoveryAction: "persist_delivery_intent",
      nextIncompleteBoundary: "delivery_intent",
    });
  });

  it("retries failed delivery without reopening completed work", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-5",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: VALID_CLOSEOUT,
        reportRequired: true,
        reportRendered: true,
        deliveryState: "failed",
      }),
    ).toMatchObject({
      state: "DELIVERY_FAILED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      recoveryAction: "retry_delivery_only_with_idempotency",
      nextIncompleteBoundary: "delivery_retry",
    });
  });

  it("treats ambiguous delivery acknowledgement as reconciliation work, not success", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-6",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: VALID_CLOSEOUT,
        reportRequired: true,
        reportRendered: true,
        deliveryState: "unknown",
      }),
    ).toMatchObject({
      state: "DELIVERY_UNKNOWN",
      settled: false,
      allowedToCloseMission: false,
      recoveryAction: "reconcile_ambiguous_delivery_ack",
      nextIncompleteBoundary: "delivery_unknown",
    });
  });

  it("maps source-turn unknown-after-send into mission delivery unknown", () => {
    const sourceTurnDecision = {
      state: "final_delivery_unknown",
      finalDeliveryDelivered: false,
      refused: false,
      reason: "delivery_outcome_unknown_after_send",
    } as const;

    expect(missionDeliveryStateFromSourceTurnDelivery(sourceTurnDecision)).toBe("unknown");
    expect(
      resolveMissionSettlementTailFromSourceTurnDelivery({
        missionId: "mission-6b",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: VALID_CLOSEOUT,
        reportRequired: true,
        reportRendered: true,
        sourceTurnDelivery: sourceTurnDecision,
      }),
    ).toMatchObject({
      state: "DELIVERY_UNKNOWN",
      settled: false,
      recoveryAction: "reconcile_ambiguous_delivery_ack",
      nextIncompleteBoundary: "delivery_unknown",
    });
  });

  it("treats later verified source-turn settlement as mission delivery proof", () => {
    expect(
      resolveMissionSettlementTailFromSourceTurnDelivery({
        missionId: "mission-6c",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: VALID_CLOSEOUT,
        reportRequired: true,
        reportRendered: true,
        sourceTurnDelivery: {
          state: "settled_resolved_later",
          finalDeliveryDelivered: false,
          refused: false,
          reason: "historical_debt_settled_not_delivered",
        },
      }),
    ).toMatchObject({
      state: "SETTLED",
      settled: true,
      recoveryAction: "settlement_complete",
    });
  });

  it("settles only after work result, closeout, report, and delivery proof are all present", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-7",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: VALID_CLOSEOUT,
        reportRequired: true,
        reportRendered: true,
        deliveryState: "proven",
      }),
    ).toMatchObject({
      state: "SETTLED",
      settled: true,
      allowedToCloseMission: true,
      recoveryAction: "settlement_complete",
      nextIncompleteBoundary: "none",
    });
  });

  it("fences live workers and concurrent recovery before settlement mutation", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-8",
        workState: "running",
        oldWorkerAlive: true,
      }),
    ).toMatchObject({
      state: "RECOVERY_REQUIRED",
      recoveryAction: "reconcile_live_worker_before_recovery",
      nextIncompleteBoundary: "live_worker",
    });

    expect(
      resolveMissionSettlementTail({
        missionId: "mission-8",
        workState: "completed",
        resultDurable: true,
        recoveryConflict: true,
      }),
    ).toMatchObject({
      state: "RECOVERY_REQUIRED",
      recoveryAction: "reread_after_revision_conflict",
      nextIncompleteBoundary: "revision_conflict",
    });
  });

  it("does not treat truncated oversized evidence as sufficient without a durable reference", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-9",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: VALID_CLOSEOUT,
        reportRequired: true,
        reportRendered: true,
        deliveryState: "proven",
        oversizedEvidenceTruncated: true,
      }),
    ).toMatchObject({
      state: "RECOVERY_REQUIRED",
      settled: false,
      allowedToCloseMission: false,
      workCompletionSettledSeparately: true,
      recoveryAction: "record_bounded_evidence_reference",
      validationErrors: [
        "oversized_evidence_reference_missing",
        "oversized_evidence_sufficiency_unproven",
      ],
      nextIncompleteBoundary: "oversized_evidence_sufficiency",
    });
  });

  it("allows referenced oversized evidence only when sufficiency is explicitly proven", () => {
    expect(
      resolveMissionSettlementTail({
        missionId: "mission-10",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: VALID_CLOSEOUT,
        reportRequired: true,
        reportRendered: true,
        deliveryState: "proven",
        oversizedEvidenceTruncated: true,
        oversizedEvidenceReference: "var/proof/full-tool-output.json",
        oversizedEvidenceSufficient: true,
      }),
    ).toMatchObject({
      state: "SETTLED",
      settled: true,
      allowedToCloseMission: true,
      recoveryAction: "settlement_complete",
    });
  });
});
