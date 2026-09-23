import type { JsonValue, TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { TaskDeliveryState, TaskRecord } from "../tasks/task-registry.types.js";
import type { GovernedReceiptKind } from "./governed-mission-contract.js";

export const GOVERNED_MISSION_RUNTIME_PRODUCER = "openclaw.governed_mission_runtime.v1";

export const GOVERNED_MISSION_RECEIPT_KINDS = [
  "transition",
  "artifact_verification",
  "watchdog_observation",
  "release",
  "delivery",
  "false_closeout",
  "durability_obligation",
  "legacy_import",
] as const;

export type GovernedMissionReceiptKind = (typeof GOVERNED_MISSION_RECEIPT_KINDS)[number];

export type GovernedMissionLedgerReceipt = {
  receiptId: string;
  missionId: string;
  flowId?: string;
  runId?: string;
  workOrderId?: string;
  gateId?: string;
  attemptId?: string;
  operation: string;
  receiptKind: GovernedMissionReceiptKind;
  fromState?: string;
  toState?: string;
  decision: string;
  reasonCode: string;
  expectedRevision?: number;
  resultingRevision?: number;
  contractId?: string;
  contractHash?: string;
  authorityHash?: string;
  planRevisionId?: string;
  sourceRevision?: string;
  runtimeBuildSha256?: string;
  policyVersion?: string;
  skillSha256?: string;
  payloadSha256: string;
  contractReceiptKinds?: GovernedReceiptKind[];
  ledgerSequence?: number;
  previousReceiptSha256?: string;
  governedPackageSha256?: string;
  receiptSha256?: string;
  producer: string;
  idempotencyKey: string;
  details: JsonValue;
  createdAt: number;
};

export type GovernedMissionArtifactLedgerRecord = {
  verificationId: string;
  receiptId: string;
  missionId: string;
  flowId?: string;
  workOrderId?: string;
  gateId?: string;
  logicalArtifactId: string;
  artifactKind: string;
  locator: string;
  status: "verified" | "optional_missing" | "rejected";
  failureCode?: string;
  sizeBytes?: number;
  computedSha256?: string;
  expectedSha256?: string;
  expectedLabels: string[];
  identityBindings: JsonValue;
  verifierVersion: string;
  verifiedAt: number;
};

export type GovernedMissionLedgerCommit = {
  receipt: GovernedMissionLedgerReceipt;
  nextFlow?: TaskFlowRecord;
  expectedFlowRevision?: number;
  taskUpdate?: TaskRecord;
  taskDeliveryState?: TaskDeliveryState;
  artifacts?: GovernedMissionArtifactLedgerRecord[];
  governedOwnerClaimKey?: string;
  terminalAdmissionPreconditionSha256?: string;
  requireNoActiveTasks?: boolean;
};

export type GovernedMissionLedgerCommitResult =
  | { status: "inserted"; receipt: GovernedMissionLedgerReceipt }
  | { status: "already_applied"; receipt: GovernedMissionLedgerReceipt }
  | { status: "mission_conflict"; receipt: GovernedMissionLedgerReceipt }
  | {
      status: "owner_conflict";
      flowId: string;
      receipt: GovernedMissionLedgerReceipt;
    }
  | { status: "idempotency_conflict"; receipt: GovernedMissionLedgerReceipt }
  | {
      status: "revision_conflict";
      currentRevision?: number;
      reason?: "active_work" | "untrusted_state";
    };
