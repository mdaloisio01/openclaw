import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  validateTasksGovernanceApplyResult,
  validateTasksGovernancePreviewResult,
  validateTasksGovernanceStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { runBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronServiceContract } from "../../cron/service-contract.js";
import type { CronJob } from "../../cron/types.js";
import { ENFORCEMENT_HEALTH_CAPABILITIES } from "../../governance/enforcement-health.js";
import { computeGovernedFinalPayloadHash } from "../../governance/governed-final-release-decision.js";
import {
  closeGovernedMissionExecutionLease as closeGovernedMissionExecutionLeaseRuntime,
  prepareGovernedMissionAgentRun as prepareGovernedMissionAgentRunRuntime,
} from "../../governance/governed-mission-agent-runtime.js";
import {
  GOVERNED_REQUIRED_RECEIPT_KINDS,
  type GovernedMissionContract,
} from "../../governance/governed-mission-contract.js";
import { readGovernedWorkspaceSkillSha256 } from "../../governance/governed-mission-identity.js";
import {
  computeGovernedMissionPackageSha256,
  computeGovernedMissionReceiptSha256,
} from "../../governance/governed-mission-ledger-integrity.js";
import { beginOwnerRunForGovernedMissionAdmission } from "../../governance/governed-mission-owner-run-fence.js";
import { resolveGovernedArtifactOutputRoot } from "../../governance/governed-mission-production-admission.js";
import {
  admitGovernedMissionToTaskFlow,
  applyGovernedMissionOperation,
  isGovernedMissionStateCanonicallyPersisted,
  listGovernedMissionReceipts,
  recordGovernedMissionWithheldPayload,
  readGovernedMissionWithheldPayload,
} from "../../governance/governed-mission-runtime.js";
import { readGovernedMissionStateFromTaskFlow } from "../../governance/governed-mission-state.js";
import type { MissionManifest } from "../../governance/mission-manifest.types.js";
import {
  compileMissionPlan,
  computeCompiledMissionPlanSha256,
} from "../../governance/mission-plan-compiler.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
  ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME,
  installProductionWatchdogLifecycleGate,
  resetProductionWatchdogLifecycleGateForTests,
} from "../../tasks/active-production-watchdog-lifecycle.js";
import {
  getProductionExecutorAssignment,
  recordProductionExecutorAssignment,
} from "../../tasks/production-executor-assignment.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  getTaskById,
  finalizeTaskRunByRunId,
  listTasksForFlowId,
  markTaskTerminalById,
  recordTaskProgressByRunId,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  setTaskCleanupAfterById,
} from "../../tasks/runtime-internal.js";
import { configureTaskFlowRegistryRuntime } from "../../tasks/task-flow-registry.store.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  getTaskFlowProductionContinuation,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-flow-runtime-internal.js";
import { runTaskRegistryMaintenance } from "../../tasks/task-registry.maintenance.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { tasksHandlers } from "./tasks.js";
import type { RespondFn } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
type TaskResponsePayload = {
  tasks?: Array<Record<string, unknown>>;
  task?: Record<string, unknown>;
  executorIdentityProof?: Record<string, unknown>;
  found?: boolean;
  cancelled?: boolean;
  ok?: boolean;
  flowId?: string;
  initialEnabled?: boolean;
  afterOpenEnabled?: boolean;
  afterCloseEnabled?: boolean;
  flowStatus?: string;
  flow?: Record<string, unknown>;
  diagnostic?: Record<string, unknown>;
  result?: Record<string, unknown>;
  mission?: Record<string, unknown> | null;
  receipts?: Array<Record<string, unknown>>;
  preview?: Record<string, unknown>;
  governed?: boolean;
  canonical?: boolean;
  malformed?: boolean;
  status?: string;
  reasonCode?: string;
  decision?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  releasedPayload?: unknown;
};

let stateDir: string;
let governedRuntimeIdentityForTest:
  | { sourceRevision: string; runtimeBuildSha256: string }
  | undefined;
let governedSkillSha256ForTest: string | undefined;

function prepareGovernedMissionAgentRun(
  params: Omit<
    Parameters<typeof prepareGovernedMissionAgentRunRuntime>[0],
    "trustedRuntimeIdentity" | "observedSkillSha256"
  >,
) {
  return prepareGovernedMissionAgentRunRuntime({
    ...params,
    ...(governedRuntimeIdentityForTest
      ? { trustedRuntimeIdentity: governedRuntimeIdentityForTest }
      : {}),
    ...(governedSkillSha256ForTest ? { observedSkillSha256: governedSkillSha256ForTest } : {}),
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
    ...(governedRuntimeIdentityForTest
      ? { trustedRuntimeIdentity: governedRuntimeIdentityForTest }
      : {}),
    ...(governedSkillSha256ForTest ? { observedSkillSha256: governedSkillSha256ForTest } : {}),
  });
}

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-tasks-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetTaskRegistryControlRuntimeForTests();
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests({ persist: false });
  resetProductionWatchdogLifecycleGateForTests();
  governedRuntimeIdentityForTest = undefined;
  governedSkillSha256ForTest = undefined;
});

afterEach(async () => {
  resetProductionWatchdogLifecycleGateForTests();
  resetTaskFlowRegistryForTests({ persist: false });
  resetTaskRegistryControlRuntimeForTests();
  resetTaskRegistryForTests();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});

function captureRespond() {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  return { calls, respond };
}

