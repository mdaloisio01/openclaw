import { describe, expect, it } from "vitest";
import {
  GIE_OPERATOR_CONTROL_ACTIONS,
  GIE_OPERATOR_DASHBOARD_QUEUES,
  createGieOperatorControlAction,
  createGieOperatorDashboardState,
  createGieOperatorQueueItem,
  createGieProofVisibilityRecord,
  createGieStateVisibilityRecord,
} from "./operator-control-dashboard.js";

const NOW = Date.parse("2026-07-21T22:15:00Z");

function makeQueueItem(queue: (typeof GIE_OPERATOR_DASHBOARD_QUEUES)[number]) {
  return createGieOperatorQueueItem({
    itemId: `item-${queue}`,
    queue,
    title: `Review ${queue}`,
    stateRef: `state-${queue}`,
    proofRefs: [`proof-${queue}`],
    authorityRef: "phase12-authority",
    priority: queue.includes("alert") ? "high" : "medium",
    createdAt: NOW,
  });
}

describe("GIE operator control dashboard", () => {
  it("defines every required Phase 12 queue and action", () => {
    expect(GIE_OPERATOR_DASHBOARD_QUEUES).toEqual([
      "operator_review",
      "approvals",
      "denials",
      "contradictions",
      "feedback_corrections",
      "learning_candidates",
      "promotion_rollbacks",
      "recurring_issues",
      "drift_alerts",
      "unsafe_pattern_alerts",
    ]);
    expect(GIE_OPERATOR_CONTROL_ACTIONS).toEqual([
      "inspect_proof",
      "inspect_state",
      "approve",
      "deny",
      "pause",
      "resume",
      "request_override",
      "freeze",
    ]);
  });

  it("builds a dashboard state exposing all queues plus proof and state visibility", () => {
    const dashboard = createGieOperatorDashboardState({
      dashboardId: "dashboard-1",
      queueItems: GIE_OPERATOR_DASHBOARD_QUEUES.map(makeQueueItem),
      proofVisibility: [
        createGieProofVisibilityRecord({
          targetRef: "phase11-adoption",
          proofRefs: ["proof"],
          receiptRefs: ["receipt"],
        }),
      ],
      stateVisibility: [
        createGieStateVisibilityRecord({
          targetRef: "phase11-adoption",
          currentState: "global_adoption",
          stateRef: "state-ref",
        }),
      ],
      authorityRef: "phase12-authority",
      proofRefs: ["dashboard-proof"],
      generatedAt: NOW,
    });

    expect(Object.keys(dashboard.queues)).toEqual([...GIE_OPERATOR_DASHBOARD_QUEUES]);
    expect(dashboard.queues.contradictions).toHaveLength(1);
    expect(dashboard.queues.feedback_corrections).toHaveLength(1);
    expect(dashboard.queues.learning_candidates).toHaveLength(1);
    expect(dashboard.queues.promotion_rollbacks).toHaveLength(1);
    expect(dashboard.queues.recurring_issues).toHaveLength(1);
    expect(dashboard.queues.drift_alerts[0].priority).toBe("high");
    expect(dashboard.queues.unsafe_pattern_alerts[0].priority).toBe("high");
    expect(dashboard.proofVisibility[0].visible).toBe(true);
    expect(dashboard.stateVisibility[0].visible).toBe(true);
  });

  it("records inspection and denial control actions through policy", () => {
    const inspect = createGieOperatorControlAction({
      actionId: "inspect-proof-1",
      action: "inspect_proof",
      targetRef: "phase11-adoption",
      requestedBy: "mark",
      reason: "Inspect verifier proof before action.",
      authorityRef: "phase12-authority",
      proofRefs: ["proof"],
      createdAt: NOW,
    });
    const denial = createGieOperatorControlAction({
      actionId: "deny-1",
      action: "deny",
      targetRef: "bad-promotion",
      requestedBy: "mark",
      reason: "Reject unsafe pattern.",
      authorityRef: "phase12-authority",
      proofRefs: ["proof"],
      createdAt: NOW,
    });

    expect(inspect.status).toBe("recorded");
    expect(denial.status).toBe("recorded");
  });

  it("requires approval proof for approve, pause, resume, and freeze actions", () => {
    for (const action of ["approve", "pause", "resume", "freeze"] as const) {
      expect(() =>
        createGieOperatorControlAction({
          actionId: `${action}-missing-approval`,
          action,
          targetRef: "phase11-adoption",
          requestedBy: "mark",
          reason: `Attempt ${action}.`,
          authorityRef: "phase12-authority",
          proofRefs: ["proof"],
          createdAt: NOW,
        }),
      ).toThrow("gie_operator_control_action_approval_required");

      const approved = createGieOperatorControlAction({
        actionId: `${action}-approved`,
        action,
        targetRef: "phase11-adoption",
        requestedBy: "mark",
        approvalRef: `${action}-approval`,
        reason: `Governed ${action}.`,
        authorityRef: "phase12-authority",
        proofRefs: ["proof"],
        createdAt: NOW,
      });
      expect(approved.status).toBe("recorded");
      expect(approved.approvalRef).toBe(`${action}-approval`);
    }
  });

  it("routes override requests to approval-required instead of executing them directly", () => {
    const override = createGieOperatorControlAction({
      actionId: "override-1",
      action: "request_override",
      targetRef: "phase11-adoption",
      requestedBy: "mark",
      reason: "Request governed exception review.",
      authorityRef: "phase12-authority",
      proofRefs: ["proof"],
      createdAt: NOW,
    });

    expect(override.status).toBe("approval_required");
    expect(override.policyDecision.decision).toBe("approval_required");
  });
});
