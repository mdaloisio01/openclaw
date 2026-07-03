import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  resolveSourceTurnDeliveryState,
  type SourceTurnDeliveryDecision,
  type SourceTurnDeliveryFacts,
  type SourceTurnDeliveryState,
} from "./source-turn-delivery-state.js";

export const SOURCE_TURN_DELIVERY_ROW_KIND = "openclaw.source-delivery-obligation";

export type SourceTurnDeliveryWatchdogReconciliation = {
  status?: string;
  action?: string;
  reason?: string;
  proofPath?: string;
  originalFinalDeliveryDelivered?: boolean;
  originalVisibleDeliveryCount?: number;
};

export type SourceTurnDeliveryRow = {
  id: string;
  kind: typeof SOURCE_TURN_DELIVERY_ROW_KIND;
  sourceTurnId: string;
  acceptedAt: string;
  updatedAt: string;
  deliveryStatus: string;
  sourceTurnState: SourceTurnDeliveryState;
  finalDeliveryDelivered: boolean;
  visibleDeliveryCount: number;
  currentStage?: string;
  failureReason?: string;
  reportArtifactPaths?: string[];
  watchdogReconciliation?: SourceTurnDeliveryWatchdogReconciliation;
  deliveryDecision: SourceTurnDeliveryDecision;
};

export type SourceTurnDeliveryRegistry = {
  rows: SourceTurnDeliveryRow[];
};

export type PersistSourceTurnDeliveryParams = {
  registryPath: string;
  id: string;
  sourceTurnId?: string;
  facts: SourceTurnDeliveryFacts;
  now?: string;
  currentStage?: string;
  reportArtifactPaths?: string[];
  watchdogReconciliation?: SourceTurnDeliveryWatchdogReconciliation;
};

export type SourceTurnDeliveryWatchdogStatus =
  | "non_blocking_delivered"
  | "non_blocking_settled"
  | "non_blocking_archived"
  | "blocking_failed"
  | "blocking_pending"
  | "blocking_refused";

function emptyRegistry(): SourceTurnDeliveryRegistry {
  return { rows: [] };
}

async function readRegistry(path: string): Promise<SourceTurnDeliveryRegistry> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const rows =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : Array.isArray(parsed)
          ? parsed
          : [];
    return {
      rows: rows.filter((row): row is SourceTurnDeliveryRow =>
        Boolean(
          row &&
          typeof row === "object" &&
          (row as { kind?: unknown }).kind === SOURCE_TURN_DELIVERY_ROW_KIND &&
          typeof (row as { id?: unknown }).id === "string",
        ),
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyRegistry();
    }
    throw error;
  }
}

async function writeRegistry(path: string, registry: SourceTurnDeliveryRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function statusForDecision(decision: SourceTurnDeliveryDecision): string {
  if (decision.state === "final_delivery_failed" || decision.state === "failure_delivered") {
    return "delivery_failed";
  }
  if (decision.state === "blocked_refused") {
    return "blocked";
  }
  if (decision.state === "settled_resolved_later") {
    return "final_pending";
  }
  return decision.state;
}

function visibleDeliveryCountForDecision(decision: SourceTurnDeliveryDecision): number {
  if (
    decision.state === "progress_delivered" ||
    decision.state === "final_delivered" ||
    decision.state === "failure_delivered"
  ) {
    return 1;
  }
  return 0;
}

export async function loadSourceTurnDeliveryRegistry(
  registryPath: string,
): Promise<SourceTurnDeliveryRegistry> {
  return readRegistry(registryPath);
}

export async function persistSourceTurnDeliveryState(
  params: PersistSourceTurnDeliveryParams,
): Promise<SourceTurnDeliveryRow> {
  const registry = await readRegistry(params.registryPath);
  const existing = registry.rows.find((row) => row.id === params.id);
  const decision = resolveSourceTurnDeliveryState(params.facts);
  const now = params.now ?? new Date().toISOString();
  const row: SourceTurnDeliveryRow = {
    id: params.id,
    kind: SOURCE_TURN_DELIVERY_ROW_KIND,
    sourceTurnId: params.sourceTurnId ?? existing?.sourceTurnId ?? params.id,
    acceptedAt: existing?.acceptedAt ?? now,
    updatedAt: now,
    deliveryStatus: statusForDecision(decision),
    sourceTurnState: decision.state,
    finalDeliveryDelivered: decision.finalDeliveryDelivered,
    visibleDeliveryCount: visibleDeliveryCountForDecision(decision),
    ...(params.currentStage ? { currentStage: params.currentStage } : {}),
    ...(decision.state === "final_delivery_failed" || decision.state === "blocked_refused"
      ? { failureReason: decision.reason }
      : {}),
    ...(params.reportArtifactPaths && params.reportArtifactPaths.length > 0
      ? { reportArtifactPaths: [...params.reportArtifactPaths] }
      : {}),
    ...(params.watchdogReconciliation
      ? { watchdogReconciliation: params.watchdogReconciliation }
      : decision.state === "settled_resolved_later"
        ? {
            watchdogReconciliation: {
              status: "settled_resolved_later",
              action: "settle-source-resolved-later",
              reason: decision.reason,
              originalFinalDeliveryDelivered: false,
              originalVisibleDeliveryCount: 0,
            },
          }
        : {}),
    deliveryDecision: decision,
  };
  const nextRows = existing
    ? registry.rows.map((candidate) => (candidate.id === row.id ? row : candidate))
    : [...registry.rows, row];
  await writeRegistry(params.registryPath, { rows: nextRows });
  return row;
}

export function classifySourceTurnDeliveryWatchdogStatus(
  row: SourceTurnDeliveryRow,
): SourceTurnDeliveryWatchdogStatus {
  const reconciliationStatus = row.watchdogReconciliation?.status?.toLowerCase() ?? "";
  const deliveryStatus = row.deliveryStatus.toLowerCase();
  if (row.finalDeliveryDelivered || deliveryStatus === "final_delivered") {
    return "non_blocking_delivered";
  }
  if (
    deliveryStatus === "archived_stale_or_orphaned" ||
    reconciliationStatus === "archived_stale_or_orphaned"
  ) {
    return "non_blocking_archived";
  }
  if (reconciliationStatus === "settled_resolved_later") {
    return "non_blocking_settled";
  }
  if (deliveryStatus === "delivery_failed" || row.sourceTurnState === "final_delivery_failed") {
    return "blocking_failed";
  }
  if (deliveryStatus === "blocked" || row.sourceTurnState === "blocked_refused") {
    return "blocking_refused";
  }
  return "blocking_pending";
}

export function sourceTurnDeliveryBlocksWatchdog(row: SourceTurnDeliveryRow): boolean {
  return classifySourceTurnDeliveryWatchdogStatus(row).startsWith("blocking_");
}
