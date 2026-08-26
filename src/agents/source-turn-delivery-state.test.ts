import { describe, expect, it } from "vitest";
import {
  isSourceTurnVisibleFinalProofKind,
  resolveSourceTurnDeliveryState,
  SOURCE_TURN_DELIVERY_STATES,
} from "./source-turn-delivery-state.js";

describe("source turn delivery state contract", () => {
  it("defines the narrowed source-turn delivery states", () => {
    expect(SOURCE_TURN_DELIVERY_STATES).toEqual([
      "accepted",
      "progress_delivered",
      "final_delivered",
      "final_delivery_failed",
      "failure_delivered",
      "settled_resolved_later",
      "blocked_refused",
    ]);
  });

  it("marks final delivered only with source-chat-visible final proof", () => {
    expect(
      resolveSourceTurnDeliveryState({
        finalDeliveryRequired: true,
        finalDeliveryDelivered: true,
        evidenceKinds: ["source_chat_final"],
      }),
    ).toEqual({
      state: "final_delivered",
      finalDeliveryDelivered: true,
      refused: false,
      reason: "final_visible_delivery_proven",
    });
  });

  it("refuses finalDeliveryDelivered=true without visible source-chat proof", () => {
    expect(
      resolveSourceTurnDeliveryState({
        finalDeliveryDelivered: true,
        evidenceKinds: ["ledger_write"],
      }),
    ).toEqual({
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "false_final_delivery_delivered_refused",
    });
  });

  it("does not treat ledger or internal evidence writes as final delivery", () => {
    expect(
      resolveSourceTurnDeliveryState({
        finalDeliveryRequired: true,
        evidenceKinds: ["ledger_write", "registry_entry", "internal_evidence_record"],
      }),
    ).toMatchObject({
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      reason: "missing_visible_final_delivery_proof",
    });
  });

  it("does not treat a report artifact or closeout artifact as final delivery", () => {
    expect(
      resolveSourceTurnDeliveryState({
        finalDeliveryRequired: true,
        reportRequired: true,
        reportArtifactPath:
          "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/report.md",
        evidenceKinds: ["report_artifact", "closeout_artifact"],
      }),
    ).toMatchObject({
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      reason: "missing_visible_final_delivery_proof",
    });
  });

  it("blocks final delivery when Mark-facing export proof is required but missing", () => {
    expect(
      resolveSourceTurnDeliveryState({
        finalDeliveryRequired: true,
        finalDeliveryDelivered: true,
        evidenceKinds: ["source_chat_final", "report_artifact"],
        reportRequired: true,
        reportArtifactPath:
          "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/report.md",
        markFacingExportRequired: true,
        markFacingExportRoot: "/home/will/.openclaw/workspace/file_hub/exports",
        markFacingExportPath: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
      }),
    ).toEqual({
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "missing_mark_facing_export_proof",
    });
  });

  it("acknowledges final delivery when chat proof and Mark-facing export proof are both present", () => {
    expect(
      resolveSourceTurnDeliveryState({
        finalDeliveryRequired: true,
        finalDeliveryDelivered: true,
        evidenceKinds: ["source_chat_final", "mark_facing_export_visible"],
        reportRequired: true,
        reportArtifactPath: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
        markFacingExportRequired: true,
        markFacingExportRoot: "/home/will/.openclaw/workspace/file_hub/exports",
        markFacingExportPath: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
      }),
    ).toEqual({
      state: "final_delivered",
      finalDeliveryDelivered: true,
      refused: false,
      reason: "final_visible_delivery_proven",
    });
  });

  it("blocks report-governed delivery when the report path is missing", () => {
    expect(
      resolveSourceTurnDeliveryState({
        reportRequired: true,
      }),
    ).toEqual({
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "missing_report_path",
    });
  });

  it("does not treat a private-only final response as delivery", () => {
    expect(
      resolveSourceTurnDeliveryState({
        finalDeliveryRequired: true,
        privateOnlyFinalResponse: true,
      }),
    ).toEqual({
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "private_final_without_visible_delivery",
    });
  });

  it("keeps failed delivery failed", () => {
    expect(
      resolveSourceTurnDeliveryState({
        finalDeliveryRequired: true,
        deliveryToolFailed: true,
      }),
    ).toEqual({
      state: "final_delivery_failed",
      finalDeliveryDelivered: false,
      refused: false,
      reason: "delivery_tool_failed",
    });
  });

  it("keeps visible failure notice distinct from final delivery", () => {
    expect(
      resolveSourceTurnDeliveryState({
        failureNoticeVisible: true,
      }),
    ).toEqual({
      state: "failure_delivered",
      finalDeliveryDelivered: false,
      refused: false,
      reason: "failure_notice_visible",
    });
  });

  it("keeps settled historical debt distinct from delivered final", () => {
    expect(
      resolveSourceTurnDeliveryState({
        historicalSettlement: true,
        finalDeliveryDelivered: false,
        evidenceKinds: ["settled_resolved_later"],
      }),
    ).toEqual({
      state: "settled_resolved_later",
      finalDeliveryDelivered: false,
      refused: false,
      reason: "historical_debt_settled_not_delivered",
    });
  });

  it("makes blocked/refused available when visible final proof is missing", () => {
    expect(
      resolveSourceTurnDeliveryState({
        finalDeliveryRequired: true,
      }),
    ).toEqual({
      state: "blocked_refused",
      finalDeliveryDelivered: false,
      refused: true,
      reason: "missing_visible_final_delivery_proof",
    });
  });

  it("tracks progress without promoting it to final delivery", () => {
    expect(
      resolveSourceTurnDeliveryState({
        evidenceKinds: ["source_chat_progress"],
      }),
    ).toEqual({
      state: "progress_delivered",
      finalDeliveryDelivered: false,
      refused: false,
      reason: "progress_visible_but_final_not_proven",
    });
  });

  it("recognizes only actual visible final proof kinds as final proof", () => {
    expect(isSourceTurnVisibleFinalProofKind("source_chat_final")).toBe(true);
    expect(isSourceTurnVisibleFinalProofKind("verified_message_tool_final")).toBe(true);
    expect(isSourceTurnVisibleFinalProofKind("direct_source_final")).toBe(true);
    expect(isSourceTurnVisibleFinalProofKind("mark_facing_export_visible")).toBe(false);
    expect(isSourceTurnVisibleFinalProofKind("ledger_write")).toBe(false);
    expect(isSourceTurnVisibleFinalProofKind("report_artifact")).toBe(false);
  });
});
