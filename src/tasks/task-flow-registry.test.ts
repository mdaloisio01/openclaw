import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMissionSettlementTail } from "../agents/mission-settlement-tail.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  BLIND_TEST_SLICE_CONTROLLER_ID,
  attachMissionSettlementToTaskFlowStateJson,
  createBlindTestSliceFlow as createBlindTestSliceFlowOrNull,
  createNextBlindTestSliceFlow,
  createFlowRecord as createFlowRecordOrNull,
  createTaskFlowForTask as createTaskFlowForTaskOrNull,
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  deleteTaskFlowRecordById,
  failFlow,
  finishFlow,
  getTaskFlowById,
  getTaskFlowActiveProductionContinuation,
  getTaskFlowMissionSettlement,
  getTaskFlowProductionContinuation,
  listTaskFlowRecords,
  recordFlowLawfulStop,
  recordFlowNextExecutableLaunch,
  recordBlindTestCloseoutFailure,
  recordBlindTestDraftReview,
  recordBlindTestImplementationReview,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
  resumeFlow,
  setFlowWaiting,
  syncFlowFromTask,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

function createFlowRecord(params: Parameters<typeof createFlowRecordOrNull>[0]): TaskFlowRecord {
  const flow = createFlowRecordOrNull(params);
  if (!flow) {
    throw new Error("expected TaskFlow creation to succeed");
  }
  return flow;
}

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function createBlindTestSliceFlow(
  params: Parameters<typeof createBlindTestSliceFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createBlindTestSliceFlowOrNull(params);
  if (!flow) {
    throw new Error("expected blind-test TaskFlow creation to succeed");
  }
  return flow;
}

