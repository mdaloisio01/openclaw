export const BUILD_ISSUE_TRIAGE_ACTIONS = [
  "log_deferred_issue_and_resume",
  "record_current_blocker_and_stop",
  "record_duplicate_and_resume",
  "stop_for_operator_decision",
] as const;

export type BuildIssueTriageAction = (typeof BUILD_ISSUE_TRIAGE_ACTIONS)[number];

export const BUILD_ISSUE_TRIAGE_REASON_CODES = [
  "duplicate_existing_issue",
  "operator_requested_log_only",
  "blocks_current_mission",
  "unsafe_or_dishonest_to_continue",
  "issue_register_write_missing",
  "active_mission_resume_required",
  "operator_decision_required",
] as const;

export type BuildIssueTriageReasonCode = (typeof BUILD_ISSUE_TRIAGE_REASON_CODES)[number];

export type BuildDiscoveredIssueTriageFacts = {
  activeBuildMission?: boolean;
  duplicateIssueId?: string;
  operatorRequestedLogOnly?: boolean;
  blocksCurrentMission?: boolean;
  continuingWouldBeUnsafe?: boolean;
  continuingWouldBeDishonest?: boolean;
  continuingWouldBeImpossible?: boolean;
  issueRegisterUpdated?: boolean;
  lawfulResumeAction?: string;
  operatorDecisionRequired?: boolean;
};

export type BuildDiscoveredIssueTriageDecision = {
  action: BuildIssueTriageAction;
  shouldResearchNow: boolean;
  shouldResumeActiveBuild: boolean;
  requiresIssueRegisterAction: boolean;
  requiresCurrentBlockerRecord: boolean;
  reasonCodes: BuildIssueTriageReasonCode[];
  nextAction: string;
};

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function appendReason(
  reasons: BuildIssueTriageReasonCode[],
  reason: BuildIssueTriageReasonCode,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

export function triageBuildDiscoveredIssue(
  facts: BuildDiscoveredIssueTriageFacts,
): BuildDiscoveredIssueTriageDecision {
  const reasonCodes: BuildIssueTriageReasonCode[] = [];
  const activeBuildMission = facts.activeBuildMission === true;
  const duplicateIssue = hasText(facts.duplicateIssueId);
  const hardBlocksCurrentMission =
    facts.blocksCurrentMission === true ||
    facts.continuingWouldBeUnsafe === true ||
    facts.continuingWouldBeDishonest === true ||
    facts.continuingWouldBeImpossible === true;

  if (facts.operatorDecisionRequired === true) {
    appendReason(reasonCodes, "operator_decision_required");
    return {
      action: "stop_for_operator_decision",
      shouldResearchNow: false,
      shouldResumeActiveBuild: false,
      requiresIssueRegisterAction: facts.issueRegisterUpdated !== true,
      requiresCurrentBlockerRecord: false,
      reasonCodes,
      nextAction: "ask Mark for the exact operator decision before changing build scope",
    };
  }

  if (duplicateIssue) {
    appendReason(reasonCodes, "duplicate_existing_issue");
    if (facts.issueRegisterUpdated !== true) {
      appendReason(reasonCodes, "issue_register_write_missing");
    }
    if (activeBuildMission && hasText(facts.lawfulResumeAction)) {
      appendReason(reasonCodes, "active_mission_resume_required");
    }
    return {
      action: hardBlocksCurrentMission
        ? "record_current_blocker_and_stop"
        : "record_duplicate_and_resume",
      shouldResearchNow: false,
      shouldResumeActiveBuild: activeBuildMission && !hardBlocksCurrentMission,
      requiresIssueRegisterAction: facts.issueRegisterUpdated !== true,
      requiresCurrentBlockerRecord: hardBlocksCurrentMission,
      reasonCodes,
      nextAction: hardBlocksCurrentMission
        ? `record the current blocker against ${facts.duplicateIssueId} and stop before closure`
        : (facts.lawfulResumeAction?.trim() ??
          `append duplicate reference to ${facts.duplicateIssueId} and resume the active build`),
    };
  }

  if (hardBlocksCurrentMission) {
    appendReason(reasonCodes, "blocks_current_mission");
    if (facts.continuingWouldBeUnsafe === true || facts.continuingWouldBeDishonest === true) {
      appendReason(reasonCodes, "unsafe_or_dishonest_to_continue");
    }
    if (facts.issueRegisterUpdated !== true) {
      appendReason(reasonCodes, "issue_register_write_missing");
    }
    return {
      action: "record_current_blocker_and_stop",
      shouldResearchNow: false,
      shouldResumeActiveBuild: false,
      requiresIssueRegisterAction: facts.issueRegisterUpdated !== true,
      requiresCurrentBlockerRecord: true,
      reasonCodes,
      nextAction: "record the blocker with proof, route repair, and do not close the active build",
    };
  }

  if (facts.operatorRequestedLogOnly === true) {
    appendReason(reasonCodes, "operator_requested_log_only");
  }
  if (facts.issueRegisterUpdated !== true) {
    appendReason(reasonCodes, "issue_register_write_missing");
  }
  if (activeBuildMission) {
    appendReason(reasonCodes, "active_mission_resume_required");
  }

  return {
    action: "log_deferred_issue_and_resume",
    shouldResearchNow: false,
    shouldResumeActiveBuild: activeBuildMission,
    requiresIssueRegisterAction: facts.issueRegisterUpdated !== true,
    requiresCurrentBlockerRecord: false,
    reasonCodes,
    nextAction:
      facts.lawfulResumeAction?.trim() ??
      "write the minimum durable issue entry and resume the active build",
  };
}
