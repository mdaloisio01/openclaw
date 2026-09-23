import { describe, expect, it } from "vitest";
import {
  buildGieHelperHandoffPacket,
  captureGieHelperResult,
  closeGieHelperContinuation,
  createGieHelperWorkOrder,
  dispatchGieHelperWork,
  preventDisconnectedParallelHelperWork,
  validateGieHelperResult,
} from "./helper-coordination-runtime.js";
import {
  createGieStepwiseExecution,
  materializeGieStep,
  selectGieStep,
} from "./stepwise-execution-runtime.js";

const NOW = 1_721_100_000_000;

function baseWorkOrder() {
  return createGieHelperWorkOrder({
    workOrderId: "helper-1",
    issueKey: "issue-123",
    ownerLane: "sadb",
    ownerTarget: "execution-routing",
    helperLane: "verification",
    helperTarget: "phase-seal-verifier",
    taskText: "verify helper result",
    allowedScope: ["read source", "run tests"],
    proofRefs: ["phase-5-receipt"],
    validationRequirements: ["verifier receipt required"],
    requestedBy: "Codex",
    now: NOW,
  });
}

function materializedStep() {
  let step = createGieStepwiseExecution({
    workItemId: "phase-6-parent",
    stepId: "step-1",
    ownerLane: "sadb",
    ownerTarget: "execution-routing",
    proofRefs: ["phase-5-receipt"],
    now: NOW,
  });
  step = selectGieStep(step, { selectedBy: "router", now: NOW + 1 });
  return materializeGieStep(step, { materializedRef: "materialized-parent", now: NOW + 2 });
}

