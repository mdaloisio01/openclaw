import type {
  CloseoutReceipt,
  GovernedCompletionOwner,
  GovernedMissionContract,
  GovernedMissionFailureState,
  ReleaseReceipt,
} from "./governed-mission-contract.js";
import { sha256Text } from "./mission-evidence-store.js";

export const GOVERNED_CLOSEOUT_VALIDATOR_VERSION = "governed-closeout-validator-v1";

export type GovernedCloseoutValidatorVerdict = "ALLOW_RELEASE" | "DENY_RELEASE";

export type GovernedCloseoutRejectionCode =
  | "AUTHORITATIVE_COMPLETION_OWNER_MISMATCH"
  | "CONTRACT_HASH_MISMATCH"
  | "AUTHORITY_HASH_MISMATCH"
  | "REQUIRED_EVIDENCE_MISSING"
  | "CLOSEOUT_FAILED"
  | "BLOCKING_STATE_UNRESOLVED";

export type GovernedPinnedReleaseState = {
  schema: "openclaw.governed_pinned_release_state.v1";
  missionId: string;
  runId: string;
  contractId: string;
  contractVersion: string;
  contractHash: string;
  authorityHash: string;
  payloadHash?: string;
  requiredEvidenceReceiptRefs: string[];
  closeoutReceiptRef: string;
  closeoutReceiptHash: string;
  validatorVerdict: GovernedCloseoutValidatorVerdict;
  validatorVersion: string;
  decisionTimestamp: string;
  decisionSequence: number;
  overrideRef?: string;
  releaseAllowed: boolean;
  releaseStateHash: string;
};

export type GovernedCloseoutValidationInput = {
  contract: GovernedMissionContract;
  runId: string;
  observedContractHash: string;
  observedAuthorityHash: string;
  requestedCompletionOwner: GovernedCompletionOwner;
  requiredEvidenceReceiptRefs: string[];
  presentEvidenceReceiptRefs: string[];
  closeoutPassed: boolean;
  noBlockingState: boolean;
  payloadHash?: string;
  overrideRef?: string;
  producedAt: string;
  decisionSequence: number;
  producer: string;
};

export type GovernedCloseoutValidationResult = {
  schema: "openclaw.governed_closeout_validation_result.v1";
  verdict: GovernedCloseoutValidatorVerdict;
  releaseAllowed: boolean;
  rejectionCodes: GovernedCloseoutRejectionCode[];
  missingEvidenceReceiptRefs: string[];
  closeoutReceipt: CloseoutReceipt;
  releaseReceipt: ReleaseReceipt;
  releaseState: GovernedPinnedReleaseState;
};

export type IssueFamilyClosureScope = "whole_family" | "scoped_slice";

export type IssueFamilyClosureAdmissionRejectionCode =
  | "ISSUE_FAMILY_ID_MISSING"
  | "MISSION_ID_MISSING"
  | "MISSION_IDENTITY_MISMATCH"
  | "RELEASE_NOT_ALLOWED"
  | "FINAL_VISIBLE_DELIVERY_PROOF_MISSING"
  | "FINAL_CLOSEOUT_ARTIFACT_PROOF_MISSING"
  | "GRANT_ACCEPTANCE_PROOF_MISSING"
  | "WATCHDOG_CLEAN_PROOF_MISSING"
  | "OPEN_SETTLEMENT_ROWS_REMAIN"
  | "ISSUE_REGISTER_ACTION_PROOF_MISSING"
  | "SCOPED_SLICE_CANNOT_CLOSE_WHOLE_FAMILY";

export type IssueFamilyClosureAdmissionInput = {
  issueFamilyId: string;
  missionId: string;
  requestedClosureScope: IssueFamilyClosureScope;
  evidenceScope: IssueFamilyClosureScope;
  releaseState: GovernedPinnedReleaseState;
  finalVisibleDeliveryProof: boolean;
  finalCloseoutArtifactProof: boolean;
  grantAcceptanceProof: boolean;
  watchdogCleanProof: boolean;
  openSettlementRows: number;
  issueRegisterActionProof: boolean;
  lawfulNoIssueUpdateReason?: string;
};

