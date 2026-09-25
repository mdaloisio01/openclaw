import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  loadSourceTurnDeliveryRegistry,
  resolveSourceTurnDeliveryRegistryPath,
} from "../../src/agents/source-turn-delivery-store.ts";
import { GatewayClient } from "../../src/gateway/client.ts";
import { applyMockOpenAiModelConfig } from "./lib/fixtures/mock-openai-config.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const proofDir =
  process.env.CASE4_PROOF_DIR ?? path.join(os.tmpdir(), `openclaw-case4-${randomUUID()}`);
const home = path.join(proofDir, "home");
const stateDir = path.join(home, ".openclaw");
const sessionKey = `agent:main:sop-case4-${randomUUID()}`;
const marker = "OPENCLAW_E2E_OK_4";
const gatewayPort = 18791;
const mockPort = 18792;
const inspectorPort = 18793;
const token = randomBytes(24).toString("hex");
const children = [];
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
const cfg = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port: gatewayPort,
    auth: { mode: "token", token },
    controlUi: { enabled: false },
  },
  agents: { defaults: { workspace: path.join(home, "workspace") } },
};
applyMockOpenAiModelConfig(cfg, { mockPort });
fs.writeFileSync(path.join(stateDir, "openclaw.json"), `${JSON.stringify(cfg, null, 2)}\n`, {
  mode: 0o600,
});
const env = {
  ...process.env,
  HOME: home,
  OPENCLAW_HOME: home,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_AUTH_PROFILE_SECRET_KEY: randomBytes(32).toString("hex"),
  OPENAI_API_KEY: "isolated-mock-only",
  MOCK_PORT: String(mockPort),
  SUCCESS_MARKER: marker,
  MOCK_REQUEST_LOG: path.join(proofDir, "mock-requests.jsonl"),
};
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = env.OPENCLAW_CONFIG_PATH;
process.env.OPENCLAW_HOME = home;

function start(name, args, logName) {
  const log = fs.openSync(path.join(proofDir, logName), "w", 0o600);
  const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  children.push(child);
  return child;
}

async function until(label, check, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) {
      return value;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function breakpointLocation() {
  const dir = path.join(repo, "dist");
  const files = fs.readdirSync(dir).filter((name) => /^dispatch-[^/]+\.js$/u.test(name));
  const matches = files.flatMap((name) => {
    const lines = fs.readFileSync(path.join(dir, name), "utf8").split("\n");
    const preparedLine = lines.findIndex((text) =>
      text.includes("required source final preparation was not persisted"),
    );
    const offset = lines
      .slice(preparedLine + 1, preparedLine + 8)
      .findIndex((text) => text.includes("markInboundDedupeReplayUnsafe()"));
    const line = preparedLine >= 0 && offset >= 0 ? preparedLine + 1 + offset : -1;
    return line >= 0 ? [{ name, line }] : [];
  });
  assert.equal(matches.length, 1, "expected one built prepared-final publication boundary");
  return matches[0];
}

async function inspector() {
  const targets = await until("inspector", async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  });
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let nextId = 0;
  const pending = new Map();
  const target = { breakpointId: undefined };
  let startupPaused;
  const startupPausedPromise = new Promise((resolve) => {
    startupPaused = resolve;
  });
  let paused;
  const pausedPromise = new Promise((resolve) => {
    paused = resolve;
  });
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.method === "Debugger.paused" && frame.params.reason === "Break on start") {
      startupPaused(frame.params);
    }
    if (
      frame.method === "Debugger.paused" &&
      frame.params.hitBreakpoints?.includes(target.breakpointId)
    ) {
      paused(frame.params);
    }
    const waiter = pending.get(frame.id);
    if (waiter) {
      pending.delete(frame.id);
      if (frame.error) {
        waiter.reject(new Error(frame.error.message));
      } else {
        waiter.resolve(frame.result);
      }
    }
  });
  function request(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await request("Debugger.enable");
  const location = breakpointLocation();
  const breakpoint = await request("Debugger.setBreakpointByUrl", {
    lineNumber: location.line,
    urlRegex: `dispatch-[^/]+\\.js$`,
  });
  target.breakpointId = breakpoint.breakpointId;
  await request("Runtime.runIfWaitingForDebugger");
  await Promise.race([
    startupPausedPromise,
    delay(15_000).then(() => {
      throw new Error("Gateway did not report its inspector startup pause");
    }),
  ]);
  // --inspect-brk pauses on the first script line after the attach gate.
  // Release that pause while keeping the prepared-final breakpoint.
  await request("Debugger.resume");
  return { ws, pausedPromise, location };
}

