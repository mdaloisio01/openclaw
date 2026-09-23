import { createHash } from "node:crypto";
import path from "node:path";
import { FsSafeError, root as openFsRoot } from "../infra/fs-safe.js";
import type { JsonValue } from "../tasks/task-flow-registry.types.js";
import { isForbiddenGovernedSecretPath } from "./governed-secret-path.js";
import type { GateKind } from "./mission-manifest.types.js";

export const GOVERNED_ARTIFACT_VERIFIER_VERSION = "governed-artifact-verifier-v1";
export const GOVERNED_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
export const GOVERNED_ARTIFACT_MAX_FILES = 100;

export const GOVERNED_ARTIFACT_FAILURE_CODES = [
  "missing",
  "unreadable",
  "wrong_type",
  "outside_allowed_root",
  "symlink_escape",
  "forbidden_secret_path",
  "empty",
  "too_small",
  "too_large",
  "required_label_missing",
  "required_field_missing",
  "hash_mismatch",
  "stale_timestamp",
  "identity_mismatch",
  "invalid_declaration",
  "verifier_internal_error",
] as const;

export type GovernedArtifactFailureCode = (typeof GOVERNED_ARTIFACT_FAILURE_CODES)[number];

export type GovernedArtifactDeclaration = {
  artifactId: string;
  artifactKind: string;
  missionId: string;
  workOrderId: string;
  gateId: string;
  allowedRoot: string;
  pathname: string;
  required: boolean;
  requireRegularFile?: boolean;
  minBytes?: number;
  maxBytes?: number;
  expectedSha256?: string;
  requiredLabels?: readonly string[];
  requiredJsonFields?: Readonly<Record<string, string>>;
  minModifiedAtMs?: number;
  identityBindings?: Readonly<Record<string, string>>;
};

export type GovernedArtifactVerificationContext = {
  missionId: string;
  workOrderId: string;
  gateId: string;
  gateKind: GateKind;
  operation: string;
  flowRevision: number;
  observedAtMs: number;
};

export type GovernedArtifactFact = {
  declaredPath: string;
  canonicalPath?: string;
  canonicalRoot?: string;
  lexicalInsideRoot: boolean;
  exists: boolean;
  readable: boolean;
  regularFile: boolean;
  sizeBytes?: number;
  modifiedAtMs?: number;
  computedSha256?: string;
  contentText?: string;
  parsedJson?: JsonValue;
  collectorFailure?: GovernedArtifactFailureCode;
};

export type GovernedArtifactVerificationResult = {
  artifactId: string;
  artifactKind: string;
  missionId: string;
  workOrderId: string;
  gateId: string;
  gateKind: GateKind;
  operation: string;
  flowRevision: number;
  required: boolean;
  status: "verified" | "optional_missing" | "rejected";
  failureCode?: GovernedArtifactFailureCode;
  nextAction?: string;
  locator: string;
  sizeBytes?: number;
  computedSha256?: string;
  expectedSha256?: string;
  expectedLabels: string[];
  identityBindings: JsonValue;
  verifierVersion: typeof GOVERNED_ARTIFACT_VERIFIER_VERSION;
  verifiedAt: number;
};

export type GovernedArtifactVerificationBatch = {
  results: GovernedArtifactVerificationResult[];
  requiredPassed: boolean;
  failureCodes: GovernedArtifactFailureCode[];
  nextAction?: string;
};

