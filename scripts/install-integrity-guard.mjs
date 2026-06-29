#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const allowedLifecyclePackageManagers = new Set(["pnpm", "npm", "yarn", "bun"]);
const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NON_PNPM_BYPASS_ENV = "OPENCLAW_ALLOW_NON_PNPM_INSTALL";
const NPM_ARTIFACT_BYPASS_ENV = "OPENCLAW_ALLOW_NPM_INSTALL_ARTIFACTS";
const PREFERRED_INSTALL_COMMAND = "corepack pnpm install";

function normalizeEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLifecyclePackageManagerName(value) {
  const normalized = normalizeEnvValue(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    return null;
  }
  return allowedLifecyclePackageManagers.has(normalized) ? normalized : null;
}

export function detectLifecyclePackageManager(env = process.env) {
  const userAgent = normalizeEnvValue(env.npm_config_user_agent);
  const userAgentMatch = /^([A-Za-z0-9._-]+)\//u.exec(userAgent);
  if (userAgentMatch) {
    return normalizeLifecyclePackageManagerName(userAgentMatch[1]);
  }

  const execPath = normalizeEnvValue(env.npm_execpath).toLowerCase();
  if (execPath.includes("pnpm")) {
    return "pnpm";
  }
  if (execPath.includes("npm")) {
    return "npm";
  }
  if (execPath.includes("yarn")) {
    return "yarn";
  }
  if (execPath.includes("bun")) {
    return "bun";
  }

  return null;
}

function envFlagEnabled(env, name) {
  const value = normalizeEnvValue(env[name]).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function createNonPnpmInstallErrorMessage(packageManager, cwd = process.cwd()) {
  if (!packageManager || packageManager === "pnpm") {
    return null;
  }
  return [
    "OpenClaw uses pnpm. Run: corepack pnpm install",
    "Do not generate package-lock.json in this pnpm workspace.",
    "Root npm-shrinkwrap.json is temporarily allowed only as the tracked release shrinkwrap; do not generate or mutate it in source checkouts.",
    `detectedPackageManager=${packageManager}`,
    `cwd=${cwd}`,
    `bypass=${NON_PNPM_BYPASS_ENV}=1 is reserved for documented release/publish automation only`,
  ].join("\n");
}

export function enforcePnpmInstallLifecycle({
  env = process.env,
  cwd = process.cwd(),
  error = console.error,
  warn = console.warn,
} = {}) {
  const packageManager = detectLifecyclePackageManager(env);
  const message = createNonPnpmInstallErrorMessage(packageManager, cwd);
  if (!message) {
    return false;
  }
  if (envFlagEnabled(env, NON_PNPM_BYPASS_ENV)) {
    warn(
      `[openclaw] ${NON_PNPM_BYPASS_ENV}=1 bypassed non-pnpm install guard for ${packageManager} in ${cwd}`,
    );
    return true;
  }
  error(message);
  throw new Error(message);
}

function gitStatusForPath(rootDir, relativePath, options = {}) {
  if (typeof options.gitStatus === "function") {
    return { ok: true, status: options.gitStatus(relativePath) };
  }
  const spawn = options.spawnSync ?? spawnSync;
  const result = spawn("git", ["status", "--porcelain=v1", "--", relativePath], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error:
        result.error instanceof Error
          ? result.error.message
          : result.stderr?.trim() || `git status exited ${result.status}`,
    };
  }
  return { ok: true, status: result.stdout ?? "" };
}

function classifyRootShrinkwrap(rootDir, options = {}) {
  const fsImpl = options.fs ?? fs;
  const relativePath = "npm-shrinkwrap.json";
  const shrinkwrapPath = path.join(rootDir, relativePath);
  if (!fsImpl.existsSync(shrinkwrapPath)) {
    return null;
  }
  const statusResult = gitStatusForPath(rootDir, relativePath, options);
  if (!statusResult.ok) {
    return {
      kind: "blocker",
      relativePath,
      path: shrinkwrapPath,
      reason: "root npm-shrinkwrap.json exists but tracked-clean status could not be verified",
      detail: statusResult.error,
    };
  }
  const statusLines = statusResult.status
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (statusLines.length === 0) {
    return {
      kind: "warning",
      relativePath,
      path: shrinkwrapPath,
      reason:
        "tracked clean root npm-shrinkwrap.json temporarily allowed for release/package workflows",
    };
  }
  const statusText = statusLines.join("; ");
  return {
    kind: "blocker",
    relativePath,
    path: shrinkwrapPath,
    reason: statusLines.some((line) => line.startsWith("??"))
      ? "untracked root npm-shrinkwrap.json is not allowed in source checkout"
      : "modified root npm-shrinkwrap.json is not allowed in source checkout",
    detail: statusText,
  };
}

