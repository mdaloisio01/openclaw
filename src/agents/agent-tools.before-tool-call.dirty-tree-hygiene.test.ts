import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateChildExecutionInheritance } from "../governance/child-execution-inheritance.js";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "../governance/governed-mission-contract.js";
import { createGovernedMissionState } from "../governance/governed-mission-state.js";
import {
  buildGovernedSupervisorReceipt,
  type GovernedSupervisorIdentity,
} from "../governance/governed-supervisor-receipt.js";
import type { MissionSpecificToolEnforcementAuthority } from "../governance/mission-specific-tool-enforcement.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { RunRecord } from "../process/supervisor/types.js";
import {
  runBeforeToolCallHook,
  setDirtyTreeHygieneStatusReaderForTest,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import type { ProcessSession } from "./bash-process-registry.js";

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

describe("before_tool_call dirty-tree hygiene gate", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    hookRunner = {
      hasHooks: vi.fn().mockReturnValue(false),
      runBeforeToolCall: vi.fn(),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  });

  afterEach(() => {
    setDirtyTreeHygieneStatusReaderForTest();
    delete process.env.OPENCLAW_GOVERNED_BUILD_WORKSPACE_METADATA;
  });

  function setStatus(status: string, calls?: string[]): void {
    setDirtyTreeHygieneStatusReaderForTest(async (repoDir) => {
      calls?.push(`git -C ${repoDir} status --short`);
      return status;
    });
  }

  function workspaceMetadata(params: { sourceRoot: string; worktreePath: string }) {
    return {
      schema: "openclaw.governed_build_workspace.v1",
      buildId: "clean-tree",
      buildName: "Clean Tree",
      controllingPlanPath: "/exports/plan.md",
      buildPromptPath: "/exports/prompt.md",
      workOrderPath: "/exports/work_order.json",
      sourceRoot: params.sourceRoot,
      worktreePath: params.worktreePath,
      branch: "governed/clean-tree",
      baseRef: "abc123",
      head: "abc123",
      allowedWriteScopes: ["src/infra"],
      ownerLease: {
        owner: "Will",
        leaseId: "lease-1",
        acquiredAt: "2026-08-22T15:04Z",
      },
      sourceLock: {
        schema: "openclaw.source_lock_snapshot.v1",
        sourceRoot: params.sourceRoot,
        worktreePath: params.worktreePath,
        branch: "governed/clean-tree",
        head: "abc123",
        baseRef: "abc123",
        indexHash: "idx",
        unstagedDiffHash: "unstaged",
        stagedDiffHash: "staged",
        untrackedManifestHash: "untracked",
        ignoredGeneratedManifestHash: "generated",
        worktreeListHash: "worktrees",
        submoduleStatusHash: "submodules",
        packageLockHash: "package-lock",
        allowedWriteScopes: ["src/infra"],
        generatedOutputPolicy: "record_only",
        timestamp: "2026-08-22T15:04Z",
        owner: "Will",
      },
      generatedOutputPolicy: "record_only",
      integrationState: "worktree_active",
      rollbackRef: "abc123",
      proofPaths: ["/proof/source-lock.json"],
      retentionState: "active",
    };
  }

  function broadMixedStatus(): string {
    return [
      " M src/agents/agent-tools.before-tool-call.ts",
      " M src/infra/restart.ts",
      " M src/auto-reply/reply/agent-runner.ts",
      " M scripts/build-all.mjs",
      "?? docs/gateway/build-integrity.md",
    ].join("\n");
  }

  function createWrappedPatchTool(name = "apply_patch") {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "patched" }],
      details: { ok: true },
    });
    return {
      execute,
      tool: wrapToolWithBeforeToolCallHook({ name, execute } as any, {
        agentId: "main",
      }),
    };
  }

  function governedToolAuthority(): MissionSpecificToolEnforcementAuthority {
    const contract: GovernedMissionContract = {
      schema: "openclaw.governed_mission_contract.v1",
      missionId: "mission-1",
      contractId: "contract-1",
      contractVersion: "2026-08-23T0241Z",
      contractHash: "contract-hash",
      authorityHash: "authority-hash",
      authorityRefs: [
        {
          refId: "plan",
          kind: "build_plan",
          uri: "/exports/sop_enforcement_master_build_plan_2026-08-21T1905Z.md",
          sha256: "authority-hash",
        },
      ],
      admissionReceiptRef: "admission-1",
      planRevisionId: "plan-revision",
      sourceRevision: "31d50dc436ddada2c38cb02e33a9e68a20216959",
      runtimeBuildSha256: "openclaw-2026.6.2-a87590b",
      policyVersion: "sop-enforcement-v1",
      mode: "shadow",
      authoritativeCompletionOwner: "governed_mission_state",
      requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
      createdAt: "2026-08-23T02:41:00Z",
    };
    const missionState = createGovernedMissionState({
      contract,
      authorityRef: contract.authorityRefs[0],
      currentStep: "SOP-ENF-10",
      ownerCorrelation: { owner: "Cleanup Crew", taskFlowId: "flow-1" },
      now: "2026-08-23T02:41:00Z",
    });
    return {
      governedMissionAdmitted: true,
      contract,
      missionState,
      expectedCurrentStep: "SOP-ENF-10",
      observedContractHash: "contract-hash",
      observedAuthorityHash: "authority-hash",
      requiredEvidencePresent: true,
      enforcementHealth: { healthy: true },
    };
  }

  function governedToolAuthorityWithChildInheritance(): MissionSpecificToolEnforcementAuthority {
    const base = governedToolAuthority();
    return {
      ...base,
      childInheritance: evaluateChildExecutionInheritance({
        actionId: "child-spawn-1",
        parent: {
          missionId: base.contract.missionId,
          contractId: base.contract.contractId,
          contractHash: base.contract.contractHash,
          authorityHash: base.contract.authorityHash,
          sessionKey: "agent:orchestrator:main",
          runId: "parent-run",
          taskFlowId: "flow-1",
          taskId: "task-1",
          policy: {
            authorityRank: "governed",
            allowedActionClasses: ["tool_call", "exec_call", "child_delegation"],
          },
        },
        child: {
          runtime: "subagent",
          sessionKey: "agent:grant:subagent:child",
          runId: "child-run",
          taskFlowId: "flow-1",
          taskId: "task-2",
          policy: {
            authorityRank: "read_only",
            allowedActionClasses: ["tool_call"],
          },
        },
        now: "2026-08-23T03:56:00Z",
      }),
    };
  }

  function governedToolAuthorityWithSupervisorReceipt(): MissionSpecificToolEnforcementAuthority {
    const base = governedToolAuthority();
    const identity: GovernedSupervisorIdentity = {
      missionId: base.contract.missionId,
      contractId: base.contract.contractId,
      contractVersion: base.contract.contractVersion,
      contractHash: base.contract.contractHash,
      authorityHash: base.contract.authorityHash,
      policyVersion: base.contract.policyVersion,
    };
    const session: ProcessSession = {
      id: "supervisor-session-1",
      command: "bash scripts/repair-governance.sh",
      startedAt: 100,
      cwd: "/home/will/openclaw-source",
      maxOutputChars: 10_000,
      totalOutputChars: 2,
      pendingStdout: [],
      pendingStderr: [],
      pendingStdoutChars: 0,
      pendingStderrChars: 0,
      aggregated: "ok",
      tail: "ok",
      exited: false,
      truncated: false,
      backgrounded: true,
      cursorKeyMode: "normal",
      pid: 4242,
    };
    const runRecord: RunRecord = {
      runId: "supervisor-run-1",
      sessionId: session.id,
      backendId: "exec",
      pid: 4242,
      processGroupId: 4242,
      state: "running",
      startedAtMs: 100,
      lastOutputAtMs: 100,
      createdAtMs: 100,
      updatedAtMs: 100,
    };
    return {
      ...base,
      supervisorReceipt: buildGovernedSupervisorReceipt({
        identity,
        producer: "exec-supervisor",
        session,
        runRecord,
        producedAt: "2026-08-23T13:45:00Z",
      }),
    };
  }

  function requireBlockedResult(result: unknown): Record<string, unknown> {
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    const record = result as Record<string, unknown>;
    expect(record.details).toMatchObject({
      status: "blocked",
      deniedReason: "dirty-tree-hygiene",
    });
    return record;
  }

  function getBlockedText(result: unknown): string {
    const record = requireBlockedResult(result);
    const content = record.content;
    expect(Array.isArray(content)).toBe(true);
    const firstContent = Array.isArray(content) ? content[0] : undefined;
    expect(typeof firstContent).toBe("object");
    expect(firstContent).not.toBeNull();
    return String((firstContent as Record<string, unknown>).text);
  }

  it("allows source-modifying tool calls when the tree is clean", async () => {
    setStatus("");
    const { execute, tool } = createWrappedPatchTool("functions.apply_patch");

    const result = await tool.execute(
      "patch-clean",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ details: { ok: true } });
  });

  it("blocks source mutation during Cleanup Crew read-only analysis mode", async () => {
    setStatus("");
    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { patch: "*** Begin Patch\n*** End Patch" },
      ctx: {
        agentId: "main",
        cleanupCrewRecovery: {
          analysisMode: true,
          missionId: "cleanup-crew-pause-analyze-plan-resume",
          stoppageId: "stoppage_receipt_123",
          nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "cleanup-crew-analysis-mode",
    });
    expect(result.blocked ? result.reason : "").toContain("read-only inspection only");
  });

  it("allows read-only diagnostics during Cleanup Crew analysis mode", async () => {
    const params = { cmd: "git status --short" };
    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params,
      ctx: {
        agentId: "main",
        cleanupCrewRecovery: {
          analysisMode: true,
          missionId: "cleanup-crew-pause-analyze-plan-resume",
          stoppageId: "stoppage_receipt_123",
        },
      },
    });

    expect(result).toEqual({ blocked: false, params });
  });

  it("blocks shell mutation during Cleanup Crew analysis mode before dirty-tree evaluation", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { cmd: "touch src/continuity/tmp.txt" },
      ctx: {
        agentId: "main",
        cleanupCrewRecovery: {
          analysisMode: true,
          missionId: "cleanup-crew-pause-analyze-plan-resume",
          stoppageId: "stoppage_receipt_123",
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      deniedReason: "cleanup-crew-analysis-mode",
    });
    expect(statusCalls).toEqual([]);
  });

  it("does not hard-block a narrow coherent dirty package", async () => {
    setStatus(" M src/infra/dirty-tree-hygiene.ts\n?? src/infra/new-helper.ts\n");
    const { execute, tool } = createWrappedPatchTool();

    const result = await tool.execute(
      "patch-narrow",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ details: { ok: true } });
  });

  it("does not let generated output clutter turn narrow source work into broad mixed risk", async () => {
    setStatus(
      [
        " M src/infra/dirty-tree-hygiene.ts",
        "?? dist.broken-2026-07-07T055954357Z/",
        "?? file_hub/exports/cleanup-proof.md",
      ].join("\n"),
    );
    const { execute, tool } = createWrappedPatchTool();

    const result = await tool.execute(
      "patch-generated-clutter",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ details: { ok: true } });
  });

  it("blocks source-modifying tool calls when the dirty tree is broad and mixed", async () => {
    setStatus(
      [
        "M  extensions/codex/src/app-server/confirmation-gate.ts",
        " M src/infra/dirty-tree-hygiene.ts",
        "?? src/infra/heartbeat-runner-new.ts",
      ].join("\n"),
    );
    const { execute, tool } = createWrappedPatchTool();

    const result = await tool.execute(
      "patch-broad",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(execute).not.toHaveBeenCalled();
    const text = getBlockedText(result);
    expect(text).toContain("broad/mixed");
    expect(text).toContain("codex-app-server");
    expect(text).toContain("production-flow-watchdog");
    expect(text).toContain("staged=1");
    expect(text).toContain("unstaged=1");
    expect(text).toContain("untracked=1");
  });

  it("allows canonical memory flush writes with matching metadata during broad mixed dirty-tree risk", async () => {
    const statusCalls: string[] = [];
    const params = {
      path: "memory/2026-06-28.md",
      content: "durable note",
    };
    setStatus(broadMixedStatus(), statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params,
      ctx: {
        agentId: "main",
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-06-28.md",
      },
    });

    expect(result).toEqual({ blocked: false, params });
    expect(statusCalls).toEqual([]);
  });

  it("allows namespaced memory flush write tools with append-only metadata", async () => {
    const statusCalls: string[] = [];
    const params = {
      path: "memory/2026-06-28.md",
      content: "durable note",
      mode: "append",
      appendOnly: true,
      operation: "operational_memory_append",
    };
    setStatus(broadMixedStatus(), statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "functions.write",
      params,
      ctx: {
        agentId: "main",
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-06-28.md",
      },
    });

    expect(result).toEqual({ blocked: false, params });
    expect(statusCalls).toEqual([]);
  });

  it("allows canonical memory flush writes when the tree is clean", async () => {
    const params = {
      path: "memory/2026-06-28.md",
      content: "durable note",
    };
    setStatus("");

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params,
      ctx: {
        agentId: "main",
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-06-28.md",
      },
    });

    expect(result).toEqual({ blocked: false, params });
  });

  it.each([
    {
      name: "normal webchat write to the canonical memory path",
      params: { path: "memory/2026-06-28.md", content: "durable note" },
      ctx: { agentId: "main" },
    },
    {
      name: "mismatched memory flush path",
      params: { path: "memory/2026-06-27.md", content: "durable note" },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "absolute memory path",
      params: {
        path: "/home/will/.openclaw/workspace-orchestrator/memory/2026-06-28.md",
        content: "durable note",
      },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "bootstrap reference write",
      params: { path: "AGENTS.md", content: "do not write" },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "memory overwrite-shaped write",
      params: {
        path: "memory/2026-06-28.md",
        content: "durable note",
        mode: "overwrite",
      },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "false append-only metadata",
      params: {
        path: "memory/2026-06-28.md",
        content: "durable note",
        appendOnly: false,
      },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "malformed memory target",
      params: { path: "memory/today.md", content: "durable note" },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "path escape from memory root",
      params: { path: "memory/../src/agents/agent-tools.before-tool-call.ts", content: "nope" },
      ctx: { agentId: "main", trigger: "memory", memoryFlushWritePath: "memory/2026-06-28.md" },
    },
    {
      name: "normal source write",
      params: { path: "src/agents/agent-tools.before-tool-call.ts", content: "do not write" },
      ctx: { agentId: "main" },
    },
  ])("blocks $name during broad mixed dirty-tree risk", async ({ params, ctx }) => {
    setStatus(broadMixedStatus());

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params,
      ctx,
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "dirty-tree-hygiene",
    });
  });

  it("allows read-only diagnostic shell commands during broad mixed dirty-tree risk", async () => {
    const statusCalls: string[] = [];
    setStatus(
      " M extensions/codex/src/app-server/run-attempt.ts\n?? src/tasks/probe.ts\n",
      statusCalls,
    );

    const result = await runBeforeToolCallHook({
      toolName: "functions.exec_command",
      params: { cmd: "git status --short" },
      ctx: { agentId: "main" },
    });

    expect(result).toEqual({ blocked: false, params: { cmd: "git status --short" } });
    expect(statusCalls).toEqual([]);
  });

  it("blocks governed protected tools without mission authority before dirty-tree hygiene", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "functions.apply_patch",
      params: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/governance/protected-action-policy.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        sessionKey: "agent:orchestrator:main",
        runId: "run-1",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "ordinary",
          expectedCurrentStep: "SOP-ENF-10",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: true,
          },
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(result.blocked ? result.reason : "").toContain("MISSING_GOVERNED_AUTHORITY");
    expect(statusCalls).toEqual([]);
  });

  it("blocks governed protected tools when host policy denies", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "functions.apply_patch",
      params: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/governance/protected-action-policy.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "governed",
          expectedCurrentStep: "SOP-ENF-10",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: false,
          },
          authority: governedToolAuthority(),
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(result.blocked ? result.reason : "").toContain("POLICY_DENY");
  });

  it("blocks governed protected tools with stale governed mission context", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "functions.apply_patch",
      params: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/governance/protected-action-policy.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "governed",
          expectedCurrentStep: "SOP-ENF-10",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: true,
          },
          authority: {
            ...governedToolAuthority(),
            missionState: {
              ...governedToolAuthority().missionState,
              contractHash: "stale-contract-hash",
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(result.blocked ? result.reason : "").toContain("CONTRACT_STATE_HASH_MISMATCH");
  });

  it("allows governed protected tools with valid mission authority", async () => {
    const params = {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/governance/protected-action-policy.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    };
    setStatus("");

    const result = await runBeforeToolCallHook({
      toolName: "functions.apply_patch",
      params,
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "governed",
          expectedCurrentStep: "SOP-ENF-10",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: true,
          },
          authority: governedToolAuthority(),
        },
      },
    });

    expect(result).toEqual({ blocked: false, params });
  });

  it("blocks governed exec when the supervisor wrapper is required but missing", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "functions.exec_command",
      params: {
        cmd: "bash scripts/repair-governance.sh",
        sandbox_permissions: "require_escalated",
      },
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "governed",
          expectedCurrentStep: "SOP-ENF-10",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: true,
          },
          supervisorWrapperRequired: true,
          authority: governedToolAuthority(),
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(result.blocked ? result.reason : "").toContain("MISSING_SUPERVISOR_WRAPPER");
  });

  it("allows governed exec when the required supervisor wrapper is active", async () => {
    const params = {
      cmd: "bash scripts/repair-governance.sh",
      sandbox_permissions: "require_escalated",
    };
    setStatus("");

    const result = await runBeforeToolCallHook({
      toolName: "functions.exec_command",
      params,
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "governed",
          expectedCurrentStep: "SOP-ENF-10",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: true,
          },
          supervisorWrapperRequired: true,
          supervisorWrapperActive: true,
          authority: governedToolAuthorityWithSupervisorReceipt(),
        },
      },
    });

    expect(result).toEqual({ blocked: false, params });
  });

  it("blocks governed exec when the supervisor wrapper is active but receipt proof is missing", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "functions.exec_command",
      params: {
        cmd: "bash scripts/repair-governance.sh",
        sandbox_permissions: "require_escalated",
      },
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "governed",
          expectedCurrentStep: "SOP-ENF-10",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: true,
          },
          supervisorWrapperRequired: true,
          supervisorWrapperActive: true,
          authority: governedToolAuthority(),
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(result.blocked ? result.reason : "").toContain("MISSING_SUPERVISOR_RECEIPT");
  });

  it("blocks governed child delegation without an inheritance receipt", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "sessions_spawn",
      params: {
        runtime: "subagent",
        agentId: "grant",
        task: "Review the governed slice.",
      },
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "governed",
          expectedCurrentStep: "SOP-ENF-10",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: true,
          },
          authority: governedToolAuthority(),
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-mission-tool-enforcement",
    });
    expect(result.blocked ? result.reason : "").toContain("MISSING_CHILD_INHERITANCE");
  });

  it("allows governed child delegation with an equal-or-narrower inheritance receipt", async () => {
    const params = {
      runtime: "subagent",
      agentId: "grant",
      task: "Review the governed slice.",
    };
    setStatus("");

    const result = await runBeforeToolCallHook({
      toolName: "sessions_spawn",
      params,
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        governedMissionToolEnforcement: {
          active: true,
          conversationClassification: "governed",
          expectedCurrentStep: "SOP-ENF-10",
          trustedHostPolicy: {
            trustedHost: true,
            openclawAllows: true,
            osAllows: true,
            hostAllows: true,
          },
          authority: governedToolAuthorityWithChildInheritance(),
        },
      },
    });

    expect(result).toEqual({ blocked: false, params });
  });

  it("blocks governed build source mutation from root before dirty-tree hygiene runs", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { path: "src/infra/governed-build-workspace.ts", content: "mutation" },
      ctx: {
        agentId: "main",
        cwd: "/home/will/openclaw-source",
        workspaceDir: "/home/will/openclaw-source",
        governedBuildWorkspace: {
          active: true,
          buildId: "clean-tree",
          sourceRoot: "/home/will/openclaw-source",
          worktreePath:
            "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
          allowedWriteScopes: ["src/infra"],
          markFacingExportRoots: [
            "/home/will/.openclaw/workspace-orchestrator/file_hub/exports",
            "/home/will/.openclaw/workspace/file_hub/exports",
          ],
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-build-root-mutation-guard",
    });
    expect(result.blocked ? result.reason : "").toContain("Use isolated worktree");
    expect(statusCalls).toEqual([]);
  });

  it("allows governed build mutation inside the active isolated worktree", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);
    const params = { path: "src/infra/governed-build-workspace.ts", content: "mutation" };

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params,
      ctx: {
        agentId: "main",
        cwd: "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
        workspaceDir:
          "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
        governedBuildWorkspace: {
          active: true,
          buildId: "clean-tree",
          sourceRoot: "/home/will/openclaw-source",
          worktreePath:
            "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
          allowedWriteScopes: ["src/infra"],
          markFacingExportRoots: [
            "/home/will/.openclaw/workspace-orchestrator/file_hub/exports",
            "/home/will/.openclaw/workspace/file_hub/exports",
          ],
        },
      },
    });

    expect(result).toEqual({ blocked: false, params });
    expect(statusCalls).toEqual(["git -C /home/will/openclaw-source status --short"]);
  });

  it("blocks targetless governed build mutation even when cwd is the active worktree", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "functions.apply_patch",
      params: { patch: "*** Begin Patch\n*** End Patch" },
      ctx: {
        agentId: "main",
        cwd: "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
        workspaceDir:
          "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
        governedBuildWorkspace: {
          active: true,
          buildId: "clean-tree",
          sourceRoot: "/home/will/openclaw-source",
          worktreePath:
            "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
          allowedWriteScopes: ["src/infra"],
          markFacingExportRoots: [
            "/home/will/.openclaw/workspace-orchestrator/file_hub/exports",
            "/home/will/.openclaw/workspace/file_hub/exports",
          ],
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-build-root-mutation-guard",
    });
    expect(result.blocked ? result.reason : "").toContain("outside allowed write scopes");
    expect(statusCalls).toEqual([]);
  });

  it("enforces allowed write scopes from apply_patch file headers", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);
    const ctx = {
      agentId: "main",
      cwd: "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
      workspaceDir:
        "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
      governedBuildWorkspace: {
        active: true,
        buildId: "clean-tree",
        sourceRoot: "/home/will/openclaw-source",
        worktreePath:
          "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
        allowedWriteScopes: ["src/infra"],
        markFacingExportRoots: [
          "/home/will/.openclaw/workspace-orchestrator/file_hub/exports",
          "/home/will/.openclaw/workspace/file_hub/exports",
        ],
      },
    };
    const allowedParams = {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/infra/governed-build-workspace.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    };
    const blockedParams = {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/governance/off-plan.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    };

    await expect(
      runBeforeToolCallHook({
        toolName: "functions.apply_patch",
        params: allowedParams,
        ctx,
      }),
    ).resolves.toEqual({ blocked: false, params: allowedParams });

    await expect(
      runBeforeToolCallHook({
        toolName: "functions.apply_patch",
        params: blockedParams,
        ctx,
      }),
    ).resolves.toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-build-root-mutation-guard",
    });
    expect(statusCalls).toEqual(["git -C /home/will/openclaw-source status --short"]);
  });

  it("blocks governed build mutation outside active worktree allowed scopes", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { path: "src/governance/off-plan.ts", content: "mutation" },
      ctx: {
        agentId: "main",
        cwd: "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
        workspaceDir:
          "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
        governedBuildWorkspace: {
          active: true,
          buildId: "clean-tree",
          sourceRoot: "/home/will/openclaw-source",
          worktreePath:
            "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
          allowedWriteScopes: ["src/infra"],
          markFacingExportRoots: [
            "/home/will/.openclaw/workspace-orchestrator/file_hub/exports",
            "/home/will/.openclaw/workspace/file_hub/exports",
          ],
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "governed-build-root-mutation-guard",
    });
    expect(result.blocked ? result.reason : "").toContain("outside allowed write scopes");
    expect(statusCalls).toEqual([]);
  });

  it("loads governed workspace metadata from the active worktree ancestor", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clean-tree-metadata-"));
    try {
      const buildRoot = path.join(tempRoot, "clean-tree");
      const worktreePath = path.join(buildRoot, "source");
      await fs.mkdir(path.join(worktreePath, "src", "infra"), { recursive: true });
      await fs.writeFile(
        path.join(buildRoot, "workspace.json"),
        JSON.stringify(
          workspaceMetadata({ sourceRoot: "/home/will/openclaw-source", worktreePath }),
        ),
        "utf8",
      );

      const params = { path: "src/infra/governed-build-workspace.ts", content: "mutation" };
      const result = await runBeforeToolCallHook({
        toolName: "write",
        params,
        ctx: {
          agentId: "main",
          cwd: worktreePath,
          workspaceDir: worktreePath,
        },
      });

      expect(result).toEqual({ blocked: false, params });
      expect(statusCalls).toEqual(["git -C /home/will/openclaw-source status --short"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads explicit governed workspace metadata to protect root source mutation", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clean-tree-explicit-metadata-"));
    try {
      const metadataPath = path.join(tempRoot, "workspace.json");
      await fs.writeFile(
        metadataPath,
        JSON.stringify(
          workspaceMetadata({
            sourceRoot: "/home/will/openclaw-source",
            worktreePath:
              "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
          }),
        ),
        "utf8",
      );
      process.env.OPENCLAW_GOVERNED_BUILD_WORKSPACE_METADATA = metadataPath;

      const result = await runBeforeToolCallHook({
        toolName: "write",
        params: { path: "src/infra/governed-build-workspace.ts", content: "mutation" },
        ctx: {
          agentId: "main",
          cwd: "/home/will/openclaw-source",
          workspaceDir: "/home/will/openclaw-source",
        },
      });

      expect(result).toMatchObject({
        blocked: true,
        kind: "veto",
        deniedReason: "governed-build-root-mutation-guard",
      });
      expect(statusCalls).toEqual([]);
    } finally {
      delete process.env.OPENCLAW_GOVERNED_BUILD_WORKSPACE_METADATA;
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses only read-only git status for dirty-tree hygiene checks", async () => {
    const statusCalls: string[] = [];
    setStatus("", statusCalls);
    const { tool } = createWrappedPatchTool();

    await tool.execute(
      "patch-read-only-gate",
      { patch: "*** Begin Patch\n*** End Patch" },
      undefined,
      undefined,
    );

    expect(statusCalls).toEqual(["git -C /home/will/openclaw-source status --short"]);
    expect(statusCalls.join("\n")).not.toMatch(/\b(reset|stash|clean|add|rm)\b/);
  });

  it("leaves stale confirmation-policy behavior unaffected", async () => {
    setStatus("");

    const result = await runBeforeToolCallHook({
      toolName: "message",
      params: { text: "update" },
      ctx: { agentId: "main" },
    });

    expect(result).toEqual({ blocked: false, params: { text: "update" } });
  });
});
