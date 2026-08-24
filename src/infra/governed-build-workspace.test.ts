import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildDirtyTreeHygieneReport } from "./dirty-tree-hygiene.js";
import {
  buildCleanupCrewWorkspaceReviewMetadata,
  buildRootBaselineAdmission,
  buildSourceLockSnapshotFromInputs,
  classifyGovernedBuildArtifact,
  evaluateGeneratedOutputCommitPolicy,
  evaluateControlledIntegrationReadiness,
  evaluateRootMutationGuard,
  ensureGovernedBuildWorktree,
  listStaleWorktreeRecords,
  normalizeGovernedBuildId,
  planGovernedBuildWorktreeAdmission,
  readGovernedBuildWorkspaceMetadataFile,
  resolveGovernedBuildBranchName,
  resolveGovernedBuildWorkspacePaths,
  validateCleanupCrewWorkspaceReviewMetadata,
  validateGovernedBuildWorkspaceMetadata,
  validateSourceLockSnapshot,
  validateWorkspaceReportSeparationContract,
  type GovernedBuildWorkspaceMetadata,
  writeGovernedBuildWorkspaceMetadataFile,
} from "./governed-build-workspace.js";

const execFile = promisify(execFileCallback);
const sourceRoot = "/home/will/openclaw-source";
const worktreePath =
  "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source";

function guardContext() {
  return {
    active: true,
    buildId: "clean-tree",
    sourceRoot,
    worktreePath,
    allowedWriteScopes: ["src/infra", "src/agents"],
    markFacingExportRoots: [
      "/home/will/.openclaw/workspace-orchestrator/file_hub/exports",
      "/home/will/.openclaw/workspace/file_hub/exports",
    ],
  };
}

function sourceLockFixture() {
  return buildSourceLockSnapshotFromInputs({
    sourceRoot,
    worktreePath,
    branch: "governed/clean-tree",
    head: "abc123",
    baseRef: "abc123",
    indexListing: "100644 blob abc\tpackage.json\n",
    unstagedDiff: "",
    stagedDiff: "",
    untrackedManifest: "",
    ignoredGeneratedManifest: "dist/index.js\n",
    worktreeList: `worktree ${sourceRoot}\nHEAD abc123\nbranch refs/heads/main\n`,
    submoduleStatus: "none\n",
    packageLockContent: "lock",
    allowedWriteScopes: ["src/infra"],
    generatedOutputPolicy: "record_only",
    timestamp: "2026-08-22T14:43Z",
    owner: "Will",
  });
}

