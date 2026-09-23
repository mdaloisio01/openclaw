---
summary: "Task Flow orchestration layer above background tasks"
read_when:
  - You want to understand how Task Flow relates to background tasks
  - You encounter Task Flow or openclaw tasks flow in release notes or docs
  - You want to inspect or manage durable flow state
title: "Task flow"
---

Task Flow is the flow orchestration substrate that sits above [background tasks](/automation/tasks). It manages durable multi-step flows with their own state, revision tracking, and sync semantics while individual tasks remain the unit of detached work.

## When to use Task Flow

Use Task Flow when work spans multiple sequential or branching steps and you need durable progress tracking across gateway restarts. For single background operations, a plain [task](/automation/tasks) is sufficient.

| Scenario                              | Use                  |
| ------------------------------------- | -------------------- |
| Single background job                 | Plain task           |
| Multi-step pipeline (A then B then C) | Task Flow (managed)  |
| Observe externally created tasks      | Task Flow (mirrored) |
| One-shot reminder                     | Cron job             |

## Reliable scheduled workflow pattern

For recurring workflows such as market intelligence briefings, treat the schedule, orchestration, and reliability checks as separate layers:

1. Use [Scheduled Tasks](/automation/cron-jobs) for timing.
2. Use a persistent cron session when the workflow should build on prior context.
3. Use [Lobster](/tools/lobster) for deterministic steps, approval gates, and resume tokens.
4. Use Task Flow to track the multi-step run across child tasks, waits, retries, and gateway restarts.

Example cron shape:

```bash
openclaw cron add \
  --name "Market intelligence brief" \
  --cron "0 7 * * 1-5" \
  --tz "America/New_York" \
  --session session:market-intel \
  --message "Run the market-intel Lobster workflow. Verify source freshness before summarizing." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

Use `session:<id>` instead of `isolated` when the recurring workflow needs deliberate history, previous run summaries, or standing context. Use `isolated` when each run should start fresh and all required state is explicit in the workflow.

Inside the workflow, put reliability checks before the LLM summary step:

```yaml
name: market-intel-brief
steps:
  - id: preflight
    command: market-intel check --json
  - id: collect
    command: market-intel collect --json
    stdin: $preflight.json
  - id: summarize
    command: market-intel summarize --json
    stdin: $collect.json
  - id: approve
    command: market-intel deliver --preview
    stdin: $summarize.json
    approval: required
  - id: deliver
    command: market-intel deliver --execute
    stdin: $summarize.json
    condition: $approve.approved
```

Recommended preflight checks:

- Browser availability and profile choice, for example `openclaw` for managed state or `user` when a signed-in Chrome session is required. See [Browser](/tools/browser).
- API credentials and quota for each source.
- Network reachability for required endpoints.
- Required tools enabled for the agent, such as `lobster`, `browser`, and `llm-task`.
- Failure destination configured for cron so preflight failures are visible. See [Scheduled Tasks](/automation/cron-jobs#delivery-and-output).

Recommended data provenance fields for every collected item:

```json
{
  "sourceUrl": "https://example.com/report",
  "retrievedAt": "2026-04-24T12:00:00Z",
  "asOf": "2026-04-24",
  "title": "Example report",
  "content": "..."
}
```

Have the workflow reject or mark stale items before summarization. The LLM step should receive only structured JSON and should be asked to preserve `sourceUrl`, `retrievedAt`, and `asOf` in its output. Use [LLM Task](/tools/llm-task) when you need a schema-validated model step inside the workflow.

For reusable team or community workflows, package the CLI, `.lobster` files, and any setup notes as a skill or plugin and publish it through [ClawHub](/clawhub). Keep workflow-specific guardrails in that package unless the plugin API is missing a needed generic capability.

## Sync modes

### Managed mode

Task Flow owns the lifecycle end-to-end. It creates tasks as flow steps, drives them to completion, and advances the flow state automatically.

Example: a weekly report flow that (1) gathers data, (2) generates the report, and (3) delivers it. Task Flow creates each step as a background task, waits for completion, then moves to the next step.

```
Flow: weekly-report
  Step 1: gather-data     → task created → succeeded
  Step 2: generate-report → task created → succeeded
  Step 3: deliver         → task created → running
