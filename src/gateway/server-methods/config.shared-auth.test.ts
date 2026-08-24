import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { VERSION } from "../../version.js";
import {
  createConfigHandlerHarness,
  createConfigWriteSnapshot,
  flushConfigHandlerMicrotasks,
} from "./config.test-helpers.js";

const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const persistedConfigResultMock = vi.fn((config: OpenClawConfig) => config);
const validateConfigObjectWithPluginsMock = vi.fn();
const prepareSecretsRuntimeSnapshotMock = vi.fn();
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({
  scheduled: true,
  delayMs: 1_000,
  coalesced: false,
}));
const restartSentinelMocks = vi.hoisted(() => ({
  writeRestartSentinel: vi.fn(async (_payload: RestartSentinelPayload) => {
    return "/tmp/restart-sentinel.json";
  }),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
    readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
    replaceConfigFile: async (params: { nextConfig: OpenClawConfig; writeOptions?: unknown }) => {
      await writeConfigFileMock(params.nextConfig, params.writeOptions);
      const writeOptions = (params.writeOptions ?? {}) as {
        lastTouchedAtOverride?: string;
        lastTouchedVersionOverride?: string;
      };
      const persistedConfig = persistedConfigResultMock({
        ...params.nextConfig,
        meta: {
          ...params.nextConfig.meta,
          lastTouchedVersion: writeOptions.lastTouchedVersionOverride ?? VERSION,
          lastTouchedAt: writeOptions.lastTouchedAtOverride ?? new Date().toISOString(),
        },
      });
      const persistedRaw = `${JSON.stringify(persistedConfig, null, 2)}\n`;
      return {
        path: "/tmp/openclaw.json",
        previousHash: "base-hash",
        snapshot: createConfigWriteSnapshot(params.nextConfig),
        nextConfig: persistedConfig,
        persistedHash: crypto.createHash("sha256").update(persistedRaw, "utf-8").digest("hex"),
        afterWrite: { mode: "auto" },
        followUp: { mode: "auto", requiresRestart: false },
      };
    },
  };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({ uiHints: undefined }),
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeSnapshot: () => null,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    writeRestartSentinel: restartSentinelMocks.writeRestartSentinel,
  };
});

const { configHandlers } = await import("./config.js");

const TEST_ACTIVATION_AT = "2026-07-14T12:00:00.000Z";
const GATEWAY_CONFIG_WRITE_OPTIONS = {
  runtimeRefresh: {
    includeAuthStoreRefs: false,
  },
  lastTouchedAtOverride: TEST_ACTIVATION_AT,
};

let previousConfigForManifest: OpenClawConfig = {};

function canonicalConfigRaw(config: OpenClawConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function hashConfig(config: OpenClawConfig): string {
  return crypto.createHash("sha256").update(canonicalConfigRaw(config), "utf-8").digest("hex");
}

function stampedCandidateForManifest(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    meta: {
      ...config.meta,
      lastTouchedVersion: VERSION,
      lastTouchedAt: TEST_ACTIVATION_AT,
    },
  };
}

function controlPlaneEnvelope(params: {
  candidateConfig: OpenClawConfig;
  tool: "config.set" | "config.patch";
  allowedRestartScope?: "none" | "gateway";
}) {
  const candidateSha256 = hashConfig(stampedCandidateForManifest(params.candidateConfig));
  return {
    controlPlaneManifest: {
      manifestId: `manifest-${params.tool}`,
      objective: "test config write",
      activationTimestamp: TEST_ACTIVATION_AT,
      candidateSha256,
      allowedFiles: ["/tmp/openclaw.json"],
      allowedConfigPaths: ["gateway", "meta"],
      forbiddenFiles: ["/tmp/forbidden-openclaw.json"],
      allowedServices: ["openclaw-gateway.service"],
      allowedRestartScope: params.allowedRestartScope ?? "gateway",
      allowedAgents: ["unknown-actor"],
      allowedTools: [params.tool],
      approvalClasses: ["auth", "runtime", "control"],
      requiredEvidence: ["test"],
      rollbackAssets: ["/tmp/openclaw.json.rollback"],
      stopConditions: ["manifest mismatch"],
      doneCriteria: ["write accepted"],
      expiresAt: "2999-01-01T00:00:00Z",
    },
    controlPlaneApproval: {
      approvalId: `approval-${params.tool}`,
      manifestId: `manifest-${params.tool}`,
      candidateSha256,
      approvalClasses: ["auth", "runtime", "control"],
      approved: true,
      expiresAt: "2999-01-01T00:00:00Z",
    },
  };
}

