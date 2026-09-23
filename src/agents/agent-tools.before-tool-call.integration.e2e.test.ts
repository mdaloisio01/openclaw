import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSessionStore, type SessionEntry } from "../config/sessions.js";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "../governance/governed-mission-contract.js";
import { createGovernedMissionState } from "../governance/governed-mission-state.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { patchPluginSessionExtension } from "../plugins/host-hook-state.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import type { PluginHookRegistration } from "../plugins/types.js";
import {
  countActiveToolExecutions,
  waitForActiveToolExecutionsToDrain,
} from "./active-tool-execution-tracker.js";
import { toClientToolDefinitions, toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import {
  testing as beforeToolCallTesting,
  consumeAdjustedParamsForToolCall,
  type HookContext,
  isToolWrappedWithBeforeToolCallHook,
  setDirtyTreeHygieneStatusReaderForTest,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { markCodeModeControlTool } from "./code-mode-control-tools.js";
import { CODE_MODE_EXEC_TOOL_NAME, createCodeModeTools } from "./code-mode.js";
import { splitSdkTools } from "./embedded-agent-runner.js";

type BeforeToolCallHandlerMock = ReturnType<typeof vi.fn>;

type BeforeToolCallHookInstall = {
  pluginId: string;
  priority?: number;
  handler: BeforeToolCallHandlerMock;
};

function collectMatching<T, U>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  map: (item: T) => U,
): U[] {
  const matches: U[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(map(item));
    }
  }
  return matches;
}

function installBeforeToolCallHook(params?: {
  enabled?: boolean;
  runBeforeToolCallImpl?: (...args: unknown[]) => unknown;
}): BeforeToolCallHandlerMock {
  resetGlobalHookRunner();
  const handler = params?.runBeforeToolCallImpl
    ? vi.fn(params.runBeforeToolCallImpl)
    : vi.fn(async () => undefined);
  if (params?.enabled === false) {
    return handler;
  }
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
  return handler;
}

function installBeforeToolCallHooks(hooks: BeforeToolCallHookInstall[]): void {
  resetGlobalHookRunner();
  const registry = createEmptyPluginRegistry();
  for (const hook of hooks) {
    addTestHook({
      registry,
      pluginId: hook.pluginId,
      hookName: "before_tool_call",
      handler: hook.handler as PluginHookRegistration["handler"],
      priority: hook.priority,
    });
  }
  initializeGlobalHookRunner(registry);
}

beforeEach(() => {
  // Dirty-tree enforcement has dedicated tests; these integration fixtures isolate
  // hook behavior from unrelated changes in the developer's production checkout.
  setDirtyTreeHygieneStatusReaderForTest(async () => "");
});

afterEach(() => {
  setDirtyTreeHygieneStatusReaderForTest();
});

