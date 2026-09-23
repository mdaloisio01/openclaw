import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  observeGovernedMissionIdentity,
  readGovernedSkillSnapshotSha256,
} from "./governed-mission-identity.js";
import { testing } from "./governed-mission-production-admission.js";

const tempRoots: string[] = [];

async function createRuntimeFixture(dirty = false): Promise<{
  root: string;
  runtimeArtifactPath: string;
  executableArtifactPaths: string[];
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governed-runtime-"));
  tempRoots.push(root);
  const runtimeArtifactPath = path.join(root, "tasks-runtime.js");
  const enforcementArtifactPath = path.join(root, "governed-enforcement.js");
  const moduleArtifactPath = path.join(root, "governed-module.mjs");
  const commonJsArtifactPath = path.join(root, "governed-common.cjs");
  await fs.writeFile(
    path.join(root, "build-info.json"),
    `${JSON.stringify({ commit: "source-revision", dirty })}\n`,
    "utf8",
  );
  await fs.writeFile(
    runtimeArtifactPath,
    'import "./governed-enforcement.js";\nexport const runtime = true;\n',
    "utf8",
  );
  await fs.writeFile(enforcementArtifactPath, "export const policy = 'allow';\n", "utf8");
  await fs.writeFile(moduleArtifactPath, "export const modulePolicy = 'allow';\n", "utf8");
  await fs.writeFile(commonJsArtifactPath, "exports.policy = 'allow';\n", "utf8");
  return {
    root,
    runtimeArtifactPath,
    executableArtifactPaths: [enforcementArtifactPath, moduleArtifactPath, commonJsArtifactPath],
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("governed production runtime identity", () => {
  it("binds every shipped JavaScript module format into the runtime digest", async () => {
    const fixture = await createRuntimeFixture();
    let prior = testing.readRuntimeIdentityFromArtifactPath(fixture.runtimeArtifactPath);
    expect(prior).toMatchObject({ sourceRevision: "source-revision" });

    for (const [index, artifactPath] of fixture.executableArtifactPaths.entries()) {
      await fs.writeFile(artifactPath, `module.exports = ${index};\n`, "utf8");
      const modified = testing.readRuntimeIdentityFromArtifactPath(fixture.runtimeArtifactPath);
      expect(modified).toMatchObject({ sourceRevision: "source-revision" });
      expect(modified?.runtimeBuildSha256).not.toBe(prior?.runtimeBuildSha256);
      prior = modified;
    }
  });

  it("rejects a runtime built from a dirty source tree", async () => {
    const fixture = await createRuntimeFixture(true);

    expect(
      testing.readRuntimeIdentityFromArtifactPath(fixture.runtimeArtifactPath),
    ).toBeUndefined();
  });

  it("remeasures the pinned authority file instead of echoing persisted identity", async () => {
    const fixture = await createRuntimeFixture();
    const authorityPath = path.join(fixture.root, "authority.md");
    await fs.writeFile(authorityPath, "original authority\n", "utf8");
    const authorityHash = createHash("sha256").update("original authority\n").digest("hex");
    const mission = {
      contractHash: "contract-hash",
      authorityRef: {
        refId: "authority-1",
        kind: "build_plan" as const,
        uri: authorityPath,
        sha256: authorityHash,
      },
      planRevisionId: "plan-1",
      policyVersion: "policy-1",
      skillSha256: "skill-1",
    };
    const trustedRuntimeIdentity = {
      sourceRevision: "source-revision",
      runtimeBuildSha256: "runtime-build",
    };

    expect(
      observeGovernedMissionIdentity({
        mission,
        trustedRuntimeIdentity,
        observedSkillSha256: mission.skillSha256,
      }),
    ).toMatchObject({ authorityHash });
    await fs.writeFile(authorityPath, "changed authority\n", "utf8");
    expect(
      observeGovernedMissionIdentity({
        mission,
        trustedRuntimeIdentity,
        observedSkillSha256: mission.skillSha256,
      })?.authorityHash,
    ).not.toBe(authorityHash);
  });

  it("hashes the exact resolved skill instructions instead of trusting persisted identity", async () => {
    const fixture = await createRuntimeFixture();
    const skillPath = path.join(fixture.root, "SKILL.md");
    await fs.writeFile(skillPath, "# Original governed skill\n", "utf8");
    const snapshot = {
      prompt: "",
      skills: [],
      resolvedSkills: [
        {
          name: "governed-test",
          description: "Test governed skill identity",
          filePath: skillPath,
          baseDir: fixture.root,
          sourceInfo: {
            path: skillPath,
            source: "tests",
            scope: "temporary" as const,
            origin: "top-level" as const,
          },
          disableModelInvocation: false,
          source: "tests",
        },
      ],
    };

    const original = readGovernedSkillSnapshotSha256(snapshot);
    expect(original).toMatch(/^[0-9a-f]{64}$/u);
    await fs.writeFile(skillPath, "# Modified governed skill\n", "utf8");
    expect(readGovernedSkillSnapshotSha256(snapshot)).not.toBe(original);
  });

  it("accepts in-root dot-prefixed names without accepting parent traversal", async () => {
    const fixture = await createRuntimeFixture();

    expect(testing.isAbsoluteInside(fixture.root, path.join(fixture.root, "..proof.json"))).toBe(
      true,
    );
    expect(
      testing.isAbsoluteInside(fixture.root, path.join(fixture.root, "..cache", "proof.json")),
    ).toBe(true);
    expect(
      testing.isAbsoluteInside(fixture.root, path.join(fixture.root, "..", "proof.json")),
    ).toBe(false);
    expect(testing.isAbsoluteInside(fixture.root, "relative-proof.json")).toBe(false);
  });
});
