import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  pruneLegacyStoreKeysMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  resolveAgentConfigMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let applyGrantHardeningContext: typeof import("./subagent-spawn.js").__testing.applyGrantHardeningContext;

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function gatewayRequestRecords(): Record<string, unknown>[] {
  return hoisted.callGatewayMock.mock.calls.map((call) => requireRecord(call[0]));
}

function gatewayRequest(method: string): Record<string, unknown> {
  const request = gatewayRequestRecords().find((entry) => entry.method === method);
  return requireRecord(request);
}

function firstRegisteredSubagentRun(): Record<string, unknown> {
  return requireRecord(hoisted.registerSubagentRunMock.mock.calls[0]?.[0]);
}

describe("spawnSubagentDirect seam flow", () => {
  beforeAll(async () => {
    ({
      resetSubagentRegistryForTests,
      spawnSubagentDirect,
      __testing: { applyGrantHardeningContext },
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => hoisted.configOverride,
      loadSessionStoreMock: hoisted.loadSessionStoreMock,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      pruneLegacyStoreKeysMock: hoisted.pruneLegacyStoreKeysMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      resolveAgentConfig: hoisted.resolveAgentConfigMock,
      resolveSubagentSpawnModelSelection: () => "openai/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.loadSessionStoreMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.pruneLegacyStoreKeysMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.resolveAgentConfigMock.mockReset();
    hoisted.resolveAgentConfigMock.mockImplementation(
      (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
        cfg.agents?.list?.find((agent) => agent.id === agentId),
    );
    hoisted.configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    hoisted.loadSessionStoreMock.mockReturnValue({});

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("rejects explicit same-agent targets when allowAgents excludes the requester", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "task-manager",
            workspace: "/tmp/workspace-task-manager",
            subagents: {
              allowAgents: ["planner"],
            },
          },
          {
            id: "planner",
            workspace: "/tmp/workspace-planner",
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "spawn myself explicitly",
        agentId: "task-manager",
      },
      {
        agentSessionKey: "agent:task-manager:main",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toBe("agentId is not allowed for sessions_spawn (allowed: planner)");
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
  });

  it("allows omitted agentId to default to requester even when allowAgents excludes requester", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "task-manager",
            workspace: "/tmp/workspace-task-manager",
            subagents: {
              allowAgents: ["planner"],
            },
          },
          {
            id: "planner",
            workspace: "/tmp/workspace-planner",
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "spawn default target",
      },
      {
        agentSessionKey: "agent:task-manager:main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:task-manager:subagent:/);
  });

  it("accepts a spawned run across session patching, runtime-model persistence, registry registration, and lifecycle emission", async () => {
    const operations: string[] = [];
    let persistedStore: Record<string, Record<string, unknown>> | undefined;

    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      operations.push(`gateway:${request.method ?? "unknown"}`);
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inspect the spawn seam",
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        agentThreadId: 42,
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.runId).toBe("run-1");
    expect(result.mode).toBe("run");
    expect(result.modelApplied).toBe(true);
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(3);
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledTimes(3);
    const registerInput = firstRegisteredSubagentRun();
    const requesterOrigin = requireRecord(registerInput.requesterOrigin);
    expect(registerInput.runId).toBe("run-1");
    expect(registerInput.childSessionKey).toBe(childSessionKey);
    expect(registerInput.requesterSessionKey).toBe("agent:main:main");
    expect(registerInput.requesterDisplayKey).toBe("agent:main:main");
    expect(requesterOrigin.channel).toBe("discord");
    expect(requesterOrigin.accountId).toBe("acct-1");
    expect(requesterOrigin.to).toBe("user-1");
    expect(requesterOrigin.threadId).toBe(42);
    expect(registerInput.task).toBe("inspect the spawn seam");
    expect(registerInput.cleanup).toBe("keep");
    expect(registerInput.model).toBe("openai/gpt-5.4");
    expect(registerInput.workspaceDir).toBe("/tmp/requester-workspace");
    expect(registerInput.expectsCompletionMessage).toBe(true);
    expect(registerInput.spawnMode).toBe("run");
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: childSessionKey,
      provider: "openai",
      model: "gpt-5.4",
      overrideSource: "user",
    });
    expect(operations.indexOf("store:update")).toBeGreaterThan(-1);
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(
      operations.lastIndexOf("store:update"),
    );
    const agentRequest = gatewayRequest("agent");
    const agentParams = requireRecord(agentRequest.params);
    expect(agentParams.sessionKey).toBe(childSessionKey);
    expect(agentParams.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("inherits requester thinking level when no spawn or subagent default is configured", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { thinkingLevel: "high" },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("high");
  });

  it("persists inherited requester thinking off", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { thinkingLevel: "off" },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit thinking off",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("off");
  });

  it("inherits requester agent thinkingDefault when the caller session has no stored thinking", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            thinkingDefault: "high",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {},
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit agent thinking default",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("high");
  });

  it("falls back to requester agent thinkingDefault when caller session store cannot be read", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            thinkingDefault: "high",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockImplementation(() => {
      throw new Error("store unavailable");
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit agent thinking default without session store",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("high");
  });

  it("prefers requester agent thinkingDefault over selected-model thinking fallback", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            thinkingDefault: "high",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
      },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit selected model thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("high");
  });

  it("inherits requester selected-model thinking when caller session has no stored thinking or agent default", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
      },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit selected model thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("low");
  });

  it("prefers requester agent thinkingDefault over runtime-model thinking fallback", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            thinkingDefault: "high",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        modelProvider: "openai-codex",
        model: "gpt-5.4",
      },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit runtime model thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("high");
  });

  it("inherits requester runtime-model thinking when caller session has no stored thinking or agent default", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        modelProvider: "openai-codex",
        model: "gpt-5.4",
      },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit runtime model thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("low");
  });

  it("inherits global thinkingDefault when caller session and agent have no stored thinking", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          thinkingDefault: "medium",
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {},
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit global thinking default",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("medium");
  });

  it("inherits provider/model thinking default when no caller-specific default exists", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          model: "openai-codex/gpt-5.4",
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {},
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit provider model thinking default",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("low");
  });

  it("applies requester-agent subagent thinking before caller session thinking", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            subagents: {
              thinking: "medium",
            },
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { thinkingLevel: "high" },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "requester policy thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("medium");
  });

  it("keeps controller ownership separate from completion ownership", async () => {
    await spawnSubagentDirect(
      {
        task: "background work",
      },
      {
        agentSessionKey: "agent:main:telegram:default:direct:456",
        completionOwnerKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:direct:456",
      },
    );

    const registerInput = firstRegisteredSubagentRun();
    expect(registerInput.controllerSessionKey).toBe("agent:main:telegram:default:direct:456");
    expect(registerInput.requesterSessionKey).toBe("agent:main:main");
    expect(registerInput.requesterDisplayKey).toBe("agent:main:main");
  });

  it("keeps spawn cwd separate from inherited agent workspace", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "work in the requested repo",
        cwd: "/tmp/task-repo",
      },
      {
        agentSessionKey: "agent:main:main",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    const childEntry = persistedStore?.[childSessionKey];
    expect(childEntry?.spawnedWorkspaceDir).toBe("/tmp/requester-workspace");
    expect(childEntry?.spawnedCwd).toBe("/tmp/task-repo");

    const agentRequest = gatewayRequest("agent");
    const agentParams = requireRecord(agentRequest.params);
    expect(agentParams).not.toHaveProperty("cwd");
    expect(agentParams).not.toHaveProperty("workspaceDir");
  });

  it("omits requesterOrigin threadId when no requester thread is provided", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "inspect unthreaded spawn",
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
      },
    );

    expect(result.status).toBe("accepted");
    const registerInput = firstRegisteredSubagentRun();
    const requesterOrigin = requireRecord(registerInput.requesterOrigin);
    expect(requesterOrigin.channel).toBe("discord");
    expect(requesterOrigin.accountId).toBe("acct-1");
    expect(requesterOrigin.to).toBe("user-1");
    expect(requesterOrigin).not.toHaveProperty("threadId");
  });

  it("pins admin-only methods to operator.admin and preserves least-privilege for others (#59428)", async () => {
    const capturedCalls: Array<{ method?: string; scopes?: string[] }> = [];

    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; scopes?: string[] }) => {
        capturedCalls.push({ method: request.method, scopes: request.scopes });
        if (request.method === "agent") {
          return { runId: "run-1" };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify per-method scope routing",
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(capturedCalls.length).toBeGreaterThan(0);

    for (const call of capturedCalls) {
      if (call.method === "sessions.patch" || call.method === "sessions.delete") {
        // Admin-only methods must be pinned to operator.admin.
        expect(call.scopes).toEqual(["operator.admin"]);
      } else {
        // Non-admin methods (e.g. "agent") must NOT be forced to admin scope.
        expect(call.scopes).toBeUndefined();
      }
    }
  });

  it("forwards normalized thinking to the agent run", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-thinking", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify thinking forwarding",
        thinking: "high",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = requireRecord(agentCall?.params);
    expect(params.thinking).toBe("high");
  });

  it("does not forward inherited requester thinking as an explicit agent override", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-inherited-thinking", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { thinkingLevel: "xhigh" },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify inherited thinking is session state",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = requireRecord(agentCall?.params);
    expect(params.thinking).toBeUndefined();
  });

  it("does not duplicate long subagent task text in the initial user message (#72019)", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-no-dup", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const task = "UNIQUE_LONG_SUBAGENT_TASK_TOKEN\n  keep indentation";
    const result = await spawnSubagentDirect(
      {
        task,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = agentCall?.params as { message?: string; extraSystemPrompt?: string };
    expect(params.message).toContain("[Subagent Task]");
    expect(params.message).toContain("UNIQUE_LONG_SUBAGENT_TASK_TOKEN");
    expect(params.message).toContain("  keep indentation");
    expect(params.message).not.toContain("**Your Role**");
    expect(params.extraSystemPrompt).toBe("system-prompt");
  });

  it("injects the Grant hardening bundle into Grant-labeled runs", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-grant", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
    const grantWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "grant-hardening-"));
    await fs.mkdir(path.join(grantWorkspace, "docs", "grant"), { recursive: true });
    await fs.mkdir(path.join(grantWorkspace, "contracts", "grant"), { recursive: true });
    await fs.mkdir(path.join(grantWorkspace, "templates", "grant"), { recursive: true });
    await fs.writeFile(
      path.join(grantWorkspace, "docs", "grant", "grant_doctrine.md"),
      [
        "# Grant Doctrine",
        "",
        "Grant hardening v1 may be called closed only for the current scoped hardening build.",
        "Grant remains a bounded governed execution owner under Will.",
        "Will remains the packet-sharpening and top command layer.",
        "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
        "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
        "",
        "Doctrine body",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "docs", "grant", "grant_corrections_matrix.md"),
      "# Grant Corrections Matrix\n\n## Active corrections\n\nCorrections body",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "contracts", "grant", "grant_hardening_operating_contract.json"),
      JSON.stringify(
        {
          boundary_lock: {
            scoped_closeout_rule:
              "Grant hardening v1 may be called closed only for the current scoped hardening build.",
            owner_rule: "Grant remains a bounded governed execution owner under Will.",
            command_rule: "Will remains the packet-sharpening and top command layer.",
            ambiguity_rule:
              "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
            promotion_rule:
              "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "templates", "grant", "grant_run_checklist.md"),
      "# Grant Run Checklist\nChecklist body",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "templates", "grant", "grant_closeout_gate.md"),
      "# Grant Closeout Gate\nCloseout body",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "templates", "grant", "grant_after_action_audit_template.md"),
      "# Grant After-Action Audit Template\nAudit body",
      "utf8",
    );
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: grantWorkspace,
        },
        list: [
          {
            id: "main",
            workspace: grantWorkspace,
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "execute the assigned Grant slice",
        label: "Grant - Production Slice",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        workspaceDir: grantWorkspace,
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = agentCall?.params as { message?: string; extraSystemPrompt?: string };
    expect(params.extraSystemPrompt).toContain("system-prompt");
    expect(params.extraSystemPrompt).toContain("## Grant Hardening Context");
    expect(params.extraSystemPrompt).toContain("[Grant Injection Verification]");
    expect(params.extraSystemPrompt).toContain("# Grant Doctrine");
    expect(params.extraSystemPrompt).toContain("# Grant Corrections Matrix");
    expect(params.message).toContain("[Grant Run Checklist - Mandatory]");
    expect(params.message).toContain("# Grant Run Checklist");
    expect(params.message).toContain("[Grant Closeout Gate - Mandatory]");
    expect(params.message).toContain("# Grant Closeout Gate");
    expect(params.message).toContain("[Grant After-Action Audit Reference]");
  });

  it("fails closed when a Grant-labeled run is missing the hardening bundle", async () => {
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
    const grantWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "grant-hardening-missing-"));
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: grantWorkspace,
        },
        list: [
          {
            id: "main",
            workspace: grantWorkspace,
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "execute the assigned Grant slice",
        label: "Grant - Missing Bundle",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        workspaceDir: grantWorkspace,
      },
    );

    expect(result.status).toBe("error");
    expect(result.error ?? "").toContain(
      "Grant hardening bundle required for this run but unavailable",
    );
    expect(
      hoisted.callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });

  it("injects the Grant hardening bundle when the child agent id is grant even without a Grant label", async () => {
    const grantWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "grant-hardening-agent-"));
    await fs.mkdir(path.join(grantWorkspace, "docs", "grant"), { recursive: true });
    await fs.mkdir(path.join(grantWorkspace, "contracts", "grant"), { recursive: true });
    await fs.mkdir(path.join(grantWorkspace, "templates", "grant"), { recursive: true });
    await fs.writeFile(
      path.join(grantWorkspace, "docs", "grant", "grant_doctrine.md"),
      [
        "# Grant Doctrine",
        "",
        "Grant hardening v1 may be called closed only for the current scoped hardening build.",
        "Grant remains a bounded governed execution owner under Will.",
        "Will remains the packet-sharpening and top command layer.",
        "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
        "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "docs", "grant", "grant_corrections_matrix.md"),
      "# Grant Corrections Matrix\n\n## Active corrections\n\nCorrections body",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "contracts", "grant", "grant_hardening_operating_contract.json"),
      JSON.stringify(
        {
          boundary_lock: {
            scoped_closeout_rule:
              "Grant hardening v1 may be called closed only for the current scoped hardening build.",
            owner_rule: "Grant remains a bounded governed execution owner under Will.",
            command_rule: "Will remains the packet-sharpening and top command layer.",
            ambiguity_rule:
              "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
            promotion_rule:
              "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "templates", "grant", "grant_run_checklist.md"),
      "# Grant Run Checklist\nChecklist body",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "templates", "grant", "grant_closeout_gate.md"),
      "# Grant Closeout Gate\nCloseout body",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "templates", "grant", "grant_after_action_audit_template.md"),
      "# Grant After-Action Audit Template\nAudit body",
      "utf8",
    );
    const result = await applyGrantHardeningContext({
      childSystemPrompt: "system-prompt",
      childTaskMessage: "task-message",
      task: "execute the assigned bounded slice",
      agentId: "grant",
      workspaceDir: grantWorkspace,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error(result.error);
    }
    expect(result.childSystemPrompt).toContain("[Grant Injection Verification]");
    expect(result.childSystemPrompt).toContain("# Grant Doctrine");
    expect(result.childTaskMessage).toContain("[Grant Run Checklist - Mandatory]");
  });

  it("fails closed when the Grant doctrine is missing the required boundary rule", async () => {
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
    const grantWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "grant-hardening-stale-"));
    await fs.mkdir(path.join(grantWorkspace, "docs", "grant"), { recursive: true });
    await fs.mkdir(path.join(grantWorkspace, "contracts", "grant"), { recursive: true });
    await fs.mkdir(path.join(grantWorkspace, "templates", "grant"), { recursive: true });
    await fs.writeFile(
      path.join(grantWorkspace, "docs", "grant", "grant_doctrine.md"),
      "# Grant Doctrine\nDoctrine body without the required boundary lock.",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "docs", "grant", "grant_corrections_matrix.md"),
      "# Grant Corrections Matrix\n\n## Active corrections\n\nCorrections body",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "contracts", "grant", "grant_hardening_operating_contract.json"),
      JSON.stringify(
        {
          boundary_lock: {
            scoped_closeout_rule:
              "Grant hardening v1 may be called closed only for the current scoped hardening build.",
            owner_rule: "Grant remains a bounded governed execution owner under Will.",
            command_rule: "Will remains the packet-sharpening and top command layer.",
            ambiguity_rule:
              "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
            promotion_rule:
              "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "templates", "grant", "grant_run_checklist.md"),
      "# Grant Run Checklist\nChecklist body",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "templates", "grant", "grant_closeout_gate.md"),
      "# Grant Closeout Gate\nCloseout body",
      "utf8",
    );
    await fs.writeFile(
      path.join(grantWorkspace, "templates", "grant", "grant_after_action_audit_template.md"),
      "# Grant After-Action Audit Template\nAudit body",
      "utf8",
    );

    const result = await spawnSubagentDirect(
      {
        task: "execute the assigned Grant slice",
        label: "Grant - stale doctrine",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        workspaceDir: grantWorkspace,
      },
    );

    expect(result.status).toBe("error");
    expect(result.error ?? "").toContain("Grant doctrine missing required boundary rule");
  });

  it("returns an error when the initial child session patch is rejected", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "agent") {
          return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );
    hoisted.updateSessionStoreMock.mockRejectedValueOnce(new Error("invalid model: bad-model"));

    const result = await spawnSubagentDirect(
      {
        task: "verify patch rejection",
        model: "bad-model",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("error");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(result.error ?? "").toContain("invalid model");
    expect(
      hoisted.callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });
});
