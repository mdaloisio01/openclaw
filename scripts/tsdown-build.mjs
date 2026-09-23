#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";
import { TSDOWN_PACKAGE_OUTPUT_ROOTS } from "./lib/tsdown-output-roots.mjs";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";
import {
  isSourceCheckoutRoot,
  pruneBundledPluginSourceNodeModules,
} from "./postinstall-bundled-plugins.mjs";
import {
  restoreControlUiFromSnapshotIfMissing,
  restoreRuntimeAssets,
  snapshotRuntimeAssets,
  validateRuntimeAssets,
} from "./runtime-asset-guard.mjs";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const INEFFECTIVE_DYNAMIC_IMPORT_MARKER = "[INEFFECTIVE_DYNAMIC_IMPORT]";
const UNRESOLVED_IMPORT_RE = /\[UNRESOLVED_IMPORT\]/;
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g");
const DEPENDENCY_PATH_MARKERS = ["node_modules/", "openclaw-pnpm-node-modules/"];
const HASHED_ROOT_JS_RE = /^(?<base>.+)-[A-Za-z0-9_-]+\.js$/u;
const DEFAULT_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_TSDOWN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TSDOWN_MAX_OLD_SPACE_MB = 12288;
const DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB = 8192;
const MIN_TSDOWN_MAX_OLD_SPACE_MB = 2048;
const TSDOWN_CGROUP_MEMORY_HEADROOM_MB = 768;
const CGROUP_MEMORY_LIMIT_PATHS = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
];
const PROC_MEMINFO_PATH = "/proc/meminfo";
const TERMINATION_GRACE_MS = 5_000;
const ROOT_TSDOWN_OUTPUT_ROOTS = ["dist", "dist-runtime"];
const PRESERVED_TSDOWN_OUTPUT_FILES = ["dist/cli-startup-metadata.json"];
const PRESERVE_CLI_STARTUP_METADATA_ENV = "OPENCLAW_PRESERVE_CLI_STARTUP_METADATA";
const GENERATED_SOURCE_DECLARATION_PATHSPEC = ":(glob)extensions/**/*.d.ts";
const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];
const SOURCE_DECLARATION_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const RUN_NODE_SKIP_DTS_BUILD_ENV = "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD";
const SERIAL_BUILD_ENV = "OPENCLAW_TSDOWN_SERIAL_BUILD";
const BUILD_MODE_ENV = "OPENCLAW_BUILD_MODE";
const TSDOWN_CONFIG_PATH = "tsdown.config.ts";

function removeDistPluginNodeModulesSymlinks(rootDir) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return;
  }

  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fs.rmSync(nodeModulesPath, { force: true, recursive: true });
      }
    } catch {
      // Skip missing or unreadable paths so the build can proceed.
    }
  }
}

function pruneStaleRuntimeSymlinks() {
  const cwd = process.cwd();
  // runtime-postbuild stages plugin-owned node_modules into dist/ and links the
  // dist-runtime overlay back to that tree. Remove only those symlinks up front
  // so tsdown's clean step cannot traverse stale runtime overlays on rebuilds.
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist"));
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist-runtime"));
}

export function cleanTsdownOutputRoots(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const env = params.env ?? process.env;
  const roots = listTsdownOutputRoots();
  const protectedDeclarationPaths =
    env[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1"
      ? listExistingDeclarationOutputPaths({
          cwd,
          fs: fsImpl,
          roots,
        })
      : new Set();
  const protectedPaths = new Set([
    ...protectedDeclarationPaths,
    ...listExistingPreservedOutputPaths({ cwd, env, fs: fsImpl }),
  ]);
  for (const root of roots) {
    const rootPath = path.join(cwd, root);
    try {
      if (hasProtectedChild({ rootPath, protectedPaths })) {
        cleanOutputRootExcept(rootPath, protectedPaths, fsImpl);
      } else {
        fsImpl.rmSync(rootPath, { force: true, recursive: true });
      }
    } catch {
      // Best-effort cleanup. tsdown will recreate the output tree it needs.
    }
  }
}

function hasProtectedChild({ rootPath, protectedPaths }) {
  const rootWithSeparator = `${path.resolve(rootPath)}${path.sep}`;
  for (const protectedPath of protectedPaths) {
    if (protectedPath.startsWith(rootWithSeparator)) {
      return true;
    }
  }
  return false;
}

function cleanOutputRootExcept(rootPath, protectedPaths, fsImpl) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    const resolvedEntryPath = path.resolve(entryPath);
    if (protectedPaths.has(resolvedEntryPath)) {
      continue;
    }
    try {
      if (entry.isDirectory()) {
        cleanOutputRootExcept(entryPath, protectedPaths, fsImpl);
        fsImpl.rmdirSync(entryPath);
      } else {
        fsImpl.rmSync(entryPath, { force: true });
      }
    } catch {
      // Keep best-effort semantics; protected declaration children can keep a directory non-empty.
    }
  }
}

