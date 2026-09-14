import { describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentMaterialProgressState } from "./subagent-session-metrics.js";

function baseRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:openclaw:acp:child",
    requesterSessionKey: "agent:orchestrator:main",
    requesterDisplayKey: "agent:orchestrator:main",
    task: "Phase 5 acknowledgement",
    cleanup: "keep",
    createdAt: 1,
    ...overrides,
  };
}

function validAcknowledgementText(): string {
  return acknowledgementText({ result: "pass" });
}

function acknowledgementText(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    schema: "openclaw.systemwide_department_flow_durability_drill.acknowledgement.v1",
    run_label: "systemwide_department_flow_durability_validation_drill_2026-09-04T1352PDT",
    department_lane_name: "ACP/session path",
    received_mission: "Verify bounded Phase 5 ACP/session acknowledgement.",
    controlling_prompt_recognized:
      "systemwide_department_flow_durability_validation_drill_14_point_build_prompt_2026-09-04T1352PDT.md",
    scope_understood: "ACP/session path owns only the bounded Phase 5 acknowledgement.",
    durability_checks_performed: ["bounded ACP turn completed", "acknowledgement schema returned"],
    result: "pass",
    proof_path_or_durable_response_receipt: "file_hub/exports/phase5_ack.md",
    what_is_materially_real_now: "ACP/session path returned a valid acknowledgement.",
    what_is_still_not_real_yet: "Downstream drill phases remain uncollected.",
    who_lawfully_owns_the_next_step: "Will / OpenClaw controller",
    open_closed_truth_for_section: "Phase 5 ACP/session section closed; full drill open.",
    exact_next_action: "Append the Phase 5 acknowledgement result to the drill ledger.",
    ...overrides,
  });
}

describe("subagent session metrics", () => {
  it("classifies a terminal bounded drill acknowledgement separately from no-closeout", () => {
    const state = resolveSubagentMaterialProgressState(
      baseRun({
        endedAt: 2,
        completion: {
          required: true,
          resultText: validAcknowledgementText(),
          capturedAt: 2,
        },
      }),
    );

    expect(state).toBe("acknowledgement_schema_returned");
  });

  it("classifies a blocked bounded drill acknowledgement as schema returned", () => {
    const state = resolveSubagentMaterialProgressState(
      baseRun({
        endedAt: 2,
        completion: {
          required: true,
          resultText: acknowledgementText({
            result: "blocked",
            proof_path_or_durable_response_receipt:
              "runtime ACP blocker for agent:main:acp:blocked",
            open_closed_truth_for_section:
              "Phase 5 ACP/session acknowledgement section remains blocked/open.",
            exact_next_action: "Repair ACP session metadata/rebind before retry.",
          }),
          capturedAt: 2,
        },
      }),
    );

    expect(state).toBe("acknowledgement_schema_returned");
  });

  it("keeps generic terminal output classified as no-closeout when no gate proof exists", () => {
    const state = resolveSubagentMaterialProgressState(
      baseRun({
        endedAt: 2,
        completion: {
          required: true,
          resultText: "done",
          capturedAt: 2,
        },
      }),
    );

    expect(state).toBe("runtime_completed_no_closeout_gate");
  });
});
