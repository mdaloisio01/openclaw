import { afterEach, describe, expect, it } from "vitest";
import {
  createBlindTestSliceFlow,
  createManagedTaskFlow,
  recordBlindTestCloseoutFailure,
  recordBlindTestDraftReview,
  recordBlindTestImplementationReview,
  resetTaskFlowRegistryForTests,
} from "./task-flow-runtime-internal.js";
import {
  listTaskAuditFindings,
  summarizeActionableTaskAuditFindings,
  summarizeRetainedLostTaskAuditFindings,
  summarizeTaskAuditFindings,
} from "./task-registry.audit.js";
import type { TaskRecord } from "./task-registry.types.js";
import { DEFAULT_TASK_RETENTION_MS, LOST_TASK_RETENTION_MS } from "./task-retention.js";

function createTask(partial: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: partial.taskId ?? "task-1",
    runtime: partial.runtime ?? "acp",
    requesterSessionKey: partial.requesterSessionKey ?? partial.ownerKey ?? "agent:main:main",
    ownerKey: partial.ownerKey ?? partial.requesterSessionKey ?? "agent:main:main",
    scopeKind: partial.scopeKind ?? "session",
    task: partial.task ?? "Background task",
    status: partial.status ?? "queued",
    deliveryStatus: partial.deliveryStatus ?? "pending",
    notifyPolicy: partial.notifyPolicy ?? "done_only",
    createdAt: partial.createdAt ?? Date.parse("2026-03-30T00:00:00.000Z"),
    ...partial,
  };
}