function listExistingDeclarationOutputPaths({ cwd, fs: fsImpl, roots }) {
  const protectedPaths = new Set();
  for (const root of roots) {
    collectDeclarationOutputPaths(path.join(cwd, root), protectedPaths, fsImpl);
  }
  return protectedPaths;
}

function listExistingPreservedOutputPaths({ cwd, env, fs: fsImpl }) {
  const protectedPaths = new Set();
  if (env[PRESERVE_CLI_STARTUP_METADATA_ENV] !== "1") {
    return protectedPaths;
  }
  for (const relativePath of PRESERVED_TSDOWN_OUTPUT_FILES) {
    const absolutePath = path.resolve(cwd, relativePath);
    try {
      if (fsImpl.statSync(absolutePath).isFile()) {
        protectedPaths.add(absolutePath);
      }
    } catch {
      // Missing preserved outputs are normal on first build.
    }
  }
  return protectedPaths;
}

function collectDeclarationOutputPaths(rootPath, protectedPaths, fsImpl) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      collectDeclarationOutputPaths(entryPath, protectedPaths, fsImpl);
    } else if (DECLARATION_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      protectedPaths.add(path.resolve(entryPath));
    }
  }
}

export function pruneStaleRootChunkFiles(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const roots = listTsdownOutputRoots({ cwd, fs: fsImpl }).map((root) => path.join(cwd, root));
  for (const root of roots) {
    let entries;
    try {
      entries = fsImpl.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!HASHED_ROOT_JS_RE.test(entry.name)) {
        continue;
      }
      try {
        fsImpl.rmSync(path.join(root, entry.name), { force: true });
      } catch {
        // Best-effort cleanup. The subsequent build will overwrite any stragglers.
      }
    }
  }
}

export function listTsdownOutputRoots() {
  return [...ROOT_TSDOWN_OUTPUT_ROOTS, ...TSDOWN_PACKAGE_OUTPUT_ROOTS];
}

