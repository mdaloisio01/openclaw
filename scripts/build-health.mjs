#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoNpmInstallArtifacts } from "./install-integrity-guard.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runNode(args, options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const result = spawn(process.execPath, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    env: process.env,
  });
  const spawnError = result.error instanceof Error ? result.error.message : undefined;
  return {
    ok: !spawnError && result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
    error: spawnError,
  };
}

export function checkPackageManager() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const packageManager =
    typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
  return {
    ok: packageManager.startsWith("pnpm@"),
    packageManager,
  };
}

export function checkDiffsResolution(options = {}) {
  const cwd = path.join(rootDir, "extensions", "diffs");
  const result = runNode(
    [
      "--input-type=module",
      "-e",
      [
        'console.log(await import.meta.resolve("@pierre/diffs"));',
        'console.log(await import.meta.resolve("@pierre/diffs/ssr"));',
      ].join("\n"),
    ],
    { cwd, spawnSync: options.spawnSync },
  );
  const resolved = result.stdout.split("\n").filter(Boolean);
  const expected = ["@pierre/diffs", "@pierre/diffs/ssr"];
  const complete =
    resolved.length === expected.length &&
    resolved[0]?.includes("@pierre/diffs") === true &&
    resolved[1]?.includes("@pierre/diffs") === true &&
    resolved[1]?.includes("/ssr/") === true;
  return {
    ok: result.ok && complete,
    cwd,
    resolved,
    expected,
    error:
      result.error ??
      (result.stderr ||
        (!complete ? `expected ${expected.length} resolved dependency path(s)` : undefined)),
  };
}

export function checkRuntimeAssets(options = {}) {
  const result = runNode(
    ["scripts/runtime-asset-guard.mjs", "validate", "--no-snapshot", "--operation", "build health"],
    { spawnSync: options.spawnSync },
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  const parsedOk = Boolean(parsed && typeof parsed === "object" && parsed.ok === true);
  return {
    ok: result.ok && parsedOk,
    result: parsed ?? result.stdout,
    error:
      result.error ??
      (result.stderr ||
        (!parsedOk ? "runtime asset guard did not emit parsed ok proof" : undefined)),
  };
}

export function checkNpmArtifacts(options = {}) {
  try {
    return assertNoNpmInstallArtifacts({
      rootDir: options.rootDir ?? rootDir,
      operation: "build health",
      gitStatus: options.gitStatus,
      spawnSync: options.spawnSync,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      artifacts: Array.isArray(error?.artifacts) ? error.artifacts : undefined,
      warnings: Array.isArray(error?.warnings) ? error.warnings : undefined,
    };
  }
}

export function collectBuildHealth(options = {}) {
  const checks = {
    packageManager: checkPackageManager(),
    npmArtifacts: checkNpmArtifacts(options),
    pierreDiffs: checkDiffsResolution(options),
    runtimeAssets: checkRuntimeAssets(options),
  };
  return {
    ok: Object.values(checks).every((check) => check?.ok === true),
    rootDir,
    checks,
  };
}

function isMainModule() {
  return import.meta.url === new URL(`file://${process.argv[1]}`).href;
}

if (isMainModule()) {
  const result = collectBuildHealth();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}
