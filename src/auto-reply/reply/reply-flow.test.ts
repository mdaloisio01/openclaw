import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  CloseoutAdmissionInput,
  MissionIdentity,
} from "../../governance/mission-manifest.types.js";
import { markReplyPayloadAsProgressHeartbeat, setReplyPayloadMetadata } from "../reply-payload.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  allowTerminalCloseout,
  flushBlockedCloseoutIfNeeded,
  installActiveRunContinuationGuard,
  recordActiveRunStarted,
  recordLawfulBlocker,
  recordNonTerminalBuildUpdateEmitted,
  resolveCleanupCrewFinalResponseGate,
  testing as activeRunContinuationTesting,
} from "./active-run-continuation-guard.js";
import { buildRuntimeCloseoutAdmissionInput } from "./false-closeout-admission-producer.js";
import { createReplyDispatcher, waitForReplyDispatcherIdle } from "./reply-dispatcher.js";
import { createReplyToModeFilter } from "./reply-threading.js";

type DeliverPayload = Parameters<Parameters<typeof createReplyDispatcher>[0]["deliver"]>[0];
type DeliverMock = { mock: { calls: unknown[][] } };

function deliveredText(deliver: DeliverMock, index = 0) {
  const payload = deliver.mock.calls[index]?.[0] as DeliverPayload | undefined;
  return payload?.text;
}

async function readOnlyJsonArtifact<T>(dir: string, subdir: string): Promise<T> {
  const artifactDir = path.join(dir, subdir);
  const files = await readdir(artifactDir);
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(path.join(artifactDir, files[0]), "utf8")) as T;
}

