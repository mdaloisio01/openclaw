import path from "node:path";
import {
  planHistoricalDeliveryFailureSnapshotPath,
  runHistoricalDeliveryFailureRemediation,
} from "../src/tasks/task-delivery-remediation.js";

type CliOptions = {
  mode: "dry-run" | "write";
  dbPath?: string;
  receiptDir: string;
  snapshotPath?: string;
};

function parseArgs(argv: string[]): CliOptions {
  let mode: "dry-run" | "write" = "dry-run";
  let dbPath: string | undefined;
  let receiptDir = "/home/will/.openclaw/workspace-orchestrator/file_hub/exports";
  let snapshotPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      mode = "dry-run";
      continue;
    }
    if (arg === "--write") {
      mode = "write";
      continue;
    }
    if (arg === "--db") {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--receipt-dir") {
      receiptDir = argv[index + 1] ?? receiptDir;
      index += 1;
      continue;
    }
    if (arg === "--snapshot-path") {
      snapshotPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node --import tsx scripts/remediate-delivery-failure-poisoned-rows.ts [--dry-run|--write] [--db <path>] [--receipt-dir <dir>] [--snapshot-path <path>]",
          "",
          "Dry-run is the default.",
          "Write mode requires a snapshot path; if omitted, one is generated next to the DB.",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    mode,
    dbPath,
    receiptDir,
    snapshotPath,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const snapshotPath =
    options.mode === "write"
      ? (options.snapshotPath ??
        planHistoricalDeliveryFailureSnapshotPath(
          options.dbPath ?? "/home/will/.openclaw/state/openclaw.sqlite",
          now,
        ))
      : undefined;

  const result = runHistoricalDeliveryFailureRemediation({
    mode: options.mode,
    path: options.dbPath,
    receiptDir: path.resolve(options.receiptDir),
    snapshotPath,
    now,
  });

  process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
