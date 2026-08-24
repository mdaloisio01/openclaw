import type { GovernedPolicyDecisionOutput } from "./governed-policy-decision.js";

export const PROTECTED_ACTION_AUTHORITY_SOURCES = [
  "trusted_host_policy",
  "exec_policy",
  "approval_policy",
  "protected_surface_policy",
  "project_authority_policy",
] as const;

export type ProtectedActionAuthoritySource = (typeof PROTECTED_ACTION_AUTHORITY_SOURCES)[number];

export const PROTECTED_ACTION_CLASSES = [
  "production_source_mutation",
  "openclaw_config_mutation",
  "plugin_mutation",
  "sop_governance_authority_mutation",
  "task_flow_cleanup_crew_mutation",
  "watchdog_control_plane_mutation",
  "service_restart",
  "deployment",
  "destructive_filesystem_action",
  "protected_database_mutation",
  "protected_exec_script",
  "child_execution_delegation",
  "release_gate_change",
  "credential_secret_mutation",
  "external_side_effect",
  "project_defined_high_authority",
] as const;

export type ProtectedActionClass = (typeof PROTECTED_ACTION_CLASSES)[number];

export type ProtectedActionInventoryRecord = {
  actionClass: ProtectedActionClass;
  authoritySources: ProtectedActionAuthoritySource[];
  description: string;
};

export const PROTECTED_ACTION_INVENTORY: readonly ProtectedActionInventoryRecord[] = [
  {
    actionClass: "production_source_mutation",
    authoritySources: ["protected_surface_policy", "project_authority_policy"],
    description: "source or production repository writes",
  },
  {
    actionClass: "openclaw_config_mutation",
    authoritySources: ["protected_surface_policy", "project_authority_policy"],
    description: "OpenClaw runtime, workspace, or operator configuration writes",
  },
  {
    actionClass: "plugin_mutation",
    authoritySources: ["approval_policy", "protected_surface_policy"],
    description: "plugin install, uninstall, permission, or runtime registration writes",
  },
  {
    actionClass: "sop_governance_authority_mutation",
    authoritySources: ["protected_surface_policy", "project_authority_policy"],
    description: "SOP, governance, policy, authority, or release-rule writes",
  },
  {
    actionClass: "task_flow_cleanup_crew_mutation",
    authoritySources: ["protected_surface_policy", "project_authority_policy"],
    description: "Task Flow, Task Registry, Cleanup Crew, or mission-state mutation",
  },
  {
    actionClass: "watchdog_control_plane_mutation",
    authoritySources: ["protected_surface_policy", "project_authority_policy"],
    description: "watchdog, cron, controller, or control-plane mutation",
  },
  {
    actionClass: "service_restart",
    authoritySources: ["trusted_host_policy", "approval_policy", "project_authority_policy"],
    description: "service restart, reload, or runtime process replacement",
  },
  {
    actionClass: "deployment",
    authoritySources: ["approval_policy", "project_authority_policy"],
    description: "deployment, publish, rollout, or production exposure changes",
  },
  {
    actionClass: "destructive_filesystem_action",
    authoritySources: ["exec_policy", "approval_policy", "trusted_host_policy"],
    description: "delete, clean, reset, overwrite, or destructive filesystem operations",
  },
  {
    actionClass: "protected_database_mutation",
    authoritySources: ["protected_surface_policy", "project_authority_policy"],
    description: "database repair, migration, direct SQL mutation, or state-store write",
  },
  {
    actionClass: "protected_exec_script",
    authoritySources: ["exec_policy", "trusted_host_policy", "approval_policy"],
    description: "exec, shell, script, interpreter, or elevated command operation",
  },
  {
    actionClass: "child_execution_delegation",
    authoritySources: ["protected_surface_policy", "project_authority_policy"],
    description: "subagent, ACP, Task Flow, background, worker, or delegated child execution",
  },
  {
    actionClass: "release_gate_change",
    authoritySources: ["protected_surface_policy", "project_authority_policy"],
    description: "closeout, release, approval, or final-output gate mutation",
  },
  {
    actionClass: "credential_secret_mutation",
    authoritySources: ["approval_policy", "protected_surface_policy"],
    description: "credential, token, secret, OAuth, or provider-auth mutation",
  },
  {
    actionClass: "external_side_effect",
    authoritySources: ["approval_policy", "project_authority_policy"],
    description: "external message, API, purchase, public action, or third-party side effect",
  },
  {
    actionClass: "project_defined_high_authority",
    authoritySources: ["project_authority_policy"],
    description: "project-specific high-authority action declared by policy",
  },
];