export type IssueFamilyClosureAdmissionResult = {
  schema: "openclaw.issue_family_closure_admission_result.v1";
  issueFamilyId: string;
  missionId: string;
  closureAllowed: boolean;
  requestedClosureScope: IssueFamilyClosureScope;
  evidenceScope: IssueFamilyClosureScope;
  rejectionCodes: IssueFamilyClosureAdmissionRejectionCode[];
  nextAction: string;
};

export function validateGovernedCloseoutAndBuildReleaseState(
  input: GovernedCloseoutValidationInput,
): GovernedCloseoutValidationResult {
  const missingEvidenceReceiptRefs = input.requiredEvidenceReceiptRefs.filter(
    (ref) => !input.presentEvidenceReceiptRefs.includes(ref),
  );
  const rejectionCodes: GovernedCloseoutRejectionCode[] = [];
  if (input.requestedCompletionOwner !== input.contract.authoritativeCompletionOwner) {
    rejectionCodes.push("AUTHORITATIVE_COMPLETION_OWNER_MISMATCH");
  }
  if (input.observedContractHash !== input.contract.contractHash) {
    rejectionCodes.push("CONTRACT_HASH_MISMATCH");
  }
  if (input.observedAuthorityHash !== input.contract.authorityHash) {
    rejectionCodes.push("AUTHORITY_HASH_MISMATCH");
  }
  if (missingEvidenceReceiptRefs.length > 0) {
    rejectionCodes.push("REQUIRED_EVIDENCE_MISSING");
  }
  if (!input.closeoutPassed) {
    rejectionCodes.push("CLOSEOUT_FAILED");
  }
  if (!input.noBlockingState) {
    rejectionCodes.push("BLOCKING_STATE_UNRESOLVED");
  }

  const releaseAllowed = rejectionCodes.length === 0;
  const verdict: GovernedCloseoutValidatorVerdict = releaseAllowed
    ? "ALLOW_RELEASE"
    : "DENY_RELEASE";
  const closeoutReceipt = buildCloseoutReceipt(input, releaseAllowed, rejectionCodes);
  const closeoutReceiptHash = sha256Text(canonicalJson(closeoutReceipt));
  const closeoutReceiptRef = closeoutReceipt.receiptId;
  const releaseStateWithoutHash = {
    schema: "openclaw.governed_pinned_release_state.v1" as const,
    missionId: input.contract.missionId,
    runId: input.runId,
    contractId: input.contract.contractId,
    contractVersion: input.contract.contractVersion,
    contractHash: input.contract.contractHash,
    authorityHash: input.contract.authorityHash,
    ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
    requiredEvidenceReceiptRefs: [...input.requiredEvidenceReceiptRefs].toSorted(),
    closeoutReceiptRef,
    closeoutReceiptHash,
    validatorVerdict: verdict,
    validatorVersion: GOVERNED_CLOSEOUT_VALIDATOR_VERSION,
    decisionTimestamp: input.producedAt,
    decisionSequence: input.decisionSequence,
    ...(input.overrideRef ? { overrideRef: input.overrideRef } : {}),
    releaseAllowed,
  };
  const releaseStateHash = sha256Text(canonicalJson(releaseStateWithoutHash));
  const releaseState: GovernedPinnedReleaseState = {
    ...releaseStateWithoutHash,
    releaseStateHash,
  };
  const releaseReceipt = buildReleaseReceipt(
    input,
    releaseAllowed,
    releaseStateHash,
    closeoutReceiptRef,
  );

  return {
    schema: "openclaw.governed_closeout_validation_result.v1",
    verdict,
    releaseAllowed,
    rejectionCodes,
    missingEvidenceReceiptRefs,
    closeoutReceipt,
    releaseReceipt,
    releaseState,
  };
}