describe("before_tool_call hook integration", () => {
  let beforeToolCallHook: BeforeToolCallHandlerMock;

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    beforeToolCallTesting.adjustedParamsByToolCallId.clear();
    beforeToolCallHook = installBeforeToolCallHook();
  });

  it("late-binds governed policy into an actual pre-wrapped core tool", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const decisions: unknown[] = [];
    const sharedContext: HookContext = {
      agentId: "main",
      cwd: process.cwd(),
      workspaceDir: process.cwd(),
      sessionKey: "agent:main:governed",
      sessionId: "session-governed",
      runId: "run-governed",
    };
    const execTool = createOpenClawCodingTools({
      agentId: "main",
      cwd: process.cwd(),
      workspaceDir: process.cwd(),
      sessionKey: "agent:main:governed",
      sessionId: "session-governed",
      runId: "run-governed",
      beforeToolCallHookContext: sharedContext,
    }).find((tool) => tool.name === "exec");
    if (!execTool) {
      throw new Error("expected core exec tool");
    }
    expect(isToolWrappedWithBeforeToolCallHook(execTool)).toBe(true);

    sharedContext.governedMissionToolEnforcement = {
      active: true,
      conversationClassification: "governed",
      expectedCurrentStep: "execute",
      trustedHostPolicy: {
        trustedHost: true,
        openclawAllows: true,
        osAllows: true,
        hostAllows: true,
      },
      onDecision: (decision) => decisions.push(decision),
    };

    const result = await execTool.execute(
      "call-governed-exec",
      { command: "printf should-not-run" },
      undefined,
      undefined,
    );
    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(decisions).toEqual([
      expect.objectContaining({
        protected: true,
        decision: "DENY",
        reasonCode: "MISSING_GOVERNED_AUTHORITY",
      }),
    ]);
  });

  it("keeps governed tool parameters out of content hooks while applying trusted policy", async () => {
    resetGlobalHookRunner();
    const trustedPolicy = vi.fn(() => ({
      block: true,
      blockReason: "trusted policy denied governed read",
    }));
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "content-plugin",
      hookName: "before_tool_call",
      handler: beforeToolCallHook as PluginHookRegistration["handler"],
    });
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-plugin",
        pluginName: "Trusted Plugin",
        source: "test",
        policy: {
          id: "governed-read-policy",
          description: "deny the governed read fixture",
          evaluate: trustedPolicy,
        },
      },
    ];
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:governed-read",
      runId: "run-governed-read",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
      },
    });

    try {
      const result = await tool.execute(
        "call-governed-read",
        { path: "private-governed-input.txt" },
        undefined,
        undefined,
      );

      expect(result.details).toMatchObject({
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(beforeToolCallHook).not.toHaveBeenCalled();
      expect(trustedPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "read",
          params: { path: "private-governed-input.txt" },
        }),
        expect.objectContaining({ sessionKey: "agent:main:governed-read" }),
      );
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  });

  it("treats messaging sends as governed final output before execution", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const decisions: unknown[] = [];
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "message", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:governed-message",
      runId: "run-governed-message",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
        onDecision: (decision) => decisions.push(decision),
      },
    });

    const result = await tool.execute(
      "call-governed-message",
      { action: "send", message: "must remain private" },
      undefined,
      undefined,
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        protected: true,
        decision: "DENY",
        reasonCode: "MISSING_GOVERNED_AUTHORITY",
      }),
    ]);
  });

  it.each([
    ["web_fetch", { url: "https://example.com/SECRET_CANARY_69737" }],
    ["web_search", { query: "SECRET_CANARY_69737" }],
  ])("blocks governed core network tool %s before execution", async (toolName, params) => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const decisions: unknown[] = [];
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: toolName, execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:governed-network",
      runId: "run-governed-network",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
        onDecision: (decision) => decisions.push(decision),
      },
    });

    const result = await tool.execute(`call-governed-${toolName}`, params, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        protected: true,
        decision: "DENY",
        reasonCode: "MISSING_GOVERNED_AUTHORITY",
        protectedActionDecision: expect.objectContaining({
          actionClass: "external_side_effect",
        }),
      }),
    ]);
  });

  it("blocks governed message calls before remote dispatch", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const decisions: unknown[] = [];
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "message", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:governed-message-actions",
      runId: "run-governed-message-actions",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
        onDecision: (decision) => decisions.push(decision),
      },
    });

    const blocked = await tool.execute(
      "call-governed-message-edit",
      { action: "edit", messageId: "message-1", message: "private revision" },
      undefined,
      undefined,
    );
    expect(blocked.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        protected: true,
        decision: "DENY",
        reasonCode: "MISSING_GOVERNED_AUTHORITY",
        protectedActionDecision: expect.objectContaining({
          actionClass: "external_side_effect",
        }),
      }),
    ]);

    for (const action of ["search", "sticker-search"]) {
      const queryBlocked = await tool.execute(
        `call-governed-message-${action}`,
        { action, query: "SECRET_CANARY_69737" },
        undefined,
        undefined,
      );
      expect(queryBlocked.details).toMatchObject({
        status: "blocked",
        deniedReason: "governed-mission-tool-enforcement",
      });
    }
    expect(execute).not.toHaveBeenCalled();

    for (const action of ["read", "reactions", "member-info"]) {
      const remoteReadBlocked = await tool.execute(
        `call-governed-message-${action}`,
        { action, messageId: "SECRET_CANARY_69737" },
        undefined,
        undefined,
      );
      expect(remoteReadBlocked.details).toMatchObject({
        status: "blocked",
        deniedReason: "governed-mission-tool-enforcement",
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves external MCP provenance through the tool-definition adapter", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const decisions: unknown[] = [];
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const mcpTool = { name: "opaque_remote_action", execute } as any;
    setPluginToolMeta(mcpTool, { pluginId: "bundle-mcp", optional: false });
    const [tool] = toToolDefinitions([mcpTool], {
      agentId: "main",
      sessionKey: "agent:main:governed-mcp-adapter",
      runId: "run-governed-mcp-adapter",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
        onDecision: (decision) => decisions.push(decision),
      },
    });
    if (!tool) {
      throw new Error("missing MCP tool definition");
    }

    const result = await tool.execute(
      "call-governed-mcp-adapter",
      { path: "src/private.ts", content: "SECRET_CANARY_69737" },
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        protected: true,
        decision: "DENY",
        reasonCode: "MISSING_GOVERNED_AUTHORITY",
        protectedActionDecision: expect.objectContaining({
          actionClass: "external_side_effect",
        }),
      }),
    ]);
  });

  it("treats governed cron mutations as unreleased final output", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const decisions: unknown[] = [];
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "cron", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:governed-cron",
      runId: "run-governed-cron",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
        onDecision: (decision) => decisions.push(decision),
      },
    });

    const result = await tool.execute(
      "call-governed-cron",
      {
        action: "add",
        job: { payload: { kind: "systemEvent", text: "must remain private" } },
      },
      undefined,
      undefined,
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        protected: true,
        decision: "DENY",
        reasonCode: "MISSING_GOVERNED_AUTHORITY",
        protectedActionDecision: expect.objectContaining({
          actionClass: "external_side_effect",
        }),
      }),
    ]);
  });

  it("treats governed gateway restart delivery as unreleased final output", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const decisions: unknown[] = [];
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "gateway", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:governed-gateway-restart",
      runId: "run-governed-gateway-restart",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
        onDecision: (decision) => decisions.push(decision),
      },
    });

    for (const [field, value] of [
      ["note", "must remain private"],
      ["reason", "private restart reason"],
      ["continuationMessage", "private post-restart instruction"],
    ] as const) {
      const result = await tool.execute(
        `call-governed-gateway-restart-${field}`,
        { action: "restart", [field]: value },
        undefined,
        undefined,
      );
      expect(result.details).toMatchObject({
        status: "blocked",
        deniedReason: "governed-mission-tool-enforcement",
      });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(decisions).toHaveLength(3);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protected: true,
          decision: "DENY",
          reasonCode: "MISSING_GOVERNED_AUTHORITY",
          protectedActionDecision: expect.objectContaining({
            actionClass: "external_side_effect",
          }),
        }),
      ]),
    );
  });

  it("holds gateway delivery actions behind final release without optional prose", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const contract: GovernedMissionContract = {
      schema: "openclaw.governed_mission_contract.v1",
      missionId: "gateway-delivery-mission",
      contractId: "gateway-delivery-contract",
      contractVersion: "1",
      contractHash: "gateway-delivery-contract-hash",
      authorityHash: "gateway-delivery-authority-hash",
      authorityRefs: [
        {
          refId: "plan",
          kind: "build_plan",
          uri: "/plan.md",
          sha256: "gateway-delivery-authority-hash",
        },
      ],
      admissionReceiptRef: "gateway-delivery-admission",
      planRevisionId: "gateway-delivery-plan",
      sourceRevision: "gateway-delivery-source",
      runtimeBuildSha256: "gateway-delivery-build",
      policyVersion: "sop-enforcement-v1",
      skillSha256: "gateway-delivery-skill",
      mode: "enforce",
      authoritativeCompletionOwner: "governed_mission_state",
      requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
      createdAt: "2026-09-21T00:00:00.000Z",
    };
    const missionState = createGovernedMissionState({
      contract,
      authorityRef: contract.authorityRefs[0],
      currentStep: "execute",
      ownerCorrelation: { owner: "Will", taskFlowId: "flow-gateway-delivery" },
      now: contract.createdAt,
    });
    const decisions: unknown[] = [];
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "gateway", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:gateway-delivery",
      runId: "run-gateway-delivery",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
        authority: {
          governedMissionAdmitted: true,
          contract,
          missionState,
          expectedCurrentStep: "execute",
          observedContractHash: contract.contractHash,
          observedAuthorityHash: contract.authorityHash,
          requiredEvidencePresent: true,
          enforcementHealth: { healthy: true },
        },
        onDecision: (decision) => decisions.push(decision),
      },
    });

    for (const action of ["restart", "config.apply", "config.patch", "update.run"]) {
      const result = await tool.execute(`call-${action}`, { action }, undefined, undefined);
      expect(result.details).toMatchObject({ status: "blocked" });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(decisions).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({
          decision: "BLOCKED",
          reasonCode: "POLICY_BLOCKED",
          policyDecision: expect.objectContaining({ reasonCode: "FINAL_OUTPUT_RELEASE_NOT_READY" }),
        }),
      ),
    );
  });

  it("blocks governed browser mutations and sensitive reads while allowing status", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const decisions: unknown[] = [];
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "browser", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:governed-browser",
      runId: "run-governed-browser",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
        onDecision: (decision) => decisions.push(decision),
      },
    });

    const blocked = await tool.execute(
      "call-governed-browser-click",
      { action: "act", request: { kind: "click", ref: "submit" } },
      undefined,
      undefined,
    );
    expect(blocked.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        protected: true,
        decision: "DENY",
        reasonCode: "MISSING_GOVERNED_AUTHORITY",
        protectedActionDecision: expect.objectContaining({
          actionClass: "external_side_effect",
        }),
      }),
    ]);

    const sensitiveRead = await tool.execute(
      "call-governed-browser-snapshot",
      { action: "snapshot" },
      undefined,
      undefined,
    );
    expect(sensitiveRead.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(execute).not.toHaveBeenCalled();

    await tool.execute("call-governed-browser-status", { action: "status" }, undefined, undefined);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks governed sensitive node reads while allowing node status", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "nodes", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:governed-nodes",
      runId: "run-governed-nodes",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
      },
    });

    for (const action of ["photos_latest", "notifications_list", "location_get"]) {
      const result = await tool.execute(
        `call-governed-nodes-${action}`,
        { action },
        undefined,
        undefined,
      );
      expect(result.details).toMatchObject({
        status: "blocked",
        deniedReason: "governed-mission-tool-enforcement",
      });
    }
    expect(execute).not.toHaveBeenCalled();

    await tool.execute("call-governed-nodes-status", { action: "status" }, undefined, undefined);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks governed Skill Workshop mutations even with automatic approval", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "skill_workshop", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:governed-skill-workshop",
      runId: "run-governed-skill-workshop",
      config: { skills: { workshop: { approvalPolicy: "auto" } } },
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
      },
    });

    for (const action of ["create", "update", "revise", "apply", "reject", "quarantine"]) {
      const result = await tool.execute(
        `call-governed-skill-workshop-${action}`,
        { action },
        undefined,
        undefined,
      );
      expect(result.details).toMatchObject({
        status: "blocked",
        deniedReason: "governed-mission-tool-enforcement",
      });
    }
    expect(execute).not.toHaveBeenCalled();

    for (const action of ["list", "inspect"]) {
      await tool.execute(
        `call-governed-skill-workshop-${action}`,
        { action },
        undefined,
        undefined,
      );
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("fails closed for plugin tools without a trusted read-only contract", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const decisions: unknown[] = [];
    const execute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const pluginTool = { name: "feishu_doc", execute } as any;
    setPluginToolMeta(pluginTool, { pluginId: "feishu", optional: false });
    const tool = wrapToolWithBeforeToolCallHook(pluginTool, {
      agentId: "main",
      sessionKey: "agent:main:governed-plugin",
      runId: "run-governed-plugin",
      governedMissionToolEnforcement: {
        active: true,
        conversationClassification: "governed",
        expectedCurrentStep: "execute",
        trustedHostPolicy: {
          trustedHost: true,
          openclawAllows: true,
          osAllows: true,
          hostAllows: true,
        },
        onDecision: (decision) => decisions.push(decision),
      },
    });

    const result = await tool.execute(
      "call-governed-feishu-write",
      { action: "write", doc_token: "doc-1", content: "premature output" },
      undefined,
      undefined,
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        protected: true,
        decision: "DENY",
        reasonCode: "MISSING_GOVERNED_AUTHORITY",
        protectedActionDecision: expect.objectContaining({
          actionClass: "external_side_effect",
        }),
      }),
    ]);
  });

  it("tracks the actual wrapped tool promise until its execution settles", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    let releaseExecution: (() => void) | undefined;
    const execution = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const tool = wrapToolWithBeforeToolCallHook(
      {
        name: "read",
        execute: vi.fn(async () => {
          await execution;
          return { content: [], details: { ok: true } };
        }),
      } as any,
      { runId: "run-drain" },
    );
    const pending = tool.execute("call-drain", { path: "/tmp/file" }, undefined, undefined);
    await vi.waitFor(() => expect(countActiveToolExecutions("run-drain")).toBe(1));
    let drained = false;
    const drain = waitForActiveToolExecutionsToDrain("run-drain").then(() => {
      drained = true;
    });
    expect(drained).toBe(false);

    releaseExecution?.();
    await pending;
    await drain;
    expect(countActiveToolExecutions("run-drain")).toBe(0);
    expect(drained).toBe(true);
  });

  it("tracks wrapped and adapter tool calls while their pre-call hooks are pending", async () => {
    let releaseHook: (() => void) | undefined;
    const hookPending = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => {
        await hookPending;
      },
    });
    const wrappedExecute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const wrapped = wrapToolWithBeforeToolCallHook(
      { name: "read", execute: wrappedExecute } as any,
      {
        runId: "run-hook-drain",
      },
    );
    const wrappedPending = wrapped.execute(
      "call-hook-drain",
      { path: "/tmp/file" },
      undefined,
      undefined,
    );

    await vi.waitFor(() => expect(countActiveToolExecutions("run-hook-drain")).toBe(1));
    expect(wrappedExecute).not.toHaveBeenCalled();
    releaseHook?.();
    await wrappedPending;
    expect(countActiveToolExecutions("run-hook-drain")).toBe(0);

    let releaseAdapterHook: (() => void) | undefined;
    const adapterHookPending = new Promise<void>((resolve) => {
      releaseAdapterHook = resolve;
    });
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => {
        await adapterHookPending;
      },
    });
    const adapterExecute = vi.fn(async () => ({ content: [], details: { ok: true } }));
    const [adapter] = toToolDefinitions([{ name: "read", execute: adapterExecute } as any], {
      runId: "run-adapter-hook-drain",
    });
    const adapterExtensionContext = {} as Parameters<typeof adapter.execute>[4];
    const adapterPending = adapter.execute(
      "call-adapter-hook-drain",
      { path: "/tmp/file" },
      undefined,
      undefined,
      adapterExtensionContext,
    );

    await vi.waitFor(() => expect(countActiveToolExecutions("run-adapter-hook-drain")).toBe(1));
    expect(adapterExecute).not.toHaveBeenCalled();
    releaseAdapterHook?.();
    await adapterPending;
    expect(countActiveToolExecutions("run-adapter-hook-drain")).toBe(0);
  });

  it("executes tool normally when no hook is registered", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-1", { path: "/tmp/file" }, undefined, extensionContext);

    expect(beforeToolCallHook).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { path: "/tmp/file" },
      undefined,
      extensionContext,
    );
  });

  it("allows hook to modify parameters", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { mode: "safe" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-2", { cmd: "ls" }, undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith(
      "call-2",
      { cmd: "ls", mode: "safe" },
      undefined,
      extensionContext,
    );
  });

  it("returns first-class blocked tool result when hook returns block=true", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({
        block: true,
        blockReason: "blocked",
      }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-3", { cmd: "rm -rf /" }, undefined, extensionContext),
    ).resolves.toEqual({
      content: [{ type: "text", text: "blocked" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked",
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute lower-priority hooks after block=true", async () => {
    const high = vi.fn().mockResolvedValue({ block: true, blockReason: "blocked-high" });
    const low = vi.fn().mockResolvedValue({ params: { shouldNotApply: true } });
    installBeforeToolCallHooks([
      { pluginId: "high", priority: 100, handler: high },
      { pluginId: "low", priority: 0, handler: low },
    ]);

    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-stop", { cmd: "rm -rf /" }, undefined, extensionContext),
    ).resolves.toEqual({
      content: [{ type: "text", text: "blocked-high" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked-high",
      },
    });

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks tool execution when hook throws", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => {
        throw new Error("boom");
      },
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-4", { path: "/tmp/file" }, undefined, extensionContext),
    ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes non-object params for hook contract", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => undefined,
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "ReAd", execute } as any, {
      agentId: "main",
      sessionKey: "main",
      sessionId: "ephemeral-main",
      runId: "run-main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-5", "not-an-object", undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith("call-5", "not-an-object", undefined, extensionContext);
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: {},
        runId: "run-main",
        toolCallId: "call-5",
      },
      {
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
        sessionId: "ephemeral-main",
        runId: "run-main",
        toolCallId: "call-5",
      },
    );
  });

  it("keeps adjusted params isolated per run when toolCallId collides", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: vi
        .fn()
        .mockResolvedValueOnce({ params: { marker: "A" } })
        .mockResolvedValueOnce({ params: { marker: "B" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const toolA = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      runId: "run-a",
    });
    const toolB = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      runId: "run-b",
    });
    const extensionContextA = {} as Parameters<typeof toolA.execute>[3];
    const extensionContextB = {} as Parameters<typeof toolB.execute>[3];
    const sharedToolCallId = "shared-call";

    await toolA.execute(sharedToolCallId, { path: "/tmp/a.txt" }, undefined, extensionContextA);
    await toolB.execute(sharedToolCallId, { path: "/tmp/b.txt" }, undefined, extensionContextB);

    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-a")).toEqual({
      path: "/tmp/a.txt",
      marker: "A",
    });
    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-b")).toEqual({
      path: "/tmp/b.txt",
      marker: "B",
    });
    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-a")).toBeUndefined();
  });
});

