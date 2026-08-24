#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initSync as initModuleLexer, parse as parseModuleImports } from "es-module-lexer";

const DEFAULT_BACKUP_ROOT = path.join(
  os.homedir(),
  ".openclaw",
  "runtime-backups",
  "openclaw-source",
);

const RUNTIME_ASSETS = [
  "dist/index.js",
  "dist/entry.js",
  "dist/build-info.json",
  "dist/plugin-sdk/state-paths.js",
  "dist/plugin-sdk/reply-payload.js",
];
const UI_ASSETS = ["dist/control-ui/index.html"];
const BACKUP_ROOT_NAMES = ["dist", "dist-runtime"];
const DEFAULT_PREVIOUS_BACKUP_RETENTION = 5;
const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MIN_FREE_INODES = 25_000;
const INTERNAL_IMPORT_MISSING_BLOCKER = "runtime_internal_import_missing";
const REQUIRED_ASSET_MISSING_BLOCKER = "runtime_required_asset_missing";
const BUILD_INFO_BLOCKER = "runtime_build_info_invalid";
const ROOT_MISMATCH_BLOCKER = "runtime_guard_root_mismatch";
const BACKUP_RESOURCE_BLOCKER = "runtime_backup_resource_limit";
const BACKUP_LOCK_BLOCKER = "runtime_backup_snapshot_in_progress";
const VALIDATION_OPERATION_DEFAULT = "production preflight";
const PLUGIN_SDK_ALIAS_PREFIXES = [
  "openclaw/plugin-sdk/",
  "@openclaw/plugin-sdk/",
  "plugin-sdk/",
  "/plugin-sdk/",
];
let moduleLexerReady = false;
const SCRIPT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function nowStamp() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
}

