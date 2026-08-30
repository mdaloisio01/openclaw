import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CleanupCrewRuntimeMissionContract,
  CleanupCrewRuntimeToolPreflightDecision,
} from "../governance/cleanup-crew-runtime-enforcement.js";
import {
  CLEANUP_WATCHDOG_CLEAN_DIMENSIONS,
  CLEANUP_WATCHDOG_POLICY_VERSION,
} from "../governance/cleanup-watchdog-policy.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  runBeforeToolCallHook,
  setDirtyTreeHygieneStatusReaderForTest,
  type HookContext,
} from "./agent-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(),
  };
});

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

const contract: CleanupCrewRuntimeMissionContract = {
  missionId: "cleanup-crew-runtime-enforcement-slice-2",
  controllingPlanRef:
    "/home/will/.openclaw/workspace/file_hub/exports/cleanup_crew_runtime_enforcement_integration_build_package_2026-08-29T0406Z.md",
  lawfulOwner: "Engineering Delivery",
  allowedTools: ["read", "functions.apply_patch", "functions.exec_command", "message"],
  forbiddenTools: ["raw_db_edit"],
  allowedPaths: ["src/agents"],
  forbiddenPaths: ["/home/will/openclaw-source/state"],
  requiredProof: ["focused_pre_tool_tests", "git_diff_check"],
  doneCriteria: ["slice_2_preflight_gate_exists", "hard_enforcement_not_active"],
  stopConditions: ["authority_conflict", "activation_gate_required"],
  requiredReportMoments: ["slice_2_closeout"],
  watchdogCleanDimensions: [...CLEANUP_WATCHDOG_CLEAN_DIMENSIONS],
  policyVersion: CLEANUP_WATCHDOG_POLICY_VERSION,
};

function preflightContext(
  decisions: CleanupCrewRuntimeToolPreflightDecision[],
  preflightOverrides: Partial<NonNullable<HookContext["cleanupCrewRuntimePreflight"]>> = {},
): HookContext {
  return {
    agentId: "engineering-delivery",
    cwd: "/home/will/openclaw-source",
    workspaceDir: "/home/will/openclaw-source",
    cleanupCrewRuntimePreflight: {
      mode: "enforce" as const,
      activationGatesPassed: true,
      activeMissionScope: "Cleanup Crew Runtime Enforcement Integration Slice 2",
      contract,
      permissionMode: "scoped_write" as const,
      approvalClassSatisfied: true,
      lawfulOwnerMatched: true,
      idempotencyKeyPresent: true,
      rollbackProofPreserved: true,
      onDecision: (decision: CleanupCrewRuntimeToolPreflightDecision) => {
        decisions.push(decision);
      },
      ...preflightOverrides,
    },
  };
}

