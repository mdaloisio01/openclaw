import type { CronJob } from "./types.js";

const MANAGED_WATCHDOG_NAME = "system-wide-active-work-watchdog-report-only";

export function isWatchdogReceiptProofJob(job: CronJob): boolean {
  if (job.sessionTarget === "isolated") {
    if (job.agentId !== "orchestrator" || job.name !== MANAGED_WATCHDOG_NAME) {
      return false;
    }
  } else if (job.sessionTarget !== "main") {
    return false;
  }
  const command = job.payload.kind === "systemEvent" ? job.payload.text : job.payload.message;
  return (
    command.includes("scripts/system_wide_active_work_watchdog.py") &&
    command.includes("--write-receipt")
  );
}
