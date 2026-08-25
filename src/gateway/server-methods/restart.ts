import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  markActivationContinuationCommandNotStarted,
  persistActivationContinuationBeforeRestart,
  type ActivationContinuationCheckName,
  type ActivationContinuationCreateInput,
} from "../../infra/activation-continuation.js";
import {
  createSafeGatewayRestartPreflight,
  requestSafeGatewayRestart,
} from "../../infra/restart-coordinator.js";
import type { GatewayRequestHandlers } from "./types.js";

const RESTART_CONTINUATION_MANUAL_CHECK_ALIASES = new Set([
  "restart-safe-active-work-preflight",
  "post-restart-gateway-status",
  "post-restart-runtime-identity",
  "normal-reply-path-usable",
]);

function normalizeReason(value: unknown): string | undefined {
  // Restart reasons are operator-visible log context, not payload storage.
  // Trim and cap them before passing through to the coordinator.
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
}

function normalizeSkipDeferral(value: unknown): boolean {
  // Only an explicit boolean may bypass deferral; truthy strings from loose
  // clients must not skip the safe-restart preflight queue.
  return value === true;
}

function normalizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function normalizeStringArray(value: unknown, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => normalizeString(entry, maxLength))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeDeliveryContext(
  value: unknown,
): NonNullable<ActivationContinuationCreateInput["route"]>["deliveryContext"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const input = value as {
    channel?: unknown;
    to?: unknown;
    accountId?: unknown;
    threadId?: unknown;
  };
  const channel = normalizeString(input.channel, 80);
  const to = normalizeString(input.to, 240);
  const accountId = normalizeString(input.accountId, 240);
  const threadId =
    typeof input.threadId === "string" || typeof input.threadId === "number"
      ? input.threadId
      : undefined;
  return channel || to || accountId || threadId !== undefined
    ? {
        ...(channel ? { channel } : {}),
        ...(to ? { to } : {}),
        ...(accountId ? { accountId } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
      }
    : undefined;
}

function normalizeExpectedRuntime(
  value: unknown,
): ActivationContinuationCreateInput["expectedRuntime"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const input = value as { commit?: unknown; version?: unknown; builtAt?: unknown };
  const commit = normalizeString(input.commit, 80);
  const version = normalizeString(input.version, 80);
  const builtAt = normalizeString(input.builtAt, 120);
  return commit || version || builtAt
    ? {
        ...(commit ? { commit } : {}),
        ...(version ? { version } : {}),
        ...(builtAt ? { builtAt } : {}),
      }
    : undefined;
}

function normalizeParent(value: unknown): ActivationContinuationCreateInput["parent"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const input = value as { sessionKey?: unknown; runId?: unknown };
  const sessionKey = normalizeString(input.sessionKey, 240);
  const runId = normalizeString(input.runId, 120);
  return sessionKey || runId
    ? {
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
      }
    : undefined;
}

function normalizeCheckName(value: string): ActivationContinuationCheckName | null {
  const raw = value.trim();
  const lower = raw.toLowerCase();
  if (lower === "systemd" || lower.includes("systemd")) {
    return "systemd";
  }
  if (lower === "gateway_status_rpc" || lower.includes("gateway status rpc")) {
    return "gateway_status_rpc";
  }
  if (lower === "http_health" || lower.includes("/health") || lower.includes("http health")) {
    return "http_health";
  }
  if (
    lower === "runtime_identity" ||
    lower.includes("runtime identity") ||
    lower.includes("build-info") ||
    lower.includes("build state")
  ) {
    return "runtime_identity";
  }
  if (lower === "log_scan" || lower.includes("log")) {
    return "log_scan";
  }
  if (
    lower === "parent_restart_recovery" ||
    lower.includes("parent turn recovery") ||
    lower.includes("parent restart recovery") ||
    lower.includes("parent-turn-recovery") ||
    lower.includes("restart continuation stuck pending")
  ) {
    return "parent_restart_recovery";
  }
  if (lower === "visible_delivery" || lower.includes("visible source delivery")) {
    return "visible_delivery";
  }
  if (lower === "delivery_route" || lower.includes("visible") || lower.includes("delivery")) {
    return "delivery_route";
  }
  if (RESTART_CONTINUATION_MANUAL_CHECK_ALIASES.has(lower)) {
    return `manual:${lower}` as ActivationContinuationCheckName;
  }
  if (raw.startsWith("manual:")) {
    return raw.slice(0, 160) as ActivationContinuationCheckName;
  }
  return null;
}

function normalizeRequiredChecks(value: unknown): {
  checks?: ActivationContinuationCheckName[];
  unknown: string[];
} {
  const raw = normalizeStringArray(value, 160);
  if (!raw) {
    return { unknown: [] };
  }
  const checks: ActivationContinuationCheckName[] = [];
  const unknown: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeCheckName(entry);
    if (normalized) {
      checks.push(normalized);
    } else {
      unknown.push(entry);
    }
  }
  return { checks: [...new Set(checks)], unknown };
}

