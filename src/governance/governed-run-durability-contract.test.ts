import { describe, expect, it } from "vitest";
import {
  GOVERNED_RUN_DURABILITY_DECISION_STATES,
  resolveGovernedRunDurability,
} from "./governed-run-durability-contract.js";

describe("governed run durability contract", () => {
  it("defines durable settlement decision states", () => {
    expect(GOVERNED_RUN_DURABILITY_DECISION_STATES).toEqual([
      "settled",
      "needs_durable_continuation",
      "needs_delivery_recovery",
      "needs_run_failed_resume",
      "watchdog_needs_review",
      "blocked",
    ]);
  });

  it("blocks a non-terminal governed update without durable next-step coverage", () => {
    expect(
      resolveGovernedRunDurability({
        governedRunActive: true,
        nonTerminalUpdateEmitted: true,
      }),
    ).toMatchObject({
      state: "needs_durable_continuation",
      allowedToSettle: false,
      watchdogVisible: true,
      requiredActions: [
        "record_durable_next_executable_step",
        "record_owner_boundary_handoff",
        "record_lawful_blocker",
        "record_terminal_completion_proof",
      ],
    });
  });

  it("allows a non-terminal governed update when a durable next step is recorded", () => {
    expect(
      resolveGovernedRunDurability({
        governedRunActive: true,
        nonTerminalUpdateEmitted: true,
        durableNextExecutableStepRecorded: true,
      }),
    ).toMatchObject({
      state: "settled",
      allowedToSettle: true,
    });
  });

  it("allows a non-terminal governed update when owner-boundary handoff is recorded", () => {
    expect(
      resolveGovernedRunDurability({
        governedRunActive: true,
        nonTerminalUpdateEmitted: true,
        ownerBoundaryHandoffRecorded: true,
      }),
    ).toMatchObject({
      state: "settled",
      allowedToSettle: true,
    });
  });

  it("allows a non-terminal governed update when a lawful blocker is recorded", () => {
    expect(
      resolveGovernedRunDurability({
        governedRunActive: true,
        nonTerminalUpdateEmitted: true,
        lawfulBlockerRecorded: true,
      }),
    ).toMatchObject({
      state: "settled",
      allowedToSettle: true,
    });
  });

  it("requires retry, handoff, or exhausted blocker for failed visible delivery", () => {
    expect(
      resolveGovernedRunDurability({
        finalDeliveryRequired: true,
        deliveryObligationStage: "failed",
        idempotencyKey: "source:turn|mission:mission|report:final",
      }),
    ).toMatchObject({
      state: "needs_delivery_recovery",
      allowedToSettle: false,
      requiredActions: [
        "enqueue_delivery_retry",
        "record_delivery_recovery_handoff",
        "record_delivery_exhausted_blocker",
      ],
    });
  });

  it("accepts failed delivery only after retry coverage is durable", () => {
    expect(
      resolveGovernedRunDurability({
        finalDeliveryRequired: true,
        deliveryObligationStage: "failed",
        deliveryRetryScheduled: true,
        idempotencyKey: "source:turn|mission:mission|report:final",
      }),
    ).toMatchObject({
      state: "settled",
      allowedToSettle: true,
    });
  });

  it("requires a durable resume item after governed run_failed", () => {
    expect(
      resolveGovernedRunDurability({
        runFailed: true,
      }),
    ).toMatchObject({
      state: "needs_run_failed_resume",
      allowedToSettle: false,
      requiredActions: ["record_run_failed_resume_item"],
    });
  });

  it("keeps watchdog NEEDS_REVIEW visible until fresh clean proof", () => {
    expect(
      resolveGovernedRunDurability({
        watchdogNeedsReview: true,
      }),
    ).toMatchObject({
      state: "watchdog_needs_review",
      allowedToSettle: false,
      watchdogVisible: true,
      requiredActions: ["rerun_watchdog_after_repair"],
    });
  });

  it("requires idempotency identity for final delivery obligations", () => {
    expect(
      resolveGovernedRunDurability({
        finalDeliveryRequired: true,
        deliveryObligationStage: "delivered",
      }),
    ).toMatchObject({
      state: "blocked",
      allowedToSettle: false,
      validationErrors: ["delivery_idempotency_key_missing"],
    });
  });
});