function mkdirRecursiveWithParentRetry(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    fs.mkdirSync(path.dirname(dirPath), { recursive: true });
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolvePreviousBackupRetention(params = {}) {
  return parseNonNegativeInteger(
    params.previousRetention ?? process.env.OPENCLAW_RUNTIME_GUARD_PREVIOUS_RETENTION,
    DEFAULT_PREVIOUS_BACKUP_RETENTION,
  );
}

function resolveResourceLimits(params = {}) {
  return {
    previousRetention: resolvePreviousBackupRetention(params),
    minFreeBytes: parseNonNegativeInteger(
      params.minFreeBytes ?? process.env.OPENCLAW_RUNTIME_GUARD_MIN_FREE_BYTES,
      DEFAULT_MIN_FREE_BYTES,
    ),
    minFreeInodes: parseNonNegativeInteger(
      params.minFreeInodes ?? process.env.OPENCLAW_RUNTIME_GUARD_MIN_FREE_INODES,
      DEFAULT_MIN_FREE_INODES,
    ),
    maxSnapshotBytes: parseNonNegativeInteger(
      params.maxSnapshotBytes ?? process.env.OPENCLAW_RUNTIME_GUARD_MAX_SNAPSHOT_BYTES,
      Number.POSITIVE_INFINITY,
    ),
    maxSnapshotEntries: parseNonNegativeInteger(
      params.maxSnapshotEntries ?? process.env.OPENCLAW_RUNTIME_GUARD_MAX_SNAPSHOT_ENTRIES,
      Number.POSITIVE_INFINITY,
    ),
    maxPreviousBytes: parseNonNegativeInteger(
      params.maxPreviousBytes ?? process.env.OPENCLAW_RUNTIME_GUARD_MAX_PREVIOUS_BYTES,
      Number.POSITIVE_INFINITY,
    ),
    maxPreviousEntries: parseNonNegativeInteger(
      params.maxPreviousEntries ?? process.env.OPENCLAW_RUNTIME_GUARD_MAX_PREVIOUS_ENTRIES,
      Number.POSITIVE_INFINITY,
    ),
  };
}

export function resolveRuntimeGuardRootDir(params = {}) {
  if (params.rootDir) {
    return path.resolve(params.rootDir);
  }
  if (process.env.OPENCLAW_RUNTIME_GUARD_ROOT) {
    return path.resolve(process.env.OPENCLAW_RUNTIME_GUARD_ROOT);
  }
  if (params.cwdRoot === true) {
    return process.cwd();
  }
  return path.resolve(params.inferredRootDir ?? SCRIPT_ROOT_DIR);
}

function resolveRootDir(params = {}) {
  return resolveRuntimeGuardRootDir(params);
}

function resolveExpectedRootDir(params = {}) {
  const expectedRoot =
    params.expectedRoot ??
    (Object.prototype.hasOwnProperty.call(params, "rootDir")
      ? undefined
      : process.env.OPENCLAW_RUNTIME_GUARD_EXPECTED_ROOT);
  return expectedRoot ? path.resolve(expectedRoot) : undefined;
}

function resolveBackupRoot(params = {}) {
  return path.resolve(
    params.backupRoot ?? process.env.OPENCLAW_RUNTIME_GUARD_BACKUP_ROOT ?? DEFAULT_BACKUP_ROOT,
  );
}

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function requiredAssets(params = {}) {
  const runtimeAssets =
    params.validateBuildInfo === false
      ? RUNTIME_ASSETS.filter((asset) => asset !== "dist/build-info.json")
      : RUNTIME_ASSETS;
  return params.requireUi ? [...runtimeAssets, ...UI_ASSETS] : [...runtimeAssets];
}

function validateBuildInfo({ rootDir, operation }) {
  const buildInfoPath = path.join(rootDir, "dist", "build-info.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
    const commit = typeof parsed.commit === "string" ? parsed.commit.trim() : "";
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    const builtAt = typeof parsed.builtAt === "string" ? parsed.builtAt.trim() : "";
    const missing = [];
    if (!commit) {
      missing.push("commit");
    }
    if (!version) {
      missing.push("version");
    }
    if (!builtAt) {
      missing.push("builtAt");
    }
    if (missing.length > 0) {
      return {
        ok: false,
        blocker: BUILD_INFO_BLOCKER,
        operation,
        rootDir,
        path: "dist/build-info.json",
        reason: `missing ${missing.join(", ")}`,
      };
    }
    return { ok: true, commit, version, builtAt };
  } catch (error) {
    return {
      ok: false,
      blocker: BUILD_INFO_BLOCKER,
      operation,
      rootDir,
      path: "dist/build-info.json",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateRootMatch({ rootDir, operation, expectedRoot }) {
  if (!expectedRoot || path.resolve(rootDir) === path.resolve(expectedRoot)) {
    return undefined;
  }
  return {
    blocker: ROOT_MISMATCH_BLOCKER,
    operation,
    rootDir,
    expectedRoot: path.resolve(expectedRoot),
  };
}

function normalizeOperation(params = {}, fallback = VALIDATION_OPERATION_DEFAULT) {
  return typeof params.operation === "string" && params.operation.trim()
    ? params.operation.trim()
    : fallback;
}

function relativeRuntimePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function isPathInside(parentDir, candidatePath) {
  const relativePath = path.relative(parentDir, candidatePath);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function listJsFiles(rootDir) {
  const distDir = path.join(rootDir, "dist");
  if (!fs.existsSync(distDir)) {
    return [];
  }

  const files = [];
  const visit = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        visit(filePath);
      } else if (dirent.isFile() && filePath.endsWith(".js")) {
        files.push(filePath);
      }
    }
  };
  visit(distDir);
  files.sort();
  return files;
}

function extractImportSpecifiers(source) {
  if (!moduleLexerReady) {
    initModuleLexer();
    moduleLexerReady = true;
  }
  const [imports] = parseModuleImports(source);
  const specifiers = [];
  for (const record of imports) {
    if (typeof record.n === "string" && record.n.trim()) {
      specifiers.push(record.n.trim());
    }
  }
  return specifiers;
}

function resolvePluginSdkAlias(specifier, distDir) {
  for (const prefix of PLUGIN_SDK_ALIAS_PREFIXES) {
    if (specifier.startsWith(prefix)) {
      return path.join(distDir, "plugin-sdk", specifier.slice(prefix.length));
    }
  }
  return undefined;
}

function candidateImportTargets(baseTarget) {
  if (path.extname(baseTarget)) {
    return [baseTarget];
  }
  return [
    baseTarget,
    `${baseTarget}.js`,
    `${baseTarget}.mjs`,
    `${baseTarget}.cjs`,
    path.join(baseTarget, "index.js"),
  ];
}

function existingFileFromCandidates(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep looking; the caller reports the first candidate if none exist.
    }
  }
  return undefined;
}

