import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "server-methods.ts",
);

describe("gateway restart broker loading", () => {
  it("keeps gateway.restart handlers outside the lazy chunk boundary", async () => {
    const source = await fs.readFile(sourcePath, "utf8");

    expect(source).toContain('import { restartHandlers } from "./server-methods/restart.js";');
    expect(source).toContain("...restartHandlers");
    expect(source).not.toContain('import("./server-methods/restart.js")');
  });
});
