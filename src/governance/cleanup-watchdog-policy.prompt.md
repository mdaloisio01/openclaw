<!-- generated/validated consumer of cleanup-watchdog-policy.ts -->

# Cleanup Crew Watchdog Governance Policy Digest

Policy version: `cleanup-watchdog-governance-20260715T1442Z`

This digest is a compact prompt/SOP consumer of the canonical policy-as-code. It is not an independent authority. If this digest conflicts with `cleanup-watchdog-policy.ts`, the TypeScript policy and schema win and this digest must be regenerated or repaired.

## Priority Order

1. `P1_SAFETY_OR_DUPLICATE_EXECUTION`: safety, destructive-risk, duplicate execution, split-brain, or fencing failure.
2. `P2_ACTIVE_NO_WORKER`: unfinished active production mission with no executor or lost ownership.
3. `P3_CORRUPTED_STATE`: corrupted state, pointer, identity, continuation, lease, or revision.
4. `P4_RESTART_OR_RUNTIME_RECOVERY`: runtime recovery, restart recovery, or mission-resumption failure.
5. `P5_MISSING_PROOF_OR_POLICY_MIGRATION`: missing correctness proof or policy-version migration failure.
6. `P6_REVIEW_REQUIRED_FOR_SAFE_WORK`: reviewer result required for safe active work.
7. `P7_PENDING_REPORT_DELIVERY`: pending milestone or final report delivery.
8. `P8_STALE_ARTIFACT_DEBT`: stale artifact or non-executable reporting debt.

Higher priority findings preempt lower priority work unless the lower priority item is a required dependency for repairing the higher priority finding.

## Clean Dimensions

`CLEAN` requires `suspicious_count=0` and all dimensions passing:

- `record_integrity`
- `worker_coverage`
- `continuation_readiness`
- `delivery_completeness`
- `runtime_health`
- `repair_closure`
- `policy_version`

## Coverage Rule

Every unfinished active production mission must have exactly one current executor lease, or exactly one durable coverage record: `durable_defer`, `external_wait`, `owner_wait`, or `verified_blocker`.

Changing a mission to a blocked-looking status never makes watchdog clean by itself. A verified blocker remains visible through coverage evaluation until it has durable proof, owner, next check, deadline, and policy version.

## Alert Lifecycle

Alert states are separate: `detected`, `delivered`, `acknowledged`, `owned`, `repair_task_created`, `repairing`, `validation_pending`, and closure. Delivery is not acknowledgement. Acknowledgement is not repair. Repair is not closure until validation passes.

Duplicate suppression affects chat delivery only. It never suppresses repair task creation, repair ownership, validation, or closure.

## Milestone And Delivery Rule

Milestone and final report delivery cannot terminate an unfinished mission. Missing delivery creates `pending_milestone_report` or `pending_report_delivery` work while the executable mission remains covered by an executor or durable wait.

## Restart Rule

Restart readiness has two gates:

- runtime readiness: build/config/runtime identity is ready;
- mission resumption: continuation is claimed, executor or durable wait is current, and watchdog coverage passes.

Gateway/runtime readiness without mission resumption is not clean.

## Policy Migration Rule

Unknown or stale policy versions remain visible until migrated or reconciled. Current accepted read versions are the current policy version and the legacy `cleanup-crew-governance-final-20260714T1454Z` compatibility version.

## Activation And Rollback Gates

Controller enforcement is not allowed until every activation gate passes:

- `policy_schema_generated`
- `sop_parity_validated`
- `source_built_runtime_match`
- `watchdog_clean`
- `worker_coverage_proven`
- `shadow_decisions_stable`
- `repair_tasks_drained`
- `grant_review_passed`
- `rollback_plan_verified`
- `production_paused`
- `trinity_unstarted`
- `control_plane_phase2_paused`

If enforcement is requested before these gates pass, the effective mode remains `shadow_observe`; controller repair mode is disabled or rolled back, missing gates stay visible, shadow comparison is rerun, and watchdog validation is repeated.