describe("governed build workspace", () => {
  it("normalizes ids and resolves stable workspace paths and branches", () => {
    expect(normalizeGovernedBuildId(" Clean Tree / Isolated Build Workspace ")).toBe(
      "clean-tree-isolated-build-workspace",
    );
    expect(resolveGovernedBuildBranchName("Clean Tree")).toBe("governed/clean-tree");
    expect(
      resolveGovernedBuildWorkspacePaths({
        workspaceRoot: "/tmp/workspaces",
        buildId: "Clean Tree",
      }),
    ).toMatchObject({
      buildRoot: "/tmp/workspaces/clean-tree",
      sourcePath: "/tmp/workspaces/clean-tree/source",
      metadataPath: "/tmp/workspaces/clean-tree/workspace.json",
      proofRoot: "/tmp/workspaces/clean-tree/proof",
    });
    expect(() => normalizeGovernedBuildId("123 nope")).toThrow(/Invalid governed build id/u);
  });

  it("rejects missing metadata identity, source, owner, lock, and integration fields", () => {
    const result = validateGovernedBuildWorkspaceMetadata({
      schema: "openclaw.governed_build_workspace.v1",
      buildId: "clean-tree",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "buildName is required",
        "sourceRoot is required",
        "worktreePath is required",
        "allowedWriteScopes is required",
        "ownerLease with owner, leaseId, and acquiredAt is required",
        "sourceLock is required",
        "integrationState is required",
      ]),
    );
  });

  it("accepts complete governed workspace metadata", () => {
    const sourceLock = sourceLockFixture();
    const metadata: GovernedBuildWorkspaceMetadata = {
      schema: "openclaw.governed_build_workspace.v1",
      buildId: "clean-tree",
      buildName: "Clean Tree",
      controllingPlanPath: "/exports/plan.md",
      buildPromptPath: "/exports/prompt.md",
      workOrderPath: "/exports/work_order.json",
      sourceRoot,
      worktreePath,
      branch: "governed/clean-tree",
      baseRef: "abc123",
      head: "abc123",
      allowedWriteScopes: ["src/infra"],
      ownerLease: {
        owner: "Will",
        leaseId: "lease-1",
        acquiredAt: "2026-08-22T14:43Z",
      },
      sourceLock,
      generatedOutputPolicy: "record_only",
      integrationState: "worktree_active",
      rollbackRef: "abc123",
      proofPaths: ["/proof/source-lock.json"],
      retentionState: "active",
    };

    expect(validateGovernedBuildWorkspaceMetadata(metadata)).toEqual({ valid: true, errors: [] });
  });

  it("rejects incomplete source-lock snapshots", () => {
    expect(
      validateSourceLockSnapshot({
        schema: "openclaw.source_lock_snapshot.v1",
      }),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "sourceLock.sourceRoot is required",
        "sourceLock.worktreePath is required",
        "sourceLock.indexHash is required",
        "sourceLock.allowedWriteScopes is required",
      ]),
    });
  });

  it("writes and reads durable workspace metadata through workspace.json", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-json-"));
    try {
      const paths = resolveGovernedBuildWorkspacePaths({
        workspaceRoot: fixtureRoot,
        buildId: "Clean Tree",
      });
      const metadata: GovernedBuildWorkspaceMetadata = {
        schema: "openclaw.governed_build_workspace.v1",
        buildId: "clean-tree",
        buildName: "Clean Tree",
        controllingPlanPath: "/exports/plan.md",
        buildPromptPath: "/exports/prompt.md",
        workOrderPath: "/exports/work_order.json",
        sourceRoot,
        worktreePath,
        branch: "governed/clean-tree",
        baseRef: "abc123",
        head: "abc123",
        allowedWriteScopes: ["src/infra"],
        ownerLease: {
          owner: "Will",
          leaseId: "lease-1",
          acquiredAt: "2026-08-22T14:43Z",
        },
        sourceLock: sourceLockFixture(),
        generatedOutputPolicy: "record_only",
        integrationState: "worktree_active",
        rollbackRef: "abc123",
        proofPaths: ["/proof/source-lock.json"],
        retentionState: "active",
      };

      await expect(
        writeGovernedBuildWorkspaceMetadataFile(metadata, paths.metadataPath),
      ).resolves.toBe(paths.metadataPath);
      await expect(readGovernedBuildWorkspaceMetadataFile(paths.metadataPath)).resolves.toEqual(
        metadata,
      );

      await fs.writeFile(paths.metadataPath, '{"schema":"openclaw.governed_build_workspace.v1"}\n');
      await expect(readGovernedBuildWorkspaceMetadataFile(paths.metadataPath)).rejects.toThrow(
        /Invalid governed build workspace metadata/u,
      );
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("classifies dirty root admission without claiming root is clean", () => {
    const clean = buildDirtyTreeHygieneReport("");
    expect(buildRootBaselineAdmission({ dirtyTree: clean })).toBe("clean");

    const unknownDirty = buildDirtyTreeHygieneReport("?? mystery/file.ts\n");
    expect(buildRootBaselineAdmission({ dirtyTree: unknownDirty })).toBe("blocked");
    expect(
      buildRootBaselineAdmission({
        dirtyTree: unknownDirty,
        operatorAcceptedDirtyFreeze: true,
        unknownAllowed: true,
      }),
    ).toBe("dirty-frozen");

    const knownDirty = buildDirtyTreeHygieneReport(
      " M src/agents/agent-tools.before-tool-call.ts\n",
    );
    expect(buildRootBaselineAdmission({ dirtyTree: knownDirty })).toBe("cleanup-required");
  });

  it("source-lock snapshot hashes tracked, staged, untracked, generated, and worktree truth", () => {
    const base = buildSourceLockSnapshotFromInputs({
      sourceRoot,
      worktreePath,
      branch: "governed/clean-tree",
      head: "abc123",
      baseRef: "abc123",
      indexListing: "a",
      unstagedDiff: "b",
      stagedDiff: "c",
      untrackedManifest: "d",
      ignoredGeneratedManifest: "e",
      worktreeList: "f",
      submoduleStatus: "",
      packageLockContent: "g",
      allowedWriteScopes: ["src/agents", "src/infra"],
      generatedOutputPolicy: "record_only",
      timestamp: "2026-08-22T14:43Z",
      owner: "Will",
    });
    const changed = buildSourceLockSnapshotFromInputs({
      sourceRoot,
      worktreePath,
      branch: "governed/clean-tree",
      head: "abc123",
      baseRef: "abc123",
      indexListing: "a",
      unstagedDiff: "changed",
      stagedDiff: "c",
      untrackedManifest: "d",
      ignoredGeneratedManifest: "e",
      worktreeList: "f",
      submoduleStatus: "",
      packageLockContent: "g",
      allowedWriteScopes: ["src/infra", "src/agents"],
      generatedOutputPolicy: "record_only",
      timestamp: "2026-08-22T14:43Z",
      owner: "Will",
    });

    expect(base.unstagedDiffHash).not.toBe(changed.unstagedDiffHash);
    expect(base.indexHash).toBe(changed.indexHash);
    expect(base.allowedWriteScopes).toEqual(["src/agents", "src/infra"]);
  });

  it("reports stale/prunable worktree records without hiding them", () => {
    const stale = listStaleWorktreeRecords(
      [
        "worktree /home/will/openclaw-source",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /tmp/openclaw-update-preflight/worktree",
        "HEAD def",
        "detached",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\n"),
    );

    expect(stale).toEqual([
      {
        worktreePath: "/tmp/openclaw-update-preflight/worktree",
        head: "def",
        detached: true,
        prunable: true,
        prunableReason: "gitdir file points to non-existent location",
      },
    ]);
  });

  it("plans worktree create, reattach, stale reporting, and blocked root admission", () => {
    const workspaceRoot =
      "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces";

    expect(
      planGovernedBuildWorktreeAdmission({
        rootAdmission: "clean",
        workspaceRoot,
        buildId: "Clean Tree",
        worktreeListOutput: `worktree ${sourceRoot}\nHEAD abc\nbranch refs/heads/main\n`,
      }),
    ).toMatchObject({
      admitted: true,
      action: "create",
      branch: "governed/clean-tree",
      paths: {
        sourcePath:
          "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
      },
      staleWorktrees: [],
    });

    expect(
      planGovernedBuildWorktreeAdmission({
        rootAdmission: "dirty-frozen",
        workspaceRoot,
        buildId: "Clean Tree",
        worktreeListOutput: [
          "worktree /home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/source",
          "HEAD abc",
          "branch refs/heads/governed/clean-tree",
          "",
          "worktree /tmp/openclaw-update-preflight/worktree",
          "HEAD def",
          "detached",
          "prunable stale test record",
          "",
        ].join("\n"),
      }),
    ).toMatchObject({
      admitted: true,
      action: "reattach",
      staleWorktrees: [
        {
          worktreePath: "/tmp/openclaw-update-preflight/worktree",
          prunable: true,
          prunableReason: "stale test record",
        },
      ],
    });

    expect(
      planGovernedBuildWorktreeAdmission({
        rootAdmission: "cleanup-required",
        workspaceRoot,
        buildId: "Clean Tree",
        worktreeListOutput: "",
      }),
    ).toMatchObject({
      admitted: false,
      action: "blocked",
      reason: "root baseline admission is cleanup-required",
    });
  });

  it("creates and then reattaches an actual git worktree in temp fixtures", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governed-worktree-"));
    const rootRepoPath = path.join(fixtureRoot, "root");
    const workspaceRoot = path.join(fixtureRoot, "workspaces");
    await fs.mkdir(rootRepoPath, { recursive: true });
    await execFile("git", ["-C", rootRepoPath, "init"]);
    await fs.writeFile(path.join(rootRepoPath, "package.json"), '{"name":"fixture"}\n');
    await execFile("git", ["-C", rootRepoPath, "add", "package.json"]);
    await execFile("git", [
      "-C",
      rootRepoPath,
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);

    const created = await ensureGovernedBuildWorktree({
      rootRepoPath,
      rootAdmission: "clean",
      workspaceRoot,
      buildId: "Clean Tree",
      baseRef: "HEAD",
    });

    expect(created).toMatchObject({
      admitted: true,
      action: "create",
      branch: "governed/clean-tree",
    });
    expect((await fs.stat(created.paths.sourcePath)).isDirectory()).toBe(true);

    const reattached = await ensureGovernedBuildWorktree({
      rootRepoPath,
      rootAdmission: "dirty-frozen",
      workspaceRoot,
      buildId: "Clean Tree",
      baseRef: "HEAD",
    });

    expect(reattached).toMatchObject({
      admitted: true,
      action: "reattach",
    });
    expect(reattached.gitCommands.at(-1)).toEqual([
      "git",
      "-C",
      reattached.paths.sourcePath,
      "rev-parse",
      "--show-toplevel",
    ]);

    const blocked = await ensureGovernedBuildWorktree({
      rootRepoPath,
      rootAdmission: "blocked",
      workspaceRoot,
      buildId: "Blocked Tree",
      baseRef: "HEAD",
    });

    expect(blocked).toMatchObject({
      admitted: false,
      action: "blocked",
    });
    expect(blocked.gitCommands).toHaveLength(1);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("classifies generated output and lock files as requiring approval before commit", () => {
    expect(classifyGovernedBuildArtifact("dist/index.js")).toEqual({
      generated: true,
      commitRequiresApproval: true,
    });
    expect(classifyGovernedBuildArtifact(".artifacts/proof.json")).toEqual({
      generated: true,
      commitRequiresApproval: true,
    });
    expect(classifyGovernedBuildArtifact("./.artifacts/proof.json")).toEqual({
      generated: true,
      commitRequiresApproval: true,
    });
    expect(classifyGovernedBuildArtifact("pnpm-lock.yaml")).toEqual({
      generated: false,
      commitRequiresApproval: true,
    });
    expect(classifyGovernedBuildArtifact("src/infra/feature.ts")).toEqual({
      generated: false,
      commitRequiresApproval: false,
    });
  });

  it("enforces generated-output commit policy separately from source artifacts", () => {
    expect(
      evaluateGeneratedOutputCommitPolicy({ path: "src/infra/feature.ts", policy: "deny_commit" }),
    ).toEqual({
      allowed: true,
      requiresApproval: false,
      reason: "source_artifact",
    });
    expect(
      evaluateGeneratedOutputCommitPolicy({ path: "dist/index.js", policy: "record_only" }),
    ).toEqual({
      allowed: false,
      requiresApproval: true,
      reason: "record_only_not_committable",
    });
    expect(
      evaluateGeneratedOutputCommitPolicy({
        path: "pnpm-lock.yaml",
        policy: "include_with_approval",
      }),
    ).toEqual({
      allowed: true,
      requiresApproval: true,
      reason: "policy_approval_required",
    });
  });

  it("denies root and targetless governed source mutation", () => {
    expect(
      evaluateRootMutationGuard({
        context: guardContext(),
        cwd: sourceRoot,
        sourceModifying: true,
        readOnlyDiagnostic: false,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "root_source_mutation_denied",
    });

    expect(
      evaluateRootMutationGuard({
        context: guardContext(),
        cwd: worktreePath,
        sourceModifying: true,
        readOnlyDiagnostic: false,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "outside_allowed_workspace_scope",
    });
  });

  it("blocks worktree mutations outside the allowed write scopes", () => {
    expect(
      evaluateRootMutationGuard({
        context: guardContext(),
        cwd: worktreePath,
        targetPaths: [`${worktreePath}/src/governance/off-plan.ts`],
        sourceModifying: true,
        readOnlyDiagnostic: false,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "outside_allowed_workspace_scope",
    });

    expect(
      evaluateRootMutationGuard({
        context: guardContext(),
        cwd: worktreePath,
        targetPaths: [`${worktreePath}/src/infra/governed-build-workspace.ts`],
        sourceModifying: true,
        readOnlyDiagnostic: false,
      }),
    ).toEqual({ allowed: true, reason: "inside_worktree" });
  });

  it("allows read-only diagnostics and Mark-facing export writes while guarded", () => {
    expect(
      evaluateRootMutationGuard({
        context: guardContext(),
        cwd: sourceRoot,
        sourceModifying: false,
        readOnlyDiagnostic: true,
      }),
    ).toEqual({ allowed: true, reason: "read_only" });

    expect(
      evaluateRootMutationGuard({
        context: guardContext(),
        cwd: "/home/will/.openclaw/workspace-orchestrator",
        targetPaths: ["/home/will/.openclaw/workspace-orchestrator/file_hub/exports/closeout.md"],
        sourceModifying: true,
        readOnlyDiagnostic: false,
      }),
    ).toEqual({ allowed: true, reason: "mark_facing_export" });
  });

  it("requires explicit emergency override metadata to allow root mutation", () => {
    expect(
      evaluateRootMutationGuard({
        context: {
          ...guardContext(),
          emergencyOverride: {
            authorized: true,
            authority: "",
            reason: "approved hotfix",
            scope: [],
            timestamp: "2026-08-22T14:43Z",
            preLockHash: "abc123",
          },
        },
        cwd: sourceRoot,
        sourceModifying: true,
        readOnlyDiagnostic: false,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "emergency_override_metadata_required",
    });

    expect(
      evaluateRootMutationGuard({
        context: {
          ...guardContext(),
          emergencyOverride: {
            authorized: true,
            authority: "Mark/operator",
            reason: "approved hotfix",
            scope: ["src/infra/hotfix.ts"],
            timestamp: "2026-08-22T14:43Z",
            preLockHash: "abc123",
          },
        },
        cwd: sourceRoot,
        targetPaths: [`${sourceRoot}/src/infra/hotfix.ts`],
        sourceModifying: true,
        readOnlyDiagnostic: false,
      }),
    ).toEqual({ allowed: true, reason: "emergency_override" });

    expect(
      evaluateRootMutationGuard({
        context: {
          ...guardContext(),
          emergencyOverride: {
            authorized: true,
            authority: "Mark/operator",
            reason: "approved hotfix",
            scope: ["src/infra/hotfix.ts"],
            timestamp: "2026-08-22T14:43Z",
            preLockHash: "abc123",
          },
        },
        cwd: sourceRoot,
        targetPaths: [`${sourceRoot}/src/agents/off-scope.ts`],
        sourceModifying: true,
        readOnlyDiagnostic: false,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "emergency_override_metadata_required",
    });
  });

  it("validates Cleanup Crew and Grant review metadata before integration", () => {
    const metadata = buildCleanupCrewWorkspaceReviewMetadata({
      implementationOwner: "Cleanup Crew implementation mechanic",
      workspaceMetadataPath: "/workspace/clean-tree/workspace.json",
      diffProofPath: "/workspace/clean-tree/proof/diff.patch",
      reviewResultPath: "/workspace/clean-tree/proof/grant-review.json",
    });

    expect(metadata).toMatchObject({
      controller: "Will",
      reviewer: "Grant",
      grantReadOnly: true,
      reviewBeforeIntegration: true,
    });
    expect(validateCleanupCrewWorkspaceReviewMetadata(metadata)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateCleanupCrewWorkspaceReviewMetadata({
        controller: "Will",
        implementationOwner: "Cleanup Crew implementation mechanic",
        reviewer: "Grant",
        grantReadOnly: false,
        reviewBeforeIntegration: false,
      }),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "Grant review must be read-only",
        "reviewBeforeIntegration is required",
        "workspaceMetadataPath is required",
      ]),
    });
  });

  it("keeps Mark-facing reports flat and bulky proof under workspace proof", () => {
    const contract = {
      markFacingExportRoot: "/home/will/.openclaw/workspace-orchestrator/file_hub/exports",
      workspaceProofRoot:
        "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/proof",
      reportPaths: [
        "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/clean-tree-closeout.md",
      ],
      proofPaths: [
        "/home/will/.openclaw/workspace-orchestrator/var/governed_build_workspaces/clean-tree/proof/source-lock.json",
      ],
    };

    expect(validateWorkspaceReportSeparationContract(contract)).toEqual({
      valid: true,
      errors: [],
    });

    expect(
      validateWorkspaceReportSeparationContract({
        ...contract,
        reportPaths: [
          "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/nested/closeout.md",
        ],
        proofPaths: [
          "/home/will/.openclaw/workspace-orchestrator/file_hub/exports/bulky-receipt.json",
        ],
      }),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "report path must be flat in export root: /home/will/.openclaw/workspace-orchestrator/file_hub/exports/nested/closeout.md",
        "proof path is outside workspace proof root: /home/will/.openclaw/workspace-orchestrator/file_hub/exports/bulky-receipt.json",
        "bulky proof path must not be stored under export root: /home/will/.openclaw/workspace-orchestrator/file_hub/exports/bulky-receipt.json",
      ]),
    });
  });

  it("blocks controlled integration when review, tests, root lock, or rollback proof are missing", () => {
    expect(
      evaluateControlledIntegrationReadiness({
        worktreeHasReviewedDiff: true,
        workspaceMetadataVerified: false,
        grantReviewWorkspaceVerified: false,
        reviewPassed: false,
        testsPassed: true,
        rootLockMatchesExpected: false,
        conflictsResolved: true,
        rollbackRefExists: false,
        postIntegrationLockRecorded: false,
        integrationArtifacts: [],
      }),
    ).toEqual({
      ready: false,
      state: "blocked",
      missing: [
        "verified workspace metadata",
        "Grant workspace verification",
        "passing reviewer result",
        "matching root source lock",
        "rollback ref",
        "post-integration source lock",
      ],
    });

    expect(
      evaluateControlledIntegrationReadiness({
        worktreeHasReviewedDiff: true,
        workspaceMetadataVerified: true,
        grantReviewWorkspaceVerified: true,
        reviewPassed: true,
        testsPassed: true,
        rootLockMatchesExpected: true,
        conflictsResolved: true,
        rollbackRefExists: true,
        postIntegrationLockRecorded: true,
        integrationArtifacts: [],
      }),
    ).toEqual({ ready: true, state: "integration_ready", missing: [] });
  });

  it("blocks controlled integration when the reviewed artifact manifest is omitted", () => {
    expect(
      evaluateControlledIntegrationReadiness({
        worktreeHasReviewedDiff: true,
        workspaceMetadataVerified: true,
        grantReviewWorkspaceVerified: true,
        reviewPassed: true,
        testsPassed: true,
        rootLockMatchesExpected: true,
        conflictsResolved: true,
        rollbackRefExists: true,
        postIntegrationLockRecorded: true,
      } as never),
    ).toEqual({
      ready: false,
      state: "blocked",
      missing: ["reviewed integration artifact manifest"],
    });
  });

  it("blocks controlled integration when generated or lock artifacts lack policy approval", () => {
    expect(
      evaluateControlledIntegrationReadiness({
        worktreeHasReviewedDiff: true,
        workspaceMetadataVerified: true,
        grantReviewWorkspaceVerified: true,
        reviewPassed: true,
        testsPassed: true,
        rootLockMatchesExpected: true,
        conflictsResolved: true,
        rollbackRefExists: true,
        postIntegrationLockRecorded: true,
        integrationArtifacts: [
          { path: "dist/index.js", policy: "record_only" },
          { path: "pnpm-lock.yaml", policy: "include_with_approval" },
        ],
      }),
    ).toEqual({
      ready: false,
      state: "blocked",
      missing: [
        "committable artifact policy for dist/index.js",
        "policy approval for pnpm-lock.yaml",
      ],
    });

    expect(
      evaluateControlledIntegrationReadiness({
        worktreeHasReviewedDiff: true,
        workspaceMetadataVerified: true,
        grantReviewWorkspaceVerified: true,
        reviewPassed: true,
        testsPassed: true,
        rootLockMatchesExpected: true,
        conflictsResolved: true,
        rollbackRefExists: true,
        postIntegrationLockRecorded: true,
        integrationArtifacts: [
          { path: "src/infra/governed-build-workspace.ts", policy: "record_only" },
          { path: "pnpm-lock.yaml", policy: "include_with_approval", approved: true },
        ],
      }),
    ).toEqual({ ready: true, state: "integration_ready", missing: [] });
  });
});
