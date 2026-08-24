import { execFile as execFileCallback } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isGeneratedOutputPath, type DirtyTreeHygieneReport } from "./dirty-tree-hygiene.js";

const execFile = promisify(execFileCallback);

export type RootBaselineAdmission = "clean" | "dirty-frozen" | "cleanup-required" | "blocked";
export type IntegrationState =
  | "not_started"
  | "worktree_active"
  | "review_ready"
  | "integration_ready"
  | "integrated"
  | "blocked";
export type GeneratedOutputPolicy = "record_only" | "include_with_approval" | "deny_commit";

export type GovernedBuildWorkspaceMetadata = {
  schema: "openclaw.governed_build_workspace.v1";
  buildId: string;
  buildName: string;
  controllingPlanPath: string;
  buildPromptPath: string;
  workOrderPath: string;
  sourceRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  head: string;
  allowedWriteScopes: string[];
  ownerLease: {
    owner: string;
    leaseId: string;
    acquiredAt: string;
  };
  sourceLock: SourceLockSnapshot;
  generatedOutputPolicy: GeneratedOutputPolicy;
  integrationState: IntegrationState;
  rollbackRef: string;
  proofPaths: string[];
  retentionState: "active" | "archived" | "ready_to_prune";
};

export type SourceLockSnapshot = {
  schema: "openclaw.source_lock_snapshot.v1";
  sourceRoot: string;
  worktreePath: string;
  branch: string;
  head: string;
  baseRef: string;
  indexHash: string;
  unstagedDiffHash: string;
  stagedDiffHash: string;
  untrackedManifestHash: string;
  ignoredGeneratedManifestHash: string;
  worktreeListHash: string;
  submoduleStatusHash: string;
  packageLockHash: string;
  runtimeMetadataHash?: string;
  allowedWriteScopes: string[];
  generatedOutputPolicy: GeneratedOutputPolicy;
  timestamp: string;
  owner: string;
};

export type WorkspacePaths = {
  workspaceRoot: string;
  buildRoot: string;
  sourcePath: string;
  metadataPath: string;
  proofRoot: string;
};

export type WorktreeRecord = {
  worktreePath: string;
  head?: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
  prunableReason?: string;
};

export type RootMutationGuardContext = {
  active: boolean;
  buildId: string;
  sourceRoot: string;
  worktreePath: string;
  allowedWriteScopes: string[];
  markFacingExportRoots: string[];
  emergencyOverride?: {
    authorized: boolean;
    authority: string;
    reason: string;
    scope: string[];
    timestamp: string;
    preLockHash: string;
  };
};

export type RootMutationGuardDecision =
  | {
      allowed: true;
      reason:
        | "inactive"
        | "read_only"
        | "inside_worktree"
        | "mark_facing_export"
        | "emergency_override";
    }
  | {
      allowed: false;
      reason:
        | "root_source_mutation_denied"
        | "outside_allowed_workspace_scope"
        | "emergency_override_metadata_required";
      message: string;
    };

export type IntegrationReadinessInput = {
  worktreeHasReviewedDiff: boolean;
  workspaceMetadataVerified?: boolean;
  grantReviewWorkspaceVerified?: boolean;
  reviewPassed: boolean;
  testsPassed: boolean;
  rootLockMatchesExpected: boolean;
  conflictsResolved: boolean;
  rollbackRefExists: boolean;
  postIntegrationLockRecorded: boolean;
  integrationArtifacts: IntegrationArtifactPolicyInput[];
};

export type IntegrationReadinessDecision = {
  ready: boolean;
  state: "integration_ready" | "blocked";
  missing: string[];
};

export type IntegrationArtifactPolicyInput = {
  path: string;
  policy: GeneratedOutputPolicy;
  approved?: boolean;
};

export type WorktreeAdmissionDecision =
  | {
      admitted: true;
      action: "create" | "reattach";
      branch: string;
      paths: WorkspacePaths;
      staleWorktrees: WorktreeRecord[];
    }
  | {
      admitted: false;
      action: "blocked";
      reason: string;
      branch: string;
      paths: WorkspacePaths;
      staleWorktrees: WorktreeRecord[];
    };