describe("before_tool_call Cleanup Crew runtime preflight", () => {
  beforeEach(() => {
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(false),
      runBeforeToolCall: vi.fn(),
    } as any);
    setDirtyTreeHygieneStatusReaderForTest(async () => "");
  });

  afterEach(() => {
    setDirtyTreeHygieneStatusReaderForTest();
  });

  it("allows read action without mutation authority", async () => {
    const decisions: CleanupCrewRuntimeToolPreflightDecision[] = [];
    const params = { path: "src/agents/agent-tools.before-tool-call.ts" };

    const result = await runBeforeToolCallHook({
      toolName: "read",
      params,
      ctx: preflightContext(decisions, {
        mode: "advisory",
        permissionMode: "read_only",
      }),
    });

    expect(result).toEqual({ blocked: false, params });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      riskClasses: ["read"],
      gate: { state: "not_required" },
    });
  });

  it("allows scoped write with mission scope, build plan, owner, and permission mode", async () => {
    const decisions: CleanupCrewRuntimeToolPreflightDecision[] = [];
    const params = {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/agents/agent-tools.before-tool-call.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
      idempotency_key: "slice-2-write",
      rollbackProofPreserved: true,
    };

    const result = await runBeforeToolCallHook({
      toolName: "functions.apply_patch",
      params,
      ctx: preflightContext(decisions),
    });

    expect(result).toEqual({ blocked: false, params });
    expect(decisions[0]).toMatchObject({
      riskClasses: ["write", "file-write"],
      gate: { state: "pass" },
    });
  });

  it("blocks off-plan write in enforce simulation after activation proof is supplied", async () => {
    const decisions: CleanupCrewRuntimeToolPreflightDecision[] = [];
    const result = await runBeforeToolCallHook({
      toolName: "functions.apply_patch",
      params: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/governance/off-plan.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      ctx: preflightContext(decisions),
    });

    expect(result).toMatchObject({
      blocked: true,
      deniedReason: "cleanup-crew-runtime-preflight",
    });
    expect(result.blocked ? result.reason : "").toContain("path_not_allowlisted");
  });

  it("blocks destructive command in enforce simulation", async () => {
    const decisions: CleanupCrewRuntimeToolPreflightDecision[] = [];
    const result = await runBeforeToolCallHook({
      toolName: "functions.exec_command",
      params: { cmd: "rm -rf /tmp/cleanup-crew-preflight" },
      ctx: preflightContext(decisions),
    });

    expect(result).toMatchObject({
      blocked: true,
      deniedReason: "cleanup-crew-runtime-preflight",
    });
    expect(decisions[0]?.riskClasses).toEqual(["shell", "destructive"]);
  });

  it("blocks unapproved restart in enforce simulation", async () => {
    const decisions: CleanupCrewRuntimeToolPreflightDecision[] = [];
    const result = await runBeforeToolCallHook({
      toolName: "functions.exec_command",
      params: { cmd: "openclaw gateway restart" },
      ctx: preflightContext(decisions, {
        approvalClassSatisfied: false,
        permissionMode: "scoped_write",
      }),
    });

    expect(result).toMatchObject({
      blocked: true,
      deniedReason: "cleanup-crew-runtime-preflight",
    });
    expect(result.blocked ? result.reason : "").toContain("approval_class_not_satisfied");
    expect(result.blocked ? result.reason : "").toContain("permission_mode_not_allowed:restart");
  });

  it("blocks external-send without explicit approval in enforce simulation", async () => {
    const decisions: CleanupCrewRuntimeToolPreflightDecision[] = [];
    const result = await runBeforeToolCallHook({
      toolName: "message",
      params: { action: "send", text: "visible external update" },
      ctx: preflightContext(decisions, {
        approvalClassSatisfied: false,
        permissionMode: "read_only",
      }),
    });

    expect(result).toMatchObject({
      blocked: true,
      deniedReason: "cleanup-crew-runtime-preflight",
    });
    expect(decisions[0]?.riskClasses).toEqual(["external-send"]);
  });

  it("logs would-block in advisory mode without activating hard enforcement", async () => {
    const decisions: CleanupCrewRuntimeToolPreflightDecision[] = [];
    const params = { action: "send", text: "visible external update" };
    const result = await runBeforeToolCallHook({
      toolName: "message",
      params,
      ctx: preflightContext(decisions, {
        mode: "advisory",
        approvalClassSatisfied: false,
        permissionMode: "read_only",
      }),
    });

    expect(result).toEqual({ blocked: false, params });
    expect(decisions[0]).toMatchObject({
      riskClasses: ["external-send"],
      gate: { state: "fail" },
    });
  });

  it("negative: disabling the Cleanup Crew preflight gate lets a bad preflight case through", async () => {
    const decisions: CleanupCrewRuntimeToolPreflightDecision[] = [];
    const params = { cmd: "rm -rf /tmp/cleanup-crew-preflight" };
    const result = await runBeforeToolCallHook({
      toolName: "functions.exec_command",
      params,
      ctx: preflightContext(decisions, {
        mode: "disabled",
      }),
    });

    expect(result).toEqual({ blocked: false, params });
    expect(decisions).toEqual([]);
  });
});
