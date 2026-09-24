import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  createLaneReadinessCheckHandle,
  isLaneReadinessReportCurrent,
  LANE_READINESS_LANES,
  runLaneReadinessHarness,
  type LaneReadinessCheck,
  type LaneReadinessCheckHandle,
  type LaneReadinessLane,
} from "./lane-readiness-harness.js";

const checkedAt = "2026-09-23T18:30:00.000Z";
const recurrenceMs = 60 * 60 * 1000;
const sourceRevision = "78d5a80174";

type TestExecution = (params: { lane: LaneReadinessLane; check: LaneReadinessCheck }) => unknown;

function handlesFor(
  execute: TestExecution,
  runLabel: string,
  include: (lane: LaneReadinessLane, check: LaneReadinessCheck) => boolean = () => true,
  identity: { sourceRevision?: string; executedAt?: string } = {},
): LaneReadinessCheckHandle[] {
  return LANE_READINESS_LANES.flatMap((lane) =>
    lane.checks
      .filter((check) => include(lane, check))
      .map((check) => {
        const supervisor = createLaneReadinessCheckHandle(lane.id, check.id);
        // Check work and envelope serialization stay outside the evaluator and can run in an owner process.
        void Promise.resolve()
          .then(() => execute({ lane, check }))
          .then(
            (result) =>
              supervisor.resolve(
                JSON.stringify({
                  runLabel,
                  sourceRevision: identity.sourceRevision ?? sourceRevision,
                  executedAt: identity.executedAt ?? checkedAt,
                  ...(result && typeof result === "object" ? result : {}),
                }),
              ),
            (reason: unknown) => {
              const detail =
                reason instanceof Error
                  ? reason.message
                  : typeof reason === "string"
                    ? reason
                    : `${lane.label}/${check.id} threw without a usable error detail`;
              supervisor.reject(
                JSON.stringify({
                  runLabel,
                  sourceRevision: identity.sourceRevision ?? sourceRevision,
                  executedAt: identity.executedAt ?? checkedAt,
                  status: "FAIL",
                  detail:
                    detail.length <= 4_096
                      ? detail
                      : `${lane.label}/${check.id} threw without a usable error detail`,
                }),
              );
            },
          );
        return supervisor.handle;
      }),
  );
}

function passingExecution({ lane, check }: { lane: LaneReadinessLane; check: LaneReadinessCheck }) {
  return { status: "PASS", proofPaths: [`proof/${lane.id}/${check.id}.json`] };
}