export type WorktreeEnsureResult = WorktreeAdmissionDecision & {
  gitCommands: string[][];
};

export type CleanupCrewWorkspaceReviewMetadata = {
  controller: "Will";
  implementationOwner: string;
  reviewer: "Grant";
  grantReadOnly: boolean;
  reviewBeforeIntegration: boolean;
  workspaceMetadataPath: string;
  diffProofPath: string;
  reviewResultPath: string;
};

export type WorkspaceReportSeparationContract = {
  markFacingExportRoot: string;
  workspaceProofRoot: string;
  reportPaths: string[];
  proofPaths: string[];
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export function normalizeGovernedBuildId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  if (!/^[a-z][a-z0-9-]*$/u.test(normalized)) {
    throw new Error(`Invalid governed build id: ${value}`);
  }
  return normalized;
}

export function resolveGovernedBuildWorkspacePaths(params: {
  workspaceRoot: string;
  buildId: string;
}): WorkspacePaths {
  const buildId = normalizeGovernedBuildId(params.buildId);
  const workspaceRoot = path.resolve(params.workspaceRoot);
  const buildRoot = path.join(workspaceRoot, buildId);
  return {
    workspaceRoot,
    buildRoot,
    sourcePath: path.join(buildRoot, "source"),
    metadataPath: path.join(buildRoot, "workspace.json"),
    proofRoot: path.join(buildRoot, "proof"),
  };
}

export function resolveGovernedBuildBranchName(buildId: string): string {
  return `governed/${normalizeGovernedBuildId(buildId)}`;
}

export function buildRootBaselineAdmission(params: {
  dirtyTree: DirtyTreeHygieneReport;
  operatorAcceptedDirtyFreeze?: boolean;
  unknownAllowed?: boolean;
}): RootBaselineAdmission {
  if (params.dirtyTree.clean) {
    return "clean";
  }
  const hasUnknown = params.dirtyTree.sourceGroups.some((group) => group.group === "unknown");
  if (hasUnknown && params.unknownAllowed !== true) {
    return "blocked";
  }
  return params.operatorAcceptedDirtyFreeze === true ? "dirty-frozen" : "cleanup-required";
}

export function validateGovernedBuildWorkspaceMetadata(
  metadata: Partial<GovernedBuildWorkspaceMetadata>,
): ValidationResult {
  const errors: string[] = [];
  const requireString = (key: keyof GovernedBuildWorkspaceMetadata) => {
    if (typeof metadata[key] !== "string" || !(metadata[key] as string).trim()) {
      errors.push(`${String(key)} is required`);
    }
  };
  for (const key of [
    "buildId",
    "buildName",
    "controllingPlanPath",
    "buildPromptPath",
    "workOrderPath",
    "sourceRoot",
    "worktreePath",
    "branch",
    "baseRef",
    "head",
    "rollbackRef",
  ] as const) {
    requireString(key);
  }
  if (metadata.schema !== "openclaw.governed_build_workspace.v1") {
    errors.push("schema must be openclaw.governed_build_workspace.v1");
  }
  if (!Array.isArray(metadata.allowedWriteScopes) || metadata.allowedWriteScopes.length === 0) {
    errors.push("allowedWriteScopes is required");
  }
  if (
    !metadata.ownerLease?.owner ||
    !metadata.ownerLease.leaseId ||
    !metadata.ownerLease.acquiredAt
  ) {
    errors.push("ownerLease with owner, leaseId, and acquiredAt is required");
  }
  if (!metadata.sourceLock || metadata.sourceLock.schema !== "openclaw.source_lock_snapshot.v1") {
    errors.push("sourceLock is required");
  } else {
    errors.push(...validateSourceLockSnapshot(metadata.sourceLock).errors);
  }
  if (!metadata.generatedOutputPolicy) {
    errors.push("generatedOutputPolicy is required");
  }
  if (!metadata.integrationState) {
    errors.push("integrationState is required");
  }
  if (!Array.isArray(metadata.proofPaths)) {
    errors.push("proofPaths is required");
  }
  if (!metadata.retentionState) {
    errors.push("retentionState is required");
  }
  return { valid: errors.length === 0, errors };
}

