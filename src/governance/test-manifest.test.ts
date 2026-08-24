import { describe, expect, it } from "vitest";
import type { TestManifest } from "./mission-manifest.types.js";
import { reconcileTestManifest } from "./test-manifest.js";

const manifest: TestManifest = {
  schema: "openclaw.test_manifest.v1",
  missionId: "mission-test-manifest",
  planRevisionId: "plan-r1",
  planSha256: "plan-sha",
  sourceRevision: "source-sha",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "policy-v1",
  skillSha256: "skill-sha",
  requestedFiles: ["a.test.ts", "b.test.ts"],
  expectedTotal: 3,
};

describe("reconcileTestManifest", () => {
  it("passes when exactly the requested files ran with the expected total and no failures", () => {
    expect(
      reconcileTestManifest(manifest, [
        { file: "a.test.ts", passed: 1, failed: 0 },
        { file: "b.test.ts", passed: 2, failed: 0 },
      ]),
    ).toMatchObject({
      passed: true,
      requestedFileCount: 2,
      executedFileCount: 2,
      expectedTotal: 3,
      actualTotal: 3,
      missingFiles: [],
      unexpectedFiles: [],
    });
  });

  it("reports missing, unexpected, count mismatch, and failures", () => {
    expect(
      reconcileTestManifest(manifest, [
        { file: "a.test.ts", passed: 1, failed: 1 },
        { file: "extra.test.ts", passed: 1, failed: 0 },
      ]),
    ).toMatchObject({
      passed: false,
      actualTotal: 3,
      missingFiles: ["b.test.ts"],
      unexpectedFiles: ["extra.test.ts"],
    });
  });
});