export type ProtectedActionSignals = {
  toolName?: string;
  targetPath?: string;
  gatewayMethod?: string;
  command?: string;
  commandInterpreter?: boolean;
  elevatedMode?: boolean;
  supervisorWrapperRequired?: boolean;
  supervisorWrapperPresent?: boolean;
  childDelegation?: boolean;
  childRuntime?: string;
  externalSideEffect?: boolean;
  projectDefinedHighAuthority?: boolean;
};

export type TrustedHostPolicy = {
  trustedHost: boolean;
  openclawAllows: boolean;
  osAllows: boolean;
  hostAllows: boolean;
  reason?: string;
};

export type GovernedAuthorityForProtectedAction = {
  governedMissionAdmitted: boolean;
  contractValid: boolean;
  sourceLockValid: boolean;
  policyDecision?: GovernedPolicyDecisionOutput;
};

export type ProtectedActionEvaluationInput = {
  actionId: string;
  actionClass?: ProtectedActionClass;
  signals?: ProtectedActionSignals;
  conversationClassification: "ordinary" | "governed" | "ambiguous";
  governedAuthority?: GovernedAuthorityForProtectedAction;
  trustedHostPolicy: TrustedHostPolicy;
  now: string;
};

export type ProtectedActionDecision = {
  schema: "openclaw.protected_action_decision.v1";
  actionId: string;
  protected: boolean;
  actionClass?: ProtectedActionClass;
  decision: "ALLOW" | "DENY";
  reasonCode:
    | "UNPROTECTED_ACTION"
    | "PROTECTED_ACTION_ALLOWED"
    | "MISSING_GOVERNED_AUTHORITY"
    | "TRUSTED_HOST_POLICY_DENIED";
  obligations: string[];
  evaluatedAt: string;
};

const GOVERNANCE_PATH_RE = /^src\/governance\//u;
const SOURCE_PATH_RE = /^(src|extensions|packages|scripts|ui|docs)\//u;
const CONFIG_PATH_RE = /(^|\/)(openclaw\.json|config\.toml|\.codex\/|\.openclaw\/)/u;
const TASK_PATH_RE = /^(src\/tasks|\.openclaw\/tasks|\.openclaw\/flows)\//u;
const WATCHDOG_PATH_RE = /(watchdog|control-plane|cleanup-watchdog|cron)/u;
const CREDENTIAL_PATH_RE = /(credential|credentials|secret|secrets|oauth|token)/u;
const RELEASE_PATH_RE = /(closeout|release|final-output|approval|gate)/u;
const DEPLOY_PATH_RE = /(^|\/)(deploy|fly\.toml|render\.yaml|Dockerfile|docker-compose\.yml)/u;
const DESTRUCTIVE_COMMAND_RE = /\b(rm|trash|unlink|rmdir|git\s+reset|git\s+clean|dd|mkfs)\b/u;
const RESTART_COMMAND_RE =
  /\b(systemctl\s+(restart|reload)|service\s+\S+\s+(restart|reload)|openclaw\s+restart)\b/u;
const INTERPRETER_COMMAND_RE =
  /(^|\s)(bash|sh|zsh|fish|python3?|node|tsx|ts-node|ruby|perl|php)(\s|$)/u;
const EXEC_TOOL_RE = /(^|\.)(exec|exec_command|shell|terminal|apply_patch)$/u;

