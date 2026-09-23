import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartTime } from "../shared/pid-alive.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { flowRequiresActiveWorkWatchdog } from "../tasks/active-production-watchdog-lifecycle.js";
import {
  getProductionExecutorAssignment,
  isProductionExecutorAssignmentCurrentGovernedAttempt,
  recordProductionExecutorAssignment,
} from "../tasks/production-executor-assignment.js";
import { cancelFlowById, runTaskInFlow } from "../tasks/task-executor.js";
import { listTaskFlowAuditFindings } from "../tasks/task-flow-registry.audit.js";
import { runTaskFlowRegistryMaintenance } from "../tasks/task-flow-registry.maintenance.js";
import { configureTaskFlowRegistryRuntime } from "../tasks/task-flow-registry.store.js";
import {
  createManagedTaskFlow,
  deleteTaskFlowRecordById,
  failFlow,
  finishFlow,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
  resumeFlow,
  setFlowWaiting,
  updateFlowRecordByIdExpectedRevision,
} from "../tasks/task-flow-runtime-internal.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ENFORCEMENT_HEALTH_CAPABILITIES } from "./enforcement-health.js";
import {
  assertGovernedMissionAgentRunBinding as assertGovernedMissionAgentRunBindingRuntime,
  closeGovernedMissionExecutionLease as closeGovernedMissionExecutionLeaseRuntime,
  hasGovernedMissionClaimForOwnerKey,
  prepareGovernedMissionAgentRun as prepareGovernedMissionAgentRunRuntime,
} from "./governed-mission-agent-runtime.js";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import { computeGovernedMissionReceiptSha256 } from "./governed-mission-ledger-integrity.js";
import { beginOwnerRunForGovernedMissionAdmission } from "./governed-mission-owner-run-fence.js";
import {
  admitGovernedMissionToTaskFlow,
  applyGovernedMissionOperation,
  listGovernedMissionReceipts,
  previewGovernedMissionOperation,
  readGovernedMissionWithheldPayload,
  recordGovernedMissionWithheldPayload,
  resolveGovernedMissionFlowForLookupToken,
  verifyAndApplyGovernedMissionArtifacts,
  type AdmitGovernedMissionToTaskFlowInput,
} from "./governed-mission-runtime.js";
import {
  createGovernedMissionState,
  readGovernedMissionStateFromTaskFlow,
} from "./governed-mission-state.js";
import type { GovernedMissionOperation } from "./governed-mission-transition.js";
import type { GateKind } from "./mission-manifest.types.js";
import { compileMissionPlan } from "./mission-plan-compiler.js";

const now = "2026-09-17T00:00:00.000Z";
const authorityPath = fileURLToPath(import.meta.url);
const authorityHash = createHash("sha256").update(readFileSync(authorityPath)).digest("hex");
const authorityRef = {
  refId: "work-order-1",
  kind: "work_order" as const,
  uri: authorityPath,
  sha256: authorityHash,
};
const contract: GovernedMissionContract = {
  schema: "openclaw.governed_mission_contract.v1",
  missionId: "mission-runtime-1",
  contractId: "contract-runtime-1",
  contractVersion: "1",
  contractHash: "contract-hash",
  authorityHash,
  authorityRefs: [authorityRef],
  admissionReceiptRef: "admission-runtime-1",
  planRevisionId: "plan-1",
  sourceRevision: "source-1",
  runtimeBuildSha256: "build-1",
  policyVersion: "policy-1",
  skillSha256: "skill-1",
  mode: "enforce",
  authoritativeCompletionOwner: "governed_mission_state",
  requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
  createdAt: now,
};
const artifactIdentityBindings = {
  missionId: contract.missionId,
  contractHash: contract.contractHash,
  authorityHash: contract.authorityHash,
  planRevisionId: contract.planRevisionId,
  sourceRevision: contract.sourceRevision,
  runtimeBuildSha256: contract.runtimeBuildSha256,
  policyVersion: contract.policyVersion,
  skillSha256: contract.skillSha256,
};
const artifactBody = `${JSON.stringify(artifactIdentityBindings)}\n`;

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

function prepareGovernedMissionAgentRun(
  params: Omit<
    Parameters<typeof prepareGovernedMissionAgentRunRuntime>[0],
    "trustedRuntimeIdentity" | "observedSkillSha256"
  >,
) {
  return prepareGovernedMissionAgentRunRuntime({
    ...params,
    trustedRuntimeIdentity: {
      sourceRevision: contract.sourceRevision,
      runtimeBuildSha256: contract.runtimeBuildSha256,
    },
    observedSkillSha256: contract.skillSha256,
  });
}

function closeGovernedMissionExecutionLease(
  params: Omit<
    Parameters<typeof closeGovernedMissionExecutionLeaseRuntime>[0],
    "trustedRuntimeIdentity" | "observedSkillSha256"
  >,
) {
  return closeGovernedMissionExecutionLeaseRuntime({
    ...params,
    trustedRuntimeIdentity: {
      sourceRevision: contract.sourceRevision,
      runtimeBuildSha256: contract.runtimeBuildSha256,
    },
    observedSkillSha256: contract.skillSha256,
  });
}

function createAdmissionInput(
  stateDir: string,
  gateKinds: readonly GateKind[] = ["test"],
  overrides: { missionId?: string; idempotencyKey?: string } = {},
): AdmitGovernedMissionToTaskFlowInput {
  const missionId = overrides.missionId ?? contract.missionId;
  const missionContract: GovernedMissionContract = {
    ...contract,
    missionId,
    contractId: missionId === contract.missionId ? contract.contractId : `contract-${missionId}`,
    admissionReceiptRef:
      missionId === contract.missionId ? contract.admissionReceiptRef : `admission-${missionId}`,
  };
  const identityBindings = { ...artifactIdentityBindings, missionId };
  const expectedArtifactSha256 = createHash("sha256")
    .update(`${JSON.stringify(identityBindings)}\n`)
    .digest("hex");
  const compiledPlan = compileMissionPlan({
    manifest: {
      schema: "openclaw.mission_manifest.v1",
      missionId,
      planRevisionId: contract.planRevisionId,
      planSha256: "plan-1-sha",
      sourceRevision: contract.sourceRevision,
      runtimeBuildSha256: contract.runtimeBuildSha256,
      policyVersion: contract.policyVersion,
      skillSha256: contract.skillSha256,
      mode: "enforce",
      scopeHash: "scope-1",
      authorizedScopeHash: "scope-1",
      planRevisionAuthorized: true,
      createdAt: now,
    },
    requirements: [{ id: "REQ-1", text: "Prove the mission", required: true }],
    gateKinds,
  });
  return {
    admission: {
      hookName: "before_agent_run",
      classification: "governed_required",
      actor: { actorId: "controller-1", runId: "run-1" },
      contract: missionContract,
      observedAuthority: {
        contractHash: missionContract.contractHash,
        authorityHash: missionContract.authorityHash,
        authorityRef,
        planRevisionId: missionContract.planRevisionId,
        sourceRevision: missionContract.sourceRevision,
        runtimeBuildSha256: missionContract.runtimeBuildSha256,
        policyVersion: missionContract.policyVersion,
        skillSha256: missionContract.skillSha256,
      },
      enforcementCapabilities: ENFORCEMENT_HEALTH_CAPABILITIES.map((capability) => ({
        capability,
        state: "known_healthy" as const,
        observedAt: now,
      })),
      hostAuthority: { openclawAllows: true, osAllows: true, hostAllows: true },
      now,
    },
    idempotencyKey: overrides.idempotencyKey ?? "admit-1",
    ownerKey: "Will",
    controllerId: "controller-1",
    goal: "Prove the governed runtime",
    continuation: {
      activeProductionRun: true,
      parentRunOpen: true,
    },
    compiledPlan,
    artifactDeclarations: compiledPlan.gates.map((gate) => ({
      artifactId: `${gate.id}-proof`,
      artifactKind: "validation",
      missionId,
      workOrderId: "work-1",
      gateId: gate.id,
      allowedRoot: stateDir,
      pathname: path.join(stateDir, `${gate.id.replaceAll(":", "-")}.json`),
      required: gate.required,
      expectedSha256: expectedArtifactSha256,
      identityBindings,
    })),
  };
}

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

async function withRuntime<T>(
  run: (flowId: string, stateDir: string) => T | Promise<T>,
  options: Pick<AdmitGovernedMissionToTaskFlowInput, "continuation" | "deliveryRequired"> = {},
): Promise<T> {
  return await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    process.env.OPENCLAW_STATE_DIR = state.stateDir;
    resetTaskFlowRegistryForTests({ persist: false });
    const admission = admitGovernedMissionToTaskFlow({
      ...createAdmissionInput(state.stateDir),
      ...options,
      continuation: options.continuation ?? {
        activeProductionRun: true,
        parentRunOpen: true,
      },
    });
    if (admission.status !== "admitted") {
      throw new Error(`expected admission, got ${admission.status}`);
    }
    return await run(admission.flow.flowId, state.stateDir);
  });
}