function resolveImportTarget({ importerFile, specifier, distDir }) {
  let baseTarget;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    baseTarget = path.resolve(path.dirname(importerFile), specifier);
  } else {
    baseTarget = resolvePluginSdkAlias(specifier, distDir);
  }
  if (!baseTarget || !isPathInside(distDir, baseTarget)) {
    return undefined;
  }

  const candidates = candidateImportTargets(baseTarget);
  return {
    expectedTarget: existingFileFromCandidates(candidates) ?? candidates[0],
    exists: Boolean(existingFileFromCandidates(candidates)),
  };
}

export function scanRuntimeInternalImports(params = {}) {
  const rootDir = resolveRootDir(params);
  const operation = normalizeOperation(params);
  const distDir = path.join(rootDir, "dist");
  const missing = [];
  const checkedFiles = [];

  for (const importerFile of listJsFiles(rootDir)) {
    checkedFiles.push(relativeRuntimePath(rootDir, importerFile));
    const source = fs.readFileSync(importerFile, "utf8");
    for (const importSpecifier of extractImportSpecifiers(source)) {
      const target = resolveImportTarget({ importerFile, specifier: importSpecifier, distDir });
      if (!target || target.exists) {
        continue;
      }
      missing.push({
        blocker: INTERNAL_IMPORT_MISSING_BLOCKER,
        operation,
        rootDir,
        importerFile: relativeRuntimePath(rootDir, importerFile),
        missingTargetFile: relativeRuntimePath(rootDir, target.expectedTarget),
        importSpecifier,
      });
    }
  }

  return {
    ok: missing.length === 0,
    operation,
    checkedFiles,
    missing,
  };
}

export function validateRuntimeAssets(params = {}) {
  const rootDir = resolveRootDir(params);
  const operation = normalizeOperation(params);
  const expectedRoot = resolveExpectedRootDir(params);
  const rootMismatch = validateRootMatch({ rootDir, operation, expectedRoot });
  const missing = [];
  for (const relativePath of requiredAssets(params)) {
    if (!isNonEmptyFile(path.join(rootDir, relativePath))) {
      missing.push(relativePath);
    }
  }
  const buildInfo =
    missing.includes("dist/build-info.json") || params.validateBuildInfo === false
      ? undefined
      : validateBuildInfo({ rootDir, operation });
  const internalImports = scanRuntimeInternalImports({ ...params, rootDir, operation });
  return {
    ok: !rootMismatch && missing.length === 0 && (buildInfo?.ok ?? true) && internalImports.ok,
    rootDir,
    operation,
    missing,
    ...(buildInfo ? { buildInfo } : {}),
    internalImports,
    ...(rootMismatch ? { blocker: ROOT_MISMATCH_BLOCKER, rootMismatch } : {}),
    ...(!rootMismatch && missing.length > 0 ? { blocker: REQUIRED_ASSET_MISSING_BLOCKER } : {}),
    ...(!rootMismatch && missing.length === 0 && buildInfo && !buildInfo.ok
      ? { blocker: BUILD_INFO_BLOCKER }
      : {}),
    ...(!rootMismatch && missing.length === 0 && (buildInfo?.ok ?? true) && !internalImports.ok
      ? { blocker: INTERNAL_IMPORT_MISSING_BLOCKER }
      : {}),
  };
}