export function classifyProtectedAction(
  signals: ProtectedActionSignals,
): ProtectedActionClass | undefined {
  const method = signals.gatewayMethod ?? "";
  const toolName = signals.toolName ?? "";
  const targetPath = normalizePath(signals.targetPath ?? "");
  const command = signals.command ?? "";

  if (signals.projectDefinedHighAuthority) {
    return "project_defined_high_authority";
  }
  if (signals.externalSideEffect) {
    return "external_side_effect";
  }
  if (signals.childDelegation) {
    return "child_execution_delegation";
  }
  if (RESTART_COMMAND_RE.test(command) || method.includes("restart")) {
    return "service_restart";
  }
  if (DESTRUCTIVE_COMMAND_RE.test(command)) {
    return "destructive_filesystem_action";
  }
  if (
    signals.elevatedMode ||
    signals.commandInterpreter ||
    EXEC_TOOL_RE.test(toolName) ||
    INTERPRETER_COMMAND_RE.test(command) ||
    command.trim()
  ) {
    return "protected_exec_script";
  }
  if (method.startsWith("plugin.") || targetPath.includes("/plugins/")) {
    return "plugin_mutation";
  }
  if (method.startsWith("config.") || CONFIG_PATH_RE.test(targetPath)) {
    return "openclaw_config_mutation";
  }
  if (method.startsWith("task.") || TASK_PATH_RE.test(targetPath)) {
    return "task_flow_cleanup_crew_mutation";
  }
  if (
    method.startsWith("cron.") ||
    WATCHDOG_PATH_RE.test(targetPath) ||
    WATCHDOG_PATH_RE.test(method)
  ) {
    return "watchdog_control_plane_mutation";
  }
  if (CREDENTIAL_PATH_RE.test(targetPath) || CREDENTIAL_PATH_RE.test(method)) {
    return "credential_secret_mutation";
  }
  if (RELEASE_PATH_RE.test(targetPath) || RELEASE_PATH_RE.test(method)) {
    return "release_gate_change";
  }
  if (
    method.startsWith("database.") ||
    targetPath.endsWith(".sqlite") ||
    targetPath.includes("/db/")
  ) {
    return "protected_database_mutation";
  }
  if (DEPLOY_PATH_RE.test(targetPath) || method.includes("deploy")) {
    return "deployment";
  }
  if (GOVERNANCE_PATH_RE.test(targetPath)) {
    return "sop_governance_authority_mutation";
  }
  if (SOURCE_PATH_RE.test(targetPath)) {
    return "production_source_mutation";
  }
  return undefined;
}

export function evaluateProtectedAction(
  input: ProtectedActionEvaluationInput,
): ProtectedActionDecision {
  const actionClass = input.actionClass ?? classifyProtectedAction(input.signals ?? {});
  if (!actionClass) {
    return {
      schema: "openclaw.protected_action_decision.v1",
      actionId: input.actionId,
      protected: false,
      decision: "ALLOW",
      reasonCode: "UNPROTECTED_ACTION",
      obligations: [],
      evaluatedAt: input.now,
    };
  }

  if (!trustedHostAllows(input.trustedHostPolicy)) {
    return deny(input, actionClass, "TRUSTED_HOST_POLICY_DENIED", [
      "do_not_execute",
      "repair_or_verify_trusted_host_policy",
    ]);
  }

  if (!hasValidGovernedAuthority(input.governedAuthority)) {
    return deny(input, actionClass, "MISSING_GOVERNED_AUTHORITY", [
      "invoke_governed_authority_check",
      "require_valid_governed_mission",
      "write_violation_receipt",
    ]);
  }

  return {
    schema: "openclaw.protected_action_decision.v1",
    actionId: input.actionId,
    protected: true,
    actionClass,
    decision: "ALLOW",
    reasonCode: "PROTECTED_ACTION_ALLOWED",
    obligations: ["write_policy_decision_receipt"],
    evaluatedAt: input.now,
  };
}

export function protectedActionInventoryByClass(
  actionClass: ProtectedActionClass,
): ProtectedActionInventoryRecord {
  const record = PROTECTED_ACTION_INVENTORY.find((entry) => entry.actionClass === actionClass);
  if (!record) {
    throw new Error(`Unknown protected action class: ${actionClass}`);
  }
  return record;
}

function hasValidGovernedAuthority(
  authority: GovernedAuthorityForProtectedAction | undefined,
): boolean {
  return (
    authority?.governedMissionAdmitted === true &&
    authority.contractValid === true &&
    authority.sourceLockValid === true &&
    authority.policyDecision?.decision === "ALLOW"
  );
}

function trustedHostAllows(policy: TrustedHostPolicy): boolean {
  return policy.trustedHost && policy.openclawAllows && policy.osAllows && policy.hostAllows;
}

function deny(
  input: ProtectedActionEvaluationInput,
  actionClass: ProtectedActionClass,
  reasonCode: "MISSING_GOVERNED_AUTHORITY" | "TRUSTED_HOST_POLICY_DENIED",
  obligations: string[],
): ProtectedActionDecision {
  return {
    schema: "openclaw.protected_action_decision.v1",
    actionId: input.actionId,
    protected: true,
    actionClass,
    decision: "DENY",
    reasonCode,
    obligations,
    evaluatedAt: input.now,
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}
