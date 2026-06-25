import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexWorkspaceBootstrapContext } from "./attempt-context.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

export type CodexConfirmationGatePending = {
  schemaVersion: 1;
  status: "pending";
  mission: string;
  createdAt: string;
  runId?: string;
};

export type CodexConfirmationGateDecision =
  | {
      action: "none";
      reason: "policy-not-required" | "automation-turn" | "empty-prompt" | "answer-without-pending";
    }
  | {
      action: "request_confirmation";
      pending: CodexConfirmationGatePending;
      prompt: string;
    }
  | {
      action: "release_confirmed_mission";
      mission: string;
    }
  | {
      action: "reject_pending_mission";
      pending: CodexConfirmationGatePending;
      prompt: string;
    }
  | {
      action: "keep_pending_mission";
      pending: CodexConfirmationGatePending;
      prompt: string;
    };

export type CodexConfirmationGateBinding = {
  confirmationGate?: CodexConfirmationGatePending;
};

const CONFIRMATION_POLICY_PATTERNS = [
  "Before doing anything on a new instruction from Mark",
  "first paraphrase back in short plain English",
  "wait for Mark to confirm yes/no",
];
const CONFIRMATION_POLICY_SUSPENSION_PATTERNS = [
  "old mandatory paraphrase/yes-no gate is suspended",
  "Do not ask for yes/no confirmation before ordinary requests",
  "Do not ask for yes/no confirmation before status requests",
];

const YES_PATTERN =
  /^(?:yes|y|yeah|yep|correct|confirmed|confirm|do it|run it|go|go ahead|proceed|continue|ok|okay)$/iu;
const NO_PATTERN = /^(?:no|n|nope|wrong|incorrect|not correct|stop|cancel)$/iu;

export function readCodexConfirmationGatePending(
  binding: CodexAppServerThreadBinding | undefined,
): CodexConfirmationGatePending | undefined {
  const candidate = (
    binding as (CodexAppServerThreadBinding & CodexConfirmationGateBinding) | undefined
  )?.confirmationGate;
  if (
    candidate?.schemaVersion !== 1 ||
    candidate.status !== "pending" ||
    typeof candidate.mission !== "string" ||
    !candidate.mission.trim() ||
    typeof candidate.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    status: "pending",
    mission: candidate.mission,
    createdAt: candidate.createdAt,
    ...(typeof candidate.runId === "string" && candidate.runId.trim()
      ? { runId: candidate.runId }
      : {}),
  };
}

export function withCodexConfirmationGatePending<T extends CodexAppServerThreadBinding | undefined>(
  binding: T,
  pending: CodexConfirmationGatePending | undefined,
): T {
  if (!binding) {
    return binding;
  }
  const next = { ...binding } as T & CodexConfirmationGateBinding;
  if (pending) {
    next.confirmationGate = pending;
  } else {
    delete next.confirmationGate;
  }
  return next;
}

export function resolveCodexConfirmationGateDecision(params: {
  prompt: string;
  trigger?: string;
  workspaceBootstrapContext: CodexWorkspaceBootstrapContext;
  startupBinding?: CodexAppServerThreadBinding;
  historyMessages?: readonly AgentMessage[];
  runId?: string;
  now?: Date;
}): CodexConfirmationGateDecision {
  const prompt = params.prompt.trim();
  if (!prompt) {
    return { action: "none", reason: "empty-prompt" };
  }
  if (params.trigger === "cron" || params.trigger === "heartbeat") {
    return { action: "none", reason: "automation-turn" };
  }

  if (!workspaceRequiresConfirmation(params.workspaceBootstrapContext)) {
    return { action: "none", reason: "policy-not-required" };
  }

  const pending = readCodexConfirmationGatePending(params.startupBinding);
  if (pending) {
    const reply = classifyConfirmationReply(prompt);
    if (reply === "yes") {
      return { action: "release_confirmed_mission", mission: pending.mission };
    }
    if (reply === "no") {
      return {
        action: "reject_pending_mission",
        pending,
        prompt: buildRejectedConfirmationPrompt(pending),
      };
    }
    return {
      action: "keep_pending_mission",
      pending,
      prompt: buildAmbiguousConfirmationPrompt(pending),
    };
  }

  if (classifyConfirmationReply(prompt) !== "other") {
    return { action: "none", reason: "answer-without-pending" };
  }

  const newPending: CodexConfirmationGatePending = {
    schemaVersion: 1,
    status: "pending",
    mission: prompt,
    createdAt: (params.now ?? new Date()).toISOString(),
    ...(params.runId ? { runId: params.runId } : {}),
  };
  return {
    action: "request_confirmation",
    pending: newPending,
    prompt: buildRequestConfirmationPrompt(newPending),
  };
}

function workspaceRequiresConfirmation(context: CodexWorkspaceBootstrapContext): boolean {
  const haystacks = [
    ...context.bootstrapFiles.map((file) => file.content ?? ""),
    context.developerInstructions,
    context.turnScopedDeveloperInstructions,
    context.memoryCollaborationInstructions,
  ].filter((text): text is string => Boolean(text?.trim()));
  if (
    haystacks.some((text) =>
      CONFIRMATION_POLICY_SUSPENSION_PATTERNS.some((pattern) => text.includes(pattern)),
    )
  ) {
    return false;
  }
  return haystacks.some((text) =>
    CONFIRMATION_POLICY_PATTERNS.some((pattern) => text.includes(pattern)),
  );
}

function classifyConfirmationReply(prompt: string): "yes" | "no" | "other" {
  const normalized = prompt
    .trim()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
  if (YES_PATTERN.test(normalized)) {
    return "yes";
  }
  if (NO_PATTERN.test(normalized)) {
    return "no";
  }
  return "other";
}

function buildRequestConfirmationPrompt(pending: CodexConfirmationGatePending): string {
  return [
    "Confirmation gate:",
    "",
    "Paraphrase this mission back to Mark in short plain English, then ask exactly: `Confirm yes/no?`",
    "",
    "Do not execute the mission yet.",
    "Do not call tools.",
    "Do not inspect files.",
    "Do not start workers.",
    "Do not continue into implementation.",
    "",
    "Mission to paraphrase:",
    pending.mission,
  ].join("\n");
}

function buildRejectedConfirmationPrompt(pending: CodexConfirmationGatePending): string {
  return [
    "Confirmation gate:",
    "",
    "Mark said no to the pending mission. Do not execute anything.",
    "Briefly ask him to correct the scope.",
    "",
    "Rejected pending mission:",
    pending.mission,
  ].join("\n");
}

function buildAmbiguousConfirmationPrompt(pending: CodexConfirmationGatePending): string {
  return [
    "Confirmation gate:",
    "",
    "The pending mission still needs a clear yes/no confirmation. Do not execute anything.",
    "Ask for a clear yes/no answer in one short sentence.",
    "",
    "Pending mission:",
    pending.mission,
  ].join("\n");
}
