import { describe, expect, it } from "vitest";
import {
  buildDirtyTreeHygieneReport,
  classifyDirtyTreePackageGroup,
  parseGitStatusShort,
} from "./dirty-tree-hygiene.js";

describe("dirty-tree hygiene report", () => {
  it("reports clean status without package-boundary risk", () => {
    const report = buildDirtyTreeHygieneReport("");

    expect(report).toMatchObject({
      clean: true,
      risk: "clean",
      packageBoundaryCount: 0,
      broadMixed: false,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      generatedOutputCount: 0,
      summary: "clean",
    });
    expect(report.entries).toEqual([]);
    expect(report.groups).toEqual([]);
  });

  it("detects broad mixed package work and reports staged, unstaged, and untracked risk", () => {
    const report = buildDirtyTreeHygieneReport(
      [
        " M extensions/codex/src/app-server/confirmation-gate.ts",
        "M  src/tasks/task-flow-registry.ts",
        "?? scripts/clean-dist.mjs",
        "A  src/state/openclaw-state-schema.generated.ts",
        "MM src/auto-reply/reply/dispatch-from-config.ts",
      ].join("\n"),
    );

    expect(report.clean).toBe(false);
    expect(report.risk).toBe("broad-mixed");
    expect(report.broadMixed).toBe(true);
    expect(report.packageBoundaryCount).toBe(5);
    expect(report.stagedCount).toBe(3);
    expect(report.unstagedCount).toBe(2);
    expect(report.untrackedCount).toBe(1);
    expect(report.generatedOutputCount).toBe(0);
    expect(report.groups.map((group) => group.group).toSorted()).toEqual([
      "codex-app-server",
      "gateway-auto-reply-routing",
      "runtime-build-tooling",
      "state-schema-storage",
      "taskflow-state",
    ]);
    expect(report.summary).toContain("5 dirty entries");
    expect(report.summary).toContain("5 package boundaries");
    expect(report.summary).toContain("staged=3");
    expect(report.summary).toContain("unstaged=2");
    expect(report.summary).toContain("untracked=1");
    expect(report.summary).toContain("generated_output=0");
  });

  it("reports generated output without treating it as source package-boundary poison", () => {
    const report = buildDirtyTreeHygieneReport(
      [
        "?? dist.broken-2026-07-07T055954357Z/",
        "?? dist-runtime.broken-2026-07-07T055957333Z/",
        "?? file_hub/exports/cleanup-proof.md",
      ].join("\n"),
    );

    expect(report.clean).toBe(false);
    expect(report.risk).toBe("single-package");
    expect(report.packageBoundaryCount).toBe(0);
    expect(report.broadMixed).toBe(false);
    expect(report.generatedOutputCount).toBe(3);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.group).toBe("generated-output");
    expect(report.sourceGroups).toEqual([]);
    expect(report.summary).toContain("0 package boundaries");
    expect(report.summary).toContain("generated_output=3");
  });

  it("keeps single-package dirt separate from broad mixed tree risk", () => {
    const report = buildDirtyTreeHygieneReport(
      [
        " M extensions/codex/src/app-server/confirmation-gate.ts",
        " M extensions/codex/src/app-server/run-attempt.ts",
      ].join("\n"),
    );

    expect(report.risk).toBe("single-package");
    expect(report.broadMixed).toBe(false);
    expect(report.packageBoundaryCount).toBe(1);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      group: "codex-app-server",
      stagedCount: 0,
      unstagedCount: 2,
      untrackedCount: 0,
    });
  });

  it("parses rename status without changing files", () => {
    const entries = parseGitStatusShort("R  src/old.ts -> src/tasks/new.ts\n");

    expect(entries).toEqual([
      {
        path: "src/tasks/new.ts",
        originalPath: "src/old.ts",
        indexStatus: "R",
        worktreeStatus: " ",
        staged: true,
        unstaged: false,
        untracked: false,
        group: "taskflow-state",
        generatedOutput: false,
      },
    ]);
  });

  it.each([
    ["extensions/codex/src/app-server/run-attempt.ts", "codex-app-server"],
    ["extensions/memory-core/src/tools.ts", "memory-qmd"],
    ["src/agents/subagent-spawn.ts", "agent-subagent-runtime"],
    ["src/gateway/server-methods/tasks.ts", "gateway-auto-reply-routing"],
    ["src/state/openclaw-state-schema.sql", "state-schema-storage"],
    ["src/cli/system-cli.ts", "cli-config-cron-infra"],
    ["dist.broken-2026-07-07T055954357Z/index.js", "generated-output"],
    ["unknown/file.txt", "unknown"],
  ] as const)("classifies %s as %s", (path, group) => {
    expect(classifyDirtyTreePackageGroup(path)).toBe(group);
  });
});
