import { retryAsync, type RetryInfo } from "../../infra/retry.js";

const GOVERNED_LEASE_CLOSE_ATTEMPTS = 2;
const GOVERNED_LEASE_CLOSE_RETRY_DELAY_MS = 50;

/** Retry only the caller's captured exact lease close; exhaustion remains visible to the caller. */
export async function closeGovernedExecutionLeaseWithRetry(params: {
  close: () => void;
  onRetry?: (info: RetryInfo) => void;
}): Promise<void> {
  await retryAsync(async () => params.close(), {
    attempts: GOVERNED_LEASE_CLOSE_ATTEMPTS,
    minDelayMs: GOVERNED_LEASE_CLOSE_RETRY_DELAY_MS,
    maxDelayMs: GOVERNED_LEASE_CLOSE_RETRY_DELAY_MS,
    jitter: 0,
    label: "governed execution lease close",
    onRetry: params.onRetry,
  });
}
