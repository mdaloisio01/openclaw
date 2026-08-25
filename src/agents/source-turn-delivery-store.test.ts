import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSourceTurnDeliveryObligationKey,
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
      obligationStage: "owed",
      obligationIdentity: {},
      idempotencyKey: "source:source:main:accepted",
      sourceTurnState: "accepted",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 0,
    });
    expect(await loadSourceTurnDeliveryRegistry(registryPath)).toEqual({ rows: [row] });
  });

  it("keys governed report delivery obligations by mission, run, report, delivery, and generation", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:issue-040",
      sourceTurnId: "source-turn-040",
      missionId: "cleanupcrew-issue-list-repair",
      runId: "run-1",
      reportId: "final-closeout",
      deliveryId: "webchat-final",
      generation: 3,
      facts: {
        finalDeliveryRequired: true,
        reportRequired: true,
        reportArtifactPath: "/tmp/issue-040-closeout.md",
        evidenceKinds: ["report_artifact"],
      },
      reportArtifactPaths: ["/tmp/issue-040-closeout.md"],
    });

    expect(row).toMatchObject({
      obligationStage: "needs_review",
      obligationIdentity: {
        missionId: "cleanupcrew-issue-list-repair",
        runId: "run-1",
        reportId: "final-closeout",
        deliveryId: "webchat-final",
        generation: "3",
      },
      idempotencyKey:
        "source:source-turn-040|mission:cleanupcrew-issue-list-repair|run:run-1|report:final-closeout|delivery:webchat-final|generation:3",
      deliveryStatus: "blocked",
      finalDeliveryDelivered: false,
    });
    expect(sourceTurnDeliveryBlocksWatchdog(row)).toBe(true);
  });

  it("builds stable idempotency keys without empty identity parts", () => {
    expect(
      buildSourceTurnDeliveryObligationKey({
        sourceTurnId: "source-turn-1",
        missionId: "mission-1",
        runId: "",
        reportId: "report-1",
        deliveryId: undefined,
        generation: 2,
      }),
    ).toBe("source:source-turn-1|mission:mission-1|report:report-1|generation:2");
  });

  it("persists progress-delivered state without marking final delivered", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:progress",
      facts: { evidenceKinds: ["source_chat_progress"] },
    });

    expect(row).toMatchObject({
      deliveryStatus: "progress_delivered",
      obligationStage: "delivery_attempted",
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
      obligationStage: "needs_review",
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
      obligationStage: "needs_review",
      sourceTurnState: "blocked_refused",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 0,
    });
    expect(row.reportArtifactPaths).toEqual([
      "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/report.md",
    ]);
  });

  it("keeps report-prepared obligations non-delivered until visible final proof arrives", async () => {
    const prepared = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:prepared",
      sourceTurnId: "source-turn-prepared",
      missionId: "mission",
      runId: "run",
      reportId: "report",
      deliveryId: "webchat",
      generation: 1,
      facts: {},
      reportPrepared: true,
      reportArtifactPaths: ["/tmp/report.md"],
    });

    expect(prepared).toMatchObject({
      obligationStage: "prepared",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 0,
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(prepared)).toBe("blocking_pending");

    const delivered = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:prepared",
      sourceTurnId: "source-turn-prepared",
      facts: {
        finalDeliveryRequired: true,
        finalDeliveryDelivered: true,
        evidenceKinds: ["source_chat_final"],
      },
    });

    expect(delivered).toMatchObject({
      obligationStage: "delivered",
      obligationIdentity: {
        missionId: "mission",
        runId: "run",
        reportId: "report",
        deliveryId: "webchat",
        generation: "1",
      },
      idempotencyKey:
        "source:source-turn-prepared|mission:mission|run:run|report:report|delivery:webchat|generation:1",
      finalDeliveryDelivered: true,
      visibleDeliveryCount: 1,
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(delivered)).toBe("non_blocking_delivered");
  });

  it("does not let mismatched delivery identity settle or overwrite an earlier pending obligation", async () => {
    const pending = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:retry",
      sourceTurnId: "source-turn-retry",
      missionId: "mission",
      runId: "run-1",
      reportId: "final-report",
      deliveryId: "webchat",
      generation: 1,
      facts: {
        finalDeliveryRequired: true,
        reportRequired: true,
        reportArtifactPath: "/tmp/final-report-v1.md",
        evidenceKinds: ["report_artifact"],
      },
      reportPrepared: true,
      reportArtifactPaths: ["/tmp/final-report-v1.md"],
    });

    const mismatchedDelivery = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:retry",
      sourceTurnId: "source-turn-retry",
      missionId: "mission",
      runId: "run-1",
      reportId: "final-report",
      deliveryId: "webchat",
      generation: 2,
      facts: {
        finalDeliveryRequired: true,
        finalDeliveryDelivered: true,
        evidenceKinds: ["source_chat_final"],
      },
    });

    const registry = await loadSourceTurnDeliveryRegistry(registryPath);

    expect(registry.rows).toHaveLength(2);
    expect(registry.rows[0]).toMatchObject({
      id: pending.id,
      obligationStage: "needs_review",
      idempotencyKey:
        "source:source-turn-retry|mission:mission|run:run-1|report:final-report|delivery:webchat|generation:1",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 0,
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(registry.rows[0]!)).toBe("blocking_refused");
    expect(registry.rows[1]).toMatchObject({
      id: mismatchedDelivery.id,
      obligationStage: "delivered",
      idempotencyKey:
        "source:source-turn-retry|mission:mission|run:run-1|report:final-report|delivery:webchat|generation:2",
      finalDeliveryDelivered: true,
      visibleDeliveryCount: 1,
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(registry.rows[1]!)).toBe(
      "non_blocking_delivered",
    );
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
      obligationStage: "failed",
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
      obligationStage: "needs_review",
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
      obligationStage: "settled_by_verified_later_delivery",
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
      obligationStage: "delivered",
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
