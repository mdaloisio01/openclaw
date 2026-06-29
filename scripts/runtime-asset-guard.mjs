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
const INTERNAL_IMPORT_MISSING_BLOCKER = "runtime_internal_import_missing";
const REQUIRED_ASSET_MISSING_BLOCKER = "runtime_required_asset_missing";
const BUILD_INFO_BLOCKER = "runtime_build_info_invalid";
const ROOT_MISMATCH_BLOCKER = "runtime_guard_root_mismatch";
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

function moveAsideIfPresent(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return undefined;
  }
  const asidePath = `${targetPath}.broken-${nowStamp()}`;
  fs.renameSync(targetPath, asidePath);
  return asidePath;
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

  fs.mkdirSync(backupRoot, { recursive: true });
  const tempRoot = path.join(backupRoot, `last-known-good.tmp-${nowStamp()}`);
  fs.mkdirSync(tempRoot, { recursive: true });

  const copied = [];
  try {
    for (const name of BACKUP_ROOT_NAMES) {
      if (copyExistingRoot({ fromRoot: rootDir, toRoot: tempRoot, name })) {
        copied.push(name);
      }
    }
    fs.writeFileSync(
      path.join(tempRoot, "runtime-asset-guard.json"),
      `${JSON.stringify(
        {
          created_at: new Date().toISOString(),
          root_dir: rootDir,
          required_assets: requiredAssets({ requireUi: params.requireUi ?? false }),
          internal_imports_checked: validation.internalImports.checkedFiles.length,
          copied_roots: copied,
        },
        null,
        2,
      )}\n`,
    );

    const latestRoot = path.join(backupRoot, "last-known-good");
    if (fs.existsSync(latestRoot)) {
      fs.renameSync(latestRoot, path.join(backupRoot, `previous-${nowStamp()}`));
    }
    fs.renameSync(tempRoot, latestRoot);
    return {
      ok: true,
      action: "snapshot",
      rootDir,
      backupRoot,
      copied,
      path: latestRoot,
    };
  } catch (error) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures; the original runtime tree was not modified.
    }
    throw error;
  }
}

export function restoreRuntimeAssets(params = {}) {
  const rootDir = resolveRootDir(params);
  const backupRoot = resolveBackupRoot(params);
  const operation = normalizeOperation(params, "restore");
  const latestRoot = path.join(backupRoot, "last-known-good");
  if (!fs.existsSync(latestRoot)) {
    return {
      ok: false,
      action: "restore",
      rootDir,
      backupRoot,
      blocker: "runtime_last_known_good_missing",
    };
  }

  const backupValidation = validateRuntimeAssets({
    rootDir: latestRoot,
    requireUi: params.requireUi ?? false,
    validateBuildInfo: params.validateBuildInfo,
    operation,
  });
  if (!backupValidation.ok) {
    return {
      ok: false,
      action: "restore",
      rootDir,
      backupRoot,
      blocker: backupValidation.blocker,
      missing: backupValidation.missing,
      rootMismatch: backupValidation.rootMismatch,
      internalImports: backupValidation.internalImports,
    };
  }

  const movedAside = [];
  const restored = [];
  for (const name of BACKUP_ROOT_NAMES) {
    const source = path.join(latestRoot, name);
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
      params.snapshot === false
        ? undefined
        : snapshotRuntimeAssets({ ...params, operation: "snapshot" });
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
    snapshot: true,
    operation: undefined,
    expectedRoot: undefined,
    cwdRoot: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-ui") {
      options.requireUi = true;
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