async function gatewayClient() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${gatewayPort}`,
      token,
      deviceIdentity: null,
      clientName: "gateway-client",
      clientDisplayName: "isolated SOP Case4 proof",
      mode: "backend",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      requestTimeoutMs: 30_000,
      onHelloOk: () => {
        if (!settled) {
          settled = true;
          resolve(client);
        }
      },
      onConnectError: (error) => {
        if (!settled) {
          settled = true;
          client.stop();
          reject(error);
        }
      },
    });
    client.start();
  });
}

function sessionEntry() {
  const store = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  if (!fs.existsSync(store)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(store, "utf8"))[sessionKey] ?? null;
}

function transcript(entry) {
  if (!entry?.sessionId) {
    return [];
  }
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const file = entry.sessionFile
    ? path.resolve(sessionsDir, entry.sessionFile)
    : path.join(sessionsDir, `${entry.sessionId}.jsonl`);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function sourceRows(runId) {
  const registry = await loadSourceTurnDeliveryRegistry(resolveSourceTurnDeliveryRegistryPath());
  return registry.rows.filter(
    (row) =>
      row.sourceSessionKey === sessionKey &&
      row.deliveryContext?.channel === "webchat" &&
      row.obligationIdentity.runId === runId,
  );
}

try {
  const mock = start("mock", ["scripts/e2e/mock-openai-server.mjs"], "mock.log");
  await until("mock OpenAI health", async () => {
    try {
      return (await fetch(`http://127.0.0.1:${mockPort}/health`)).ok;
    } catch {
      return false;
    }
  });
  assert.equal(mock.exitCode, null);
  const gateway = start(
    "gateway",
    [`--inspect-brk=127.0.0.1:${inspectorPort}`, "openclaw.mjs", "gateway", "run", "--verbose"],
    "gateway-before.log",
  );
  const debug = await inspector();
  await until("isolated gateway socket", async () => {
    try {
      const c = await gatewayClient();
      c.stop();
      return true;
    } catch {
      return false;
    }
  });
  const client = await gatewayClient();
  const runId = `sop-case4-${randomUUID()}`;
  const started = await client.request("chat.send", {
    sessionKey,
    idempotencyKey: runId,
    message: `Reply only ${marker}`,
  });
  assert.equal(started.status, "started");
  const pause = await Promise.race([
    debug.pausedPromise,
    delay(90_000).then(() => {
      throw new Error("prepared-final breakpoint not reached");
    }),
  ]);
  assert.equal(pause.callFrames[0].location.lineNumber, debug.location.line);
  const before = sessionEntry();
  assert.equal(before?.status, "done");
  assert.equal(before?.pendingFinalDelivery, true);
  assert.equal(before?.pendingFinalDeliveryText, marker);
  const beforeMessages = transcript(before);
  const beforeRows = await sourceRows(runId);
  assert.equal(beforeRows.length, 1, "original run must own one source row");
  const prepared = beforeRows[0].preparedSourceFinal;
  assert.equal(prepared?.kind, "source_session_transcript");
  assert.equal(prepared?.sessionId, before.sessionId);
  assert.equal(prepared?.pendingFinalDeliveryCreatedAt, before.pendingFinalDeliveryCreatedAt);
  assert.equal(prepared?.parts.length, 1);
  assert.equal(prepared?.parts[0].text, marker);
  assert.equal(beforeRows[0].finalDeliveryDelivered, false);
  const sourceKey = prepared.parts[0].idempotencyKey;
  assert.equal(
    beforeMessages.filter((record) => record.message?.idempotencyKey === sourceKey).length,
    0,
    "source receipt must not exist before restart",
  );
  fs.writeFileSync(
    path.join(proofDir, "before-restart.json"),
    JSON.stringify(
      {
        sessionKey,
        runId,
        pendingText: before.pendingFinalDeliveryText,
        pendingCreatedAt: before.pendingFinalDeliveryCreatedAt,
        status: before.status,
        breakpoint: debug.location,
        transcriptMessageCountBefore: beforeMessages.length,
        sourceRowId: beforeRows[0].id,
        sourceKey,
        sourceRowPrepared: Boolean(prepared),
        sourceRowDeliveredBefore: beforeRows[0].finalDeliveryDelivered,
      },
      null,
      2,
    ),
  );
  gateway.kill("SIGKILL");
  await until("first gateway exit", () => gateway.exitCode !== null || gateway.signalCode !== null);
  debug.ws.close();
  client.stop();
  const restarted = start(
    "gateway-restarted",
    ["openclaw.mjs", "gateway", "run", "--verbose"],
    "gateway-after.log",
  );
  await until("restarted gateway socket", async () => {
    try {
      const c = await gatewayClient();
      c.stop();
      return true;
    } catch {
      return false;
    }
  });
  const recovered = await gatewayClient();
  const observed = await until(
    "exact source publication after restart",
    async () => {
      const rows = await sourceRows(runId);
      const receipt = transcript(sessionEntry()).filter(
        (record) => record.message?.idempotencyKey === sourceKey,
      );
      return rows.length === 1 && rows[0].finalDeliveryDelivered && receipt.length === 1
        ? { row: rows[0], receipt: receipt[0] }
        : null;
    },
    120_000,
  );
  const history = await recovered.request("chat.history", { sessionKey, limit: 50 });
  const after = sessionEntry();
  const afterMessages = transcript(after);
  const newReceipts = afterMessages
    .slice(beforeMessages.length)
    .filter((record) => record.message?.idempotencyKey === sourceKey);
  const historyMarkerCount = (history.messages ?? []).filter(
    (message) =>
      message.role === "assistant" && JSON.stringify(message.content ?? "").includes(marker),
  ).length;
  const mockRequests = fs.readFileSync(env.MOCK_REQUEST_LOG, "utf8").trim().split("\n").length;
  const result = {
    status:
      observed.row.id === beforeRows[0].id &&
      observed.row.visibleDeliveryCount === 1 &&
      newReceipts.length === 1 &&
      observed.receipt.message?.display === false &&
      Boolean(observed.receipt.message?.sourceDelivery?.visibleMessageId) &&
      after?.pendingFinalDelivery !== true &&
      after?.abortedLastRun !== true &&
      historyMarkerCount === 1 &&
      mockRequests === 1 &&
      restarted.pid !== gateway.pid
        ? "PASS"
        : "FAIL",
    sessionKey,
    runId,
    sourceKey,
    sourceRowId: observed.row.id,
    sourceRowDeliveredAfter: observed.row.finalDeliveryDelivered,
    sourceVisibleDeliveryCount: observed.row.visibleDeliveryCount,
    sourceReceiptCountAfterRestart: newReceipts.length,
    sourceReceiptHidden: observed.receipt.message?.display === false,
    nativeVisibleMessageId: observed.receipt.message?.sourceDelivery?.visibleMessageId,
    webchatHistoryMarkerCount: historyMarkerCount,
    transcriptMessageCountBefore: beforeMessages.length,
    transcriptMessageCountAfter: afterMessages.length,
    after: {
      status: after?.status,
      abortedLastRun: after?.abortedLastRun,
      pendingFinalDelivery: after?.pendingFinalDelivery,
      pendingFinalDeliveryText: after?.pendingFinalDeliveryText,
    },
    gatewayRestarted: restarted.pid !== gateway.pid,
    mockRequests,
  };
  fs.writeFileSync(
    path.join(proofDir, "after-restart.json"),
    `${JSON.stringify({ row: observed.row, receipt: observed.receipt, history }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(proofDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, proofDir }));
  assert.equal(result.status, "PASS");
  recovered.stop();
} finally {
  for (const child of children) {
    child.kill("SIGKILL");
  }
}
