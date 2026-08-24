import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateFalseCloseoutAdmission } from "./false-closeout-admission-controller.js";
import {
  buildRuntimeCloseoutAdmissionInput,
  writeFalseCloseoutAdmissionDecisionReceipt,
} from "./false-closeout-runtime-evidence.js";
import type { MissionIdentity } from "./mission-manifest.types.js";

const RUNTIME_IDENTITY: MissionIdentity = {
  missionId: "cleanup-crew-runtime-closeout-bddc0ffee",
  planRevisionId: "runtime-closeout-attempt-v1",
  planSha256: "060498e57418332777e3dc83949c40ad882b2a7933abb8afc1e54cb2e64f7a4f",
  sourceRevision: "runtime-unbound",
  runtimeBuildSha256: "runtime-unbound",
  policyVersion: "active-run-continuation-guard",
  skillSha256: "runtime-unbound",
};

const BOUND_IDENTITY: MissionIdentity = {
  missionId: "cleanup-crew-final-live-enforcement",
  planRevisionId: "ai-orchestrator-plan",
  planSha256: "plan-sha",
  sourceRevision: "source-sha",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "cleanup-watchdog-governance-20260715T1442Z",
  skillSha256: "skill-sha",
};

describe("false-closeout runtime evidence", () => {
  it("builds deterministic runtime closeout input and writes a durable decision receipt", () => {
    const input = buildRuntimeCloseoutAdmissionInput({
      activeCleanupCrewMission: true,
      terminalAttempt: true,
      currentTurnText: "run cleanup crew until the next step is complete",
      responseText: "done",
      mode: "enforce",
      activeRunStarted: true,
      executionRunningNow: true,
      pendingContinuationRequirement: true,
      nextExecutableStepStarted: false,
      now: "2026-07-17T05:00:00.000Z",
    });

    expect(input).toBeDefined();
    expect(input?.manifest.mode).toBe("enforce");
    expect(input?.runtimeState.parentStatus).toBe("running");
    expect(input?.nextExecutableStepExists).toBe(true);

    const decision = evaluateFalseCloseoutAdmission(input!);
    expect(decision.allowed).toBe(false);
    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining(["FCAC_PARENT_RUNNING", "FCAC_NEXT_EXECUTABLE_STEP_EXISTS"]),
    );

    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcac-runtime-evidence-"));
    const receipt = writeFalseCloseoutAdmissionDecisionReceipt({
      input: input!,
      decision,
      workspaceDir,
    });
    const body = JSON.parse(fs.readFileSync(receipt.path, "utf8")) as {
      schema: string;
      decision: { decisionId: string };
      input: { manifest: { missionId: string } };
    };

    expect(receipt.path).toContain("var/false_closeout_admission/decisions");
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.schema).toBe("openclaw.false_closeout_admission_decision_receipt.v1");
    expect(body.decision.decisionId).toBe(decision.decisionId);
    expect(body.input.manifest.missionId).toBe(input?.manifest.missionId);
  });

  it("maps live delivery, executor, watchdog, repair, and next-step snapshots into rejection evidence", () => {
    const input = buildRuntimeCloseoutAdmissionInput({
      activeCleanupCrewMission: true,
      terminalAttempt: true,
      currentTurnText: "run cleanup crew until the next step is complete",
      responseText: "done",
      mode: "enforce",
      now: "2026-07-17T05:00:00.000Z",
      runtimeState: {
        parentStatus: "running",
        activeExecutorCount: 0,
        staleExecutorCount: 1,
        openSessionCount: 0,
        openRunCount: 0,
        openLeaseCount: 0,
        openContinuationCount: 1,
        pendingDeliveryCount: 1,
      },
      watchdog: {
        label: "NEEDS_REVIEW",
        suspiciousCount: 2,
        postTerminal: false,
      },
      repairWork: {
        openIds: ["watchdog-repair-open"],
      },
      nextExecutableStepExists: true,
    });

    const decision = evaluateFalseCloseoutAdmission(input!);

    expect(input?.runtimeState.pendingDeliveryCount).toBe(1);
    expect(input?.runtimeState.staleExecutorCount).toBe(1);
    expect(input?.repairWork.openIds).toEqual(["watchdog-repair-open"]);
    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_PARENT_RUNNING",
        "FCAC_EXECUTOR_RUNNING_OR_STALE",
        "FCAC_REPORT_RUNTIME_CONTRADICTION",
        "FCAC_REPAIR_OPEN",
        "FCAC_WATCHDOG_NOT_CLEAN",
        "FCAC_POST_TERMINAL_WATCHDOG_MISSING",
        "FCAC_NEXT_EXECUTABLE_STEP_EXISTS",
      ]),
    );
  });

  it("preserves explicit mission identity and evidence manifest binding", () => {
    const input = buildRuntimeCloseoutAdmissionInput({
      activeCleanupCrewMission: true,
      terminalAttempt: true,
      identity: BOUND_IDENTITY,
      evidenceManifestSha256: "evidence-manifest-sha",
      currentTurnText: "run cleanup crew until the next step is complete",
      responseText: "done",
      mode: "enforce",
      now: "2026-07-17T05:00:00.000Z",
    });

    expect(input?.manifest).toMatchObject(BOUND_IDENTITY);
    expect(input?.completionRequest).toMatchObject(BOUND_IDENTITY);
    expect(input?.completionRequest.evidenceManifestSha256).toBe("evidence-manifest-sha");

    const decision = evaluateFalseCloseoutAdmission(input!);
    expect(decision.missionId).toBe(BOUND_IDENTITY.missionId);
    expect(decision.evidenceManifestSha256).toBe("evidence-manifest-sha");
  });

  it("preserves supplied stale review and rollback/restoration gaps as controller inputs", () => {
    const input = buildRuntimeCloseoutAdmissionInput({
      activeCleanupCrewMission: true,
      terminalAttempt: true,
      currentTurnText: "run cleanup crew until the next step is complete",
      responseText: "done",
      mode: "enforce",
      now: "2026-07-17T05:00:00.000Z",
      runtimeState: {
        parentStatus: "terminal",
        activeExecutorCount: 0,
        staleExecutorCount: 0,
        openSessionCount: 0,
        openRunCount: 0,
        openLeaseCount: 0,
        openContinuationCount: 0,
        pendingDeliveryCount: 0,
      },
      watchdog: {
        label: "CLEAN",
        suspiciousCount: 0,
        postTerminal: true,
      },
      repairWork: {
        openIds: [],
      },
      nextExecutableStepExists: false,
      reportContradictions: [],
      grantApproval: {
        schema: "openclaw.grant_approval.v1",
        ...RUNTIME_IDENTITY,
        approved: true,
        approvedAt: "2026-07-17T05:00:00.000Z",
        evidenceManifestSha256: "wrong-evidence",
        reviewer: "Grant",
      },
    });

    const decision = evaluateFalseCloseoutAdmission(input!);

    expect(decision.rejectionCodes).toEqual(
      expect.arrayContaining([
        "FCAC_REQUIREMENT_MISSING_RECEIPT",
        "FCAC_ROLLBACK_MISSING_OR_INVALID",
        "FCAC_RESTORATION_MISSING_OR_INVALID",
        "FCAC_EXPORT_MANIFEST_INCOMPLETE",
      ]),
    );
    expect(decision.rejectionCodes).not.toContain("FCAC_GRANT_STALE_OR_MISSING");
  });
});