describe("before_tool_call hook deduplication (#15502)", () => {
  let beforeToolCallHook: BeforeToolCallHandlerMock;

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => undefined,
    });
  });

  it("fires hook exactly once when tool goes through wrap + toToolDefinitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "web_fetch", execute, description: "fetch", parameters: {} } as any;

    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const [def] = toToolDefinitions([wrapped]);
    const extensionContext = {} as Parameters<typeof def.execute>[4];
    await def.execute(
      "call-dedup",
      { url: "https://example.com" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
  });

  it("passes agent context to outer code-mode exec hooks through OpenClaw custom tools", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({
        block: true,
        blockReason: "blocked before code-mode execution",
      }),
    });
    const abortController = new AbortController();
    const codeModeTools = createCodeModeTools({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
      abortSignal: abortController.signal,
      executeTool: async () => {
        throw new Error("catalog tool execution should not be reached");
      },
    });
    const execTool = codeModeTools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    if (!execTool) {
      throw new Error("missing code-mode exec tool");
    }
    const { customTools } = splitSdkTools({
      tools: [execTool],
      sandboxEnabled: false,
      toolHookContext: {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      },
    });
    const [def] = customTools;
    if (!def) {
      throw new Error("missing custom tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    const result = await def.execute(
      "call-code-mode-exec",
      { code: "return 1;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "return 1;", command: "return 1;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec",
      },
    );

    beforeToolCallHook.mockClear();
    const commandOnlyResult = await def.execute(
      "call-code-mode-exec-command",
      { command: "return 2;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(commandOnlyResult.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "return 2;", command: "return 2;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-command",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-command",
      },
    );

    beforeToolCallHook.mockClear();
    const typescriptResult = await def.execute(
      "call-code-mode-exec-typescript",
      {
        code: "const value: number = 5;",
        language: "typescript",
      },
      undefined,
      undefined,
      extensionContext,
    );

    expect(typescriptResult.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: {
          code: "const value: number = 5;",
          command: "const value: number = 5;",
          language: "typescript",
        },
        toolKind: "code_mode_exec",
        toolInputKind: "typescript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-typescript",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "typescript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-typescript",
      },
    );

    beforeToolCallHook.mockClear();
    const malformedAliasResult = await def.execute(
      "call-code-mode-exec-null-command",
      { code: "return 4;", command: null },
      undefined,
      undefined,
      extensionContext,
    );

    expect(malformedAliasResult.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "return 4;", command: "return 4;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-null-command",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-null-command",
      },
    );
  });

  it("marks code-mode exec without marking plain exec hooks", async () => {
    const observed: Array<{
      event: Record<string, unknown>;
      ctx: Record<string, unknown>;
    }> = [];
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async (event, ctx) => {
        observed.push({
          event: event as Record<string, unknown>,
          ctx: ctx as Record<string, unknown>,
        });
        if ((event as Record<string, unknown>).toolKind === "code_mode_exec") {
          return { block: true, blockReason: "blocked before code-mode execution" };
        }
        return { params: (event as { params: Record<string, unknown> }).params };
      },
    });
    const plainExecute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const [plainExecDef] = toToolDefinitions(
      [{ name: "exec", execute: plainExecute, description: "Plain exec", parameters: {} } as any],
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      },
    );
    const codeModeTools = createCodeModeTools({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
      abortSignal: new AbortController().signal,
      executeTool: async () => {
        throw new Error("catalog tool execution should not be reached");
      },
    });
    const codeModeExec = codeModeTools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    if (!plainExecDef || !codeModeExec) {
      throw new Error("missing exec definitions");
    }
    const [codeModeExecDef] = toToolDefinitions([codeModeExec], {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
    });
    if (!codeModeExecDef) {
      throw new Error("missing code-mode exec definition");
    }
    const extensionContext = {} as Parameters<typeof plainExecDef.execute>[4];

    await plainExecDef.execute(
      "call-plain-exec",
      { command: "echo hi" },
      undefined,
      undefined,
      extensionContext,
    );
    const codeModeResult = await codeModeExecDef.execute(
      "call-code-mode-exec",
      { code: "return 1;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(plainExecute).toHaveBeenCalledWith(
      "call-plain-exec",
      { command: "echo hi" },
      undefined,
      undefined,
    );
    expect(codeModeResult.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(observed[0]?.event).toMatchObject({
      toolName: "exec",
      params: { command: "echo hi" },
    });
    expect(observed[0]?.event).not.toHaveProperty("toolKind");
    expect(observed[1]?.event).toMatchObject({
      toolName: "exec",
      params: { code: "return 1;", command: "return 1;" },
      toolKind: "code_mode_exec",
      toolInputKind: "javascript",
    });
    expect(observed[1]?.ctx).toMatchObject({
      toolName: "exec",
      toolKind: "code_mode_exec",
      toolInputKind: "javascript",
    });
  });

  it("normalizes outer code-mode exec hook params when a wrapper owns the hook", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({
        block: true,
        blockReason: "blocked before code-mode execution",
      }),
    });
    const codeModeTools = createCodeModeTools({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
      abortSignal: new AbortController().signal,
      executeTool: async () => {
        throw new Error("catalog tool execution should not be reached");
      },
    });
    const execTool = codeModeTools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    if (!execTool) {
      throw new Error("missing code-mode exec tool");
    }
    const wrapped = wrapToolWithAbortSignal(
      wrapToolWithBeforeToolCallHook(execTool, {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      }),
      new AbortController().signal,
    );
    const [def] = toToolDefinitions([wrapped]);
    if (!def) {
      throw new Error("missing custom tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    const result = await def.execute(
      "call-wrapped-code-mode-exec",
      { command: "return 3;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { command: "return 3;", code: "return 3;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-wrapped-code-mode-exec",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-wrapped-code-mode-exec",
      },
    );
  });

  it("mirrors single-alias hook rewrites for code-mode exec aliases", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { command: "return 2;" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = markCodeModeControlTool({
      name: CODE_MODE_EXEC_TOOL_NAME,
      execute,
      description: "exec",
      parameters: {},
    } as any);
    const [def] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
    });
    if (!def) {
      throw new Error("missing custom tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-code-mode-exec-rewrite",
      { code: "return 1;", command: "return 1;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(execute).toHaveBeenCalledWith(
      "call-code-mode-exec-rewrite",
      { code: "return 2;", command: "return 2;" },
      undefined,
      undefined,
    );
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "return 1;", command: "return 1;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-rewrite",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-rewrite",
      },
    );
    expect(consumeAdjustedParamsForToolCall("call-code-mode-exec-rewrite", "run-main")).toEqual({
      code: "return 2;",
      command: "return 2;",
    });
  });

  it("renormalizes trusted policy rewrites before code-mode exec hooks observe params", async () => {
    resetGlobalHookRunner();
    const normalHook = vi.fn(async () => undefined);
    const trustedObserver = vi.fn(async () => undefined);
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "normal-plugin",
      hookName: "before_tool_call",
      handler: normalHook as PluginHookRegistration["handler"],
    });
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-plugin",
        pluginName: "Trusted Plugin",
        source: "test",
        policy: {
          id: "code-mode-rewrite-policy",
          description: "rewrite code-mode exec params",
          evaluate(eventValue) {
            if (eventValue.toolCallId === "call-code-mode-trusted-command") {
              return { params: { command: "return 2;" } };
            }
            if (eventValue.toolCallId === "call-code-mode-trusted-language") {
              return {
                params: {
                  code: "const value: number = 3;",
                  command: "const value: number = 3;",
                  language: "typescript",
                },
              };
            }
            return undefined;
          },
        },
      },
      {
        pluginId: "trusted-observer",
        pluginName: "Trusted Observer",
        source: "test",
        policy: {
          id: "code-mode-observer-policy",
          description: "observe rewritten code-mode exec params",
          evaluate: trustedObserver,
        },
      },
    ];
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    try {
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const tool = markCodeModeControlTool({
        name: CODE_MODE_EXEC_TOOL_NAME,
        execute,
        description: "exec",
        parameters: {},
      } as any);
      const [def] = toToolDefinitions([tool], {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      });
      if (!def) {
        throw new Error("missing custom tool definition");
      }
      const extensionContext = {} as Parameters<typeof def.execute>[4];

      await def.execute(
        "call-code-mode-trusted-command",
        { code: "return 1;", command: "return 1;" },
        undefined,
        undefined,
        extensionContext,
      );
      await def.execute(
        "call-code-mode-trusted-language",
        { code: "return 3;", command: "return 3;", language: "javascript" },
        undefined,
        undefined,
        extensionContext,
      );

      expect(normalHook).toHaveBeenNthCalledWith(
        1,
        {
          toolName: "exec",
          params: { command: "return 2;", code: "return 2;" },
          toolKind: "code_mode_exec",
          toolInputKind: "javascript",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-command",
        },
        expect.objectContaining({
          toolName: "exec",
          toolKind: "code_mode_exec",
          toolInputKind: "javascript",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-command",
        }),
      );
      expect(trustedObserver).toHaveBeenNthCalledWith(
        1,
        {
          toolName: "exec",
          params: { command: "return 2;", code: "return 2;" },
          toolKind: "code_mode_exec",
          toolInputKind: "javascript",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-command",
        },
        expect.objectContaining({
          toolName: "exec",
          toolKind: "code_mode_exec",
          toolInputKind: "javascript",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-command",
        }),
      );
      expect(normalHook).toHaveBeenNthCalledWith(
        2,
        {
          toolName: "exec",
          params: {
            code: "const value: number = 3;",
            command: "const value: number = 3;",
            language: "typescript",
          },
          toolKind: "code_mode_exec",
          toolInputKind: "typescript",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-language",
        },
        expect.objectContaining({
          toolName: "exec",
          toolKind: "code_mode_exec",
          toolInputKind: "typescript",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-language",
        }),
      );
      expect(trustedObserver).toHaveBeenNthCalledWith(
        2,
        {
          toolName: "exec",
          params: {
            code: "const value: number = 3;",
            command: "const value: number = 3;",
            language: "typescript",
          },
          toolKind: "code_mode_exec",
          toolInputKind: "typescript",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-language",
        },
        expect.objectContaining({
          toolName: "exec",
          toolKind: "code_mode_exec",
          toolInputKind: "typescript",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-language",
        }),
      );
      expect(execute).toHaveBeenNthCalledWith(
        1,
        "call-code-mode-trusted-command",
        { command: "return 2;", code: "return 2;" },
        undefined,
        undefined,
      );
      expect(execute).toHaveBeenNthCalledWith(
        2,
        "call-code-mode-trusted-language",
        {
          code: "const value: number = 3;",
          command: "const value: number = 3;",
          language: "typescript",
        },
        undefined,
        undefined,
      );
      expect(
        consumeAdjustedParamsForToolCall("call-code-mode-trusted-command", "run-main"),
      ).toEqual({ command: "return 2;", code: "return 2;" });
      expect(
        consumeAdjustedParamsForToolCall("call-code-mode-trusted-language", "run-main"),
      ).toEqual({
        code: "const value: number = 3;",
        command: "const value: number = 3;",
        language: "typescript",
      });
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      resetGlobalHookRunner();
    }
  });

  it("fires hook exactly once when tool goes through wrap + abort + toToolDefinitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "Bash", execute, description: "bash", parameters: {} } as any;

    const abortController = new AbortController();
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const withAbort = wrapToolWithAbortSignal(wrapped, abortController.signal);
    const [def] = toToolDefinitions([withAbort]);
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-abort-dedup",
      { command: "ls" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
  });

  it("passes hook context for unwrapped tool definitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "exec", execute, description: "exec", parameters: {} } as any;
    const [def] = toToolDefinitions([baseTool], {
      agentId: "code-agent",
      sessionKey: "agent:code-agent:main",
      sessionId: "session-code",
      runId: "run-code",
      channelId: "channel-code",
    });
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-code-exec",
      { code: "echo hi" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "echo hi" },
        runId: "run-code",
        toolCallId: "call-code-exec",
      },
      {
        toolName: "exec",
        agentId: "code-agent",
        sessionKey: "agent:code-agent:main",
        sessionId: "session-code",
        runId: "run-code",
        toolCallId: "call-code-exec",
        channelId: "channel-code",
      },
    );
  });

  it("preserves the hook marker when abort wrapping a hooked tool", () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "Bash", execute, description: "bash", parameters: {} } as any;
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const withAbort = wrapToolWithAbortSignal(wrapped, new AbortController().signal);

    expect(isToolWrappedWithBeforeToolCallHook(withAbort)).toBe(true);
  });
});

