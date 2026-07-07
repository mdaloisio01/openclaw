import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveRequiredCompletionTerminalResult } from "./task-completion-contract.js";
import { formatTaskTerminalMessage } from "./task-executor-policy.js";
import {
  createBlindTestSliceFlow,
  createNextBlindTestSliceFlow,
  finishFlow,
  getTaskFlowById,
  recordBlindTestDraftReview,
  recordBlindTestImplementationReview,
  resetTaskFlowRegistryForTests,
} from "./task-flow-runtime-internal.js";
import {
  activateTaskMissionById,
  createTaskRecord,
  getTaskById,
  recordTaskProgressByRunId,
  resetTaskRegistryForTests,
  resolveMissionBoundFollowupForOwner,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

function requireTask(task: TaskRecord | null): TaskRecord {
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

async function withProofHarnessState<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-grant-blind-proof-" },
    async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests();
      try {
        return await run(state.stateDir);
      } finally {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

async function loadFollowupProofTools(params: { callGatewayMock: ReturnType<typeof vi.fn> }) {
  vi.resetModules();
  vi.doMock("../gateway/call.js", () => ({
    callGateway: (opts: unknown) =>
      (params.callGatewayMock as unknown as (opts: unknown) => unknown)(opts),
  }));
  vi.doMock("../config/config.js", async () => {
    const actual =
      await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
    return {
      ...actual,
      getRuntimeConfig: () =>
        ({
          session: { scope: "per-sender", mainKey: "main" },
          tools: { agentToAgent: { enabled: false } },
        }) as never,
    };
  });
  vi.doMock("../agents/tools/sessions-send-tool.a2a.js", () => ({
    runSessionsSendA2AFlow: vi.fn(),
  }));
  const [{ createSessionsSendTool }, { buildAgentSystemPrompt }] = await Promise.all([
    import("../agents/tools/sessions-send-tool.js"),
    import("../agents/system-prompt.js"),
  ]);
  return { createSessionsSendTool, buildAgentSystemPrompt };
}

describe("grant blind-test proof harness", () => {
  it("reproduces corrected-target drift and proves the runtime blocks the stale frame", async () => {
    await withProofHarnessState(async () => {
      const oldMission = requireTask(
        createTaskRecord({
          runtime: "subagent",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:subagent:grant-old",
          runId: "run-grant-old",
          task: "Work the old drifted mission",
          missionId: "mission-old",
          missionSummary: "Old drifted blind-test frame",
          missionState: "active",
          status: "running",
          deliveryStatus: "pending",
        }),
      );
      const newMission = requireTask(
        createTaskRecord({
          runtime: "subagent",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:subagent:grant-new",
          runId: "run-grant-new",
          task: "Fix the real Grant blind-test hang path",
          status: "running",
          deliveryStatus: "pending",
        }),
      );

      expect(
        activateTaskMissionById({
          taskId: newMission.taskId,
          missionId: "mission-grant-fix",
          missionSummary: "Fix the real Grant blind-test hang path",
          missionUpdatedAt: 5_000,
        }),
      ).toMatchObject({
        abandonedMissionId: "mission-old",
        activatedMissionId: "mission-grant-fix",
      });

      expect(
        resolveMissionBoundFollowupForOwner({
          ownerKey: "agent:main:main",
          text: "continue",
        }),
      ).toEqual({
        status: "bound",
        ownerKey: "agent:main:main",
        missionId: "mission-grant-fix",
        missionSummary: "Fix the real Grant blind-test hang path",
        activeTaskId: newMission.taskId,
        reboundText:
          "Continue the active mission (mission-grant-fix): Fix the real Grant blind-test hang path",
      });

      const staleProgress = recordTaskProgressByRunId({
        runId: "run-grant-old",
        runtime: "subagent",
        progressSummary: "Phase 4 landed and passed tests on the old mission.",
        lastEventAt: 6_000,
      });
      expect(staleProgress).toMatchObject([
        {
          taskId: oldMission.taskId,
          missionState: "abandoned",
          status: "succeeded",
          terminalOutcome: "blocked",
          progressSummary: "Phase 4 landed and passed tests on the old mission.",
          terminalSummary:
            'Progress arrived for abandoned mission "Old drifted blind-test frame" after the target changed. Reactivate it explicitly before continuing.',
        },
      ]);

      expect(getTaskById(oldMission.taskId)).toMatchObject({
        taskId: oldMission.taskId,
        missionState: "abandoned",
        terminalOutcome: "blocked",
      });
    });
  });

  it("reproduces blind-test slice gating, scope-safe reporting, and progress-only block behavior", async () => {
    await withProofHarnessState(async () => {
      const sliceOne = createBlindTestSliceFlow({
        ownerKey: "agent:main:main",
        goal: "Grant blind-test slice 1",
        sliceKey: "grant-slice-1",
        subjectAgent: "grant",
        createdAt: 10,
        updatedAt: 10,
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      });
      if (!sliceOne) {
        throw new Error("expected blind-test slice flow creation to succeed");
      }

      const prematureClose = finishFlow({
        flowId: sliceOne.flowId,
        expectedRevision: sliceOne.revision,
        updatedAt: 20,
      });
      expect(prematureClose).toMatchObject({
        applied: false,
        reason: "guard_blocked",
        blockedSummary: "Blind-test slice cannot close until the implemented slice passes review.",
      });

      const afterDraft = recordBlindTestDraftReview({
        flowId: sliceOne.flowId,
        expectedRevision: sliceOne.revision,
        verdict: "passed",
        summary: "Draft passed",
        reviewedAt: 30,
        updatedAt: 30,
      });
      expect(afterDraft.applied).toBe(true);
      if (!afterDraft.applied) {
        throw new Error("expected draft review to apply");
      }

      const prematureImplementationClose = finishFlow({
        flowId: sliceOne.flowId,
        expectedRevision: afterDraft.flow.revision,
        updatedAt: 40,
      });
      expect(prematureImplementationClose).toMatchObject({
        applied: false,
        reason: "guard_blocked",
      });

      const afterImplementation = recordBlindTestImplementationReview({
        flowId: sliceOne.flowId,
        expectedRevision: afterDraft.flow.revision,
        verdict: "passed",
        summary: "Implementation passed",
        reviewedAt: 50,
        updatedAt: 50,
      });
      expect(afterImplementation.applied).toBe(true);
      if (!afterImplementation.applied) {
        throw new Error("expected implementation review to apply");
      }

      const closed = finishFlow({
        flowId: sliceOne.flowId,
        expectedRevision: afterImplementation.flow.revision,
        updatedAt: 60,
        endedAt: 60,
      });
      expect(closed).toMatchObject({
        applied: false,
        reason: "guard_blocked",
        blockedSummary:
          "Active production run cannot pause or close after a passed bounded unit before the next executable unit launches.",
      });
      if (closed.applied || !closed.current) {
        throw new Error("expected continuation guard to block close");
      }

      const sliceTwo = createNextBlindTestSliceFlow({
        previousFlowId: sliceOne.flowId,
        expectedPreviousRevision: closed.current.revision,
        goal: "Grant blind-test slice 2",
        sliceKey: "grant-slice-2",
        subjectAgent: "grant",
        createdAt: 70,
        updatedAt: 70,
      });
      expect(sliceTwo.created).toBe(true);
      if (!sliceTwo.created) {
        throw new Error("expected next slice creation to succeed");
      }
      expect(getTaskFlowById(sliceTwo.flow.flowId)).toMatchObject({
        currentStep: "draft_review_required",
        status: "running",
      });

      const localSliceTask = requireTask(
        createTaskRecord({
          runtime: "acp",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:acp:grant-slice",
          parentFlowId: sliceOne.flowId,
          parentTaskId: "task-parent-grant",
          missionId: "mission-grant-fix",
          missionSummary: "Fix the real Grant blind-test hang path",
          missionState: "subordinate",
          runId: "run-grant-slice",
          task: "Blind-test local slice",
          status: "succeeded",
          deliveryStatus: "pending",
          terminalSummary: "Slice 1 implementation landed and passed tests.",
        }),
      );

      expect(formatTaskTerminalMessage(localSliceTask)).toBe(
        "Background task local result ready for review: ACP background task (run run-gran). Slice 1 implementation landed and passed tests. Broader build execution is paused pending parent review.",
      );

      expect(
        resolveRequiredCompletionTerminalResult(
          "I'll inspect the repo now. Then I'll run tests and report back.",
        ),
      ).toEqual({
        terminalOutcome: "blocked",
        terminalSummary:
          "Required completion ended with progress-only text, not a final deliverable.",
      });
    });
  });

  it("reproduces the Grant fail-handback receipt and fails closed on running-now truth until later proof exists", async () => {
    await withProofHarnessState(async () => {
      const callGatewayMock = vi.fn();
      const { createSessionsSendTool, buildAgentSystemPrompt } = await loadFollowupProofTools({
        callGatewayMock,
      });

      const slice = createBlindTestSliceFlow({
        ownerKey: "agent:main:main",
        goal: "Grant blind-test slice 2",
        sliceKey: "grant-slice-2",
        subjectAgent: "grant",
        createdAt: 100,
        updatedAt: 100,
      });
      if (!slice) {
        throw new Error("expected blind-test slice flow creation to succeed");
      }

      const failedDraft = recordBlindTestDraftReview({
        flowId: slice.flowId,
        expectedRevision: slice.revision,
        verdict: "failed",
        summary: "Proof/closeout discipline failed. Correct it and retry the same slice.",
        reviewedAt: 110,
        updatedAt: 110,
      });
      expect(failedDraft.applied).toBe(true);
      if (!failedDraft.applied) {
        throw new Error("expected failed draft review to apply");
      }
      expect(failedDraft.flow.status).toBe("blocked");
      expect(failedDraft.flow.currentStep).toBe("draft_rework_required");
      expect(failedDraft.flow.blockedSummary).toBe(
        "Proof/closeout discipline failed. Correct it and retry the same slice.",
      );

      const activeTask = requireTask(
        createTaskRecord({
          runtime: "subagent",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:subagent:grant-slice-2",
          runId: "run-grant-slice-2",
          task: "Grant blind-test slice 2 rework",
          missionId: "mission-grant-slice-2",
          missionSummary: "Correct the same Grant blind-test slice 2 draft",
          missionState: "active",
          status: "running",
          deliveryStatus: "pending",
        }),
      );

      expect(
        resolveMissionBoundFollowupForOwner({
          ownerKey: "agent:main:main",
          text: "continue",
        }),
      ).toEqual({
        status: "bound",
        ownerKey: "agent:main:main",
        missionId: "mission-grant-slice-2",
        missionSummary: "Correct the same Grant blind-test slice 2 draft",
        activeTaskId: activeTask.taskId,
        reboundText:
          "Continue the active mission (mission-grant-slice-2): Correct the same Grant blind-test slice 2 draft",
      });

      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "sessions.list") {
          return {
            path: "/tmp/sessions.json",
            sessions: [{ key: "agent:main:subagent:grant-slice-2", kind: "direct" }],
          };
        }
        if (request.method === "chat.history") {
          throw new Error("history unavailable");
        }
        if (request.method === "agent") {
          return { runId: "run-grant-rework", acceptedAt: 123 };
        }
        return {};
      });

      const tool = createSessionsSendTool({
        agentSessionKey: "agent:main:main",
        agentChannel: "webchat",
      });
      const result = await tool.execute("call-grant-rework-handback", {
        sessionKey: "agent:main:subagent:grant-slice-2",
        message: "What was wrong: proof discipline. Fix it and retry the same slice now.",
        timeoutSeconds: 0,
      });
      const details = result.details as {
        status?: string;
        runningNow?: boolean;
        runningNowAnswer?: string;
        runningNowProofSummary?: string;
        followupExecutionTruth?: {
          runningNow?: boolean;
          liveExecutionState?: string;
          proofSummary?: string;
        };
      };
      expect(details.status).toBe("accepted");
      expect(details.runningNow).toBe(false);
      expect(details.runningNowAnswer).toBe("no");
      expect(details.runningNowProofSummary).toBe(
        "Follow-up was accepted by the target session, but continued execution is not yet proven from this tool result alone.",
      );
      expect(details.followupExecutionTruth).toMatchObject({
        runningNow: false,
        liveExecutionState: "accepted_not_yet_proven_active",
        proofSummary:
          "Follow-up was accepted by the target session, but continued execution is not yet proven from this tool result alone.",
      });

      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames: ["sessions_send", "sessions_list", "session_status"],
      });
      expect(prompt).toContain(
        'When `sessions_send` returns `runningNowAnswer: "no"` or `followupExecutionTruth.runningNow=false`, do not claim the target is actively running now; report `no` unless a later proof surface explicitly flips it to yes.',
      );
    });
  });
});