export function pruneUntrackedGeneratedSourceDeclarations(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  let result;
  try {
    result = spawnSyncImpl(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", GENERATED_SOURCE_DECLARATION_PATHSPEC],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return 0;
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return 0;
  }

  let removed = 0;
  for (const rawPath of result.stdout.split(/\r?\n/u)) {
    const relativePath = rawPath.trim().replaceAll("\\", "/");
    if (!relativePath.startsWith("extensions/") || !relativePath.endsWith(".d.ts")) {
      continue;
    }
    const declarationPath = path.join(cwd, relativePath);
    const sourceBase = declarationPath.slice(0, -".d.ts".length);
    const hasMatchingSource = SOURCE_DECLARATION_SOURCE_EXTENSIONS.some((extension) =>
      fsImpl.existsSync(`${sourceBase}${extension}`),
    );
    if (!hasMatchingSource) {
      continue;
    }
    try {
      fsImpl.rmSync(declarationPath, { force: true });
      removed += 1;
    } catch {
      // Best-effort cleanup; tsdown will still report any remaining stale files.
    }
  }
  return removed;
}

export function pruneSourceCheckoutBundledPluginNodeModules(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const logger = params.logger ?? console;
  if (!isSourceCheckoutRoot({ packageRoot: cwd, existsSync: fs.existsSync })) {
    return;
  }
  try {
    pruneBundledPluginSourceNodeModules({
      extensionsDir: path.join(cwd, "extensions"),
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      rmSync: fs.rmSync,
    });
  } catch (error) {
    logger.warn(`tsdown: could not prune bundled plugin source node_modules: ${String(error)}`);
  }
}

function findFatalUnresolvedImport(lines) {
  for (const line of lines) {
    if (!UNRESOLVED_IMPORT_RE.test(line)) {
      continue;
    }

    const normalizedLine = line.replace(ANSI_ESCAPE_RE, "");
    if (
      !normalizedLine.includes(BUNDLED_PLUGIN_PATH_PREFIX) &&
      !DEPENDENCY_PATH_MARKERS.some((marker) => normalizedLine.includes(marker))
    ) {
      return normalizedLine;
    }
  }

  return null;
}

function parsePositiveInteger(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function parseNonNegativeInteger(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.trunc(parsed);
}

export function resolveTsdownDtsMode(env = process.env) {
  const skipDts = env[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1";
  return {
    skipDts,
    expectedDts: !skipDts,
    dtsStatus: skipDts ? "skipped" : "enabled",
    buildMode: env[BUILD_MODE_ENV]?.trim() || (skipDts ? "runtime" : "release"),
  };
}

export function countTsdownConfigBlocks(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const configPath = params.configPath ?? path.join(cwd, TSDOWN_CONFIG_PATH);
  let source;
  try {
    source = fsImpl.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  return source
    .split(/\r?\n/u)
    .filter((line) => /^\s{2,}(?:nodeBuildConfig|nodeWorkspacePackageBuildConfig)\s*\(/u.test(line))
    .length;
}

function readProcessResidentSetKb(pid, params = {}) {
  if (!pid || (params.platform ?? process.platform) !== "linux") {
    return null;
  }
  const fsImpl = params.fs ?? fs;
  try {
    const status = fsImpl.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(?<rss>\d+)\s+kB$/imu.exec(status);
    if (!match?.groups?.rss) {
      return null;
    }
    const rssKb = Number.parseInt(match.groups.rss, 10);
    return Number.isFinite(rssKb) ? rssKb : null;
  } catch {
    return null;
  }
}

export function formatTsdownHeartbeat({ pid, elapsedMs, silentForMs, rssKb, dtsStatus } = {}) {
  const fields = [
    "still running",
    pid ? `pid=${pid}` : null,
    `elapsed=${Math.round(Math.max(0, elapsedMs ?? 0) / 1000)}s`,
    rssKb === null || rssKb === undefined ? "rss=unknown" : `rss=${rssKb}KB`,
    `dts=${dtsStatus ?? "unknown"}`,
    `no output for ${Math.round(Math.max(0, silentForMs ?? 0) / 1000)}s`,
  ].filter(Boolean);
  return `[tsdown-build] ${fields.join(" ")}\n`;
}

function parseCgroupMemoryLimitBytes(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "max" || !/^\d+$/u.test(trimmed)) {
    return null;
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(parsed);
}

function readCgroupMemoryLimitBytes(params = {}) {
  if (Number.isFinite(params.cgroupMemoryLimitBytes) && params.cgroupMemoryLimitBytes > 0) {
    return Math.trunc(params.cgroupMemoryLimitBytes);
  }

  const fsImpl = params.fs ?? fs;
  const paths = params.cgroupMemoryLimitPaths ?? CGROUP_MEMORY_LIMIT_PATHS;
  for (const limitPath of paths) {
    try {
      const limitBytes = parseCgroupMemoryLimitBytes(fsImpl.readFileSync(limitPath, "utf8"));
      if (limitBytes !== null) {
        return limitBytes;
      }
    } catch {
      // Missing cgroup files are expected outside Linux containers.
    }
  }

  return null;
}

function parseProcMemTotalBytes(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^MemTotal:\s+(\d+)\s+kB$/imu);
  if (!match) {
    return null;
  }
  const parsed = BigInt(match[1]) * 1024n;
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(parsed);
}

function readProcMemTotalBytes(params = {}) {
  if (Number.isFinite(params.procMemTotalBytes) && params.procMemTotalBytes > 0) {
    return Math.trunc(params.procMemTotalBytes);
  }

  const fsImpl = params.fs ?? fs;
  try {
    return parseProcMemTotalBytes(
      fsImpl.readFileSync(params.procMeminfoPath ?? PROC_MEMINFO_PATH, "utf8"),
    );
  } catch {
    return null;
  }
}

function resolveTsdownMaxOldSpaceMb(params = {}) {
  const defaultMaxOldSpaceMb =
    (params.platform ?? process.platform) === "win32"
      ? DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB
      : DEFAULT_TSDOWN_MAX_OLD_SPACE_MB;
  const limitBytes = readCgroupMemoryLimitBytes(params) ?? readProcMemTotalBytes(params);
  if (limitBytes === null) {
    return defaultMaxOldSpaceMb;
  }

  const limitMb = Math.floor(limitBytes / 1024 / 1024);
  if (limitMb <= 0) {
    return defaultMaxOldSpaceMb;
  }

  const cgroupCap = Math.max(
    MIN_TSDOWN_MAX_OLD_SPACE_MB,
    limitMb - TSDOWN_CGROUP_MEMORY_HEADROOM_MB,
  );
  return Math.min(defaultMaxOldSpaceMb, cgroupCap);
}

function parseMaxOldSpaceSizeMb(value, fallbackMb) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMb;
  }
  return Math.trunc(parsed);
}

function normalizeMaxOldSpaceSizeMb(value, maxOldSpaceMb, allowSmallerHeap = false) {
  // Build wrappers may inherit smaller runner-level caps; tsdown needs the
  // resolved build heap while still respecting cgroup-derived upper bounds.
  const parsed = parseMaxOldSpaceSizeMb(value, maxOldSpaceMb);
  if (parsed < maxOldSpaceMb && !allowSmallerHeap) {
    return maxOldSpaceMb;
  }
  return Math.min(parsed, maxOldSpaceMb);
}

function normalizeTsdownNodeOptions(nodeOptions, params = {}) {
  const maxOldSpaceMb = resolveTsdownMaxOldSpaceMb(params);
  const allowSmallerHeap = params.allowSmallerHeap === true;
  const parts = nodeOptions.trim().split(/\s+/u).filter(Boolean);
  const normalized = [];
  let foundMaxOldSpaceSize = false;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const inlineMatch = part.match(/^--max-old-space-size=(\d+)$/u);
    if (inlineMatch) {
      foundMaxOldSpaceSize = true;
      const value = normalizeMaxOldSpaceSizeMb(inlineMatch[1], maxOldSpaceMb, allowSmallerHeap);
      normalized.push(`--max-old-space-size=${value}`);
      continue;
    }

    if (part === "--max-old-space-size") {
      foundMaxOldSpaceSize = true;
      const next = parts[index + 1];
      const value = normalizeMaxOldSpaceSizeMb(next, maxOldSpaceMb, allowSmallerHeap);
      normalized.push(`--max-old-space-size=${value}`);
      if (next !== undefined) {
        index += 1;
      }
      continue;
    }

    normalized.push(part);
  }

  if (!foundMaxOldSpaceSize) {
    normalized.push(`--max-old-space-size=${maxOldSpaceMb}`);
  }

  return normalized.join(" ");
}

function resolveTsdownEnv(env, params = {}) {
  const nodeOptions = env.NODE_OPTIONS?.trim() ?? "";
  return {
    ...env,
    NODE_OPTIONS: normalizeTsdownNodeOptions(nodeOptions, {
      ...params,
      allowSmallerHeap: env[SERIAL_BUILD_ENV] === "1",
    }),
  };
}

export function tsdownBuildUsage() {
  return [
    "Usage: node scripts/tsdown-build.mjs [tsdown args...]",
    "",
    "Builds OpenClaw with tsdown and validates emitted import diagnostics.",
    "",
    "Options:",
    "  -h, --help  Show this help without starting tsdown.",
    "",
    "Other arguments are forwarded to tsdown.",
  ].join("\n");
}

export function parseTsdownBuildArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      forwardedArgs: [],
      help: true,
    };
  }
  return {
    forwardedArgs: argv,
    help: false,
  };
}