function createWatchdogJob(enabled: boolean): CronJob {
  return {
    id: ACTIVE_WORK_WATCHDOG_CRON_JOB_ID,
    name: ACTIVE_WORK_WATCHDOG_CRON_JOB_NAME,
    enabled,
    agentId: "orchestrator",
    schedule: { kind: "cron", expr: "*/5 * * * *" },
    payload: { kind: "systemEvent", text: "watch active production" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    deleteAfterRun: false,
    createdAtMs: 100,
    updatedAtMs: 100,
    state: {},
  };
}

function createCronHarness(enabled: boolean): CronServiceContract & {
  job: CronJob;
  update: ReturnType<typeof vi.fn>;
} {
  const job = createWatchdogJob(enabled);
  return {
    job,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    status: vi.fn(async () => ({
      running: true,
      jobCount: 1,
      enabledJobCount: job.enabled ? 1 : 0,
    })),
    list: vi.fn(async () => [job]),
    listPage: vi.fn(async () => ({ items: [job], total: 1, limit: 50, offset: 0 })),
    add: vi.fn(),
    update: vi.fn(async (_id: string, patch: Partial<CronJob>) => {
      if (typeof patch.enabled === "boolean") {
        job.enabled = patch.enabled;
      }
      job.updatedAtMs += 1;
      return job;
    }),
    remove: vi.fn(),
    run: vi.fn(),
    enqueueRun: vi.fn(),
    getJob: vi.fn((id: string) => (id === job.id ? job : undefined)),
    readJob: vi.fn(async (id: string) => (id === job.id ? job : undefined)),
    getDefaultAgentId: vi.fn(() => "orchestrator"),
    wake: vi.fn(() => ({ ok: true as const })),
  } as unknown as CronServiceContract & { job: CronJob; update: ReturnType<typeof vi.fn> };
}

function createContext(
  cron: CronServiceContract = createCronHarness(false),
  cfg: OpenClawConfig = { agents: { defaults: { workspace: stateDir } } },
) {
  return {
    getRuntimeConfig: () => cfg,
    cron,
    governedRuntimeIdentity: governedRuntimeIdentityForTest,
  } as never;
}

async function waitForCronEnabled(cron: { job: CronJob }, enabled: boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (cron.job.enabled === enabled) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for watchdog enabled=${enabled}`);
}

async function runTaskHandler(
  method:
    | "tasks.list"
    | "tasks.get"
    | "tasks.governance.status"
    | "tasks.governance.preview"
    | "tasks.governance.apply"
    | "tasks.cancel"
    | "tasks.startProductionFlow"
    | "tasks.resumeProductionFlow"
    | "tasks.handleBuildIssue"
    | "tasks.runTaskInFlow"
    | "tasks.recordTaskInFlowProgress"
    | "tasks.completeTaskInFlow"
    | "tasks.recordProductionFlowLawfulStop"
    | "tasks.probeProductionWatchdogLifecycle",
  params: Record<string, unknown>,
  options?: { cron?: CronServiceContract; cfg?: OpenClawConfig; clientDeviceId?: string },
) {
  const { calls, respond } = captureRespond();
  await tasksHandlers[method]({
    req: { type: "req", id: `req-${method}`, method },
    params,
    respond,
    context: createContext(options?.cron, options?.cfg),
    client: options?.clientDeviceId
      ? ({
          connect: { device: { id: options.clientDeviceId } },
          isDeviceTokenAuth: true,
        } as never)
      : null,
    isWebchatConnect: () => false,
  });
  return {
    calls,
    payload: calls[0]?.[1] as TaskResponsePayload | undefined,
  };
}

async function writeTestBuildPlan(name = "build-plan.md"): Promise<string> {
  const planPath = path.join(stateDir, name);
  await fs.writeFile(planPath, "# Test Build Plan\n", "utf8");
  return planPath;
}

async function createGovernedProductionPackage(params: {
  authorityPath: string;
  missionId: string;
}) {
  const buildInfoBody = await fs.readFile(path.resolve("dist/build-info.json"));
  const buildInfo = JSON.parse(buildInfoBody.toString("utf8")) as { commit: string };
  const runtimeBuildSha256 = createHash("sha256").update(buildInfoBody).digest("hex");
  governedRuntimeIdentityForTest = {
    sourceRevision: buildInfo.commit,
    runtimeBuildSha256,
  };
  const createdAt = "2026-09-17T00:00:00.000Z";
  const planRevisionId = `${params.missionId}-plan-1`;
  const policyVersion = "policy-1";
  const skillSha256 = readGovernedWorkspaceSkillSha256({
    workspaceDir: stateDir,
    config: { agents: { defaults: { workspace: stateDir } } },
    agentId: "main",
  });
  if (!skillSha256) {
    throw new Error("expected governed workspace skill identity");
  }
  governedSkillSha256ForTest = skillSha256;
  const contractHash = `${params.missionId}-contract-hash`;
  const manifest = {
    schema: "openclaw.mission_manifest.v1",
    missionId: params.missionId,
    planRevisionId,
    planSha256: "",
    sourceRevision: buildInfo.commit,
    runtimeBuildSha256,
    policyVersion,
    skillSha256,
    mode: "enforce",
    scopeHash: `${params.missionId}-scope`,
    authorizedScopeHash: `${params.missionId}-scope`,
    planRevisionAuthorized: true,
    createdAt,
  } satisfies MissionManifest;
  const requirements = [{ id: "REQ-1", text: "Complete governed production work", required: true }];
  const gateKinds = ["test"] as const;
  manifest.planSha256 = computeCompiledMissionPlanSha256(
    compileMissionPlan({ manifest, requirements, gateKinds }),
  );
  await fs.writeFile(
    params.authorityPath,
    JSON.stringify({
      schema: "openclaw.governed_authority_plan.v1",
      planRevisionId,
      planSha256: manifest.planSha256,
      scopeHash: manifest.scopeHash,
      authorizedScopeHash: manifest.authorizedScopeHash,
      planRevisionAuthorized: true,
    }),
    "utf8",
  );
  const authorityHash = createHash("sha256")
    .update(await fs.readFile(params.authorityPath))
    .digest("hex");
  const authorityRef = {
    refId: `${params.missionId}-authority`,
    kind: "build_plan" as const,
    uri: params.authorityPath,
    sha256: authorityHash,
  };
  const identityBindings = {
    missionId: params.missionId,
    contractHash,
    authorityHash,
    planRevisionId,
    sourceRevision: buildInfo.commit,
    runtimeBuildSha256,
    policyVersion,
    skillSha256,
  };
  const artifactRoot = resolveGovernedArtifactOutputRoot(stateDir, params.missionId);
  if (!artifactRoot) {
    throw new Error("expected a valid governed artifact output root");
  }
  await fs.mkdir(artifactRoot, { recursive: true });
  return {
    idempotencyKey: `${params.missionId}-admission`,
    authorityRefId: authorityRef.refId,
    contract: {
      schema: "openclaw.governed_mission_contract.v1",
      missionId: params.missionId,
      contractId: `${params.missionId}-contract`,
      contractVersion: "1",
      contractHash,
      authorityHash,
      authorityRefs: [authorityRef],
      admissionReceiptRef: `${params.missionId}-admission-receipt`,
      planRevisionId,
      sourceRevision: buildInfo.commit,
      runtimeBuildSha256,
      policyVersion,
      skillSha256,
      mode: "enforce",
      authoritativeCompletionOwner: "governed_mission_state",
      requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
      proofProducers: {
        implementation: { deviceId: "device-governed-implementation" },
        validation: { deviceId: "device-governed-validation" },
        review: { deviceId: "device-governed-review" },
        delivery: { deviceId: "device-governed-delivery" },
      },
      createdAt,
    },
    manifest,
    requirements,
    gateKinds,
    artifactDeclarations: [
      {
        artifactId: `${params.missionId}-proof`,
        artifactKind: "validation",
        missionId: params.missionId,
        workOrderId: `${params.missionId}-work`,
        gateId: "REQ-1:test",
        allowedRoot: artifactRoot,
        pathname: path.join(artifactRoot, `${params.missionId}-proof.json`),
        required: true,
        identityBindings,
      },
    ],
    deliveryRequired: true,
  };
}

async function getTaskPayload(taskId: string) {
  const { calls, payload } = await runTaskHandler("tasks.get", { taskId });
  expect(calls[0]?.[0]).toBe(true);
  expect(payload?.task?.id).toBe(taskId);
  return { calls, payload };
}

function createGovernedProofTask(params: {
  flowId: string;
  ownerKey: string;
  label: string;
  deviceId: string;
  role: Parameters<typeof recordProductionExecutorAssignment>[0]["role"];
  capability: Parameters<typeof recordProductionExecutorAssignment>[0]["permitted"][number];
  proofPurpose: Parameters<typeof recordProductionExecutorAssignment>[0]["proofPurpose"];
  deliveryStatus?: TaskRecord["deliveryStatus"];
  terminalOutcome?: TaskRecord["terminalOutcome"];
}): string {
  const runId = `${params.flowId}:${params.label}:run`;
  const now = Date.now();
  const task = createTaskRecord({
    runtime: "cli",
    requesterSessionKey: params.ownerKey,
    ownerKey: params.ownerKey,
    scopeKind: "session",
    childSessionKey: `${params.ownerKey}:${params.label}`,
    parentFlowId: params.flowId,
    runId,
    label: params.label,
    task: `Produce ${params.label} evidence`,
    status: "succeeded",
    ...(params.terminalOutcome ? { terminalOutcome: params.terminalOutcome } : {}),
    deliveryStatus: params.deliveryStatus ?? "delivered",
    startedAt: now,
    endedAt: now,
  });
  const assignment = recordProductionExecutorAssignment({
    flowId: params.flowId,
    taskId: task.taskId,
    expectedRunId: runId,
    executorId: `${params.label}-executor`,
    producerDeviceId: params.deviceId,
    ownerLane: params.role,
    proofPurpose: params.proofPurpose,
    role: params.role,
    permitted: [params.capability],
    prohibited: [],
    evidenceRefs: [`work-packet:${params.label}`],
    assignedAt: now,
  });
  if (!assignment.applied) {
    throw new Error(assignment.reason);
  }
  return task.taskId;
}

describe("tasks gateway handlers", () => {
  it("preserves governed proof across cancel, lease close, and task prune", async () => {
    const authorityPath = await writeTestBuildPlan("governed-production-plan.md");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-production-governed-1",
    });
    const ownerKey = "agent:main:main";
    const startParams = {
      ownerKey,
      controllerId: "governed-production-test",
      goal: "Run governed production work",
      sliceId: "governed-production",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "governed-production",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      governedMission,
    };
    const started = await runTaskHandler("tasks.startProductionFlow", startParams);

    expect(started.calls[0]?.[0]).toBe(true);
    expect(started.payload?.flow).toMatchObject({ status: "queued", ownerKey });
    const flowId = String(started.payload?.flow?.flowId);
    const admitted = getTaskFlowById(flowId);
    expect(admitted).toBeDefined();
    expect(getTaskFlowProductionContinuation(admitted!)).toMatchObject({
      activeProductionRun: true,
      parentRunOpen: true,
    });
    const admittedMission = readGovernedMissionStateFromTaskFlow(admitted!)!;
    const newerOrdinary = createManagedTaskFlow({
      ownerKey,
      controllerId: "ordinary-after-governance",
      goal: "Ordinary work for the same owner",
      createdAt: admitted!.createdAt + 1,
    });
    expect(newerOrdinary).toBeDefined();
    const ownerStatus = await runTaskHandler("tasks.governance.status", { lookup: ownerKey });
    const ownerPreview = await runTaskHandler("tasks.governance.preview", {
      lookup: ownerKey,
      operation: "startWorkOrder",
    });
    expect(ownerStatus.payload?.flowId).toBe(flowId);
    expect(ownerPreview.payload?.preview).toMatchObject({ status: "preview", flowId });
    const startedWorkOrder = await runTaskHandler("tasks.governance.apply", {
      lookup: ownerKey,
      expectedRevision: admittedMission.revision,
      idempotencyKey: "governed-start-work-order",
      action: { operation: "startWorkOrder" },
    });
    expect(startedWorkOrder.calls[0]?.[0]).toBe(true);
    expect(validateTasksGovernanceApplyResult(startedWorkOrder.payload)).toBe(true);
    expect(startedWorkOrder.payload).toMatchObject({
      status: "applied",
      decision: { operation: "startWorkOrder", stateChanged: true },
    });

    const preparation = prepareGovernedMissionAgentRun({
      ownerKey,
      runId: "governed-agent-run-1",
      occurredAt: "2026-09-17T00:01:00.000Z",
    });
    expect(preparation).toMatchObject({ status: "bound", flowId });
    if (preparation.status !== "bound") {
      throw new Error(`expected governed agent binding, got ${preparation.status}`);
    }
    expect(getTaskFlowById(flowId)).toMatchObject({ status: "running", revision: 2 });

    const wrongProducerDispatch = await runTaskHandler(
      "tasks.runTaskInFlow",
      {
        lookup: flowId,
        runtime: "cli",
        workPacketRef: "work-packet:wrong-producer",
        buildPlanRef: authorityPath,
        buildItem: "governed-production",
        requiredOwnerLane: "Coding Agent",
        attemptedOwnerLane: "Coding Agent",
        attemptedExecutor: "Coding Agent",
        executorRole: "Coding Agent",
        lawfulRouteRequired: "assigned coding lane",
        handoffRef: "handoff:wrong-producer",
        handoffAcceptedBy: "Coding Agent",
        childSessionKey: "agent:main:wrong-producer",
        task: "Attempt governed proof from the wrong device",
        status: "running",
        proofPurpose: "implementation",
        permitted: ["repo_write"],
        prohibited: [],
      },
      { clientDeviceId: "device-not-designated-for-implementation" },
    );
    expect(wrongProducerDispatch.calls[0]?.[0]).toBe(false);
    expect(wrongProducerDispatch.calls[0]?.[2]?.message).toContain(
      "governed_child_task_producer_unauthorized",
    );
    expect(listTasksForFlowId(flowId)).toEqual([]);

    const toolDecision = await runBeforeToolCallHook({
      toolName: "gateway",
      toolCallId: "governed-tool-call-1",
      params: { method: "config.get" },
      ctx: {
        agentId: "main",
        sessionKey: ownerKey,
        runId: "governed-agent-run-1",
        governedMissionToolEnforcement: preparation.toolEnforcement,
      },
    });
    expect(toolDecision).toMatchObject({ blocked: false });
    expect(listGovernedMissionReceipts({ flowId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "authorizeToolCall",
          runId: "governed-agent-run-1",
          reasonCode: "PROTECTED_TOOL_ALLOWED",
          decision: "applied",
        }),
      ]),
    );

    closeGovernedMissionExecutionLease({
      flowId,
      runId: "governed-agent-run-1",
      occurredAt: "2026-09-17T00:02:00.000Z",
    });
    expect(
      recordGovernedMissionWithheldPayload({
        flowId,
        attemptReceiptId: preparation.attemptReceiptId,
        payload: [{ text: "obsolete attempt result" }],
      }),
    ).toMatchObject({ applied: true });
    const staleImplementationTaskId = createGovernedProofTask({
      flowId,
      ownerKey,
      label: "implementation-stale-attempt",
      deviceId: "device-governed-implementation",
      role: "Coding Agent",
      capability: "repo_write",
      proofPurpose: "implementation",
    });
    const repair = await runTaskHandler("tasks.governance.apply", {
      lookup: flowId,
      expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
      idempotencyKey: "governed-new-attempt-required",
      action: {
        operation: "blockForRepair",
        reasonCode: "REPAIR_REQUIRED",
        nextAction: "Run a fresh governed attempt.",
      },
    });
    expect(repair.calls[0]?.[0]).toBe(true);
    expect(repair.payload?.status).toBe("applied");
    const repairPreparation = prepareGovernedMissionAgentRun({
      ownerKey,
      runId: "governed-agent-run-2",
      occurredAt: "2026-09-17T00:03:00.000Z",
    });
    expect(repairPreparation).toMatchObject({ status: "bound", flowId });
    if (repairPreparation.status !== "bound") {
      throw new Error(`expected repaired governed agent binding, got ${repairPreparation.status}`);
    }
    const openLeaseMission = readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!;
    const implementationDispatch = await runTaskHandler(
      "tasks.runTaskInFlow",
      {
        lookup: flowId,
        runtime: "acp",
        workPacketRef: "work-packet:implementation",
        buildPlanRef: authorityPath,
        buildItem: "governed-production",
        requiredOwnerLane: "Coding Agent",
        attemptedOwnerLane: "Coding Agent",
        attemptedExecutor: "Coding Agent",
        executorRole: "Coding Agent",
        lawfulRouteRequired: "assigned coding lane",
        handoffRef: "handoff:implementation",
        handoffAcceptedBy: "Coding Agent",
        childSessionKey: "agent:main:implementation",
        task: "Produce implementation evidence",
        runId: "governed-implementation-run",
        status: "running",
        proofPurpose: "implementation",
        permitted: ["repo_write"],
        prohibited: [],
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(implementationDispatch.calls[0]?.[0]).toBe(true);
    expect(implementationDispatch.payload?.executorIdentityProof?.deliveryStatus).toBe("pending");
    const implementationTaskId = String(implementationDispatch.payload?.task?.taskId);
    let releaseCancellation!: () => void;
    const cancellationReleased = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationStarted!: () => void;
    const cancellationEntered = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    setTaskRegistryControlRuntimeForTests({
      getAcpSessionManager: () => ({
        cancelSession: async () => {
          cancellationStarted();
          await cancellationReleased;
        },
      }),
      killSubagentRunAdmin: async () => ({ found: false, killed: false }),
    });
    const cancellation = runTaskHandler("tasks.cancel", { taskId: implementationTaskId });
    await cancellationEntered;
    const implementationCompletionParams = {
      lookup: flowId,
      runId: "governed-implementation-run",
      runtime: "acp",
      status: "succeeded",
      terminalSummary: "Implementation evidence completed and acknowledged by the Gateway.",
      nextExecutableLaunch: {
        detail: "Launch governed validation proof work",
        currentStep: "validation_proof_dispatched",
      },
    };
    const implementationCompletion = await runTaskHandler(
      "tasks.completeTaskInFlow",
      implementationCompletionParams,
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(implementationCompletion.calls[0]?.[0]).toBe(true);
    expect(implementationCompletion.payload?.task).toMatchObject({
      taskId: implementationTaskId,
      status: "completed",
    });
    releaseCancellation();
    await expect(cancellation).resolves.toMatchObject({
      payload: {
        found: true,
        cancelled: false,
        task: { taskId: implementationTaskId, status: "completed" },
      },
    });
    const implementationCompletionRetry = await runTaskHandler(
      "tasks.completeTaskInFlow",
      implementationCompletionParams,
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(implementationCompletionRetry.calls[0]?.[0]).toBe(true);
    expect(implementationCompletionRetry.payload?.task).toMatchObject({
      taskId: implementationTaskId,
      status: "completed",
    });
    resetTaskRegistryForTests({ persist: false });
    expect(getTaskById(implementationTaskId)).toMatchObject({
      taskId: implementationTaskId,
      status: "succeeded",
      deliveryStatus: "delivered",
    });
    expect(
      getProductionExecutorAssignment(getTaskFlowById(flowId)!, implementationTaskId),
    ).toMatchObject({
      governedAttemptReceiptId: repairPreparation.attemptReceiptId,
      governedAttemptRunId: "governed-agent-run-2",
      governedMissionRevision: openLeaseMission.revision,
    });
    const proofBeforeLeaseClose = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: openLeaseMission.revision,
        idempotencyKey: "governed-implementation-before-lease-close",
        action: {
          operation: "recordImplementationResult",
          proofTaskId: implementationTaskId,
        },
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(proofBeforeLeaseClose.calls[0]?.[0]).toBe(true);
    expect(proofBeforeLeaseClose.payload).toMatchObject({
      status: "repair_required",
      reasonCode: "ACTIVE_EXECUTION_LEASE_OPEN",
      decision: { stateChanged: false },
    });
    closeGovernedMissionExecutionLease({
      flowId,
      runId: "governed-agent-run-2",
      occurredAt: "2026-09-17T00:04:00.000Z",
    });
    expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
      activeExecutionLease: undefined,
      revision: openLeaseMission.revision + 1,
    });
    expect(readGovernedMissionWithheldPayload(getTaskFlowById(flowId)!)).toBeUndefined();
    const withheldPayload = [{ text: "withheld result" }];
    expect(
      recordGovernedMissionWithheldPayload({
        flowId,
        attemptReceiptId: preparation.attemptReceiptId,
        payload: [{ text: "stale attempt result" }],
      }),
    ).toMatchObject({ applied: false, reason: "guard_blocked" });
    expect(
      recordGovernedMissionWithheldPayload({
        flowId,
        attemptReceiptId: repairPreparation.attemptReceiptId,
        payload: withheldPayload,
      }),
    ).toMatchObject({ applied: true });
    const staleAttemptProof = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
        idempotencyKey: "governed-implementation-stale-attempt",
        action: {
          operation: "recordImplementationResult",
          proofTaskId: staleImplementationTaskId,
        },
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(staleAttemptProof.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(staleAttemptProof.calls[0]?.[2])).toContain(
      "GOVERNED_PROOF_TASK_AUTHORITY_INVALID",
    );

    const wrongPurposeValidationTaskId = createGovernedProofTask({
      flowId,
      ownerKey,
      label: "validation-wrong-purpose",
      deviceId: "device-governed-validation",
      role: "Grant",
      capability: "repo_read",
      proofPurpose: "implementation",
    });
    const pendingImplementationTaskId = createGovernedProofTask({
      flowId,
      ownerKey,
      label: "implementation-delivery-pending",
      deviceId: "device-governed-implementation",
      role: "Coding Agent",
      capability: "repo_write",
      proofPurpose: "implementation",
      deliveryStatus: "pending",
    });
    const blockedImplementationTaskId = createGovernedProofTask({
      flowId,
      ownerKey,
      label: "implementation-blocked",
      deviceId: "device-governed-implementation",
      role: "Coding Agent",
      capability: "repo_write",
      proofPurpose: "implementation",
      terminalOutcome: "blocked",
    });

    const wrongPurposeValidation = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
        idempotencyKey: "governed-validation-wrong-purpose",
        action: {
          operation: "recordValidationResult",
          proofTaskId: wrongPurposeValidationTaskId,
        },
      },
      { clientDeviceId: "device-governed-validation" },
    );
    expect(wrongPurposeValidation.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(wrongPurposeValidation.calls[0]?.[2])).toContain(
      "GOVERNED_PROOF_TASK_AUTHORITY_INVALID",
    );

    const impersonatedImplementation = await runTaskHandler("tasks.governance.apply", {
      lookup: flowId,
      expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
      idempotencyKey: "governed-implementation-impersonated",
      action: {
        operation: "recordImplementationResult",
        proofTaskId: implementationTaskId,
      },
    });
    expect(impersonatedImplementation.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(impersonatedImplementation.calls[0]?.[2])).toContain(
      "GOVERNED_PROOF_PRODUCER_UNAUTHORIZED",
    );

    const undeliveredImplementation = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
        idempotencyKey: "governed-implementation-undelivered",
        action: {
          operation: "recordImplementationResult",
          proofTaskId: pendingImplementationTaskId,
        },
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(undeliveredImplementation.calls[0]?.[0]).toBe(true);
    expect(undeliveredImplementation.payload).toMatchObject({
      status: "repair_required",
      reasonCode: "IMPLEMENTATION_PROOF_MISSING",
      decision: { stateChanged: false },
    });
    expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toHaveProperty(
      "proofs.implementation",
      "pending",
    );

    const blockedImplementation = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
        idempotencyKey: "governed-implementation-blocked",
        action: {
          operation: "recordImplementationResult",
          proofTaskId: blockedImplementationTaskId,
        },
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(blockedImplementation.calls[0]?.[0]).toBe(true);
    expect(blockedImplementation.payload).toMatchObject({
      status: "repair_required",
      reasonCode: "IMPLEMENTATION_PROOF_MISSING",
      decision: { stateChanged: false },
    });
    expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toHaveProperty(
      "proofs.implementation",
      "pending",
    );

    const unverifiedImplementationTaskId = createGovernedProofTask({
      flowId,
      ownerKey,
      label: "implementation-generic-terminal-write",
      deviceId: "device-governed-implementation",
      role: "Coding Agent",
      capability: "repo_write",
      proofPurpose: "implementation",
    });
    const unverifiedImplementation = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
        idempotencyKey: "governed-implementation-generic-terminal-write",
        action: {
          operation: "recordImplementationResult",
          proofTaskId: unverifiedImplementationTaskId,
        },
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(unverifiedImplementation.payload).toMatchObject({
      status: "repair_required",
      reasonCode: "IMPLEMENTATION_PROOF_MISSING",
    });

    expect(
      setTaskCleanupAfterById({ taskId: implementationTaskId, cleanupAfter: Date.now() - 1 }),
    ).toMatchObject({ taskId: implementationTaskId });
    expect(
      setTaskCleanupAfterById({
        taskId: unverifiedImplementationTaskId,
        cleanupAfter: Date.now() - 1,
      }),
    ).toMatchObject({ taskId: unverifiedImplementationTaskId });
    expect(await runTaskRegistryMaintenance()).toMatchObject({ pruned: 2 });
    expect(getTaskById(implementationTaskId)).toBeUndefined();
    expect(getTaskById(unverifiedImplementationTaskId)).toBeUndefined();
    const unauthorizedPrunedImplementation = await runTaskHandler("tasks.governance.apply", {
      lookup: flowId,
      expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
      idempotencyKey: "governed-implementation-pruned-unauthorized",
      action: {
        operation: "recordImplementationResult",
        proofTaskId: implementationTaskId,
      },
    });
    expect(unauthorizedPrunedImplementation.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(unauthorizedPrunedImplementation.calls[0]?.[2])).toContain(
      "GOVERNED_PROOF_PRODUCER_UNAUTHORIZED",
    );
    const unverifiedAfterPrune = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
        idempotencyKey: "governed-implementation-pruned-unverified",
        action: {
          operation: "recordImplementationResult",
          proofTaskId: unverifiedImplementationTaskId,
        },
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(unverifiedAfterPrune.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(unverifiedAfterPrune.calls[0]?.[2])).toContain(
      "GOVERNED_PROOF_TASK_AUTHORITY_INVALID",
    );

    const implementation = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
        idempotencyKey: "governed-implementation-advanced",
        action: {
          operation: "recordImplementationResult",
          proofTaskId: implementationTaskId,
        },
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(implementation.calls[0]?.[0]).toBe(true);
    expect(validateTasksGovernanceApplyResult(implementation.payload)).toBe(true);
    expect(implementation.payload).toMatchObject({
      status: "applied",
      flowId,
      decision: { operation: "recordImplementationResult", stateChanged: true },
    });
    resetTaskRegistryForTests();
    const implementationRetry = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: implementation.payload?.receipt?.expectedRevision,
        idempotencyKey: "governed-implementation-advanced",
        action: {
          operation: "recordImplementationResult",
          proofTaskId: implementationTaskId,
        },
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(implementationRetry.calls[0]?.[0]).toBe(true);
    expect(implementationRetry.payload).toMatchObject({
      status: "already_applied",
      receipt: { receiptId: implementation.payload?.receipt?.receiptId },
    });
    const validationTaskId = createGovernedProofTask({
      flowId,
      ownerKey,
      label: "validation",
      deviceId: "device-governed-validation",
      role: "Grant",
      capability: "repo_read",
      proofPurpose: "validation",
    });
    const validationCompletion = await runTaskHandler(
      "tasks.completeTaskInFlow",
      {
        lookup: flowId,
        runId: `${flowId}:validation:run`,
        runtime: "cli",
        status: "succeeded",
        nextExecutableLaunch: { detail: "Launch governed review proof work" },
      },
      { clientDeviceId: "device-governed-validation" },
    );
    expect(validationCompletion.calls[0]?.[0]).toBe(true);
    await expect(
      runBeforeToolCallHook({
        toolName: "gateway",
        toolCallId: "governed-tool-call-stale",
        params: { method: "config.get" },
        ctx: {
          agentId: "main",
          sessionKey: ownerKey,
          runId: "governed-agent-run-1",
          governedMissionToolEnforcement: preparation.toolEnforcement,
        },
      }),
    ).resolves.toMatchObject({
      blocked: true,
      kind: "failure",
      reason: "Tool call blocked because before_tool_call hook failed",
    });

    const apply = async (
      idempotencyKey: string,
      action: Record<string, unknown>,
      clientDeviceId?: string,
    ) => {
      const current = readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!;
      const response = await runTaskHandler(
        "tasks.governance.apply",
        {
          lookup: flowId,
          expectedRevision: current.revision,
          idempotencyKey,
          action,
        },
        clientDeviceId ? { clientDeviceId } : undefined,
      );
      expect(response.calls[0]?.[0]).toBe(true);
      expect(validateTasksGovernanceApplyResult(response.payload)).toBe(true);
      expect(response.payload?.status, JSON.stringify(response.payload)).toBe("applied");
      return response;
    };

    await apply(
      "governed-validation",
      {
        operation: "recordValidationResult",
        proofTaskId: validationTaskId,
      },
      "device-governed-validation",
    );
    const validationTaskAfterProof = getTaskById(validationTaskId);
    const flowAfterValidationProof = getTaskFlowById(flowId);
    const receiptsAfterValidationProof = listGovernedMissionReceipts({ flowId });
    expect(
      finalizeTaskRunByRunId({
        runId: `${flowId}:validation:run`,
        runtime: "cli",
        sessionKey: `${ownerKey}:validation`,
        status: "failed",
        endedAt: Date.now(),
        error: "Late direct-finalizer validation failure.",
      }),
    ).toEqual([]);
    expect(getTaskById(validationTaskId)).toEqual(validationTaskAfterProof);
    expect(getTaskFlowById(flowId)).toEqual(flowAfterValidationProof);
    expect(listGovernedMissionReceipts({ flowId })).toEqual(receiptsAfterValidationProof);
    const validationCorrection = await runTaskHandler(
      "tasks.completeTaskInFlow",
      {
        lookup: flowId,
        taskId: validationTaskId,
        runId: `${flowId}:validation:run`,
        runtime: "cli",
        sessionKey: `${ownerKey}:validation`,
        status: "failed",
        error: "Late contradictory validation failure.",
      },
      { clientDeviceId: "device-governed-validation" },
    );
    expect(validationCorrection.calls[0]?.[0]).toBe(false);
    expect(validationCorrection.calls[0]?.[2]?.message).toContain(
      "child_task_completion_not_recorded",
    );
    expect(getTaskById(validationTaskId)).toEqual(validationTaskAfterProof);
    expect(getTaskFlowById(flowId)).toEqual(flowAfterValidationProof);
    expect(listGovernedMissionReceipts({ flowId })).toEqual(receiptsAfterValidationProof);
    const ordinaryTask = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: ownerKey,
      ownerKey,
      scopeKind: "session",
      childSessionKey: `${ownerKey}:ordinary-correction`,
      runId: `${flowId}:ordinary-correction:run`,
      task: "Ordinary terminal correction",
      status: "succeeded",
      deliveryStatus: "delivered",
    });
    expect(
      finalizeTaskRunByRunId({
        runId: ordinaryTask.runId!,
        runtime: "cli",
        sessionKey: ordinaryTask.childSessionKey,
        status: "failed",
        endedAt: Date.now(),
        error: "Ordinary late failure remains authoritative.",
      }),
    ).toEqual([
      expect.objectContaining({
        taskId: ordinaryTask.taskId,
        status: "failed",
        error: "Ordinary late failure remains authoritative.",
      }),
    ]);
    const reviewTaskId = createGovernedProofTask({
      flowId,
      ownerKey,
      label: "review",
      deviceId: "device-governed-review",
      role: "Grant",
      capability: "grant_review",
      proofPurpose: "review",
    });
    const reviewCompletion = await runTaskHandler(
      "tasks.completeTaskInFlow",
      {
        lookup: flowId,
        runId: `${flowId}:review:run`,
        runtime: "cli",
        status: "succeeded",
        nextExecutableLaunch: { detail: "Launch governed closeout work" },
      },
      { clientDeviceId: "device-governed-review" },
    );
    expect(reviewCompletion.calls[0]?.[0]).toBe(true);
    await apply(
      "governed-review",
      {
        operation: "recordReviewResult",
        proofTaskId: reviewTaskId,
      },
      "device-governed-review",
    );
    await apply("governed-closeout", { operation: "requestCloseout" });
    await fs.writeFile(
      governedMission.artifactDeclarations[0].pathname,
      `${JSON.stringify({
        status: "passed",
        ...governedMission.artifactDeclarations[0]?.identityBindings,
      })}\n`,
      "utf8",
    );
    const artifactExpectedRevision = readGovernedMissionStateFromTaskFlow(
      getTaskFlowById(flowId)!,
    )!.revision;
    await apply("governed-artifacts", { operation: "verifyRequiredArtifacts" });
    const authorityBody = await fs.readFile(authorityPath);
    await fs.unlink(authorityPath);
    const artifactRetry = await runTaskHandler("tasks.governance.apply", {
      lookup: flowId,
      expectedRevision: artifactExpectedRevision,
      idempotencyKey: "governed-artifacts",
      action: { operation: "verifyRequiredArtifacts" },
    });
    expect(artifactRetry.calls[0]?.[0]).toBe(true);
    expect(artifactRetry.payload).toMatchObject({ status: "already_applied" });
    await fs.writeFile(authorityPath, authorityBody);
    expect(
      prepareGovernedMissionAgentRun({
        ownerKey,
        runId: "governed-agent-run-after-artifacts",
      }),
    ).toMatchObject({
      status: "blocked",
      reasonCode: "GOVERNED_MISSION_NOT_EXECUTABLE",
    });
    await apply("governed-terminal-pending", {
      operation: "admitTerminalPendingWatchdog",
    });
    expect(getTaskFlowProductionContinuation(getTaskFlowById(flowId)!)).toMatchObject({
      parentRunOpen: false,
      lawfulWholeRunCompletion: true,
      lawfulStopReason: "whole_run_complete",
    });
    await apply("governed-watchdog", { operation: "recordPostTerminalWatchdog" });
    const admissionRetryBeforeRelease = await runTaskHandler(
      "tasks.startProductionFlow",
      startParams,
    );
    expect(admissionRetryBeforeRelease.calls[0]?.[0]).toBe(true);
    expect(JSON.stringify(admissionRetryBeforeRelease.payload)).not.toContain("withheld result");
    expect(admissionRetryBeforeRelease.payload?.flow).not.toHaveProperty(
      "stateJson.governedMissionWithheldPayload",
    );
    const prematureDelivery = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
        idempotencyKey: "governed-delivery-before-release",
        action: {
          operation: "recordDeliveryResult",
          releaseReceiptId: "missing-release-receipt",
          payloadHash: computeGovernedFinalPayloadHash(withheldPayload),
        },
      },
      { clientDeviceId: "device-governed-delivery" },
    );
    expect(prematureDelivery.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(prematureDelivery.calls[0]?.[2])).toContain(
      "GOVERNED_DELIVERY_RELEASE_BINDING_INVALID",
    );
    const release = await apply("governed-release", { operation: "releaseFinalResult" });
    expect(release.payload?.releasedPayload).toEqual(withheldPayload);
    const releaseRetry = await runTaskHandler("tasks.governance.apply", {
      lookup: flowId,
      expectedRevision: release.payload?.receipt?.expectedRevision,
      idempotencyKey: "governed-release",
      action: { operation: "releaseFinalResult" },
    });
    expect(releaseRetry.calls[0]?.[0]).toBe(true);
    expect(releaseRetry.payload).toMatchObject({
      status: "already_applied",
      receipt: { receiptId: release.payload?.receipt?.receiptId },
      releasedPayload: withheldPayload,
    });
    expect(getTaskFlowById(flowId)).toHaveProperty(
      "stateJson.governedMissionReleaseState.payloadHash",
      computeGovernedFinalPayloadHash(withheldPayload),
    );
    const wrongPayloadDelivery = await runTaskHandler(
      "tasks.governance.apply",
      {
        lookup: flowId,
        expectedRevision: readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!.revision,
        idempotencyKey: "governed-delivery-wrong-payload",
        action: {
          operation: "recordDeliveryResult",
          releaseReceiptId: String(release.payload?.receipt?.receiptId),
          payloadHash: "0".repeat(64),
        },
      },
      { clientDeviceId: "device-governed-delivery" },
    );
    expect(wrongPayloadDelivery.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(wrongPayloadDelivery.calls[0]?.[2])).toContain(
      "GOVERNED_DELIVERY_RELEASE_BINDING_INVALID",
    );
    await apply(
      "governed-delivery",
      {
        operation: "recordDeliveryResult",
        releaseReceiptId: String(release.payload?.receipt?.receiptId),
        payloadHash: computeGovernedFinalPayloadHash(withheldPayload),
      },
      "device-governed-delivery",
    );
    expect(getTaskFlowById(flowId)).toMatchObject({ status: "succeeded" });
    expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
      currentGovernedState: "released",
      proofs: {
        artifacts: "passed",
        postTerminalWatchdog: "passed",
        delivery: "passed",
      },
    });
  });

  it("rejects governed production packages with stale authority bytes or unknown fields", async () => {
    const ownerKey = "agent:main:main";
    const authorityPath = await writeTestBuildPlan("stale-governed-production-plan.md");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-production-stale-authority",
    });
    await fs.appendFile(authorityPath, "\nchanged after package creation\n", "utf8");
    const baseParams = {
      ownerKey,
      controllerId: "governed-production-rejection-test",
      goal: "Reject stale governed production work",
      sliceId: "governed-production-rejection",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "governed-production-rejection",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
    };
    const stale = await runTaskHandler("tasks.startProductionFlow", {
      ...baseParams,
      governedMission,
    });
    expect(stale.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(stale.calls[0]?.[2])).toContain("AUTHORITY_FILE_HASH_MISMATCH");

    const planPath = await writeTestBuildPlan("mismatched-governed-plan.json");
    const planPackage = await createGovernedProductionPackage({
      authorityPath: planPath,
      missionId: "gateway-production-mismatched-plan",
    });
    planPackage.requirements[0].text = "Skip the authorized work";
    const mismatchedPlan = await runTaskHandler("tasks.startProductionFlow", {
      ...baseParams,
      authorityPath: planPath,
      governedMission: planPackage,
    });
    expect(mismatchedPlan.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(mismatchedPlan.calls[0]?.[2])).toContain("PLAN_DIGEST_MISMATCH");
    planPackage.manifest.planSha256 = computeCompiledMissionPlanSha256(
      compileMissionPlan({
        manifest: planPackage.manifest,
        requirements: planPackage.requirements,
        gateKinds: planPackage.gateKinds,
      }),
    );
    const unauthorizedPlan = await runTaskHandler("tasks.startProductionFlow", {
      ...baseParams,
      authorityPath: planPath,
      governedMission: planPackage,
    });
    expect(unauthorizedPlan.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(unauthorizedPlan.calls[0]?.[2])).toContain("PLAN_AUTHORITY_MISMATCH");

    const skillDriftAuthorityPath = await writeTestBuildPlan("skill-drift-governed-plan.md");
    const skillDriftPackage = await createGovernedProductionPackage({
      authorityPath: skillDriftAuthorityPath,
      missionId: "gateway-production-skill-drift",
    });
    const skillDir = path.join(stateDir, "skills", "governed-drift-test");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: governed-drift-test",
        "description: Prove governed admission remeasures active skill instructions.",
        "---",
        "# Changed governed instructions",
        "",
      ].join("\n"),
      "utf8",
    );
    const skillDrift = await runTaskHandler("tasks.startProductionFlow", {
      ...baseParams,
      authorityPath: skillDriftAuthorityPath,
      governedMission: skillDriftPackage,
    });
    expect(skillDrift.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(skillDrift.calls[0]?.[2])).toContain("SKILL_HASH_MISMATCH");

    const freshAuthorityPath = await writeTestBuildPlan("unknown-field-governed-plan.md");
    const freshPackage = await createGovernedProductionPackage({
      authorityPath: freshAuthorityPath,
      missionId: "gateway-production-unknown-field",
    });
    const unknownField = await runTaskHandler("tasks.startProductionFlow", {
      ...baseParams,
      authorityPath: freshAuthorityPath,
      governedMission: {
        ...freshPackage,
        contract: { ...freshPackage.contract, callerAssertedHealthy: true },
      },
    });
    expect(unknownField.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(unknownField.calls[0]?.[2])).toContain("GOVERNED_PACKAGE_VALUE_INVALID");

    const outsideWorkspacePath = await writeTestBuildPlan("outside-workspace-governed-plan.md");
    const outsideWorkspacePackage = await createGovernedProductionPackage({
      authorityPath: outsideWorkspacePath,
      missionId: "gateway-production-outside-workspace",
    });
    outsideWorkspacePackage.artifactDeclarations[0] = {
      ...outsideWorkspacePackage.artifactDeclarations[0],
      allowedRoot: "/",
      pathname: "/etc/hosts",
    };
    const outsideWorkspace = await runTaskHandler("tasks.startProductionFlow", {
      ...baseParams,
      authorityPath: outsideWorkspacePath,
      governedMission: outsideWorkspacePackage,
    });
    expect(outsideWorkspace.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(outsideWorkspace.calls[0]?.[2])).toContain(
      "ARTIFACT_OUTSIDE_OUTPUT_ROOT",
    );

    const workspaceSecretPackage = await createGovernedProductionPackage({
      authorityPath: outsideWorkspacePath,
      missionId: "gateway-production-workspace-secret",
    });
    workspaceSecretPackage.artifactDeclarations[0] = {
      ...workspaceSecretPackage.artifactDeclarations[0],
      allowedRoot: stateDir,
      pathname: path.join(stateDir, ".env"),
    };
    const workspaceSecret = await runTaskHandler("tasks.startProductionFlow", {
      ...baseParams,
      authorityPath: outsideWorkspacePath,
      governedMission: workspaceSecretPackage,
    });
    expect(workspaceSecret.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(workspaceSecret.calls[0]?.[2])).toContain(
      "GOVERNED_PACKAGE_VALUE_INVALID",
    );

    const noRuntimeIdentityPath = await writeTestBuildPlan("source-runtime-governed-plan.md");
    const noRuntimeIdentityPackage = await createGovernedProductionPackage({
      authorityPath: noRuntimeIdentityPath,
      missionId: "gateway-production-source-runtime",
    });
    governedRuntimeIdentityForTest = undefined;
    const noRuntimeIdentity = await runTaskHandler("tasks.startProductionFlow", {
      ...baseParams,
      authorityPath: noRuntimeIdentityPath,
      governedMission: noRuntimeIdentityPackage,
    });
    expect(noRuntimeIdentity.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(noRuntimeIdentity.calls[0]?.[2])).toContain(
      "RUNTIME_BUILD_IDENTITY_UNAVAILABLE",
    );
  });

  it("replays admission before remeasuring a changed authority file", async () => {
    const authorityPath = await writeTestBuildPlan("governed-admission-retry.json");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-production-admission-retry",
    });
    const request = {
      ownerKey: "agent:main:admission-retry",
      controllerId: "admission-retry-controller",
      goal: "Prove governed admission retry",
      sliceId: "admission-retry",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "admission-retry",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      governedMission,
    };
    const admitted = await runTaskHandler("tasks.startProductionFlow", request);
    expect(admitted.calls[0]?.[0]).toBe(true);
    await fs.appendFile(authorityPath, "changed after response loss", "utf8");

    const retry = await runTaskHandler("tasks.startProductionFlow", request);
    expect(retry.calls[0]?.[0]).toBe(true);
    const admittedReceipt = admitted.calls[0]?.[1] as
      | { governedAdmissionReceipt?: { receiptId: string } }
      | undefined;
    const retryReceipt = retry.calls[0]?.[1] as
      | { governedAdmissionReceipt?: { receiptId: string } }
      | undefined;
    expect(retryReceipt?.governedAdmissionReceipt?.receiptId).toBe(
      admittedReceipt?.governedAdmissionReceipt?.receiptId,
    );
    const conflict = await runTaskHandler("tasks.startProductionFlow", {
      ...request,
      governedMission: {
        ...governedMission,
        requirements: [{ ...governedMission.requirements[0], text: "Different work" }],
      },
    });
    expect(conflict.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(conflict.calls[0]?.[2])).toContain("IDEMPOTENCY_PAYLOAD_CONFLICT");
  });

  it("replays a persisted governed admission denial on an identical retry", async () => {
    const authorityPath = await writeTestBuildPlan("governed-denied-admission-retry.json");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-production-denied-admission-retry",
    });
    const ownerKey = "agent:main:denied-admission-retry";
    const request = {
      ownerKey,
      controllerId: "denied-admission-retry-controller",
      goal: "Prove denied admission retry",
      sliceId: "denied-admission-retry",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "denied-admission-retry",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      governedMission,
    };
    const releaseOwnerRun = beginOwnerRunForGovernedMissionAdmission(ownerKey);
    try {
      const denied = await runTaskHandler("tasks.startProductionFlow", request);
      const retry = await runTaskHandler("tasks.startProductionFlow", request);
      expect(denied.calls[0]?.[0]).toBe(false);
      expect(retry.calls[0]?.[0]).toBe(false);
      expect(JSON.stringify(denied.calls[0]?.[2])).toContain("OWNER_SESSION_RUN_ACTIVE");
      expect(retry.calls[0]?.[2]).toEqual(denied.calls[0]?.[2]);
    } finally {
      releaseOwnerRun();
    }
  });

  it("persists governed child creation and executor assignment as one durable unit", async () => {
    const authorityPath = await writeTestBuildPlan("atomic-governed-child-plan.md");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-production-atomic-child",
    });
    const ownerKey = "agent:main:atomic-governed-child";
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey,
      controllerId: "atomic-governed-child-controller",
      goal: "Persist a governed child with its assignment",
      sliceId: "atomic-governed-child",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "atomic-governed-child",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      governedMission,
    });
    expect(started.calls[0]?.[0]).toBe(true);
    const flowId = String(started.payload?.flow?.flowId);
    expect(
      prepareGovernedMissionAgentRun({ ownerKey, runId: "atomic-governed-parent-run" }),
    ).toMatchObject({ status: "bound", flowId });

    const invalid = await runTaskHandler(
      "tasks.runTaskInFlow",
      {
        lookup: flowId,
        runtime: "cli",
        workPacketRef: "x".repeat(4_097),
        buildPlanRef: authorityPath,
        buildItem: "atomic-governed-child",
        requiredOwnerLane: "Coding Agent",
        attemptedOwnerLane: "Coding Agent",
        attemptedExecutor: "Coding Agent",
        executorRole: "Coding Agent",
        lawfulRouteRequired: "assigned coding lane",
        handoffRef: "handoff:atomic-governed-invalid",
        handoffAcceptedBy: "Coding Agent",
        childSessionKey: "agent:main:atomic-governed-invalid",
        task: "Reject an invalid atomic assignment",
        runId: "atomic-governed-invalid-run",
        status: "running",
        proofPurpose: "implementation",
        permitted: ["repo_write"],
        prohibited: [],
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(invalid.calls[0]?.[0]).toBe(false);
    expect(invalid.calls[0]?.[2]?.message).toContain(
      "child_task_assignment_persist_failed: production_executor_assignment_invalid",
    );
    resetTaskRegistryForTests({ persist: false });
    expect(listTasksForFlowId(flowId)).toEqual([]);

    const childParams = {
      lookup: flowId,
      runtime: "acp",
      workPacketRef: "work-packet:atomic-governed-child",
      buildPlanRef: authorityPath,
      buildItem: "atomic-governed-child",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      handoffRef: "handoff:atomic-governed-child",
      handoffAcceptedBy: "Coding Agent",
      childSessionKey: "agent:main:atomic-governed-child-run",
      task: "Persist an atomic governed assignment",
      runId: "atomic-governed-child-run",
      status: "running",
      deliveryStatus: "delivered",
      proofPurpose: "implementation",
      permitted: ["repo_write"],
      prohibited: [],
    };
    const child = await runTaskHandler("tasks.runTaskInFlow", childParams, {
      clientDeviceId: "device-governed-implementation",
    });
    expect(child.calls[0]?.[0]).toBe(true);
    expect(child.payload?.executorIdentityProof?.deliveryStatus).toBe("pending");
    const taskId = String(child.payload?.task?.taskId);
    const firstPersistedFlow = getTaskFlowById(flowId)!;
    const firstAssignment = (
      firstPersistedFlow.stateJson as {
        productionExecutorAssignments: Array<{ taskId: string; assignedAt: number }>;
      }
    ).productionExecutorAssignments[0];

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(firstAssignment.assignedAt + 1_000);
    let retriedChild;
    try {
      retriedChild = await runTaskHandler("tasks.runTaskInFlow", childParams, {
        clientDeviceId: "device-governed-implementation",
      });
    } finally {
      dateNow.mockRestore();
    }
    expect(retriedChild.calls[0]?.[0]).toBe(true);
    expect(retriedChild.payload?.task?.taskId).toBe(taskId);
    expect(listTasksForFlowId(flowId)).toHaveLength(1);
    expect(getTaskFlowById(flowId)).toEqual(firstPersistedFlow);

    const conflictingRetry = await runTaskHandler(
      "tasks.runTaskInFlow",
      {
        ...childParams,
        label: "Different child label",
        task: "Different child work",
        preferMetadata: true,
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(conflictingRetry.calls[0]?.[0]).toBe(false);
    expect(conflictingRetry.calls[0]?.[2]?.message).toContain(
      "governed_child_task_idempotency_conflict",
    );
    expect(getTaskById(taskId)).toMatchObject({
      task: childParams.task,
      label: childParams.buildItem,
    });
    expect(getTaskFlowById(flowId)).toEqual(firstPersistedFlow);

    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    expect(getTaskById(taskId)).toMatchObject({
      taskId,
      parentFlowId: flowId,
      deliveryStatus: "pending",
      task: childParams.task,
      label: childParams.buildItem,
    });
    expect(getTaskFlowById(flowId)?.stateJson).toMatchObject({
      productionExecutorAssignments: [
        expect.objectContaining({
          taskId,
          producerDeviceId: "device-governed-implementation",
          proofPurpose: "implementation",
        }),
      ],
    });
  });

  it("fails closed for child mutations when durable governance survives mutable-state loss", async () => {
    const authorityPath = await writeTestBuildPlan("governed-child-corruption-plan.md");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-production-corrupt-child-state",
    });
    const ownerKey = "agent:main:corrupt-governed-child";
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey,
      controllerId: "corrupt-governed-child-controller",
      goal: "Reject child work after governed state corruption",
      sliceId: "corrupt-governed-child",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "corrupt-governed-child",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      governedMission,
    });
    expect(started.calls[0]?.[0]).toBe(true);
    const flowId = String(started.payload?.flow?.flowId);
    expect(prepareGovernedMissionAgentRun({ ownerKey, runId: "corrupt-parent-run" })).toMatchObject(
      {
        status: "bound",
        flowId,
      },
    );
    const child = createTaskRecord({
      runtime: "acp",
      requesterSessionKey: ownerKey,
      ownerKey,
      scopeKind: "session",
      childSessionKey: `${ownerKey}:child`,
      parentFlowId: flowId,
      runId: "corrupt-child-run",
      task: "Existing child must remain unchanged",
      status: "running",
      deliveryStatus: "pending",
    });
    const persisted = getTaskFlowById(flowId)!;
    const corruptedState = { ...(persisted.stateJson as Record<string, unknown>) };
    delete corruptedState.governedMissionState;
    const { db } = openOpenClawStateDatabase();
    db.prepare("UPDATE flow_runs SET state_json = ? WHERE flow_id = ?").run(
      JSON.stringify(corruptedState),
      flowId,
    );
    resetTaskFlowRegistryForTests({ persist: false });

    const status = await runTaskHandler("tasks.governance.status", { lookup: ownerKey });
    expect(status.calls[0]?.[0]).toBe(true);
    expect(status.payload).toMatchObject({
      flowId,
      governed: true,
      malformed: true,
      canonical: false,
    });
    const preview = await runTaskHandler("tasks.governance.preview", {
      lookup: ownerKey,
      operation: "startWorkOrder",
    });
    expect(preview.payload?.preview).toMatchObject({ status: "untrusted_governed_state", flowId });

    const dispatch = await runTaskHandler(
      "tasks.runTaskInFlow",
      {
        lookup: flowId,
        runtime: "acp",
        workPacketRef: "work-packet:corrupt-child",
        buildPlanRef: authorityPath,
        buildItem: "corrupt-governed-child",
        requiredOwnerLane: "Coding Agent",
        attemptedOwnerLane: "Coding Agent",
        attemptedExecutor: "Coding Agent",
        executorRole: "Coding Agent",
        lawfulRouteRequired: "assigned coding lane",
        handoffRef: "handoff:corrupt-child",
        handoffAcceptedBy: "Coding Agent",
        childSessionKey: `${ownerKey}:new-child`,
        task: "This child must not be created",
        runId: "corrupt-new-child-run",
        status: "running",
        proofPurpose: "implementation",
        permitted: ["repo_write"],
        prohibited: [],
      },
      { clientDeviceId: "device-governed-implementation" },
    );
    expect(dispatch.calls[0]?.[0]).toBe(false);
    expect(dispatch.calls[0]?.[2]?.message).toContain("governed_child_task_flow_untrusted");

    for (const method of ["tasks.recordTaskInFlowProgress", "tasks.completeTaskInFlow"] as const) {
      const result = await runTaskHandler(method, {
        lookup: flowId,
        taskId: child.taskId,
        runId: child.runId,
        runtime: child.runtime,
        sessionKey: child.childSessionKey,
        status: "succeeded",
        progressSummary: "must not be recorded",
      });
      expect(result.calls[0]?.[0]).toBe(false);
      expect(result.calls[0]?.[2]?.message).toContain("governed_child_task_flow_untrusted");
    }
    expect(getTaskById(child.taskId)).toEqual(child);
    expect(listTasksForFlowId(flowId)).toHaveLength(1);
  });

  it("readmits a drifted production mission through a freshly measured replacement package", async () => {
    const authorityPath = await writeTestBuildPlan("governed-readmission-plan.md");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-production-readmission",
    });
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "agent:main:readmission",
      controllerId: "governed-readmission-controller",
      goal: "Readmit governed production work",
      sliceId: "governed-readmission",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "governed-readmission",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      governedMission,
    });
    expect(started.calls[0]?.[0]).toBe(true);
    const flowId = String(started.payload?.flow?.flowId);
    const flow = getTaskFlowById(flowId)!;
    const mission = readGovernedMissionStateFromTaskFlow(flow)!;
    const drift = applyGovernedMissionOperation({
      flowId,
      request: {
        operation: "startWorkOrder",
        expectedRevision: mission.revision,
        idempotencyKey: "readmission-drift-detection",
        owner: mission.ownerCorrelation.owner,
        controllerId: flow.controllerId,
        bindings: {
          contractHash: mission.contractHash,
          authorityHash: mission.authorityHash,
          planRevisionId: mission.planRevisionId,
          sourceRevision: "stale-source-revision",
          runtimeBuildSha256: mission.runtimeBuildSha256,
          policyVersion: mission.policyVersion,
          skillSha256: mission.skillSha256,
        },
        occurredAt: "2026-09-17T01:00:00.000Z",
      },
    });
    expect(drift.status).toBe("denied");
    expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
      currentGovernedState: "readmission_required",
    });

    const replacementAuthorityPath = await writeTestBuildPlan(
      "governed-readmission-replacement-plan.md",
    );
    const replacement = structuredClone(governedMission);
    replacement.idempotencyKey = "gateway-production-readmission-2";
    replacement.contract.contractId = "gateway-production-readmission-contract-2";
    replacement.contract.contractVersion = "2";
    replacement.contract.contractHash = "gateway-production-readmission-contract-hash-2";
    replacement.contract.planRevisionId = "gateway-production-readmission-plan-2";
    replacement.contract.authorityRefs[0].uri = replacementAuthorityPath;
    replacement.manifest.planRevisionId = replacement.contract.planRevisionId;
    replacement.manifest.planSha256 = computeCompiledMissionPlanSha256(
      compileMissionPlan({
        manifest: replacement.manifest,
        requirements: replacement.requirements,
        gateKinds: replacement.gateKinds,
      }),
    );
    await fs.writeFile(
      replacementAuthorityPath,
      JSON.stringify({
        schema: "openclaw.governed_authority_plan.v1",
        planRevisionId: replacement.manifest.planRevisionId,
        planSha256: replacement.manifest.planSha256,
        scopeHash: replacement.manifest.scopeHash,
        authorizedScopeHash: replacement.manifest.authorizedScopeHash,
        planRevisionAuthorized: true,
      }),
      "utf8",
    );
    const replacementAuthorityHash = createHash("sha256")
      .update(await fs.readFile(replacementAuthorityPath))
      .digest("hex");
    replacement.contract.authorityHash = replacementAuthorityHash;
    replacement.contract.authorityRefs[0].sha256 = replacementAuthorityHash;
    for (const declaration of replacement.artifactDeclarations) {
      declaration.identityBindings.contractHash = replacement.contract.contractHash;
      declaration.identityBindings.authorityHash = replacementAuthorityHash;
      declaration.identityBindings.planRevisionId = replacement.contract.planRevisionId;
    }
    const current = readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!;
    const readmitted = await runTaskHandler("tasks.governance.apply", {
      lookup: flowId,
      expectedRevision: current.revision,
      idempotencyKey: "gateway-production-readmission-apply",
      action: {
        operation: "requestReadmission",
        authorityPath: replacementAuthorityPath,
        governedMission: replacement,
      },
    });

    expect(readmitted.calls[0]?.[0]).toBe(true);
    expect(readmitted.payload).toMatchObject({
      status: "applied",
      decision: { operation: "requestReadmission", stateChanged: true },
    });
    expect(readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)).toMatchObject({
      currentGovernedState: "admitted",
      contractVersion: "2",
      contractHash: "gateway-production-readmission-contract-hash-2",
      planRevisionId: "gateway-production-readmission-plan-2",
    });
    expect(getTaskFlowById(flowId)?.stateJson).toMatchObject({
      authorityPath: replacementAuthorityPath,
    });

    await fs.appendFile(replacementAuthorityPath, "changed after response loss", "utf8");
    const retried = await runTaskHandler("tasks.governance.apply", {
      lookup: flowId,
      expectedRevision: current.revision,
      idempotencyKey: "gateway-production-readmission-apply",
      action: {
        operation: "requestReadmission",
        authorityPath: replacementAuthorityPath,
        governedMission: replacement,
      },
    });
    expect(retried.calls[0]?.[0]).toBe(true);
    expect(retried.payload).toMatchObject({ status: "already_applied" });
  });

  it("replays an identity-drift denial with its originally observed bindings", async () => {
    const authorityPath = await writeTestBuildPlan("governed-drift-replay-plan.md");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-production-drift-replay",
    });
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "agent:main:drift-replay",
      controllerId: "governed-drift-replay-controller",
      goal: "Replay an identity drift decision",
      sliceId: "governed-drift-replay",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "governed-drift-replay",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      governedMission,
    });
    expect(started.calls[0]?.[0]).toBe(true);
    const flowId = String(started.payload?.flow?.flowId);
    const mission = readGovernedMissionStateFromTaskFlow(getTaskFlowById(flowId)!)!;
    const request = {
      lookup: flowId,
      expectedRevision: mission.revision,
      idempotencyKey: "governed-drift-replay-apply",
      action: { operation: "startWorkOrder" as const },
    };
    await fs.appendFile(authorityPath, "\nidentity drift\n", "utf8");

    const denied = await runTaskHandler("tasks.governance.apply", request);
    const replay = await runTaskHandler("tasks.governance.apply", request);

    expect(denied.calls[0]?.[0]).toBe(true);
    expect(denied.payload).toMatchObject({
      status: "denied",
      decision: { reasonCode: "AUTHORITY_HASH_MISMATCH", stateChanged: true },
    });
    expect(replay.calls[0]?.[0]).toBe(true);
    expect(replay.payload).toMatchObject({
      status: "already_applied",
      receipt: { receiptId: denied.payload?.receipt?.receiptId },
    });
  });

  it("inspects, previews, and starts an internally admitted governed TaskFlow", async () => {
    const authorityPath = await writeTestBuildPlan("gateway-preview-work-order.json");
    const authorityHash = createHash("sha256")
      .update(await fs.readFile(authorityPath))
      .digest("hex");
    governedRuntimeIdentityForTest = {
      sourceRevision: "source-1",
      runtimeBuildSha256: "build-1",
    };
    const skillSha256 = readGovernedWorkspaceSkillSha256({
      workspaceDir: stateDir,
      config: { agents: { defaults: { workspace: stateDir } } },
      agentId: "main",
    });
    if (!skillSha256) {
      throw new Error("expected governed workspace skill identity");
    }
    governedSkillSha256ForTest = skillSha256;
    const authorityRef = {
      refId: "work-order-1",
      kind: "work_order" as const,
      uri: authorityPath,
      sha256: authorityHash,
    };
    const contract: GovernedMissionContract = {
      schema: "openclaw.governed_mission_contract.v1",
      missionId: "gateway-governed-1",
      contractId: "gateway-contract-1",
      contractVersion: "1",
      contractHash: "contract-hash",
      authorityHash,
      authorityRefs: [authorityRef],
      admissionReceiptRef: "admission-1",
      planRevisionId: "plan-1",
      sourceRevision: "source-1",
      runtimeBuildSha256: "build-1",
      policyVersion: "policy-1",
      skillSha256,
      mode: "enforce",
      authoritativeCompletionOwner: "governed_mission_state",
      requiredReceiptKinds: [...GOVERNED_REQUIRED_RECEIPT_KINDS],
      createdAt: "2026-09-17T00:00:00.000Z",
    };
    const compiledPlan = compileMissionPlan({
      manifest: {
        schema: "openclaw.mission_manifest.v1",
        missionId: contract.missionId,
        planRevisionId: contract.planRevisionId,
        planSha256: "plan-sha",
        sourceRevision: contract.sourceRevision,
        runtimeBuildSha256: contract.runtimeBuildSha256,
        policyVersion: contract.policyVersion,
        skillSha256: contract.skillSha256,
        mode: "enforce",
        scopeHash: "scope-sha",
        authorizedScopeHash: "scope-sha",
        planRevisionAuthorized: true,
        createdAt: contract.createdAt,
      },
      requirements: [{ id: "REQ-1", text: "Complete the governed work", required: true }],
      gateKinds: ["test"],
    });
    const admitted = admitGovernedMissionToTaskFlow({
      admission: {
        hookName: "before_agent_run",
        classification: "governed_required",
        actor: { actorId: "gateway-governed-controller" },
        contract,
        observedAuthority: {
          contractHash: contract.contractHash,
          authorityHash: contract.authorityHash,
          authorityRef,
          planRevisionId: contract.planRevisionId,
          sourceRevision: contract.sourceRevision,
          runtimeBuildSha256: contract.runtimeBuildSha256,
          policyVersion: contract.policyVersion,
          skillSha256: contract.skillSha256,
        },
        enforcementCapabilities: ENFORCEMENT_HEALTH_CAPABILITIES.map((capability) => ({
          capability,
          state: "known_healthy" as const,
          observedAt: contract.createdAt,
        })),
        hostAuthority: { openclawAllows: true, osAllows: true, hostAllows: true },
        now: contract.createdAt,
      },
      ownerKey: "Will",
      controllerId: "gateway-governed-controller",
      goal: "Run governed work",
      idempotencyKey: "gateway-admit-1",
      compiledPlan,
      artifactDeclarations: [
        {
          artifactId: "proof-1",
          artifactKind: "validation",
          missionId: contract.missionId,
          workOrderId: "work-1",
          gateId: "REQ-1:test",
          allowedRoot: stateDir,
          pathname: path.join(stateDir, "governed-proof.json"),
          required: true,
          identityBindings: {
            missionId: contract.missionId,
            contractHash: contract.contractHash,
            authorityHash: contract.authorityHash,
            planRevisionId: contract.planRevisionId,
            sourceRevision: contract.sourceRevision,
            runtimeBuildSha256: contract.runtimeBuildSha256,
            policyVersion: contract.policyVersion,
            skillSha256: contract.skillSha256,
          },
        },
      ],
      deliveryRequired: true,
    });
    expect(admitted).toMatchObject({ status: "admitted" });
    if (admitted.status !== "admitted") {
      throw new Error(`expected admission, got ${admitted.status}`);
    }
    const flowId = admitted.flow.flowId;
    expect(admitted.flow).toHaveProperty(
      "stateJson.governedMissionPlan.requirements.requirements.0.gateIds",
      ["REQ-1:test"],
    );
    expect(admitted.flow).toHaveProperty(
      "stateJson.governedMissionArtifactDeclarations.0",
      expect.objectContaining({
        artifactId: "proof-1",
        gateId: "REQ-1:test",
        identityBindings: expect.objectContaining({ planRevisionId: contract.planRevisionId }),
      }),
    );
    expect(admitted.flow).toHaveProperty("stateJson.governedMissionState.proofs", {
      implementation: "pending",
      validation: "pending",
      review: "pending",
      artifacts: "pending",
      rollback: "not_required",
      restoration: "not_required",
      postTerminalWatchdog: "pending",
      delivery: "pending",
    });
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const beforeRead = await fs.stat(databasePath);
    const status = await runTaskHandler("tasks.governance.status", { lookup: flowId });
    const preview = await runTaskHandler("tasks.governance.preview", {
      lookup: flowId,
      operation: "startWorkOrder",
    });
    const afterRead = await fs.stat(databasePath);
    expect(status.calls[0]?.[0]).toBe(true);
    expect(validateTasksGovernanceStatusResult(status.payload)).toBe(true);
    expect(status.payload).toMatchObject({
      governed: true,
      canonical: true,
      mission: {
        missionId: contract.missionId,
        skillSha256: contract.skillSha256,
        authorityRef: { refId: authorityRef.refId, kind: authorityRef.kind },
      },
      receipts: [{ operation: "admitMission" }],
    });
    expect(status.payload?.mission).not.toHaveProperty("authorityRef.uri");
    expect(status.payload?.mission).not.toHaveProperty("ownerCorrelation");
    expect(preview.calls[0]?.[0]).toBe(true);
    expect(validateTasksGovernancePreviewResult(preview.payload)).toBe(true);
    expect(preview.payload?.preview).toMatchObject({
      status: "preview",
      decision: { status: "applied", stateChanged: true },
    });
    expect(preview.payload?.preview).not.toHaveProperty("flow");
    expect(preview.payload?.preview).not.toHaveProperty("decision.previousState");
    expect(preview.payload?.preview).not.toHaveProperty("decision.nextState");
    expect(preview.payload?.preview).not.toHaveProperty("decision.currentMission.authorityRef.uri");
    expect(JSON.stringify(preview.payload?.preview)).not.toContain(stateDir);
    expect(afterRead.mtimeMs).toBe(beforeRead.mtimeMs);

    createTaskRecord({
      runtime: "acp",
      ownerKey: "Will",
      requesterSessionKey: "Will",
      scopeKind: "session",
      parentFlowId: flowId,
      childSessionKey: "agent:main:acp:gateway-preview-child",
      runId: "gateway-preview-child-run",
      task: "Remain active during the preview",
      status: "running",
    });
    const activeWorkPreview = await runTaskHandler("tasks.governance.preview", {
      lookup: flowId,
      operation: "stopMission",
    });
    expect(activeWorkPreview.payload?.preview).toMatchObject({
      status: "preview",
      decision: { status: "conflict", reasonCode: "ACTIVE_WORK_CONFLICT" },
    });

    await fs.writeFile(authorityPath, "# Drifted Build Plan\n");
    const driftPreview = await runTaskHandler("tasks.governance.preview", {
      lookup: flowId,
      operation: "startWorkOrder",
    });
    expect(driftPreview.payload?.preview).toMatchObject({
      status: "preview",
      decision: { status: "denied", reasonCode: "AUTHORITY_HASH_MISMATCH" },
    });

    const callerIdentityRejected = await runTaskHandler("tasks.governance.preview", {
      lookup: flowId,
      operation: "startWorkOrder",
      owner: "Mallory",
      bindings: { contractHash: "caller-controlled" },
    });
    expect(callerIdentityRejected.calls[0]?.[0]).toBe(false);
    expect(callerIdentityRejected.calls[0]?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: "invalid governance preview params",
    });

    const missingPreview = await runTaskHandler("tasks.governance.preview", {
      lookup: "missing-governed-flow",
      operation: "startWorkOrder",
    });
    expect(missingPreview.calls[0]?.[0]).toBe(true);
    expect(missingPreview.payload?.preview).toEqual({ status: "not_found" });
    expect(validateTasksGovernancePreviewResult(missingPreview.payload)).toBe(true);

    const ordinary = createManagedTaskFlow({
      ownerKey: "agent:main:ordinary-preview",
      controllerId: "ordinary-preview-controller",
      goal: "Preview an ordinary flow",
    });
    if (!ordinary) {
      throw new Error("expected ordinary flow creation");
    }
    const ordinaryPreview = await runTaskHandler("tasks.governance.preview", {
      lookup: ordinary.flowId,
      operation: "startWorkOrder",
    });
    expect(ordinaryPreview.calls[0]?.[0]).toBe(true);
    expect(ordinaryPreview.payload?.preview).toEqual({
      status: "not_governed",
      flowId: ordinary.flowId,
      flowRevision: ordinary.revision,
    });
    expect(validateTasksGovernancePreviewResult(ordinaryPreview.payload)).toBe(true);
  });

  it("reports malformed governed state without exposing mission data", async () => {
    const malformedFlow: TaskFlowRecord = {
      flowId: "malformed-governed-gateway",
      syncMode: "managed",
      ownerKey: "Will",
      controllerId: "tests/malformed-governed-gateway",
      revision: 0,
      status: "blocked",
      notifyPolicy: "done_only",
      goal: "Diagnose malformed governed state",
      stateJson: { governedMissionState: "malformed" },
      createdAt: 100,
      updatedAt: 100,
    };
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({ flows: new Map([[malformedFlow.flowId, malformedFlow]]) }),
        saveSnapshot: () => {},
      },
    });

    const status = await runTaskHandler("tasks.governance.status", {
      lookup: malformedFlow.flowId,
    });

    expect(status.calls[0]?.[0]).toBe(true);
    expect(status.payload).toMatchObject({
      flowId: malformedFlow.flowId,
      governed: true,
      canonical: false,
      malformed: true,
      mission: null,
      receipts: [],
    });
    const preview = await runTaskHandler("tasks.governance.preview", {
      lookup: malformedFlow.flowId,
      operation: "startWorkOrder",
    });
    expect(preview.calls[0]?.[0]).toBe(true);
    expect(preview.payload?.preview).toEqual({
      status: "untrusted_governed_state",
      flowId: malformedFlow.flowId,
      flowRevision: malformedFlow.revision,
    });
    expect(validateTasksGovernancePreviewResult(preview.payload)).toBe(true);
  });

  it("persists build issue triage through the RPC while preserving an explicit session-send denial", async () => {
    const authorityPath = await writeTestBuildPlan();
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "agent:main:main",
      controllerId: "build-issue-test",
      goal: "Finish repair",
      sliceId: "repair",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "owner instruction",
      buildItem: "repair",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
    });
    const flowId = String(started.payload?.flow?.flowId);
    const task = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      parentFlowId: flowId,
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:worker",
      runId: "worker-run",
      task: "Assigned repair",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
    });
    const assignment = recordProductionExecutorAssignment({
      flowId,
      taskId: task.taskId,
      expectedRunId: "worker-run",
      executorId: "Coding Agent",
      ownerLane: "Coding Agent",
      role: "Coding Agent",
      permitted: ["production_dispatch"],
      prohibited: [],
      evidenceRefs: ["proof:capability"],
    });
    expect(assignment.applied).toBe(true);
    const result = await runTaskHandler(
      "tasks.handleBuildIssue",
      {
        kind: "triage",
        flowId,
        ownerKey: "agent:main:main",
        actionId: "action-1",
        occurrenceId: "occurrence-1",
        issueId: "issue-1",
        summary: "Incidental failure",
        evidenceRefs: ["proof:incidental"],
        impact: "non_blocking",
        resume: {
          executor: {
            taskId: task.taskId,
            expectedRunId: "worker-run",
            ownerLane: "Coding Agent",
            role: "Coding Agent",
            permitted: ["production_dispatch"],
            prohibited: [],
            evidenceRefs: ["proof:capability"],
          },
          message: "Continue the assigned repair.",
        },
      },
      { cfg: { gateway: { tools: { deny: ["sessions_send"] } } } },
    );
    expect(result.calls[0]?.[0]).toBe(true);
    expect(result.calls[0]?.[1]).toMatchObject({
      receipt: {
        decision: "log_deferred_issue_and_resume",
        execution: { state: "dispatch_failed", reason: "Tool not available: sessions_send" },
      },
    });
    expect(getTaskFlowById(flowId)?.stateJson).toMatchObject({
      buildIssueActions: [{ input: { issueId: "issue-1" } }],
    });
    expect(getTaskFlowById(flowId)?.endedAt).toBeUndefined();
  });

  it("records governed build-issue stops through the canonical ledger owner", async () => {
    const authorityPath = await writeTestBuildPlan("governed-build-issue-plan.md");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "governed-build-issue-mission",
    });
    const ownerKey = "agent:main:main";
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey,
      controllerId: "governed-build-issue-test",
      goal: "Stop safely for an operator decision",
      sliceId: "governed-build-issue",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "governed-build-issue",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      governedMission,
    });
    expect(started.calls[0]?.[0]).toBe(true);
    const flowId = String(started.payload?.flow?.flowId);

    const result = await runTaskHandler("tasks.handleBuildIssue", {
      kind: "triage",
      flowId,
      ownerKey,
      actionId: "governed-build-issue-action",
      occurrenceId: "governed-build-issue-occurrence",
      issueId: "governed-build-issue",
      summary: "Operator scope decision required",
      evidenceRefs: ["proof:governed-build-issue"],
      impact: "operator_decision",
    });

    expect(result.calls[0]?.[0]).toBe(true);
    expect(result.payload?.receipt).toMatchObject({
      decision: "stop_for_operator_decision",
      execution: { state: "not_dispatched" },
    });
    const flow = getTaskFlowById(flowId)!;
    expect(flow).toMatchObject({
      status: "blocked",
      currentStep: "build_issue_resolution_required",
      stateJson: {
        buildIssueActions: [{ input: { actionId: "governed-build-issue-action" } }],
      },
    });
    expect(getTaskFlowProductionContinuation(flow)).toMatchObject({
      parentRunOpen: true,
      ownerDecisionRequired: true,
      lawfulStopReason: "owner_decision",
    });
    expect(listGovernedMissionReceipts({ flowId }).map((receipt) => receipt.operation)).toEqual(
      expect.arrayContaining(["recordBuildIssueAction", "recordBuildIssueBoundary"]),
    );
    expect(
      prepareGovernedMissionAgentRunRuntime({
        ownerKey,
        runId: "run-after-governed-build-issue-stop",
        trustedRuntimeIdentity: governedRuntimeIdentityForTest,
        observedSkillSha256: governedSkillSha256ForTest,
      }),
    ).toMatchObject({
      status: "blocked",
      reasonCode: "GOVERNED_PRODUCTION_BOUNDARY_ACTIVE",
    });
  });

  it("lists task summaries with SDK-facing statuses and filters", async () => {
    const running = createTaskRecord({
      runtime: "subagent",
      taskKind: "investigation",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      agentId: "main",
      runId: "run-running",
      task: "Investigate issue",
      status: "running",
      deliveryStatus: "pending",
    });
    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:other:main",
      ownerKey: "agent:other:main",
      scopeKind: "session",
      runId: "run-other",
      task: "Other task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.list", {
      status: "running",
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.tasks).toHaveLength(1);
    const listedTask = payload?.tasks?.[0];
    expect(listedTask?.id).toBe(running.taskId);
    expect(listedTask?.taskId).toBe(running.taskId);
    expect(listedTask?.kind).toBe("investigation");
    expect(listedTask?.runtime).toBe("subagent");
    expect(listedTask?.status).toBe("running");
    expect(listedTask?.title).toBe("Investigate issue");
    expect(listedTask?.agentId).toBe("main");
    expect(listedTask?.sessionKey).toBe("agent:main:main");
    expect(listedTask?.childSessionKey).toBe("agent:worker:subagent:child");
    expect(listedTask?.runId).toBe("run-running");
  });

  it("gets completed tasks with stable completed status", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-completed",
      task: "Done task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
    });

    const { payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.status).toBe("completed");
    expect(payload?.task?.title).toBe("Done task");
  });

  it("sanitizes task text before exposing SDK summaries", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-sanitized",
      label:
        "Compile artifact\nOpenClaw runtime context (internal): Keep internal details private.",
      task: "Compile artifact",
      status: "running",
      deliveryStatus: "pending",
    });
    recordTaskProgressByRunId({
      runId: "run-sanitized",
      progressSummary:
        "Bundling output\nOpenClaw runtime context (internal): Keep internal details private.",
    });
    markTaskTerminalById({
      taskId: task.taskId,
      status: "failed",
      endedAt: Date.now(),
      terminalSummary:
        "Failed after build\nOpenClaw runtime context (internal): Keep internal details private.",
      error: "Tool failed\nOpenClaw runtime context (internal): Keep internal details private.",
    });

    const { calls, payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.title).toBe("Compile artifact");
    expect(payload?.task?.terminalSummary).toBe("Failed after build");
    expect(payload?.task?.error).toBe("Tool failed");
    expect(JSON.stringify(calls[0]?.[1])).not.toContain("OpenClaw runtime context");
  });

  it("cancels running task records and returns the updated task", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-cancel",
      task: "Cancelable task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "user stopped task",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(true);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("cancelled");
    expect(payload?.task?.error).toBe("user stopped task");
  });

  it("probes active production watchdog lifecycle through the installed gateway observer", async () => {
    const cron = createCronHarness(false);
    installProductionWatchdogLifecycleGate({ cron });

    const { calls, payload } = await runTaskHandler(
      "tasks.probeProductionWatchdogLifecycle",
      {},
      { cron },
    );

    expect(calls[0]?.[0]).toBe(true);
    expect(payload).toMatchObject({
      ok: true,
      initialEnabled: false,
      afterOpenEnabled: true,
      afterCloseEnabled: false,
      flowStatus: "succeeded",
    });
    expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
      enabled: true,
    });
    expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
      enabled: false,
    });
    const flowId = payload?.flowId;
    expect(typeof flowId).toBe("string");
    const flow = getTaskFlowById(flowId!);
    expect(flow?.status).toBe("succeeded");
  });

  it("returns structured diagnostics when watchdog probe cron.readJob stalls", async () => {
    const cron = createCronHarness(false);
    cron.readJob = vi.fn(async () => await new Promise<never>(() => {}));

    const { calls, payload } = await runTaskHandler(
      "tasks.probeProductionWatchdogLifecycle",
      {},
      { cron },
    );

    expect(calls[0]?.[0]).toBe(false);
    expect(payload?.diagnostic).toMatchObject({
      kind: "watchdog_lifecycle_probe_timeout",
      operation: "cron.readJob",
      stage: "initial-read",
      timeoutMs: 2000,
    });
    expect(calls[0]?.[2]).toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("cron.readJob timed out"),
    });
  });

  it("returns structured diagnostics when watchdog probe cron.list stalls", async () => {
    const cron = createCronHarness(false);
    cron.readJob = vi.fn(async () => undefined);
    cron.list = vi.fn(async () => await new Promise<never>(() => {}));

    const { calls, payload } = await runTaskHandler(
      "tasks.probeProductionWatchdogLifecycle",
      {},
      { cron },
    );

    expect(calls[0]?.[0]).toBe(false);
    expect(payload?.diagnostic).toMatchObject({
      kind: "watchdog_lifecycle_probe_timeout",
      operation: "cron.list",
      stage: "initial-read",
      timeoutMs: 2000,
    });
    expect(calls[0]?.[2]).toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("cron.list timed out"),
    });
  });

  it("starts and lawfully blocks a production flow through gateway observer state", async () => {
    const cron = createCronHarness(false);
    installProductionWatchdogLifecycleGate({ cron });
    const authorityPath = await writeTestBuildPlan("gie-authority-build-plan.md");

    const started = await runTaskHandler(
      "tasks.startProductionFlow",
      {
        ownerKey: "agent:orchestrator:main",
        controllerId: "gie/authority-mirror-decision",
        goal: "GIE authority mirror decision",
        sliceId: "gie-authority-mirror-decision-2026-06-22T0236Z",
        sliceOwner: "Will / Top-Level Governance",
        authorityPath,
        authorityBasis: "controlling build-state interpretation",
        buildItem: "GIE authority mirror decision",
        requiredOwnerLane: "Will / Top-Level Governance",
        attemptedOwnerLane: "Will / Top-Level Governance",
        attemptedExecutor: "will-orchestrator",
        executorRole: "governance_decision",
        lawfulRouteRequired: "Will / Top-Level Governance decision",
        currentStep: "authority_decision",
        blockers: ["department_registry_mirror_alignment", "blocking_authority_state"],
      },
      { cron },
    );

    expect(started.calls[0]?.[0]).toBe(true);
    await waitForCronEnabled(cron, true);
    expect(cron.update).toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
      enabled: true,
    });
    const flowId = String(started.payload?.flow?.flowId);
    const flow = getTaskFlowById(flowId);
    expect(flow?.status).toBe("running");
    expect(getTaskFlowProductionContinuation(flow!)?.activeProductionRun).toBe(true);

    const stopped = await runTaskHandler(
      "tasks.recordProductionFlowLawfulStop",
      {
        lookup: flowId,
        reason: "blocker",
        detail: "authority decision remains blocked",
        currentStep: "authority_blocked",
      },
      { cron },
    );

    expect(stopped.calls[0]?.[0]).toBe(true);
    await waitForCronEnabled(cron, true);
    expect(cron.update).not.toHaveBeenCalledWith(ACTIVE_WORK_WATCHDOG_CRON_JOB_ID, {
      enabled: false,
    });
    const stoppedFlow = getTaskFlowById(flowId);
    expect(stoppedFlow?.status).toBe("blocked");
    expect(stoppedFlow?.blockedSummary).toBe("authority decision remains blocked");
    expect(getTaskFlowProductionContinuation(stoppedFlow!)?.lawfulStopReason).toBe("blocker");
  });

  it("blocks Will from starting a Will-owned production flow for SADB-owned work", async () => {
    const authorityPath = await writeTestBuildPlan("gie-v2-build-plan.md");

    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-v2-phase0-owner-surface-verification-constitution-2026-06-22T2022Z",
      controllerId: "will-orchestrator",
      goal: "Verify owner surfaces and issue GIE constitution",
      sliceId: "gie-v2-phase0-owner-surface-verification-constitution-2026-06-22T2022Z",
      sliceOwner: "Will / Top-Level Governance",
      authorityPath,
      authorityBasis: "GIE v2 controlling build plan Phase 0",
      buildItem: "Phase 0 - Owner-Surface Verification And GIE Constitution",
      requiredOwnerLane: "SADB",
      attemptedOwnerLane: "Will",
      attemptedExecutor: "will-orchestrator",
      executorRole: "direct_execution",
      lawfulRouteRequired: "dispatch bounded owner-surface discovery support to SADB",
    });

    expect(started.calls[0]?.[0]).toBe(false);
    expect(started.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: {
        buildPlanRef: authorityPath,
        buildItem: "Phase 0 - Owner-Surface Verification And GIE Constitution",
        requiredOwnerLane: "SADB",
        attemptedOwnerLane: "Will",
        attemptedExecutor: "will-orchestrator",
        lawfulRouteRequired: "dispatch bounded owner-surface discovery support to SADB",
        operatorOverrideExists: false,
      },
    });
    expect(started.calls[0]?.[2]?.message).toContain("will_self_perform_forbidden");
  });

  it("blocks missing owner/lane metadata before production flow creation", async () => {
    const authorityPath = await writeTestBuildPlan("missing-owner-route-plan.md");

    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "agent:orchestrator:main",
      controllerId: "gie/missing-owner",
      goal: "Missing owner route",
      sliceId: "gie-missing-owner-route",
      sliceOwner: "Will",
      authorityPath,
      authorityBasis: "test plan",
    });

    expect(started.calls[0]?.[0]).toBe(false);
    expect(started.calls[0]?.[2]?.message).toContain("buildItem is required");
  });

  it("does not treat parent production flow start as child execution proof", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-plan.md");

    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });

    expect(started.calls[0]?.[0]).toBe(true);
    expect(started.payload?.executorIdentityProof).toBeUndefined();
    const flowId = String(started.payload?.flow?.flowId);
    const flow = getTaskFlowById(flowId);
    expect(flow?.status).toBe("running");
    expect(started.payload?.flow?.stateJson).toMatchObject({
      ownerLaneGuard: {
        requiredOwnerLane: "sadb_decomposition_review",
        attemptedExecutor: "sadb_decomposition_review",
      },
    });
  });

  it("blocks child task execution without lawful handoff proof", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-handoff-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);

    const child = await runTaskHandler("tasks.runTaskInFlow", {
      lookup: flowId,
      runtime: "cli",
      workPacketRef: "/tmp/sadb-packet.md",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
      handoffAcceptedBy: "sadb_decomposition_review",
      task: "Run SADB decomposition",
    });

    expect(child.calls[0]?.[0]).toBe(false);
    expect(child.calls[0]?.[2]?.message).toContain("child_task_handoff_missing");
  });

  it("blocks Will from directly running a SADB child task", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-will-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);

    const child = await runTaskHandler("tasks.runTaskInFlow", {
      lookup: flowId,
      runtime: "cli",
      workPacketRef: "/tmp/sadb-packet.md",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "Will",
      attemptedExecutor: "will-orchestrator",
      executorRole: "direct_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
      handoffRef: "handoff:sadb",
      handoffAcceptedBy: "sadb_decomposition_review",
      task: "Run SADB decomposition",
    });

    expect(child.calls[0]?.[0]).toBe(false);
    expect(child.calls[0]?.[2]?.message).toContain("child_task_executor_identity_mismatch");
    expect(child.calls[0]?.[2]?.message).toContain("will_self_perform_forbidden");
  });

  it("blocks production child dispatch without a backing child session", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-child-session-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);

    const child = await runTaskHandler("tasks.runTaskInFlow", {
      lookup: flowId,
      runtime: "cli",
      sourceId: "/tmp/sadb-packet.md",
      workPacketRef: "/tmp/sadb-packet.md",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
      handoffRef: "handoff:sadb",
      handoffAcceptedBy: "sadb_decomposition_review",
      task: "Run SADB decomposition",
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      status: "running",
    });

    expect(child.calls[0]?.[0]).toBe(false);
    expect(child.calls[0]?.[2]?.message).toContain("child_task_backing_session_missing");
  });

  it("blocks production child completion when backing child session proof is missing", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-child-completion-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);
    createTaskRecord({
      runtime: "cli",
      ownerKey: "gie-phase1-sadb-runtime",
      requesterSessionKey: "gie-phase1-sadb-runtime",
      scopeKind: "session",
      parentFlowId: flowId,
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      task: "Run SADB decomposition",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    const completed = await runTaskHandler("tasks.completeTaskInFlow", {
      lookup: flowId,
      runId: "gie-phase1-sadb-child-run",
      runtime: "cli",
      status: "succeeded",
      terminalSummary: "SADB completed",
    });

    expect(completed.calls[0]?.[0]).toBe(false);
    expect(completed.calls[0]?.[2]?.message).toContain("child_task_backing_session_missing");
  });

  it("records a blocked production child closeout when backing child session is missing", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-child-blocked-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);
    const task = createTaskRecord({
      runtime: "cli",
      ownerKey: "gie-phase1-sadb-runtime",
      requesterSessionKey: "gie-phase1-sadb-runtime",
      scopeKind: "session",
      parentFlowId: flowId,
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      task: "Run SADB decomposition",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    const completed = await runTaskHandler("tasks.completeTaskInFlow", {
      lookup: flowId,
      runId: "gie-phase1-sadb-child-run",
      runtime: "cli",
      status: "blocked",
      terminalSummary: "SADB backing session disappeared before closeout delivery.",
    });

    expect(completed.calls[0]?.[0]).toBe(true);
    expect(completed.payload?.task?.status).toBe("failed");
    expect(getTaskById(task.taskId)).toMatchObject({
      status: "failed",
      terminalOutcome: "blocked",
      terminalSummary: "SADB backing session disappeared before closeout delivery.",
    });
  });

  it("records a rejected production child closeout when backing child session is missing", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-child-rejected-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);
    const task = createTaskRecord({
      runtime: "cli",
      ownerKey: "gie-phase1-sadb-runtime",
      requesterSessionKey: "gie-phase1-sadb-runtime",
      scopeKind: "session",
      parentFlowId: flowId,
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      task: "Run SADB decomposition",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    const completed = await runTaskHandler("tasks.completeTaskInFlow", {
      lookup: flowId,
      runId: "gie-phase1-sadb-child-run",
      runtime: "cli",
      status: "rejected",
      error: "Grant closeout missing proof fields.",
      terminalSummary: "Rejected: missing proof fields.",
    });

    expect(completed.calls[0]?.[0]).toBe(true);
    expect(completed.payload?.task?.status).toBe("failed");
    expect(getTaskById(task.taskId)).toMatchObject({
      status: "failed",
      error: "Grant closeout missing proof fields.",
      terminalOutcome: "blocked",
      terminalSummary: "Rejected: missing proof fields.",
    });
  });

  it("blocks production child success without continuation launch proof", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-continuation-required.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);
    const task = createTaskRecord({
      runtime: "cli",
      ownerKey: "gie-phase1-sadb-runtime",
      requesterSessionKey: "gie-phase1-sadb-runtime",
      scopeKind: "session",
      childSessionKey: "agent:sadb:phase1-child",
      parentFlowId: flowId,
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      task: "Run SADB decomposition",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    const completed = await runTaskHandler("tasks.completeTaskInFlow", {
      lookup: flowId,
      runId: "gie-phase1-sadb-child-run",
      runtime: "cli",
      status: "succeeded",
      terminalSummary: "SADB completed",
    });

    expect(completed.calls[0]?.[0]).toBe(false);
    expect(completed.calls[0]?.[2]?.message).toContain(
      "child_task_completion_requires_continuation_proof",
    );
    expect(getTaskFlowById(flowId)?.status).toBe("running");
    expect(getTaskById(task.taskId)?.status).toBe("running");
  });

  it("records next executable launch proof when completing a production child", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-continuation-launched.md");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-production-continuation-launch",
    });
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
      governedMission,
    });
    const flowId = String(started.payload?.flow?.flowId);
    expect(
      prepareGovernedMissionAgentRun({
        ownerKey: "gie-phase1-sadb-runtime",
        runId: "gie-phase1-governed-parent-run",
      }),
    ).toMatchObject({ status: "bound", flowId });
    closeGovernedMissionExecutionLease({
      flowId,
      runId: "gie-phase1-governed-parent-run",
    });
    const task = createTaskRecord({
      runtime: "cli",
      ownerKey: "gie-phase1-sadb-runtime",
      requesterSessionKey: "gie-phase1-sadb-runtime",
      scopeKind: "session",
      childSessionKey: "agent:sadb:phase1-child",
      parentFlowId: flowId,
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      task: "Run SADB decomposition",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });
    const producerDeviceId = "device-continuation-launch";
    expect(
      recordProductionExecutorAssignment({
        flowId,
        taskId: task.taskId,
        expectedRunId: "gie-phase1-sadb-child-run",
        executorId: "sadb-continuation-executor",
        producerDeviceId,
        ownerLane: "sadb_decomposition_review",
        proofPurpose: "implementation",
        role: "SADB",
        permitted: ["production_dispatch"],
        prohibited: ["runtime_restart"],
        evidenceRefs: ["work-packet:sadb-continuation"],
      }),
    ).toMatchObject({ applied: true });

    const completion = {
      lookup: flowId,
      runId: "gie-phase1-sadb-child-run",
      runtime: "cli",
      status: "succeeded",
      terminalSummary: "SADB completed",
      nextExecutableLaunch: {
        detail: "Launch Phase 1 Security safety audit",
        currentStep: "phase1_security_safety_audit_running",
      },
    };
    const completed = await runTaskHandler("tasks.completeTaskInFlow", completion, {
      clientDeviceId: producerDeviceId,
    });

    expect(completed.calls[0]?.[0]).toBe(true);
    expect(completed.payload?.task?.status).toBe("completed");
    expect(completed.payload?.flow?.currentStep).toBe("phase1_security_safety_audit_running");
    const persistedFlow = getTaskFlowById(flowId)!;
    const continuation = getTaskFlowProductionContinuation(persistedFlow);
    expect(continuation?.continuationRequiredAfterLocalSuccess).toBe(true);
    expect(continuation?.nextExecutableUnitLaunched).toBe(true);
    const receipts = listGovernedMissionReceipts({ flowId });
    const continuationReceipt = receipts.find(
      (receipt) => receipt.operation === "recordNextExecutableLaunch",
    );
    expect(continuationReceipt?.governedPackageSha256).toBe(
      computeGovernedMissionPackageSha256(persistedFlow),
    );
    expect(continuationReceipt?.receiptSha256).toBe(
      continuationReceipt && computeGovernedMissionReceiptSha256(continuationReceipt),
    );
    expect(isGovernedMissionStateCanonicallyPersisted(persistedFlow)).toBe(true);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "recordNextExecutableLaunch",
          reasonCode: "NEXT_EXECUTABLE_UNIT_LAUNCHED",
        }),
      ]),
    );

    const persistedTask = getTaskById(task.taskId);
    const retry = await runTaskHandler("tasks.completeTaskInFlow", completion, {
      clientDeviceId: producerDeviceId,
    });
    expect(retry.calls[0]?.[0]).toBe(true);
    expect(retry.payload?.task).toEqual(completed.payload?.task);
    expect(retry.payload?.flow).toEqual(completed.payload?.flow);
    expect(getTaskById(task.taskId)).toEqual(persistedTask);
    expect(getTaskFlowById(flowId)).toEqual(persistedFlow);
    expect(listGovernedMissionReceipts({ flowId })).toEqual(receipts);

    const changedPayload = await runTaskHandler(
      "tasks.completeTaskInFlow",
      {
        ...completion,
        nextExecutableLaunch: {
          ...completion.nextExecutableLaunch,
          detail: "Launch a different unit",
        },
      },
      { clientDeviceId: producerDeviceId },
    );
    expect(changedPayload.calls[0]?.[0]).toBe(false);
    expect(getTaskById(task.taskId)).toEqual(persistedTask);
    expect(getTaskFlowById(flowId)).toEqual(persistedFlow);
    expect(listGovernedMissionReceipts({ flowId })).toEqual(receipts);

    const changedSummary = await runTaskHandler(
      "tasks.completeTaskInFlow",
      { ...completion, terminalSummary: "Different completion claim" },
      { clientDeviceId: producerDeviceId },
    );
    expect(changedSummary.calls[0]?.[0]).toBe(false);
    expect(getTaskById(task.taskId)).toEqual(persistedTask);
    expect(getTaskFlowById(flowId)).toEqual(persistedFlow);
    expect(listGovernedMissionReceipts({ flowId })).toEqual(receipts);

    const otherDevice = await runTaskHandler("tasks.completeTaskInFlow", completion, {
      clientDeviceId: "different-device",
    });
    expect(otherDevice.calls[0]?.[0]).toBe(false);
    expect(getTaskById(task.taskId)).toEqual(persistedTask);
    expect(getTaskFlowById(flowId)).toEqual(persistedFlow);
    expect(listGovernedMissionReceipts({ flowId })).toEqual(receipts);
  });

  it("mutates only the requested governed child in a shared run scope", async () => {
    const authorityPath = await writeTestBuildPlan("shared-run-governed-child-completion.md");
    const governedMission = await createGovernedProductionPackage({
      authorityPath,
      missionId: "gateway-shared-run-child-completion",
    });
    const ownerKey = "agent:main:shared-run-owner";
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey,
      controllerId: "shared-run-child-completion",
      goal: "Prove producer-scoped child completion",
      sliceId: "shared-run-child-completion",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "pinned governed build plan",
      buildItem: "shared-run-child-completion",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      governedMission,
    });
    expect(started.calls[0]?.[0]).toBe(true);
    const flowId = String(started.payload?.flow?.flowId);
    const parentRunId = "shared-run-governed-parent";
    expect(prepareGovernedMissionAgentRun({ ownerKey, runId: parentRunId })).toMatchObject({
      status: "bound",
      flowId,
    });
    closeGovernedMissionExecutionLease({ flowId, runId: parentRunId });
    const sharedRunId = "shared-governed-child-run";
    const sharedChildSessionKey = "agent:main:shared-governed-child";
    const first = createTaskRecord({
      runtime: "cli",
      ownerKey,
      requesterSessionKey: ownerKey,
      scopeKind: "session",
      childSessionKey: sharedChildSessionKey,
      parentFlowId: flowId,
      runId: sharedRunId,
      label: "first producer",
      task: "First producer work",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
    });
    const second = createTaskRecord({
      runtime: "cli",
      ownerKey,
      requesterSessionKey: ownerKey,
      scopeKind: "session",
      childSessionKey: sharedChildSessionKey,
      parentFlowId: flowId,
      runId: sharedRunId,
      label: "second producer",
      task: "Second producer work",
      status: "running",
      deliveryStatus: "session_queued",
      notifyPolicy: "done_only",
    });
    if (!first || !second) {
      throw new Error("expected both shared-run child task records");
    }
    expect(first.taskId).not.toBe(second.taskId);
    for (const [task, producerDeviceId] of [
      [first, "device-first-producer"],
      [second, "device-second-producer"],
    ] as const) {
      expect(
        recordProductionExecutorAssignment({
          flowId,
          taskId: task.taskId,
          expectedRunId: sharedRunId,
          executorId: `${task.label}-executor`,
          producerDeviceId,
          ownerLane: "Coding Agent",
          proofPurpose: "implementation",
          role: "Coding Agent",
          permitted: ["repo_write"],
          prohibited: [],
          evidenceRefs: [`work-packet:${task.taskId}`],
        }),
      ).toMatchObject({ applied: true });
    }

    const ambiguous = await runTaskHandler("tasks.recordTaskInFlowProgress", {
      lookup: flowId,
      runId: sharedRunId,
      runtime: "cli",
      sessionKey: sharedChildSessionKey,
      progressSummary: "Ambiguous progress must not select a child.",
    });
    expect(ambiguous.calls[0]?.[0]).toBe(false);
    expect(ambiguous.calls[0]?.[2]?.message).toContain("child_task_scope_ambiguous");

    const unauthorizedProgress = await runTaskHandler("tasks.recordTaskInFlowProgress", {
      lookup: flowId,
      taskId: first.taskId,
      runId: sharedRunId,
      runtime: "cli",
      sessionKey: sharedChildSessionKey,
      progressSummary: "Spoofed producer progress.",
      eventSummary: "Spoofed requester-facing progress.",
    });
    expect(unauthorizedProgress.calls[0]?.[0]).toBe(false);
    expect(unauthorizedProgress.calls[0]?.[2]?.message).toContain(
      "governed_child_task_progress_owner_mismatch",
    );
    expect(getTaskById(first.taskId)?.progressSummary).toBeUndefined();

    const progressed = await runTaskHandler(
      "tasks.recordTaskInFlowProgress",
      {
        lookup: flowId,
        taskId: first.taskId,
        runId: sharedRunId,
        runtime: "cli",
        sessionKey: sharedChildSessionKey,
        progressSummary: "First producer is ready to close.",
      },
      { clientDeviceId: "device-first-producer" },
    );
    expect(progressed.calls[0]?.[0]).toBe(true);
    expect(progressed.payload?.task?.taskId).toBe(first.taskId);
    expect(getTaskById(first.taskId)).toMatchObject({
      progressSummary: "First producer is ready to close.",
    });
    expect(getTaskById(second.taskId)?.progressSummary).toBeUndefined();

    const completed = await runTaskHandler(
      "tasks.completeTaskInFlow",
      {
        lookup: flowId,
        taskId: first.taskId,
        runId: sharedRunId,
        runtime: "cli",
        sessionKey: sharedChildSessionKey,
        status: "failed",
        error: "First producer failed its assigned work.",
      },
      { clientDeviceId: "device-first-producer" },
    );

    expect(completed.calls[0]?.[0]).toBe(true);
    expect(completed.payload?.task?.taskId).toBe(first.taskId);
    expect(getTaskById(first.taskId)).toMatchObject({
      status: "failed",
      error: "First producer failed its assigned work.",
    });
    expect(getTaskById(second.taskId)).toMatchObject({ status: "running" });

    const terminalProgress = await runTaskHandler(
      "tasks.recordTaskInFlowProgress",
      {
        lookup: flowId,
        taskId: first.taskId,
        runId: sharedRunId,
        runtime: "cli",
        sessionKey: sharedChildSessionKey,
        progressSummary: "Terminal progress must not be recorded.",
      },
      { clientDeviceId: "device-first-producer" },
    );
    expect(terminalProgress.calls[0]?.[0]).toBe(false);
    expect(terminalProgress.calls[0]?.[2]?.message).toContain(
      "governed_child_task_progress_not_active",
    );
    expect(getTaskById(first.taskId)?.progressSummary).toBe("First producer is ready to close.");

    const nextAttempt = prepareGovernedMissionAgentRun({
      ownerKey,
      runId: "shared-run-governed-parent-next",
    });
    expect(nextAttempt).toMatchObject({ status: "bound", flowId });
    const staleProgress = await runTaskHandler(
      "tasks.recordTaskInFlowProgress",
      {
        lookup: flowId,
        taskId: second.taskId,
        runId: sharedRunId,
        runtime: "cli",
        sessionKey: sharedChildSessionKey,
        progressSummary: "Stale attempt progress must not be recorded.",
      },
      { clientDeviceId: "device-second-producer" },
    );
    expect(staleProgress.calls[0]?.[0]).toBe(false);
    expect(staleProgress.calls[0]?.[2]?.message).toContain(
      "governed_child_task_progress_owner_mismatch",
    );
    expect(getTaskById(second.taskId)?.progressSummary).toBeUndefined();
  });

  it("runs a lawful SADB child task and emits executor identity proof", async () => {
    const authorityPath = await writeTestBuildPlan("phase1-sadb-child-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-phase1-sadb-runtime",
      controllerId: "will-orchestrator/gie",
      goal: "Dispatch Phase 1 SADB runtime implementation",
      sliceId: "gie-phase1-sadb-runtime",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "Phase 1 policy-law decision",
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "sadb_lane_execution",
      lawfulRouteRequired: "SADB executes through governed lane path",
    });
    const flowId = String(started.payload?.flow?.flowId);

    const child = await runTaskHandler("tasks.runTaskInFlow", {
      lookup: flowId,
      runtime: "cli",
      sourceId: "/tmp/sadb-packet.md",
      workPacketRef: "/tmp/sadb-packet.md",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "SADB",
      lawfulRouteRequired: "SADB executes through governed lane path",
      handoffRef: "handoff:sadb",
      handoffAcceptedBy: "sadb_decomposition_review",
      childSessionKey: "agent:sadb:phase1-child",
      task: "Run SADB decomposition",
      runId: "gie-phase1-sadb-child-run",
      label: "Phase 1 SADB runtime implementation",
      status: "running",
      permitted: ["repo_read", "repo_write", "production_dispatch"],
      prohibited: [],
    });

    expect(child.calls[0]?.[0]).toBe(true);
    expect(child.payload?.task).toMatchObject({
      runtime: "cli",
      status: "running",
      runId: "gie-phase1-sadb-child-run",
      flowId,
    });
    expect(child.payload?.executorIdentityProof).toMatchObject({
      kind: "production_taskflow_child_execution_proof",
      buildPlanRef: authorityPath,
      buildItem: "Phase 1 - Hard-Rule Policy Engine",
      workPacketRef: "/tmp/sadb-packet.md",
      requiredOwnerLane: "sadb_decomposition_review",
      attemptedOwnerLane: "sadb_decomposition_review",
      attemptedExecutor: "sadb_decomposition_review",
      executorRole: "SADB",
      handoffRef: "handoff:sadb",
      handoffAcceptedBy: "sadb_decomposition_review",
      parentFlowId: flowId,
      childSessionKey: "agent:sadb:phase1-child",
      deliveryStatus: "pending",
    });
    expect(child.payload?.executorIdentityProof?.childTaskId).toBe(child.payload?.task?.taskId);
    expect(getTaskFlowById(flowId)?.stateJson).toMatchObject({
      productionExecutorAssignments: [
        {
          taskId: child.payload?.task?.taskId,
          expectedRunId: "gie-phase1-sadb-child-run",
          executorId: "sadb_decomposition_review",
          ownerLane: "sadb_decomposition_review",
          role: "SADB",
          permitted: ["production_dispatch", "repo_read", "repo_write"],
          prohibited: [],
        },
      ],
    });
    resetTaskFlowRegistryForTests({ persist: false });
    expect(getTaskFlowById(flowId)?.stateJson).toMatchObject({
      productionExecutorAssignments: [
        {
          taskId: child.payload?.task?.taskId,
          expectedRunId: "gie-phase1-sadb-child-run",
          role: "SADB",
          permitted: ["production_dispatch", "repo_read", "repo_write"],
        },
      ],
    });
  });

  it("removes the exact child when executor assignment persistence is rejected", async () => {
    const authorityPath = await writeTestBuildPlan("assignment-compensation-plan.md");
    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "assignment-compensation-owner",
      controllerId: "assignment-compensation-controller",
      goal: "Prove assignment compensation",
      sliceId: "assignment-compensation-slice",
      sliceOwner: "Coding Agent",
      authorityPath,
      authorityBasis: "test authority",
      buildItem: "Assignment compensation",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
    });
    const flowId = String(started.payload?.flow?.flowId);

    const child = await runTaskHandler("tasks.runTaskInFlow", {
      lookup: flowId,
      runtime: "cli",
      workPacketRef: "x".repeat(4_097),
      buildPlanRef: authorityPath,
      buildItem: "Assignment compensation",
      requiredOwnerLane: "Coding Agent",
      attemptedOwnerLane: "Coding Agent",
      attemptedExecutor: "Coding Agent",
      executorRole: "Coding Agent",
      lawfulRouteRequired: "assigned coding lane",
      handoffRef: "handoff:assignment-compensation",
      handoffAcceptedBy: "Coding Agent",
      childSessionKey: "agent:main:subagent:assignment-compensation",
      task: "Exercise assignment compensation",
      status: "running",
      permitted: ["repo_read", "production_dispatch"],
      prohibited: [],
    });

    expect(child.calls[0]?.[0]).toBe(false);
    expect(child.calls[0]?.[2]?.message).toContain(
      "child_task_assignment_persist_failed: production_executor_assignment_invalid",
    );
    expect(listTasksForFlowId(flowId)).toEqual([]);
    resetTaskRegistryForTests({ persist: false });
    expect(listTasksForFlowId(flowId)).toEqual([]);
  });

  it("allows a scoped explicit operator override for a production flow", async () => {
    const authorityPath = await writeTestBuildPlan("override-plan.md");

    const started = await runTaskHandler("tasks.startProductionFlow", {
      ownerKey: "gie-override-test",
      controllerId: "sadb-runtime",
      goal: "Override scoped work",
      sliceId: "gie-override-test",
      sliceOwner: "SADB",
      authorityPath,
      authorityBasis: "test plan",
      buildItem: "Phase 4 - Contradiction Resolver",
      requiredOwnerLane: "Governance/Authority",
      attemptedOwnerLane: "SADB",
      attemptedExecutor: "sadb",
      executorRole: "runtime_implementation",
      lawfulRouteRequired: "dispatch to Governance/Authority",
      operatorOverride: {
        explicitOperatorApproval: true,
        targetWorkItem: "Phase 4 - Contradiction Resolver",
        normalRequiredOwnerLane: "Governance/Authority",
        approvedAlternateExecutor: "sadb",
        reason: "bounded approved implementation support",
        scope: "this test slice only",
        oneTimeUse: true,
      },
    });

    expect(started.calls[0]?.[0]).toBe(true);
    expect(started.payload?.flow?.stateJson).toMatchObject({
      buildItem: "Phase 4 - Contradiction Resolver",
      requiredOwnerLane: "Governance/Authority",
      attemptedOwnerLane: "SADB",
      attemptedExecutor: "sadb",
      ownerLaneGuard: {
        operatorOverrideExists: true,
      },
    });
  });
});
