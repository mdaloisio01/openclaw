export type MissionMode = "shadow" | "enforce" | "off";

export type RequirementStatus = "pending" | "passed" | "failed" | "not_applicable";

export const MISSION_GATE_KINDS = [
  "requirement",
  "test",
  "rollback",
  "restoration",
  "grant_review",
  "export",
  "watchdog",
  "terminal_state",
  "contradiction",
  "next_step",
] as const;

export type GateKind = (typeof MISSION_GATE_KINDS)[number];

export type MissionIdentity = {
  missionId: string;
  planRevisionId: string;
  planSha256: string;
  sourceRevision: string;
  runtimeBuildSha256: string;
  policyVersion: string;
  skillSha256: string;
};

export type MissionManifest = MissionIdentity & {
  schema: "openclaw.mission_manifest.v1";
  packageId?: string;
  mode: MissionMode;
  scopeHash: string;
  authorizedScopeHash: string;
  planRevisionAuthorized: boolean;
  createdAt: string;
};

export type RequirementManifestItem = {
  id: string;
  text: string;
  required: boolean;
  gateIds: string[];
  dependsOn?: string[];
};

export type RequirementManifest = {
  schema: "openclaw.requirement_manifest.v1";
  missionId: string;
  planRevisionId: string;
  requirements: RequirementManifestItem[];
};

export type AcceptanceGate = {
  id: string;
  requirementId: string;
  kind: GateKind;
  required: boolean;
  freshnessMs?: number;
};

export type EvidenceReceipt = MissionIdentity & {
  schema: "openclaw.evidence_receipt.v1";
  receiptId: string;
  gateId: string;
  status: RequirementStatus;
  producedAt: string;
  artifactPath?: string;
  artifactSha256?: string;
  rawResultSha256?: string;
};

export type TestManifest = MissionIdentity & {
  schema: "openclaw.test_manifest.v1";
  requestedFiles: string[];
  expectedTotal: number;
};

export type RawTestResult = {
  file: string;
  passed: number;
  failed: number;
  skipped?: number;
  rawSha256?: string;
};

export type RollbackReceipt = MissionIdentity & {
  schema: "openclaw.rollback_receipt.v1";
  executed: boolean;
  producedAt: string;
  targetStateSha256?: string;
};

export type RestorationReceipt = MissionIdentity & {
  schema: "openclaw.restoration_receipt.v1";
  executed: boolean;
  producedAt: string;
  restoredStateSha256?: string;
};

export type GrantApprovalReceipt = MissionIdentity & {
  schema: "openclaw.grant_approval.v1";
  approved: boolean;
  approvedAt: string;
  evidenceManifestSha256: string;
  reviewer: "Grant";
};

export type ExportManifestItem = {
  path: string;
  sha256?: string;
  sizeBytes?: number;
  required: boolean;
};

export type ExportManifest = MissionIdentity & {
  schema: "openclaw.export_manifest.v1";
  items: ExportManifestItem[];
};

export type RuntimeCloseoutState = {
  parentStatus: "running" | "waiting" | "blocked" | "terminal_pending_watchdog" | "terminal";
  activeExecutorCount: number;
  staleExecutorCount: number;
  openSessionCount: number;
  openRunCount: number;
  openLeaseCount: number;
  openContinuationCount: number;
  pendingDeliveryCount: number;
  validPostCloseoutRoles?: string[];
};

export type WatchdogState = {
  label: string;
  suspiciousCount: number;
  checkedAt: string;
  postTerminal: boolean;
};

export type RepairWorkState = {
  openCount: number;
  openIds: string[];
};

export type CompletionTransition =
  | "completion_request -> terminal_pending_watchdog"
  | "terminal_pending_watchdog -> COMPLETE";

export type CompletionRequest = MissionIdentity & {
  schema: "openclaw.completion_request.v1";
  requestedAt: string;
  claimedScopeHash: string;
  closeoutText: string;
  closeoutSha256?: string;
  evidenceManifestSha256: string;
  requestedTransition?: CompletionTransition;
  previousDecisionReceiptSha256?: string;
  transitionalWatchdogReceiptSha256?: string;
  parentExecutorSnapshotSha256?: string;
};

