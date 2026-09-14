import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRunningTaskRun as createRunningTaskRunOrNull } from "./task-executor.js";
import {
  listTaskFlowAuditFindings,
  type TaskFlowAuditCode,
  type TaskFlowAuditFinding,
} from "./task-flow-registry.audit.js";
import {
  createBlindTestSliceFlow,
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  finishFlow,
  recordFlowLawfulStop,
  recordFlowNextExecutableLaunch,
  recordBlindTestDraftReview,
  recordBlindTestImplementationReview,
  resetTaskFlowRegistryForTests,
  setFlowWaiting,
} from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function createRunningTaskRun(
  params: Parameters<typeof createRunningTaskRunOrNull>[0],
): TaskRecord {
  const task = createRunningTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected running task creation to succeed");
  }
  return task;
}

function requireFinding(
  findings: TaskFlowAuditFinding[],
  code: TaskFlowAuditCode,
  flowId?: string,
): TaskFlowAuditFinding {
  const finding = findings.find(
    (candidate) =>
      candidate.code === code && (flowId === undefined || candidate.flow?.flowId === flowId),
  );
  if (!finding) {
    throw new Error(`Expected ${code} finding${flowId ? ` for ${flowId}` : ""}`);
  }
  return finding;
}

async function withTaskFlowAuditStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-task-flow-audit-",
    },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
      try {
        await run(state.stateDir);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests();
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("task-flow-registry audit", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("surfaces restore failures as task-flow audit findings", () => {
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => {
          throw new Error("boom");
        },
        saveSnapshot: () => {},
      },
    });

    const findings = listTaskFlowAuditFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.code).toBe("restore_failed");
    expect(findings[0]?.detail).toContain("boom");
  });

  it("clears restore-failed findings after a clean reset and restore", () => {
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => {
          throw new Error("boom");
        },
        saveSnapshot: () => {},
      },
    });

    const findings = listTaskFlowAuditFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("restore_failed");

    resetTaskFlowRegistryForTests({ persist: false });
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
      },
    });

    expect(listTaskFlowAuditFindings()).toStrictEqual([]);
  });

  it("detects stuck managed flows and missing blocked tasks", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const running = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Inspect queue",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });

      const blocked = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Wait on child",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });
      setFlowWaiting({
        flowId: blocked.flowId,
        expectedRevision: blocked.revision,
        blockedTaskId: "task-missing",
        blockedSummary: "Need follow-up",
        updatedAt: 1,
      });

      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(requireFinding(findings, "missing_linked_tasks", running.flowId).flow?.flowId).toBe(
        running.flowId,
      );
      expect(requireFinding(findings, "blocked_task_missing", blocked.flowId).flow?.flowId).toBe(
        blocked.flowId,
      );
    });
  });

  it("does not flag managed flows with active linked tasks as missing", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Inspect queue",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });

      createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "task-flow-audit-child",
        task: "Inspect PR 1",
        startedAt: 1,
        lastEventAt: 1,
      });

      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(
        findings.some(
          (finding) =>
            finding.code === "missing_linked_tasks" && finding.flow?.flowId === flow.flowId,
        ),
      ).toBe(false);
    });
  });

  it("does not flag missing linked tasks before the flow is stale", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const now = Date.now();
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Fresh managed flow",
        status: "running",
        createdAt: now - 5 * 60_000,
        updatedAt: now - 5 * 60_000,
      });

      expect(
        listTaskFlowAuditFindings({ now }).find(
          (finding) => finding.code === "missing_linked_tasks",
        ),
      ).toBeUndefined();

      const staleFindings = listTaskFlowAuditFindings({ now: now + 26 * 60_000 });
      expect(requireFinding(staleFindings, "missing_linked_tasks", flow.flowId).flow?.flowId).toBe(
        flow.flowId,
      );
    });
  });

  it("flags stale queued managed flows that never gained executor proof", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Queued without executor proof",
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      });

      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(requireFinding(findings, "stale_queued", flow.flowId).flow?.flowId).toBe(flow.flowId);
      expect(requireFinding(findings, "missing_linked_tasks", flow.flowId).detail).toContain(
        "no executor proof",
      );
    });
  });

  it("reports cancel-stuck before maintenance finalizes the flow", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Cancel work",
        status: "running",
        cancelRequestedAt: 100,
        createdAt: 1,
        updatedAt: 100,
      });

      const findings = listTaskFlowAuditFindings({ now: 6 * 60_000 });
      expect(requireFinding(findings, "cancel_stuck", flow.flowId).flow?.flowId).toBe(flow.flowId);
    });
  });

  it("reports continuation-required flows that have not launched the next executable unit", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createBlindTestSliceFlow({
        ownerKey: "agent:main:main",
        goal: "Grant production blind-test slice 1",
        sliceKey: "prod-slice-1",
        subjectAgent: "Grant",
        createdAt: 1,
        updatedAt: 1,
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      });
      if (!flow) {
        throw new Error("Expected blind-test flow creation");
      }
      const draftPassed = recordBlindTestDraftReview({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        verdict: "passed",
        reviewedAt: 2,
        updatedAt: 2,
      });
      if (!draftPassed.applied) {
        throw new Error("Expected draft pass");
      }
      const implementationPassed = recordBlindTestImplementationReview({
        flowId: flow.flowId,
        expectedRevision: draftPassed.flow.revision,
        verdict: "passed",
        reviewedAt: 3,
        updatedAt: 3,
      });
      if (!implementationPassed.applied) {
        throw new Error("Expected implementation pass");
      }

      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(
        requireFinding(
          findings,
          "continuation_required_not_launched",
          implementationPassed.flow.flowId,
        ).flow?.flowId,
      ).toBe(implementationPassed.flow.flowId);
    });
  });

  it("clears continuation-required findings after the next executable unit launch is recorded", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createBlindTestSliceFlow({
        ownerKey: "agent:main:main",
        goal: "Grant production blind-test slice 1",
        sliceKey: "prod-slice-1",
        subjectAgent: "Grant",
        createdAt: 1,
        updatedAt: 1,
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      });
      if (!flow) {
        throw new Error("Expected blind-test flow creation");
      }
      const draftPassed = recordBlindTestDraftReview({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        verdict: "passed",
        reviewedAt: 2,
        updatedAt: 2,
      });
      if (!draftPassed.applied) {
        throw new Error("Expected draft pass");
      }
      const implementationPassed = recordBlindTestImplementationReview({
        flowId: flow.flowId,
        expectedRevision: draftPassed.flow.revision,
        verdict: "passed",
        reviewedAt: 3,
        updatedAt: 3,
      });
      if (!implementationPassed.applied) {
        throw new Error("Expected implementation pass");
      }
      const launched = recordFlowNextExecutableLaunch({
        flowId: implementationPassed.flow.flowId,
        expectedRevision: implementationPassed.flow.revision,
        detail: "REWORK_EXECUTOR_LAUNCHED: accepted same-slice rework run run-prod-slice-1",
        currentStep: "closeout_rework_running",
        updatedAt: 4,
      });
      expect(launched.applied).toBe(true);

      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(
        findings.some(
          (finding) =>
            finding.code === "continuation_required_not_launched" &&
            finding.flow?.flowId === implementationPassed.flow.flowId,
        ),
      ).toBe(false);
    });
  });

  it("reports generic managed continuation flows that have not launched the next executable unit", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Run managed production controller",
        status: "running",
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      });

      const blockedClose = finishFlow({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        endedAt: 100,
      });
      expect(blockedClose.applied).toBe(false);
      if (blockedClose.applied || !blockedClose.current) {
        throw new Error("Expected blocked managed continuation close");
      }

      const findings = listTaskFlowAuditFindings({ now: 101 });
      expect(
        requireFinding(findings, "continuation_required_not_launched", flow.flowId).detail,
      ).toContain("next executable unit");
    });
  });

  it("does not report managed continuation findings after a lawful blocker is recorded", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Managed controller blocked lawfully",
        status: "running",
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      });

      const lawfulStop = recordFlowLawfulStop({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        reason: "blocker",
        detail: "Approval token missing.",
        updatedAt: 120,
      });
      expect(lawfulStop.applied).toBe(true);

      const findings = listTaskFlowAuditFindings({ now: 121 });
      expect(
        findings.some(
          (finding) =>
            finding.code === "continuation_required_not_launched" &&
            finding.flow?.flowId === flow.flowId,
        ),
      ).toBe(false);
    });
  });
});