export function validateSourceLockSnapshot(
  snapshot: Partial<SourceLockSnapshot>,
): ValidationResult {
  const errors: string[] = [];
  const requireString = (key: keyof SourceLockSnapshot) => {
    if (typeof snapshot[key] !== "string" || !(snapshot[key] as string).trim()) {
      errors.push(`sourceLock.${String(key)} is required`);
    }
  };
  if (snapshot.schema !== "openclaw.source_lock_snapshot.v1") {
    errors.push("sourceLock.schema must be openclaw.source_lock_snapshot.v1");
  }
  for (const key of [
    "sourceRoot",
    "worktreePath",
    "branch",
    "head",
    "baseRef",
    "indexHash",
    "unstagedDiffHash",
    "stagedDiffHash",
    "untrackedManifestHash",
    "ignoredGeneratedManifestHash",
    "worktreeListHash",
    "submoduleStatusHash",
    "packageLockHash",
    "timestamp",
    "owner",
  ] as const) {
    requireString(key);
  }
  if (!Array.isArray(snapshot.allowedWriteScopes) || snapshot.allowedWriteScopes.length === 0) {
    errors.push("sourceLock.allowedWriteScopes is required");
  }
  if (!snapshot.generatedOutputPolicy) {
    errors.push("sourceLock.generatedOutputPolicy is required");
  }
  return { valid: errors.length === 0, errors };
}

export async function writeGovernedBuildWorkspaceMetadataFile(
  metadata: GovernedBuildWorkspaceMetadata,
  metadataPath = resolveGovernedBuildWorkspacePaths({
    workspaceRoot: path.dirname(path.dirname(metadata.worktreePath)),
    buildId: metadata.buildId,
  }).metadataPath,
): Promise<string> {
  const validation = validateGovernedBuildWorkspaceMetadata(metadata);
  if (!validation.valid) {
    throw new Error(`Invalid governed build workspace metadata: ${validation.errors.join("; ")}`);
  }
  const resolvedPath = path.resolve(metadataPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, resolvedPath);
  return resolvedPath;
}

export async function readGovernedBuildWorkspaceMetadataFile(
  metadataPath: string,
): Promise<GovernedBuildWorkspaceMetadata> {
  const resolvedPath = path.resolve(metadataPath);
  const parsed = JSON.parse(
    await fs.readFile(resolvedPath, "utf8"),
  ) as Partial<GovernedBuildWorkspaceMetadata>;
  const validation = validateGovernedBuildWorkspaceMetadata(parsed);
  if (!validation.valid) {
    throw new Error(`Invalid governed build workspace metadata: ${validation.errors.join("; ")}`);
  }
  return parsed as GovernedBuildWorkspaceMetadata;
}

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildSourceLockSnapshotFromInputs(params: {
  sourceRoot: string;
  worktreePath: string;
  branch: string;
  head: string;
  baseRef: string;
  indexListing: string;
  unstagedDiff: string;
  stagedDiff: string;
  untrackedManifest: string;
  ignoredGeneratedManifest: string;
  worktreeList: string;
  submoduleStatus: string;
  packageLockContent: string;
  runtimeMetadata?: string;
  allowedWriteScopes: string[];
  generatedOutputPolicy: GeneratedOutputPolicy;
  timestamp: string;
  owner: string;
}): SourceLockSnapshot {
  return {
    schema: "openclaw.source_lock_snapshot.v1",
    sourceRoot: path.resolve(params.sourceRoot),
    worktreePath: path.resolve(params.worktreePath),
    branch: params.branch,
    head: params.head,
    baseRef: params.baseRef,
    indexHash: hashText(params.indexListing),
    unstagedDiffHash: hashText(params.unstagedDiff),
    stagedDiffHash: hashText(params.stagedDiff),
    untrackedManifestHash: hashText(params.untrackedManifest),
    ignoredGeneratedManifestHash: hashText(params.ignoredGeneratedManifest),
    worktreeListHash: hashText(params.worktreeList),
    submoduleStatusHash: hashText(params.submoduleStatus),
    packageLockHash: hashText(params.packageLockContent),
    ...(params.runtimeMetadata ? { runtimeMetadataHash: hashText(params.runtimeMetadata) } : {}),
    allowedWriteScopes: params.allowedWriteScopes.toSorted(),
    generatedOutputPolicy: params.generatedOutputPolicy,
    timestamp: params.timestamp,
    owner: params.owner,
  };
}

