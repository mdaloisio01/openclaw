import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";

export type ControlPlaneApprovalClass =
  | "auth"
  | "secrets"
  | "agents"
  | "exec"
  | "browser"
  | "memory"
  | "models"
  | "plugins"
  | "channels"
  | "skills"
  | "runtime"
  | "control";

export type ProtectedSurfaceRule = {
  path: string;
  approvalClass: ControlPlaneApprovalClass;
  riskClass: "critical" | "high" | "medium";
  owner: string;
  allowedWriter: "control-plane-writer";
  requiredTests: string[];
  requiredRuntimeProof: string[];
  rollbackRequired: true;
  allowDeletion?: boolean;
};

export type ControlPlaneManifest = {
  manifestId: string;
  objective: string;
  activationTimestamp: string;
  candidateSha256: string;
  allowedFiles: string[];
  allowedConfigPaths: string[];
  forbiddenFiles: string[];
  forbiddenConfigPaths?: string[];
  allowedServices: string[];
  allowedRestartScope: "none" | "gateway";
  allowedAgents: string[];
  allowedTools: string[];
  approvalClasses?: ControlPlaneApprovalClass[];
  requiredEvidence: string[];
  rollbackAssets: string[];
  stopConditions: string[];
  doneCriteria: string[];
  expiresAt?: string;
};

export type ControlPlaneApproval = {
  approvalId: string;
  manifestId: string;
  candidateSha256: string;
  approvalClasses: ControlPlaneApprovalClass[];
  approved: true;
  expiresAt: string;
};

export type ControlPlaneActivationInput = {
  beforeConfig: unknown;
  candidateConfig: unknown;
  candidateRaw: string;
  manifest: unknown;
  approval: unknown;
  now: Date;
  candidatePath: string;
  stagingRoot: string;
  actor?: string;
  tool?: string;
  requestedServices?: string[];
  restartScope?: "none" | "gateway";
  candidateIsSymlink?: boolean;
  auditSinkAvailable: boolean;
  rollbackSinkAvailable: boolean;
  seenApprovalIds?: ReadonlySet<string>;
  registry?: readonly ProtectedSurfaceRule[];
};

export type ControlPlaneActivationDecision =
  | {
      ok: true;
      noOp: boolean;
      changedPaths: string[];
      requiredApprovalClasses: ControlPlaneApprovalClass[];
      candidateSha256: string;
    }
  | {
      ok: false;
      code:
        | "audit_unavailable"
        | "rollback_unavailable"
        | "malformed_config"
        | "malformed_manifest"
        | "malformed_approval"
        | "path_traversal"
        | "candidate_symlink"
        | "candidate_manifest_mismatch"
        | "approval_manifest_mismatch"
        | "approval_candidate_mismatch"
        | "approval_expired"
        | "approval_replay"
        | "unauthorized_actor"
        | "unauthorized_tool"
        | "unauthorized_service_restart"
        | "restart_scope_expansion"
        | "allowed_section_escape"
        | "forbidden_section_mutation"
        | "protected_deletion"
        | "unknown_section"
        | "missing_approval_class";
      reason: string;
      changedPaths?: string[];
    };

