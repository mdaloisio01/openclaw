import { describe, expect, it } from "vitest";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import {
  dispatchGieSoftExecution,
  getGieRuntimePlatformMap,
  readGieSubstrateTruth,
} from "./runtime-platform.js";

describe("GIE runtime platform contract", () => {
  it("maps every Phase 2 substrate surface to an existing task substrate interface", () => {
    const map = getGieRuntimePlatformMap();

    expect(map.boundary).toBe("phase2_soft_execution_under_phase1_policy");
    expect(map.surfaces).toEqual([
      "task-flow-registry",
      "task-executor",
      "task-registry",
      "dispatch",
      "receipts",
      "work-orders",
      "lane-outcomes",
      "proof",
    ]);
    expect(map.stableInterfaces.childDispatch).toBe("runTaskInFlow");
    expect(map.stableInterfaces.dispatchGate).toBe("evaluatePolicyDecision");
  });

  it("reads TaskFlow, work-order, lane-outcome, receipt, and proof truth through reused substrate", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    const flow = createManagedTaskFlow({
      ownerKey: "sadb",
      goal: "GIE substrate proof",
      controllerId: "gie-runtime-platform-test",
      status: "running",
    });
    if (!flow) {
      throw new Error("expected managed flow");
    }

    const truth = readGieSubstrateTruth({
      flowId: flow.flowId,
      proofRefs: ["phase-2-proof"],
    });

    expect(truth.flowFound).toBe(true);
    expect(truth.taskCount).toBe(0);
    expect(truth.surfaces).toContain("task-flow-registry");
    expect(truth.proofRefs).toEqual(["phase-2-proof"]);
  });

  it("keeps soft execution inside Phase 1 hard-rule boundaries", () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });

    const blocked = dispatchGieSoftExecution({
      flowId: "missing-flow",
      runtime: "subagent",
      task: "run without proof",
      ownerLane: "sadb",
      ownerTarget: "sadb-head",
      proofRefs: [],
    });

    expect(blocked.dispatched).toBe(false);
    expect(blocked.policyDecision.allowed).toBe(false);
    expect(blocked.policyDecision.decision).toBe("hard_stop");
    expect(blocked.policyDecision.triggeredRule).toBe("proof_refs_required");
  });
});
