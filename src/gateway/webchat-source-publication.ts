import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { streamSessionTranscriptLinesReverse } from "../config/sessions/transcript-stream.js";
import {
  appendExactAssistantMessageToSessionTranscript,
  type CanonicalAssistantTranscript,
  type PreparedWebchatSourceContent,
  type SessionTranscriptAssistantMessage,
} from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredMediaMaxBytes } from "../media/configured-max-bytes.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import { resolveSendableOutboundReplyParts } from "../plugin-sdk/reply-payload.js";
import {
  attachManagedOutgoingImagesToMessage,
  readManagedOutgoingAttachmentProof,
} from "./managed-image-attachments.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./server-methods/chat-reply-media.js";
import { buildAssistantDisplayContentFromReplyPayloads } from "./server-methods/chat-webchat-media.js";

const contentBlock = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("image"),
    url: z.string(),
    openUrl: z.string(),
    alt: z.string(),
    mimeType: z.string(),
    width: z.number().nullable(),
    height: z.number().nullable(),
  }),
  z.strictObject({
    type: z.literal("attachment"),
    attachment: z.strictObject({
      url: z.string(),
      managedMediaUrl: z.string(),
      kind: z.enum(["audio", "video", "document"]),
      label: z.string(),
      mimeType: z.string(),
      isVoiceNote: z.boolean().optional(),
    }),
  }),
]);

function assistantMessage(
  content: PreparedWebchatSourceContent["content"],
): SessionTranscriptAssistantMessage {
  return {
    role: "assistant",
    content,
    provider: "openclaw",
    model: "delivery-mirror",
    api: "openai-responses",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as SessionTranscriptAssistantMessage;
}

/** Freeze actual media bytes and complete post-policy content before the first append. */
export async function prepareWebchatSourceContent(params: {
  sessionKey: string;
  agentId: string;
  payload: ReplyPayload;
  config: OpenClawConfig;
}): Promise<PreparedWebchatSourceContent> {
  const originalMedia = resolveSendableOutboundReplyParts(params.payload).mediaUrls;
  // Sensitive media is explicitly live-only. This durable sink cannot acknowledge
  // it by persisting secret refs or by quietly replacing it with caption text.
  if (originalMedia.length > 0 && params.payload.sensitiveMedia) {
    throw new Error("Required WebChat sensitive media needs its live-only delivery owner");
  }
  const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
    cfg: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    payloads: [params.payload],
  });
  if (!payload) {
    throw new Error("Required WebChat payload was removed during media preparation");
  }
  const media = resolveSendableOutboundReplyParts(payload).mediaUrls;
  if (media.length !== originalMedia.length) {
    throw new Error("Required WebChat attachment was removed during media preparation");
  }
  const content = z
    .array(contentBlock)
    .min(1)
    .parse(
      await buildAssistantDisplayContentFromReplyPayloads({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        payloads: [payload],
        managedImageLocalRoots: getAgentScopedMediaLocalRoots(params.config, params.agentId),
        includeSensitiveMedia: false,
        requireCompleteMedia: true,
        attachmentMaxBytes: resolveConfiguredMediaMaxBytes(params.config),
      }),
    );
  const assets = await readManagedOutgoingAttachmentProof({
    sessionKey: params.sessionKey,
    blocks: content,
  });
  if (assets.length !== media.length) {
    throw new Error("Required WebChat attachment is missing from prepared content");
  }
  const redacted = redactTranscriptMessage(
    assistantMessage(content),
    params.config,
  ) as SessionTranscriptAssistantMessage;
  return { content: z.array(contentBlock).min(1).parse(redacted.content), assets };
}

/** Publish or recover one immutable part, including a crash between append and binding. */
export async function publishPreparedWebchatSourceReply(params: {
  sessionKey: string;
  agentId: string;
  storePath?: string;
  expectedSessionId: string;
  part: {
    text: string;
    mediaUrls?: string[];
    idempotencyKey: string;
    canonicalAssistantTranscript?: CanonicalAssistantTranscript;
    webchatContent?: PreparedWebchatSourceContent;
  };
  config: OpenClawConfig;
}): Promise<{ sessionFile: string; messageId: string }> {
  const part = params.part;
  if (part.mediaUrls?.length && !part.webchatContent) {
    throw new Error("Required WebChat media has no complete durable preparation");
  }
  const content = part.webchatContent?.content ?? [{ type: "text" as const, text: part.text }];
  const canonicalAssistantTranscript = part.canonicalAssistantTranscript;
  if (
    canonicalAssistantTranscript &&
    (part.webchatContent?.assets.length || part.mediaUrls?.length)
  ) {
    throw new Error("A native text reference cannot acknowledge a media final");
  }
  const expectedMessage = redactTranscriptMessage(
    assistantMessage(content),
    params.config,
  ) as SessionTranscriptAssistantMessage;
  if (part.webchatContent) {
    const assets = await readManagedOutgoingAttachmentProof({
      sessionKey: params.sessionKey,
      blocks: content,
    });
    if (!isDeepStrictEqual(assets, part.webchatContent.assets)) {
      throw new Error("Prepared WebChat attachment bytes changed before publication");
    }
  }
  const appended = await appendExactAssistantMessageToSessionTranscript({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    storePath: params.storePath,
    expectedSessionId: params.expectedSessionId,
    idempotencyKey: part.idempotencyKey,
    canonicalAssistantTranscript,
    message: expectedMessage,
    config: params.config,
    updateMode: "inline",
  });
  if (!appended.ok) {
    throw new Error(`Required WebChat publication failed: ${appended.reason}`);
  }
  let actual: Record<string, unknown> | undefined;
  for await (const line of streamSessionTranscriptLinesReverse(appended.sessionFile)) {
    const record = JSON.parse(line) as { id?: string; message?: Record<string, unknown> };
    if (record.id === appended.messageId) {
      actual = record.message;
      break;
    }
  }
  if (
    actual?.role !== "assistant" ||
    actual.idempotencyKey !== part.idempotencyKey ||
    !isDeepStrictEqual(actual.content, expectedMessage.content)
  ) {
    throw new Error("Required WebChat source content readback does not match its prepared part");
  }
  if (part.webchatContent) {
    await attachManagedOutgoingImagesToMessage({ messageId: appended.messageId, blocks: content });
    const assets = await readManagedOutgoingAttachmentProof({
      sessionKey: params.sessionKey,
      messageId: appended.messageId,
      blocks: content,
    });
    if (!isDeepStrictEqual(assets, part.webchatContent.assets)) {
      throw new Error("Required WebChat attachment readback does not match its prepared part");
    }
  }
  return { sessionFile: appended.sessionFile, messageId: appended.messageId };
}