describe("before_tool_call hook integration for client tools", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    installBeforeToolCallHook();
  });

  it("blocks client-hosted execution while governed completion tracking is active", async () => {
    const decisions: unknown[] = [];
    const onClientToolCall = vi.fn();
    const [tool] = toClientToolDefinitions(
      [
        {
          type: "function",
          function: {
            name: "client_tool",
            description: "Client tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      onClientToolCall,
      {
        agentId: "main",
        sessionKey: "agent:main:governed-client",
        runId: "run-governed-client",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "governed",
          expectedCurrentStep: "execute",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: true,
          },
          onDecision: (decision) => decisions.push(decision),
        },
      },
    );

    const result = await tool.execute(
      "client-call-governed",
      {},
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(onClientToolCall).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        protected: true,
        decision: "BLOCKED",
        reasonCode: "CLIENT_HOSTED_EXECUTION_UNTRACKED",
      }),
    ]);
  });

  it("passes modified params to client tool callbacks", async () => {
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { extra: true } }),
    });
    const onClientToolCall = vi.fn();
    const [tool] = toClientToolDefinitions(
      [
        {
          type: "function",
          function: {
            name: "client_tool",
            description: "Client tool",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
      ],
      onClientToolCall,
      { agentId: "main", sessionKey: "main" },
    );
    const extensionContext = {} as Parameters<typeof tool.execute>[4];
    await tool.execute("client-call-1", { value: "ok" }, undefined, undefined, extensionContext);

    expect(onClientToolCall).toHaveBeenCalledWith("client_tool", {
      value: "ok",
      extra: true,
    });
  });

  it("preserves client tool source order when hooks resolve out of order", async () => {
    let releaseFirstHook: (() => void) | undefined;
    const firstHookGate = new Promise<void>((resolve) => {
      releaseFirstHook = resolve;
    });
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async (event: unknown) => {
        const toolName = (event as { toolName?: string }).toolName;
        if (toolName === "first_tool") {
          await firstHookGate;
        }
        return { params: { marker: toolName } };
      },
    });

    const slots: Array<{
      toolCallId: string;
      name: string;
      params?: Record<string, unknown>;
      completed: boolean;
    }> = [];
    const indexes = new Map<string, number>();
    const reserve = (toolCallId: string, name: string) => {
      indexes.set(toolCallId, slots.length);
      slots.push({ toolCallId, name, completed: false });
    };
    const complete = (toolCallId: string, name: string, params: Record<string, unknown>) => {
      const index = indexes.get(toolCallId);
      if (index === undefined) {
        throw new Error(`missing reserved client tool slot for ${toolCallId}`);
      }
      const slot = slots[index];
      if (!slot) {
        throw new Error(`missing client tool slot at ${index}`);
      }
      slot.name = name;
      slot.params = params;
      slot.completed = true;
    };
    const [firstTool, secondTool] = toClientToolDefinitions(
      [
        {
          type: "function",
          function: {
            name: "first_tool",
            description: "First client tool",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
        {
          type: "function",
          function: {
            name: "second_tool",
            description: "Second client tool",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
      ],
      { reserve, complete },
      { agentId: "main", sessionKey: "main" },
    );
    if (!firstTool || !secondTool) {
      throw new Error("missing client tool definitions");
    }
    const extensionContext = {} as Parameters<typeof firstTool.execute>[4];

    const firstRun = firstTool.execute(
      "client-call-1",
      { value: "first" },
      undefined,
      undefined,
      extensionContext,
    );
    const secondRun = secondTool.execute(
      "client-call-2",
      { value: "second" },
      undefined,
      undefined,
      extensionContext,
    );

    await secondRun;
    expect(slots.map((slot) => ({ name: slot.name, completed: slot.completed }))).toEqual([
      { name: "first_tool", completed: false },
      { name: "second_tool", completed: true },
    ]);

    if (!releaseFirstHook) {
      throw new Error("Expected first before-tool-call hook release callback to be initialized");
    }
    releaseFirstHook();
    await firstRun;

    expect(
      collectMatching(
        slots,
        (slot) => slot.completed,
        (slot) => slot.name,
      ),
    ).toEqual(["first_tool", "second_tool"]);
    expect(slots.map((slot) => slot.params)).toEqual([
      { value: "first", marker: "first_tool" },
      { value: "second", marker: "second_tool" },
    ]);
  });

  it("lets trusted policies read session extensions for client tools when config is provided", async () => {
    resetGlobalHookRunner();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-client-tool-policy-"));
    const storePath = path.join(stateDir, "sessions.json");
    const config = { session: { store: storePath } };
    const seen: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.sessionExtensions = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        extension: {
          namespace: "policy",
          description: "policy state",
        },
      },
    ];
    registry.trustedToolPolicies = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        policy: {
          id: "client-tool-session-extension-policy",
          description: "client tool session extension policy",
          evaluate(eventValue, ctx) {
            seen.push(ctx.getSessionExtension?.("policy"));
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    try {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:client"] = {
          sessionId: "session-client",
          updatedAt: Date.now(),
        } as SessionEntry;
      });
      await expect(
        patchPluginSessionExtension({
          cfg: config as never,
          sessionKey: "agent:main:client",
          pluginId: "policy-plugin",
          namespace: "policy",
          value: { gate: "client" },
        }),
      ).resolves.toEqual({
        ok: true,
        key: "agent:main:client",
        value: { gate: "client" },
      });

      const [tool] = toClientToolDefinitions(
        [
          {
            type: "function",
            function: {
              name: "client_tool",
              description: "Client tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        undefined,
        {
          agentId: "main",
          sessionKey: "agent:main:client",
          sessionId: "session-client",
          config: config as never,
        },
      );
      const extensionContext = {} as Parameters<typeof tool.execute>[4];
      await tool.execute("client-call-policy", {}, undefined, undefined, extensionContext);

      expect(seen).toEqual([{ gate: "client" }]);
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