describe("governed embedded execution lease recovery", () => {
  it("classifies active governed owners before content-bearing hooks run", async () => {
    await withRuntime(() => {
      expect(hasGovernedMissionClaimForOwnerKey("Will")).toBe(true);
      expect(hasGovernedMissionClaimForOwnerKey("someone-else")).toBe(false);
      expect(hasGovernedMissionClaimForOwnerKey(" ")).toBe(false);
    });
  });

  it("fails closed when only the outer flow status is forged terminal", async () => {
    await withRuntime((flowId) => {
      const canonical = getTaskFlowById(flowId)!;
      const tampered = { ...canonical, status: "succeeded" as const };
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map([[flowId, tampered]]) }),
          saveSnapshot: () => {},
        },
      });

      expect(hasGovernedMissionClaimForOwnerKey("Will")).toBe(true);
      expect(
        prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "tampered-terminal-run" }),
      ).toMatchObject({
        status: "blocked",
        reasonCode: "GOVERNED_MISSION_PROVENANCE_INVALID",
      });
    });
  });

  it("retains the durable owner claim when persisted governed state is missing", async () => {
    await withRuntime(async (flowId) => {
      const previewRequest = operation(flowId, "startWorkOrder");
      const { db } = openOpenClawStateDatabase();
      const old = Date.parse(now) - 8 * 24 * 60 * 60_000;
      db.prepare(
        "UPDATE flow_runs SET state_json = NULL, status = 'failed', created_at = ?, updated_at = ?, ended_at = ? WHERE flow_id = ?",
      ).run(old, old, old, flowId);
      resetTaskFlowRegistryForTests({ persist: false });

      const ordinary = createManagedTaskFlow({
        ownerKey: "Will",
        controllerId: "ordinary-after-corruption",
        goal: "Newer ordinary work must not shadow the durable governed claim",
      });
      expect(ordinary).toBeDefined();

      expect(hasGovernedMissionClaimForOwnerKey("Will")).toBe(true);
      expect(resolveGovernedMissionFlowForLookupToken("Will")?.flowId).toBe(flowId);
      expect(
        previewGovernedMissionOperation({ lookup: "Will", request: previewRequest }),
      ).toMatchObject({ status: "untrusted_governed_state", flow: { flowId } });
      expect(
        prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "missing-state-run" }),
      ).toMatchObject({
        status: "blocked",
        reasonCode: "MALFORMED_GOVERNED_MISSION_STATE",
      });
      expect(deleteTaskFlowRecordById(flowId)).toBe(false);
      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(getTaskFlowById(flowId)).toMatchObject({ flowId, status: "failed" });
    });
  });

  it("restarts a repair-required mission on the next governed agent run", async () => {
    await withRuntime((flowId) => {
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "applied" });
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "blockForRepair", {
            reasonCode: "REPAIR_REQUIRED",
            nextAction: "Run the repaired governed attempt.",
          }),
        }),
      ).toMatchObject({ status: "applied" });

      const preparation = prepareGovernedMissionAgentRun({
        ownerKey: "Will",
        runId: "run-after-repair",
      });
      expect(preparation).toMatchObject({ status: "bound", flowId });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "executing",
        blockedStatus: "not_blocked",
        activeExecutionLease: { runId: "run-after-repair" },
      });
      closeGovernedMissionExecutionLease({ flowId, runId: "run-after-repair" });
    });
  });

  it("remeasures runtime identity before start, dispatch, and lease close", async () => {
    await withRuntime((flowId) => {
      const staleRuntimeIdentity = {
        sourceRevision: "source-after-admission",
        runtimeBuildSha256: "build-after-admission",
      };
      expect(
        prepareGovernedMissionAgentRunRuntime({
          ownerKey: "Will",
          runId: "stale-before-start",
          trustedRuntimeIdentity: staleRuntimeIdentity,
          observedSkillSha256: contract.skillSha256,
        }),
      ).toMatchObject({ status: "blocked", reasonCode: "GOVERNED_START_DENIED" });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "readmission_required",
        activeExecutionLease: undefined,
      });
    });

    await withRuntime((flowId) => {
      const preparation = prepareGovernedMissionAgentRun({
        ownerKey: "Will",
        runId: "identity-bound-run",
      });
      expect(preparation).toMatchObject({ status: "bound" });
      if (preparation.status !== "bound") {
        throw new Error(`expected governed binding, got ${preparation.status}`);
      }
      expect(() =>
        assertGovernedMissionAgentRunBindingRuntime({
          ownerKey: "Will",
          flowId,
          runId: "identity-bound-run",
          attemptReceiptId: preparation.attemptReceiptId,
          trustedRuntimeIdentity: {
            sourceRevision: "source-after-dispatch-binding",
            runtimeBuildSha256: "build-after-dispatch-binding",
          },
          observedSkillSha256: contract.skillSha256,
        }),
      ).toThrow("governed mission dispatch binding is no longer canonical");

      expect(() =>
        closeGovernedMissionExecutionLeaseRuntime({
          flowId,
          runId: "identity-bound-run",
          trustedRuntimeIdentity: {
            sourceRevision: "source-before-close",
            runtimeBuildSha256: "build-before-close",
          },
          observedSkillSha256: contract.skillSha256,
        }),
      ).not.toThrow();
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "readmission_required",
        activeExecutionLease: undefined,
      });
    });
  });

  it("remeasures skill identity before start and provider dispatch", async () => {
    await withRuntime((flowId) => {
      expect(
        prepareGovernedMissionAgentRunRuntime({
          ownerKey: "Will",
          runId: "stale-skill-before-start",
          trustedRuntimeIdentity: {
            sourceRevision: contract.sourceRevision,
            runtimeBuildSha256: contract.runtimeBuildSha256,
          },
          observedSkillSha256: "skill-after-admission",
        }),
      ).toMatchObject({ status: "blocked", reasonCode: "GOVERNED_START_DENIED" });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "readmission_required",
        activeExecutionLease: undefined,
      });
    });

    await withRuntime((flowId) => {
      const preparation = prepareGovernedMissionAgentRun({
        ownerKey: "Will",
        runId: "skill-bound-run",
      });
      expect(preparation).toMatchObject({ status: "bound" });
      if (preparation.status !== "bound") {
        throw new Error(`expected governed binding, got ${preparation.status}`);
      }
      expect(() =>
        assertGovernedMissionAgentRunBindingRuntime({
          ownerKey: "Will",
          flowId,
          runId: "skill-bound-run",
          attemptReceiptId: preparation.attemptReceiptId,
          trustedRuntimeIdentity: {
            sourceRevision: contract.sourceRevision,
            runtimeBuildSha256: contract.runtimeBuildSha256,
          },
          observedSkillSha256: "skill-after-dispatch-binding",
        }),
      ).toThrow("governed mission dispatch binding is no longer canonical");
      closeGovernedMissionExecutionLease({ flowId, runId: "skill-bound-run" });
    });
  });

  it("revokes tool authority when the resolved skill changes after run preparation", async () => {
    await withRuntime((flowId) => {
      let currentSkillSha256 = contract.skillSha256;
      const preparation = prepareGovernedMissionAgentRun({
        ownerKey: "Will",
        runId: "skill-changes-during-run",
        readObservedSkillSha256: () => currentSkillSha256,
      });
      expect(preparation.status).toBe("bound");
      if (preparation.status !== "bound") {
        throw new Error(`expected governed binding, got ${preparation.status}`);
      }
      expect(preparation.toolEnforcement.resolveAuthority()).toBeDefined();

      currentSkillSha256 = "skill-after-tool-binding";
      expect(preparation.toolEnforcement.resolveAuthority()).toBeUndefined();
      expect(() =>
        assertGovernedMissionAgentRunBindingRuntime({
          ownerKey: "Will",
          flowId,
          runId: "skill-changes-during-run",
          attemptReceiptId: preparation.attemptReceiptId,
          trustedRuntimeIdentity: {
            sourceRevision: contract.sourceRevision,
            runtimeBuildSha256: contract.runtimeBuildSha256,
          },
          observedSkillSha256: contract.skillSha256,
          readObservedSkillSha256: () => currentSkillSha256,
        }),
      ).toThrow("governed mission dispatch binding is no longer canonical");
      closeGovernedMissionExecutionLease({ flowId, runId: "skill-changes-during-run" });
    });
  });

  it("closes an exact execution lease when its authority becomes unreadable", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const transientAuthorityPath = path.join(state.stateDir, "transient-authority.json");
      const transientAuthorityBody = Buffer.from('{"authority":"transient"}\n');
      await fs.writeFile(transientAuthorityPath, transientAuthorityBody);
      const transientAuthorityHash = createHash("sha256")
        .update(transientAuthorityBody)
        .digest("hex");
      const transientAuthorityRef = {
        ...authorityRef,
        uri: transientAuthorityPath,
        sha256: transientAuthorityHash,
      };
      const input = createAdmissionInput(state.stateDir);
      input.admission.contract = {
        ...input.admission.contract,
        authorityHash: transientAuthorityHash,
        authorityRefs: [transientAuthorityRef],
      };
      const observedAuthority = input.admission.observedAuthority;
      if (!observedAuthority) {
        throw new Error("expected observed authority fixture");
      }
      input.admission.observedAuthority = {
        ...observedAuthority,
        authorityHash: transientAuthorityHash,
        authorityRef: transientAuthorityRef,
      };
      input.artifactDeclarations = input.artifactDeclarations.map((declaration) => ({
        ...declaration,
        identityBindings: {
          ...declaration.identityBindings,
          authorityHash: transientAuthorityHash,
        },
      }));
      const admission = admitGovernedMissionToTaskFlow(input);
      expect(admission.status).toBe("admitted");
      if (admission.status !== "admitted") {
        throw new Error(`expected admission, got ${admission.status}`);
      }
      const flowId = admission.flow.flowId;
      expect(
        prepareGovernedMissionAgentRun({
          ownerKey: "Will",
          runId: "transient-authority-run",
        }),
      ).toMatchObject({ status: "bound", flowId });

      await fs.rm(transientAuthorityPath);
      expect(() =>
        closeGovernedMissionExecutionLease({
          flowId,
          runId: "transient-authority-run",
        }),
      ).not.toThrow();
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "executing",
        activeExecutionLease: undefined,
      });
    });
  });

  it("recovers a lease from a prior runtime instance before binding the new run", async () => {
    await withRuntime((flowId) => {
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }).status,
      ).toBe("applied");
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "openExecutionLease", {
            runId: "run-stale",
            processId: process.pid,
            runtimeInstanceId: "prior-runtime-instance",
          }),
        }).status,
      ).toBe("applied");

      const rebound = prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "run-next" });
      expect(rebound).toMatchObject({ status: "bound", flowId });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        activeExecutionLease: {
          runId: "run-next",
          processId: process.pid,
          runtimeInstanceId: expect.not.stringMatching(/^prior-runtime-instance$/u),
        },
      });
      expect(listGovernedMissionReceipts({ flowId }).map((receipt) => receipt.operation)).toEqual(
        expect.arrayContaining(["closeExecutionLease", "openExecutionLease"]),
      );
      closeGovernedMissionExecutionLease({ flowId, runId: "run-next" });
    });
  });

  it("recovers a stale lease when its live PID has been reused", async () => {
    await withRuntime((flowId) => {
      const reusedPid = process.pid === 1 ? process.ppid : 1;
      const currentStartTime = getProcessStartTime(reusedPid);
      if (currentStartTime === null) {
        return;
      }
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }).status,
      ).toBe("applied");
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "openExecutionLease", {
            runId: "run-reused-pid",
            processId: reusedPid,
            processStartTime: currentStartTime + 1,
            runtimeInstanceId: "prior-runtime-instance",
          }),
        }).status,
      ).toBe("applied");

      const rebound = prepareGovernedMissionAgentRun({
        ownerKey: "Will",
        runId: "run-after-reuse",
      });
      expect(rebound).toMatchObject({ status: "bound", flowId });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        activeExecutionLease: {
          runId: "run-after-reuse",
          processId: process.pid,
        },
      });
      closeGovernedMissionExecutionLease({ flowId, runId: "run-after-reuse" });
    });
  });

  it("does not steal a lease owned by the active runtime instance", async () => {
    await withRuntime((flowId) => {
      expect(
        prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "run-active" }),
      ).toMatchObject({ status: "bound", flowId });
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "blockForRepair", {
            reasonCode: "TEST_REPAIR_REQUIRED",
            nextAction: "Repair after the active run closes.",
          }),
        }),
      ).toMatchObject({
        status: "repair_required",
      });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "executing",
        activeExecutionLease: { runId: "run-active" },
      });
      expect(
        prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "run-conflict" }),
      ).toMatchObject({ status: "blocked", reasonCode: "GOVERNED_EXECUTION_LEASE_CONFLICT" });
      closeGovernedMissionExecutionLease({ flowId, runId: "run-active" });
    });
  });

  it("binds sequential executable turns to distinct lease receipts", async () => {
    await withRuntime((flowId) => {
      const first = prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "run-turn-1" });
      expect(first).toMatchObject({ status: "bound", flowId });
      if (first.status !== "bound") {
        throw new Error(`expected first governed binding, got ${first.status}`);
      }
      closeGovernedMissionExecutionLease({ flowId, runId: "run-turn-1" });

      const second = prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "run-turn-2" });
      expect(second).toMatchObject({ status: "bound", flowId });
      if (second.status !== "bound") {
        throw new Error(`expected second governed binding, got ${second.status}`);
      }
      expect(second.attemptReceiptId).not.toBe(first.attemptReceiptId);
      closeGovernedMissionExecutionLease({ flowId, runId: "run-turn-2" });

      expect(
        recordGovernedMissionWithheldPayload({
          flowId,
          attemptReceiptId: first.attemptReceiptId,
          payload: [{ text: "stale result" }],
        }),
      ).toMatchObject({ applied: false, reason: "guard_blocked" });
      expect(
        recordGovernedMissionWithheldPayload({
          flowId,
          attemptReceiptId: second.attemptReceiptId,
          payload: [{ text: "current result" }],
        }),
      ).toMatchObject({ applied: true });
      expect(readGovernedMissionWithheldPayload(getTaskFlowById(flowId)!)).toMatchObject({
        runId: "run-turn-2",
        attemptReceiptId: second.attemptReceiptId,
        payload: [{ text: "current result" }],
      });
    });
  });

  it("stores the accepted payload while its exact execution lease still fences transitions", async () => {
    await withRuntime((flowId) => {
      const preparation = prepareGovernedMissionAgentRun({
        ownerKey: "Will",
        runId: "run-withheld-before-close",
      });
      if (preparation.status !== "bound") {
        throw new Error(`expected governed binding, got ${preparation.status}`);
      }
      expect(
        recordGovernedMissionWithheldPayload({
          flowId,
          attemptReceiptId: preparation.attemptReceiptId,
          payload: [{ text: "accepted private result" }],
        }),
      ).toMatchObject({ applied: true });
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "recordImplementationResult", { passed: true }),
        }).status,
      ).not.toBe("applied");
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        activeExecutionLease: { runId: "run-withheld-before-close" },
      });
      closeGovernedMissionExecutionLease({ flowId, runId: "run-withheld-before-close" });
      expect(readGovernedMissionWithheldPayload(getTaskFlowById(flowId)!)).toMatchObject({
        attemptReceiptId: preparation.attemptReceiptId,
        payload: [{ text: "accepted private result" }],
      });
    });
  });

  it("records governed tool decisions in the mission revision domain", async () => {
    await withRuntime((flowId) => {
      const preparation = prepareGovernedMissionAgentRun({
        ownerKey: "Will",
        runId: "tool-receipt-run",
      });
      if (preparation.status !== "bound") {
        throw new Error(`expected governed binding, got ${preparation.status}`);
      }
      const mission = readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!;

      preparation.toolEnforcement.onDecision(
        {
          schema: "openclaw.mission_specific_tool_enforcement_decision.v1",
          actionId: "tool-action-1",
          protected: false,
          decision: "ALLOW",
          reasonCode: "UNPROTECTED_ACTION",
          obligations: [],
          evaluatedAt: now,
        },
        {
          invocationId: "tool-invocation-1",
          toolCallId: "tool-call-1",
          toolName: "nodes",
          params: { action: "status" },
        },
      );

      expect(
        listGovernedMissionReceipts({ flowId }).find(
          (receipt) => receipt.operation === "authorizeToolCall",
        ),
      ).toMatchObject({
        expectedRevision: mission.revision,
        resultingRevision: mission.revision,
      });
      closeGovernedMissionExecutionLease({ flowId, runId: "tool-receipt-run" });
    });
  });

  it("invalidates executor proof when a newer execution lease opens", async () => {
    await withRuntime((flowId) => {
      expect(
        prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "proof-attempt-1" }),
      ).toMatchObject({ status: "bound", flowId });
      closeGovernedMissionExecutionLease({ flowId, runId: "proof-attempt-1" });
      expect(
        recordProductionExecutorAssignment({
          flowId,
          taskId: "proof-task-1",
          expectedRunId: "proof-run-1",
          executorId: "coding-agent",
          ownerLane: "implementation",
          proofPurpose: "implementation",
          role: "Coding Agent",
          permitted: ["repo_write"],
          prohibited: ["runtime_restart"],
          evidenceRefs: ["work-order:proof-1"],
          assignedAt: Date.parse(now),
        }),
      ).toMatchObject({
        applied: true,
        assignment: {
          governedAttemptRunId: "proof-attempt-1",
          governedMissionState: "executing",
          governedMissionRevision: expect.any(Number),
        },
      });
      const assignedFlow = getTaskFlowById(flowId)!;
      const assignment = getProductionExecutorAssignment(assignedFlow, "proof-task-1")!;
      expect(
        isProductionExecutorAssignmentCurrentGovernedAttempt({
          flow: assignedFlow,
          assignment,
        }),
      ).toBe(true);

      expect(
        prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "proof-attempt-2" }),
      ).toMatchObject({ status: "bound", flowId });
      closeGovernedMissionExecutionLease({ flowId, runId: "proof-attempt-2" });
      expect(
        isProductionExecutorAssignmentCurrentGovernedAttempt({
          flow: getTaskFlowById(flowId)!,
          assignment,
        }),
      ).toBe(false);
    });
  });

  it("binds proof assignments to their prerequisite lifecycle revision", async () => {
    await withRuntime((flowId) => {
      expect(
        prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "proof-lifecycle-attempt" }),
      ).toMatchObject({ status: "bound", flowId });
      closeGovernedMissionExecutionLease({ flowId, runId: "proof-lifecycle-attempt" });

      const record = (proofPurpose: "implementation" | "validation" | "review") =>
        recordProductionExecutorAssignment({
          flowId,
          taskId: `${proofPurpose}-task`,
          expectedRunId: `${proofPurpose}-run`,
          executorId: `${proofPurpose}-executor`,
          ownerLane: proofPurpose,
          proofPurpose,
          role: proofPurpose === "implementation" ? "Coding Agent" : "Grant",
          permitted: [proofPurpose === "review" ? "grant_review" : "repo_read"],
          prohibited: [],
          evidenceRefs: [`work-order:${proofPurpose}`],
          assignedAt: Date.parse(now),
        });

      expect(record("review")).toEqual({
        applied: false,
        reason: "production_executor_assignment_lifecycle_invalid",
      });
      expect(record("implementation")).toMatchObject({ applied: true });
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "recordImplementationResult", { passed: true }),
        }),
      ).toMatchObject({ status: "applied" });
      expect(record("validation")).toMatchObject({ applied: true });
      expect(record("review")).toEqual({
        applied: false,
        reason: "production_executor_assignment_lifecycle_invalid",
      });
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "recordValidationResult", { passed: true }),
        }),
      ).toMatchObject({ status: "applied" });
      expect(record("review")).toMatchObject({
        applied: true,
        assignment: {
          governedMissionState: "validation_complete",
          governedMissionRevision: expect.any(Number),
        },
      });
    });
  });

  it("lets the exact run close its lease after cancellation is requested", async () => {
    await withRuntime(async (flowId) => {
      const preparation = prepareGovernedMissionAgentRun({
        ownerKey: "Will",
        runId: "run-cancelling",
      });
      expect(preparation).toMatchObject({ status: "bound", flowId });
      if (preparation.status !== "bound") {
        throw new Error(`expected governed binding, got ${preparation.status}`);
      }
      const flow = getTaskFlowById(flowId)!;
      expect(
        requestFlowCancel({
          flowId,
          expectedRevision: flow.revision,
          cancelRequestedAt: Date.parse(now),
        }),
      ).toMatchObject({ applied: true });
      expect(listGovernedMissionReceipts({ flowId })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "requestCancellation",
            decision: "applied",
            reasonCode: "CANCELLATION_REQUESTED",
          }),
        ]),
      );
      expect(preparation.toolEnforcement.resolveAuthority()).toBeUndefined();
      expect(() =>
        assertGovernedMissionAgentRunBindingRuntime({
          ownerKey: "Will",
          flowId,
          runId: "run-cancelling",
          attemptReceiptId: preparation.attemptReceiptId,
          trustedRuntimeIdentity: {
            sourceRevision: contract.sourceRevision,
            runtimeBuildSha256: contract.runtimeBuildSha256,
          },
          observedSkillSha256: contract.skillSha256,
        }),
      ).toThrow("governed mission dispatch binding is no longer canonical");
      expect(
        prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "run-after-cancel" }),
      ).toMatchObject({
        status: "blocked",
        reasonCode: "GOVERNED_CANCELLATION_PENDING",
      });

      closeGovernedMissionExecutionLease({ flowId, runId: "run-cancelling" });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        activeExecutionLease: undefined,
      });
      expect(await cancelFlowById({ cfg: {}, flowId })).toMatchObject({
        found: true,
        cancelled: true,
      });
    });
  });

  it("rejects cancellation-intent tampering against the governed package head", async () => {
    await withRuntime((flowId) => {
      const flow = getTaskFlowById(flowId)!;
      expect(
        requestFlowCancel({
          flowId,
          expectedRevision: flow.revision,
          cancelRequestedAt: Date.parse(now),
        }),
      ).toMatchObject({ applied: true });
      const canonical = getTaskFlowById(flowId)!;
      const tampered = { ...canonical, cancelRequestedAt: undefined };
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map([[flowId, tampered]]) }),
          saveSnapshot: () => {},
        },
      });

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "untrusted_governed_state", flow: tampered });
    });
  });
});

