#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
    checkTimeoutMs: 20_000,
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
fs.renameSync(temporaryReportPath, reportPath);
process.stdout.write(
  JSON.stringify({ status: report.status, reportPath, summary: report.summary }) + "\n",
);
process.exitCode = report.status === "PASS" ? 0 : 1;
