import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeTaskFlowRegistryDatabase,
  findGovernedMissionReceiptByIdempotencyFromSqlite,
} from "../../tasks/task-flow-registry.store.sqlite.js";
import type { ReplyPayload } from "../types.js";
import {
  allowTerminalCloseout,
  beginActiveRunContinuationGuard,
  flushBlockedCloseoutIfNeeded,
  installActiveRunContinuationGuard,
  recordActiveRunStarted,
  recordNextExecutableStepStarted,
  recordNonTerminalBuildUpdateEmitted,
  recordOwnerBoundaryHandoff,
  recordTerminalCompletionProof,
  resolveCleanupCrewFinalResponseGate,
  testing,
} from "./active-run-continuation-guard.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-active-run-guard-"));
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", tempDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));
});

afterEach(async () => {
  closeTaskFlowRegistryDatabase();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

function createDispatcher() {
  const finalPayloads: ReplyPayload[] = [];
  const toolPayloads: ReplyPayload[] = [];
  const dispatcher: ReplyDispatcher = {
    sendToolResult(payload) {
      toolPayloads.push(payload);
      return true;
    },
    sendBlockReply() {
      return true;
    },
    sendFinalReply(payload) {
      finalPayloads.push(payload);
      return true;
    },
    waitForIdle: async () => undefined,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => undefined,
  };
  return { dispatcher, finalPayloads, toolPayloads };
}

describe("active run continuation guard durability obligations", () => {
  const statusReport = [
    "STATUS: blocked",
    "BLOCKER: repairable blocker in watchdog lifecycle",
    "SAFE NEXT ACTION: continue cleanup repair",
  ].join("\n");

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
    "Do not continue with the Cleanup Crew build.",
    "Cleanup Crew production repair: do not continue all work.",
    "Cleanup Crew production repair: do not execute work.",
    "Cleanup Crew production repair: no execution of all work.",
    "Cleanup Crew production repair: no execution of production work.",
    "Cleanup Crew production repair: do not continue any work.",
    "Cleanup Crew production repair: do not execute any work.",
    "Cleanup Crew production repair: no execution of any work.",
    "Give me a Cleanup Crew status update and do not continue.",
    "Draft a plan. Run Cleanup Crew. Mention blockers and then pause now.",
    "Stop.",
    "Don't run.",
    "Do not resume.",
    "Do not start.",
    "Do not proceed.",
    "Stop the execution.",
    "Do not do any work on this production build.",
    "Cleanup Crew production repair: do not continue, please.",
    "Cleanup Crew production repair: stop for the moment, please.",
    "Stop working on the Cleanup Crew production repair.",
    "Stop all work on the Cleanup Crew production repair.",
    "Cleanup Crew production repair: stop all work.",
    "Do not proceed with work on the Cleanup Crew mission.",
    "Do not run the Cleanup Crew production build.",
    "Do not continue with the Cleanup Crew build, please.",
    "Do not continue with the Cleanup Crew build because I only want a status update.",
    "Do not continue with the Cleanup Crew build for now.",
    "Do not continue with the Cleanup Crew build, please, for now, because I only want status.",
    "No execution of this Cleanup Crew production mission.",
    "Pause the Cleanup Crew production repair.",
    "Cleanup Crew production repair: do not do any work, just answer.",
  ])(
    "allows an actual operator hold in enforce mode without completing the mission: %s",
    (currentTurnText) => {
      const { dispatcher } = createDispatcher();
      installActiveRunContinuationGuard(dispatcher, {
        cleanupCrewFinalResponse: {
          activeCleanupCrewMission: true,
          currentTurnText,
          falseCloseoutAdmissionMode: "enforce",
        },
      });
      recordActiveRunStarted(dispatcher);
      recordNonTerminalBuildUpdateEmitted(dispatcher, "current status requested");
      expect(
        allowTerminalCloseout(dispatcher, "sendFinalReply", { text: statusReport }).allowed,
      ).toBe(true);
      expect(testing.getEvents(dispatcher)).toContainEqual({
        type: "OPERATOR_PAUSE_HOLD_RECORDED",
        detail: "operator_pause_hold",
      });
      expect(testing.getEvents(dispatcher).map((event) => event.type)).not.toContain(
        "TERMINAL_COMPLETION_PROOF_RECORDED",
      );
      expect(testing.getEvents(dispatcher).map((event) => event.type)).not.toContain(
        "FALSE_CLOSEOUT_ADMISSION_ENFORCED_REJECTED",
      );
    },
  );

  it.each([
    "Cleanup Crew production repair: fix pause/resume handling and run its tests.",
    "Cleanup Crew production repair: fix status-only/report-only classification.",
    "Cleanup Crew production repair: fix the parser and do not run tests.",
    "Cleanup Crew production repair: fix the parser and do not run the production build tests.",
    "Cleanup Crew production repair: fix the parser and do not execute the production build tests.",
    "Cleanup Crew production repair: fix the parser and do not continue the repair helper.",
    "Cleanup Crew production repair: stop the repair helper and run the remaining checks.",
    "Cleanup Crew production repair: do not do any work on the repair helper; run remaining checks.",
    "Cleanup Crew production repair: fix the parser; no execution of this mission classifier.",
    "Cleanup Crew production repair: fix the 'status only and do not continue' regression and run its tests.",
    "Pause Cleanup Crew. Start the build now.",
    "Stop. Proceed with the Cleanup Crew repair now.",
    "Proceed with the Cleanup Crew production status report only because I will review it and then execute the Cleanup Crew repair.",
    "Proceed with the Cleanup Crew production status report only and I will review it and then execute the Cleanup Crew repair.",
    "Please proceed with the Cleanup Crew production status report only and I will review it and then execute the Cleanup Crew repair.",
    "Please, proceed with the Cleanup Crew production status report only and I will review it and then execute the Cleanup Crew repair.",
    "Draft a plan for Cleanup Crew and execute it now.",
    "Draft a plan to fix Cleanup Crew and execute it now.",
    "Draft a Cleanup Crew production plan and include rollback steps; then execute it now.",
    "Give me a Cleanup Crew production build plan. Execute it now.",
  ])(
    "rejects the same nonterminal status for an execution request in enforce mode: %s",
    (currentTurnText) => {
      const { dispatcher } = createDispatcher();
      installActiveRunContinuationGuard(dispatcher, {
        cleanupCrewFinalResponse: {
          activeCleanupCrewMission: true,
          currentTurnText,
          falseCloseoutAdmissionMode: "enforce",
        },
      });
      recordActiveRunStarted(dispatcher);
      recordNonTerminalBuildUpdateEmitted(dispatcher, "research pending");
      expect(
        allowTerminalCloseout(dispatcher, "sendFinalReply", { text: statusReport }).allowed,
      ).toBe(false);
      expect(testing.getEvents(dispatcher).map((event) => event.type)).not.toContain(
        "OPERATOR_PAUSE_HOLD_RECORDED",
      );
    },
  );

  it("does not carry a previous operator hold into a fresh production turn", () => {
    const { dispatcher } = createDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: { currentTurnText: "Pause the Cleanup Crew production repair." },
    });
    beginActiveRunContinuationGuard(dispatcher);
    installActiveRunContinuationGuard(dispatcher, {
      cleanupCrewFinalResponse: {
        currentTurnText: "Cleanup Crew production repair: fix the paused task recovery.",
        falseCloseoutAdmissionMode: "enforce",
      },
    });
    recordNonTerminalBuildUpdateEmitted(dispatcher, "research pending");
    expect(
      allowTerminalCloseout(dispatcher, "sendFinalReply", { text: statusReport }).allowed,
    ).toBe(false);
    expect(testing.getEvents(dispatcher).map((event) => event.type)).not.toContain(
      "OPERATOR_PAUSE_HOLD_RECORDED",
    );
  });

  it("allows the requested prompt without inheriting an older production mission", () => {
    const result = resolveCleanupCrewFinalResponseGate({
      currentTurnText:
        "Give me an optimized research prompt to have Cleanup Crew review the system and research common issues and fixes.",
      responseText: "The requested research prompt is ready.",
      activeCleanupCrewMission: true,
    });
    expect(result.activeCleanupCrewMission).toBe(false);
    expect(result.allowed).toBe(true);
  });

  it("does not exempt production repair that discusses a planning-only regression", () => {
    const result = resolveCleanupCrewFinalResponseGate({
      currentTurnText: "Cleanup Crew production repair: fix the planning-only closeout regression.",
      responseText: "Status: done.",
      activeCleanupCrewMission: true,
    });
    expect(result.activeCleanupCrewMission).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it("writes a watchdog-visible durability obligation when BLOCKED_CLOSEOUT is emitted", async () => {
    const { dispatcher, finalPayloads } = createDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      persistence: {
        outputDir: path.join(tempDir, "var", "continuity_gate_v2", "active_run_guard"),
        activeMission: "system-wide governed run durability test",
        authoritySources: [
          {
            kind: "active_mission_lock",
            id: "mission:test",
            summary: "test mission",
            active: true,
          },
        ],
        sourceSurface: "active-run-continuation-guard:test",
        proofRefs: ["proof:test"],
        now: "2026-09-04T12:32:00.000Z",
      },
    });
    recordActiveRunStarted(dispatcher);
    recordNonTerminalBuildUpdateEmitted(dispatcher, "milestone_report_delivered");

    await flushBlockedCloseoutIfNeeded(dispatcher);
    await testing.flushPersistence(dispatcher);

    expect(finalPayloads.at(-1)?.text).toContain("BLOCKED_CLOSEOUT");
    const receiptId = testing
      .getEvents(dispatcher)
      .find((event) => event.type === "GOVERNED_RUN_DURABILITY_OBLIGATION_WRITTEN")?.detail;
    expect(receiptId).toMatch(/^durability:/u);
    const receipt = findGovernedMissionReceiptByIdempotencyFromSqlite({
      missionId: "system-wide governed run durability test",
      idempotencyKey: receiptId!.slice("durability:".length),
    });
    expect(receipt).toMatchObject({
      receiptId,
      receiptKind: "durability_obligation",
      decision: "repair_required",
      reasonCode: "needs_durable_continuation",
      details: {
        eventKind: "blocked_closeout",
        watchdogVisible: true,
        sourceSurface: "active-run-continuation-guard:test",
      },
    });
  });

  it("does not write a durability obligation after owner-boundary handoff is recorded", async () => {
    const { dispatcher, finalPayloads } = createDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      persistence: {
        outputDir: path.join(tempDir, "var", "continuity_gate_v2", "active_run_guard"),
        activeMission: "system-wide department-flow drill",
        authoritySources: [],
      },
    });
    recordActiveRunStarted(dispatcher);
    recordNonTerminalBuildUpdateEmitted(dispatcher, "section_report_delivered");
    recordOwnerBoundaryHandoff(dispatcher, "routed to lawful owner, build still open.");

    await flushBlockedCloseoutIfNeeded(dispatcher);

    expect(finalPayloads).toHaveLength(0);
    expect(testing.getEvents(dispatcher)).toEqual(
      expect.arrayContaining([
        {
          type: "OWNER_BOUNDARY_HANDOFF_RECORDED",
          detail: "routed to lawful owner, build still open.",
        },
      ]),
    );
  });

  it("does not write a durability obligation after the next executable step starts", async () => {
    const { dispatcher, finalPayloads } = createDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      persistence: {
        outputDir: path.join(tempDir, "var", "continuity_gate_v2", "active_run_guard"),
        activeMission: "system-wide governed run durability test",
        authoritySources: [],
      },
    });
    recordActiveRunStarted(dispatcher);
    recordNonTerminalBuildUpdateEmitted(dispatcher, "milestone_report_delivered");
    recordNextExecutableStepStarted(dispatcher, "focused_validation_started");

    await flushBlockedCloseoutIfNeeded(dispatcher);

    expect(finalPayloads).toHaveLength(0);
    expect(testing.getEvents(dispatcher).map((event) => event.type)).not.toContain(
      "GOVERNED_RUN_DURABILITY_OBLIGATION_WRITTEN",
    );
  });

  it("requires fresh terminal proof after a later non-terminal update", async () => {
    const { dispatcher, finalPayloads } = createDispatcher();
    installActiveRunContinuationGuard(dispatcher, {
      persistence: {
        outputDir: path.join(tempDir, "var", "continuity_gate_v2", "active_run_guard"),
        activeMission: "system-wide department-flow drill",
        authoritySources: [],
      },
    });
    recordActiveRunStarted(dispatcher);
    recordNonTerminalBuildUpdateEmitted(dispatcher, "phase5_ack_progress");
    recordTerminalCompletionProof(dispatcher, "phase5_acknowledgement_schema");
    recordNonTerminalBuildUpdateEmitted(dispatcher, "later_non_terminal_update");

    await flushBlockedCloseoutIfNeeded(dispatcher);

    expect(finalPayloads.at(-1)?.text).toContain("BLOCKED_CLOSEOUT");
  });
});