export const DEFAULT_PROTECTED_SURFACE_REGISTRY: readonly ProtectedSurfaceRule[] = [
  {
    path: "gateway.auth",
    approvalClass: "auth",
    riskClass: "critical",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["auth-token-source", "auth-mode-preserved"],
    requiredRuntimeProof: ["gateway-auth-valid", "secret-provider-valid"],
    rollbackRequired: true,
  },
  {
    path: "gateway",
    approvalClass: "runtime",
    riskClass: "critical",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["gateway-runtime-schema", "gateway-restart-scope"],
    requiredRuntimeProof: ["gateway-health", "gateway-readiness"],
    rollbackRequired: true,
  },
  {
    path: "secrets",
    approvalClass: "secrets",
    riskClass: "critical",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["secret-provider-schema", "secret-redaction"],
    requiredRuntimeProof: ["secret-provider-valid"],
    rollbackRequired: true,
  },
  {
    path: "agents",
    approvalClass: "agents",
    riskClass: "critical",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["agent-list-schema", "subagent-permission-boundary"],
    requiredRuntimeProof: ["main-agent-loaded", "orchestrator-agent-loaded", "grant-agent-loaded"],
    rollbackRequired: true,
  },
  {
    path: "tools.exec",
    approvalClass: "exec",
    riskClass: "critical",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["exec-mode-schema", "exec-approval-policy"],
    requiredRuntimeProof: ["exec-mode-compatible"],
    rollbackRequired: true,
  },
  {
    path: "tools",
    approvalClass: "runtime",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["tool-policy-schema"],
    requiredRuntimeProof: ["tools-healthy"],
    rollbackRequired: true,
  },
  {
    path: "browser",
    approvalClass: "browser",
    riskClass: "critical",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["browser-policy-schema", "ssrf-policy-boundary"],
    requiredRuntimeProof: ["browser-policy-unchanged-or-approved"],
    rollbackRequired: true,
  },
  {
    path: "memory",
    approvalClass: "memory",
    riskClass: "critical",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["memory-backend-schema", "qmd-boundary"],
    requiredRuntimeProof: ["memory-qmd-healthy"],
    rollbackRequired: true,
  },
  {
    path: "models",
    approvalClass: "models",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["model-provider-schema"],
    requiredRuntimeProof: ["model-runtime-compatible"],
    rollbackRequired: true,
  },
  {
    path: "plugins",
    approvalClass: "plugins",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["plugin-config-schema"],
    requiredRuntimeProof: ["plugins-loaded-without-errors"],
    rollbackRequired: true,
  },
  {
    path: "channels",
    approvalClass: "channels",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["channel-config-schema"],
    requiredRuntimeProof: ["channel-policy-valid"],
    rollbackRequired: true,
  },
  {
    path: "messages",
    approvalClass: "channels",
    riskClass: "medium",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["message-policy-schema"],
    requiredRuntimeProof: ["message-policy-valid"],
    rollbackRequired: true,
  },
  {
    path: "skills",
    approvalClass: "skills",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["skill-config-schema"],
    requiredRuntimeProof: ["skills-healthy"],
    rollbackRequired: true,
  },
  {
    path: "mcp",
    approvalClass: "runtime",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["mcp-runtime-schema"],
    requiredRuntimeProof: ["runtime-backend-compatible"],
    rollbackRequired: true,
  },
  {
    path: "acp",
    approvalClass: "runtime",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["acp-runtime-schema"],
    requiredRuntimeProof: ["runtime-backend-compatible"],
    rollbackRequired: true,
  },
  {
    path: "commands",
    approvalClass: "runtime",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["command-policy-schema"],
    requiredRuntimeProof: ["command-policy-valid"],
    rollbackRequired: true,
  },
  {
    path: "cron",
    approvalClass: "runtime",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["cron-policy-schema"],
    requiredRuntimeProof: ["cron-store-healthy", "watchdog-clean"],
    rollbackRequired: true,
  },
  {
    path: "hooks",
    approvalClass: "runtime",
    riskClass: "high",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["hook-policy-schema"],
    requiredRuntimeProof: ["native-hooks-healthy"],
    rollbackRequired: true,
  },
  {
    path: "ui",
    approvalClass: "control",
    riskClass: "medium",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["ui-config-schema"],
    requiredRuntimeProof: ["control-ui-compatible"],
    rollbackRequired: true,
  },
  {
    path: "_meta",
    approvalClass: "control",
    riskClass: "critical",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["control-metadata-schema"],
    requiredRuntimeProof: ["control-metadata-valid"],
    rollbackRequired: true,
  },
  {
    path: "meta",
    approvalClass: "control",
    riskClass: "critical",
    owner: "control-plane-protection",
    allowedWriter: "control-plane-writer",
    requiredTests: ["control-metadata-schema"],
    requiredRuntimeProof: ["control-metadata-valid"],
    rollbackRequired: true,
  },
];

