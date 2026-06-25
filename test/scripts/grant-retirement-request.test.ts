import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "grant-retirement-request.mjs");
const { createTempDir } = createScriptTestHarness();

function createGrantWorkspace() {
  const workspaceDir = createTempDir("grant-retirement-request-");
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
  return workspaceDir;
}

describe("scripts/grant-retirement-request", () => {
  it("is exposed as a first-class package script", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["grant:retirement-request"]).toBe(
      "node scripts/grant-retirement-request.mjs",
    );
  });

  it("creates the canonical request artifact and queue entry", () => {
    const workspaceDir = createGrantWorkspace();
    const proofPath = path.join(workspaceDir, "proof.txt");
    fs.writeFileSync(proofPath, "proof", "utf8");

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--workspace",
        workspaceDir,
        "--outcome-code",
        "rejected_proof_missing",
        "--reason",
        "capability_materially_fixed",
        "--evidence",
        "The runtime behavior is now materially fixed.",
        "--proof-path",
        proofPath,
        "--notes",
        "operator path test",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const stdout = JSON.parse(result.stdout) as {
      ok: boolean;
      requestPath: string;
      queuePath: string;
      outcomeCode: string;
      reason: string;
    };
    expect(stdout.ok).toBe(true);
    expect(stdout.outcomeCode).toBe("rejected_proof_missing");
    expect(stdout.reason).toBe("capability_materially_fixed");

    const requestArtifact = JSON.parse(fs.readFileSync(stdout.requestPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(requestArtifact.artifact_type).toBe("grant_correction_retirement_request");
    expect(requestArtifact.outcomeCode).toBe("rejected_proof_missing");
    expect(requestArtifact.reason).toBe("capability_materially_fixed");
    expect(requestArtifact.evidence).toBe("The runtime behavior is now materially fixed.");
    expect(requestArtifact.grantRulebook).toMatchObject({
      doctrinePath: path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
      correctionsPath: path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
      contractPath: path.join(
        workspaceDir,
        "contracts",
        "grant",
        "grant_hardening_operating_contract.json",
      ),
    });

    const queueLines = fs.readFileSync(stdout.queuePath, "utf8").trim().split("\n").filter(Boolean);
    expect(queueLines).toHaveLength(1);
    const queueEntry = JSON.parse(queueLines[0]) as Record<string, unknown>;
    expect(queueEntry.outcomeCode).toBe("rejected_proof_missing");
    expect(queueEntry.requestPath).toBe(stdout.requestPath);
    expect(queueEntry.grantRulebook).toMatchObject({
      doctrinePath: path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
      correctionsPath: path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"),
    });
  });

  it("supports dry-run without writing files", () => {
    const workspaceDir = createGrantWorkspace();

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--workspace",
        workspaceDir,
        "--outcome-code",
        "rejected_proof_missing",
        "--reason",
        "false_positive_pattern",
        "--evidence",
        "Dry run only.",
        "--dry-run",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const stdout = JSON.parse(result.stdout) as {
      dryRun: boolean;
      requestPath: string;
      queuePath: string;
    };
    expect(stdout.dryRun).toBe(true);
    expect(fs.existsSync(stdout.requestPath)).toBe(false);
    expect(fs.existsSync(stdout.queuePath)).toBe(false);
  });

  it("fails closed when the template is missing", () => {
    const workspaceDir = createGrantWorkspace();
    fs.rmSync(
      path.join(
        workspaceDir,
        "templates",
        "grant",
        "grant_correction_retirement_request_template.json",
      ),
    );

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--workspace",
        workspaceDir,
        "--outcome-code",
        "rejected_proof_missing",
        "--reason",
        "capability_materially_fixed",
        "--evidence",
        "Missing template test.",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("retirement request template missing or unreadable");
  });

  it("fails closed when the Grant corrections matrix is missing", () => {
    const workspaceDir = createGrantWorkspace();
    fs.rmSync(path.join(workspaceDir, "docs", "grant", "grant_corrections_matrix.md"));

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--workspace",
        workspaceDir,
        "--outcome-code",
        "rejected_proof_missing",
        "--reason",
        "capability_materially_fixed",
        "--evidence",
        "Missing corrections test.",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Grant corrections matrix missing or unreadable");
  });

  it("fails closed when the Grant doctrine is stale and missing the boundary rule", () => {
    const workspaceDir = createGrantWorkspace();
    fs.writeFileSync(
      path.join(workspaceDir, "docs", "grant", "grant_doctrine.md"),
      "# Grant Doctrine\nOld doctrine body only.\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--workspace",
        workspaceDir,
        "--outcome-code",
        "rejected_proof_missing",
        "--reason",
        "capability_materially_fixed",
        "--evidence",
        "Missing boundary rule test.",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Grant doctrine missing required boundary rule");
  });

  it("prints usage through the package script entrypoint", () => {
    const result = spawnSync("npm", ["run", "-s", "grant:retirement-request", "--", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("grant-retirement-request.mjs");
  });
});