function createTaskFlowForTask(
  params: Parameters<typeof createTaskFlowForTaskOrNull>[0],
): TaskFlowRecord {
  const flow = createTaskFlowForTaskOrNull(params);
  if (!flow) {
    throw new Error("expected task-mirrored TaskFlow creation to succeed");
  }
  return flow;
}

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-flow-registry-" },
    async (state) => {
      resetTaskFlowRegistryForTests();
      try {
        return await run(state.stateDir);
      } finally {
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("task-flow-registry", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTaskFlowRegistryForTests();
  });

  it("creates managed flows and updates them through revision-checked helpers", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Investigate flaky test",
        currentStep: "spawn_task",
        stateJson: { phase: "spawn" },
      });

      expect(created.flowId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(created.syncMode).toBe("managed");
      expect(created.controllerId).toBe("tests/managed-controller");
      expect(created.revision).toBe(0);
      expect(created.status).toBe("queued");
      expect(created.currentStep).toBe("spawn_task");
      expect(created.stateJson).toEqual({ phase: "spawn" });

      const waiting = setFlowWaiting({
        flowId: created.flowId,
        expectedRevision: created.revision,
        currentStep: "await_review",
        stateJson: { phase: "await_review" },
        waitJson: { kind: "task", taskId: "task-123" },
      });
      expect(waiting.applied).toBe(true);
      if (!waiting.applied) {
        throw new Error("Expected wait state update to apply");
      }
      expect(waiting.flow.flowId).toBe(created.flowId);
      expect(waiting.flow.revision).toBe(1);
      expect(waiting.flow.status).toBe("waiting");
      expect(waiting.flow.currentStep).toBe("await_review");
      expect(waiting.flow.waitJson).toEqual({ kind: "task", taskId: "task-123" });

      const conflict = updateFlowRecordByIdExpectedRevision({
        flowId: created.flowId,
        expectedRevision: 0,
        patch: {
          currentStep: "stale",
        },
      });
      expect(conflict.applied).toBe(false);
      if (conflict.applied) {
        throw new Error("Expected stale revision update to conflict");
      }
      expect(conflict.reason).toBe("revision_conflict");
      expect(conflict.current?.flowId).toBe(created.flowId);
      expect(conflict.current?.revision).toBe(1);

      const resumed = resumeFlow({
        flowId: created.flowId,
        expectedRevision: 1,
        status: "running",
        currentStep: "resume_work",
      });
      expect(resumed.applied).toBe(true);
      if (!resumed.applied) {
        throw new Error("Expected resume update to apply");
      }
      expect(resumed.flow.flowId).toBe(created.flowId);
      expect(resumed.flow.revision).toBe(2);
      expect(resumed.flow.status).toBe("running");
      expect(resumed.flow.currentStep).toBe("resume_work");
      expect(resumed.flow.waitJson).toBeNull();

      const cancelRequested = requestFlowCancel({
        flowId: created.flowId,
        expectedRevision: 2,
        cancelRequestedAt: 400,
      });
      expect(cancelRequested.applied).toBe(true);
      if (!cancelRequested.applied) {
        throw new Error("Expected cancel request update to apply");
      }
      expect(cancelRequested.flow.flowId).toBe(created.flowId);
      expect(cancelRequested.flow.revision).toBe(3);
      expect(cancelRequested.flow.cancelRequestedAt).toBe(400);

      const failed = failFlow({
        flowId: created.flowId,
        expectedRevision: 3,
        blockedSummary: "Task runner failed.",
        endedAt: 500,
      });
      expect(failed.applied).toBe(true);
      if (!failed.applied) {
        throw new Error("Expected fail update to apply");
      }
      expect(failed.flow.flowId).toBe(created.flowId);
      expect(failed.flow.revision).toBe(4);
      expect(failed.flow.status).toBe("failed");
      expect(failed.flow.blockedSummary).toBe("Task runner failed.");
      expect(failed.flow.endedAt).toBe(500);

      const flows = listTaskFlowRecords();
      expect(flows).toHaveLength(1);
      expect(flows[0]?.flowId).toBe(created.flowId);
      expect(flows[0]?.revision).toBe(4);
      expect(flows[0]?.cancelRequestedAt).toBe(400);

      expect(deleteTaskFlowRecordById(created.flowId)).toBe(true);
      expect(getTaskFlowById(created.flowId)).toBeUndefined();
    });
  });

  it("requires a controller for managed flows and rejects clearing it later", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      expect(() =>
        createFlowRecord({
          ownerKey: "agent:main:main",
          goal: "Missing controller",
        }),
      ).toThrow("Managed flow controllerId is required.");

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Protected controller",
      });

      expect(() =>
        updateFlowRecordByIdExpectedRevision({
          flowId: created.flowId,
          expectedRevision: created.revision,
          patch: {
            controllerId: null,
          },
        }),
      ).toThrow("Managed flow controllerId is required.");
    });
  });

  it("emits restored, upserted, and deleted flow observer events", () => {
    const onEvent = vi.fn();
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
      },
      observers: {
        onEvent,
      },
    });

    const created = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/observers",
      goal: "Observe observers",
    });

    deleteTaskFlowRecordById(created.flowId);

    expect(onEvent).toHaveBeenCalledWith({
      kind: "restored",
      flows: [],
    });
    const events = onEvent.mock.calls.map((call) => call[0]);
    expect(events[1]?.kind).toBe("upserted");
    expect(events[1]?.flow?.flowId).toBe(created.flowId);
    expect(events[2]?.kind).toBe("deleted");
    expect(events[2]?.flowId).toBe(created.flowId);
  });

  it("does not throw or register memory when flow create persistence fails", () => {
    const upsertFlow = vi.fn((_flow: TaskFlowRecord) => {
      throw new Error("SQLITE_FULL: database or disk is full");
    });
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
        upsertFlow,
      },
    });

    const created = createManagedTaskFlowOrNull({
      ownerKey: "agent:main:main",
      controllerId: "tests/create-persist-fail",
      goal: "Create while persistence fails",
    });

    expect(created).toBeNull();
    const attempted = upsertFlow.mock.calls[0]?.[0];
    expect(attempted?.flowId).toEqual(expect.any(String));
    expect(getTaskFlowById(attempted?.flowId ?? "")).toBeUndefined();
  });

  it("does not throw or mutate memory when flow update persistence fails", () => {
    let failUpsert = false;
    const upsertFlow = vi.fn(() => {
      if (failUpsert) {
        throw new Error("SQLITE_IOERR: disk I/O error");
      }
    });
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
        upsertFlow,
      },
    });
    const created = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/update-persist-fail",
      goal: "Update while persistence fails",
    });

    failUpsert = true;
    const result = setFlowWaiting({
      flowId: created.flowId,
      expectedRevision: created.revision,
      currentStep: "persist failed",
    });

    expect(result).toMatchObject({
      applied: false,
      reason: "persist_failed",
      current: {
        flowId: created.flowId,
        revision: 0,
        status: "queued",
      },
    });
    expect(getTaskFlowById(created.flowId)).toMatchObject({
      revision: 0,
      status: "queued",
    });
  });

  it("does not throw or delete memory when flow delete persistence fails", () => {
    const deleteFlow = vi.fn(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
        upsertFlow: () => {},
        deleteFlow,
      },
    });
    const created = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/delete-persist-fail",
      goal: "Delete while persistence fails",
    });

    expect(deleteTaskFlowRecordById(created.flowId)).toBe(false);

    expect(deleteFlow).toHaveBeenCalledWith(created.flowId);
    expect(getTaskFlowById(created.flowId)?.flowId).toBe(created.flowId);
  });

  it("refuses generic deletion of restored governed tombstones", () => {
    const deleteFlow = vi.fn();
    const governed: TaskFlowRecord = {
      flowId: "governed-tombstone",
      syncMode: "managed",
      ownerKey: "agent:main:governed-tombstone",
      controllerId: "tests/governed-tombstone",
      revision: 4,
      status: "succeeded",
      notifyPolicy: "done_only",
      goal: "Retain the governed owner claim",
      stateJson: {
        governedMissionState: {
          schema: "openclaw.governed_mission_state.v2",
          missionId: "governed-tombstone-mission",
        },
      },
      createdAt: 1,
      updatedAt: 2,
      endedAt: 2,
    };
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({ flows: new Map([[governed.flowId, governed]]) }),
        saveSnapshot: () => {},
        deleteFlow,
      },
    });

    expect(getTaskFlowById(governed.flowId)).toEqual(governed);
    expect(deleteTaskFlowRecordById(governed.flowId)).toBe(false);
    expect(deleteFlow).not.toHaveBeenCalled();
    expect(getTaskFlowById(governed.flowId)).toEqual(governed);
  });

  it("normalizes restored managed flows without a controller id", () => {
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map([
            [
              "legacy-managed",
              {
                flowId: "legacy-managed",
                syncMode: "managed",
                ownerKey: "agent:main:main",
                revision: 0,
                status: "queued",
                notifyPolicy: "done_only",
                goal: "Legacy managed flow",
                createdAt: 10,
                updatedAt: 10,
              },
            ],
          ]),
        }),
        saveSnapshot: () => {},
      },
    });

    const restored = getTaskFlowById("legacy-managed");
    expect(restored?.flowId).toBe("legacy-managed");
    expect(restored?.syncMode).toBe("managed");
    expect(restored?.controllerId).toBe("core/legacy-restored");
  });

  it("mirrors one-task flow state from tasks and leaves managed flows alone", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const mirrored = createTaskFlowForTask({
        task: {
          ownerKey: "agent:main:main",
          taskId: "task-running",
          notifyPolicy: "done_only",
          status: "running",
          label: "Fix permissions",
          task: "Fix permissions",
          createdAt: 100,
          lastEventAt: 100,
        },
      });

      const blocked = syncFlowFromTask({
        taskId: "task-blocked",
        parentFlowId: mirrored.flowId,
        status: "succeeded",
        terminalOutcome: "blocked",
        notifyPolicy: "done_only",
        label: "Fix permissions",
        task: "Fix permissions",
        lastEventAt: 200,
        endedAt: 200,
        terminalSummary: "Writable session required.",
      });
      if (!blocked) {
        throw new Error("Expected blocked mirrored flow update");
      }
      expect(blocked.flowId).toBe(mirrored.flowId);
      expect(blocked.syncMode).toBe("task_mirrored");
      expect(blocked.status).toBe("blocked");
      expect(blocked.blockedTaskId).toBe("task-blocked");
      expect(blocked.blockedSummary).toBe("Writable session required.");
      expect(blocked.endedAt).toBe(200);
      expect(blocked.updatedAt).toBe(200);

      const delivered = syncFlowFromTask({
        taskId: "task-blocked",
        parentFlowId: mirrored.flowId,
        status: "succeeded",
        terminalOutcome: "blocked",
        notifyPolicy: "done_only",
        label: "Fix permissions",
        task: "Fix permissions",
        lastEventAt: 250,
        endedAt: 200,
        terminalSummary: "Writable session required.",
      });
      if (!delivered) {
        throw new Error("Expected repeated mirrored flow update");
      }
      expect(delivered.flowId).toBe(mirrored.flowId);
      expect(delivered.status).toBe("blocked");
      expect(delivered.endedAt).toBe(200);
      expect(delivered.updatedAt).toBe(200);

      const deliveryDebtSuccess = syncFlowFromTask({
        taskId: "task-delivery-debt",
        parentFlowId: mirrored.flowId,
        status: "succeeded",
        terminalOutcome: "succeeded",
        notifyPolicy: "done_only",
        label: "Fix permissions",
        task: "Fix permissions",
        lastEventAt: 275,
        endedAt: 275,
        terminalSummary:
          "Required completion delivery failed before reaching the requester: requester wake failed.",
      });
      if (!deliveryDebtSuccess) {
        throw new Error("Expected delivery-debt mirrored flow update");
      }
      expect(deliveryDebtSuccess.flowId).toBe(mirrored.flowId);
      expect(deliveryDebtSuccess.status).toBe("succeeded");
      expect(deliveryDebtSuccess.blockedTaskId ?? null).toBeNull();
      expect(deliveryDebtSuccess.blockedSummary ?? null).toBeNull();
      expect(deliveryDebtSuccess.endedAt).toBe(275);
      expect(deliveryDebtSuccess.updatedAt).toBe(275);

      const terminalCreated = createTaskFlowForTask({
        task: {
          ownerKey: "agent:main:main",
          taskId: "task-failed",
          notifyPolicy: "done_only",
          status: "failed",
          label: "Fail permissions",
          task: "Fail permissions",
          createdAt: 100,
          lastEventAt: 300,
          endedAt: 200,
        },
      });
      expect(terminalCreated.status).toBe("failed");
      expect(terminalCreated.endedAt).toBe(200);
      expect(terminalCreated.updatedAt).toBe(200);

      const managed = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed",
        goal: "Cluster PRs",
        currentStep: "wait_for",
        status: "waiting",
        waitJson: { kind: "external_event" },
      });
      const syncedManaged = syncFlowFromTask({
        taskId: "task-child",
        parentFlowId: managed.flowId,
        status: "running",
        notifyPolicy: "done_only",
        label: "Child task",
        task: "Child task",
        lastEventAt: 250,
        progressSummary: "Running child task",
      });
      if (!syncedManaged) {
        throw new Error("Expected managed flow sync result");
      }
      expect(syncedManaged.flowId).toBe(managed.flowId);
      expect(syncedManaged.syncMode).toBe("managed");
      expect(syncedManaged.status).toBe("waiting");
      expect(syncedManaged.currentStep).toBe("wait_for");
      expect(syncedManaged.waitJson).toEqual({ kind: "external_event" });
    });
  });

  it("preserves explicit json null in state and wait payloads", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/null-state",
        goal: "Null payloads",
        stateJson: null,
        waitJson: null,
      });

      expect(created.flowId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(created.stateJson).toBeNull();
      expect(created.waitJson).toBeNull();

      const resumed = resumeFlow({
        flowId: created.flowId,
        expectedRevision: created.revision,
        stateJson: null,
      });

      expect(resumed.applied).toBe(true);
      if (!resumed.applied) {
        throw new Error("Expected resume update to apply");
      }
      expect(resumed.flow.flowId).toBe(created.flowId);
      expect(resumed.flow.stateJson).toBeNull();
    });
  });

  it("requires implementation pass before a blind-test slice can close", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createBlindTestSliceFlow({
        ownerKey: "agent:main:main",
        goal: "Blind test Grant slice 1",
        sliceKey: "slice-1",
        subjectAgent: "Grant",
      });

      expect(created.controllerId).toBe(BLIND_TEST_SLICE_CONTROLLER_ID);
      expect(created.currentStep).toBe("draft_review_required");

      const draftPassed = recordBlindTestDraftReview({
        flowId: created.flowId,
        expectedRevision: created.revision,
        verdict: "passed",
        summary: "Draft passes. Now implement it.",
        reviewedAt: 100,
      });
      expect(draftPassed.applied).toBe(true);
      if (!draftPassed.applied) {
        throw new Error("Expected blind-test draft review pass to apply");
      }
      expect(draftPassed.flow.status).toBe("running");
      expect(draftPassed.flow.currentStep).toBe("implementation_review_required");

      const prematureClose = finishFlow({
        flowId: created.flowId,
        expectedRevision: draftPassed.flow.revision,
        endedAt: 110,
      });
      expect(prematureClose).toMatchObject({
        applied: false,
        reason: "guard_blocked",
        blockedSummary: "Blind-test slice cannot close until the implemented slice passes review.",
        current: {
          flowId: created.flowId,
          status: "running",
        },
      });

      const implementationPassed = recordBlindTestImplementationReview({
        flowId: created.flowId,
        expectedRevision: draftPassed.flow.revision,
        verdict: "passed",
        summary: "Implemented slice passes.",
        reviewedAt: 120,
      });
      expect(implementationPassed.applied).toBe(true);
      if (!implementationPassed.applied) {
        throw new Error("Expected blind-test implementation review pass to apply");
      }
      expect(implementationPassed.flow.currentStep).toBe(
        "implementation_passed_ready_for_closeout",
      );

      const closed = finishFlow({
        flowId: created.flowId,
        expectedRevision: implementationPassed.flow.revision,
        endedAt: 130,
      });
      expect(closed.applied).toBe(true);
      if (!closed.applied) {
        throw new Error("Expected blind-test flow close to apply");
      }
      expect(closed.flow.status).toBe("succeeded");
      expect(closed.flow.endedAt).toBe(130);
    });
  });

  it("attaches mission settlement state to managed TaskFlow stateJson without changing revision semantics", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const settlement = resolveMissionSettlementTail({
        missionId: "mission-settlement-flow",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: {
          runLabel: "TaskFlow settlement",
          targetHandled: "mission settlement",
          scopeHandled: "managed TaskFlow stateJson",
          actualExecutionOwner: "Cleanup Crew",
          artifactPaths: ["/tmp/closeout.md"],
          proofPaths: ["src/tasks/task-flow-registry.test.ts"],
          whatIsMateriallyRealNow: "Work result is durable.",
          whatIsStillNotRealYet: "Delivery is unknown.",
          whoLawfullyOwnsNextStep: "Will",
          openClosedTruth: "owner execution in progress, build still open.",
          exactNextAction: "reconcile delivery acknowledgement",
          shortResult: "Settlement tail is attached to TaskFlow state.",
        },
        reportRequired: true,
        reportRendered: true,
        deliveryState: "unknown",
      });
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Track mission settlement tail",
        currentStep: "delivery_recovery",
        stateJson: attachMissionSettlementToTaskFlowStateJson({
          stateJson: { phase: "delivery_recovery" },
          settlement,
        }),
      });

      expect(created.revision).toBe(0);
      expect(created.stateJson).toMatchObject({
        phase: "delivery_recovery",
        governedMissionSettlement: {
          schema: "openclaw.mission_settlement_tail_decision.v1",
          missionId: "mission-settlement-flow",
          state: "DELIVERY_UNKNOWN",
          settled: false,
          nextIncompleteBoundary: "delivery_unknown",
        },
      });
      expect(getTaskFlowMissionSettlement(created)).toMatchObject({
        missionId: "mission-settlement-flow",
        state: "DELIVERY_UNKNOWN",
        recoveryAction: "reconcile_ambiguous_delivery_ack",
      });

      const updated = updateFlowRecordByIdExpectedRevision({
        flowId: created.flowId,
        expectedRevision: created.revision,
        patch: {
          currentStep: "delivery_reconciliation_running",
          stateJson: attachMissionSettlementToTaskFlowStateJson({
            stateJson: created.stateJson,
            settlement: {
              ...settlement,
              state: "DELIVERY_FAILED",
              recoveryAction: "retry_delivery_only_with_idempotency",
              nextIncompleteBoundary: "delivery_retry",
            },
          }),
        },
      });
      expect(updated.applied).toBe(true);
      if (!updated.applied) {
        throw new Error("Expected settlement update to apply");
      }
      expect(updated.flow.revision).toBe(1);
      expect(updated.flow.stateJson).toMatchObject({
        phase: "delivery_recovery",
        governedMissionSettlement: {
          state: "DELIVERY_FAILED",
          nextIncompleteBoundary: "delivery_retry",
        },
      });
    });
  });

  it("ignores malformed TaskFlow mission settlement blobs", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Reject malformed settlement state",
        stateJson: {
          governedMissionSettlement: {
            schema: "wrong.schema",
            state: "SETTLED",
          },
        },
      });

      expect(getTaskFlowMissionSettlement(created)).toBeNull();
    });
  });

  it("blocks managed TaskFlow close while mission settlement tail is open", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const settlement = resolveMissionSettlementTail({
        missionId: "mission-open-tail",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: {
          runLabel: "Open settlement",
          targetHandled: "mission settlement close gate",
          scopeHandled: "managed TaskFlow terminal close",
          actualExecutionOwner: "Cleanup Crew",
          artifactPaths: ["/tmp/closeout.md"],
          proofPaths: ["src/tasks/task-flow-registry.test.ts"],
          whatIsMateriallyRealNow: "Work result is durable.",
          whatIsStillNotRealYet: "Final report delivery is unknown.",
          whoLawfullyOwnsNextStep: "Will",
          openClosedTruth: "owner execution in progress, build still open.",
          exactNextAction: "reconcile delivery acknowledgement",
          shortResult: "TaskFlow close must wait for settlement.",
        },
        reportRequired: true,
        reportRendered: true,
        deliveryState: "unknown",
      });
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Do not close before delivery settlement",
        currentStep: "delivery_recovery",
        stateJson: attachMissionSettlementToTaskFlowStateJson({
          stateJson: { phase: "delivery_recovery" },
          settlement,
        }),
      });
      if (!created) {
        throw new Error("Expected managed flow creation");
      }

      const closed = finishFlow({
        flowId: created.flowId,
        expectedRevision: created.revision,
        currentStep: "attempted_close",
      });

      assert(!closed.applied);
      expect(closed.reason).toBe("guard_blocked");
      expect(closed.blockedSummary).toContain("Mission settlement tail is not settled");
      expect(closed.blockedSummary).toContain("DELIVERY_UNKNOWN");
      expect(closed.current).toMatchObject({
        status: "blocked",
        currentStep: "mission_settlement_tail_open",
      });
    });
  });

  it("blocks whole-run completion stop while mission settlement tail is open", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const settlement = resolveMissionSettlementTail({
        missionId: "mission-open-tail-stop",
        workState: "completed",
        resultDurable: true,
        closeoutReady: true,
        closeout: {
          runLabel: "Open settlement stop",
          targetHandled: "mission settlement lawful stop gate",
          scopeHandled: "active production whole-run completion",
          actualExecutionOwner: "Cleanup Crew",
          artifactPaths: ["/tmp/closeout.md"],
          proofPaths: ["src/tasks/task-flow-registry.test.ts"],
          whatIsMateriallyRealNow: "Work result is durable.",
          whatIsStillNotRealYet: "Final report delivery failed.",
          whoLawfullyOwnsNextStep: "Will",
          openClosedTruth: "owner execution in progress, build still open.",
          exactNextAction: "retry delivery only",
          shortResult: "Whole-run complete must wait for delivery settlement.",
        },
        reportRequired: true,
        reportRendered: true,
        deliveryState: "failed",
      });
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Do not mark whole run complete before delivery settlement",
        currentStep: "delivery_retry",
        continuation: {
          activeProductionRun: true,
          currentUnitStatus: "passed",
          continuationRequiredAfterLocalSuccess: false,
        },
        stateJson: attachMissionSettlementToTaskFlowStateJson({
          stateJson: { phase: "delivery_retry" },
          settlement,
        }),
      });
      if (!created) {
        throw new Error("Expected managed flow creation");
      }

      const stopped = recordFlowLawfulStop({
        flowId: created.flowId,
        expectedRevision: created.revision,
        reason: "whole_run_complete",
      });

      assert(!stopped.applied);
      expect(stopped.reason).toBe("guard_blocked");
      expect(stopped.blockedSummary).toContain("Mission settlement tail is not settled");
      expect(stopped.blockedSummary).toContain("DELIVERY_FAILED");
      expect(stopped.current).toMatchObject({
        status: "blocked",
        currentStep: "mission_settlement_tail_open",
      });
    });
  });

  it("blocks managed-flow close after local success until the next executable unit launches", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Run bounded production controller",
        status: "running",
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      });

      const blockedClose = finishFlow({
        flowId: created.flowId,
        expectedRevision: created.revision,
        endedAt: 200,
      });

      expect(blockedClose).toMatchObject({
        applied: false,
        reason: "guard_blocked",
        blockedSummary:
          "Active production run cannot pause or close after a passed bounded unit before the next executable unit launches.",
        current: {
          flowId: created.flowId,
          status: "blocked",
          currentStep: "continuation_launch_required",
        },
      });
      if (blockedClose.applied || !blockedClose.current) {
        throw new Error("Expected blocked close current flow snapshot");
      }
      const blockedContinuation = getTaskFlowProductionContinuation(blockedClose.current);
      expect(blockedContinuation?.continuationRequiredAfterLocalSuccess).toBe(true);
      expect(blockedContinuation?.continuationViolation).toBe(true);

      const launched = recordFlowNextExecutableLaunch({
        flowId: created.flowId,
        expectedRevision: blockedClose.current.revision,
        detail: "Launch bounded unit 2",
        currentStep: "bounded_unit_2_running",
        updatedAt: 210,
      });
      expect(launched.applied).toBe(true);
      if (!launched.applied) {
        throw new Error("Expected next-launch update to apply");
      }
      const launchedContinuation = getTaskFlowProductionContinuation(launched.flow);
      expect(launchedContinuation?.nextExecutableUnitIdentified).toBe(true);
      expect(launchedContinuation?.nextExecutableUnitLaunched).toBe(true);

      const closed = finishFlow({
        flowId: created.flowId,
        expectedRevision: launched.flow.revision,
        endedAt: 220,
      });
      expect(closed.applied).toBe(true);
      if (!closed.applied) {
        throw new Error("Expected managed flow close after next launch");
      }
      expect(closed.flow.status).toBe("succeeded");
    });
  });

  it("projects the new pending action without reusing the previous execution receipt", async () => {
    await withFlowRegistryTempDir(async () => {
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Run bounded production controller",
        status: "running",
        continuation: { activeProductionRun: true, parentRunOpen: true },
      });
      const launched = recordFlowNextExecutableLaunch({
        flowId: created.flowId,
        expectedRevision: created.revision,
        detail: "run:inspection-1:tool:start:read-1",
        updatedAt: 200,
      });
      assert(launched.applied);
      const continuation = getTaskFlowProductionContinuation(launched.flow);
      assert(continuation);
      const launchedState = launched.flow.stateJson;
      assert(launchedState && typeof launchedState === "object" && !Array.isArray(launchedState));
      const checkpoint = resumeFlow({
        flowId: launched.flow.flowId,
        expectedRevision: launched.flow.revision,
        currentStep: "inspection_report_delivered",
        stateJson: {
          ...launchedState,
          productionContinuation: {
            ...continuation,
            nextExecutableUnitLaunched: false,
            events: [
              ...continuation.events,
              { type: "NEXT_EXECUTABLE_UNIT_IDENTIFIED", at: 300, detail: "Run next validation" },
            ],
          },
        },
      });
      assert(checkpoint.applied);
      const readback = getTaskFlowById(created.flowId);
      assert(readback);
      expect(getTaskFlowActiveProductionContinuation(readback)).toMatchObject({
        status: "dispatch_required",
        nextAction: { summary: "Run next validation" },
        dispatchReceipts: [],
      });
      expect(
        getTaskFlowActiveProductionContinuation(readback)?.nextAction?.dispatchProofRef,
      ).toBeUndefined();
      expect(getTaskFlowProductionContinuation(readback)?.events).toContainEqual({
        type: "NEXT_EXECUTABLE_UNIT_LAUNCHED",
        at: 200,
        detail: "run:inspection-1:tool:start:read-1",
      });
    });
  });

  it("allows lawful whole-run completion on managed continuation flows", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Complete entire production run",
        status: "running",
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      });

      const lawfulStop = recordFlowLawfulStop({
        flowId: created.flowId,
        expectedRevision: created.revision,
        reason: "whole_run_complete",
        detail: "No further bounded units remain.",
        updatedAt: 300,
      });
      expect(lawfulStop.applied).toBe(true);
      if (!lawfulStop.applied) {
        throw new Error("Expected lawful whole-run completion update to apply");
      }
      const lawfulContinuation = getTaskFlowProductionContinuation(lawfulStop.flow);
      expect(lawfulStop.flow.status).toBe("terminal_pending_watchdog");
      expect(lawfulContinuation?.lawfulWholeRunCompletion).toBe(true);
      expect(lawfulContinuation?.lawfulStopReason).toBe("whole_run_complete");
      expect(lawfulContinuation?.parentRunOpen).toBe(false);

      const closed = finishFlow({
        flowId: created.flowId,
        expectedRevision: lawfulStop.flow.revision,
        endedAt: 310,
      });
      expect(closed.applied).toBe(true);
      if (!closed.applied) {
        throw new Error("Expected close after lawful whole-run completion");
      }
      expect(closed.flow.status).toBe("succeeded");
    });
  });

  it("fails closed when a governed mission state value is present but invalid", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();
      const malformed: TaskFlowRecord = {
        flowId: "malformed-governed-flow",
        syncMode: "managed",
        ownerKey: "agent:main:main",
        controllerId: "tests/governed-invalid-state",
        revision: 0,
        status: "running",
        notifyPolicy: "done_only",
        goal: "Do not close malformed governed state",
        stateJson: {
          governedMissionState: {
            schema: "openclaw.governed_mission_state.v2",
            missionId: "mission-with-incomplete-state",
          },
        },
        createdAt: 1,
        updatedAt: 1,
      };
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map([[malformed.flowId, malformed]]) }),
          saveSnapshot: () => {},
        },
      });

      const result = finishFlow({
        flowId: malformed.flowId,
        expectedRevision: malformed.revision,
      });
      expect(result).toMatchObject({
        applied: false,
        reason: "guard_blocked",
        blockedSummary: expect.stringContaining("state is present but invalid"),
      });
      expect(getTaskFlowById(malformed.flowId)).toMatchObject({ status: "running" });
    });
  });

  it("reserves governed mission state creation for the admission runtime", async () => {
    await withFlowRegistryTempDir(async () => {
      expect(() =>
        createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/governed-state-injection",
          goal: "Inject governed state",
          stateJson: { governedMissionState: {} },
        }),
      ).toThrow("can only be created by the governed mission admission runtime");
      expect(listTaskFlowRecords()).toEqual([]);

      const ordinary = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/ordinary-flow",
        goal: "Ordinary flow",
      });
      expect(
        updateFlowRecordByIdExpectedRevision({
          flowId: ordinary.flowId,
          expectedRevision: ordinary.revision,
          patch: { stateJson: { governedMissionState: {} } },
        }),
      ).toMatchObject({
        applied: false,
        reason: "guard_blocked",
        blockedSummary: expect.stringContaining("admission runtime"),
      });
    });
  });

  it("blocks implementation review before draft pass and blocks next-slice creation until prior slice closes cleanly", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const firstSlice = createBlindTestSliceFlow({
        ownerKey: "agent:main:main",
        goal: "Blind test Grant slice 1",
        sliceKey: "slice-1",
        subjectAgent: "Grant",
      });

      const implementationBeforeDraft = recordBlindTestImplementationReview({
        flowId: firstSlice.flowId,
        expectedRevision: firstSlice.revision,
        verdict: "passed",
        reviewedAt: 200,
      });
      expect(implementationBeforeDraft).toMatchObject({
        applied: false,
        reason: "guard_blocked",
        blockedSummary:
          "Implementation review cannot complete until the blind-test draft review passes.",
      });

      const nextBeforeClose = createNextBlindTestSliceFlow({
        previousFlowId: firstSlice.flowId,
        expectedPreviousRevision: firstSlice.revision,
        goal: "Blind test Grant slice 2",
        sliceKey: "slice-2",
        subjectAgent: "Grant",
      });
      expect(nextBeforeClose).toMatchObject({
        created: false,
        reason: "previous_slice_not_complete",
        blockedSummary:
          "Next blind-test slice cannot start until the prior slice has a passing implementation review and is closed successfully.",
      });

      const draftPassed = recordBlindTestDraftReview({
        flowId: firstSlice.flowId,
        expectedRevision: firstSlice.revision,
        verdict: "passed",
        reviewedAt: 210,
      });
      if (!draftPassed.applied) {
        throw new Error("Expected draft pass");
      }
      const implementationPassed = recordBlindTestImplementationReview({
        flowId: firstSlice.flowId,
        expectedRevision: draftPassed.flow.revision,
        verdict: "passed",
        reviewedAt: 220,
      });
      if (!implementationPassed.applied) {
        throw new Error("Expected implementation pass");
      }
      const closed = finishFlow({
        flowId: firstSlice.flowId,
        expectedRevision: implementationPassed.flow.revision,
        endedAt: 230,
      });
      if (!closed.applied) {
        throw new Error("Expected first slice close");
      }

      const secondSlice = createNextBlindTestSliceFlow({
        previousFlowId: firstSlice.flowId,
        expectedPreviousRevision: closed.flow.revision,
        goal: "Blind test Grant slice 2",
        sliceKey: "slice-2",
        subjectAgent: "Grant",
      });
      expect(secondSlice.created).toBe(true);
      if (!secondSlice.created) {
        throw new Error("Expected next blind-test slice creation to succeed");
      }
      expect(secondSlice.flow.ownerKey).toBe("agent:main:main");
      expect(secondSlice.flow.currentStep).toBe("draft_review_required");
    });
  });

  it("requires next executable launch before an active production blind-test slice can close", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const firstSlice = createBlindTestSliceFlow({
        ownerKey: "agent:main:main",
        goal: "Blind test Grant production slice 1",
        sliceKey: "prod-slice-1",
        subjectAgent: "Grant",
        createdAt: 10,
        updatedAt: 10,
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
        },
      });

      const draftPassed = recordBlindTestDraftReview({
        flowId: firstSlice.flowId,
        expectedRevision: firstSlice.revision,
        verdict: "passed",
        reviewedAt: 20,
        updatedAt: 20,
      });
      if (!draftPassed.applied) {
        throw new Error("Expected draft pass");
      }
      const implementationPassed = recordBlindTestImplementationReview({
        flowId: firstSlice.flowId,
        expectedRevision: draftPassed.flow.revision,
        verdict: "passed",
        reviewedAt: 30,
        updatedAt: 30,
      });
      if (!implementationPassed.applied) {
        throw new Error("Expected implementation pass");
      }

      expect(
        (
          implementationPassed.flow.stateJson as {
            continuation?: {
              continuationRequiredAfterLocalSuccess?: boolean;
              events?: { type: string }[];
            };
          }
        ).continuation,
      ).toMatchObject({
        continuationRequiredAfterLocalSuccess: true,
      });

      const blockedClose = finishFlow({
        flowId: firstSlice.flowId,
        expectedRevision: implementationPassed.flow.revision,
        updatedAt: 40,
        endedAt: 40,
      });
      expect(blockedClose).toMatchObject({
        applied: false,
        reason: "guard_blocked",
        blockedSummary:
          "Active production run cannot pause or close after a passed bounded unit before the next executable unit launches.",
        current: {
          flowId: firstSlice.flowId,
          status: "blocked",
          currentStep: "continuation_launch_required",
        },
      });
      if (blockedClose.applied || !blockedClose.current) {
        throw new Error("Expected continuation guard to block close");
      }
      expect(
        (
          blockedClose.current.stateJson as {
            continuation?: { continuationViolation?: boolean; events?: { type: string }[] };
          }
        ).continuation,
      ).toMatchObject({
        continuationViolation: true,
      });

      const secondSlice = createNextBlindTestSliceFlow({
        previousFlowId: firstSlice.flowId,
        expectedPreviousRevision: blockedClose.current.revision,
        goal: "Blind test Grant production slice 2",
        sliceKey: "prod-slice-2",
        subjectAgent: "Grant",
        createdAt: 50,
        updatedAt: 50,
      });
      expect(secondSlice.created).toBe(true);
      if (!secondSlice.created) {
        throw new Error("Expected next slice creation to succeed");
      }
      expect(secondSlice.previousFlow).toMatchObject({
        status: "running",
        currentStep: "next_executable_unit_launched_ready_for_closeout",
      });

      const closed = finishFlow({
        flowId: firstSlice.flowId,
        expectedRevision: secondSlice.previousFlow?.revision ?? blockedClose.current.revision,
        updatedAt: 60,
        endedAt: 60,
      });
      expect(closed.applied).toBe(true);
      if (!closed.applied) {
        throw new Error("Expected close after next launch");
      }
      expect(closed.flow.status).toBe("succeeded");
    });
  });

  it("allows lawful whole-run completion for active production slices", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createBlindTestSliceFlow({
        ownerKey: "agent:main:main",
        goal: "Blind test Grant final production slice",
        sliceKey: "prod-final",
        subjectAgent: "Grant",
        createdAt: 10,
        updatedAt: 10,
        continuation: {
          activeProductionRun: true,
          parentRunOpen: false,
          lawfulWholeRunCompletion: true,
          lawfulStopReason: "whole_run_complete",
        },
      });

      const draftPassed = recordBlindTestDraftReview({
        flowId: created.flowId,
        expectedRevision: created.revision,
        verdict: "passed",
        reviewedAt: 20,
        updatedAt: 20,
      });
      if (!draftPassed.applied) {
        throw new Error("Expected draft pass");
      }
      const implementationPassed = recordBlindTestImplementationReview({
        flowId: created.flowId,
        expectedRevision: draftPassed.flow.revision,
        verdict: "passed",
        reviewedAt: 30,
        updatedAt: 30,
      });
      if (!implementationPassed.applied) {
        throw new Error("Expected implementation pass");
      }

      const closed = finishFlow({
        flowId: created.flowId,
        expectedRevision: implementationPassed.flow.revision,
        updatedAt: 40,
        endedAt: 40,
      });
      expect(closed.applied).toBe(true);
      if (!closed.applied) {
        throw new Error("Expected lawful whole-run completion close");
      }
      expect(closed.flow.status).toBe("succeeded");
    });
  });

  it("tracks closeout rework and escalates the same slice to Will on the third failure", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createBlindTestSliceFlow({
        ownerKey: "agent:main:main",
        goal: "Blind test Grant slice 3",
        sliceKey: "slice-3",
        subjectAgent: "Grant",
      });

      const draftPassed = recordBlindTestDraftReview({
        flowId: created.flowId,
        expectedRevision: created.revision,
        verdict: "passed",
        reviewedAt: 100,
      });
      if (!draftPassed.applied) {
        throw new Error("Expected draft pass");
      }
      const implementationPassed = recordBlindTestImplementationReview({
        flowId: created.flowId,
        expectedRevision: draftPassed.flow.revision,
        verdict: "passed",
        reviewedAt: 110,
      });
      if (!implementationPassed.applied) {
        throw new Error("Expected implementation pass");
      }

      const firstFail = recordBlindTestCloseoutFailure({
        flowId: created.flowId,
        expectedRevision: implementationPassed.flow.revision,
        summary: "Readable proof is missing. Retry the same slice.",
        outcomeCode: "rejected_proof_missing",
        reviewedAt: 120,
      });
      expect(firstFail.applied).toBe(true);
      if (!firstFail.applied) {
        throw new Error("Expected first closeout failure");
      }
      expect(firstFail.flow.currentStep).toBe("closeout_rework_required");
      expect(firstFail.flow.blockedSummary).toBe(
        "Readable proof is missing. Retry the same slice.",
      );
      expect(
        (firstFail.flow.stateJson as { rework?: { failCount?: number; stage?: string } }).rework,
      ).toMatchObject({
        failCount: 1,
        stage: "closeout",
      });

      const secondFail = recordBlindTestCloseoutFailure({
        flowId: created.flowId,
        expectedRevision: firstFail.flow.revision,
        summary: "Still missing proof. Retry the same slice.",
        outcomeCode: "rejected_proof_missing",
        reviewedAt: 130,
      });
      expect(secondFail.applied).toBe(true);
      if (!secondFail.applied) {
        throw new Error("Expected second closeout failure");
      }
      expect(
        (secondFail.flow.stateJson as { rework?: { failCount?: number } }).rework?.failCount,
      ).toBe(2);

      const thirdFail = recordBlindTestCloseoutFailure({
        flowId: created.flowId,
        expectedRevision: secondFail.flow.revision,
        summary: "Third failure",
        outcomeCode: "rejected_proof_missing",
        reviewedAt: 140,
      });
      expect(thirdFail.applied).toBe(true);
      if (!thirdFail.applied) {
        throw new Error("Expected third closeout failure");
      }
      expect(thirdFail.flow.currentStep).toBe("will_takeover_required");
      expect(thirdFail.flow.blockedSummary).toBe(
        "Blind-test slice failed three times. Transfer this same slice to Will now.",
      );
      expect(
        (
          thirdFail.flow.stateJson as {
            rework?: { failCount?: number; transferOwner?: string; handbackStatus?: string };
          }
        ).rework,
      ).toMatchObject({
        failCount: 3,
        transferOwner: "Will",
        handbackStatus: "required",
      });
    });
  });
});
