import type { EvidenceReceipt, MissionMode } from "./mission-manifest.types.js";

export const GOVERNED_RECEIPT_KINDS = [
  "admission",
  "policy_decision",
  "tool_call",
  "exec_call",
  "evidence",
  "violation",
  "supervisor",
  "closeout",
  "release",
  "override",
  "rollback",
] as const;

export type GovernedReceiptKind = (typeof GOVERNED_RECEIPT_KINDS)[number];

export const GOVERNED_REQUIRED_RECEIPT_KINDS = GOVERNED_RECEIPT_KINDS;

export const GOVERNED_MISSION_FAILURE_STATES = [
  "DENIED_POLICY",
  "FAILED_PRECONDITION",
  "FAILED_CONTRACT",
  "FAILED_VALIDATION",
  "FAILED_TOOL",
  "FAILED_SUPERVISOR",
  "TIMED_OUT",
  "CANCELLED",
  "LOST",
  "BLOCKED",
  "SUCCEEDED",
  "FAILED_ENFORCEMENT_HEALTH",
] as const;

export type GovernedMissionFailureState = (typeof GOVERNED_MISSION_FAILURE_STATES)[number];

export const GOVERNED_MISSION_LOCK_STATES = [
  "GOVERNED_MISSION_PENDING_OVERRIDE",
  "AWAITING_CLOSEOUT",
] as const;

export type GovernedMissionLockState = (typeof GOVERNED_MISSION_LOCK_STATES)[number];

export type GovernedAuthorityRef = {
  refId: string;
  kind:
    | "sop"
    | "build_plan"
    | "work_order"
    | "operator_approval"
    | "policy"
    | "source_lock"
    | "runtime_lock";
  uri: string;
  sha256?: string;
};

export type GovernedCompletionOwner =
  | "task_flow"
  | "task_registry"
  | "governed_mission_state"
  | "release_gate";

export type GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1";
  missionId: string;
  contractId: string;
  contractVersion: string;
  contractHash: string;
  authorityHash: string;
  authorityRefs: GovernedAuthorityRef[];
  admissionReceiptRef: string;
  planRevisionId: string;
  sourceRevision: string;
  runtimeBuildSha256: string;
  policyVersion: string;
  mode: MissionMode;
  authoritativeCompletionOwner: GovernedCompletionOwner;
  requiredReceiptKinds: GovernedReceiptKind[];
  createdAt: string;
};

export type GovernedReceiptBase = {
  missionId: string;
  contractId: string;
  contractVersion: string;
  contractHash: string;
  authorityHash: string;
  receiptId: string;
  receiptKind: GovernedReceiptKind;
  producedAt: string;
  producer: string;
};

export type AdmissionReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_admission_receipt.v1";
  receiptKind: "admission";
  admitted: boolean;
  reason: string;
};

export type PolicyDecisionReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_policy_decision_receipt.v1";
  receiptKind: "policy_decision";
  decision: "allow" | "deny" | "requires_override";
  policyRuleId: string;
  reason: string;
};

export type ToolCallReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_tool_call_receipt.v1";
  receiptKind: "tool_call";
  toolName: string;
  decisionReceiptRef: string;
  outcome: "allowed" | "denied" | "failed";
};

export type ExecCallReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_exec_call_receipt.v1";
  receiptKind: "exec_call";
  commandHash: string;
  decisionReceiptRef: string;
  outcome: "allowed" | "denied" | "failed";
};

export type ViolationReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_violation_receipt.v1";
  receiptKind: "violation";
  violationCode: string;
  blocked: boolean;
  evidenceRefs: string[];
};

export type SupervisorReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_supervisor_receipt.v1";
  receiptKind: "supervisor";
  state: "running" | "healthy" | "stale" | "lost" | "terminal";
  evidenceRefs: string[];
};

export type CloseoutReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_closeout_receipt.v1";
  receiptKind: "closeout";
  passed: boolean;
  evidenceRefs: string[];
  failureState?: GovernedMissionFailureState;
};

export type ReleaseReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_release_receipt.v1";
  receiptKind: "release";
  releaseAllowed: boolean;
  releaseStateHash: string;
  closeoutReceiptRef: string;
};

export type OverrideReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_override_receipt.v1";
  receiptKind: "override";
  overrideId: string;
  approved: boolean;
  approverRef: string;
  scopeHash: string;
  expiresAt?: string;
};

export type RollbackGovernedReceipt = GovernedReceiptBase & {
  schema: "openclaw.governed_rollback_receipt.v1";
  receiptKind: "rollback";
  rollbackPlanRef: string;
  rollbackReady: boolean;
};

export type GovernedMissionReceipt =
  | AdmissionReceipt
  | PolicyDecisionReceipt
  | ToolCallReceipt
  | ExecCallReceipt
  | (EvidenceReceipt & { receiptKind?: "evidence" })
  | ViolationReceipt
  | SupervisorReceipt
  | CloseoutReceipt
  | ReleaseReceipt
  | OverrideReceipt
  | RollbackGovernedReceipt;

export type GovernedMissionCompletionRule = {
  schema: "openclaw.governed_mission_completion_rule.v1";
  authoritativeCompletionOwner: GovernedCompletionOwner;
  succeededRequiresCloseoutPassed: true;
  succeededRequiresReleasePassedForGovernedFinalOutput: true;
  succeededRequiresNoUnresolvedBlockingState: true;
  independentSuccessOwnersForbidden: true;
};

export const GOVERNED_MISSION_COMPLETION_RULE: GovernedMissionCompletionRule = {
  schema: "openclaw.governed_mission_completion_rule.v1",
  authoritativeCompletionOwner: "governed_mission_state",
  succeededRequiresCloseoutPassed: true,
  succeededRequiresReleasePassedForGovernedFinalOutput: true,
  succeededRequiresNoUnresolvedBlockingState: true,
  independentSuccessOwnersForbidden: true,
};

export function missingGovernedContractFoundationFields(
  contract: Partial<GovernedMissionContract>,
): string[] {
  const missing: string[] = [];
  const requiredStringFields: Array<keyof GovernedMissionContract> = [
    "missionId",
    "contractId",
    "contractVersion",
    "contractHash",
    "authorityHash",
    "admissionReceiptRef",
    "planRevisionId",
    "sourceRevision",
    "runtimeBuildSha256",
    "policyVersion",
    "createdAt",
  ];
  for (const field of requiredStringFields) {
    const value = contract[field];
    if (typeof value !== "string" || !value.trim()) {
      missing.push(field);
    }
  }
  if (!contract.authoritativeCompletionOwner) {
    missing.push("authoritativeCompletionOwner");
  }
  if (!Array.isArray(contract.authorityRefs) || contract.authorityRefs.length === 0) {
    missing.push("authorityRefs");
  }
  const receiptKinds = new Set(contract.requiredReceiptKinds ?? []);
  for (const kind of GOVERNED_REQUIRED_RECEIPT_KINDS) {
    if (!receiptKinds.has(kind)) {
      missing.push(`requiredReceiptKinds.${kind}`);
    }
  }
  return missing;
}