const KNOWN_TOP_LEVEL_SECTIONS = new Set(
  DEFAULT_PROTECTED_SURFACE_REGISTRY.map((rule) => parseConfigPath(rule.path)[0]).filter(
    (segment): segment is string => Boolean(segment),
  ),
);

function sha256(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}

function parseConfigPath(value: string): string[] {
  return value
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function formatConfigPath(value: readonly string[]): string {
  return value.length === 0 ? "<root>" : value.join(".");
}

function pathStartsWith(pathValue: readonly string[], prefix: readonly string[]): boolean {
  return (
    prefix.length <= pathValue.length &&
    prefix.every((segment, index) => pathValue[index] === segment)
  );
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return pathStartsWith(left, right) || pathStartsWith(right, left);
}

function collectChangedPaths(before: unknown, after: unknown, prefix: string[] = []): string[][] {
  if (isDeepStrictEqual(before, after)) {
    return [];
  }
  if (!isRecord(before) || !isRecord(after) || Array.isArray(before) || Array.isArray(after)) {
    return [prefix];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) => {
    const hasBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (!hasBefore || !hasAfter) {
      return [[...prefix, key]];
    }
    return collectChangedPaths(before[key], after[key], [...prefix, key]);
  });
}

function getPathValue(value: unknown, pathValue: readonly string[]): unknown {
  let current = value;
  for (const segment of pathValue) {
    if (!isRecord(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isValidStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim());
}

function parseManifest(value: unknown): ControlPlaneManifest | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.manifestId !== "string" ||
    !value.manifestId.trim() ||
    typeof value.objective !== "string" ||
    !value.objective.trim() ||
    typeof value.activationTimestamp !== "string" ||
    !value.activationTimestamp.trim() ||
    typeof value.candidateSha256 !== "string" ||
    !value.candidateSha256.trim() ||
    !isValidStringArray(value.allowedFiles) ||
    !isValidStringArray(value.allowedConfigPaths) ||
    !isValidStringArray(value.forbiddenFiles) ||
    !isValidStringArray(value.allowedServices) ||
    (value.allowedRestartScope !== "none" && value.allowedRestartScope !== "gateway") ||
    !isValidStringArray(value.allowedAgents) ||
    !isValidStringArray(value.allowedTools) ||
    !isValidStringArray(value.requiredEvidence) ||
    !isValidStringArray(value.rollbackAssets) ||
    !isValidStringArray(value.stopConditions) ||
    !isValidStringArray(value.doneCriteria)
  ) {
    return null;
  }
  if (value.forbiddenConfigPaths !== undefined && !isValidStringArray(value.forbiddenConfigPaths)) {
    return null;
  }
  if (
    value.approvalClasses !== undefined &&
    (!Array.isArray(value.approvalClasses) ||
      !value.approvalClasses.every((entry) => typeof entry === "string" && entry.trim()))
  ) {
    return null;
  }
  return {
    manifestId: value.manifestId,
    objective: value.objective,
    activationTimestamp: value.activationTimestamp,
    candidateSha256: value.candidateSha256,
    allowedFiles: value.allowedFiles,
    allowedConfigPaths: value.allowedConfigPaths,
    forbiddenFiles: value.forbiddenFiles,
    forbiddenConfigPaths: value.forbiddenConfigPaths,
    allowedServices: value.allowedServices,
    allowedRestartScope: value.allowedRestartScope,
    allowedAgents: value.allowedAgents,
    allowedTools: value.allowedTools,
    approvalClasses: value.approvalClasses as ControlPlaneApprovalClass[] | undefined,
    requiredEvidence: value.requiredEvidence,
    rollbackAssets: value.rollbackAssets,
    stopConditions: value.stopConditions,
    doneCriteria: value.doneCriteria,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : undefined,
  };
}

function parseApproval(value: unknown): ControlPlaneApproval | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.approvalId !== "string" ||
    !value.approvalId.trim() ||
    typeof value.manifestId !== "string" ||
    !value.manifestId.trim() ||
    typeof value.candidateSha256 !== "string" ||
    !value.candidateSha256.trim() ||
    value.approved !== true ||
    !isValidStringArray(value.approvalClasses) ||
    typeof value.expiresAt !== "string" ||
    !value.expiresAt.trim()
  ) {
    return null;
  }
  return value as ControlPlaneApproval;
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiresMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresMs) || expiresMs <= now.getTime();
}