describe("task-registry audit", () => {
  afterEach(() => {
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("flags stale running, lost, and missing cleanup tasks", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "stale-running",
          status: "running",
          startedAt: now - 40 * 60_000,
          lastEventAt: now - 40 * 60_000,
        }),
        createTask({
          taskId: "lost-task",
          status: "lost",
          error: "backing session missing",
          endedAt: now - 5 * 60_000,
        }),
        createTask({
          taskId: "missing-cleanup",
          status: "failed",
          endedAt: now - 60_000,
          cleanupAfter: undefined,
        }),
      ],
    });

    expect(findings.map((finding) => [finding.code, finding.task.taskId])).toEqual([
      ["lost", "lost-task"],
      ["stale_running", "stale-running"],
      ["missing_cleanup", "missing-cleanup"],
    ]);
  });

  it("summarizes findings by severity and code", () => {
    const summary = summarizeTaskAuditFindings([
      {
        severity: "error",
        code: "stale_running",
        task: createTask({ taskId: "a", status: "running" }),
        detail: "running task appears stuck",
      },
      {
        severity: "warn",
        code: "delivery_failed",
        task: createTask({ taskId: "b", status: "failed" }),
        detail: "terminal update delivery failed",
      },
    ]);

    expect(summary).toEqual({
      total: 2,
      warnings: 1,
      errors: 1,
      byCode: {
        stale_queued: 0,
        stale_running: 1,
        lost: 0,
        delivery_failed: 1,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
        accepted_not_yet_proven_active_too_long: 0,
        parent_review_state_without_active_executor: 0,
        open_build_no_active_owner: 0,
        owner_readout_finished_no_followthrough: 0,
        parent_continuity_violation: 0,
        rework_follow_through_violation: 0,
        routed_to_owner_not_proven_active: 0,
        build_open_all_related_sessions_terminal: 0,
        execution_truth_conflicts_with_status_text: 0,
      },
    });
  });

  it("downgrades retained lost tasks with future cleanupAfter to warnings", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "lost-retained",
          status: "lost",
          error: "backing session missing",
          endedAt: now - 60_000,
          lastEventAt: now - 60_000,
          cleanupAfter: now + 60_000,
        }),
        createTask({
          taskId: "lost-expired",
          status: "lost",
          error: "backing session missing",
          endedAt: now - 120_000,
          lastEventAt: now - 120_000,
          cleanupAfter: now - 1,
        }),
      ],
    });

    expect(
      findings.map((finding) => [finding.task.taskId, finding.code, finding.severity]),
    ).toEqual([
      ["lost-expired", "lost", "error"],
      ["lost-retained", "lost", "warn"],
    ]);
  });

  it("summarizes future-retained lost tasks separately from actionable audit counts", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const nextCleanupAfter = now + 60_000;
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "lost-retained",
          status: "lost",
          endedAt: now - 60_000,
          cleanupAfter: nextCleanupAfter,
        }),
        createTask({
          taskId: "lost-expired",
          status: "lost",
          endedAt: now - 120_000,
          cleanupAfter: now - 1,
        }),
      ],
    });

    expect(summarizeActionableTaskAuditFindings(findings, { now })).toEqual({
      total: 1,
      warnings: 0,
      errors: 1,
      byCode: {
        stale_queued: 0,
        stale_running: 0,
        lost: 1,
        delivery_failed: 0,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
        accepted_not_yet_proven_active_too_long: 0,
        parent_review_state_without_active_executor: 0,
        open_build_no_active_owner: 0,
        owner_readout_finished_no_followthrough: 0,
        parent_continuity_violation: 0,
        rework_follow_through_violation: 0,
        routed_to_owner_not_proven_active: 0,
        build_open_all_related_sessions_terminal: 0,
        execution_truth_conflicts_with_status_text: 0,
      },
    });
    expect(summarizeRetainedLostTaskAuditFindings(findings, { now })).toEqual({
      count: 1,
      nextCleanupAfter,
    });
  });

  it("treats old seven-day lost cleanupAfter values as expired after the lost window", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const endedAt = now - LOST_TASK_RETENTION_MS - 1;
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "lost-old-retention",
          status: "lost",
          endedAt,
          cleanupAfter: endedAt + DEFAULT_TASK_RETENTION_MS,
        }),
      ],
    });

    expect(summarizeActionableTaskAuditFindings(findings, { now }).errors).toBe(1);
    expect(summarizeRetainedLostTaskAuditFindings(findings, { now })).toEqual({ count: 0 });
  });

  it("does not double-report lost tasks as missing cleanup", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "lost-projected",
          status: "lost",
          endedAt: now - 60_000,
          cleanupAfter: undefined,
        }),
      ],
    });

    expect(findings.map((finding) => finding.code)).toEqual(["lost"]);
  });

  it("flags open mission truth with no active owner executor", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      staleQueuedMs: 5 * 60_000,
      tasks: [
        createTask({
          taskId: "review-paused",
          runtime: "acp",
          status: "succeeded",
          childSessionKey: "agent:main:acp:child",
          missionId: "mission-1",
          missionUpdatedAt: now - 10 * 60_000,
          endedAt: now - 10 * 60_000,
          terminalSummary: "Phase landed and passed tests.",
        }),
      ],
    });

    expect(findings.map((finding) => [finding.code, finding.task.taskId])).toEqual([
      ["open_build_no_active_owner", "review-paused"],
      ["build_open_all_related_sessions_terminal", "review-paused"],
      ["missing_cleanup", "review-paused"],
      ["parent_review_state_without_active_executor", "review-paused"],
      ["owner_readout_finished_no_followthrough", "review-paused"],
    ]);
  });

  it("flags active production parent flow with lost child and no active owner", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const flow = createManagedTaskFlow({
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch GIE Phase 1 SADB runtime implementation",
      status: "running",
      notifyPolicy: "done_only",
      currentStep: "phase1_sadb_parent_flow_created",
      createdAt: now - 5 * 60_000,
      stateJson: { kind: "production_taskflow_slice" },
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
    });
    if (!flow) {
      throw new Error("Expected active production TaskFlow creation");
    }

    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "lost-sadb-child",
          runtime: "cli",
          parentFlowId: flow.flowId,
          status: "lost",
          error: "backing session missing",
          endedAt: now - 60_000,
          lastEventAt: now - 60_000,
          cleanupAfter: now + 60_000,
        }),
      ],
    });

    expect(findings.map((finding) => [finding.code, finding.task.taskId])).toEqual([
      ["open_build_no_active_owner", "lost-sadb-child"],
      ["build_open_all_related_sessions_terminal", "lost-sadb-child"],
      ["lost", "lost-sadb-child"],
    ]);
  });

  it("flags accepted tasks that stay queued too long without proving active execution", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      staleQueuedMs: 5 * 60_000,
      tasks: [
        createTask({
          taskId: "queued-mission",
          status: "queued",
          missionId: "mission-queued",
          missionUpdatedAt: now - 10 * 60_000,
          lastEventAt: now - 10 * 60_000,
        }),
      ],
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "open_build_no_active_owner",
      "stale_queued",
      "accepted_not_yet_proven_active_too_long",
      "routed_to_owner_not_proven_active",
    ]);
  });

  it("flags same-slice rework packets that stayed queued without launch proof", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    resetTaskFlowRegistryForTests({ persist: false });
    const flow = createBlindTestSliceFlow({
      ownerKey: "agent:main:main",
      goal: "Grant production blind-test slice 2",
      sliceKey: "prod-slice-2",
      subjectAgent: "Grant",
      createdAt: now - 20 * 60_000,
      updatedAt: now - 20 * 60_000,
      continuation: {
        activeProductionRun: true,
        parentRunOpen: true,
      },
    });
    if (!flow) {
      throw new Error("Expected blind-test flow creation");
    }
    const failed = recordBlindTestCloseoutFailure({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      summary: "Grant closeout failed and must retry the same slice.",
      outcomeCode: "rejected_proof_missing",
      reviewedAt: now - 10 * 60_000,
      updatedAt: now - 10 * 60_000,
    });
    if (!failed.applied) {
      throw new Error("Expected closeout rework state");
    }

    const findings = listTaskAuditFindings({
      now,
      staleQueuedMs: 5 * 60_000,
      tasks: [
        createTask({
          taskId: "grant-rework-queued",
          runtime: "subagent",
          status: "queued",
          missionId: "mission-grant-rework",
          missionUpdatedAt: now - 10 * 60_000,
          lastEventAt: now - 10 * 60_000,
          parentFlowId: failed.flow.flowId,
          progressSummary:
            "CHILD_RESULT_REJECTED :: SAME_SLICE_REWORK_REQUIRED :: REWORK_PACKET_CREATED :: REWORK_PACKET_QUEUED :: REWORK_EXECUTOR_LAUNCH_REQUIRED :: retry the same slice",
        }),
      ],
    });

    expect(findings.map((finding) => finding.code)).toContain("rework_follow_through_violation");
  });

  it("flags status text that claims execution in progress without runtime proof", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      staleQueuedMs: 5 * 60_000,
      tasks: [
        createTask({
          taskId: "fake-running-text",
          status: "succeeded",
          missionId: "mission-fake-running",
          missionUpdatedAt: now - 10 * 60_000,
          endedAt: now - 10 * 60_000,
          terminalSummary: "Open/closed truth: owner execution in progress, build still open.",
        }),
      ],
    });

    expect(findings.map((finding) => finding.code)).toContain(
      "execution_truth_conflicts_with_status_text",
    );
  });

  it("flags parent continuity violation when active production continuation requires next launch", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    resetTaskFlowRegistryForTests({ persist: false });
    const flow = createBlindTestSliceFlow({
      ownerKey: "agent:main:main",
      goal: "Grant production blind-test slice 1",
      sliceKey: "prod-slice-1",
      subjectAgent: "Grant",
      createdAt: now - 20 * 60_000,
      updatedAt: now - 20 * 60_000,
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
      reviewedAt: now - 15 * 60_000,
      updatedAt: now - 15 * 60_000,
    });
    if (!draftPassed.applied) {
      throw new Error("Expected draft pass");
    }
    const implementationPassed = recordBlindTestImplementationReview({
      flowId: flow.flowId,
      expectedRevision: draftPassed.flow.revision,
      verdict: "passed",
      reviewedAt: now - 10 * 60_000,
      updatedAt: now - 10 * 60_000,
    });
    if (!implementationPassed.applied) {
      throw new Error("Expected implementation pass");
    }

    const findings = listTaskAuditFindings({
      now,
      staleQueuedMs: 5 * 60_000,
      tasks: [
        createTask({
          taskId: "review-paused-production",
          runtime: "acp",
          status: "succeeded",
          childSessionKey: "agent:main:acp:child",
          missionId: "mission-prod-1",
          missionUpdatedAt: now - 10 * 60_000,
          endedAt: now - 10 * 60_000,
          parentFlowId: implementationPassed.flow.flowId,
          terminalSummary: "Phase landed and passed tests.",
        }),
      ],
    });

    expect(findings.map((finding) => finding.code)).toContain("parent_continuity_violation");
  });
});
