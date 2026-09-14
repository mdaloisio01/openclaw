import crypto from "node:crypto";
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfigIO, readConfigFileSnapshot } from "../config/config.js";
import { VERSION } from "../version.js";
import { prepareConfigWriteCandidateForControlPlane } from "./server-methods/config.js";
import {
  loadGatewayConfig,
  openAuthenticatedGatewayWs,
  waitForGatewayWsClose,
} from "./shared-auth.test-helpers.js";
import {
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const ORIGINAL_GATEWAY_AUTH = testState.gatewayAuth;
const OLD_TOKEN = "shared-token-session-old";
const NEW_TOKEN = "shared-token-session-new";
const TEST_ACTIVATION_AT = "2026-07-14T12:00:00.000Z";

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port = 0;
let configSetRotationCase: {
  closed: Awaited<ReturnType<typeof waitForGatewayWsClose>>;
  setOk: boolean;
};

beforeAll(async () => {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  port = await getFreePort();
  testState.gatewayAuth = undefined;
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          auth: {
            mode: "token",
            token: OLD_TOKEN,
          },
          reload: {
            mode: "off",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  server = await startGatewayServer(port, { controlUiEnabled: true });

  const ws = await openAuthenticatedGatewayWs(port, OLD_TOKEN);
  try {
    const current = await loadGatewayConfig(ws);
    const nextConfig = buildConfigSetWithRotatedToken(current.config);
    const closed = waitForGatewayWsClose(ws, 30_000);
    const setRes = await rpcReq(ws, "config.set", {
      baseHash: current.hash,
      raw: JSON.stringify(nextConfig, null, 2),
      ...(await controlPlaneEnvelope(JSON.stringify(nextConfig, null, 2))),
    });
    configSetRotationCase = {
      closed: await closed,
      setOk: setRes.ok,
    };
  } finally {
    ws.close();
  }
});

afterAll(async () => {
  testState.gatewayAuth = ORIGINAL_GATEWAY_AUTH;
  await server.close();
});

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildConfigSetWithRotatedToken(config: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(config);
  const gateway = { ...toRecord(next.gateway) };
  const auth = { ...toRecord(gateway.auth), mode: "token", token: NEW_TOKEN };
  const reload = { ...toRecord(gateway.reload), mode: "off" };
  gateway.auth = auth;
  gateway.reload = reload;
  next.gateway = gateway;
  return next;
}

async function controlPlaneEnvelope(raw: string) {
  const snapshot = await readConfigFileSnapshot();
  const prepared = prepareConfigWriteCandidateForControlPlane({ raw, snapshot });
  const stampedConfig = {
    ...prepared.writeConfig,
    meta: {
      ...toRecord(prepared.writeConfig.meta),
      lastTouchedVersion: VERSION,
      lastTouchedAt: TEST_ACTIVATION_AT,
    },
  };
  const candidateRaw = `${JSON.stringify(stampedConfig, null, 2)}\n`;
  const candidateSha256 = crypto.createHash("sha256").update(candidateRaw, "utf-8").digest("hex");
  return {
    controlPlaneManifest: {
      manifestId: "manifest-config.set",
      objective: "gateway shared token session rotation test",
      activationTimestamp: TEST_ACTIVATION_AT,
      candidateSha256,
      allowedFiles: [createConfigIO().configPath],
      allowedConfigPaths: ["gateway", "meta"],
      forbiddenFiles: ["/tmp/forbidden-openclaw.json"],
      allowedServices: ["openclaw-gateway.service"],
      allowedRestartScope: "gateway",
      allowedAgents: ["unknown-actor", "test"],
      allowedTools: ["config.set"],
      approvalClasses: ["auth", "control", "runtime"],
      requiredEvidence: ["integration-test"],
      rollbackAssets: ["/tmp/openclaw.json.rollback"],
      stopConditions: ["manifest mismatch"],
      doneCriteria: ["write accepted"],
      expiresAt: "2999-01-01T00:00:00Z",
    },
    controlPlaneApproval: {
      approvalId: `approval-config.set-${candidateSha256}`,
      manifestId: "manifest-config.set",
      candidateSha256,
      approvalClasses: ["auth", "control", "runtime"],
      approved: true,
      expiresAt: "2999-01-01T00:00:00Z",
    },
  };
}

describe("gateway shared token session rotation", () => {
  it("invalidates shared-token websocket sessions after config.set rotation even with reload mode off", async () => {
    expect(configSetRotationCase.setOk).toBe(true);
    expect(configSetRotationCase.closed).toEqual({
      code: 4001,
      reason: "gateway auth changed",
    });
  });
});
