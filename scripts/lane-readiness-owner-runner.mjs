#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const request = JSON.parse(fs.readFileSync(0, "utf8"));
const key = `${request.laneId}.${request.checkId}`;
const executedAt = new Date().toISOString();
const response = {
  laneId: request.laneId,
  checkId: request.checkId,
  runLabel: request.runLabel,
  sourceRevision: request.sourceRevision,
  executedAt,
};
if (
  !/^[a-z][a-z0-9_]{0,63}$/.test(request.laneId) ||
  !/^[a-z][a-z0-9_]{0,63}$/.test(request.checkId) ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.runLabel)
) {
  throw new Error("invalid lane readiness check identity");
}
function respond(status, detail, evidence = {}) {
  const proofPath = path.join("proof", request.laneId, `${request.checkId}.json`);
  const absolute = path.resolve(process.cwd(), proofPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(
    absolute,
    JSON.stringify({ check: key, executedAt, status, ...(detail ? { detail } : {}), ...evidence }),
  );
  process.stdout.write(
    JSON.stringify({
      ...response,
      status,
      proofPaths: [proofPath],
      ...(detail ? { detail } : {}),
    }),
  );
  process.exit(0);
}
const commands = {
  "gateway_runtime.health": ["health", "--json", "--verbose", "--timeout", "10000"],
  "gateway_runtime.method_smoke": ["cron", "list", "--json", "--timeout", "10000"],
};
if (key === "watchdog.fixture_matrix") {
  const ownerTest =
    "/home/will/.openclaw/workspace-orchestrator/scripts/test_system_wide_active_work_watchdog.py";
  const run = spawnSync("python3", [ownerTest], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64_000,
  });
  const testCount = Number(/Ran (\d+) tests? in/.exec(run.stderr ?? "")?.[1]);
  let ownerTestSha256;
  try {
    ownerTestSha256 = createHash("sha256").update(fs.readFileSync(ownerTest)).digest("hex");
  } catch {
    // A missing owner test remains a FAIL with its process error recorded.
  }
  const evidence = {
    ownerTest,
    ownerTestSha256,
    testCount,
    exitCode: run.status,
  };
  if (
    run.status !== 0 ||
    !Number.isSafeInteger(testCount) ||
    testCount <= 0 ||
    !ownerTestSha256 ||
    !(run.stderr ?? "").includes("\nOK\n")
  ) {
    respond(
      "FAIL",
      `Owner watchdog fixture matrix failed: exit=${run.status ?? "none"}, error=${run.error?.code ?? "none"}, tests=${testCount}`,
      evidence,
    );
  }
  respond("PASS", undefined, evidence);
}
if (
  key === "will_controller.active_worker_proof" ||
  key === "will_controller.final_source_delivery" ||
  key === "cleanup_crew.clean_watchdog" ||
  key === "cleanup_crew.stale_worker" ||
  key === "cleanup_crew.repair_routing" ||
  key === "watchdog.cron_freshness" ||
  key === "watchdog.seven_dimensions" ||
  key === "watchdog.repair_closure" ||
  key === "source_report_delivery.failure_notice" ||
  key === "source_report_delivery.final_delivered" ||
  key === "source_report_delivery.obligation_round_trip"
) {
  // This owner command reads the live SQLite store in report-only mode.
  // A fresh scan is evidence; its metadata alone cannot certify a clean lane.
  const ownerScript =
    "/home/will/.openclaw/workspace-orchestrator/scripts/system_wide_active_work_watchdog.py";
  const command = [
    ownerScript,
    "--mode",
    "report-only",
    "--reason",
    "lane-readiness",
    "--chat-delivery",
    "off",
    "--stdout-json",
  ];
  const run = spawnSync("python3", command, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  let receipt;
  try {
    const jsonStart = run.stdout.indexOf("{");
    receipt = JSON.parse(run.stdout.slice(jsonStart)).receipt;
  } catch {
    // A missing or malformed owner receipt cannot certify the lane.
  }
  const validReceipt =
    receipt?.watchdog === "system_wide_active_work_watchdog" &&
    typeof receipt.checked_at === "string" &&
    Number.isSafeInteger(receipt.summary?.items_suspicious) &&
    receipt.summary?.by_category !== null &&
    typeof receipt.summary?.by_category === "object" &&
    Array.isArray(receipt.decisions?.suspicious_items) &&
    receipt.decisions.suspicious_items.length === Math.min(receipt.summary.items_suspicious, 200) &&
    Array.isArray(receipt.clean_dimensions_required);
  if (run.status !== 0 || !validReceipt) {
    respond(
      "FAIL",
      `${key} owner watchdog scan failed: exit=${run.status ?? "none"}, error=${run.error?.code ?? "none"}, validReceipt=${validReceipt}`,
      { ownerCommand: command },
    );
  }
  const suspicious = receipt.summary?.items_suspicious;
  const cron = receipt.watchdog_cron;
  const sourceFailed = receipt.summary.by_category.source_delivery_failed ?? 0;
  const sourceStale = receipt.summary.by_category.source_delivery_stale ?? 0;
  const suspiciousItems = receipt.decisions.suspicious_items;
  // The owner caps item detail at 200; a truncated list cannot prove worker health.
  const completeItemList = suspicious <= 200;
  const workerFindings = suspiciousItems.filter((item) =>
    ["task_run", "flow_run", "subagent_run"].includes(item.entity_type),
  ).length;
  const intakeGaps = suspiciousItems.filter(
    (item) => item.entity_type === "owner_request_intake",
  ).length;
  if (
    key === "cleanup_crew.stale_worker" &&
    completeItemList &&
    workerFindings === 0 &&
    receipt.coverage?.task_runs === true &&
    receipt.coverage?.flow_runs === true &&
    receipt.coverage?.subagent_runs === true
  ) {
    respond("PASS", undefined, {
      ownerCommand: command,
      ownerCheckedAt: receipt.checked_at,
      workerFindings,
      coverage: receipt.coverage,
    });
  }
  let detail;
  if (key === "will_controller.active_worker_proof") {
    detail = `Owner watchdog scan found ${completeItemList ? "" : "at least "}${workerFindings} suspicious worker records; active ownership proof unavailable`;
  } else if (key === "will_controller.final_source_delivery") {
    detail = `Owner watchdog found ${sourceFailed} failed and ${sourceStale} stale source-delivery obligations; final source delivery proof unavailable`;
  } else if (key === "cleanup_crew.clean_watchdog") {
    detail = `Owner watchdog scan found ${suspicious} suspicious items; clean watchdog proof unavailable`;
  } else if (key === "cleanup_crew.stale_worker") {
    detail = `Owner watchdog scan found ${completeItemList ? "" : "at least "}${workerFindings} suspicious worker records; clean worker proof unavailable`;
  } else if (key === "cleanup_crew.repair_routing") {
    detail = `Owner watchdog scan found ${completeItemList ? "" : "at least "}${intakeGaps} owner-request intake gaps; executed repair route proof unavailable`;
  } else if (key === "watchdog.cron_freshness") {
    detail = `Owner watchdog cron has enabled=${cron?.enabled}, lastRunStatus=${cron?.last_run_status}, lastRunAt=${cron?.last_run_at}; fresh scheduled proof unavailable`;
  } else if (key === "watchdog.seven_dimensions") {
    detail = `Owner scan declares ${receipt.clean_dimensions_required.length} clean dimensions and found ${suspicious} suspicious items; seven-dimension clean proof unavailable`;
  } else if (key === "watchdog.repair_closure") {
    detail = `Owner watchdog scan found ${suspicious} suspicious items; routed repair closure proof unavailable`;
  } else if (key === "source_report_delivery.failure_notice") {
    detail = `Owner watchdog found ${sourceFailed} failed source-delivery obligations; visible failure notice proof unavailable`;
  } else if (key === "source_report_delivery.obligation_round_trip") {
    detail = `Owner watchdog found ${sourceFailed} failed and ${sourceStale} stale delivery obligations; live obligation round-trip proof unavailable`;
  } else {
    detail = `Owner watchdog found ${sourceFailed} failed and ${sourceStale} stale source-delivery obligations; final delivery proof unavailable`;
  }
  respond("FAIL", detail, {
    ownerCommand: command,
    ownerCheckedAt: receipt.checked_at,
    suspiciousItems: suspicious,
    workerFindings,
    ownerRequestIntakeGaps: intakeGaps,
    sourceDeliveryFailed: sourceFailed,
    sourceDeliveryStale: sourceStale,
    cleanDimensionsRequired: receipt.clean_dimensions_required,
    cron: {
      enabled: cron?.enabled,
      lastRunStatus: cron?.last_run_status,
      lastRunAt: cron?.last_run_at,
      nextRunAt: cron?.next_run_at,
    },
  });
}
if (
  request.laneId === "file_hub_export" &&
  ["write_export", "dashboard_listing", "download_readback", "hash_match"].includes(request.checkId)
) {
  const exportDir = path.dirname(process.cwd());
  const name = `${request.runLabel}-export-probe.json`;
  const sourcePath = path.join(exportDir, name);
  const dashboardReportPath = path.join(
    os.homedir(),
    ".openclaw",
    "workspace",
    "file_hub",
    "exports",
    name,
  );
  const probe = {
    schema: "openclaw.lane_readiness_export_probe.v1",
    runLabel: request.runLabel,
    sourceRevision: request.sourceRevision,
    checkedAt: request.checkedAt,
  };
  if (key === "file_hub_export.write_export") {
    try {
      fs.writeFileSync(sourcePath, JSON.stringify(probe) + "\n", { flag: "wx" });
      fs.copyFileSync(sourcePath, dashboardReportPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      respond(
        "FAIL",
        `Current readiness export probe could not be published: ${error?.code ?? "unknown"}`,
      );
    }
  }
  if (!fs.existsSync(sourcePath) || !fs.existsSync(dashboardReportPath)) {
    respond("FAIL", "Current readiness export probe is absent from File Hub");
  }
  const sourceBytes = fs.readFileSync(sourcePath);
  if (sourceBytes.toString("utf8") !== JSON.stringify(probe) + "\n") {
    respond("FAIL", "Current readiness export probe has the wrong run identity");
  }
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  const evidence = {
    sourcePath,
    dashboardReportPath,
    sourceHash,
    probe,
  };
  if (key === "file_hub_export.write_export") {
    const dashboardHash = createHash("sha256")
      .update(fs.readFileSync(dashboardReportPath))
      .digest("hex");
    if (dashboardHash !== sourceHash) {
      respond("FAIL", "Dashboard File Hub export differs from the current probe", {
        ...evidence,
        dashboardHash,
      });
    }
    respond("PASS", undefined, { ...evidence, dashboardHash });
  }
  let token;
  try {
    token = fs
      .readFileSync(
        path.join(os.homedir(), ".openclaw", "workspace", ".dashboard_api_token"),
        "utf8",
      )
      .trim();
  } catch {
    respond("FAIL", "Dashboard authentication token is unavailable", evidence);
  }
  if (!token) {
    respond("FAIL", "Dashboard authentication token is empty", evidence);
  }
  const headers = { Authorization: `Bearer ${token}` };
  const base = "http://127.0.0.1:18888";
  try {
    if (key === "file_hub_export.dashboard_listing") {
      const url = `${base}/api/file-hub/browse?path=exports&query=${encodeURIComponent(name)}&limit=10`;
      const result = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      const listing = result.ok ? await result.json() : undefined;
      const item = listing?.items?.find(
        (entry) =>
          entry.name === name && entry.relPath === `exports/${name}` && entry.type === "file",
      );
      if (!item) {
        respond(
          "FAIL",
          `Dashboard File Hub listing omitted the export: HTTP ${result.status}`,
          evidence,
        );
      }
      respond("PASS", undefined, {
        ...evidence,
        httpStatus: result.status,
        listedPath: item.relPath,
      });
    }
    const url = `${base}/api/file-hub/download?path=${encodeURIComponent(`exports/${name}`)}`;
    const result = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!result.ok) {
      respond("FAIL", `Dashboard File Hub download failed: HTTP ${result.status}`, evidence);
    }
    const downloaded = Buffer.from(await result.arrayBuffer());
    const downloadedHash = createHash("sha256").update(downloaded).digest("hex");
    if (key === "file_hub_export.download_readback") {
      let readback;
      try {
        readback = JSON.parse(downloaded.toString("utf8"));
      } catch {
        respond("FAIL", "Dashboard download is not a readable readiness export probe", evidence);
      }
      if (
        readback.schema !== probe.schema ||
        readback.runLabel !== probe.runLabel ||
        readback.sourceRevision !== probe.sourceRevision ||
        readback.checkedAt !== probe.checkedAt
      ) {
        respond(
          "FAIL",
          "Dashboard download does not match the current export probe identity",
          evidence,
        );
      }
      respond("PASS", undefined, { ...evidence, downloadedHash, httpStatus: result.status });
    }
    if (downloadedHash !== sourceHash) {
      respond("FAIL", "Dashboard download hash differs from the current source export", {
        ...evidence,
        downloadedHash,
      });
    }
    respond("PASS", undefined, { ...evidence, downloadedHash, httpStatus: result.status });
  } catch (error) {
    respond("FAIL", `Dashboard File Hub probe failed: ${error?.name ?? "unknown"}`, evidence);
  }
}
const args = commands[key];
if (!args && key !== "gateway_runtime.build_info") {
  respond("FAIL", `No production owner command is registered for ${key}`);
}

// The CLI can probe a healthy older Gateway. Bind PASS to the built source and
// the selected Gateway process, or the report would misattribute it.
const buildInfoPath = path.resolve(import.meta.dirname, "../dist/build-info.json");
let buildInfo;
try {
  buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
} catch {
  respond("FAIL", `${key} build-info.json is missing or unreadable`);
}
const builtAtMs = Date.parse(buildInfo.builtAt);
if (
  buildInfo.commit !== request.sourceRevision ||
  buildInfo.dirty !== false ||
  !Number.isFinite(builtAtMs)
) {
  respond(
    "FAIL",
    `${key} build identity mismatch: source=${request.sourceRevision}, build=${buildInfo.commit}, buildDirty=${buildInfo.dirty}`,
    { buildCommit: buildInfo.commit, buildDirty: buildInfo.dirty },
  );
}
const entry = path.resolve(import.meta.dirname, "../dist/entry.js");
const probeEnv = { ...process.env };
delete probeEnv.OPENCLAW_GATEWAY_URL;
const statusRun = spawnSync(process.execPath, [entry, "gateway", "status", "--json"], {
  encoding: "utf8",
  timeout: 10_000,
  maxBuffer: 512_000,
  env: probeEnv,
});
let gatewayStatus;
try {
  gatewayStatus = JSON.parse(statusRun.stdout);
} catch {
  // An unparseable status cannot bind the RPC endpoint to the local service.
}
const runtimePid = gatewayStatus?.service?.runtime?.pid;
const matchingListener = gatewayStatus?.port?.listeners?.some(
  (listener) => listener.pid === runtimePid,
);
const distRoot = path.resolve(import.meta.dirname, "../dist");
const gatewayEntrypoint = gatewayStatus?.service?.command?.programArguments?.find(
  (argument) =>
    path.dirname(argument) === distRoot &&
    ["index.js", "index.mjs", "entry.js", "entry.mjs"].includes(path.basename(argument)),
);
const modeRun = spawnSync(process.execPath, [entry, "config", "get", "gateway.mode", "--json"], {
  encoding: "utf8",
  timeout: 10_000,
  maxBuffer: 64_000,
  env: probeEnv,
});
let gatewayMode;
try {
  gatewayMode = JSON.parse(modeRun.stdout);
} catch {
  // A missing effective mode cannot bind later CLI calls to this Gateway.
}
const localGateway =
  statusRun.status === 0 &&
  gatewayStatus?.service?.runtime?.status === "running" &&
  Number.isSafeInteger(runtimePid) &&
  matchingListener === true &&
  gatewayStatus?.rpc?.ok === true &&
  gatewayStatus.rpc.url === gatewayStatus.gateway?.probeUrl &&
  gatewayStatus?.rpc?.server?.version === gatewayStatus?.gateway?.version &&
  gatewayStatus?.config?.cli?.path === gatewayStatus?.config?.daemon?.path &&
  modeRun.status === 0 &&
  gatewayMode === "local" &&
  Number.isSafeInteger(gatewayStatus?.gateway?.port) &&
  gatewayStatus.gateway.port > 0 &&
  gatewayStatus.gateway.port <= 65_535 &&
  Boolean(gatewayEntrypoint);
const unitPath = gatewayStatus?.service?.command?.sourcePath;
const unitName = typeof unitPath === "string" ? path.basename(unitPath) : "";
if (!localGateway || !/^openclaw-[A-Za-z0-9_.@-]+\.service$/.test(unitName)) {
  respond("FAIL", `${key} could not bind the probed Gateway to the running local service`);
}
probeEnv.OPENCLAW_GATEWAY_PORT = String(gatewayStatus.gateway.port);

let unitFacts = {};
let unitScope;
for (const scope of ["user", "system"]) {
  const unitRun = spawnSync(
    "systemctl",
    [
      ...(scope === "user" ? ["--user"] : []),
      "show",
      unitName,
      "-p",
      "MainPID",
      "-p",
      "ActiveState",
      "-p",
      "ExecMainStartTimestamp",
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  const facts = Object.fromEntries(
    (unitRun.stdout ?? "")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  if (
    unitRun.status === 0 &&
    facts.ActiveState === "active" &&
    Number(facts.MainPID) === runtimePid
  ) {
    unitFacts = facts;
    unitScope = scope;
    break;
  }
}
const startedAtMs = Date.parse(unitFacts.ExecMainStartTimestamp ?? "");
if (!unitScope || !Number.isFinite(startedAtMs) || startedAtMs < builtAtMs) {
  respond("FAIL", `${key} selected Gateway process is not bound to the current build`);
}
if (key === "gateway_runtime.build_info") {
  const buildInfoSha256 = createHash("sha256").update(fs.readFileSync(buildInfoPath)).digest("hex");
  respond("PASS", undefined, {
    buildInfoPath,
    buildInfoSha256,
    buildCommit: buildInfo.commit,
    builtAt: buildInfo.builtAt,
    gatewayStartedAt: new Date(startedAtMs).toISOString(),
    gatewayPid: runtimePid,
    gatewayUnit: unitName,
    gatewayUnitScope: unitScope,
  });
}

const result = spawnSync(process.execPath, [entry, ...args], {
  encoding: "utf8",
  timeout: 15_000,
  maxBuffer: 512_000,
  env: probeEnv,
});
let payload;
try {
  payload = JSON.parse(result.stdout);
} catch {
  // A successful owner probe must return a structured response.
}
const healthy =
  key === "gateway_runtime.health"
    ? payload?.ok === true &&
      payload?.eventLoop?.degraded === false &&
      (payload?.plugins === undefined ||
        (Array.isArray(payload.plugins.errors) && payload.plugins.errors.length === 0))
    : Array.isArray(payload?.jobs);
if (result.status !== 0 || !payload || !healthy) {
  respond(
    "FAIL",
    `${key} CLI probe failed: exit=${result.status ?? "none"}, error=${result.error?.code ?? "none"}, validJson=${Boolean(payload)}, healthy=${healthy}`,
    { command: args, exitCode: result.status, errorCode: result.error?.code },
  );
}

respond("PASS", undefined, {
  command: args,
  exitCode: result.status,
  sourceRevision: request.sourceRevision,
  buildCommit: buildInfo.commit,
  buildAt: buildInfo.builtAt,
  gatewayStartedAt: new Date(startedAtMs).toISOString(),
  gatewayPid: runtimePid,
  gatewayUrl: gatewayStatus.rpc.url,
  gatewayUnit: unitName,
  gatewayUnitScope: unitScope,
  result:
    key === "gateway_runtime.health"
      ? {
          ok: payload.ok,
          observedAt: payload.ts,
          durationMs: payload.durationMs,
          eventLoopDegraded: payload.eventLoop?.degraded,
          pluginErrorCount: payload.plugins?.errors?.length,
        }
      : { jobCount: payload.jobs.length, total: payload.total },
});
