---
summary: "CLI reference for `openclaw tasks` (background task ledger and Task Flow state)"
read_when:
  - You want to inspect, audit, or cancel background task records
  - You are documenting Task Flow commands under `openclaw tasks flow`
title: "`openclaw tasks`"
---

Inspect durable background tasks and Task Flow state. With no subcommand,
`openclaw tasks` is equivalent to `openclaw tasks list`.

See [Background Tasks](/automation/tasks) for the lifecycle and delivery model.

## Usage

```bash
openclaw tasks
openclaw tasks list
openclaw tasks list --runtime acp
openclaw tasks list --status running
openclaw tasks show <lookup>
openclaw tasks notify <lookup> state_changes
openclaw tasks cancel <lookup>
openclaw tasks audit
openclaw tasks maintenance
openclaw tasks maintenance --apply
openclaw tasks flow list
openclaw tasks flow show <lookup>
openclaw tasks flow cancel <lookup>
openclaw tasks flow governance show <lookup>
openclaw tasks flow governance preview <lookup> --operation <name>
openclaw tasks flow governance receipts <lookup> --limit 20
```

## Root Options

- `--json`: output JSON.
- `--runtime <name>`: filter by kind: `subagent`, `acp`, `cron`, or `cli`.
- `--status <name>`: filter by status: `queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, or `lost`.

## Subcommands

### `list`

```bash
openclaw tasks list [--runtime <name>] [--status <name>] [--json]
```

Lists tracked background tasks newest first.

### `show`

```bash
openclaw tasks show <lookup> [--json]
```

Shows one task by task ID, run ID, or session key.

### `notify`

```bash
openclaw tasks notify <lookup> <done_only|state_changes|silent>
```

Changes the notification policy for a running task.

### `cancel`

```bash
openclaw tasks cancel <lookup>
```

Cancels a running background task.

### `audit`

```bash
openclaw tasks audit [--severity <warn|error>] [--code <name>] [--limit <n>] [--json]
```

Surfaces stale, lost, delivery-failed, or otherwise inconsistent task and Task Flow records. Lost tasks retained until `cleanupAfter` are warnings; expired or unstamped lost tasks are errors.

### `maintenance`

```bash
openclaw tasks maintenance [--apply] [--json]
```

Previews or applies task and Task Flow reconciliation, cleanup stamping, pruning,
and stale cron run session registry cleanup.
For cron tasks, reconciliation uses persisted run logs/job state before marking an
old active task `lost`, so completed cron runs do not become false audit errors
just because the in-memory Gateway runtime state is gone. Offline CLI audit is
not authoritative for the Gateway's process-local cron active-job set. CLI tasks
with a run id/source id are marked `lost` when their live Gateway run context is
gone, even if an old child-session row remains.
When applied, maintenance also prunes `cron:<jobId>:run:<uuid>` session registry
rows older than 7 days while preserving currently running cron jobs and leaving
non-cron session rows untouched.

### `flow`

```bash
openclaw tasks flow list [--status <name>] [--json]
openclaw tasks flow show <lookup> [--json]
openclaw tasks flow cancel <lookup>
openclaw tasks flow governance show <lookup> [--json]
openclaw tasks flow governance preview <lookup> --operation <name> [--json]
openclaw tasks flow governance receipts <lookup> [--limit <n>] [--json]
```

Inspects or cancels durable Task Flow state under the task ledger.

The `governance` commands are read-only:

- `show` displays the canonical mission identity, lifecycle state, revisions,
  source/build/policy/skill bindings, and proof gates. It redacts authority
  locations and runtime correlation details.
- `preview` evaluates one named lifecycle operation without updating SQLite or
  writing a receipt. Its JSON decision includes `status`, `reasonCode`, current
  and proposed states, `missingProof`, and one `nextAction`. It remeasures the
  pinned authority and loaded runtime identity, and cancel/stop previews report
  a conflict while linked child work remains active.
- `receipts` returns at most 500 recent append-only transition and verification
  receipts. The default limit is 50.

Their lookup accepts a flow ID or owner session key. An owner key selects its
governed mission even when that owner has a newer ordinary flow.

The CLI does not admit governed work. Governed production admission is an
authenticated Gateway operation on `tasks.startProductionFlow`; use these CLI
commands to inspect or preview the resulting canonical state. Authenticated
runtime owners advance named proof operations through `tasks.governance.apply`;
the CLI intentionally exposes no mutation command.

Implementation, validation, and review actions name a completed Task Flow child
task. The Gateway derives pass/fail from that task and verifies its persisted
executor assignment and contract-pinned paired-device producer; clients do not
submit proof booleans. A successful `releaseFinalResult` response returns the
durably withheld payload only after the release gate passes. Delivery proof is a
later acknowledgment from the pinned delivery device and must echo that release
receipt ID and payload hash. Drift recovery uses the `requestReadmission` action
with a complete replacement governed package.

The operation name must be one of `startWorkOrder`,
`recordImplementationResult`, `recordValidationResult`, `recordReviewResult`,
`requestCloseout`, `verifyRequiredArtifacts`,
`admitTerminalPendingWatchdog`, `recordPostTerminalWatchdog`,
`releaseFinalResult`, `recordDeliveryResult`, `blockForRepair`,
`requestReadmission`, `cancelMission`, or `stopMission`.

Preview treats unprovided result proof conservatively. For example, previewing
`recordValidationResult` reports the missing validation proof; it never assumes
that validation passed. `requestReadmission` preview also denies by default
because lawful readmission requires a complete replacement identity, compiled
plan, and pinned artifact declaration package; the read-only CLI does not invent
that package.

`openclaw tasks audit` also observes governed flows. Governed findings identify
missing or non-head SQLite package provenance, owner-flow identity mismatches,
repair still required at the current revision, missing post-terminal watchdog
proof, and release state that disagrees with the Task Flow terminal state. Audit
reports these conditions; it does not run lifecycle operations or manufacture
proof.

## Related

- [CLI reference](/cli)
- [Background tasks](/automation/tasks)
