import { createHash } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";

export const SOP_ARTIFACT_ROLES = [
  "build_plan",
  "build_state_interpretation",
  "issue_status",
  "closeout",
  "runtime_proof",
  "watchdog_proof",
  "readiness_report",
  "registry",
  "export",
  "research",
] as const;

export type SopArtifactRole = (typeof SOP_ARTIFACT_ROLES)[number];
export type SopArtifactClass =
  | "current"
  | "support"
  | "partially_stale"
  | "stale"
  | "superseded"
  | "archive_only";

const artifactSchema = z.object({
  id: z.string().trim().min(1),
  role: z.enum(SOP_ARTIFACT_ROLES),
  scope: z.string().trim().min(1),
  issuedAt: z.iso.datetime({ offset: true }),
  key: z.string().trim().min(1).optional(),
  sourceRevision: z.string().trim().min(1).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  supersedes: z.array(z.string().trim().min(1)).default([]),
  proofPaths: z.array(z.string().trim().min(1)).default([]),
  proofBindings: z
    .array(
      z.object({
        path: z.string().trim().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        artifactId: z.string().trim().min(1),
        role: z.enum(SOP_ARTIFACT_ROLES),
        scope: z.string().trim().min(1),
        sourceRevision: z.string().trim().min(1).optional(),
      }),
    )
    .default([]),
  coverage: z.array(z.string().trim().min(1)).optional(),
  bounded: z.boolean().default(false),
});
export type SopArtifact = z.infer<typeof artifactSchema>;

const contextSchema = z.object({
  activeScope: z.string().trim().min(1),
  activeRevision: z.string().trim().min(1),
  now: z.iso.datetime({ offset: true }),
  activePlanId: z.string().trim().min(1).optional(),
  requiredWatchdogCoverage: z.array(z.string().trim().min(1)).default([]),
});
export type SopCurrentTruthContext = z.input<typeof contextSchema>;

export type SopArtifactClassification = {
  artifact: SopArtifact;
  classification: SopArtifactClass;
  reason: string;
  canRoute: boolean;
  safeReadings: string[];
  unsafeReadings: string[];
};