function copyExistingRoot({ fromRoot, toRoot, name }) {
  const source = path.join(fromRoot, name);
  if (!fs.existsSync(source)) {
    return false;
  }
  fs.cpSync(source, path.join(toRoot, name), {
    recursive: true,
    errorOnExist: false,
    force: true,
    verbatimSymlinks: true,
  });
  return true;
}

function listPreviousBackupCandidates(backupRoot) {
  try {
    return fs
      .readdirSync(backupRoot, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && dirent.name.startsWith("previous-"))
      .map((dirent) => ({ label: dirent.name, path: path.join(backupRoot, dirent.name) }))
      .sort((a, b) => b.label.localeCompare(a.label));
  } catch {
    return [];
  }
}

function cleanupPartialRuntimeBackups(backupRoot) {
  const removed = [];
  let dirents = [];
  try {
    dirents = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const isPartial =
      dirent.name.startsWith("last-known-good.tmp-") ||
      dirent.name.startsWith("last-known-good.next-") ||
      dirent.name.startsWith("partial-");
    if (!isPartial) {
      continue;
    }
    const target = path.join(backupRoot, dirent.name);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push({ label: dirent.name, path: target });
  }
  return removed;
}

function measureTree(rootPath) {
  const summary = { bytes: 0, entries: 0 };
  if (!fs.existsSync(rootPath)) {
    return summary;
  }
  const visit = (filePath) => {
    const stat = fs.lstatSync(filePath);
    summary.entries += 1;
    summary.bytes += stat.size;
    if (!stat.isDirectory()) {
      return;
    }
    for (const dirent of fs.readdirSync(filePath, { withFileTypes: true })) {
      visit(path.join(filePath, dirent.name));
    }
  };
  visit(rootPath);
  return summary;
}

function measureRuntimeRoots(rootDir) {
  const summary = { bytes: 0, entries: 0 };
  for (const name of BACKUP_ROOT_NAMES) {
    const measured = measureTree(path.join(rootDir, name));
    summary.bytes += measured.bytes;
    summary.entries += measured.entries;
  }
  return summary;
}

function getBackupStorageStats(targetPath, params = {}) {
  const statfs = params.statfs ?? fs.statfsSync;
  try {
    const stats = statfs(targetPath);
    const blockSize = Number(stats.bsize ?? stats.frsize ?? 0);
    const freeBlocks = Number(stats.bavail ?? stats.bfree ?? 0);
    const freeFiles = Number(stats.ffree ?? Number.POSITIVE_INFINITY);
    return {
      freeBytes: Number.isFinite(blockSize * freeBlocks) ? blockSize * freeBlocks : 0,
      freeInodes: Number.isFinite(freeFiles) ? freeFiles : Number.POSITIVE_INFINITY,
    };
  } catch {
    return {
      freeBytes: Number.POSITIVE_INFINITY,
      freeInodes: Number.POSITIVE_INFINITY,
    };
  }
}

function removePreviousBackup(candidate) {
  fs.rmSync(candidate.path, { recursive: true, force: true });
  return { label: candidate.label, path: candidate.path };
}

