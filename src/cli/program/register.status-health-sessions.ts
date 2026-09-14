import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { setVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";
import { parsePositiveIntOrUndefined, parseStrictPositiveIntOrUndefined } from "./helpers.js";

function resolveVerbose(opts: { verbose?: boolean; debug?: boolean }): boolean {
  return Boolean(opts.verbose || opts.debug);
}

type SessionsListCliOptions = {
  json?: boolean;
  verbose?: boolean;
  store?: string;
  agent?: string;
  allAgents?: boolean;
  active?: string;
  limit?: string;
};

function createModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}

const loadCommitmentsCommands = createModuleLoader(() => import("../../commands/commitments.js"));
const loadTasksCommands = createModuleLoader(() => import("../../commands/tasks.js"));
const loadFlowsCommands = createModuleLoader(() => import("../../commands/flows.js"));

function addSessionsListOptions(command: Command): Command {
  return command
    .option("--json", "Output as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .option("--store <path>", "Path to session store (default: resolved from config)")
    .option("--agent <id>", "Agent id to inspect (default: configured default agent)")
    .option("--all-agents", "Aggregate sessions across all configured agents", false)
    .option("--active <minutes>", "Only show sessions updated within the past N minutes")
    .option("--limit <count>", 'Max sessions to show (default: 100; use "all" for full output)');
}

function mergeSessionsListOptions(
  opts: SessionsListCliOptions,
  parentOpts?: SessionsListCliOptions,
): SessionsListCliOptions {
  return {
    json: Boolean(opts.json || parentOpts?.json),
    verbose: Boolean(opts.verbose || parentOpts?.verbose),
    store: opts.store ?? parentOpts?.store,
    agent: opts.agent ?? parentOpts?.agent,
    allAgents: Boolean(opts.allAgents || parentOpts?.allAgents),
    active: opts.active ?? parentOpts?.active,
    limit: opts.limit ?? parentOpts?.limit,
  };
}

async function runSessionsListCli(opts: SessionsListCliOptions): Promise<void> {
  setVerbose(Boolean(opts.verbose));
  const { sessionsCommand } = await import("../../commands/sessions.js");
  await sessionsCommand(
    {
      json: Boolean(opts.json),
      store: opts.store,
      agent: opts.agent,
      allAgents: Boolean(opts.allAgents),
      active: opts.active,
      limit: opts.limit,
    },
    defaultRuntime,
  );
}

function parseTimeoutMs(timeout: unknown): number | null | undefined {
  const parsed = parsePositiveIntOrUndefined(timeout);
  if (timeout !== undefined && parsed === undefined) {
    defaultRuntime.error("--timeout must be a positive integer (milliseconds)");
    defaultRuntime.exit(1);
    return null;
  }
  return parsed;
}

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function hasJsonOption(opts: { json?: boolean }, command?: Command): boolean {
  return Boolean(
    opts.json || command?.parent?.opts()?.json || command?.parent?.parent?.opts()?.json,
  );
}

function parseTasksAuditLimit(limit: unknown): number | null | undefined {
  const parsed = parseStrictPositiveIntOrUndefined(limit);
  if (limit !== undefined && parsed === undefined) {
    defaultRuntime.error("--limit must be a positive integer, for example --limit 25.");
    defaultRuntime.exit(1);
    return null;
  }
  return parsed;
}

async function runWithVerboseAndTimeout(
  opts: { verbose?: boolean; debug?: boolean; timeout?: unknown },
  action: (params: { verbose: boolean; timeoutMs: number | undefined }) => Promise<void>,
): Promise<void> {
  const verbose = resolveVerbose(opts);
  setVerbose(verbose);
  const timeoutMs = parseTimeoutMs(opts.timeout);
  if (timeoutMs === null) {
    return;
  }
  await runCommandWithRuntime(defaultRuntime, async () => {
    await action({ verbose, timeoutMs });
  });
}

export function registerStatusHealthSessionsCommands(program: Command) {
  program
    .command("status")
    .description("Show channel health and recent session recipients")
    .option("--json", "Output JSON instead of text", false)
    .option("--all", "Full diagnosis (read-only, pasteable)", false)
    .option("--usage", "Show model provider usage/quota snapshots", false)
    .option("--deep", "Probe channels (WhatsApp Web + Telegram + Discord + Slack + Signal)", false)
    .option("--timeout <ms>", "Probe timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .option("--debug", "Alias for --verbose", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw status", "Show channel health + session summary."],
          ["openclaw status --all", "Full diagnosis (read-only)."],
          ["openclaw status --json", "Machine-readable output."],
          ["openclaw status --usage", "Show model provider usage/quota snapshots."],
          [
            "openclaw status --deep",
            "Run channel probes (WA + Telegram + Discord + Slack + Signal).",
          ],
          ["openclaw status --deep --timeout 5000", "Tighten probe timeout."],
        ])}`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/status", "docs.openclaw.ai/cli/status")}\n`,
    )
    .action(async (opts) => {
      await runWithVerboseAndTimeout(opts, async ({ verbose, timeoutMs }) => {
        const { statusCommand } = await import("../../commands/status.js");
        await statusCommand(
          {
            json: Boolean(opts.json),
            all: Boolean(opts.all),
            deep: Boolean(opts.deep),
            usage: Boolean(opts.usage),
            timeoutMs,
            verbose,
          },
          defaultRuntime,
        );
      });
    });

  program
    .command("health")
    .description("Fetch health from the running gateway")
    .option("--json", "Output JSON instead of text", false)
    .option("--timeout <ms>", "Connection timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .option("--debug", "Alias for --verbose", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/health", "docs.openclaw.ai/cli/health")}\n`,
    )
    .action(async (opts, command) => {
      await runWithVerboseAndTimeout(opts, async ({ verbose, timeoutMs }) => {
        const { healthCommand } = await import("../../commands/health.js");
        await healthCommand(
          {
            json: hasJsonOption(opts, command),
            timeoutMs,
            verbose,
          },
          defaultRuntime,
        );
      });
    });

  const sessionsCmd = addSessionsListOptions(
    program.command("sessions").description("List stored conversation sessions"),
  )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw sessions", "List all sessions."],
          ["openclaw sessions --agent work", "List sessions for one agent."],
          ["openclaw sessions --all-agents", "Aggregate sessions across agents."],
          ["openclaw sessions --active 120", "Only last 2 hours."],
          ["openclaw sessions --limit 25", "Show the newest 25 sessions."],
          ["openclaw sessions --json", "Machine-readable output."],
          ["openclaw sessions --store ./tmp/sessions.json", "Use a specific session store."],
        ])}\n\n${theme.muted(
          "Shows token usage per session when the agent reports it; set agents.defaults.contextTokens to cap the window and show %.",
        )}`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/sessions", "docs.openclaw.ai/cli/sessions")}\n`,
    )
    .action(async (opts) => {
      await runSessionsListCli(opts as SessionsListCliOptions);
    });
  sessionsCmd.enablePositionalOptions();

  addSessionsListOptions(
    sessionsCmd.command("list").description("List stored conversation sessions"),
  ).action(async (opts, command) => {
    const parentOpts = command.parent?.opts() as SessionsListCliOptions | undefined;
    await runSessionsListCli(mergeSessionsListOptions(opts as SessionsListCliOptions, parentOpts));
  });

  sessionsCmd
    .command("cleanup")
    .description("Run session-store maintenance now")
    .option("--store <path>", "Path to session store (default: resolved from config)")
    .option("--agent <id>", "Agent id to maintain (default: configured default agent)")
    .option("--all-agents", "Run maintenance across all configured agents", false)
    .option("--dry-run", "Preview maintenance actions without writing", false)
    .option("--enforce", "Apply maintenance even when configured mode is warn", false)
    .option(
      "--fix-missing",
      "Remove store entries whose transcript files are missing (bypasses age/count retention)",
      false,
    )
    .option(
      "--fix-dm-scope",
      "Retire stale direct-DM session rows that no longer match session.dmScope=main",
      false,
    )
    .option("--active-key <key>", "Protect this session key from budget-eviction")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw sessions cleanup --dry-run", "Preview stale/cap cleanup."],
          [
            "openclaw sessions cleanup --dry-run --fix-missing",
            "Also preview pruning entries with missing transcript files.",
          ],
          [
            "openclaw sessions cleanup --dry-run --fix-dm-scope",
            "Preview stale direct-DM rows after returning dmScope to main.",
          ],
          ["openclaw sessions cleanup --enforce", "Apply maintenance now."],
          ["openclaw sessions cleanup --agent work --dry-run", "Preview one agent store."],
          ["openclaw sessions cleanup --all-agents --dry-run", "Preview all agent stores."],
          [
            "openclaw sessions cleanup --enforce --store ./tmp/sessions.json",
            "Use a specific store.",
          ],
        ])}`,
    )
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as
        | {
            store?: string;
            agent?: string;
            allAgents?: boolean;
            json?: boolean;
          }
        | undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { sessionsCleanupCommand } = await import("../../commands/sessions-cleanup.js");
        await sessionsCleanupCommand(
          {
            store: (opts.store as string | undefined) ?? parentOpts?.store,
            agent: (opts.agent as string | undefined) ?? parentOpts?.agent,
            allAgents: Boolean(opts.allAgents || parentOpts?.allAgents),
            dryRun: Boolean(opts.dryRun),
            enforce: Boolean(opts.enforce),
            fixMissing: Boolean(opts.fixMissing),
            fixDmScope: Boolean(opts.fixDmScope),
            activeKey: opts.activeKey as string | undefined,
            json: Boolean(opts.json || parentOpts?.json),
          },
          defaultRuntime,
        );
      });
    });

  sessionsCmd
    .command("tail")
    .description("Tail human-readable session trajectory progress")
    .option("--session-key <key>", "Session key to tail (default: active sessions or latest)")
    .option("--tail <count>", "Number of existing trajectory events to show", "80")
    .option("--follow", "Continue following for new trajectory events", false)
    .option("--store <path>", "Path to session store (default: resolved from config)")
    .option("--agent <id>", "Agent id to inspect (default: configured default agent)")
    .option("--all-agents", "Aggregate sessions across all configured agents", false)
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as
        | {
            store?: string;
            agent?: string;
            allAgents?: boolean;
          }
        | undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { sessionsTailCommand } = await import("../../commands/sessions-tail.js");
        await sessionsTailCommand(
          {
            sessionKey: opts.sessionKey as string | undefined,
            store: (opts.store as string | undefined) ?? parentOpts?.store,
            agent: (opts.agent as string | undefined) ?? parentOpts?.agent,
            allAgents: Boolean(opts.allAgents || parentOpts?.allAgents),
            follow: Boolean(opts.follow),
            tail: opts.tail as string | undefined,
          },
          defaultRuntime,
        );
      });
    });

  sessionsCmd
    .command("export-trajectory")
    .description("Export a redacted trajectory bundle for a stored session")
    .option("--session-key <key>", "Session key to export")
    .option("--output <path>", "Output directory name inside .openclaw/trajectory-exports")
    .option("--workspace <path>", "Workspace root for the export (default: current directory)")
    .option("--store <path>", "Path to session store (default: resolved from session key)")
    .option("--agent <id>", "Agent id for resolving the default session store")
    .option("--request-json-base64 <payload>", "Base64url-encoded export request")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as
        | {
            store?: string;
            agent?: string;
            json?: boolean;
          }
        | undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { exportTrajectoryCommand } = await import("../../commands/export-trajectory.js");
        await exportTrajectoryCommand(
          {
            sessionKey: opts.sessionKey as string | undefined,
            output: opts.output as string | undefined,
            workspace: opts.workspace as string | undefined,
            store: (opts.store as string | undefined) ?? parentOpts?.store,
            agent: (opts.agent as string | undefined) ?? parentOpts?.agent,
            requestJsonBase64: opts.requestJsonBase64 as string | undefined,
            json: Boolean(opts.json || parentOpts?.json),
          },
          defaultRuntime,
        );
      });
    });

  const commitmentsCmd = program
    .command("commitments")
    .description("List and manage inferred follow-up commitments")
    .option("--json", "Output JSON instead of text", false)
    .option("--agent <id>", "Agent id to inspect")
    .option("--status <status>", "Filter by status (pending, sent, dismissed, snoozed, expired)")
    .option("--all", "Show all statuses", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw commitments", "List pending inferred follow-ups."],
          ["openclaw commitments --all", "List all inferred follow-ups."],
          ["openclaw commitments --agent work", "List one agent's inferred follow-ups."],
          ["openclaw commitments dismiss cm_abc123", "Dismiss a follow-up."],
        ])}`,
    )
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { commitmentsListCommand } = await loadCommitmentsCommands();
        await commitmentsListCommand(
          {
            json: hasJsonOption(opts, command),
            agent: opts.agent as string | undefined,
            status: opts.status as string | undefined,
            all: Boolean(opts.all),
          },
          defaultRuntime,
        );
      });
    });
  commitmentsCmd.enablePositionalOptions();

  commitmentsCmd
    .command("list")
    .description("List inferred follow-up commitments")
    .option("--json", "Output JSON instead of text", false)
    .option("--agent <id>", "Agent id to inspect")
    .option("--status <status>", "Filter by status (pending, sent, dismissed, snoozed, expired)")
    .option("--all", "Show all statuses", false)
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as
        | { json?: boolean; agent?: string; status?: string; all?: boolean }
        | undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { commitmentsListCommand } = await loadCommitmentsCommands();
        await commitmentsListCommand(
          {
            json: Boolean(opts.json || parentOpts?.json),
            agent: (opts.agent as string | undefined) ?? parentOpts?.agent,
            status: (opts.status as string | undefined) ?? parentOpts?.status,
            all: Boolean(opts.all || parentOpts?.all),
          },
          defaultRuntime,
        );
      });
    });

  commitmentsCmd
    .command("dismiss <ids...>")
    .description("Dismiss inferred follow-up commitments")
    .option("--json", "Output JSON instead of text", false)
    .action(async (ids: string[], opts, command) => {
      const parentOpts = command.parent?.opts() as { json?: boolean } | undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { commitmentsDismissCommand } = await loadCommitmentsCommands();
        await commitmentsDismissCommand(
          {
            ids,
            json: Boolean(opts.json || parentOpts?.json),
          },
          defaultRuntime,
        );
      });
    });

  const tasksCmd = program
    .command("tasks")
    .description("Inspect durable background tasks and TaskFlow state")
    .option("--json", "Output as JSON", false)
    .option("--runtime <name>", "Filter by kind (subagent, acp, cron, cli)")
    .option(
      "--status <name>",
      "Filter by status (queued, running, succeeded, failed, timed_out, cancelled, lost)",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { tasksListCommand } = await loadTasksCommands();
        await tasksListCommand(
          {
            json: Boolean(opts.json),
            runtime: opts.runtime as string | undefined,
            status: opts.status as string | undefined,
          },
          defaultRuntime,
        );
      });
    });
  tasksCmd.enablePositionalOptions();

  tasksCmd
    .command("list")
    .description("List tracked background tasks")
    .option("--json", "Output as JSON", false)
    .option("--runtime <name>", "Filter by kind (subagent, acp, cron, cli)")
    .option(
      "--status <name>",
      "Filter by status (queued, running, succeeded, failed, timed_out, cancelled, lost)",
    )
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as
        | {
            json?: boolean;
            runtime?: string;
            status?: string;
          }
        | undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { tasksListCommand } = await loadTasksCommands();
        await tasksListCommand(
          {
            json: Boolean(opts.json || parentOpts?.json),
            runtime: (opts.runtime as string | undefined) ?? parentOpts?.runtime,
            status: (opts.status as string | undefined) ?? parentOpts?.status,
          },
          defaultRuntime,
        );
      });
    });

  tasksCmd
    .command("audit")
    .description("Show stale or broken background tasks and TaskFlows")
    .option("--json", "Output as JSON", false)
    .option("--severity <level>", "Filter by severity (warn, error)")
    .option(
      "--code <name>",
      "Filter by finding code (stale_queued, stale_running, lost, delivery_failed, missing_cleanup, inconsistent_timestamps, restore_failed, stale_waiting, stale_blocked, cancel_stuck, missing_linked_tasks, blocked_task_missing)",
    )
    .option("--limit <n>", "Limit displayed findings")
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as { json?: boolean } | undefined;
      const limit = parseTasksAuditLimit(opts.limit);
      if (limit === null) {
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { tasksAuditCommand } = await loadTasksCommands();
        await tasksAuditCommand(
          {
            json: Boolean(opts.json || parentOpts?.json),
            severity: opts.severity as "warn" | "error" | undefined,
            code: opts.code as
              | "stale_queued"
              | "stale_running"
              | "lost"
              | "delivery_failed"
              | "missing_cleanup"
              | "inconsistent_timestamps"
              | "restore_failed"
              | "stale_waiting"
              | "stale_blocked"
              | "cancel_stuck"
              | "missing_linked_tasks"
              | "blocked_task_missing"
              | undefined,
            limit,
          },
          defaultRuntime,
        );
      });
    });

  tasksCmd
    .command("maintenance")
    .description("Preview or apply tasks and TaskFlow maintenance")
    .option("--json", "Output as JSON", false)
    .option("--apply", "Apply reconciliation, cleanup stamping, and pruning", false)
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as { json?: boolean } | undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { tasksMaintenanceCommand } = await loadTasksCommands();
        await tasksMaintenanceCommand(
          {
            json: Boolean(opts.json || parentOpts?.json),
            apply: Boolean(opts.apply),
          },
          defaultRuntime,
        );
      });
    });

  tasksCmd
    .command("show")
    .description("Show one background task by task id, run id, or session key")
    .argument("<lookup>", "Task id, run id, or session key")
    .option("--json", "Output as JSON", false)
    .action(async (lookup, opts, command) => {
      const parentOpts = command.parent?.opts() as { json?: boolean } | undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { tasksShowCommand } = await loadTasksCommands();
        await tasksShowCommand(
          {
            lookup,
            json: Boolean(opts.json || parentOpts?.json),
          },
          defaultRuntime,
        );
      });
    });

  tasksCmd
    .command("notify")
    .description("Set task notify policy")
    .argument("<lookup>", "Task id, run id, or session key")
    .argument("<notify>", "Notify policy (done_only, state_changes, silent)")
    .action(async (lookup, notify) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { tasksNotifyCommand } = await loadTasksCommands();
        await tasksNotifyCommand(
          {
            lookup,
            notify: notify as "done_only" | "state_changes" | "silent",
          },
          defaultRuntime,
        );
      });
    });

  tasksCmd
    .command("cancel")
    .description("Cancel a running background task")
    .argument("<lookup>", "Task id, run id, or session key")
    .action(async (lookup) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { tasksCancelCommand } = await loadTasksCommands();
        await tasksCancelCommand(
          {
            lookup,
          },
          defaultRuntime,
        );
      });
    });

  const tasksFlowCmd = tasksCmd
    .command("flow")
    .description("Inspect durable TaskFlow state under tasks");

  tasksFlowCmd
    .command("start-production")
    .description("Start a managed active-production TaskFlow with required authority metadata")
    .requiredOption("--owner-key <key>", "Flow owner key")
    .requiredOption("--controller-id <id>", "Managed controller id")
    .requiredOption("--goal <text>", "TaskFlow goal")
    .requiredOption("--slice-id <id>", "Governed slice id")
    .requiredOption("--slice-owner <owner>", "Lawful slice owner")
    .requiredOption("--authority-path <path>", "Controlling authority artifact path")
    .requiredOption("--authority-basis <text>", "Authority basis for this production slice")
    .requiredOption("--build-item <item>", "Current controlling build-plan item")
    .requiredOption("--required-owner-lane <owner>", "SOP/build-plan required owner or lane")
    .requiredOption("--attempted-owner-lane <owner>", "Owner/lane the flow would run as")
    .requiredOption("--attempted-executor <executor>", "Executor attempting the work")
    .requiredOption("--executor-role <role>", "Executor role for this exact work")
    .requiredOption(
      "--lawful-route-required <route>",
      "Lawful route required when owner mismatch blocks",
    )
    .option("--current-step <step>", "Current flow step")
    .option("--blocker <code>", "Known SOP blocker code", collectOptionValue, [])
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { flowsStartProductionCommand } = await loadFlowsCommands();
        await flowsStartProductionCommand(
          {
            ownerKey: opts.ownerKey as string | undefined,
            controllerId: opts.controllerId as string | undefined,
            goal: opts.goal as string | undefined,
            sliceId: opts.sliceId as string | undefined,
            sliceOwner: opts.sliceOwner as string | undefined,
            authorityPath: opts.authorityPath as string | undefined,
            authorityBasis: opts.authorityBasis as string | undefined,
            buildItem: opts.buildItem as string | undefined,
            requiredOwnerLane: opts.requiredOwnerLane as string | undefined,
            attemptedOwnerLane: opts.attemptedOwnerLane as string | undefined,
            attemptedExecutor: opts.attemptedExecutor as string | undefined,
            executorRole: opts.executorRole as string | undefined,
            lawfulRouteRequired: opts.lawfulRouteRequired as string | undefined,
            currentStep: opts.currentStep as string | undefined,
            blocker: opts.blocker as string[] | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  tasksFlowCmd
    .command("resume-production")
    .description("Resume a managed active-production TaskFlow")
    .argument("<lookup>", "Flow id or owner key")
    .option("--current-step <step>", "Current flow step")
    .option("--json", "Output as JSON", false)
    .action(async (lookup, opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { flowsResumeProductionCommand } = await loadFlowsCommands();
        await flowsResumeProductionCommand(
          {
            lookup,
            currentStep: opts.currentStep as string | undefined,
            json: hasJsonOption(opts, command),
          },
          defaultRuntime,
        );
      });
    });

  tasksFlowCmd
    .command("lawful-stop")
    .description("Record a lawful active-production stop for a managed TaskFlow")
    .argument("<lookup>", "Flow id or owner key")
    .requiredOption(
      "--reason <reason>",
      "Stop reason (blocker, owner_decision, restart_or_reload, hard_stop, safety_stop, whole_run_complete)",
    )
    .requiredOption("--detail <text>", "Stop detail")
    .option("--current-step <step>", "Current flow step")
    .option("--finish", "Finish the flow after whole-run completion", false)
    .option("--json", "Output as JSON", false)
    .action(async (lookup, opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { flowsLawfulStopCommand } = await loadFlowsCommands();
        await flowsLawfulStopCommand(
          {
            lookup,
            reason: opts.reason as
              | "blocker"
              | "owner_decision"
              | "restart_or_reload"
              | "hard_stop"
              | "safety_stop"
              | "whole_run_complete"
              | undefined,
            detail: opts.detail as string | undefined,
            currentStep: opts.currentStep as string | undefined,
            finish: Boolean(opts.finish),
            json: hasJsonOption(opts, command),
          },
          defaultRuntime,
        );
      });
    });

  tasksFlowCmd
    .command("attach-foreground-cleanup-crew-execution")
    .description(
      "Attach the current foreground Cleanup Crew execution to its active parent TaskFlow",
    )
    .requiredOption("--owner-key <key>", "Expected parent owner key")
    .requiredOption("--session-key <key>", "Foreground executor session key")
    .option("--current-turn-text <text>", "Cleanup Crew production turn text")
    .option("--current-step <step>", "Current executable step")
    .option(
      "--checkpoint-kind <kind>",
      "Cleanup Crew checkpoint kind: tool_batch_completed, tool_error_recovery, report_boundary, validation_failure, startup_proof_batch, or milestone_delivered",
    )
    .option("--checkpoint-summary <text>", "Short checkpoint proof summary")
    .option("--next-executable-action <text>", "Next executable action after this checkpoint")
    .option("--authority-path <path>", "Authority or build-plan path")
    .option("--authority-basis <text>", "Authority basis")
    .option("--owner-lane <lane>", "Owner lane")
    .option("--json", "Output as JSON", false)
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { flowsAttachForegroundCleanupCrewExecutionCommand } = await loadFlowsCommands();
        await flowsAttachForegroundCleanupCrewExecutionCommand(
          {
            ownerKey: opts.ownerKey as string | undefined,
            sessionKey: opts.sessionKey as string | undefined,
            currentTurnText: opts.currentTurnText as string | undefined,
            currentStep: opts.currentStep as string | undefined,
            checkpointKind: opts.checkpointKind as string | undefined,
            checkpointSummary: opts.checkpointSummary as string | undefined,
            nextExecutableAction: opts.nextExecutableAction as string | undefined,
            authorityPath: opts.authorityPath as string | undefined,
            authorityBasis: opts.authorityBasis as string | undefined,
            ownerLane: opts.ownerLane as string | undefined,
            json: hasJsonOption(opts, command),
          },
          defaultRuntime,
        );
      });
    });

  tasksFlowCmd
    .command("supersede-foreground-cleanup-crew-executor")
    .description("Replace a lost foreground Cleanup Crew executor under the same parent mission")
    .argument("<lookup>", "Flow id or owner key")
    .requiredOption("--lost-task-id <id>", "Lost child task id being superseded")
    .requiredOption("--replacement-task-id <id>", "Active replacement task id or run id to bind")
    .requiredOption("--owner-key <key>", "Expected parent owner key")
    .requiredOption("--session-key <key>", "Replacement executor session key")
    .requiredOption("--current-step <step>", "Exact executable step the replacement owns")
    .option("--detail <text>", "Supersession detail")
    .option("--json", "Output as JSON", false)
    .action(async (lookup, opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { flowsSupersedeForegroundCleanupCrewExecutorCommand } = await loadFlowsCommands();
        await flowsSupersedeForegroundCleanupCrewExecutorCommand(
          {
            lookup,
            lostTaskId: opts.lostTaskId as string | undefined,
            replacementTaskId: opts.replacementTaskId as string | undefined,
            ownerKey: opts.ownerKey as string | undefined,
            sessionKey: opts.sessionKey as string | undefined,
            currentStep: opts.currentStep as string | undefined,
            detail: opts.detail as string | undefined,
            json: hasJsonOption(opts, command),
          },
          defaultRuntime,
        );
      });
    });

  tasksFlowCmd
    .command("list")
    .description("List tracked TaskFlows")
    .option("--json", "Output as JSON", false)
    .option(
      "--status <name>",
      "Filter by status (queued, running, waiting, blocked, succeeded, failed, cancelled, lost)",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { flowsListCommand } = await loadFlowsCommands();
        await flowsListCommand(
          {
            json: Boolean(opts.json),
            status: opts.status as string | undefined,
          },
          defaultRuntime,
        );
      });
    });

  tasksFlowCmd
    .command("blocked-report")
    .description("Classify blocked TaskFlow rows without mutating state")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { flowsBlockedRowsCommand } = await loadFlowsCommands();
        await flowsBlockedRowsCommand(
          {
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  tasksFlowCmd
    .command("show")
    .description("Show one TaskFlow by flow id or owner key")
    .argument("<lookup>", "Flow id or owner key")
    .option("--json", "Output as JSON", false)
    .action(async (lookup, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { flowsShowCommand } = await loadFlowsCommands();
        await flowsShowCommand(
          {
            lookup,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  tasksFlowCmd
    .command("cancel")
    .description("Cancel a running TaskFlow")
    .argument("<lookup>", "Flow id or owner key")
    .action(async (lookup) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { flowsCancelCommand } = await loadFlowsCommands();
        await flowsCancelCommand(
          {
            lookup,
          },
          defaultRuntime,
        );
      });
    });
}