function hashProofFile(proofPath: string): string | undefined {
  let fd: number | undefined;
  try {
    if (!fs.lstatSync(proofPath).isFile()) {
      return undefined;
    }
    fd = fs.openSync(proofPath, "r");
    if (fs.fstatSync(fd).size === 0) {
      return undefined;
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (
      let count = fs.readSync(fd, buffer, 0, buffer.length, null);
      count > 0;
      count = fs.readSync(fd, buffer, 0, buffer.length, null)
    ) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

const proofRequired = new Set<SopArtifactRole>([
  "build_state_interpretation",
  "closeout",
  "runtime_proof",
  "watchdog_proof",
  "readiness_report",
  "registry",
  "export",
]);
const revisionRequired = new Set<SopArtifactRole>([
  "build_state_interpretation",
  "closeout",
  "runtime_proof",
  "watchdog_proof",
  "readiness_report",
  "registry",
  "export",
]);

export function resolveSopCurrentTruth(
  input: readonly unknown[],
  rawContext: SopCurrentTruthContext,
): SopArtifactClassification[] {
  const context = contextSchema.parse(rawContext);
  const artifacts = input.map((value) => artifactSchema.parse(value));
  if (
    artifacts.some(
      (artifact) => artifact.role === "build_plan" && artifact.scope === context.activeScope,
    ) &&
    !context.activePlanId
  ) {
    throw new Error("active SOP build plan identity is required");
  }
  for (const artifact of artifacts) {
    if (artifact.role === "issue_status" && !artifact.key) {
      throw new Error(`SOP issue status lacks exact issue identity: ${artifact.id}`);
    }
    if (artifact.role === "readiness_report" && !artifact.expiresAt) {
      throw new Error(`SOP readiness report lacks recurrence deadline: ${artifact.id}`);
    }
  }
  const byId = new Map<string, SopArtifact>();
  for (const artifact of artifacts) {
    if (byId.has(artifact.id)) {
      throw new Error(`duplicate SOP artifact identity: ${artifact.id}`);
    }
    byId.set(artifact.id, artifact);
  }
  const activePlan = context.activePlanId ? byId.get(context.activePlanId) : undefined;
  if (
    context.activePlanId &&
    (!activePlan || activePlan.role !== "build_plan" || activePlan.scope !== context.activeScope)
  ) {
    throw new Error("active SOP build plan is missing from current-truth inputs");
  }
  const nowMs = Date.parse(context.now);
  const proofVerified = new Map(
    artifacts.map((artifact) => [
      artifact.id,
      artifact.proofPaths.length > 0 &&
        artifact.proofBindings.length === artifact.proofPaths.length &&
        artifact.proofPaths.every((proofPath) => {
          const matching = artifact.proofBindings.filter((binding) => binding.path === proofPath);
          const binding = matching[0];
          return (
            matching.length === 1 &&
            binding.artifactId === artifact.id &&
            binding.role === artifact.role &&
            binding.scope === artifact.scope &&
            binding.sourceRevision === artifact.sourceRevision &&
            hashProofFile(proofPath) === binding.sha256
          );
        }),
    ]),
  );
  const eligibleForRouting = (artifact: SopArtifact): boolean =>
    artifact.scope === context.activeScope &&
    Date.parse(artifact.issuedAt) <= nowMs &&
    (!artifact.expiresAt || Date.parse(artifact.expiresAt) >= nowMs) &&
    !artifact.bounded &&
    artifact.role !== "research" &&
    (artifact.role !== "build_plan" || artifact.id === context.activePlanId) &&
    (!revisionRequired.has(artifact.role) || artifact.sourceRevision === context.activeRevision) &&
    (!proofRequired.has(artifact.role) || proofVerified.get(artifact.id) === true) &&
    (artifact.role !== "watchdog_proof" ||
      (context.requiredWatchdogCoverage.length > 0 &&
        context.requiredWatchdogCoverage.every((signal) => artifact.coverage?.includes(signal))));
  const supersededBy = new Map<string, string>();
  for (const artifact of artifacts) {
    for (const priorId of artifact.supersedes) {
      const prior = byId.get(priorId);
      if (
        !prior ||
        prior.scope !== artifact.scope ||
        prior.role !== artifact.role ||
        prior.key !== artifact.key
      ) {
        throw new Error(`invalid SOP supersession: ${artifact.id} -> ${priorId}`);
      }
      if (Date.parse(prior.issuedAt) >= Date.parse(artifact.issuedAt)) {
        throw new Error(`SOP supersession is not newer: ${artifact.id} -> ${priorId}`);
      }
      if (eligibleForRouting(artifact) && supersededBy.has(priorId)) {
        throw new Error(`ambiguous SOP supersession: ${priorId}`);
      }
      if (eligibleForRouting(artifact)) {
        supersededBy.set(priorId, artifact.id);
      }
    }
  }
  const latestByRoleAndKey = new Map<string, number>();
  for (const artifact of artifacts) {
    const key = `${artifact.scope}\0${artifact.role}\0${artifact.key ?? ""}`;
    const at = Date.parse(artifact.issuedAt);
    if (eligibleForRouting(artifact)) {
      latestByRoleAndKey.set(key, Math.max(latestByRoleAndKey.get(key) ?? -Infinity, at));
    }
  }
  return artifacts.map((artifact): SopArtifactClassification => {
    const at = Date.parse(artifact.issuedAt);
    const latestAt = latestByRoleAndKey.get(
      `${artifact.scope}\0${artifact.role}\0${artifact.key ?? ""}`,
    );
    let classification: SopArtifactClass = "current";
    let reason = "latest relevant artifact with required proof";
    if (artifact.scope !== context.activeScope) {
      classification = "archive_only";
      reason = "artifact belongs to another mission scope";
    } else if (supersededBy.has(artifact.id)) {
      classification = "superseded";
      reason = `explicitly superseded by ${supersededBy.get(artifact.id)}`;
    } else if (artifact.role === "research") {
      classification = "support";
      reason = "research informs the build but does not control routing";
    } else if (
      artifact.role === "build_plan" &&
      context.activePlanId &&
      artifact.id !== context.activePlanId
    ) {
      classification = "superseded";
      reason = "another build plan is designated controlling";
    } else if (at > nowMs) {
      classification = "partially_stale";
      reason = "artifact timestamp is later than the evaluation time";
    } else if (artifact.role !== "build_plan" && latestAt !== undefined && at < latestAt) {
      classification = "stale";
      reason = "a newer artifact exists for this role and identity";
    } else if (artifact.expiresAt && Date.parse(artifact.expiresAt) < nowMs) {
      classification = "stale";
      reason = "artifact recurrence or validity deadline expired";
    } else if (
      revisionRequired.has(artifact.role) &&
      artifact.sourceRevision !== context.activeRevision
    ) {
      classification = "stale";
      reason = "artifact revision differs from active source";
    } else if (artifact.bounded) {
      classification = "partially_stale";
      reason = "bounded result cannot certify the full active scope";
    } else if (proofRequired.has(artifact.role) && proofVerified.get(artifact.id) !== true) {
      classification = "partially_stale";
      reason = "required material proof is missing";
    } else if (
      artifact.role === "watchdog_proof" &&
      (context.requiredWatchdogCoverage.length === 0 ||
        context.requiredWatchdogCoverage.some((signal) => !artifact.coverage?.includes(signal)))
    ) {
      classification = "partially_stale";
      reason = "watchdog proof does not declare complete required coverage";
    }
    const canRoute = classification === "current";
    return {
      artifact,
      classification,
      reason,
      canRoute,
      safeReadings: canRoute ? ["active_status_and_proof"] : ["historical_facts_with_scope"],
      unsafeReadings: canRoute ? [] : ["active_routing", "full_closeout_claim"],
    };
  });
}

export function requireCurrentSopArtifact(
  classifications: readonly SopArtifactClassification[],
  role: SopArtifactRole,
  key?: string,
): SopArtifact {
  const matching = classifications.filter(
    (result) => result.artifact.role === role && (key === undefined || result.artifact.key === key),
  );
  const current = matching.filter((result) => result.canRoute);
  if (current.length !== 1) {
    throw new Error(`SOP ${role} has ${current.length} current routing candidates`);
  }
  return current[0].artifact;
}
