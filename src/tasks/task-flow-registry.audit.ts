import { readGovernedMissionStateFromTaskFlow } from "../governance/governed-mission-state.js";
import { listTasksForFlowId } from "./runtime-internal.js";
import {
  getTaskFlowProductionContinuation,
  getTaskFlowRegistryRestoreFailure,
  listTaskFlowRecords,
} from "./task-flow-registry.js";
import {
  hasCanonicalGovernedMissionProvenanceFromSqlite,
  hasGovernedMissionClaimForFlow,
  hasGovernedMissionRepairReceiptFromSqlite,
} from "./task-flow-registry.store.sqlite.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskFlowAuditSeverity = "warn" | "error";
export type TaskFlowAuditCode =
  | "restore_failed"
  | "stale_queued"
  | "stale_running"
  | "stale_waiting"
  | "stale_blocked"
  | "cancel_stuck"
  | "missing_linked_tasks"
  | "blocked_task_missing"
  | "inconsistent_timestamps"
  | "continuation_required_not_launched"
  | "governed_admission_receipt_missing"
  | "governed_state_malformed"
  | "governed_flow_identity_mismatch"
  | "governed_repair_required"
  | "governed_terminal_proof_missing"
  | "governed_release_inconsistent";

export type TaskFlowAuditFinding = {
  severity: TaskFlowAuditSeverity;
  code: TaskFlowAuditCode;
  detail: string;
  ageMs?: number;
  flow?: TaskFlowRecord;
};

export type TaskFlowAuditSummary = {
  total: number;
  warnings: number;
  errors: number;
  byCode: Record<TaskFlowAuditCode, number>;
};

export type TaskFlowAuditOptions = {
  now?: number;
  flows?: TaskFlowRecord[];
  staleQueuedMs?: number;
  staleRunningMs?: number;
  staleWaitingMs?: number;
  staleBlockedMs?: number;
  cancelStuckMs?: number;
};

const DEFAULT_STALE_QUEUED_MS = 30 * 60_000;
const DEFAULT_STALE_RUNNING_MS = 30 * 60_000;
const DEFAULT_STALE_WAITING_MS = 30 * 60_000;
const DEFAULT_STALE_BLOCKED_MS = 30 * 60_000;
const DEFAULT_CANCEL_STUCK_MS = 5 * 60_000;

function createFinding(params: {
  severity: TaskFlowAuditSeverity;
  code: TaskFlowAuditCode;
  detail: string;
  ageMs?: number;
  flow?: TaskFlowRecord;
}): TaskFlowAuditFinding {
  return {
    severity: params.severity,
    code: params.code,
    detail: params.detail,
    ...(typeof params.ageMs === "number" ? { ageMs: params.ageMs } : {}),
    ...(params.flow ? { flow: params.flow } : {}),
  };
}

function severityRank(severity: TaskFlowAuditSeverity): number {
  return severity === "error" ? 0 : 1;
}

function compareFindings(left: TaskFlowAuditFinding, right: TaskFlowAuditFinding): number {
  const severityDiff = severityRank(left.severity) - severityRank(right.severity);
  if (severityDiff !== 0) {
    return severityDiff;
  }
  const leftAge = left.ageMs ?? -1;
  const rightAge = right.ageMs ?? -1;
  if (leftAge !== rightAge) {
    return rightAge - leftAge;
  }
  return (left.flow?.createdAt ?? 0) - (right.flow?.createdAt ?? 0);
}

function getReferenceAt(flow: TaskFlowRecord): number {
  return flow.updatedAt ?? flow.createdAt;
}

function getLinkedTasks(flowId: string): TaskRecord[] {
  return listTasksForFlowId(flowId);
}

function hasBlockingMetadata(flow: TaskFlowRecord): boolean {
  return Boolean(
    flow.blockedTaskId?.trim() || flow.blockedSummary?.trim() || flow.waitJson != null,
  );
}

function findTimestampInconsistency(flow: TaskFlowRecord): TaskFlowAuditFinding | null {
  if (flow.updatedAt < flow.createdAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      flow,
      detail: "updatedAt is earlier than createdAt",
    });
  }
  if (flow.endedAt && flow.endedAt < flow.createdAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      flow,
      detail: "endedAt is earlier than createdAt",
    });
  }
  if (flow.endedAt && flow.endedAt < flow.updatedAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      flow,
      detail: "endedAt is earlier than updatedAt",
    });
  }
  return null;
}

