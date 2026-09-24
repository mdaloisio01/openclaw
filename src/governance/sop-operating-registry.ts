import { z } from "zod";
import type { LaneReadinessLane, LaneReadinessReport } from "./lane-readiness-harness.js";

export const SOP_OPERATING_REGISTRY_SCHEMA = "openclaw.sop_operating_registry.v1" as const;

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const route = z.object({ from: identifier, to: identifier, priority: z.number().int().min(0) });
const substitute = z.object({
  owner: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
});
const lane = z.object({
  id: identifier,
  priority: z.enum(["P0", "P1"]),
  owner: z.string().trim().min(1),
  responsibility: z.string().trim().min(1),
  handoffRoutes: z.array(route).min(1),
  allowedSubstitutes: z.array(substitute),
  proofGates: z.array(identifier).min(1),
  watchdogSignals: z.array(identifier).min(1),
  readinessTests: z.array(identifier).min(1),
  closeoutRule: z.literal("all_required_checks_pass_with_proof"),
  stopCondition: z.string().trim().min(1),
});
const registrySchema = z.object({
  schema: z.literal(SOP_OPERATING_REGISTRY_SCHEMA),
  lanes: z.array(lane).min(1),
});
export type SopOperatingRegistry = z.infer<typeof registrySchema>;

// Keep owner policy adjacent to the live readiness catalog. A substitute is
// absent until its owner, scope, and expiry have been explicitly approved.
const lanePolicy: Record<
  string,
  Pick<
    SopOperatingRegistry["lanes"][number],
    "responsibility" | "handoffRoutes" | "watchdogSignals" | "stopCondition"
  >
> = {
  will_controller: {
    responsibility: "Classify owner requests, route work, and report source-visible truth",
    handoffRoutes: [{ from: "mark", to: "will_controller", priority: 0 }],
    watchdogSignals: ["owner_request_intake", "active_worker", "source_delivery"],
    stopCondition: "Unproven intake, active ownership, or source delivery remains open",
  },
  cleanup_crew: {
    responsibility: "Execute governed cleanup and recovery through assigned lanes",
    handoffRoutes: [{ from: "will_controller", to: "cleanup_crew", priority: 0 }],
    watchdogSignals: ["worker", "repair_closure"],
    stopCondition: "Unproven worker, repair, or report delivery blocks closeout",
  },
  grant: {
    responsibility: "Independently review proof and issue final acceptance",
    handoffRoutes: [{ from: "will_controller", to: "grant", priority: 0 }],
    watchdogSignals: ["grant_state"],
    stopCondition: "Missing review fields, proof, or audit receipt blocks acceptance",
  },
  acp_acpx: {
    responsibility: "Own ACP session, prompt, response, and intake correlation",
    handoffRoutes: [{ from: "will_controller", to: "acp_acpx", priority: 0 }],
    watchdogSignals: ["owner_request_intake", "delivery"],
    stopCondition: "Unbound prompt or missing response delivery blocks completion",
  },
  gateway_runtime: {
    responsibility: "Run the live Gateway and prove build, service, and asset identity",
    handoffRoutes: [{ from: "will_controller", to: "gateway_runtime", priority: 0 }],
    watchdogSignals: ["runtime"],
    stopCondition: "Stale runtime identity or unproven loaded assets blocks readiness",
  },
  watchdog: {
    responsibility: "Scan active work and route suspicious findings",
    handoffRoutes: [{ from: "will_controller", to: "watchdog", priority: 0 }],
    watchdogSignals: ["scheduled_scan", "native_tool_result", "record_integrity"],
    stopCondition: "Suspicious findings or incomplete declared coverage blocks clean",
  },
  taskflow_session_continuity: {
    responsibility: "Persist task lifecycle and parent-child continuation",
    handoffRoutes: [{ from: "will_controller", to: "taskflow_session_continuity", priority: 0 }],
    watchdogSignals: ["continuation", "worker"],
    stopCondition: "Unproven child completion or parent wake blocks settlement",
  },
  source_report_delivery: {
    responsibility: "Preserve source response and report delivery obligations",
    handoffRoutes: [{ from: "will_controller", to: "source_report_delivery", priority: 0 }],
    watchdogSignals: ["delivery", "source_delivery"],
    stopCondition: "Prepared or failed final without visible delivery remains open",
  },
  sadb: {
    responsibility: "Admit build plans and route governed implementation slices",
    handoffRoutes: [{ from: "will_controller", to: "sadb", priority: 0 }],
    watchdogSignals: ["active_closeout_gate"],
    stopCondition: "Unadmitted plan or unproven slice result blocks completion",
  },
  engineering_delivery: {
    responsibility: "Implement, validate, and hand off source repairs",
    handoffRoutes: [{ from: "will_controller", to: "engineering_delivery", priority: 0 }],
    watchdogSignals: ["runtime", "repair_closure"],
    stopCondition: "Missing integration, runtime, or handoff proof blocks acceptance",
  },
  file_hub_export: {
    responsibility: "Publish and read back Mark-visible evidence exports",
    handoffRoutes: [{ from: "will_controller", to: "file_hub_export", priority: 0 }],
    watchdogSignals: ["file_hub_visibility", "delivery"],
    stopCondition: "Unlisted or unmatched download blocks report delivery",
  },
  memory_knowledge: {
    responsibility: "Maintain continuity, search, QMD scope, and memory sync",
    handoffRoutes: [{ from: "will_controller", to: "memory_knowledge", priority: 0 }],
    watchdogSignals: ["continuation"],
    stopCondition: "Unproven knowledge sync or scope integrity blocks readiness",
  },
};

