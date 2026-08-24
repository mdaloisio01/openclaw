import { describe, expect, it } from "vitest";
import {
  CLEANUP_WATCHDOG_POLICY_VERSION,
  canCleanupWatchdogCloseClean,
  compareCleanupWatchdogPriority,
  evaluateCleanupWatchdogCoverage,
  getCleanupWatchdogPriority,
  isCleanupWatchdogPolicyVersionCompatible,
} from "./cleanup-watchdog-policy.js";

describe("cleanup-watchdog-policy", () => {
  it("prioritizes safety and active-no-worker ahead of reporting debt", () => {
    const safety = getCleanupWatchdogPriority("duplicate_execution_or_fencing_failure");
    const activeNoWorker = getCleanupWatchdogPriority("active_no_worker");
    const reportDebt = getCleanupWatchdogPriority("pending_report_delivery");

    expect(compareCleanupWatchdogPriority(safety, activeNoWorker)).toBeLessThan(0);
    expect(compareCleanupWatchdogPriority(activeNoWorker, reportDebt)).toBeLessThan(0);
  });

  it("requires exactly one live executor for unfinished active production work", () => {
    expect(
      evaluateCleanupWatchdogCoverage({
        unfinished: true,
        activeProduction: true,
        executorCount: 1,
        executorLeaseCurrent: true,
      }),
    ).toEqual({
      ok: true,
      kind: "valid_executor",
      reason: "exactly_one_current_executor",
    });
  });

  it("rejects unfinished active production work with no executor or durable coverage", () => {
    expect(
      evaluateCleanupWatchdogCoverage({
        unfinished: true,
        activeProduction: true,
        executorCount: 0,
      }),
    ).toEqual({
      ok: false,
      reason: "unfinished_active_mission_missing_executor_or_durable_coverage",
    });
  });

  it("rejects duplicate worker coverage for one unfinished active mission", () => {
    expect(
      evaluateCleanupWatchdogCoverage({
        unfinished: true,
        activeProduction: true,
        executorCount: 2,
        executorLeaseCurrent: true,
      }),
    ).toEqual({
      ok: false,
      reason: "duplicate_executor_coverage_for_unfinished_mission",
    });
  });

  it("allows exactly one durable wait or verified blocker record", () => {
    expect(
      evaluateCleanupWatchdogCoverage({
        unfinished: true,
        activeProduction: true,
        executorCount: 0,
        verifiedBlockerRecord: true,
      }),
    ).toEqual({
      ok: true,
      kind: "verified_blocker",
      reason: "exactly_one_verified_blocker_coverage_record",
    });
  });

  it("does not allow clean unless every clean dimension passes", () => {
    expect(
      canCleanupWatchdogCloseClean({
        suspiciousCount: 0,
        dimensions: {
          record_integrity: true,
          worker_coverage: false,
          continuation_readiness: true,
          delivery_completeness: true,
          runtime_health: true,
          repair_closure: true,
          policy_version: true,
        },
      }),
    ).toBe(false);
  });

  it("keeps the current and legacy migration policy versions readable", () => {
    expect(isCleanupWatchdogPolicyVersionCompatible(CLEANUP_WATCHDOG_POLICY_VERSION)).toBe(true);
    expect(
      isCleanupWatchdogPolicyVersionCompatible("cleanup-crew-governance-final-20260714T1454Z"),
    ).toBe(true);
    expect(isCleanupWatchdogPolicyVersionCompatible("cleanup-crew-governance-unknown")).toBe(false);
  });
});
