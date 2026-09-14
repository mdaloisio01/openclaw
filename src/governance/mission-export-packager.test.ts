import { describe, expect, it } from "vitest";
import { exportManifestComplete } from "./mission-export-packager.js";
import type { ExportManifest, MissionIdentity } from "./mission-manifest.types.js";

const identity: MissionIdentity = {
  missionId: "mission-export-test",
  planRevisionId: "plan-r1",
  planSha256: "plan-sha",
  sourceRevision: "source-sha",
  runtimeBuildSha256: "runtime-sha",
  policyVersion: "policy-v1",
  skillSha256: "skill-sha",
};

const manifest: ExportManifest = {
  schema: "openclaw.export_manifest.v1",
  ...identity,
  items: [
    { path: "/tmp/required.json", sha256: "required-sha", sizeBytes: 1, required: true },
    { path: "/tmp/optional.json", required: false },
  ],
};

describe("exportManifestComplete", () => {
  it("accepts complete required export items bound to the mission identity", () => {
    expect(exportManifestComplete(manifest, identity)).toBe(true);
  });

  it("rejects missing required item metadata or identity drift", () => {
    expect(
      exportManifestComplete(
        {
          ...manifest,
          items: [{ path: "/tmp/required.json", required: true }],
        },
        identity,
      ),
    ).toBe(false);
    expect(exportManifestComplete({ ...manifest, sourceRevision: "other-source" }, identity)).toBe(
      false,
    );
  });
});
