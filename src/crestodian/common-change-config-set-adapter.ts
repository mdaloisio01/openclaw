import { isDeepStrictEqual } from "node:util";
import type { ConfigSetOptions } from "../cli/config-set-input.js";

export type ConfigFileIdentitySnapshot = {
  config?: unknown;
  hash?: string | null;
  path?: string | null;
};

export type CommonChangeRegistryClient = {
  create_operation: (
    record: Record<string, unknown>,
    expectedRevision: number,
    idempotencyKey: string,
  ) => Promise<Record<string, unknown>>;
  transition_operation: (
    operationId: string,
    requestedState: string,
    expectedRevision: number,
    evidenceUpdates: Record<string, unknown>,
    actorIdentity: string,
    sessionIdentity: string,
    toolOrInvokingPath: string,
    workOrderIdentity: string,
    idempotencyKey: string,
  ) => Promise<Record<string, unknown>>;
  integrity_status?: () => Promise<Record<string, unknown>>;
};

export type CrestodianConfigSetCommonChangeContext = {
  registry?: CommonChangeRegistryClient;
  missionAdmission: {
    result?: string;
    admittedStageId?: string;
    evidenceRef?: string;
  };
  attribution: {
    actor: string;
    session: string;
    tool: string;
    workOrder: string;
  };
  authority: {
    authorityId: string;
    writerPath: string;
    rollbackBoundary: string;
  };
  expectedConfigIdentity: {
    beforeHash: string | null;
    path?: string | null;
  };
  idempotencyKey: string;
  expectedRegistryRevision: number;
};

export type CrestodianConfigSetAdapterParams = {
  operation: {
    path: string;
    value: string;
  };
  commonChange?: CrestodianConfigSetCommonChangeContext;
  readConfigFileSnapshot: () => Promise<ConfigFileIdentitySnapshot>;
  runConfigSet: (opts: {
    path?: string;
    value?: string;
    cliOptions: ConfigSetOptions;
  }) => Promise<void>;
};

export type CrestodianConfigSetAdapterResult = {
  operationId: string;
  before: ConfigFileIdentitySnapshot;
  after: ConfigFileIdentitySnapshot;
  transitions: string[];
};

export type CrestodianConfigSetCommonChangeAdapter = (
  params: CrestodianConfigSetAdapterParams,
) => Promise<CrestodianConfigSetAdapterResult>;

function requireText(value: string | undefined, field: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    throw new Error(`common_change_config_set_blocked:missing_${field}`);
  }
  return trimmed;
}

function operationResultId(result: Record<string, unknown>): string {
  const value = result.operation_id ?? result.operationId ?? result.id;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("common_change_config_set_blocked:registry_create_missing_operation_id");
  }
  return value;
}

function operationResultRevision(result: Record<string, unknown>): number {
  const value = result.revision ?? result.next_revision ?? result.expected_revision;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("common_change_config_set_blocked:registry_revision_missing");
  }
  return value;
}

function pathSegments(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function valueAtPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function collectDiffPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (isDeepStrictEqual(before, after)) {
    return [];
  }
  const beforeIsObject = Boolean(before) && typeof before === "object";
  const afterIsObject = Boolean(after) && typeof after === "object";
  if (!beforeIsObject && !afterIsObject) {
    return [prefix];
  }
  const keys = new Set([
    ...(beforeIsObject ? Object.keys(before as Record<string, unknown>) : []),
    ...(afterIsObject ? Object.keys(after as Record<string, unknown>) : []),
  ]);
  const out: string[] = [];
  for (const key of [...keys].toSorted()) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    out.push(
      ...collectDiffPaths(
        beforeIsObject ? (before as Record<string, unknown>)[key] : undefined,
        afterIsObject ? (after as Record<string, unknown>)[key] : undefined,
        nextPrefix,
      ),
    );
  }
  return out;
}

async function requireRegistryIntegrity(registry: CommonChangeRegistryClient): Promise<void> {
  if (!registry.integrity_status) {
    return;
  }
  const status = await registry.integrity_status();
  if (status.valid === false || status.ok === false) {
    throw new Error("common_change_config_set_blocked:registry_integrity_invalid");
  }
}

async function transition(params: {
  registry: CommonChangeRegistryClient;
  operationId: string;
  requestedState: string;
  revision: number;
  evidence: Record<string, unknown>;
  context: CrestodianConfigSetCommonChangeContext;
  idempotencySuffix: string;
}): Promise<number> {
  const result = await params.registry.transition_operation(
    params.operationId,
    params.requestedState,
    params.revision,
    params.evidence,
    params.context.attribution.actor,
    params.context.attribution.session,
    params.context.attribution.tool,
    params.context.attribution.workOrder,
    `${params.context.idempotencyKey}:${params.idempotencySuffix}`,
  );
  return operationResultRevision(result);
}

