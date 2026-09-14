import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoNpmInstallArtifacts,
  createNpmInstallArtifactErrorMessage,
} from "../../scripts/install-integrity-guard.mjs";

function withTempRoot(run: (rootDir: string) => void) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-guard-"));
  try {
    run(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

describe("install integrity guard", () => {
  it("passes when npm-owned lock artifacts are absent", () => {
    withTempRoot((rootDir) => {
      expect(assertNoNpmInstallArtifacts({ rootDir })).toEqual({
        ok: true,
        artifacts: [],
        warnings: [],
      });
    });
  });

  it("fails local build preflight when package-lock.json exists", () => {
    withTempRoot((rootDir) => {
      fs.writeFileSync(path.join(rootDir, "package-lock.json"), "{}\n");

      expect(() => assertNoNpmInstallArtifacts({ rootDir, operation: "build-all full" })).toThrow(
        "package-lock.json",
      );
    });
  });

  it("allows clean tracked root npm-shrinkwrap.json temporarily", () => {
    withTempRoot((rootDir) => {
      fs.writeFileSync(path.join(rootDir, "npm-shrinkwrap.json"), "{}\n");

      expect(
        assertNoNpmInstallArtifacts({
          rootDir,
          operation: "gateway restart preflight",
          gitStatus: () => "",
        }),
      ).toMatchObject({
        ok: true,
        artifacts: [],
        warnings: [
          expect.objectContaining({
            relativePath: "npm-shrinkwrap.json",
          }),
        ],
      });
    });
  });

  it("allows clean tracked shrinkwrap when git status exits zero with a sandbox spawn warning", () => {
    withTempRoot((rootDir) => {
      fs.writeFileSync(path.join(rootDir, "npm-shrinkwrap.json"), "{}\n");

      expect(
        assertNoNpmInstallArtifacts({
          rootDir,
          operation: "runtime build",
          spawnSync: () =>
            ({
              status: 0,
              stdout: "",
              stderr: "",
              error: new Error("spawnSync git EPERM"),
            }) as never,
        }),
      ).toMatchObject({
        ok: true,
        artifacts: [],
        warnings: [
          expect.objectContaining({
            relativePath: "npm-shrinkwrap.json",
          }),
        ],
      });
    });
  });

  it("fails local build preflight when root npm-shrinkwrap.json is modified or untracked", () => {
    withTempRoot((rootDir) => {
      fs.writeFileSync(path.join(rootDir, "npm-shrinkwrap.json"), "{}\n");

      expect(() =>
        assertNoNpmInstallArtifacts({
          rootDir,
          operation: "gateway restart preflight",
          gitStatus: () => " M npm-shrinkwrap.json\n",
        }),
      ).toThrow("modified root npm-shrinkwrap.json");

      expect(() =>
        assertNoNpmInstallArtifacts({
          rootDir,
          operation: "gateway restart preflight",
          gitStatus: () => "?? npm-shrinkwrap.json\n",
        }),
      ).toThrow("untracked root npm-shrinkwrap.json");
    });
  });

  it("reports backup shrinkwrap artifacts as warning evidence only", () => {
    withTempRoot((rootDir) => {
      fs.writeFileSync(path.join(rootDir, "npm-shrinkwrap.json.bak-20260627T142430Z"), "{}\n");

      expect(assertNoNpmInstallArtifacts({ rootDir })).toMatchObject({
        ok: true,
        artifacts: [],
        warnings: [
          expect.objectContaining({
            relativePath: "npm-shrinkwrap.json.bak-20260627T142430Z",
          }),
        ],
      });
    });
  });

  it("includes non-destructive repair guidance in npm artifact errors", () => {
    const message = createNpmInstallArtifactErrorMessage({
      artifacts: [{ relativePath: "npm-shrinkwrap.json" }],
      operation: "local build",
      rootDir: "/repo",
    });

    expect(message).toContain("npm-shrinkwrap.json");
    expect(message).toContain(
      "Do not leave package-lock.json or untracked/mutated npm-shrinkwrap.json",
    );
    expect(message).toContain("clean tracked root npm-shrinkwrap.json is temporarily allowed");
    expect(message).toContain("do not auto-delete evidence files");
    expect(message).toContain("rootDir=/repo");
  });
});
