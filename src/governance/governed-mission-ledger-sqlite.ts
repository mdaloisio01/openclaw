import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { JsonValue, TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { GOVERNED_RECEIPT_KINDS, type GovernedReceiptKind } from "./governed-mission-contract.js";
import {
  computeGovernedMissionPackageSha256,
  computeGovernedMissionReceiptSha256,
} from "./governed-mission-ledger-integrity.js";
import {
  GOVERNED_MISSION_RUNTIME_PRODUCER,
  type GovernedMissionLedgerReceipt,
} from "./governed-mission-ledger.types.js";

export type GovernedMissionReceiptRow = Selectable<
  OpenClawStateKyselyDatabase["governed_mission_receipts"]
>;

type GovernedMissionLedgerDatabase = Pick<OpenClawStateKyselyDatabase, "governed_mission_receipts">;

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function parseJsonValue(raw: string | null): JsonValue | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return undefined;
  }
}

function parseContractReceiptKinds(raw: string | null): GovernedReceiptKind[] {
  const parsed = parseJsonValue(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const knownKinds = new Set<string>(GOVERNED_RECEIPT_KINDS);
  return parsed.filter(
    (kind): kind is GovernedReceiptKind => typeof kind === "string" && knownKinds.has(kind),
  );
}

export function parseGovernedMissionReceiptRow(
  row: GovernedMissionReceiptRow,
): GovernedMissionLedgerReceipt {
  const contractReceiptKinds = parseContractReceiptKinds(row.contract_receipt_kinds_json);
  return {
    receiptId: row.receipt_id,
    missionId: row.mission_id,
    ...(row.flow_id ? { flowId: row.flow_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.work_order_id ? { workOrderId: row.work_order_id } : {}),
    ...(row.gate_id ? { gateId: row.gate_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    operation: row.operation,
    receiptKind: row.receipt_kind as GovernedMissionLedgerReceipt["receiptKind"],
    ...(row.from_state ? { fromState: row.from_state } : {}),
    ...(row.to_state ? { toState: row.to_state } : {}),
    decision: row.decision,
    reasonCode: row.reason_code,
    ...(row.expected_revision !== null
      ? { expectedRevision: normalizeNumber(row.expected_revision) }
      : {}),
    ...(row.resulting_revision !== null
      ? { resultingRevision: normalizeNumber(row.resulting_revision) }
      : {}),
    ...(row.contract_id ? { contractId: row.contract_id } : {}),
    ...(row.contract_hash ? { contractHash: row.contract_hash } : {}),
    ...(row.authority_hash ? { authorityHash: row.authority_hash } : {}),
    ...(row.plan_revision_id ? { planRevisionId: row.plan_revision_id } : {}),
    ...(row.source_revision ? { sourceRevision: row.source_revision } : {}),
    ...(row.runtime_build_sha256 ? { runtimeBuildSha256: row.runtime_build_sha256 } : {}),
    ...(row.policy_version ? { policyVersion: row.policy_version } : {}),
    ...(row.skill_sha256 ? { skillSha256: row.skill_sha256 } : {}),
    payloadSha256: row.payload_sha256,
    ...(contractReceiptKinds.length > 0 ? { contractReceiptKinds } : {}),
    ...(row.ledger_sequence !== null
      ? { ledgerSequence: normalizeNumber(row.ledger_sequence) }
      : {}),
    ...(row.previous_receipt_sha256 ? { previousReceiptSha256: row.previous_receipt_sha256 } : {}),
    ...(row.governed_package_sha256 ? { governedPackageSha256: row.governed_package_sha256 } : {}),
    ...(row.receipt_sha256 ? { receiptSha256: row.receipt_sha256 } : {}),
    producer: row.producer,
    idempotencyKey: row.idempotency_key,
    details: parseJsonValue(row.details_json) ?? {},
    createdAt: normalizeNumber(row.created_at) ?? 0,
  };
}

export function readValidatedGovernedMissionReceiptChainFromDatabase(
  db: DatabaseSync,
  params: { flow: TaskFlowRecord; missionId: string },
): GovernedMissionLedgerReceipt[] | undefined {
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<GovernedMissionLedgerDatabase>(db)
      .selectFrom("governed_mission_receipts")
      .selectAll()
      .where("flow_id", "=", params.flow.flowId)
      .where("producer", "=", GOVERNED_MISSION_RUNTIME_PRODUCER)
      .orderBy("ledger_sequence", "asc"),
  ).rows.map((row) => parseGovernedMissionReceiptRow(row));
  const first = rows[0];
  if (
    !first ||
    first.operation !== "admitMission" ||
    first.decision !== "applied" ||
    first.missionId !== params.missionId
  ) {
    return undefined;
  }
  for (const [index, receipt] of rows.entries()) {
    const previous = rows[index - 1];
    if (
      receipt.missionId !== params.missionId ||
      receipt.ledgerSequence !== index + 1 ||
      !receipt.receiptSha256 ||
      receipt.receiptSha256 !== computeGovernedMissionReceiptSha256(receipt) ||
      (previous
        ? receipt.previousReceiptSha256 !== previous.receiptSha256
        : receipt.previousReceiptSha256 !== undefined)
    ) {
      return undefined;
    }
  }
  const head = rows.at(-1);
  if (
    !head?.receiptSha256 ||
    head.governedPackageSha256 !== computeGovernedMissionPackageSha256(params.flow)
  ) {
    return undefined;
  }
  return rows;
}
