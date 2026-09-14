import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReplyPayload } from "../types.js";
import {
  flushBlockedCloseoutIfNeeded,
  installActiveRunContinuationGuard,
  recordActiveRunStarted,
  recordNextExecutableStepStarted,
  recordNonTerminalBuildUpdateEmitted,
  recordOwnerBoundaryHandoff,
  recordTerminalCompletionProof,
  testing,
} from "./active-run-continuation-guard.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-active-run-guard-"));
});

afterEach(async () => {
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

async function readDurabilityObligations(): Promise<Array<Record<string, unknown>>> {
  const obligationDir = path.join(
    tempDir,
    "var",
    "continuity_gate_v2",
    "active_run_guard",
    "durability_obligations",
  );
  const entries = await readdir(obligationDir);
  return Promise.all(
    entries.map(async (entry) =>
      JSON.parse(await readFile(path.join(obligationDir, entry), "utf8")),
    ),
  );
}

describe("active run continuation guard durability obligations", () => {
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
    const obligations = await readDurabilityObligations();
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({
      kind: "openclaw.governed-run-durability-obligation",
      status: "open",
      sourceSurface: "active-run-continuation-guard:test",
      activeMission: "system-wide governed run durability test",
      obligatedOwner: "active_run_controller",
      watchdogVisible: true,
      requiredActions: [
        "record_durable_next_executable_step",
        "record_owner_boundary_handoff",
        "record_lawful_blocker",
        "record_terminal_completion_proof",
      ],
      lastNonTerminalDetail: "milestone_report_delivered",
      proofRefs: ["proof:test"],
      durabilityDecision: {
        state: "needs_durable_continuation",
        allowedToSettle: false,
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
