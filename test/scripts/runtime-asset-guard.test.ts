import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ensureRuntimeAssets,
  restoreControlUiFromSnapshotIfMissing,
  restoreRuntimeAssets,
  resolveRuntimeGuardRootDir,
  scanRuntimeInternalImports,
  snapshotRuntimeAssets,
  validateRuntimeAssets,
} from "../../scripts/runtime-asset-guard.mjs";

function makeTempRoot() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-guard-"));
  return {
    rootDir: path.join(tempDir, "repo"),
    backupRoot: path.join(tempDir, "backup"),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

function writeRuntimeAssets(rootDir: string) {
  fs.mkdirSync(path.join(rootDir, "dist", "control-ui"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "dist", "plugin-sdk"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "dist-runtime"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "dist", "index.js"), "console.log('index');\n");
  fs.writeFileSync(path.join(rootDir, "dist", "entry.js"), "console.log('entry');\n");
  fs.writeFileSync(
    path.join(rootDir, "dist", "build-info.json"),
    `${JSON.stringify({
      version: "test",
      commit: "abc123",
      builtAt: "2026-06-27T00:00:00.000Z",
    })}\n`,
  );
  fs.writeFileSync(path.join(rootDir, "dist", "plugin-sdk", "state-paths.js"), "export {};\n");
  fs.writeFileSync(path.join(rootDir, "dist", "plugin-sdk", "reply-payload.js"), "export {};\n");
  fs.writeFileSync(path.join(rootDir, "dist", "control-ui", "index.html"), "<!doctype html>\n");
  fs.writeFileSync(path.join(rootDir, "dist-runtime", "marker.js"), "console.log('runtime');\n");
}

function writeDistFile(rootDir: string, relativePath: string, source: string) {
  const filePath = path.join(rootDir, "dist", relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("runtime asset guard", () => {
  it("defaults to the repo root inferred from the guard script instead of cwd", () => {
    expect(resolveRuntimeGuardRootDir()).toBe(REPO_ROOT);
    expect(resolveRuntimeGuardRootDir({ cwdRoot: true })).toBe(process.cwd());
  });

  it("reports runtime_guard_root_mismatch when the checked root is not the expected gateway root", () => {
    const { rootDir, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      const validation = validateRuntimeAssets({
        rootDir,
        expectedRoot: path.join(rootDir, "different-root"),
        operation: "service prestart",
      });

      expect(validation.ok).toBe(false);
      expect(validation.blocker).toBe("runtime_guard_root_mismatch");
      expect(validation.rootMismatch).toMatchObject({
        blocker: "runtime_guard_root_mismatch",
        operation: "service prestart",
        rootDir,
        expectedRoot: path.join(rootDir, "different-root"),
      });
    } finally {
      cleanup();
    }
  });

  it("validates required runtime and UI assets", () => {
    const { rootDir, backupRoot, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      expect(validateRuntimeAssets({ rootDir, backupRoot, requireUi: true })).toMatchObject({
        ok: true,
        missing: [],
      });

      fs.rmSync(path.join(rootDir, "dist", "control-ui"), { recursive: true, force: true });
      expect(validateRuntimeAssets({ rootDir, backupRoot, requireUi: true })).toMatchObject({
        ok: false,
        blocker: "runtime_required_asset_missing",
        missing: ["dist/control-ui/index.html"],
      });
    } finally {
      cleanup();
    }
  });

  it("passes internal import validation for existing local runtime chunks", () => {
    const { rootDir, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      writeDistFile(
        rootDir,
        "index.js",
        [
          "import value from './chunk-a.js';",
          "import './chunk-side-effect.js';",
          "export { value as nested } from './nested/chunk-b.js';",
          "await import('./chunk-dynamic.js');",
          "console.log(value);",
        ].join("\n"),
      );
      writeDistFile(rootDir, "chunk-a.js", "export default 1;\n");
      writeDistFile(rootDir, "chunk-side-effect.js", "console.log('side effect');\n");
      writeDistFile(rootDir, "nested/chunk-b.js", "export const value = 2;\n");
      writeDistFile(rootDir, "chunk-dynamic.js", "export default 3;\n");

      expect(scanRuntimeInternalImports({ rootDir, operation: "build" })).toMatchObject({
        ok: true,
        missing: [],
      });
      expect(validateRuntimeAssets({ rootDir })).toMatchObject({ ok: true });
    } finally {
      cleanup();
    }
  });

  it("fails internal import validation with importer, missing target, specifier, and operation", () => {
    const { rootDir, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      writeDistFile(rootDir, "index.js", "import './missing-chunk.js';\n");

      const validation = validateRuntimeAssets({
        rootDir,
        operation: "production preflight",
      });

      expect(validation.ok).toBe(false);
      expect(validation.blocker).toBe("runtime_internal_import_missing");
      expect(validation.internalImports.missing).toEqual([
        {
          blocker: "runtime_internal_import_missing",
          operation: "production preflight",
          rootDir,
          importerFile: "dist/index.js",
          missingTargetFile: "dist/missing-chunk.js",
          importSpecifier: "./missing-chunk.js",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("blocks snapshot creation when active dist has a missing internal import", () => {
    const { rootDir, backupRoot, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      writeDistFile(rootDir, "entry.js", "await import('./gone-Co028f3a.js');\n");

      const snapshot = snapshotRuntimeAssets({
        rootDir,
        backupRoot,
        operation: "snapshot",
      });

      expect(snapshot.ok).toBe(false);
      expect(snapshot.blocker).toBe("runtime_internal_import_missing");
      expect(snapshot.internalImports.missing[0]).toMatchObject({
        operation: "snapshot",
        rootDir,
        importerFile: "dist/entry.js",
        missingTargetFile: "dist/gone-Co028f3a.js",
        importSpecifier: "./gone-Co028f3a.js",
      });
      expect(fs.existsSync(path.join(backupRoot, "last-known-good"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("blocks restore when last-known-good has a missing internal import", () => {
    const { rootDir, backupRoot, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      expect(snapshotRuntimeAssets({ rootDir, backupRoot, requireUi: true }).ok).toBe(true);
      fs.writeFileSync(path.join(rootDir, "dist", "index.js"), "console.log('active valid');\n");
      fs.writeFileSync(
        path.join(backupRoot, "last-known-good", "dist", "index.js"),
        "import './missing-from-backup.js';\n",
      );

      const restore = restoreRuntimeAssets({ rootDir, backupRoot, operation: "restore" });

      expect(restore.ok).toBe(false);
      expect(restore.blocker).toBe("runtime_internal_import_missing");
      expect(restore.internalImports.missing[0]).toMatchObject({
        operation: "restore",
        rootDir: path.join(backupRoot, "last-known-good"),
        importerFile: "dist/index.js",
        missingTargetFile: "dist/missing-from-backup.js",
        importSpecifier: "./missing-from-backup.js",
      });
      expect(fs.readFileSync(path.join(rootDir, "dist", "index.js"), "utf8")).toContain(
        "active valid",
      );
    } finally {
      cleanup();
    }
  });

  it("validates plugin-sdk aliases that resolve into dist", () => {
    const { rootDir, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      writeDistFile(rootDir, "index.js", "import 'openclaw/plugin-sdk/state-paths.js';\n");
      writeDistFile(rootDir, "plugin-sdk/state-paths.js", "export const statePaths = true;\n");
      expect(validateRuntimeAssets({ rootDir }).ok).toBe(true);

      fs.rmSync(path.join(rootDir, "dist", "plugin-sdk", "state-paths.js"));
      const validation = validateRuntimeAssets({ rootDir, operation: "recovery" });
      expect(validation.ok).toBe(false);
      expect(validation.internalImports.missing[0]).toMatchObject({
        operation: "recovery",
        rootDir,
        importerFile: "dist/index.js",
        missingTargetFile: "dist/plugin-sdk/state-paths.js",
        importSpecifier: "openclaw/plugin-sdk/state-paths.js",
      });
    } finally {
      cleanup();
    }
  });

  it("requires parseable build-info with runtime identity fields", () => {
    const { rootDir, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      fs.writeFileSync(path.join(rootDir, "dist", "build-info.json"), "{ nope\n");

      const validation = validateRuntimeAssets({ rootDir, operation: "restart preflight" });

      expect(validation.ok).toBe(false);
      expect(validation.blocker).toBe("runtime_build_info_invalid");
      expect(validation.buildInfo).toMatchObject({
        ok: false,
        blocker: "runtime_build_info_invalid",
        operation: "restart preflight",
        path: "dist/build-info.json",
      });
    } finally {
      cleanup();
    }
  });

  it("requires plugin-sdk runtime files used by live extensions", () => {
    const { rootDir, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      fs.rmSync(path.join(rootDir, "dist", "plugin-sdk", "reply-payload.js"));

      const validation = validateRuntimeAssets({ rootDir, operation: "restart preflight" });

      expect(validation.ok).toBe(false);
      expect(validation.blocker).toBe("runtime_required_asset_missing");
      expect(validation.missing).toEqual(["dist/plugin-sdk/reply-payload.js"]);
    } finally {
      cleanup();
    }
  });

  it("restores last-known-good runtime after active dist disappears", () => {
    const { rootDir, backupRoot, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      expect(snapshotRuntimeAssets({ rootDir, backupRoot, requireUi: true }).ok).toBe(true);

      fs.rmSync(path.join(rootDir, "dist"), { recursive: true, force: true });
      fs.rmSync(path.join(rootDir, "dist-runtime"), { recursive: true, force: true });
      const restore = restoreRuntimeAssets({ rootDir, backupRoot, requireUi: true });

      expect(restore.ok).toBe(true);
      expect(validateRuntimeAssets({ rootDir, backupRoot, requireUi: true }).ok).toBe(true);
      expect(fs.existsSync(path.join(rootDir, "dist-runtime", "marker.js"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("restores from the newest valid previous backup when last-known-good is invalid", () => {
    const { rootDir, backupRoot, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      expect(snapshotRuntimeAssets({ rootDir, backupRoot, requireUi: true }).ok).toBe(true);
      const latestRoot = path.join(backupRoot, "last-known-good");
      const previousRoot = path.join(backupRoot, "previous-9999-valid");
      fs.cpSync(latestRoot, previousRoot, { recursive: true });
      fs.rmSync(path.join(latestRoot, "dist", "build-info.json"));

      fs.rmSync(path.join(rootDir, "dist"), { recursive: true, force: true });
      fs.rmSync(path.join(rootDir, "dist-runtime"), { recursive: true, force: true });
      const restore = restoreRuntimeAssets({ rootDir, backupRoot, requireUi: true });

      expect(restore.ok).toBe(true);
      expect(restore.sourceBackupLabel).toBe("previous-9999-valid");
      expect(restore.invalidBackups).toEqual([
        expect.objectContaining({
          label: "last-known-good",
          blocker: "runtime_required_asset_missing",
          missing: ["dist/build-info.json"],
        }),
      ]);
      expect(validateRuntimeAssets({ rootDir, backupRoot, requireUi: true }).ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("ensures assets by restoring from the snapshot", () => {
    const { rootDir, backupRoot, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      expect(snapshotRuntimeAssets({ rootDir, backupRoot, requireUi: true }).ok).toBe(true);
      fs.rmSync(path.join(rootDir, "dist", "index.js"), { force: true });

      const ensure = ensureRuntimeAssets({ rootDir, backupRoot, requireUi: true });

      expect(ensure.ok).toBe(true);
      expect(ensure.restored).toBe(true);
      expect(validateRuntimeAssets({ rootDir, backupRoot, requireUi: true }).ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("restores only Control UI when a runtime-only build omits it", () => {
    const { rootDir, backupRoot, cleanup } = makeTempRoot();
    try {
      writeRuntimeAssets(rootDir);
      expect(snapshotRuntimeAssets({ rootDir, backupRoot, requireUi: true }).ok).toBe(true);
      fs.rmSync(path.join(rootDir, "dist", "control-ui"), { recursive: true, force: true });
      fs.writeFileSync(path.join(rootDir, "dist", "index.js"), "console.log('new index');\n");

      const restore = restoreControlUiFromSnapshotIfMissing({ rootDir, backupRoot });

      expect(restore.ok).toBe(true);
      expect(restore.restored).toBe(true);
      expect(fs.readFileSync(path.join(rootDir, "dist", "index.js"), "utf8")).toContain(
        "new index",
      );
      expect(validateRuntimeAssets({ rootDir, backupRoot, requireUi: true }).ok).toBe(true);
    } finally {
      cleanup();
    }
  });
});