describe("lane readiness harness", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T18:40:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the controlling P0 and P1 lane inventory executable", () => {
    expect(
      LANE_READINESS_LANES.filter((lane) => lane.priority === "P0").map((lane) => lane.label),
    ).toEqual([
      "Will/controller",
      "Cleanup Crew",
      "Grant",
      "ACP/ACPX",
      "Gateway/runtime",
      "Watchdog",
      "TaskFlow/session continuity",
      "Source/report delivery",
    ]);
    expect(
      LANE_READINESS_LANES.filter((lane) => lane.priority === "P1").map((lane) => lane.label),
    ).toEqual(["SADB", "Engineering Delivery", "File Hub/export", "Memory/knowledge"]);
    expect(LANE_READINESS_LANES.every((lane) => lane.checks.length > 0)).toBe(true);
  });

  it("returns a current PASS report only when every supervised check has proof", async () => {
    const execute = vi.fn(passingExecution);
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-pass",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: handlesFor(execute, "phase8-pass"),
    });

    expect(report).toMatchObject({
      schema: "openclaw.lane_readiness_report.v1",
      status: "PASS",
      nextRunDueAt: "2026-09-23T19:30:00.000Z",
      summary: {
        laneCount: 12,
        passedLaneCount: 12,
        failedLaneCount: 0,
        p0FailedLaneCount: 0,
        p1FailedLaneCount: 0,
        integrityFailureCount: 0,
      },
      integrityFailures: [],
      cancellationRequests: [],
    });
    expect(execute).toHaveBeenCalledTimes(
      LANE_READINESS_LANES.reduce((total, lane) => total + lane.checks.length, 0),
    );
    expect(isLaneReadinessReportCurrent(report, "2026-09-23T19:29:59.999Z")).toBe(true);
    expect(isLaneReadinessReportCurrent(report, "2026-09-23T19:30:00.001Z")).toBe(false);
  });

  it("rejects proof paths that change before the report stores them", async () => {
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-proof-identity",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: handlesFor(
        ({ lane, check }) =>
          lane.id === "will_controller" && check.id === "intake_classification"
            ? { status: "PASS", proofPaths: ["proof/intake.json "] }
            : passingExecution({ lane, check }),
        "phase8-proof-identity",
      ),
    });
    expect(
      report.lanes[0]?.checks.find((check) => check.checkId === "intake_classification"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "invalid_check_result" } });
  });

  it("turns missing proof, rejected checks, and missing handles into exact blockers", async () => {
    const handles = handlesFor(
      ({ lane, check }) => {
        if (lane.id === "will_controller" && check.id === "closeout_truth") {
          return { status: "PASS" };
        }
        if (lane.id === "watchdog" && check.id === "cron_freshness") {
          throw new Error("scheduled watchdog receipt is stale");
        }
        if (lane.id === "file_hub_export" && check.id === "download_readback") {
          return {
            status: "FAIL",
            proofPaths: ["proof/file-hub/listing.json"],
            detail: "download readback has not run",
          };
        }
        return passingExecution({ lane, check });
      },
      "phase8-fail",
      (lane, check) => !(lane.id === "memory_knowledge" && check.id === "resource_sample"),
    );
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-fail",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles,
    });

    const failed = report.lanes
      .flatMap((lane) => lane.checks.map((check) => ({ ...check, owner: lane.currentOwner })))
      .filter((check) => check.status === "FAIL");
    expect(report.summary).toMatchObject({ failedLaneCount: 4, p0FailedLaneCount: 2 });
    expect(failed.map((check) => [check.checkId, check.blocker?.code])).toEqual([
      ["closeout_truth", "missing_proof_path"],
      ["cron_freshness", "check_threw"],
      ["download_readback", "check_failed"],
      ["resource_sample", "missing_check_result"],
    ]);
    expect(failed.find((check) => check.checkId === "cron_freshness")?.blocker?.detail).toBe(
      "scheduled watchdog receipt is stale",
    );
  });

  it("keeps the catalog immutable and refuses malformed execution envelopes", async () => {
    expect(() => {
      (LANE_READINESS_LANES[0] as { checks: readonly LaneReadinessCheck[] }).checks = [];
    }).toThrow();
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-accessor",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: handlesFor(({ lane, check }) => {
        if (lane.id === "grant" && check.id === "audit_receipt") {
          return { status: "FAIL", proofPaths: [] };
        }
        return passingExecution({ lane, check });
      }, "phase8-accessor"),
    });

    expect(
      report.lanes
        .find((lane) => lane.laneId === "grant")
        ?.checks.find((check) => check.checkId === "audit_receipt"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "invalid_check_result" } });
  });

  it("bounds unresolved completions and requests isolated owner cancellation", async () => {
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-timeout",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      checkTimeoutMs: 5,
      runTimeoutMs: 100,
      handles: handlesFor(({ lane, check }) => {
        if (lane.id === "acp_acpx" && check.id === "response") {
          return new Promise(() => {
            // The external supervisor owns this intentionally unresolved work.
          });
        }
        return passingExecution({ lane, check });
      }, "phase8-timeout"),
    });

    expect(report.cancellationRequests).toContainEqual({
      laneId: "acp_acpx",
      checkId: "response",
      reason: "check_timed_out",
    });
    expect(
      report.lanes
        .find((lane) => lane.laneId === "acp_acpx")
        ?.checks.find((check) => check.checkId === "response"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "check_timed_out" } });
  });

  it("reports whole-run expiry separately from a per-check timeout", async () => {
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-run-timeout",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      checkTimeoutMs: 100,
      runTimeoutMs: 5,
      handles: handlesFor(
        ({ lane, check }) =>
          lane.id === "acp_acpx" && check.id === "response"
            ? new Promise(() => {
                // The external supervisor owns this intentionally unresolved work.
              })
            : passingExecution({ lane, check }),
        "phase8-run-timeout",
      ),
    });

    expect(
      report.lanes
        .find((lane) => lane.laneId === "acp_acpx")
        ?.checks.find((check) => check.checkId === "response"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "run_timed_out" } });
    expect(report.cancellationRequests).toContainEqual({
      laneId: "acp_acpx",
      checkId: "response",
      reason: "run_timed_out",
    });
  });

  it("bounds unresolved completions by the recurrence deadline", async () => {
    vi.restoreAllMocks();
    const runLabel = "phase8-recurrence-timeout";
    const dynamicCheckedAt = new Date().toISOString();
    const report = await runLaneReadinessHarness({
      runLabel,
      sourceRevision,
      checkedAt: dynamicCheckedAt,
      recurrenceMs: 5,
      checkTimeoutMs: 100,
      runTimeoutMs: 100,
      handles: handlesFor(
        ({ lane, check }) =>
          lane.id === "acp_acpx" && check.id === "response"
            ? new Promise(() => {
                // The recurrence deadline must cancel this supervised owner work first.
              })
            : passingExecution({ lane, check }),
        runLabel,
        undefined,
        { executedAt: dynamicCheckedAt },
      ),
    });

    expect(
      report.lanes
        .find((lane) => lane.laneId === "acp_acpx")
        ?.checks.find((check) => check.checkId === "response"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "recurrence_timed_out" } });
    expect(report.cancellationRequests).toContainEqual({
      laneId: "acp_acpx",
      checkId: "response",
      reason: "recurrence_timed_out",
    });
  });

  it("rejects a late settlement even when it beats the delayed timer callback", async () => {
    vi.restoreAllMocks();
    const runLabel = "phase8-delayed-event-loop";
    const dynamicCheckedAt = new Date().toISOString();
    const supervisor = createLaneReadinessCheckHandle("acp_acpx", "response");
    const reportPromise = runLaneReadinessHarness({
      runLabel,
      sourceRevision,
      checkedAt: dynamicCheckedAt,
      recurrenceMs,
      checkTimeoutMs: 5,
      runTimeoutMs: 100,
      handles: [
        ...handlesFor(
          passingExecution,
          runLabel,
          (lane, check) => !(lane.id === "acp_acpx" && check.id === "response"),
          { executedAt: dynamicCheckedAt },
        ),
        supervisor.handle,
      ],
    });
    const blockedUntil = Date.now() + 10;
    while (Date.now() < blockedUntil) {
      // Intentionally hold the evaluator event loop past the check deadline.
    }
    supervisor.resolve(
      JSON.stringify({
        runLabel,
        sourceRevision,
        executedAt: dynamicCheckedAt,
        status: "PASS",
        proofPaths: ["proof/acp_acpx/response.json"],
      }),
    );
    const report = await reportPromise;

    expect(
      report.lanes
        .find((lane) => lane.laneId === "acp_acpx")
        ?.checks.find((check) => check.checkId === "response"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "check_timed_out" } });
    expect(report.cancellationRequests).toContainEqual({
      laneId: "acp_acpx",
      checkId: "response",
      reason: "check_timed_out",
    });
  });

  it("rejects timely settlement evaluated after the absolute deadline", async () => {
    vi.restoreAllMocks();
    const runLabel = "phase8-late-evaluation";
    const dynamicCheckedAt = new Date().toISOString();
    const supervisor = createLaneReadinessCheckHandle("acp_acpx", "response");
    supervisor.resolve(
      JSON.stringify({
        runLabel,
        sourceRevision,
        executedAt: dynamicCheckedAt,
        status: "PASS",
        proofPaths: ["proof/acp_acpx/response.json"],
      }),
    );
    const reportPromise = runLaneReadinessHarness({
      runLabel,
      sourceRevision,
      checkedAt: dynamicCheckedAt,
      recurrenceMs,
      checkTimeoutMs: 5,
      runTimeoutMs: 100,
      handles: [
        ...handlesFor(
          passingExecution,
          runLabel,
          (lane, check) => !(lane.id === "acp_acpx" && check.id === "response"),
          { executedAt: dynamicCheckedAt },
        ),
        supervisor.handle,
      ],
    });
    const blockedUntil = Date.now() + 10;
    while (Date.now() < blockedUntil) {
      // Delay evaluation until after the already-settled check's deadline.
    }
    const report = await reportPromise;

    expect(
      report.lanes
        .find((lane) => lane.laneId === "acp_acpx")
        ?.checks.find((check) => check.checkId === "response"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "check_timed_out" } });
  });

  it("redacts returned and thrown failure details even when general logging can be off", async () => {
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-redaction",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: handlesFor(({ lane, check }) => {
        if (lane.id === "will_controller" && check.id === "active_worker_proof") {
          return {
            status: "PASS",
            proofPaths: ["https://artifacts.test/proof.json?access_key=readinesssecret1234567890"],
          };
        }
        if (lane.id === "will_controller" && check.id === "closeout_truth") {
          return {
            status: "PASS",
            proofPaths: [
              "https://redirect.test/#https%253A%252F%252Fartifact.test%252Fp%253Ftoken%253Dreadinesssecret1234567890",
            ],
          };
        }
        if (lane.id === "will_controller" && check.id === "final_source_delivery") {
          return {
            status: "PASS",
            proofPaths: [
              "https://redirect.test/#https://artifact.test/?credential=readinesssecret1234567890",
            ],
          };
        }
        if (lane.id === "source_report_delivery" && check.id === "final_delivered") {
          return {
            status: "PASS",
            proofPaths: ["https://oauth.example/callback?code=readinesssecret1234567890"],
          };
        }
        if (lane.id === "source_report_delivery" && check.id === "no_duplicate") {
          return {
            status: "PASS",
            proofPaths: ["https://alice:readinesssecret1234567890@bad host/proof"],
          };
        }
        if (lane.id === "watchdog" && check.id === "fixture_matrix") {
          throw new Error("OPENAI_API_KEY=sk-readinesssecret1234567890");
        }
        if (lane.id === "file_hub_export" && check.id === "download_readback") {
          return {
            status: "FAIL",
            detail: "Authorization: Bearer readinesssecret1234567890",
          };
        }
        return passingExecution({ lane, check });
      }, "phase8-redaction"),
    });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("readinesssecret1234567890");
    expect(serialized).toContain("…");
    expect(
      report.lanes
        .find((lane) => lane.laneId === "will_controller")
        ?.checks.find((check) => check.checkId === "active_worker_proof"),
    ).toMatchObject({ status: "FAIL", proofPaths: [], blocker: { code: "unsafe_proof_path" } });
    expect(
      report.lanes
        .find((lane) => lane.laneId === "will_controller")
        ?.checks.find((check) => check.checkId === "closeout_truth"),
    ).toMatchObject({ status: "FAIL", proofPaths: [], blocker: { code: "unsafe_proof_path" } });
    expect(
      report.lanes
        .find((lane) => lane.laneId === "will_controller")
        ?.checks.find((check) => check.checkId === "final_source_delivery"),
    ).toMatchObject({ status: "FAIL", proofPaths: [], blocker: { code: "unsafe_proof_path" } });
    expect(
      report.lanes
        .find((lane) => lane.laneId === "source_report_delivery")
        ?.checks.find((check) => check.checkId === "final_delivered"),
    ).toMatchObject({ status: "FAIL", proofPaths: [], blocker: { code: "unsafe_proof_path" } });
    expect(
      report.lanes
        .find((lane) => lane.laneId === "source_report_delivery")
        ?.checks.find((check) => check.checkId === "no_duplicate"),
    ).toMatchObject({ status: "FAIL", proofPaths: [], blocker: { code: "unsafe_proof_path" } });
  });

  it("applies configured redaction patterns to details and proof paths", async () => {
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lane-readiness-"));
    const configPath = path.join(configDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ logging: { redactPatterns: ["organization-secret-[A-Za-z0-9]+"] } }),
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    try {
      const report = await runLaneReadinessHarness({
        runLabel: "phase8-custom-redaction",
        sourceRevision,
        checkedAt,
        recurrenceMs,
        handles: handlesFor(({ lane, check }) => {
          if (lane.id === "will_controller" && check.id === "active_worker_proof") {
            return {
              status: "PASS",
              proofPaths: ["proof/organization-secret-readiness123456.json"],
            };
          }
          if (lane.id === "watchdog" && check.id === "fixture_matrix") {
            return { status: "FAIL", detail: "organization-secret-readiness123456" };
          }
          return passingExecution({ lane, check });
        }, "phase8-custom-redaction"),
      });
      const serialized = JSON.stringify(report);

      expect(serialized).not.toContain("organization-secret-readiness123456");
      expect(
        report.lanes
          .find((lane) => lane.laneId === "will_controller")
          ?.checks.find((check) => check.checkId === "active_worker_proof"),
      ).toMatchObject({ status: "FAIL", blocker: { code: "unsafe_proof_path" } });
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      fs.rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("fails visibly for malformed or unexpected supervised handles", async () => {
    const credentialShapedId = `ghp_${"a".repeat(24)}`;
    expect(() =>
      createLaneReadinessCheckHandle("Authorization_Bearer_secret", "stale_check"),
    ).toThrow("bounded snake-case");
    expect(() => createLaneReadinessCheckHandle(credentialShapedId, "stale_check")).toThrow(
      "bounded snake-case",
    );
    const unexpected = [
      createLaneReadinessCheckHandle("z_lane", "stale_check"),
      createLaneReadinessCheckHandle("a_lane", "stale_check"),
    ];
    for (const supervisor of unexpected) {
      supervisor.resolve(
        JSON.stringify({
          runLabel: "phase8-handle-integrity",
          sourceRevision,
          executedAt: checkedAt,
          status: "PASS",
          proofPaths: ["proof/unexpected.json"],
        }),
      );
    }
    let accessorReads = 0;
    const fabricated = Object.defineProperty({}, "abortController", {
      get: () => {
        accessorReads += 1;
        return new AbortController();
      },
    }) as LaneReadinessCheckHandle;
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-handle-integrity",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: [
        ...handlesFor(passingExecution, "phase8-handle-integrity"),
        ...unexpected.map((supervisor) => supervisor.handle),
        fabricated,
      ],
    });

    expect(report.status).toBe("FAIL");
    expect(report.summary.integrityFailureCount).toBe(3);
    expect(report.integrityFailures).toEqual([
      expect.objectContaining({ code: "invalid_handle", count: 1 }),
      expect.objectContaining({ code: "unexpected_handle", count: 2 }),
    ]);
    expect(report.cancellationRequests).toEqual([
      { laneId: "a_lane", checkId: "stale_check", reason: "unexpected_handle" },
      { laneId: "z_lane", checkId: "stale_check", reason: "unexpected_handle" },
    ]);
    expect(accessorReads).toBe(0);
  });

  it("rejects execution envelopes from another run, source, or recurrence window", async () => {
    const staleIdentities = [
      { runLabel: "phase8-stale-run" },
      { runLabel: "phase8-fresh-run", sourceRevision: "stale-source" },
      { runLabel: "phase8-fresh-run", executedAt: "2026-09-23T19:00:00.000Z" },
    ];
    for (const identity of staleIdentities) {
      const report = await runLaneReadinessHarness({
        runLabel: "phase8-fresh-run",
        sourceRevision,
        checkedAt,
        recurrenceMs,
        handles: handlesFor(passingExecution, identity.runLabel, undefined, identity),
      });

      expect(report.status).toBe("FAIL");
      expect(
        report.lanes.every((lane) =>
          lane.checks.every((check) => check.blocker?.code === "invalid_check_result"),
        ),
      ).toBe(true);
    }
  });

  it("rejects stale identity on owner failure settlements", async () => {
    const supervisor = createLaneReadinessCheckHandle("grant", "audit_receipt");
    supervisor.reject(
      JSON.stringify({
        runLabel: "phase8-stale-rejection",
        sourceRevision,
        executedAt: checkedAt,
        status: "FAIL",
        detail: "stale owner failure",
      }),
    );
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-current-rejection",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: [
        ...handlesFor(
          passingExecution,
          "phase8-current-rejection",
          (lane, check) => !(lane.id === "grant" && check.id === "audit_receipt"),
        ),
        supervisor.handle,
      ],
    });

    expect(
      report.lanes
        .find((lane) => lane.laneId === "grant")
        ?.checks.find((check) => check.checkId === "audit_receipt"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "invalid_check_result" } });
  });

  it("fails immediately when evaluation starts after the recurrence deadline", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-23T20:00:00.000Z"));
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-expired-run",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: handlesFor(passingExecution, "phase8-expired-run"),
    });

    expect(report.status).toBe("FAIL");
    expect(
      report.lanes.every((lane) =>
        lane.checks.every((check) => check.blocker?.code === "recurrence_timed_out"),
      ),
    ).toBe(true);
  });

  it("keeps a completed owner failure exact when the report expires before evaluation", async () => {
    const runLabel = "phase8-expired-owner-failure";
    const supervisor = createLaneReadinessCheckHandle("grant", "audit_receipt");
    supervisor.resolve(
      JSON.stringify({
        runLabel,
        sourceRevision,
        executedAt: checkedAt,
        status: "FAIL",
        detail: "audit receipt is missing",
      }),
    );
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-23T20:00:00.000Z"));

    const report = await runLaneReadinessHarness({
      runLabel,
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: [supervisor.handle],
    });

    expect(report.status).toBe("FAIL");
    expect(isLaneReadinessReportCurrent(report, "2026-09-23T20:00:00.000Z")).toBe(false);
    expect(
      report.lanes
        .find((lane) => lane.laneId === "grant")
        ?.checks.find((check) => check.checkId === "audit_receipt"),
    ).toMatchObject({
      status: "FAIL",
      blocker: { code: "check_failed", detail: "audit receipt is missing" },
    });
  });

  it("keeps hostile rejection values visible with stable fallback detail", async () => {
    let messageReads = 0;
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-hostile-throw",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: handlesFor(({ lane, check }) => {
        if (lane.id === "watchdog" && check.id === "fixture_matrix") {
          // oxlint-disable-next-line typescript/only-throw-error -- Regression proves unknown rejection payloads are never inspected.
          throw Object.defineProperty({}, "message", {
            get: () => {
              messageReads += 1;
              return "must not run";
            },
          });
        }
        if (lane.id === "grant" && check.id === "valid_proof_review") {
          throw new Error("x".repeat(4_097));
        }
        return passingExecution({ lane, check });
      }, "phase8-hostile-throw"),
    });

    expect(
      report.lanes
        .find((lane) => lane.laneId === "watchdog")
        ?.checks.find((check) => check.checkId === "fixture_matrix"),
    ).toMatchObject({
      status: "FAIL",
      blocker: {
        code: "check_threw",
        detail: "Watchdog/fixture_matrix threw without a usable error detail",
      },
    });
    expect(messageReads).toBe(0);
    expect(
      report.lanes
        .find((lane) => lane.laneId === "grant")
        ?.checks.find((check) => check.checkId === "valid_proof_review"),
    ).toMatchObject({
      status: "FAIL",
      blocker: {
        code: "check_threw",
        detail: "Grant/valid_proof_review threw without a usable error detail",
      },
    });
  });

  it("rejects oversized structured results before proof normalization", async () => {
    const handles = handlesFor(
      ({ lane, check }) =>
        lane.id === "grant" && check.id === "audit_receipt"
          ? {
              status: "PASS",
              proofPaths: Array.from({ length: 33 }, (_, index) => `proof/${index}.json`),
            }
          : passingExecution({ lane, check }),
      "phase8-bounded-result",
    );

    const report = await runLaneReadinessHarness({
      runLabel: "phase8-bounded-result",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles,
    });

    expect(
      report.lanes
        .find((lane) => lane.laneId === "grant")
        ?.checks.find((check) => check.checkId === "audit_receipt"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "invalid_check_result" } });
  });

  it("bounds execution payloads before native promise settlement", async () => {
    const supervisor = createLaneReadinessCheckHandle("grant", "audit_receipt");
    const oversized = createLaneReadinessCheckHandle("grant", "missing_proof_reject");
    let thenReads = 0;
    // oxlint-disable-next-line unicorn/no-thenable -- Regression proves boundary validation runs before native Promise assimilation.
    const thenable = Object.defineProperty({}, "then", {
      get: () => {
        thenReads += 1;
        return () => {};
      },
    });
    (supervisor.resolve as (value: unknown) => void)(thenable);
    oversized.resolve("x".repeat(64 * 1024 + 1));
    const report = await runLaneReadinessHarness({
      runLabel: "phase8-bounded-settlement",
      sourceRevision,
      checkedAt,
      recurrenceMs,
      handles: [
        ...handlesFor(
          passingExecution,
          "phase8-bounded-settlement",
          (lane, check) =>
            !(
              lane.id === "grant" &&
              (check.id === "audit_receipt" || check.id === "missing_proof_reject")
            ),
        ),
        supervisor.handle,
        oversized.handle,
      ],
    });

    expect(thenReads).toBe(0);
    expect(
      report.lanes
        .find((lane) => lane.laneId === "grant")
        ?.checks.find((check) => check.checkId === "audit_receipt"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "invalid_check_result" } });
    expect(
      report.lanes
        .find((lane) => lane.laneId === "grant")
        ?.checks.find((check) => check.checkId === "missing_proof_reject"),
    ).toMatchObject({ status: "FAIL", blocker: { code: "invalid_check_result" } });
  });

  it("rejects invalid recurrence identity instead of emitting ambiguous reports", async () => {
    const base = { handles: [] as LaneReadinessCheckHandle[], recurrenceMs };
    await expect(
      runLaneReadinessHarness({
        ...base,
        runLabel: " ",
        sourceRevision: "78d5a80174",
        checkedAt,
      }),
    ).rejects.toThrow("runLabel must be a bounded safe identifier");
    await expect(
      runLaneReadinessHarness({
        ...base,
        runLabel: `ghp_${"a".repeat(24)}`,
        sourceRevision: "78d5a80174",
        checkedAt,
      }),
    ).rejects.toThrow("runLabel must be a bounded safe identifier");
    await expect(
      runLaneReadinessHarness({
        ...base,
        runLabel: "Authorization: Bearer readinesssecret1234567890",
        sourceRevision: "78d5a80174",
        checkedAt,
      }),
    ).rejects.toThrow("runLabel must be a bounded safe identifier");
    await expect(
      runLaneReadinessHarness({
        ...base,
        runLabel: "phase8",
        sourceRevision: "not-a-revision",
        checkedAt,
      }),
    ).rejects.toThrow("sourceRevision must be a hexadecimal revision");
    await expect(
      runLaneReadinessHarness({
        ...base,
        runLabel: "phase8",
        sourceRevision: "78d5a80174",
        checkedAt: "2026-09-23T18:30:00",
      }),
    ).rejects.toThrow("checkedAt must be an explicit UTC timestamp");
    await expect(
      runLaneReadinessHarness({
        ...base,
        runLabel: "phase8",
        sourceRevision: "78d5a80174",
        checkedAt,
        recurrenceMs: 0,
      }),
    ).rejects.toThrow("recurrenceMs must be a positive safe integer");
    await expect(
      runLaneReadinessHarness({
        ...base,
        runLabel: "phase8",
        sourceRevision,
        checkedAt,
        checkTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      }),
    ).rejects.toThrow("checkTimeoutMs must be a timer-safe positive integer");
    await expect(
      runLaneReadinessHarness({
        ...base,
        runLabel: "phase8",
        sourceRevision,
        checkedAt,
        runTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      }),
    ).rejects.toThrow("runTimeoutMs must be a timer-safe positive integer");
  });
});

