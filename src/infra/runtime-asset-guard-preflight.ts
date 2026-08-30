import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeAssetGuardPreflightResult = {
  ok: boolean;
  status: number | null;
  operation: string;
  scriptPath: string;
  message: string;
  stdout: string;
  stderr: string;
};

function resolveSourceRoot(): string {
  const envRoot = process.env.OPENCLAW_RUNTIME_GUARD_SOURCE_ROOT;
  if (envRoot) {
    return path.resolve(envRoot);
  }

  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "scripts", "runtime-asset-guard.mjs"))) {
    return cwd;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(moduleDir) === "dist") {
    return path.dirname(moduleDir);
  }
  return cwd;
}

function describeUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "unknown";
  }
  return JSON.stringify(value) ?? "unknown";
}

function summarizeGuardOutput(stdout: string, stderr: string): string {
  try {
    const parsed = JSON.parse(stdout) as {
      blocker?: unknown;
      missing?: unknown;
      rootDir?: unknown;
      rootMismatch?: { operation?: unknown; rootDir?: unknown; expectedRoot?: unknown };
      internalImports?: { missing?: unknown };
      error?: unknown;
    };
    const parts: string[] = [];
    if (typeof parsed.blocker === "string") {
      parts.push(`blocker=${parsed.blocker}`);
    }
    if (Array.isArray(parsed.missing) && parsed.missing.length > 0) {
      parts.push(`missing=${parsed.missing.join(", ")}`);
    }
    if (parsed.rootMismatch) {
      parts.push(
        [
          `operation=${describeUnknown(parsed.rootMismatch.operation)}`,
          `root=${describeUnknown(parsed.rootMismatch.rootDir)}`,
          `expected=${describeUnknown(parsed.rootMismatch.expectedRoot)}`,
        ].join(" "),
      );
    } else if (typeof parsed.rootDir === "string") {
      parts.push(`root=${parsed.rootDir}`);
    }
    const internalMissing = parsed.internalImports?.missing;
    if (Array.isArray(internalMissing) && internalMissing.length > 0) {
      for (const item of internalMissing as Array<Record<string, unknown>>) {
        parts.push(
          [
            `operation=${describeUnknown(item.operation)}`,
            `importer=${describeUnknown(item.importerFile)}`,
            `specifier=${describeUnknown(item.importSpecifier)}`,
            `missing=${describeUnknown(item.missingTargetFile)}`,
          ].join(" "),
        );
      }
    }
    if (typeof parsed.error === "string") {
      parts.push(parsed.error);
    }
    if (parts.length > 0) {
      return parts.join("; ");
    }
  } catch {
    // Fall through to raw output below.
  }
  return stderr.trim() || stdout.trim() || "runtime asset guard failed without output";
}

export function runRuntimeAssetGuardPreflight(params: {
  operation: string;
  requireUi?: boolean;
}): RuntimeAssetGuardPreflightResult {
  const sourceRoot = resolveSourceRoot();
  const scriptPath = path.join(sourceRoot, "scripts", "runtime-asset-guard.mjs");
  const args = [
    scriptPath,
    "validate",
    "--root",
    sourceRoot,
    "--expected-root",
    sourceRoot,
    "--operation",
    params.operation,
  ];
  if (params.requireUi) {
    args.push("--require-ui");
  }
  const result = spawnSync(process.execPath, args, {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const ok = result.status === 0;
  return {
    ok,
    status: result.status,
    operation: params.operation,
    scriptPath,
    message: ok ? "runtime asset guard passed" : summarizeGuardOutput(stdout, stderr),
    stdout,
    stderr,
  };
}
