import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistActivationContinuationBeforeRestart,
  recoverPendingActivationContinuations,
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

describe("activation restart continuations", () => {
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
