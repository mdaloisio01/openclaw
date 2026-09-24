#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_PROOF_PATH_COUNT = 32;
const MAX_PROOF_PATH_LENGTH = 4_096;

function resolveBuiltLaneReadinessModule() {
  const directPath = path.resolve(import.meta.dirname, "../dist/lane-readiness.js");
  if (!fs.existsSync(directPath)) {
    throw new Error("Built lane readiness module is missing from dist");
  }
  return directPath;
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stopOwnerProcessTree(child) {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    // taskkill must see the live parent to discover its descendants.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through if the detached group already exited.
    }
  }
  child.kill("SIGKILL");
}

function runOwnerProcess(runnerPath, proofRoot, request, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: proofRoot,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks = [];
    let outputBytes = 0;
    let errorCode;
    const timer = setTimeout(() => {
      errorCode ??= "ETIMEDOUT";
      stopOwnerProcessTree(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_INPUT_BYTES && !errorCode) {
        errorCode = "ENOBUFS";
        stopOwnerProcessTree(child);
      } else if (outputBytes <= MAX_INPUT_BYTES) {
        chunks.push(chunk);
      }
    });
    child.on("error", (error) => {
      errorCode ??= error.code;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        error: errorCode ? { code: errorCode } : undefined,
        status,
        signal,
        stdout: Buffer.concat(chunks).toString("utf8"),
        finishedAtMs: Date.now(),
      });
    });
    child.stdin.on("error", () => {
      // A runner that exits before reading stdin is classified by its exit status.
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const inputArg = arg("input");
if (!inputArg) {
  throw new Error("lane readiness harness requires --input <json-path>");
}
const inputPath = path.resolve(inputArg);
if (!fs.lstatSync(inputPath).isFile()) {
  throw new Error("lane readiness input must be a regular file");
}
const inputDescriptor = fs.openSync(inputPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
let inputText;
try {
  if (!fs.fstatSync(inputDescriptor).isFile()) {
    throw new Error("lane readiness input must remain a regular file");
  }
  const inputBuffer = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < inputBuffer.length) {
    const count = fs.readSync(
      inputDescriptor,
      inputBuffer,
      bytesRead,
      inputBuffer.length - bytesRead,
      null,
    );
    if (count === 0) {
      break;
    }
    bytesRead += count;
  }
  if (bytesRead > MAX_INPUT_BYTES) {
    throw new Error("lane readiness input exceeds the one-megabyte limit");
  }
  inputText = inputBuffer.subarray(0, bytesRead).toString("utf8");
} finally {
  fs.closeSync(inputDescriptor);
}
const input = JSON.parse(inputText);
if (!isRecord(input) || "executions" in input) {
  throw new Error("lane readiness input must contain run metadata, not precomputed executions");
}

const lib = await import(pathToFileURL(resolveBuiltLaneReadinessModule()).href);
const runnerArg = arg("runner");
const proofRootArg = arg("proof-root");
const executions = [];
const timedOutExecutions = new Set();
if (runnerArg || proofRootArg) {
  let runnerPath;
  let proofRoot;
  let preflightFailure;
  try {
    if (!runnerArg || !proofRootArg) {
      throw new Error("missing runner configuration");
    }
    runnerPath = path.resolve(runnerArg);
    proofRoot = fs.realpathSync(path.resolve(proofRootArg));
    if (!fs.statSync(runnerPath).isFile() || !fs.statSync(proofRoot).isDirectory()) {
      throw new Error("invalid runner configuration");
    }
  } catch {
    preflightFailure = "owner runner or proof root is unavailable";
  }
  const checkTimeoutMs = input.checkTimeoutMs ?? 30_000;
  const runTimeoutMs = input.runTimeoutMs ?? 5 * 60_000;
  const runDeadlineMs = Date.now() + runTimeoutMs;
  const recurrenceDeadlineMs = Date.parse(input.checkedAt) + input.recurrenceMs;

  function hasCurrentLocalProof(proofPath, startedAtMs, finishedAtMs) {
    if (
      typeof proofPath !== "string" ||
      path.isAbsolute(proofPath) ||
      /^[a-z][a-z0-9+.-]*:/i.test(proofPath)
    ) {
      return false;
    }
    const resolved = path.resolve(proofRoot, proofPath);
    const relative = path.relative(proofRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return false;
    }
    try {
      const canonical = fs.realpathSync(resolved);
      const canonicalRelative = path.relative(proofRoot, canonical);
      const stat = fs.statSync(canonical);
      return (
        canonicalRelative !== "" &&
        !canonicalRelative.startsWith("..") &&
        !path.isAbsolute(canonicalRelative) &&
        stat.isFile() &&
        stat.size > 0 &&
        stat.mtimeMs >= startedAtMs &&
        stat.mtimeMs <= finishedAtMs
      );
    } catch {
      return false;
    }
  }

  for (const lane of lib.LANE_READINESS_LANES) {
    for (const check of lane.checks) {
      let failure = preflightFailure;
      let execution;
      if (!failure) {
        const startedAtMs = Date.now();
        const timeoutMs = Math.min(
          checkTimeoutMs,
          runDeadlineMs - startedAtMs,
          recurrenceDeadlineMs - startedAtMs,
        );
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
          failure = "owner check deadline expired before execution";
        } else {
          // Each declared check gets its own supervised process and deadline.
          const run = await runOwnerProcess(
            runnerPath,
            proofRoot,
            {
              laneId: lane.id,
              checkId: check.id,
              runLabel: input.runLabel,
              sourceRevision: input.sourceRevision,
              checkedAt: input.checkedAt,
            },
            timeoutMs,
          );
          const finishedAtMs = run.finishedAtMs;
          if (run.error) {
            failure =
              run.error.code === "ETIMEDOUT"
                ? `owner check timed out after ${timeoutMs} ms`
                : run.error.code === "ENOBUFS"
                  ? "owner check output exceeded the bounded response size"
                  : "owner check could not start";
            if (run.error.code === "ETIMEDOUT") {
              timedOutExecutions.add(executions.length);
            }
          } else if (run.signal) {
            failure = /^SIG[A-Z0-9]+$/.test(run.signal)
              ? `owner check terminated by ${run.signal}`
              : "owner check terminated by a signal";
          } else if (run.status !== 0) {
            failure = `owner check exited with status ${run.status ?? "unknown"}`;
          } else if (
            finishedAtMs > startedAtMs + checkTimeoutMs ||
            finishedAtMs > runDeadlineMs ||
            finishedAtMs > recurrenceDeadlineMs
          ) {
            failure = "owner check exceeded its readiness deadline";
          } else {
            try {
              execution = JSON.parse(run.stdout);
              if (
                !isRecord(execution) ||
                execution.laneId !== lane.id ||
                execution.checkId !== check.id
              ) {
                failure = "owner check returned an invalid identity";
              } else if (
                execution.status === "PASS" &&
                (!Array.isArray(execution.proofPaths) ||
                  execution.proofPaths.length === 0 ||
                  execution.proofPaths.length > MAX_PROOF_PATH_COUNT ||
                  execution.proofPaths.some(
                    (proofPath) =>
                      typeof proofPath !== "string" || proofPath.length > MAX_PROOF_PATH_LENGTH,
                  ))
              ) {
                failure = "owner check returned invalid proof file references";
              } else if (
                execution.status === "PASS" &&
                !execution.proofPaths.every(
                  (proofPath) =>
                    Date.now() <= startedAtMs + checkTimeoutMs &&
                    Date.now() <= runDeadlineMs &&
                    Date.now() <= recurrenceDeadlineMs &&
                    hasCurrentLocalProof(proofPath, startedAtMs, finishedAtMs),
                )
              ) {
                failure = "owner check did not produce a current local proof file";
              }
            } catch {
              failure = "owner check returned malformed JSON";
            }
          }
          if (!failure && (Date.now() > runDeadlineMs || Date.now() > recurrenceDeadlineMs)) {
            failure = "owner run deadline expired during proof verification";
          }
        }
      }
      executions.push(
        failure
          ? {
              laneId: lane.id,
              checkId: check.id,
              runLabel: input.runLabel,
              sourceRevision: input.sourceRevision,
              executedAt: new Date().toISOString(),
              status: "FAIL",
              detail: failure,
            }
          : execution,
      );
    }
  }
}

const invalidHandle = Object.freeze({});
const handles = executions.map((execution, index) => {
  if (!isRecord(execution)) {
    return invalidHandle;
  }
  let supervisor;
  try {
    supervisor = lib.createLaneReadinessCheckHandle(execution.laneId, execution.checkId);
  } catch {
    return invalidHandle;
  }
  if (
    typeof execution.runLabel !== "string" ||
    typeof execution.sourceRevision !== "string" ||
    typeof execution.executedAt !== "string"
  ) {
    supervisor.resolve("");
    return supervisor.handle;
  }
  if (timedOutExecutions.has(index)) {
    supervisor.timeout(
      JSON.stringify({
        runLabel: execution.runLabel,
        sourceRevision: execution.sourceRevision,
        executedAt: execution.executedAt,
        status: "FAIL",
        detail: execution.detail,
      }),
    );
  } else if (typeof execution.rejectionDetail === "string") {
    try {
      supervisor.reject(
        JSON.stringify({
          runLabel: execution.runLabel,
          sourceRevision: execution.sourceRevision,
          executedAt: execution.executedAt,
          status: "FAIL",
          detail: execution.rejectionDetail,
        }),
      );
    } catch {
      supervisor.resolve("");
    }
  } else {
    try {
      supervisor.resolve(
        JSON.stringify({
          runLabel: execution.runLabel,
          sourceRevision: execution.sourceRevision,
          executedAt: execution.executedAt,
          status: execution.status,
          proofPaths: execution.proofPaths,
          detail: execution.detail,
        }),
      );
    } catch {
      supervisor.resolve("");
    }
  }
  return supervisor.handle;
});

const report = await lib.runLaneReadinessHarness({
  runLabel: input.runLabel,
  sourceRevision: input.sourceRevision,
  checkedAt: input.checkedAt,
  recurrenceMs: input.recurrenceMs,
  checkTimeoutMs: input.checkTimeoutMs,
  runTimeoutMs: input.runTimeoutMs,
  handles,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "PASS") {
  process.exitCode = 1;
}
