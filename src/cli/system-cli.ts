import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import type { GatewayRpcOpts } from "./gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";
import { createGrantRetirementRequest } from "./grant-retirement-request.js";

type SystemEventOpts = GatewayRpcOpts & {
  text?: string;
  mode?: string;
  sessionKey?: string;
  json?: boolean;
};
type SystemGatewayOpts = GatewayRpcOpts & { json?: boolean };
type SystemGrantRetirementRequestOpts = {
  workspace?: string;
  outcomeCode?: string;
  reason?: string;
  evidence?: string;
  proofPath?: string[];
  notes?: string;
  requestedAt?: string;
  approvedAt?: string;
  dryRun?: boolean;
  json?: boolean;
};

const normalizeWakeMode = (raw: unknown) => {
  const mode = normalizeOptionalString(raw) ?? "";
  if (!mode) {
    return "next-heartbeat" as const;
  }
  if (mode === "now" || mode === "next-heartbeat") {
    return mode;
  }
  throw new Error("--mode must be now or next-heartbeat");
};

async function runSystemGatewayCommand(
  opts: SystemGatewayOpts,
  action: () => Promise<unknown>,
  successText?: string,
): Promise<void> {
  try {
    const result = await action();
    if (opts.json || successText === undefined) {
      defaultRuntime.writeJson(result);
    } else {
      defaultRuntime.log(successText);
    }
  } catch (err) {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  }
}

export function registerSystemCli(program: Command) {
  const system = program
    .command("system")
    .description("System tools (events, heartbeat, presence)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/system", "docs.openclaw.ai/cli/system")}\n`,
    );

  addGatewayClientOptions(
    system
      .command("event")
      .description("Enqueue a system event and optionally trigger a heartbeat")
      .requiredOption("--text <text>", "System event text")
      .option("--mode <mode>", "Wake mode (now|next-heartbeat)", "next-heartbeat")
      .option(
        "--session-key <sessionKey>",
        "Target a specific session for the event (defaults to the agent's main session)",
      )
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemEventOpts) => {
    await runSystemGatewayCommand(
      opts,
      async () => {
        const text = normalizeOptionalString(opts.text) ?? "";
        if (!text) {
          throw new Error(
            `--text is required. Example: ${formatCliCommand('openclaw system event --text "deploy finished"')}.`,
          );
        }
        const mode = normalizeWakeMode(opts.mode);
        const sessionKey = normalizeOptionalString(opts.sessionKey);
        return await callGatewayFromCli(
          "wake",
          opts,
          sessionKey ? { mode, text, sessionKey } : { mode, text },
          { expectFinal: false },
        );
      },
      "ok",
    );
  });

  const heartbeat = system.command("heartbeat").description("Heartbeat controls");

  addGatewayClientOptions(
    heartbeat
      .command("last")
      .description("Show the last heartbeat event")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemGatewayOpts) => {
    await runSystemGatewayCommand(opts, async () => {
      return await callGatewayFromCli("last-heartbeat", opts, undefined, {
        expectFinal: false,
      });
    });
  });

  addGatewayClientOptions(
    heartbeat
      .command("enable")
      .description("Enable heartbeats")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemGatewayOpts) => {
    await runSystemGatewayCommand(opts, async () => {
      return await callGatewayFromCli(
        "set-heartbeats",
        opts,
        { enabled: true },
        { expectFinal: false },
      );
    });
  });

  addGatewayClientOptions(
    heartbeat
      .command("disable")
      .description("Disable heartbeats")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemGatewayOpts) => {
    await runSystemGatewayCommand(opts, async () => {
      return await callGatewayFromCli(
        "set-heartbeats",
        opts,
        { enabled: false },
        { expectFinal: false },
      );
    });
  });

  addGatewayClientOptions(
    system
      .command("presence")
      .description("List system presence entries")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemGatewayOpts) => {
    await runSystemGatewayCommand(opts, async () => {
      return await callGatewayFromCli("system-presence", opts, undefined, {
        expectFinal: false,
      });
    });
  });

  const grant = system.command("grant").description("Grant hardening tools");

  grant
    .command("retirement-request")
    .description("Create and enqueue a Grant correction retirement request")
    .requiredOption("--workspace <path>", "Workspace that owns the Grant retirement files")
    .requiredOption("--outcome-code <code>", "Generated Grant correction outcome code to retire")
    .requiredOption(
      "--reason <reason>",
      "Retirement reason (obsolete_rule|superseded_by_higher_quality_rule|false_positive_pattern|capability_materially_fixed)",
    )
    .option("--evidence <text>", "Plain-English retirement evidence")
    .option("--proof-path <path...>", "Optional supporting proof path(s)")
    .option("--notes <text>", "Optional operator note")
    .option("--requested-at <iso>", "Optional request timestamp override")
    .option("--approved-at <iso>", "Optional approval timestamp override")
    .option("--dry-run", "Preview without writing files", false)
    .option("--json", "Output JSON", false)
    .action(async (opts: SystemGrantRetirementRequestOpts) => {
      try {
        const result = await createGrantRetirementRequest({
          workspace: normalizeOptionalString(opts.workspace) ?? "",
          outcomeCode: normalizeOptionalString(opts.outcomeCode) ?? "",
          reason: normalizeOptionalString(opts.reason) ?? "",
          evidence: opts.evidence,
          proofPaths: opts.proofPath ?? [],
          notes: opts.notes,
          requestedAt: opts.requestedAt,
          approvedAt: opts.approvedAt,
          dryRun: opts.dryRun === true,
        });
        if (opts.json) {
          defaultRuntime.writeJson(result);
        } else {
          defaultRuntime.log(`request: ${result.requestPath}`);
          defaultRuntime.log(`queue: ${result.queuePath}`);
          if (result.dryRun) {
            defaultRuntime.log("dry-run");
          }
        }
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