export const applyCrestodianConfigSetThroughCommonChangeRegistry: CrestodianConfigSetCommonChangeAdapter =
  async (params) => {
    const context = params.commonChange;
    if (!context?.registry) {
      throw new Error("common_change_config_set_blocked:registry_unavailable");
    }
    if (context.missionAdmission.result !== "ALLOW_BOUNDED") {
      throw new Error("common_change_config_set_blocked:mission_not_allow_bounded");
    }
    const actor = requireText(context.attribution.actor, "actor");
    const session = requireText(context.attribution.session, "session");
    const tool = requireText(context.attribution.tool, "tool");
    const workOrder = requireText(context.attribution.workOrder, "work_order");
    const authorityId = requireText(context.authority.authorityId, "authority");
    const writerPath = requireText(context.authority.writerPath, "writer_path");
    const rollbackBoundary = requireText(context.authority.rollbackBoundary, "rollback_boundary");
    requireText(context.idempotencyKey, "idempotency_key");

    await requireRegistryIntegrity(context.registry);
    const before = await params.readConfigFileSnapshot();
    if ((before.hash ?? null) !== context.expectedConfigIdentity.beforeHash) {
      throw new Error("common_change_config_set_blocked:expected_config_identity_mismatch");
    }
    if (
      context.expectedConfigIdentity.path !== undefined &&
      (before.path ?? null) !== context.expectedConfigIdentity.path
    ) {
      throw new Error("common_change_config_set_blocked:expected_config_path_mismatch");
    }

    const createResult = await context.registry.create_operation(
      {
        operation_class: "configuration_write",
        lifecycle_state: "proposed",
        actor_identity: actor,
        session_identity: session,
        tool_or_invoking_path: tool,
        work_order_identity: workOrder,
        declared_scope: {
          entry_point: "crestodian.config-set",
          configuration_path: params.operation.path,
          authority_id: authorityId,
          writer_path: writerPath,
          access_path_sensitive: true,
        },
        artifact_identities: {
          before_config_path: before.path ?? null,
          before_config_sha256: before.hash ?? null,
          expected_before_config_sha256: context.expectedConfigIdentity.beforeHash,
          writer_path: writerPath,
        },
        preflight: {
          mission_admission_result: context.missionAdmission.result,
          mission_admission_stage_id: context.missionAdmission.admittedStageId ?? null,
          mission_admission_evidence_ref: context.missionAdmission.evidenceRef ?? null,
          required_proofs: {
            browser_access_path: { status: "PENDING", stage: "shared_resolver" },
            phone_access_path: { status: "PENDING", stage: "shared_resolver" },
            authentication: { status: "PENDING", stage: "shared_resolver" },
            systemd_listener: { status: "PENDING", stage: "shared_resolver" },
            restart_reload: { status: "PENDING", stage: "restart_adapter" },
          },
        },
        rollback_identity: {
          boundary: rollbackBoundary,
          before_config_sha256: before.hash ?? null,
          writer_path: writerPath,
        },
      },
      context.expectedRegistryRevision,
      `${context.idempotencyKey}:create`,
    );
    const operationId = operationResultId(createResult);
    let revision = operationResultRevision(createResult);
    revision = await transition({
      registry: context.registry,
      operationId,
      requestedState: "preflight_passed",
      revision,
      context,
      idempotencySuffix: "preflight_passed",
      evidence: {
        mission_admission_result: "ALLOW_BOUNDED",
        before_config_sha256: before.hash ?? null,
        required_proofs_pending: true,
      },
    });

    await requireRegistryIntegrity(context.registry);
    try {
      await params.runConfigSet({
        path: params.operation.path,
        value: params.operation.value,
        cliOptions: {},
      });
    } catch (error) {
      await transition({
        registry: context.registry,
        operationId,
        requestedState: "failed",
        revision,
        context,
        idempotencySuffix: "writer_failed",
        evidence: { writer_error: String(error) },
      });
      throw error;
    }

    const after = await params.readConfigFileSnapshot();
    const changedPaths = collectDiffPaths(before.config, after.config).filter(Boolean);
    const writtenValue = valueAtPath(after.config, pathSegments(params.operation.path));
    const expectedValueConfirmed = isDeepStrictEqual(writtenValue, params.operation.value);
    if (changedPaths.length > 0 && !changedPaths.includes(params.operation.path)) {
      await transition({
        registry: context.registry,
        operationId,
        requestedState: "rollback_pending",
        revision,
        context,
        idempotencySuffix: "readback_mismatch",
        evidence: { changed_paths: changedPaths, after_config_sha256: after.hash ?? null },
      });
      throw new Error("common_change_config_set_blocked:readback_mismatch");
    }
    const unrelated = changedPaths.filter((item) => item !== params.operation.path);
    if (unrelated.length > 0) {
      await transition({
        registry: context.registry,
        operationId,
        requestedState: "rollback_pending",
        revision,
        context,
        idempotencySuffix: "unrelated_config_difference",
        evidence: { changed_paths: changedPaths, after_config_sha256: after.hash ?? null },
      });
      throw new Error("common_change_config_set_blocked:unrelated_config_difference");
    }
    if (!expectedValueConfirmed) {
      await transition({
        registry: context.registry,
        operationId,
        requestedState: "rollback_pending",
        revision,
        context,
        idempotencySuffix: "expected_mutation_missing",
        evidence: { written_value: writtenValue, after_config_sha256: after.hash ?? null },
      });
      throw new Error("common_change_config_set_blocked:expected_mutation_not_confirmed");
    }

    revision = await transition({
      registry: context.registry,
      operationId,
      requestedState: "applied",
      revision,
      context,
      idempotencySuffix: "applied",
      evidence: {
        before_config_sha256: before.hash ?? null,
        after_config_sha256: after.hash ?? null,
        after_config_path: after.path ?? before.path ?? null,
        changed_paths: changedPaths,
        idempotent_noop: changedPaths.length === 0,
        writer_path: writerPath,
      },
    });
    await transition({
      registry: context.registry,
      operationId,
      requestedState: "post_action_pending",
      revision,
      context,
      idempotencySuffix: "post_action_pending",
      evidence: {
        lifecycle_boundary: "post_action_pending",
        browser_phone_auth_systemd_listener_restart_proofs: "pending_shared_resolvers",
      },
    });

    return {
      operationId,
      before,
      after,
      transitions: ["proposed", "preflight_passed", "applied", "post_action_pending"],
    };
  };
