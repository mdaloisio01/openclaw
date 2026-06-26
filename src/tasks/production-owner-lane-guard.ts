import fs from "node:fs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export const PRODUCTION_OWNER_LANE_BLOCKER_CODES = [
  "owner_lane_mismatch",
  "unresolved_owner_lane",
  "missing_controlling_build_plan",
  "missing_sop_owner_route",
  "will_self_perform_forbidden",
  "grant_self_perform_forbidden",
  "operator_override_required",
] as const;

export type ProductionOwnerLaneBlockerCode = (typeof PRODUCTION_OWNER_LANE_BLOCKER_CODES)[number];

export type ProductionOwnerLaneOverride = {
  explicitOperatorApproval?: boolean;
  targetWorkItem?: string;
  normalRequiredOwnerLane?: string;
  approvedAlternateExecutor?: string;
  reason?: string;
  scope?: string;
  expiresAt?: string;
  oneTimeUse?: boolean;
};

export type ProductionOwnerLaneGuardInput = {
  buildPlanRef?: string;
  buildItem?: string;
  requiredOwnerLane?: string;
  attemptedOwnerLane?: string;
  attemptedExecutor?: string;
  executorRole?: string;
  lawfulRouteRequired?: string;
  override?: ProductionOwnerLaneOverride;
};

export type ProductionOwnerLaneGuardBlock = {
  allowed: false;
  blockerCode: ProductionOwnerLaneBlockerCode;
  message: string;
  details: {
    buildPlanRef?: string;
    buildItem?: string;
    requiredOwnerLane?: string;
    attemptedOwnerLane?: string;
    attemptedExecutor?: string;
    executorRole?: string;
    lawfulRouteRequired?: string;
    operatorOverrideExists: boolean;
  };
};

export type ProductionOwnerLaneGuardAllow = {
  allowed: true;
  details: ProductionOwnerLaneGuardBlock["details"];
};

export type ProductionOwnerLaneGuardResult =
  | ProductionOwnerLaneGuardAllow
  | ProductionOwnerLaneGuardBlock;

function normalizeOwnerLane(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isWill(value: string | undefined): boolean {
  const normalized = normalizeOwnerLane(value);
  return (
    normalized === "will" ||
    normalized === "will_orchestrator" ||
    normalized === "will_top_level_governance"
  );
}

function isGrant(value: string | undefined): boolean {
  const normalized = normalizeOwnerLane(value);
  return (
    normalized === "grant" ||
    normalized === "grant_review" ||
    normalized === "grant_validation_support"
  );
}

function buildBlock(params: {
  code: ProductionOwnerLaneBlockerCode;
  detail: string;
  details: ProductionOwnerLaneGuardBlock["details"];
}): ProductionOwnerLaneGuardBlock {
  return {
    allowed: false,
    blockerCode: params.code,
    message: `${params.code}: ${params.detail}`,
    details: params.details,
  };
}

function hasValidOverride(input: ProductionOwnerLaneGuardInput): boolean {
  const override = input.override;
  if (!override?.explicitOperatorApproval) {
    return false;
  }
  const target = normalizeOptionalString(override.targetWorkItem);
  const item = normalizeOptionalString(input.buildItem);
  const required = normalizeOwnerLane(input.requiredOwnerLane);
  const overrideRequired = normalizeOwnerLane(override.normalRequiredOwnerLane);
  const attemptedExecutor = normalizeOwnerLane(input.attemptedExecutor);
  const attemptedOwner = normalizeOwnerLane(input.attemptedOwnerLane);
  const alternate = normalizeOwnerLane(override.approvedAlternateExecutor);
  if (!target || !item || target !== item) {
    return false;
  }
  if (!required || !overrideRequired || required !== overrideRequired) {
    return false;
  }
  if (!alternate || (alternate !== attemptedExecutor && alternate !== attemptedOwner)) {
    return false;
  }
  if (!normalizeOptionalString(override.reason) || !normalizeOptionalString(override.scope)) {
    return false;
  }
  if (!override.oneTimeUse && !normalizeOptionalString(override.expiresAt)) {
    return false;
  }
  return true;
}

export function evaluateProductionOwnerLaneGuard(
  input: ProductionOwnerLaneGuardInput,
): ProductionOwnerLaneGuardResult {
  const buildPlanRef = normalizeOptionalString(input.buildPlanRef);
  const buildItem = normalizeOptionalString(input.buildItem);
  const requiredOwnerLane = normalizeOptionalString(input.requiredOwnerLane);
  const attemptedOwnerLane = normalizeOptionalString(input.attemptedOwnerLane);
  const attemptedExecutor = normalizeOptionalString(input.attemptedExecutor);
  const executorRole = normalizeOptionalString(input.executorRole);
  const lawfulRouteRequired = normalizeOptionalString(input.lawfulRouteRequired);
  const operatorOverrideExists = hasValidOverride(input);
  const details = {
    ...(buildPlanRef ? { buildPlanRef } : {}),
    ...(buildItem ? { buildItem } : {}),
    ...(requiredOwnerLane ? { requiredOwnerLane } : {}),
    ...(attemptedOwnerLane ? { attemptedOwnerLane } : {}),
    ...(attemptedExecutor ? { attemptedExecutor } : {}),
    ...(executorRole ? { executorRole } : {}),
    ...(lawfulRouteRequired ? { lawfulRouteRequired } : {}),
    operatorOverrideExists,
  };

  if (!buildPlanRef || !fs.existsSync(buildPlanRef)) {
    return buildBlock({
      code: "missing_controlling_build_plan",
      detail: "production work requires an existing controlling build plan ref",
      details,
    });
  }
  if (!buildItem) {
    return buildBlock({
      code: "unresolved_owner_lane",
      detail: "current build-plan item is not identified",
      details,
    });
  }
  if (!requiredOwnerLane) {
    return buildBlock({
      code: "missing_sop_owner_route",
      detail: "SOP/build-plan required owner/lane is missing",
      details,
    });
  }
  if (!attemptedOwnerLane || !attemptedExecutor) {
    return buildBlock({
      code: "unresolved_owner_lane",
      detail: "attempted owner/lane and executor must both be identified",
      details,
    });
  }

  const required = normalizeOwnerLane(requiredOwnerLane);
  const attemptedOwner = normalizeOwnerLane(attemptedOwnerLane);
  const attempted = normalizeOwnerLane(attemptedExecutor);
  const executorMatches = required === attemptedOwner || required === attempted;
  if (executorMatches || operatorOverrideExists) {
    return { allowed: true, details };
  }

  if (isWill(attemptedOwnerLane) || isWill(attemptedExecutor)) {
    return buildBlock({
      code: "will_self_perform_forbidden",
      detail: "Will may orchestrate but may not self-perform work owned by another lane",
      details,
    });
  }
  if (isGrant(attemptedOwnerLane) || isGrant(attemptedExecutor)) {
    return buildBlock({
      code: "grant_self_perform_forbidden",
      detail: "Grant may not self-perform lane-owned work unless assigned or explicitly overridden",
      details,
    });
  }
  return buildBlock({
    code: "owner_lane_mismatch",
    detail: "attempted executor does not match the required SOP/build-plan owner/lane",
    details,
  });
}
