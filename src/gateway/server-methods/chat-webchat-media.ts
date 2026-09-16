import path from "node:path";
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { isAudioFileName } from "@openclaw/media-core/mime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { openLocalFileSafely } from "../../infra/fs-safe.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../../infra/local-file-access.js";
import {
  createOutboundPayloadPlan,
  normalizeReplyPayloadsForDelivery,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { assertLocalMediaAllowed, LocalMediaAccessError } from "../../media/local-media-access.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";
import { sanitizeReplyDirectiveId } from "../../utils/directive-tags.js";
import { stripInlineDirectiveTagsForDisplay } from "../../utils/directive-tags.js";
import { stripEnvelopeFromMessage } from "../chat-sanitize.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import {
  createManagedOutgoingImageBlocks,
  createManagedOutgoingAttachmentBlocks,
  MAX_WEBCHAT_AUDIO_BYTES,
} from "../managed-image-attachments.js";

const MAX_WEBCHAT_IMAGE_DATA_URL_CHARS = 2_000_000;
const MAX_WEBCHAT_IMAGE_DATA_BYTES = 1_500_000;
const ALLOWED_WEBCHAT_DATA_IMAGE_MEDIA_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

type WebchatAudioEmbeddingOptions = {
  localRoots?: readonly string[];
  onLocalAudioAccessDenied?: (err: LocalMediaAccessError) => void;
};

type WebchatAssistantMediaOptions = WebchatAudioEmbeddingOptions;

type LocalAudioContentBlock = {
  path: string;
  block: Record<string, unknown>;
};

type ReplyMediaAudioEmbedding = {
  url: string;
  audioBlock?: Record<string, unknown>;
};

/** Map `mediaUrl` strings to an absolute filesystem path for local embedding (plain paths or `file:` URLs). */
function resolveLocalMediaPathForEmbedding(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (/^data:/i.test(trimmed)) {
    return null;
  }
  if (/^https?:/i.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("file:")) {
    try {
      const p = safeFileURLToPath(trimmed);
      if (!path.isAbsolute(p)) {
        return null;
      }
      return p;
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(trimmed)) {
    return null;
  }
  try {
    assertNoWindowsNetworkPath(trimmed, "Local media path");
  } catch {
    return null;
  }
  return trimmed;
}

async function readLocalAudioContentBlockForEmbedding(
  payload: ReplyPayload,
  raw: string,
  options: WebchatAudioEmbeddingOptions | undefined,
): Promise<LocalAudioContentBlock | null> {
  if (payload.trustedLocalMedia !== true) {
    // WebChat may embed local audio only after an upstream path normalizer grants trust.
    return null;
  }
  const resolved = resolveLocalMediaPathForEmbedding(raw);
  if (!resolved) {
    return null;
  }
  if (!isAudioFileName(resolved)) {
    return null;
  }
  let opened: Awaited<ReturnType<typeof openLocalFileSafely>> | undefined;
  try {
    await assertLocalMediaAllowed(resolved, options?.localRoots);
    opened = await openLocalFileSafely({ filePath: resolved });
    await assertLocalMediaAllowed(opened.realPath, options?.localRoots);
    if (opened.stat.size > MAX_WEBCHAT_AUDIO_BYTES) {
      return null;
    }
    return {
      path: opened.realPath,
      block: {
        type: "attachment",
        attachment: {
          url: opened.realPath,
          kind: "audio",
          label: path.basename(opened.realPath),
          mimeType: mimeTypeForPath(opened.realPath),
          ...(payload.audioAsVoice === true ? { isVoiceNote: true } : {}),
        },
      },
    };
  } catch (err) {
    if (err instanceof LocalMediaAccessError) {
      options?.onLocalAudioAccessDenied?.(err);
    }
    return null;
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

async function resolveReplyMediaAudioEmbedding(
  payload: ReplyPayload,
  raw: string,
  seenAudio: Set<string>,
  options: WebchatAudioEmbeddingOptions | undefined,
): Promise<ReplyMediaAudioEmbedding | null> {
  const url = raw.trim();
  if (!url) {
    return null;
  }
  const audio = await readLocalAudioContentBlockForEmbedding(payload, url, options);
  if (!audio || seenAudio.has(audio.path)) {
    return { url };
  }
  seenAudio.add(audio.path);
  return { url, audioBlock: audio.block };
}

function mimeTypeForPath(filePath: string): string {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  return MIME_BY_EXT[ext] ?? "audio/mpeg";
}

function isBase64DataPayload(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isBase64Char =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f ||
      code === 0x3d;
    const isWhitespace =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0b ||
      code === 0x0c ||
      code === 0x0d ||
      code === 0x20;
    if (!isBase64Char && !isWhitespace) {
      return false;
    }
  }
  return true;
}

function resolveEmbeddableImageUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_WEBCHAT_IMAGE_DATA_URL_CHARS) {
    return null;
  }
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const metadata = trimmed.slice(0, commaIndex);
  const match = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(metadata);
  const base64Data = trimmed.slice(commaIndex + 1);
  if (!match || !isBase64DataPayload(base64Data)) {
    return null;
  }
  const mediaType = normalizeLowercaseStringOrEmpty(match[1]);
  if (!ALLOWED_WEBCHAT_DATA_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return null;
  }
  // Size-check the decoded image, not just the data URL string length.
  if (estimateBase64DecodedBytes(base64Data) > MAX_WEBCHAT_IMAGE_DATA_BYTES) {
    return null;
  }
  return trimmed;
}