export function createTsdownOutputScanner(params = {}) {
  const maxCaptureBytes = params.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
  let captured = "";
  let pendingLine = "";
  let hasIneffectiveDynamicImport = false;
  let fatalUnresolvedImport = null;

  function scanLines(text) {
    const combined = pendingLine + text;
    const lines = combined.split(/\r?\n/u);
    pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      fatalUnresolvedImport ??= findFatalUnresolvedImport([line]);
    }
  }

  return {
    append(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(INEFFECTIVE_DYNAMIC_IMPORT_MARKER)) {
        hasIneffectiveDynamicImport = true;
      }
      scanLines(text);
      captured += text;
      if (captured.length > maxCaptureBytes) {
        captured = captured.slice(-maxCaptureBytes);
      }
    },
    finish() {
      if (pendingLine) {
        fatalUnresolvedImport ??= findFatalUnresolvedImport([pendingLine]);
        pendingLine = "";
      }
      return {
        captured,
        hasIneffectiveDynamicImport,
        fatalUnresolvedImport,
      };
    },
  };
}

export function resolveTsdownBuildInvocation(params = {}) {
  const env = resolveTsdownEnv(params.env ?? process.env, params);
  const forwardedArgs = params.args ?? [];
  const tsdownArgs = [
    "--config-loader",
    "unrun",
    "--logLevel",
    logLevel,
    "--no-clean",
    ...forwardedArgs,
  ];
  if (env.OPENCLAW_BUILD_ALL_NO_PNPM === "1") {
    return {
      command: params.nodeExecPath ?? process.execPath,
      args: ["node_modules/tsdown/dist/run.mjs", ...tsdownArgs],
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: params.detached ?? (params.platform ?? process.platform) !== "win32",
        windowsVerbatimArguments: undefined,
        env,
      },
    };
  }
  const runner = resolvePnpmRunner({
    pnpmArgs: ["exec", "tsdown", ...tsdownArgs],
    nodeExecPath: params.nodeExecPath ?? process.execPath,
    npmExecPath: params.npmExecPath ?? env.npm_execpath,
    comSpec: params.comSpec ?? env.ComSpec,
    platform: params.platform ?? process.platform,
  });
  return {
    command: runner.command,
    args: runner.args,
    options: {
      stdio: ["ignore", "pipe", "pipe"],
      shell: runner.shell,
      detached: params.detached ?? (params.platform ?? process.platform) !== "win32",
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
      env,
    },
  };
}

