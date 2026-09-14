import { spawnSync } from "node:child_process";
import { getActiveEmbeddedRunCount } from "../agents/embedded-agent-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { CLEANUP_WATCHDOG_POLICY_VERSION } from "../governance/cleanup-watchdog-policy.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import {
  getInspectableActiveTaskRestartBlockers,
  type ActiveTaskRestartBlocker,
} from "../tasks/task-registry.maintenance.js";
import {
  scheduleGatewaySigusr1Restart,
  type RestartEmitHooks,
  type ScheduledRestart,
} from "./restart.js";

export const SAFE_GATEWAY_RESTART_POST_RESTART_PROOF = [
  "runtime_identity_loaded",
  "mission_resumption_valid_executor_or_durable_wait",
  "watchdog_clean_with_execution_or_continuation_coverage",
] as const;

export type SafeGatewayRestartPostRestartProof =
  (typeof SAFE_GATEWAY_RESTART_POST_RESTART_PROOF)[number];

export type SafeGatewayRestartCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  activeTasks: number;
  totalActive: number;
};

export type SafeGatewayRestartBlocker = {
  kind: "queue" | "reply" | "embedded-run" | "task" | "build";
  count: number;
  message: string;
  task?: ActiveTaskRestartBlocker;
};

export type SafeGatewayRestartBuildCheck = {
  ok: boolean;
  reason?: string;
  detail?: string;
};

export type SafeGatewayRestartPreflight = {
  policyVersion: typeof CLEANUP_WATCHDOG_POLICY_VERSION;
  restartReadinessGate: "runtime_preflight";
  missionResumptionGate: "post_restart_proof_required";
  postRestartProofRequired: readonly SafeGatewayRestartPostRestartProof[];
  safe: boolean;
  counts: SafeGatewayRestartCounts;
  blockers: SafeGatewayRestartBlocker[];
  build: SafeGatewayRestartBuildCheck;
  summary: string;
};

export type SafeGatewayRestartRequestResult = {
  ok: boolean;
  status: "scheduled" | "deferred" | "coalesced" | "blocked";
  preflight: SafeGatewayRestartPreflight;
  restart?: ScheduledRestart;
  error?: string;
};

type SafeRestartInspectors = {
  getQueueSize: () => number;
  getPendingReplies: () => number;
  getEmbeddedRuns: () => number;
  getActiveTasks: () => number;
  getTaskBlockers: () => ActiveTaskRestartBlocker[];
  validateBuild: () => SafeGatewayRestartBuildCheck;
};

function resolveSourceRoot(): string {
  return process.env.OPENCLAW_RUNTIME_GUARD_ROOT ?? process.cwd();
}

function runNodePreflight(
  script: string,
  args: string[],
  reason: string,
): SafeGatewayRestartBuildCheck {
  const sourceRoot = resolveSourceRoot();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status === 0) {
    return { ok: true };
  }
  const detail = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
  return {
    ok: false,
    reason,
    detail,
  };
}

export function validateGatewayRestartBuildArtifacts(): SafeGatewayRestartBuildCheck {
  const install = runNodePreflight(
    "scripts/install-integrity-guard.mjs",
    ["local-preflight"],
    "dependency preflight failed",
  );
  if (!install.ok) {
    return install;
  }
  return runNodePreflight(
    "scripts/runtime-asset-guard.mjs",
    ["validate", "--no-snapshot", "--operation", "gateway restart preflight"],
    "dist stale/partial or runtime identity unverifiable",
  );
}

