#!/usr/bin/env node

import { createGrantRetirementRequest } from "./lib/grant-retirement-request.mjs";

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/grant-retirement-request.mjs \\",
      "    --workspace /abs/workspace \\",
      "    --outcome-code rejected_proof_missing \\",
      "    --reason capability_materially_fixed \\",
      '    --evidence "why the correction should retire" \\',
      "    [--proof-path /abs/proof]... \\",
      '    [--notes "optional note"]',
      "",
      "Required:",
      "  --workspace",
      "  --outcome-code",
      "  --reason",
      "  one of --evidence or --proof-path",
      "",
      "Optional:",
      "  --requested-by Will",
      "  --approved-by Will",
      "  --requested-at 2026-06-06T05:19:00.000Z",
      "  --approved-at 2026-06-06T05:19:00.000Z",
      "  --dry-run",
    ].join("\n"),
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const result = {
    workspace: "",
    outcomeCode: "",
    reason: "",
    evidence: "",
    proofPaths: [],
    notes: "",
    requestedBy: "Will",
    approvedBy: "Will",
    requestedAt: "",
    approvedAt: "",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null) {
      throw new Error(`missing value for ${arg}`);
    }
    switch (arg) {
      case "--workspace":
        result.workspace = value;
        break;
      case "--outcome-code":
        result.outcomeCode = value;
        break;
      case "--reason":
        result.reason = value;
        break;
      case "--evidence":
        result.evidence = value;
        break;
      case "--proof-path":
        result.proofPaths.push(value);
        break;
      case "--notes":
        result.notes = value;
        break;
      case "--requested-by":
        result.requestedBy = value;
        break;
      case "--approved-by":
        result.approvedBy = value;
        break;
      case "--requested-at":
        result.requestedAt = value;
        break;
      case "--approved-at":
        result.approvedAt = value;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
    index += 1;
  }
  return result;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }
  if (!args.workspace.trim()) {
    fail("--workspace is required");
    return;
  }
  if (!args.outcomeCode.trim()) {
    fail("--outcome-code is required");
    return;
  }
  try {
    const result = await createGrantRetirementRequest({
      workspace: args.workspace,
      outcomeCode: args.outcomeCode,
      reason: args.reason,
      evidence: args.evidence,
      proofPaths: args.proofPaths,
      notes: args.notes,
      requestedBy: args.requestedBy,
      approvedBy: args.approvedBy,
      requestedAt: args.requestedAt,
      approvedAt: args.approvedAt,
      dryRun: args.dryRun,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

await main();