export type CloseoutAdmissionInput = {
  manifest: MissionManifest;
  requirements: RequirementManifestItem[];
  gates: AcceptanceGate[];
  receipts: EvidenceReceipt[];
  testManifest?: TestManifest;
  testResults?: RawTestResult[];
  rollbackReceipt?: RollbackReceipt;
  restorationReceipt?: RestorationReceipt;
  grantApproval?: GrantApprovalReceipt;
  exportManifest?: ExportManifest;
  runtimeState: RuntimeCloseoutState;
  watchdog: WatchdogState;
  repairWork: RepairWorkState;
  completionRequest: CompletionRequest;
  nextExecutableStepExists: boolean;
  reportContradictions?: string[];
  now: string;
};

export type CompletionDecisionState =
  | "shadow_rejected"
  | "shadow_would_allow_terminal_pending_watchdog"
  | "off_bypassed_rejected"
  | "off_bypassed_terminal_pending_watchdog"
  | "rejected_repair_required"
  | "terminal_pending_watchdog"
  | "complete";

export type CompletionRejectionCode =
  | "FCAC_SCOPE_NARROWED"
  | "FCAC_PLAN_REVISION_UNAUTHORIZED"
  | "FCAC_REQUIREMENT_HAS_NO_GATE"
  | "FCAC_REQUIREMENT_MISSING_RECEIPT"
  | "FCAC_EVIDENCE_BOUND_TO_OTHER_REVISION"
  | "FCAC_EVIDENCE_STALE"
  | "FCAC_DEPENDENCY_OPEN"
  | "FCAC_TEST_MANIFEST_MISMATCH"
  | "FCAC_ROLLBACK_MISSING_OR_INVALID"
  | "FCAC_RESTORATION_MISSING_OR_INVALID"
  | "FCAC_GRANT_STALE_OR_MISSING"
  | "FCAC_EXPORT_MANIFEST_INCOMPLETE"
  | "FCAC_REPORT_RUNTIME_CONTRADICTION"
  | "FCAC_PARENT_RUNNING"
  | "FCAC_EXECUTOR_RUNNING_OR_STALE"
  | "FCAC_REPAIR_OPEN"
  | "FCAC_WATCHDOG_NOT_CLEAN"
  | "FCAC_POST_TERMINAL_WATCHDOG_MISSING"
  | "FCAC_TERMINAL_PENDING_RECEIPT_MISSING"
  | "FCAC_TRANSITIONAL_WATCHDOG_BINDING_MISSING"
  | "FCAC_PARENT_EXECUTOR_SNAPSHOT_MISSING"
  | "FCAC_NEXT_EXECUTABLE_STEP_EXISTS";

export type CompletionRejection = {
  code: CompletionRejectionCode;
  detail: string;
  requirementId?: string;
  gateId?: string;
};

export type CompletionDecision = {
  schema: "openclaw.completion_decision.v1";
  decisionId: string;
  missionId: string;
  planRevisionId: string;
  mode: MissionMode;
  state: CompletionDecisionState;
  allowed: boolean;
  rejectionCodes: CompletionRejectionCode[];
  rejections: CompletionRejection[];
  evaluatedAt: string;
  evidenceManifestSha256: string;
  authorizedTransition?: CompletionTransition;
};

export function identityMatches(receipt: MissionIdentity, manifest: MissionIdentity): boolean {
  return (
    receipt.missionId === manifest.missionId &&
    receipt.planRevisionId === manifest.planRevisionId &&
    receipt.planSha256 === manifest.planSha256 &&
    receipt.sourceRevision === manifest.sourceRevision &&
    receipt.runtimeBuildSha256 === manifest.runtimeBuildSha256 &&
    receipt.policyVersion === manifest.policyVersion &&
    receipt.skillSha256 === manifest.skillSha256
  );
}
