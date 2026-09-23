import type { EvidenceReceipt, MissionMode } from "./mission-manifest.types.js";
import type { CompiledMissionPlan } from "./mission-plan-compiler.js";

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

export const GOVERNED_REQUIRED_RECEIPT_KINDS = [
  "admission",
  "policy_decision",
  "evidence",
  "supervisor",
  "closeout",
  "release",
] as const satisfies readonly GovernedReceiptKind[];

export const GOVERNED_RUNTIME_RECEIPT_KINDS = [
  ...GOVERNED_REQUIRED_RECEIPT_KINDS,
  "rollback",
] as const satisfies readonly GovernedReceiptKind[];

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
  "pending_override",
  "closeout_ready",
  "artifact_verified",
  "terminal_pending_watchdog",
  "released",
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

const GOVERNED_AUTHORITY_REF_KINDS = new Set<GovernedAuthorityRef["kind"]>([
  "sop",
  "build_plan",
  "work_order",
  "operator_approval",
  "policy",
  "source_lock",
  "runtime_lock",
]);

const GOVERNED_MISSION_MODES = new Set<MissionMode>(["shadow", "enforce", "off"]);

export function isGovernedAuthorityRefPinnedToContract(
  contract: Pick<GovernedMissionContract, "authorityHash" | "authorityRefs">,
  authorityRef: GovernedAuthorityRef,
): boolean {
  if (
    !isGovernedAuthorityRef(authorityRef) ||
    !Array.isArray(contract.authorityRefs) ||
    typeof contract.authorityHash !== "string"
  ) {
    return false;
  }
  return (
    authorityRef.sha256 === contract.authorityHash &&
    contract.authorityRefs.some(
      (candidate) =>
        isGovernedAuthorityRef(candidate) &&
        candidate.refId === authorityRef.refId &&
        candidate.kind === authorityRef.kind &&
        candidate.uri === authorityRef.uri &&
        candidate.sha256 === authorityRef.sha256,
    )
  );
}

export type GovernedCompletionOwner = "governed_mission_state";

export type GovernedProofProducerKind = "implementation" | "validation" | "review" | "delivery";

export type GovernedProofProducers = Record<GovernedProofProducerKind, { deviceId: string }>;

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
  skillSha256: string;
  mode: MissionMode;
  authoritativeCompletionOwner: GovernedCompletionOwner;
  requiredReceiptKinds: GovernedReceiptKind[];
  proofProducers?: GovernedProofProducers;
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
  if (contract.schema !== "openclaw.governed_mission_contract.v1") {
    missing.push("schema.unsupported");
  }
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
    "skillSha256",
    "createdAt",
  ];
  for (const field of requiredStringFields) {
    const value = contract[field];
    if (typeof value !== "string" || !value.trim()) {
      missing.push(field);
    }
  }
  if (contract.authoritativeCompletionOwner !== "governed_mission_state") {
    missing.push("authoritativeCompletionOwner.unsupported");
  }
  if (!GOVERNED_MISSION_MODES.has(contract.mode as MissionMode)) {
    missing.push("mode.unsupported");
  }
  const authorityRefs = contract.authorityRefs;
  if (!Array.isArray(authorityRefs) || authorityRefs.length === 0) {
    missing.push("authorityRefs");
  } else {
    for (const [index, authorityRef] of authorityRefs.entries()) {
      if (!isGovernedAuthorityRef(authorityRef)) {
        missing.push(`authorityRefs.${index}.invalid`);
      }
    }
  }
  if (!Array.isArray(contract.requiredReceiptKinds)) {
    missing.push("requiredReceiptKinds");
  }
  if (contract.proofProducers !== undefined && !isGovernedProofProducers(contract.proofProducers)) {
    missing.push("proofProducers.invalid");
  }
  const receiptKinds = new Set(
    Array.isArray(contract.requiredReceiptKinds) ? contract.requiredReceiptKinds : [],
  );
  for (const kind of GOVERNED_REQUIRED_RECEIPT_KINDS) {
    if (!receiptKinds.has(kind)) {
      missing.push(`requiredReceiptKinds.${kind}`);
    }
  }
  const supportedReceiptKinds = new Set<string>(GOVERNED_RUNTIME_RECEIPT_KINDS);
  for (const kind of receiptKinds) {
    if (typeof kind !== "string" || !supportedReceiptKinds.has(kind)) {
      missing.push(`requiredReceiptKinds.unsupported.${kind}`);
    }
  }
  return missing;
}

export function isGovernedProofProducers(value: unknown): value is GovernedProofProducers {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const kinds: GovernedProofProducerKind[] = ["implementation", "validation", "review", "delivery"];
  if (Object.keys(record).length !== kinds.length) {
    return false;
  }
  return kinds.every((kind) => {
    const producer = record[kind];
    const deviceId = (producer as { deviceId?: unknown } | undefined)?.deviceId;
    return (
      producer !== null &&
      typeof producer === "object" &&
      !Array.isArray(producer) &&
      Object.keys(producer).length === 1 &&
      typeof deviceId === "string" &&
      deviceId.length > 0 &&
      deviceId === deviceId.trim()
    );
  });
}

export function governedMissionPlanCanSatisfyContract(
  contract: GovernedMissionContract,
  plan: CompiledMissionPlan,
): boolean {
  if (
    !Array.isArray(contract.requiredReceiptKinds) ||
    !contract.requiredReceiptKinds.includes("rollback")
  ) {
    return true;
  }
  return (
    Array.isArray(plan.gates) &&
    plan.gates.some((gate) => gate?.required && gate.kind === "rollback")
  );
}

function isGovernedAuthorityRef(value: unknown): value is GovernedAuthorityRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<GovernedAuthorityRef>;
  return (
    typeof candidate.refId === "string" &&
    candidate.refId.trim().length > 0 &&
    GOVERNED_AUTHORITY_REF_KINDS.has(candidate.kind as GovernedAuthorityRef["kind"]) &&
    typeof candidate.uri === "string" &&
    candidate.uri.trim().length > 0 &&
    (candidate.sha256 === undefined ||
      (typeof candidate.sha256 === "string" && candidate.sha256.trim().length > 0))
  );
}
