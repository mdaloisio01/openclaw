import {
  GOVERNED_FINAL_RELEASE_WITHHELD_NOTICE,
  mayReleaseGovernedFinal,
  type GovernedFinalReleaseDecision,
  type GovernedFinalReleaseDecisionInput,
} from "../../governance/governed-final-release-decision.js";
import type { ReplyPayload } from "../reply-payload.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyDispatchBeforeDeliver } from "./reply-dispatcher.types.js";

export type GovernedFinalReleaseDecisionProvider = (
  input: GovernedFinalReleaseDecisionInput,
) => GovernedFinalReleaseDecision | Promise<GovernedFinalReleaseDecision>;

export function buildGovernedWebChatFinalReleaseBeforeDeliver(params: {
  channel?: string;
  decisionProvider?: GovernedFinalReleaseDecisionProvider;
  timeoutMs?: number;
}): ReplyDispatchBeforeDeliver | undefined {
  if (normalizeChannel(params.channel) !== "webchat") {
    return undefined;
  }
  const decisionProvider = params.decisionProvider ?? mayReleaseGovernedFinal;
  const timeoutMs = params.timeoutMs ?? 1000;

  return async (payload: ReplyPayload, info): Promise<ReplyPayload | null> => {
    if (info.kind !== "final") {
      return payload;
    }
    const governedRelease = getReplyPayloadMetadata(payload)?.governedFinalRelease;
    if (!governedRelease) {
      return payload;
    }
    try {
      const decision = await withTimeout(decisionProvider(governedRelease), timeoutMs);
      return decision.allowed ? payload : buildWithheldPayload();
    } catch {
      return buildWithheldPayload();
    }
  };
}

function buildWithheldPayload(): ReplyPayload {
  return {
    text: GOVERNED_FINAL_RELEASE_WITHHELD_NOTICE,
    isStatusNotice: true,
  };
}

function normalizeChannel(channel: string | undefined): string | undefined {
  const normalized = channel?.trim().toLowerCase();
  return normalized || undefined;
}

async function withTimeout<T>(value: T | Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return value;
  }
  return await Promise.race([
    Promise.resolve(value),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("governed final release decision timed out")), timeoutMs);
    }),
  ]);
}
