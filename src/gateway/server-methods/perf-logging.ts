import { performance } from "node:perf_hooks";
import type { createSubsystemLogger } from "../../logging/subsystem.js";

export const GATEWAY_PERF_INFO_THRESHOLD_MS = 250;
export const GATEWAY_PERF_WARN_THRESHOLD_MS = 1_000;

type GatewayPerfLogger = ReturnType<typeof createSubsystemLogger>;

export function formatGatewayPerfMs(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "n/a";
}

export function formatGatewayPerfCpuUsage(start: NodeJS.CpuUsage): string {
  const usage = process.cpuUsage(start);
  return `cpuUserMs=${formatGatewayPerfMs(usage.user / 1000)} cpuSystemMs=${formatGatewayPerfMs(
    usage.system / 1000,
  )}`;
}

export function safeGatewayPerfRequestId(id: unknown): string {
  return typeof id === "string" || typeof id === "number" ? String(id) : "unknown";
}

export function createGatewayPerfStageTimer(): {
  mark: (name: string) => void;
  totalMs: () => number;
  summary: () => string;
} {
  const started = performance.now();
  let last = started;
  const stages: string[] = [];
  return {
    mark(name: string) {
      const now = performance.now();
      stages.push(`${name}=${formatGatewayPerfMs(now - last)}ms`);
      last = now;
    },
    totalMs() {
      return performance.now() - started;
    },
    summary() {
      return stages.join(" ");
    },
  };
}

export function logGatewayPerfSummary(params: {
  logger: GatewayPerfLogger;
  surface: string;
  message: string;
  durationMs: number;
  minInfoMs?: number;
  minWarnMs?: number;
}): void {
  const infoThreshold = params.minInfoMs ?? GATEWAY_PERF_INFO_THRESHOLD_MS;
  const warnThreshold = params.minWarnMs ?? GATEWAY_PERF_WARN_THRESHOLD_MS;
  if (params.durationMs < infoThreshold) {
    return;
  }
  const threshold = params.durationMs >= warnThreshold ? "slow_handler_warn" : "slow_handler_info";
  const line =
    `[perf:${params.surface}] durationMs=${formatGatewayPerfMs(params.durationMs)} ` +
    `threshold=${threshold} ${params.message}`;
  if (params.durationMs >= warnThreshold) {
    params.logger.warn(line);
  } else {
    params.logger.info(line);
  }
}
