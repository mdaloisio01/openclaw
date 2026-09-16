import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyOwnerRequestIntakeGaps,
  classifyOwnerRequestIntakeMessage,
  createOwnerRequestIntakeRecord,
  listOwnerRequestIntakeRecords,
  markOwnerRequestChatOnlyExempted,
  markOwnerRequestMissionRegistered,
  markOwnerRequestOwnerNotified,
  markOwnerRequestPromptPersisted,
  markOwnerRequestRecoveryDispatched,
} from "./owner-request-intake-ledger.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-owner-request-intake-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("owner request intake ledger", () => {
  it("persists governed request metadata without storing the full prompt", () => {
    const record = createOwnerRequestIntakeRecord({
      message: "Cleanup Crew production repair build. ".repeat(20),
      sourceSessionKey: "agent:orchestrator:main",
      clientSendAttemptId: "run-1",
      clientSendAttemptAtMs: 900,
      classification: "cleanup_crew_production",
      expectedDurability: "taskflow_required",
      stateDir,
      nowMs: 1_000,
    });

    const rows = listOwnerRequestIntakeRecords({ stateDir });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: record.requestId,
      status: "server_acknowledged",
      governed: true,
      classification: "cleanup_crew_production",
      expectedDurability: "taskflow_required",
      sourceSessionKey: "agent:orchestrator:main",
      clientSendAttemptId: "run-1",
      clientSendAttemptAtMs: 900,
      serverAckAtMs: 1_000,
    });
    expect(rows[0]?.messageFingerprintSha256).toHaveLength(64);
    expect(rows[0]?.messageSnippet?.length).toBeLessThanOrEqual(160);
  });

  it("classifies ordinary chat separately from governed owner work", () => {
    expect(classifyOwnerRequestIntakeMessage("test")).toMatchObject({
      classification: "chat_only",
      expectedDurability: "chat_only_exemption",
      governed: false,
    });
    expect(
      classifyOwnerRequestIntakeMessage("perform a read-only system-wide inventory"),
    ).toMatchObject({
      classification: "read_only_reporting",
      expectedDurability: "taskflow_or_exemption",
      governed: true,
    });
    expect(
      classifyOwnerRequestIntakeMessage("start the Cleanup Crew remediation build"),
    ).toMatchObject({
      classification: "cleanup_crew_production",
      expectedDurability: "taskflow_required",
      governed: true,
    });
  });

  it.each([
    "Give me a Cleanup Crew production report only.",
    "Give me the current Cleanup Crew production report only.",
    "Give me an optimized research prompt to have Cleanup Crew review the system and research common issues and fixes.",
    "Okay, make up a full production SOP build plan for Cleanup Crew.",
    "Cleanup Crew production build: only draft a prompt for the repair.",
    "Cleanup Crew production repair: status only; do not continue.",
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
    "Do not continue with the Cleanup Crew build, please.",
    "Do not continue with the Cleanup Crew build because I only want a status update.",
    "Do not continue with the Cleanup Crew build for now.",
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
    "No execution of this Cleanup Crew production mission.",
    "Pause the Cleanup Crew production repair.",
    "Cleanup Crew production repair: do not do any work, just answer.",
  ])("does not create an executable mission obligation for a restricted request: %s", (message) => {
    expect(classifyOwnerRequestIntakeMessage(message)).toMatchObject({
      classification: "chat_only",
      expectedDurability: "chat_only_exemption",
      governed: false,
    });
  });

  it.each([
    "Draft a Cleanup Crew production build plan and then execute it.",
    "Draft a Cleanup Crew production build plan, but execute it now.",
    "Draft a plan for Cleanup Crew and execute it now.",
    "Draft a plan to fix Cleanup Crew and execute it now.",
    "Draft a Cleanup Crew production plan and include rollback steps; then execute it now.",
    "Give me a Cleanup Crew production build plan. Execute it now.",
    "Cleanup Crew production repair: fix the planning-only closeout regression.",
    "Cleanup Crew production repair: fix status-only/report-only classification.",
    "Cleanup Crew production repair: fix pause/resume handling and run its tests.",
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
    "Write production code for a plan validator.",
  ])("keeps the current execution request governed: %s", (message) => {
    expect(classifyOwnerRequestIntakeMessage(message).governed).toBe(true);
  });

  it("classifies intake gaps at each pre-registration stage", () => {
    const clientOnly = createOwnerRequestIntakeRecord({
      message: "client send",
      classification: "governed_mission",
      expectedDurability: "taskflow_required",
      status: "client_send_attempt",
      stateDir,
      nowMs: 1_000,
    });
    const serverOnly = createOwnerRequestIntakeRecord({
      message: "server ack",
      classification: "governed_mission",
      expectedDurability: "taskflow_required",
      status: "server_acknowledged",
      stateDir,
      nowMs: 2_000,
    });
    const promptPersisted = createOwnerRequestIntakeRecord({
      message: "prompt persisted",
      classification: "governed_mission",
      expectedDurability: "taskflow_required",
      status: "server_acknowledged",
      stateDir,
      nowMs: 3_000,
    });
    markOwnerRequestPromptPersisted({
      requestId: promptPersisted.requestId,
      stateDir,
      nowMs: 3_100,
    });

    expect(
      classifyOwnerRequestIntakeGaps({ stateDir, nowMs: 200_000, graceMs: 1 }).map((gap) => [
        gap.requestId,
        gap.category,
      ]),
    ).toEqual([
      [clientOnly.requestId, "client_send_no_server_ack"],
      [serverOnly.requestId, "server_ack_no_prompt_persist"],
      [promptPersisted.requestId, "prompt_persist_no_mission_registration"],
    ]);
  });

  it("does not flag registered missions or explicit chat-only exemptions", () => {
    const registered = createOwnerRequestIntakeRecord({
      message: "registered",
      classification: "governed_mission",
      expectedDurability: "taskflow_required",
      stateDir,
      nowMs: 1_000,
    });
    markOwnerRequestMissionRegistered({
      requestId: registered.requestId,
      taskFlowId: "flow-1",
      taskId: "task-1",
      stateDir,
      nowMs: 2_000,
    });
    expect(classifyOwnerRequestIntakeGaps({ stateDir, nowMs: 200_000, graceMs: 1 })).toMatchObject([
      { requestId: registered.requestId, category: "server_ack_no_prompt_persist" },
    ]);
    markOwnerRequestPromptPersisted({ requestId: registered.requestId, stateDir, nowMs: 2_100 });
    const chatOnly = createOwnerRequestIntakeRecord({
      message: "hello",
      classification: "chat_only",
      expectedDurability: "chat_only_exemption",
      governed: false,
      stateDir,
      nowMs: 3_000,
    });
    markOwnerRequestChatOnlyExempted({
      requestId: chatOnly.requestId,
      reason: "ordinary short chat",
      stateDir,
      nowMs: 4_000,
    });

    expect(classifyOwnerRequestIntakeGaps({ stateDir, nowMs: 200_000, graceMs: 1 })).toEqual([]);
  });

  it.each(["taskflow_or_exemption", "taskflow_required"] as const)(
    "binds a managed task only when %s allows it",
    (expectedDurability) => {
      const record = createOwnerRequestIntakeRecord({
        message: "bounded delegated acknowledgement",
        classification: "governed_mission",
        expectedDurability,
        stateDir,
      });
      const bind = () =>
        markOwnerRequestMissionRegistered({
          requestId: record.requestId,
          taskId: "managed-acp-task",
          stateDir,
        });
      if (expectedDurability === "taskflow_required") {
        expect(bind).toThrow("durable mission identity");
        expect(listOwnerRequestIntakeRecords({ stateDir })[0].status).toBe("server_acknowledged");
      } else {
        expect(bind()).toMatchObject({ status: "mission_registered", taskId: "managed-acp-task" });
      }
    },
  );

  it("records proof-backed recovery dispatches and excludes them from open gaps", () => {
    const record = createOwnerRequestIntakeRecord({
      message: "Cleanup Crew production repair build",
      classification: "cleanup_crew_production",
      expectedDurability: "taskflow_required",
      stateDir,
      nowMs: 1_000,
    });

    const updated = markOwnerRequestRecoveryDispatched({
      requestId: record.requestId,
      recoveryDispatchId: "watchdog-repair-work-1",
      reason: "watchdog repair work dispatched",
      nextExecutableAction: "rerun system-wide active-work watchdog",
      stateDir,
      nowMs: 2_000,
    });

    expect(updated).toMatchObject({
      status: "recovery_dispatched",
      recoveryDispatchId: "watchdog-repair-work-1",
      reason: "watchdog repair work dispatched",
      nextExecutableAction: "rerun system-wide active-work watchdog",
    });
    expect(classifyOwnerRequestIntakeGaps({ stateDir, nowMs: 200_000, graceMs: 1 })).toEqual([]);
  });

  it("records proof-backed owner notification settlement and excludes it from open gaps", () => {
    const record = createOwnerRequestIntakeRecord({
      message: "governed build request",
      classification: "governed_mission",
      expectedDurability: "taskflow_or_exemption",
      stateDir,
      nowMs: 1_000,
    });
    const ownerNotificationProofPath = path.join(stateDir, "owner-notification-proof.json");
    fs.writeFileSync(ownerNotificationProofPath, JSON.stringify({ schema: "proof" }));

    const updated = markOwnerRequestOwnerNotified({
      requestId: record.requestId,
      ownerNotificationId: "owner-notification-report-1",
      ownerNotificationProofPath,
      reason: "historical intake gap surfaced to owner",
      stateDir,
      nowMs: 2_000,
    });

    expect(updated).toMatchObject({
      status: "owner_notified",
      ownerNotificationId: "owner-notification-report-1",
      ownerNotificationProofPath,
      reason: "historical intake gap surfaced to owner",
    });
    expect(classifyOwnerRequestIntakeGaps({ stateDir, nowMs: 200_000, graceMs: 1 })).toEqual([]);
  });

  it("rejects owner notification settlement when the durable proof file is missing", () => {
    const record = createOwnerRequestIntakeRecord({
      message: "governed build request",
      classification: "governed_mission",
      expectedDurability: "taskflow_or_exemption",
      stateDir,
      nowMs: 1_000,
    });

    expect(() =>
      markOwnerRequestOwnerNotified({
        requestId: record.requestId,
        ownerNotificationId: "owner-notification-report-1",
        ownerNotificationProofPath: path.join(stateDir, "missing-proof.json"),
        reason: "historical intake gap surfaced to owner",
        stateDir,
        nowMs: 2_000,
      }),
    ).toThrow(/owner notification proof path does not exist/);
    expect(
      classifyOwnerRequestIntakeGaps({ stateDir, nowMs: 200_000, graceMs: 1 }).map(
        (gap) => gap.requestId,
      ),
    ).toEqual([record.requestId]);
  });

  it("keeps owner-notified rows visible when settlement proof is missing", () => {
    const record = createOwnerRequestIntakeRecord({
      message: "governed build request",
      classification: "governed_mission",
      expectedDurability: "taskflow_or_exemption",
      stateDir,
      nowMs: 1_000,
    });
    const ledgerPath = path.join(stateDir, "owner-request-intake-ledger", "records.json");
    const payload = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    payload.records = payload.records.map((row) =>
      row.requestId === record.requestId
        ? {
            ...row,
            status: "owner_notified",
            ownerNotificationId: "owner-notification-report-1",
            reason: "historical intake gap surfaced to owner",
          }
        : row,
    );
    fs.writeFileSync(ledgerPath, `${JSON.stringify(payload, null, 2)}\n`);

    expect(
      classifyOwnerRequestIntakeGaps({ stateDir, nowMs: 200_000, graceMs: 1 }).map(
        (gap) => gap.requestId,
      ),
    ).toEqual([record.requestId]);
  });
});
