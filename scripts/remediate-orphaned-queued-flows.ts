import path from "node:path";
import {
  planOrphanQueuedFlowSnapshotPath,
  runOrphanQueuedFlowRemediation,
} from "../src/tasks/task-flow-orphan-remediation.js";

function parseArgs(argv: string[]) {
  let mode: "dry-run" | "write" | null = null;
  let dbPath = path.join(process.cwd(), "state", "openclaw.sqlite");
  let receiptDir = path.join(process.cwd(), "receipts");
  let staleQueuedMs: number | undefined;

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
      dbPath = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--receipt-dir") {
      receiptDir = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--stale-ms") {
      staleQueuedMs = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!mode) {
    throw new Error("Pass exactly one of --dry-run or --write.");
  }

  return {
    mode,
    dbPath,
    receiptDir,
    staleQueuedMs,
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const snapshotPath =
    parsed.mode === "write" ? planOrphanQueuedFlowSnapshotPath(parsed.dbPath) : undefined;
  const result = runOrphanQueuedFlowRemediation({
    mode: parsed.mode,
    dbPath: parsed.dbPath,
    receiptDir: parsed.receiptDir,
    staleQueuedMs: parsed.staleQueuedMs,
    ...(snapshotPath ? { snapshotPath } : {}),
  });
  process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
}

await main();