function validateCandidatePath(params: { candidatePath: string; stagingRoot: string }): boolean {
  const resolvedRoot = path.resolve(params.stagingRoot);
  const resolvedCandidate = path.resolve(params.candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function pathEquals(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function normalizeScopeValue(value: string): string {
  return value.trim().toLowerCase();
}

function manifestIncludesValue(items: readonly string[], value: string | undefined): boolean {
  if (!value?.trim()) {
    return false;
  }
  const normalized = normalizeScopeValue(value);
  return items.some((item) => normalizeScopeValue(item) === normalized);
}

function manifestIncludesEveryValue(items: readonly string[], values: readonly string[]): boolean {
  return values.every((value) => manifestIncludesValue(items, value));
}

function findProtectedRule(
  changedPath: readonly string[],
  registry: readonly ProtectedSurfaceRule[],
): ProtectedSurfaceRule | undefined {
  return registry.find((rule) => pathsOverlap(changedPath, parseConfigPath(rule.path)));
}

export function evaluateControlPlaneActivation(
  params: ControlPlaneActivationInput,
): ControlPlaneActivationDecision {
  if (!params.auditSinkAvailable) {
    return { ok: false, code: "audit_unavailable", reason: "audit sink unavailable" };
  }
  if (!params.rollbackSinkAvailable) {
    return { ok: false, code: "rollback_unavailable", reason: "rollback sink unavailable" };
  }
  if (!isRecord(params.beforeConfig) || !isRecord(params.candidateConfig)) {
    return {
      ok: false,
      code: "malformed_config",
      reason: "before and candidate config must be objects",
    };
  }
  if (params.candidateIsSymlink) {
    return { ok: false, code: "candidate_symlink", reason: "candidate path is a symlink" };
  }
  if (!validateCandidatePath(params)) {
    return { ok: false, code: "path_traversal", reason: "candidate path is outside staging root" };
  }

  const manifest = parseManifest(params.manifest);
  if (!manifest) {
    return { ok: false, code: "malformed_manifest", reason: "manifest is malformed" };
  }
  const approval = parseApproval(params.approval);
  if (!approval) {
    return { ok: false, code: "malformed_approval", reason: "approval is malformed" };
  }

  const candidateSha256 = sha256(params.candidateRaw);
  if (manifest.candidateSha256 !== candidateSha256) {
    return {
      ok: false,
      code: "candidate_manifest_mismatch",
      reason: "manifest candidate hash does not match candidate",
    };
  }
  if (approval.manifestId !== manifest.manifestId) {
    return {
      ok: false,
      code: "approval_manifest_mismatch",
      reason: "approval manifest id does not match manifest",
    };
  }
  if (approval.candidateSha256 !== candidateSha256) {
    return {
      ok: false,
      code: "approval_candidate_mismatch",
      reason: "approval candidate hash does not match candidate",
    };
  }
  if (isExpired(manifest.expiresAt, params.now) || isExpired(approval.expiresAt, params.now)) {
    return { ok: false, code: "approval_expired", reason: "manifest or approval expired" };
  }
  if (params.seenApprovalIds?.has(approval.approvalId)) {
    return { ok: false, code: "approval_replay", reason: "approval id was already used" };
  }
  if (!manifestIncludesValue(manifest.allowedAgents, params.actor)) {
    return {
      ok: false,
      code: "unauthorized_actor",
      reason: `actor is outside manifest scope: ${params.actor ?? "<missing>"}`,
    };
  }
  if (!manifestIncludesValue(manifest.allowedTools, params.tool)) {
    return {
      ok: false,
      code: "unauthorized_tool",
      reason: `tool is outside manifest scope: ${params.tool ?? "<missing>"}`,
    };
  }
  const requestedServices = params.requestedServices ?? [];
  if (!manifestIncludesEveryValue(manifest.allowedServices, requestedServices)) {
    return {
      ok: false,
      code: "unauthorized_service_restart",
      reason: `requested service scope exceeds manifest: ${requestedServices.join(",") || "<none>"}`,
    };
  }
  const restartScope = params.restartScope ?? "none";
  if (restartScope === "gateway" && manifest.allowedRestartScope !== "gateway") {
    return {
      ok: false,
      code: "restart_scope_expansion",
      reason: "gateway restart requested but manifest restart scope is not gateway",
    };
  }
  if (!manifest.allowedFiles.some((allowedFile) => pathEquals(params.candidatePath, allowedFile))) {
    return {
      ok: false,
      code: "allowed_section_escape",
      reason: `candidate file is outside manifest file scope: ${params.candidatePath}`,
    };
  }
  if (
    manifest.forbiddenFiles.some((forbiddenFile) => pathEquals(params.candidatePath, forbiddenFile))
  ) {
    return {
      ok: false,
      code: "forbidden_section_mutation",
      reason: `candidate file overlaps forbidden manifest file scope: ${params.candidatePath}`,
    };
  }

  const changedPaths = collectChangedPaths(params.beforeConfig, params.candidateConfig);
  const allowedPaths = manifest.allowedConfigPaths.map(parseConfigPath);
  const forbiddenPaths = (manifest.forbiddenConfigPaths ?? []).map(parseConfigPath);
  const registry = params.registry ?? DEFAULT_PROTECTED_SURFACE_REGISTRY;
  const requiredApprovalClasses = new Set<ControlPlaneApprovalClass>();

  for (const changedPath of changedPaths) {
    const formatted = formatConfigPath(changedPath);
    const topLevel = changedPath[0];
    if (!topLevel || !KNOWN_TOP_LEVEL_SECTIONS.has(topLevel)) {
      return {
        ok: false,
        code: "unknown_section",
        reason: `unknown configuration section changed: ${formatted}`,
        changedPaths: changedPaths.map(formatConfigPath),
      };
    }
    if (!allowedPaths.some((allowedPath) => pathStartsWith(changedPath, allowedPath))) {
      return {
        ok: false,
        code: "allowed_section_escape",
        reason: `changed path is outside manifest scope: ${formatted}`,
        changedPaths: changedPaths.map(formatConfigPath),
      };
    }
    if (forbiddenPaths.some((forbiddenPath) => pathsOverlap(changedPath, forbiddenPath))) {
      return {
        ok: false,
        code: "forbidden_section_mutation",
        reason: `changed path overlaps forbidden section: ${formatted}`,
        changedPaths: changedPaths.map(formatConfigPath),
      };
    }

    const rule = findProtectedRule(changedPath, registry);
    if (!rule) {
      return {
        ok: false,
        code: "unknown_section",
        reason: `changed path has no protected-surface rule: ${formatted}`,
        changedPaths: changedPaths.map(formatConfigPath),
      };
    }
    const rulePath = parseConfigPath(rule.path);
    if (
      !rule.allowDeletion &&
      getPathValue(params.beforeConfig, rulePath) !== undefined &&
      getPathValue(params.candidateConfig, rulePath) === undefined
    ) {
      return {
        ok: false,
        code: "protected_deletion",
        reason: `protected section deletion rejected: ${rule.path}`,
        changedPaths: changedPaths.map(formatConfigPath),
      };
    }
    requiredApprovalClasses.add(rule.approvalClass);
  }

  const manifestApprovalClasses = new Set(manifest.approvalClasses ?? []);
  const approvedClasses = new Set(approval.approvalClasses);
  for (const approvalClass of requiredApprovalClasses) {
    if (!manifestApprovalClasses.has(approvalClass) || !approvedClasses.has(approvalClass)) {
      return {
        ok: false,
        code: "missing_approval_class",
        reason: `manifest or approval class missing: ${approvalClass}`,
        changedPaths: changedPaths.map(formatConfigPath),
      };
    }
  }

  return {
    ok: true,
    noOp: changedPaths.length === 0,
    changedPaths: changedPaths.map(formatConfigPath),
    requiredApprovalClasses: [...requiredApprovalClasses].sort(),
    candidateSha256,
  };
}
