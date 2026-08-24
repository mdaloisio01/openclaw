import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLEANUP_CREW_CANONICAL_OUTCOMES,
  CLEANUP_CREW_GOVERNANCE_REASON_CODES,
  CLEANUP_CREW_IMPACT_LEVELS,
  CLEANUP_CREW_MISSION_ABORT_CONTINUATION_CLASSES,
  CLEANUP_CREW_OWNER_DECISION_CLASSES,
  CLEANUP_CREW_POLICY_SCHEMA_VERSION,
  classifyCleanupCrewBlocker,
  classifyCleanupCrewGovernanceTaxonomy,
  classifyBuildContextConstraint,
  classifyGrantRejection,
  appendCleanupCrewPlanAmendment,
  createCleanupCrewOperationalReconciliationRecord,
  createCleanupCrewDecisionRecord,
  createCleanupCrewMissionAbortExhaustionReceipt,
  createCleanupCrewDurableWaitRecord,
  createCleanupCrewExecutorCapabilityRecord,
  createCleanupCrewRestartDrainRegistration,
  createCleanupCrewRepairAttemptReceipt,
  createCleanupCrewBootstrapB0TypedDecisionReceipt,
  createCleanupCrewResumeUnit,
  createCleanupCrewStoppageReceipt,
  createCleanupCrewTypedDecisionReceipt,
  createCleanupCrewRecoveryTelemetryEvent,
  createContinueReceipt,
  createDiagnosticTrace,
  evaluateCleanupCrewScopeRiskDiff,
  createGrantRetryKey,
  createStopReport,
  deriveCleanupCrewRepair,
  evaluateContinuityGateV2,
  parseRootOperatorOverride,
  resolveAuthority,
  resolveCleanupCrewRepairExecutionGate,
  resolveCleanupCrewDurableWait,
  resolveCleanupCrewCapabilityRoute,
  resolveCleanupCrewRestartContinuation,
  resolveCleanupCrewRepairLoop,
  resolveCleanupCrewLevelState,
  resolveCleanupCrewNonterminalContinuation,
  resolveCleanupCrewResumeGate,
  resolveCleanupCrewTelemetryCloseoutGate,
  resolveGrantRetry,
  writeCleanupCrewDurableArtifacts,
  type AuthoritySource,
  type BuildContextConstraint,
  type CleanupCrewMissionAbortExhaustionEntry,
} from "./continuity-gate-v2.js";

const NOW = "2026-07-04T18:02:00.000Z";

function source(
  kind: AuthoritySource["kind"],
  id: string,
  overrides: Partial<AuthoritySource> = {},
): AuthoritySource {
  return {
    kind,
    id,
    summary: `${kind}:${id}`,
    active: true,
    createdAt: NOW,
    ...overrides,
  };
}