export function normalizeGovernedArtifactDeclarations(
  value: unknown,
): GovernedArtifactDeclaration[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > GOVERNED_ARTIFACT_MAX_FILES) {
    return null;
  }
  const declarations: GovernedArtifactDeclaration[] = [];
  const allowedKeys = [
    "artifactId",
    "artifactKind",
    "missionId",
    "workOrderId",
    "gateId",
    "allowedRoot",
    "pathname",
    "required",
    "requireRegularFile",
    "minBytes",
    "maxBytes",
    "expectedSha256",
    "requiredLabels",
    "requiredJsonFields",
    "minModifiedAtMs",
    "identityBindings",
  ] as const;
  for (const candidate of value) {
    if (!isStrictObject(candidate, allowedKeys)) {
      return null;
    }
    const strings = requireNonEmptyStrings(candidate, [
      "artifactId",
      "artifactKind",
      "missionId",
      "workOrderId",
      "gateId",
      "allowedRoot",
      "pathname",
    ]);
    const minBytes = optionalNonNegativeInteger(candidate.minBytes);
    const maxBytes = optionalNonNegativeInteger(candidate.maxBytes);
    const minModifiedAtMs = optionalNonNegativeNumber(candidate.minModifiedAtMs);
    const requiredLabels = optionalStringArray(candidate.requiredLabels);
    const requiredJsonFields = optionalStringRecord(candidate.requiredJsonFields);
    const identityBindings = optionalStringRecord(candidate.identityBindings);
    const expectedSha256 = optionalString(candidate.expectedSha256)?.toLowerCase();
    if (
      !strings ||
      typeof candidate.required !== "boolean" ||
      (candidate.requireRegularFile !== undefined && candidate.requireRegularFile !== true) ||
      minBytes === null ||
      maxBytes === null ||
      minModifiedAtMs === null ||
      requiredLabels === null ||
      requiredJsonFields === null ||
      identityBindings === null ||
      (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha256)) ||
      strings.artifactId.length > 256 ||
      strings.artifactKind.length > 128 ||
      strings.missionId.length > 256 ||
      strings.workOrderId.length > 256 ||
      strings.gateId.length > 256 ||
      strings.allowedRoot.length > 4096 ||
      strings.pathname.length > 4096 ||
      !path.isAbsolute(strings.allowedRoot) ||
      !path.isAbsolute(strings.pathname) ||
      !isAbsoluteInside(strings.allowedRoot, strings.pathname) ||
      isForbiddenGovernedSecretPath(strings.allowedRoot) ||
      isForbiddenGovernedSecretPath(strings.pathname) ||
      (maxBytes !== undefined && maxBytes > GOVERNED_ARTIFACT_MAX_BYTES) ||
      (minBytes !== undefined && maxBytes !== undefined && minBytes > maxBytes)
    ) {
      return null;
    }
    declarations.push({
      artifactId: strings.artifactId,
      artifactKind: strings.artifactKind,
      missionId: strings.missionId,
      workOrderId: strings.workOrderId,
      gateId: strings.gateId,
      allowedRoot: strings.allowedRoot,
      pathname: strings.pathname,
      required: candidate.required,
      ...(candidate.requireRegularFile === true ? { requireRegularFile: true } : {}),
      ...(minBytes !== undefined ? { minBytes } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(expectedSha256 ? { expectedSha256 } : {}),
      ...(requiredLabels ? { requiredLabels } : {}),
      ...(requiredJsonFields ? { requiredJsonFields } : {}),
      ...(minModifiedAtMs !== undefined ? { minModifiedAtMs } : {}),
      ...(identityBindings ? { identityBindings } : {}),
    });
  }
  return declarations.some((item) => item.required) &&
    new Set(declarations.map((item) => item.artifactId)).size === declarations.length
    ? declarations.toSorted((left, right) => left.artifactId.localeCompare(right.artifactId))
    : null;
}

export async function verifyGovernedArtifacts(
  declarations: readonly GovernedArtifactDeclaration[],
  context: GovernedArtifactVerificationContext,
): Promise<GovernedArtifactVerificationBatch> {
  const results: GovernedArtifactVerificationResult[] = [];
  const sorted = [...declarations].toSorted((left, right) =>
    left.artifactId.localeCompare(right.artifactId),
  );
  for (const [index, declaration] of sorted.entries()) {
    let fact: GovernedArtifactFact;
    if (index >= GOVERNED_ARTIFACT_MAX_FILES) {
      fact = emptyFact(declaration, "invalid_declaration");
    } else {
      try {
        fact = await collectGovernedArtifactFact(declaration);
      } catch {
        fact = emptyFact(declaration, "verifier_internal_error");
      }
    }
    results.push(evaluateGovernedArtifactFact(declaration, fact, context));
  }
  const rejected = results.filter((result) => result.status === "rejected");
  return {
    results,
    requiredPassed: rejected.length === 0,
    failureCodes: rejected
      .flatMap((result) => (result.failureCode ? [result.failureCode] : []))
      .toSorted(),
    ...(rejected[0]?.nextAction ? { nextAction: rejected[0].nextAction } : {}),
  };
}

