import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateProductionOwnerLaneGuard } from "./production-owner-lane-guard.js";

async function withPlanFile(testFn: (planPath: string) => void | Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owner-lane-guard-"));
  try {
    const planPath = path.join(dir, "build-plan.md");
    await fs.writeFile(planPath, "# Build Plan\n", "utf8");
    await testFn(planPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("production owner/lane guard", () => {
  it("allows the correct owner/lane to execute", async () => {
    await withPlanFile((planPath) => {
      const result = evaluateProductionOwnerLaneGuard({
        buildPlanRef: planPath,
        buildItem: "Phase 1 - Hard-Rule Policy Engine",
        requiredOwnerLane: "SADB",
        attemptedOwnerLane: "SADB",
        attemptedExecutor: "sadb",
        executorRole: "runtime_implementation",
        lawfulRouteRequired: "dispatch to SADB",
      });

      expect(result.allowed).toBe(true);
    });
  });

  it("blocks missing controlling build plans", () => {
    const result = evaluateProductionOwnerLaneGuard({
      buildPlanRef: "/tmp/openclaw-missing-build-plan.md",
      buildItem: "Phase 1",
      requiredOwnerLane: "SADB",
      attemptedOwnerLane: "SADB",
      attemptedExecutor: "sadb",
      executorRole: "runtime_implementation",
      lawfulRouteRequired: "dispatch to SADB",
    });

    expect(result).toMatchObject({
      allowed: false,
      blockerCode: "missing_controlling_build_plan",
    });
  });

  it("blocks unresolved build items and owner routes", async () => {
    await withPlanFile((planPath) => {
      expect(
        evaluateProductionOwnerLaneGuard({
          buildPlanRef: planPath,
          requiredOwnerLane: "SADB",
          attemptedOwnerLane: "SADB",
          attemptedExecutor: "sadb",
          executorRole: "runtime_implementation",
          lawfulRouteRequired: "dispatch to SADB",
        }),
      ).toMatchObject({ allowed: false, blockerCode: "unresolved_owner_lane" });

      expect(
        evaluateProductionOwnerLaneGuard({
          buildPlanRef: planPath,
          buildItem: "Phase 1",
          attemptedOwnerLane: "SADB",
          attemptedExecutor: "sadb",
          executorRole: "runtime_implementation",
          lawfulRouteRequired: "dispatch to SADB",
        }),
      ).toMatchObject({ allowed: false, blockerCode: "missing_sop_owner_route" });
    });
  });

  it("blocks Will, Grant, and other wrong-owner execution", async () => {
    await withPlanFile((planPath) => {
      const base = {
        buildPlanRef: planPath,
        buildItem: "Phase 3 - Decision Router",
        requiredOwnerLane: "Data & AI Systems / SADB",
        executorRole: "direct_execution",
        lawfulRouteRequired: "dispatch to Data & AI Systems / SADB",
      };

      expect(
        evaluateProductionOwnerLaneGuard({
          ...base,
          attemptedOwnerLane: "Will",
          attemptedExecutor: "will-orchestrator",
        }),
      ).toMatchObject({ allowed: false, blockerCode: "will_self_perform_forbidden" });

      expect(
        evaluateProductionOwnerLaneGuard({
          ...base,
          attemptedOwnerLane: "Grant",
          attemptedExecutor: "grant",
        }),
      ).toMatchObject({ allowed: false, blockerCode: "grant_self_perform_forbidden" });

      expect(
        evaluateProductionOwnerLaneGuard({
          ...base,
          attemptedOwnerLane: "Security",
          attemptedExecutor: "security",
        }),
      ).toMatchObject({ allowed: false, blockerCode: "owner_lane_mismatch" });
    });
  });

  it("allows only a scoped explicit Mark/operator override", async () => {
    await withPlanFile((planPath) => {
      const base = {
        buildPlanRef: planPath,
        buildItem: "Phase 4 - Contradiction Resolver",
        requiredOwnerLane: "Governance/Authority",
        attemptedOwnerLane: "SADB",
        attemptedExecutor: "sadb",
        executorRole: "runtime_implementation",
        lawfulRouteRequired: "dispatch to Governance/Authority",
      };

      expect(
        evaluateProductionOwnerLaneGuard({
          ...base,
          override: {
            explicitOperatorApproval: true,
            targetWorkItem: "different item",
            normalRequiredOwnerLane: "Governance/Authority",
            approvedAlternateExecutor: "sadb",
            reason: "bounded emergency repair",
            scope: "one slice",
            oneTimeUse: true,
          },
        }),
      ).toMatchObject({ allowed: false, blockerCode: "owner_lane_mismatch" });

      expect(
        evaluateProductionOwnerLaneGuard({
          ...base,
          override: {
            explicitOperatorApproval: true,
            targetWorkItem: "Phase 4 - Contradiction Resolver",
            normalRequiredOwnerLane: "Governance/Authority",
            approvedAlternateExecutor: "sadb",
            reason: "bounded emergency repair",
            scope: "one slice",
            oneTimeUse: true,
          },
        }),
      ).toMatchObject({ allowed: true });
    });
  });
});