describe("Continuity Gate v2", () => {
  it("keeps the Cleanup Crew owner-decision taxonomy closed", () => {
    expect(CLEANUP_CREW_OWNER_DECISION_CLASSES).toEqual([
      "OWNER_GOAL_CHANGE",
      "SCOPE_EXPANSION",
      "PUBLIC_OR_USER_CONTRACT_CHANGE",
      "BUSINESS_RULE_CHOICE",
      "RISK_ACCEPTANCE_CHANGE",
      "DESTRUCTIVE_NO_ROLLBACK",
      "EXTERNAL_SIDE_EFFECT_REQUIRES_OWNER_CHOICE",
      "CREDENTIAL_OR_PRIVILEGE_DECISION_REQUIRED",
      "UNRESOLVED_AUTHORITY_CONFLICT",
    ]);
  });

  it("keeps the Phase 3 typed decision schema constants closed and versioned", () => {
    expect(CLEANUP_CREW_POLICY_SCHEMA_VERSION).toBe("cleanup-crew-governance-final-20260714T1454Z");
    expect(CLEANUP_CREW_CANONICAL_OUTCOMES).toEqual([
      "CONTINUE",
      "REPAIR_AND_CONTINUE",
      "RETRY",
      "DEFER_UNTIL_DRAIN",
      "ACTION_BLOCKED",
      "PHASE_BLOCKED",
      "EXTERNAL_DEPENDENCY",
      "OWNER_DECISION_REQUIRED",
      "MISSION_ABORTED",
      "COMPLETE",
    ]);
    expect(CLEANUP_CREW_IMPACT_LEVELS).toEqual(["ACTION", "PHASE", "MISSION"]);
    expect(CLEANUP_CREW_GOVERNANCE_REASON_CODES).toEqual([
      "TECHNICAL_REPAIR",
      "RETRYABLE_TRANSIENT",
      "PROOF_PRODUCTION_AVAILABLE",
      "PROOF_PRODUCER_UNAVAILABLE",
      "ROOT_OR_CREDENTIAL_UNAVAILABLE",
      "EXTERNAL_APPROVAL_UNAVAILABLE",
      "OWNER_CHOICE_REQUIRED",
      "MALFORMED_POLICY_INPUT",
      "SCOPE_RISK_UNCLASSIFIED",
      "ROLE_CAPABILITY_UNAVAILABLE",
      "REVIEWER_UNAVAILABLE",
      "ACTIVE_WORK_DRAIN",
      "STALE_STATE_RECONCILIATION",
      "REPORT_DELIVERY_REPAIR",
      "RESTART_DRAIN_WAIT",
      "PROTECTED_ACTION_DENIED",
      "ROLLBACK_UNAVAILABLE",
      "FORBIDDEN_SCOPE",
      "AUTHORITY_CONFLICT",
      "REPAIR_BUDGET_EXHAUSTED",
      "MISSION_EXHAUSTION_PROVEN",
      "COMPLETE_PROVEN",
      "SUPERSEDED_MISSION",
      "OWNER_GOAL_CHANGE",
      "SCOPE_EXPANSION",
      "PUBLIC_OR_USER_CONTRACT_CHANGE",
      "BUSINESS_RULE_CHOICE",
      "RISK_ACCEPTANCE_CHANGE",
      "DESTRUCTIVE_NO_ROLLBACK",
      "EXTERNAL_SIDE_EFFECT_REQUIRES_OWNER_CHOICE",
      "CREDENTIAL_OR_PRIVILEGE_DECISION_REQUIRED",
      "UNRESOLVED_AUTHORITY_CONFLICT",
    ]);
  });

  it("turns malformed typed policy input into ACTION_BLOCKED:MALFORMED_POLICY_INPUT", () => {
    const receipt = createCleanupCrewTypedDecisionReceipt(
      {
        schema: "openclaw.cleanup_crew_typed_decision_input.v1",
        policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
        phase: "phase3_canonical_typed_decision_schema",
        missionId: "cleanup-crew-governance",
        inputSummary: "adapter returned unknown outcome and reason",
        proposedOutcome: "PLEASE_STOP_AND_ASK_MARK",
        proposedImpact: "EVERYTHING",
        proposedReasonCode: "VIBES",
        owner: "Will",
        nextAction: "diagnose malformed adapter output",
        evidence: ["adapter-output.json"],
        rollback: {
          available: true,
          proofRef: "rollback.md",
        },
        reportEffect: "action blocked until schema mapping is repaired",
      },
      { timestamp: NOW },
    );

    expect(receipt).toMatchObject({
      schema: "openclaw.cleanup_crew_typed_decision_receipt.v1",
      policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
      outcome: "ACTION_BLOCKED",
      impact: "ACTION",
      reason_code: "MALFORMED_POLICY_INPUT",
      owner: "Will",
      next_action: "diagnose_policy_input_and_rerun_classifier",
      report_effect: "action_blocked",
      validation: {
        ok: false,
        errors: expect.arrayContaining([
          "typed_decision_outcome_invalid",
          "typed_decision_impact_invalid",
          "typed_decision_reason_code_invalid",
        ]),
      },
    });
    expect(receipt.input_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces mission-abort exhaustion receipt validation", () => {
    const incompleteAbort = createCleanupCrewTypedDecisionReceipt(
      {
        schema: "openclaw.cleanup_crew_typed_decision_input.v1",
        policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
        phase: "phase3_canonical_typed_decision_schema",
        missionId: "cleanup-crew-governance",
        inputSummary: "missing exhaustion receipt must not abort mission",
        proposedOutcome: "MISSION_ABORTED",
        proposedImpact: "MISSION",
        proposedReasonCode: "MISSION_EXHAUSTION_PROVEN",
        owner: "Will",
        nextAction: "stop mission",
        evidence: ["diagnostic.md"],
        rollback: {
          available: false,
          proofRef: "rollback-unavailable.md",
        },
        reportEffect: "mission would stop",
      },
      { timestamp: NOW },
    );

    expect(incompleteAbort).toMatchObject({
      outcome: "ACTION_BLOCKED",
      reason_code: "MALFORMED_POLICY_INPUT",
      validation: {
        ok: false,
        errors: expect.arrayContaining(["mission_abort_exhaustion_receipt_missing"]),
      },
    });

    const entries: CleanupCrewMissionAbortExhaustionEntry[] =
      CLEANUP_CREW_MISSION_ABORT_CONTINUATION_CLASSES.map((continuationClass) => ({
        class: continuationClass,
        status: "unavailable",
        evidence: `${continuationClass} unavailable after documented repair search`,
      }));
    const exhaustion = createCleanupCrewMissionAbortExhaustionReceipt({
      missionId: "cleanup-crew-governance",
      entries,
      timestamp: NOW,
    });
    const missingIdentityAbort = createCleanupCrewTypedDecisionReceipt(
      {
        schema: "openclaw.cleanup_crew_typed_decision_input.v1",
        policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
        phase: "phase3_canonical_typed_decision_schema",
        missionId: "cleanup-crew-governance",
        inputSummary: "minimal forged exhaustion object must not abort mission",
        proposedOutcome: "MISSION_ABORTED",
        proposedImpact: "MISSION",
        proposedReasonCode: "MISSION_EXHAUSTION_PROVEN",
        owner: "Will",
        nextAction: "stop mission",
        evidence: ["diagnostic.md"],
        rollback: {
          available: false,
          proofRef: "rollback-unavailable.md",
        },
        reportEffect: "mission would stop",
        missionAbortExhaustion: {
          schema: "openclaw.cleanup_crew_mission_abort_exhaustion_receipt.v1",
          policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
          entries,
        } as any,
      },
      { timestamp: NOW },
    );

    expect(missingIdentityAbort).toMatchObject({
      outcome: "ACTION_BLOCKED",
      reason_code: "MALFORMED_POLICY_INPUT",
      validation: {
        ok: false,
        errors: expect.arrayContaining([
          "mission_abort_exhaustion_receipt_id_missing",
          "mission_abort_exhaustion_created_at_missing",
          "mission_abort_exhaustion_mission_id_missing",
        ]),
      },
    });

    const wrongMissionAbort = createCleanupCrewTypedDecisionReceipt(
      {
        schema: "openclaw.cleanup_crew_typed_decision_input.v1",
        policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
        phase: "phase3_canonical_typed_decision_schema",
        missionId: "cleanup-crew-governance",
        inputSummary: "wrong mission exhaustion receipt must not abort mission",
        proposedOutcome: "MISSION_ABORTED",
        proposedImpact: "MISSION",
        proposedReasonCode: "MISSION_EXHAUSTION_PROVEN",
        owner: "Will",
        nextAction: "stop mission",
        evidence: ["diagnostic.md"],
        rollback: {
          available: false,
          proofRef: "rollback-unavailable.md",
        },
        reportEffect: "mission would stop",
        missionAbortExhaustion: {
          ...exhaustion,
          mission_id: "other-mission",
        },
      },
      { timestamp: NOW },
    );

    expect(wrongMissionAbort).toMatchObject({
      outcome: "ACTION_BLOCKED",
      reason_code: "MALFORMED_POLICY_INPUT",
      validation: {
        ok: false,
        errors: expect.arrayContaining(["mission_abort_exhaustion_mission_id_mismatch"]),
      },
    });

    const validAbort = createCleanupCrewTypedDecisionReceipt(
      {
        schema: "openclaw.cleanup_crew_typed_decision_input.v1",
        policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
        phase: "phase3_canonical_typed_decision_schema",
        missionId: "cleanup-crew-governance",
        inputSummary: "all continuation classes exhausted",
        proposedOutcome: "MISSION_ABORTED",
        proposedImpact: "MISSION",
        proposedReasonCode: "MISSION_EXHAUSTION_PROVEN",
        owner: "Will",
        nextAction: "emit structured exhaustion receipt and stop mission",
        evidence: ["diagnostic.md", exhaustion.receipt_id],
        rollback: {
          available: false,
          proofRef: "rollback-unavailable.md",
        },
        reportEffect: "mission_abort_with_exhaustion_receipt",
        missionAbortExhaustion: exhaustion,
      },
      { timestamp: NOW },
    );

    expect(validAbort).toMatchObject({
      outcome: "MISSION_ABORTED",
      impact: "MISSION",
      reason_code: "MISSION_EXHAUSTION_PROVEN",
      validation: {
        ok: true,
        errors: [],
      },
    });
  });

  it("classifies undecided public deployment as a closed owner decision", () => {
    expect(
      classifyCleanupCrewGovernanceTaxonomy({
        ownerChoiceRequired: true,
        ownerDecisionClass: "EXTERNAL_SIDE_EFFECT_REQUIRES_OWNER_CHOICE",
        summary: "public deployment has not been approved",
      }),
    ).toMatchObject({
      outcome: "OWNER_DECISION_REQUIRED",
      reasonCode: "EXTERNAL_SIDE_EFFECT_REQUIRES_OWNER_CHOICE",
      ownerApprovalRequired: true,
      classification: "closed_owner_decision_first",
    });
  });

  it("classifies missing root or credentials after approval as external dependency", () => {
    expect(
      classifyCleanupCrewGovernanceTaxonomy({
        ownerChoiceAlreadyMade: true,
        externalDependencyClass: "ROOT_OR_CREDENTIAL_UNAVAILABLE",
        summary: "root authority is unavailable after the build objective was approved",
      }),
    ).toMatchObject({
      outcome: "EXTERNAL_DEPENDENCY",
      reasonCode: "ROOT_OR_CREDENTIAL_UNAVAILABLE",
      ownerApprovalRequired: false,
      classification: "owner_choice_already_made_dependency_wait",
    });
  });

  it("resolves owner choice before dependency when both are present", () => {
    expect(
      classifyCleanupCrewGovernanceTaxonomy({
        ownerChoiceRequired: true,
        ownerDecisionClass: "RISK_ACCEPTANCE_CHANGE",
        externalDependencyClass: "ROOT_OR_CREDENTIAL_UNAVAILABLE",
        summary: "credential prompt attempts to smuggle a risk acceptance change",
      }),
    ).toMatchObject({
      outcome: "OWNER_DECISION_REQUIRED",
      reasonCode: "RISK_ACCEPTANCE_CHANGE",
      ownerApprovalRequired: true,
      externalDependencyClass: "ROOT_OR_CREDENTIAL_UNAVAILABLE",
    });
  });

  it("rejects open-ended owner routing when no closed owner class matches", () => {
    expect(
      classifyCleanupCrewGovernanceTaxonomy({
        ownerChoiceRequired: true,
        malformedOrUnknownInput: true,
        summary: "unknown classifier input asks Mark what to do",
      }),
    ).toMatchObject({
      outcome: "ACTION_BLOCKED",
      reasonCode: "MALFORMED_POLICY_INPUT",
      ownerApprovalRequired: false,
      classification: "malformed_input_not_owner_decision",
    });
  });

  it("rejects runtime owner-decision strings outside the closed set", () => {
    expect(
      classifyCleanupCrewGovernanceTaxonomy({
        ownerChoiceRequired: true,
        ownerDecisionClass: "PLEASE_ASK_MARK_ANYWAY",
        summary: "runtime JSON supplied an unrecognized owner class",
      } as any),
    ).toMatchObject({
      outcome: "ACTION_BLOCKED",
      reasonCode: "MALFORMED_POLICY_INPUT",
      ownerApprovalRequired: false,
      classification: "malformed_input_not_owner_decision",
    });
  });

  it("rejects runtime dependency strings outside the closed set", () => {
    expect(
      classifyCleanupCrewGovernanceTaxonomy({
        ownerChoiceAlreadyMade: true,
        externalDependencyClass: "PRIVILEGE_UNAVAILABLE",
        summary: "runtime JSON supplied a shorthand dependency class",
      } as any),
    ).toMatchObject({
      outcome: "ACTION_BLOCKED",
      reasonCode: "MALFORMED_POLICY_INPUT",
      ownerApprovalRequired: false,
      classification: "malformed_input_not_owner_decision",
    });
  });

  it("classifies Phase 6 scope/risk diffs into closed owner decisions", () => {
    const evaluation = evaluateCleanupCrewScopeRiskDiff({
      missionId: "cleanup-crew-governance",
      phase: "phase6_operational_reconciliation_authority",
      owner: "Will",
      beforeAuthoritySummary: "Plan allows internal governance remediation.",
      proposedAuthoritySummary: "Proposed amendment changes public user contract.",
      changedSurfaces: ["AGENTS.md", "USER.md"],
      diffSummary: "The amendment would change what Mark is promised externally.",
      evidence: ["phase6-diff.md"],
      rollbackProofRef: "rollback.md",
      changedMeaning: true,
      scopeWithinMission: false,
      publicOrUserContractChange: true,
      timestamp: NOW,
    });

    expect(evaluation).toMatchObject({
      schema: "openclaw.cleanup_crew_scope_risk_diff_evaluation.v1",
      policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
      classification: "closed_owner_decision",
      owner_decision_class: "PUBLIC_OR_USER_CONTRACT_CHANGE",
      outcome: "OWNER_DECISION_REQUIRED",
      impact: "MISSION",
      reason_code: "PUBLIC_OR_USER_CONTRACT_CHANGE",
      next_action: "record_closed_owner_decision_before_plan_amendment",
      grant_review_required: true,
    });
  });

  it("records Phase 6 operational reconciliation through the typed decision path", () => {
    const record = createCleanupCrewOperationalReconciliationRecord({
      missionId: "cleanup-crew-governance",
      phase: "phase6_operational_reconciliation_authority",
      owner: "Will",
      beforeAuthoritySummary: "Phase 6 plan calls for a reconciliation ledger.",
      proposedAuthoritySummary: "Add a versioned record shape and tests.",
      changedSurfaces: ["src/continuity/continuity-gate-v2.ts"],
      diffSummary: "Mechanical implementation of the approved Phase 6 authority surface.",
      evidence: ["continuity-gate-v2.test.ts"],
      rollbackProofRef: "git diff -- src/continuity/continuity-gate-v2.ts",
      changedMeaning: false,
      scopeWithinMission: true,
      safeTechnicalRepairAvailable: true,
      timestamp: NOW,
    });

    expect(record).toMatchObject({
      schema: "openclaw.cleanup_crew_operational_reconciliation_ledger_record.v1",
      policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
      evaluation: {
        classification: "technical_reconciliation",
        outcome: "REPAIR_AND_CONTINUE",
        reason_code: "TECHNICAL_REPAIR",
        grant_review_required: false,
      },
      typed_decision_receipt: {
        schema: "openclaw.cleanup_crew_typed_decision_receipt.v1",
        outcome: "REPAIR_AND_CONTINUE",
        impact: "ACTION",
        reason_code: "TECHNICAL_REPAIR",
        next_action: "record_operational_reconciliation_and_continue",
        validation: {
          ok: true,
          errors: [],
        },
      },
    });
  });

  it("fails ambiguous Phase 6 scope/risk diffs closed instead of routing open-ended owner asks", () => {
    const record = createCleanupCrewOperationalReconciliationRecord({
      missionId: "cleanup-crew-governance",
      phase: "phase6_operational_reconciliation_authority",
      owner: "Will",
      beforeAuthoritySummary: "Prior plan allows internal remediation.",
      proposedAuthoritySummary: "Proposed amendment has unclear scope.",
      changedSurfaces: ["AGENTS.md"],
      diffSummary: "The diff cannot prove whether behavior semantics changed.",
      evidence: ["ambiguous-diff.md"],
      rollbackProofRef: "rollback.md",
      changedMeaning: true,
      scopeWithinMission: false,
      timestamp: NOW,
    });

    expect(record.evaluation).toMatchObject({
      classification: "scope_risk_unclassified",
      outcome: "ACTION_BLOCKED",
      impact: "ACTION",
      reason_code: "SCOPE_RISK_UNCLASSIFIED",
      next_action: "classify_scope_risk_diff_with_evidence_and_grant_review",
      grant_review_required: true,
    });
    expect(record.typed_decision_receipt).toMatchObject({
      outcome: "ACTION_BLOCKED",
      reason_code: "SCOPE_RISK_UNCLASSIFIED",
      validation: {
        ok: true,
        errors: [],
      },
    });
  });

  it("fails Phase 6 diffs closed when scope and meaning facts are omitted", () => {
    const record = createCleanupCrewOperationalReconciliationRecord({
      missionId: "cleanup-crew-governance",
      phase: "phase6_operational_reconciliation_authority",
      owner: "Will",
      beforeAuthoritySummary: "Prior authority exists.",
      proposedAuthoritySummary: "Proposed authority is underspecified.",
      changedSurfaces: ["AGENTS.md"],
      diffSummary: "No structured proof states whether meaning or scope changed.",
      evidence: ["incomplete-diff.md"],
      rollbackProofRef: "rollback.md",
      timestamp: NOW,
    });

    expect(record.evaluation).toMatchObject({
      changed_meaning: null,
      scope_within_mission: null,
      classification: "scope_risk_unclassified",
      outcome: "ACTION_BLOCKED",
      reason_code: "SCOPE_RISK_UNCLASSIFIED",
      grant_review_required: true,
    });
    expect(record.typed_decision_receipt).toMatchObject({
      outcome: "ACTION_BLOCKED",
      reason_code: "SCOPE_RISK_UNCLASSIFIED",
      validation: {
        ok: true,
        errors: [],
      },
    });
  });

  it("resolves Phase 7 action blockers without stopping the phase or mission", () => {
    const receipt = createCleanupCrewTypedDecisionReceipt(
      {
        schema: "openclaw.cleanup_crew_typed_decision_input.v1",
        policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
        phase: "phase7_action_phase_mission_separation",
        missionId: "cleanup-crew-governance",
        inputSummary: "single action needs repair before continuation",
        proposedOutcome: "ACTION_BLOCKED",
        proposedImpact: "ACTION",
        proposedReasonCode: "TECHNICAL_REPAIR",
        owner: "Will",
        nextAction: "repair_action_then_resume_phase",
        evidence: ["action-blocker.md"],
        rollback: {
          available: true,
          proofRef: "rollback.md",
        },
        reportEffect: "action_blocked_phase_continues",
      },
      { timestamp: NOW },
    );

    expect(resolveCleanupCrewLevelState(receipt)).toMatchObject({
      schema: "openclaw.cleanup_crew_level_state_resolution.v1",
      action_state: "blocked",
      phase_state: "open",
      mission_state: "open",
      stop_levels: ["ACTION"],
      resume_behavior: "repair_action_then_resume_phase",
      safe_parallel_work_continues: true,
    });
  });

  it("resolves Phase 7 phase blockers without aborting the mission", () => {
    const receipt = createCleanupCrewTypedDecisionReceipt(
      {
        schema: "openclaw.cleanup_crew_typed_decision_input.v1",
        policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
        phase: "phase7_action_phase_mission_separation",
        missionId: "cleanup-crew-governance",
        inputSummary: "reviewer unavailable for risky activation",
        proposedOutcome: "PHASE_BLOCKED",
        proposedImpact: "PHASE",
        proposedReasonCode: "REVIEWER_UNAVAILABLE",
        owner: "Will",
        nextAction: "wait_for_grant_or_alternate_reviewer",
        evidence: ["review-required.md"],
        rollback: {
          available: true,
          proofRef: "rollback.md",
        },
        reportEffect: "phase_blocked_safe_unrelated_work_continues",
      },
      { timestamp: NOW },
    );

    expect(resolveCleanupCrewLevelState(receipt)).toMatchObject({
      action_state: "blocked",
      phase_state: "blocked",
      mission_state: "open",
      stop_levels: ["ACTION", "PHASE"],
      resume_behavior: "wait_for_grant_or_alternate_reviewer",
      safe_parallel_work_continues: true,
    });
  });

  it("resolves Phase 7 mission abort only from a valid mission-abort receipt", () => {
    const entries: CleanupCrewMissionAbortExhaustionEntry[] =
      CLEANUP_CREW_MISSION_ABORT_CONTINUATION_CLASSES.map((continuationClass) => ({
        class: continuationClass,
        status: "unavailable",
        evidence: `${continuationClass} unavailable`,
      }));
    const exhaustion = createCleanupCrewMissionAbortExhaustionReceipt({
      missionId: "cleanup-crew-governance",
      entries,
      timestamp: NOW,
    });
    const receipt = createCleanupCrewTypedDecisionReceipt(
      {
        schema: "openclaw.cleanup_crew_typed_decision_input.v1",
        policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
        phase: "phase7_action_phase_mission_separation",
        missionId: "cleanup-crew-governance",
        inputSummary: "all continuation classes exhausted",
        proposedOutcome: "MISSION_ABORTED",
        proposedImpact: "MISSION",
        proposedReasonCode: "MISSION_EXHAUSTION_PROVEN",
        owner: "Will",
        nextAction: "emit_exhaustion_receipt_and_stop_mission",
        evidence: ["exhaustion.md", exhaustion.receipt_id],
        rollback: {
          available: false,
          proofRef: "rollback-unavailable.md",
        },
        reportEffect: "mission_aborted_with_exhaustion",
        missionAbortExhaustion: exhaustion,
      },
      { timestamp: NOW },
    );

    expect(resolveCleanupCrewLevelState(receipt)).toMatchObject({
      action_state: "aborted",
      phase_state: "aborted",
      mission_state: "aborted",
      stop_levels: ["ACTION", "PHASE", "MISSION"],
      safe_parallel_work_continues: false,
    });
  });

  it("resolves malformed Phase 7 typed decisions as action-level repair only", () => {
    const receipt = createCleanupCrewTypedDecisionReceipt(
      {
        schema: "openclaw.cleanup_crew_typed_decision_input.v1",
        policyVersion: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
        phase: "phase7_action_phase_mission_separation",
        missionId: "cleanup-crew-governance",
        inputSummary: "adapter emitted bad impact",
        proposedOutcome: "ACTION_BLOCKED",
        proposedImpact: "EVERYTHING",
        proposedReasonCode: "TECHNICAL_REPAIR",
        owner: "Will",
        nextAction: "bad",
        evidence: ["bad-adapter.json"],
        rollback: {
          available: true,
          proofRef: "rollback.md",
        },
        reportEffect: "bad",
      },
      { timestamp: NOW },
    );

    expect(resolveCleanupCrewLevelState(receipt)).toMatchObject({
      outcome: "ACTION_BLOCKED",
      impact: "ACTION",
      reason_code: "MALFORMED_POLICY_INPUT",
      action_state: "blocked",
      phase_state: "open",
      mission_state: "open",
      stop_levels: ["ACTION"],
      resume_behavior: "diagnose_policy_input_and_rerun_classifier",
      safe_parallel_work_continues: true,
    });
  });

  it("keeps technical persistence and identity defects out of owner-decision routing", () => {
    expect(
      classifyCleanupCrewGovernanceTaxonomy({
        technicalPersistenceOrIdentityDefect: true,
        summary: "guard-local blocker state is persisted under the wrong identity",
      }),
    ).toMatchObject({
      outcome: "REPAIR_AND_CONTINUE",
      reasonCode: "TECHNICAL_REPAIR",
      ownerApprovalRequired: false,
      classification: "technical_repair_not_owner_decision",
    });
  });

  it("adapts Bootstrap B0 repairable blockers into canonical typed decisions", () => {
    const receipt = createCleanupCrewBootstrapB0TypedDecisionReceipt({
      missionId: "cleanup-crew-governance",
      phase: "phase5_mechanical_policy_unification",
      owner: "Will",
      summary: "STATUS: blocked",
      blocker: "watchdog NEEDS_REVIEW but next action is rerun watchdog",
      nextRepairPathKnown: true,
      evidence: ["watchdog-receipt.json"],
      rollbackProofRef: "b0-local-classifier-backup",
      timestamp: NOW,
    });

    expect(receipt).toMatchObject({
      policy_version: CLEANUP_CREW_POLICY_SCHEMA_VERSION,
      phase: "phase5_mechanical_policy_unification",
      mission_id: "cleanup-crew-governance",
      outcome: "REPAIR_AND_CONTINUE",
      impact: "ACTION",
      reason_code: "TECHNICAL_REPAIR",
      next_action: "continue_cleanup_repair_through_canonical_policy",
      report_effect: "b0_compatibility_repair_continues",
      validation: { ok: true, errors: [] },
    });
  });

  it("adapts Bootstrap B0 hard blockers into fail-closed canonical typed decisions", () => {
    const receipt = createCleanupCrewBootstrapB0TypedDecisionReceipt({
      missionId: "cleanup-crew-governance",
      phase: "phase5_mechanical_policy_unification",
      owner: "Will",
      summary: "STATUS: blocked",
      blocker: "raw DB repair required without emergency SOP",
      evidence: ["blocked-artifact.md"],
      rollbackProofRef: "b0-local-classifier-backup",
      timestamp: NOW,
    });

    expect(receipt).toMatchObject({
      outcome: "ACTION_BLOCKED",
      impact: "MISSION",
      reason_code: "PROTECTED_ACTION_DENIED",
      next_action: "record_lawful_blocker_artifact_before_terminal_closeout",
      report_effect: "b0_compatibility_terminal_stop_requires_blocker_proof",
      validation: { ok: true, errors: [] },
    });
  });

  it("creates stoppage receipts with required proof-gap metadata and bounded output tails", () => {
    const receipt = createCleanupCrewStoppageReceipt({
      timestamp: NOW,
      missionId: "cleanup-crew-runtime-repair",
      taskFlowId: "flow-123",
      packetId: "packet-1",
      stageId: "validation",
      commandProcessId: "cmd-456",
      commandSpec: "node scripts/run-vitest.mjs run src/example.test.ts",
      workingDirectory: "/home/will/openclaw-source",
      gitHead: "7fe95e210b51a365d9d08e013e34369fa0374a35",
      dirtyTreeSummary: " M src/continuity/continuity-gate-v2.ts",
      stdoutTail: `${"x".repeat(4100)}stdout-end`,
      stderrTail: "expected failure tail",
      proofArtifactPath: "var/proof/receipt.json",
      logPath: "var/log/test.log",
      stoppageClass: "validation_nonzero_exit",
      suspectedAffectedSurface: "scripts/run-vitest.mjs",
      nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
    });

    expect(receipt).toMatchObject({
      schema: "openclaw.cleanup_crew_stoppage_receipt.v1",
      created_at: NOW,
      mission_id: "cleanup-crew-runtime-repair",
      task_flow_id: "flow-123",
      packet_id: "packet-1",
      stage_id: "validation",
      command_process_id: "cmd-456",
      command_spec: "node scripts/run-vitest.mjs run src/example.test.ts",
      working_directory: "/home/will/openclaw-source",
      git_state: {
        head: "7fe95e210b51a365d9d08e013e34369fa0374a35",
        dirty_tree_summary: " M src/continuity/continuity-gate-v2.ts",
      },
      captured_output: {
        stderr_tail: "expected failure tail",
        tail_truncated: true,
      },
      proof: {
        artifact_path: "var/proof/receipt.json",
        log_path: "var/log/test.log",
      },
      stoppage_class: "validation_nonzero_exit",
      suspected_affected_surface: "scripts/run-vitest.mjs",
      next_analysis_owner: "cleanup_crew_planning_dev_sop",
    });
    expect(receipt.receipt_id).toMatch(/^stoppage_receipt_/);
    expect(receipt.captured_output.stdout_tail).toHaveLength(4000);
    expect(receipt.captured_output.stdout_tail.endsWith("stdout-end")).toBe(true);
  });

  it("classifies Lane A technical repairs as autonomous only after plan amendment", () => {
    const repair = deriveCleanupCrewRepair({
      issue: {
        summary: "Missing proof receipt link can be repaired mechanically.",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "proof_or_receipt_shape",
        behaviorImpact: "technical",
      },
      repairAction: "write missing receipt ref",
      targetSurfaces: ["src/commands/cleanup-plan.ts"],
      validationSteps: [
        "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
      ],
      proofArtifacts: ["var/cleanup/proof-gap.json"],
      nextExecutableCommand:
        "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
    });

    expect(repair).toMatchObject({
      schema: "openclaw.cleanup_crew_derived_repair.v1",
      lane: "lane_a_technical_repair",
      can_execute_autonomously: true,
      requires_plan_amendment: true,
      requires_mark_decision: false,
      path_risk: "LOW_RISK_TECHNICAL",
      diff_intent: "proof_or_receipt_shape",
    });
  });

  it("classifies Lane B plan-driven build work inside the active plan boundary", () => {
    const repair = deriveCleanupCrewRepair({
      activeBuildPlanAuthorizesWork: true,
      issue: {
        summary: "Packet validation retry is already authorized by the active build plan.",
        pathRisk: "MEDIUM_RISK_RUNTIME",
        diffIntent: "test_alignment",
        behaviorImpact: "plan_driven",
        scopeWithinMission: true,
      },
      repairAction: "rerun focused validation from amended plan",
    });

    expect(repair).toMatchObject({
      lane: "lane_b_plan_driven_build_work",
      can_execute_autonomously: true,
      requires_plan_amendment: true,
      requires_mark_decision: false,
      path_risk: "MEDIUM_RISK_RUNTIME",
      diff_intent: "test_alignment",
    });
  });

  it("classifies Lane C product or behavior changes as Mark decisions", () => {
    const repair = deriveCleanupCrewRepair({
      issue: {
        summary: "Choose a new user-facing recovery flow.",
        pathRisk: "HIGH_RISK_BEHAVIOR",
        diffIntent: "new_feature_behavior",
        behaviorImpact: "ux_flow",
      },
      repairAction: "change user-facing recovery UX",
    });

    expect(repair).toMatchObject({
      lane: "lane_c_product_behavior_decision",
      can_execute_autonomously: false,
      requires_plan_amendment: false,
      requires_mark_decision: true,
      stop_state: "STOP_HUMAN_PRODUCT_DECISION",
    });
  });

  it("blocks repair execution before a plan amendment exists", () => {
    const repair = deriveCleanupCrewRepair({
      issue: {
        summary: "Repair focused validation proof.",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "test_alignment",
      },
      repairAction: "rerun focused validation",
      nextExecutableCommand: "node scripts/run-vitest.mjs run src/example.test.ts",
    });

    expect(resolveCleanupCrewRepairExecutionGate({ derivedRepair: repair })).toMatchObject({
      allowed: false,
      reason: "plan_amendment_required",
    });
  });

  it("appends active build plan amendments and authorizes exact resumed command after reload", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-plan-amendment-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n\nPacket 3\n", "utf8");
      const repair = deriveCleanupCrewRepair({
        activeBuildPlanAuthorizesWork: true,
        issue: {
          summary: "Focused validation failed and needs a planned retry.",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "test_alignment",
          behaviorImpact: "plan_driven",
        },
        repairAction: "rerun focused validation",
        targetSurfaces: ["src/continuity/continuity-gate-v2.ts"],
        validationSteps: [
          "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
        ],
        proofArtifacts: ["var/cleanup/packet3-proof.json"],
        nextExecutableCommand:
          "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
      });

      const write = await appendCleanupCrewPlanAmendment({
        activeBuildPlanPath: planPath,
        timestamp: NOW,
        stoppageId: "stoppage_receipt_packet3",
        derivedRepair: repair,
        diagnosis: "Focused validation failed after schema change; retry is inside plan.",
        stopConditions: ["validation fails again"],
        rollbackSafetyNotes: ["no raw DB/state edits"],
      });
      const amendedPlan = await readFile(planPath, "utf8");

      expect(write.amendment).toMatchObject({
        schema: "openclaw.cleanup_crew_plan_amendment.v1",
        active_build_plan_path: planPath,
        stoppage_id: "stoppage_receipt_packet3",
        lane_classification: "lane_b_plan_driven_build_work",
        next_executable_command:
          "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
      });
      expect(write.amendedPlanHash).not.toBe(write.basePlanHash);
      expect(amendedPlan).toContain("Cleanup Crew Recovery Amendment");
      expect(amendedPlan).toContain('"stoppage_id": "stoppage_receipt_packet3"');

      expect(
        resolveCleanupCrewRepairExecutionGate({
          derivedRepair: repair,
          amendment: write.amendment,
          currentPlanHash: write.amendedPlanHash,
          amendedPlanHash: write.amendedPlanHash,
        }),
      ).toMatchObject({
        allowed: true,
        amendmentId: write.amendment.amendment_id,
        nextExecutableCommand:
          "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks stale active plan amendments before resumed execution", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-plan-amendment-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n", "utf8");
      const repair = deriveCleanupCrewRepair({
        issue: {
          summary: "Repair proof gap.",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "proof_or_receipt_shape",
        },
        repairAction: "write proof receipt",
        nextExecutableCommand:
          "node scripts/run-vitest.mjs run src/commands/cleanup-plan.continuity-gate.test.ts",
      });
      const write = await appendCleanupCrewPlanAmendment({
        activeBuildPlanPath: planPath,
        timestamp: NOW,
        stoppageId: "stoppage_receipt_stale",
        derivedRepair: repair,
        diagnosis: "Proof receipt missing.",
        stopConditions: ["proof still missing"],
        rollbackSafetyNotes: ["append-only plan amendment"],
      });

      expect(
        resolveCleanupCrewRepairExecutionGate({
          derivedRepair: repair,
          amendment: write.amendment,
          currentPlanHash: "not-the-current-plan-hash",
          amendedPlanHash: write.amendedPlanHash,
        }),
      ).toMatchObject({
        allowed: false,
        reason: "stale_plan_amendment",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prevents Lane C repairs from becoming executable plan amendments", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-plan-amendment-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n", "utf8");
      const repair = deriveCleanupCrewRepair({
        issue: {
          summary: "Choose new user-facing product behavior.",
          pathRisk: "HIGH_RISK_BEHAVIOR",
          diffIntent: "new_feature_behavior",
          behaviorImpact: "product_behavior",
        },
        repairAction: "change product behavior",
      });

      await expect(
        appendCleanupCrewPlanAmendment({
          activeBuildPlanPath: planPath,
          timestamp: NOW,
          stoppageId: "stoppage_receipt_lane_c",
          derivedRepair: repair,
          diagnosis: "Product decision needed.",
          stopConditions: ["Mark decision missing"],
          rollbackSafetyNotes: ["do not execute product behavior change"],
        }),
      ).rejects.toThrow("Lane C repair requires Mark decision");
      expect(resolveCleanupCrewRepairExecutionGate({ derivedRepair: repair })).toMatchObject({
        allowed: false,
        reason: "lane_c_mark_decision_required",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds resume units from active plan amendments and allows only the amended command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-resume-unit-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n", "utf8");
      const interruptedBundle =
        "node scripts/run-vitest.mjs run src/tasks/task-flow-registry.test.ts src/tasks/active-production-watchdog-lifecycle.test.ts";
      const repair = deriveCleanupCrewRepair({
        activeBuildPlanAuthorizesWork: true,
        issue: {
          summary: "Interrupted Packet F validation bundle must rerun from the plan.",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "test_alignment",
          behaviorImpact: "plan_driven",
        },
        repairAction: "rerun interrupted validation bundle",
        validationSteps: [interruptedBundle],
        proofArtifacts: ["var/cleanup/packet-f-validation.log"],
        nextExecutableCommand: interruptedBundle,
      });
      const write = await appendCleanupCrewPlanAmendment({
        activeBuildPlanPath: planPath,
        timestamp: NOW,
        stoppageId: "stoppage_interrupted_bundle",
        derivedRepair: repair,
        diagnosis: "Validation proof was interrupted; exact bundle rerun is required.",
        stopConditions: ["bundle exits nonzero", "output tail lost again"],
        rollbackSafetyNotes: ["rerun only; no source mutation"],
      });
      const resumeUnit = createCleanupCrewResumeUnit({
        amendmentWrite: write,
        workingDirectory: "/home/will/openclaw-source",
      });

      expect(resumeUnit).toMatchObject({
        schema: "openclaw.cleanup_crew_resume_unit.v1",
        amendment_id: write.amendment.amendment_id,
        plan_path: planPath,
        plan_hash: write.amendedPlanHash,
        command: interruptedBundle,
        cwd: "/home/will/openclaw-source",
        proof_artifacts: ["var/cleanup/packet-f-validation.log"],
      });
      expect(resumeUnit.idempotency_key).toMatch(/^resume_unit_key_/);
      expect(
        resolveCleanupCrewResumeGate({
          resumeUnit,
          requestedCommand: interruptedBundle,
          currentPlanHash: write.amendedPlanHash,
        }),
      ).toMatchObject({
        allowed: true,
        action: "execute_resume_unit",
        command: interruptedBundle,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks arbitrary retries that are not loaded from the amended plan", () => {
    const repair = deriveCleanupCrewRepair({
      issue: {
        summary: "Recover proof gap.",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "test_alignment",
      },
      repairAction: "rerun focused validation",
      nextExecutableCommand: "node scripts/run-vitest.mjs run src/expected.test.ts",
    });

    expect(resolveCleanupCrewResumeGate({ requestedCommand: "pnpm test" })).toMatchObject({
      allowed: false,
      reason: "resume_unit_required",
    });
    expect(
      resolveCleanupCrewRepairExecutionGate({
        derivedRepair: repair,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "plan_amendment_required",
    });
  });

  it("blocks requested commands that differ from the resume unit command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-resume-unit-"));
    try {
      const planPath = path.join(dir, "active-build-plan.md");
      await writeFile(planPath, "# Active Build Plan\n", "utf8");
      const repair = deriveCleanupCrewRepair({
        issue: {
          summary: "Rerun exact proof command.",
          pathRisk: "LOW_RISK_TECHNICAL",
          diffIntent: "test_alignment",
        },
        repairAction: "rerun exact proof command",
        nextExecutableCommand: "node scripts/run-vitest.mjs run src/expected.test.ts",
      });
      const write = await appendCleanupCrewPlanAmendment({
        activeBuildPlanPath: planPath,
        timestamp: NOW,
        stoppageId: "stoppage_exact_command",
        derivedRepair: repair,
        diagnosis: "Exact command required.",
        stopConditions: ["validation fails"],
        rollbackSafetyNotes: ["no mutation"],
      });
      const resumeUnit = createCleanupCrewResumeUnit({
        amendmentWrite: write,
        workingDirectory: "/home/will/openclaw-source",
      });

      expect(
        resolveCleanupCrewResumeGate({
          resumeUnit,
          requestedCommand: "node scripts/run-vitest.mjs run src/other.test.ts",
          currentPlanHash: write.amendedPlanHash,
        }),
      ).toMatchObject({
        allowed: false,
        reason: "command_not_in_amended_plan",
        recoveryCommand: "node scripts/run-vitest.mjs run src/expected.test.ts",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not resume for report-only and records explicit stop with recovery command", () => {
    const resumeUnit = {
      schema: "openclaw.cleanup_crew_resume_unit.v1" as const,
      resume_id: "resume_unit_test",
      amendment_id: "plan_amendment_test",
      plan_path: "/tmp/plan.md",
      plan_hash: "hash",
      command: "node scripts/run-vitest.mjs run src/expected.test.ts",
      cwd: "/home/will/openclaw-source",
      idempotency_key: "resume_unit_key_test",
      proof_artifacts: [],
      stop_conditions: [],
    };

    expect(resolveCleanupCrewResumeGate({ resumeUnit, reportOnly: true })).toMatchObject({
      allowed: false,
      action: "do_not_resume",
      reason: "report_only",
    });
    expect(resolveCleanupCrewResumeGate({ resumeUnit, explicitStop: true })).toMatchObject({
      allowed: false,
      action: "record_lawful_stop",
      reason: "explicit_stop",
      recoveryCommand: "node scripts/run-vitest.mjs run src/expected.test.ts",
    });
  });

  it("creates structured recovery telemetry events with required transition fields", () => {
    const event = createCleanupCrewRecoveryTelemetryEvent({
      eventType: "stoppage_detected",
      missionId: "cleanup-crew-pause-analyze-plan-resume",
      taskFlowId: "flow-1",
      timestamp: NOW,
      gitHead: "7fe95e210b51a365d9d08e013e34369fa0374a35",
      dirtySourceDetected: true,
      activeLane: "lane_a_technical_repair",
      pathRiskEvaluation: "LOW_RISK_TECHNICAL",
      grantRetryCount: 0,
      fromState: "running",
      toState: "paused_for_analysis",
      reasonCode: "validation_nonzero_exit",
      diagnosticRef: "stoppage_receipt_1",
      nextExecutableCommand:
        "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
      nextExecutableCwd: "/home/will/openclaw-source",
    });

    expect(event).toMatchObject({
      schema: "openclaw.cleanup_crew_recovery_event.v1",
      event_type: "stoppage_detected",
      mission_id: "cleanup-crew-pause-analyze-plan-resume",
      task_flow_id: "flow-1",
      timestamp: NOW,
      git_state: {
        head: "7fe95e210b51a365d9d08e013e34369fa0374a35",
        dirty_source_detected: true,
      },
      active_lane: "lane_a_technical_repair",
      path_risk_evaluation: "LOW_RISK_TECHNICAL",
      grant_retry_count: 0,
      from_state: "running",
      to_state: "paused_for_analysis",
      reason_code: "validation_nonzero_exit",
      diagnostic_ref: "stoppage_receipt_1",
      next_executable_unit: {
        command: "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
        cwd: "/home/will/openclaw-source",
      },
    });
    expect(event.event_id).toMatch(/^recovery_event_/);
  });

  it("blocks closeout when required telemetry events are missing and ignores debug logs", () => {
    const event = createCleanupCrewRecoveryTelemetryEvent({
      eventType: "proof_gap_written",
      missionId: "cleanup-crew-pause-analyze-plan-resume",
      timestamp: NOW,
      gitHead: "head",
      dirtySourceDetected: false,
      fromState: "paused",
      toState: "proof_gap_written",
      reasonCode: "proof_gap",
      diagnosticRef: "stoppage_receipt",
      nextExecutableCommand: "node scripts/run-vitest.mjs run src/example.test.ts",
      nextExecutableCwd: "/home/will/openclaw-source",
    });

    expect(
      resolveCleanupCrewTelemetryCloseoutGate({
        events: [
          event,
          {
            schema: "debug.log",
            event_type: "plan_amended",
            message: "this is not a receipt",
          },
        ],
        requiredEventTypes: ["proof_gap_written", "plan_amended"],
      }),
    ).toMatchObject({
      allowed: false,
      reason: "missing_required_telemetry",
      missingEventTypes: ["plan_amended"],
    });
  });

  it("writes durable recovery telemetry artifacts", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telemetry-"));
    try {
      const event = createCleanupCrewRecoveryTelemetryEvent({
        eventType: "plan_amended",
        missionId: "cleanup-crew-pause-analyze-plan-resume",
        timestamp: NOW,
        gitHead: "head",
        dirtySourceDetected: false,
        activeLane: "lane_b_plan_driven_build_work",
        pathRiskEvaluation: "MEDIUM_RISK_RUNTIME",
        fromState: "analysis_completed",
        toState: "plan_amended",
        reasonCode: "active_plan_recovery_amendment",
        diagnosticRef: "plan_amendment_1",
        nextExecutableCommand: "node scripts/run-vitest.mjs run src/example.test.ts",
        nextExecutableCwd: "/home/will/openclaw-source",
      });
      const writes = await writeCleanupCrewDurableArtifacts({
        outputDir,
        telemetryEvents: [event],
      });

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        kind: "telemetry_event",
      });
      expect(writes[0]?.path).toContain("cleanup_crew_recovery_events");
      const saved = JSON.parse(await readFile(writes[0]!.path, "utf8")) as { schema: string };
      expect(saved.schema).toBe("openclaw.cleanup_crew_recovery_event.v1");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("runs adversarial stoppage drills through pause, analysis, plan amendment or stop decision", async () => {
    const recoverableDrills = [
      ["validation_nonzero_exit", "validation failed", "test_alignment"],
      ["external_turn_interruption", "foreground turn interrupted", "proof_or_receipt_shape"],
      ["lost_output_tail", "output tail was lost", "proof_or_receipt_shape"],
      [
        "watchdog_needs_review",
        "watchdog NEEDS_REVIEW requires planned repair",
        "proof_or_receipt_shape",
      ],
      [
        "watchdog_monitor_disabled",
        "watchdog MONITOR_DISABLED during active work",
        "proof_or_receipt_shape",
      ],
      ["grant_fail", "Grant rejected mechanical proof link", "mechanical_format"],
      [
        "dirty_tree_block",
        "dirty tree block requires planned source hygiene",
        "routing_or_catalog_recording",
      ],
      ["restart_failure", "restart proof failed", "proof_or_receipt_shape"],
      ["runtime_proof_failure", "runtime proof failed", "proof_or_receipt_shape"],
      ["shell_session_aborted", "shell session aborted", "proof_or_receipt_shape"],
      ["command_timeout", "command timed out", "test_alignment"],
      ["subprocess_signal_exit", "subprocess exited by signal", "test_alignment"],
      ["subprocess_error_event", "subprocess error event", "test_alignment"],
    ] as const;

    for (const [stoppageClass, summary, diffIntent] of recoverableDrills) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-adversarial-drill-"));
      try {
        const planPath = path.join(dir, "active-build-plan.md");
        await writeFile(planPath, "# Active Build Plan\n", "utf8");
        const receipt = createCleanupCrewStoppageReceipt({
          timestamp: NOW,
          missionId: "cleanup-crew-adversarial-drills",
          packetId: "packet-11",
          stageId: stoppageClass,
          commandProcessId: `cmd-${stoppageClass}`,
          commandSpec: "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
          workingDirectory: "/home/will/openclaw-source",
          gitHead: "head",
          dirtyTreeSummary: " M src/continuity/continuity-gate-v2.ts",
          stdoutTail: summary,
          stderrTail: "",
          proofArtifactPath: "var/cleanup/stoppage.json",
          stoppageClass,
          suspectedAffectedSurface: "src/continuity/continuity-gate-v2.ts",
          nextAnalysisOwner: "cleanup_crew_planning_dev_sop",
        });
        const repair = deriveCleanupCrewRepair({
          activeBuildPlanAuthorizesWork: true,
          issue: {
            summary,
            pathRisk: "LOW_RISK_TECHNICAL",
            diffIntent,
            behaviorImpact: "plan_driven",
            scopeWithinMission: true,
          },
          repairAction: `recover ${stoppageClass}`,
          targetSurfaces: ["src/continuity/continuity-gate-v2.ts"],
          validationSteps: [
            "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
          ],
          proofArtifacts: [receipt.receipt_id],
          nextExecutableCommand:
            "node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts",
        });
        const amendment = await appendCleanupCrewPlanAmendment({
          activeBuildPlanPath: planPath,
          timestamp: NOW,
          stoppageId: receipt.receipt_id,
          derivedRepair: repair,
          diagnosis: summary,
          stopConditions: ["same stoppage repeats"],
          rollbackSafetyNotes: ["no raw DB/state edits"],
        });
        const resumeUnit = createCleanupCrewResumeUnit({
          amendmentWrite: amendment,
          workingDirectory: "/home/will/openclaw-source",
        });
        const telemetry = createCleanupCrewRecoveryTelemetryEvent({
          eventType: "plan_amended",
          missionId: "cleanup-crew-adversarial-drills",
          timestamp: NOW,
          gitHead: "head",
          dirtySourceDetected: true,
          activeLane: repair.lane,
          pathRiskEvaluation: repair.path_risk,
          fromState: "analysis_completed",
          toState: "plan_amended",
          reasonCode: stoppageClass,
          diagnosticRef: amendment.amendment.amendment_id,
          nextExecutableCommand: resumeUnit.command,
          nextExecutableCwd: resumeUnit.cwd,
        });

        expect(repair.requires_plan_amendment).toBe(true);
        expect(
          resolveCleanupCrewResumeGate({
            resumeUnit,
            requestedCommand: resumeUnit.command,
            currentPlanHash: amendment.amendedPlanHash,
          }),
        ).toMatchObject({ allowed: true });
        expect(
          resolveCleanupCrewTelemetryCloseoutGate({
            events: [telemetry],
            requiredEventTypes: ["plan_amended"],
          }),
        ).toMatchObject({ allowed: true });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    expect(
      deriveCleanupCrewRepair({
        issue: {
          summary: "Lane C product change",
          pathRisk: "HIGH_RISK_BEHAVIOR",
          diffIntent: "new_feature_behavior",
          behaviorImpact: "product_behavior",
        },
        repairAction: "change product behavior",
      }),
    ).toMatchObject({
      lane: "lane_c_product_behavior_decision",
      requires_mark_decision: true,
    });
    expect(classifyCleanupCrewBlocker({ rawDbRequired: true })).toMatchObject({
      category: "raw_db_required_blocker",
      hardStopWholeMission: true,
    });
    expect(classifyCleanupCrewBlocker({ unsafeOrDestructive: true })).toMatchObject({
      category: "unsafe_destructive_blocker",
      hardStopWholeMission: true,
    });
    expect(
      classifyCleanupCrewBlocker({
        summary: "stale active TaskFlow needs analysis with safe next action",
        nextRepairPathKnown: true,
      }),
    ).toMatchObject({
      status: "in_progress",
    });
    expect(
      classifyCleanupCrewBlocker({
        summary: "orphaned lost child task has repair route",
        nextRepairPathKnown: true,
      }),
    ).toMatchObject({
      canContinueCleanupRepair: true,
    });
    expect(resolveCleanupCrewResumeGate({ reportOnly: true })).toMatchObject({
      allowed: false,
      reason: "report_only",
    });
    expect(resolveCleanupCrewResumeGate({ explicitStop: true })).toMatchObject({
      allowed: false,
      action: "record_lawful_stop",
      reason: "explicit_stop",
    });
    expect(classifyCleanupCrewBlocker({ authorityOrScopeMissing: true })).toMatchObject({
      category: "authority_scope_blocker",
      hardStopWholeMission: true,
    });
  });

  it("keeps first and second no-progress repairs active within the Phase 8 budget", () => {
    const attempts = [1, 2].map((attemptNumber) =>
      createCleanupCrewRepairAttemptReceipt({
        missionId: "cleanup-crew-governance",
        reasonCode: "watchdog_needs_review",
        attemptIdentity: "watchdog-flow-763440db-repair",
        attemptNumber,
        inputRef: "watchdog_receipt_20260715_042023",
        action: "reattach_foreground_cleanup_crew_executor",
        evidence: [`attempt-${attemptNumber}`],
        result: "no_progress",
        deltaSummary: "watchdog still reports the same stale flow/task pair",
        timestamp: NOW,
      }),
    );

    expect(
      resolveCleanupCrewRepairLoop({
        missionId: "cleanup-crew-governance",
        reasonCode: "watchdog_needs_review",
        attempts: [attempts[0]!],
      }),
    ).toMatchObject({
      outcome: "continue_repair",
      identical_no_progress_count: 1,
      retry_budget: 3,
      mission_remains_active: true,
      safe_parallel_work_continues: true,
    });

    expect(
      resolveCleanupCrewRepairLoop({
        missionId: "cleanup-crew-governance",
        reasonCode: "watchdog_needs_review",
        attempts,
      }),
    ).toMatchObject({
      outcome: "continue_repair",
      identical_no_progress_count: 2,
      retry_budget: 3,
      mission_remains_active: true,
      safe_parallel_work_continues: true,
    });
  });

  it("quarantines and investigates alternate path after three identical no-progress repairs", () => {
    const attempts = [1, 2, 3].map((attemptNumber) =>
      createCleanupCrewRepairAttemptReceipt({
        missionId: "cleanup-crew-governance",
        reasonCode: "watchdog_needs_review",
        attemptIdentity: "watchdog-flow-763440db-repair",
        attemptNumber,
        inputRef: "watchdog_receipt_20260715_042023",
        action: "reattach_foreground_cleanup_crew_executor",
        evidence: [`attempt-${attemptNumber}`],
        result: "no_progress",
        deltaSummary: "watchdog still reports the same stale flow/task pair",
        timestamp: NOW,
      }),
    );

    expect(
      resolveCleanupCrewRepairLoop({
        missionId: "cleanup-crew-governance",
        reasonCode: "watchdog_needs_review",
        attempts,
      }),
    ).toMatchObject({
      outcome: "quarantine_and_investigate_alternate",
      identical_no_progress_count: 3,
      retry_budget: 3,
      quarantine_required: true,
      alternate_path_required: true,
      mission_remains_active: true,
      safe_parallel_work_continues: true,
      next_action: "quarantine_affected_change_and_investigate_alternate_path",
    });
  });

  it("does not let retry budget bypass a required rollback", () => {
    const attempt = createCleanupCrewRepairAttemptReceipt({
      missionId: "cleanup-crew-governance",
      reasonCode: "technical_repair",
      attemptNumber: 1,
      inputRef: "failed_patch",
      action: "retry_patch_without_rollback",
      evidence: ["diff touched protected surface"],
      result: "rollback_required",
      deltaSummary: "rollback is required before another mutation",
      rollbackRequired: true,
      rollbackAvailable: false,
      timestamp: NOW,
    });

    expect(
      resolveCleanupCrewRepairLoop({
        missionId: "cleanup-crew-governance",
        reasonCode: "technical_repair",
        attempts: [attempt],
      }),
    ).toMatchObject({
      outcome: "action_blocked_rollback_required",
      quarantine_required: false,
      alternate_path_required: false,
      mission_remains_active: true,
      next_action: "perform_or_restore_rollback_before_retry_budget_can_continue",
    });
  });

  it("blocks malformed proof producer output without closing the mission", () => {
    const attempt = createCleanupCrewRepairAttemptReceipt({
      missionId: "cleanup-crew-governance",
      reasonCode: "proof_production_available",
      attemptNumber: 1,
      inputRef: "watchdog_clean_proof",
      action: "parse_watchdog_receipt",
      evidence: ["receipt missing summary.items_suspicious"],
      result: "malformed_evidence",
      deltaSummary: "proof producer returned malformed evidence",
      timestamp: NOW,
    });

    expect(
      resolveCleanupCrewRepairLoop({
        missionId: "cleanup-crew-governance",
        reasonCode: "proof_production_available",
        attempts: [attempt],
      }),
    ).toMatchObject({
      outcome: "action_blocked_malformed_evidence",
      mission_remains_active: true,
      alternate_path_required: true,
      next_action: "repair_or_replace_malformed_proof_producer_before_retrying",
    });
  });

  it("keeps Phase 8 repair attempt receipts durable across JSON persistence", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-phase8-repair-"));
    try {
      const attempt = createCleanupCrewRepairAttemptReceipt({
        missionId: "cleanup-crew-governance",
        reasonCode: "watchdog_needs_review",
        attemptIdentity: "watchdog-flow-763440db-repair",
        attemptNumber: 1,
        inputRef: "watchdog_receipt_20260715_042023",
        action: "reattach_foreground_cleanup_crew_executor",
        evidence: ["flow 763440db", "task d92e4133"],
        result: "progress",
        deltaSummary: "foreground executor reattached to Phase 8",
        timestamp: NOW,
      });
      const savedPath = path.join(outputDir, "repair-attempt.json");
      await writeFile(savedPath, JSON.stringify(attempt, null, 2), "utf8");
      const restored = JSON.parse(await readFile(savedPath, "utf8"));

      expect(restored).toEqual(attempt);
      expect(
        resolveCleanupCrewRepairLoop({
          missionId: "cleanup-crew-governance",
          reasonCode: "watchdog_needs_review",
          attempts: [restored],
        }),
      ).toMatchObject({
        outcome: "continue_repair",
        mission_remains_active: true,
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("records Phase 9 source-turn drain waits as durable continuation records", () => {
    const wait = createCleanupCrewDurableWaitRecord({
      missionId: "cleanup-crew-governance",
      waitKind: "drain",
      owner: "Will",
      evidence: ["foreground source turn is actively executing Phase 9"],
      timeoutAt: "2026-07-04T18:12:00.000Z",
      nextProbeAt: "2026-07-04T18:07:00.000Z",
      resumeProbeTarget: "agent:orchestrator:main",
      resumeCondition: "source turn finished or yielded with next executable step",
      timestamp: NOW,
    });

    expect(wait).toMatchObject({
      schema: "openclaw.cleanup_crew_durable_wait_record.v1",
      wait_kind: "drain",
      reason_code: "ACTIVE_WORK_DRAIN",
      owner: "Will",
      continuation_receipt_required: true,
      mission_remains_open: true,
      resume_probe: {
        kind: "source_turn_drain",
        target: "agent:orchestrator:main",
      },
    });

    expect(
      resolveCleanupCrewDurableWait({
        record: wait,
        now: "2026-07-04T18:03:00.000Z",
      }),
    ).toMatchObject({
      outcome: "wait_valid",
      canonical_outcome: "DEFER_UNTIL_DRAIN",
      mission_remains_open: true,
      pending_report_delivery_can_close_mission: false,
      next_action: "keep_durable_wait_until_resume_probe_or_timeout",
      validation_errors: [],
    });
  });

  it("makes pending report delivery a durable wait that cannot close the parent mission", () => {
    const wait = createCleanupCrewDurableWaitRecord({
      missionId: "cleanup-crew-governance",
      waitKind: "report_delivery",
      owner: "Will",
      evidence: ["milestone report body pending visible chat delivery"],
      timeoutAt: "2026-07-04T18:12:00.000Z",
      nextProbeAt: "2026-07-04T18:04:00.000Z",
      resumeProbeTarget: "report-delivery-guard:phase9",
      resumeCondition: "report body delivered or repair receipt written",
      timestamp: NOW,
    });

    expect(
      resolveCleanupCrewDurableWait({
        record: wait,
        now: "2026-07-04T18:05:00.000Z",
      }),
    ).toMatchObject({
      outcome: "resume_probe_due",
      canonical_outcome: "DEFER_UNTIL_DRAIN",
      mission_remains_open: true,
      pending_report_delivery_can_close_mission: false,
      next_action: "run_resume_probe:report_delivery:report-delivery-guard:phase9",
    });
  });

  it("rejects nonterminal parent responses that omit continuation receipt or durable wait", () => {
    expect(
      resolveCleanupCrewNonterminalContinuation({
        missionId: "cleanup-crew-governance",
        parentMissionOpen: true,
        localStageComplete: true,
        attemptedParentCloseout: true,
      }),
    ).toMatchObject({
      allowed_to_emit_nonterminal_response: false,
      allowed_to_close_parent_mission: false,
      validation_errors: expect.arrayContaining([
        "continuation_receipt_missing",
        "parent_mission_closeout_forbidden_while_open",
      ]),
      next_action: "write_continuation_receipt_or_durable_wait_before_response",
    });
  });

  it("turns expired durable waits into resume probes instead of idle silence", () => {
    const wait = createCleanupCrewDurableWaitRecord({
      missionId: "cleanup-crew-governance",
      waitKind: "lost_session",
      owner: "Will",
      evidence: ["child session disappeared during Phase 9 wait"],
      timeoutAt: "2026-07-04T18:04:00.000Z",
      resumeProbeTarget: "child-session:agent:worker:phase9",
      resumeCondition: "child session active or supersession receipt exists",
      timestamp: NOW,
    });

    expect(
      resolveCleanupCrewDurableWait({
        record: wait,
        now: "2026-07-04T18:05:00.000Z",
      }),
    ).toMatchObject({
      outcome: "wait_expired_probe_required",
      canonical_outcome: "DEFER_UNTIL_DRAIN",
      mission_remains_open: true,
      next_action: "run_resume_probe:child_session:child-session:agent:worker:phase9",
    });
  });

  it("routes Phase 10 prohibited background writes to the available foreground executor", () => {
    const background = createCleanupCrewExecutorCapabilityRecord({
      executorId: "coding-agent-background",
      role: "Coding Agent",
      sessionKey: "agent:codex:background",
      permitted: ["repo_read"],
      prohibited: ["repo_write"],
    });
    const foreground = createCleanupCrewExecutorCapabilityRecord({
      executorId: "will-foreground",
      role: "Will",
      sessionKey: "agent:orchestrator:main",
      taskId: "d92e4133-066f-4ad5-9656-fe07e365983a",
      leaseRevision: 38,
      permitted: ["repo_read", "repo_write", "taskflow_reconciliation", "watchdog_repair"],
      prohibited: [],
      receiptRequirements: ["taskflow_revision", "watchdog_receipt"],
    });

    expect(
      resolveCleanupCrewCapabilityRoute({
        missionId: "cleanup-crew-governance",
        requiredCapability: "repo_write",
        preferredExecutorId: "coding-agent-background",
        executors: [background, foreground],
        evidence: ["background writes prohibited; foreground executor active"],
      }),
    ).toMatchObject({
      outcome: "route_to_available_executor",
      selected_executor_id: "will-foreground",
      canonical_outcome: "CONTINUE",
      reason_code: "TECHNICAL_REPAIR",
      duplicate_spawn_allowed: false,
      next_action: "route_work_to_executor:will-foreground",
    });
  });

  it("turns Grant unavailable into a phase wait instead of bypassing required review", () => {
    expect(
      resolveCleanupCrewCapabilityRoute({
        missionId: "cleanup-crew-governance",
        requiredCapability: "grant_review",
        requiresGrantReview: true,
        executors: [
          createCleanupCrewExecutorCapabilityRecord({
            executorId: "grant",
            role: "Grant",
            sessionKey: "agent:grant:unavailable",
            available: false,
            permitted: ["grant_review"],
          }),
        ],
        evidence: ["risky repeated repairs require Grant"],
      }),
    ).toMatchObject({
      outcome: "reviewer_unavailable_wait",
      canonical_outcome: "PHASE_BLOCKED",
      reason_code: "REVIEWER_UNAVAILABLE",
      duplicate_spawn_allowed: false,
      next_action: "write_reviewer_unavailable_wait_and_resume_probe",
    });
  });

  it("blocks stale executor identity before duplicate spawn or mutation", () => {
    expect(
      resolveCleanupCrewCapabilityRoute({
        missionId: "cleanup-crew-governance",
        requiredCapability: "taskflow_reconciliation",
        executors: [
          createCleanupCrewExecutorCapabilityRecord({
            executorId: "stale-worker",
            role: "Coding Agent",
            taskId: "lost-task",
            runId: "ended-run",
            available: true,
            stale: true,
            permitted: ["taskflow_reconciliation"],
          }),
        ],
        evidence: ["watchdog reported stale worker"],
      }),
    ).toMatchObject({
      outcome: "stale_identity_reconciliation_required",
      canonical_outcome: "ACTION_BLOCKED",
      reason_code: "STALE_STATE_RECONCILIATION",
      duplicate_spawn_allowed: false,
      next_action: "reconcile_stale_executor_identity_before_spawn_or_mutation",
    });
  });

  it("blocks identity-poor capability records before routing", () => {
    expect(
      resolveCleanupCrewCapabilityRoute({
        missionId: "cleanup-crew-governance",
        requiredCapability: "watchdog_repair",
        executors: [
          createCleanupCrewExecutorCapabilityRecord({
            executorId: "anonymous-counter",
            role: "TaskFlow",
            permitted: ["watchdog_repair"],
          }),
        ],
        evidence: ["counter says active but no task/session/run identity exists"],
      }),
    ).toMatchObject({
      outcome: "identity_missing_blocked",
      canonical_outcome: "ACTION_BLOCKED",
      reason_code: "ROLE_CAPABILITY_UNAVAILABLE",
      duplicate_spawn_allowed: false,
      next_action: "attach_executor_identity_and_receipt_requirements_before_routing",
    });
  });

  it("requires restart drain registration before active-work restart deferral", () => {
    expect(
      resolveCleanupCrewRestartContinuation({
        missionId: "cleanup-crew-governance",
        restartRequested: true,
        activeWorkPresent: true,
      }),
    ).toMatchObject({
      outcome: "restart_missing_registration_blocked",
      canonical_outcome: "ACTION_BLOCKED",
      reason_code: "RESTART_DRAIN_WAIT",
      mission_remains_open: true,
      allowed_to_close: false,
      next_action: "write_restart_registration_before_drain_or_restart",
    });
  });

  it("defers restart through a registered active-work drain", () => {
    const registration = createCleanupCrewRestartDrainRegistration({
      missionId: "cleanup-crew-governance",
      owner: "Will",
      restartTarget: "gateway-runtime",
      drainReason: "Phase 11 validates source turn as legitimate active work",
      activeWorkRef: "taskflow:763440db:revision39",
      timeoutAt: "2026-07-04T18:15:00.000Z",
      postRestartProofRequired: ["runtime_descriptor_loaded", "watchdog_clean"],
      timestamp: NOW,
    });

    expect(
      resolveCleanupCrewRestartContinuation({
        missionId: "cleanup-crew-governance",
        restartRequested: true,
        activeWorkPresent: true,
        registration,
      }),
    ).toMatchObject({
      outcome: "restart_registered_defer_until_drain",
      canonical_outcome: "DEFER_UNTIL_DRAIN",
      reason_code: "RESTART_DRAIN_WAIT",
      mission_remains_open: true,
      allowed_to_close: false,
      next_action: "defer_restart_until_registered_active_work_drains_then_probe",
    });
  });

  it("blocks closeout when post-restart target proof is missing", () => {
    const registration = createCleanupCrewRestartDrainRegistration({
      missionId: "cleanup-crew-governance",
      owner: "Will",
      restartTarget: "gateway-runtime",
      drainReason: "restart required after build",
      activeWorkRef: "taskflow:phase11",
      timeoutAt: "2026-07-04T18:15:00.000Z",
      postRestartProofRequired: ["runtime_descriptor_loaded", "watchdog_clean"],
      timestamp: NOW,
    });

    expect(
      resolveCleanupCrewRestartContinuation({
        missionId: "cleanup-crew-governance",
        restartRequested: true,
        activeWorkPresent: false,
        registration,
        postRestartProof: ["runtime_descriptor_loaded"],
        attemptedCloseout: true,
      }),
    ).toMatchObject({
      outcome: "post_restart_proof_missing_blocked",
      canonical_outcome: "ACTION_BLOCKED",
      allowed_to_close: false,
      mission_remains_open: true,
      next_action: "prove_post_restart_target_surface_loaded_before_closeout",
    });
  });

  it("continues after all post-restart target proof is present", () => {
    const registration = createCleanupCrewRestartDrainRegistration({
      missionId: "cleanup-crew-governance",
      owner: "Will",
      restartTarget: "gateway-runtime",
      drainReason: "restart required after build",
      activeWorkRef: "taskflow:phase11",
      timeoutAt: "2026-07-04T18:15:00.000Z",
      postRestartProofRequired: ["runtime_descriptor_loaded", "watchdog_clean"],
      timestamp: NOW,
    });

    expect(
      resolveCleanupCrewRestartContinuation({
        missionId: "cleanup-crew-governance",
        restartRequested: true,
        activeWorkPresent: false,
        registration,
        postRestartProof: ["runtime_descriptor_loaded", "watchdog_clean"],
      }),
    ).toMatchObject({
      outcome: "post_restart_proof_passed_continue",
      canonical_outcome: "CONTINUE",
      allowed_to_close: false,
      mission_remains_open: true,
      next_action: "continue_after_post_restart_target_surface_proof",
    });
  });

  it("continues through technical repair blockers without asking Mark", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Grant rejected closeout for missing proof path.",
        blocker: "proof missing",
        pathRisk: "MEDIUM_RISK_RUNTIME",
        diffIntent: "proof_or_receipt_shape",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    expect(decision.selectedState).toBe("CONTINUE_TECHNICAL_REPAIR");
    expect(decision.shouldContinue).toBe(true);
    expect(decision.askMark).toBe(false);
    expect(decision.invalidStopReasonRejected).toBe("proof missing");
  });

  it("classifies repairable prerequisite blockers as continue cleanup repair", () => {
    expect(
      classifyCleanupCrewBlocker({
        blocker: "repairable prerequisite blocker",
        nextRepairPathKnown: true,
      }),
    ).toMatchObject({
      category: "repairable_prerequisite_blocker",
      status: "in_progress",
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
      scopedStops: ["stop_final_closeout", "continue_cleanup_repair"],
    });
  });

  it("classifies downstream phase stops without stopping the whole mission", () => {
    expect(
      classifyCleanupCrewBlocker({
        summary: "Phase 13 watchdog blocker should stop Phase 14 but continue Cleanup Crew repair.",
        blocker: "downstream phase blocked",
      }),
    ).toMatchObject({
      category: "downstream_phase_blocked_cleanup_continues",
      status: "in_progress",
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
      scopedStops: [
        "stop_adjacent_phase",
        "stop_phase_transition",
        "stop_final_closeout",
        "continue_cleanup_repair",
      ],
    });
  });

  it("classifies raw DB required without emergency SOP as a hard whole-mission stop", () => {
    expect(
      classifyCleanupCrewBlocker({
        rawDbRequired: true,
        emergencySopAuthorized: false,
      }),
    ).toMatchObject({
      category: "raw_db_required_blocker",
      status: "blocked",
      canContinueCleanupRepair: false,
      hardStopWholeMission: true,
      scopedStops: ["stop_final_closeout", "hard_stop_whole_mission"],
    });
  });

  it("hard-stops unsupported missing surfaces only when no lawful discovery path exists", () => {
    expect(
      classifyCleanupCrewBlocker({
        unsupportedSurfaceMissing: true,
        lawfulDiscoveryPathAvailable: false,
      }),
    ).toMatchObject({
      category: "unsupported_surface_missing_blocker",
      status: "blocked",
      hardStopWholeMission: true,
    });

    expect(
      classifyCleanupCrewBlocker({
        unsupportedSurfaceMissing: true,
        lawfulDiscoveryPathAvailable: true,
      }),
    ).toMatchObject({
      category: "unsupported_surface_missing_blocker",
      status: "in_progress",
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
      scopedStops: ["stop_final_closeout", "continue_cleanup_repair"],
    });
  });

  it("routes proof-source unavailable to recovery when alternate lawful proof exists", () => {
    expect(
      classifyCleanupCrewBlocker({
        proofSourceUnavailable: true,
        alternateProofSourceAvailable: true,
      }),
    ).toMatchObject({
      category: "proof_source_unavailable_blocker",
      status: "in_progress",
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
    });
  });

  it("classifies the Phase 13 watchdog pattern as phase stop plus cleanup repair continuation", () => {
    expect(
      classifyCleanupCrewBlocker({
        summary:
          "Phase 13 watchdog NEEDS_REVIEW blocks Phase 14/final closeout; inspect latest watchdog receipt and rerun watchdog.",
      }),
    ).toMatchObject({
      category: "downstream_phase_blocked_cleanup_continues",
      status: "in_progress",
      scopedStops: [
        "stop_adjacent_phase",
        "stop_phase_transition",
        "stop_final_closeout",
        "continue_cleanup_repair",
      ],
      canContinueCleanupRepair: true,
      hardStopWholeMission: false,
    });
  });

  it("stops for root answer-only and inspect-only overrides", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      userInstruction: "Inspect only. Do not do anything yet.",
      issue: {
        summary: "technical proof repair exists",
        blocker: "test failed",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "bug_fix_same_behavior",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    expect(decision.selectedState).toBe("STOP_USER_ANSWER_ONLY_OVERRIDE");
    expect(decision.shouldContinue).toBe(false);
    expect(decision.askMark).toBe(false);
  });

  it("ignores answer-only phrases inside code fences and historical excerpts", () => {
    expect(
      parseRootOperatorOverride(
        "Continue Cleanup Crew.\n\n```text\nDo not do anything, just answer yes or no.\n```",
      ),
    ).toBeUndefined();
    expect(
      parseRootOperatorOverride(
        "Continue Cleanup Crew.\n\n> Prior log: inspect only and do not mutate.",
      ),
    ).toBeUndefined();
  });

  it("stops for product, UX, GUI, and system-purpose decisions", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Choose whether the dashboard workflow should add a new approval screen.",
        pathRisk: "HIGH_RISK_BEHAVIOR",
        diffIntent: "new_feature_behavior",
        behaviorImpact: "ux_flow",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    expect(decision.selectedState).toBe("STOP_HUMAN_PRODUCT_DECISION");
    expect(decision.askMark).toBe(true);
    expect(decision.stopReport?.why_this_is_not_technical).toContain("ux_flow");
  });

  it("diagnoses authority conflicts before stopping", () => {
    const resolved = resolveAuthority([
      source("historical_closeout", "old-closeout", { active: false }),
      source("active_build_plan", "current-plan"),
    ]);

    expect(resolved.winner).toBe("active_build_plan");
    expect(resolved.conflict_type).toBe("stale_artifact");
    expect(resolved.continue_state).toBe("CONTINUE_AFTER_AUTHORITY_CONFLICT_DIAGNOSIS");
  });

  it("stops on unresolved live authority conflict", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Two active live authorities conflict.",
        pathRisk: "MEDIUM_RISK_RUNTIME",
        diffIntent: "routing_or_catalog_recording",
      },
      authoritySources: [
        source("active_build_plan", "plan-a", { conflictWith: ["plan-b"] }),
        source("active_build_plan", "plan-b", { conflictWith: ["plan-a"] }),
      ],
    });

    expect(decision.selectedState).toBe("STOP_UNRESOLVED_AUTHORITY_CONFLICT");
    expect(decision.shouldContinue).toBe(false);
    expect(decision.askMark).toBe(false);
  });

  it("stops unsafe SOP-blocked behavior without asking Mark as a technical question", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Proposed repair conflicts with a live SOP safety block.",
        pathRisk: "CRITICAL_CONTROL",
        diffIntent: "bug_fix_same_behavior",
      },
      authoritySources: [
        source("active_build_plan", "continuity-gate-v2"),
        source("global_sop", "safety-stop", {
          safetyBlock: true,
          proofPath: "sop-proof.md",
        }),
      ],
    });

    expect(decision.selectedState).toBe("STOP_UNSAFE_BEHAVIOR_CHANGE");
    expect(decision.shouldContinue).toBe(false);
    expect(decision.askMark).toBe(false);
  });

  it("uses path risk plus diff intent instead of absolute path bans", () => {
    const proofShape = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Record already-authorized verifier proof ref.",
        pathRisk: "HIGH_RISK_BEHAVIOR",
        diffIntent: "proof_or_receipt_shape",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });
    const semantics = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "Change user-facing GUI flow semantics.",
        pathRisk: "HIGH_RISK_BEHAVIOR",
        diffIntent: "behavior_semantics_change",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    expect(proofShape.shouldContinue).toBe(true);
    expect(proofShape.grantReviewRequired).toBe(true);
    expect(semantics.selectedState).toBe("STOP_HUMAN_PRODUCT_DECISION");
  });

  it("classifies Grant mechanical failures as repairable within ceilings", () => {
    const rejection = classifyGrantRejection("missing artifact path(s)");
    const retry = resolveGrantRetry({
      retrySurfaceId: "grant_closeout:continuity_gate:artifact_fields",
      rejectionType: rejection,
      priorAttempts: 2,
    });

    expect(rejection).toBe("MECHANICAL_CLOSEOUT_FORMAT");
    expect(retry.result).toBe("continue_repair");
    expect(retry.attempt).toBe(3);
    expect(retry.maxAttempts).toBe(3);
    expect(retry.continueState).toBe("CONTINUE_AFTER_REPAIRABLE_GRANT_REJECTION");
  });

  it("generates deterministic Grant retry keys from rejection type, surface hash, and artifact id", () => {
    const key = createGrantRetryKey({
      rejectionType: "MECHANICAL_PROOF_LINK",
      fileSurfaceHash: "abc123",
      artifactId: "grant-closeout-artifact",
    });

    expect(key).toBe(
      createGrantRetryKey({
        rejectionType: "MECHANICAL_PROOF_LINK",
        fileSurfaceHash: "abc123",
        artifactId: "grant-closeout-artifact",
      }),
    );
    expect(key).not.toBe(
      createGrantRetryKey({
        rejectionType: "SEMANTIC_SAFETY",
        fileSurfaceHash: "abc123",
        artifactId: "grant-closeout-artifact",
      }),
    );
    expect(key).toMatch(/^grant_retry_/);
  });

  it.each([
    ["MECHANICAL_CLOSEOUT_FORMAT", 2, "continue_repair", 3],
    ["MECHANICAL_CLOSEOUT_FORMAT", 3, "stop_or_true_blocker", 3],
    ["MECHANICAL_PROOF_LINK", 2, "continue_repair", 3],
    ["MECHANICAL_PROOF_LINK", 3, "stop_or_true_blocker", 3],
    ["SEMANTIC_SAFETY", 0, "stop_or_true_blocker", 1],
    ["SCOPE_EXPANSION", 0, "stop_or_plan_update_required", 0],
  ] as const)(
    "enforces Grant retry ceiling for %s after %s prior attempt(s)",
    (rejectionType, priorAttempts, result, maxAttempts) => {
      expect(
        resolveGrantRetry({
          retrySurfaceId: createGrantRetryKey({
            rejectionType,
            fileSurfaceHash: "surface",
            artifactId: "artifact",
          }),
          rejectionType,
          priorAttempts,
        }),
      ).toMatchObject({
        result,
        maxAttempts,
      });
    },
  );

  it("does not force Grant semantic safety or scope expansion failures", () => {
    expect(
      resolveGrantRetry({
        retrySurfaceId: "grant:safety",
        rejectionType: "SEMANTIC_SAFETY",
        priorAttempts: 1,
      }).result,
    ).toBe("stop_or_true_blocker");
    expect(
      resolveGrantRetry({
        retrySurfaceId: "grant:scope",
        rejectionType: "SCOPE_EXPANSION",
        priorAttempts: 0,
      }).result,
    ).toBe("stop_or_plan_update_required");
  });

  it("refreshes expired build-context constraints instead of stopping", () => {
    const constraint: BuildContextConstraint = {
      schema: "openclaw.build_context_constraint.v2",
      constraint_id: "current_trinity_exclusion_2026_07",
      label: "Trinity excluded from current cleanup chain",
      source_artifact: "artifact.md",
      created_at: "2026-07-04T15:00:00.000Z",
      expires_at: "2026-07-04T17:00:00.000Z",
      max_major_phase_count: 1,
      refresh_probe: "verify_active_plan_and_shared_file_overlap",
      on_expiry: "REFRESH_THEN_RECLASSIFY",
      status: "active",
    };

    expect(classifyBuildContextConstraint(constraint, NOW)).toMatchObject({
      status: "expired",
      action: "REFRESH_THEN_RECLASSIFY",
      selectedState: "CONTINUE_PLAN_NEXT_STEP",
    });
  });

  it("creates decision records, continue receipts, stop reports, and diagnostic traces", () => {
    const decision = evaluateContinuityGateV2({
      now: NOW,
      activeMission: "Cleanup Crew repair",
      issue: {
        summary: "test failed but fix is known",
        blocker: "test failed",
        pathRisk: "LOW_RISK_TECHNICAL",
        diffIntent: "test_alignment",
      },
      authoritySources: [source("active_build_plan", "continuity-gate-v2")],
    });

    const record = createCleanupCrewDecisionRecord(decision);
    const receipt = createContinueReceipt(decision, {
      repairAction: "repair focused test",
      proofPath: "proof.json",
    });
    const stop = createStopReport(
      evaluateContinuityGateV2({
        now: NOW,
        activeMission: "Cleanup Crew repair",
        issue: {
          summary: "new product decision",
          pathRisk: "HIGH_RISK_BEHAVIOR",
          diffIntent: "new_feature_behavior",
          behaviorImpact: "product_behavior",
        },
        authoritySources: [source("active_build_plan", "continuity-gate-v2")],
      }),
      { diagnosticArtifact: "diagnostic.json" },
    );
    const trace = createDiagnosticTrace(decision, {
      filesTouched: ["src/continuity/continuity-gate-v2.ts"],
      tests: ["continuity-gate-v2.test.ts"],
      surfaces: ["cleanup-plan"],
      records: ["decision-record"],
      commands: ["node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts"],
      grantResult: "not_requested",
      proofRefs: ["proof.json"],
      redactionStatus: "no_sensitive_payloads",
    });

    expect(record.schema).toBe("openclaw.cleanup_crew_decision_record.v2");
    expect(receipt.schema).toBe("openclaw.cleanup_crew_continue_receipt.v2");
    expect(stop.schema).toBe("openclaw.cleanup_crew_stop_report.v2");
    expect(trace.schema).toBe("openclaw.cleanup_crew_diagnostic_trace.v2");
    expect(trace).toMatchObject({
      owner_level_blocker_audit: "technical_owner",
      risk_classification: {
        path_risk: "LOW_RISK_TECHNICAL",
        diff_intent: "test_alignment",
      },
      technical_vs_product: {
        lane: "technical",
      },
      scope: {
        surfaces: ["cleanup-plan"],
        records: ["decision-record"],
        commands: ["node scripts/run-vitest.mjs run src/continuity/continuity-gate-v2.test.ts"],
      },
      grant_result: "not_requested",
      proof_refs: ["proof.json"],
    });
  });

  it("writes durable decision, receipt, stop-report, and diagnostic artifacts", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-gate-"));
    try {
      const decision = evaluateContinuityGateV2({
        now: NOW,
        activeMission: "Cleanup Crew repair",
        issue: {
          summary: "missing proof but repair path is known",
          blocker: "proof missing",
          pathRisk: "MEDIUM_RISK_RUNTIME",
          diffIntent: "proof_or_receipt_shape",
        },
        authoritySources: [source("active_build_plan", "continuity-gate-v2")],
      });
      const stopDecision = evaluateContinuityGateV2({
        now: NOW,
        activeMission: "Cleanup Crew repair",
        issue: {
          summary: "new UX behavior decision",
          pathRisk: "HIGH_RISK_BEHAVIOR",
          diffIntent: "new_feature_behavior",
          behaviorImpact: "ux_flow",
        },
        authoritySources: [source("active_build_plan", "continuity-gate-v2")],
      });
      const record = createCleanupCrewDecisionRecord(decision);
      const receipt = createContinueReceipt(decision, {
        repairAction: "repair proof path",
        proofPath: "proof.json",
      });
      const stopReport = createStopReport(stopDecision, {
        diagnosticArtifact: "diagnostic.json",
      });
      const trace = createDiagnosticTrace(decision, {
        filesTouched: ["src/continuity/continuity-gate-v2.ts"],
        tests: ["src/continuity/continuity-gate-v2.test.ts"],
        redactionStatus: "no_sensitive_payloads",
      });

      const writes = await writeCleanupCrewDurableArtifacts({
        outputDir,
        decisionRecord: record,
        continueReceipt: receipt,
        stopReport,
        diagnosticTrace: trace,
      });

      expect(writes.map((write) => write.kind)).toEqual([
        "decision_record",
        "continue_receipt",
        "stop_report",
        "diagnostic_trace",
      ]);
      const persistedRecord = JSON.parse(await readFile(writes[0]!.path, "utf8")) as {
        schema: string;
        decision_id: string;
      };
      expect(persistedRecord).toMatchObject({
        schema: "openclaw.cleanup_crew_decision_record.v2",
        decision_id: decision.decisionId,
      });
      expect(writes.every((write) => write.path.startsWith(outputDir))).toBe(true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
