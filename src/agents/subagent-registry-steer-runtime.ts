import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ReplaceSubagentRunAfterSteerParams = {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
  transcriptFile?: string;
};

type ReplaceSubagentRunAfterSteerFn = (
  params: ReplaceSubagentRunAfterSteerParams,
) => Promise<boolean>;

type FinalizeInterruptedSubagentRunParams = {
  runId?: string;
  childSessionKey?: string;
  error: string;
  endedAt?: number;
};

type FinalizeInterruptedSubagentRunFn = (
  params: FinalizeInterruptedSubagentRunParams,
) => Promise<number>;

let replaceSubagentRunAfterSteerImpl: ReplaceSubagentRunAfterSteerFn | null = null;
let assertParentYieldWaitAllowsRestartImpl: ((runId: string) => Promise<void>) | null = null;
let finalizeInterruptedSubagentRunImpl: FinalizeInterruptedSubagentRunFn | null = null;

export function configureSubagentRegistrySteerRuntime(params: {
  assertParentYieldWaitAllowsRestart: (runId: string) => Promise<void>;
  replaceSubagentRunAfterSteer: ReplaceSubagentRunAfterSteerFn;
  finalizeInterruptedSubagentRun?: FinalizeInterruptedSubagentRunFn;
}) {
  assertParentYieldWaitAllowsRestartImpl = params.assertParentYieldWaitAllowsRestart;
  replaceSubagentRunAfterSteerImpl = params.replaceSubagentRunAfterSteer;
  finalizeInterruptedSubagentRunImpl = params.finalizeInterruptedSubagentRun ?? null;
}

export async function assertParentYieldWaitAllowsRestart(runId: string): Promise<void> {
  if (!assertParentYieldWaitAllowsRestartImpl) {
    throw new Error("Subagent registry is not initialized");
  }
  await assertParentYieldWaitAllowsRestartImpl(runId);
}

export async function replaceSubagentRunAfterSteer(params: ReplaceSubagentRunAfterSteerParams) {
  return (await replaceSubagentRunAfterSteerImpl?.(params)) ?? false;
}

export async function finalizeInterruptedSubagentRun(params: FinalizeInterruptedSubagentRunParams) {
  return (await finalizeInterruptedSubagentRunImpl?.(params)) ?? 0;
}
