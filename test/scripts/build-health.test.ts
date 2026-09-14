import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkNpmArtifacts,
  checkDiffsResolution,
  checkRuntimeAssets,
  collectBuildHealth,
  runNode,
} from "../../scripts/build-health.mjs";

function spawnResult(
  overrides: {
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  } = {},
) {
  return {
    status: overrides.status ?? 0,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

describe("build health", () => {
  it("fails child probes when spawnSync reports an error even with zero status", () => {
    const result = runNode(["scripts/runtime-asset-guard.mjs"], {
      spawnSync: () => spawnResult({ error: new Error("EPERM") }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("EPERM");
  });

  it("fails diffs resolution when proof output is empty", () => {
    const result = checkDiffsResolution({
      spawnSync: () => spawnResult({ stdout: "" }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("expected 2 resolved dependency path");
  });

  it("fails runtime asset health when output is empty or unparseable", () => {
    expect(
      checkRuntimeAssets({
        spawnSync: () => spawnResult({ stdout: "" }),
      }),
    ).toMatchObject({
      ok: false,
      error: "runtime asset guard did not emit parsed ok proof",
    });

    expect(
      checkRuntimeAssets({
        spawnSync: () => spawnResult({ stdout: "not json" }),
      }),
    ).toMatchObject({
      ok: false,
      error: "runtime asset guard did not emit parsed ok proof",
    });
  });

  it("passes when diffs and runtime asset proof are complete", () => {
    let call = 0;
    const result = collectBuildHealth({
      spawnSync: () => {
        call += 1;
        if (call === 1) {
          return spawnResult({
            stdout: [
              "file:///repo/node_modules/@pierre/diffs/dist/index.js",
              "file:///repo/node_modules/@pierre/diffs/dist/ssr/index.js",
            ].join("\n"),
          });
        }
        return spawnResult({
          stdout: JSON.stringify({
            ok: true,
            missing: [],
            internalImports: { ok: true, checkedFileCount: 1, missing: [] },
          }),
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.checks.pierreDiffs.resolved).toHaveLength(2);
    expect(result.checks.runtimeAssets.result).toMatchObject({ ok: true });
  });

  it("reports shrinkwrap backup evidence without failing build health", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-health-npm-artifacts-"));
    try {
      fs.writeFileSync(path.join(rootDir, "npm-shrinkwrap.json.bak-20260627T142430Z"), "{}\n");

      expect(checkNpmArtifacts({ rootDir })).toMatchObject({
        ok: true,
        artifacts: [],
        warnings: [
          expect.objectContaining({
            relativePath: "npm-shrinkwrap.json.bak-20260627T142430Z",
          }),
        ],
      });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
