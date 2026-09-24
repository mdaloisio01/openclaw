import { describe, expect, it } from "vitest";
import {
  LANE_READINESS_LANES,
  SOP_OPERATING_REGISTRY,
  type LaneReadinessReport,
} from "./lane-readiness-harness.js";
import {
  resolveSopOperatingLaneState,
  validateSopOperatingRegistry,
} from "./sop-operating-registry.js";

const validRegistry = () => structuredClone(SOP_OPERATING_REGISTRY);

function readinessResults(): Pick<
  LaneReadinessReport,
  "checkedAt" | "nextRunDueAt" | "status" | "integrityFailures" | "lanes"
> {
  return {
    checkedAt: "2026-09-24T18:00:00.000Z",
    nextRunDueAt: "2026-10-01T18:00:00.000Z",
    status: "PASS",
    integrityFailures: [],
    lanes: LANE_READINESS_LANES.map((lane) => ({
      laneId: lane.id,
      label: lane.label,
      priority: lane.priority,
      currentOwner: lane.currentOwner,
      status: "PASS",
      checks: lane.checks.map((check) => ({
        checkId: check.id,
        description: check.description,
        status: "PASS",
        proofPaths: [`proof/${lane.id}/${check.id}.json`],
      })),
    })),
  };
}

describe("SOP operating registry", () => {
  it("binds every readiness lane and proof gate to one explicit owner route", () => {
    expect(SOP_OPERATING_REGISTRY.lanes).toHaveLength(12);
    expect(SOP_OPERATING_REGISTRY.lanes.filter((lane) => lane.priority === "P0")).toHaveLength(8);
    expect(SOP_OPERATING_REGISTRY.lanes.every((lane) => lane.allowedSubstitutes.length === 0)).toBe(
      true,
    );
    expect(SOP_OPERATING_REGISTRY.lanes.flatMap((lane) => lane.proofGates)).toHaveLength(54);
  });

  it.each([
    [
      "missing owner",
      (lane: ReturnType<typeof validRegistry>["lanes"][number]) => {
        lane.owner = "";
      },
    ],
    [
      "missing proof gate",
      (lane: ReturnType<typeof validRegistry>["lanes"][number]) => {
        lane.proofGates = [];
      },
    ],
    [
      "ambiguous route",
      (lane: ReturnType<typeof validRegistry>["lanes"][number]) => {
        lane.handoffRoutes.push({ ...lane.handoffRoutes[0] });
      },
    ],
    [
      "unbounded substitute",
      (lane: ReturnType<typeof validRegistry>["lanes"][number]) => {
        lane.allowedSubstitutes.push({ owner: "alternate", scope: "all", expiresAt: "" });
      },
    ],
    [
      "missing closeout rule",
      (lane: ReturnType<typeof validRegistry>["lanes"][number]) => {
        delete (lane as Partial<typeof lane>).closeoutRule;
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const registry = validRegistry();
    mutate(registry.lanes[0]);
    expect(() => validateSopOperatingRegistry(registry)).toThrow();
  });

  it("does not promote blocked or expired evidence to ready", () => {
    const report = readinessResults();
    report.status = "FAIL";
    report.lanes[0].status = "FAIL";
    report.lanes[0].checks[0].status = "FAIL";
    const current = resolveSopOperatingLaneState(
      SOP_OPERATING_REGISTRY,
      report,
      "2026-09-24T18:01:00.000Z",
    );
    expect(current[0].status).toBe("blocked");
    expect(current[1].status).toBe("ready");
    const expired = resolveSopOperatingLaneState(
      SOP_OPERATING_REGISTRY,
      report,
      "2026-10-02T00:00:00.000Z",
    );
    expect(expired.every((lane) => lane.status === "stale")).toBe(true);
  });

  it("blocks registry readiness when report integrity fails despite passing lanes", () => {
    const report = readinessResults();
    report.status = "FAIL";
    report.integrityFailures.push({
      code: "invalid_handle",
      count: 1,
      detail: "unexpected readiness handle",
    });
    const states = resolveSopOperatingLaneState(
      SOP_OPERATING_REGISTRY,
      report,
      "2026-09-24T18:01:00.000Z",
    );
    expect(states.every((lane) => lane.status === "blocked")).toBe(true);
    expect(states[0].blockers).toContain("unexpected readiness handle");
  });

  it("rejects reports that omit an owner lane", () => {
    const report = readinessResults();
    report.lanes.pop();
    expect(() =>
      resolveSopOperatingLaneState(SOP_OPERATING_REGISTRY, report, report.checkedAt),
    ).toThrow("does not cover");
  });
});
