import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();
const addGatewayClientOptions = vi.fn((command: Command) => command);

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions,
  callGatewayFromCli,
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime,
  writeRuntimeJson: (runtime: { log: (...args: unknown[]) => void }, value: unknown, space = 2) =>
    runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined)),
}));

const { registerSystemCli } = await import("./system-cli.js");

function gatewayCall(callIndex = 0): ReadonlyArray<unknown> {
  const call = callGatewayFromCli.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected gateway call ${callIndex + 1}`);
  }
  return call;
}

describe("system-cli", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSystemCli(program);
    try {
      await program.parseAsync(args, { from: "user" });
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("__exit__:"))) {
        throw err;
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("runs system event with default wake mode and text output", async () => {
    await runCli(["system", "event", "--text", "  hello world  "]);

    const [method, payload, options, requestOptions] = gatewayCall();
    expect(method).toBe("wake");
    expect((payload as { text?: string } | undefined)?.text).toBe("  hello world  ");
    expect(options).toEqual({ mode: "next-heartbeat", text: "hello world" });
    expect(requestOptions).toEqual({ expectFinal: false });
    expect(runtimeLogs).toEqual(["ok"]);
  });

  it("prints JSON for event when --json is enabled", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ id: "wake-1" });

    await runCli(["system", "event", "--text", "hello", "--json"]);

    expect(runtimeLogs).toEqual([JSON.stringify({ id: "wake-1" }, null, 2)]);
  });

  it("handles invalid wake mode as runtime error", async () => {
    await runCli(["system", "event", "--text", "hello", "--mode", "later"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors[0]).toContain("--mode must be now or next-heartbeat");
  });

  it("forwards --session-key on system event", async () => {
    await runCli([
      "system",
      "event",
      "--text",
      "ping",
      "--session-key",
      "agent:main:telegram:dm:42",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const [method, gatewayOptions, params, requestOptions] = gatewayCall();
    expect(method).toBe("wake");
    expect(typeof gatewayOptions).toBe("object");
    expect(params).toEqual({
      mode: "next-heartbeat",
      text: "ping",
      sessionKey: "agent:main:telegram:dm:42",
    });
    expect(requestOptions).toEqual({ expectFinal: false });
  });

  it("omits sessionKey from payload when --session-key not provided", async () => {
    await runCli(["system", "event", "--text", "ping"]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const params = gatewayCall()[2];
    expect(params).not.toHaveProperty("sessionKey");
  });

  it("treats empty --session-key as omitted", async () => {
    await runCli(["system", "event", "--text", "ping", "--session-key", "  "]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const params = gatewayCall()[2];
    expect(params).not.toHaveProperty("sessionKey");
  });

  it.each([
    { args: ["system", "heartbeat", "last"], method: "last-heartbeat", params: undefined },
    {
      args: ["system", "heartbeat", "enable"],
      method: "set-heartbeats",
      params: { enabled: true },
    },
    {
      args: ["system", "heartbeat", "disable"],
      method: "set-heartbeats",
      params: { enabled: false },
    },
    { args: ["system", "presence"], method: "system-presence", params: undefined },
  ])("routes $args to gateway", async ({ args, method, params }) => {
    callGatewayFromCli.mockResolvedValueOnce({ method });

    await runCli(args);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const [calledMethod, gatewayOptions, calledParams, requestOptions] = gatewayCall();
    expect(calledMethod).toBe(method);
    expect(typeof gatewayOptions).toBe("object");
    expect(calledParams).toEqual(params);
    expect(requestOptions).toEqual({ expectFinal: false });
    expect(runtimeLogs).toEqual([JSON.stringify({ method }, null, 2)]);
  });

  it("creates a Grant retirement request through the real system subcommand", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "system-cli-grant-retirement-"));
    try {
      fs.mkdirSync(path.join(workspaceDir, "docs", "grant"), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, "contracts", "grant"), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, "templates", "grant"), { recursive: true });
      const proofPath = path.join(workspaceDir, "proof.txt");
      fs.writeFileSync(proofPath, "proof", "utf8");
      fs.writeFileSync(
        path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
        [
          "# Grant Doctrine",
          "",
          "Grant hardening v1 may be called closed only for the current scoped hardening build.",
          "Grant remains a bounded governed execution owner under Will.",
          "Will remains the packet-sharpening and top command layer.",
          "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
          "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
        "# Grant Corrections Matrix\n\n## Active corrections\n\n### GC-001: Do not smooth over ambiguity\n",
        "utf8",
      );
      fs.writeFileSync(
        path.join(workspaceDir, "contracts", "grant", "grant_hardening_operating_contract.json"),
        `${JSON.stringify(
          {
            boundary_lock: {
              scoped_closeout_rule:
                "Grant hardening v1 may be called closed only for the current scoped hardening build.",
              owner_rule: "Grant remains a bounded governed execution owner under Will.",
              command_rule: "Will remains the packet-sharpening and top command layer.",
              ambiguity_rule:
                "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
              promotion_rule:
                "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      fs.writeFileSync(
        path.join(
          workspaceDir,
          "templates",
          "grant",
          "grant_correction_retirement_request_template.json",
        ),
        `${JSON.stringify(
          {
            schema_version: "0.1.0",
            artifact_type: "grant_correction_retirement_request",
            requestedBy: "Will",
            approvedBy: "Will",
            outcomeCode: "",
            reason: "obsolete_rule",
            evidence: "",
            resolutionProofPaths: [],
            notes: "",
            requestedAt: "",
            approvedAt: "",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await runCli([
        "system",
        "grant",
        "retirement-request",
        "--workspace",
        workspaceDir,
        "--outcome-code",
        "rejected_proof_missing",
        "--reason",
        "capability_materially_fixed",
        "--evidence",
        "CLI command proof",
        "--proof-path",
        proofPath,
      ]);

      expect(callGatewayFromCli).not.toHaveBeenCalled();
      const requestLine = runtimeLogs.find((line) => line.startsWith("request: "));
      const queueLine = runtimeLogs.find((line) => line.startsWith("queue: "));
      expect(requestLine).toBeTruthy();
      expect(queueLine).toBeTruthy();
      const requestPath = requestLine?.slice("request: ".length) ?? "";
      const queuePath = queueLine?.slice("queue: ".length) ?? "";
      expect(fs.existsSync(requestPath)).toBe(true);
      expect(fs.existsSync(queuePath)).toBe(true);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("prints JSON for Grant retirement requests when --json is enabled", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "system-cli-grant-retirement-json-"),
    );
    try {
      fs.mkdirSync(path.join(workspaceDir, "docs", "grant"), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, "contracts", "grant"), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, "templates", "grant"), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
        [
          "# Grant Doctrine",
          "",
          "Grant hardening v1 may be called closed only for the current scoped hardening build.",
          "Grant remains a bounded governed execution owner under Will.",
          "Will remains the packet-sharpening and top command layer.",
          "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
          "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
        "# Grant Corrections Matrix\n\n## Active corrections\n\n### GC-001: Do not smooth over ambiguity\n",
        "utf8",
      );
      fs.writeFileSync(
        path.join(workspaceDir, "contracts", "grant", "grant_hardening_operating_contract.json"),
        `${JSON.stringify(
          {
            boundary_lock: {
              scoped_closeout_rule:
                "Grant hardening v1 may be called closed only for the current scoped hardening build.",
              owner_rule: "Grant remains a bounded governed execution owner under Will.",
              command_rule: "Will remains the packet-sharpening and top command layer.",
              ambiguity_rule:
                "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
              promotion_rule:
                "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      fs.writeFileSync(
        path.join(
          workspaceDir,
          "templates",
          "grant",
          "grant_correction_retirement_request_template.json",
        ),
        `${JSON.stringify(
          {
            schema_version: "0.1.0",
            artifact_type: "grant_correction_retirement_request",
            requestedBy: "Will",
            approvedBy: "Will",
            outcomeCode: "",
            reason: "obsolete_rule",
            evidence: "",
            resolutionProofPaths: [],
            notes: "",
            requestedAt: "",
            approvedAt: "",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await runCli([
        "system",
        "grant",
        "retirement-request",
        "--workspace",
        workspaceDir,
        "--outcome-code",
        "rejected_proof_missing",
        "--reason",
        "false_positive_pattern",
        "--evidence",
        "json output",
        "--dry-run",
        "--json",
      ]);

      expect(runtimeLogs).toHaveLength(1);
      expect(runtimeLogs[0]).toContain('"ok": true');
      expect(runtimeLogs[0]).toContain('"dryRun": true');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
