import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseBundledPluginAssetArgs,
  readBundledPluginAssetHooks,
  requiredDependencyPreflightsForHook,
  runBundledPluginDependencyPreflight,
} from "../../scripts/bundled-plugin-assets.mjs";

async function withPluginAssetFixture(run: (rootDir: string) => Promise<void>) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-assets-"));
  try {
    fs.mkdirSync(path.join(rootDir, "extensions", "canvas"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "extensions", "canvas", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/canvas-plugin",
          openclaw: {
            assetScripts: {
              build: "node scripts/bundle-a2ui.mjs",
              copy: "node scripts/copy-a2ui.mjs",
            },
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(rootDir, "extensions", "canvas", "openclaw.plugin.json"),
      JSON.stringify({ id: "canvas" }, null, 2),
    );
    await run(rootDir);
  } finally {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
}

describe("bundled plugin assets", () => {
  it("discovers plugin-owned asset scripts by manifest id", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const hooks = await readBundledPluginAssetHooks({
        phase: "build",
        plugins: ["canvas"],
        rootDir,
      });

      expect(hooks).toEqual([
        {
          aliases: ["@openclaw/canvas-plugin", "canvas", "canvas-plugin"],
          command: "node scripts/bundle-a2ui.mjs",
          packageName: "@openclaw/canvas-plugin",
          phase: "build",
          pluginDir: path.join(rootDir, "extensions", "canvas"),
          pluginId: "canvas",
        },
      ]);
    });
  });

  it("skips cleanly when a requested plugin is absent", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      await expect(
        readBundledPluginAssetHooks({ phase: "copy", plugins: ["missing"], rootDir }),
      ).resolves.toStrictEqual([]);
    });
  });

  it("parses phase and plugin filters", () => {
    expect(parseBundledPluginAssetArgs(["--phase", "build", "--plugin=canvas"])).toEqual({
      phase: "build",
      plugins: ["canvas"],
    });
  });

  it("declares ESM dependency preflights for the diffs asset build", () => {
    expect(
      requiredDependencyPreflightsForHook({
        packageName: "@openclaw/diffs",
        phase: "build",
      }),
    ).toEqual(["@pierre/diffs", "@pierre/diffs/ssr"]);
  });

  it("fails bundled dependency preflight with package, dependency, cwd, and repair command", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-assets-missing-dep-"));
    const pluginDir = path.join(rootDir, "extensions", "diffs");
    try {
      fs.mkdirSync(pluginDir, { recursive: true });

      const result = runBundledPluginDependencyPreflight(
        {
          packageName: "@openclaw/diffs",
          phase: "build",
          pluginDir,
        },
        { dependencies: ["@pierre/diffs"] },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("@openclaw/diffs");
      expect(result.error).toContain("dependency=@pierre/diffs");
      expect(result.error).toContain(`cwd=${pluginDir}`);
      expect(result.error).toContain("corepack pnpm install");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
