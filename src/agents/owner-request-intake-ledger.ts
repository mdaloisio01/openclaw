import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export const OWNER_REQUEST_INTAKE_KIND = "openclaw.owner-request-intake";
export const OWNER_REQUEST_INTAKE_SCHEMA_VERSION = 1;
export const OWNER_REQUEST_INTAKE_DEFAULT_GRACE_MS = 2 * 60_000;

const LEDGER_DIR = "owner-request-intake-ledger";
const LEDGER_FILE = "records.json";
const MAX_SNIPPET_LENGTH = 160;

export type OwnerRequestIntakeStatus =
  | "client_send_attempt"
  | "server_acknowledged"
  | "prompt_persisted"
  | "mission_registered"
  | "chat_only_exempted"
  | "terminal"
  | "recovery_dispatched"
  | "owner_notified";

export type OwnerRequestIntakeClassification =
  | "cleanup_crew_production"
  | "read_only_reporting"
  | "forensic_review"
  | "governed_mission"
  | "chat_only";

export type OwnerRequestIntakeExpectedDurability =
  | "taskflow_or_exemption"
  | "taskflow_required"
  | "chat_only_exemption";

export type OwnerRequestIntakeGapCategory =
  | "client_send_no_server_ack"
  | "server_ack_no_prompt_persist"
  | "prompt_persist_no_mission_registration";

export type OwnerRequestIntakeRecord = {
  kind: typeof OWNER_REQUEST_INTAKE_KIND;
  schemaVersion: typeof OWNER_REQUEST_INTAKE_SCHEMA_VERSION;
  requestId: string;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
  status: OwnerRequestIntakeStatus;
  sourceSessionKey?: string;
  sourceSessionId?: string;
  sourceChannel?: string;
  sourceProvider?: string;
  clientSendAttemptId?: string;
  clientSendAttemptAtMs?: number;
  messageFingerprintSha256: string;
  messageSnippet?: string;
  classification: OwnerRequestIntakeClassification;
  expectedDurability: OwnerRequestIntakeExpectedDurability;
  governed: boolean;
  serverAckAtMs?: number;
  promptPersistedAtMs?: number;
  missionRegisteredAtMs?: number;
  terminalAtMs?: number;
  taskFlowId?: string;
  taskId?: string;
  recoveryDispatchId?: string;
  ownerNotificationId?: string;
  ownerNotificationProofPath?: string;
  lastExecutableAction?: string;
  nextExecutableAction?: string;
  reason?: string;
};

export type OwnerRequestIntakeLedger = {
  records: OwnerRequestIntakeRecord[];
};

export type OwnerRequestIntakeGap = {
  category: OwnerRequestIntakeGapCategory;
  requestId: string;
  ageMs: number;
  record: OwnerRequestIntakeRecord;
};

export type OwnerRequestIntakeClassificationResult = {
  classification: OwnerRequestIntakeClassification;
  expectedDurability: OwnerRequestIntakeExpectedDurability;
  governed: boolean;
  reason: string;
};

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function normalizeOptionalString(value: unknown, maxLength = 500): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizeRequiredString(value: unknown, fallback: string, maxLength = 500): string {
  return normalizeOptionalString(value, maxLength) ?? fallback;
}

function ledgerPath(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(process.env), LEDGER_DIR, LEDGER_FILE);
}

function readLedger(stateDir?: string): OwnerRequestIntakeLedger {
  const file = ledgerPath(stateDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [] };
    }
    throw error;
  }
  const records =
    parsed && typeof parsed === "object" ? (parsed as { records?: unknown }).records : [];
  return {
    records: Array.isArray(records)
      ? records.filter((record): record is OwnerRequestIntakeRecord =>
          Boolean(
            record &&
            typeof record === "object" &&
            (record as { kind?: unknown }).kind === OWNER_REQUEST_INTAKE_KIND &&
            (record as { schemaVersion?: unknown }).schemaVersion ===
              OWNER_REQUEST_INTAKE_SCHEMA_VERSION &&
            typeof (record as { requestId?: unknown }).requestId === "string",
          ),
        )
      : [],
  };
}

