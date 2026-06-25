import fs from "node:fs/promises";
import path from "node:path";
import {
  attachGrantRulebookMetadata,
  loadGrantHardeningRulebook,
} from "./grant-hardening-rulebook.mjs";

export const GRANT_RETIREMENT_ALLOWED_REASONS = [
  "obsolete_rule",
  "superseded_by_higher_quality_rule",
  "false_positive_pattern",
  "capability_materially_fixed",
];

const DEFAULT_PATHS = {
  template: path.join("templates", "grant", "grant_correction_retirement_request_template.json"),
  requestDir: path.join("var", "grant", "retirement_requests"),
  queuePath: path.join("var", "grant", "grant_correction_retirements.jsonl"),
};

function sanitizeSlug(value) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "grant-retirement-request";
  }
  return (
    trimmed
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "grant-retirement-request"
  );
}

function assertGrantRetirementParams(params) {
  if (!params.workspace.trim()) {
    throw new Error("--workspace is required");
  }
  if (!params.outcomeCode.trim()) {
    throw new Error("--outcome-code is required");
  }
  if (!GRANT_RETIREMENT_ALLOWED_REASONS.includes(params.reason)) {
    throw new Error(`--reason must be one of: ${GRANT_RETIREMENT_ALLOWED_REASONS.join(", ")}`);
  }
  if ((params.requestedBy ?? "Will").trim() !== "Will") {
    throw new Error("--requested-by must be Will");
  }
  if ((params.approvedBy ?? "Will").trim() !== "Will") {
    throw new Error("--approved-by must be Will");
  }
  const evidence = params.evidence?.trim() ?? "";
  const proofPaths = (params.proofPaths ?? []).map((item) => item.trim()).filter(Boolean);
  if (!evidence && proofPaths.length === 0) {
    throw new Error("one of --evidence or --proof-path is required");
  }
}

export async function createGrantRetirementRequest(params) {
  assertGrantRetirementParams(params);

  const workspaceDir = path.resolve(params.workspace);
  const rulebook = await loadGrantHardeningRulebook({ workspaceDir });
  const templatePath = path.join(workspaceDir, DEFAULT_PATHS.template);
  let template;
  try {
    template = JSON.parse(await fs.readFile(templatePath, "utf8"));
  } catch (error) {
    throw new Error(
      `retirement request template missing or unreadable at ${templatePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const now = new Date().toISOString();
  const requestedAt = params.requestedAt?.trim() || now;
  const approvedAt = params.approvedAt?.trim() || requestedAt;
  const requestDir = path.join(workspaceDir, DEFAULT_PATHS.requestDir);
  const requestPath = path.join(
    requestDir,
    `${requestedAt.replace(/[:.]/g, "").replace(/Z$/, "Z")}_${sanitizeSlug(params.outcomeCode)}.json`,
  );
  const queuePath = path.join(workspaceDir, DEFAULT_PATHS.queuePath);
  const evidence = params.evidence?.trim() ?? "";
  const proofPaths = (params.proofPaths ?? []).map((item) => item.trim()).filter(Boolean);

  const requestArtifact = attachGrantRulebookMetadata(
    {
      ...template,
      requestedBy: "Will",
      approvedBy: "Will",
      outcomeCode: params.outcomeCode.trim(),
      reason: params.reason.trim(),
      evidence,
      resolutionProofPaths: proofPaths,
      notes: params.notes ?? "",
      requestedAt,
      approvedAt,
    },
    rulebook.verification,
  );
  const queueEntry = attachGrantRulebookMetadata(
    {
      queuedAt: now,
      requestedBy: "Will",
      approvedBy: "Will",
      outcomeCode: params.outcomeCode.trim(),
      reason: params.reason.trim(),
      evidence,
      resolutionProofPaths: proofPaths,
      notes: params.notes ?? "",
      requestedAt,
      approvedAt,
      requestPath,
    },
    rulebook.verification,
  );

  if (!params.dryRun) {
    await fs.mkdir(requestDir, { recursive: true });
    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await fs.writeFile(requestPath, `${JSON.stringify(requestArtifact, null, 2)}\n`, "utf8");
    await fs.appendFile(queuePath, `${JSON.stringify(queueEntry)}\n`, "utf8");
  }

  return {
    ok: true,
    dryRun: params.dryRun === true,
    requestPath,
    queuePath,
    outcomeCode: params.outcomeCode.trim(),
    reason: params.reason.trim(),
  };
}
