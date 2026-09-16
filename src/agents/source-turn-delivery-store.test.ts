import { spawnSync } from "node:child_process";
import fs, { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSourceTurnDeliveryObligationKey,
  classifySourceTurnDeliveryWatchdogStatus,
  createSourceTurnDeliveryQueueOwnerReference,
  inspectExternalSourceDeliveryQueueOwner,
  loadSourceTurnDeliveryRegistry,
  persistSourceTurnDeliveryState,
  prepareExternalSourceDeliveryQueueOwner,
  recordRecoveredExternalSourceDelivery,
  resolveSourceTurnDeliveryRegistryPath,
  settleSourceTurnDeliveryFinal,
  sourceTurnDeliveryBlocksWatchdog,
  transitionExternalSourceDelivery,
  type PersistSourceTurnDeliveryParams,
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
    vi.unstubAllEnvs();
  });

  it("keeps default registry writes inside the worker-local home", async () => {
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", undefined);
    vi.stubEnv("OPENCLAW_WORKSPACE_ORCHESTRATOR_DIR", undefined);
    const expectedPath = join(
      tempDir,
      ".openclaw",
      "workspace-orchestrator",
      "var",
      "source_delivery_obligations",
      "source_delivery_obligations.json",
    );
    const workerRegistryPath = resolveSourceTurnDeliveryRegistryPath();
    // Check isolation before any write, so a regression cannot touch host state.
    expect(workerRegistryPath).toBe(expectedPath);
    const row = await persistSourceTurnDeliveryState({
      registryPath: workerRegistryPath,
      id: "worker-local-default-registry",
      facts: {},
    });
    expect(await loadSourceTurnDeliveryRegistry(expectedPath)).toEqual({ rows: [row] });
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

  it("persists source route metadata for later watchdog repair", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:agent:orchestrator:main:message-1",
      facts: {},
      sourceSessionKey: "agent:orchestrator:main",
      sourceMessageId: "message-1",
      sourceChannel: "webchat",
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
        threadId: 42,
      },
    });

    expect(row).toMatchObject({
      sourceSessionKey: "agent:orchestrator:main",
      sourceMessageId: "message-1",
      sourceChannel: "webchat",
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
        threadId: "42",
      },
    });
  });

  function preparedFinalParams() {
    return {
      registryPath,
      id: "source-parent-final",
      sourceSessionKey: "agent:main:parent",
      sourceChannel: "webchat",
      deliveryContext: { channel: "webchat", to: "agent:main:parent" },
      runId: "actual-continuation-run",
      parentYieldWaits: [{ parentRunId: "original-parent-run", waitId: "original-wait" }],
      preparedSourceFinal: {
        kind: "source_session_transcript",
        sessionId: "original-session",
        expectedPartCount: 1,
        parts: [
          {
            text: "The original final, after delivery hooks.",
            mediaUrls: ["https://example.com/result.png"],
          },
        ],
      },
      facts: { finalDeliveryRequired: true },
      currentStage: "source_final_prepared",
    } satisfies PersistSourceTurnDeliveryParams;
  }

  it("preserves a prepared final and its exact execution identity through delivery settlement", async () => {
    const params = preparedFinalParams();
    const prepared = await persistSourceTurnDeliveryState(params);
    expect(prepared.finalDeliveryDelivered).toBe(false);
    expect(prepared.preparedSourceFinal).toMatchObject(params.preparedSourceFinal);
    expect(prepared.preparedSourceFinal?.parts[0]?.idempotencyKey).toMatch(
      /^source-session-final:[a-f0-9]{64}$/,
    );
    params.preparedSourceFinal.parts[0].mediaUrls.push("https://example.com/later.png");
    expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows).toEqual([prepared]);

    const delivered = await persistSourceTurnDeliveryState({
      registryPath,
      id: params.id,
      runId: params.runId,
      facts: { finalDeliveryDelivered: true, evidenceKinds: ["source_chat_final"] },
    });
    expect(delivered.preparedSourceFinal).toEqual(prepared.preparedSourceFinal);
    expect(delivered.obligationIdentity.runId).toBe("actual-continuation-run");
    expect(delivered.parentYieldWaits).toEqual(params.parentYieldWaits);
    expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows).toEqual([delivered]);

    const distinctRun = await persistSourceTurnDeliveryState({
      ...preparedFinalParams(),
      runId: "another-actual-run",
    });
    expect(distinctRun.preparedSourceFinal?.parts[0]?.idempotencyKey).not.toBe(
      prepared.preparedSourceFinal?.parts[0]?.idempotencyKey,
    );
    expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows).toHaveLength(2);
  });

  it.each([
    [
      "payload",
      {
        preparedSourceFinal: {
          ...preparedFinalParams().preparedSourceFinal,
          parts: [{ text: "changed" }],
        },
      },
    ],
    [
      "session",
      {
        preparedSourceFinal: {
          ...preparedFinalParams().preparedSourceFinal,
          sessionId: "reset-session",
        },
      },
    ],
    ["controller", { sourceSessionKey: "agent:main:other" }],
    ["route", { deliveryContext: { channel: "webchat", to: "other" } }],
    ["parent wait", { parentYieldWaits: [{ parentRunId: "other-parent", waitId: "other-wait" }] }],
  ] satisfies Array<[string, Partial<PersistSourceTurnDeliveryParams>]>)(
    "refuses to replace a prepared final's %s",
    async (_label, replacement) => {
      const params = preparedFinalParams();
      await persistSourceTurnDeliveryState(params);
      const originalBytes = await readFile(registryPath, "utf8");
      await expect(persistSourceTurnDeliveryState({ ...params, ...replacement })).rejects.toThrow(
        /Prepared source final .* cannot change/,
      );
      expect(await readFile(registryPath, "utf8")).toBe(originalBytes);
    },
  );

  it("keeps failed preparation unpublished so its caller cannot start source delivery", async () => {
    const params = preparedFinalParams();
    const accepted = await persistSourceTurnDeliveryState({
      ...params,
      preparedSourceFinal: undefined,
      facts: {},
    });
    const failure = Object.assign(new Error("prepared final commit failed"), { code: "EIO" });
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(failure);
    try {
      await expect(persistSourceTurnDeliveryState(params)).rejects.toBe(failure);
    } finally {
      rename.mockRestore();
    }
    expect(await loadSourceTurnDeliveryRegistry(registryPath)).toEqual({ rows: [accepted] });
  });

  it("retains multipart preparation by ordinal and refuses partial final delivery", async () => {
    const params = preparedFinalParams();
    params.preparedSourceFinal.expectedPartCount = 2;
    const prefix = await persistSourceTurnDeliveryState(params);
    const deliveredParams: PersistSourceTurnDeliveryParams = {
      registryPath,
      id: params.id,
      runId: params.runId,
      facts: { finalDeliveryDelivered: true, evidenceKinds: ["source_chat_final"] },
    };
    await expect(persistSourceTurnDeliveryState(deliveredParams)).rejects.toThrow(
      "Incomplete prepared source final cannot be delivered",
    );
    expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows).toEqual([prefix]);

    params.preparedSourceFinal.parts.push({
      text: "The second admitted final part.",
      mediaUrls: [],
    });
    const complete = await persistSourceTurnDeliveryState(params);
    expect(complete.preparedSourceFinal?.parts[0]).toEqual(prefix.preparedSourceFinal?.parts[0]);
    expect(complete.preparedSourceFinal?.parts[1]?.idempotencyKey).not.toBe(
      complete.preparedSourceFinal?.parts[0]?.idempotencyKey,
    );
    await expect(
      persistSourceTurnDeliveryState({
        ...params,
        preparedSourceFinal: {
          ...params.preparedSourceFinal,
          parts: params.preparedSourceFinal.parts.slice(0, 1),
        },
      }),
    ).rejects.toThrow("Prepared source final payload cannot change");
    const delivered = await persistSourceTurnDeliveryState(deliveredParams);
    expect(delivered.preparedSourceFinal).toEqual(complete.preparedSourceFinal);
    expect(delivered.finalDeliveryDelivered).toBe(true);
  });

  it("retains the complete external final and accepts only its bound transport receipt", async () => {
    const payloads = [
      { text: "First report part." },
      {
        text: "Second report part.",
        mediaUrls: ["https://example.com/result.png"],
        audioAsVoice: true,
      },
    ];
    const params: PersistSourceTurnDeliveryParams = {
      ...preparedFinalParams(),
      sourceChannel: "telegram",
      deliveryContext: { channel: "telegram", to: "original-conversation", threadId: "42" },
      preparedSourceFinal: {
        kind: "external_channel",
        sessionId: "original-session",
        expectedPartCount: payloads.length,
        parts: payloads.map((payload) => ({
          text: payload.text,
          mediaUrls: payload.mediaUrls,
          payload,
        })),
        outboundDelivery: { status: "prepared" },
      },
    };
    const prepared = await persistSourceTurnDeliveryState(params);
    expect(prepared.preparedSourceFinal).toMatchObject({
      kind: "external_channel",
      parts: payloads.map((payload) => ({ payload })),
      outboundDelivery: { status: "prepared" },
    });
    const update = {
      registryPath,
      id: params.id,
      runId: params.runId,
      facts: { finalDeliveryRequired: true },
    };
    const finalFacts = {
      finalDeliveryRequired: true,
      finalDeliveryDelivered: true,
      evidenceKinds: ["direct_source_final" as const],
    };
    await expect(persistSourceTurnDeliveryState({ ...update, facts: finalFacts })).rejects.toThrow(
      "Incomplete prepared source final cannot be delivered",
    );
    const queued = await persistSourceTurnDeliveryState({
      ...update,
      preparedExternalFinalDelivery: { status: "queued", queueId: "actual-queue-id" },
    });
    await expect(
      persistSourceTurnDeliveryState({
        ...update,
        preparedExternalFinalDelivery: { status: "queued", queueId: "another-queue-id" },
      }),
    ).rejects.toThrow("Prepared external final transport identity cannot change");
    expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows).toEqual([queued]);
    const delivered = await persistSourceTurnDeliveryState({
      ...update,
      facts: finalFacts,
      preparedExternalFinalDelivery: {
        status: "delivered",
        queueId: "actual-queue-id",
        receipt: { platformMessageIds: ["message-1", "message-2"], parts: [], sentAt: Date.now() },
      },
    });
    expect(delivered.preparedSourceFinal?.parts).toEqual(prepared.preparedSourceFinal?.parts);
    expect(delivered.finalDeliveryDelivered).toBe(true);
    expect(delivered.acceptedAt).toBe(prepared.acceptedAt);
    expect(delivered.obligationIdentity).toEqual(prepared.obligationIdentity);
    expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows).toEqual([delivered]);
  });

  it("retains a rich-only external final without requiring a text/media projection", async () => {
    const payload = {
      channelData: { line: { flexMessage: { altText: "Status card", contents: {} } } },
    };
    const prepared = await persistSourceTurnDeliveryState({
      ...preparedFinalParams(),
      sourceChannel: "line",
      deliveryContext: { channel: "line", to: "original-conversation" },
      preparedSourceFinal: {
        kind: "external_channel",
        sessionId: "original-session",
        expectedPartCount: 1,
        parts: [{ text: "", payload }],
        outboundDelivery: { status: "prepared" },
      },
    });

    expect(prepared.preparedSourceFinal).toMatchObject({
      kind: "external_channel",
      parts: [{ text: "", payload }],
      outboundDelivery: { status: "prepared" },
    });
  });

  it("commits a recovered transport receipt only to its exact queued source owner", async () => {
    const payloads = [{ text: "First report part." }, { text: "Second report part." }];
    const params: PersistSourceTurnDeliveryParams = {
      ...preparedFinalParams(),
      sourceChannel: "telegram",
      deliveryContext: { channel: "telegram", to: "original-conversation", threadId: "42" },
      facts: {
        finalDeliveryRequired: true,
        reportRequired: true,
        reportArtifactPath: "/workspace/report.md",
        markFacingExportRequired: true,
        markFacingExportRoot: "/workspace/exports",
        markFacingExportPath: "/workspace/exports/report.md",
        markFacingExportVerified: true,
        trbGateDecisionStatus: "passed",
        trbGateDecisionRecordId: "trb-gate:passed",
        trbRecoveryRecordId: "trb-recovery:complete",
      },
      reportArtifactPaths: ["/workspace/report.md"],
      watchdogReconciliation: {
        status: "retry_scheduled",
        action: "retry-source-delivery",
        reason: "transport interrupted",
        proofPath: "/workspace/recovery.json",
      },
      preparedSourceFinal: {
        kind: "external_channel",
        sessionId: "original-session",
        expectedPartCount: payloads.length,
        parts: payloads.map((payload) => ({ text: payload.text, payload })),
        outboundDelivery: { status: "prepared" },
      },
    };
    const prepared = await persistSourceTurnDeliveryState(params);
    const preservedMetadata = {
      reportArtifactPaths: prepared.reportArtifactPaths,
      markFacingExport: prepared.markFacingExport,
      trbRecovery: prepared.trbRecovery,
      watchdogReconciliation: prepared.watchdogReconciliation,
      deliveryDecision: prepared.deliveryDecision,
      durabilityDecision: prepared.durabilityDecision,
    };
    const identity = {
      queueId: "recovered-queue",
      channel: "telegram",
      to: "original-conversation",
      threadId: "42",
      payloads,
      owner: createSourceTurnDeliveryQueueOwnerReference(prepared),
    };
    await expect(
      transitionExternalSourceDelivery({
        registryPath,
        owner: identity.owner,
        delivery: {
          status: "delivered",
          queueId: identity.queueId,
          receipt: { platformMessageIds: ["message-1"], parts: [], sentAt: 1 },
        },
      }),
    ).rejects.toThrow("must bind its queue owner before receipt commit");
    expect(await inspectExternalSourceDeliveryQueueOwner({ registryPath, identity })).toEqual({
      status: "pending",
      sourceSessionKey: params.sourceSessionKey,
    });
    expect(await prepareExternalSourceDeliveryQueueOwner({ registryPath, identity })).toEqual({
      status: "pending",
      sourceSessionKey: params.sourceSessionKey,
    });
    const queued = (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0];
    expect(queued).toMatchObject({
      preparedSourceFinal: {
        kind: "external_channel",
        outboundDelivery: { status: "queued", queueId: "recovered-queue" },
      },
    });
    expect({
      reportArtifactPaths: queued?.reportArtifactPaths,
      markFacingExport: queued?.markFacingExport,
      trbRecovery: queued?.trbRecovery,
      watchdogReconciliation: queued?.watchdogReconciliation,
      deliveryDecision: queued?.deliveryDecision,
      durabilityDecision: queued?.durabilityDecision,
    }).toEqual(preservedMetadata);
    await expect(
      transitionExternalSourceDelivery({
        registryPath,
        owner: identity.owner,
        delivery: { status: "queued", queueId: "different-queue" },
      }),
    ).rejects.toThrow("transport identity cannot change");
    await expect(
      recordRecoveredExternalSourceDelivery({
        registryPath,
        identity: { ...identity, payloads: [{ text: "different" }] },
        receipt: { platformMessageIds: ["message-1"], parts: [], sentAt: 1 },
      }),
    ).rejects.toThrow("does not match its saved route and payload");

    const receipt = {
      platformMessageIds: ["message-1", "message-2"],
      parts: [],
      sentAt: 1,
    };
    expect(
      await recordRecoveredExternalSourceDelivery({ registryPath, identity, receipt }),
    ).toEqual({ status: "delivered", sourceSessionKey: params.sourceSessionKey });
    expect(await inspectExternalSourceDeliveryQueueOwner({ registryPath, identity })).toEqual({
      status: "delivered",
      sourceSessionKey: params.sourceSessionKey,
    });
    const row = (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0];
    expect(row).toMatchObject({
      finalDeliveryDelivered: false,
      preparedSourceFinal: {
        kind: "external_channel",
        outboundDelivery: { status: "delivered", queueId: "recovered-queue", receipt },
      },
    });
    expect({
      reportArtifactPaths: row?.reportArtifactPaths,
      markFacingExport: row?.markFacingExport,
      trbRecovery: row?.trbRecovery,
      watchdogReconciliation: row?.watchdogReconciliation,
      deliveryDecision: row?.deliveryDecision,
      durabilityDecision: row?.durabilityDecision,
    }).toEqual(preservedMetadata);
    await expect(
      recordRecoveredExternalSourceDelivery({
        registryPath,
        identity,
        receipt: { ...receipt, platformMessageIds: ["conflicting-message"] },
      }),
    ).rejects.toThrow("transport receipt cannot change");

    const settled = await settleSourceTurnDeliveryFinal({
      registryPath,
      owner: identity.owner,
    });
    expect(settled).toMatchObject({
      finalDeliveryDelivered: true,
      obligationStage: "delivered",
      sourceTurnState: "final_delivered",
      currentStage: "final_dispatch_delivered",
      deliveryDecision: { state: "final_delivered" },
      durabilityDecision: { state: "settled", allowedToSettle: true },
    });
    expect({
      reportArtifactPaths: settled.reportArtifactPaths,
      markFacingExport: settled.markFacingExport,
      trbRecovery: settled.trbRecovery,
      watchdogReconciliation: settled.watchdogReconciliation,
    }).toEqual({
      reportArtifactPaths: preservedMetadata.reportArtifactPaths,
      markFacingExport: preservedMetadata.markFacingExport,
      trbRecovery: preservedMetadata.trbRecovery,
      watchdogReconciliation: preservedMetadata.watchdogReconciliation,
    });
  });

  it.each(["sourceSessionKey", "runId"] as const)(
    "refuses prepared delivery without exact %s correlation",
    async (field) => {
      await expect(
        persistSourceTurnDeliveryState({ ...preparedFinalParams(), [field]: " " }),
      ).rejects.toThrow("Prepared source final requires its source session and execution run");
      expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows).toEqual([]);
    },
  );

  it("preserves every obligation when deliveries update the registry concurrently", async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `source:main:concurrent-${index}`);
    const written = await Promise.all(
      ids.map((id) => persistSourceTurnDeliveryState({ registryPath, id, facts: {} })),
    );

    const registry = await loadSourceTurnDeliveryRegistry(registryPath);
    expect(registry.rows.map((row) => row.id).toSorted()).toEqual(ids.toSorted());
    expect(registry.rows).toEqual(expect.arrayContaining(written));
  });

  it.each(["EPERM", "EEXIST"])(
    "preserves the existing registry when rename fails with %s",
    async (code) => {
      const original = await persistSourceTurnDeliveryState({
        registryPath,
        id: "existing-obligation",
        facts: {},
      });
      const originalBytes = await readFile(registryPath, "utf8");
      const failure = Object.assign(new Error("rename denied"), { code });
      const rename = vi.spyOn(fs, "rename").mockRejectedValue(failure);
      try {
        await expect(
          persistSourceTurnDeliveryState({ registryPath, id: "new-obligation", facts: {} }),
        ).rejects.toBe(failure);
      } finally {
        rename.mockRestore();
      }
      expect(await readFile(registryPath, "utf8")).toBe(originalBytes);
      expect(await loadSourceTurnDeliveryRegistry(registryPath)).toEqual({ rows: [original] });
    },
  );

  it("recovers one unchanged abandoned lock before serializing concurrent writers", async () => {
    const owner = spawnSync(process.execPath, ["-e", ""], { timeout: 5_000 });
    expect(owner.status).toBe(0);
    expect(owner.pid).toBeGreaterThan(0);
    const abandonedLock = JSON.stringify({ pid: owner.pid, createdAt: new Date().toISOString() });
    await writeFile(`${registryPath}.lock`, abandonedLock);
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        persistSourceTurnDeliveryState({ registryPath, id: `after-crash-${index}`, facts: {} }),
      ),
    );

    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(true);
    await expect(readFile(`${registryPath}.lock`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows).toHaveLength(8);
  });

  it("recovers an old partial lock left by a crash during lock creation", async () => {
    const lockPath = `${registryPath}.lock`;
    await writeFile(lockPath, "{partial", "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "after-partial-lock-crash",
      facts: {},
    });

    expect(row.id).toBe("after-partial-lock-crash");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32").each([0o700, 0o1777, 0o2770])(
    "preserves directory mode %o during atomic replacement",
    async (mode) => {
      await chmod(tempDir, mode);
      expect((await stat(tempDir)).mode & 0o7777).toBe(mode);
      const backupPath = join(tempDir, "previous-registry.json");
      await writeFile(backupPath, "private delivery history", { mode: 0o664 });
      await persistSourceTurnDeliveryState({ registryPath, id: "private-delivery", facts: {} });
      expect((await stat(tempDir)).mode & 0o7777).toBe(mode);
      expect(await readFile(backupPath, "utf8")).toBe("private delivery history");
    },
  );

  it("waits for a live writer even when its lock timestamp is old", async () => {
    const holder = await acquireFileLock(registryPath, {
      managerKey: "source-delivery-test-holder",
      payload: () => ({ pid: process.pid, createdAt: new Date(0).toISOString() }),
    });
    const update = persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:after-live-writer",
      facts: {},
    }).then(
      (row) => ({ row }),
      (error: unknown) => ({ error }),
    );
    try {
      await setTimeout(25);
      expect(JSON.parse(await readFile(holder.lockPath, "utf8"))).toMatchObject({
        pid: process.pid,
      });
    } finally {
      await holder.release();
    }
    expect(await update).toMatchObject({ row: { id: "source:main:after-live-writer" } });
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
      durabilityDecision: {
        state: "needs_delivery_recovery",
        allowedToSettle: false,
        watchdogVisible: true,
      },
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
      durabilityDecision: {
        state: "settled",
        allowedToSettle: true,
        watchdogVisible: false,
      },
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
      durabilityDecision: {
        state: "needs_delivery_recovery",
        allowedToSettle: false,
      },
    });
    expect(row.reportArtifactPaths).toEqual([
      "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/report.md",
    ]);
  });

  it("persists TRB gate-decision linkage as blocking delivery evidence", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:trb-blocked",
      sourceTurnId: "source-turn-trb",
      missionId: "trb-runtime-gate-repair",
      reportId: "trb-recovery",
      facts: {
        finalDeliveryRequired: true,
        evidenceKinds: ["trb_gate_decision", "trb_recovery_record"],
        trbGateDecisionStatus: "blocked",
        trbGateDecisionRecordId: "trb-gate:msg-1:blocked",
        trbRecoveryRecordId: "trb-recovery-record-1",
      },
    });

    expect(row).toMatchObject({
      deliveryStatus: "blocked",
      obligationStage: "needs_review",
      sourceTurnState: "blocked_refused",
      failureReason: "trb_gate_blocked_recovery_required",
      trbRecovery: {
        gateBlocked: true,
        gateDecisionRecordId: "trb-gate:msg-1:blocked",
        gateDecisionStatus: "blocked",
        recoveryRecordId: "trb-recovery-record-1",
      },
    });
    expect(sourceTurnDeliveryBlocksWatchdog(row)).toBe(true);
  });

  it("keeps Mark-facing export obligations blocked until visible export proof exists", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:mark-export-missing",
      sourceTurnId: "source-turn-mark-export",
      missionId: "mission",
      runId: "run",
      reportId: "report",
      deliveryId: "webchat",
      generation: 1,
      facts: {
        finalDeliveryRequired: true,
        finalDeliveryDelivered: true,
        evidenceKinds: ["source_chat_final", "report_artifact"],
        reportRequired: true,
        reportArtifactPath:
          "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/report.md",
        markFacingExportRequired: true,
        markFacingExportRoot: "/home/will/.openclaw/workspace/file_hub/exports",
        markFacingExportPath: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
      },
      reportPrepared: true,
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
      failureReason: "missing_mark_facing_export_proof",
      markFacingExport: {
        required: true,
        root: "/home/will/.openclaw/workspace/file_hub/exports",
        path: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
        verified: false,
      },
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(row)).toBe("blocking_refused");
  });

  it("keeps failed required delivery blocking until retry or handoff coverage exists", async () => {
    const failed = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:delivery-failed",
      sourceTurnId: "source-turn-delivery-failed",
      missionId: "mission",
      runId: "run",
      reportId: "final",
      deliveryId: "webchat",
      facts: {
        finalDeliveryRequired: true,
        deliveryToolFailed: true,
      },
    });

    expect(failed).toMatchObject({
      obligationStage: "failed",
      deliveryStatus: "delivery_failed",
      durabilityDecision: {
        state: "needs_delivery_recovery",
        allowedToSettle: false,
        requiredActions: [
          "enqueue_delivery_retry",
          "record_delivery_recovery_handoff",
          "record_delivery_exhausted_blocker",
        ],
      },
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(failed)).toBe("blocking_failed");

    const retryCovered = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:delivery-failed",
      sourceTurnId: "source-turn-delivery-failed",
      missionId: "mission",
      runId: "run",
      reportId: "final",
      deliveryId: "webchat",
      facts: {
        finalDeliveryRequired: true,
        deliveryToolFailed: true,
      },
      watchdogReconciliation: {
        status: "retry_scheduled",
        action: "enqueue_delivery_retry",
        proofPath: "/tmp/retry-proof.json",
      },
    });

    expect(retryCovered).toMatchObject({
      durabilityDecision: {
        state: "settled",
        allowedToSettle: true,
      },
    });
  });

  it("acknowledges Mark-facing export delivery with chat and visible export proof", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:mark-export-visible",
      sourceTurnId: "source-turn-mark-export-visible",
      missionId: "mission",
      runId: "run",
      reportId: "report",
      deliveryId: "webchat",
      generation: 1,
      facts: {
        finalDeliveryRequired: true,
        finalDeliveryDelivered: true,
        evidenceKinds: ["source_chat_final", "mark_facing_export_visible"],
        reportRequired: true,
        reportArtifactPath: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
        markFacingExportRequired: true,
        markFacingExportRoot: "/home/will/.openclaw/workspace/file_hub/exports",
        markFacingExportPath: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
      },
      reportPrepared: true,
      reportArtifactPaths: ["/home/will/.openclaw/workspace/file_hub/exports/report.md"],
    });

    expect(row).toMatchObject({
      deliveryStatus: "final_delivered",
      obligationStage: "delivered",
      sourceTurnState: "final_delivered",
      finalDeliveryDelivered: true,
      visibleDeliveryCount: 1,
      markFacingExport: {
        required: true,
        root: "/home/will/.openclaw/workspace/file_hub/exports",
        path: "/home/will/.openclaw/workspace/file_hub/exports/report.md",
        verified: true,
      },
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(row)).toBe("non_blocking_delivered");
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
    expect(classifySourceTurnDeliveryWatchdogStatus(registry.rows[0])).toBe("blocking_refused");
    expect(registry.rows[1]).toMatchObject({
      id: mismatchedDelivery.id,
      obligationStage: "delivered",
      idempotencyKey:
        "source:source-turn-retry|mission:mission|run:run-1|report:final-report|delivery:webchat|generation:2",
      finalDeliveryDelivered: true,
      visibleDeliveryCount: 1,
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(registry.rows[1])).toBe(
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

  it("preserves unknown-after-send delivery as pending settlement review", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:unknown-after-send",
      sourceTurnId: "source-turn-unknown",
      missionId: "mission",
      reportId: "final-closeout",
      deliveryId: "queue-entry-1",
      facts: {
        finalDeliveryRequired: true,
        deliveryOutcomeUnknown: true,
        evidenceKinds: ["delivery_unknown_after_send"],
        reportRequired: true,
        reportArtifactPath: "/tmp/report.md",
      },
      reportPrepared: true,
      deliveryAttempted: true,
      reportArtifactPaths: ["/tmp/report.md"],
    });

    expect(row).toMatchObject({
      deliveryStatus: "delivery_unknown",
      obligationStage: "needs_review",
      sourceTurnState: "final_delivery_unknown",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 0,
      failureReason: "delivery_outcome_unknown_after_send",
      obligationIdentity: {
        missionId: "mission",
        reportId: "final-closeout",
        deliveryId: "queue-entry-1",
      },
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(row)).toBe("blocking_pending");
    expect(sourceTurnDeliveryBlocksWatchdog(row)).toBe(true);
  });

  it("treats a visible source-chat failure notice as non-blocking delivery handling", async () => {
    const row = await persistSourceTurnDeliveryState({
      registryPath,
      id: "source:main:failure-visible",
      facts: {
        finalDeliveryRequired: true,
        failureNoticeVisible: true,
        evidenceKinds: ["source_chat_failure"],
      },
    });

    expect(row).toMatchObject({
      deliveryStatus: "failure_delivered",
      obligationStage: "delivery_attempted",
      sourceTurnState: "failure_delivered",
      finalDeliveryDelivered: false,
      visibleDeliveryCount: 1,
    });
    expect(classifySourceTurnDeliveryWatchdogStatus(row)).toBe("non_blocking_delivered");
    expect(sourceTurnDeliveryBlocksWatchdog(row)).toBe(false);
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