export function resolveTsdownBuildInvocations(params = {}) {
  const env = params.env ?? process.env;
  if (env[SERIAL_BUILD_ENV] !== "1") {
    return [resolveTsdownBuildInvocation(params)];
  }
  const configCount = countTsdownConfigBlocks(params);
  if (!configCount) {
    throw new Error("Cannot run serial tsdown build without configured build entries");
  }
  // A separate process per config releases DTS graph memory before the next build.
  return Array.from({ length: configCount }, (_, index) =>
    resolveTsdownBuildInvocation({
      ...params,
      args: [...(params.args ?? []), "--filter", `openclaw-build-${index}`],
    }),
  );
}

export function parseTsdownBuildProcessRows(text, params = {}) {
  const currentPid = params.currentPid ?? process.pid;
  const rows = [];
  for (const line of String(text).split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<stat>\S+)\s+(?<command>.+)$/u.exec(trimmed);
    if (!match?.groups) {
      continue;
    }
    const pid = Number.parseInt(match.groups.pid, 10);
    if (!Number.isFinite(pid) || pid === currentPid) {
      continue;
    }
    const command = match.groups.command;
    const startsWithNode = /^(?:\S*\/)?node(?:\s|$)/u.test(command);
    const isWrapper = startsWithNode && command.includes("scripts/tsdown-build.mjs");
    const isPnpmTsdown = startsWithNode && command.includes("pnpm exec tsdown");
    const isDirectTsdown = startsWithNode && command.includes("node_modules/tsdown");
    if (!isWrapper && !isPnpmTsdown && !isDirectTsdown) {
      continue;
    }
    rows.push({
      pid,
      ppid: Number.parseInt(match.groups.ppid, 10),
      stat: match.groups.stat,
      command,
      stopped: match.groups.stat.includes("T"),
    });
  }
  return rows;
}

export function findTsdownBuildProcesses(params = {}) {
  if ((params.platform ?? process.platform) === "win32") {
    return [];
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,stat=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return [];
  }
  return parseTsdownBuildProcessRows(result.stdout, params);
}

function formatTsdownBuildProcesses(processes) {
  return processes
    .map((entry) => `pid=${entry.pid} ppid=${entry.ppid} stat=${entry.stat} cmd=${entry.command}`)
    .join("; ");
}