function operation(
  flowId: string,
  name: GovernedMissionOperation["operation"],
  extra: Record<string, unknown> = {},
): GovernedMissionOperation {
  const flow = getTaskFlowById(flowId);
  const mission = flow ? readGovernedMissionStateFromTaskFlow(flow) : undefined;
  if (!flow || !mission) {
    throw new Error("expected governed flow");
  }
  return {
    operation: name,
    expectedRevision: mission.revision,
    idempotencyKey: `${name}-${mission.revision}`,
    owner: "Will",
    controllerId: "controller-1",
    bindings: {
      contractHash: mission.contractHash,
      authorityHash: mission.authorityHash,
      planRevisionId: mission.planRevisionId,
      sourceRevision: mission.sourceRevision,
      runtimeBuildSha256: mission.runtimeBuildSha256,
      policyVersion: mission.policyVersion,
      skillSha256: mission.skillSha256,
    },
    occurredAt: `2026-09-17T00:00:${String(mission.revision).padStart(2, "0")}.000Z`,
    ...extra,
  } as GovernedMissionOperation;
}

describe("governed mission SQLite runtime", () => {
  it("atomically persists an allowed state change and its receipt across restore", async () => {
    await withRuntime((flowId) => {
      const applied = applyGovernedMissionOperation({
        flowId,
        request: operation(flowId, "startWorkOrder"),
      });
      expect(applied.status).toBe("applied");
      expect(getTaskFlowById(flowId)).toMatchObject({ revision: 1, status: "running" });
      const receipts = listGovernedMissionReceipts({ flowId });
      expect(receipts).toHaveLength(2);
      expect(receipts.find((receipt) => receipt.operation === "startWorkOrder")).toMatchObject({
        expectedRevision: 1,
        resultingRevision: 2,
      });
      const ledger = receipts.toSorted(
        (left, right) => (left.ledgerSequence ?? 0) - (right.ledgerSequence ?? 0),
      );
      expect(ledger.map((receipt) => receipt.ledgerSequence)).toEqual([1, 2]);
      expect(ledger[0]).toMatchObject({
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        governedPackageSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(ledger[1]).toMatchObject({
        previousReceiptSha256: ledger[0]?.receiptSha256,
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        governedPackageSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });

      resetTaskFlowRegistryForTests({ persist: false });
      const restored = getTaskFlowById(flowId);
      expect(readGovernedMissionStateFromTaskFlow(restored!)).toMatchObject({
        currentGovernedState: "executing",
        revision: 2,
      });
    });
  });

  it("writes one denial receipt without changing state and returns it on identical retry", async () => {
    await withRuntime((flowId) => {
      const started = applyGovernedMissionOperation({
        flowId,
        request: operation(flowId, "startWorkOrder"),
      });
      expect(started.status).toBe("applied");
      const request = operation(flowId, "recordImplementationResult", { passed: false });
      const before = getTaskFlowById(flowId)!;
      const denied = applyGovernedMissionOperation({ flowId, request });
      expect(denied.status).toBe("repair_required");
      expect(getTaskFlowById(flowId)).toEqual(before);
      expect(listGovernedMissionReceipts({ flowId })).toHaveLength(3);
      for (let index = 0; index < 55; index += 1) {
        expect(
          applyGovernedMissionOperation({
            flowId,
            request: operation(flowId, "requestCloseout", {
              idempotencyKey: `audit-window-noise-${index}`,
              controllerId: "wrong-controller",
            }),
          }).status,
        ).toBe("denied");
      }
      expect(listTaskFlowAuditFindings({ now: Date.parse(now) })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "governed_repair_required", flow: before }),
        ]),
      );
      const receiptCountAfterNoise = listGovernedMissionReceipts({ flowId, limit: 100 }).length;
      expect(receiptCountAfterNoise).toBe(58);

      const retry = applyGovernedMissionOperation({ flowId, request });
      expect(retry.status).toBe("already_applied");
      expect(listGovernedMissionReceipts({ flowId, limit: 100 })).toHaveLength(
        receiptCountAfterNoise,
      );

      const laterRetry = applyGovernedMissionOperation({
        flowId,
        request: { ...request, occurredAt: "2026-09-17T01:00:00.000Z" },
      });
      expect(laterRetry.status).toBe("already_applied");
      expect(listGovernedMissionReceipts({ flowId, limit: 100 })).toHaveLength(
        receiptCountAfterNoise,
      );

      const changed = applyGovernedMissionOperation({
        flowId,
        request: { ...request, passed: true } as GovernedMissionOperation,
      });
      expect(changed).toMatchObject({
        status: "conflict",
        reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT",
      });
    });
  });

  it("keeps admission idempotent across server-observation timestamps", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const input = createAdmissionInput(state.stateDir);
      const admitted = admitGovernedMissionToTaskFlow(input);
      expect(admitted.status).toBe("admitted");

      const observedAt = "2026-09-17T01:00:00.000Z";
      const retry = admitGovernedMissionToTaskFlow({
        ...input,
        createdAt: Date.parse(observedAt),
        admission: {
          ...input.admission,
          now: observedAt,
          enforcementCapabilities: input.admission.enforcementCapabilities.map((fact) =>
            Object.assign({}, fact, { observedAt }),
          ),
        },
      });
      expect(retry.status).toBe("already_applied");
    });
  });

  it("initializes the governed ledger after a read-only lookup on an upgraded database", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const database = openOpenClawStateDatabase();
      database.db.exec("DROP TABLE governed_mission_artifacts");
      database.db.exec("DROP TABLE governed_mission_receipts");
      closeOpenClawStateDatabase();

      expect(listGovernedMissionReceipts({ flowId: "not-yet-admitted" })).toEqual([]);
      const admitted = admitGovernedMissionToTaskFlow(createAdmissionInput(state.stateDir));
      expect(admitted).toMatchObject({ status: "admitted" });
      if (admitted.status === "admitted") {
        expect(listGovernedMissionReceipts({ flowId: admitted.flow.flowId })).toHaveLength(1);
      }
    });
  });

  it("normalizes governed flow ownership and audits invalid owner/controller identities", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const admitted = admitGovernedMissionToTaskFlow({
        ...createAdmissionInput(state.stateDir),
        ownerKey: "  Will  ",
        controllerId: "  controller-1  ",
      });
      expect(admitted).toMatchObject({
        status: "admitted",
        flow: { ownerKey: "Will", controllerId: "controller-1" },
      });
      if (admitted.status !== "admitted") {
        throw new Error(`expected admission, got ${admitted.status}`);
      }
      expect(readGovernedMissionStateFromTaskFlow(admitted.flow)).toMatchObject({
        ownerCorrelation: { owner: "Will" },
      });
    });

    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const invalidOwner = admitGovernedMissionToTaskFlow({
        ...createAdmissionInput(state.stateDir),
        idempotencyKey: "invalid-owner",
        ownerKey: "   ",
      });
      expect(invalidOwner).toMatchObject({
        status: "denied",
        reasonCode: "FLOW_OWNER_INVALID",
        receipt: { decision: "denied" },
      });
      expect(invalidOwner).not.toHaveProperty("receipt.flowId");
      const invalidController = admitGovernedMissionToTaskFlow({
        ...createAdmissionInput(state.stateDir),
        idempotencyKey: "invalid-controller",
        controllerId: "   ",
      });
      expect(invalidController).toMatchObject({
        status: "denied",
        reasonCode: "FLOW_CONTROLLER_INVALID",
      });
      expect(invalidController).not.toHaveProperty("receipt.flowId");
    });
  });

  it("denies admission when any required compiled gate lacks a declaration", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const input = createAdmissionInput(state.stateDir, ["test", "rollback"]);
      const result = admitGovernedMissionToTaskFlow({
        ...input,
        artifactDeclarations: input.artifactDeclarations.filter(
          (declaration) => declaration.gateId !== "REQ-1:rollback",
        ),
      });
      expect(result).toMatchObject({
        status: "denied",
        reasonCode: "ARTIFACT_DECLARATION_REQUIRED_GATE_MISSING",
      });
      expect(result).not.toHaveProperty("receipt.flowId");
      if (result.status !== "denied") {
        throw new Error(`expected denied admission, got ${result.status}`);
      }
      const retry = admitGovernedMissionToTaskFlow({
        ...input,
        artifactDeclarations: input.artifactDeclarations.filter(
          (declaration) => declaration.gateId !== "REQ-1:rollback",
        ),
      });
      expect(retry).toMatchObject({
        status: "already_applied",
        receipt: { receiptId: result.receipt.receiptId },
      });
      expect(retry).not.toHaveProperty("receipt.flowId");
      expect(
        admitGovernedMissionToTaskFlow({
          ...input,
          goal: "Changed denied admission payload",
          artifactDeclarations: input.artifactDeclarations.filter(
            (declaration) => declaration.gateId !== "REQ-1:rollback",
          ),
        }),
      ).toEqual({ status: "conflict", reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT" });
    });
  });

  it("persists malformed pre-flow packages with a stable admission attempt identity", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const input = createAdmissionInput(state.stateDir);
      const malformed = {
        ...input,
        idempotencyKey: "malformed-package-attempt",
        admission: { ...input.admission, contract: undefined },
        artifactDeclarations: [],
      };
      const denied = admitGovernedMissionToTaskFlow(malformed);
      expect(denied).toMatchObject({
        status: "denied",
        reasonCode: "MALFORMED_CONTRACT_STATE",
        receipt: {
          missionId: expect.stringMatching(/^admission-attempt:/u),
          attemptId: expect.stringMatching(/^admission-attempt:/u),
          decision: "denied",
        },
      });
      expect(denied).not.toHaveProperty("receipt.flowId");
      const retry = admitGovernedMissionToTaskFlow(malformed);
      expect(retry).toMatchObject({
        status: "already_applied",
        receipt: { receiptId: denied.status === "denied" ? denied.receipt.receiptId : "missing" },
      });
      const conflicting = admitGovernedMissionToTaskFlow({
        ...malformed,
        goal: "Changed malformed attempt",
      });
      expect(conflicting).toEqual({
        status: "conflict",
        reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT",
      });

      const validInput = createAdmissionInput(state.stateDir);
      const planMismatch = {
        ...validInput,
        idempotencyKey: "plan-mismatch-attempt",
        compiledPlan: {
          ...validInput.compiledPlan,
          manifest: { ...validInput.compiledPlan.manifest, sourceRevision: "wrong-source" },
        },
      };
      const planDenied = admitGovernedMissionToTaskFlow(planMismatch);
      expect(planDenied).toMatchObject({
        status: "denied",
        reasonCode: "COMPILED_PLAN_CONTRACT_MISMATCH",
        receipt: { decision: "denied" },
      });
      expect(admitGovernedMissionToTaskFlow(planMismatch)).toMatchObject({
        status: "already_applied",
        receipt: { receiptId: planDenied.status === "denied" ? planDenied.receipt.receiptId : "" },
      });

      const malformedGates = admitGovernedMissionToTaskFlow({
        ...validInput,
        idempotencyKey: "malformed-gates-attempt",
        compiledPlan: {
          ...validInput.compiledPlan,
          gates: undefined,
        } as unknown as AdmitGovernedMissionToTaskFlowInput["compiledPlan"],
      });
      expect(malformedGates).toMatchObject({
        status: "denied",
        reasonCode: "COMPILED_PLAN_CONTRACT_MISMATCH",
        receipt: { decision: "denied" },
      });
    });
  });

  it("denies contract packages whose owner or rollback receipt cannot be fulfilled", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const input = createAdmissionInput(state.stateDir);
      const unsupportedOwner = admitGovernedMissionToTaskFlow({
        ...input,
        idempotencyKey: "unsupported-owner",
        admission: {
          ...input.admission,
          contract: {
            ...contract,
            authoritativeCompletionOwner: "task_flow",
          } as unknown as GovernedMissionContract,
        },
      });
      expect(unsupportedOwner).toMatchObject({
        status: "denied",
        reasonCode: "MALFORMED_CONTRACT_STATE",
      });

      const unsatisfiedRollback = admitGovernedMissionToTaskFlow({
        ...input,
        idempotencyKey: "unsatisfied-rollback",
        admission: {
          ...input.admission,
          contract: {
            ...contract,
            requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS, "rollback"],
          },
        },
      });
      expect(unsatisfiedRollback).toMatchObject({
        status: "denied",
        reasonCode: "REQUIRED_RECEIPT_KIND_UNSATISFIABLE",
      });
      expect(unsatisfiedRollback).not.toHaveProperty("receipt.flowId");
    });
  });

  it("denies contracts that require receipt classes the runtime cannot produce", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const input = createAdmissionInput(state.stateDir);
      const result = admitGovernedMissionToTaskFlow({
        ...input,
        admission: {
          ...input.admission,
          contract: {
            ...contract,
            requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS, "override"],
          },
        },
      });

      expect(result).toMatchObject({
        status: "denied",
        reasonCode: "MALFORMED_CONTRACT_STATE",
      });
      expect(result).not.toHaveProperty("receipt.flowId");
    });
  });

  it("derives proof meaning from the pinned gate instead of caller artifactKind", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const input = createAdmissionInput(state.stateDir);
      const admitted = admitGovernedMissionToTaskFlow({
        ...input,
        artifactDeclarations: input.artifactDeclarations.map((declaration) =>
          Object.assign({}, declaration, { artifactKind: "rollback" as const }),
        ),
      });
      if (admitted.status !== "admitted") {
        throw new Error(`expected admission, got ${admitted.status}`);
      }
      const flowId = admitted.flow.flowId;
      for (const [name, extra] of [
        ["startWorkOrder", {}],
        ["recordImplementationResult", { passed: true }],
        ["recordValidationResult", { passed: true }],
        ["recordReviewResult", { passed: true }],
        ["requestCloseout", {}],
      ] as const) {
        expect(
          applyGovernedMissionOperation({ flowId, request: operation(flowId, name, extra) }).status,
        ).toBe("applied");
      }
      const artifactPath = path.join(state.stateDir, "REQ-1-test.json");
      await fs.writeFile(artifactPath, artifactBody);
      const verified = await verifyAndApplyGovernedMissionArtifacts({
        flowId,
        request: operation(flowId, "verifyRequiredArtifacts", {
          passed: false,
        }) as Extract<GovernedMissionOperation, { operation: "verifyRequiredArtifacts" }>,
        observedAtMs: Date.parse(now),
      });
      expect(verified.status).toBe("applied");
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        proofs: { artifacts: "passed", rollback: "not_required" },
      });
    });
  });

  it("keeps a governed flow open when completion proof is missing", async () => {
    await withRuntime((flowId) => {
      const before = getTaskFlowById(flowId)!;
      const result = finishFlow({ flowId, expectedRevision: before.revision });

      expect(result).toMatchObject({
        applied: false,
        reason: "guard_blocked",
        current: before,
        blockedSummary: expect.stringContaining(
          "next action is to complete the named governed proof operation",
        ),
      });
      expect(getTaskFlowById(flowId)).toEqual(before);
    });
  });

  it("fences one canonical TaskFlow per mission across admission keys", async () => {
    await withRuntime((flowId, stateDir) => {
      const retry = admitGovernedMissionToTaskFlow({
        ...createAdmissionInput(stateDir),
        idempotencyKey: "admit-same-mission-new-key",
      });
      expect(retry).toMatchObject({
        status: "already_applied",
        flow: { flowId },
        receipt: { flowId },
      });

      const conflicting = admitGovernedMissionToTaskFlow({
        ...createAdmissionInput(stateDir),
        idempotencyKey: "admit-conflicting-mission-key",
        goal: "Conflicting mission definition",
      });
      expect(conflicting).toEqual({
        status: "conflict",
        reasonCode: "MISSION_ALREADY_ADMITTED",
      });
      expect(listGovernedMissionReceipts({ flowId })).toHaveLength(1);
    });
  });

  it("retains one canonical governed mission claim per owner session", async () => {
    await withRuntime(async (flowId, stateDir) => {
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }).status,
      ).toBe("applied");
      expect(await cancelFlowById({ cfg: {}, flowId })).toMatchObject({
        cancelled: true,
        flow: { status: "cancelled" },
      });

      const secondMission = admitGovernedMissionToTaskFlow(
        createAdmissionInput(stateDir, ["test"], {
          missionId: "mission-runtime-2",
          idempotencyKey: "admit-mission-runtime-2",
        }),
      );

      expect(secondMission).toEqual({
        status: "conflict",
        reasonCode: "OWNER_SESSION_ALREADY_GOVERNED",
      });
    });
  });

  it("denies admission while the owner session has an already-started agent run", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const releaseOwnerRun = beginOwnerRunForGovernedMissionAdmission("Will");
      try {
        expect(admitGovernedMissionToTaskFlow(createAdmissionInput(state.stateDir))).toMatchObject({
          status: "denied",
          reasonCode: "OWNER_SESSION_RUN_ACTIVE",
        });
      } finally {
        releaseOwnerRun();
      }
    });
  });

  it("rejects a structurally valid governed state without canonical admission provenance", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const flowId = "forged-governed-flow";
      const mission = createGovernedMissionState({
        contract,
        authorityRef,
        currentStep: "forged_admission",
        ownerCorrelation: { owner: "Will", taskFlowId: flowId },
        now,
      });
      const forgedFlow = {
        flowId,
        syncMode: "managed" as const,
        ownerKey: "Will",
        controllerId: "controller-1",
        revision: 0,
        status: "queued" as const,
        notifyPolicy: "done_only" as const,
        goal: "Forged governed flow",
        currentStep: mission.currentStep,
        stateJson: { governedMissionState: mission },
        createdAt: Date.parse(now),
        updatedAt: Date.parse(now),
      };
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map([[flowId, forgedFlow]]) }),
          saveSnapshot: () => {},
        },
      });

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "untrusted_governed_state", flow: forgedFlow });
      expect(listTaskFlowAuditFindings()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "governed_admission_receipt_missing",
            flow: forgedFlow,
          }),
        ]),
      );
    });
  });

  it("rejects proof tampering that preserves the old mission state and revision", async () => {
    await withRuntime((flowId) => {
      const canonical = getTaskFlowById(flowId)!;
      const mission = readGovernedMissionStateFromTaskFlow(canonical)!;
      const tampered: typeof canonical = {
        ...canonical,
        stateJson: {
          ...(canonical.stateJson as Record<string, never>),
          governedMissionState: {
            ...mission,
            proofs: { ...mission.proofs, implementation: "passed" },
          },
        },
      };
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map([[flowId, tampered]]) }),
          saveSnapshot: () => {},
        },
      });

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "untrusted_governed_state", flow: tampered });
    });
  });

  it("rejects TaskFlow lifecycle field tampering against canonical provenance", async () => {
    await withRuntime((flowId) => {
      const canonical = getTaskFlowById(flowId)!;
      const variants = [
        {
          field: "revision",
          tampered: { ...canonical, revision: canonical.revision + 1 },
        },
        {
          field: "createdAt",
          tampered: { ...canonical, createdAt: canonical.createdAt - 1 },
        },
        {
          field: "updatedAt",
          tampered: { ...canonical, updatedAt: canonical.updatedAt + 1 },
        },
      ];

      for (const { field, tampered } of variants) {
        resetTaskFlowRegistryForTests({ persist: false });
        configureTaskFlowRegistryRuntime({
          store: {
            loadSnapshot: () => ({ flows: new Map([[flowId, tampered]]) }),
            saveSnapshot: () => {},
          },
        });

        expect(
          applyGovernedMissionOperation({
            flowId,
            request: operation(flowId, "startWorkOrder"),
          }),
          `${field} tampering must invalidate governed provenance`,
        ).toMatchObject({ status: "untrusted_governed_state", flow: tampered });
      }
    });
  });

  it("rejects production-continuation tampering covered by the governed package hash", async () => {
    await withRuntime((flowId) => {
      const canonical = getTaskFlowById(flowId)!;
      const stateJson = canonical.stateJson as Record<string, unknown>;
      const continuation = stateJson.productionContinuation as Record<string, unknown>;
      const tampered: typeof canonical = {
        ...canonical,
        stateJson: {
          ...stateJson,
          productionContinuation: { ...continuation, parentRunOpen: false },
        } as typeof canonical.stateJson,
      };
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map([[flowId, tampered]]) }),
          saveSnapshot: () => {},
        },
      });

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "untrusted_governed_state", flow: tampered });
    });
  });

  it("rejects changes to production authorization fields outside governed state", async () => {
    await withRuntime((flowId) => {
      const canonical = getTaskFlowById(flowId)!;
      const tampered: typeof canonical = {
        ...canonical,
        stateJson: {
          ...(canonical.stateJson as Record<string, unknown>),
          authorityPath: "/forged-build-plan.md",
          buildItem: "forged-item",
          requiredOwnerLane: "forged-lane",
          executorRole: "forged-executor",
          lawfulRouteRequired: "forged-route",
        } as typeof canonical.stateJson,
      };
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map([[flowId, tampered]]) }),
          saveSnapshot: () => {},
        },
      });

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "untrusted_governed_state", flow: tampered });
    });
  });

  it("rejects executor-assignment tampering covered by the governed package hash", async () => {
    await withRuntime((flowId) => {
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "applied" });
      expect(
        prepareGovernedMissionAgentRun({ ownerKey: "Will", runId: "assignment-attempt" }),
      ).toMatchObject({ status: "bound", flowId });
      closeGovernedMissionExecutionLease({ flowId, runId: "assignment-attempt" });
      expect(
        recordProductionExecutorAssignment({
          flowId,
          taskId: "implementation-task",
          expectedRunId: "run-1",
          executorId: "coding-agent",
          ownerLane: "implementation",
          proofPurpose: "implementation",
          role: "Coding Agent",
          permitted: ["repo_read", "repo_write"],
          prohibited: ["runtime_restart"],
          evidenceRefs: ["work-order:implementation"],
          assignedAt: Date.parse(now),
        }),
      ).toMatchObject({ applied: true });
      const canonical = getTaskFlowById(flowId)!;
      const stateJson = canonical.stateJson as Record<string, unknown>;
      const assignments = stateJson.productionExecutorAssignments as Array<Record<string, unknown>>;
      const tampered: typeof canonical = {
        ...canonical,
        stateJson: {
          ...stateJson,
          productionExecutorAssignments: assignments.map((assignment) =>
            Object.assign({}, assignment, { executorId: "untrusted-executor" }),
          ),
        } as typeof canonical.stateJson,
      };
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map([[flowId, tampered]]) }),
          saveSnapshot: () => {},
        },
      });

      expect(
        recordProductionExecutorAssignment({
          flowId,
          taskId: "tampered-assignment-task",
          expectedRunId: "run-tampered",
          executorId: "coding-agent",
          ownerLane: "implementation",
          proofPurpose: "implementation",
          role: "Coding Agent",
          permitted: ["repo_read"],
          prohibited: ["runtime_restart"],
          evidenceRefs: ["work-order:tamper-check"],
          assignedAt: Date.parse(now) + 1,
        }),
      ).toEqual({
        applied: false,
        reason: "production_executor_assignment_governance_untrusted",
      });

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "untrusted_governed_state", flow: tampered });
    });
  });

  it("rejects replay of a pre-cancellation governed package", async () => {
    await withRuntime(async (flowId) => {
      const admitted = getTaskFlowById(flowId)!;
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }).status,
      ).toBe("applied");
      expect(await cancelFlowById({ cfg: {}, flowId })).toMatchObject({ cancelled: true });

      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map([[flowId, admitted]]) }),
          saveSnapshot: () => {},
        },
      });

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "untrusted_governed_state", flow: admitted });
    });
  });

  it("rejects tampering anywhere in the canonical receipt chain", async () => {
    await withRuntime((flowId) => {
      for (const [name, extra] of [
        ["startWorkOrder", {}],
        ["recordImplementationResult", { passed: true }],
        ["recordValidationResult", { passed: true }],
      ] as const) {
        expect(
          applyGovernedMissionOperation({ flowId, request: operation(flowId, name, extra) }).status,
        ).toBe("applied");
      }
      const { db } = openOpenClawStateDatabase();
      db.prepare(
        "UPDATE governed_mission_receipts SET details_json = ? WHERE flow_id = ? AND ledger_sequence = 1",
      ).run('{"tampered":true}', flowId);

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "recordReviewResult", { passed: true }),
        }),
      ).toMatchObject({ status: "untrusted_governed_state" });
    });
  });

  it("rejects a self-hashed runtime head with a forged predecessor link", async () => {
    await withRuntime((flowId) => {
      expect(
        applyGovernedMissionOperation({ flowId, request: operation(flowId, "startWorkOrder") }),
      ).toMatchObject({ status: "applied" });
      const head = listGovernedMissionReceipts({ flowId }).find(
        (receipt) => receipt.operation === "startWorkOrder",
      );
      expect(head).toBeDefined();
      const forged = {
        ...head!,
        previousReceiptSha256: "f".repeat(64),
        receiptSha256: undefined,
      };
      const { db } = openOpenClawStateDatabase();
      db.prepare(
        "UPDATE governed_mission_receipts SET previous_receipt_sha256 = ?, receipt_sha256 = ? WHERE receipt_id = ?",
      ).run(
        forged.previousReceiptSha256,
        computeGovernedMissionReceiptSha256(forged),
        forged.receiptId,
      );

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "recordImplementationResult", { passed: true }),
        }),
      ).toMatchObject({ status: "untrusted_governed_state" });
    });
  });

  it("does not bless a tampered receipt chain when cancellation is requested", async () => {
    await withRuntime((flowId) => {
      expect(
        applyGovernedMissionOperation({ flowId, request: operation(flowId, "startWorkOrder") }),
      ).toMatchObject({ status: "applied" });
      const flow = getTaskFlowById(flowId)!;
      const { db } = openOpenClawStateDatabase();
      db.prepare(
        "UPDATE governed_mission_receipts SET details_json = ? WHERE flow_id = ? AND ledger_sequence = 1",
      ).run('{"tampered":true}', flowId);

      expect(
        requestFlowCancel({
          flowId,
          expectedRevision: flow.revision,
          cancelRequestedAt: Date.parse(now),
        }),
      ).toMatchObject({ applied: false, reason: "revision_conflict" });
      expect(getTaskFlowById(flowId)).toEqual(flow);
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "recordImplementationResult", { passed: true }),
        }),
      ).toMatchObject({ status: "untrusted_governed_state" });
    });
  });

  it("does not return an unpersisted candidate flow after a concurrent admission win", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({ flows: new Map() }),
          saveSnapshot: () => {},
          commitGovernance: (commit) => ({
            status: "already_applied",
            receipt: { ...commit.receipt, flowId: "concurrent-winner-flow" },
          }),
        },
      });

      const result = admitGovernedMissionToTaskFlow(createAdmissionInput(state.stateDir));
      expect(result).toMatchObject({
        status: "already_applied",
        receipt: { flowId: "concurrent-winner-flow" },
      });
      expect(result).not.toHaveProperty("flow");
    });
  });

  it("denies a governed operation when its pinned controller identity is omitted", async () => {
    await withRuntime((flowId) => {
      const request = operation(flowId, "startWorkOrder");
      delete request.controllerId;
      expect(applyGovernedMissionOperation({ flowId, request })).toMatchObject({
        status: "denied",
        decision: { reasonCode: "CONTROLLER_MISMATCH", stateChanged: false },
      });
    });
  });

  it("cancels the canonical mission through the public TaskFlow cancellation owner", async () => {
    await withRuntime(async (flowId) => {
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }).status,
      ).toBe("applied");

      const cancelled = await cancelFlowById({ cfg: {}, flowId });
      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
        flow: { status: "cancelled" },
      });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "cancelled",
        terminalStatus: "cancelled",
      });
      expect(listGovernedMissionReceipts({ flowId })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "cancelMission", decision: "applied" }),
        ]),
      );

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder", {
            idempotencyKey: "start-after-cancel",
          }),
        }),
      ).toMatchObject({ status: "irrelevant", flow: { status: "cancelled" } });
    });
  });

  it("does not report a replayed lease-blocked cancellation or maintenance retry as complete", async () => {
    await withRuntime(async (flowId) => {
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }).status,
      ).toBe("applied");
      expect(
        prepareGovernedMissionAgentRun({
          ownerKey: "Will",
          runId: "lease-blocked-cancel-run",
          occurredAt: "2026-09-17T00:01:00.000Z",
        }),
      ).toMatchObject({ status: "bound", flowId });

      const first = await cancelFlowById({ cfg: {}, flowId });
      const replay = await cancelFlowById({ cfg: {}, flowId });

      expect(first).toMatchObject({ found: true, cancelled: false });
      expect(replay).toMatchObject({ found: true, cancelled: false });
      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(getTaskFlowById(flowId)).toMatchObject({ status: "running" });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "executing",
        terminalStatus: "not_terminal",
        activeExecutionLease: { runId: "lease-blocked-cancel-run" },
      });
      expect(listGovernedMissionReceipts({ flowId })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "cancelMission",
            decision: "repair_required",
            reasonCode: "ACTIVE_EXECUTION_LEASE_OPEN",
          }),
        ]),
      );
    });
  });

  it("atomically rejects direct cancel and stop while child work remains active", async () => {
    await withRuntime(async (flowId) => {
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }).status,
      ).toBe("applied");
      expect(
        runTaskInFlow({
          flowId,
          runtime: "acp",
          childSessionKey: "agent:codex:acp:active-terminal-child",
          runId: "active-terminal-child",
          task: "Remain active across a direct terminal request",
          status: "running",
          startedAt: Date.parse(now),
          lastEventAt: Date.parse(now),
        }),
      ).toMatchObject({ created: true });

      for (const operationName of ["cancelMission", "stopMission"] as const) {
        expect(
          applyGovernedMissionOperation({
            flowId,
            request: operation(flowId, operationName, {
              idempotencyKey: `${operationName}-with-active-child`,
            }),
          }),
        ).toMatchObject({ status: "conflict", reasonCode: "ACTIVE_WORK_CONFLICT" });
      }
      expect(getTaskFlowById(flowId)).toMatchObject({ status: "running" });
      const mission = readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!);
      expect(mission).toMatchObject({
        currentGovernedState: "executing",
        terminalStatus: "not_terminal",
      });
    });
  });

  it("blocks governed progress after cancellation intent is persisted", async () => {
    await withRuntime(async (flowId) => {
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }).status,
      ).toBe("applied");
      const flow = getTaskFlowById(flowId)!;
      expect(
        requestFlowCancel({
          flowId,
          expectedRevision: flow.revision,
          cancelRequestedAt: Date.parse(now),
        }),
      ).toMatchObject({ applied: true });

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "recordImplementationResult", { passed: true }),
        }),
      ).toMatchObject({
        status: "denied",
        decision: { reasonCode: "CANCELLATION_PENDING", stateChanged: false },
      });
      expect(await cancelFlowById({ cfg: {}, flowId })).toMatchObject({
        found: true,
        cancelled: true,
      });
    });
  });

  it("rejects generic TaskFlow lifecycle mutations for a governed mission", async () => {
    await withRuntime((flowId) => {
      const flow = getTaskFlowById(flowId)!;
      const attempts = [
        resumeFlow({
          flowId,
          expectedRevision: flow.revision,
          status: "running",
          currentStep: "generic_resume",
        }),
        setFlowWaiting({
          flowId,
          expectedRevision: flow.revision,
          currentStep: "generic_wait",
        }),
        failFlow({
          flowId,
          expectedRevision: flow.revision,
          blockedSummary: "generic failure",
        }),
        updateFlowRecordByIdExpectedRevision({
          flowId,
          expectedRevision: flow.revision,
          patch: { cancelRequestedAt: Date.parse(now) },
        }),
        updateFlowRecordByIdExpectedRevision({
          flowId,
          expectedRevision: flow.revision,
          patch: { goal: "generic replacement goal" },
        }),
        updateFlowRecordByIdExpectedRevision({
          flowId,
          expectedRevision: flow.revision,
          patch: { notifyPolicy: "state_changes" },
        }),
      ];

      for (const result of attempts) {
        expect(result).toMatchObject({
          applied: false,
          reason: "guard_blocked",
          blockedSummary: expect.stringContaining("governed mission runtime"),
        });
      }
      expect(getTaskFlowById(flowId)).toEqual(flow);
    });
  });

  it("finalizes a persisted governed cancellation request through maintenance", async () => {
    await withRuntime(async (flowId) => {
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "blockForRepair", {
            reasonCode: "TEST_REPAIR_REQUIRED",
            nextAction: "Repair the test fixture.",
          }),
        }),
      ).toMatchObject({ status: "applied", flow: { status: "blocked" } });
      expect(listTaskFlowAuditFindings()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "governed_repair_required",
            detail: expect.stringContaining("repair_required"),
          }),
        ]),
      );
      const flow = getTaskFlowById(flowId)!;
      const requested = requestFlowCancel({
        flowId,
        expectedRevision: flow.revision,
        cancelRequestedAt: Date.parse(now),
      });
      expect(requested.applied).toBe(true);

      expect(await runTaskFlowRegistryMaintenance()).toMatchObject({ reconciled: 1 });
      expect(getTaskFlowById(flowId)).toMatchObject({ status: "cancelled" });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "cancelled",
        terminalStatus: "cancelled",
      });
      expect(listGovernedMissionReceipts({ flowId })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "cancelMission", decision: "applied" }),
        ]),
      );
    });
  });

  it("does not classify an admitted governed flow as a generic orphan", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      resetTaskFlowRegistryForTests({ persist: false });
      const admitted = admitGovernedMissionToTaskFlow({
        ...createAdmissionInput(state.stateDir),
        createdAt: 1,
      });
      expect(admitted.status).toBe("admitted");
      if (admitted.status !== "admitted") {
        throw new Error(`expected admission, got ${admitted.status}`);
      }

      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(getTaskFlowById(admitted.flow.flowId)).toMatchObject({ status: "queued" });
    });
  });

  it("commits only one of two operations racing on the same mission revision", async () => {
    await withRuntime((flowId) => {
      applyGovernedMissionOperation({
        flowId,
        request: operation(flowId, "startWorkOrder"),
      });
      const first = operation(flowId, "recordImplementationResult", {
        idempotencyKey: "implementation-race-1",
        passed: true,
      });
      const second = {
        ...first,
        idempotencyKey: "implementation-race-2",
      } as GovernedMissionOperation;

      expect(applyGovernedMissionOperation({ flowId, request: first }).status).toBe("applied");
      expect(applyGovernedMissionOperation({ flowId, request: second })).toMatchObject({
        status: "conflict",
        reasonCode: "REVISION_CONFLICT",
        receipt: {
          decision: "conflict",
          expectedRevision: first.expectedRevision,
          resultingRevision: first.expectedRevision + 1,
        },
      });
      expect(listGovernedMissionReceipts({ flowId })).toHaveLength(4);
    });
  });

  it("blocks on identity drift and reopens only after complete lawful readmission", async () => {
    await withRuntime(async (flowId, stateDir) => {
      expect(
        applyGovernedMissionOperation({ flowId, request: operation(flowId, "startWorkOrder") })
          .status,
      ).toBe("applied");
      const priorAttempt = prepareGovernedMissionAgentRun({
        ownerKey: "Will",
        runId: "run-before-readmission",
      });
      expect(priorAttempt.status).toBe("bound");
      if (priorAttempt.status !== "bound") {
        throw new Error(`expected governed binding, got ${priorAttempt.status}`);
      }
      closeGovernedMissionExecutionLease({ flowId, runId: "run-before-readmission" });
      expect(
        recordGovernedMissionWithheldPayload({
          flowId,
          attemptReceiptId: priorAttempt.attemptReceiptId,
          payload: [{ text: "old identity output" }],
        }),
      ).toMatchObject({ applied: true });
      expect(
        recordProductionExecutorAssignment({
          flowId,
          taskId: "assignment-before-readmission",
          expectedRunId: "proof-before-readmission",
          executorId: "coding-agent",
          ownerLane: "implementation",
          proofPurpose: "implementation",
          role: "Coding Agent",
          permitted: ["repo_write"],
          prohibited: ["runtime_restart"],
          evidenceRefs: ["work-order:before-readmission"],
        }),
      ).toMatchObject({ applied: true });
      const priorAssignment = getProductionExecutorAssignment(
        getTaskFlowById(flowId)!,
        "assignment-before-readmission",
      )!;
      for (const [name, extra] of [
        ["recordImplementationResult", { passed: true }],
        ["recordValidationResult", { passed: true }],
        ["recordReviewResult", { passed: true }],
        ["requestCloseout", {}],
      ] as const) {
        expect(
          applyGovernedMissionOperation({ flowId, request: operation(flowId, name, extra) }).status,
        ).toBe("applied");
      }
      await fs.writeFile(path.join(stateDir, "REQ-1-test.json"), artifactBody);
      expect(
        await verifyAndApplyGovernedMissionArtifacts({
          flowId,
          request: operation(flowId, "verifyRequiredArtifacts", {
            passed: false,
          }) as Extract<GovernedMissionOperation, { operation: "verifyRequiredArtifacts" }>,
          observedAtMs: Date.parse(now),
        }),
      ).toMatchObject({ status: "applied" });
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "admitTerminalPendingWatchdog", {
            parentScopeClosed: true,
            openWorkCount: 0,
          }),
        }),
      ).toMatchObject({ status: "applied" });
      expect(getTaskFlowProductionContinuation(getTaskFlowById(flowId)!)).toMatchObject({
        parentRunOpen: false,
        lawfulWholeRunCompletion: true,
        lawfulStopReason: "whole_run_complete",
      });
      expect(flowRequiresActiveWorkWatchdog(getTaskFlowById(flowId)!)).toBe(false);

      const drifted = operation(flowId, "startWorkOrder");
      drifted.bindings.runtimeBuildSha256 = "build-2";

      expect(applyGovernedMissionOperation({ flowId, request: drifted })).toMatchObject({
        status: "denied",
        decision: {
          reasonCode: "RUNTIME_BUILD_MISMATCH",
          stateChanged: true,
        },
        flow: { status: "blocked" },
      });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "readmission_required",
        blockedStatus: "runtime_build_mismatch",
      });

      const replacementIdentity = {
        contractId: contract.contractId,
        contractVersion: "2",
        contractHash: contract.contractHash,
        authorityHash: "authority-hash-2",
        authorityRef: { ...authorityRef, sha256: "authority-hash-2" },
        planRevisionId: "plan-2",
        sourceRevision: "source-2",
        runtimeBuildSha256: "build-2",
        policyVersion: "policy-2",
        skillSha256: "skill-2",
      };
      const replacementCompiledPlan = compileMissionPlan({
        manifest: {
          schema: "openclaw.mission_manifest.v1",
          missionId: contract.missionId,
          planRevisionId: replacementIdentity.planRevisionId,
          planSha256: "plan-2-sha",
          sourceRevision: replacementIdentity.sourceRevision,
          runtimeBuildSha256: replacementIdentity.runtimeBuildSha256,
          policyVersion: replacementIdentity.policyVersion,
          skillSha256: replacementIdentity.skillSha256,
          mode: "enforce",
          scopeHash: "scope-2",
          authorizedScopeHash: "scope-2",
          planRevisionAuthorized: true,
          createdAt: now,
        },
        requirements: [{ id: "REQ-2", text: "Prove replacement", required: true }],
        gateKinds: ["test"],
      });
      const readmission = operation(flowId, "requestReadmission", {
        replacementIdentity,
        replacementContract: {
          ...contract,
          contractId: replacementIdentity.contractId,
          contractVersion: replacementIdentity.contractVersion,
          contractHash: replacementIdentity.contractHash,
          authorityHash: replacementIdentity.authorityHash,
          authorityRefs: [replacementIdentity.authorityRef],
          planRevisionId: replacementIdentity.planRevisionId,
          sourceRevision: replacementIdentity.sourceRevision,
          runtimeBuildSha256: replacementIdentity.runtimeBuildSha256,
          policyVersion: replacementIdentity.policyVersion,
          skillSha256: replacementIdentity.skillSha256,
        },
        replacementCompiledPlan,
        replacementArtifactDeclarations: [
          {
            artifactId: "replacement-proof",
            artifactKind: "validation",
            missionId: contract.missionId,
            workOrderId: "work-2",
            gateId: "REQ-2:test",
            allowedRoot: stateDir,
            pathname: path.join(stateDir, "replacement-proof.json"),
            required: true,
            identityBindings: {
              missionId: contract.missionId,
              contractHash: replacementIdentity.contractHash,
              authorityHash: replacementIdentity.authorityHash,
              planRevisionId: replacementIdentity.planRevisionId,
              sourceRevision: replacementIdentity.sourceRevision,
              runtimeBuildSha256: replacementIdentity.runtimeBuildSha256,
              policyVersion: replacementIdentity.policyVersion,
              skillSha256: replacementIdentity.skillSha256,
            },
          },
        ],
      });
      const readmissionRequest = readmission as Extract<
        GovernedMissionOperation,
        { operation: "requestReadmission" }
      >;
      const unsatisfiableReadmission = {
        ...readmissionRequest,
        idempotencyKey: "readmission-unsatisfied-rollback",
        replacementContract: {
          ...readmissionRequest.replacementContract,
          requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS, "rollback"],
        },
      } as GovernedMissionOperation;
      expect(
        applyGovernedMissionOperation({ flowId, request: unsatisfiableReadmission }),
      ).toMatchObject({
        status: "denied",
        decision: { reasonCode: "READMISSION_PLAN_MISMATCH", stateChanged: false },
      });
      expect(applyGovernedMissionOperation({ flowId, request: readmissionRequest })).toMatchObject({
        status: "applied",
        flow: { status: "queued" },
        receipt: { contractReceiptKinds: ["admission", "policy_decision"] },
      });
      expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
        currentGovernedState: "admitted",
        contractVersion: "2",
        runtimeBuildSha256: "build-2",
        blockedStatus: "not_blocked",
      });
      expect(readGovernedMissionWithheldPayload(getTaskFlowById(flowId)!)).toBeUndefined();
      expect(
        isProductionExecutorAssignmentCurrentGovernedAttempt({
          flow: getTaskFlowById(flowId)!,
          assignment: priorAssignment,
        }),
      ).toBe(false);
      expect(getTaskFlowById(flowId)).toMatchObject({
        stateJson: {
          productionContinuation: {
            activeProductionRun: true,
            currentUnitStatus: "started",
            parentRunOpen: true,
            lawfulWholeRunCompletion: false,
            continuationRequiredAfterLocalSuccess: false,
            nextExecutableUnitIdentified: false,
            nextExecutableUnitLaunched: false,
          },
          governedMissionPlan: { manifest: { planRevisionId: "plan-2" } },
          governedMissionArtifactDeclarations: [
            { artifactId: "replacement-proof", identityBindings: { planRevisionId: "plan-2" } },
          ],
        },
      });
      expect(getTaskFlowProductionContinuation(getTaskFlowById(flowId)!)).not.toHaveProperty(
        "lawfulStopReason",
      );
      expect(flowRequiresActiveWorkWatchdog(getTaskFlowById(flowId)!)).toBe(true);

      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "startWorkOrder"),
        }),
      ).toMatchObject({ status: "applied", flow: { status: "running" } });
      expect(
        recordGovernedMissionWithheldPayload({
          flowId,
          attemptReceiptId: priorAttempt.attemptReceiptId,
          payload: [{ text: "old identity output" }],
        }),
      ).toMatchObject({ applied: false, reason: "guard_blocked" });
      expect(
        recordProductionExecutorAssignment({
          flowId,
          taskId: "assignment-after-readmission",
          expectedRunId: "proof-after-readmission",
          executorId: "coding-agent",
          ownerLane: "implementation",
          proofPurpose: "implementation",
          role: "Coding Agent",
          permitted: ["repo_write"],
          prohibited: ["runtime_restart"],
          evidenceRefs: ["work-order:after-readmission"],
        }),
      ).toEqual({
        applied: false,
        reason: "production_executor_assignment_governed_attempt_missing",
      });
      const newLease = applyGovernedMissionOperation({
        flowId,
        request: operation(flowId, "openExecutionLease", {
          runId: "run-after-readmission",
          processId: process.pid,
          runtimeInstanceId: "test-runtime-after-readmission",
        }),
      });
      expect(newLease.status).toBe("applied");
      if (newLease.status !== "applied") {
        throw new Error(`expected a new execution lease, got ${newLease.status}`);
      }
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "closeExecutionLease", {
            runId: "run-after-readmission",
            idempotencyKey: "agent-run:run-after-readmission:close-execution-lease",
          }),
        }).status,
      ).toBe("applied");
      expect(
        recordGovernedMissionWithheldPayload({
          flowId,
          attemptReceiptId: newLease.receipt.receiptId,
          payload: [{ text: "new identity output" }],
        }),
      ).toMatchObject({ applied: true });
      expect(readGovernedMissionWithheldPayload(getTaskFlowById(flowId)!)).toMatchObject({
        attemptReceiptId: newLease.receipt.receiptId,
        payload: [{ text: "new identity output" }],
      });
      expect(
        recordProductionExecutorAssignment({
          flowId,
          taskId: "assignment-after-new-lease",
          expectedRunId: "proof-after-new-lease",
          executorId: "coding-agent",
          ownerLane: "implementation",
          proofPurpose: "implementation",
          role: "Coding Agent",
          permitted: ["repo_write"],
          prohibited: ["runtime_restart"],
          evidenceRefs: ["work-order:after-new-lease"],
        }),
      ).toMatchObject({
        applied: true,
        assignment: { governedAttemptReceiptId: newLease.receipt.receiptId },
      });
    });
  });

  it("derives active work from SQLite and fences new children once closeout starts", async () => {
    await withRuntime(async (flowId, stateDir) => {
      for (const [name, extra] of [
        ["startWorkOrder", {}],
        ["recordImplementationResult", { passed: true }],
        ["recordValidationResult", { passed: true }],
        ["recordReviewResult", { passed: true }],
      ] as const) {
        expect(
          applyGovernedMissionOperation({ flowId, request: operation(flowId, name, extra) }).status,
        ).toBe("applied");
      }
      expect(
        runTaskInFlow({
          flowId,
          runtime: "acp",
          childSessionKey: "agent:codex:acp:governed-child",
          runId: "governed-active-child",
          task: "Finish governed work",
          status: "running",
          startedAt: Date.parse(now),
          lastEventAt: Date.parse(now),
        }),
      ).toMatchObject({ created: true });
      expect(
        applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "requestCloseout"),
        }).status,
      ).toBe("applied");
      expect(
        runTaskInFlow({
          flowId,
          runtime: "acp",
          childSessionKey: "agent:codex:acp:late-child",
          runId: "governed-late-child",
          task: "Bypass closeout",
          status: "running",
          startedAt: Date.parse(now),
          lastEventAt: Date.parse(now),
        }),
      ).toMatchObject({
        created: false,
        reason: "Governed mission child creation is closed for closeout.",
      });

      const artifactPath = path.join(stateDir, "REQ-1-test.json");
      await fs.writeFile(artifactPath, artifactBody);
      await verifyAndApplyGovernedMissionArtifacts({
        flowId,
        request: operation(flowId, "verifyRequiredArtifacts", {
          passed: false,
        }) as Extract<GovernedMissionOperation, { operation: "verifyRequiredArtifacts" }>,
        observedAtMs: Date.parse(now),
      });
      const terminal = applyGovernedMissionOperation({
        flowId,
        request: operation(flowId, "admitTerminalPendingWatchdog", {
          parentScopeClosed: true,
          openWorkCount: 0,
        }),
      });
      expect(terminal).toMatchObject({
        status: "repair_required",
        decision: {
          reasonCode: "TERMINAL_PENDING_PROOF_MISSING",
          missingProof: ["open_work", "parent_scope"],
        },
      });
    });
  });

  it("preserves canonical parent-scope blockers during terminal admission", async () => {
    await withRuntime(
      async (flowId, stateDir) => {
        for (const [name, extra] of [
          ["startWorkOrder", {}],
          ["recordImplementationResult", { passed: true }],
          ["recordValidationResult", { passed: true }],
          ["recordReviewResult", { passed: true }],
          ["requestCloseout", {}],
        ] as const) {
          expect(
            applyGovernedMissionOperation({ flowId, request: operation(flowId, name, extra) })
              .status,
          ).toBe("applied");
        }
        const artifactPath = path.join(stateDir, "REQ-1-test.json");
        await fs.writeFile(artifactPath, artifactBody);
        try {
          expect(
            await verifyAndApplyGovernedMissionArtifacts({
              flowId,
              request: operation(flowId, "verifyRequiredArtifacts", {
                passed: false,
              }) as Extract<GovernedMissionOperation, { operation: "verifyRequiredArtifacts" }>,
              observedAtMs: Date.parse(now),
            }),
          ).toMatchObject({ status: "applied" });
        } finally {
          await fs.rm(artifactPath, { force: true });
        }

        expect(
          applyGovernedMissionOperation({
            flowId,
            request: operation(flowId, "admitTerminalPendingWatchdog", {
              parentScopeClosed: true,
              openWorkCount: 0,
            }),
          }),
        ).toMatchObject({
          status: "repair_required",
          decision: {
            reasonCode: "TERMINAL_PENDING_PROOF_MISSING",
            missingProof: ["parent_scope"],
          },
        });
        expect(getTaskFlowProductionContinuation(getTaskFlowById(flowId)!)).toMatchObject({
          blockerPresent: true,
          lawfulWholeRunCompletion: false,
        });
      },
      {
        continuation: {
          activeProductionRun: true,
          parentRunOpen: true,
          blockerPresent: true,
        },
      },
    );
  });

  it("runs admission through verified artifacts, watchdog, release, and visible delivery", async () => {
    await withRuntime(
      async (flowId, stateDir) => {
        const apply = (
          name: GovernedMissionOperation["operation"],
          extra: Record<string, unknown> = {},
        ) => {
          const result = applyGovernedMissionOperation({
            flowId,
            request: operation(flowId, name, extra),
          });
          expect(result.status).toBe("applied");
          return result;
        };

        const preparation = prepareGovernedMissionAgentRun({
          ownerKey: "Will",
          runId: "governed-agent-run-1",
          occurredAt: now,
        });
        expect(preparation).toMatchObject({ status: "bound", flowId });
        if (preparation.status !== "bound") {
          throw new Error(`expected governed agent binding, got ${preparation.status}`);
        }
        closeGovernedMissionExecutionLease({
          flowId,
          runId: "governed-agent-run-1",
          occurredAt: now,
        });
        expect(
          recordGovernedMissionWithheldPayload({
            flowId,
            attemptReceiptId: preparation.attemptReceiptId,
            payload: [{ text: "withheld result" }],
            capturedAt: Date.parse(now),
          }),
        ).toMatchObject({ applied: true });
        apply("recordImplementationResult", { passed: true });
        apply("recordValidationResult", { passed: true });
        apply("recordReviewResult", { passed: true });
        apply("requestCloseout");

        const beforeSpoof = getTaskFlowById(flowId)!;
        const spoofed = applyGovernedMissionOperation({
          flowId,
          request: operation(flowId, "verifyRequiredArtifacts", {
            idempotencyKey: "unverified-artifact-result",
            passed: true,
          }),
        });
        expect(spoofed).toMatchObject({ status: "repair_required" });
        expect(getTaskFlowById(flowId)).toEqual(beforeSpoof);

        try {
          await fs.writeFile(path.join(stateDir, "REQ-1-test.json"), artifactBody);
          const artifactRequest = operation(flowId, "verifyRequiredArtifacts", {
            passed: false,
          }) as Extract<GovernedMissionOperation, { operation: "verifyRequiredArtifacts" }>;
          const verified = await verifyAndApplyGovernedMissionArtifacts({
            flowId,
            request: artifactRequest,
            observedAtMs: Date.parse(now),
          });
          expect(verified.status).toBe("applied");
          await fs.writeFile(path.join(stateDir, "REQ-1-test.json"), "changed after commit\n");
          expect(
            await verifyAndApplyGovernedMissionArtifacts({
              flowId,
              request: artifactRequest,
              observedAtMs: Date.parse(now) + 60_000,
            }),
          ).toMatchObject({
            status: "already_applied",
            receipt: { receiptId: verified.status === "applied" ? verified.receipt.receiptId : "" },
          });
        } finally {
          await fs.rm(path.join(stateDir, "REQ-1-test.json"), { force: true });
        }

        expect(getTaskFlowProductionContinuation(getTaskFlowById(flowId)!)).toMatchObject({
          activeProductionRun: true,
          blockerPresent: false,
          ownerDecisionRequired: false,
          restartOrReloadRequired: false,
          hardStopPresent: false,
          safetyStopPresent: false,
          continuationViolation: false,
        });
        apply("admitTerminalPendingWatchdog", { parentScopeClosed: true, openWorkCount: 0 });
        const pending = readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!;
        apply("recordPostTerminalWatchdog", {
          passed: true,
          boundRevision: pending.revision,
          boundRuntimeBuildSha256: pending.runtimeBuildSha256,
        });
        apply("releaseFinalResult");
        expect(getTaskFlowById(flowId)).toMatchObject({ status: "terminal_pending_watchdog" });
        expect(getTaskFlowById(flowId)).toHaveProperty(
          "stateJson.governedMissionReleaseState.releaseAllowed",
          true,
        );
        expect(
          finishFlow({
            flowId,
            expectedRevision: getTaskFlowById(flowId)!.revision,
          }),
        ).toMatchObject({
          applied: false,
          reason: "guard_blocked",
          blockedSummary: expect.stringContaining("visible delivery proof"),
        });
        const cancelledBeforeDelivery = await cancelFlowById({ cfg: {}, flowId });
        expect(cancelledBeforeDelivery).toMatchObject({
          found: true,
          cancelled: false,
          reason: expect.stringContaining("awaiting delivery cannot be cancelled"),
          flow: { status: "terminal_pending_watchdog" },
        });
        expect(getTaskFlowById(flowId)?.cancelRequestedAt).toBeUndefined();
        apply("recordDeliveryResult", { passed: true });

        expect(getTaskFlowById(flowId)).toMatchObject({ status: "succeeded" });
        expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
          currentGovernedState: "released",
          terminalStatus: "succeeded",
          proofs: { artifacts: "passed", postTerminalWatchdog: "passed", delivery: "passed" },
        });
        expect(listGovernedMissionReceipts({ flowId })).toHaveLength(15);
        expect(hasGovernedMissionClaimForOwnerKey("Will")).toBe(true);
        expect(
          prepareGovernedMissionAgentRun({
            ownerKey: "Will",
            runId: "governed-agent-run-after-release",
          }),
        ).toMatchObject({
          status: "blocked",
          reasonCode: "GOVERNED_MISSION_SESSION_TERMINAL",
        });
        const dateNow = vi
          .spyOn(Date, "now")
          .mockReturnValue(Date.parse(now) + 8 * 24 * 60 * 60_000);
        try {
          expect(await runTaskFlowRegistryMaintenance()).toMatchObject({ pruned: 0 });
          expect(getTaskFlowById(flowId)).toBeDefined();
          expect(hasGovernedMissionClaimForOwnerKey("Will")).toBe(true);
        } finally {
          dateNow.mockRestore();
        }
      },
      { deliveryRequired: true },
    );
  });
});
