import { beforeEach, describe, expect, it, vi } from "vitest";

const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const assertParentYieldWaitAllowsRestartMock = vi.fn();

vi.mock("../agents/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/subagent-registry-read.js")>(
    "../agents/subagent-registry-read.js",
  );
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
  };
});

vi.mock("./session-subagent-reactivation.runtime.js", () => ({
  assertParentYieldWaitAllowsRestart: (...args: unknown[]) =>
    assertParentYieldWaitAllowsRestartMock(...args),
  replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
}));

import { reactivateCompletedSubagentSession } from "./session-subagent-reactivation.js";

describe("reactivateCompletedSubagentSession", () => {
  beforeEach(() => {
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    assertParentYieldWaitAllowsRestartMock.mockReset().mockResolvedValue(undefined);
  });

  it("reactivates the newest ended row even when stale active rows still exist for the same child session", async () => {
    const childSessionKey = "agent:main:subagent:followup-race";
    const latestEndedRun = {
      runId: "run-current-ended",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current ended task",
      cleanup: "keep" as const,
      createdAt: 20,
      startedAt: 21,
      endedAt: 22,
      outcome: { status: "ok" as const },
    };

    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(latestEndedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-next",
      }),
    ).resolves.toBe(true);

    expect(getLatestSubagentRunByChildSessionKeyMock).toHaveBeenCalledWith(childSessionKey);
    expect(assertParentYieldWaitAllowsRestartMock).not.toHaveBeenCalled();
    expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
      previousRunId: "run-current-ended",
      nextRunId: "run-next",
      fallback: latestEndedRun,
      runTimeoutSeconds: 0,
    });
  });

  it.each(["pending-closeout", "failed-remap"])(
    "rejects required-wait reactivation before Gateway model execution on %s",
    async (failure) => {
      getLatestSubagentRunByChildSessionKeyMock.mockReturnValue({
        runId: "original-child",
        endedAt: 20,
        parentYieldWait: { requiredCloseout: true },
      });
      if (failure === "pending-closeout") {
        assertParentYieldWaitAllowsRestartMock.mockRejectedValueOnce(
          new Error("Parent closeout is pending"),
        );
      } else {
        replaceSubagentRunAfterSteerMock.mockResolvedValue(false);
      }
      await expect(
        reactivateCompletedSubagentSession({
          sessionKey: "agent:main:subagent:child",
          runId: "next",
        }),
      ).rejects.toThrow(
        failure === "pending-closeout" ? "Parent closeout is pending" : "required parent wait",
      );
      expect(assertParentYieldWaitAllowsRestartMock).toHaveBeenCalledWith("original-child");
      if (failure === "pending-closeout") {
        expect(replaceSubagentRunAfterSteerMock).not.toHaveBeenCalled();
      }
    },
  );
});
