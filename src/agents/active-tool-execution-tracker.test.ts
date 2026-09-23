import { describe, expect, it, vi } from "vitest";
import {
  beginActiveToolExecution,
  countActiveToolExecutions,
  waitForActiveToolExecutionsToDrain,
} from "./active-tool-execution-tracker.js";

describe("active tool execution tracker", () => {
  it("tracks overlapping invocations that reuse one provider tool-call id", async () => {
    const finishFirst = beginActiveToolExecution("run-duplicate-call-id", "reused-call");
    const finishSecond = beginActiveToolExecution("run-duplicate-call-id", "reused-call");
    expect(countActiveToolExecutions("run-duplicate-call-id")).toBe(2);

    const drained = vi.fn();
    const drain = waitForActiveToolExecutionsToDrain("run-duplicate-call-id").then(drained);
    finishFirst();
    await Promise.resolve();
    expect(countActiveToolExecutions("run-duplicate-call-id")).toBe(1);
    expect(drained).not.toHaveBeenCalled();

    finishSecond();
    await drain;
    expect(countActiveToolExecutions("run-duplicate-call-id")).toBe(0);
    expect(drained).toHaveBeenCalledOnce();
  });
});
