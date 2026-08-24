import { exportManifestComplete } from "./mission-export-packager.js";
import { latestPassingReceiptForGate } from "./mission-gate-registry.js";
import type {
  CloseoutAdmissionInput,
  CompletionDecision,
  CompletionRejection,
  CompletionRejectionCode,
  CompletionTransition,
  EvidenceReceipt,
  MissionMode,
} from "./mission-manifest.types.js";
import { identityMatches } from "./mission-manifest.types.js";
import { restorationReceiptValid, rollbackReceiptValid } from "./rollback-restoration-state.js";
import { reconcileTestManifest } from "./test-manifest.js";

function reject(
  rejections: CompletionRejection[],
  code: CompletionRejectionCode,
  detail: string,
  extra?: Pick<CompletionRejection, "requirementId" | "gateId">,
) {
  rejections.push({ code, detail, ...extra });
}

function latestReceiptForGate(
  gateId: string,
  receipts: readonly EvidenceReceipt[],
): EvidenceReceipt | undefined {
  return receipts
    .filter((receipt) => receipt.gateId === gateId && receipt.status === "passed")
    .sort((a, b) => Date.parse(b.producedAt) - Date.parse(a.producedAt))[0];
}

function isSha256(value: string | undefined): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function requestedTransition(input: CloseoutAdmissionInput): CompletionTransition {
  return (
    input.completionRequest.requestedTransition ?? "completion_request -> terminal_pending_watchdog"
  );
}

export function resolveFalseCloseoutAdmissionMode(
  value: string | undefined,
  fallback: MissionMode = "shadow",
): MissionMode {
  if (value === "shadow" || value === "enforce" || value === "off") {
    return value;
  }
  return fallback;
}

