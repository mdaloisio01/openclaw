#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const exportDir = process.argv[2];
if (!exportDir) {
  throw new Error("lane readiness schedule requires an export directory");
}
const root = fs.realpathSync(path.resolve(exportDir));
const checkedAt = new Date().toISOString();
const stamp = checkedAt.replace(/[-:.]/g, "");
const basename = `lane_readiness_${stamp}`;
const runLabel = basename.replaceAll("_", "-");
const inputPath = path.join(root, `${basename}-input.json`);
const reportPath = path.join(root, `${basename}-report.json`);
const proofRoot = path.join(root, basename);
fs.mkdirSync(proofRoot);

const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  encoding: "utf8",
});
if (revision.status !== 0) {
  throw new Error("could not resolve source revision");
}
const sourceRevision = revision.stdout.trim();
fs.writeFileSync(
  inputPath,
  JSON.stringify({
    runLabel,
    sourceRevision,
    checkedAt,
    recurrenceMs: 7 * 24 * 60 * 60 * 1_000,
    checkTimeoutMs: 90_000,
    runTimeoutMs: 180_000,
  }),
);

const harness = spawnSync(
  process.execPath,
  [
    path.join(import.meta.dirname, "lane-readiness-harness.mjs"),
    "--input",
    inputPath,
    "--runner",
    path.join(import.meta.dirname, "lane-readiness-owner-runner.mjs"),
    "--proof-root",
    proofRoot,
  ],
  { encoding: "utf8", timeout: 190_000, maxBuffer: 1024 * 1024 },
);
if (!harness.stdout || harness.error || (harness.status !== 0 && harness.status !== 1)) {
  throw new Error(
    `lane readiness harness failed to produce a report: ${harness.error?.code ?? harness.status}`,
  );
}
const report = JSON.parse(harness.stdout);
if (
  report.schema !== "openclaw.lane_readiness_report.v1" ||
  report.runLabel !== runLabel ||
  report.sourceRevision !== sourceRevision ||
  report.checkedAt !== checkedAt ||
  !Array.isArray(report.lanes) ||
  report.summary?.laneCount !== report.lanes.length ||
  (report.status !== "PASS" && report.status !== "FAIL") ||
  harness.status !== (report.status === "PASS" ? 0 : 1)
) {
  throw new Error("lane readiness harness returned an inconsistent report");
}
const temporaryReportPath = `${reportPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryReportPath, harness.stdout);
const dashboardExportDir = path.join(os.homedir(), ".openclaw", "workspace", "file_hub", "exports");
const dashboardReportPath = path.join(dashboardExportDir, path.basename(reportPath));
const temporaryDashboardPath = `${dashboardReportPath}.${process.pid}.tmp`;
try {
  fs.copyFileSync(temporaryReportPath, temporaryDashboardPath);
  fs.renameSync(temporaryDashboardPath, dashboardReportPath);
  const token = fs
    .readFileSync(path.join(os.homedir(), ".openclaw", "workspace", ".dashboard_api_token"), "utf8")
    .trim();
  const url = `http://127.0.0.1:18888/api/file-hub/download?path=${encodeURIComponent(`exports/${path.basename(reportPath)}`)}`;
  const downloaded = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (
    !downloaded.ok ||
    !Buffer.from(await downloaded.arrayBuffer()).equals(Buffer.from(harness.stdout))
  ) {
    throw new Error(`dashboard File Hub report readback failed: HTTP ${downloaded.status}`);
  }
  // Publish the source report only after the dashboard serves the same bytes.
  fs.renameSync(temporaryReportPath, reportPath);
} catch (error) {
  fs.rmSync(temporaryDashboardPath, { force: true });
  fs.rmSync(dashboardReportPath, { force: true });
  const detail = `Dashboard File Hub report publication failed: ${error?.message ?? "unknown"}`;
  const lane = report.lanes.find((item) => item.laneId === "file_hub_export");
  const check = lane?.checks.find((item) => item.checkId === "write_export");
  if (!check) {
    throw error;
  }
  check.status = "FAIL";
  check.blocker = { code: "check_failed", detail };
  lane.status = "FAIL";
  report.status = "FAIL";
  const failed = report.lanes.filter((item) => item.status === "FAIL");
  report.summary.passedLaneCount = report.lanes.length - failed.length;
  report.summary.failedLaneCount = failed.length;
  report.summary.p0FailedLaneCount = failed.filter((item) => item.priority === "P0").length;
  report.summary.p1FailedLaneCount = failed.filter((item) => item.priority === "P1").length;
  fs.writeFileSync(
    path.join(proofRoot, "proof", "file_hub_export", "write_export.json"),
    JSON.stringify({
      check: "file_hub_export.write_export",
      executedAt: new Date().toISOString(),
      status: "FAIL",
      detail,
    }),
  );
  fs.writeFileSync(temporaryReportPath, JSON.stringify(report) + "\n");
  fs.renameSync(temporaryReportPath, reportPath);
}
process.stdout.write(
  JSON.stringify({ status: report.status, reportPath, summary: report.summary }) + "\n",
);
process.exitCode = report.status === "PASS" ? 0 : 1;
