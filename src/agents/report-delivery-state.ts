import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordSourceTurnReference } from "./source-delivery-obligation.js";

const MARKER_DIR_ENV = "OPENCLAW_REPORT_DELIVERY_MARKER_DIR";

type MarkerRow = Record<string, unknown> & {
  id: string;
  created_at?: string;
  updated_at?: string;
};

export type PendingReportDeliveryMarker = {
  id: string;
  sourceTurnId?: string;
  label?: string;
  artifact_path?: string;
  artifact_paths?: string[];
  report_required?: boolean;
  chat_report_delivered?: boolean;
  notes?: string;
};

export type PendingMilestoneReportMarker = {
  id: string;
  sourceTurnId?: string;
  label?: string;
  current_stage?: string;
  next_stage?: string;
  report_governed_mission?: boolean;
  stage_complete_pending_report?: boolean;
  milestone_report_delivered?: boolean;
  interrupted_stage_pending_report?: boolean;
  final_closeout_required?: boolean;
  final_closeout_delivered?: boolean;
  notes?: string;
};

function markerDir(): string | undefined {
  const configured = process.env[MARKER_DIR_ENV]?.trim();
  if (configured) {
    return configured;
  }
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return undefined;
  }
  return path.join(
    os.homedir(),
    ".openclaw",
    "workspace-orchestrator",
    "var",
    "report_delivery_law",
  );
}

function readRows(filePath: string): MarkerRow[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : [];
    return rows.filter((row): row is MarkerRow => {
      return Boolean(
        row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string",
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }
}

function upsertMarker(fileName: string, row: MarkerRow): void {
  const dir = markerDir();
  if (!dir) {
    return;
  }
  const now = new Date().toISOString();
  const filePath = path.join(dir, fileName);
  const rows = readRows(filePath);
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  const nextRow: MarkerRow = {
    ...(index >= 0 ? rows[index] : {}),
    ...row,
    created_at: index >= 0 ? (rows[index]?.created_at ?? now) : (row.created_at ?? now),
    updated_at: now,
  };
  const nextRows =
    index >= 0
      ? rows.map((candidate, candidateIndex) => (candidateIndex === index ? nextRow : candidate))
      : [...rows, nextRow];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify({ rows: nextRows }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function recordPendingReportDelivery(marker: PendingReportDeliveryMarker): void {
  try {
    if (marker.sourceTurnId) {
      recordSourceTurnReference({
        id: marker.sourceTurnId,
        currentStage: "report delivery pending",
        reportArtifactPaths: [
          ...(marker.artifact_paths ?? []),
          ...(marker.artifact_path ? [marker.artifact_path] : []),
        ],
        deliveryStatus: "final_pending",
        notes: marker.notes ?? "Report artifact requires source-chat report body delivery.",
      });
    }
    upsertMarker("pending_report_delivery.json", {
      ...marker,
      report_required: marker.report_required ?? true,
      chat_report_delivered: marker.chat_report_delivered ?? false,
    });
  } catch {
    // Reporting-marker writes are watchdog evidence. They must not break the user-facing guard path.
  }
}

export function recordPendingMilestoneReport(marker: PendingMilestoneReportMarker): void {
  try {
    if (marker.sourceTurnId) {
      recordSourceTurnReference({
        id: marker.sourceTurnId,
        currentStage: marker.current_stage ?? "milestone delivery pending",
        deliveryStatus: "milestone_pending",
        notes: marker.notes ?? "Milestone requires source-chat milestone report delivery.",
      });
    }
    upsertMarker("pending_milestone_report.json", {
      ...marker,
      report_governed_mission: marker.report_governed_mission ?? true,
      stage_complete_pending_report: marker.stage_complete_pending_report ?? true,
      milestone_report_delivered: marker.milestone_report_delivered ?? false,
    });
  } catch {
    // Reporting-marker writes are watchdog evidence. They must not break task finalization.
  }
}
