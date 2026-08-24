import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GovernedMissionReceipt } from "./governed-mission-contract.js";
import type { EvidenceReceipt } from "./mission-manifest.types.js";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type GovernedEvidenceRetentionStrategy = {
  policyId: string;
  retainRuntimeReceipts: true;
  retainIndexes: true;
  exportSummariesOnly: true;
  maxReceiptAgeDays?: number;
};

export const DEFAULT_GOVERNED_EVIDENCE_RETENTION: GovernedEvidenceRetentionStrategy = {
  policyId: "governed-evidence-retention-v1",
  retainRuntimeReceipts: true,
  retainIndexes: true,
  exportSummariesOnly: true,
};

export type GovernedEvidenceStorageLocator = {
  storeRoot: string;
  missionId: string;
  workOrderId: string;
  runId: string;
};

export type GovernedEvidenceRecord = {
  schema: "openclaw.governed_evidence_record.v1";
  artifactId: string;
  artifactSha256: string;
  receiptId: string;
  receiptKind: string;
  missionId: string;
  workOrderId: string;
  runId: string;
  producedAt?: string;
  relativePath: string;
  absolutePath: string;
  writtenAt: string;
  retention: GovernedEvidenceRetentionStrategy;
};

export type GovernedEvidenceRunIndex = {
  schema: "openclaw.governed_evidence_run_index.v1";
  missionId: string;
  workOrderId: string;
  runId: string;
  updatedAt: string;
  retention: GovernedEvidenceRetentionStrategy;
  records: GovernedEvidenceRecord[];
  handoffPointers: GovernedEvidenceHandoffPointerRecord[];
};

export type GovernedEvidenceExportPointer = {
  schema: "openclaw.governed_evidence_export_pointer.v1";
  artifactId: string;
  artifactSha256: string;
  receiptKind: string;
  missionId: string;
  workOrderId: string;
  runId: string;
  evidencePath: string;
  indexPath: string;
};

export type GovernedEvidenceWriteResult = {
  record: GovernedEvidenceRecord;
  index: GovernedEvidenceRunIndex;
  indexPath: string;
  exportPointer: GovernedEvidenceExportPointer;
};

export type GovernedEvidenceHandoffPointer = {
  schema: "openclaw.governed_evidence_handoff_pointer.v1";
  pointerId: string;
  missionId: string;
  workOrderId: string;
  runId: string;
  fromOwner: string;
  toOwner: string;
  reason: string;
  evidenceRefs: string[];
  createdAt: string;
};

export type GovernedEvidenceHandoffPointerRecord = {
  schema: "openclaw.governed_evidence_handoff_pointer_record.v1";
  pointerId: string;
  pointerSha256: string;
  missionId: string;
  workOrderId: string;
  runId: string;
  fromOwner: string;
  toOwner: string;
  relativePath: string;
  absolutePath: string;
  createdAt: string;
};

export type GovernedEvidenceHandoffWriteResult = {
  record: GovernedEvidenceHandoffPointerRecord;
  index: GovernedEvidenceRunIndex;
  indexPath: string;
};

