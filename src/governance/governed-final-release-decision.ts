import {
  recomputePinnedReleaseStateHash,
  type GovernedPinnedReleaseState,
} from "./governed-closeout-validator.js";

export const GOVERNED_FINAL_RELEASE_DECISION_VERSION =
  "governed-final-release-decision-v1" as const;
export const GOVERNED_FINAL_RELEASE_WITHHELD_NOTICE =
  "Governed result withheld because compliance state could not be verified.";

export type GovernedFinalReleaseCheck = {
  missionId: string;
  runId: string;
  contractId: string;
  contractHash: string;
  payloadHash?: string;
};

export type GovernedFinalReleaseDecisionReason =
  | "allowed"
  | "gate_disabled"
  | "release_state_missing"
  | "release_state_denied"
  | "release_state_hash_invalid"
  | "mission_mismatch"
  | "run_mismatch"
  | "contract_mismatch"
  | "contract_hash_mismatch"
  | "payload_hash_mismatch";

export type GovernedFinalReleaseDecisionInput = GovernedFinalReleaseCheck & {
  releaseState?: GovernedPinnedReleaseState;
  gateEnabled?: boolean;
};

export type GovernedFinalReleaseDecision = {
  schema: "openclaw.governed_final_release_decision.v1";
  decisionVersion: typeof GOVERNED_FINAL_RELEASE_DECISION_VERSION;
  allowed: boolean;
  reason: GovernedFinalReleaseDecisionReason;
  check: GovernedFinalReleaseCheck;
  releaseStateHash?: string;
};

export function mayReleaseGovernedFinal(
  input: GovernedFinalReleaseDecisionInput,
): GovernedFinalReleaseDecision {
  const check = {
    missionId: input.missionId,
    runId: input.runId,
    contractId: input.contractId,
    contractHash: input.contractHash,
    ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
  };
  const deny = (reason: Exclude<GovernedFinalReleaseDecisionReason, "allowed">) => ({
    schema: "openclaw.governed_final_release_decision.v1" as const,
    decisionVersion: GOVERNED_FINAL_RELEASE_DECISION_VERSION,
    allowed: false,
    reason,
    check,
    ...(input.releaseState?.releaseStateHash
      ? { releaseStateHash: input.releaseState.releaseStateHash }
      : {}),
  });

  if (input.gateEnabled === false) {
    return deny("gate_disabled");
  }
  if (!input.releaseState) {
    return deny("release_state_missing");
  }
  if (!input.releaseState.releaseAllowed) {
    return deny("release_state_denied");
  }
  if (input.releaseState.releaseStateHash !== recomputePinnedReleaseStateHash(input.releaseState)) {
    return deny("release_state_hash_invalid");
  }
  if (input.releaseState.missionId !== input.missionId) {
    return deny("mission_mismatch");
  }
  if (input.releaseState.runId !== input.runId) {
    return deny("run_mismatch");
  }
  if (input.releaseState.contractId !== input.contractId) {
    return deny("contract_mismatch");
  }
  if (input.releaseState.contractHash !== input.contractHash) {
    return deny("contract_hash_mismatch");
  }
  if ((input.releaseState.payloadHash ?? "") !== (input.payloadHash ?? "")) {
    return deny("payload_hash_mismatch");
  }
  return {
    schema: "openclaw.governed_final_release_decision.v1",
    decisionVersion: GOVERNED_FINAL_RELEASE_DECISION_VERSION,
    allowed: true,
    reason: "allowed",
    check,
    releaseStateHash: input.releaseState.releaseStateHash,
  };
}
