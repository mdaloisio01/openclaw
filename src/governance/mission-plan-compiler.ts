import type {
  AcceptanceGate,
  MissionManifest,
  RequirementManifest,
  RequirementManifestItem,
} from "./mission-manifest.types.js";

export type CompiledMissionPlan = {
  manifest: MissionManifest;
  requirements: RequirementManifest;
  gates: AcceptanceGate[];
};

/** The plan digest covers every executable gate and authorization field, excluding only itself. */
export function computeCompiledMissionPlanSha256(plan: CompiledMissionPlan): string {
  const { planSha256: _planSha256, ...manifest } = plan.manifest;
  return createHash("sha256")
    .update(stableStringify({ manifest, requirements: plan.requirements, gates: plan.gates }))
    .digest("hex");
}

export function compileMissionPlan(params: {
  manifest: MissionManifest;
  requirements: readonly Omit<RequirementManifestItem, "gateIds">[];
  gateKinds?: readonly AcceptanceGate["kind"][];
}): CompiledMissionPlan {
  const gateKinds = params.gateKinds ?? ["requirement"];
  const gates: AcceptanceGate[] = [];
  const requirements = params.requirements.map((requirement) => {
    const gateIds = gateKinds.map((kind) => `${requirement.id}:${kind}`);
    for (const [index, kind] of gateKinds.entries()) {
      gates.push({
        id: gateIds[index],
        requirementId: requirement.id,
        kind,
        required: requirement.required,
      });
    }
    return { ...requirement, gateIds };
  });
  return {
    manifest: params.manifest,
    requirements: {
      schema: "openclaw.requirement_manifest.v1",
      missionId: params.manifest.missionId,
      planRevisionId: params.manifest.planRevisionId,
      requirements,
    },
    gates,
  };
}
import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
