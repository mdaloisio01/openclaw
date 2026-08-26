import { describe, expect, it } from "vitest";
import {
  createTrbRecoveryState,
  evaluateTrbPostTurnWatchdog,
  inboundTrbRecoveryRequired,
  shouldDrainStaleTrbRecoveryState,
  validateTrbFinalReplyPayloads,
  validateTrbRecoveryContract,
  type TrbRecoveryContract,
} from "./trb-recovery-contract.js";

const completeContract: TrbRecoveryContract = {
  what_was_happening_before_misfire: "runtime hardening work stopped after tool execution",
  proof_checked: ["session transcript", "tool output summary"],
  actual_issue_identified: "final report delivery was missing after tool work",
  root_cause: "the run ended before a Mark-facing closeout was delivered",
  classification: "current_blocker",
  active_mission_impact: "active mission remains open until recovery is complete",
  lawful_no_update_reason: "current blocker is handled immediately in the active repair path",
  recovery_artifact_path:
    "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/trb_recovery.md",
  exact_next_action: "write recovery artifact, patch runtime gate, run focused tests",
  session_tool_log_proof: {
    checked: true,
    evidence: "session history and transcript were inspected",
  },
};

describe("TRB recovery runtime contract", () => {
  it("detects TRB command-style inbound turns and creates durable state", () => {
    expect(inboundTrbRecoveryRequired({ Body: "TRB" })).toBe(true);
    expect(inboundTrbRecoveryRequired({ Body: "please TRB then resume" })).toBe(true);
    expect(inboundTrbRecoveryRequired({ Body: "notarbitrary" })).toBe(false);

    const state = createTrbRecoveryState({
      ctx: {
        Body: "TRB why did this stop",
        MessageSid: "msg-1",
      },
      sessionKey: "agent:orchestrator:main",
      sessionId: "session-1",
      now: 123,
    });

    expect(state).toMatchObject({
      trb_recovery_required: true,
      recovery_mode: "trb",
      trigger_message_id: "msg-1",
      trigger_session_key: "agent:orchestrator:main",
      trigger_session_id: "session-1",
      trigger_timestamp: 123,
      requires_session_tool_log_proof: true,
      final_response_gate: { status: "pending" },
    });
  });

  it("rejects a final TRB response without classification", () => {
    const result = validateTrbRecoveryContract({
      ...completeContract,
      classification: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  });

  it("rejects a final TRB response without what happened", () => {
    const result = validateTrbRecoveryContract({
      ...completeContract,
      what_was_happening_before_misfire: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("TRB_FINAL_MISSING_REQUIRED_FIELDS");
  });

  it("rejects stall or missing-report TRB results without session/tool-log proof", () => {
    const result = validateTrbRecoveryContract(
      {
        ...completeContract,
        session_tool_log_proof: undefined,
      },
      { requireSessionToolLogProof: true },
    );

    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("TRB_STALL_WITHOUT_SESSION_LOG_PROOF");
  });

  it("rejects unknown root cause language without missing-proof fields", () => {
    const result = validateTrbRecoveryContract({
      ...completeContract,
      root_cause: "unknown",
      missing_proof: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("missing_proof");
  });

  it("allows not-proven language when missing-proof fields are complete", () => {
    const result = validateTrbRecoveryContract({
      ...completeContract,
      root_cause: "not proven",
      missing_proof: {
        what_was_checked: "session history and tool transcript",
        proof_missing: "provider-side disconnect reason",
        where_proof_should_exist: "provider run telemetry",
        missing_proof_is_blocker: false,
        exact_next_recovery_step: "continue from local source proof and keep TRB build open",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects deferred_issue when the active mission is blocked", () => {
    const result = validateTrbRecoveryContract({
      ...completeContract,
      classification: "deferred_issue",
      active_mission_blocked: true,
      active_mission_impact: "current build remains blocked by this issue",
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("TRB_CURRENT_BLOCKER_LOGGED_AS_DEFERRED");
  });

  it("rejects TRB results without issue-list action or lawful no-update reason", () => {
    const result = validateTrbRecoveryContract({
      ...completeContract,
      issue_list_action: undefined,
      lawful_no_update_reason: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("TRB_ISSUE_ACTION_MISSING");
  });

  it("rejects TRB results without recovery artifact path", () => {
    const result = validateTrbRecoveryContract({
      ...completeContract,
      recovery_artifact_path: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("TRB_ARTIFACT_MISSING");
  });

  it("passes a complete TRB contract", () => {
    expect(validateTrbRecoveryContract(completeContract).ok).toBe(true);
  });

  it("drains stale TRB recovery state on the next non-TRB inbound turn", () => {
    const state = createTrbRecoveryState({
      ctx: { Body: "TRB", MessageSid: "msg-stale" },
      sessionKey: "agent:orchestrator:main",
      sessionId: "session-stale",
      now: 1_234,
    });

    expect(
      shouldDrainStaleTrbRecoveryState({
        state,
        trbInboundRequired: false,
      }),
    ).toBe(true);
    expect(
      shouldDrainStaleTrbRecoveryState({
        state,
        trbInboundRequired: true,
      }),
    ).toBe(false);
    expect(
      shouldDrainStaleTrbRecoveryState({
        state: undefined,
        trbInboundRequired: false,
      }),
    ).toBe(false);
  });

  it("requires oversized inspection output to be summarized before the turn can close", () => {
    const result = validateTrbRecoveryContract({
      ...completeContract,
      oversized_output: {
        observed: true,
        summarized_or_checkpointed: false,
        final_recovery_report_delivered: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("oversized output");
  });

  it("gates final payload text for TRB-triggered turns", () => {
    const state = createTrbRecoveryState({
      ctx: { Body: "TRB missing report", MessageSid: "msg-2" },
      sessionKey: "agent:orchestrator:main",
      sessionId: "session-2",
      now: 456,
    });
    const result = validateTrbFinalReplyPayloads({
      state,
      payloads: {
        text: [
          "classification: current_blocker",
          "what_was_happening_before_misfire: prior work stopped",
          "proof_checked: session transcript, tool output summary",
          "actual_issue_identified: missing final report",
          "root_cause: final delivery was absent",
          "active_mission_impact: build remains open",
          "lawful_no_update_reason: current blocker handled now",
          "recovery_artifact_path: /tmp/trb.md",
          "exact_next_action: patch runtime gate",
          "session_tool_log_proof: checked in session history",
        ].join("\n"),
      },
    });

    expect(result.ok).toBe(true);
  });

  it("post-turn checker flags TRB runs that started without a valid final report", () => {
    const state = createTrbRecoveryState({
      ctx: { Body: "TRB no final answer after tool work", MessageSid: "msg-3" },
      sessionKey: "agent:orchestrator:main",
      sessionId: "session-3",
      now: 789,
    });

    expect(evaluateTrbPostTurnWatchdog({ state })).toEqual({
      status: "needs_review",
      codes: ["TRB_STARTED_NO_FINAL_REPORT"],
    });

    state.final_response_gate = {
      status: "blocked",
      checkedAt: 790,
      reasonCodes: ["TRB_STALL_WITHOUT_SESSION_LOG_PROOF"],
    };

    expect(evaluateTrbPostTurnWatchdog({ state })).toEqual({
      status: "needs_review",
      codes: ["TRB_STALL_WITHOUT_SESSION_LOG_PROOF"],
    });
  });
});