export function parseGitWorktreeListPorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: Partial<WorktreeRecord> | undefined;
  const finish = () => {
    if (current?.worktreePath) {
      records.push({
        worktreePath: current.worktreePath,
        ...(current.head ? { head: current.head } : {}),
        ...(current.branch ? { branch: current.branch } : {}),
        detached: current.detached === true,
        prunable: current.prunable === true,
        ...(current.prunableReason ? { prunableReason: current.prunableReason } : {}),
      });
    }
    current = undefined;
  };
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) {
      finish();
      continue;
    }
    if (line.startsWith("worktree ")) {
      finish();
      current = { worktreePath: line.slice("worktree ".length), detached: false, prunable: false };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line.startsWith("prunable")) {
      current.prunable = true;
      const reason = line.slice("prunable".length).trim();
      if (reason) {
        current.prunableReason = reason;
      }
    }
  }
  finish();
  return records;
}

export function listStaleWorktreeRecords(output: string): WorktreeRecord[] {
  return parseGitWorktreeListPorcelain(output).filter((record) => record.prunable);
}

export function planGovernedBuildWorktreeAdmission(params: {
  rootAdmission: RootBaselineAdmission;
  workspaceRoot: string;
  buildId: string;
  worktreeListOutput: string;
}): WorktreeAdmissionDecision {
  const paths = resolveGovernedBuildWorkspacePaths({
    workspaceRoot: params.workspaceRoot,
    buildId: params.buildId,
  });
  const branch = resolveGovernedBuildBranchName(params.buildId);
  const staleWorktrees = listStaleWorktreeRecords(params.worktreeListOutput);
  if (params.rootAdmission === "blocked" || params.rootAdmission === "cleanup-required") {
    return {
      admitted: false,
      action: "blocked",
      reason: `root baseline admission is ${params.rootAdmission}`,
      branch,
      paths,
      staleWorktrees,
    };
  }
  const matchingWorktree = parseGitWorktreeListPorcelain(params.worktreeListOutput).find(
    (record) => normalizePathForCompare(record.worktreePath) === paths.sourcePath,
  );
  return {
    admitted: true,
    action: matchingWorktree ? "reattach" : "create",
    branch,
    paths,
    staleWorktrees,
  };
}

export async function ensureGovernedBuildWorktree(params: {
  rootRepoPath: string;
  rootAdmission: RootBaselineAdmission;
  workspaceRoot: string;
  buildId: string;
  baseRef: string;
}): Promise<WorktreeEnsureResult> {
  const gitCommands: string[][] = [];
  const runGit = async (args: string[], cwd = params.rootRepoPath): Promise<string> => {
    gitCommands.push(["git", "-C", cwd, ...args]);
    const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return stdout;
  };
  const worktreeListOutput = await runGit(["worktree", "list", "--porcelain"]);
  const admission = planGovernedBuildWorktreeAdmission({
    rootAdmission: params.rootAdmission,
    workspaceRoot: params.workspaceRoot,
    buildId: params.buildId,
    worktreeListOutput,
  });
  if (!admission.admitted) {
    return { ...admission, gitCommands };
  }
  if (admission.action === "create") {
    await fs.mkdir(admission.paths.buildRoot, { recursive: true });
    await runGit([
      "worktree",
      "add",
      "-b",
      admission.branch,
      admission.paths.sourcePath,
      params.baseRef,
    ]);
  } else {
    const topLevel = (
      await runGit(["rev-parse", "--show-toplevel"], admission.paths.sourcePath)
    ).trim();
    if (normalizePathForCompare(topLevel) !== admission.paths.sourcePath) {
      throw new Error(
        `Existing governed worktree does not resolve to ${admission.paths.sourcePath}`,
      );
    }
  }
  return { ...admission, gitCommands };
}

