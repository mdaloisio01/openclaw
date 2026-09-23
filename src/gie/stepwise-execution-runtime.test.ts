import { describe, expect, it } from "vitest";
import {
  GIE_STEP_STATES,
  createGieStepwiseExecution,
  dispatchGieStep,
  failGieStep,
  fixGieStep,
  hardStopGieStep,
  materializeGieStep,
  reconcileGieStep,
  materializeGieProductionItem,
  selectGieStep,
  submitGieStepForVerification,
  verifyGieStep,
} from "./stepwise-execution-runtime.js";

const NOW = 1_721_000_000_000;

function baseExecution() {
  return createGieStepwiseExecution({
    workItemId: "gie-phase5-work",
    stepId: "step-1",
    ownerLane: "sadb",
    ownerTarget: "execution-routing",
    proofRefs: ["phase-4-receipt"],
    now: NOW,
  });
}

describe("GIE stepwise execution runtime", () => {
  it("defines the required Phase 5 state model in order", () => {
    expect(GIE_STEP_STATES).toEqual([
      "unresolved",
      "selected",
      "materialized",
      "dispatched",
      "running",
      "verification_pending",
      "verified",
      "fix_required",
      "fixed",
      "completed",
      "failed",
      "reconciled",
      "hard_stopped",
    ]);
  });

  it("moves one lawful step at a time through successful completion", () => {
    let execution = baseExecution();
    execution = selectGieStep(execution, { selectedBy: "router", now: NOW + 1 });
    execution = materializeGieStep(execution, {
      materializedRef: "materialized-work-ref",
      now: NOW + 2,
    });
    execution = dispatchGieStep(execution, {
      dispatchRef: "dispatch-ref",
      now: NOW + 3,
    });
    execution = submitGieStepForVerification(execution, {
      runReceiptRef: "run-receipt",
      now: NOW + 4,
    });
    execution = verifyGieStep(execution, {
      verifierReceiptRef: "verifier-pass",
      passed: true,
      now: NOW + 5,
    });

    expect(execution.state).toBe("completed");
    expect(execution.auditLog.map((event) => event.to)).toEqual([
      "unresolved",
      "selected",
      "materialized",
      "dispatched",
      "running",
      "verification_pending",
      "verified",
      "completed",
    ]);
  });

  it("blocks illegal leaps instead of allowing whole-build execution in one jump", () => {
    const execution = baseExecution();

    expect(() =>
      dispatchGieStep(execution, {
        dispatchRef: "dispatch-ref",
        now: NOW + 1,
      }),
    ).toThrow("illegal_gie_step_transition:unresolved->dispatched");
  });

  it("requires owner and proof refs before materializing execution", () => {
    const execution = createGieStepwiseExecution({
      workItemId: "gie-phase5-work",
      stepId: "step-1",
      ownerLane: "sadb",
      ownerTarget: "",
      proofRefs: [],
      now: NOW,
    });

    expect(() => selectGieStep(execution, { selectedBy: "router", now: NOW + 1 })).toThrow(
      "gie_step_owner_and_proof_required",
    );
  });

  it("routes verification failure through fix_required then fixed before completion", () => {
    let execution = baseExecution();
    execution = selectGieStep(execution, { selectedBy: "router", now: NOW + 1 });
    execution = materializeGieStep(execution, { materializedRef: "materialized", now: NOW + 2 });
    execution = dispatchGieStep(execution, { dispatchRef: "dispatch", now: NOW + 3 });
    execution = submitGieStepForVerification(execution, { runReceiptRef: "run", now: NOW + 4 });
    execution = verifyGieStep(execution, {
      verifierReceiptRef: "verifier-fix",
      passed: false,
      now: NOW + 5,
    });
    execution = fixGieStep(execution, {
      fixRef: "fix-ref",
      now: NOW + 6,
    });
    execution = submitGieStepForVerification(execution, {
      runReceiptRef: "rerun",
      now: NOW + 7,
    });
    execution = verifyGieStep(execution, {
      verifierReceiptRef: "verifier-pass",
      passed: true,
      now: NOW + 8,
    });

    expect(execution.state).toBe("completed");
    expect(execution.auditLog.map((event) => event.to)).toContain("fix_required");
    expect(execution.auditLog.map((event) => event.to)).toContain("fixed");
  });

  it("can reconcile a failed or completed step without reopening the whole build", () => {
    let execution = baseExecution();
    execution = selectGieStep(execution, { selectedBy: "router", now: NOW + 1 });
    execution = failGieStep(execution, { failureRef: "failure-ref", now: NOW + 2 });
    execution = reconcileGieStep(execution, {
      reconciliationRef: "phase-4-resolution",
      now: NOW + 3,
    });

    expect(execution.state).toBe("reconciled");
    expect(execution.currentStepOnly).toBe(true);
  });

  it("hard-stops from any nonterminal state and records the stop reason", () => {
    let execution = baseExecution();
    execution = selectGieStep(execution, { selectedBy: "router", now: NOW + 1 });
    execution = hardStopGieStep(execution, {
      hardStopRef: "policy-hard-stop",
      reason: "missing_authority",
      now: NOW + 2,
    });

    expect(execution.state).toBe("hard_stopped");
    expect(execution.hardStopReason).toBe("missing_authority");
    expect(execution.auditLog.at(-1)?.proofRefs).toContain("policy-hard-stop");
  });

  it("maps representative production items into the Phase 5 state model", () => {
    const taskFlowStep = materializeGieProductionItem({
      itemId: "flow-1",
      itemKind: "taskflow",
      ownerLane: "sadb",
      ownerTarget: "execution-routing",
      proofRefs: ["flow-proof"],
      materializedRef: "taskflow-materialized",
      now: NOW,
    });
    const taskStep = materializeGieProductionItem({
      itemId: "task-1",
      itemKind: "task",
      ownerLane: "verification",
      ownerTarget: "phase-seal-verifier",
      proofRefs: ["task-proof"],
      materializedRef: "task-materialized",
      now: NOW + 1,
    });
    const receiptStep = materializeGieProductionItem({
      itemId: "receipt-1",
      itemKind: "receipt",
      ownerLane: "governance",
      ownerTarget: "truth-review",
      proofRefs: ["receipt-proof"],
      materializedRef: "receipt-materialized",
      now: NOW + 2,
    });

    expect([taskFlowStep.state, taskStep.state, receiptStep.state]).toEqual([
      "materialized",
      "materialized",
      "materialized",
    ]);
    expect(taskFlowStep.auditLog.map((event) => event.to)).toEqual([
      "unresolved",
      "selected",
      "materialized",
    ]);
  });
});