type ActivationContinuationNormalization =
  | { ok: true; value: ActivationContinuationCreateInput }
  | { ok: false; error: string };

function normalizeActivationContinuation(
  params: Record<string, unknown>,
): ActivationContinuationNormalization | null {
  const raw = params.activationContinuation ?? params.continuation;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const input = raw as Record<string, unknown>;
  const sessionKey =
    normalizeString(input.sessionKey, 240) ?? normalizeString(params.sessionKey, 240);
  const deliveryContext = normalizeDeliveryContext(input.deliveryContext);
  const expectedRuntime =
    normalizeExpectedRuntime(input.expectedRuntime) ??
    normalizeExpectedRuntime(input.expectedBuild);
  const requiredChecksResult = normalizeRequiredChecks(input.requiredChecks);
  const requiredChecks = requiredChecksResult.checks;
  const objective =
    normalizeString(input.objective, 1_000) ?? normalizeString(input.originalObjective, 1_000);
  const parent = normalizeParent(input.parent) ?? {
    ...(sessionKey ? { sessionKey } : {}),
    ...(normalizeString(input.parentRunId, 120)
      ? { runId: normalizeString(input.parentRunId, 120) }
      : {}),
  };
  const missing: string[] = [];
  if (!sessionKey) {
    missing.push("sessionKey");
  }
  if (!objective) {
    missing.push("objective/originalObjective");
  }
  if (!expectedRuntime) {
    missing.push("expectedRuntime/expectedBuild");
  }
  if (!requiredChecks || requiredChecks.length === 0) {
    missing.push("requiredChecks");
  }
  if (requiredChecksResult.unknown.length > 0) {
    return {
      ok: false,
      error: `activationContinuation requiredChecks include unregistered continuation check(s): ${requiredChecksResult.unknown.join(", ")}`,
    };
  }
  if (missing.length > 0) {
    return { ok: false, error: `activationContinuation missing ${missing.join(", ")}` };
  }
  if (
    hasOwn(input, "expectedBuild") &&
    !hasOwn(input, "expectedRuntime") &&
    !normalizeExpectedRuntime(input.expectedBuild)
  ) {
    return { ok: false, error: "activationContinuation expectedBuild is invalid" };
  }
  return {
    ok: true,
    value: {
      ...(normalizeString(input.id, 120) ? { id: normalizeString(input.id, 120) } : {}),
      route: {
        sessionKey: sessionKey as string,
        ...(deliveryContext ? { deliveryContext } : {}),
      },
      parent,
      expectedRuntime,
      requiredChecks,
      objective,
      ...(normalizeStringArray(input.hardStopRules, 240)
        ? { hardStopRules: normalizeStringArray(input.hardStopRules, 240) }
        : {}),
      requestedRestartAction: {
        reason: normalizeReason(params.reason),
        skipDeferral: normalizeSkipDeferral(params.skipDeferral),
      },
    },
  };
}

export const restartHandlers: GatewayRequestHandlers = {
  "gateway.restart.request": async ({ respond, params }) => {
    const activationContinuation =
      params && typeof params === "object"
        ? normalizeActivationContinuation(params as Record<string, unknown>)
        : null;
    if (activationContinuation && !activationContinuation.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, activationContinuation.error),
      );
      return;
    }
    let activationContinuationId: string | undefined;
    if (activationContinuation) {
      try {
        const record = await persistActivationContinuationBeforeRestart(
          activationContinuation.value,
        );
        activationContinuationId = record.id;
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `activationContinuation persistence failed; restart not scheduled: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
    }
    const result = requestSafeGatewayRestart({
      reason: normalizeReason(params.reason),
      delayMs: 0,
      skipDeferral: normalizeSkipDeferral(params.skipDeferral),
      ...(activationContinuationId
        ? {
            emitHooks: {
              afterEmitRejected: async () => {
                if (activationContinuationId) {
                  await markActivationContinuationCommandNotStarted(activationContinuationId);
                }
              },
            },
          }
        : {}),
    });
    respond(true, result);
  },
  "gateway.restart.preflight": async ({ respond }) => {
    respond(true, createSafeGatewayRestartPreflight());
  },
};
