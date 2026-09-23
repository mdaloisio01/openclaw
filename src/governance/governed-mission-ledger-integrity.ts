import { createHash } from "node:crypto";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { GovernedMissionLedgerReceipt } from "./governed-mission-ledger.types.js";

export const GOVERNED_MISSION_CONTRACT_KEY = "governedMissionContract";
export const GOVERNED_MISSION_PLAN_KEY = "governedMissionPlan";
export const GOVERNED_MISSION_ARTIFACT_DECLARATIONS_KEY = "governedMissionArtifactDeclarations";
export const GOVERNED_MISSION_RELEASE_STATE_KEY = "governedMissionReleaseState";

export function computeGovernedMissionPackageSha256(flow: TaskFlowRecord): string {
  return sha256(
    stableJson({
      schema: "openclaw.governed_mission_package.v1",
      flow: {
        flowId: flow.flowId,
        revision: flow.revision,
        syncMode: flow.syncMode,
        ownerKey: flow.ownerKey,
        controllerId: flow.controllerId ?? null,
        status: flow.status,
        notifyPolicy: flow.notifyPolicy,
        goal: flow.goal,
        currentStep: flow.currentStep ?? null,
        blockedTaskId: flow.blockedTaskId ?? null,
        blockedSummary: flow.blockedSummary ?? null,
        cancelRequestedAt: flow.cancelRequestedAt ?? null,
        endedAt: flow.endedAt ?? null,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt,
      },
      // Production routing fields share stateJson with the governed contract.
      // Hash the whole state so a new authorization field cannot bypass the ledger.
      stateJson: flow.stateJson ?? null,
    }),
  );
}

export function computeGovernedTerminalAdmissionPreconditionSha256(flow: TaskFlowRecord): string {
  return sha256(
    stableJson({
      schema: "openclaw.governed_terminal_admission_precondition.v1",
      flowId: flow.flowId,
      revision: flow.revision,
      stateJson: flow.stateJson ?? null,
    }),
  );
}

export function computeGovernedMissionReceiptSha256(receipt: GovernedMissionLedgerReceipt): string {
  const { receiptSha256: _receiptSha256, ...hashInput } = receipt;
  return sha256(stableJson(hashInput));
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
