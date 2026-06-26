import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "clean-dist.mjs");
const { createTempDir } = createScriptTestHarness();

function createRuntimeRoot() {
  const rootDir = createTempDir("openclaw-clean-dist-root-");
  fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "dist-runtime"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "dist", "index.js"), "console.log('runtime');\n");
  fs.writeFileSync(path.join(rootDir, "dist-runtime", "marker.js"), "console.log('marker');\n");
  return rootDir;
}

function runCleanDist(args: string[], params: { rootDir: string; homeDir?: string }) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: params.homeDir ?? createTempDir("openclaw-clean-dist-home-"),
      OPENCLAW_RUNTIME_GUARD_ROOT: params.rootDir,
    },
  });
}

describe("scripts/clean-dist", () => {
  it("is exposed as the clean:dist package script", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["clean:dist"]).toBe("node scripts/clean-dist.mjs");
  });

  it("reports removable output roots without deleting them during dry-run", () => {
    const rootDir = createRuntimeRoot();

    const result = runCleanDist(["--dry-run"], { rootDir });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      dryRun: boolean;
      removed: string[];
      rootDir: string;
      protectedByGateway: boolean;
    };
    expect(payload).toMatchObject({
      ok: true,
      dryRun: true,
      removed: ["dist", "dist-runtime"],
      rootDir,
      protectedByGateway: false,
    });
    expect(fs.existsSync(path.join(rootDir, "dist", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "dist-runtime", "marker.js"))).toBe(true);
  });

  it("blocks cleaning when the user gateway service points at the active runtime", () => {
    const rootDir = createRuntimeRoot();
    const homeDir = createTempDir("openclaw-clean-dist-home-");
    const serviceDir = path.join(homeDir, ".config", "systemd", "user");
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(
      path.join(serviceDir, "openclaw-gateway.service"),
      `ExecStart=/usr/bin/node ${path.join(rootDir, "dist", "index.js")} gateway\n`,
    );

    const result = runCleanDist(["--dry-run"], { rootDir, homeDir });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "clean-dist blocked: openclaw-gateway.service points at this checkout's active dist/index.js.",
    );
    expect(fs.existsSync(path.join(rootDir, "dist", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "dist-runtime", "marker.js"))).toBe(true);
  });
});