function resolveReplyDirectivePrefix(payload: ReplyPayload): string {
  const replyToId = sanitizeReplyDirectiveId(payload.replyToId);
  if (replyToId) {
    return `[[reply_to:${replyToId}]]`;
  }
  if (payload.replyToCurrent) {
    return "[[reply_to_current]]";
  }
  return "";
}

/**
 * Build Control UI / transcript `content` blocks for local TTS (or other) audio files
 * referenced by slash-command / agent replies when the webchat path only had text aggregation.
 */
export async function buildWebchatAudioContentBlocksFromReplyPayloads(
  payloads: ReplyPayload[],
  options?: WebchatAudioEmbeddingOptions,
): Promise<Array<Record<string, unknown>>> {
  const seen = new Set<string>();
  const blocks: Array<Record<string, unknown>> = [];
  for (const payload of payloads) {
    if (payload.isReasoning === true) {
      continue;
    }
    const parts = resolveSendableOutboundReplyParts(payload);
    for (const raw of parts.mediaUrls) {
      const media = await resolveReplyMediaAudioEmbedding(payload, raw, seen, options);
      if (!media?.audioBlock) {
        continue;
      }
      blocks.push(media.audioBlock);
    }
  }
  return blocks;
}

export async function buildWebchatAssistantMessageFromReplyPayloads(
  payloads: ReplyPayload[],
  options?: WebchatAssistantMediaOptions,
): Promise<{ content: Array<Record<string, unknown>>; transcriptText: string } | null> {
  const content: Array<Record<string, unknown>> = [];
  const transcriptTextParts: string[] = [];
  const seenAudio = new Set<string>();
  const seenImages = new Set<string>();
  let hasAudio = false;
  let hasImage = false;

  for (const payload of payloads) {
    if (payload.isReasoning === true) {
      continue;
    }
    const visibleText = payload.text?.trim();
    const text =
      visibleText && !isSuppressedControlReplyText(visibleText) ? visibleText : undefined;
    const replyDirectivePrefix = resolveReplyDirectivePrefix(payload);
    let payloadHasAudio = false;
    let payloadHasImage = false;
    const payloadMediaBlocks: Array<Record<string, unknown>> = [];
    const parts = resolveSendableOutboundReplyParts(payload);
    for (const raw of parts.mediaUrls) {
      const media = await resolveReplyMediaAudioEmbedding(payload, raw, seenAudio, options);
      if (!media) {
        continue;
      }
      if (media.audioBlock) {
        payloadMediaBlocks.push(media.audioBlock);
        hasAudio = true;
        payloadHasAudio = true;
        continue;
      }
      const imageUrl = resolveEmbeddableImageUrl(media.url);
      if (!imageUrl || seenImages.has(imageUrl)) {
        continue;
      }
      seenImages.add(imageUrl);
      payloadMediaBlocks.push({ type: "input_image", image_url: imageUrl });
      hasImage = true;
      payloadHasImage = true;
    }
    const needsSyntheticText =
      payloadMediaBlocks.length > 0 &&
      (!text || replyDirectivePrefix) &&
      transcriptTextParts.length === 0;
    // Media-only replies need stable transcript text so later context is readable.
    const syntheticText = needsSyntheticText
      ? payloadHasAudio && payloadHasImage
        ? "Media reply"
        : payloadHasAudio
          ? "Audio reply"
          : "Image reply"
      : undefined;
    const blockText = text ?? syntheticText;
    if (blockText) {
      const fullText = replyDirectivePrefix ? `${replyDirectivePrefix}${blockText}` : blockText;
      transcriptTextParts.push(fullText);
      content.push({ type: "text", text: fullText });
    } else if (replyDirectivePrefix) {
      transcriptTextParts.push(replyDirectivePrefix);
      content.push({ type: "text", text: replyDirectivePrefix });
    }
    content.push(...payloadMediaBlocks);
  }

  if (!hasAudio && !hasImage) {
    return null;
  }
  const transcriptText =
    transcriptTextParts.join("\n\n").trim() ||
    (hasAudio && hasImage ? "Media reply" : hasAudio ? "Audio reply" : "Image reply");
  if (transcriptTextParts.length === 0) {
    content.unshift({ type: "text", text: transcriptText });
  }
  return { content, transcriptText };
}

