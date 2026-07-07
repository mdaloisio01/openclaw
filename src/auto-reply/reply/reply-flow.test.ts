import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { markReplyPayloadAsProgressHeartbeat } from "../reply-payload.js";
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
  return JSON.parse(await readFile(path.join(artifactDir, files[0]!), "utf8")) as T;
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
    });
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