export function createEmptyTaskFlowAuditSummary(): TaskFlowAuditSummary {
  return {
    total: 0,
    warnings: 0,
    errors: 0,
    byCode: {
      restore_failed: 0,
      stale_queued: 0,
      stale_running: 0,
      stale_waiting: 0,
      stale_blocked: 0,
      cancel_stuck: 0,
      missing_linked_tasks: 0,
      blocked_task_missing: 0,
      inconsistent_timestamps: 0,
      continuation_required_not_launched: 0,
      governed_admission_receipt_missing: 0,
      governed_state_malformed: 0,
      governed_flow_identity_mismatch: 0,
      governed_repair_required: 0,
      governed_terminal_proof_missing: 0,
      governed_release_inconsistent: 0,
    },
  };
}

export function listTaskFlowAuditFindings(
  options: TaskFlowAuditOptions = {},
): TaskFlowAuditFinding[] {
  const flows = options.flows ?? listTaskFlowRecords();
  const now = options.now ?? Date.now();
  const staleQueuedMs = options.staleQueuedMs ?? DEFAULT_STALE_QUEUED_MS;
  const staleRunningMs = options.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
  const staleWaitingMs = options.staleWaitingMs ?? DEFAULT_STALE_WAITING_MS;
  const staleBlockedMs = options.staleBlockedMs ?? DEFAULT_STALE_BLOCKED_MS;
  const cancelStuckMs = options.cancelStuckMs ?? DEFAULT_CANCEL_STUCK_MS;
  const findings: TaskFlowAuditFinding[] = [];

  const restoreFailure = getTaskFlowRegistryRestoreFailure();
  if (restoreFailure) {
    findings.push(
      createFinding({
        severity: "error",
        code: "restore_failed",
        detail: `task-flow registry restore failed: ${restoreFailure}`,
      }),
    );
  }

  for (const flow of flows) {
    const referenceAt = getReferenceAt(flow);
    const ageMs = Math.max(0, now - referenceAt);
    const linkedTasks = getLinkedTasks(flow.flowId);
    const activeTasks = linkedTasks.filter(
      (task) => task.status === "queued" || task.status === "running",
    );

    if (flow.status === "queued" && ageMs >= staleQueuedMs) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "stale_queued",
          flow,
          ageMs,
          detail: "queued TaskFlow has not advanced recently",
        }),
      );
    }

    if (flow.status === "running" && ageMs >= staleRunningMs) {
      findings.push(
        createFinding({
          severity: "error",
          code: "stale_running",
          flow,
          ageMs,
          detail: "running TaskFlow has not advanced recently",
        }),
      );
    }

    if (flow.status === "waiting" && ageMs >= staleWaitingMs) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "stale_waiting",
          flow,
          ageMs,
          detail: "waiting TaskFlow has not advanced recently",
        }),
      );
    }

    if (flow.status === "blocked" && ageMs >= staleBlockedMs) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "stale_blocked",
          flow,
          ageMs,
          detail: "blocked TaskFlow has not advanced recently",
        }),
      );
    }

    if (
      flow.cancelRequestedAt != null &&
      flow.status !== "cancelled" &&
      flow.status !== "failed" &&
      flow.status !== "succeeded" &&
      flow.status !== "lost" &&
      activeTasks.length === 0 &&
      now - flow.cancelRequestedAt >= cancelStuckMs
    ) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "cancel_stuck",
          flow,
          ageMs: Math.max(0, now - flow.cancelRequestedAt),
          detail: "cancel-requested TaskFlow has no active child tasks but is still nonterminal",
        }),
      );
    }

    if (
      flow.syncMode === "managed" &&
      (flow.status === "queued" ||
        flow.status === "running" ||
        flow.status === "waiting" ||
        flow.status === "blocked") &&
      ageMs >=
        (flow.status === "queued"
          ? staleQueuedMs
          : flow.status === "running"
            ? staleRunningMs
            : flow.status === "waiting"
              ? staleWaitingMs
              : staleBlockedMs) &&
      linkedTasks.length === 0 &&
      !hasBlockingMetadata(flow)
    ) {
      findings.push(
        createFinding({
          severity: flow.status === "running" ? "error" : "warn",
          code: "missing_linked_tasks",
          flow,
          ageMs,
          detail:
            flow.status === "queued"
              ? "managed queued TaskFlow has no executor proof, linked tasks, or wait state"
              : "managed TaskFlow has no linked tasks or wait state",
        }),
      );
    }

    if (flow.blockedTaskId?.trim()) {
      const blockedTaskId = flow.blockedTaskId.trim();
      if (!linkedTasks.some((task) => task.taskId === blockedTaskId)) {
        findings.push(
          createFinding({
            severity: "warn",
            code: "blocked_task_missing",
            flow,
            ageMs,
            detail: `blocked TaskFlow points at missing task ${blockedTaskId}`,
          }),
        );
      }
    }

    const continuation = getTaskFlowProductionContinuation(flow);
    if (
      continuation?.activeProductionRun === true &&
      continuation.continuationRequiredAfterLocalSuccess &&
      !continuation.nextExecutableUnitLaunched
    ) {
      findings.push(
        createFinding({
          severity: "error",
          code: "continuation_required_not_launched",
          flow,
          ageMs,
          detail:
            "active production continuation requires the next executable unit to launch before this flow can pause or close",
        }),
      );
    }

    const governedState = readGovernedMissionStateFromTaskFlow(flow);
    if (!governedState && hasGovernedMissionClaimForFlow(flow)) {
      findings.push(
        createFinding({
          severity: "error",
          code: "governed_state_malformed",
          flow,
          detail: "governed mission state is present but malformed and requires repair",
        }),
      );
    }
    if (governedState) {
      if (governedState.ownerCorrelation.taskFlowId !== flow.flowId) {
        findings.push(
          createFinding({
            severity: "error",
            code: "governed_flow_identity_mismatch",
            flow,
            detail: "governed mission state is bound to a different TaskFlow identity",
          }),
        );
      }
      if (
        !hasCanonicalGovernedMissionProvenanceFromSqlite({
          flow,
          missionId: governedState.missionId,
        })
      ) {
        findings.push(
          createFinding({
            severity: "error",
            code: "governed_admission_receipt_missing",
            flow,
            detail:
              "governed mission state has no canonical SQLite admission and current-state provenance",
          }),
        );
      }
      const hasOpenRepairReceipt = hasGovernedMissionRepairReceiptFromSqlite({
        flowId: flow.flowId,
        resultingRevision: governedState.revision,
      });
      const canonicalRepairState =
        governedState.currentGovernedState === "repair_required" ||
        governedState.currentGovernedState === "readmission_required";
      if (canonicalRepairState || hasOpenRepairReceipt) {
        const detail = canonicalRepairState
          ? `${governedState.currentGovernedState}: ${governedState.blockedStatus}`
          : "current revision has an unresolved repair-required decision";
        findings.push(
          createFinding({
            severity: "warn",
            code: "governed_repair_required",
            flow,
            detail: `governed transition requires repair: ${detail}`,
          }),
        );
      }
      if (
        governedState.currentGovernedState === "terminal_pending_watchdog" &&
        governedState.proofs.postTerminalWatchdog !== "passed"
      ) {
        findings.push(
          createFinding({
            severity: "error",
            code: "governed_terminal_proof_missing",
            flow,
            detail: "terminal-pending governed mission lacks fresh bound post-terminal proof",
          }),
        );
      }
      const governedReleaseComplete =
        governedState.currentGovernedState === "released" &&
        governedState.proofs.delivery !== "pending" &&
        governedState.proofs.delivery !== "failed";
      if (governedReleaseComplete !== (flow.status === "succeeded")) {
        findings.push(
          createFinding({
            severity: "error",
            code: "governed_release_inconsistent",
            flow,
            detail: "governed release state and TaskFlow terminal state disagree",
          }),
        );
      }
    }

    const inconsistency = findTimestampInconsistency(flow);
    if (inconsistency) {
      findings.push(inconsistency);
    }
  }

  return findings.toSorted(compareFindings);
}

export function summarizeTaskFlowAuditFindings(
  findings: Iterable<TaskFlowAuditFinding>,
): TaskFlowAuditSummary {
  const summary = createEmptyTaskFlowAuditSummary();
  for (const finding of findings) {
    summary.total += 1;
    summary.byCode[finding.code] += 1;
    if (finding.severity === "error") {
      summary.errors += 1;
    } else {
      summary.warnings += 1;
    }
  }
  return summary;
}