function mergePatchForTest(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }
  const baseRecord =
    base && typeof base === "object" && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...baseRecord };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = mergePatchForTest(baseRecord[key], value);
    }
  }
  return next;
}

function tokenAuthConfig(token: string): OpenClawConfig {
  return {
    gateway: {
      auth: {
        mode: "token",
        token,
      },
    },
  };
}

function trustedProxyConfig(params: {
  trustedProxies?: string[];
  requiredHeaders?: string[];
  allowUsers?: string[];
}): OpenClawConfig {
  return {
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          ...(params.requiredHeaders ? { requiredHeaders: params.requiredHeaders } : {}),
          ...(params.allowUsers ? { allowUsers: params.allowUsers } : {}),
        },
      },
      ...(params.trustedProxies ? { trustedProxies: params.trustedProxies } : {}),
    },
  };
}

function hotReloadConfig(): OpenClawConfig {
  return {
    gateway: {
      reload: {
        mode: "hot",
      },
    },
  };
}

function mockPreviousConfig(config: OpenClawConfig): void {
  previousConfigForManifest = config;
  readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(config));
}

async function runConfigPatch(
  raw: unknown,
  params: { sessionKey?: string; restartDelayMs?: number } = {},
) {
  const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
    method: "config.patch",
    params: {
      baseHash: "base-hash",
      raw: typeof raw === "string" ? raw : JSON.stringify(raw),
      restartDelayMs: params.restartDelayMs ?? 1_000,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...controlPlaneEnvelope({
        candidateConfig: mergePatchForTest(previousConfigForManifest, raw) as OpenClawConfig,
        tool: "config.patch",
      }),
    },
  });

  await configHandlers["config.patch"](options);
  await flushConfigHandlerMicrotasks();
  return { disconnectClientsUsingSharedGatewayAuth };
}

function expectNoDirectRestart(): void {
  expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TEST_ACTIVATION_AT));
  previousConfigForManifest = {};
  validateConfigObjectWithPluginsMock.mockImplementation((config: OpenClawConfig) => ({
    ok: true,
    config,
  }));
  prepareSecretsRuntimeSnapshotMock.mockImplementation(
    async ({ config }: { config: OpenClawConfig }) => ({
      config,
    }),
  );
  restartSentinelMocks.writeRestartSentinel.mockClear();
  persistedConfigResultMock.mockImplementation((config: OpenClawConfig) => config);
});

