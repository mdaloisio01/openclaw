import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { root as openFsRoot } from "../infra/fs-safe.js";
import {
  recordOpenClawStateMigrationRun,
  recordOpenClawStateMigrationSource,
} from "../state/openclaw-state-db.js";
import { commitGovernedMissionLedgerToSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import { buildFalseCloseoutLedgerDetails } from "./false-closeout-runtime-evidence.js";

const LEGACY_RECEIPT_MAX_BYTES = 1024 * 1024;
const LEGACY_RECEIPT_MAX_FILES = 10_000;
const LEGACY_RECEIPT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MIGRATION_KIND = "governed-false-closeout-receipts-v1";
const LEGACY_RECEIPT_MIGRATION_SUFFIX = ".openclaw-migrating";

type LegacyFalseCloseoutReceipt = {
  schema: "openclaw.false_closeout_admission_decision_receipt.v1";
  writtenAt?: string;
  decision: {
    decisionId: string;
    missionId: string;
    planRevisionId?: string;
    mode?: string;
    state: string;
    allowed: boolean;
    rejectionCodes?: string[];
    evaluatedAt?: string;
  };
};

type ImportedLegacyFileEvidence = {
  payloadSha256: string;
  dev: number;
  ino: number;
};

export type LegacyGovernedReceiptMigrationPreview = {
  directory: string;
  present: boolean;
  fileCount: number;
  totalBytes: number;
  bounded: boolean;
};

export type LegacyGovernedReceiptMigrationResult = {
  changes: string[];
  warnings: string[];
  imported: number;
  alreadyImported: number;
  removedSource: boolean;
};

export function legacyFalseCloseoutReceiptStagingDirectory(directory: string): string {
  return `${directory}${LEGACY_RECEIPT_MIGRATION_SUFFIX}`;
}

export function inspectLegacyFalseCloseoutReceipts(
  directory: string,
): LegacyGovernedReceiptMigrationPreview {
  if (!fs.existsSync(directory)) {
    return { directory, present: false, fileCount: 0, totalBytes: 0, bounded: true };
  }
  if (!isNormalDirectory(directory)) {
    return { directory, present: false, fileCount: 0, totalBytes: 0, bounded: false };
  }
  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const totalBytes = files.reduce(
    (total, entry) => total + fs.statSync(path.join(directory, entry.name)).size,
    0,
  );
  return {
    directory,
    present: files.length > 0,
    fileCount: files.length,
    totalBytes,
    bounded:
      files.length <= LEGACY_RECEIPT_MAX_FILES && totalBytes <= LEGACY_RECEIPT_MAX_TOTAL_BYTES,
  };
}

export async function migrateLegacyFalseCloseoutReceipts(params: {
  directory: string;
  stateDbPath?: string;
  removeSource: boolean;
  now?: number;
}): Promise<LegacyGovernedReceiptMigrationResult> {
  const originalDirectory = params.directory;
  let workingDirectory = originalDirectory;
  let stagedDirectory: string | undefined;
  const recoverableStagingDirectory = legacyFalseCloseoutReceiptStagingDirectory(originalDirectory);
  let stagedIdentity: fs.Stats | undefined;
  if (params.removeSource && fs.existsSync(recoverableStagingDirectory)) {
    if (!isNormalDirectory(recoverableStagingDirectory)) {
      return {
        changes: [],
        warnings: ["Governed receipt migration refused an invalid recovery staging path."],
        imported: 0,
        alreadyImported: 0,
        removedSource: false,
      };
    }
    const recoveryIdentity = fs.lstatSync(recoverableStagingDirectory);
    if (fs.readdirSync(recoverableStagingDirectory).length === 0) {
      // A crash after the last staged receipt was removed leaves an empty recovery path.
      // Clear only that verified directory so a concurrently recreated source is not hidden.
      assertMigrationDirectoryIdentity(recoverableStagingDirectory, recoveryIdentity);
      fs.rmdirSync(recoverableStagingDirectory);
    } else {
      stagedDirectory = recoverableStagingDirectory;
      workingDirectory = stagedDirectory;
      stagedIdentity = recoveryIdentity;
    }
  }
  if (!stagedDirectory && params.removeSource && fs.existsSync(originalDirectory)) {
    if (!isNormalDirectory(originalDirectory)) {
      return {
        changes: [],
        warnings: ["Governed receipt migration refused a non-directory or symlink source."],
        imported: 0,
        alreadyImported: 0,
        removedSource: false,
      };
    }
    const sourceIdentity = fs.lstatSync(originalDirectory);
    stagedDirectory = recoverableStagingDirectory;
    fs.renameSync(originalDirectory, stagedDirectory);
    stagedIdentity = sourceIdentity;
    workingDirectory = stagedDirectory;
  }

  if (!fs.existsSync(workingDirectory)) {
    return {
      changes: [],
      warnings: [],
      imported: 0,
      alreadyImported: 0,
      removedSource: false,
    };
  }

  try {
    const safeWorkingRoot = params.removeSource
      ? await openFsRoot(workingDirectory, {
          hardlinks: "reject",
          maxBytes: LEGACY_RECEIPT_MAX_BYTES,
          symlinks: "reject",
        })
      : undefined;
    if (stagedIdentity) {
      assertMigrationDirectoryIdentity(workingDirectory, stagedIdentity);
    }
    const preview = inspectLegacyFalseCloseoutReceipts(workingDirectory);
    if (!preview.present) {
      const restoreWarning = restoreStagedLegacyDirectory(
        originalDirectory,
        stagedDirectory,
        stagedIdentity,
      );
      return {
        changes: [],
        warnings: restoreWarning ? [restoreWarning] : [],
        imported: 0,
        alreadyImported: 0,
        removedSource: false,
      };
    }
    if (!preview.bounded) {
      const restoreWarning = restoreStagedLegacyDirectory(
        originalDirectory,
        stagedDirectory,
        stagedIdentity,
      );
      return {
        changes: [],
        warnings: [
          `Governed receipt migration refused ${preview.fileCount} files (${preview.totalBytes} bytes); limits are ${LEGACY_RECEIPT_MAX_FILES} files and ${LEGACY_RECEIPT_MAX_TOTAL_BYTES} bytes.`,
          ...(restoreWarning ? [restoreWarning] : []),
        ],
        imported: 0,
        alreadyImported: 0,
        removedSource: false,
      };
    }

    const entries = fs.readdirSync(workingDirectory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .toSorted();
    const unsupportedEntries = entries
      .filter((entry) => !entry.isFile() || !entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .toSorted();
    const warnings = unsupportedEntries.map(
      (name) =>
        `Kept legacy governed receipt directory because it contains unsupported entry ${name}.`,
    );
    const importedFiles = new Map<string, ImportedLegacyFileEvidence>();
    let imported = 0;
    let alreadyImported = 0;
    const sourceDigest = createHash("sha256");
    for (const name of files) {
      const pathname = path.join(workingDirectory, name);
      const opened = safeWorkingRoot
        ? await safeWorkingRoot.read(name)
        : { buffer: fs.readFileSync(pathname), stat: fs.statSync(pathname) };
      const stat = opened.stat;
      if (!stat.isFile() || stat.size <= 0 || stat.size > LEGACY_RECEIPT_MAX_BYTES) {
        warnings.push(`Skipped invalid legacy governed receipt ${name}.`);
        continue;
      }
      const body = opened.buffer;
      const payloadSha256 = createHash("sha256").update(body).digest("hex");
      sourceDigest.update(name).update("\0").update(payloadSha256).update("\n");
      let legacy: LegacyFalseCloseoutReceipt;
      try {
        legacy = JSON.parse(body.toString("utf8")) as LegacyFalseCloseoutReceipt;
      } catch {
        warnings.push(`Skipped unreadable legacy governed receipt ${name}.`);
        continue;
      }
      if (!isLegacyFalseCloseoutReceipt(legacy)) {
        warnings.push(`Skipped unsupported legacy governed receipt ${name}.`);
        continue;
      }
      const createdAt = parseLegacyTimestamp(
        legacy.decision.evaluatedAt ?? legacy.writtenAt,
        stat.mtimeMs,
      );
      const committed = commitGovernedMissionLedgerToSqlite(
        {
          receipt: {
            receiptId: `legacy:false-closeout:${hash(legacy.decision.decisionId).slice(0, 40)}`,
            missionId: legacy.decision.missionId,
            operation: "legacyFalseCloseoutImport",
            receiptKind: "legacy_import",
            decision: legacy.decision.allowed ? "allowed" : "denied",
            reasonCode: legacy.decision.rejectionCodes?.[0] ?? legacy.decision.state,
            planRevisionId: legacy.decision.planRevisionId,
            payloadSha256,
            producer: "openclaw.doctor.governed_receipt_migration",
            idempotencyKey: `legacy:false-closeout:${legacy.decision.decisionId}`,
            details: {
              legacyReceipt: buildFalseCloseoutLedgerDetails(legacy),
              sourceSha256: payloadSha256,
            },
            createdAt,
          },
        },
        params.stateDbPath ? { path: params.stateDbPath } : undefined,
      );
      if (committed.status === "idempotency_conflict") {
        warnings.push(`Legacy governed receipt changed after an earlier import: ${name}.`);
        continue;
      }
      if (committed.status === "revision_conflict") {
        warnings.push(`Legacy governed receipt unexpectedly hit a revision conflict: ${name}.`);
        continue;
      }
      if (committed.status === "already_applied") {
        alreadyImported += 1;
      } else {
        imported += 1;
      }
      importedFiles.set(name, {
        payloadSha256,
        dev: stat.dev,
        ino: stat.ino,
      });
    }

    let removedSource = false;
    if (params.removeSource && warnings.length === 0 && importedFiles.size === files.length) {
      for (const [name, importedEvidence] of importedFiles) {
        if (stagedIdentity) {
          assertMigrationDirectoryIdentity(workingDirectory, stagedIdentity);
        }
        let current: { buffer: Buffer; stat: fs.Stats };
        try {
          current = safeWorkingRoot
            ? await safeWorkingRoot.read(name)
            : {
                buffer: fs.readFileSync(path.join(workingDirectory, name)),
                stat: fs.statSync(path.join(workingDirectory, name)),
              };
        } catch {
          warnings.push(
            `Kept the staged legacy governed receipt snapshot because ${name} disappeared during migration.`,
          );
          break;
        }
        const currentSha256 = createHash("sha256").update(current.buffer).digest("hex");
        if (
          !sameLegacyFileIdentity(current.stat, importedEvidence) ||
          currentSha256 !== importedEvidence.payloadSha256
        ) {
          warnings.push(
            `Kept legacy governed receipt ${name} because it changed during migration.`,
          );
          break;
        }
        // Keep the identity/content check adjacent to removal. A separate
        // preflight loop lets an open writer change imported bytes before unlink.
        if (safeWorkingRoot) {
          await safeWorkingRoot.remove(name);
        } else {
          fs.unlinkSync(path.join(workingDirectory, name));
        }
      }
    }
    if (params.removeSource && warnings.length === 0 && importedFiles.size === files.length) {
      if (stagedIdentity) {
        assertMigrationDirectoryIdentity(workingDirectory, stagedIdentity);
      }
      if (fs.readdirSync(workingDirectory).length === 0) {
        fs.rmdirSync(workingDirectory);
      }
      if (fs.existsSync(originalDirectory)) {
        warnings.push(
          "A legacy governed receipt source reappeared during migration; it was left intact for a later import.",
        );
      } else {
        removedSource = true;
      }
    } else if (stagedDirectory) {
      const restoreWarning = restoreStagedLegacyDirectory(
        originalDirectory,
        stagedDirectory,
        stagedIdentity,
      );
      if (restoreWarning) {
        warnings.push(restoreWarning);
      }
    }

    const finishedAt = params.now ?? Date.now();
    const runId = randomUUID();
    const status = warnings.length > 0 ? "warning" : "completed";
    recordOpenClawStateMigrationRun({
      id: runId,
      ...(params.stateDbPath ? { path: params.stateDbPath } : {}),
      startedAt: finishedAt,
      finishedAt,
      status,
      report: { migrationKind: MIGRATION_KIND, imported, alreadyImported, removedSource, warnings },
    });
    recordOpenClawStateMigrationSource({
      ...(params.stateDbPath ? { path: params.stateDbPath } : {}),
      runId,
      migrationKind: MIGRATION_KIND,
      sourceKey: `${MIGRATION_KIND}:${hash(path.resolve(params.directory))}`,
      sourcePath: params.directory,
      targetTable: "governed_mission_receipts",
      status,
      importedAt: finishedAt,
      removedSource,
      sourceSha256: sourceDigest.digest("hex"),
      sourceRecordCount: files.length,
      report: { imported, alreadyImported, warnings },
    });
    return {
      changes:
        imported + alreadyImported > 0
          ? [
              `Governed receipts: ${imported} imported, ${alreadyImported} already present in shared SQLite state.`,
            ]
          : [],
      warnings,
      imported,
      alreadyImported,
      removedSource,
    };
  } catch (error) {
    const restoreWarning = restoreStagedLegacyDirectory(
      originalDirectory,
      stagedDirectory,
      stagedIdentity,
    );
    if (restoreWarning) {
      throw new Error(restoreWarning, { cause: error });
    }
    throw error;
  }
}

function isNormalDirectory(directory: string): boolean {
  const stat = fs.lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function sameLegacyFileIdentity(
  current: fs.Stats,
  imported: Pick<fs.Stats, "dev" | "ino">,
): boolean {
  if (current.ino !== imported.ino) {
    return false;
  }
  return (
    current.dev === imported.dev ||
    (process.platform === "win32" && (current.dev === 0 || imported.dev === 0))
  );
}

function assertMigrationDirectoryIdentity(directory: string, expected: fs.Stats): void {
  const current = fs.lstatSync(directory);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error("governed receipt migration staging directory changed during migration");
  }
}

function restoreStagedLegacyDirectory(
  originalDirectory: string,
  stagedDirectory: string | undefined,
  expectedIdentity: fs.Stats | undefined,
): string | undefined {
  if (!stagedDirectory || !fs.existsSync(stagedDirectory)) {
    return undefined;
  }
  if (fs.existsSync(originalDirectory)) {
    return `Kept staged legacy governed receipts at ${stagedDirectory} because the source path reappeared during migration.`;
  }
  if (expectedIdentity) {
    try {
      assertMigrationDirectoryIdentity(stagedDirectory, expectedIdentity);
    } catch {
      return `Refused to restore changed legacy governed receipt staging path ${stagedDirectory}.`;
    }
  }
  fs.renameSync(stagedDirectory, originalDirectory);
  return undefined;
}

function isLegacyFalseCloseoutReceipt(value: unknown): value is LegacyFalseCloseoutReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const receipt = value as Partial<LegacyFalseCloseoutReceipt>;
  const decision = receipt.decision as Partial<LegacyFalseCloseoutReceipt["decision"]> | undefined;
  return (
    receipt.schema === "openclaw.false_closeout_admission_decision_receipt.v1" &&
    Boolean(decision) &&
    typeof decision?.decisionId === "string" &&
    typeof decision.missionId === "string" &&
    typeof decision.state === "string" &&
    typeof decision.allowed === "boolean" &&
    (decision.planRevisionId === undefined || typeof decision.planRevisionId === "string") &&
    (decision.mode === undefined || typeof decision.mode === "string") &&
    (decision.evaluatedAt === undefined || typeof decision.evaluatedAt === "string") &&
    (decision.rejectionCodes === undefined ||
      (Array.isArray(decision.rejectionCodes) &&
        decision.rejectionCodes.every((code) => typeof code === "string"))) &&
    (receipt.writtenAt === undefined || typeof receipt.writtenAt === "string")
  );
}

function parseLegacyTimestamp(value: string | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Math.trunc(fallback);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