export function validateSopOperatingRegistry(input: unknown): SopOperatingRegistry {
  const parsed = registrySchema.parse(input);
  const ids = new Set<string>();
  for (const entry of parsed.lanes) {
    if (ids.has(entry.id)) {
      throw new Error(`duplicate operating lane: ${entry.id}`);
    }
    ids.add(entry.id);
    if (!entry.handoffRoutes.some((candidate) => candidate.to === entry.id)) {
      throw new Error(`operating lane ${entry.id} has no owner-bound handoff`);
    }
    const routeKeys = new Set<string>();
    for (const candidate of entry.handoffRoutes) {
      const key = `${candidate.from}\0${candidate.priority}`;
      if (routeKeys.has(key)) {
        throw new Error(`ambiguous operating route: ${entry.id}`);
      }
      routeKeys.add(key);
    }
    if (new Set(entry.proofGates).size !== entry.proofGates.length) {
      throw new Error(`duplicate proof gate: ${entry.id}`);
    }
    if (new Set(entry.readinessTests).size !== entry.readinessTests.length) {
      throw new Error(`duplicate readiness test: ${entry.id}`);
    }
  }
  return parsed;
}

export function buildSopOperatingRegistry(
  lanes: readonly LaneReadinessLane[],
): SopOperatingRegistry {
  const policyIds = new Set(Object.keys(lanePolicy));
  if (policyIds.size !== lanes.length || lanes.some((entry) => !policyIds.has(entry.id))) {
    throw new Error("operating policy does not match the readiness lane catalog");
  }
  return validateSopOperatingRegistry({
    schema: SOP_OPERATING_REGISTRY_SCHEMA,
    lanes: lanes.map((entry) => {
      const policy = lanePolicy[entry.id];
      if (!policy) {
        throw new Error(`missing operating policy for readiness lane: ${entry.id}`);
      }
      const checkIds = entry.checks.map((check) => check.id);
      return {
        id: entry.id,
        priority: entry.priority,
        owner: entry.currentOwner,
        ...policy,
        allowedSubstitutes: [],
        proofGates: checkIds,
        readinessTests: checkIds,
        closeoutRule: "all_required_checks_pass_with_proof",
      };
    }),
  });
}

export type SopOperatingLaneState = {
  id: string;
  owner: string;
  status: "ready" | "blocked" | "stale";
  checkedAt: string;
  proofPaths: string[];
  blockers: string[];
};

export function resolveSopOperatingLaneState(
  registry: SopOperatingRegistry,
  report: Pick<
    LaneReadinessReport,
    "lanes" | "checkedAt" | "nextRunDueAt" | "status" | "integrityFailures"
  >,
  now: string,
): SopOperatingLaneState[] {
  const nowMs = Date.parse(now);
  const checkedAtMs = Date.parse(report.checkedAt);
  const dueMs = Date.parse(report.nextRunDueAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(checkedAtMs) || !Number.isFinite(dueMs)) {
    throw new Error("operating state requires valid current and recurrence timestamps");
  }
  if (
    report.status === "PASS" &&
    (report.integrityFailures.length > 0 || report.lanes.some((entry) => entry.status === "FAIL"))
  ) {
    throw new Error("readiness report status contradicts its evidence");
  }
  const resultById = new Map(report.lanes.map((entry) => [entry.laneId, entry]));
  if (resultById.size !== registry.lanes.length) {
    throw new Error("readiness result does not cover the operating registry");
  }
  const unexplainedReportFailure =
    report.status === "FAIL" && report.lanes.every((entry) => entry.status === "PASS");
  return registry.lanes.map((entry) => {
    const result = resultById.get(entry.id);
    if (!result || result.currentOwner !== entry.owner) {
      throw new Error(`readiness result owner mismatch: ${entry.id}`);
    }
    const checkIds = new Set(result.checks.map((check) => check.checkId));
    if (
      checkIds.size !== entry.readinessTests.length ||
      entry.readinessTests.some((id) => !checkIds.has(id))
    ) {
      throw new Error(`readiness result check mismatch: ${entry.id}`);
    }
    const blockers = result.checks.flatMap((check) =>
      check.status === "FAIL"
        ? [check.blocker?.detail ?? `missing proof for ${check.checkId}`]
        : check.proofPaths.length === 0
          ? [`missing proof for ${check.checkId}`]
          : [],
    );
    blockers.push(...report.integrityFailures.map((failure) => failure.detail));
    if (unexplainedReportFailure && blockers.length === 0) {
      blockers.push("readiness report failed without lane-level proof");
    }
    const proofPaths = result.checks.flatMap((check) => check.proofPaths).toSorted();
    return {
      id: entry.id,
      owner: entry.owner,
      status:
        nowMs < checkedAtMs || nowMs > dueMs
          ? "stale"
          : result.status === "PASS" && blockers.length === 0
            ? "ready"
            : "blocked",
      checkedAt: report.checkedAt,
      proofPaths,
      blockers,
    };
  });
}
