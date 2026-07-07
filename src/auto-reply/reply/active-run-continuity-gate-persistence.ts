import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ActiveRunContinuityGatePersistenceOptions } from "./active-run-continuation-guard.js";

export type ResolveActiveRunContinuityGatePersistenceParams = {
  workspaceDir?: string | null;
  sessionKey?: string | null;
  agentId?: string | null;
  now?: string;
};

const CONTINUITY_GATE_ACTIVE_RUN_OUTPUT_DIR = path.join(
  "var",
  "continuity_gate_v2",
  "active_run_guard",
);

export function resolveActiveRunContinuityGatePersistence(
  params: ResolveActiveRunContinuityGatePersistenceParams,
): ActiveRunContinuityGatePersistenceOptions | undefined {
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const agentId = normalizeOptionalString(params.agentId);
  if (!workspaceDir || !path.isAbsolute(workspaceDir) || !sessionKey || !agentId) {
    return undefined;
  }
  return {
    outputDir: path.join(workspaceDir, CONTINUITY_GATE_ACTIVE_RUN_OUTPUT_DIR),
    activeMission: `Active reply run continuation for ${sessionKey}`,
    now: params.now,
    sourceSurface: "dispatch-from-config:active-run-continuation-guard",
    proofRefs: [sessionKey],
    authoritySources: [
      {
        kind: "active_mission_lock",
        id: `active_reply_run:${sessionKey}`,
        summary: `Active reply run continuation guard for ${sessionKey} (${agentId})`,
        active: true,
      },
    ],
  };
}
