#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
const operatingModule = await import(
  pathToFileURL(path.resolve(import.meta.dirname, "../dist/lane-readiness.js")).href
);
const temporaryReportPath = `${reportPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryReportPath, harness.stdout);
const observedAt = new Date().toISOString();
try {
  const currentReadiness = operatingModule.resolveSopCurrentTruth(
    [
      {
        id: runLabel,
        role: "readiness_report",
        scope: runLabel,
        issuedAt: report.checkedAt,
        expiresAt: report.nextRunDueAt,
        sourceRevision,
        proofPaths: [temporaryReportPath],
        proofBindings: [
          {
            path: temporaryReportPath,
            sha256: createHash("sha256").update(harness.stdout).digest("hex"),
            artifactId: runLabel,
            role: "readiness_report",
            scope: runLabel,
            sourceRevision,
          },
        ],
      },
    ],
    { activeScope: runLabel, activeRevision: sourceRevision, now: observedAt },
  );
  operatingModule.requireCurrentSopArtifact(currentReadiness, "readiness_report");
} catch (error) {
  fs.rmSync(temporaryReportPath, { force: true });
  throw error;
}
const operatingRegistry = operatingModule.SOP_OPERATING_REGISTRY;
const operatingState = operatingModule.resolveSopOperatingLaneState(
  operatingRegistry,
  report,
  observedAt,
);
const operatingLanes = (states) =>
  operatingRegistry.lanes.map((lane, index) =>
    Object.assign({}, lane, {
      observedReadiness: {
        result: states[index].status === "ready" ? "PASS" : "FAIL",
        observedAt: report.checkedAt,
        expiresAt: report.nextRunDueAt,
        proofPaths: states[index].proofPaths,
        blockers: states[index].blockers,
      },
    }),
  );
const operatingReport = {
  schema: operatingModule.SOP_OPERATING_REGISTRY_SCHEMA,
  runLabel,
  sourceRevision,
  checkedAt: report.checkedAt,
  nextRunDueAt: report.nextRunDueAt,
  observedResult: operatingState.every((lane) => lane.status === "ready") ? "PASS" : "FAIL",
  observationExpiresAt: report.nextRunDueAt,
  lanes: operatingLanes(operatingState),
};
const operatingPath = path.join(root, `operating_registry_${stamp}-report.json`);
const operatingBody = `${JSON.stringify(operatingReport, null, 2)}\n`;
const operatingTemporary = `${operatingPath}.${process.pid}.tmp`;
const dashboardExportDir = path.join(os.homedir(), ".openclaw", "workspace", "file_hub", "exports");
const dashboardReportPath = path.join(dashboardExportDir, path.basename(reportPath));
const operatingDashboardPath = path.join(dashboardExportDir, path.basename(operatingPath));
const temporaryDashboardPath = `${dashboardReportPath}.${process.pid}.tmp`;
const operatingDashboardTemporary = `${operatingDashboardPath}.${process.pid}.tmp`;
fs.writeFileSync(operatingTemporary, operatingBody);
try {
  const token = fs
    .readFileSync(path.join(os.homedir(), ".openclaw", "workspace", ".dashboard_api_token"), "utf8")
    .trim();
  const headers = { Authorization: `Bearer ${token}` };
  for (const item of [
    {
      source: operatingTemporary,
      destination: operatingDashboardPath,
      temporary: operatingDashboardTemporary,
      body: operatingBody,
    },
    {
      source: temporaryReportPath,
      destination: dashboardReportPath,
      temporary: temporaryDashboardPath,
      body: harness.stdout,
    },
  ]) {
    fs.copyFileSync(item.source, item.temporary);
    fs.renameSync(item.temporary, item.destination);
    const url = `http://127.0.0.1:18888/api/file-hub/download?path=${encodeURIComponent(`exports/${path.basename(item.destination)}`)}`;
    const downloaded = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (
      !downloaded.ok ||
      !Buffer.from(await downloaded.arrayBuffer()).equals(Buffer.from(item.body))
    ) {
      throw new Error(
        `dashboard File Hub readback failed for ${path.basename(item.destination)}: HTTP ${downloaded.status}`,
      );
    }
  }
  // Publish source artifacts only after both dashboard downloads match.
  fs.renameSync(operatingTemporary, operatingPath);
  fs.renameSync(temporaryReportPath, reportPath);
} catch (error) {
  for (const file of [
    temporaryDashboardPath,
    dashboardReportPath,
    operatingDashboardTemporary,
    operatingDashboardPath,
    operatingTemporary,
    operatingPath,
  ]) {
    fs.rmSync(file, { force: true });
  }
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
  const failedOperatingState = operatingModule.resolveSopOperatingLaneState(
    operatingRegistry,
    report,
    new Date().toISOString(),
  );
  operatingReport.observedResult = "FAIL";
  operatingReport.lanes = operatingLanes(failedOperatingState);
  fs.writeFileSync(operatingTemporary, JSON.stringify(operatingReport, null, 2) + "\n");
  fs.renameSync(operatingTemporary, operatingPath);
}
process.stdout.write(
  JSON.stringify({ status: report.status, reportPath, operatingPath, summary: report.summary }) +
    "\n",
);
process.exitCode = report.status === "PASS" ? 0 : 1;
