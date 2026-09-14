import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const GRANT_HARDENING_RELATIVE_PATHS = {
  doctrine: path.join("docs", "grant", "grant_doctrine.md"),
  corrections: path.join("docs", "grant", "grant_corrections_matrix.md"),
  contract: path.join("contracts", "grant", "grant_hardening_operating_contract.json"),
  checklist: path.join("templates", "grant", "grant_run_checklist.md"),
  closeoutGate: path.join("templates", "grant", "grant_closeout_gate.md"),
  afterActionAudit: path.join("templates", "grant", "grant_after_action_audit_template.md"),
};

const DEFAULT_BOUNDARY_LOCK = {
  scoped_closeout_rule:
    "Grant hardening v1 may be called closed only for the current scoped hardening build.",
  owner_rule: "Grant remains a bounded governed execution owner under Will.",
  command_rule: "Will remains the packet-sharpening and top command layer.",
  ambiguity_rule:
    "Grant may stop on ambiguity, but Grant is not the lawful default owner for unresolved messy ambiguity.",
  promotion_rule:
    "Grant is not low-review, not broadly autonomous, and not promoted into Will-level judgment unless separate future proof exists.",
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function readRequiredText(absPath, label) {
  try {
    const raw = await fs.readFile(absPath, "utf8");
    const text = raw.trim();
    if (!text) {
      throw new Error(`${label} is empty`);
    }
    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} missing or unreadable at ${absPath}: ${message}`, {
      cause: error,
    });
  }
}

async function readRequiredJson(absPath, label) {
  const raw = await readRequiredText(absPath, label);
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} missing or unreadable at ${absPath}: ${message}`, {
      cause: error,
    });
  }
}

function resolveBoundaryLock(contractRecord) {
  const candidate = contractRecord?.boundary_lock;
  return {
    scoped_closeout_rule:
      typeof candidate?.scoped_closeout_rule === "string" && candidate.scoped_closeout_rule.trim()
        ? candidate.scoped_closeout_rule.trim()
        : DEFAULT_BOUNDARY_LOCK.scoped_closeout_rule,
    owner_rule:
      typeof candidate?.owner_rule === "string" && candidate.owner_rule.trim()
        ? candidate.owner_rule.trim()
        : DEFAULT_BOUNDARY_LOCK.owner_rule,
    command_rule:
      typeof candidate?.command_rule === "string" && candidate.command_rule.trim()
        ? candidate.command_rule.trim()
        : DEFAULT_BOUNDARY_LOCK.command_rule,
    ambiguity_rule:
      typeof candidate?.ambiguity_rule === "string" && candidate.ambiguity_rule.trim()
        ? candidate.ambiguity_rule.trim()
        : DEFAULT_BOUNDARY_LOCK.ambiguity_rule,
    promotion_rule:
      typeof candidate?.promotion_rule === "string" && candidate.promotion_rule.trim()
        ? candidate.promotion_rule.trim()
        : DEFAULT_BOUNDARY_LOCK.promotion_rule,
  };
}

function verifyBoundaryLockPresence(doctrine, boundaryLock) {
  for (const [key, value] of Object.entries(boundaryLock)) {
    if (!doctrine.includes(value)) {
      throw new Error(`Grant doctrine missing required boundary rule (${key})`);
    }
  }
}

function verifyCorrectionsShape(corrections) {
  if (!corrections.includes("## Active corrections")) {
    throw new Error("Grant corrections matrix missing required Active corrections section");
  }
}

function buildVerificationSummary(paths, boundaryLock, texts) {
  const verifiedAt = new Date().toISOString();
  return {
    verifiedAt,
    doctrinePath: paths.doctrinePath,
    doctrineSha256: sha256(texts.doctrine),
    correctionsPath: paths.correctionsPath,
    correctionsSha256: sha256(texts.corrections),
    contractPath: paths.contractPath,
    contractSha256: sha256(JSON.stringify(texts.contractRecord)),
    boundaryLock,
    ...(paths.checklistPath
      ? {
          checklistPath: paths.checklistPath,
          checklistSha256: sha256(texts.checklist),
        }
      : {}),
    ...(paths.closeoutGatePath
      ? {
          closeoutGatePath: paths.closeoutGatePath,
          closeoutGateSha256: sha256(texts.closeoutGate),
        }
      : {}),
    ...(paths.afterActionAuditPath
      ? {
          afterActionAuditPath: paths.afterActionAuditPath,
          afterActionAuditSha256: sha256(texts.afterActionAudit),
        }
      : {}),
  };
}