describe("config shared auth disconnects", () => {
  it("rejects protected config writes without a control-plane manifest", async () => {
    mockPreviousConfig(hotReloadConfig());
    const { options, respond } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { port: 19001 } }),
      },
    });

    await configHandlers["config.patch"](options);

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("control-plane manifest rejected (malformed_manifest)"),
      }),
    );
  });

  it("returns the persisted config from config.set write results", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        port: 19000,
      },
    };
    const submittedConfig: OpenClawConfig = {
      gateway: {
        port: 19001,
      },
    };
    const persistedConfig = stampedCandidateForManifest(submittedConfig);
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, respond } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(submittedConfig, null, 2),
        baseHash: "base-hash",
        ...controlPlaneEnvelope({ candidateConfig: submittedConfig, tool: "config.set" }),
      },
    });

    await configHandlers["config.set"](options);
    await flushConfigHandlerMicrotasks();

    expect(writeConfigFileMock).toHaveBeenCalledWith(submittedConfig, GATEWAY_CONFIG_WRITE_OPTIONS);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        path: "/tmp/openclaw.json",
        config: persistedConfig,
      },
      undefined,
    );
  });

  it("rejects post-write drift and blocks restart follow-up", async () => {
    mockPreviousConfig(hotReloadConfig());
    persistedConfigResultMock.mockReturnValueOnce({
      ...stampedCandidateForManifest({
        gateway: {
          reload: {
            mode: "hot",
          },
          port: 19001,
        },
      }),
      gateway: {
        reload: {
          mode: "hot",
        },
        port: 19002,
      },
    });

    const nextConfig: OpenClawConfig = {
      gateway: {
        reload: {
          mode: "hot",
        },
        port: 19001,
      },
    };
    const { options, respond } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { port: 19001 } }),
        ...controlPlaneEnvelope({ candidateConfig: nextConfig, tool: "config.patch" }),
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("control-plane post-write validation failed"),
      }),
    );
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("does not disconnect shared-auth clients for config.set auth writes without restart", async () => {
    const nextConfig = tokenAuthConfig("new-token");
    mockPreviousConfig(tokenAuthConfig("old-token"));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash: "base-hash",
        ...controlPlaneEnvelope({ candidateConfig: nextConfig, tool: "config.set" }),
      },
    });

    await configHandlers["config.set"](options);
    await flushConfigHandlerMicrotasks();

    expect(writeConfigFileMock).toHaveBeenCalledWith(nextConfig, GATEWAY_CONFIG_WRITE_OPTIONS);
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
    expectNoDirectRestart();
  });

  it("lets the config reloader own hybrid-mode auth restarts", async () => {
    mockPreviousConfig(tokenAuthConfig("old-token"));

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch({
      gateway: { auth: { token: "new-token" } },
    });

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect shared-auth clients when config.patch changes only inactive password auth", async () => {
    mockPreviousConfig(tokenAuthConfig("old-token"));

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch({
      gateway: { auth: { password: "new-password" } },
    });

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("disconnects gateway-auth clients when active trusted-proxy policy changes", async () => {
    mockPreviousConfig(
      trustedProxyConfig({
        allowUsers: ["alice@example.com"],
        trustedProxies: ["127.0.0.1"],
      }),
    );

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch({
      gateway: {
        auth: {
          trustedProxy: {
            userHeader: "x-forwarded-user",
            allowUsers: ["bob@example.com"],
          },
        },
      },
    });

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("disconnects gateway-auth clients when trusted-proxy source list changes", async () => {
    mockPreviousConfig(
      trustedProxyConfig({
        trustedProxies: ["127.0.0.1"],
      }),
    );

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch({
      gateway: {
        trustedProxies: ["10.0.0.10"],
      },
    });

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect gateway-auth clients when trusted-proxy lists are reordered", async () => {
    mockPreviousConfig(
      trustedProxyConfig({
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: ["alice@example.com", "bob@example.com"],
        trustedProxies: ["127.0.0.1", "10.0.0.10"],
      }),
    );

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch({
      gateway: {
        auth: {
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-host", "x-forwarded-proto"],
            allowUsers: ["bob@example.com", "alice@example.com"],
          },
        },
        trustedProxies: ["10.0.0.10", "127.0.0.1"],
      },
    });

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("still schedules a direct restart for hot mode when the reloader cannot apply the change", async () => {
    mockPreviousConfig(hotReloadConfig());

    await runConfigPatch({ gateway: { port: 19001 } });

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
  });

  it("does not add an agent continuation from generic control-plane sessionKey params", async () => {
    mockPreviousConfig(hotReloadConfig());

    await runConfigPatch(
      { gateway: { port: 19001 } },
      {
        sessionKey: "agent:main:main",
      },
    );

    const payload = restartSentinelMocks.writeRestartSentinel.mock.calls.at(-1)?.[0];
    expect(payload?.sessionKey).toBe("agent:main:main");
    expect(payload?.continuation).toBeUndefined();
  });
});
