const activeToolCallsByRun = new Map<string, Set<symbol>>();
const drainWaitersByRun = new Map<string, Set<() => void>>();

/** Track the real tool execution promise, independent of subscription lifetime. */
export function beginActiveToolExecution(
  runId: string | undefined,
  toolCallId: string,
): () => void {
  const normalizedRunId = runId?.trim();
  if (!normalizedRunId) {
    return () => {};
  }
  // Provider call IDs are metadata, not unique invocation identities. Retries and
  // overlapping calls may reuse one, so every actual promise gets its own token.
  const executionToken = Symbol(toolCallId);
  const active = activeToolCallsByRun.get(normalizedRunId) ?? new Set<symbol>();
  active.add(executionToken);
  activeToolCallsByRun.set(normalizedRunId, active);
  let finished = false;
  return () => {
    if (finished) {
      return;
    }
    finished = true;
    const current = activeToolCallsByRun.get(normalizedRunId);
    current?.delete(executionToken);
    if (current && current.size > 0) {
      return;
    }
    activeToolCallsByRun.delete(normalizedRunId);
    const waiters = drainWaitersByRun.get(normalizedRunId);
    if (!waiters) {
      return;
    }
    drainWaitersByRun.delete(normalizedRunId);
    for (const resolve of waiters) {
      resolve();
    }
  };
}

export function countActiveToolExecutions(runId: string): number {
  return activeToolCallsByRun.get(runId)?.size ?? 0;
}

export function waitForActiveToolExecutionsToDrain(runId: string): Promise<void> {
  if (countActiveToolExecutions(runId) === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const waiters = drainWaitersByRun.get(runId) ?? new Set<() => void>();
    waiters.add(resolve);
    drainWaitersByRun.set(runId, waiters);
  });
}
