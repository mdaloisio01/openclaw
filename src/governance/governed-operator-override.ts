import type { GovernedAuthorityRef, OverrideReceipt } from "./governed-mission-contract.js";

export const GOVERNED_OPERATOR_OVERRIDE_ALLOWED_CLASSES = [
  "mission_policy_exception",
  "tool_action_exception",
  "exec_action_exception",
  "child_delegation_exception",
  "closeout_repair_exception",
] as const;

export type GovernedOperatorOverrideAllowedClass =
  (typeof GOVERNED_OPERATOR_OVERRIDE_ALLOWED_CLASSES)[number];

export const GOVERNED_OPERATOR_OVERRIDE_PROHIBITED_CLASSES = [
  "expand_os_authority",
  "expand_openclaw_host_authority",
  "bypass_sandbox_boundary",
  "bypass_source_or_runtime_lock",
  "bypass_required_closeout",
  "bypass_release_gate",
] as const;

export type GovernedOperatorOverrideProhibitedClass =
  (typeof GOVERNED_OPERATOR_OVERRIDE_PROHIBITED_CLASSES)[number];

export const GOVERNED_OPERATOR_OVERRIDE_STATUSES = [
  "active",
  "revoked",
  "expired",
  "used",
  "denied",
] as const;

export type GovernedOperatorOverrideStatus = (typeof GOVERNED_OPERATOR_OVERRIDE_STATUSES)[number];

export type GovernedOperatorOverrideReuse = {
  mode: "one_use" | "reusable";
  maxUses?: number;
  useCount: number;
};

export type GovernedOperatorOverrideScope = {
  missionId: string;
  actionId?: string;
  scopeHash: string;
};

export type GovernedOperatorOverrideRecord = {
  schema: "openclaw.governed_operator_override.v1";
  overrideId: string;
  operatorAuthority: GovernedAuthorityRef;
  target: GovernedOperatorOverrideScope;
  reason: string;
  expiresAt: string;
  reuse: GovernedOperatorOverrideReuse;
  receiptRef: string;
  receipt?: OverrideReceipt;
  allowableClasses: readonly GovernedOperatorOverrideAllowedClass[];
  prohibitedClasses: readonly GovernedOperatorOverrideProhibitedClass[];
  revocationStatus: GovernedOperatorOverrideStatus;
  cannotExpandBeyondHostAuthority: true;
  createdAt: string;
};

export type GovernedOverrideHostAuthority = {
  openclawAllows: boolean;
  osAllows: boolean;
  hostAllows: boolean;
};

export type GovernedOperatorOverrideEvaluationContext = {
  missionId: string;
  actionId?: string;
  scopeHash: string;
  requestedClass: GovernedOperatorOverrideAllowedClass | GovernedOperatorOverrideProhibitedClass;
  hostAuthority: GovernedOverrideHostAuthority;
  now: string;
};

export type GovernedOperatorOverrideDecision =
  | {
      valid: true;
      overrideId: string;
      class: GovernedOperatorOverrideAllowedClass;
      receiptRef: string;
    }
  | {
      valid: false;
      overrideId?: string;
      reason:
        | "missing_override"
        | "missing_expiration"
        | "invalid_expiration"
        | "revoked_or_not_active"
        | "expired"
        | "reuse_exhausted"
        | "target_mismatch"
        | "scope_mismatch"
        | "class_not_allowed"
        | "class_prohibited"
        | "host_authority_denied";
    };

export function missingGovernedOperatorOverrideFields(
  record: Partial<GovernedOperatorOverrideRecord>,
): string[] {
  const missing: string[] = [];
  const requiredStrings: Array<keyof GovernedOperatorOverrideRecord> = [
    "overrideId",
    "reason",
    "expiresAt",
    "receiptRef",
    "createdAt",
  ];
  for (const field of requiredStrings) {
    if (!record[field]) {
      missing.push(field);
    }
  }
  if (!record.operatorAuthority) {
    missing.push("operatorAuthority");
  }
  if (!record.target?.missionId) {
    missing.push("target.missionId");
  }
  if (!record.target?.scopeHash) {
    missing.push("target.scopeHash");
  }
  if (!record.reuse) {
    missing.push("reuse");
  }
  if (!record.allowableClasses?.length) {
    missing.push("allowableClasses");
  }
  if (!record.prohibitedClasses?.length) {
    missing.push("prohibitedClasses");
  }
  if (!record.revocationStatus) {
    missing.push("revocationStatus");
  }
  if (record.cannotExpandBeyondHostAuthority !== true) {
    missing.push("cannotExpandBeyondHostAuthority");
  }
  return missing;
}

export function evaluateGovernedOperatorOverride(
  override: GovernedOperatorOverrideRecord | undefined,
  context: GovernedOperatorOverrideEvaluationContext,
): GovernedOperatorOverrideDecision {
  if (!override) {
    return { valid: false, reason: "missing_override" };
  }
  if (override.revocationStatus !== "active") {
    return { valid: false, overrideId: override.overrideId, reason: "revoked_or_not_active" };
  }
  if (!override.expiresAt) {
    return { valid: false, overrideId: override.overrideId, reason: "missing_expiration" };
  }
  if (!isStrictUtcIsoTimestamp(override.expiresAt) || !isStrictUtcIsoTimestamp(context.now)) {
    return { valid: false, overrideId: override.overrideId, reason: "invalid_expiration" };
  }
  const expirationMs = Date.parse(override.expiresAt);
  const nowMs = Date.parse(context.now);
  if (expirationMs <= nowMs) {
    return { valid: false, overrideId: override.overrideId, reason: "expired" };
  }
  if (reuseExhausted(override.reuse)) {
    return { valid: false, overrideId: override.overrideId, reason: "reuse_exhausted" };
  }
  if (
    override.target.missionId !== context.missionId ||
    override.target.actionId !== context.actionId
  ) {
    return { valid: false, overrideId: override.overrideId, reason: "target_mismatch" };
  }
  if (override.target.scopeHash !== context.scopeHash) {
    return { valid: false, overrideId: override.overrideId, reason: "scope_mismatch" };
  }
  if (
    override.prohibitedClasses.includes(
      context.requestedClass as GovernedOperatorOverrideProhibitedClass,
    )
  ) {
    return { valid: false, overrideId: override.overrideId, reason: "class_prohibited" };
  }
  if (
    !override.allowableClasses.includes(
      context.requestedClass as GovernedOperatorOverrideAllowedClass,
    )
  ) {
    return { valid: false, overrideId: override.overrideId, reason: "class_not_allowed" };
  }
  if (!hostAuthorityAllows(context.hostAuthority)) {
    return { valid: false, overrideId: override.overrideId, reason: "host_authority_denied" };
  }
  return {
    valid: true,
    overrideId: override.overrideId,
    class: context.requestedClass as GovernedOperatorOverrideAllowedClass,
    receiptRef: override.receiptRef,
  };
}

function reuseExhausted(reuse: GovernedOperatorOverrideReuse): boolean {
  if (reuse.mode === "one_use") {
    return reuse.useCount > 0;
  }
  return typeof reuse.maxUses === "number" && reuse.useCount >= reuse.maxUses;
}

function hostAuthorityAllows(authority: GovernedOverrideHostAuthority): boolean {
  return authority.openclawAllows && authority.osAllows && authority.hostAllows;
}

function isStrictUtcIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString() === normalizeIsoMilliseconds(value)
  );
}

function normalizeIsoMilliseconds(value: string): string {
  return value.includes(".") ? value : value.replace("Z", ".000Z");
}
