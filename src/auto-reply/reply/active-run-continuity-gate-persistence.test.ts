import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveActiveRunContinuityGatePersistence } from "./active-run-continuity-gate-persistence.js";

describe("resolveActiveRunContinuityGatePersistence", () => {
  it("returns active-run guard persistence config when required runtime context is present", () => {
    const resolved = resolveActiveRunContinuityGatePersistence({
      workspaceDir: "/tmp/openclaw-workspace",
      sessionKey: "agent:main:webchat:direct:abc",
      agentId: "main",
      now: "2026-07-04T22:20:00.000Z",
    });

    expect(resolved).toMatchObject({
      outputDir: path.join(
        "/tmp/openclaw-workspace",
        "var",
        "continuity_gate_v2",
        "active_run_guard",
      ),
      activeMission: "Active reply run continuation for agent:main:webchat:direct:abc",
      now: "2026-07-04T22:20:00.000Z",
      sourceSurface: "dispatch-from-config:active-run-continuation-guard",
      proofRefs: ["agent:main:webchat:direct:abc"],
      authoritySources: [
        {
          kind: "active_mission_lock",
          id: "active_reply_run:agent:main:webchat:direct:abc",
          summary: "Active reply run continuation guard for agent:main:webchat:direct:abc (main)",
          active: true,
        },
      ],
    });
  });

  it("returns undefined when required context is missing or unsafe", () => {
    expect(
      resolveActiveRunContinuityGatePersistence({
        workspaceDir: "/tmp/openclaw-workspace",
        sessionKey: undefined,
        agentId: "main",
      }),
    ).toBeUndefined();
    expect(
      resolveActiveRunContinuityGatePersistence({
        workspaceDir: "relative-workspace",
        sessionKey: "agent:main:webchat:direct:abc",
        agentId: "main",
      }),
    ).toBeUndefined();
    expect(
      resolveActiveRunContinuityGatePersistence({
        workspaceDir: "/tmp/openclaw-workspace",
        sessionKey: "agent:main:webchat:direct:abc",
        agentId: "",
      }),
    ).toBeUndefined();
  });
});
