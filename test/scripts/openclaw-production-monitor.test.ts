import { describe, expect, it } from "vitest";
import {
  buildProductionMonitorReport,
  parseDiskDfOutput,
  parseInodeDfOutput,
  scanGatewayJournal,
} from "../../scripts/openclaw-production-monitor.mjs";

const thresholds = {
  diskWarnPercent: 85,
  diskCriticalPercent: 95,
  inodeWarnPercent: 85,
  inodeCriticalPercent: 95,
  previousBackupMax: 5,
};

describe("openclaw-production-monitor", () => {
  it("parses disk and inode df output", () => {
    expect(
      parseDiskDfOutput(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 91 9 91% /\n",
      ),
    ).toEqual({
      usedPercent: 91,
      mountedOn: "/",
    });

    expect(
      parseInodeDfOutput(
        "Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/sda1 1000 970 30 97% /\n",
      ),
    ).toEqual({
      total: 1000,
      used: 970,
      free: 30,
      usedPercent: 97,
      mountedOn: "/",
    });
  });

  it("reports backup, disk, inode, start-limit, and control-plane write alerts", () => {
    const report = buildProductionMonitorReport({
      fsPath: "/home/will/.openclaw",
      backupRoot: "/home/will/.openclaw/workspace-orchestrator/runtime-backups/openclaw-source",
      gatewayService: "openclaw-gateway.service",
      disk: { usedPercent: 96, mountedOn: "/" },
      inodes: { usedPercent: 100, mountedOn: "/", total: 100, used: 100, free: 0 },
      previousBackupCount: 804,
      gatewayFailed: true,
      systemd: { isFailedStatus: 0, isFailedOutput: "failed" },
      journal: scanGatewayJournal(
        [
          "Start request repeated too quickly.",
          "failed to promote config last-known-good backup: Error: EACCES: permission denied",
        ].join("\n"),
      ),
      thresholds,
    });

    expect(report.ok).toBe(false);
    expect(report.alerts.map((alert) => alert.code)).toEqual([
      "disk_usage",
      "inode_usage",
      "runtime_backup_count",
      "gateway_service_failed",
      "gateway_start_limit",
      "control_plane_write_failure",
    ]);
  });

  it("returns ok when all external production checks are inside limits", () => {
    const report = buildProductionMonitorReport({
      fsPath: "/home/will/.openclaw",
      backupRoot: "/home/will/.openclaw/workspace-orchestrator/runtime-backups/openclaw-source",
      gatewayService: "openclaw-gateway.service",
      disk: { usedPercent: 40, mountedOn: "/" },
      inodes: { usedPercent: 11, mountedOn: "/", total: 100, used: 11, free: 89 },
      previousBackupCount: 5,
      gatewayFailed: false,
      systemd: { isFailedOutput: "active" },
      journal: scanGatewayJournal("gateway ready"),
      thresholds,
    });

    expect(report.ok).toBe(true);
    expect(report.alerts).toEqual([]);
  });

  it("alerts when gateway systemd status cannot be checked", () => {
    const report = buildProductionMonitorReport({
      fsPath: "/home/will/.openclaw",
      backupRoot: "/home/will/.openclaw/workspace-orchestrator/runtime-backups/openclaw-source",
      gatewayService: "openclaw-gateway.service",
      disk: { usedPercent: 40, mountedOn: "/" },
      inodes: { usedPercent: 11, mountedOn: "/", total: 100, used: 11, free: 89 },
      previousBackupCount: 5,
      gatewayFailed: false,
      systemd: {
        isFailedStatus: 1,
        isFailedOutput: "Failed to connect to user scope bus",
        show: "",
      },
      journal: scanGatewayJournal(""),
      thresholds,
    });

    expect(report.ok).toBe(false);
    expect(report.alerts.map((alert) => alert.code)).toContain("gateway_systemd_status_unknown");
  });
});
