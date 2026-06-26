import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./program.js";
import {
  configureCommand,
  ensureConfigReady,
  installBaseProgramMocks,
  installSmokeProgramMocks,
  runCrestodian,
  runTui,
  runtime,
  setupCommand,
  setupWizardCommand,
} from "./program.test-mocks.js";

installBaseProgramMocks();
installSmokeProgramMocks();

vi.mock("./config-cli.js", () => ({
  registerConfigCli: (program: {
    command: (name: string) => { action: (fn: () => unknown) => void };
  }) => {
    program.command("config").action(() => configureCommand({}, runtime));
  },
  runConfigGet: vi.fn(),
  runConfigUnset: vi.fn(),
}));

describe("cli program (smoke)", () => {
  let program = createProgram();

  function createProgram() {
    return buildProgram();
  }

  async function runProgram(argv: string[]) {
    await program.parseAsync(argv, { from: "user" });
  }

  function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error("expected mock to have at least one call");
    }
    return call[0];
  }

  beforeEach(() => {
    program = createProgram();
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
    runCrestodian.mockResolvedValue(undefined);
    ensureConfigReady.mockResolvedValue(undefined);
  });

  it("registers message + status commands", () => {
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("message");
    expect(names).toContain("status");
  });

  it("runs tui with explicit timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "45000"]);
    const options = firstMockArg(runTui) as {
      timeoutMs?: number;
      forceProcessExitOnReturn?: boolean;
    };
    expect(options?.timeoutMs).toBe(45000);
    expect(options?.forceProcessExitOnReturn).toBe(true);
  });

  it("runs crestodian one-shot requests", async () => {
    await runProgram(["crestodian", "--message", "status"]);
    const options = firstMockArg(runCrestodian) as {
      message?: string;
      yes?: boolean;
      json?: boolean;
    };
    expect(options?.message).toBe("status");
    expect(options?.yes).toBe(false);
    expect(options?.json).toBe(false);
  });

  it("warns and ignores invalid tui timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "nope"]);
    expect(runtime.error).toHaveBeenCalledWith('warning: invalid --timeout-ms "nope"; ignoring');
    const options = firstMockArg(runTui) as { timeoutMs?: number };
    expect(options?.timeoutMs).toBeUndefined();
  });

  it("rejects partial tui history limits", async () => {
    await expect(runProgram(["tui", "--history-limit", "10x"])).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(
      "Error: --history-limit must be a positive integer.",
    );
    expect(runTui).not.toHaveBeenCalled();
  });

  it("runs setup wizard when wizard flags are present", async () => {
    await runProgram(["setup", "--remote-url", "ws://example"]);

    expect(setupCommand).not.toHaveBeenCalled();
    expect(setupWizardCommand).toHaveBeenCalledTimes(1);
  });

  it("runs the real system grant retirement-request flow through buildProgram", async () => {
    const originalArgv = process.argv;
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "program-smoke-grant-retirement-"));
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

      process.argv = [
        "node",
        "openclaw",
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
        "program smoke proof",
        "--proof-path",
        proofPath,
      ];
      program = createProgram();

      await runProgram(process.argv.slice(2));

      const requestsDir = path.join(workspaceDir, "var", "grant", "retirement_requests");
      const queuePath = path.join(
        workspaceDir,
        "var",
        "grant",
        "grant_correction_retirements.jsonl",
      );
      const requestFiles = fs.readdirSync(requestsDir);

      expect(requestFiles).toHaveLength(1);
      expect(
        JSON.parse(fs.readFileSync(path.join(requestsDir, requestFiles[0] ?? ""), "utf8")),
      ).toMatchObject({
        outcomeCode: "rejected_proof_missing",
        reason: "capability_materially_fixed",
        evidence: "program smoke proof",
        resolutionProofPaths: [proofPath],
      });
      expect(fs.readFileSync(queuePath, "utf8")).toContain(
        '"outcomeCode":"rejected_proof_missing"',
      );
      expect(fs.readFileSync(queuePath, "utf8")).toContain(
        `"requestPath":"${path.join(requestsDir, requestFiles[0] ?? "")}"`,
      );
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("var/grant/retirement_requests/"),
      );
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("var/grant/grant_correction_retirements.jsonl"),
      );
    } finally {
      process.argv = originalArgv;
    }
  });
});
