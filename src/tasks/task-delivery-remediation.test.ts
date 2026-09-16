import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  planHistoricalDeliveryFailureSnapshotPath,
  runHistoricalDeliveryFailureRemediation,
} from "./task-delivery-remediation.js";

function createTempPaths(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    dbPath: path.join(root, "openclaw.sqlite"),
    receiptDir: path.join(root, "receipts"),
    snapshotPath: path.join(root, "snapshot.sqlite"),
  };
}

function seedCandidateState(
  dbPath: string,
  options?: { includeOrphanFlow?: boolean; includeSkippedDebt?: boolean },
) {
  const database = openOpenClawStateDatabase({ path: dbPath });
  const db = database.db;
  db.prepare(
    `INSERT INTO task_runs (
      task_id, runtime, requester_session_key, owner_key, scope_kind, run_id, child_session_key,
      parent_flow_id, task, status, delivery_status, notify_policy, created_at, ended_at,
      last_event_at, terminal_summary, terminal_outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "task-candidate",
    "subagent",
    "agent:main:main",
    "agent:main:main",
    "session",
    "run-candidate",
    "agent:orchestrator:subagent:candidate",
    "flow-candidate",
    "Candidate task",
    "succeeded",
    "failed",
    "done_only",
    100,
    200,
    200,
    "Required completion delivery failed before reaching the requester: Error: CLI transcript compaction failed for openai/gpt-5.4: Summarization failed: Connection error.",
    "blocked",
  );
  db.prepare(
    `INSERT INTO flow_runs (
      flow_id, owner_key, revision, status, notify_policy, goal, current_step, blocked_task_id,
      blocked_summary, created_at, updated_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "flow-candidate",
    "agent:main:main",
    0,
    "blocked",
    "done_only",
    "Candidate task",
    "waiting",
    "task-candidate",
    "Required completion delivery failed before reaching the requester: Error: CLI transcript compaction failed for openai/gpt-5.4: Summarization failed: Connection error.",
    100,
    200,
    200,
  );
  db.prepare(
    `INSERT INTO subagent_runs (
      run_id, child_session_key, requester_session_key, requester_display_key, task, cleanup,
      created_at, pending_final_delivery, pending_final_delivery_attempt_count,
      pending_final_delivery_last_error, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "run-candidate",
    "agent:orchestrator:subagent:candidate",
    "agent:main:main",
    "agent:main:main",
    "Candidate task",
    "keep",
    100,
    1,
    3,
    "Error: CLI transcript compaction failed for openai/gpt-5.4: Summarization failed: Connection error.",
    JSON.stringify({
      runId: "run-candidate",
      childSessionKey: "agent:orchestrator:subagent:candidate",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "Candidate task",
      cleanup: "keep",
      createdAt: 100,
      expectsCompletionMessage: true,
      delivery: {
        status: "suspended",
        suspendedReason: "retry-limit",
        lastError:
          "Error: CLI transcript compaction failed for openai/gpt-5.4: Summarization failed: Connection error.",
        payload: {
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "agent:main:main",
          childSessionKey: "agent:orchestrator:subagent:candidate",
          childRunId: "run-candidate",
          task: "Candidate task",
        },
      },
    }),
  );
  db.prepare(
    `INSERT INTO task_runs (
      task_id, runtime, requester_session_key, owner_key, scope_kind, run_id, task, status,
      delivery_status, notify_policy, created_at, ended_at, last_event_at, terminal_summary,
      terminal_outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "task-real-blocker",
    "subagent",
    "agent:main:main",
    "agent:main:main",
    "session",
    "run-real",
    "Real blocker task",
    "succeeded",
    "failed",
    "done_only",
    100,
    200,
    200,
    "Writable session required.",
    "blocked",
  );
  if (options?.includeOrphanFlow !== false) {
    db.prepare(
      `INSERT INTO flow_runs (
        flow_id, owner_key, revision, status, notify_policy, goal, current_step, blocked_task_id,
        blocked_summary, created_at, updated_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "flow-orphan",
      "agent:main:main",
      0,
      "blocked",
      "done_only",
      "Orphan delivery blocker",
      "waiting",
      "task-missing",
      "Required completion delivery failed before reaching the requester: announce deferred or direct delivery failed.",
      100,
      200,
      200,
    );
  }
  if (options?.includeSkippedDebt !== false) {
    db.prepare(
      `INSERT INTO subagent_runs (
        run_id, child_session_key, requester_session_key, requester_display_key, task, cleanup,
        created_at, pending_final_delivery, pending_final_delivery_attempt_count,
        pending_final_delivery_last_error, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-pending",
      "agent:orchestrator:subagent:pending",
      "agent:main:main",
      "agent:main:main",
      "Pending debt task",
      "keep",
      100,
      1,
      1,
      "waiting for requester turn",
      JSON.stringify({
        runId: "run-pending",
        childSessionKey: "agent:orchestrator:subagent:pending",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        task: "Pending debt task",
        cleanup: "keep",
        createdAt: 100,
        delivery: {
          status: "pending",
          lastError: "waiting for requester turn",
        },
      }),
    );
  }
  closeOpenClawStateDatabaseForTest();
}

function readRow(dbPath: string, sql: string, ...args: (string | number | bigint | null)[]) {
  const database = openOpenClawStateDatabase({ path: dbPath });
  const row = database.db.prepare(sql).get(...args);
  closeOpenClawStateDatabaseForTest();
  return row;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("task-delivery-remediation", () => {
  it("dry-run inventories only the old delivery-failure poison seam and skips unproven rows", () => {
    const paths = createTempPaths("task-delivery-remediation-dry-run-");
    seedCandidateState(paths.dbPath);

    const result = runHistoricalDeliveryFailureRemediation({
      mode: "dry-run",
      path: paths.dbPath,
      receiptDir: paths.receiptDir,
      now: Date.UTC(2026, 5, 12, 21, 7, 0),
    });

    expect(result.receipt.candidates).toEqual({
      taskRuns: 1,
      flowRuns: 1,
      subagentRuns: 1,
    });
    expect(result.receipt.skipped.total).toBe(2);
    expect(result.receipt.skipped.byReason).toMatchObject({
      missing_succeeded_blocked_task_proof: 1,
      payload_not_suspended_retry_limit: 1,
    });
    expect(result.receipt.before).toEqual({
      blockedDeliveryFlows: 2,
      pendingFinalDeliveryRuns: 2,
      succeededBlockedTasks: 2,
    });
    expect(result.receipt.after).toEqual(result.receipt.before);
    expect(fs.existsSync(result.receipt.receiptPath)).toBe(true);
  });

  it("refuses write mode without a verified snapshot path", () => {
    const paths = createTempPaths("task-delivery-remediation-no-snapshot-");
    seedCandidateState(paths.dbPath);

    expect(() =>
      runHistoricalDeliveryFailureRemediation({
        mode: "write",
        path: paths.dbPath,
        receiptDir: paths.receiptDir,
        now: Date.UTC(2026, 5, 12, 21, 8, 0),
      }),
    ).toThrow("Write mode requires a verified snapshot path.");
  });

  it("writes a governed repair, preserves delivery evidence, and is idempotent on rerun", () => {
    const paths = createTempPaths("task-delivery-remediation-write-");
    seedCandidateState(paths.dbPath, { includeOrphanFlow: false, includeSkippedDebt: false });

    const first = runHistoricalDeliveryFailureRemediation({
      mode: "write",
      path: paths.dbPath,
      receiptDir: paths.receiptDir,
      snapshotPath: paths.snapshotPath,
      now: Date.UTC(2026, 5, 12, 21, 9, 0),
    });

    expect(fs.existsSync(paths.snapshotPath)).toBe(true);
    expect(fs.existsSync(first.receipt.receiptPath)).toBe(true);
    expect(first.receipt.repaired).toEqual({
      taskRuns: 1,
      flowRuns: 1,
      subagentRuns: 1,
    });
    expect(first.receipt.after).toEqual({
      blockedDeliveryFlows: 0,
      pendingFinalDeliveryRuns: 0,
      succeededBlockedTasks: 1,
    });

    const repairedTask = readRow(
      paths.dbPath,
      `SELECT terminal_outcome, delivery_status, terminal_summary
         FROM task_runs
        WHERE task_id = 'task-candidate'`,
    ) as {
      terminal_outcome: string | null;
      delivery_status: string;
      terminal_summary: string | null;
    };
    expect(repairedTask).toEqual({
      terminal_outcome: "succeeded",
      delivery_status: "failed",
      terminal_summary:
        "Required completion delivery failed before reaching the requester: Error: CLI transcript compaction failed for openai/gpt-5.4: Summarization failed: Connection error.",
    });

    const repairedFlow = readRow(
      paths.dbPath,
      `SELECT status, blocked_task_id, blocked_summary
         FROM flow_runs
        WHERE flow_id = 'flow-candidate'`,
    ) as {
      status: string;
      blocked_task_id: string | null;
      blocked_summary: string | null;
    };
    expect(repairedFlow).toEqual({
      status: "succeeded",
      blocked_task_id: null,
      blocked_summary: null,
    });

    const repairedSubagent = readRow(
      paths.dbPath,
      `SELECT
         pending_final_delivery,
         json_extract(payload_json, '$.delivery.status') AS payload_delivery_status,
         json_extract(payload_json, '$.delivery.suspendedReason') AS payload_suspended_reason,
         json_extract(payload_json, '$.delivery.lastError') AS payload_last_error
       FROM subagent_runs
       WHERE run_id = 'run-candidate'`,
    ) as {
      pending_final_delivery: number;
      payload_delivery_status: string | null;
      payload_suspended_reason: string | null;
      payload_last_error: string | null;
    };
    expect(repairedSubagent).toEqual({
      pending_final_delivery: 0,
      payload_delivery_status: "suspended",
      payload_suspended_reason: "retry-limit",
      payload_last_error:
        "Error: CLI transcript compaction failed for openai/gpt-5.4: Summarization failed: Connection error.",
    });

    const backupCount = readRow(paths.dbPath, `SELECT COUNT(*) AS count FROM backup_runs`) as {
      count: number;
    };
    expect(backupCount.count).toBe(1);

    const second = runHistoricalDeliveryFailureRemediation({
      mode: "write",
      path: paths.dbPath,
      receiptDir: paths.receiptDir,
      snapshotPath: planHistoricalDeliveryFailureSnapshotPath(
        paths.dbPath,
        Date.UTC(2026, 5, 12, 21, 10, 0),
      ),
      now: Date.UTC(2026, 5, 12, 21, 10, 0),
    });
    expect(second.receipt.candidates).toEqual({
      taskRuns: 0,
      flowRuns: 0,
      subagentRuns: 0,
    });
    expect(second.receipt.repaired).toEqual({
      taskRuns: 0,
      flowRuns: 0,
      subagentRuns: 0,
    });
  });
});
