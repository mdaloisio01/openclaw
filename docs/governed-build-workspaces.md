# Governed Build Workspaces

Governed source builds must not use the primary source checkout as a scratchpad.

The root source repo is the baseline and controlled integration surface. Build work happens in a durable external git worktree with a metadata record, source-lock snapshot, proof directory, review result, and integration state.

## Default Layout

- Source root: `<source-root>`
- Workspace state root: `<workspace-state-root>/governed_build_workspaces/`
- Per-build source worktree: `<workspace-state-root>/governed_build_workspaces/<build_id>/source`
- Per-build metadata: `<workspace-state-root>/governed_build_workspaces/<build_id>/workspace.json`
- Per-build proof: `<workspace-state-root>/governed_build_workspaces/<build_id>/proof/`
- Operator-facing exports: `<workspace-file-hub>/exports/`

## Required Flow

1. Freeze root truth before source mutation.
2. Admit the root as `clean`, `dirty-frozen`, `cleanup-required`, or `blocked`.
3. Create or validate the build-specific worktree.
4. Write `workspace.json` with the controlling plan, prompt, work order, source lock, owner lease, allowed write scopes, generated-output policy, proof paths, rollback ref, and integration state.
5. Perform source edits only in the active build worktree.
6. Store bulky receipts under the build workspace proof directory.
7. Store operator-facing reports, prompts, work orders, and closeouts as flat files in exports.
8. Require reviewer pass and test proof before integration.
9. Verify the root source lock before integration.
10. Integrate through the controlled integration lane.
11. Record the post-integration root lock and rollback ref.
12. Close the build only after proof, review, integration, and reporting are complete.

## Root Mutation Rule

When a governed build workspace is active, source-modifying tools running from the primary source checkout must be denied unless an explicit emergency override is present. Read-only diagnostics remain allowed. Operator-facing export writes remain allowed.

Emergency root mutation must name the authority, reason, exact scope, timestamp, and pre-lock hash.

Source writes inside the isolated worktree are still bounded by the workspace metadata's allowed write scopes. A worktree path match alone does not authorize off-plan source mutation.

## Generated Output Rule

Generated paths, build output, logs, `.artifacts`, and lock files must be classified separately from source implementation. Generated output may be recorded as proof, but it cannot silently broaden the source change or be committed without policy approval.

Generated-output policies:

- `record_only`: generated output may be recorded as proof but is not committable.
- `include_with_approval`: generated output or lockfile changes require explicit policy approval before inclusion.
- `deny_commit`: generated output and lockfile changes remain blocked from source integration.

## Cleanup Crew and Review Contract

Cleanup Crew workspace metadata must name the controller, the implementation mechanic as implementation owner, the reviewer, read-only review, required review before integration, the workspace metadata path, the diff proof path, and the review result path.

Reviewer pass must verify the build workspace metadata and diff before integration. Review success alone is not enough if it does not verify the active workspace identity and proof paths.

## Export and Proof Separation

Operator-facing plans, prompts, work orders, reports, and closeouts stay as flat files directly under `file_hub/exports/`. Do not create export-tab subdirectories.

Bulky receipts, source-lock JSON, dirty-state snapshots, diff proof, test logs, generated-output manifests, and review result payloads stay under `var/governed_build_workspaces/<build_id>/proof/`. Operator-facing exports should point to those internal proof paths instead of copying bulky proof into the flat export directory.

## Integration Rule

Integration cannot proceed unless:

- the worktree diff was reviewed;
- the workspace metadata was verified;
- the reviewer verified the workspace and diff proof;
- the reviewer passed;
- tests passed in the worktree;
- the root lock still matches the expected source state;
- conflicts are explicitly resolved;
- rollback ref exists;
- post-integration source lock is recorded.

If any of those checks are missing, integration is blocked and the build remains open.