function writeLedger(ledger: OwnerRequestIntakeLedger, stateDir?: string): void {
  const file = ledgerPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.records.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function fingerprintMessage(message: string): string {
  return crypto.createHash("sha256").update(message, "utf8").digest("hex");
}

export function classifyOwnerRequestIntakeMessage(
  message: string,
): OwnerRequestIntakeClassificationResult {
  const normalized = message.toLowerCase();
  if (
    /\b(cleanup crew|cleanup-crew|remediation build|repair build|resume.*sop)\b/.test(normalized)
  ) {
    return {
      classification: "cleanup_crew_production",
      expectedDurability: "taskflow_required",
      governed: true,
      reason: "cleanup crew or remediation build request",
    };
  }
  if (/\b(forensic|root-cause|root cause|incident|postmortem)\b/.test(normalized)) {
    return {
      classification: "forensic_review",
      expectedDurability: "taskflow_or_exemption",
      governed: true,
      reason: "forensic or incident review request",
    };
  }
  if (
    /\b(read-only|read only|inventory|system-wide|system wide|open jobs?|status report|export|sop collection|watchdog|grant review|taskflow|control-plane|phase 2|false-closeout|build-state interpretation)\b/.test(
      normalized,
    )
  ) {
    return {
      classification: "read_only_reporting",
      expectedDurability: "taskflow_or_exemption",
      governed: true,
      reason: "read-only/reporting/governance request",
    };
  }
  if (
    /\b(build|implement|restart|reload|rollback|restore|deploy|production|resume)\b/.test(
      normalized,
    )
  ) {
    return {
      classification: "governed_mission",
      expectedDurability: "taskflow_or_exemption",
      governed: true,
      reason: "governed executable owner request",
    };
  }
  return {
    classification: "chat_only",
    expectedDurability: "chat_only_exemption",
    governed: false,
    reason: "ordinary chat-only request",
  };
}

function createRequestId(params: {
  sourceSessionKey?: string;
  messageFingerprintSha256: string;
  nowMs: number;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      `${params.sourceSessionKey ?? "unknown"}:${params.messageFingerprintSha256}:${params.nowMs}`,
    )
    .digest("hex")
    .slice(0, 32);
}

function upsertRecord(
  record: OwnerRequestIntakeRecord,
  stateDir?: string,
): OwnerRequestIntakeRecord {
  const ledger = readLedger(stateDir);
  const nextRecords = ledger.records.some((candidate) => candidate.requestId === record.requestId)
    ? ledger.records.map((candidate) =>
        candidate.requestId === record.requestId ? record : candidate,
      )
    : [...ledger.records, record];
  writeLedger({ records: nextRecords }, stateDir);
  return record;
}

function updateRecord(
  requestId: string,
  updater: (record: OwnerRequestIntakeRecord) => OwnerRequestIntakeRecord,
  stateDir?: string,
): OwnerRequestIntakeRecord | undefined {
  const ledger = readLedger(stateDir);
  let updated: OwnerRequestIntakeRecord | undefined;
  const nextRecords = ledger.records.map((record) => {
    if (record.requestId !== requestId) {
      return record;
    }
    updated = updater(record);
    return updated;
  });
  if (!updated) {
    return undefined;
  }
  writeLedger({ records: nextRecords }, stateDir);
  return updated;
}

export function createOwnerRequestIntakeRecord(params: {
  message: string;
  sourceSessionKey?: string | null;
  sourceSessionId?: string | null;
  sourceChannel?: string | null;
  sourceProvider?: string | null;
  clientSendAttemptId?: string | null;
  clientSendAttemptAtMs?: number | null;
  classification: OwnerRequestIntakeClassification;
  expectedDurability: OwnerRequestIntakeExpectedDurability;
  governed?: boolean;
  status?: OwnerRequestIntakeStatus;
  lastExecutableAction?: string | null;
  nextExecutableAction?: string | null;
  stateDir?: string;
  nowMs?: number;
}): OwnerRequestIntakeRecord {
  const nowMs = params.nowMs ?? Date.now();
  const message = normalizeRequiredString(params.message, "", 12_000);
  const messageFingerprintSha256 = fingerprintMessage(message);
  const sourceSessionKey = normalizeOptionalString(params.sourceSessionKey, 240);
  const requestId = createRequestId({ sourceSessionKey, messageFingerprintSha256, nowMs });
  return upsertRecord(
    {
      kind: OWNER_REQUEST_INTAKE_KIND,
      schemaVersion: OWNER_REQUEST_INTAKE_SCHEMA_VERSION,
      requestId,
      createdAt: nowIso(nowMs),
      createdAtMs: nowMs,
      updatedAt: nowIso(nowMs),
      updatedAtMs: nowMs,
      status: params.status ?? "server_acknowledged",
      ...(sourceSessionKey ? { sourceSessionKey } : {}),
      ...(normalizeOptionalString(params.sourceSessionId, 240)
        ? { sourceSessionId: normalizeOptionalString(params.sourceSessionId, 240) }
        : {}),
      ...(normalizeOptionalString(params.sourceChannel, 120)
        ? { sourceChannel: normalizeOptionalString(params.sourceChannel, 120) }
        : {}),
      ...(normalizeOptionalString(params.sourceProvider, 120)
        ? { sourceProvider: normalizeOptionalString(params.sourceProvider, 120) }
        : {}),
      ...(normalizeOptionalString(params.clientSendAttemptId, 240)
        ? { clientSendAttemptId: normalizeOptionalString(params.clientSendAttemptId, 240) }
        : {}),
      ...(typeof params.clientSendAttemptAtMs === "number" &&
      Number.isFinite(params.clientSendAttemptAtMs)
        ? { clientSendAttemptAtMs: Math.max(0, Math.trunc(params.clientSendAttemptAtMs)) }
        : {}),
      messageFingerprintSha256,
      ...(message ? { messageSnippet: message.slice(0, MAX_SNIPPET_LENGTH) } : {}),
      classification: params.classification,
      expectedDurability: params.expectedDurability,
      governed: params.governed ?? params.classification !== "chat_only",
      ...(params.status === "server_acknowledged" || !params.status
        ? { serverAckAtMs: nowMs }
        : {}),
      ...(normalizeOptionalString(params.lastExecutableAction, 500)
        ? { lastExecutableAction: normalizeOptionalString(params.lastExecutableAction, 500) }
        : {}),
      ...(normalizeOptionalString(params.nextExecutableAction, 500)
        ? { nextExecutableAction: normalizeOptionalString(params.nextExecutableAction, 500) }
        : {}),
    },
    params.stateDir,
  );
}

export function markOwnerRequestPromptPersisted(params: {
  requestId: string;
  stateDir?: string;
  nowMs?: number;
}): OwnerRequestIntakeRecord | undefined {
  const nowMs = params.nowMs ?? Date.now();
  return updateRecord(
    params.requestId,
    (record) => ({
      ...record,
      status: record.status === "mission_registered" ? record.status : "prompt_persisted",
      updatedAt: nowIso(nowMs),
      updatedAtMs: nowMs,
      promptPersistedAtMs: nowMs,
    }),
    params.stateDir,
  );
}

export function markOwnerRequestMissionRegistered(params: {
  requestId: string;
  taskFlowId: string;
  taskId?: string;
  lastExecutableAction?: string | null;
  nextExecutableAction?: string | null;
  stateDir?: string;
  nowMs?: number;
}): OwnerRequestIntakeRecord | undefined {
  const nowMs = params.nowMs ?? Date.now();
  return updateRecord(
    params.requestId,
    (record) => ({
      ...record,
      status: "mission_registered",
      updatedAt: nowIso(nowMs),
      updatedAtMs: nowMs,
      missionRegisteredAtMs: nowMs,
      taskFlowId: params.taskFlowId,
      ...(normalizeOptionalString(params.taskId, 240) ? { taskId: params.taskId } : {}),
      ...(normalizeOptionalString(params.lastExecutableAction, 500)
        ? { lastExecutableAction: normalizeOptionalString(params.lastExecutableAction, 500) }
        : {}),
      ...(normalizeOptionalString(params.nextExecutableAction, 500)
        ? { nextExecutableAction: normalizeOptionalString(params.nextExecutableAction, 500) }
        : {}),
    }),
    params.stateDir,
  );
}

export function markOwnerRequestChatOnlyExempted(params: {
  requestId: string;
  reason: string;
  stateDir?: string;
  nowMs?: number;
}): OwnerRequestIntakeRecord | undefined {
  const nowMs = params.nowMs ?? Date.now();
  return updateRecord(
    params.requestId,
    (record) => ({
      ...record,
      status: "chat_only_exempted",
      expectedDurability: "chat_only_exemption",
      governed: false,
      reason: normalizeRequiredString(params.reason, "chat-only exemption", 500),
      updatedAt: nowIso(nowMs),
      updatedAtMs: nowMs,
      terminalAtMs: nowMs,
    }),
    params.stateDir,
  );
}

export function markOwnerRequestRecoveryDispatched(params: {
  requestId: string;
  recoveryDispatchId: string;
  reason: string;
  nextExecutableAction?: string | null;
  stateDir?: string;
  nowMs?: number;
}): OwnerRequestIntakeRecord | undefined {
  const nowMs = params.nowMs ?? Date.now();
  return updateRecord(
    params.requestId,
    (record) => ({
      ...record,
      status: "recovery_dispatched",
      reason: normalizeRequiredString(
        params.reason,
        "owner request intake recovery dispatched",
        500,
      ),
      recoveryDispatchId: normalizeRequiredString(
        params.recoveryDispatchId,
        "recovery-dispatch",
        240,
      ),
      updatedAt: nowIso(nowMs),
      updatedAtMs: nowMs,
      ...(normalizeOptionalString(params.nextExecutableAction, 500)
        ? { nextExecutableAction: normalizeOptionalString(params.nextExecutableAction, 500) }
        : {}),
    }),
    params.stateDir,
  );
}

export function markOwnerRequestOwnerNotified(params: {
  requestId: string;
  ownerNotificationId: string;
  ownerNotificationProofPath: string;
  reason: string;
  stateDir?: string;
  nowMs?: number;
}): OwnerRequestIntakeRecord | undefined {
  const nowMs = params.nowMs ?? Date.now();
  const ownerNotificationProofPath = normalizeRequiredString(
    params.ownerNotificationProofPath,
    "owner-notification-proof",
    1_000,
  );
  if (!fs.existsSync(ownerNotificationProofPath)) {
    throw new Error(`owner notification proof path does not exist: ${ownerNotificationProofPath}`);
  }
  return updateRecord(
    params.requestId,
    (record) => ({
      ...record,
      status: "owner_notified",
      reason: normalizeRequiredString(
        params.reason,
        "owner notified about unrecoverable intake gap",
        500,
      ),
      ownerNotificationId: normalizeRequiredString(
        params.ownerNotificationId,
        "owner-notification",
        240,
      ),
      ownerNotificationProofPath,
      updatedAt: nowIso(nowMs),
      updatedAtMs: nowMs,
    }),
    params.stateDir,
  );
}

export function listOwnerRequestIntakeRecords(
  params: { stateDir?: string } = {},
): OwnerRequestIntakeRecord[] {
  return readLedger(params.stateDir).records;
}

export function classifyOwnerRequestIntakeGaps(
  params: {
    stateDir?: string;
    nowMs?: number;
    graceMs?: number;
  } = {},
): OwnerRequestIntakeGap[] {
  const nowMs = params.nowMs ?? Date.now();
  const graceMs = params.graceMs ?? OWNER_REQUEST_INTAKE_DEFAULT_GRACE_MS;
  return readLedger(params.stateDir).records.flatMap<OwnerRequestIntakeGap>((record) => {
    if (
      !record.governed ||
      record.status === "mission_registered" ||
      record.status === "terminal"
    ) {
      return [];
    }
    if (
      record.status === "chat_only_exempted" ||
      record.status === "recovery_dispatched" ||
      (record.status === "owner_notified" &&
        record.ownerNotificationId &&
        record.reason &&
        record.ownerNotificationProofPath &&
        fs.existsSync(record.ownerNotificationProofPath))
    ) {
      return [];
    }
    const ageMs = Math.max(0, nowMs - record.updatedAtMs);
    if (ageMs < graceMs) {
      return [];
    }
    if (record.status === "client_send_attempt") {
      return [
        { category: "client_send_no_server_ack", requestId: record.requestId, ageMs, record },
      ];
    }
    if (record.status === "server_acknowledged") {
      return [
        { category: "server_ack_no_prompt_persist", requestId: record.requestId, ageMs, record },
      ];
    }
    return [
      {
        category: "prompt_persist_no_mission_registration",
        requestId: record.requestId,
        ageMs,
        record,
      },
    ];
  });
}

export function resetOwnerRequestIntakeLedgerForTests(params: { stateDir?: string } = {}): void {
  fs.rmSync(path.dirname(ledgerPath(params.stateDir)), { recursive: true, force: true });
}