export function applyRuntimeBackupPolicy(params = {}) {
  const backupRoot = resolveBackupRoot(params);
  const limits = resolveResourceLimits(params);
  mkdirRecursiveWithParentRetry(backupRoot);
  const partialRemoved = cleanupPartialRuntimeBackups(backupRoot);
  const removed = [];
  let previous = listPreviousBackupCandidates(backupRoot);

  while (previous.length > limits.previousRetention) {
    const oldest = previous.pop();
    if (oldest) {
      removed.push(removePreviousBackup(oldest));
    }
  }

  let previousUsage = previous.reduce(
    (summary, candidate) => {
      const measured = measureTree(candidate.path);
      summary.bytes += measured.bytes;
      summary.entries += measured.entries;
      return summary;
    },
    { bytes: 0, entries: 0 },
  );

  while (
    previous.length > 0 &&
    (previousUsage.bytes > limits.maxPreviousBytes ||
      previousUsage.entries > limits.maxPreviousEntries)
  ) {
    const oldest = previous.pop();
    if (!oldest) {
      break;
    }
    const measured = measureTree(oldest.path);
    removed.push(removePreviousBackup(oldest));
    previousUsage = {
      bytes: Math.max(0, previousUsage.bytes - measured.bytes),
      entries: Math.max(0, previousUsage.entries - measured.entries),
    };
  }

  return {
    ok: true,
    action: "runtime-backup-policy",
    backupRoot,
    limits,
    partialRemoved,
    previousRemoved: removed,
    previousRemaining: listPreviousBackupCandidates(backupRoot).map((candidate) => candidate.label),
  };
}

function preflightRuntimeSnapshotResources({ rootDir, backupRoot, params = {} }) {
  const limits = resolveResourceLimits(params);
  const snapshotUsage = measureRuntimeRoots(rootDir);
  if (
    snapshotUsage.bytes > limits.maxSnapshotBytes ||
    snapshotUsage.entries > limits.maxSnapshotEntries
  ) {
    return {
      ok: false,
      blocker: BACKUP_RESOURCE_BLOCKER,
      reason: "snapshot tree exceeds configured maximum",
      limits,
      snapshotUsage,
    };
  }

  const storage = getBackupStorageStats(backupRoot, params);
  if (storage.freeBytes < limits.minFreeBytes || storage.freeInodes < limits.minFreeInodes) {
    return {
      ok: false,
      blocker: BACKUP_RESOURCE_BLOCKER,
      reason: "backup root below minimum free byte or inode reserve",
      limits,
      snapshotUsage,
      storage,
    };
  }

  return { ok: true, limits, snapshotUsage, storage };
}

function acquireSnapshotLock(backupRoot) {
  const lockPath = path.join(backupRoot, ".runtime-asset-guard.lock");
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    return {
      ok: true,
      lockPath,
      release: () => {
        try {
          fs.closeSync(fd);
        } finally {
          fs.rmSync(lockPath, { force: true });
        }
      },
    };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { ok: false, blocker: BACKUP_LOCK_BLOCKER, lockPath };
    }
    throw error;
  }
}

function moveAsideIfPresent(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return undefined;
  }
  const asidePath = `${targetPath}.broken-${nowStamp()}`;
  fs.renameSync(targetPath, asidePath);
  return asidePath;
}

function validationSummary(validation) {
  return {
    ok: validation.ok,
    missing: validation.missing,
    blocker: validation.blocker,
    buildInfo: validation.buildInfo,
    internalImports: {
      ok: validation.internalImports.ok,
      checkedFileCount: validation.internalImports.checkedFiles.length,
      missing: validation.internalImports.missing,
    },
    ...(validation.rootMismatch ? { rootMismatch: validation.rootMismatch } : {}),
  };
}

