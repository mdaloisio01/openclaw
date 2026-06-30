import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import { isSilentReplyText } from "../tokens.js";
import type { ReplyPayload } from "../types.js";

const privateFinalReplyLogger = createSubsystemLogger("source-reply/private-final");

/**
 * `message_tool_only` requires visible replies to be sent through the message
 * tool. Any non-silent private final text means the model attempted a terminal
 * answer without satisfying that contract, so emit the safe visible fallback.
 */
export function shouldWarnAboutPrivateMessageToolFinal(params: {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  sendPolicyDenied: boolean;
  successfulSourceReplyDelivery: boolean;
  finalText: string;
}): boolean {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return false;
  }
  // A send-policy denial is an intentional block, and a successful source-reply
  // delivery means the contract was honored. Other side effects do not count.
  if (params.sendPolicyDenied || params.successfulSourceReplyDelivery) {
    return false;
  }
  const trimmed = params.finalText.trim();
  if (!trimmed || isSilentReplyText(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Emit metadata-only operator signal. The body is intentionally omitted:
 * `message_tool_only` keeps normal final text private by design.
 */
export function warnPrivateMessageToolFinal(params: {
  sessionKey: string | undefined;
  channel: string | undefined;
  finalTextLength: number;
}): void {
  privateFinalReplyLogger.warn(
    "agent produced a private final reply without calling the configured delivery tool (message_tool_only); private body withheld and delivery-contract error payload emitted",
    {
      sessionKey: params.sessionKey,
      channel: params.channel,
      chars: params.finalTextLength,
    },
  );
}

export function buildPrivateMessageToolFinalDeliveryError(): ReplyPayload {
  return markReplyPayloadForSourceSuppressionDelivery({
    text: "Delivery failed: the agent produced a private final reply but did not use the required source delivery tool. The private reply body was withheld. This turn requires recovery.",
    isError: true,
    isStatusNotice: true,
  });
}
