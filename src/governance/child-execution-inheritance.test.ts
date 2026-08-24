import { describe, expect, it } from "vitest";
import { evaluateChildExecutionInheritance } from "./child-execution-inheritance.js";

const now = "2026-08-23T03:56:00Z";

const baseInput = {
  actionId: "child-spawn-1",
  parent: {
    missionId: "mission-1",
    contractId: "contract-1",
    contractHash: "contract-hash",
    authorityHash: "authority-hash",
    sessionKey: "agent:orchestrator:main",
    runId: "parent-run",
    taskFlowId: "flow-1",
    taskId: "task-1",
    policy: {
      authorityRank: "governed" as const,
      allowedActionClasses: ["tool_call", "exec_call", "child_delegation"],
    },
  },
  child: {
    runtime: "subagent" as const,
    sessionKey: "agent:grant:subagent:child",
    runId: "child-run",
    taskFlowId: "flow-1",
    taskId: "task-2",
    policy: {
      authorityRank: "read_only" as const,
      allowedActionClasses: ["tool_call"],
    },
  },
  now,
};

describe("child execution inheritance", () => {
  it("allows child delegation when authority and actions are equal-or-narrower", () => {
    expect(evaluateChildExecutionInheritance(baseInput)).toMatchObject({
      decision: "ALLOW",
      reasonCode: "CHILD_AUTHORITY_INHERITED",
      obligations: ["write_child_inheritance_receipt"],
      receipt: {
        parentMissionId: "mission-1",
        parentContractHash: "contract-hash",
        parentTaskFlowId: "flow-1",
        parentTaskId: "task-1",
        childRuntime: "subagent",
        childSessionKey: "agent:grant:subagent:child",
        childRunId: "child-run",
        childTaskFlowId: "flow-1",
        childTaskId: "task-2",
        effectiveChildPolicy: {
          authorityRank: "read_only",
          allowedActionClasses: ["tool_call"],
        },
      },
    });
  });

  it("denies child authority wider than the parent", () => {
    expect(
      evaluateChildExecutionInheritance({
        ...baseInput,
        child: {
          ...baseInput.child,
          policy: {
            ...baseInput.child.policy,
            authorityRank: "protected",
          },
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "CHILD_AUTHORITY_EXCEEDS_PARENT",
      obligations: ["deny_child_delegation", "narrow_child_authority"],
    });
  });

  it("denies child action classes unavailable to the parent", () => {
    expect(
      evaluateChildExecutionInheritance({
        ...baseInput,
        child: {
          ...baseInput.child,
          policy: {
            ...baseInput.child.policy,
            allowedActionClasses: ["tool_call", "release"],
          },
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "CHILD_ACTION_CLASS_EXCEEDS_PARENT",
      obligations: ["deny_child_delegation", "remove_child_action_classes:release"],
    });
  });

  it("denies when central child-delegation policy has already denied", () => {
    expect(
      evaluateChildExecutionInheritance({
        ...baseInput,
        policyDecision: {
          schema: "openclaw.governed_policy_decision.v1",
          decision: "DENY",
          reasonCode: "CHILD_DELEGATION_DENIED",
          policyVersion: "sop-enforcement-v1",
          contractId: "contract-1",
          contractHash: "contract-hash",
          obligations: ["do_not_spawn_child"],
          receiptMetadata: {
            missionId: "mission-1",
            actionId: "child-spawn-1",
            actorId: "will",
            producedAt: now,
          },
        },
      }),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "CENTRAL_POLICY_DENIED",
      obligations: ["deny_child_delegation", "do_not_spawn_child"],
    });
  });
});
