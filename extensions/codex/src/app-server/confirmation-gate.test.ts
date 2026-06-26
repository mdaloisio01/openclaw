import { describe, expect, it } from "vitest";
import type { CodexWorkspaceBootstrapContext } from "./attempt-context.js";
import {
  resolveCodexConfirmationGateDecision,
  withCodexConfirmationGatePending,
  type CodexConfirmationGatePending,
} from "./confirmation-gate.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

function confirmationWorkspace(): CodexWorkspaceBootstrapContext {
  return {
    bootstrapFiles: [
      {
        name: "USER.md",
        path: "/workspace/USER.md",
        content:
          "## Mark Instruction Confirmation Law\n\nBefore doing anything on a new instruction from Mark, first paraphrase back in short plain English and wait for Mark to confirm yes/no.",
      },
    ],
    contextFiles: [],
  };
}

function stalePolicyWorkspace(): CodexWorkspaceBootstrapContext {
  return {
    bootstrapFiles: [
      {
        name: "AGENTS.md",
        path: "/workspace/AGENTS.md",
        content: [
          "## Mark Instruction Confirmation Law",
          "",
          "Before doing anything on a new instruction from Mark, first paraphrase back in short plain English and wait for Mark to confirm yes/no.",
          "",
          "Emergency confirmation-loop rule:",
          "",
          "- The old mandatory paraphrase/yes-no gate is suspended.",
          "- Do not ask for yes/no confirmation before ordinary requests.",
          "- Do not ask for yes/no confirmation before status requests.",
        ].join("\n"),
      },
    ],
    contextFiles: [],
  };
}

function bindingWithPending(mission = "fix the server-side gate"): CodexAppServerThreadBinding {
  return {
    schemaVersion: 1,
    threadId: "thread-1",
    sessionFile: "/tmp/session.jsonl",
    cwd: "/workspace",
    confirmationGate: {
      schemaVersion: 1,
      status: "pending",
      mission,
      createdAt: "2026-06-25T04:00:00.000Z",
    },
    createdAt: "2026-06-25T04:00:00.000Z",
    updatedAt: "2026-06-25T04:00:00.000Z",
  };
}

describe("Codex confirmation gate", () => {
  it("creates a pending confirmation for a new instruction when workspace policy requires it", () => {
    const decision = resolveCodexConfirmationGateDecision({
      prompt: "run the server-side fix",
      confirmationPolicy: "confirm-new-instructions",
      workspaceBootstrapContext: confirmationWorkspace(),
      runId: "run-1",
      now: new Date("2026-06-25T04:01:00.000Z"),
    });

    expect(decision).toMatchObject({
      action: "request_confirmation",
      pending: {
        status: "pending",
        mission: "run the server-side fix",
        runId: "run-1",
      },
    });
    expect(decision.action === "request_confirmation" ? decision.prompt : "").toContain(
      "Do not call tools.",
    );
  });

  it.each(["update", "status", "what is the blocker?"])(
    "does not create a pending confirmation for normal message %j when policy is disabled",
    (prompt) => {
      const decision = resolveCodexConfirmationGateDecision({
        prompt,
        confirmationPolicy: "disabled",
        workspaceBootstrapContext: confirmationWorkspace(),
        runId: "run-1",
        now: new Date("2026-06-25T16:20:00.000Z"),
      });

      expect(decision).toEqual({ action: "none", reason: "policy-not-required" });
    },
  );

  it("does not create a pending confirmation from stale prompt or memory prose by itself", () => {
    const decision = resolveCodexConfirmationGateDecision({
      prompt: "status",
      workspaceBootstrapContext: stalePolicyWorkspace(),
      runId: "run-1",
      now: new Date("2026-06-25T16:20:00.000Z"),
    });

    expect(decision).toEqual({ action: "none", reason: "policy-not-required" });
  });

  it("lets explicit confirmation policy win over stale suspension prose", () => {
    const decision = resolveCodexConfirmationGateDecision({
      prompt: "status",
      confirmationPolicy: "confirm-new-instructions",
      workspaceBootstrapContext: stalePolicyWorkspace(),
      runId: "run-1",
      now: new Date("2026-06-25T16:20:00.000Z"),
    });

    expect(decision).toMatchObject({
      action: "request_confirmation",
      pending: { mission: "status" },
    });
  });

  it("releases only the latest pending mission on yes", () => {
    const decision = resolveCodexConfirmationGateDecision({
      prompt: "yes",
      confirmationPolicy: "confirm-new-instructions",
      workspaceBootstrapContext: confirmationWorkspace(),
      startupBinding: bindingWithPending("fix the stored mission"),
    });

    expect(decision).toEqual({
      action: "release_confirmed_mission",
      mission: "fix the stored mission",
    });
  });

  it("rejects pending mission on no and keeps ambiguous replies pending", () => {
    const pendingBinding = bindingWithPending("fix the stored mission");
    const noDecision = resolveCodexConfirmationGateDecision({
      prompt: "no",
      confirmationPolicy: "confirm-new-instructions",
      workspaceBootstrapContext: confirmationWorkspace(),
      startupBinding: pendingBinding,
    });
    expect(noDecision).toMatchObject({
      action: "reject_pending_mission",
      pending: { mission: "fix the stored mission" },
    });

    const ambiguousDecision = resolveCodexConfirmationGateDecision({
      prompt: "what do you mean?",
      confirmationPolicy: "confirm-new-instructions",
      workspaceBootstrapContext: confirmationWorkspace(),
      startupBinding: pendingBinding,
    });
    expect(ambiguousDecision).toMatchObject({
      action: "keep_pending_mission",
      pending: { mission: "fix the stored mission" },
    });
  });

  it("writes and clears pending state on the existing binding shape", () => {
    const binding = bindingWithPending();
    const pending: CodexConfirmationGatePending = {
      schemaVersion: 1,
      status: "pending",
      mission: "new mission",
      createdAt: "2026-06-25T04:02:00.000Z",
    };

    expect(withCodexConfirmationGatePending(binding, pending).confirmationGate).toEqual(pending);
    expect(withCodexConfirmationGatePending(binding, undefined)).not.toHaveProperty(
      "confirmationGate",
    );
  });
});
