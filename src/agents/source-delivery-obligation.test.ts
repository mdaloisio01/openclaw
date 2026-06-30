import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSourceDeliveryObligationId,
  evaluateSourceDeliveryObligation,
  listSourceDeliveryObligations,
  recordSourceDeliveryFailure,
  recordSourceDeliveryObligation,
  recordSourceTurnReference,
  recordSourceVisibleDelivery,
  recordSourceVisibleDeliveryIfPresent,
} from "./source-delivery-obligation.js";

let markerDir: string;
let originalMarkerDir: string | undefined;

async function readRegistry() {
  return JSON.parse(
    await readFile(join(markerDir, "source_delivery_obligations.json"), "utf8"),
  ) as {
    rows: Array<Record<string, unknown>>;
  };
}

describe("source delivery obligation", () => {
  beforeEach(async () => {
    markerDir = await mkdtemp(join(tmpdir(), "openclaw-source-delivery-"));
    originalMarkerDir = process.env.OPENCLAW_SOURCE_DELIVERY_OBLIGATION_DIR;
    process.env.OPENCLAW_SOURCE_DELIVERY_OBLIGATION_DIR = markerDir;
  });

  afterEach(async () => {
    if (originalMarkerDir === undefined) {
      delete process.env.OPENCLAW_SOURCE_DELIVERY_OBLIGATION_DIR;
    } else {
      process.env.OPENCLAW_SOURCE_DELIVERY_OBLIGATION_DIR = originalMarkerDir;
    }
    await rm(markerDir, { recursive: true, force: true });
  });

  it("creates a durable source delivery obligation for a direct user turn", async () => {
    const id = buildSourceDeliveryObligationId({
      sourceSessionKey: "agent:orchestrator:main",
      parentRunId: "run-1",
    });

    recordSourceDeliveryObligation({
      id,
      sourceChannel: "webchat",
      sourceSessionKey: "agent:orchestrator:main",
      sourceMessageId: "msg-1",
      parentRunId: "run-1",
      missionLabel: "Fix source delivery.",
      deliveryContext: { channel: "webchat", to: "session:dashboard" },
    });

    const registry = await readRegistry();
    expect(registry.rows).toEqual([
      expect.objectContaining({
        id,
        sourceTurnId: id,
        kind: "openclaw.source-delivery-obligation",
        sourceChannel: "webchat",
        sourceSessionKey: "agent:orchestrator:main",
        sourceMessageId: "msg-1",
        parentRunId: "run-1",
        requiredMilestoneDelivery: true,
        requiredFinalDelivery: true,
        finalDeliveryDelivered: false,
        deliveryStatus: "accepted",
        sourceTurnState: "accepted",
      }),
    ]);
  });

  it("uses the source message id as the canonical source turn key when available", () => {
    expect(
      buildSourceDeliveryObligationId({
        sourceSessionKey: "agent:orchestrator:main",
        parentRunId: "run-1",
        sourceMessageId: "msg-1",
      }),
    ).toBe("source:agent:orchestrator:main:msg-1");
  });

  it("marks final source-visible delivery only for real non-NO_REPLY text", () => {
    const id = "source:agent:orchestrator:main:run-2";
    recordSourceDeliveryObligation({ id, sourceChannel: "webchat" });

    recordSourceVisibleDelivery({
      id,
      text: "STATUS: Success\nFinal body delivered.",
      final: true,
    });

    const [row] = listSourceDeliveryObligations({ dir: markerDir });
    expect(row).toMatchObject({
      id,
      deliveryStatus: "final_delivered",
      sourceTurnState: "final_delivered",
      progressDeliveryState: "progress_delivered",
      finalDeliveryState: "final_delivered",
      finalDeliveryDelivered: true,
      visibleDeliveryCount: 1,
    });
    expect(row?.lastUserVisibleDeliveryAt).toEqual(expect.any(String));
    expect(row?.deliveryEvents?.at(-1)).toMatchObject({
      type: "final",
      proof: "source-chat-visible payload delivered",
    });
  });

  it("increments source-visible delivery count after each proven chat delivery", () => {
    const id = "source:agent:orchestrator:main:run-count";
    recordSourceDeliveryObligation({ id, sourceChannel: "webchat" });

    recordSourceVisibleDelivery({ id, text: "STATUS: In Progress", final: false });
    recordSourceVisibleDelivery({ id, text: "STATUS: In Progress\nStill working", final: false });

    const [row] = listSourceDeliveryObligations({ dir: markerDir });
    expect(row).toMatchObject({
      visibleDeliveryCount: 2,
      deliveryStatus: "progress_delivered",
      finalDeliveryDelivered: false,
    });
  });

  it("treats NO_REPLY as a delivery failure when source-visible delivery is required", () => {
    const id = "source:agent:orchestrator:main:run-3";
    recordSourceDeliveryObligation({ id, sourceChannel: "webchat" });

    recordSourceVisibleDelivery({ id, text: "NO_REPLY", final: true });

    const [row] = listSourceDeliveryObligations({ dir: markerDir });
    expect(row).toMatchObject({
      id,
      deliveryStatus: "delivery_failed",
      userFacingDeliveryFailed: true,
      failureReason: "source-visible delivery was empty or NO_REPLY",
    });
  });

  it("updates progress only when the source obligation already exists", () => {
    recordSourceVisibleDeliveryIfPresent({
      id: "source:missing:run",
      text: "hidden progress should not create an obligation",
      final: false,
    });
    expect(listSourceDeliveryObligations({ dir: markerDir })).toEqual([]);

    const id = "source:agent:orchestrator:main:run-progress";
    recordSourceDeliveryObligation({ id, sourceChannel: "webchat" });
    recordSourceVisibleDeliveryIfPresent({
      id,
      text: "STATUS: In Progress",
      final: false,
      currentStage: "plan source dispatch delivered",
    });

    const [row] = listSourceDeliveryObligations({ dir: markerDir });
    expect(row).toMatchObject({
      id,
      deliveryStatus: "progress_delivered",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 1,
      currentStage: "plan source dispatch delivered",
    });
  });

  it("records progress on the latest open source turn when progress lacks the source message id", () => {
    const oldId = "source:agent:orchestrator:main:old-msg";
    const currentId = "source:agent:orchestrator:main:current-msg";
    recordSourceDeliveryObligation({
      id: oldId,
      sourceChannel: "webchat",
      sourceSessionKey: "agent:orchestrator:main",
      sourceMessageId: "old-msg",
      acceptedAt: "2026-06-30T16:00:00.000Z",
    });
    recordSourceDeliveryObligation({
      id: currentId,
      sourceChannel: "webchat",
      sourceSessionKey: "agent:orchestrator:main",
      sourceMessageId: "current-msg",
      acceptedAt: "2026-06-30T16:09:00.000Z",
    });

    recordSourceVisibleDeliveryIfPresent({
      id: "source:agent:orchestrator:main:agent:orchestrator:main",
      sourceSessionKey: "agent:orchestrator:main",
      parentRunId: "agent:orchestrator:main",
      text: "STATUS: In Progress\nVisible milestone delivered.",
      final: false,
      currentStage: "milestone source dispatch delivered",
    });

    const rows = listSourceDeliveryObligations({ dir: markerDir });
    expect(rows.find((row) => row.id === oldId)).toMatchObject({
      deliveryStatus: "accepted",
      visibleDeliveryCount: 0,
    });
    expect(rows.find((row) => row.id === currentId)).toMatchObject({
      deliveryStatus: "progress_delivered",
      sourceTurnState: "progress_delivered",
      progressDeliveryState: "progress_delivered",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 1,
      currentStage: "milestone source dispatch delivered",
    });
  });

  it("evaluates stale direct turns with no visible source-chat progress as not clean", () => {
    const acceptedAt = "2026-06-30T01:02:00.000Z";
    const row = recordSourceDeliveryObligation({
      id: "source:agent:orchestrator:main:run-4",
      sourceChannel: "webchat",
      acceptedAt,
    });

    expect(row).toBeTruthy();
    expect(
      evaluateSourceDeliveryObligation(row!, {
        nowMs: Date.parse("2026-06-30T01:20:00.000Z"),
        staleMs: 10 * 60 * 1000,
      }),
    ).toMatchObject({
      ok: false,
      reason: "source_delivery_stale",
    });
  });

  it("records suspended or unroutable subagent delivery as a failed source obligation", () => {
    const id = "source:agent:orchestrator:main:subagent-run";
    recordSourceDeliveryFailure({
      id,
      reason: "announce deferred or direct delivery failed",
      sourceChannel: "webchat",
      sourceSessionKey: "agent:orchestrator:main",
      parentRunId: "subagent-run",
      deliveryContext: { channel: "webchat" },
    });

    const [row] = listSourceDeliveryObligations({ dir: markerDir });
    expect(row).toMatchObject({
      id,
      deliveryStatus: "delivery_failed",
      userFacingDeliveryFailed: true,
      failureReason: "announce deferred or direct delivery failed",
      deliveryContext: { channel: "webchat" },
    });
    expect(evaluateSourceDeliveryObligation(row!)).toMatchObject({
      ok: false,
      reason: "source_delivery_failed",
    });
  });

  it("records visible delivery-contract failure proof while keeping recovery debt open", () => {
    const id = "source:agent:orchestrator:main:private-final";
    recordSourceDeliveryObligation({ id, sourceChannel: "webchat" });

    recordSourceDeliveryFailure({
      id,
      reason: "private final reply withheld because required source delivery tool was not used",
      currentStage: "final source dispatch delivered",
      visibleFailureText:
        "Delivery failed: the agent produced a private final reply but did not use the required source delivery tool. The private reply body was withheld. This turn requires recovery.",
    });

    const [row] = listSourceDeliveryObligations({ dir: markerDir });
    expect(row).toMatchObject({
      id,
      deliveryStatus: "delivery_failed",
      sourceTurnState: "delivery_failed",
      finalDeliveryState: "delivery_failed",
      finalDeliveryDelivered: false,
      recoveryState: "recovery_pending",
      userFacingDeliveryFailed: true,
      visibleDeliveryCount: 1,
    });
    expect(row?.lastUserVisibleDeliveryAt).toEqual(expect.any(String));
    expect(row?.deliveryEvents?.at(-1)).toMatchObject({
      type: "failure",
      proof: "source-chat-visible delivery-contract failure delivered",
      textPreview: expect.stringContaining("Delivery failed:"),
    });
    expect(evaluateSourceDeliveryObligation(row!)).toMatchObject({
      ok: false,
      reason: "source_delivery_failed",
    });
  });

  it("attaches child and report references to the canonical source turn", () => {
    const id = "source:agent:orchestrator:main:run-reference";
    recordSourceDeliveryObligation({ id, sourceChannel: "webchat" });

    recordSourceTurnReference({
      id,
      currentStage: "subagent run registered",
      childRunIds: ["child-run-1"],
      subagentTaskIds: ["agent:orchestrator:subagent:child"],
      reportArtifactPaths: ["/tmp/report.md"],
      deliveryStatus: "final_pending",
    });

    const [row] = listSourceDeliveryObligations({ dir: markerDir });
    expect(row).toMatchObject({
      id,
      deliveryStatus: "final_pending",
      sourceTurnState: "final_pending",
      childRunIds: ["child-run-1"],
      subagentTaskIds: ["agent:orchestrator:subagent:child"],
      reportArtifactPaths: ["/tmp/report.md"],
    });
    expect(row?.deliveryEvents?.at(-1)).toMatchObject({
      type: "reference",
      stage: "subagent run registered",
    });
  });
});
