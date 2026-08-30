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