it("runs owner checks before accepting current proof and reports runner failure", async () => {
  const repoRoot = process.cwd();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lane-runner-"));
  try {
    const scriptsRoot = path.join(fixtureRoot, "scripts");
    const distRoot = path.join(fixtureRoot, "dist");
    const proofRoot = path.join(fixtureRoot, "proof");
    fs.mkdirSync(scriptsRoot);
    fs.mkdirSync(distRoot);
    fs.mkdirSync(proofRoot);
    fs.writeFileSync(path.join(fixtureRoot, "package.json"), '{"type":"module"}');
    const scriptPath = path.join(scriptsRoot, "lane-readiness-harness.mjs");
    fs.copyFileSync(path.join(repoRoot, "scripts/lane-readiness-harness.mjs"), scriptPath);
    const sourceUrl = pathToFileURL(path.join(repoRoot, "src/lane-readiness.ts")).href;
    fs.writeFileSync(
      path.join(distRoot, "lane-readiness.js"),
      `export * from ${JSON.stringify(sourceUrl)};\n`,
    );
    const inputPath = path.join(fixtureRoot, "input.json");
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        runLabel: "phase8-owner-runner",
        sourceRevision,
        checkedAt: new Date(Date.now() - 1_000).toISOString(),
        recurrenceMs: 60_000,
        checkTimeoutMs: 10_000,
        runTimeoutMs: 30_000,
      }),
    );
    const passingRunnerPath = path.join(fixtureRoot, "passing-runner.mjs");
    fs.writeFileSync(
      passingRunnerPath,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'let text = "";',
        "for await (const chunk of process.stdin) text += chunk;",
        "const input = JSON.parse(text);",
        'const proofPath = process.env.OPENCLAW_LANE_TEST_URL === "1"',
        "  ? `https://example.test/${input.laneId}/${input.checkId}.json`",
        '  : path.join("proof", input.laneId, `${input.checkId}.json`);',
        "fs.mkdirSync(path.dirname(proofPath), { recursive: true });",
        "fs.writeFileSync(proofPath, JSON.stringify({ laneId: input.laneId, checkId: input.checkId }));",
        'if (process.env.OPENCLAW_LANE_TEST_FUTURE === "1") {',
        "  const future = new Date(Date.now() + 60_000);",
        "  fs.utimesSync(proofPath, future, future);",
        "}",
        "process.stdout.write(JSON.stringify({ ...input, executedAt: new Date().toISOString(),",
        '  status: "PASS", proofPaths: process.env.OPENCLAW_LANE_TEST_TOO_MANY === "1"',
        "    ? Array(33).fill(proofPath) : [proofPath] }));",
      ].join("\n"),
    );
    const futureRunnerPath = path.join(fixtureRoot, "future-runner.mjs");
    fs.writeFileSync(
      futureRunnerPath,
      [
        'process.env.OPENCLAW_LANE_TEST_FUTURE = "1";',
        'await import("./passing-runner.mjs");',
      ].join("\n"),
    );
    const urlRunnerPath = path.join(fixtureRoot, "url-runner.mjs");
    fs.writeFileSync(
      urlRunnerPath,
      ['process.env.OPENCLAW_LANE_TEST_URL = "1";', 'await import("./passing-runner.mjs");'].join(
        "\n",
      ),
    );
    const tooManyRunnerPath = path.join(fixtureRoot, "too-many-runner.mjs");
    fs.writeFileSync(
      tooManyRunnerPath,
      [
        'process.env.OPENCLAW_LANE_TEST_TOO_MANY = "1";',
        'await import("./passing-runner.mjs");',
      ].join("\n"),
    );
    const signalRunnerPath = path.join(fixtureRoot, "signal-runner.mjs");
    fs.writeFileSync(signalRunnerPath, 'process.kill(process.pid, "SIGTERM");\n');
    const failedRunnerPath = path.join(fixtureRoot, "failed-runner.mjs");
    fs.writeFileSync(failedRunnerPath, "process.exit(7);\n");
    const timedOutRunnerPath = path.join(fixtureRoot, "timed-out-runner.mjs");
    fs.writeFileSync(
      timedOutRunnerPath,
      'import fs from "node:fs"; fs.writeFileSync("started", "yes"); setInterval(() => {}, 1_000);\n',
    );
    const childRunnerPath = path.join(fixtureRoot, "child-runner.mjs");
    fs.writeFileSync(
      childRunnerPath,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        'const child = spawn(process.execPath, ["-e",',
        "  \"setTimeout(() => require('node:fs').writeFileSync('late-child-proof', 'late'), 700)\"",
        '], { stdio: "ignore" });',
        'fs.writeFileSync("spawned-child", String(child.pid));',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );
    const slowPassingRunnerPath = path.join(fixtureRoot, "slow-passing-runner.mjs");
    fs.writeFileSync(
      slowPassingRunnerPath,
      'await new Promise((resolve) => setTimeout(resolve, 25)); await import("./passing-runner.mjs");\n',
    );
    const invoke = (runnerPath: string) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          scriptPath,
          "--input",
          inputPath,
          "--runner",
          runnerPath,
          "--proof-root",
          proofRoot,
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 40_000 },
      );

    const passing = invoke(passingRunnerPath);
    expect(passing.status).toBe(0);
    expect(JSON.parse(passing.stdout)).toMatchObject({ status: "PASS" });

    const future = invoke(futureRunnerPath);
    expect(future.status).toBe(1);
    expect(JSON.parse(future.stdout).lanes[0].checks[0]).toMatchObject({
      status: "FAIL",
      blocker: {
        code: "check_failed",
        detail: "owner check did not produce a current local proof file",
      },
    });

    const url = invoke(urlRunnerPath);
    expect(url.status).toBe(1);
    expect(JSON.parse(url.stdout).lanes[0].checks[0]).toMatchObject({
      status: "FAIL",
      blocker: {
        code: "check_failed",
        detail: "owner check did not produce a current local proof file",
      },
    });

    const tooMany = invoke(tooManyRunnerPath);
    expect(tooMany.status).toBe(1);
    expect(JSON.parse(tooMany.stdout).lanes[0].checks[0]).toMatchObject({
      status: "FAIL",
      blocker: {
        code: "check_failed",
        detail: "owner check returned invalid proof file references",
      },
    });

    const signaled = invoke(signalRunnerPath);
    expect(signaled.status).toBe(1);
    expect(JSON.parse(signaled.stdout).lanes[0].checks[0]).toMatchObject({
      status: "FAIL",
      blocker: { code: "check_failed", detail: "owner check terminated by SIGTERM" },
    });

    const failed = invoke(failedRunnerPath);
    expect(failed.status).toBe(1);
    const failedReport = JSON.parse(failed.stdout);
    expect(failedReport.status).toBe("FAIL");
    expect(failedReport.lanes[0].checks[0]).toMatchObject({
      status: "FAIL",
      blocker: { code: "check_failed", detail: "owner check exited with status 7" },
    });
    const unavailable = invoke(path.join(fixtureRoot, "missing-runner.mjs"));
    expect(unavailable.status).toBe(1);
    expect(JSON.parse(unavailable.stdout).lanes[0].checks[0]).toMatchObject({
      status: "FAIL",
      blocker: { code: "check_failed", detail: "owner runner or proof root is unavailable" },
    });
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        runLabel: "phase8-owner-runner",
        sourceRevision,
        checkedAt: new Date(Date.now() - 1_000).toISOString(),
        recurrenceMs: 60_000,
        checkTimeoutMs: 100,
        runTimeoutMs: 500,
      }),
    );
    const timedOut = invoke(timedOutRunnerPath);
    expect(timedOut.status).toBe(1);
    expect(JSON.parse(timedOut.stdout).lanes[0].checks[0]).toMatchObject({
      status: "FAIL",
      blocker: { code: "check_timed_out", detail: "owner check timed out after 100 ms" },
    });
    fs.rmSync(path.join(proofRoot, "started"));
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        runLabel: "phase8-owner-runner",
        sourceRevision,
        checkedAt: new Date().toISOString(),
        recurrenceMs: 2_000,
        checkTimeoutMs: 1_000,
        runTimeoutMs: 5_000,
      }),
    );
    const expired = invoke(timedOutRunnerPath);
    expect(fs.existsSync(path.join(proofRoot, "started"))).toBe(true);
    expect(expired.status).toBe(1);
    expect(JSON.parse(expired.stdout).lanes[0].checks[0]).toMatchObject({
      status: "FAIL",
      blocker: { code: "recurrence_timed_out" },
    });
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        runLabel: "phase8-owner-runner",
        sourceRevision,
        checkedAt: new Date().toISOString(),
        recurrenceMs: 60_000,
        checkTimeoutMs: 200,
        runTimeoutMs: 500,
      }),
    );
    const childTimedOut = invoke(childRunnerPath);
    expect(fs.existsSync(path.join(proofRoot, "spawned-child"))).toBe(true);
    expect(childTimedOut.status).toBe(1);
    expect(JSON.parse(childTimedOut.stdout).lanes[0].checks[0]).toMatchObject({
      status: "FAIL",
      blocker: { code: "check_timed_out" },
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 800);
    });
    expect(fs.existsSync(path.join(proofRoot, "late-child-proof"))).toBe(false);
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        runLabel: "phase8-owner-runner",
        sourceRevision,
        checkedAt: new Date().toISOString(),
        recurrenceMs: 60_000,
        checkTimeoutMs: 1_000,
        runTimeoutMs: 20_000,
      }),
    );
    const catalogStartedAt = Date.now();
    const slowPassing = invoke(slowPassingRunnerPath);
    expect(Date.now() - catalogStartedAt).toBeGreaterThan(1_000);
    expect(slowPassing.status).toBe(0);
    expect(JSON.parse(slowPassing.stdout).status).toBe("PASS");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}, 60_000);
