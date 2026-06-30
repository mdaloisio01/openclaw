import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export type PendingFinalDeliveryPayload = {
  sourceTurnId?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  childSessionKey: string;
  childRunId: string;
  task: string;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  frozenResultText?: string | null;
  fallbackFrozenResultText?: string | null;
  wakeOnDescendantSettle?: boolean;
};

export type SubagentExecutionState = {
  status: "running" | "interrupted" | "terminal";
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  interruptedAt?: number;
  interruptionReason?: "gateway-restart" | "lost-execution-context";
  transcriptFile?: string;
};

export type GrantCloseoutGateState = {
  applies: boolean;
  passed: boolean;
  reviewStatus?: "not_applicable" | "passed" | "rejected";
  outcomeCode?: string;
  assessedAt?: number;
  missingFields?: string[];
  missingProofPaths?: string[];
  requiresCorrectedCloseout?: boolean;
  materialProgressState?:
    | "closeout_not_applicable"
    | "closeout_review_passed"
    | "closeout_rejected";
  auditReceiptPath?: string;
  correctionCandidateQueuePath?: string;
  correctionCandidateQueuedAt?: number;
};

export type SubagentCompletionState = {
  required: boolean;
  resultText?: string | null;
  capturedAt?: number;
  fallbackResultText?: string | null;
  fallbackCapturedAt?: number;
  grantCloseoutGate?: GrantCloseoutGateState;
};

export type SubagentCompletionDeliveryState = {
  status:
    | "not_required"
    | "pending"
    | "in_progress"
    | "delivered"
    | "failed"
    | "suspended"
    | "discarded";
  payload?: PendingFinalDeliveryPayload;
  createdAt?: number;
  enqueuedAt?: number;
  deliveredAt?: number;
  announcedAt?: number;
  lastAttemptAt?: number;
  attemptCount?: number;
  lastError?: string | null;
  steeringLeaseId?: string;
  steeringLeasedAt?: number;
  steeringInjectedAt?: number;
  suspendedAt?: number;
  suspendedReason?: "retry-limit" | "expiry";
  discardedAt?: number;
  discardReason?: "expired" | "pressure-pruned";
  discardedPayloadSummary?: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    childRunId?: string;
    endedAt?: number;
    status?: string;
    lastError?: string | null;
  };
  lastDropReason?:
    | "queue_cap"
    | "parent_run_ended"
    | "sink_unavailable"
    | "dedupe"
    | "waiting_for_requester_turn";
};

export type SubagentProductionContinuationState = {
  activeProductionRun?: boolean;
  continuationRequiredAfterLocalSuccess?: boolean;
  nextExecutableUnitIdentified?: boolean;
  nextExecutableUnitLaunched?: boolean;
  continuationViolation?: boolean;
  lawfulStopReason?: string;
  parentFlowId?: string;
};

export type SubagentParentYieldWaitState = {
  waitId: string;
  sourceTurnId?: string;
  parentSessionKey: string;
  parentRunId?: string;
  reason?: string;
  expectedChildRunIds: string[];
  childSessionKeys: string[];
  waitStartedAt: number;
  staleAt: number;
  requiredCloseout: boolean;
  status: "waiting" | "ready_to_resume" | "continuation_scheduled";
  terminalChildRunIds?: string[];
  continuationScheduledAt?: number;
  lastUpdatedAt?: number;
};

export type SubagentRunRecord = {
  runId: string;
  sourceTurnId?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;
  createdAt: number;
  startedAt?: number;
  sessionStartedAt?: number;
  accumulatedRuntimeMs?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  expectsCompletionMessage?: boolean;
  endedReason?: SubagentLifecycleEndedReason;
  pauseReason?: "sessions_yield";
  wakeOnDescendantSettle?: boolean;
  execution?: SubagentExecutionState;
  completion?: SubagentCompletionState;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  /** Set after cleanupBrowserSessionsForLifecycleEnd has been dispatched once. */
  browserCleanupDispatchedAt?: number;
  /** Durable outbox marker for parent/external completion delivery. */
  delivery?: SubagentCompletionDeliveryState;
  productionContinuation?: SubagentProductionContinuationState;
  parentYieldWait?: SubagentParentYieldWaitState;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
};
