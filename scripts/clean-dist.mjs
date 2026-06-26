#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { snapshotRuntimeAssets } from "./runtime-asset-guard.mjs";

const OUTPUT_ROOTS = ["dist", "dist-runtime"];
const DEFAULT_GATEWAY_SERVICE_PATH = path.join(
  process.env.HOME ?? "",
  ".config",
  "systemd",
  "user",
  "openclaw-gateway.service",
);
const DEFAULT_GATEWAY_OVERRIDE_PATH = path.join(
  process.env.HOME ?? "",
  ".config",
  "systemd",
  "user",
  "openclaw-gateway.service.d",
  "override.conf",
);

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    force:
      argv.includes("--force") ||
      argv.includes("--allow-active-runtime-clean") ||
      process.env.OPENCLAW_ALLOW_ACTIVE_RUNTIME_CLEAN === "1",
    rootDir: path.resolve(process.env.OPENCLAW_RUNTIME_GUARD_ROOT ?? process.cwd()),
  };
}

function readOptional(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function isGatewayServicePointingAtActiveDist(rootDir) {
  const activeEntry = path.join(rootDir, "dist", "index.js");
  const serviceText = `${readOptional(DEFAULT_GATEWAY_SERVICE_PATH)}\n${readOptional(
    DEFAULT_GATEWAY_OVERRIDE_PATH,
  )}`;
  return serviceText.includes(activeEntry);
}

function cleanOutputRoots({ dryRun, rootDir }) {
  const removed = [];
  for (const root of OUTPUT_ROOTS) {
    const target = path.join(rootDir, root);
    if (!fs.existsSync(target)) {
      continue;
    }
    removed.push(root);
    if (!dryRun) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  return removed;
}

function isMainModule() {
  const argv1 = process.argv[1];
  return Boolean(argv1 && import.meta.url === pathToFileURL(argv1).href);
}

if (isMainModule()) {
  const options = parseArgs(process.argv.slice(2));
  const protectedByGateway = isGatewayServicePointingAtActiveDist(options.rootDir);
  if (protectedByGateway && !options.force) {
    console.error(
      [
        "clean-dist blocked: openclaw-gateway.service points at this checkout's active dist/index.js.",
        "Use staged build/restore flow instead, or set OPENCLAW_ALLOW_ACTIVE_RUNTIME_CLEAN=1 only after the gateway no longer depends on this runtime.",
      ].join("\n"),
    );
    process.exit(1);
  }

  if (protectedByGateway) {
    const snapshot = snapshotRuntimeAssets({
      rootDir: options.rootDir,
      requireUi: false,
      operation: "snapshot",
    });
    if (!snapshot.ok) {
      console.error(
        `clean-dist blocked: could not snapshot active runtime before forced clean; blocker ${
          snapshot.blocker ?? "runtime_assets_missing"
        }`,
      );
      process.exit(1);
    }
  }

  const removed = cleanOutputRoots(options);
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "clean-dist",
        dryRun: options.dryRun,
        removed,
        rootDir: options.rootDir,
        protectedByGateway,
      },
      null,
      2,
    ),
  );
}
