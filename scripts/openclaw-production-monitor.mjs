#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BACKUP_ROOT = "~/.openclaw/workspace-orchestrator/runtime-backups/openclaw-source";
const DEFAULT_SERVICE = "openclaw-gateway.service";

function expandHome(input, home = os.homedir()) {
  return input === "~" ? home : input.startsWith("~/") ? path.join(home, input.slice(2)) : input;
}

function parsePercent(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d+)%$/);
  return match ? Number(match[1]) : undefined;
}

export function parseDiskDfOutput(output) {
  const lines = String(output ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const data = lines.at(-1)?.trim().split(/\s+/) ?? [];
  if (data.length < 6) {
    return null;
  }
  return {
    usedPercent: parsePercent(data[4]),
    mountedOn: data.slice(5).join(" "),
  };
}

export function parseInodeDfOutput(output) {
  const lines = String(output ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const data = lines.at(-1)?.trim().split(/\s+/) ?? [];
  if (data.length < 6) {
    return null;
  }
  return {
    total: Number(data[1]),
    used: Number(data[2]),
    free: Number(data[3]),
    usedPercent: parsePercent(data[4]),
    mountedOn: data.slice(5).join(" "),
  };
}

export function classifyThreshold(value, warn, critical) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  if (value >= critical) {
    return "critical";
  }
  if (value >= warn) {
    return "warn";
  }
  return undefined;
}

export function countPreviousBackups(backupRoot, fsImpl = fs) {
  try {
    return fsImpl
      .readdirSync(backupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("previous-")).length;
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

export function scanGatewayJournal(text) {
  const haystack = String(text ?? "");
  return {
    startLimit: /start-limit-hit|Start request repeated too quickly/i.test(haystack),
    controlPlaneWriteFailure:
      /failed to promote config last-known-good backup/i.test(haystack) ||
      /EACCES.*openclaw\.json\.last-good/i.test(haystack),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function addAlert(alerts, severity, code, message, detail = {}) {
  alerts.push({ severity, code, message, ...detail });
}

export function buildProductionMonitorReport(params) {
  const alerts = [];
  const disk = params.disk ?? null;
  const inodes = params.inodes ?? null;

  const diskSeverity = classifyThreshold(
    disk?.usedPercent,
    params.thresholds.diskWarnPercent,
    params.thresholds.diskCriticalPercent,
  );
  if (diskSeverity) {
    addAlert(
      alerts,
      diskSeverity,
      "disk_usage",
      `Filesystem usage is ${disk.usedPercent}% on ${disk.mountedOn ?? params.fsPath}.`,
      { usedPercent: disk.usedPercent, mountedOn: disk.mountedOn },
    );
  }

  const inodeSeverity = classifyThreshold(
    inodes?.usedPercent,
    params.thresholds.inodeWarnPercent,
    params.thresholds.inodeCriticalPercent,
  );
  if (inodeSeverity) {
    addAlert(
      alerts,
      inodeSeverity,
      "inode_usage",
      `Inode usage is ${inodes.usedPercent}% on ${inodes.mountedOn ?? params.fsPath}.`,
      { usedPercent: inodes.usedPercent, mountedOn: inodes.mountedOn },
    );
  }

  if (typeof params.previousBackupCount === "number") {
    if (params.previousBackupCount > params.thresholds.previousBackupMax) {
      addAlert(
        alerts,
        "critical",
        "runtime_backup_count",
        `Runtime previous backup count is ${params.previousBackupCount}, above max ${params.thresholds.previousBackupMax}.`,
        { previousBackupCount: params.previousBackupCount },
      );
    }
  } else if (params.previousBackupCount?.error) {
    addAlert(alerts, "warn", "runtime_backup_count_unknown", params.previousBackupCount.error);
  }

  if (params.gatewayFailed) {
    addAlert(
      alerts,
      "critical",
      "gateway_service_failed",
      `${params.gatewayService} is failed according to systemd.`,
      { systemd: params.systemd },
    );
  }

  if (params.systemd?.isFailedStatus !== 0 && params.systemd?.isFailedOutput !== "active") {
    addAlert(
      alerts,
      "warn",
      "gateway_systemd_status_unknown",
      `${params.gatewayService} status could not be checked through systemd.`,
      { systemd: params.systemd },
    );
  }

  if (params.journal?.startLimit) {
    addAlert(
      alerts,
      "critical",
      "gateway_start_limit",
      `${params.gatewayService} reported start-limit behavior in the journal window.`,
    );
  }

  if (params.journal?.controlPlaneWriteFailure) {
    addAlert(
      alerts,
      "critical",
      "control_plane_write_failure",
      `${params.gatewayService} reported config last-good promotion/write failure in the journal window.`,
    );
  }

  return {
    ok: alerts.length === 0,
    checkedAt: new Date().toISOString(),
    fsPath: params.fsPath,
    backupRoot: params.backupRoot,
    gatewayService: params.gatewayService,
    disk,
    inodes,
    previousBackupCount: params.previousBackupCount,
    systemd: params.systemd,
    journal: params.journal,
    alerts,
  };
}

function readNumberEnv(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function collectReport(env = process.env) {
  const backupRoot = expandHome(env.OPENCLAW_MONITOR_BACKUP_ROOT || DEFAULT_BACKUP_ROOT);
  const fsPath = expandHome(env.OPENCLAW_MONITOR_FILESYSTEM_PATH || backupRoot);
  const gatewayService = env.OPENCLAW_MONITOR_GATEWAY_SERVICE || DEFAULT_SERVICE;
  const journalSince = env.OPENCLAW_MONITOR_JOURNAL_SINCE || "-15min";

  const diskResult = run("df", ["-P", fsPath]);
  const inodeResult = run("df", ["-Pi", fsPath]);
  const failedResult = run("systemctl", ["--user", "is-failed", gatewayService]);
  const showResult = run("systemctl", [
    "--user",
    "show",
    gatewayService,
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "Result",
    "-p",
    "NRestarts",
  ]);
  const journalResult = run("journalctl", [
    "--user-unit",
    gatewayService,
    "--since",
    journalSince,
    "--no-pager",
    "-o",
    "cat",
  ]);

  return buildProductionMonitorReport({
    fsPath,
    backupRoot,
    gatewayService,
    disk: parseDiskDfOutput(diskResult.stdout),
    inodes: parseInodeDfOutput(inodeResult.stdout),
    previousBackupCount: countPreviousBackups(backupRoot),
    gatewayFailed: failedResult.stdout.trim() === "failed",
    systemd: {
      isFailedStatus: failedResult.status,
      isFailedOutput: failedResult.stdout.trim() || failedResult.stderr.trim(),
      show: showResult.stdout.trim(),
    },
    journal: scanGatewayJournal(journalResult.stdout),
    thresholds: {
      diskWarnPercent: readNumberEnv(env, "OPENCLAW_MONITOR_DISK_WARN_PERCENT", 85),
      diskCriticalPercent: readNumberEnv(env, "OPENCLAW_MONITOR_DISK_CRITICAL_PERCENT", 95),
      inodeWarnPercent: readNumberEnv(env, "OPENCLAW_MONITOR_INODE_WARN_PERCENT", 85),
      inodeCriticalPercent: readNumberEnv(env, "OPENCLAW_MONITOR_INODE_CRITICAL_PERCENT", 95),
      previousBackupMax: readNumberEnv(env, "OPENCLAW_MONITOR_PREVIOUS_BACKUP_MAX", 5),
    },
  });
}

function writeReceipt(report, env = process.env) {
  const receiptPath = expandHome(
    env.OPENCLAW_MONITOR_STATE_FILE || "~/.openclaw/monitor/openclaw-production-monitor.json",
  );
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function main() {
  const report = collectReport();
  writeReceipt(report);
  const prefix = report.ok ? "OPENCLAW_MONITOR_STATUS OK" : "OPENCLAW_MONITOR_STATUS ALERT";
  console.log(`${prefix} ${JSON.stringify(report)}`);
  process.exitCode = report.ok ? 0 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