function terminateChildProcessTree(child, signal) {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child below.
  }
  try {
    child.kill(signal);
  } catch {
    // The child may already be gone.
  }
}

export async function runTsdownBuildInvocation(invocation, params = {}) {
  const stdout = params.stdout ?? process.stdout;
  const stderr = params.stderr ?? process.stderr;
  const env = params.env ?? process.env;
  const effectiveEnv = invocation.options?.env ?? env;
  const scanner = params.scanner ?? createTsdownOutputScanner();
  const timeoutMs =
    parsePositiveInteger(env.OPENCLAW_TSDOWN_TIMEOUT_MS) ?? DEFAULT_TSDOWN_TIMEOUT_MS;
  const heartbeatMs =
    parseNonNegativeInteger(env.OPENCLAW_TSDOWN_HEARTBEAT_MS) ?? DEFAULT_HEARTBEAT_MS;
  const dtsMode = resolveTsdownDtsMode(effectiveEnv);
  const configCount = countTsdownConfigBlocks({ cwd: params.cwd ?? process.cwd() });
  let timedOut = false;
  let settled = false;
  const startedAt = Date.now();
  let lastOutputAt = Date.now();

  const child = spawn(invocation.command, invocation.args, invocation.options);
  const pidText = child.pid ? ` pid=${child.pid}` : "";
  stderr.write(
    `[tsdown-build] mode=${dtsMode.buildMode} dts=${dtsMode.dtsStatus} expectedDts=${
      dtsMode.expectedDts ? "yes" : "no"
    } configCount=${configCount ?? "unknown"} heartbeatMs=${heartbeatMs} timeoutMs=${timeoutMs}\n`,
  );

  function markOutput() {
    lastOutputAt = Date.now();
  }

  child.stdout?.on("data", (chunk) => {
    markOutput();
    scanner.append(chunk);
    stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    markOutput();
    scanner.append(chunk);
    stderr.write(chunk);
  });

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (settled) {
            return;
          }
          const silentForMs = Date.now() - lastOutputAt;
          if (silentForMs < heartbeatMs) {
            return;
          }
          const rssKb =
            params.readProcessResidentSetKb?.(child.pid) ?? readProcessResidentSetKb(child.pid);
          stderr.write(
            formatTsdownHeartbeat({
              pid: child.pid,
              elapsedMs: Date.now() - startedAt,
              silentForMs,
              rssKb,
              dtsStatus: dtsMode.dtsStatus,
            }),
          );
          lastOutputAt = Date.now();
        }, heartbeatMs).unref()
      : null;

  const timeout =
    timeoutMs !== null
      ? setTimeout(() => {
          timedOut = true;
          stderr.write(
            `[tsdown-build] timeout after ${timeoutMs}ms${pidText}; sending SIGTERM to process tree\n`,
          );
          terminateChildProcessTree(child, "SIGTERM");
          setTimeout(() => {
            if (!settled) {
              stderr.write(`[tsdown-build] forcing SIGKILL for process tree${pidText}\n`);
              terminateChildProcessTree(child, "SIGKILL");
            }
          }, TERMINATION_GRACE_MS).unref();
        }, timeoutMs).unref()
      : null;

  return new Promise((resolve) => {
    child.once("error", (error) => {
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      stderr.write(`[tsdown-build] failed to start: ${String(error)}\n`);
      resolve({
        status: 1,
        signal: null,
        timedOut,
        error,
        ...scanner.finish(),
      });
    });
    child.once("close", (status, signal) => {
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        timedOut,
        error: null,
        ...scanner.finish(),
      });
    });
  });
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  return import.meta.url === pathToFileURL(argv1).href;
}

function formatRuntimeAssetGuardFailure(result) {
  const lines = [];
  if (result.blocker) {
    lines.push(`blocker=${result.blocker}`);
  }
  if (Array.isArray(result.missing) && result.missing.length > 0) {
    lines.push(`missing=${result.missing.join(", ")}`);
  }
  if (result.rootMismatch) {
    lines.push(
      `operation=${result.rootMismatch.operation} root=${result.rootMismatch.rootDir} expected=${result.rootMismatch.expectedRoot}`,
    );
  }
  const internalMissing = result.internalImports?.missing;
  if (Array.isArray(internalMissing) && internalMissing.length > 0) {
    for (const item of internalMissing) {
      lines.push(
        [
          `operation=${item.operation}`,
          `importer=${item.importerFile}`,
          `specifier=${item.importSpecifier}`,
          `missing=${item.missingTargetFile}`,
        ].join(" "),
      );
    }
  }
  return lines.length > 0 ? lines.join("; ") : "unknown runtime asset guard failure";
}

