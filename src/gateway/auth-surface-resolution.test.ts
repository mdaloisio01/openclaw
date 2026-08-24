import { describe, expect, it } from "vitest";
import type { GatewayRemoteConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayInteractiveSurfaceAuth } from "./auth-surface-resolution.js";

function remoteGatewayConfig(remote?: GatewayRemoteConfig): OpenClawConfig {
  return {
    gateway: {
      mode: "remote",
      remote: {
        url: "wss://remote.example/ws",
        ...remote,
      },
    },
  };
}

describe("resolveGatewayInteractiveSurfaceAuth", () => {
  it("uses OPENCLAW_GATEWAY_TOKEN as remote interactive fallback", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: remoteGatewayConfig(),
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        surface: "remote",
      }),
    ).resolves.toEqual({
      token: "env-token",
      password: undefined,
    });
  });

  it("keeps configured remote token ahead of OPENCLAW_GATEWAY_TOKEN", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: remoteGatewayConfig({ token: "remote-token" }),
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        surface: "remote",
      }),
    ).resolves.toEqual({
      token: "remote-token",
      password: undefined,
    });
  });

  it("does not fall back to OPENCLAW_GATEWAY_TOKEN when the configured remote token ref is unresolved", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: {
          ...remoteGatewayConfig({
            token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
          }),
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        surface: "remote",
      }),
    ).resolves.toEqual({
      failureReason: expect.stringContaining("gateway.remote.token"),
    });
  });

  it("allows explicit remote auth to replace an unresolved configured remote token ref", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: {
          ...remoteGatewayConfig({
            token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
          }),
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        explicitAuth: {
          token: "explicit-token",
        },
        surface: "remote",
      }),
    ).resolves.toEqual({
      token: "explicit-token",
      password: undefined,
    });
  });

  it("does not fall back to env password when the configured local password ref is unresolved", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: {
          gateway: {
            auth: {
              mode: "password",
              password: { source: "env", provider: "default", id: "MISSING_GATEWAY_PASSWORD" },
            },
          },
        },
        env: {
          OPENCLAW_GATEWAY_PASSWORD: "env-password",
        },
        surface: "local",
      }),
    ).resolves.toEqual({
      failureReason: expect.stringContaining("gateway.auth.password"),
    });
  });

  it("does not fall back to env token when the configured local token ref is unresolved", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: {
          gateway: {
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
            },
          },
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        surface: "local",
      }),
    ).resolves.toEqual({
      failureReason: expect.stringContaining("gateway.auth.token"),
      password: undefined,
      token: undefined,
    });
  });
});
