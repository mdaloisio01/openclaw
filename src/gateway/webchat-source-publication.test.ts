import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSourceTurnDeliveryRegistry,
  persistSourceTurnDeliveryState,
} from "../agents/source-turn-delivery-store.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cleanOldMedia } from "../media/store.js";
import * as managedMedia from "./managed-image-attachments.js";
import { readSessionMessageByIdAsync } from "./session-utils.fs.js";
import {
  prepareWebchatSourceContent,
  publishPreparedWebchatSourceReply,
} from "./webchat-source-publication.js";

const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXcZ0AAAAASUVORK5CYII=",
  "base64",
);
const sessionKey = "agent:main:source-media";
const sessionId = "source-media-session";
let stateDir: string;
let storePath: string;
let registryPath: string;
let config: OpenClawConfig;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-source-media-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  registryPath = path.join(stateDir, "source-delivery.json");
  vi.stubEnv("OPENCLAW_SOURCE_TURN_DELIVERY_REGISTRY_PATH", registryPath);
  storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify({ [sessionKey]: { sessionId, updatedAt: Date.now() } }),
  );
  config = { agents: { defaults: { workspace: stateDir } }, session: { store: storePath } };
  setRuntimeConfigSnapshot(config);
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});

async function prepare(payload: ReplyPayload) {
  const webchatContent = await prepareWebchatSourceContent({
    sessionKey,
    agentId: "main",
    payload,
    config,
  });
  const row = await persistSourceTurnDeliveryState({
    registryPath,
    id: "source-media",
    sourceSessionKey: sessionKey,
    sourceChannel: "webchat",
    deliveryContext: { channel: "webchat", to: sessionKey },
    runId: "actual-source-run",
    facts: { finalDeliveryRequired: true },
    preparedSourceFinal: {
      kind: "source_session_transcript",
      sessionId,
      expectedPartCount: 1,
      parts: [
        {
          text: payload.text ?? "",
          mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
          payload,
          webchatContent,
        },
      ],
    },
  });
  return row.preparedSourceFinal!.parts[0];
}

async function publish(part: Awaited<ReturnType<typeof prepare>>) {
  return publishPreparedWebchatSourceReply({
    sessionKey,
    agentId: "main",
    storePath,
    expectedSessionId: sessionId,
    part,
    config,
  });
}

async function recordFor(part: Awaited<ReturnType<typeof prepare>>) {
  const attachmentId = part.webchatContent!.assets[0].url.split("/").at(-2)!;
  return JSON.parse(
    await fs.readFile(
      path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
      "utf8",
    ),
  ) as {
    messageId: string | null;
    original: { path: string };
    retentionClass: string;
  };
}