export async function collectGovernedArtifactFact(
  declaration: GovernedArtifactDeclaration,
): Promise<GovernedArtifactFact> {
  const base = emptyFact(declaration);
  if (!path.isAbsolute(declaration.allowedRoot) || !path.isAbsolute(declaration.pathname)) {
    return { ...base, collectorFailure: "invalid_declaration" };
  }
  if (!base.lexicalInsideRoot) {
    return { ...base, collectorFailure: "outside_allowed_root" };
  }
  if (isForbiddenGovernedSecretPath(declaration.pathname)) {
    return { ...base, collectorFailure: "forbidden_secret_path" };
  }

  let fsRoot: Awaited<ReturnType<typeof openFsRoot>>;
  try {
    fsRoot = await openFsRoot(declaration.allowedRoot, {
      symlinks: "follow-within-root",
    });
  } catch (error) {
    return {
      ...base,
      collectorFailure: collectorFailureForError(error),
    };
  }
  // Admission persists this root below a canonical workspace path. A different
  // opened root means an output-path component was redirected after admission.
  if (path.resolve(fsRoot.rootReal) !== path.resolve(declaration.allowedRoot)) {
    return {
      ...base,
      canonicalRoot: fsRoot.rootReal,
      collectorFailure: "symlink_escape",
    };
  }

  const relativePath = path.relative(declaration.allowedRoot, declaration.pathname);
  try {
    const opened = await fsRoot.open(relativePath);
    try {
      const canonicalRoot = fsRoot.rootReal;
      const canonicalPath = opened.realPath;
      if (isForbiddenGovernedSecretPath(canonicalPath)) {
        return {
          ...base,
          canonicalRoot,
          canonicalPath,
          exists: true,
          collectorFailure: "forbidden_secret_path",
        };
      }
      // fs-safe pins the opened descriptor to this root before returning it.
      // Hash and stability checks stay on that descriptor so an ancestor swap
      // cannot redirect proof collection after boundary validation.
      const beforeRead = await opened.handle.stat({ bigint: true });
      const regularFile = beforeRead.isFile();
      if (!regularFile) {
        return {
          ...base,
          canonicalRoot,
          canonicalPath,
          exists: true,
          regularFile,
          sizeBytes: Number(beforeRead.size),
          modifiedAtMs: Number(beforeRead.mtimeNs) / 1_000_000,
          collectorFailure: "wrong_type",
        };
      }
      const maxBytes = normalizedMaxBytes(declaration.maxBytes);
      if (beforeRead.size > BigInt(maxBytes)) {
        return {
          ...base,
          canonicalRoot,
          canonicalPath,
          exists: true,
          regularFile,
          sizeBytes: Number(beforeRead.size),
          modifiedAtMs: Number(beforeRead.mtimeNs) / 1_000_000,
          collectorFailure: "too_large",
        };
      }
      const sizeBytes = Number(beforeRead.size);
      const bytes = Buffer.alloc(sizeBytes);
      const read = await opened.handle.read(bytes, 0, sizeBytes, 0);
      const afterRead = await opened.handle.stat({ bigint: true });
      if (
        read.bytesRead !== sizeBytes ||
        afterRead.size !== beforeRead.size ||
        afterRead.mtimeNs !== beforeRead.mtimeNs ||
        afterRead.ctimeNs !== beforeRead.ctimeNs ||
        afterRead.dev !== beforeRead.dev ||
        afterRead.ino !== beforeRead.ino
      ) {
        return {
          ...base,
          canonicalRoot,
          canonicalPath,
          exists: true,
          regularFile,
          sizeBytes: Number(afterRead.size),
          modifiedAtMs: Number(afterRead.mtimeNs) / 1_000_000,
          collectorFailure: "unreadable",
        };
      }
      const exactBytes = bytes.subarray(0, read.bytesRead);
      const contentText = exactBytes.toString("utf8");
      const parsedJson = parseJsonIfRequired(declaration, contentText);
      return {
        ...base,
        canonicalRoot,
        canonicalPath,
        exists: true,
        regularFile,
        readable: true,
        sizeBytes,
        modifiedAtMs: Number(beforeRead.mtimeNs) / 1_000_000,
        computedSha256: createHash("sha256").update(exactBytes).digest("hex"),
        contentText,
        ...(parsedJson !== undefined ? { parsedJson } : {}),
      };
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    return {
      ...base,
      canonicalRoot: fsRoot.rootReal,
      collectorFailure: collectorFailureForError(error),
    };
  }
}

function collectorFailureForError(error: unknown): GovernedArtifactFailureCode {
  if (error instanceof FsSafeError) {
    switch (error.code) {
      case "not-found":
        return "missing";
      case "not-file":
        return "wrong_type";
      case "hardlink":
        return "outside_allowed_root";
      case "outside-workspace":
      case "path-alias":
      case "path-mismatch":
      case "symlink":
        return "symlink_escape";
      case "too-large":
        return "too_large";
      default:
        return "unreadable";
    }
  }
  return isMissingError(error) ? "missing" : "unreadable";
}

function emptyFact(
  declaration: GovernedArtifactDeclaration,
  collectorFailure?: GovernedArtifactFailureCode,
): GovernedArtifactFact {
  return {
    declaredPath: declaration.pathname,
    lexicalInsideRoot: isAbsoluteInside(declaration.allowedRoot, declaration.pathname),
    exists: false,
    readable: false,
    regularFile: false,
    ...(collectorFailure ? { collectorFailure } : {}),
  };
}

export function evaluateGovernedArtifactFact(
  declaration: GovernedArtifactDeclaration,
  fact: GovernedArtifactFact,
  context: GovernedArtifactVerificationContext,
): GovernedArtifactVerificationResult {
  const base: Omit<GovernedArtifactVerificationResult, "status" | "failureCode" | "nextAction"> = {
    artifactId: declaration.artifactId,
    artifactKind: declaration.artifactKind,
    missionId: declaration.missionId,
    workOrderId: declaration.workOrderId,
    gateId: declaration.gateId,
    gateKind: context.gateKind,
    operation: context.operation,
    flowRevision: context.flowRevision,
    required: declaration.required,
    locator: redactLocator(fact.canonicalPath ?? fact.declaredPath),
    ...(fact.sizeBytes !== undefined ? { sizeBytes: fact.sizeBytes } : {}),
    ...(fact.computedSha256 ? { computedSha256: fact.computedSha256 } : {}),
    ...(declaration.expectedSha256 ? { expectedSha256: declaration.expectedSha256 } : {}),
    expectedLabels: [...(declaration.requiredLabels ?? [])].toSorted(),
    identityBindings: { ...declaration.identityBindings },
    verifierVersion: GOVERNED_ARTIFACT_VERIFIER_VERSION,
    verifiedAt: context.observedAtMs,
  };

  const identityFailure = firstDeclarationIdentityFailure(declaration, context);
  const failureCode =
    identityFailure ?? fact.collectorFailure ?? firstContentFailure(declaration, fact);
  if (!failureCode) {
    return { ...base, status: "verified" };
  }
  if (!declaration.required && failureCode === "missing") {
    return { ...base, status: "optional_missing", failureCode };
  }
  return {
    ...base,
    status: "rejected",
    failureCode,
    nextAction: nextActionForFailure(declaration.artifactId, failureCode),
  };
}

function firstDeclarationIdentityFailure(
  declaration: GovernedArtifactDeclaration,
  context: GovernedArtifactVerificationContext,
): GovernedArtifactFailureCode | undefined {
  if (
    declaration.missionId !== context.missionId ||
    declaration.workOrderId !== context.workOrderId ||
    declaration.gateId !== context.gateId
  ) {
    return "identity_mismatch";
  }
  return undefined;
}

function firstContentFailure(
  declaration: GovernedArtifactDeclaration,
  fact: GovernedArtifactFact,
): GovernedArtifactFailureCode | undefined {
  const size = fact.sizeBytes ?? 0;
  if (size === 0) {
    return "empty";
  }
  if (size < Math.max(0, declaration.minBytes ?? 1)) {
    return "too_small";
  }
  if (size > normalizedMaxBytes(declaration.maxBytes)) {
    return "too_large";
  }
  if (declaration.expectedSha256 && fact.computedSha256 !== declaration.expectedSha256) {
    return "hash_mismatch";
  }
  if (
    declaration.minModifiedAtMs !== undefined &&
    (fact.modifiedAtMs === undefined || fact.modifiedAtMs < declaration.minModifiedAtMs)
  ) {
    return "stale_timestamp";
  }
  for (const label of [...(declaration.requiredLabels ?? [])].toSorted()) {
    if (!fact.contentText?.includes(label)) {
      return "required_label_missing";
    }
  }
  for (const [field, expected] of Object.entries(declaration.requiredJsonFields ?? {}).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (readJsonField(fact.parsedJson, field) !== expected) {
      return "required_field_missing";
    }
  }
  for (const [field, expected] of Object.entries(declaration.identityBindings ?? {}).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (readJsonField(fact.parsedJson, field) !== expected) {
      return "identity_mismatch";
    }
  }
  return undefined;
}

function parseJsonIfRequired(
  declaration: GovernedArtifactDeclaration,
  content: string,
): JsonValue | undefined {
  if (!declaration.requiredJsonFields && !declaration.identityBindings) {
    return undefined;
  }
  try {
    return JSON.parse(content) as JsonValue;
  } catch {
    return undefined;
  }
}

function readJsonField(value: JsonValue | undefined, field: string): string | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of field.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === "string" || typeof current === "number" || typeof current === "boolean"
    ? String(current)
    : undefined;
}

function normalizedMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) {
    return GOVERNED_ARTIFACT_MAX_BYTES;
  }
  return Math.max(0, Math.min(Math.trunc(maxBytes), GOVERNED_ARTIFACT_MAX_BYTES));
}

function isStrictObject(
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireNonEmptyStrings(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const normalized = optionalString(value[key]);
    if (!normalized) {
      return null;
    }
    result[key] = normalized;
  }
  return result;
}

function optionalNonNegativeInteger(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalNonNegativeNumber(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 100) {
    return null;
  }
  const normalized = value.map(optionalString);
  return normalized.some((entry) => !entry || entry.length > 512)
    ? null
    : [...new Set(normalized as string[])].toSorted();
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (Object.keys(value).length > 100) {
    return null;
  }
  const entries = Object.entries(value);
  if (
    entries.some(
      ([key, entry]) =>
        !key.trim() ||
        key.trim().length > 256 ||
        typeof entry !== "string" ||
        !entry.trim() ||
        entry.trim().length > 4096,
    )
  ) {
    return null;
  }
  const normalized = entries
    .map(([key, entry]) => [key.trim(), (entry as string).trim()] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return new Set(normalized.map(([key]) => key)).size === normalized.length
    ? Object.fromEntries(normalized)
    : null;
}

function isAbsoluteInside(root: string, target: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(target)) {
    return false;
  }
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function redactLocator(pathname: string): string {
  return `<root>/${path.basename(pathname)}`;
}

function nextActionForFailure(
  artifactId: string,
  failureCode: GovernedArtifactFailureCode,
): string {
  return `Repair artifact ${artifactId} (${failureCode}), then run bounded verification again.`;
}