export function snapshotRuntimeAssets(params = {}) {
  const rootDir = resolveRootDir(params);
  const backupRoot = resolveBackupRoot(params);
  const operation = normalizeOperation(params, "snapshot");
  const validation = validateRuntimeAssets({
    rootDir,
    requireUi: params.requireUi ?? false,
    validateBuildInfo: params.validateBuildInfo,
    operation,
    expectedRoot: params.expectedRoot,
  });
  if (!validation.ok) {
    return {
      ok: false,
      action: "snapshot",
      rootDir,
      backupRoot,
      missing: validation.missing,
      blocker: validation.blocker,
      rootMismatch: validation.rootMismatch,
      internalImports: validation.internalImports,
    };
  }

  mkdirRecursiveWithParentRetry(backupRoot);
  const policyBefore = applyRuntimeBackupPolicy({ ...params, backupRoot });
  const resourcePreflight = preflightRuntimeSnapshotResources({ rootDir, backupRoot, params });
  if (!resourcePreflight.ok) {
    return {
      ok: false,
      action: "snapshot",
      rootDir,
      backupRoot,
      blocker: resourcePreflight.blocker,
      reason: resourcePreflight.reason,
      limits: resourcePreflight.limits,
      snapshotUsage: resourcePreflight.snapshotUsage,
      storage: resourcePreflight.storage,
      policyBefore,
    };
  }

  const lock = acquireSnapshotLock(backupRoot);
  if (!lock.ok) {
    return {
      ok: false,
      action: "snapshot",
      rootDir,
      backupRoot,
      blocker: lock.blocker,
      lockPath: lock.lockPath,
      policyBefore,
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-assets-"));
  let nextRoot;

  const copied = [];
  try {
    for (const name of BACKUP_ROOT_NAMES) {
      if (copyExistingRoot({ fromRoot: rootDir, toRoot: tempRoot, name })) {
        copied.push(name);
      }
    }
    const backupValidation = validateRuntimeAssets({
      rootDir: tempRoot,
      requireUi: params.requireUi ?? false,
      validateBuildInfo: params.validateBuildInfo,
      operation: `${operation} backup validation`,
    });
    if (!backupValidation.ok) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      return {
        ok: false,
        action: "snapshot",
        rootDir,
        backupRoot,
        copied,
        blocker: backupValidation.blocker,
        missing: backupValidation.missing,
        rootMismatch: backupValidation.rootMismatch,
        internalImports: backupValidation.internalImports,
        backupValidation,
      };
    }
    fs.writeFileSync(
      path.join(tempRoot, "runtime-asset-guard.json"),
      `${JSON.stringify(
        {
          created_at: new Date().toISOString(),
          root_dir: rootDir,
          required_assets: requiredAssets({ requireUi: params.requireUi ?? false }),
          internal_imports_checked: validation.internalImports.checkedFiles.length,
          backup_validation: validationSummary(backupValidation),
          copied_roots: copied,
        },
        null,
        2,
      )}\n`,
    );

    const latestRoot = path.join(backupRoot, "last-known-good");
    mkdirRecursiveWithParentRetry(path.dirname(latestRoot));
    nextRoot = path.join(backupRoot, `last-known-good.next-${nowStamp()}`);
    fs.cpSync(tempRoot, nextRoot, { recursive: true });
    if (fs.existsSync(latestRoot)) {
      fs.renameSync(latestRoot, path.join(backupRoot, `previous-${nowStamp()}`));
    }
    fs.renameSync(nextRoot, latestRoot);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    const policyAfter = applyRuntimeBackupPolicy({ ...params, backupRoot });
    return {
      ok: true,
      action: "snapshot",
      rootDir,
      backupRoot,
      copied,
      path: latestRoot,
      resourcePreflight,
      policyBefore,
      policyAfter,
    };
  } catch (error) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures; the original runtime tree was not modified.
    }
    if (nextRoot) {
      try {
        fs.rmSync(nextRoot, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures; the caller gets the original copy/promote error.
      }
    }
    throw error;
  } finally {
    lock.release();
  }
}

function listBackupCandidates(backupRoot) {
  const candidates = [];
  const latestRoot = path.join(backupRoot, "last-known-good");
  if (fs.existsSync(latestRoot)) {
    candidates.push({ label: "last-known-good", path: latestRoot });
  }
  let previous = [];
  try {
    previous = fs
      .readdirSync(backupRoot, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && dirent.name.startsWith("previous-"))
      .map((dirent) => ({ label: dirent.name, path: path.join(backupRoot, dirent.name) }))
      .sort((a, b) => b.label.localeCompare(a.label));
  } catch {
    previous = [];
  }
  return [...candidates, ...previous];
}