```

### Mirrored mode

Task Flow observes externally created tasks and keeps flow state in sync without taking ownership of task creation. This is useful when tasks originate from cron jobs, CLI commands, or other sources and you want a unified view of their progress as a flow.

Example: three independent cron jobs that together form a "morning ops" routine. A mirrored flow tracks their collective progress without controlling when or how they run.

## Durable state and revision tracking

Each flow persists its own state and tracks revisions so progress survives gateway restarts. Revision tracking enables conflict detection when multiple sources attempt to advance the same flow concurrently.
The flow registry uses SQLite with bounded write-ahead-log maintenance, including
periodic and shutdown checkpoints, so long-running gateways do not retain
unbounded `registry.sqlite-wal` sidecar files.

### Governed mission lifecycle

A governed managed flow stores one canonical mission record in the Task Flow
`stateJson`. Task Flow owns persistence; the governed evaluator decides whether a
named operation is admissible. The contract, authority, plan, source, runtime
build, policy, and skill hashes remain pinned across every operation. Transition
and artifact-verification receipts are append-only rows in the shared state
database. Each runtime receipt advances a per-flow hash chain and binds the
complete governed package: flow lifecycle fields, contract, mission state,
compiled plan, artifact declarations, proof/watchdog state, and pinned release
state. Runtime reads accept only the latest matching ledger head, so replaying an
older state or changing proof data without a receipt fails closed. The runtime
verifies the complete receipt chain on first use and after an external SQLite
change, then checks the validated head on routine appends. Release proof reads
verify every contiguous receipt and hash link from sequence 1 through the head.
A denied pre-flow admission
is stored without a flow ID, preserving its audit and idempotency record without
pretending that a governed package exists. A malformed package without a mission
ID uses a stable admission-attempt identity for the same purpose. Contracts that
name another completion owner or require receipt classes the pinned plan cannot
produce are denied at admission; a required rollback receipt, for example, needs
a required rollback gate in that plan.
The observed authority reference must exactly match one of the contract's pinned
references, including its kind, URI, reference ID, and authority hash. For
production admission, the referenced file must be a JSON authorization record
with schema `openclaw.governed_authority_plan.v1`, `planRevisionId`,
`planSha256`, `scopeHash`, `authorizedScopeHash`, and
`planRevisionAuthorized: true`. The server computes `planSha256` from the
compiled manifest, requirements, and gates, omitting only the manifest's own
`planSha256` field; it hashes the recursively key-sorted JSON with SHA-256.
The measured file must name that digest and the same authorized revision and
scope. Readmission applies the same binding to the replacement contract.

Admission also pins a bounded artifact declaration set. Every required compiled
gate must have a matching required declaration tied to the admitted mission,
work order, gate, allowed root, and current
contract/authority/plan/source/build/policy/skill identity. Closeout verification
checks the complete pinned set from disk; a caller cannot substitute a new path,
artifact label, or easier declaration at verification time.

Governed proof artifacts must be written beneath
`<agent-workspace>/.openclaw/governed-artifacts/<mission-id>/`. Admission rejects
declarations outside that mission-specific directory and replaces every submitted
`allowedRoot` with the server-derived directory. It also rejects common credential
and private-key filenames. This keeps artifact verification from becoming a
general workspace file reader.

The successful path is:

```text
admitted -> executing -> implementation_complete -> validation_complete
-> review_complete -> closeout_ready -> artifact_verified
-> terminal_pending_watchdog -> released
```

`pending_override`, `closeout_ready`, `artifact_verified`,
`terminal_pending_watchdog`, and `released` are lock states. Protected tool,
exec, and child-delegation actions fail closed there. Entering closeout also
closes child creation in the same SQLite transaction. Terminal-pending admission
derives the active-child count and parent-scope facts from canonical Task Flow
state, rechecks the active-child count atomically, and closes the production
continuation in that same governed transaction. Caller-supplied counts and racing
child creation cannot bypass the fence.

Missing proof does not silently complete the mission, and it does not permanently
trap the flow. The attempted operation returns `repair_required`, leaves the prior
state authoritative, records one denial receipt, and names the next repair action.
The flow moves to the explicit `repair_required` state only through the named
repair operation. Generic Task Flow completion also leaves a governed flow
unchanged until its canonical mission reaches `released`.

Identity drift moves a nonterminal mission to `readmission_required`. Readmission
must atomically replace the pinned contract, identity, compiled plan, artifact
declarations, and visible-delivery requirement with one internally consistent package. It resets stale proof and
watchdog state, returns the Task Flow to `queued`, and records replacement
admission and policy-decision receipt kinds under the new identity. An incomplete
replacement package leaves the mission blocked with one repair action instead of
silently accepting stale proof.

Artifact verification reads a declared file only within its allowed root. It
resolves in-root symlinks, rejects escaping symlinks, hardlink aliases, secret
paths, and unsupported file types, bounds the number of declarations and bytes
read, and checks configured labels, structured fields, timestamps, hashes, and
mission identity. The verifier binds metadata and the hash to the same open file
descriptor and rejects a file that changes during the read. A path string by
itself is never completion proof.
An identical artifact-verification retry resolves its idempotency receipt before
reading the current file or revision again. Reusing the key with a different
stable request still conflicts.

The governance ledger uses `governed_mission_receipts` and
`governed_mission_artifacts` in shared SQLite state. False-closeout and active-run
durability writers use the same ledger. `openclaw doctor --fix` can import the
older false-closeout decision JSON files idempotently and records the migration.
For a destructive import, doctor first atomically renames the source directory,
imports that stable snapshot, and rechecks every content hash before deletion.
The staging path is deterministic, so a later doctor run resumes a snapshot left
by a process interruption; ordinary exceptions restore the original source path
when possible. A concurrent writer, changed file, or invalid source remains on
disk for a later repair/import. The SQLite row retains a bounded audit payload
with the detailed decision and evidence manifest; free-form closeout text is
replaced by its hash and byte count. Normal runtime does not dual-write or read
through the old directory.

Task Flow audit observes this canonical state without executing mission work. It
reports malformed state, missing admission or current-state provenance,
flow-identity mismatch, canonical repair/readmission state, unresolved
current-revision repair results, missing post-terminal watchdog proof, and a
release/Task Flow terminal-state disagreement.

Use the read-only CLI before attempting a transition:

```bash
openclaw tasks flow governance show <flow-id>
openclaw tasks flow governance preview <flow-id> --operation requestCloseout --json
openclaw tasks flow governance receipts <flow-id> --limit 20 --json
```

`show`, `preview`, and `receipts` do not update flow state or create receipts.
Preview remeasures the pinned authority and loaded runtime identity, reports
active child work that blocks direct cancel/stop, and does not invent result
proof. Operations that record implementation, validation, review, artifact,
watchdog, release, or delivery results are shown conservatively until their
owner supplies real proof through the authenticated owner operation.

`released` means the final result passed its release gate. The runtime derives
that decision from the pinned contract, its authoritative completion owner, the
canonical required receipt kinds, complete closeout proof, and the current
watchdog-bound revision. A caller-supplied boolean cannot authorize release. If
the admitted contract requires visible delivery proof, Task Flow remains
nonterminal until a separate delivery result passes. A failed or missing delivery
attempt leaves the released state and prior proof intact, records the denial, and
names delivery as the next repair action.

The Gateway exposes read-only status and preview with `operator.read`. Governed
production admission uses the existing `tasks.startProductionFlow` owner boundary
with `operator.write`: callers may supply a closed `governedMission` package, but
they cannot assert enforcement-health or host-authority facts. The Gateway reads
and hashes the pinned local authority file, rejects dirty or unverifiable builds,
and measures the complete built `.js`, `.mjs`, and `.cjs` artifact set with its adjacent build metadata,
compiles the submitted manifest and requirements, checks the compiled plan against
the measured authorization record, and applies the production owner-lane
guard, and admits the mission and Task Flow in one SQLite transaction. Admission
is denied while that owner has a queued or active agent run, and the transaction
rejects a second governed mission claim for an owner even after the first mission
becomes terminal. Unknown
package fields, stale authority bytes, source/build mismatches, invalid plans, and
incomplete artifact declarations fail closed. Omitting `governedMission` preserves
ordinary production Task Flow creation.
An identical admission or readmission retry resolves its saved receipt before
remeasuring authority, runtime, or skill files; changing request fields under
the same idempotency key returns a conflict.

Before an embedded model turn, the runtime resolves the active governed flow by
the agent session owner. It requires exactly one canonical nonterminal mission,
validates the receipt chain, advances `admitted` to `executing`, opens a persisted
execution lease, and binds the pinned authority to the same hook context retained
by every core and plugin tool wrapper. The lease closes only after session cleanup
confirms that no tool execution remains active. If timeout cleanup sees a tool
still running, the lease stays fenced and closes when the final execution settles.
After a process restart, a new run may recover an old lease only when its persisted
process identity proves that the prior runtime is gone. Proof, closeout, artifact, watchdog, readmission, and release transitions
fail closed while that lease is open. Malformed, ambiguous, stale, or
untrusted state blocks the model turn. Every tool authorization decision is then
written to the same hash-chained SQLite ledger with the current mission revision;
a stale run cannot append a decision after another transition advances the mission.
Assistant streaming and final payloads are withheld for that executing turn; a
host-authored nonterminal notice is rendered instead. Post-verification and
released states cannot start another model turn, so a model cannot alter proof or
generate a new unbound final after release.

Shell execution and ordinary core file reads are treated as potentially externally
visible output while a governed result is withheld. They remain behind the
final-output release gate because those surfaces do not provide the governance hook
with a root-pinned file descriptor or a non-executing command contract. Structured
core status operations, such as process polling, can still run when they have no
protected side effect. Core network, search, media-generation, and provider-backed
document tools are also treated as external output, so model-controlled request
data cannot leave through those tools before release.

Later proof-producing transitions use the closed, authenticated
`tasks.governance.apply` owner operation. The server derives owner, controller,
identity bindings, and timestamps from canonical state. Artifact verification
collects bounded disk facts, terminal admission derives parent/child facts, and
the post-terminal watchdog result comes from the Task Flow audit. Other named
proof actions carry a child task ID, not a result boolean. The server verifies the
task's terminal and delivery state, persisted executor assignment, required role
and capability, and the paired-device producer pinned in the admitted contract;
successful completion by that exact authenticated producer atomically records the
proof as delivered. The server then derives pass/fail and evidence references. The method cannot set a target
state, inject a receipt, supply artifact or watchdog success, or bypass transition
order. Generic Task Flow creation and updates still cannot inject or mutate
governed lifecycle state.

`requestReadmission` is the write-side recovery path for identity drift. It accepts
a complete replacement governed package and authority path, then remeasures the
authority and loaded runtime before atomically replacing the contract, plan, and
artifact declarations. Read-only preview remains conservative because it cannot
manufacture that package.

Task Flow cancellation also uses the governed transition owner. After child
tasks settle, cancellation atomically records `cancelMission`, updates the
canonical mission to `cancelled`, and updates the Task Flow in the same SQLite
transaction. A cancelled governed flow cannot be restarted from stale mission
state. Direct `cancelMission` and `stopMission` governance operations reject while
any child remains queued or running; use `tasks.cancel` when the Gateway must
request child cancellation and settle the flow first.

### Authoritative child executor assignments

`tasks.runTaskInFlow` is the owner boundary for a production child's executor
assignment. Along with the existing plan, owner-lane, handoff, and backing-session
proof, the request supplies `executorRole`, `permitted`, and `prohibited`.
`executorRole` must be `Coding Agent`, `Grant`, `SADB`, `TaskFlow`, `Watchdog`, or
`Will`; the capability values are listed under [Build issue actions](#build-issue-actions).

Task Flow stores the new child's task row and executor assignment in one SQLite
transaction. The assignment includes task and run identities, executor identity,
owner lane, role, capability sets, and handoff evidence. Governed assignments also
bind the paired device that dispatched the child and join the governed receipt
hash chain. A failed assignment therefore cannot leave an active unassigned task,
and only the pinned device may record the governed child's terminal result. Later
build-issue routing uses this persisted assignment as authority. Executor fields repeated in a
`tasks.handleBuildIssue` request must
match it exactly; they cannot add a lane, role, or capability. A child without a
valid persisted assignment is not eligible for routing.

## Build issue actions

For an active managed production flow, an authorized controller can call the
`tasks.handleBuildIssue` Gateway RPC to record an issue and dispatch the next
authorized action. The method requires `operator.write` and stores its receipts
in the flow's SQLite state. Inspect them with `openclaw tasks flow show <flow-id>`.

This method uses the existing `sessions_send` tool with the same runtime policies
as native MCP, including tool profiles, explicit denies, session visibility, and
agent-to-agent permissions. A tool denial is recorded as a failed dispatch; the
controller does not select another executor to evade that denial. The separate
[HTTP tool restrictions](/gateway/tools-invoke-http-api) remain on generic tool
invocation and are not changed by this method.

Every request supplies these fields:

| Field                     | Meaning                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `flowId`, `ownerKey`      | Existing flow and its exact owner session key.                          |
| `actionId`                | Stable identity for this action and its side effects.                   |
| `occurrenceId`            | Stable identity for this observed occurrence.                           |
| `issueId`                 | Issue identity used to link repeated occurrences within the same owner. |
| `summary`, `evidenceRefs` | Bounded description and references to the observed evidence.            |
| `kind`                    | `triage` or `recover_execution_surface`.                                |

Identity fields contain 1–256 characters. Summaries, dispatch messages, and each
evidence reference contain 1–4,096 characters; evidence arrays contain 1–32 entries.
Unknown fields are rejected.

### Record an incidental issue

Use `kind: "triage"` with an explicit `impact`: `non_blocking`, `current_blocker`,
`unsafe`, `dishonest`, `impossible`, or `operator_decision`. For `non_blocking`,
provide `resume: { executor, message }` to continue the assigned work. The issue
is persisted and read back before the tool is invoked. A current blocker or owner
decision records a continuation boundary and does not dispatch dependent work.

Each executor supplies `taskId`, `expectedRunId`, `ownerLane`, `role`, `permitted`,
`prohibited`, and `evidenceRefs`. The task must belong to this flow and owner, retain
the expected run identity, and have a backing child session. Its lane, role, and
capability sets must exactly match the authoritative assignment recorded by
`tasks.runTaskInFlow`; request fields do not grant authority. Its current status
must be `queued` or `running`, and its owner lane must satisfy the controlling plan.
The controller derives the target session from that task.

Roles are `Coding Agent`, `Grant`, `SADB`, `TaskFlow`, `Watchdog`, or `Will`.
Capability lists use `grant_review`, `production_dispatch`, `repo_read`,
`repo_write`, `report_delivery`, `runtime_restart`, `taskflow_reconciliation`, or
`watchdog_repair`. `permitted` must contain at least one capability. A triage resume
requires `production_dispatch` to be permitted and absent from `prohibited`.

### Recover an unavailable execution surface

Use `kind: "recover_execution_surface"` with `primaryFailure: { taskId, kind,
evidenceRefs }`, `requiredCapability`, an `executors` array, and `message`.
The failure kind is `execution_unavailable` or `policy_denied`. Candidates must
refer to different tasks from the failed primary; at most 32 candidates are accepted.
Selection checks the required capability, owner lane, and current task identity
before invoking the selected session. Stale identities require reconciliation.

If no route is available, an optional `exhaustion` receipt must use the canonical
mission-abort receipt schema, match `flowId` as its `mission_id`, and include evidence
for all 14 continuation classes. Recording that receipt leaves the parent mission
open. Existing owner decisions, safety stops, hard stops, and restart boundaries
must be resolved through their owners before further dispatch.

### Read results and retry

The response contains `receipt`, including the original input, its hash, timestamps,
the decision, and `execution.state`:

| State                      | Meaning                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `not_dispatched`           | A recorded boundary prevents dispatch.                          |
| `dispatch_pending`         | Dispatch intent is durable; its outcome has not been recorded.  |
| `dispatch_unknown`         | The call was interrupted or returned no usable execution proof. |
| `dispatch_failed`          | Admission or policy rejected the dispatch.                      |
| `awaiting_result`          | A run identity is known; its terminal outcome remains unproven. |
| `terminal_result_observed` | The tool or a later wait returned terminal run evidence.        |

Repeat the identical request to read its retained receipt. If it has a known run
in `awaiting_result`, the controller waits briefly for that run and updates the
receipt when terminal proof is available. This includes `sessions_send` errors
that retain a run identity: a lost RPC response does not prove dispatch failed.
Changed input under the same action or
occurrence identity is rejected. Pending or unknown dispatches are never resent
automatically; recover their original execution evidence before authorizing another
action. A terminal child result does not complete the parent flow or prove visible
report delivery.

## Cancel behavior

`openclaw tasks flow cancel` sets a sticky cancel intent on the flow. Active tasks within the flow are cancelled, and no new steps are started. The cancel intent persists across restarts, so a cancelled flow stays cancelled even if the gateway restarts before all child tasks have terminated.

## CLI commands

```bash
# List active and recent flows
openclaw tasks flow list