export function writeEvidenceReceipt(params: { directory: string; receipt: EvidenceReceipt }): {
  path: string;
  sha256: string;
} {
  fs.mkdirSync(params.directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(params.directory, `${params.receipt.receiptId}.json`);
  const body = `${JSON.stringify(params.receipt, null, 2)}\n`;
  fs.writeFileSync(filePath, body, { mode: 0o600 });
  return { path: filePath, sha256: sha256Text(body) };
}

export function writeGovernedEvidenceReceipt(params: {
  locator: GovernedEvidenceStorageLocator;
  receipt: GovernedMissionReceipt;
  retention?: GovernedEvidenceRetentionStrategy;
  writtenAt: string;
}): GovernedEvidenceWriteResult {
  assertMissionCorrelation(params.locator, params.receipt);
  const retention = params.retention ?? DEFAULT_GOVERNED_EVIDENCE_RETENTION;
  const receiptKind = receiptKindFor(params.receipt);
  const receiptId = receiptIdFor(params.receipt);
  const receiptBody = `${canonicalJson(params.receipt)}\n`;
  const artifactSha256 = sha256Text(receiptBody);
  const artifactId = sha256Text(
    [
      "governed-evidence",
      params.locator.missionId,
      params.locator.workOrderId,
      params.locator.runId,
      receiptKind,
      receiptId,
      artifactSha256,
    ].join("\n"),
  );
  const runDir = evidenceRunDirectory(params.locator);
  const receiptDir = path.join(runDir, "receipts", safePathSegment(receiptKind));
  fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const receiptFile = `${safePathSegment(receiptId)}--${artifactId.slice(0, 16)}.json`;
  const absolutePath = path.join(receiptDir, receiptFile);
  fs.writeFileSync(absolutePath, receiptBody, { mode: 0o600 });

  const record: GovernedEvidenceRecord = {
    schema: "openclaw.governed_evidence_record.v1",
    artifactId,
    artifactSha256,
    receiptId,
    receiptKind,
    missionId: params.locator.missionId,
    workOrderId: params.locator.workOrderId,
    runId: params.locator.runId,
    producedAt: producedAtFor(params.receipt),
    relativePath: path.relative(params.locator.storeRoot, absolutePath),
    absolutePath,
    writtenAt: params.writtenAt,
    retention,
  };
  const { index, indexPath } = upsertRunIndex(params.locator, {
    record,
    retention,
    updatedAt: params.writtenAt,
  });
  return {
    record,
    index,
    indexPath,
    exportPointer: {
      schema: "openclaw.governed_evidence_export_pointer.v1",
      artifactId,
      artifactSha256,
      receiptKind,
      missionId: params.locator.missionId,
      workOrderId: params.locator.workOrderId,
      runId: params.locator.runId,
      evidencePath: absolutePath,
      indexPath,
    },
  };
}

export function writeGovernedEvidenceHandoffPointer(params: {
  locator: GovernedEvidenceStorageLocator;
  pointer: GovernedEvidenceHandoffPointer;
  retention?: GovernedEvidenceRetentionStrategy;
}): GovernedEvidenceHandoffWriteResult {
  assertHandoffCorrelation(params.locator, params.pointer);
  const retention = params.retention ?? DEFAULT_GOVERNED_EVIDENCE_RETENTION;
  const pointerBody = `${canonicalJson(params.pointer)}\n`;
  const pointerSha256 = sha256Text(pointerBody);
  const runDir = evidenceRunDirectory(params.locator);
  const pointerDir = path.join(runDir, "handoff-pointers");
  fs.mkdirSync(pointerDir, { recursive: true, mode: 0o700 });
  const absolutePath = path.join(
    pointerDir,
    `${safePathSegment(params.pointer.pointerId)}--${pointerSha256.slice(0, 16)}.json`,
  );
  fs.writeFileSync(absolutePath, pointerBody, { mode: 0o600 });

  const record: GovernedEvidenceHandoffPointerRecord = {
    schema: "openclaw.governed_evidence_handoff_pointer_record.v1",
    pointerId: params.pointer.pointerId,
    pointerSha256,
    missionId: params.locator.missionId,
    workOrderId: params.locator.workOrderId,
    runId: params.locator.runId,
    fromOwner: params.pointer.fromOwner,
    toOwner: params.pointer.toOwner,
    relativePath: path.relative(params.locator.storeRoot, absolutePath),
    absolutePath,
    createdAt: params.pointer.createdAt,
  };
  const { index, indexPath } = upsertRunIndex(params.locator, {
    handoffPointer: record,
    retention,
    updatedAt: params.pointer.createdAt,
  });
  return { record, index, indexPath };
}

export function readGovernedEvidenceRunIndex(
  locator: GovernedEvidenceStorageLocator,
): GovernedEvidenceRunIndex {
  const indexPath = evidenceRunIndexPath(locator);
  return readIndex(indexPath, locator, DEFAULT_GOVERNED_EVIDENCE_RETENTION);
}

export function evidenceRunDirectory(locator: GovernedEvidenceStorageLocator): string {
  return path.join(
    locator.storeRoot,
    "governed-evidence",
    "v1",
    "missions",
    safePathSegment(locator.missionId),
    "work-orders",
    safePathSegment(locator.workOrderId),
    "runs",
    safePathSegment(locator.runId),
  );
}

function upsertRunIndex(
  locator: GovernedEvidenceStorageLocator,
  update: {
    record?: GovernedEvidenceRecord;
    handoffPointer?: GovernedEvidenceHandoffPointerRecord;
    retention: GovernedEvidenceRetentionStrategy;
    updatedAt: string;
  },
): { index: GovernedEvidenceRunIndex; indexPath: string } {
  const indexPath = evidenceRunIndexPath(locator);
  const index = readIndex(indexPath, locator, update.retention);
  const records = update.record
    ? upsertBy(index.records, update.record, (record) => record.artifactId)
    : index.records;
  const handoffPointers = update.handoffPointer
    ? upsertBy(index.handoffPointers, update.handoffPointer, (record) => record.pointerId)
    : index.handoffPointers;
  const nextIndex: GovernedEvidenceRunIndex = {
    ...index,
    updatedAt: update.updatedAt,
    retention: update.retention,
    records,
    handoffPointers,
  };
  fs.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(indexPath, `${canonicalJson(nextIndex)}\n`, { mode: 0o600 });
  return { index: nextIndex, indexPath };
}

function evidenceRunIndexPath(locator: GovernedEvidenceStorageLocator): string {
  return path.join(evidenceRunDirectory(locator), "index.json");
}

function readIndex(
  indexPath: string,
  locator: GovernedEvidenceStorageLocator,
  retention: GovernedEvidenceRetentionStrategy,
): GovernedEvidenceRunIndex {
  if (!fs.existsSync(indexPath)) {
    return {
      schema: "openclaw.governed_evidence_run_index.v1",
      missionId: locator.missionId,
      workOrderId: locator.workOrderId,
      runId: locator.runId,
      updatedAt: "",
      retention,
      records: [],
      handoffPointers: [],
    };
  }
  return JSON.parse(fs.readFileSync(indexPath, "utf8")) as GovernedEvidenceRunIndex;
}

function upsertBy<T>(items: T[], item: T, keyFor: (item: T) => string): T[] {
  const key = keyFor(item);
  const filtered = items.filter((existing) => keyFor(existing) !== key);
  return [...filtered, item].sort((left, right) => keyFor(left).localeCompare(keyFor(right)));
}

function receiptKindFor(receipt: GovernedMissionReceipt): string {
  if ("receiptKind" in receipt && typeof receipt.receiptKind === "string") {
    return receipt.receiptKind;
  }
  if ("schema" in receipt && receipt.schema === "openclaw.evidence_receipt.v1") {
    return "evidence";
  }
  return "unknown";
}

function receiptIdFor(receipt: GovernedMissionReceipt): string {
  if ("receiptId" in receipt && typeof receipt.receiptId === "string" && receipt.receiptId) {
    return receipt.receiptId;
  }
  return sha256Text(canonicalJson(receipt)).slice(0, 32);
}

function producedAtFor(receipt: GovernedMissionReceipt): string | undefined {
  if ("producedAt" in receipt && typeof receipt.producedAt === "string") {
    return receipt.producedAt;
  }
  return undefined;
}

function assertMissionCorrelation(
  locator: GovernedEvidenceStorageLocator,
  receipt: GovernedMissionReceipt,
): void {
  if ("missionId" in receipt && receipt.missionId !== locator.missionId) {
    throw new Error(
      `receipt missionId ${receipt.missionId} does not match evidence locator ${locator.missionId}`,
    );
  }
}

function assertHandoffCorrelation(
  locator: GovernedEvidenceStorageLocator,
  pointer: GovernedEvidenceHandoffPointer,
): void {
  const mismatches = [
    ["missionId", pointer.missionId, locator.missionId],
    ["workOrderId", pointer.workOrderId, locator.workOrderId],
    ["runId", pointer.runId, locator.runId],
  ].filter(([, observed, expected]) => observed !== expected);
  if (mismatches.length > 0) {
    throw new Error(
      `handoff pointer does not match evidence locator: ${mismatches
        .map(([field, observed, expected]) => `${field}=${observed} expected ${expected}`)
        .join(", ")}`,
    );
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || sha256Text(value).slice(0, 16);
}