type AssistantDisplayContentBlock = Record<string, unknown>;

function sanitizeAssistantDisplayText(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const withoutEnvelope = stripEnvelopeFromMessage(value);
  const normalized = typeof withoutEnvelope === "string" ? withoutEnvelope : value;
  const stripped = stripInlineDirectiveTagsForDisplay(normalized).text.trim();
  return stripped || undefined;
}

export function extractAssistantDisplayTextFromContent(
  content?: readonly AssistantDisplayContentBlock[] | null,
): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const parts = content
    .map((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") {
        return "";
      }
      return block.text.trim();
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export async function buildAssistantDisplayContentFromReplyPayloads(params: {
  sessionKey: string;
  agentId?: string;
  payloads: ReplyPayload[];
  managedImageLocalRoots?: Parameters<typeof createManagedOutgoingImageBlocks>[0]["localRoots"];
  includeSensitiveMedia?: boolean;
  /** Required source publication must retain every admitted attachment. */
  requireCompleteMedia?: boolean;
  attachmentMaxBytes?: number;
  onLocalAudioAccessDenied?: (message: string) => void;
  onManagedImagePrepareError?: (message: string) => void;
}): Promise<AssistantDisplayContentBlock[] | undefined> {
  const rawTextPayloadCount = params.payloads.filter(
    (payload) =>
      payload.isReasoning !== true &&
      typeof payload.text === "string" &&
      payload.text.trim().length > 0,
  ).length;
  const normalized = normalizeReplyPayloadsForDelivery(params.payloads);
  if (normalized.length === 0) {
    return rawTextPayloadCount > 0 ? [{ type: "text", text: "" }] : undefined;
  }

  const content: AssistantDisplayContentBlock[] = [];
  let strippedTextPayloadCount = 0;
  for (const payload of normalized) {
    const text = sanitizeAssistantDisplayText(payload.text);
    if (text) {
      content.push({ type: "text", text });
    } else if (typeof payload.text === "string" && payload.text.trim().length > 0) {
      strippedTextPayloadCount += 1;
    } else {
      const mirrorText = sanitizeAssistantDisplayText(
        projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan([payload])).text,
      );
      if (mirrorText) {
        content.push({ type: "text", text: mirrorText });
      } else if (payload.channelData && Object.keys(payload.channelData).length > 0) {
        // Channel-specific envelopes have no portable WebChat renderer. Keep the
        // exact payload in the prepared owner record and make the durable mirror visible.
        content.push({ type: "text", text: "Channel-specific rich message" });
      }
    }
    if (params.includeSensitiveMedia === false && payload.sensitiveMedia === true) {
      continue;
    }
    if (params.requireCompleteMedia) {
      const parts = resolveSendableOutboundReplyParts(payload);
      if (
        payload.trustedLocalMedia !== true &&
        parts.mediaUrls.some(
          (url) => Boolean(resolveLocalMediaPathForEmbedding(url)) && isAudioFileName(url),
        )
      ) {
        throw new Error("Required WebChat local audio is not trust-scoped");
      }
      content.push(
        ...(await createManagedOutgoingAttachmentBlocks({
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          mediaUrls: parts.mediaUrls,
          localRoots: params.managedImageLocalRoots,
          audioAsVoice: payload.audioAsVoice,
          attachmentMaxBytes: params.attachmentMaxBytes ?? MEDIA_MAX_BYTES,
        })),
      );
      continue;
    }
    const audioBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads([payload], {
      localRoots: Array.isArray(params.managedImageLocalRoots)
        ? params.managedImageLocalRoots
        : undefined,
      onLocalAudioAccessDenied: (err) => {
        params.onLocalAudioAccessDenied?.(formatErrorMessage(err));
      },
    });
    content.push(...audioBlocks);

    const mediaUrls = Array.from(
      new Set([
        ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
        ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
      ]),
    );
    const imageBlocks = await createManagedOutgoingImageBlocks({
      sessionKey: params.sessionKey,
      ...(params.sessionKey === "global" && params.agentId ? { agentId: params.agentId } : {}),
      mediaUrls,
      localRoots: params.managedImageLocalRoots,
      continueOnPrepareError: true,
      onPrepareError: (error) => {
        params.onManagedImagePrepareError?.(error.message);
      },
    });
    if (imageBlocks.length > 0) {
      content.push(...imageBlocks);
    }
  }

  if (content.length > 0) {
    return content;
  }
  return strippedTextPayloadCount > 0 ? [{ type: "text", text: "" }] : undefined;
}

export function replaceAssistantContentTextBlocks(
  content: readonly AssistantDisplayContentBlock[] | undefined,
  transcriptMediaMessage: { content: Array<Record<string, unknown>> } | null,
): AssistantDisplayContentBlock[] | undefined {
  const transcriptTextBlocks = (transcriptMediaMessage?.content ?? []).filter(
    (block): block is AssistantDisplayContentBlock =>
      Boolean(block) &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string",
  );
  if (transcriptTextBlocks.length === 0) {
    return content ? [...content] : undefined;
  }
  if (!content || content.length === 0) {
    return [...transcriptTextBlocks];
  }
  const merged: AssistantDisplayContentBlock[] = [];
  let transcriptTextIndex = 0;
  for (const block of content) {
    if (
      block?.type === "text" &&
      typeof block.text === "string" &&
      transcriptTextIndex < transcriptTextBlocks.length
    ) {
      merged.push(transcriptTextBlocks[transcriptTextIndex++]);
      continue;
    }
    merged.push(block);
  }
  if (transcriptTextIndex < transcriptTextBlocks.length) {
    merged.unshift(...transcriptTextBlocks.slice(transcriptTextIndex));
  }
  return merged;
}
