import { describe, expect, it } from "vitest";
import type { FinishedSession, ProcessSession } from "../agents/bash-process-registry.js";
import type { RunExit, RunRecord } from "../process/supervisor/types.js";
import {
  buildGovernedSupervisorReceipt,
  evaluateGovernedSupervisorRequirement,
  type GovernedSupervisorIdentity,
} from "./governed-supervisor-receipt.js";

const identity: GovernedSupervisorIdentity = {
  missionId: "mission-supervisor",
  contractId: "contract-1",
  contractVersion: "v1",
  contractHash: "contract-sha",
  authorityHash: "authority-sha",
  policyVersion: "policy-v1",
};

const runningSession: ProcessSession = {
  id: "sess-running",
  command: "npm test",
  startedAt: 100,
  cwd: "/repo",
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

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    sessionId: "sess-running",
    backendId: "exec",
    pid: 4242,
    processGroupId: 4242,
    state: "running",
    startedAtMs: 100,
    lastOutputAtMs: 100,
    createdAtMs: 100,
    updatedAtMs: 100,
    ...overrides,
  };
}

function exit(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 50,
    stdout: "done",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

describe("governed supervisor receipts", () => {
  it("builds running receipts with pid/session/run identity and evidence refs", () => {
    const receipt = buildGovernedSupervisorReceipt({
      identity,
      producer: "exec-supervisor",
      session: runningSession,
      runRecord: runRecord(),
      taskId: "task-1",
      flowId: "flow-1",
      timeoutMs: 30_000,
      evidenceRefs: ["evidence-1"],
      producedAt: "2026-08-23T06:40:00Z",
    });

    expect(receipt).toMatchObject({
      schema: "openclaw.governed_supervisor_receipt.v1",
      receiptKind: "supervisor",
      missionId: "mission-supervisor",
      sessionId: "sess-running",
      runId: "run-1",
      taskId: "task-1",
      flowId: "flow-1",
      pid: 4242,
      processGroupId: 4242,
      supervisorState: "running",
      state: "running",
      terminalResult: "running",
      timedOut: false,
      evidenceRefs: ["evidence-1"],
    });
    expect(receipt.receiptId).toMatch(/^supervisor:[a-f0-9]{32}$/);
  });

  it("maps timeout exits to structured timeout failure state", () => {
    const receipt = buildGovernedSupervisorReceipt({
      identity,
      producer: "exec-supervisor",
      session: runningSession,
      runRecord: runRecord({
        state: "exited",
        terminationReason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGTERM",
      }),
      exit: exit({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGTERM",
        timedOut: true,
        noOutputTimedOut: true,
        stderr: "idle",
      }),
      noOutputTimeoutMs: 10_000,
      producedAt: "2026-08-23T06:41:00Z",
    });

    expect(receipt.supervisorState).toBe("timeout");
    expect(receipt.failureState).toBe("TIMED_OUT");
    expect(receipt.terminalResult).toBe("blocked");
    expect(receipt.timedOut).toBe(true);
    expect(receipt.noOutputTimedOut).toBe(true);
    expect(receipt.stderrSummary).toBe("idle");
  });

  it("maps completed finished sessions to healthy supervisor receipts", () => {
    const finished: FinishedSession = {
      id: "sess-finished",
      command: "npm test",
      startedAt: 100,
      endedAt: 175,
      status: "completed",
      exitCode: 0,
      exitSignal: null,
      aggregated: "all good",
      tail: "all good",
      truncated: false,
      totalOutputChars: 8,
    };

    const receipt = buildGovernedSupervisorReceipt({
      identity,
      producer: "exec-supervisor",
      session: finished,
      runRecord: runRecord({ runId: "run-finished", state: "exited", exitCode: 0 }),
      producedAt: "2026-08-23T06:42:00Z",
    });

    expect(receipt.supervisorState).toBe("completed");
    expect(receipt.state).toBe("healthy");
    expect(receipt.terminalResult).toBe("succeeded");
    expect(receipt.durationMs).toBe(75);
    expect(receipt.failureState).toBeUndefined();
  });

  it("blocks governed long-running work when required supervisor proof is missing", () => {
    expect(
      evaluateGovernedSupervisorRequirement({
        wrapperRequired: true,
        wrapperPresent: false,
        supervisorAvailable: true,
      }),
    ).toMatchObject({
      decision: "BLOCK",
      reasonCode: "SUPERVISOR_UNAVAILABLE",
      failureState: "FAILED_SUPERVISOR",
    });

    expect(
      evaluateGovernedSupervisorRequirement({
        wrapperRequired: true,
        wrapperPresent: true,
        supervisorAvailable: true,
      }),
    ).toMatchObject({
      decision: "BLOCK",
      reasonCode: "SUPERVISOR_RECEIPT_MISSING",
      failureState: "FAILED_SUPERVISOR",
    });
  });

  it("blocks timeout receipts and allows healthy receipts", () => {
    const timeoutReceipt = buildGovernedSupervisorReceipt({
      identity,
      producer: "exec-supervisor",
      session: runningSession,
      runRecord: runRecord({ state: "exited", terminationReason: "overall-timeout" }),
      exit: exit({ reason: "overall-timeout", timedOut: true }),
      producedAt: "2026-08-23T06:43:00Z",
    });
    const healthyReceipt = buildGovernedSupervisorReceipt({
      identity,
      producer: "exec-supervisor",
      session: runningSession,
      runRecord: runRecord(),
      producedAt: "2026-08-23T06:44:00Z",
    });

    expect(
      evaluateGovernedSupervisorRequirement({
        wrapperRequired: true,
        wrapperPresent: true,
        supervisorAvailable: true,
        receipt: timeoutReceipt,
      }),
    ).toMatchObject({
      decision: "BLOCK",
      reasonCode: "SUPERVISOR_TIMEOUT",
      failureState: "TIMED_OUT",
    });
    expect(
      evaluateGovernedSupervisorRequirement({
        wrapperRequired: true,
        wrapperPresent: true,
        supervisorAvailable: true,
        receipt: healthyReceipt,
      }),
    ).toMatchObject({
      decision: "ALLOW",
      reasonCode: "SUPERVISOR_HEALTHY",
      obligations: ["write_supervisor_receipt"],
    });
  });
});