# Show details for a specific flow
openclaw tasks flow show <lookup>

# Cancel a running flow and its active tasks
openclaw tasks flow cancel <lookup>

# Inspect a governed flow without writing state
openclaw tasks flow governance show <lookup>
openclaw tasks flow governance preview <lookup> --operation <name>
openclaw tasks flow governance receipts <lookup> --limit 20
```

For governance commands, `<lookup>` may be a flow ID or owner session key. An
owner key selects its governed mission even if a newer ordinary flow exists.

| Command                                                          | Description                                   |
| ---------------------------------------------------------------- | --------------------------------------------- |
| `openclaw tasks flow list`                                       | Shows tracked flows with status and sync mode |
| `openclaw tasks flow show <id>`                                  | Inspect one flow by flow id or lookup key     |
| `openclaw tasks flow cancel <id>`                                | Cancel a running flow and its active tasks    |
| `openclaw tasks flow governance show <id>`                       | Show canonical governed state and proof gates |
| `openclaw tasks flow governance preview <id> --operation <name>` | Explain an operation without applying it      |
| `openclaw tasks flow governance receipts <id>`                   | List bounded, redacted governance receipts    |

## How flows relate to tasks

Flows coordinate tasks, not replace them. A single flow may drive multiple background tasks over its lifetime. Use `openclaw tasks` to inspect individual task records and `openclaw tasks flow` to inspect the orchestrating flow.

## Related

- [Background Tasks](/automation/tasks) — the detached work ledger that flows coordinate
- [CLI: tasks](/cli/tasks) — CLI command reference for `openclaw tasks flow`
- [Automation Overview](/automation) — all automation mechanisms at a glance
- [Cron Jobs](/automation/cron-jobs) — scheduled jobs that may feed into flows
