import { describe, expect, it } from "vitest";
import { triageBuildDiscoveredIssue } from "./build-discovered-issue-triage.js";

describe("build-discovered issue triage", () => {
  it("logs non-blocking build-discovered issues and resumes instead of researching", () => {
    expect(
      triageBuildDiscoveredIssue({
        activeBuildMission: true,
        operatorRequestedLogOnly: true,
        issueRegisterUpdated: true,
        lawfulResumeAction: "continue Phase 5 validation",
      }),
    ).toEqual({
      action: "log_deferred_issue_and_resume",
      shouldResearchNow: false,
      shouldResumeActiveBuild: true,
      requiresIssueRegisterAction: false,
      requiresCurrentBlockerRecord: false,
      reasonCodes: ["operator_requested_log_only", "active_mission_resume_required"],
      nextAction: "continue Phase 5 validation",
    });
  });

  it("records a current blocker instead of burying active build blockers as deferred issues", () => {
    expect(
      triageBuildDiscoveredIssue({
        activeBuildMission: true,
        blocksCurrentMission: true,
        continuingWouldBeDishonest: true,
        issueRegisterUpdated: false,
      }),
    ).toMatchObject({
      action: "record_current_blocker_and_stop",
      shouldResearchNow: false,
      shouldResumeActiveBuild: false,
      requiresIssueRegisterAction: true,
      requiresCurrentBlockerRecord: true,
      reasonCodes: [
        "blocks_current_mission",
        "unsafe_or_dishonest_to_continue",
        "issue_register_write_missing",
      ],
      nextAction: "record the blocker with proof, route repair, and do not close the active build",
    });
  });

  it("deduplicates non-blocking issues and returns to the active build", () => {
    expect(
      triageBuildDiscoveredIssue({
        activeBuildMission: true,
        duplicateIssueId: "ISSUE-015",
        issueRegisterUpdated: true,
        lawfulResumeAction: "resume current build phase",
      }),
    ).toMatchObject({
      action: "record_duplicate_and_resume",
      shouldResearchNow: false,
      shouldResumeActiveBuild: true,
      requiresIssueRegisterAction: false,
      requiresCurrentBlockerRecord: false,
      reasonCodes: ["duplicate_existing_issue", "active_mission_resume_required"],
      nextAction: "resume current build phase",
    });
  });

  it("stops for operator decisions before changing build scope", () => {
    expect(
      triageBuildDiscoveredIssue({
        activeBuildMission: true,
        operatorDecisionRequired: true,
      }),
    ).toMatchObject({
      action: "stop_for_operator_decision",
      shouldResearchNow: false,
      shouldResumeActiveBuild: false,
      requiresIssueRegisterAction: true,
      requiresCurrentBlockerRecord: false,
      reasonCodes: ["operator_decision_required"],
      nextAction: "ask Mark for the exact operator decision before changing build scope",
    });
  });
});
