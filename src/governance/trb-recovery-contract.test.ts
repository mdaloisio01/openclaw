import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { SessionEntry, TrbRecoveryRecordV1 } from "../config/sessions/types.js";
import {
  buildTrbRecoverySystemPrompt,
  captureTrbRecoveryRecordFromFinalReplyPayloads,
  createTrbRecoveryRecordFromContract,
  createTrbRecoveryState,
  evaluateTrbPostTurnWatchdog,
  inboundTrbRecoveryRequired,
  markTrbGateResultOnSessionEntry,
  parseTrbRecoveryContractFromText,
  shouldDrainStaleTrbRecoveryState,
  validateTrbFinalReplyPayloads,
  validateTrbRecoveryArtifact,
  validateTrbRecoveryContract,
  validateTrbRecoveryRecord,
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

const completeRecord: TrbRecoveryRecordV1 = {
  schemaVersion: 1,
  recordId: "trb-record-1",
  createdAt: 1,
  classification: "current_blocker",
  whatWasHappeningBeforeMisfire: completeContract.what_was_happening_before_misfire!,
  proofChecked: completeContract.proof_checked!,
  actualIssueIdentified: completeContract.actual_issue_identified!,
  rootCause: completeContract.root_cause,
  activeMissionImpact: completeContract.active_mission_impact!,
  lawfulNoUpdateReason: completeContract.lawful_no_update_reason,
  recoveryArtifactPath: completeContract.recovery_artifact_path!,
  exactNextAction: completeContract.exact_next_action!,
  sessionToolLogProof: completeContract.session_tool_log_proof,
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

  it("parses child missing-proof fields without requiring a parent missing_proof line", () => {
    const parsed = parseTrbRecoveryContractFromText(
      [
        "classification: current_blocker",
        "what_was_happening_before_misfire: remote compaction failed after tool work",
        "proof_checked: session transcript, trajectory log",
        "actual_issue_identified: final reply was withheld",
        "root_cause: not proven",
        "what_was_checked: session history and compact error",
        "proof_missing: provider compact endpoint root cause",
        "where_proof_should_exist: provider telemetry",
        "missing_proof_is_blocker: true",
        "exact_next_recovery_step: patch visible compaction fallback",
        "active_mission_impact: build remains blocked until visible recovery lands",
        "lawful_no_update_reason: current blocker handled in active ISSUE-040 repair",
        "recovery_artifact_path: /tmp/trb.md",
        "exact_next_action: run focused tests",
      ].join("\n"),
    );

    const result = validateTrbRecoveryContract(parsed);

    expect(parsed.missing_proof).toMatchObject({
      what_was_checked: "session history and compact error",
      proof_missing: "provider compact endpoint root cause",
      where_proof_should_exist: "provider telemetry",
      missing_proof_is_blocker: true,
      exact_next_recovery_step: "patch visible compaction fallback",
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

  it.each(["none", "not written", "no file created", "missing.md"])(
    "rejects %s without a written artifact",
    async (recoveryArtifactPath) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trb-artifact-"));
      try {
        const state = createTrbRecoveryState({
          ctx: { Body: "TRB", MessageSid: "msg-artifact" },
          sessionKey: "agent:orchestrator:main",
          sessionId: "session-artifact",
          now: Date.now(),
        });
        state.recovery_record = { ...completeRecord, recoveryArtifactPath };

        const result = await validateTrbRecoveryArtifact({ state, workspaceDir });
        expect(result.ok).toBe(false);
        expect(result.reasonCodes).toContain("TRB_ARTIFACT_MISSING");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  it("rejects malformed persisted artifact metadata without throwing", () => {
    const result = validateTrbRecoveryRecord({
      ...completeRecord,
      recoveryArtifactPath: 42 as unknown as string,
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("TRB_ARTIFACT_MISSING");
  });

  it("accepts a copied extensionless file and rejects stale or empty artifacts", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trb-artifact-"));
    try {
      const state = createTrbRecoveryState({
        ctx: { Body: "TRB", MessageSid: "msg-artifact" },
        sessionKey: "agent:orchestrator:main",
        sessionId: "session-artifact",
        now: Date.now(),
      });
      const artifactPath = path.join(workspaceDir, "recovery");
      state.recovery_record = { ...completeRecord, recoveryArtifactPath: "recovery" };
      await fs.writeFile(artifactPath, "");
      expect((await validateTrbRecoveryArtifact({ state, workspaceDir })).ok).toBe(false);
      await fs.writeFile(artifactPath, "recovery proof\n");
      const staleTime = new Date(state.trigger_timestamp - 1_000);
      await fs.utimes(artifactPath, staleTime, staleTime);
      expect((await validateTrbRecoveryArtifact({ state, workspaceDir })).ok).toBe(true);
      state.trigger_timestamp = Date.now() + 2_000;
      expect((await validateTrbRecoveryArtifact({ state, workspaceDir })).ok).toBe(false);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("passes a complete TRB contract", () => {
    expect(validateTrbRecoveryContract(completeContract).ok).toBe(true);
  });

  it("passes a complete structured TRB recovery record", () => {
    expect(validateTrbRecoveryRecord(completeRecord).ok).toBe(true);
  });

  it("captures a valid visible TRB contract as a structured recovery record", () => {
    const state = createTrbRecoveryState({
      ctx: { Body: "TRB", MessageSid: "msg-capture" },
      sessionKey: "agent:orchestrator:main",
      sessionId: "session-capture",
      now: 123,
    });

    const record = createTrbRecoveryRecordFromContract({
      state,
      contract: completeContract,
      createdAt: 456,
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      createdAt: 456,
      classification: "current_blocker",
      whatWasHappeningBeforeMisfire: completeContract.what_was_happening_before_misfire,
      proofChecked: completeContract.proof_checked,
      actualIssueIdentified: completeContract.actual_issue_identified,
      rootCause: completeContract.root_cause,
      activeMissionImpact: completeContract.active_mission_impact,
      lawfulNoUpdateReason: completeContract.lawful_no_update_reason,
      recoveryArtifactPath: completeContract.recovery_artifact_path,
      exactNextAction: completeContract.exact_next_action,
    });
    expect(record?.recordId).toMatch(/^trb-recovery:[a-f0-9]{32}$/);
    expect(validateTrbRecoveryRecord(record!).ok).toBe(true);
  });

  it("does not capture an invalid visible TRB contract as a structured record", () => {
    const state = createTrbRecoveryState({
      ctx: { Body: "TRB", MessageSid: "msg-invalid-capture" },
      sessionKey: "agent:orchestrator:main",
      sessionId: "session-invalid-capture",
      now: 123,
    });

    const record = createTrbRecoveryRecordFromContract({
      state,
      contract: {
        ...completeContract,
        recovery_artifact_path: undefined,
      },
      createdAt: 456,
    });

    expect(record).toBeUndefined();
  });

  it("captures a valid final payload on the session before storing the gate decision", () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-finalizer-capture",
      updatedAt: 1,
      trbRecovery: createTrbRecoveryState({
        ctx: { Body: "TRB", MessageSid: "msg-finalizer-capture" },
        sessionKey: "agent:orchestrator:main",
        sessionId: "session-finalizer-capture",
        now: 123,
      }),
    };
    const payload = {
      text: [
        "classification: current_blocker",
        "what_was_happening_before_misfire: final response gate blocked recovery",
        "proof_checked: session state; issue register; source diff",
        "actual_issue_identified: visible contract needed structured persistence",
        "root_cause: finalizer did not capture the validated contract as a record",
        "active_mission_impact: recovery remains open until record is persisted",
        "issue_list_action: appended OPEN_TRB_RECORD_CAPTURE",
        "recovery_artifact_path: /tmp/trb-record-capture.md",
        "exact_next_action: persist record before gate decision",
      ].join("\n"),
    };

    expect(
      captureTrbRecoveryRecordFromFinalReplyPayloads({
        sessionEntry,
        payloads: payload,
        createdAt: 456,
      }),
    ).toBe(true);

    const result = validateTrbFinalReplyPayloads({
      state: sessionEntry.trbRecovery,
      payloads: { text: "Plain prose after structured record exists." },
    });
    markTrbGateResultOnSessionEntry({
      sessionEntry,
      result,
      checkedAt: 789,
      candidateReplyText: payload.text,
    });

    expect(result.ok).toBe(true);
    expect(sessionEntry.trbRecovery?.recovery_record).toMatchObject({
      createdAt: 456,
      recoveryArtifactPath: "/tmp/trb-record-capture.md",
      issueListAction: "appended OPEN_TRB_RECORD_CAPTURE",
    });
    expect(sessionEntry.trbRecovery?.final_response_gate?.decisionRecord).toMatchObject({
      status: "passed",
      recoveryRecordId: sessionEntry.trbRecovery?.recovery_record?.recordId,
      recoveryArtifactPath: "/tmp/trb-record-capture.md",
      issueActionPresent: true,
    });
  });

  it("captures structured TRB recovery metadata without requiring visible contract prose", () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-metadata-capture",
      updatedAt: 1,
      trbRecovery: createTrbRecoveryState({
        ctx: { Body: "TRB", MessageSid: "msg-metadata-capture" },
        sessionKey: "agent:orchestrator:main",
        sessionId: "session-metadata-capture",
        now: 123,
      }),
    };
    const payload = setReplyPayloadMetadata(
      {
        text: "Plain English report for Mark. No machine-field block in the visible message.",
      },
      {
        trbRecoveryRecord: completeRecord,
      },
    );

    expect(
      captureTrbRecoveryRecordFromFinalReplyPayloads({
        sessionEntry,
        payloads: payload,
      }),
    ).toBe(true);

    const result = validateTrbFinalReplyPayloads({
      state: sessionEntry.trbRecovery,
      payloads: payload,
    });

    expect(result.ok).toBe(true);
    expect(sessionEntry.trbRecovery?.recovery_record).toBe(completeRecord);
  });

  it("refuses invalid structured TRB recovery metadata", () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-invalid-metadata",
      updatedAt: 1,
      trbRecovery: createTrbRecoveryState({
        ctx: { Body: "TRB", MessageSid: "msg-invalid-metadata" },
        sessionKey: "agent:orchestrator:main",
        sessionId: "session-invalid-metadata",
        now: 123,
      }),
    };
    const payload = setReplyPayloadMetadata(
      {
        text: "Plain English report for Mark.",
      },
      {
        trbRecoveryRecord: {
          ...completeRecord,
          recoveryArtifactPath: "",
        },
      },
    );

    expect(
      captureTrbRecoveryRecordFromFinalReplyPayloads({
        sessionEntry,
        payloads: payload,
      }),
    ).toBe(false);

    expect(sessionEntry.trbRecovery?.recovery_record).toBeUndefined();
    expect(
      validateTrbFinalReplyPayloads({
        state: sessionEntry.trbRecovery,
        payloads: payload,
      }).ok,
    ).toBe(false);
  });

  it("prefers structured recovery records over plain visible prose", () => {
    const state = createTrbRecoveryState({
      ctx: { Body: "TRB", MessageSid: "msg-record" },
      sessionKey: "agent:orchestrator:main",
      sessionId: "session-record",
      now: 111,
    });
    state.recovery_record = completeRecord;

    const result = validateTrbFinalReplyPayloads({
      state,
      payloads: {
        text: "Plain English report for Mark without machine field labels.",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("parses a Mark-facing report with a machine-readable contract block and prose", () => {
    const result = validateTrbFinalReplyPayloads({
      state: createTrbRecoveryState({
        ctx: { Body: "TRB", MessageSid: "msg-report" },
        sessionKey: "agent:orchestrator:main",
        sessionId: "session-report",
        now: 321,
      }),
      payloads: {
        text: [
          "classification: current_blocker",
          "what_was_happening_before_misfire: final report was blocked by the runtime gate",
          "proof_checked:",
          "- session transcript",
          "- TRB gate source",
          "actual_issue_identified: report format did not satisfy the runtime contract",
          "root_cause: final text used a human report shape instead of parseable fields",
          "active_mission_impact: repair report must include the contract block",
          "issue_list_action: update ISSUE-040 with the recurrence",
          "recovery_artifact_path: /tmp/trb-format-repair.md",
          "exact_next_action: patch parser and prompt",
          "",
          "TRB Format Repair",
          "",
          "Status: Open - source repair is being validated",
          "",
          "Update:",
          "- The required contract block is present before the human report.",
        ].join("\n"),
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts required TRB fields embedded in the default Mark-facing report shape", () => {
    const result = validateTrbFinalReplyPayloads({
      state: createTrbRecoveryState({
        ctx: { Body: "TRB why did this stop", MessageSid: "msg-default-report" },
        sessionKey: "agent:orchestrator:main",
        sessionId: "session-default-report",
        now: 654,
      }),
      payloads: {
        text: [
          "what_was_happening_before_misfire: Phase 5 ACP/session acknowledgement returned BLOCKED_CLOSEOUT and the controller stopped after naming the next repair.",
          "proof_checked: session status; issue register; source hooks; watchdog receipt",
          "actual_issue_identified: parent-review settlement did not force executable follow-through",
          "root_cause: parent-review handoff allowed a follow-up note without launched repair or current-run blocker proof",
          "session_tool_log_proof: checked session status and issue-register proof",
          "active_mission_impact: original drill remains open at Phase 5",
          "issue_list_action: appended OPEN_TRB_PARENT_REVIEW_STOP_AND_TRB_CONTRACT_GATE_RECURRENCE",
          "",
          "Systemwide Department-Flow Drill TRB",
          "",
          "Status: Blocked - root cause found.",
          "",
          "Next Steps:",
          "- Start bounded source repair and validate it before retrying Phase 5.",
          "",
          "Files/Reports:",
          "- /home/will/.openclaw/workspace-orchestrator/file_hub/exports/trb_parent_review_stop.md",
        ].join("\n"),
      },
    });

    expect(result.ok).toBe(true);
  });

  it("normalizes exact backticked classification values", () => {
    const parsed = parseTrbRecoveryContractFromText(
      [
        "classification: `deferred_issue`",
        "what_was_happening_before_misfire: activation closeout was already delivered",
        "proof_checked: issue register; closeout artifact",
        "actual_issue_identified: no current blocker remained",
        "root_cause: follow-up formatting defect was recorded for later repair",
        "active_mission_impact: active repair slice can continue",
        "issue_list_action: ISSUE-040 update already records the recurrence",
        "recovery_artifact_path: /tmp/trb.md",
        "exact_next_action: continue issue-list triage",
      ].join("\n"),
    );

    expect(parsed.classification).toBe("deferred_issue");
    expect(validateTrbRecoveryContract(parsed).ok).toBe(true);
  });

  it("parses proof_checked bullet lists under an empty label", () => {
    const parsed = parseTrbRecoveryContractFromText(
      [
        "classification: current_blocker",
        "what_was_happening_before_misfire: report stopped before a final answer",
        "proof_checked:",
        "- session transcript",
        "- tool output summary",
        "actual_issue_identified: final report was absent",
        "root_cause: run ended before closeout delivery",
        "active_mission_impact: recovery must deliver the final report",
        "lawful_no_update_reason: current blocker handled immediately",
        "recovery_artifact_path: /tmp/trb.md",
        "exact_next_action: deliver recovery report",
      ].join("\n"),
    );

    expect(parsed.proof_checked).toEqual(["session transcript", "tool output summary"]);
    expect(validateTrbRecoveryContract(parsed).ok).toBe(true);
  });

  it("rejects backticked classification values with extra prose", () => {
    const parsed = parseTrbRecoveryContractFromText(
      [
        "classification: `deferred_issue` for the aborted tool wait",
        "what_was_happening_before_misfire: activation closeout was already delivered",
        "proof_checked: issue register; closeout artifact",
        "actual_issue_identified: no current blocker remained",
        "root_cause: follow-up formatting defect was recorded for later repair",
        "active_mission_impact: active repair slice can continue",
        "issue_list_action: ISSUE-040 update already records the recurrence",
        "recovery_artifact_path: /tmp/trb.md",
        "exact_next_action: continue issue-list triage",
      ].join("\n"),
    );

    expect(parsed.classification).toBe("`deferred_issue` for the aborted tool wait");
    expect(validateTrbRecoveryContract(parsed).ok).toBe(false);
  });

  it("still fails closed for prose-only incomplete TRB responses", () => {
    const result = validateTrbFinalReplyPayloads({
      state: createTrbRecoveryState({
        ctx: { Body: "TRB", MessageSid: "msg-prose" },
        sessionKey: "agent:orchestrator:main",
        sessionId: "session-prose",
        now: 654,
      }),
      payloads: {
        text: [
          "TRB finding: The compact visible recovery slice is closed.",
          "",
          "Status: Closed - everything important passed.",
          "",
          "Files/Reports:",
          "cleanupcrew_issue_040_compact_visible_recovery_activation_closeout.md",
        ].join("\n"),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("TRB_FINAL_MISSING_REQUIRED_FIELDS");
    expect(result.reasonCodes).toContain("TRB_ARTIFACT_MISSING");
    expect(result.reasonCodes).toContain("TRB_ISSUE_ACTION_MISSING");
  });

  it("stores a durable blocked gate decision with stable lineage and bounded redacted reply preview", () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-blocked",
      updatedAt: 1,
      trbRecovery: createTrbRecoveryState({
        ctx: { Body: "TRB", MessageSid: "msg-blocked" },
        sessionKey: "agent:orchestrator:main",
        sessionId: "session-blocked",
        now: 654,
      }),
    };
    const candidateReplyText = `Plain prose only secret=12345 test@example.com ${"x".repeat(2_000)}`;
    const result = validateTrbFinalReplyPayloads({
      state: sessionEntry.trbRecovery,
      payloads: {
        text: candidateReplyText,
      },
    });

    markTrbGateResultOnSessionEntry({
      sessionEntry,
      result,
      checkedAt: 777,
      candidateReplyText,
    });

    expect(sessionEntry.trbRecovery?.final_response_gate).toMatchObject({
      status: "blocked",
      checkedAt: 777,
      decisionRecordId: "trb-gate:msg-blocked:blocked",
      reasonCodes: expect.arrayContaining([
        "TRB_FINAL_MISSING_REQUIRED_FIELDS",
        "TRB_ARTIFACT_MISSING",
        "TRB_ISSUE_ACTION_MISSING",
      ]),
      missingFields: expect.arrayContaining([
        "classification",
        "recovery_artifact_path",
        "issue_list_action",
      ]),
    });
    const firstDecision = sessionEntry.trbRecovery?.final_response_gate?.decisionRecord;
    expect(firstDecision).toMatchObject({
      recordId: "trb-gate:msg-blocked:blocked",
      lineageKey:
        "trb-gate|session-key:agent:orchestrator:main|session-id:session-blocked|message:msg-blocked|trigger:654",
      attempt: 1,
      issueActionPresent: false,
    });
    expect(firstDecision?.candidateReplyPreview?.length).toBeLessThanOrEqual(1_003);
    expect(firstDecision?.candidateReplyPreview).toContain("[redacted-email]");
    expect(firstDecision?.candidateReplyPreview).toContain("secret=[redacted]");
    expect(firstDecision?.candidateReplySha256).toMatch(/^[a-f0-9]{64}$/);

    const prompt = buildTrbRecoverySystemPrompt(sessionEntry.trbRecovery);
    expect(prompt).toContain("Previous TRB gate decision:");
    expect(prompt).toContain("TRB_ARTIFACT_MISSING");
    expect(prompt).toContain("recovery_artifact_path is required");

    markTrbGateResultOnSessionEntry({
      sessionEntry,
      result,
      checkedAt: 888,
      candidateReplyText,
    });
    expect(sessionEntry.trbRecovery?.final_response_gate?.decisionRecord).toMatchObject({
      recordId: "trb-gate:msg-blocked:blocked",
      attempt: 2,
    });
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