export function evaluateFalseCloseoutAdmission(input: CloseoutAdmissionInput): CompletionDecision {
  const rejections: CompletionRejection[] = [];
  const identity = input.manifest;
  const transition = requestedTransition(input);
  const finalTransition = transition === "terminal_pending_watchdog -> COMPLETE";

  if (input.manifest.scopeHash !== input.completionRequest.claimedScopeHash) {
    reject(rejections, "FCAC_SCOPE_NARROWED", "closeout scope differs from mission scope");
  }
  if (
    input.manifest.authorizedScopeHash !== input.manifest.scopeHash ||
    input.manifest.planRevisionAuthorized !== true
  ) {
    reject(rejections, "FCAC_PLAN_REVISION_UNAUTHORIZED", "plan revision is not authorized");
  }

  for (const requirement of input.requirements.filter((req) => req.required)) {
    const gates = input.gates.filter(
      (gate) => gate.requirementId === requirement.id && gate.required,
    );
    if (gates.length === 0) {
      reject(rejections, "FCAC_REQUIREMENT_HAS_NO_GATE", "required requirement has no gate", {
        requirementId: requirement.id,
      });
      continue;
    }
    for (const gate of gates) {
      const latestAnyRevision = latestReceiptForGate(gate.id, input.receipts);
      const latestCurrent = latestPassingReceiptForGate({
        gate,
        receipts: input.receipts,
        identity,
        now: input.now,
      });
      if (!latestAnyRevision) {
        reject(rejections, "FCAC_REQUIREMENT_MISSING_RECEIPT", "required gate has no receipt", {
          requirementId: requirement.id,
          gateId: gate.id,
        });
      } else if (!identityMatches(latestAnyRevision, identity)) {
        reject(
          rejections,
          "FCAC_EVIDENCE_BOUND_TO_OTHER_REVISION",
          "gate receipt is bound to another mission, plan, source, runtime, policy, or skill",
          { requirementId: requirement.id, gateId: gate.id },
        );
      } else if (!latestCurrent) {
        reject(rejections, "FCAC_EVIDENCE_STALE", "gate receipt is stale", {
          requirementId: requirement.id,
          gateId: gate.id,
        });
      }
    }
  }

  const passedRequirementIds = new Set(
    input.receipts
      .filter((receipt) => receipt.status === "passed" && identityMatches(receipt, identity))
      .flatMap((receipt) =>
        input.gates.filter((gate) => gate.id === receipt.gateId).map((gate) => gate.requirementId),
      ),
  );
  for (const requirement of input.requirements) {
    if ((requirement.dependsOn ?? []).some((dependency) => !passedRequirementIds.has(dependency))) {
      reject(rejections, "FCAC_DEPENDENCY_OPEN", "requirement dependency remains open", {
        requirementId: requirement.id,
      });
    }
  }

  if (!reconcileTestManifest(input.testManifest, input.testResults).passed) {
    reject(rejections, "FCAC_TEST_MANIFEST_MISMATCH", "test manifest and raw results differ");
  }
  if (!rollbackReceiptValid(input.rollbackReceipt, identity)) {
    reject(rejections, "FCAC_ROLLBACK_MISSING_OR_INVALID", "rollback proof is missing or invalid");
  }
  if (!restorationReceiptValid(input.restorationReceipt, identity)) {
    reject(
      rejections,
      "FCAC_RESTORATION_MISSING_OR_INVALID",
      "restoration proof is missing or invalid",
    );
  }
  if (!exportManifestComplete(input.exportManifest, identity)) {
    reject(rejections, "FCAC_EXPORT_MANIFEST_INCOMPLETE", "export manifest is incomplete");
  }
  if ((input.reportContradictions ?? []).length > 0) {
    reject(rejections, "FCAC_REPORT_RUNTIME_CONTRADICTION", input.reportContradictions!.join("; "));
  }

  if (finalTransition) {
    if (
      input.runtimeState.parentStatus !== "terminal_pending_watchdog" &&
      input.runtimeState.parentStatus !== "terminal"
    ) {
      reject(rejections, "FCAC_PARENT_RUNNING", "parent mission is not terminal-pending");
    }
    if (input.runtimeState.activeExecutorCount > 0 || input.runtimeState.staleExecutorCount > 0) {
      reject(
        rejections,
        "FCAC_EXECUTOR_RUNNING_OR_STALE",
        "executor is still active or stale without a post-closeout role",
      );
    }
    if (
      input.runtimeState.openSessionCount > 0 ||
      input.runtimeState.openRunCount > 0 ||
      input.runtimeState.openLeaseCount > 0 ||
      input.runtimeState.openContinuationCount > 0 ||
      input.runtimeState.pendingDeliveryCount > 0
    ) {
      reject(
        rejections,
        "FCAC_REPORT_RUNTIME_CONTRADICTION",
        "open session/run/lease/continuation/delivery state contradicts closeout",
      );
    }
  }
  if (input.repairWork.openCount > 0) {
    reject(
      rejections,
      "FCAC_REPAIR_OPEN",
      `open repair work: ${input.repairWork.openIds.join(",")}`,
    );
  }
  if (finalTransition) {
    if (input.watchdog.label !== "CLEAN" || input.watchdog.suspiciousCount !== 0) {
      reject(rejections, "FCAC_WATCHDOG_NOT_CLEAN", "latest watchdog is not clean");
    }
    if (!input.watchdog.postTerminal) {
      reject(
        rejections,
        "FCAC_POST_TERMINAL_WATCHDOG_MISSING",
        "no post-terminal watchdog proof exists",
      );
    }
    if (!isSha256(input.completionRequest.previousDecisionReceiptSha256)) {
      reject(
        rejections,
        "FCAC_TERMINAL_PENDING_RECEIPT_MISSING",
        "terminal-pending admission receipt binding is missing",
      );
    }
    if (!isSha256(input.completionRequest.transitionalWatchdogReceiptSha256)) {
      reject(
        rejections,
        "FCAC_TRANSITIONAL_WATCHDOG_BINDING_MISSING",
        "transitional watchdog receipt binding is missing",
      );
    }
    if (!isSha256(input.completionRequest.parentExecutorSnapshotSha256)) {
      reject(
        rejections,
        "FCAC_PARENT_EXECUTOR_SNAPSHOT_MISSING",
        "parent/executor terminal snapshot binding is missing",
      );
    }
  }
  if (input.nextExecutableStepExists) {
    reject(
      rejections,
      "FCAC_NEXT_EXECUTABLE_STEP_EXISTS",
      "controller still has a dispatchable next step",
    );
  }

  const allowed = rejections.length === 0;
  const state = allowed
    ? input.manifest.mode === "enforce"
      ? finalTransition
        ? "complete"
        : "terminal_pending_watchdog"
      : input.manifest.mode === "off"
        ? "off_bypassed_terminal_pending_watchdog"
        : "shadow_would_allow_terminal_pending_watchdog"
    : input.manifest.mode === "enforce"
      ? "rejected_repair_required"
      : input.manifest.mode === "off"
        ? "off_bypassed_rejected"
        : "shadow_rejected";

  return {
    schema: "openclaw.completion_decision.v1",
    decisionId: `${input.manifest.missionId}:${input.now}`,
    missionId: input.manifest.missionId,
    planRevisionId: input.manifest.planRevisionId,
    mode: input.manifest.mode,
    state,
    allowed,
    rejectionCodes: [...new Set(rejections.map((rejection) => rejection.code))],
    rejections,
    evaluatedAt: input.now,
    evidenceManifestSha256: input.completionRequest.evidenceManifestSha256,
    ...(allowed && input.manifest.mode === "enforce" ? { authorizedTransition: transition } : {}),
  };
}