export function validateIssueFamilyClosureAdmission(
  input: IssueFamilyClosureAdmissionInput,
): IssueFamilyClosureAdmissionResult {
  const rejectionCodes: IssueFamilyClosureAdmissionRejectionCode[] = [];
  const issueFamilyId = input.issueFamilyId.trim();
  const missionId = input.missionId.trim();
  if (!issueFamilyId) {
    rejectionCodes.push("ISSUE_FAMILY_ID_MISSING");
  }
  if (!missionId) {
    rejectionCodes.push("MISSION_ID_MISSING");
  }
  if (missionId && input.releaseState.missionId !== missionId) {
    rejectionCodes.push("MISSION_IDENTITY_MISMATCH");
  }
  if (!input.releaseState.releaseAllowed) {
    rejectionCodes.push("RELEASE_NOT_ALLOWED");
  }
  if (!input.finalVisibleDeliveryProof) {
    rejectionCodes.push("FINAL_VISIBLE_DELIVERY_PROOF_MISSING");
  }
  if (!input.finalCloseoutArtifactProof) {
    rejectionCodes.push("FINAL_CLOSEOUT_ARTIFACT_PROOF_MISSING");
  }
  if (!input.grantAcceptanceProof) {
    rejectionCodes.push("GRANT_ACCEPTANCE_PROOF_MISSING");
  }
  if (!input.watchdogCleanProof) {
    rejectionCodes.push("WATCHDOG_CLEAN_PROOF_MISSING");
  }
  if (input.openSettlementRows > 0) {
    rejectionCodes.push("OPEN_SETTLEMENT_ROWS_REMAIN");
  }
  if (!input.issueRegisterActionProof && !input.lawfulNoIssueUpdateReason?.trim()) {
    rejectionCodes.push("ISSUE_REGISTER_ACTION_PROOF_MISSING");
  }
  if (input.requestedClosureScope === "whole_family" && input.evidenceScope !== "whole_family") {
    rejectionCodes.push("SCOPED_SLICE_CANNOT_CLOSE_WHOLE_FAMILY");
  }

  const closureAllowed = rejectionCodes.length === 0;
  return {
    schema: "openclaw.issue_family_closure_admission_result.v1",
    issueFamilyId: issueFamilyId || "unknown",
    missionId: missionId || "unknown",
    closureAllowed,
    requestedClosureScope: input.requestedClosureScope,
    evidenceScope: input.evidenceScope,
    rejectionCodes,
    nextAction: closureAllowed
      ? "write issue-register closure row for the same governed mission identity"
      : nextIssueFamilyClosureAction(rejectionCodes[0]),
  };
}

function nextIssueFamilyClosureAction(
  code: IssueFamilyClosureAdmissionRejectionCode | undefined,
): string {
  switch (code) {
    case "ISSUE_FAMILY_ID_MISSING":
    case "MISSION_ID_MISSING":
    case "MISSION_IDENTITY_MISMATCH":
      return "repair the issue-family and governed mission identity binding before closure";
    case "RELEASE_NOT_ALLOWED":
      return "obtain an allowed governed release state before issue-family closure";
    case "FINAL_VISIBLE_DELIVERY_PROOF_MISSING":
      return "deliver the final Mark-facing report visibly and record proof before closure";
    case "FINAL_CLOSEOUT_ARTIFACT_PROOF_MISSING":
      return "write and verify the final closeout artifact before closure";
    case "GRANT_ACCEPTANCE_PROOF_MISSING":
      return "obtain Grant accepted-review proof before closure";
    case "WATCHDOG_CLEAN_PROOF_MISSING":
      return "run fresh watchdog proof and require suspicious_count=0 before closure";
    case "OPEN_SETTLEMENT_ROWS_REMAIN":
      return "settle, supersede, or lawfully block every open settlement row before closure";
    case "ISSUE_REGISTER_ACTION_PROOF_MISSING":
      return "record issue-register action proof or a lawful no-update reason before closure";
    case "SCOPED_SLICE_CANNOT_CLOSE_WHOLE_FAMILY":
      return "use scoped closure only for the slice or collect whole-family evidence";
    default:
      return "collect required issue-family closure proof before closure";
  }
}

