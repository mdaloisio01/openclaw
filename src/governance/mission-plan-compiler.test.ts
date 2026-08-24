import { describe, expect, it } from "vitest";
import type { MissionManifest } from "./mission-manifest.types.js";
import { compileMissionPlan } from "./mission-plan-compiler.js";

const manifest: MissionManifest = {
  schema: "openclaw.mission_manifest.v1",
  missionId: "mission-plan-test",
  planRevisionId: "plan-r1",
  planSha256: "plan-sha",
  sourceRevision: "source-sha",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "policy-v1",
  skillSha256: "skill-sha",
  mode: "enforce",
  scopeHash: "scope",
  authorizedScopeHash: "scope",
  planRevisionAuthorized: true,
  createdAt: "2026-07-17T13:30:00Z",
};

describe("compileMissionPlan", () => {
  it("binds requirements and generated gates to the mission revision", () => {
    const compiled = compileMissionPlan({
      manifest,
      requirements: [
        { id: "REQ-1", text: "first requirement", required: true },
        { id: "REQ-2", text: "optional requirement", required: false },
      ],
      gateKinds: ["requirement", "test"],
    });

    expect(compiled.requirements).toMatchObject({
      schema: "openclaw.requirement_manifest.v1",
      missionId: "mission-plan-test",
      planRevisionId: "plan-r1",
    });
    expect(compiled.requirements.requirements).toEqual([
      {
        id: "REQ-1",
        text: "first requirement",
        required: true,
        gateIds: ["REQ-1:requirement", "REQ-1:test"],
      },
      {
        id: "REQ-2",
        text: "optional requirement",
        required: false,
        gateIds: ["REQ-2:requirement", "REQ-2:test"],
      },
    ]);
    expect(compiled.gates).toEqual([
      { id: "REQ-1:requirement", requirementId: "REQ-1", kind: "requirement", required: true },
      { id: "REQ-1:test", requirementId: "REQ-1", kind: "test", required: true },
      { id: "REQ-2:requirement", requirementId: "REQ-2", kind: "requirement", required: false },
      { id: "REQ-2:test", requirementId: "REQ-2", kind: "test", required: false },
    ]);
  });
});
