#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function resolveBuiltLibraryModule() {
  const directPath = path.resolve(import.meta.dirname, "../dist/library.js");
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  const distDir = path.resolve(import.meta.dirname, "../dist");
  const candidates = fs
    .readdirSync(distDir)
    .filter((name) => /^library-[A-Za-z0-9_-]+\.js$/.test(name))
    .map((name) => path.join(distDir, name))
    .toSorted((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length === 0) {
    throw new Error("No built library module found in dist");
  }
  return candidates[0];
}

const lib = await import(pathToFileURL(resolveBuiltLibraryModule()).href);

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const command = process.argv[2] ?? "status";
const workspaceDir = arg("workspace", process.env.OPENCLAW_WORKSPACE_DIR);

if (command === "status") {
  json(lib.getCleanupWatchdogLiveControllerState({ workspaceDir }));
} else if (command === "activate") {
  const gates = {
    requestedMode: "enforce",
    policySchemaGenerated: flag("policy-schema-generated"),
    sopParityValidated: flag("sop-parity-validated"),
    sourceBuiltRuntimeMatch: flag("source-built-runtime-match"),
    watchdogClean: flag("watchdog-clean"),
    knownRepairStateCovered: flag("known-repair-state-covered"),
    workerCoverageProven: flag("worker-coverage-proven"),
    shadowDecisionsStable: flag("shadow-decisions-stable"),
    repairTasksDrained: flag("repair-tasks-drained"),
    grantReviewPassed: flag("grant-review-passed"),
    rollbackPlanVerified: flag("rollback-plan-verified"),
    productionPaused: flag("production-paused"),
    trinityUnstarted: flag("trinity-unstarted"),
    controlPlanePhase2Paused: flag("control-plane-phase2-paused"),
  };
  json(
    lib.activateCleanupWatchdogLiveController({
      workspaceDir,
      command: process.argv.join(" "),
      runtimePid: Number(arg("runtime-pid", process.pid)) || process.pid,
      buildInfoPath: arg("build-info"),
      controllerSourcePath: arg("controller-source"),
      policySourcePath: arg("policy-source"),
      skillPath: arg("skill"),
      receiptPath: arg("receipt"),
      gates,
    }),
  );
} else if (command === "rollback") {
  json(
    lib.rollbackCleanupWatchdogLiveController({
      workspaceDir,
      reason: arg("reason", "governed rollback exercise"),
    }),
  );
} else if (command === "canaries") {
  json(lib.runCleanupWatchdogControlledCanaries({ workspaceDir }));
} else if (command === "live-recovery-exercise") {
  json(lib.runCleanupWatchdogLiveRecoveryExercise({ workspaceDir, cleanup: !flag("keep-canary") }));
} else if (command === "receipt-decision") {
  const receiptPath = arg("receipt");
  const missionId = arg("mission");
  if (!receiptPath || !missionId) {
    throw new Error("receipt-decision requires --receipt and --mission");
  }
  const receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), "utf8"));
  json(lib.evaluateReceiptWithLiveController({ workspaceDir, receipt, missionId }));
} else if (command === "consume-receipt") {
  const receiptPath = arg("receipt");
  const missionId = arg("mission");
  if (!receiptPath || !missionId) {
    throw new Error("consume-receipt requires --receipt and --mission");
  }
  const receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), "utf8"));
  json(
    lib.consumeReceiptWithLiveController({
      workspaceDir,
      receipt,
      missionId,
      ownerKey: arg("owner-key"),
      sessionKey: arg("session-key"),
      currentStep: arg("current-step"),
      currentTurnText: arg("current-turn-text"),
    }),
  );
} else {
  throw new Error(`Unknown command: ${command}`);
}
