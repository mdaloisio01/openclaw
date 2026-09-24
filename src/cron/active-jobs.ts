import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CronActiveJobState = {
  activeJobIds: Set<string>;
  pendingCoreJobIds: Set<string>;
};

const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");

function getCronActiveJobState(): CronActiveJobState {
  // Cron runs can cross module reload boundaries in tests and dev watch; keep
  // the in-flight job set process-global so duplicate-run guards share state.
  const state = resolveGlobalSingleton<CronActiveJobState>(CRON_ACTIVE_JOB_STATE_KEY, () => ({
    activeJobIds: new Set<string>(),
    pendingCoreJobIds: new Set<string>(),
  }));
  // Dev reload can retain the old singleton shape while loading this newer module.
  state.pendingCoreJobIds ??= new Set<string>();
  return state;
}

/** Holds a timed-out core run until its abort path actually settles. */
export function markCronJobCorePending(jobId: string) {
  getCronActiveJobState().pendingCoreJobIds.add(jobId);
}

export function clearCronJobCorePending(jobId: string) {
  getCronActiveJobState().pendingCoreJobIds.delete(jobId);
}

/** Marks a cron job id as currently executing for duplicate-run suppression. */
export function markCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.add(jobId);
}

/** Clears the active marker when a cron run exits or is abandoned. */
export function clearCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.delete(jobId);
}

/** Returns whether the given cron job id is currently executing in this process. */
export function isCronJobActive(jobId: string) {
  if (!jobId) {
    return false;
  }
  const state = getCronActiveJobState();
  return state.activeJobIds.has(jobId) || state.pendingCoreJobIds.has(jobId);
}

/** Returns whether any cron run is active in this process. */
export function hasActiveCronJobs() {
  // Timed-out cores still block the same job but must not suppress unrelated heartbeats.
  return getCronActiveJobState().activeJobIds.size > 0;
}

/** Clears process-global cron active-job state between tests. */
export function resetCronActiveJobsForTests() {
  getCronActiveJobState().activeJobIds.clear();
  getCronActiveJobState().pendingCoreJobIds.clear();
}
