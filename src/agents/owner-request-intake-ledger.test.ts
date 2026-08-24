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
  markOwnerRequestPromptPersisted,
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
});