export function restoreRuntimeAssets(params = {}) {
  const rootDir = resolveRootDir(params);
  const backupRoot = resolveBackupRoot(params);
  const operation = normalizeOperation(params, "restore");
  const candidates = listBackupCandidates(backupRoot);
  if (candidates.length === 0) {
    return {
      ok: false,
      action: "restore",
      rootDir,
      backupRoot,
      blocker: "runtime_last_known_good_missing",
    };
  }

  const invalidBackups = [];
  let selectedBackup;
  for (const candidate of candidates) {
    const backupValidation = validateRuntimeAssets({
      rootDir: candidate.path,
      requireUi: params.requireUi ?? false,
      validateBuildInfo: params.validateBuildInfo,
      operation,
    });
    if (backupValidation.ok) {
      selectedBackup = { ...candidate, validation: backupValidation };
      break;
    }
    invalidBackups.push({
      label: candidate.label,
      path: candidate.path,
      blocker: backupValidation.blocker,
      missing: backupValidation.missing,
      rootMismatch: backupValidation.rootMismatch,
      internalImports: {
        ok: backupValidation.internalImports.ok,
        checkedFileCount: backupValidation.internalImports.checkedFiles.length,
        missing: backupValidation.internalImports.missing,
      },
    });
  }

  if (!selectedBackup) {
    const firstInvalid = invalidBackups[0];
    return {
      ok: false,
      action: "restore",
      rootDir,
      backupRoot,
      blocker: firstInvalid?.blocker ?? "runtime_last_known_good_missing",
      missing: firstInvalid?.missing ?? [],
      rootMismatch: firstInvalid?.rootMismatch,
      internalImports: firstInvalid?.internalImports,
      invalidBackups,
    };
  }

  const movedAside = [];
  const restored = [];
  for (const name of BACKUP_ROOT_NAMES) {
    const source = path.join(selectedBackup.path, name);
    if (!fs.existsSync(source)) {
      continue;
    }
    const target = path.join(rootDir, name);
    const aside = moveAsideIfPresent(target);
    if (aside) {
      movedAside.push(aside);
    }
    fs.cpSync(source, target, {
      recursive: true,
      errorOnExist: false,
      force: true,
      verbatimSymlinks: true,
    });
    restored.push(name);
  }

  const validation = validateRuntimeAssets({
    rootDir,
    requireUi: params.requireUi ?? false,
    validateBuildInfo: params.validateBuildInfo,
    operation,
    expectedRoot: params.expectedRoot,
  });
  return {
    ok: validation.ok,
    action: "restore",
    rootDir,
    backupRoot,
    sourceBackupRoot: selectedBackup.path,
    sourceBackupLabel: selectedBackup.label,
    invalidBackups,
    restored,
    movedAside,
    missing: validation.missing,
    blocker: validation.blocker,
    rootMismatch: validation.rootMismatch,
    internalImports: validation.internalImports,
  };
}

export function restoreControlUiFromSnapshotIfMissing(params = {}) {
  const rootDir = resolveRootDir(params);
  const backupRoot = resolveBackupRoot(params);
  const uiIndexPath = path.join(rootDir, "dist", "control-ui", "index.html");
  if (isNonEmptyFile(uiIndexPath)) {
    return {
      ok: true,
      action: "restore-ui-if-missing",
      restored: false,
      rootDir,
      backupRoot,
    };
  }

  const source = path.join(backupRoot, "last-known-good", "dist", "control-ui");
  if (!fs.existsSync(source)) {
    return {
      ok: false,
      action: "restore-ui-if-missing",
      restored: false,
      rootDir,
      backupRoot,
      blocker: "runtime_last_known_good_ui_missing",
    };
  }

  const target = path.join(rootDir, "dist", "control-ui");
  moveAsideIfPresent(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: false,
    force: true,
    verbatimSymlinks: true,
  });

  return {
    ok: isNonEmptyFile(uiIndexPath),
    action: "restore-ui-if-missing",
    restored: true,
    rootDir,
    backupRoot,
  };
}