function restoreRuntimeAfterRejectedBuild(reason) {
  const restore = restoreRuntimeAssets({ requireUi: false, operation: "restore" });
  if (!restore.ok) {
    console.error(
      `[tsdown-build] failed to restore last-known-good runtime after ${reason}: ${formatRuntimeAssetGuardFailure(
        restore,
      )}`,
    );
  }
  return restore;
}

if (isMainModule()) {
  const args = parseTsdownBuildArgs(process.argv.slice(2));
  if (args.help) {
    console.log(tsdownBuildUsage());
    process.exit(0);
  }
  const staleBuildProcesses = findTsdownBuildProcesses();
  if (staleBuildProcesses.length > 0) {
    console.error(
      `[tsdown-build] build_stale_process_detected: ${formatTsdownBuildProcesses(
        staleBuildProcesses,
      )}`,
    );
    process.exit(1);
  }
  const runtimeSnapshot = snapshotRuntimeAssets({ requireUi: false, operation: "snapshot" });
  if (!runtimeSnapshot.ok) {
    console.warn(
      `[tsdown-build] active runtime snapshot skipped: ${formatRuntimeAssetGuardFailure(
        runtimeSnapshot,
      )}`,
    );
  }
  pruneSourceCheckoutBundledPluginNodeModules();
  pruneUntrackedGeneratedSourceDeclarations();
  pruneStaleRuntimeSymlinks();
  const invocations = resolveTsdownBuildInvocations({ args: args.forwardedArgs });
  cleanTsdownOutputRoots();
  let result;
  for (const invocation of invocations) {
    result = await runTsdownBuildInvocation(invocation);
    if (
      result.status !== 0 ||
      result.timedOut ||
      result.hasIneffectiveDynamicImport ||
      result.fatalUnresolvedImport
    ) {
      break;
    }
  }

  if (result.status === 0 && result.hasIneffectiveDynamicImport) {
    restoreRuntimeAfterRejectedBuild("rejected build");
    console.error(
      "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.",
    );
    process.exit(1);
  }

  if (result.status === 0 && result.fatalUnresolvedImport) {
    restoreRuntimeAfterRejectedBuild("unresolved import");
    console.error(
      `Build emitted [UNRESOLVED_IMPORT] outside extensions: ${result.fatalUnresolvedImport}`,
    );
    process.exit(1);
  }

  if (result.timedOut) {
    restoreRuntimeAfterRejectedBuild("timeout");
    process.exit(124);
  }

  if (typeof result.status === "number") {
    if (result.status === 0) {
      const uiRestore = restoreControlUiFromSnapshotIfMissing();
      if (!uiRestore.ok) {
        console.warn(
          `[tsdown-build] control UI was not restored from last-known-good snapshot: ${
            uiRestore.blocker ?? "unknown"
          }`,
        );
      }
      const postBuildValidation = validateRuntimeAssets({
        requireUi: false,
        validateBuildInfo: false,
        operation: "build",
      });
      if (!postBuildValidation.ok) {
        restoreRuntimeAfterRejectedBuild("runtime_internal_import_missing");
        console.error(
          `[tsdown-build] build output rejected by runtime asset guard: ${formatRuntimeAssetGuardFailure(
            postBuildValidation,
          )}`,
        );
        process.exit(1);
      }
      const snapshot = snapshotRuntimeAssets({
        requireUi: false,
        validateBuildInfo: false,
        operation: "snapshot",
      });
      if (!snapshot.ok) {
        restoreRuntimeAfterRejectedBuild("broken runtime snapshot");
        console.error(
          `[tsdown-build] runtime snapshot rejected by runtime asset guard: ${formatRuntimeAssetGuardFailure(
            snapshot,
          )}`,
        );
        process.exit(1);
      }
    } else {
      restoreRuntimeAfterRejectedBuild("failed build");
    }
    process.exit(result.status);
  }

  restoreRuntimeAfterRejectedBuild("abnormal build exit");
  process.exit(1);
}
