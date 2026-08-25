import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistActivationContinuationBeforeRestart,
  recoverPendingActivationContinuations,
  resolveActivationContinuationContinuityGatePersistence,
  resumeActivationContinuation,
  testing,
  type ActivationContinuationCheckName,
  type ActivationContinuationCheckResult,
} from "./activation-continuation.js";

let tempRoot: string;
let stateDir: string;
let exportsDir: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-activation-continuation-"));
  stateDir = path.join(tempRoot, "state");
  exportsDir = path.join(tempRoot, "exports");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function passCheck(name: ActivationContinuationCheckName): ActivationContinuationCheckResult {
  return { name, status: "pass", detail: "ok" };
}

function continuityGateOutputDir(root = stateDir): string {
  return path.join(root, "var", "continuity_gate_v2", "activation_continuation");
}

async function readJsonArtifacts<T>(dir: string, subdir: string): Promise<T[]> {
  const artifactDir = path.join(dir, subdir);
  const files = await fs.readdir(artifactDir);
  return await Promise.all(
    files.map(
      async (file) => JSON.parse(await fs.readFile(path.join(artifactDir, file), "utf8")) as T,
    ),
  );
}

describe("activation restart continuations", () => {
  it("resolves Continuity Gate persistence only for absolute activation state directories", () => {
    expect(resolveActivationContinuationContinuityGatePersistence()).toBeUndefined();
    expect(
      resolveActivationContinuationContinuityGatePersistence({ stateDir: "undefined" }),
    ).toBeUndefined();
    expect(
      resolveActivationContinuationContinuityGatePersistence({ stateDir: "relative-state" }),
    ).toBeUndefined();
    expect(resolveActivationContinuationContinuityGatePersistence({ stateDir })).toMatchObject({
      outputDir: continuityGateOutputDir(),
    });
  });

  it("persists a pending continuation before restart dispatch", async () => {
    const record = await persistActivationContinuationBeforeRestart(
      {
        id: "activation-1",
        now: 10,
        route: { sessionKey: "main" },
        objective: "activate patched gateway",
        expectedRuntime: { commit: "abc" },
        requiredChecks: ["http_health"],
        hardStopRules: ["do not resume GIE/SADB"],
        requestedRestartAction: { reason: "activation", skipDeferral: true },
      },
      { stateDir },
    );

    const store = await testing.readStore(stateDir);

    expect(record.status).toBe("pending_restart");
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      id: "activation-1",
      status: "pending_restart",
      objective: "activate patched gateway",
      expectedRuntime: { commit: "abc" },
      requestedRestartAction: {
        method: "gateway.restart.request",
        reason: "activation",
        skipDeferral: true,
      },
    });
  });

  it("persists governed restart mission identity and next executable step", async () => {
    const record = await persistActivationContinuationBeforeRestart(
      {
        id: "activation-governed-restart",
        now: 10,
        route: { sessionKey: "agent:orchestrator:main" },
        parent: {
          sessionKey: "agent:orchestrator:main",
          runId: "parent-run-1",
        },
        governedRestart: {
          parentMissionId: "763440db-1c9e-41ee-9adf-8e097af1db4e",
          currentPhase: "Phase 9 durable continuation architecture",
          executableStep: "governed_restart_loaded_runtime_validation",
          sessionKey: "agent:orchestrator:main",
          runId: "foreground-cleanup-crew:763440db:supersession:1",
          restartRequestId: "restart-request-1",
          continuationIdentity: "continuation-identity-1",
          continuationRevision: 1,
          receiptId: "receipt-1",
          nextAction: "recover replacement executor and rerun watchdog",
        },
        objective: "activate patched gateway",
        expectedRuntime: { commit: "abc" },
        requiredChecks: ["http_health"],
      },
      { stateDir },
    );

    const store = await testing.readStore(stateDir);
    expect(record.governedRestart).toMatchObject({
      parentMissionId: "763440db-1c9e-41ee-9adf-8e097af1db4e",
      executableStep: "governed_restart_loaded_runtime_validation",
      continuationRevision: 1,
      nextAction: "recover replacement executor and rerun watchdog",
    });
    expect(store.records[0]?.governedRestart).toEqual(record.governedRestart);
  });

  it("rejects incomplete governed restart bindings on store read", async () => {
    const record = await testing.createContinuationRecord({
      id: "activation-incomplete-governed-restart",
      now: 10,
      route: { sessionKey: "agent:orchestrator:main" },
      governedRestart: {
        parentMissionId: "mission",
        currentPhase: "phase",
        executableStep: "step",
        sessionKey: "agent:orchestrator:main",
        runId: "run",
        restartRequestId: "restart",
        continuationIdentity: "identity",
        continuationRevision: 1,
        receiptId: "receipt",
        nextAction: "continue",
      },
    });
    await testing.writeStore(
      {
        version: 1,
        records: [
          {
            ...record,
            governedRestart: {
              parentMissionId: "mission",
              currentPhase: "phase",
            },
          } as any,
        ],
      },
      stateDir,
    );

    const store = await testing.readStore(stateDir);
    expect(store.records[0]?.governedRestart).toBeUndefined();
  });

  it("keeps visible delivery proof separate from delivery route proof", async () => {
    const record = await persistActivationContinuationBeforeRestart(
      {
        id: "activation-visible-proof",
        now: 10,
        route: { sessionKey: "main" },
        objective: "activate patched gateway",
        expectedRuntime: { commit: "abc" },
        requiredChecks: ["visible_delivery", "delivery route is configured"],
      },
      { stateDir },
    );

    expect(record.requiredChecks).toEqual(["visible_delivery", "delivery_route"]);
  });

  it("defaults restart continuations to the required runtime proof bundle", async () => {
    const record = await persistActivationContinuationBeforeRestart(
      {
        id: "activation-default-proof-bundle",
        now: 10,
        route: { sessionKey: "main" },
        objective: "activate patched gateway",
        expectedRuntime: { commit: "abc" },
      },
      { stateDir },
    );

    expect(record.requiredChecks).toEqual([
      "systemd",
      "gateway_status_rpc",
      "http_health",
      "runtime_identity",
      "log_scan",
    ]);

    await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 200,
      check: async (_record, check) =>
        check === "runtime_identity"
          ? { name: check, status: "fail", detail: "build-info missing from runtime" }
          : passCheck(check),
      deliver: () => {},
    });

    const store = await testing.readStore(stateDir);
    expect(store.records[0]).toMatchObject({
      id: "activation-default-proof-bundle",
      status: "continuation_blocked",
    });
    expect(store.records[0]?.result?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "systemd", status: "pass" }),
        expect.objectContaining({ name: "gateway_status_rpc", status: "pass" }),
        expect.objectContaining({ name: "http_health", status: "pass" }),
        expect.objectContaining({
          name: "runtime_identity",
          status: "fail",
          detail: "build-info missing from runtime",
        }),
        expect.objectContaining({ name: "log_scan", status: "pass" }),
      ]),
    );
    expect(store.records[0]?.result?.message).toContain("runtime_identity=fail");
    expect(store.records[0]?.blockerPath).toBeTruthy();
  });

  it("persists Continuity Gate continuation evidence for restart deferral before dispatch", async () => {
    await persistActivationContinuationBeforeRestart(
      {
        id: "activation-deferral-continuity",
        now: 10,
        route: { sessionKey: "main" },
        objective: "activate patched gateway",
        requiredChecks: ["http_health"],
        requestedRestartAction: { reason: "activation", skipDeferral: true },
      },
      { stateDir },
    );

    const outputDir = continuityGateOutputDir();
    const decisionRecords = await readJsonArtifacts<{
      selected_state: string;
      authority_resolution: { winner: string; winnerId: string };
      technical_vs_product: { lane: string };
    }>(outputDir, "cleanup_crew_decision_records");
    const continueReceipts = await readJsonArtifacts<{
      selected_state: string;
      repair_action: string;
    }>(outputDir, "cleanup_crew_continue_receipts");
    const traces = await readJsonArtifacts<{
      selected_state: string;
      scope: { records: string[] };
      technical_vs_product: { lane: string };
    }>(outputDir, "cleanup_crew_diagnostic_traces");

    expect(decisionRecords).toContainEqual(
      expect.objectContaining({
        selected_state: "CONTINUE_AFTER_RUNTIME_PROOF_REPAIR",
        authority_resolution: expect.objectContaining({
          winner: "active_mission_lock",
          winnerId: "activation_continuation:activation-deferral-continuity",
        }),
        technical_vs_product: expect.objectContaining({ lane: "technical" }),
      }),
    );
    expect(continueReceipts).toContainEqual(
      expect.objectContaining({
        selected_state: "CONTINUE_AFTER_RUNTIME_PROOF_REPAIR",
        repair_action: "resume activation continuation after restart and produce runtime proof",
      }),
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        selected_state: "CONTINUE_AFTER_RUNTIME_PROOF_REPAIR",
        technical_vs_product: expect.objectContaining({ lane: "technical" }),
        scope: expect.objectContaining({
          records: expect.arrayContaining([
            "activation-deferral-continuity",
            "activation_status:pending_restart",
          ]),
        }),
      }),
    );
    await expect(
      fs.readdir(path.join(outputDir, "cleanup_crew_stop_reports")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads pending continuations on startup and reports completion after checks pass", async () => {
    await persistActivationContinuationBeforeRestart(
      {
        id: "activation-2",
        now: 100,
        route: { sessionKey: "main" },
        objective: "post restart validation",
        requiredChecks: ["systemd", "http_health"],
      },
      { stateDir },
    );
    const delivered: string[] = [];

    const recovered = await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 200,
      check: async (_record, check) => passCheck(check),
      deliver: (_record, message) => {
        delivered.push(message);
      },
    });

    const store = await testing.readStore(stateDir);
    expect(recovered).toHaveLength(1);
    expect(store.records[0]?.status).toBe("continuation_completed");
    expect(store.records[0]?.attempts).toBe(1);
    expect(delivered.join("\n")).toContain(
      "side effect completed, parent turn interrupted, continuation resumed and validation passed",
    );
    expect(delivered.join("\n")).not.toContain("aborted");
    await expect(fs.stat(store.records[0]?.closeoutPath ?? "")).resolves.toBeTruthy();
  });

  it("preserves hard stop rules and does not run forbidden downstream work", async () => {
    const record = await persistActivationContinuationBeforeRestart(
      {
        id: "activation-3",
        now: 100,
        route: { sessionKey: "main" },
        hardStopRules: ["do not resume GIE/SADB", "do not relaunch SADB"],
        requiredChecks: ["http_health"],
      },
      { stateDir },
    );
    const delivered: string[] = [];

    await resumeActivationContinuation(record, {
      stateDir,
      exportsDir,
      now: () => 200,
      check: async (_record, check) => passCheck(check),
      deliver: (_record, message) => {
        delivered.push(message);
      },
    });

    const output = delivered.join("\n");
    expect(output).toContain("do not resume GIE/SADB");
    expect(output).toContain("do not relaunch SADB");
  });

  it("is idempotent across repeated startup scans after completion", async () => {
    await persistActivationContinuationBeforeRestart(
      {
        id: "activation-4",
        now: 100,
        route: { sessionKey: "main" },
        requiredChecks: ["http_health"],
      },
      { stateDir },
    );
    const check = vi.fn(async (_record, checkName: ActivationContinuationCheckName) =>
      passCheck(checkName),
    );

    await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 200,
      check,
      deliver: () => {},
    });
    await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 300,
      check,
      deliver: () => {},
    });

    const store = await testing.readStore(stateDir);
    expect(check).toHaveBeenCalledTimes(1);
    expect(store.records[0]?.status).toBe("continuation_completed");
    expect(store.records[0]?.attempts).toBe(1);
  });

  it("writes a durable blocker artifact when required proof is missing", async () => {
    await persistActivationContinuationBeforeRestart(
      {
        id: "activation-5",
        now: 100,
        requiredChecks: ["http_health", "manual:yield-resume"],
      },
      { stateDir },
    );

    await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 200,
      check: async (_record, check) =>
        check === "http_health"
          ? passCheck(check)
          : { name: check, status: "fail", detail: "missing smoke proof" },
      deliver: () => {},
    });

    const store = await testing.readStore(stateDir);
    const blockerPath = store.records[0]?.blockerPath;
    expect(store.records[0]?.status).toBe("continuation_blocked");
    expect(blockerPath).toBeTruthy();
    const blocker = await fs.readFile(blockerPath ?? "", "utf8");
    expect(blocker).toContain("Missing proof/check: manual:yield-resume");
    expect(blocker).toContain("Exact next repair step:");
  });

  it("persists Continuity Gate continuation evidence for runtime proof gaps", async () => {
    await persistActivationContinuationBeforeRestart(
      {
        id: "activation-proof-gap-continuity",
        now: 100,
        route: { sessionKey: "main" },
        requiredChecks: ["http_health", "manual:yield-resume"],
      },
      { stateDir },
    );

    await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 200,
      check: async (_record, check) =>
        check === "http_health"
          ? passCheck(check)
          : { name: check, status: "fail", detail: "missing smoke proof" },
      deliver: () => {},
    });

    const outputDir = continuityGateOutputDir();
    const traces = await readJsonArtifacts<{
      selected_state: string;
      scope: { records: string[] };
      technical_vs_product: { lane: string };
    }>(outputDir, "cleanup_crew_diagnostic_traces");
    const continueReceipts = await readJsonArtifacts<{
      selected_state: string;
      repair_action: string;
    }>(outputDir, "cleanup_crew_continue_receipts");

    expect(traces).toContainEqual(
      expect.objectContaining({
        selected_state: "CONTINUE_AFTER_RUNTIME_PROOF_REPAIR",
        technical_vs_product: expect.objectContaining({ lane: "technical" }),
        scope: expect.objectContaining({
          records: expect.arrayContaining([
            "activation-proof-gap-continuity",
            "activation_status:continuation_blocked",
            "manual:yield-resume:fail:missing smoke proof",
          ]),
        }),
      }),
    );
    expect(continueReceipts).toContainEqual(
      expect.objectContaining({
        selected_state: "CONTINUE_AFTER_RUNTIME_PROOF_REPAIR",
        repair_action:
          "repair the failing runtime proof checks and allow activation continuation recovery to retry",
      }),
    );
  });

  it("persists Continuity Gate stop evidence when restart recovery expires unresolved", async () => {
    const record = await persistActivationContinuationBeforeRestart(
      {
        id: "activation-expired-continuity",
        now: 100,
        ttlMs: 1,
        route: { sessionKey: "main" },
        requiredChecks: ["http_health"],
      },
      { stateDir },
    );

    await resumeActivationContinuation(record, {
      stateDir,
      exportsDir,
      now: () => 200,
      check: async (_record, check) => passCheck(check),
      deliver: () => {},
    });

    const outputDir = continuityGateOutputDir();
    const stopReports = await readJsonArtifacts<{
      stop_state: string;
      plain_text_question: string;
    }>(outputDir, "cleanup_crew_stop_reports");
    const traces = await readJsonArtifacts<{
      selected_state: string;
      technical_vs_product: { lane: string };
      scope: { records: string[] };
    }>(outputDir, "cleanup_crew_diagnostic_traces");

    expect(stopReports).toContainEqual(
      expect.objectContaining({
        stop_state: "STOP_TRUE_UNKNOWN_BLOCKER",
        plain_text_question: "No operator action requested unless a human decision is required.",
      }),
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        selected_state: "STOP_TRUE_UNKNOWN_BLOCKER",
        technical_vs_product: expect.objectContaining({ lane: "true_unknown" }),
        scope: expect.objectContaining({
          records: expect.arrayContaining([
            "activation-expired-continuity",
            "activation_status:expired_before_recovery",
          ]),
        }),
      }),
    );
  });

  it("persists diagnostic-only Continuity Gate evidence for answer-only restart recovery overrides", async () => {
    const record = await testing.createContinuationRecord({
      id: "activation-answer-only-continuity",
      now: 100,
      route: { sessionKey: "main" },
      requiredChecks: ["http_health"],
    });
    await testing.writeStore({ version: 1, records: [record] }, stateDir);

    const check = vi.fn(async (_record, checkName: ActivationContinuationCheckName) =>
      passCheck(checkName),
    );
    const deliver = vi.fn();

    const result = await resumeActivationContinuation(record, {
      stateDir,
      exportsDir,
      now: () => 200,
      continuityGate: {
        outputDir: continuityGateOutputDir(),
        now: "2026-07-04T23:10:00.000Z",
        userInstruction: "inspect only",
      },
      check,
      deliver,
    });

    const store = await testing.readStore(stateDir);
    const outputDir = continuityGateOutputDir();
    const traces = await readJsonArtifacts<{
      selected_state: string;
      scope: { records: string[] };
    }>(outputDir, "cleanup_crew_diagnostic_traces");

    expect(traces).toContainEqual(
      expect.objectContaining({
        selected_state: "STOP_USER_ANSWER_ONLY_OVERRIDE",
        scope: expect.objectContaining({
          records: expect.arrayContaining(["activation-answer-only-continuity"]),
        }),
      }),
    );
    expect(result.status).toBe("pending_restart");
    expect(store.records[0]).toMatchObject({
      id: "activation-answer-only-continuity",
      status: "pending_restart",
    });
    expect(store.records[0]?.closeoutPath).toBeUndefined();
    expect(store.records[0]?.blockerPath).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    await expect(fs.readdir(exportsDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readdir(path.join(outputDir, "cleanup_crew_continue_receipts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readdir(path.join(outputDir, "cleanup_crew_stop_reports")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not persist a Continuity Gate repair receipt for successful completed recovery", async () => {
    const record = await testing.createContinuationRecord({
      id: "activation-success-continuity",
      now: 100,
      route: { sessionKey: "main" },
      requiredChecks: ["http_health"],
    });
    await testing.writeStore({ version: 1, records: [record] }, stateDir);

    const result = await resumeActivationContinuation(record, {
      stateDir,
      exportsDir,
      now: () => 200,
      continuityGate: {
        outputDir: continuityGateOutputDir(),
        now: "2026-07-04T23:11:00.000Z",
      },
      check: async (_record, check) => passCheck(check),
      deliver: () => {},
    });

    expect(result.status).toBe("continuation_completed");
    await expect(fs.stat(result.closeoutPath ?? "")).resolves.toBeTruthy();
    await expect(
      fs.readdir(path.join(continuityGateOutputDir(), "cleanup_crew_continue_receipts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readdir(path.join(continuityGateOutputDir(), "cleanup_crew_decision_records")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks instead of completing when no visible delivery route exists", async () => {
    await persistActivationContinuationBeforeRestart(
      {
        id: "activation-no-route",
        now: 100,
        objective: "post restart validation",
        requiredChecks: ["http_health"],
      },
      { stateDir },
    );
    const delivered: string[] = [];

    await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 200,
      check: async (_record, check) => passCheck(check),
      deliver: (_record, message) => {
        delivered.push(message);
      },
    });

    const store = await testing.readStore(stateDir);
    expect(delivered).toHaveLength(0);
    expect(store.records[0]?.status).toBe("continuation_blocked");
    expect(store.records[0]?.result?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "delivery_route",
          status: "fail",
        }),
      ]),
    );
    expect(store.records[0]?.blockerPath).toBeTruthy();
  });

  it("reports old persisted unregistered checks clearly", async () => {
    const record = await testing.createContinuationRecord({
      id: "activation-old-smoke",
      now: 100,
      route: { sessionKey: "main" },
      objective: "post restart validation",
      expectedRuntime: { commit: "abc" },
      requiredChecks: ["smoke:yield-resume" as ActivationContinuationCheckName],
    });
    await testing.writeStore(
      { version: 1, records: [{ ...record, status: "pending_restart" }] },
      stateDir,
    );
    const delivered: string[] = [];

    await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 200,
      deliver: (_record, message) => {
        delivered.push(message);
      },
    });

    const store = await testing.readStore(stateDir);
    expect(store.records[0]?.status).toBe("continuation_blocked");
    expect(store.records[0]?.result?.checks[0]).toMatchObject({
      name: "manual:smoke-yield-resume",
      status: "fail",
      detail: "unregistered continuation check: manual:smoke-yield-resume",
    });
    expect(delivered.join("\n")).toContain("unregistered continuation check");
  });

  it("recognizes restart-continuation manual proof aliases", async () => {
    const runtimeRoot = path.join(tempRoot, "runtime");
    const runtimeDist = path.join(tempRoot, "dist");
    await fs.mkdir(runtimeRoot, { recursive: true });
    await fs.mkdir(runtimeDist, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDist, "build-info.json"),
      JSON.stringify({ commit: "abc", version: "2026.6.2", builtAt: "now" }),
    );
    const previousRuntimeRoot = process.env.OPENCLAW_RUNTIME_ROOT;
    const previousCwd = process.cwd();
    process.env.OPENCLAW_RUNTIME_ROOT = runtimeRoot;
    process.chdir(tempRoot);
    try {
      await persistActivationContinuationBeforeRestart(
        {
          id: "activation-known-restart-manuals",
          now: 100,
          route: { sessionKey: "main" },
          objective: "post restart validation",
          expectedRuntime: { commit: "abc", version: "2026.6.2", builtAt: "now" },
          requiredChecks: [
            "manual:restart-safe-active-work-preflight",
            "manual:post-restart-gateway-status",
            "manual:gateway-status",
            "manual:post-restart-runtime-identity",
            "manual:post-restart-asset-guard",
            "manual:normal-reply-path-usable",
          ],
        },
        { stateDir },
      );
      const delivered: string[] = [];

      await recoverPendingActivationContinuations({
        stateDir,
        exportsDir,
        now: () => 200,
        deliver: (_record, message) => {
          delivered.push(message);
        },
      });

      const store = await testing.readStore(stateDir);
      expect(store.records[0]?.status).toBe("continuation_completed");
      expect(store.records[0]?.result?.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "manual:restart-safe-active-work-preflight",
            status: "pass",
          }),
          expect.objectContaining({
            name: "manual:post-restart-gateway-status",
            status: "pass",
          }),
          expect.objectContaining({
            name: "manual:gateway-status",
            status: "pass",
          }),
          expect.objectContaining({
            name: "manual:post-restart-runtime-identity",
            status: "pass",
          }),
          expect.objectContaining({
            name: "manual:post-restart-asset-guard",
            status: "pass",
          }),
          expect.objectContaining({
            name: "manual:normal-reply-path-usable",
            status: "pass",
          }),
        ]),
      );
      expect(delivered.join("\n")).not.toContain("unregistered continuation check");
      expect(delivered.join("\n")).toContain("manual:restart-safe-active-work-preflight=pass");
    } finally {
      process.chdir(previousCwd);
      if (previousRuntimeRoot === undefined) {
        delete process.env.OPENCLAW_RUNTIME_ROOT;
      } else {
        process.env.OPENCLAW_RUNTIME_ROOT = previousRuntimeRoot;
      }
    }
  });

  it("keeps restart-continuation manual proof aliases blocking when proof is missing", async () => {
    await persistActivationContinuationBeforeRestart(
      {
        id: "activation-known-restart-manuals-missing-proof",
        now: 100,
        objective: "post restart validation",
        expectedRuntime: { commit: "abc" },
        requiredChecks: [
          "manual:restart-safe-active-work-preflight",
          "manual:normal-reply-path-usable",
        ],
        requestedRestartAction: { skipDeferral: true },
      },
      { stateDir },
    );

    await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 200,
      deliver: () => {},
    });

    const store = await testing.readStore(stateDir);
    expect(store.records[0]?.status).toBe("continuation_blocked");
    expect(store.records[0]?.result?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "manual:restart-safe-active-work-preflight",
          status: "fail",
          detail: expect.stringContaining("safe active-work preflight was not proven"),
        }),
        expect.objectContaining({
          name: "manual:normal-reply-path-usable",
          status: "fail",
          detail: expect.stringContaining("persisted visible continuation route"),
        }),
      ]),
    );
    expect(store.records[0]?.result?.message).not.toContain("unregistered continuation check");
  });

  it("finds runtime build-info from the service entrypoint directory when cwd differs", async () => {
    const runtimeDir = path.join(tempRoot, "runtime", "dist");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, "build-info.json"),
      JSON.stringify({ commit: "abc", version: "2026.6.2", builtAt: "now" }),
    );
    const previousArgv = process.argv[1];
    const previousCwd = process.cwd();
    process.argv[1] = path.join(runtimeDir, "index.js");
    process.chdir(tempRoot);
    try {
      const check = await testing.runDefaultCheck(
        await testing.createContinuationRecord({
          id: "runtime-identity",
          now: 100,
          route: { sessionKey: "main" },
          objective: "post restart validation",
          expectedRuntime: { commit: "abc", version: "2026.6.2", builtAt: "now" },
          requiredChecks: ["runtime_identity"],
        }),
        "runtime_identity",
      );
      expect(check.status).toBe("pass");
      expect(check.detail).toContain(path.join(runtimeDir, "build-info.json"));
    } finally {
      process.argv[1] = previousArgv;
      process.chdir(previousCwd);
    }
  });

  it("includes searched build-info paths when runtime identity cannot be found", async () => {
    const previousArgv = process.argv[1];
    const previousCwd = process.cwd();
    process.argv[1] = path.join(tempRoot, "missing-runtime", "index.js");
    process.chdir(tempRoot);
    try {
      const check = await testing.runDefaultCheck(
        await testing.createContinuationRecord({
          id: "runtime-identity-missing",
          now: 100,
          route: { sessionKey: "main" },
          objective: "post restart validation",
          expectedRuntime: { commit: "abc" },
          requiredChecks: ["runtime_identity"],
        }),
        "runtime_identity",
      );
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("searched=");
      expect(check.detail).toContain(path.join(tempRoot, "dist", "build-info.json"));
      expect(check.detail).toContain(path.join(tempRoot, "missing-runtime", "build-info.json"));
    } finally {
      process.argv[1] = previousArgv;
      process.chdir(previousCwd);
    }
  });

  it("keeps visible delivery proof and message in agreement", async () => {
    await persistActivationContinuationBeforeRestart(
      {
        id: "activation-delivery-proof",
        now: 100,
        route: { sessionKey: "main" },
        objective: "post restart validation",
        requiredChecks: ["http_health"],
      },
      { stateDir },
    );

    await recoverPendingActivationContinuations({
      stateDir,
      exportsDir,
      now: () => 200,
      check: async (_record, check) => passCheck(check),
      deliver: () => {},
    });

    const store = await testing.readStore(stateDir);
    expect(store.records[0]?.result?.proof?.visibleDeliveryCompleted).toBe(true);
    expect(store.records[0]?.result?.proof?.deliveryStatus).toBe("queued");
    expect(store.records[0]?.result?.message).toContain("visibleSourceDeliveryCompleted: yes");
    expect(store.records[0]?.result?.message).toContain("deliveryStatus: queued");
  });
});