describe("GIE helper coordination runtime", () => {
  it("creates helper work orders only with explicit owner, helper, issue, task, scope, validation, and proof", () => {
    const order = baseWorkOrder();

    expect(order.state).toBe("created");
    expect(order.antiParallelLockKey).toBe("issue-123");
    expect(order.proofRefs).toEqual(["phase-5-receipt"]);
    expect(order.auditLog.at(-1)?.to).toBe("created");
  });

  it("rejects incomplete helper work orders", () => {
    expect(() =>
      createGieHelperWorkOrder({
        workOrderId: "helper-1",
        issueKey: "",
        ownerLane: "sadb",
        ownerTarget: "execution-routing",
        helperLane: "verification",
        helperTarget: "phase-seal-verifier",
        taskText: "verify helper result",
        allowedScope: ["read source"],
        proofRefs: ["phase-5-receipt"],
        validationRequirements: ["receipt required"],
        now: NOW,
      }),
    ).toThrow("gie_helper_work_order_required_fields_missing");
  });

  it("builds a handoff packet from a materialized Phase 5 step", () => {
    const packet = buildGieHelperHandoffPacket({
      parentStep: materializedStep(),
      workOrder: baseWorkOrder(),
      authorityRef: "phase-6-plan",
      handoffRef: "handoff-ref",
      now: NOW + 3,
    });

    expect(packet.workOrderId).toBe("helper-1");
    expect(packet.parentStepState).toBe("materialized");
    expect(packet.proofRefs).toContain("phase-5-receipt");
    expect(packet.handoffAccepted).toBe(true);
  });

  it("refuses helper handoff from illegal parent step states", () => {
    const unresolved = createGieStepwiseExecution({
      workItemId: "phase-6-parent",
      stepId: "step-1",
      ownerLane: "sadb",
      ownerTarget: "execution-routing",
      proofRefs: ["phase-5-receipt"],
      now: NOW,
    });

    expect(() =>
      buildGieHelperHandoffPacket({
        parentStep: unresolved,
        workOrder: baseWorkOrder(),
        authorityRef: "phase-6-plan",
        handoffRef: "handoff-ref",
        now: NOW + 1,
      }),
    ).toThrow("gie_helper_handoff_illegal_parent_state:unresolved");
  });

  it("dispatches helper work through a policy-gated task dispatch callback", () => {
    const packet = buildGieHelperHandoffPacket({
      parentStep: materializedStep(),
      workOrder: baseWorkOrder(),
      authorityRef: "phase-6-plan",
      handoffRef: "handoff-ref",
      now: NOW + 3,
    });
    const dispatched = dispatchGieHelperWork(packet, {
      now: NOW + 4,
      dispatchTask: (workOrder) => ({
        taskId: `task:${workOrder.workOrderId}`,
        flowId: "flow-1",
        dispatchReceiptRef: "dispatch-receipt",
      }),
    });

    expect(dispatched.state).toBe("running");
    expect(dispatched.taskId).toBe("task:helper-1");
    expect(dispatched.policyDecision.triggeredRule).toBe("governed_dispatch_allowed");
    expect(dispatched.auditLog.map((event) => event.to)).toContain("running");
  });

  it("blocks Will/self performance for helper-owned work without explicit approval proof", () => {
    const packet = buildGieHelperHandoffPacket({
      parentStep: materializedStep(),
      workOrder: createGieHelperWorkOrder({
        ...baseWorkOrder(),
        requestedBy: "Will",
        selfPerformanceApprovalRef: null,
      }),
      authorityRef: "phase-6-plan",
      handoffRef: "handoff-ref",
      now: NOW + 3,
    });

    expect(() =>
      dispatchGieHelperWork(packet, {
        now: NOW + 4,
        dispatchTask: () => ({ taskId: "task", flowId: "flow", dispatchReceiptRef: "receipt" }),
      }),
    ).toThrow("gie_helper_self_performance_requires_approval");
  });

  it("captures helper result but blocks closeout until validation proof exists", () => {
    const packet = buildGieHelperHandoffPacket({
      parentStep: materializedStep(),
      workOrder: baseWorkOrder(),
      authorityRef: "phase-6-plan",
      handoffRef: "handoff-ref",
      now: NOW + 3,
    });
    const running = dispatchGieHelperWork(packet, {
      now: NOW + 4,
      dispatchTask: () => ({ taskId: "task", flowId: "flow", dispatchReceiptRef: "receipt" }),
    });
    const captured = captureGieHelperResult(running, {
      terminalOutcome: "succeeded",
      resultRef: "helper-result",
      proofRefs: ["helper-output-proof"],
      now: NOW + 5,
    });

    expect(captured.state).toBe("validation_required");
    expect(() =>
      closeGieHelperContinuation(captured, {
        continuationRef: "continuation",
        nextExecutableUnitLaunched: true,
        now: NOW + 6,
      }),
    ).toThrow("gie_helper_validation_required_before_continuation");
  });

  it("records failed validation as fix required instead of completed", () => {
    const captured = captureGieHelperResult(
      dispatchGieHelperWork(
        buildGieHelperHandoffPacket({
          parentStep: materializedStep(),
          workOrder: baseWorkOrder(),
          authorityRef: "phase-6-plan",
          handoffRef: "handoff-ref",
          now: NOW + 3,
        }),
        { dispatchTask: () => ({ taskId: "task", flowId: "flow", dispatchReceiptRef: "receipt" }) },
      ),
      {
        terminalOutcome: "succeeded",
        resultRef: "helper-result",
        proofRefs: ["proof"],
        now: NOW + 4,
      },
    );
    const validated = validateGieHelperResult(captured, {
      validatorIdentity: "verification",
      validationProofRef: "validator-fail",
      passed: false,
      now: NOW + 5,
    });

    expect(validated.state).toBe("fix_required");
  });

  it("records continuation after validated helper closeout", () => {
    const captured = captureGieHelperResult(
      dispatchGieHelperWork(
        buildGieHelperHandoffPacket({
          parentStep: materializedStep(),
          workOrder: baseWorkOrder(),
          authorityRef: "phase-6-plan",
          handoffRef: "handoff-ref",
          now: NOW + 3,
        }),
        { dispatchTask: () => ({ taskId: "task", flowId: "flow", dispatchReceiptRef: "receipt" }) },
      ),
      {
        terminalOutcome: "succeeded",
        resultRef: "helper-result",
        proofRefs: ["proof"],
        now: NOW + 4,
      },
    );
    const validated = validateGieHelperResult(captured, {
      validatorIdentity: "verification",
      validationProofRef: "validator-pass",
      passed: true,
      now: NOW + 5,
    });
    const continued = closeGieHelperContinuation(validated, {
      continuationRef: "continuation-ref",
      nextExecutableUnitLaunched: true,
      now: NOW + 6,
    });

    expect(continued.state).toBe("continued");
    expect(continued.continuationRef).toBe("continuation-ref");
  });

  it("refuses disconnected parallel helper work on the same issue", () => {
    const active = dispatchGieHelperWork(
      buildGieHelperHandoffPacket({
        parentStep: materializedStep(),
        workOrder: baseWorkOrder(),
        authorityRef: "phase-6-plan",
        handoffRef: "handoff-ref",
        now: NOW + 3,
      }),
      { dispatchTask: () => ({ taskId: "task", flowId: "flow", dispatchReceiptRef: "receipt" }) },
    );
    const duplicate = createGieHelperWorkOrder({
      ...baseWorkOrder(),
      workOrderId: "helper-2",
    });

    expect(() => preventDisconnectedParallelHelperWork([active], duplicate)).toThrow(
      "gie_helper_parallel_work_blocked:issue-123",
    );
  });
});
