import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  closeTaskFlowRegistryDatabase,
  findGovernedMissionReceiptByIdempotencyFromSqlite,
} from "../tasks/task-flow-registry.store.sqlite.js";
import {
  inspectLegacyFalseCloseoutReceipts,
  migrateLegacyFalseCloseoutReceipts,
} from "./governed-mission-legacy-migration.js";

let root: string;
let decisionDir: string;
let stateDbPath: string;

function writeLegacyReceipt(name = "decision.json"): string {
  fs.mkdirSync(decisionDir, { recursive: true });
  const pathname = path.join(decisionDir, name);
  fs.writeFileSync(
    pathname,
    `${JSON.stringify({
      schema: "openclaw.false_closeout_admission_decision_receipt.v1",
      writtenAt: "2026-09-01T00:00:00.000Z",
      decision: {
        decisionId: "decision-1",
        missionId: "mission-1",
        planRevisionId: "plan-1",
        mode: "enforce",
        state: "REJECTED",
        allowed: false,
        rejectionCodes: ["FCAC_ARTIFACT_MISSING"],
        evaluatedAt: "2026-09-01T00:00:00.000Z",
      },
    })}\n`,
  );
  return pathname;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "governed-receipt-migration-"));
  decisionDir = path.join(root, "workspace", "var", "false_closeout_admission", "decisions");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  stateDbPath = resolveOpenClawStateSqlitePath(process.env);
});

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  closeTaskFlowRegistryDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("governed mission legacy receipt migration", () => {
  it("imports a legacy receipt idempotently into SQLite", async () => {
    writeLegacyReceipt();
    expect(inspectLegacyFalseCloseoutReceipts(decisionDir)).toMatchObject({
      present: true,
      fileCount: 1,
      bounded: true,
    });

    const first = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: false,
      now: 1,
    });
    const second = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: false,
      now: 2,
    });

    expect(first).toMatchObject({ imported: 1, alreadyImported: 0, warnings: [] });
    expect(second).toMatchObject({ imported: 0, alreadyImported: 1, warnings: [] });
    expect(
      findGovernedMissionReceiptByIdempotencyFromSqlite({
        missionId: "mission-1",
        idempotencyKey: "legacy:false-closeout:decision-1",
      }),
    ).toMatchObject({
      receiptKind: "legacy_import",
      decision: "denied",
      reasonCode: "FCAC_ARTIFACT_MISSING",
      details: {
        legacyReceipt: {
          auditReceipt: {
            schema: "openclaw.false_closeout_admission_decision_receipt.v1",
            decision: {
              decisionId: "decision-1",
              rejectionCodes: ["FCAC_ARTIFACT_MISSING"],
            },
          },
        },
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
  });

  it("keeps all source files when any legacy receipt is corrupt", async () => {
    const validPath = writeLegacyReceipt();
    const corruptPath = path.join(decisionDir, "corrupt.json");
    fs.writeFileSync(corruptPath, "not-json\n");

    const result = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: true,
      now: 1,
    });

    expect(result).toMatchObject({ imported: 1, removedSource: false });
    expect(result.warnings).toEqual(["Skipped unreadable legacy governed receipt corrupt.json."]);
    expect(fs.existsSync(validPath)).toBe(true);
    expect(fs.existsSync(corruptPath)).toBe(true);
  });

  it("keeps the complete source directory when it contains an unrelated entry", async () => {
    const validPath = writeLegacyReceipt();
    const unrelatedPath = path.join(decisionDir, "README.txt");
    fs.writeFileSync(unrelatedPath, "operator note\n");

    const result = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: true,
      now: 1,
    });

    expect(result).toMatchObject({ imported: 1, removedSource: false });
    expect(result.warnings).toEqual([
      "Kept legacy governed receipt directory because it contains unsupported entry README.txt.",
    ]);
    expect(fs.existsSync(validPath)).toBe(true);
    expect(fs.existsSync(unrelatedPath)).toBe(true);
  });

  it("removes the exact legacy receipt directory only after a complete import", async () => {
    writeLegacyReceipt();

    const result = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: true,
      now: 1,
    });

    expect(result).toMatchObject({ imported: 1, warnings: [], removedSource: true });
    expect(fs.existsSync(decisionDir)).toBe(false);
  });

  it("resumes an interrupted destructive migration from its deterministic staging path", async () => {
    writeLegacyReceipt();
    const stagingDirectory = `${decisionDir}.openclaw-migrating`;
    fs.renameSync(decisionDir, stagingDirectory);

    const result = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: true,
      now: 1,
    });

    expect(result).toMatchObject({ imported: 1, warnings: [], removedSource: true });
    expect(fs.existsSync(stagingDirectory)).toBe(false);
    expect(fs.existsSync(decisionDir)).toBe(false);
  });

  it("clears an empty recovery stage before migrating a recreated source", async () => {
    const stagingDirectory = `${decisionDir}.openclaw-migrating`;
    fs.mkdirSync(stagingDirectory, { recursive: true });
    writeLegacyReceipt();

    const result = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: true,
      now: 1,
    });

    expect(result).toMatchObject({ imported: 1, warnings: [], removedSource: true });
    expect(fs.existsSync(stagingDirectory)).toBe(false);
    expect(fs.existsSync(decisionDir)).toBe(false);
  });

  it("cleans an empty recovery stage when no source remains", async () => {
    const stagingDirectory = `${decisionDir}.openclaw-migrating`;
    fs.mkdirSync(stagingDirectory, { recursive: true });

    const result = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: true,
      now: 1,
    });

    expect(result).toMatchObject({ imported: 0, warnings: [], removedSource: false });
    expect(fs.existsSync(stagingDirectory)).toBe(false);
  });

  it("restores the source path when an ordinary migration operation throws", async () => {
    const receiptPath = writeLegacyReceipt();
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw new Error("simulated read failure");
    });

    await expect(
      migrateLegacyFalseCloseoutReceipts({
        directory: decisionDir,
        stateDbPath,
        removeSource: true,
        now: 1,
      }),
    ).rejects.toThrow("simulated read failure");
    expect(fs.existsSync(receiptPath)).toBe(true);
    expect(fs.existsSync(`${decisionDir}.openclaw-migrating`)).toBe(false);
  });

  it("preserves receipts written to a recreated legacy source during migration", async () => {
    writeLegacyReceipt();
    let replacementPath: string | undefined;
    let opened = 0;
    __setFsSafeTestHooksForTest({
      beforeOpen: () => {
        opened += 1;
        if (opened === 2 && !replacementPath) {
          replacementPath = writeLegacyReceipt("replacement.json");
        }
      },
    });

    const result = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: true,
      now: 1,
    });

    expect(result).toMatchObject({ imported: 1, removedSource: false });
    expect(result.warnings).toEqual([
      "A legacy governed receipt source reappeared during migration; it was left intact for a later import.",
    ]);
    expect(replacementPath && fs.existsSync(replacementPath)).toBe(true);
  });

  it("keeps a staged receipt whose content changes immediately before removal", async () => {
    writeLegacyReceipt();
    const stagingDirectory = `${decisionDir}.openclaw-migrating`;
    const stagedReceiptPath = path.join(stagingDirectory, "decision.json");
    const lstatSync = fs.lstatSync.bind(fs);
    let opened = 0;
    let changed = false;
    __setFsSafeTestHooksForTest({
      afterOpen: () => {
        opened += 1;
      },
    });
    vi.spyOn(fs, "lstatSync").mockImplementation((pathname) => {
      if (!changed && opened >= 1 && String(pathname) === stagingDirectory) {
        fs.appendFileSync(stagedReceiptPath, " ");
        changed = true;
      }
      return lstatSync(pathname);
    });

    const result = await migrateLegacyFalseCloseoutReceipts({
      directory: decisionDir,
      stateDbPath,
      removeSource: true,
      now: 1,
    });

    expect(changed).toBe(true);
    expect(result).toMatchObject({ imported: 1, removedSource: false });
    expect(result.warnings).toEqual([
      "Kept legacy governed receipt decision.json because it changed during migration.",
    ]);
    expect(fs.existsSync(path.join(decisionDir, "decision.json"))).toBe(true);
  });

  it("refuses a staging directory replaced after the source rename", async () => {
    writeLegacyReceipt();
    const outsideDir = path.join(root, "outside");
    const outsidePath = path.join(outsideDir, "outside.json");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsidePath, "outside\n");
    const renameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      renameSync(from, to);
      fs.renameSync(String(to), `${String(to)}.displaced`);
      fs.symlinkSync(outsideDir, String(to), "dir");
    });

    await expect(
      migrateLegacyFalseCloseoutReceipts({
        directory: decisionDir,
        stateDbPath,
        removeSource: true,
        now: 1,
      }),
    ).rejects.toThrow("Refused to restore changed legacy governed receipt staging path");
    expect(fs.readFileSync(outsidePath, "utf8")).toBe("outside\n");
  });
});
