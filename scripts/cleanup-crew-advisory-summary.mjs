#!/usr/bin/env node
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SUMMARY_SCHEMA = "openclaw.cleanup_crew_advisory_summary.v1";

function parseArgs(argv) {
  const options = { file: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { ...options, help: true };
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--file") {
      const file = argv[index + 1];
      if (!file) {
        throw new Error("--file requires a path");
      }
      options.file = file;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function readInput(file) {
  if (file) {
    return fs.readFile(file, "utf8");
  }
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function receiptsFromJson(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.receipts)) {
    return value.receipts;
  }
  if (value?.schema === "openclaw.cleanup_crew_advisory_receipt.v1") {
    return [value];
  }
  throw new Error("expected an advisory receipt, an array of receipts, or { receipts: [...] }");
}

function decisionFor(receipt) {
  const decision = receipt?.decisionRecord?.decision;
  if (decision === "would_allow" || decision === "would_block" || decision === "require_review") {
    return decision;
  }
  throw new Error("receipt is missing decisionRecord.decision");
}

export function summarizeCleanupCrewAdvisoryReceiptJson(value) {
  const receipts = receiptsFromJson(value);
  const summary = {
    schema: SUMMARY_SCHEMA,
    total: receipts.length,
    wouldAllow: 0,
    wouldBlock: 0,
    requireReview: 0,
    falsePositiveMarkers: 0,
    falseNegativeMarkers: 0,
  };
  for (const receipt of receipts) {
    const decision = decisionFor(receipt);
    if (decision === "would_allow") {
      summary.wouldAllow += 1;
    } else if (decision === "would_block") {
      summary.wouldBlock += 1;
    } else {
      summary.requireReview += 1;
    }
    if (receipt?.falsePositiveMarker === true) {
      summary.falsePositiveMarkers += 1;
    }
    if (receipt?.falseNegativeMarker === true) {
      summary.falseNegativeMarkers += 1;
    }
  }
  return summary;
}

export function formatCleanupCrewAdvisorySummary(summary) {
  const status =
    summary.wouldBlock > 0 || summary.requireReview > 0 ? "advisory_attention" : "advisory_clear";
  return [
    `status: ${status}`,
    `schema: ${summary.schema}`,
    `total: ${summary.total}`,
    `would_allow: ${summary.wouldAllow}`,
    `would_block: ${summary.wouldBlock}`,
    `require_review: ${summary.requireReview}`,
    `false_positive_markers: ${summary.falsePositiveMarkers}`,
    `false_negative_markers: ${summary.falseNegativeMarkers}`,
    "execution_effect: advisory_only_no_block",
  ].join("\n");
}

function usage() {
  return [
    "Usage: node scripts/cleanup-crew-advisory-summary.mjs [--file path] [--json]",
    "",
    "Reads Cleanup Crew advisory receipt JSON from stdin or --file and prints a read-only summary.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const raw = await readInput(options.file);
  const parsed = JSON.parse(raw);
  const summary = summarizeCleanupCrewAdvisoryReceiptJson(parsed);
  console.log(
    options.json ? JSON.stringify(summary, null, 2) : formatCleanupCrewAdvisorySummary(summary),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