describe("required WebChat source publication", () => {
  it.each([
    {
      name: "portable presentation",
      payload: {
        presentation: {
          title: "Approval required",
          blocks: [
            { type: "context" as const, text: "Review the proposed repair." },
            {
              type: "buttons" as const,
              buttons: [{ label: "Approve", value: "approve" }],
            },
          ],
        },
      },
      expectedText: "Approval required\nReview the proposed repair.\nApprove",
    },
    {
      name: "channel-specific envelope",
      payload: { channelData: { line: { flexMessage: { altText: "Status card" } } } },
      expectedText: "Channel-specific rich message",
    },
  ])("retains and visibly mirrors a rich-only $name final", async ({ payload, expectedText }) => {
    const part = await prepare(payload);
    expect(part.payload).toEqual(payload);
    expect(part.webchatContent?.content).toEqual([{ type: "text", text: expectedText }]);

    const result = await publish(part);
    expect(
      await readSessionMessageByIdAsync(sessionId, storePath, result.sessionFile, result.messageId),
    ).toMatchObject({
      found: true,
      message: { content: [{ type: "text", text: expectedText }] },
    });
  });

  it("recovers full caption/image and the original bytes after input expiry and transient cleanup", async () => {
    const input = path.join(stateDir, "report.png");
    await fs.writeFile(input, imageBytes);
    const part = await prepare({ text: "The complete report with evidence.", mediaUrl: input });
    await fs.rm(input);
    await cleanOldMedia(0, { recursive: true, pruneEmptyDirs: true });
    await managedMedia.cleanupManagedOutgoingImageRecords({
      stateDir,
      nowMs: Date.now() + 16 * 60_000,
    });
    const saved = (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0];
    expect(saved.finalDeliveryDelivered).toBe(false);
    expect(saved.preparedSourceFinal!.parts[0]).toEqual(part);
    const result = await publish(saved.preparedSourceFinal!.parts[0]);
    const readback = await readSessionMessageByIdAsync(
      sessionId,
      storePath,
      result.sessionFile,
      result.messageId,
    );
    expect(readback).toMatchObject({
      found: true,
      message: { content: part.webchatContent!.content, idempotencyKey: part.idempotencyKey },
    });
    expect(part.webchatContent!.content[0]).toEqual({
      type: "text",
      text: "The complete report with evidence.",
    });
    const record = await recordFor(part);
    expect(record.messageId).toBe(result.messageId);
    expect(record.retentionClass).toBe("history");
    expect(await fs.readFile(record.original.path)).toEqual(imageBytes);
    expect(part.webchatContent!.assets[0].sha256).toBe(
      createHash("sha256").update(imageBytes).digest("hex"),
    );
    const repeated = await publish(part);
    expect(repeated.messageId).toBe(result.messageId);
    const transcript = await fs.readFile(result.sessionFile, "utf8");
    expect(
      transcript.split("\n").filter((line) => line.includes(part.idempotencyKey)),
    ).toHaveLength(1);
  });

  it("resumes binding after append succeeds but attachment binding is interrupted", async () => {
    const part = await prepare({
      text: "Keep this caption.",
      mediaUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
    });
    const attach = vi
      .spyOn(managedMedia, "attachManagedOutgoingImagesToMessage")
      .mockRejectedValueOnce(new Error("interrupted after append"));
    await expect(publish(part)).rejects.toThrow("interrupted after append");
    expect(
      (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0].finalDeliveryDelivered,
    ).toBe(false);
    expect((await recordFor(part)).messageId).toBeNull();
    await managedMedia.cleanupManagedOutgoingImageRecords({
      stateDir,
      nowMs: Date.now() + 16 * 60_000,
    });
    attach.mockRestore();
    const result = await publish(
      (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0].preparedSourceFinal!.parts[0],
    );
    expect((await recordFor(part)).messageId).toBe(result.messageId);
    expect(
      (await fs.readFile(result.sessionFile, "utf8"))
        .split("\n")
        .filter((line) => line.includes(part.idempotencyKey)),
    ).toHaveLength(1);
  });

  it.each([
    {
      name: "voice audio",
      filename: "voice.mp3",
      bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      kind: "audio",
      voice: true,
    },
    {
      name: "document",
      filename: "report.pdf",
      bytes: Buffer.from("%PDF-1.7\nA small report.\n"),
      kind: "document",
      voice: false,
    },
  ])(
    "retains the $name attachment and caption through the existing local-media ticket path",
    async ({ filename, bytes, kind, voice }) => {
      const input = path.join(stateDir, filename);
      await fs.writeFile(input, bytes);
      const part = await prepare({
        text: "The complete result.",
        mediaUrl: input,
        trustedLocalMedia: true,
        audioAsVoice: voice,
      });
      await fs.rm(input);
      await cleanOldMedia(0, { recursive: true });
      const result = await publish(part);
      const record = await recordFor(part);
      expect(part.webchatContent!.content).toContainEqual({
        type: "attachment",
        attachment: {
          url: record.original.path,
          managedMediaUrl: part.webchatContent!.assets[0].url,
          kind,
          label: expect.any(String),
          mimeType: expect.any(String),
          ...(voice ? { isVoiceNote: true } : {}),
        },
      });
      expect(
        await readSessionMessageByIdAsync(
          sessionId,
          storePath,
          result.sessionFile,
          result.messageId,
        ),
      ).toMatchObject({ found: true, message: { content: part.webchatContent!.content } });
      expect(await fs.readFile(record.original.path)).toEqual(bytes);
    },
  );

  it("refuses changed backing bytes and a conflicting existing canonical part", async () => {
    const part = await prepare({
      text: "Original report.",
      mediaUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
    });
    const record = await recordFor(part);
    await fs.writeFile(record.original.path, "different bytes");
    await expect(publish(part)).rejects.toThrow("bytes changed");
    await fs.writeFile(record.original.path, imageBytes);
    await publish(part);
    const changed = structuredClone(part);
    changed.webchatContent!.content[0] = { type: "text", text: "A different report." };
    await expect(publish(changed)).rejects.toThrow("content readback");
    expect(
      (await loadSourceTurnDeliveryRegistry(registryPath)).rows[0].finalDeliveryDelivered,
    ).toBe(false);
  });

  it.each([
    { filename: "voice.mp3", size: 15 * 1024 * 1024, kind: "audio", accepted: true },
    { filename: "voice.mp3", size: 15 * 1024 * 1024 + 1, kind: "audio", accepted: false },
    { filename: "report.pdf", size: 13 * 1024 * 1024, kind: "document", accepted: true },
  ])(
    "preserves the audio/configured attachment limit ($filename, $size bytes)",
    async ({ filename, size, kind, accepted }) => {
      config = {
        ...config,
        agents: { defaults: { workspace: stateDir, mediaMaxMb: 16 } },
      };
      setRuntimeConfigSnapshot(config);
      const input = path.join(stateDir, filename);
      const bytes = Buffer.alloc(size);
      (kind === "audio" ? Buffer.from([0xff, 0xfb, 0x90, 0x00]) : Buffer.from("%PDF-1.7\n")).copy(
        bytes,
      );
      await fs.writeFile(input, bytes);
      const pending = prepare({
        text: "The complete result.",
        mediaUrl: input,
        trustedLocalMedia: true,
      });
      if (!accepted) {
        await expect(pending).rejects.toThrow();
        expect((await loadSourceTurnDeliveryRegistry(registryPath)).rows).toEqual([]);
        return;
      }
      const part = await pending;
      expect(part.webchatContent!.content).toContainEqual({
        type: "attachment",
        attachment: expect.objectContaining({ kind }),
      });
      await fs.rm(input);
      await publish(part);
      const retainedBytes = await fs.readFile((await recordFor(part)).original.path);
      expect(retainedBytes.byteLength).toBe(bytes.byteLength);
      expect(createHash("sha256").update(retainedBytes).digest("hex")).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    },
  );

  it("does not persist sensitive media or silently admit untrusted local audio", async () => {
    const privatePayload = {
      text: "Private one-time image.",
      sensitiveMedia: true,
      mediaUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
    };
    await expect(
      prepareWebchatSourceContent({ sessionKey, agentId: "main", payload: privatePayload, config }),
    ).rejects.toThrow("live-only delivery owner");
    await expect(fs.stat(path.join(stateDir, "media", "outgoing"))).rejects.toThrow();
    const input = path.join(stateDir, "untrusted.mp3");
    await fs.writeFile(input, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    await expect(
      prepareWebchatSourceContent({
        sessionKey,
        agentId: "main",
        payload: { text: "Audio", mediaUrl: input },
        config,
      }),
    ).rejects.toThrow("not trust-scoped");
  });

  it("preserves the separate external filename-only mirror contract", async () => {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      agentId: "main",
      storePath,
      text: "External caption",
      mediaUrls: ["https://example.com/report.png"],
      config,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const message = await readSessionMessageByIdAsync(
      sessionId,
      storePath,
      result.sessionFile,
      result.messageId,
    );
    expect(message).toMatchObject({
      found: true,
      message: { content: [{ type: "text", text: "report.png" }] },
    });
  });
});