export function classifyGovernedBuildArtifact(pathValue: string): {
  generated: boolean;
  commitRequiresApproval: boolean;
} {
  const normalizedPath = pathValue.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  const generated =
    isGeneratedOutputPath(normalizedPath) ||
    normalizedPath === ".artifacts" ||
    normalizedPath.startsWith(".artifacts/") ||
    normalizedPath.includes("/.artifacts/");
  const baseName = path.basename(pathValue);
  const lockFileRequiresApproval =
    baseName.endsWith(".lock") ||
    baseName === "pnpm-lock.yaml" ||
    baseName === "package-lock.json" ||
    baseName === "npm-shrinkwrap.json" ||
    baseName === "yarn.lock" ||
    baseName === "bun.lockb";
  return {
    generated,
    commitRequiresApproval: generated || lockFileRequiresApproval,
  };
}

export function evaluateGeneratedOutputCommitPolicy(params: {
  path: string;
  policy: GeneratedOutputPolicy;
}): { allowed: boolean; requiresApproval: boolean; reason: string } {
  const artifact = classifyGovernedBuildArtifact(params.path);
  if (!artifact.commitRequiresApproval) {
    return { allowed: true, requiresApproval: false, reason: "source_artifact" };
  }
  if (params.policy === "deny_commit") {
    return { allowed: false, requiresApproval: true, reason: "generated_output_denied" };
  }
  if (params.policy === "include_with_approval") {
    return { allowed: true, requiresApproval: true, reason: "policy_approval_required" };
  }
  return { allowed: false, requiresApproval: true, reason: "record_only_not_committable" };
}

function normalizePathForCompare(value: string): string {
  return path.resolve(value);
}