function createGuardedDispatcher() {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

const PACKET_A_MILESTONE_REPORT = [
  "STATUS: in progress",
  "MODE: Cleanup Crew execution",
  "PACKET COMPLETE: Packet A",
  "RESULT: focused repair landed",
  "FILES VERIFIED: src/auto-reply/reply/active-run-continuation-guard.ts",
  "FILES CHANGED: src/auto-reply/reply/active-run-continuation-guard.ts",
  "TESTS RUN: focused",
  "PROOF: local focused test",
  "NEXT PACKET: Packet B",
  "SAFETY CHECK: milestone only; Cleanup Crew continues",
  "BLOCKERS: none",
].join("\n");

const STAGE_MILESTONE_REPORT = [
  "STATUS: in progress",
  "MODE: Cleanup Crew resume",
  "STAGE COMPLETE: ISSUE-039 verification-only closeout",
  "RESULT: scoped issue closed; broader Cleanup Crew remains open",
  "PROOF: focused validation and Grant review passed",
  "NEXT STAGE: ISSUE-040 post-milestone continuation repair",
  "SAFETY CHECK: milestone only; Cleanup Crew continues",
  "BLOCKERS: none",
].join("\n");

const FALSE_CLOSEOUT_IDENTITY: MissionIdentity = {
  missionId: "mission-false-closeout",
  planRevisionId: "plan-r1",
  planSha256: "plan-sha",
  sourceRevision: "source-sha",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "policy-v1",
  skillSha256: "skill-sha",
};

function falseCloseoutAdmissionInput(mode: "shadow" | "enforce" | "off"): CloseoutAdmissionInput {
  return {
    manifest: {
      schema: "openclaw.mission_manifest.v1",
      ...FALSE_CLOSEOUT_IDENTITY,
      mode,
      scopeHash: "full-scope",
      authorizedScopeHash: "full-scope",
      planRevisionAuthorized: true,
      createdAt: "2026-07-16T19:00:00Z",
    },
    requirements: [
      { id: "REQ-1", text: "require real proof", required: true, gateIds: ["gate-1"] },
    ],
    gates: [{ id: "gate-1", requirementId: "REQ-1", kind: "requirement", required: true }],
    receipts: [],
    runtimeState: {
      parentStatus: "running",
      activeExecutorCount: 1,
      staleExecutorCount: 0,
      openSessionCount: 0,
      openRunCount: 1,
      openLeaseCount: 0,
      openContinuationCount: 0,
      pendingDeliveryCount: 0,
    },
    watchdog: {
      label: "NEEDS_REVIEW",
      suspiciousCount: 1,
      checkedAt: "2026-07-16T19:00:00Z",
      postTerminal: false,
    },
    repairWork: { openCount: 1, openIds: ["repair-open"] },
    completionRequest: {
      schema: "openclaw.completion_request.v1",
      ...FALSE_CLOSEOUT_IDENTITY,
      requestedAt: "2026-07-16T19:00:00Z",
      claimedScopeHash: "narrow-scope",
      closeoutText: "complete",
      evidenceManifestSha256: "evidence-sha",
    },
    nextExecutableStepExists: true,
    reportContradictions: ["closeout contradicts runtime"],
    now: "2026-07-16T19:00:00Z",
  };
}

afterEach(() => {
  delete process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION;
  delete process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION_MODE;
});

describe("createReplyDispatcher", () => {
  it("drops empty payloads and exact silent tokens without media", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    expect(dispatcher.sendFinalReply({})).toBe(false);
    expect(dispatcher.sendFinalReply({ text: " " })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: `${SILENT_REPLY_TOKEN} -- nope` })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: `interject.${SILENT_REPLY_TOKEN}` })).toBe(true);

    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliveredText(deliver)).toBe(`${SILENT_REPLY_TOKEN} -- nope`);
    expect(deliveredText(deliver, 1)).toBe(`interject.${SILENT_REPLY_TOKEN}`);
  });

  it("drops exact NO_REPLY final payloads for direct sessions", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
            internal: "allow",
          },
        },
      },
    };
    const dispatcher = createReplyDispatcher({
      deliver,
      silentReplyContext: {
        cfg,
        sessionKey: "agent:main:telegram:direct:123",
        surface: "telegram",
      },
    });

    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);

    await dispatcher.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("still drops exact NO_REPLY final payloads for group sessions where silence is allowed", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
            internal: "allow",
          },
        },
      },
    };
    const dispatcher = createReplyDispatcher({
      deliver,
      silentReplyContext: {
        cfg,
        sessionKey: "agent:main:telegram:group:123",
        surface: "telegram",
      },
    });

    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);

    await dispatcher.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("strips heartbeat tokens and applies responsePrefix", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onHeartbeatStrip = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver,
      responsePrefix: "PFX",
      onHeartbeatStrip,
    });

    expect(dispatcher.sendFinalReply({ text: HEARTBEAT_TOKEN })).toBe(false);
    expect(dispatcher.sendToolResult({ text: `${HEARTBEAT_TOKEN} hello` })).toBe(true);
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliveredText(deliver)).toBe("PFX hello");
    expect(onHeartbeatStrip).toHaveBeenCalledTimes(2);
  });

  it("avoids double-prefixing and keeps media when heartbeat is the only text", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      responsePrefix: "PFX",
    });

    expect(
      dispatcher.sendFinalReply({
        text: "PFX already",
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);
    expect(
      dispatcher.sendFinalReply({
        text: HEARTBEAT_TOKEN,
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);
    expect(
      dispatcher.sendFinalReply({
        text: `${SILENT_REPLY_TOKEN} -- explanation`,
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);

    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliveredText(deliver)).toBe("PFX already");
    expect(deliveredText(deliver, 1)).toBe("");
    expect(deliveredText(deliver, 2)).toBe(`PFX ${SILENT_REPLY_TOKEN} -- explanation`);
  });

  it("preserves ordering across tool, block, and final replies", async () => {
    const delivered: string[] = [];
    const deliver = vi.fn(async (_payload, info) => {
      delivered.push(info.kind);
      if (info.kind === "tool") {
        await Promise.resolve();
      }
    });
    const dispatcher = createReplyDispatcher({ deliver });

    dispatcher.sendToolResult({ text: "tool" });
    dispatcher.sendBlockReply({ text: "block" });
    dispatcher.sendFinalReply({ text: "final" });

    await dispatcher.waitForIdle();
    expect(delivered).toEqual(["tool", "block", "final"]);
  });

  it("delivers active-run progress heartbeats through block semantics even when queued as tool results", async () => {
    const delivered: string[] = [];
    const deliver = vi.fn(async (_payload, info) => {
      delivered.push(info.kind);
    });
    const dispatcher = createReplyDispatcher({ deliver });

    dispatcher.sendToolResult(
      markReplyPayloadAsProgressHeartbeat(
        {
          text: "Status: still working.\nCurrent step: Inspect code",
          isStatusNotice: true,
        },
        {
          category: "working",
          activeRunContinues: true,
        },
      ),
    );

    await dispatcher.waitForIdle();
    expect(delivered).toEqual(["block"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 1, block: 0, final: 0 });
  });

  it("rejects markComplete-style terminal closeout when no next step followed a non-terminal update", async () => {
    const dispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    installActiveRunContinuationGuard(dispatcher);
    recordActiveRunStarted(dispatcher);
    recordNonTerminalBuildUpdateEmitted(dispatcher, "plan:Inspect code");

    expect(allowTerminalCloseout(dispatcher, "markComplete").allowed).toBe(false);
    expect(dispatcher.markComplete).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ACTIVE_RUN_CONTINUITY_VIOLATION"),
      }),
    );
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        { type: "ACTIVE_RUN_STARTED" },
        { type: "NON_TERMINAL_BUILD_UPDATE_EMITTED", detail: "plan:Inspect code" },
        { type: "BLOCKER_STATE", detail: "false" },
        { type: "TERMINAL_CLOSEOUT_ATTEMPTED", detail: "markComplete" },
        expect.objectContaining({ type: "ACTIVE_RUN_CONTINUITY_VIOLATION" }),
      ]),
    );
  });

  it("rejects Cleanup Crew Status: Closed reports when they still name next steps", () => {
    const dispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: {
        currentTurnText: "resume under cleanup crew sop",
        activeCleanupCrewMission: true,
      },
    });
    recordActiveRunStarted(dispatcher);

    const result = allowTerminalCloseout(dispatcher, "sendFinalReply", {
      text: [
        "Cleanup Crew ISSUE-040 Resume",
        "",
        "Status: Closed - scoped activation proved.",
        "",
        "Remaining Work:",
        "- Broader ISSUE-040 family remains open.",
        "",
        "Next Steps:",
        "Continue remaining-family re-triage.",
      ].join("\n"),
    });

    expect(result.allowed).toBe(false);
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ACTIVE_RUN_CONTINUITY_VIOLATION"),
      }),
    );
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        { type: "ACTIVE_RUN_STARTED" },
        { type: "TERMINAL_CLOSEOUT_ATTEMPTED", detail: "sendFinalReply" },
        expect.objectContaining({ type: "CLEANUP_CREW_TERMINAL_CLOSEOUT_REJECTED" }),
        expect.objectContaining({ type: "ACTIVE_RUN_CONTINUITY_VIOLATION" }),
      ]),
    );
  });

  it("persists Continuity Gate v2 technical continuation evidence for blocked terminal closeout", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-active-run-gate-"));
    try {
      const dispatcher = {
        sendToolResult: vi.fn(() => true),
        sendBlockReply: vi.fn(() => true),
        sendFinalReply: vi.fn(() => true),
        waitForIdle: vi.fn(async () => {}),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      };
      installActiveRunContinuationGuard(dispatcher, {
        persistence: {
          outputDir,
          activeMission: "Cleanup Crew active-run continuation repair",
          now: "2026-07-04T22:10:00.000Z",
          sourceSurface: "reply-flow-test-active-run-guard",
          proofRefs: ["active-run-continuation-proof.json"],
          authoritySources: [
            {
              kind: "active_mission_lock",
              id: "cleanup-crew-active-run",
              summary: "Cleanup Crew active mission controls active-run continuation repair",
              active: true,
            },
          ],
        },
      });
      recordActiveRunStarted(dispatcher);
      recordNonTerminalBuildUpdateEmitted(dispatcher, "plan:Inspect code");

      expect(allowTerminalCloseout(dispatcher, "markComplete").allowed).toBe(false);
      await activeRunContinuationTesting.flushPersistence(dispatcher);

      const decisionRecord = await readOnlyJsonArtifact<{
        schema: string;
        selected_state: string;
        scope: { files: string[]; records: string[] };
      }>(outputDir, "cleanup_crew_decision_records");
      const continueReceipt = await readOnlyJsonArtifact<{
        schema: string;
        selected_state: string;
        repair_action: string;
        proof_path: string;
      }>(outputDir, "cleanup_crew_continue_receipts");
      const trace = await readOnlyJsonArtifact<{
        schema: string;
        selected_state: string;
        owner_level_blocker_audit: string;
        risk_classification: { path_risk: string; diff_intent: string };
        technical_vs_product: { lane: string };
        scope: { surfaces: string[]; records: string[] };
        proof_refs: string[];
      }>(outputDir, "cleanup_crew_diagnostic_traces");

      expect(decisionRecord).toMatchObject({
        schema: "openclaw.cleanup_crew_decision_record.v2",
        selected_state: "CONTINUE_PLAN_NEXT_STEP",
        scope: {
          files: ["src/auto-reply/reply/active-run-continuation-guard.ts"],
          records: ["plan:Inspect code"],
        },
      });
      expect(continueReceipt).toMatchObject({
        schema: "openclaw.cleanup_crew_continue_receipt.v2",
        selected_state: "CONTINUE_PLAN_NEXT_STEP",
        repair_action:
          "start next executable step or record a lawful blocker before terminal closeout",
        proof_path: "active-run-continuation-proof.json",
      });
      expect(trace).toMatchObject({
        schema: "openclaw.cleanup_crew_diagnostic_trace.v2",
        selected_state: "CONTINUE_PLAN_NEXT_STEP",
        owner_level_blocker_audit: "active_run_continuation_guard",
        risk_classification: {
          path_risk: "MEDIUM_RISK_RUNTIME",
          diff_intent: "routing_or_catalog_recording",
        },
        technical_vs_product: {
          lane: "plan_driven",
        },
        scope: {
          surfaces: ["reply-flow-test-active-run-guard"],
          records: ["plan:Inspect code"],
        },
        proof_refs: ["active-run-continuation-proof.json"],
      });
      await expect(
        readdir(path.join(outputDir, "cleanup_crew_stop_reports")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("allows blocked closeout after a lawful blocker is recorded", async () => {
    const dispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    installActiveRunContinuationGuard(dispatcher);
    recordActiveRunStarted(dispatcher);
    recordNonTerminalBuildUpdateEmitted(dispatcher, "plan:Inspect code");
    recordLawfulBlocker(dispatcher, "approval_unavailable");

    expect(allowTerminalCloseout(dispatcher, "sendFinalReply").allowed).toBe(true);
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        { type: "BLOCKER_STATE", detail: "true:approval_unavailable" },
        { type: "TERMINAL_CLOSEOUT_ATTEMPTED", detail: "sendFinalReply" },
        { type: "TERMINAL_CLOSEOUT_ALLOWED", detail: "sendFinalReply" },
      ]),
    );
  });

  it("keeps a lawful blocker across later non-terminal updates", async () => {
    const dispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    installActiveRunContinuationGuard(dispatcher);
    recordActiveRunStarted(dispatcher);
    recordNonTerminalBuildUpdateEmitted(dispatcher, "plan:Inspect code");
    recordLawfulBlocker(dispatcher, "approval_blocked");
    recordNonTerminalBuildUpdateEmitted(dispatcher, "readiness_report");
    recordNonTerminalBuildUpdateEmitted(dispatcher, "phase_report");
    recordNonTerminalBuildUpdateEmitted(dispatcher, "final_response_preparation");

    expect(allowTerminalCloseout(dispatcher, "sendFinalReply").allowed).toBe(true);
    await flushBlockedCloseoutIfNeeded(dispatcher);

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("BLOCKED_CLOSEOUT"),
      }),
    );
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        { type: "BLOCKER_STATE", detail: "true:approval_blocked" },
        { type: "NON_TERMINAL_BUILD_UPDATE_EMITTED", detail: "readiness_report" },
        { type: "BLOCKER_STATE", detail: "true:approval_blocked" },
        { type: "NON_TERMINAL_BUILD_UPDATE_EMITTED", detail: "phase_report" },
        { type: "BLOCKER_STATE", detail: "true:approval_blocked" },
        { type: "NON_TERMINAL_BUILD_UPDATE_EMITTED", detail: "final_response_preparation" },
        { type: "BLOCKER_STATE", detail: "true:approval_blocked" },
        { type: "TERMINAL_CLOSEOUT_ALLOWED", detail: "sendFinalReply" },
      ]),
    );
  });

  it("emits a blocked closeout during settle when continuation is impossible", async () => {
    const dispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    installActiveRunContinuationGuard(dispatcher);
    recordActiveRunStarted(dispatcher);
    recordNonTerminalBuildUpdateEmitted(dispatcher, "plan:Inspect code");

    await flushBlockedCloseoutIfNeeded(dispatcher);

    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ACTIVE_RUN_CONTINUITY_VIOLATION"),
      }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("BLOCKED_CLOSEOUT"),
      }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Next action: start the next executable step"),
      }),
    );
  });

  it("records operator pause instead of BLOCKED_CLOSEOUT for explicit status-only holds", async () => {
    const dispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: {
        currentTurnText: "status update only; don't do anything else",
      },
    });
    recordActiveRunStarted(dispatcher);
    recordNonTerminalBuildUpdateEmitted(dispatcher, "operator_status_report");

    expect(allowTerminalCloseout(dispatcher, "sendFinalReply").allowed).toBe(true);
    await flushBlockedCloseoutIfNeeded(dispatcher);

    expect(dispatcher.sendToolResult).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ACTIVE_RUN_CONTINUITY_VIOLATION"),
      }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("OPERATOR_PAUSED"),
        isStatusNotice: true,
      }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("BLOCKED_CLOSEOUT"),
      }),
    );
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        { type: "OPERATOR_PAUSE_HOLD_RECORDED", detail: "operator_pause_hold" },
        { type: "BLOCKER_STATE", detail: "true:operator_pause_hold" },
        { type: "NON_TERMINAL_BUILD_UPDATE_EMITTED", detail: "operator_status_report" },
        { type: "TERMINAL_CLOSEOUT_ALLOWED", detail: "sendFinalReply" },
        { type: "TERMINAL_CLOSEOUT_ALLOWED", detail: "OPERATOR_PAUSED" },
      ]),
    );
  });

  it("rejects Cleanup Crew final closeout on a repairable blocker with a lawful next repair path", () => {
    const dispatcher = createGuardedDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: {
        activeCleanupCrewMission: true,
        currentTurnText: "Run Cleanup Crew until the runtime cannot end wrong.",
      },
    });
    recordActiveRunStarted(dispatcher);

    expect(
      allowTerminalCloseout(dispatcher, "sendFinalReply", {
        text: [
          "STATUS: blocked",
          "MODE: Cleanup Crew execution",
          "BLOCKER: repairable blocker in watchdog lifecycle",
          "PROOF: Phase 13 watchdog receipt",
          "SAFE NEXT ACTION: continue cleanup repair and rerun watchdog",
        ].join("\n"),
      }).allowed,
    ).toBe(false);
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Cleanup Crew final response attempted terminal"),
      }),
    );
  });

  it("rejects STATUS blocked when a lawful next repair exists", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "BLOCKER: downstream phase blocked but Cleanup Crew repair can continue",
          "NEXT ACTION: inspect latest watchdog receipt and route repair",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      repairableBlocker: true,
      nextRepairPathKnown: true,
      typedDecisionReceipt: {
        outcome: "REPAIR_AND_CONTINUE",
        impact: "ACTION",
        reason_code: "TECHNICAL_REPAIR",
        next_action: "continue_cleanup_repair_through_canonical_policy",
      },
    });
  });

  it("rejects terminal scoped closeout when broader issue-family work remains open", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        currentTurnText: "Run Cleanup Crew SOP for ISSUE-040.",
        responseText: [
          "ISSUE-040 Tail Settlement Reliability first slice final closeout",
          "STATUS: Closed for the scoped first source slice.",
          "MODE: Cleanup Crew SOP.",
          "What is materially real now: scoped first source slice is live.",
          "What is still not real yet: broader ISSUE-040 reliability family remains open.",
          "Who lawfully owns the next step: Will / Cleanup Crew controller.",
          "Open/closed truth: Scoped first source slice is closed. Broader ISSUE-040 family remains open.",
          "Exact next action: continue ISSUE-040 family triage from the updated register.",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      violationReason:
        "Cleanup Crew final response attempted terminal closeout while broader work remains open: broader_build_open_next_action_named",
    });
  });

  it("rejects Cleanup Crew final closeout missing exact truth fields in the final path", () => {
    const dispatcher = createGuardedDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: {
        activeCleanupCrewMission: true,
        currentTurnText: "Run Cleanup Crew until the current slice is truthfully closed.",
      },
    });
    recordActiveRunStarted(dispatcher);

    const decision = allowTerminalCloseout(dispatcher, "sendFinalReply", {
      text: [
        "Cleanup Crew Runtime Enforcement Integration Slice 3 final closeout",
        "Status: closed",
        "Artifact path(s): /home/will/.openclaw/workspace/file_hub/exports/slice_3_closeout.md",
      ].join("\n"),
    });

    expect(decision).toMatchObject({
      allowed: false,
      violationReason: expect.stringContaining("report/closeout acceptance rejected"),
    });
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CLEANUP_CREW_TERMINAL_CLOSEOUT_REJECTED" }),
        expect.objectContaining({ type: "ACTIVE_RUN_CONTINUITY_VIOLATION" }),
      ]),
    );
  });

  it("allows explicit Mark report-only request to end after the report", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        currentTurnText: "Cleanup Crew report only. Do not continue.",
        responseText: [
          "STATUS: blocked",
          "BLOCKER: repairable blocker in watchdog lifecycle",
          "SAFE NEXT ACTION: continue cleanup repair",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: true,
      explicitReportOnlyRequest: true,
    });
  });

  it("allows explicit Mark stop request to end after the report", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        currentTurnText: "Stop after this Cleanup Crew report.",
        responseText: [
          "STATUS: blocked",
          "BLOCKER: repairable blocker in watchdog lifecycle",
          "SAFE NEXT ACTION: continue cleanup repair",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: true,
      explicitStopRequest: true,
    });
  });

  it("allows a true hard blocker only when the blocker is named with proof and blocker artifact", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "BLOCKER: authority cannot be verified for the required owner surface",
          "WHY CONTINUATION IS NOT LAWFUL: supported owner surface cannot be verified",
          "PROOF: live file reference search found no lawful owner",
          "BLOCKER_ARTIFACT: /tmp/cleanup-crew-hard-blocker.json",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: true,
      hardBlockerNamedWithProof: true,
      blockerArtifactPresent: true,
    });

    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "BLOCKER: authority cannot be verified for the required owner surface",
          "WHY CONTINUATION IS NOT LAWFUL: supported owner surface cannot be verified",
          "PROOF: live file reference search found no lawful owner",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      hardBlockerNamedWithProof: false,
      blockerArtifactPresent: false,
      typedDecisionReceipt: {
        outcome: "ACTION_BLOCKED",
        impact: "MISSION",
        reason_code: "AUTHORITY_CONFLICT",
        next_action: "record_lawful_blocker_artifact_before_terminal_closeout",
      },
    });
  });

  it("uses the Phase 5 typed B0 adapter instead of local-only blocker policy", () => {
    const decision = resolveCleanupCrewFinalResponseGate({
      activeCleanupCrewMission: true,
      responseText: [
        "STATUS: blocked",
        "BLOCKER: proof source unavailable",
        "NEXT ACTION: alternate lawful proof path and continue cleanup repair",
      ].join("\n"),
    });

    expect(decision).toMatchObject({
      allowed: false,
      repairableBlocker: true,
      nextRepairPathKnown: true,
      typedDecisionReceipt: {
        policy_version: "cleanup-crew-governance-final-20260714T1454Z",
        phase: "phase5_mechanical_policy_unification_b0_adapter",
        outcome: "REPAIR_AND_CONTINUE",
        reason_code: "TECHNICAL_REPAIR",
        validation: { ok: true, errors: [] },
      },
    });
  });

  it("does not allow terminal closeout from hard-blocker text unless the typed receipt is hard-terminal", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "BLOCKER: proof source unavailable",
          "WHY CONTINUATION IS NOT LAWFUL: first proof source is unavailable",
          "PROOF: alternate lawful proof path exists",
          "BLOCKER_ARTIFACT: /tmp/local-proof-artifact.json",
          "NEXT ACTION: alternate lawful proof path and continue cleanup repair",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      repairableBlocker: true,
      nextRepairPathKnown: true,
      hardBlockerNamedWithProof: false,
      typedDecisionReceipt: {
        outcome: "REPAIR_AND_CONTINUE",
        reason_code: "TECHNICAL_REPAIR",
        next_action: "continue_cleanup_repair_through_canonical_policy",
      },
    });
  });

  it("keeps proof gaps open when a plan amendment recovery path is named", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "RESULT: stoppage captured, plan amendment required, Cleanup Crew will resume from updated plan",
          "BLOCKER: proof_gap in focused validation output",
          "NEXT ACTION: update active build plan with next executable command",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      repairableBlocker: true,
      nextRepairPathKnown: true,
    });
  });

  it("allows Lane C stop only when a blocker artifact names the Mark decision", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "BLOCKER: Lane C product/behavior decision requires Mark decision",
          "PROOF: recovery classifier marked this as user-facing behavior decision",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      laneCDecisionRequired: true,
      blockerArtifactPresent: false,
    });

    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "BLOCKER: Lane C product/behavior decision requires Mark decision",
          "PROOF: recovery classifier marked this as user-facing behavior decision",
          "BLOCKER_ARTIFACT: /tmp/lane-c-decision.json",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: true,
      laneCDecisionRequired: true,
      blockerArtifactPresent: true,
    });
  });

  it("treats milestone reporting as visibility, not Cleanup Crew mission stop", () => {
    const dispatcher = createGuardedDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: {
        activeCleanupCrewMission: true,
        currentTurnText: "Execute Cleanup Crew packets in order.",
      },
    });
    recordActiveRunStarted(dispatcher);

    expect(
      allowTerminalCloseout(dispatcher, "sendFinalReply", {
        text: PACKET_A_MILESTONE_REPORT,
      }).allowed,
    ).toBe(false);
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        {
          type: "NON_TERMINAL_BUILD_UPDATE_EMITTED",
          detail: "cleanup_crew_milestone_visibility_report",
        },
        expect.objectContaining({ type: "ACTIVE_RUN_CONTINUITY_VIOLATION" }),
      ]),
    );
  });

  it("treats stage-based milestone reporting as visibility, not Cleanup Crew mission stop", () => {
    const dispatcher = createGuardedDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: {
        activeCleanupCrewMission: true,
        currentTurnText: "Execute Cleanup Crew stages in order.",
      },
    });
    recordActiveRunStarted(dispatcher);

    expect(
      allowTerminalCloseout(dispatcher, "sendFinalReply", {
        text: STAGE_MILESTONE_REPORT,
      }).allowed,
    ).toBe(false);
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        {
          type: "NON_TERMINAL_BUILD_UPDATE_EMITTED",
          detail: "cleanup_crew_milestone_visibility_report",
        },
        expect.objectContaining({ type: "ACTIVE_RUN_CONTINUITY_VIOLATION" }),
      ]),
    );
  });

  it("records false-closeout admission rejection in shadow mode without blocking final delivery", () => {
    const dispatcher = createGuardedDispatcher();
    installActiveRunContinuationGuard(dispatcher);
    const payload = setReplyPayloadMetadata(
      { text: "Final closeout report: complete." },
      { falseCloseoutAdmission: falseCloseoutAdmissionInput("shadow") },
    );

    expect(allowTerminalCloseout(dispatcher, "sendFinalReply", payload).allowed).toBe(true);
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("FALSE_CLOSEOUT_SHADOW_REJECTED"),
        isStatusNotice: true,
      }),
    );
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "FALSE_CLOSEOUT_ADMISSION_SHADOW_REJECTED" }),
        expect.objectContaining({ type: "TERMINAL_CLOSEOUT_ALLOWED" }),
      ]),
    );
  });

  it("blocks false-closeout admission rejection in enforce mode", () => {
    const dispatcher = createGuardedDispatcher();
    installActiveRunContinuationGuard(dispatcher);
    const payload = setReplyPayloadMetadata(
      { text: "Final closeout report: complete." },
      { falseCloseoutAdmission: falseCloseoutAdmissionInput("enforce") },
    );

    const decision = allowTerminalCloseout(dispatcher, "sendFinalReply", payload);

    expect(decision.allowed).toBe(false);
    expect(decision.violationReason).toContain("False-closeout admission controller rejected");
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "FALSE_CLOSEOUT_ADMISSION_ENFORCED_REJECTED" }),
        expect.objectContaining({ type: "ACTIVE_RUN_CONTINUITY_VIOLATION" }),
      ]),
    );
  });

  it("records false-closeout admission rejection as an audited bypass in off mode", () => {
    const dispatcher = createGuardedDispatcher();
    installActiveRunContinuationGuard(dispatcher);
    const payload = setReplyPayloadMetadata(
      { text: "Final closeout report: complete." },
      { falseCloseoutAdmission: falseCloseoutAdmissionInput("off") },
    );

    expect(allowTerminalCloseout(dispatcher, "sendFinalReply", payload).allowed).toBe(true);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("FALSE_CLOSEOUT_SHADOW_REJECTED"),
      }),
    );
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "FALSE_CLOSEOUT_ADMISSION_OFF_BYPASSED",
          detail: expect.stringContaining("off_bypassed_rejected"),
        }),
        expect.objectContaining({ type: "TERMINAL_CLOSEOUT_ALLOWED" }),
      ]),
    );
  });

  it("auto-produces false-closeout admission input for Cleanup Crew terminal replies in shadow mode", () => {
    const dispatcher = createGuardedDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: {
        activeCleanupCrewMission: true,
        currentTurnText: "Report only; do not continue the Cleanup Crew mission in this reply.",
        falseCloseoutAdmissionMode: "shadow",
      },
    });
    recordActiveRunStarted(dispatcher);

    expect(
      allowTerminalCloseout(dispatcher, "sendFinalReply", {
        text: "Final closeout report: complete.",
      }).allowed,
    ).toBe(true);
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("FALSE_CLOSEOUT_SHADOW_REJECTED"),
        isStatusNotice: true,
      }),
    );
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "FALSE_CLOSEOUT_ADMISSION_SHADOW_REJECTED" }),
        expect.objectContaining({ type: "TERMINAL_CLOSEOUT_ALLOWED" }),
      ]),
    );
  });

  it("auto-produces and blocks Cleanup Crew terminal false closeout in enforce mode", () => {
    const dispatcher = createGuardedDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: {
        activeCleanupCrewMission: true,
        currentTurnText: "Run the Cleanup Crew mission until it is truthfully closed.",
        falseCloseoutAdmissionMode: "enforce",
      },
    });
    recordActiveRunStarted(dispatcher);

    const decision = allowTerminalCloseout(dispatcher, "sendFinalReply", {
      text: "Final closeout report: complete.",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violationReason).toContain("False-closeout admission controller rejected");
    expect(activeRunContinuationTesting.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "FALSE_CLOSEOUT_ADMISSION_ENFORCED_REJECTED" }),
        expect.objectContaining({ type: "ACTIVE_RUN_CONTINUITY_VIOLATION" }),
      ]),
    );
  });

  it("does not treat stop adjacent production as stopping Cleanup Crew repair", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "BLOCKER: stop adjacent production while Cleanup Crew continues",
          "SAFE NEXT ACTION: continue_cleanup_repair",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      repairableBlocker: true,
      nextRepairPathKnown: true,
    });
  });

  it("rejects the old Phase 13 watchdog blocked pattern when repair classification is known", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "MODE: Cleanup Crew execution",
          "BLOCKER: Phase 13 watchdog NEEDS_REVIEW",
          "PROOF: watchdog receipt shows repairable blocker",
          "SAFE NEXT ACTION: inspect latest watchdog receipt, classify suspicious work, reconcile or route repair, rerun watchdog",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      repairableBlocker: true,
      nextRepairPathKnown: true,
    });
  });

  it("keeps recoverable watchdog intake reports open as Cleanup Crew recovery", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "RESULT: watchdog stoppage captured; routed to Cleanup Crew recovery",
          "BLOCKER: watchdog NEEDS_REVIEW paused adjacent production",
          "NEXT ACTION: analyze/read-only, amend plan, resume recovery, rerun watchdog",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      repairableBlocker: true,
      nextRepairPathKnown: true,
    });
  });

  it("keeps memory flush dirty-tree defects open as Lane A repair", () => {
    expect(
      resolveCleanupCrewFinalResponseGate({
        activeCleanupCrewMission: true,
        responseText: [
          "STATUS: blocked",
          "BLOCKER: memory flush dirty-tree defect",
          "RESULT: append-only memory flush is a Lane A memory append lane repair",
          "NEXT ACTION: update active build plan and validate append-only memory write",
        ].join("\n"),
      }),
    ).toMatchObject({
      allowed: false,
      repairableBlocker: true,
      nextRepairPathKnown: true,
    });
  });

  it("fires onIdle when the queue drains", async () => {
    const deliver: Parameters<typeof createReplyDispatcher>[0]["deliver"] = async () =>
      await Promise.resolve();
    const onIdle = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver, onIdle });

    dispatcher.sendToolResult({ text: "one" });
    dispatcher.sendFinalReply({ text: "two" });

    await dispatcher.waitForIdle();
    dispatcher.markComplete();
    await Promise.resolve();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("delays block replies after the first when humanDelay is natural", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      humanDelay: { mode: "natural" },
    });

    dispatcher.sendBlockReply({ text: "first" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    dispatcher.sendBlockReply({ text: "second" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(799);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("uses custom bounds for humanDelay and clamps when max <= min", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      humanDelay: { mode: "custom", minMs: 1200, maxMs: 400 },
    });

    dispatcher.sendBlockReply({ text: "first" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    dispatcher.sendBlockReply({ text: "second" });
    await vi.advanceTimersByTimeAsync(1199);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe("buildRuntimeCloseoutAdmissionInput", () => {
  it("uses the canonical false-closeout admission env flag for runtime activation", () => {
    process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION = "enforce";

    const input = buildRuntimeCloseoutAdmissionInput({
      activeCleanupCrewMission: true,
      terminalAttempt: true,
      currentTurnText: "Run Cleanup Crew until live enforcement is proven.",
      responseText: "Final closeout report: complete.",
    });

    expect(input?.manifest.mode).toBe("enforce");
  });

  it("keeps the legacy mode env flag as fallback", () => {
    process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION_MODE = "enforce";

    const input = buildRuntimeCloseoutAdmissionInput({
      activeCleanupCrewMission: true,
      terminalAttempt: true,
      currentTurnText: "Run Cleanup Crew until live enforcement is proven.",
      responseText: "Final closeout report: complete.",
    });

    expect(input?.manifest.mode).toBe("enforce");
  });

  it("lets an explicit runtime mode override env activation", () => {
    process.env.OPENCLAW_FALSE_CLOSEOUT_ADMISSION = "enforce";

    const input = buildRuntimeCloseoutAdmissionInput({
      activeCleanupCrewMission: true,
      terminalAttempt: true,
      mode: "shadow",
      currentTurnText: "Run Cleanup Crew until live enforcement is proven.",
      responseText: "Final closeout report: complete.",
    });

    expect(input?.manifest.mode).toBe("shadow");
  });
});

describe("waitForReplyDispatcherIdle", () => {
  it("returns when the abort signal fires before the dispatcher becomes idle", async () => {
    const controller = new AbortController();
    const waitForIdle = vi.fn(
      () =>
        new Promise<void>(() => {
          // Keep the dispatcher busy until the abort path wins.
        }),
    );

    let settled = false;
    const waitPromise = waitForReplyDispatcherIdle({ waitForIdle }, controller.signal).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    controller.abort();
    await waitPromise;

    expect(settled).toBe(true);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
  });
});

describe("createReplyToModeFilter", () => {
  it("handles off/all mode behavior for replyToId", () => {
    const cases: Array<{
      filter: ReturnType<typeof createReplyToModeFilter>;
      input: { text: string; replyToId?: string; replyToTag?: boolean };
      expectedReplyToId?: string;
    }> = [
      {
        filter: createReplyToModeFilter("off"),
        input: { text: "hi", replyToId: "1" },
        expectedReplyToId: undefined,
      },
      {
        filter: createReplyToModeFilter("off", { allowExplicitReplyTagsWhenOff: true }),
        input: { text: "hi", replyToId: "1", replyToTag: true },
        expectedReplyToId: "1",
      },
      {
        filter: createReplyToModeFilter("all"),
        input: { text: "hi", replyToId: "1" },
        expectedReplyToId: "1",
      },
    ];
    for (const testCase of cases) {
      expect(testCase.filter(testCase.input).replyToId).toBe(testCase.expectedReplyToId);
    }
  });

  it("keeps only the first replyToId when mode is first", () => {
    const filter = createReplyToModeFilter("first");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBe("1");
    expect(filter({ text: "next", replyToId: "1" }).replyToId).toBeUndefined();
  });
});