export async function loadGrantHardeningRulebook(params) {
  const workspaceDir = typeof params?.workspaceDir === "string" ? params.workspaceDir.trim() : "";
  const includeRunArtifacts = params?.includeRunArtifacts === true;
  if (!workspaceDir) {
    throw new Error(
      "Grant hardening rulebook could not be loaded because the workspace directory is unavailable.",
    );
  }

  const doctrinePath = path.join(workspaceDir, GRANT_HARDENING_RELATIVE_PATHS.doctrine);
  const correctionsPath = path.join(workspaceDir, GRANT_HARDENING_RELATIVE_PATHS.corrections);
  const contractPath = path.join(workspaceDir, GRANT_HARDENING_RELATIVE_PATHS.contract);

  const [doctrine, corrections, contractRecord] = await Promise.all([
    readRequiredText(doctrinePath, "Grant doctrine"),
    readRequiredText(correctionsPath, "Grant corrections matrix"),
    readRequiredJson(contractPath, "Grant hardening operating contract"),
  ]);

  const boundaryLock = resolveBoundaryLock(contractRecord);
  verifyBoundaryLockPresence(doctrine, boundaryLock);
  verifyCorrectionsShape(corrections);

  let checklistPath;
  let closeoutGatePath;
  let afterActionAuditPath;
  let checklist;
  let closeoutGate;
  let afterActionAudit;

  if (includeRunArtifacts) {
    checklistPath = path.join(workspaceDir, GRANT_HARDENING_RELATIVE_PATHS.checklist);
    closeoutGatePath = path.join(workspaceDir, GRANT_HARDENING_RELATIVE_PATHS.closeoutGate);
    afterActionAuditPath = path.join(workspaceDir, GRANT_HARDENING_RELATIVE_PATHS.afterActionAudit);
    [checklist, closeoutGate, afterActionAudit] = await Promise.all([
      readRequiredText(checklistPath, "Grant run checklist"),
      readRequiredText(closeoutGatePath, "Grant closeout gate"),
      readRequiredText(afterActionAuditPath, "Grant after-action audit template"),
    ]);
  }

  const verification = buildVerificationSummary(
    {
      doctrinePath,
      correctionsPath,
      contractPath,
      checklistPath,
      closeoutGatePath,
      afterActionAuditPath,
    },
    boundaryLock,
    {
      doctrine,
      corrections,
      contractRecord,
      checklist,
      closeoutGate,
      afterActionAudit,
    },
  );

  return {
    doctrine,
    corrections,
    contractRecord,
    checklist,
    closeoutGate,
    afterActionAudit,
    verification,
  };
}

export function buildGrantRunInjection(rulebook) {
  return {
    systemPromptSuffix: [
      "## Grant Hardening Context",
      "This is a Grant-labeled governed execution run.",
      "The Grant hardening bundle is mandatory for this run. Do not ignore it, summarize it away, or treat it as optional.",
      "",
      "[Grant Injection Verification]",
      JSON.stringify(rulebook.verification, null, 2),
      "",
      `[Grant Doctrine Source] ${rulebook.verification.doctrinePath}`,
      rulebook.doctrine,
      "",
      `[Grant Corrections Source] ${rulebook.verification.correctionsPath}`,
      rulebook.corrections,
    ].join("\n"),
    taskMessageSuffix: [
      "[Grant Run Checklist - Mandatory]",
      `[Checklist Source] ${rulebook.verification.checklistPath}`,
      rulebook.checklist,
      "",
      "[Grant Closeout Gate - Mandatory]",
      `[Closeout Gate Source] ${rulebook.verification.closeoutGatePath}`,
      rulebook.closeoutGate,
      "",
      "[Grant After-Action Audit Reference]",
      `Your result will be reviewed against: ${rulebook.verification.afterActionAuditPath}`,
      rulebook.afterActionAudit,
    ].join("\n\n"),
  };
}

export function attachGrantRulebookMetadata(record, verification) {
  return {
    ...record,
    grantRulebook: {
      verifiedAt: verification.verifiedAt,
      doctrinePath: verification.doctrinePath,
      doctrineSha256: verification.doctrineSha256,
      correctionsPath: verification.correctionsPath,
      correctionsSha256: verification.correctionsSha256,
      contractPath: verification.contractPath,
      contractSha256: verification.contractSha256,
      boundaryLock: verification.boundaryLock,
    },
  };
}
