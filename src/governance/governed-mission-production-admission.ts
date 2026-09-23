import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stableStringify } from "../agents/stable-stringify.js";
import { readRegularFileSync } from "../infra/fs-safe.js";
import { findGovernedMissionReceiptByIdempotencyFromSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import type { JsonValue, TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { getTaskFlowById } from "../tasks/task-flow-runtime-internal.js";
import { ENFORCEMENT_HEALTH_CAPABILITIES } from "./enforcement-health.js";
import {
  normalizeGovernedArtifactDeclarations,
  type GovernedArtifactDeclaration,
} from "./governed-artifact-verifier.js";
import {
  missingGovernedContractFoundationFields,
  isGovernedProofProducers,
  type GovernedAuthorityRef,
  type GovernedMissionContract,
} from "./governed-mission-contract.js";
import {
  readCurrentGovernedRuntimeIdentity,
  readGovernedRuntimeIdentityFromArtifactPath,
  resolveGovernedAuthorityPath,
  type GovernedRuntimeIdentity,
} from "./governed-mission-identity.js";
import type { GovernedMissionLedgerReceipt } from "./governed-mission-ledger.types.js";
import {
  admitGovernedMissionToTaskFlow,
  applyGovernedMissionOperation,
  isGovernedMissionFlowClaimed,
  resolveGovernedMissionFlowForLookupToken,
} from "./governed-mission-runtime.js";
import { readGovernedMissionStateFromTaskFlow } from "./governed-mission-state.js";
import {
  MISSION_GATE_KINDS,
  type GateKind,
  type MissionManifest,
  type RequirementManifestItem,
} from "./mission-manifest.types.js";
import { compileMissionPlan, computeCompiledMissionPlanSha256 } from "./mission-plan-compiler.js";

export type { GovernedRuntimeIdentity } from "./governed-mission-identity.js";

export const GOVERNED_ARTIFACT_OUTPUT_DIRECTORY = path.join(".openclaw", "governed-artifacts");
const GOVERNED_MISSION_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

export function resolveGovernedArtifactOutputRoot(
  workspaceRoot: string,
  missionId: string,
): string | undefined {
  if (!path.isAbsolute(workspaceRoot) || !GOVERNED_MISSION_PATH_SEGMENT_RE.test(missionId)) {
    return undefined;
  }
  return path.join(path.resolve(workspaceRoot), GOVERNED_ARTIFACT_OUTPUT_DIRECTORY, missionId);
}

type GovernedProductionAdmissionPackage = {
  idempotencyKey: string;
  authorityRefId: string;
  contract: GovernedMissionContract;
  manifest: MissionManifest;
  requirements: Array<Omit<RequirementManifestItem, "gateIds">>;
  gateKinds: GateKind[];
  artifactDeclarations: GovernedArtifactDeclaration[];
  deliveryRequired?: boolean;
};

export type AdmitGovernedProductionFlowInput = {
  ownerKey: string;
  controllerId: string;
  goal: string;
  authorityPath: string;
  artifactRoot: string;
  currentStep?: string;
  stateJson?: JsonValue;
  governedMission: unknown;
  observedSkillSha256?: string;
  now?: number;
};

export type GovernedProductionAdmissionResult =
  | ReturnType<typeof admitGovernedMissionToTaskFlow>
  | { status: "invalid_package"; reasonCode: string };

export type ReadmitGovernedProductionFlowInput = {
  lookup: string;
  expectedRevision: number;
  idempotencyKey: string;
  authorityPath: string;
  artifactRoot: string;
  governedMission: unknown;
  observedSkillSha256?: string;
  now?: number;
};

type PreparedGovernedProductionPackage = {
  admissionPackage: GovernedProductionAdmissionPackage;
  authorityRef: GovernedAuthorityRef;
  authoritySha256: string;
  runtimeIdentity: GovernedRuntimeIdentity;
  observedSkillSha256: string;
  compiledPlan: ReturnType<typeof compileMissionPlan>;
  observedAt: string;
};

function productionRequestSha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableProductionStateJson(value: JsonValue | undefined): JsonValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { ownerLaneGuard: _ownerLaneGuard, ...requestFields } = value;
  return requestFields;
}

function receiptRequestSha256(receipt: GovernedMissionLedgerReceipt): string | undefined {
  const details = receipt.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const value = details.productionRequestSha256;
  return typeof value === "string" ? value : undefined;
}

function existingProductionAdmission(
  receipt: GovernedMissionLedgerReceipt,
  requestSha256: string,
): GovernedProductionAdmissionResult {
  if (receipt.operation !== "admitMission" || receiptRequestSha256(receipt) !== requestSha256) {
    return { status: "conflict", reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT" };
  }
  const flow = receipt.flowId ? getTaskFlowById(receipt.flowId) : undefined;
  return { status: "already_applied", ...(flow ? { flow } : {}), receipt };
}

function existingProductionReadmission(
  flow: TaskFlowRecord,
  receipt: GovernedMissionLedgerReceipt,
  requestSha256: string,
) {
  if (
    receipt.operation !== "requestReadmission" ||
    receipt.flowId !== flow.flowId ||
    receiptRequestSha256(receipt) !== requestSha256
  ) {
    return {
      status: "conflict" as const,
      flow,
      reasonCode: "IDEMPOTENCY_PAYLOAD_CONFLICT" as const,
    };
  }
  return { status: "already_applied" as const, flow, receipt };
}

function authorityAuthorizesPlan(body: Buffer, manifest: MissionManifest): boolean {
  let authority: unknown;
  try {
    authority = JSON.parse(body.toString("utf8"));
  } catch {
    return false;
  }
  if (
    !isStrictRecord(authority, [
      "schema",
      "planRevisionId",
      "planSha256",
      "scopeHash",
      "authorizedScopeHash",
      "planRevisionAuthorized",
    ]) ||
    authority.schema !== "openclaw.governed_authority_plan.v1"
  ) {
    return false;
  }
  return (
    authority.planRevisionId === manifest.planRevisionId &&
    authority.planSha256 === manifest.planSha256 &&
    authority.scopeHash === manifest.scopeHash &&
    authority.authorizedScopeHash === manifest.authorizedScopeHash &&
    authority.planRevisionAuthorized === true &&
    manifest.planRevisionAuthorized &&
    manifest.scopeHash === manifest.authorizedScopeHash
  );
}

/**
 * Trusted managed-flow creation boundary for governed production work.
 * Runtime and authority-file identity are measured here; callers cannot assert them as host facts.
 */
export function admitGovernedProductionFlow(
  input: AdmitGovernedProductionFlowInput,
  trustedRuntimeIdentity?: GovernedRuntimeIdentity,
): GovernedProductionAdmissionResult {
  const parsed = parseGovernedProductionAdmissionPackage(input.governedMission);
  if (!parsed.ok) {
    return { status: "invalid_package", reasonCode: parsed.reasonCode };
  }
  const requestSha256 = productionRequestSha256({
    operation: "admitMission",
    ownerKey: input.ownerKey,
    controllerId: input.controllerId,
    goal: input.goal,
    authorityPath: input.authorityPath,
    currentStep: input.currentStep,
    stateJson: stableProductionStateJson(input.stateJson),
    admissionPackage: parsed.value,
  });
  const previous = findGovernedMissionReceiptByIdempotencyFromSqlite({
    missionId: parsed.value.contract.missionId,
    idempotencyKey: parsed.value.idempotencyKey,
  });
  if (previous) {
    return existingProductionAdmission(previous, requestSha256);
  }
  const prepared = prepareGovernedProductionPackage({
    authorityPath: input.authorityPath,
    artifactRoot: input.artifactRoot,
    governedMission: input.governedMission,
    trustedRuntimeIdentity,
    observedSkillSha256: input.observedSkillSha256,
    now: input.now,
  });
  if (!prepared.ok) {
    return prepared.error;
  }
  const {
    admissionPackage,
    authorityRef,
    authoritySha256,
    runtimeIdentity,
    compiledPlan,
    observedAt,
  } = prepared.value;
  return admitGovernedMissionToTaskFlow({
    admission: {
      hookName: "before_agent_run",
      classification: "governed_required",
      actor: {
        actorId: input.controllerId,
        sessionKey: input.ownerKey,
        runId: `governed-admission:${admissionPackage.idempotencyKey}`,
      },
      contract: admissionPackage.contract,
      observedAuthority: {
        contractHash: admissionPackage.contract.contractHash,
        authorityHash: authoritySha256,
        authorityRef,
        planRevisionId: admissionPackage.contract.planRevisionId,
        sourceRevision: runtimeIdentity.sourceRevision,
        runtimeBuildSha256: runtimeIdentity.runtimeBuildSha256,
        policyVersion: admissionPackage.contract.policyVersion,
        skillSha256: prepared.value.observedSkillSha256,
      },
      enforcementCapabilities: ENFORCEMENT_HEALTH_CAPABILITIES.map((capability) => ({
        capability,
        state: "known_healthy" as const,
        observedAt,
      })),
      // This boundary runs only after Gateway operator-write and owner-lane authorization.
      hostAuthority: { openclawAllows: true, osAllows: true, hostAllows: true },
      now: observedAt,
    },
    idempotencyKey: admissionPackage.idempotencyKey,
    productionRequestSha256: requestSha256,
    ownerKey: input.ownerKey,
    controllerId: input.controllerId,
    goal: input.goal,
    currentStep: input.currentStep,
    stateJson: input.stateJson,
    continuation: { activeProductionRun: true, parentRunOpen: true },
    compiledPlan,
    artifactDeclarations: admissionPackage.artifactDeclarations,
    deliveryRequired: admissionPackage.deliveryRequired,
    createdAt: input.now,
  });
}

/** Replaces every drift-sensitive package component after the current runtime remeasures it. */
export function readmitGovernedProductionFlow(
  input: ReadmitGovernedProductionFlowInput,
  trustedRuntimeIdentity?: GovernedRuntimeIdentity,
) {
  const flow = resolveGovernedMissionFlowForLookupToken(input.lookup);
  if (!flow) {
    return { status: "not_found" as const };
  }
  const mission = readGovernedMissionStateFromTaskFlow(flow);
  if (!mission) {
    return {
      status: isGovernedMissionFlowClaimed(flow)
        ? ("untrusted_governed_state" as const)
        : ("not_governed" as const),
      flow,
    };
  }
  const parsed = parseGovernedProductionAdmissionPackage(input.governedMission);
  if (!parsed.ok) {
    return { status: "invalid_package" as const, reasonCode: parsed.reasonCode };
  }
  const requestSha256 = productionRequestSha256({
    operation: "requestReadmission",
    flowId: flow.flowId,
    expectedRevision: input.expectedRevision,
    authorityPath: input.authorityPath,
    admissionPackage: parsed.value,
  });
  const previous = findGovernedMissionReceiptByIdempotencyFromSqlite({
    missionId: mission.missionId,
    idempotencyKey: input.idempotencyKey,
  });
  if (previous) {
    return existingProductionReadmission(flow, previous, requestSha256);
  }
  const prepared = prepareGovernedProductionPackage({
    authorityPath: input.authorityPath,
    artifactRoot: input.artifactRoot,
    governedMission: input.governedMission,
    trustedRuntimeIdentity,
    observedSkillSha256: input.observedSkillSha256,
    now: input.now,
  });
  if (!prepared.ok) {
    return prepared.error;
  }
  const { admissionPackage, authorityRef, runtimeIdentity, compiledPlan, observedAt } =
    prepared.value;
  if (admissionPackage.contract.missionId !== mission.missionId) {
    return { status: "invalid_package" as const, reasonCode: "MISSION_ID_MISMATCH" };
  }
  return applyGovernedMissionOperation({
    flowId: flow.flowId,
    request: {
      operation: "requestReadmission",
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      productionRequestSha256: requestSha256,
      owner: mission.ownerCorrelation.owner,
      controllerId: flow.controllerId,
      bindings: {
        contractHash: mission.contractHash,
        authorityHash: mission.authorityHash,
        planRevisionId: mission.planRevisionId,
        sourceRevision: mission.sourceRevision,
        runtimeBuildSha256: mission.runtimeBuildSha256,
        policyVersion: mission.policyVersion,
        skillSha256: mission.skillSha256,
      },
      occurredAt: observedAt,
      replacementIdentity: {
        contractId: admissionPackage.contract.contractId,
        contractVersion: admissionPackage.contract.contractVersion,
        contractHash: admissionPackage.contract.contractHash,
        authorityHash: admissionPackage.contract.authorityHash,
        authorityRef,
        planRevisionId: admissionPackage.contract.planRevisionId,
        sourceRevision: runtimeIdentity.sourceRevision,
        runtimeBuildSha256: runtimeIdentity.runtimeBuildSha256,
        policyVersion: admissionPackage.contract.policyVersion,
        skillSha256: prepared.value.observedSkillSha256,
      },
      replacementContract: admissionPackage.contract,
      replacementCompiledPlan: compiledPlan,
      replacementArtifactDeclarations: admissionPackage.artifactDeclarations,
      replacementDeliveryRequired: admissionPackage.deliveryRequired === true,
    },
  });
}

function prepareGovernedProductionPackage(params: {
  authorityPath: string;
  artifactRoot: string;
  governedMission: unknown;
  trustedRuntimeIdentity?: GovernedRuntimeIdentity;
  observedSkillSha256?: string;
  now?: number;
}):
  | { ok: true; value: PreparedGovernedProductionPackage }
  | { ok: false; error: { status: "invalid_package"; reasonCode: string } } {
  const invalid = (reasonCode: string) => ({
    ok: false as const,
    error: { status: "invalid_package" as const, reasonCode },
  });
  const parsed = parseGovernedProductionAdmissionPackage(params.governedMission);
  if (!parsed.ok) {
    return invalid(parsed.reasonCode);
  }
  let canonicalWorkspaceRoot: string;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(params.artifactRoot);
  } catch {
    return invalid("ARTIFACT_OUTPUT_ROOT_INVALID");
  }
  const artifactRoot = resolveGovernedArtifactOutputRoot(
    canonicalWorkspaceRoot,
    parsed.value.contract.missionId,
  );
  if (!artifactRoot) {
    return invalid("ARTIFACT_OUTPUT_ROOT_INVALID");
  }
  if (
    parsed.value.artifactDeclarations.some(
      (declaration) => !isAbsoluteInside(artifactRoot, declaration.pathname),
    )
  ) {
    return invalid("ARTIFACT_OUTSIDE_OUTPUT_ROOT");
  }
  // Proof declarations never choose their read boundary. A per-mission output
  // directory prevents operator-supplied checks from becoming workspace file oracles.
  const admissionPackage = {
    ...parsed.value,
    artifactDeclarations: parsed.value.artifactDeclarations.map((declaration) =>
      Object.assign({}, declaration, { allowedRoot: artifactRoot }),
    ),
  };
  const authorityRef = admissionPackage.contract.authorityRefs.find(
    (candidate) => candidate.refId === admissionPackage.authorityRefId,
  );
  if (!authorityRef) {
    return invalid("AUTHORITY_REFERENCE_NOT_FOUND");
  }
  let authorityPath: string;
  try {
    authorityPath = resolveGovernedAuthorityPath(authorityRef.uri);
  } catch {
    return invalid("AUTHORITY_PATH_INVALID");
  }
  if (authorityPath !== path.resolve(params.authorityPath)) {
    return invalid("PRODUCTION_AUTHORITY_MISMATCH");
  }
  if (admissionPackage.contract.mode !== "enforce") {
    return invalid("GOVERNED_ENFORCEMENT_MODE_REQUIRED");
  }
  let authorityBody: Buffer;
  try {
    authorityBody = readRegularFileSync({
      filePath: authorityPath,
      maxBytes: 10 * 1024 * 1024,
    }).buffer;
  } catch {
    return invalid("AUTHORITY_FILE_HASH_MISMATCH");
  }
  const authoritySha256 = createHash("sha256").update(authorityBody).digest("hex");
  if (
    authorityRef.sha256 !== authoritySha256 ||
    admissionPackage.contract.authorityHash !== authoritySha256
  ) {
    return invalid("AUTHORITY_FILE_HASH_MISMATCH");
  }
  const compiledPlan = compileMissionPlan({
    manifest: admissionPackage.manifest,
    requirements: admissionPackage.requirements,
    gateKinds: admissionPackage.gateKinds,
  });
  if (admissionPackage.manifest.planSha256 !== computeCompiledMissionPlanSha256(compiledPlan)) {
    return invalid("PLAN_DIGEST_MISMATCH");
  }
  // Authorization must come from the measured host file, not request fields that
  // an operator.write client can pair with unrelated authority bytes.
  if (!authorityAuthorizesPlan(authorityBody, admissionPackage.manifest)) {
    return invalid("PLAN_AUTHORITY_MISMATCH");
  }
  const runtimeIdentity = params.trustedRuntimeIdentity ?? readCurrentGovernedRuntimeIdentity();
  if (!runtimeIdentity) {
    return invalid("RUNTIME_BUILD_IDENTITY_UNAVAILABLE");
  }
  if (admissionPackage.contract.sourceRevision !== runtimeIdentity.sourceRevision) {
    return invalid("SOURCE_REVISION_MISMATCH");
  }
  if (admissionPackage.contract.runtimeBuildSha256 !== runtimeIdentity.runtimeBuildSha256) {
    return invalid("RUNTIME_BUILD_MISMATCH");
  }
  if (!params.observedSkillSha256) {
    return invalid("SKILL_IDENTITY_UNAVAILABLE");
  }
  if (admissionPackage.contract.skillSha256 !== params.observedSkillSha256) {
    return invalid("SKILL_HASH_MISMATCH");
  }
  if (admissionPackage.manifest.mode !== admissionPackage.contract.mode) {
    return invalid("MANIFEST_MODE_MISMATCH");
  }
  return {
    ok: true,
    value: {
      admissionPackage,
      authorityRef,
      authoritySha256,
      runtimeIdentity,
      observedSkillSha256: params.observedSkillSha256,
      compiledPlan,
      observedAt: new Date(params.now ?? Date.now()).toISOString(),
    },
  };
}

function isAbsoluteInside(root: string, candidate: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) {
    return false;
  }
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function parseGovernedProductionAdmissionPackage(
  value: unknown,
): { ok: true; value: GovernedProductionAdmissionPackage } | { ok: false; reasonCode: string } {
  if (
    !isStrictRecord(value, [
      "idempotencyKey",
      "authorityRefId",
      "contract",
      "manifest",
      "requirements",
      "gateKinds",
      "artifactDeclarations",
      "deliveryRequired",
    ])
  ) {
    return { ok: false, reasonCode: "GOVERNED_PACKAGE_SHAPE_INVALID" };
  }
  const idempotencyKey = boundedString(value.idempotencyKey, 256);
  const authorityRefId = boundedString(value.authorityRefId, 256);
  const contract = parseContract(value.contract);
  const manifest = parseManifest(value.manifest);
  const requirements = parseRequirements(value.requirements);
  const gateKinds = parseGateKinds(value.gateKinds);
  const artifactDeclarations = normalizeGovernedArtifactDeclarations(value.artifactDeclarations);
  if (
    !idempotencyKey ||
    !authorityRefId ||
    !contract ||
    !manifest ||
    !requirements ||
    !gateKinds ||
    !artifactDeclarations ||
    (value.deliveryRequired !== undefined && typeof value.deliveryRequired !== "boolean")
  ) {
    return { ok: false, reasonCode: "GOVERNED_PACKAGE_VALUE_INVALID" };
  }
  return {
    ok: true,
    value: {
      idempotencyKey,
      authorityRefId,
      contract,
      manifest,
      requirements,
      gateKinds,
      artifactDeclarations,
      ...(value.deliveryRequired === true ? { deliveryRequired: true } : {}),
    },
  };
}

function parseContract(value: unknown): GovernedMissionContract | null {
  if (
    !isStrictRecord(value, [
      "schema",
      "missionId",
      "contractId",
      "contractVersion",
      "contractHash",
      "authorityHash",
      "authorityRefs",
      "admissionReceiptRef",
      "planRevisionId",
      "sourceRevision",
      "runtimeBuildSha256",
      "policyVersion",
      "skillSha256",
      "mode",
      "authoritativeCompletionOwner",
      "requiredReceiptKinds",
      "proofProducers",
      "createdAt",
    ]) ||
    !Array.isArray(value.authorityRefs) ||
    value.authorityRefs.some(
      (candidate) => !isStrictRecord(candidate, ["refId", "kind", "uri", "sha256"]),
    ) ||
    !Array.isArray(value.requiredReceiptKinds) ||
    !isGovernedProofProducers(value.proofProducers)
  ) {
    return null;
  }
  const contract = value as unknown as GovernedMissionContract;
  return missingGovernedContractFoundationFields(contract).length === 0 ? contract : null;
}

function parseManifest(value: unknown): MissionManifest | null {
  if (
    !isStrictRecord(value, [
      "schema",
      "missionId",
      "planRevisionId",
      "planSha256",
      "sourceRevision",
      "runtimeBuildSha256",
      "policyVersion",
      "skillSha256",
      "packageId",
      "mode",
      "scopeHash",
      "authorizedScopeHash",
      "planRevisionAuthorized",
      "createdAt",
    ])
  ) {
    return null;
  }
  const requiredStrings = [
    "missionId",
    "planRevisionId",
    "planSha256",
    "sourceRevision",
    "runtimeBuildSha256",
    "policyVersion",
    "skillSha256",
    "scopeHash",
    "authorizedScopeHash",
    "createdAt",
  ] as const;
  if (
    value.schema !== "openclaw.mission_manifest.v1" ||
    requiredStrings.some((field) => !boundedString(value[field], 4096)) ||
    (value.packageId !== undefined && !boundedString(value.packageId, 4096)) ||
    !["shadow", "enforce", "off"].includes(String(value.mode)) ||
    typeof value.planRevisionAuthorized !== "boolean"
  ) {
    return null;
  }
  return value as unknown as MissionManifest;
}

function parseRequirements(value: unknown): Array<Omit<RequirementManifestItem, "gateIds">> | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
    return null;
  }
  const requirements: Array<Omit<RequirementManifestItem, "gateIds">> = [];
  for (const candidate of value) {
    if (!isStrictRecord(candidate, ["id", "text", "required", "dependsOn"])) {
      return null;
    }
    const id = boundedString(candidate.id, 256);
    const text = boundedString(candidate.text, 4096);
    const dependsOn = candidate.dependsOn;
    if (
      !id ||
      !text ||
      typeof candidate.required !== "boolean" ||
      (dependsOn !== undefined &&
        (!Array.isArray(dependsOn) ||
          dependsOn.some((dependency) => !boundedString(dependency, 256))))
    ) {
      return null;
    }
    requirements.push({
      id,
      text,
      required: candidate.required,
      ...(Array.isArray(dependsOn) ? { dependsOn: dependsOn as string[] } : {}),
    });
  }
  return new Set(requirements.map((requirement) => requirement.id)).size === requirements.length
    ? requirements
    : null;
}

function parseGateKinds(value: unknown): GateKind[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const kinds = value.filter(
    (kind): kind is GateKind =>
      typeof kind === "string" && (MISSION_GATE_KINDS as readonly string[]).includes(kind),
  );
  return kinds.length === value.length && new Set(kinds).size === kinds.length ? kinds : null;
}

export const testing = {
  readRuntimeIdentityFromArtifactPath: readGovernedRuntimeIdentityFromArtifactPath,
  isAbsoluteInside,
};

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function isStrictRecord(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key)),
  );
}
