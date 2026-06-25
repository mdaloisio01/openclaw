import { describe, expect, it } from "vitest";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  resolveRequiredCompletionTerminalResult,
} from "./task-completion-contract.js";

describe("task-completion-contract", () => {
  it("blocks required completion when no final deliverable exists", () => {
    expect(resolveRequiredCompletionTerminalResult("")).toEqual({
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    });
  });

  it("blocks required completion when only progress text exists", () => {
    expect(resolveRequiredCompletionTerminalResult("I will investigate this now")).toEqual({
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    });
  });

  it("keeps successful child execution distinct from delivery failure debt", () => {
    expect(resolveRequiredCompletionDeliveryFailureTerminalResult("requester wake failed")).toEqual(
      {
        terminalOutcome: "succeeded",
        terminalSummary:
          "Required completion delivery failed before reaching the requester: requester wake failed.",
      },
    );
  });
});
