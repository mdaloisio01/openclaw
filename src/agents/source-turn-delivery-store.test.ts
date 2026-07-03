import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifySourceTurnDeliveryWatchdogStatus,
  loadSourceTurnDeliveryRegistry,
  persistSourceTurnDeliveryState,
  sourceTurnDeliveryBlocksWatchdog,
} from "./source-turn-delivery-store.js";

let tempDir: string;
let registryPath: string;

async function rawRows() {
  return JSON.parse(await readFile(registryPath, "utf8")) as {
    rows: Array<Record<string, unknown>>;
  };
}

describe("source turn delivery storage adapter", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openclaw-source-turn-store-"));
    registryPath = join(tempDir, "source_delivery_obligations.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists accepted state correctly", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:accepted",
      facts: {},
      now: "2026-07-03T05:00:00.000Z",
    });

    expect(row).toMatchObject({
      id: "source:main:accepted",
      kind: "openclaw.source-delivery-obligation",
      deliveryStatus: "accepted",
      sourceTurnState: "accepted",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 0,
    });
    expect(await loadSourceTurnDeliveryRegistry(registryPath)).toEqual({ rows: [row] });
  });

  it("persists progress-delivered state without marking final delivered", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:progress",
      facts: { evidenceKinds: ["source_chat_progress"] },
    });

    expect(row).toMatchObject({
      deliveryStatus: "progress_delivered",
      sourceTurnState: "progress_delivered",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 1,
    });
    expect(sourceTurnDeliveryBlocksWatchdog(row)).toBe(true);
  });

  it("refuses final-delivered state without visible proof and never stores false delivered", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:false-final",
      facts: {
        finalDeliveryDelivered: true,
        evidenceKinds: ["ledger_write", "registry_entry"],
      },
    });

    expect(row).toMatchObject({
      deliveryStatus: "blocked",
      sourceTurnState: "blocked_refused",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 0,
      failureReason: "false_final_delivery_delivered_refused",
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(row)).toBe("blocking_refused");
  });

  it("does not treat report artifacts or registry entries as final delivery", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:artifact-only",
      facts: {
        finalDeliveryRequired: true,
        evidenceKinds: ["report_artifact", "registry_entry"],
        reportRequired: true,
        reportArtifactPath:
          "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/report.md",
      },
      reportArtifactPaths: [
        "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/report.md",
      ],
    });

    expect(row).toMatchObject({
      deliveryStatus: "blocked",
      sourceTurnState: "blocked_refused",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 0,
    });
    expect(row.reportArtifactPaths).toEqual([
      "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/report.md",
    ]);
  });

  it("does not treat private-only final responses as final delivery", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:private-only",
      facts: { privateOnlyFinalResponse: true, finalDeliveryRequired: true },
    });

    expect(row).toMatchObject({
      deliveryStatus: "blocked",
      sourceTurnState: "blocked_refused",
      finalDeliveryDelivered: false,
      failureReason: "private_final_without_visible_delivery",
    });
  });

  it("preserves failed delivery state as watchdog-blocking", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:failed",
      facts: { deliveryToolFailed: true, finalDeliveryRequired: true },
    });

    expect(row).toMatchObject({
      deliveryStatus: "delivery_failed",
      sourceTurnState: "final_delivery_failed",
      finalDeliveryDelivered: false,
      failureReason: "delivery_tool_failed",
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(row)).toBe("blocking_failed");
    expect(sourceTurnDeliveryBlocksWatchdog(row)).toBe(true);
  });

  it("preserves blocked/refused state as watchdog-blocking", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:blocked",
      facts: { finalDeliveryRequired: true },
    });

    expect(row).toMatchObject({
      deliveryStatus: "blocked",
      sourceTurnState: "blocked_refused",
      finalDeliveryDelivered: false,
      failureReason: "missing_visible_final_delivery_proof",
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(row)).toBe("blocking_refused");
  });

  it("keeps settled historical debt distinct from delivered final and non-blocking", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:settled",
      facts: { historicalSettlement: true, evidenceKinds: ["settled_resolved_later"] },
    });

    expect(row).toMatchObject({
      deliveryStatus: "final_pending",
      sourceTurnState: "settled_resolved_later",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 0,
      watchdogReconciliation: {
        status: "settled_resolved_later",
        action: "settle-source-resolved-later",
        originalFinalDeliveryDelivered: false,
        originalVisibleDeliveryCount: 0,
      },
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(row)).toBe("non_blocking_settled");
    expect(sourceTurnDeliveryBlocksWatchdog(row)).toBe(false);
  });

  it("treats valid visible final delivery as delivered and non-blocking", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:delivered",
      facts: {
        finalDeliveryDelivered: true,
        evidenceKinds: ["source_chat_final"],
      },
    });

    expect(row).toMatchObject({
      deliveryStatus: "final_delivered",
      sourceTurnState: "final_delivered",
      finalDeliveryDelivered: true,
      visibleDeliveryCount: 1,
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(row)).toBe("non_blocking_delivered");
  });

  it("writes rows without mutating unrelated rows", async () => {
    const first = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:first",
      facts: {},
    });
    const second = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:second",
      facts: { deliveryToolFailed: true },
    });

    expect((await rawRows()).rows).toHaveLength(2);
    expect(await loadSourceTurnDeliveryRegistry(registryPath)).toEqual({ rows: [first, second] });
  });
});