export function ensureRuntimeAssets(params = {}) {
  const operation = normalizeOperation(params, "service prestart");
  const validation = validateRuntimeAssets({ ...params, operation });
  if (validation.ok) {
    const snapshot =
      params.snapshot === true
        ? snapshotRuntimeAssets({ ...params, operation: "snapshot" })
        : undefined;
    return {
      ok: true,
      action: "ensure",
      restored: false,
      validation,
      snapshot,
    };
  }

  const restore = restoreRuntimeAssets({ ...params, operation });
  return {
    ok: restore.ok,
    action: "ensure",
    restored: true,
    validation,
    restore,
  };
}

function parseArgs(argv) {
  const options = {
    command: argv[0] ?? "validate",
    requireUi: false,
    rootDir: undefined,
    backupRoot: undefined,
    snapshot: undefined,
    operation: undefined,
    expectedRoot: undefined,
    cwdRoot: false,
    previousRetention: undefined,
    minFreeBytes: undefined,
    minFreeInodes: undefined,
    maxSnapshotBytes: undefined,
    maxSnapshotEntries: undefined,
    maxPreviousBytes: undefined,
    maxPreviousEntries: undefined,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-ui") {
      options.requireUi = true;
    } else if (arg === "--snapshot") {
      options.snapshot = true;
    } else if (arg === "--no-snapshot") {
      options.snapshot = false;
    } else if (arg === "--root") {
      options.rootDir = argv[++index];
    } else if (arg === "--backup-root") {
      options.backupRoot = argv[++index];
    } else if (arg === "--operation") {
      options.operation = argv[++index];
    } else if (arg === "--expected-root") {
      options.expectedRoot = argv[++index];
    } else if (arg === "--cwd-root") {
      options.cwdRoot = true;
    } else if (arg === "--previous-retention") {
      options.previousRetention = argv[++index];
    } else if (arg === "--min-free-bytes") {
      options.minFreeBytes = argv[++index];
    } else if (arg === "--min-free-inodes") {
      options.minFreeInodes = argv[++index];
    } else if (arg === "--max-snapshot-bytes") {
      options.maxSnapshotBytes = argv[++index];
    } else if (arg === "--max-snapshot-entries") {
      options.maxSnapshotEntries = argv[++index];
    } else if (arg === "--max-previous-bytes") {
      options.maxPreviousBytes = argv[++index];
    } else if (arg === "--max-previous-entries") {
      options.maxPreviousEntries = argv[++index];
    } else {
      throw new Error(`Unknown runtime asset guard argument: ${arg}`);
    }
  }
  return options;
}

function compactResultForPrint(value) {
  if (Array.isArray(value)) {
    return value.map((item) => compactResultForPrint(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const compact = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "checkedFiles" && Array.isArray(nestedValue)) {
      compact.checkedFileCount = nestedValue.length;
    } else {
      compact[key] = compactResultForPrint(nestedValue);
    }
  }
  return compact;
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(compactResultForPrint(result), null, 2)}\n`);
}

function isMainModule() {
  const argv1 = process.argv[1];
  return Boolean(argv1 && import.meta.url === pathToFileURL(argv1).href);
}

if (isMainModule()) {
  let result;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "validate") {
      result = validateRuntimeAssets(options);
    } else if (options.command === "snapshot") {
      result = snapshotRuntimeAssets(options);
    } else if (options.command === "restore") {
      result = restoreRuntimeAssets(options);
    } else if (options.command === "restore-ui-if-missing") {
      result = restoreControlUiFromSnapshotIfMissing(options);
    } else if (options.command === "ensure") {
      result = ensureRuntimeAssets(options);
    } else if (options.command === "policy") {
      result = applyRuntimeBackupPolicy(options);
    } else {
      throw new Error(`Unknown runtime asset guard command: ${options.command}`);
    }
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    printResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}
