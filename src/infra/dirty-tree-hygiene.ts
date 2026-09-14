export type DirtyTreeRisk = "clean" | "single-package" | "broad-mixed";

export type DirtyTreePackageGroup =
  | "codex-app-server"
  | "memory-qmd"
  | "grant-retirement"
  | "production-flow-watchdog"
  | "taskflow-state"
  | "runtime-build-tooling"
  | "session-control"
  | "agent-subagent-runtime"
  | "gateway-auto-reply-routing"
  | "state-schema-storage"
  | "cli-config-cron-infra"
  | "generated-output"
  | "unknown";

export type DirtyTreeStatusEntry = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  group: DirtyTreePackageGroup;
  generatedOutput: boolean;
};

export type DirtyTreeGroupReport = {
  group: DirtyTreePackageGroup;
  paths: string[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
};

export type DirtyTreeHygieneReport = {
  clean: boolean;
  risk: DirtyTreeRisk;
  entries: DirtyTreeStatusEntry[];
  groups: DirtyTreeGroupReport[];
  sourceGroups: DirtyTreeGroupReport[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  generatedOutputCount: number;
  packageBoundaryCount: number;
  broadMixed: boolean;
  summary: string;
};

export function buildDirtyTreeHygieneReport(statusShortOutput: string): DirtyTreeHygieneReport {
  const entries = parseGitStatusShort(statusShortOutput);
  const groupMap = new Map<DirtyTreePackageGroup, DirtyTreeStatusEntry[]>();
  for (const entry of entries) {
    const existing = groupMap.get(entry.group) ?? [];
    existing.push(entry);
    groupMap.set(entry.group, existing);
  }
  const groups = [...groupMap.entries()]
    .map(([group, groupEntries]) => ({
      group,
      paths: groupEntries.map((entry) => entry.path).toSorted(),
      stagedCount: groupEntries.filter((entry) => entry.staged).length,
      unstagedCount: groupEntries.filter((entry) => entry.unstaged).length,
      untrackedCount: groupEntries.filter((entry) => entry.untracked).length,
    }))
    .toSorted((left, right) => left.group.localeCompare(right.group));
  const sourceGroups = groups.filter((group) => group.group !== "generated-output");
  const stagedCount = entries.filter((entry) => entry.staged).length;
  const unstagedCount = entries.filter((entry) => entry.unstaged).length;
  const untrackedCount = entries.filter((entry) => entry.untracked).length;
  const generatedOutputCount = entries.filter((entry) => entry.generatedOutput).length;
  const packageBoundaryCount = sourceGroups.length;
  const broadMixed = packageBoundaryCount > 1;
  const risk: DirtyTreeRisk =
    entries.length === 0 ? "clean" : broadMixed ? "broad-mixed" : "single-package";
  return {
    clean: entries.length === 0,
    risk,
    entries,
    groups,
    sourceGroups,
    stagedCount,
    unstagedCount,
    untrackedCount,
    generatedOutputCount,
    packageBoundaryCount,
    broadMixed,
    summary: buildDirtyTreeSummary({
      entries,
      groups: sourceGroups,
      stagedCount,
      unstagedCount,
      untrackedCount,
      generatedOutputCount,
    }),
  };
}

export function parseGitStatusShort(statusShortOutput: string): DirtyTreeStatusEntry[] {
  return statusShortOutput
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parseGitStatusShortLine);
}

function parseGitStatusShortLine(line: string): DirtyTreeStatusEntry {
  const indexStatus = line[0] ?? " ";
  const worktreeStatus = line[1] ?? " ";
  const rawPath = line.slice(3);
  const renameMatch = rawPath.match(/^(?<original>.+) -> (?<next>.+)$/u);
  const path = renameMatch?.groups?.next ?? rawPath;
  const originalPath = renameMatch?.groups?.original;
  const untracked = indexStatus === "?" && worktreeStatus === "?";
  return {
    path,
    ...(originalPath ? { originalPath } : {}),
    indexStatus,
    worktreeStatus,
    staged: !untracked && indexStatus !== " " && indexStatus !== "?",
    unstaged: !untracked && worktreeStatus !== " " && worktreeStatus !== "?",
    untracked,
    group: classifyDirtyTreePackageGroup(path),
    generatedOutput: isGeneratedOutputPath(path),
  };
}

export function isGeneratedOutputPath(path: string): boolean {
  return (
    path.startsWith("dist/") ||
    path.startsWith("dist-runtime/") ||
    path.startsWith("coverage/") ||
    /^dist(?:-runtime)?\.broken-/u.test(path) ||
    path.includes("/dist/") ||
    path.endsWith(".tsbuildinfo") ||
    path.endsWith(".log") ||
    path.startsWith("var/") ||
    path.startsWith("file_hub/exports/")
  );
}

export function classifyDirtyTreePackageGroup(path: string): DirtyTreePackageGroup {
  if (isGeneratedOutputPath(path)) {
    return "generated-output";
  }
  if (path.startsWith("extensions/codex/src/app-server/")) {
    return "codex-app-server";
  }
  if (path.startsWith("extensions/memory-core/") || path.startsWith("packages/memory-host-sdk/")) {
    return "memory-qmd";
  }
  if (
    path.includes("grant-retirement") ||
    path.includes("grant-hardening") ||
    path.includes("grant-blind-test")
  ) {
    return "grant-retirement";
  }
  if (
    path.includes("active-production-watchdog") ||
    path.includes("production-owner-lane") ||
    path.includes("heartbeat-runner") ||
    path.includes("heartbeat-wake") ||
    path.includes("message-action-runner")
  ) {
    return "production-flow-watchdog";
  }
  if (
    path.startsWith("src/tasks/") ||
    path.startsWith("src/plugins/runtime/") ||
    path.startsWith("src/plugin-sdk/agent-harness-task-runtime") ||
    path.startsWith("src/commands/flows")
  ) {
    return "taskflow-state";
  }
  if (
    path === "package.json" ||
    path === "tsconfig.json" ||
    path.startsWith("scripts/") ||
    path.startsWith("test/scripts/") ||
    path.includes("runtime-asset-guard") ||
    path.includes("tsdown-build") ||
    path.includes("run-vitest") ||
    path.includes("pnpm-runner")
  ) {
    return "runtime-build-tooling";
  }
  if (path.includes("session-status") || path.includes("sessions-") || path.includes("sessions.")) {
    return "session-control";
  }
  if (
    path.startsWith("src/agents/") ||
    path.startsWith("src/acp/control-plane/") ||
    path.includes("subagent") ||
    path.includes("embedded-agent")
  ) {
    return "agent-subagent-runtime";
  }
  if (
    path.startsWith("src/auto-reply/") ||
    path.startsWith("src/gateway/") ||
    path.startsWith("src/routing/")
  ) {
    return "gateway-auto-reply-routing";
  }
  if (path.startsWith("src/state/")) {
    return "state-schema-storage";
  }
  if (
    path.startsWith("src/cli/") ||
    path.startsWith("src/config/") ||
    path.startsWith("src/cron/") ||
    path.startsWith("src/infra/") ||
    path.startsWith("src/crestodian/") ||
    path.startsWith("src/secrets/") ||
    path.startsWith("src/status/")
  ) {
    return "cli-config-cron-infra";
  }
  return "unknown";
}

function buildDirtyTreeSummary(params: {
  entries: DirtyTreeStatusEntry[];
  groups: DirtyTreeGroupReport[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  generatedOutputCount: number;
}): string {
  if (params.entries.length === 0) {
    return "clean";
  }
  const groupList = params.groups.map((group) => group.group).join(", ");
  return [
    `${params.entries.length} dirty entr${params.entries.length === 1 ? "y" : "ies"}`,
    `${params.groups.length} package boundar${params.groups.length === 1 ? "y" : "ies"}`,
    `staged=${params.stagedCount}`,
    `unstaged=${params.unstagedCount}`,
    `untracked=${params.untrackedCount}`,
    `generated_output=${params.generatedOutputCount}`,
    `groups=${groupList}`,
  ].join("; ");
}