function npmArtifactWarnings(rootDir, options = {}) {
  const fsImpl = options.fs ?? fs;
  const entries = fsImpl.existsSync(rootDir) ? fsImpl.readdirSync(rootDir) : [];
  return entries
    .filter((entry) => /^npm-shrinkwrap\.json\.bak-/u.test(entry))
    .map((entry) => ({
      relativePath: entry,
      path: path.join(rootDir, entry),
      reason: "backup shrinkwrap artifact preserved as evidence for later cleanup review",
    }));
}

function npmInstallArtifacts(rootDir, options = {}) {
  const blockers = [];
  const warnings = npmArtifactWarnings(rootDir, options);
  const packageLockPath = path.join(rootDir, "package-lock.json");
  const fsImpl = options.fs ?? fs;
  if (fsImpl.existsSync(packageLockPath)) {
    blockers.push({
      relativePath: "package-lock.json",
      path: packageLockPath,
      reason: "root package-lock.json is not allowed in pnpm source checkout",
    });
  }
  const shrinkwrap = classifyRootShrinkwrap(rootDir, options);
  if (shrinkwrap?.kind === "blocker") {
    blockers.push(shrinkwrap);
  } else if (shrinkwrap?.kind === "warning") {
    warnings.push(shrinkwrap);
  }
  return { blockers, warnings };
}

export function createNpmInstallArtifactErrorMessage({
  artifacts,
  operation = "local build/install/restart activation",
  rootDir = DEFAULT_ROOT_DIR,
} = {}) {
  if (!artifacts || artifacts.length === 0) {
    return null;
  }
  const artifactList = artifacts.map((artifact) => artifact.relativePath).join(", ");
  const artifactReasons = artifacts
    .map((artifact) => (artifact.reason ? `${artifact.relativePath}: ${artifact.reason}` : null))
    .filter(Boolean);
  return [
    `OpenClaw local ${operation} is blocked by npm-owned install artifact(s): ${artifactList}`,
    ...(artifactReasons.length > 0 ? [`Reasons: ${artifactReasons.join("; ")}`] : []),
    "These files can make npm, not pnpm, control the workspace install state.",
    "Do not leave package-lock.json or untracked/mutated npm-shrinkwrap.json as active source-checkout truth.",
    "A clean tracked root npm-shrinkwrap.json is temporarily allowed for release/package workflows.",
    "Back up suspicious npm lock/shrinkwrap artifacts before moving them; do not auto-delete evidence files.",
    `rootDir=${rootDir}`,
    `bypass=${NPM_ARTIFACT_BYPASS_ENV}=1 is reserved for documented publish/release automation only`,
  ].join("\n");
}

export function assertNoNpmInstallArtifacts({
  rootDir = DEFAULT_ROOT_DIR,
  operation,
  env = process.env,
  gitStatus,
  spawnSync: spawn,
  fs: fsImpl,
} = {}) {
  const { blockers, warnings } = npmInstallArtifacts(rootDir, {
    gitStatus,
    spawnSync: spawn,
    fs: fsImpl,
  });
  if (blockers.length === 0) {
    return { ok: true, artifacts: [], warnings };
  }
  const message = createNpmInstallArtifactErrorMessage({ artifacts: blockers, operation, rootDir });
  if (envFlagEnabled(env, NPM_ARTIFACT_BYPASS_ENV)) {
    console.warn(
      `[openclaw] ${NPM_ARTIFACT_BYPASS_ENV}=1 bypassed npm install artifact guard for ${blockers
        .map((artifact) => artifact.relativePath)
        .join(", ")} in ${rootDir}`,
    );
    return { ok: true, artifacts: blockers, warnings, bypassed: true };
  }
  const error = new Error(message ?? "npm install artifact guard failed");
  error.code = "OPENCLAW_NPM_INSTALL_ARTIFACT";
  error.artifacts = blockers.map((artifact) => artifact.relativePath);
  error.warnings = warnings.map((artifact) => artifact.relativePath);
  throw error;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const command = process.argv[2] ?? "local-preflight";
    if (command === "preinstall") {
      enforcePnpmInstallLifecycle();
    } else if (command === "local-preflight") {
      assertNoNpmInstallArtifacts({ operation: "local build/install/restart activation" });
    } else {
      throw new Error(`Unknown install integrity guard command: ${command}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
