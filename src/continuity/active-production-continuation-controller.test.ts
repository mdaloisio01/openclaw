import { describe, expect, it } from "vitest";
import {
  buildActiveProductionContinuationState,
  buildTaskFlowDispatchAction,
  createActiveProductionDispatchReceipt,
  evaluateActiveProductionFinality,
  evaluateActiveProductionRuntimeProbes,
  hasValidContinuationDispatchReceipt,
  isActiveProductionHardBoundary,
  resolveActiveProductionBoundary,
} from "./active-production-continuation-controller.js";

describe("active-production-continuation-controller", () => {
  it("requires dispatch proof when a broader build is open and the next action is known", () => {
    const action = buildTaskFlowDispatchAction({
      actionId: "flow-1:next",
      owner: "SADB",
      summary: "Continue the next executable build slice",
    });
    const state = buildActiveProductionContinuationState({
      activeProductionRun: true,
      broaderBuildOpen: true,
      nextAction: action,
    });

    expect(hasValidContinuationDispatchReceipt(state)).toBe(false);
    expect(
      evaluateActiveProductionFinality({ state, attemptedFinalKind: "task_success" }),
    ).toMatchObject({
      allowed: false,
      result: "continuation_required",
      boundary: "plan_next_step",
    });
  });

  it("allows local finality after a valid continuation dispatch receipt exists", () => {
    const action = buildTaskFlowDispatchAction({
      actionId: "flow-1:next",
      owner: "SADB",
      summary: "Continue the next executable build slice",
      dispatchProofRef: "taskflow:child:next-1",
    });
    const state = buildActiveProductionContinuationState({
      activeProductionRun: true,
      broaderBuildOpen: true,
      nextAction: action,
      dispatchReceipts: [createActiveProductionDispatchReceipt({ action })],
    });

    expect(hasValidContinuationDispatchReceipt(state)).toBe(true);
    expect(
      evaluateActiveProductionFinality({ state, attemptedFinalKind: "task_success" }),
    ).toMatchObject({
      allowed: true,
      result: "complete_allowed",
      boundary: "plan_next_step",
      receipt: expect.objectContaining({ proofRef: "taskflow:child:next-1" }),
    });
  });

  it("allows finality when the broader build is closed", () => {
    const state = buildActiveProductionContinuationState({
      activeProductionRun: true,
      broaderBuildOpen: false,
    });

    expect(
      evaluateActiveProductionFinality({ state, attemptedFinalKind: "final_answer" }),
    ).toMatchObject({
      allowed: true,
      result: "complete_allowed",
      boundary: "complete",
    });
  });

  it("classifies operator decisions as hard boundaries", () => {
    const boundary = resolveActiveProductionBoundary({
      broaderBuildOpen: true,
      operatorProductDecisionRequired: true,
    });

    expect(boundary).toBe("operator_product_decision_required");
    expect(isActiveProductionHardBoundary(boundary)).toBe(true);
  });

  it("classifies destructive actions as hard boundaries", () => {
    const boundary = resolveActiveProductionBoundary({
      broaderBuildOpen: true,
      destructiveActionRequired: true,
    });

    expect(boundary).toBe("unsafe_destructive_action_required");
    expect(isActiveProductionHardBoundary(boundary)).toBe(true);
  });

  it("classifies missing next action as a hard boundary", () => {
    const state = buildActiveProductionContinuationState({
      activeProductionRun: true,
      broaderBuildOpen: true,
    });

    expect(
      evaluateActiveProductionFinality({ state, attemptedFinalKind: "closeout" }),
    ).toMatchObject({
      allowed: false,
      result: "hard_boundary",
      boundary: "next_action_unclear",
    });
  });

  it("classifies technical impossibility as a hard boundary", () => {
    const boundary = resolveActiveProductionBoundary({
      broaderBuildOpen: true,
      technicalImpossibility: true,
    });

    expect(boundary).toBe("technical_impossibility");
    expect(isActiveProductionHardBoundary(boundary)).toBe(true);
  });

  it("requires dispatch for watchdog recovery when it is executable", () => {
    const action = buildTaskFlowDispatchAction({
      actionId: "watchdog:repair:1",
      owner: "Will",
      summary: "Route watchdog NEEDS_REVIEW recovery",
      boundary: "watchdog_recovery",
      surface: "watchdog_recovery",
    });
    const state = buildActiveProductionContinuationState({
      activeProductionRun: true,
      broaderBuildOpen: true,
      nextAction: action,
    });

    expect(
      evaluateActiveProductionFinality({ state, attemptedFinalKind: "watchdog_reconciliation" }),
    ).toMatchObject({
      allowed: false,
      result: "continuation_required",
      boundary: "watchdog_recovery",
    });
  });

  it("classifies runtime probes as restart recovery continuation evidence", () => {
    expect(
      evaluateActiveProductionRuntimeProbes({
        capturedAt: 1,
        activeToolAgeMs: 34_000,
        pendingReplyCount: 1,
        restartRecoveryFailureCount: 3,
        eventLoopUtilization: 1,
        eventLoopDelayP99Ms: 8_002,
        eventLoopDelayMaxMs: 9_100,
        activeEmbeddedRunCount: 1,
      }),
    ).toEqual({
      boundary: "runtime_restart_recovery",
      continuationRequired: true,
      reasons: [
        "active_tool_age_ms=34000",
        "pending_reply_count=1",
        "restart_recovery_failure_count=3",
        "event_loop_utilization=1",
        "event_loop_delay_p99_ms=8002",
        "event_loop_delay_max_ms=9100",
        "active_embedded_run_count=1",
      ],
    });
  });

  it("keeps empty runtime probes neutral", () => {
    expect(evaluateActiveProductionRuntimeProbes({ capturedAt: 1 })).toEqual({
      boundary: "none",
      continuationRequired: false,
      reasons: [],
    });
  });
});