export function isPinnedReleaseStateValidForPayload(
  state: GovernedPinnedReleaseState,
  params: {
    missionId: string;
    runId: string;
    contractId: string;
    contractHash: string;
    payloadHash?: string;
  },
): boolean {
  if (!state.releaseAllowed) {
    return false;
  }
  if (
    state.missionId !== params.missionId ||
    state.runId !== params.runId ||
    state.contractId !== params.contractId ||
    state.contractHash !== params.contractHash
  ) {
    return false;
  }
  if ((state.payloadHash ?? "") !== (params.payloadHash ?? "")) {
    return false;
  }
  return state.releaseStateHash === recomputePinnedReleaseStateHash(state);
}

export function recomputePinnedReleaseStateHash(state: GovernedPinnedReleaseState): string {
  const { releaseStateHash: _releaseStateHash, ...hashInput } = state;
  return sha256Text(canonicalJson(hashInput));
}

function buildCloseoutReceipt(
  input: GovernedCloseoutValidationInput,
  releaseAllowed: boolean,
  rejectionCodes: GovernedCloseoutRejectionCode[],
): CloseoutReceipt {
  const receiptId = `closeout:${sha256Text(
    [
      input.contract.missionId,
      input.runId,
      input.contract.contractId,
      input.contract.contractHash,
      input.producedAt,
      releaseAllowed ? "passed" : "failed",
      ...rejectionCodes,
    ].join("\n"),
  ).slice(0, 32)}`;
  return {
    schema: "openclaw.governed_closeout_receipt.v1",
    receiptKind: "closeout",
    missionId: input.contract.missionId,
    contractId: input.contract.contractId,
    contractVersion: input.contract.contractVersion,
    contractHash: input.contract.contractHash,
    authorityHash: input.contract.authorityHash,
    receiptId,
    producedAt: input.producedAt,
    producer: input.producer,
    passed: releaseAllowed,
    evidenceRefs: [...input.presentEvidenceReceiptRefs].toSorted(),
    ...(!releaseAllowed ? { failureState: failureStateFor(rejectionCodes) } : {}),
  };
}

function buildReleaseReceipt(
  input: GovernedCloseoutValidationInput,
  releaseAllowed: boolean,
  releaseStateHash: string,
  closeoutReceiptRef: string,
): ReleaseReceipt {
  return {
    schema: "openclaw.governed_release_receipt.v1",
    receiptKind: "release",
    missionId: input.contract.missionId,
    contractId: input.contract.contractId,
    contractVersion: input.contract.contractVersion,
    contractHash: input.contract.contractHash,
    authorityHash: input.contract.authorityHash,
    receiptId: `release:${releaseStateHash.slice(0, 32)}`,
    producedAt: input.producedAt,
    producer: input.producer,
    releaseAllowed,
    releaseStateHash,
    closeoutReceiptRef,
  };
}

function failureStateFor(
  rejectionCodes: GovernedCloseoutRejectionCode[],
): GovernedMissionFailureState {
  if (rejectionCodes.includes("REQUIRED_EVIDENCE_MISSING")) {
    return "FAILED_VALIDATION";
  }
  if (
    rejectionCodes.includes("AUTHORITATIVE_COMPLETION_OWNER_MISMATCH") ||
    rejectionCodes.includes("CONTRACT_HASH_MISMATCH") ||
    rejectionCodes.includes("AUTHORITY_HASH_MISMATCH")
  ) {
    return "FAILED_CONTRACT";
  }
  if (rejectionCodes.includes("BLOCKING_STATE_UNRESOLVED")) {
    return "BLOCKED";
  }
  return "FAILED_VALIDATION";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    out[key] = sortForJson((value as Record<string, unknown>)[key]);
  }
  return out;
}
