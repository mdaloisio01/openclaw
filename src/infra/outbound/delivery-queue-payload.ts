import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { stripInternalRuntimeScaffolding } from "./sanitize-text.js";

function stripInternalRuntimeScaffoldingFromValue(value: unknown): unknown {
  if (typeof value === "string") {
    return stripInternalRuntimeScaffolding(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const stripped = stripInternalRuntimeScaffoldingFromValue(entry);
      changed ||= stripped !== entry;
      return stripped;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const stripped = stripInternalRuntimeScaffoldingFromValue(entry);
    changed ||= stripped !== entry;
    next[key] = stripped;
  }
  return changed ? next : value;
}

/** Canonical payload projection persisted and replayed by the outbound queue. */
export function prepareDeliveryQueuePayload(payload: ReplyPayload): ReplyPayload {
  const stripped = stripInternalRuntimeScaffoldingFromValue(payload);
  return stripped && typeof stripped === "object" && !Array.isArray(stripped)
    ? (stripped as ReplyPayload)
    : payload;
}