const defaultInspectors: SafeRestartInspectors = {
  getQueueSize: getTotalQueueSize,
  getPendingReplies: getTotalPendingReplies,
  getEmbeddedRuns: getActiveEmbeddedRunCount,
  getActiveTasks: () => getInspectableActiveTaskRestartBlockers().length,
  getTaskBlockers: getInspectableActiveTaskRestartBlockers,
  validateBuild: validateGatewayRestartBuildArtifacts,
};

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function formatTaskBlocker(task: ActiveTaskRestartBlocker): string {
  return [
    `taskId=${task.taskId}`,
    task.runId ? `runId=${task.runId}` : null,
    `status=${task.status}`,
    `runtime=${task.runtime}`,
    task.label ? `label=${task.label}` : null,
    task.title ? `title=${task.title.slice(0, 80)}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function createFallbackTaskBlocker(count: number): SafeGatewayRestartBlocker {
  return {
    kind: "task",
    count,
    message: `${count} active background task run(s)`,
  };
}

export function createSafeGatewayRestartPreflight(
  inspectors: Partial<SafeRestartInspectors> = {},
): SafeGatewayRestartPreflight {
  const resolved = { ...defaultInspectors, ...inspectors };
  const counts: SafeGatewayRestartCounts = {
    queueSize: normalizeCount(resolved.getQueueSize()),
    pendingReplies: normalizeCount(resolved.getPendingReplies()),
    embeddedRuns: normalizeCount(resolved.getEmbeddedRuns()),
    activeTasks: normalizeCount(resolved.getActiveTasks()),
    totalActive: 0,
  };
  counts.totalActive =
    counts.queueSize + counts.pendingReplies + counts.embeddedRuns + counts.activeTasks;

  const blockers: SafeGatewayRestartBlocker[] = [];
  const build = resolved.validateBuild();
  if (!build.ok) {
    blockers.push({
      kind: "build",
      count: 1,
      message: build.reason ?? "gateway build/runtime validation failed",
    });
  }
  if (counts.queueSize > 0) {
    blockers.push({
      kind: "queue",
      count: counts.queueSize,
      message: `${counts.queueSize} queued or active operation(s)`,
    });
  }
  if (counts.pendingReplies > 0) {
    blockers.push({
      kind: "reply",
      count: counts.pendingReplies,
      message: `${counts.pendingReplies} pending reply delivery operation(s)`,
    });
  }
  if (counts.embeddedRuns > 0) {
    blockers.push({
      kind: "embedded-run",
      count: counts.embeddedRuns,
      message: `${counts.embeddedRuns} active embedded run(s)`,
    });
  }
  if (counts.activeTasks > 0) {
    const taskBlockers = resolved.getTaskBlockers();
    if (taskBlockers.length === 0) {
      blockers.push(createFallbackTaskBlocker(counts.activeTasks));
    } else {
      for (const task of taskBlockers.slice(0, 8)) {
        blockers.push({
          kind: "task",
          count: 1,
          message: formatTaskBlocker(task),
          task,
        });
      }
      const omitted = counts.activeTasks - taskBlockers.length;
      if (omitted > 0) {
        blockers.push(createFallbackTaskBlocker(omitted));
      }
    }
  }

  const summary =
    blockers.length === 0
      ? "safe to restart now"
      : `restart deferred: ${blockers.map((blocker) => blocker.message).join("; ")}`;
  return {
    policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
    restartReadinessGate: "runtime_preflight",
    missionResumptionGate: "post_restart_proof_required",
    postRestartProofRequired: SAFE_GATEWAY_RESTART_POST_RESTART_PROOF,
    safe: counts.totalActive === 0 && build.ok,
    counts,
    blockers,
    build,
    summary,
  };
}

export function requestSafeGatewayRestart(
  opts: {
    reason?: string;
    delayMs?: number;
    skipDeferral?: boolean;
    emitHooks?: RestartEmitHooks;
    inspect?: Partial<SafeRestartInspectors>;
  } = {},
): SafeGatewayRestartRequestResult {
  const preflight = createSafeGatewayRestartPreflight(opts.inspect);
  if (!preflight.build.ok) {
    return {
      ok: false,
      status: "blocked",
      preflight,
      error: preflight.build.detail ?? preflight.build.reason ?? "gateway build validation failed",
    };
  }
  const skipDeferral = opts.skipDeferral === true;
  if (skipDeferral && (preflight.counts.pendingReplies > 0 || preflight.counts.embeddedRuns > 0)) {
    return {
      ok: false,
      status: "blocked",
      preflight,
      error:
        "forced gateway restart blocked: active source turn work has pending replies or embedded runs",
    };
  }
  const restart = scheduleGatewaySigusr1Restart({
    delayMs: opts.delayMs ?? 0,
    reason: opts.reason ?? "gateway.restart.safe",
    deferralTimeoutMs: 0,
    ...(opts.emitHooks ? { emitHooks: opts.emitHooks } : {}),
    ...(skipDeferral ? { skipDeferral: true } : {}),
  });
  const status = restart.coalesced
    ? "coalesced"
    : skipDeferral || preflight.safe
      ? "scheduled"
      : "deferred";
  return {
    ok: true,
    status,
    preflight,
    restart,
  };
}