function isPathInside(candidate: string, root: string): boolean {
  const resolvedCandidate = normalizePathForCompare(candidate);
  const resolvedRoot = normalizePathForCompare(root);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isEmergencyOverrideScopeMatch(params: {
  scope: string;
  targetPath: string;
  sourceRoot: string;
}): boolean {
  const scopeRoot = path.isAbsolute(params.scope)
    ? params.scope
    : path.join(params.sourceRoot, params.scope);
  return isPathInside(params.targetPath, scopeRoot);
}

function hasValidEmergencyOverride(
  context: RootMutationGuardContext,
  targetPaths: string[],
): boolean {
  const override = context.emergencyOverride;
  return (
    override?.authorized === true &&
    nonEmptyString(override.authority) &&
    nonEmptyString(override.reason) &&
    nonEmptyString(override.timestamp) &&
    nonEmptyString(override.preLockHash) &&
    Array.isArray(override.scope) &&
    override.scope.some((entry) => nonEmptyString(entry)) &&
    targetPaths.length > 0 &&
    targetPaths.every((targetPath) =>
      override.scope.some((scope) =>
        isEmergencyOverrideScopeMatch({
          scope,
          targetPath,
          sourceRoot: context.sourceRoot,
        }),
      ),
    )
  );
}

function isTargetInsideAllowedWriteScope(params: {
  targetPath: string;
  worktreePath: string;
  allowedWriteScopes: string[];
}): boolean {
  if (params.allowedWriteScopes.length === 0) {
    return false;
  }
  return params.allowedWriteScopes.some((scope) =>
    isPathInside(params.targetPath, path.join(params.worktreePath, scope)),
  );
}

function allMutationTargetsInsideAllowedScopes(params: {
  targetPaths: string[];
  worktreePath: string;
  allowedWriteScopes: string[];
}): boolean {
  if (params.targetPaths.length === 0) {
    return false;
  }
  return params.targetPaths.every((targetPath) =>
    isTargetInsideAllowedWriteScope({
      targetPath,
      worktreePath: params.worktreePath,
      allowedWriteScopes: params.allowedWriteScopes,
    }),
  );
}

export function evaluateRootMutationGuard(params: {
  context?: RootMutationGuardContext;
  cwd?: string;
  targetPaths?: string[];
  sourceModifying: boolean;
  readOnlyDiagnostic: boolean;
}): RootMutationGuardDecision {
  const context = params.context;
  if (!context?.active) {
    return { allowed: true, reason: "inactive" };
  }
  if (!params.sourceModifying || params.readOnlyDiagnostic) {
    return { allowed: true, reason: "read_only" };
  }
  const targetPaths = params.targetPaths ?? [];
  const targetsAreMarkFacingExports =
    targetPaths.length > 0 &&
    targetPaths.every((targetPath) =>
      context.markFacingExportRoots.some((exportRoot) => isPathInside(targetPath, exportRoot)),
    );
  if (targetsAreMarkFacingExports) {
    return { allowed: true, reason: "mark_facing_export" };
  }
  if (hasValidEmergencyOverride(context, targetPaths)) {
    return { allowed: true, reason: "emergency_override" };
  }
  if (context.emergencyOverride?.authorized === true) {
    return {
      allowed: false,
      reason: "emergency_override_metadata_required",
      message:
        "Governed build emergency root override is missing required authority, reason, scope, timestamp, or pre-lock metadata.",
    };
  }

  const cwd = params.cwd ? normalizePathForCompare(params.cwd) : undefined;
  const touchesRoot =
    (cwd !== undefined &&
      isPathInside(cwd, context.sourceRoot) &&
      !isPathInside(cwd, context.worktreePath)) ||
    targetPaths.some((targetPath) => isPathInside(targetPath, context.sourceRoot));
  if (touchesRoot) {
    return {
      allowed: false,
      reason: "root_source_mutation_denied",
      message: [
        "Governed build workspace guard blocked root source mutation.",
        `Build: ${context.buildId}.`,
        `Use isolated worktree: ${context.worktreePath}.`,
      ].join(" "),
    };
  }

  const targetOrCwdInWorktree =
    (cwd !== undefined && isPathInside(cwd, context.worktreePath)) ||
    targetPaths.some((targetPath) => isPathInside(targetPath, context.worktreePath));
  if (!targetOrCwdInWorktree) {
    return {
      allowed: false,
      reason: "outside_allowed_workspace_scope",
      message: [
        "Governed build workspace guard blocked mutation outside the active worktree.",
        `Build: ${context.buildId}.`,
        `Allowed worktree: ${context.worktreePath}.`,
      ].join(" "),
    };
  }
  if (
    !allMutationTargetsInsideAllowedScopes({
      targetPaths,
      worktreePath: context.worktreePath,
      allowedWriteScopes: context.allowedWriteScopes,
    })
  ) {
    return {
      allowed: false,
      reason: "outside_allowed_workspace_scope",
      message: [
        "Governed build workspace guard blocked mutation outside allowed write scopes.",
        `Build: ${context.buildId}.`,
        `Allowed scopes: ${context.allowedWriteScopes.join(", ") || "none"}.`,
      ].join(" "),
    };
  }

  return { allowed: true, reason: "inside_worktree" };
}

export function evaluateControlledIntegrationReadiness(
  input: IntegrationReadinessInput,
): IntegrationReadinessDecision {
  const missing: string[] = [];
  if (!input.worktreeHasReviewedDiff) {
    missing.push("reviewed worktree diff");
  }
  if (input.workspaceMetadataVerified === false) {
    missing.push("verified workspace metadata");
  }
  if (input.grantReviewWorkspaceVerified === false) {
    missing.push("Grant workspace verification");
  }
  if (!input.reviewPassed) {
    missing.push("passing reviewer result");
  }
  if (!input.testsPassed) {
    missing.push("passing worktree tests");
  }
  if (!input.rootLockMatchesExpected) {
    missing.push("matching root source lock");
  }
  if (!input.conflictsResolved) {
    missing.push("explicit conflict resolution");
  }
  if (!input.rollbackRefExists) {
    missing.push("rollback ref");
  }
  if (!input.postIntegrationLockRecorded) {
    missing.push("post-integration source lock");
  }
  if (!Array.isArray(input.integrationArtifacts)) {
    missing.push("reviewed integration artifact manifest");
  }
  for (const artifact of input.integrationArtifacts ?? []) {
    const decision = evaluateGeneratedOutputCommitPolicy({
      path: artifact.path,
      policy: artifact.policy,
    });
    if (!decision.allowed) {
      missing.push(`committable artifact policy for ${artifact.path}`);
      continue;
    }
    if (decision.requiresApproval && artifact.approved !== true) {
      missing.push(`policy approval for ${artifact.path}`);
    }
  }
  return {
    ready: missing.length === 0,
    state: missing.length === 0 ? "integration_ready" : "blocked",
    missing,
  };
}

export function buildCleanupCrewWorkspaceReviewMetadata(params: {
  implementationOwner: string;
  workspaceMetadataPath: string;
  diffProofPath: string;
  reviewResultPath: string;
}): CleanupCrewWorkspaceReviewMetadata {
  return {
    controller: "Will",
    implementationOwner: params.implementationOwner,
    reviewer: "Grant",
    grantReadOnly: true,
    reviewBeforeIntegration: true,
    workspaceMetadataPath: path.resolve(params.workspaceMetadataPath),
    diffProofPath: path.resolve(params.diffProofPath),
    reviewResultPath: path.resolve(params.reviewResultPath),
  };
}

export function validateCleanupCrewWorkspaceReviewMetadata(
  metadata: Partial<CleanupCrewWorkspaceReviewMetadata>,
): ValidationResult {
  const errors: string[] = [];
  if (metadata.controller !== "Will") {
    errors.push("controller must be Will");
  }
  if (!nonEmptyString(metadata.implementationOwner)) {
    errors.push("implementationOwner is required");
  }
  if (metadata.reviewer !== "Grant") {
    errors.push("reviewer must be Grant");
  }
  if (metadata.grantReadOnly !== true) {
    errors.push("Grant review must be read-only");
  }
  if (metadata.reviewBeforeIntegration !== true) {
    errors.push("reviewBeforeIntegration is required");
  }
  for (const key of ["workspaceMetadataPath", "diffProofPath", "reviewResultPath"] as const) {
    if (!nonEmptyString(metadata[key])) {
      errors.push(`${key} is required`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateWorkspaceReportSeparationContract(
  contract: WorkspaceReportSeparationContract,
): ValidationResult {
  const errors: string[] = [];
  const exportRoot = normalizePathForCompare(contract.markFacingExportRoot);
  const proofRoot = normalizePathForCompare(contract.workspaceProofRoot);
  if (exportRoot === proofRoot || isPathInside(proofRoot, exportRoot)) {
    errors.push("workspaceProofRoot must not be inside the flat export root");
  }
  for (const reportPath of contract.reportPaths) {
    const resolved = normalizePathForCompare(reportPath);
    if (!isPathInside(resolved, exportRoot)) {
      errors.push(`report path is outside export root: ${reportPath}`);
      continue;
    }
    if (path.dirname(resolved) !== exportRoot) {
      errors.push(`report path must be flat in export root: ${reportPath}`);
    }
  }
  for (const proofPath of contract.proofPaths) {
    const resolved = normalizePathForCompare(proofPath);
    if (!isPathInside(resolved, proofRoot)) {
      errors.push(`proof path is outside workspace proof root: ${proofPath}`);
    }
    if (isPathInside(resolved, exportRoot)) {
      errors.push(`bulky proof path must not be stored under export root: ${proofPath}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
