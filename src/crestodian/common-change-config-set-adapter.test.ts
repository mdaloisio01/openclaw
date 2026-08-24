import { describe, expect, it, vi } from "vitest";
import {
  applyCrestodianConfigSetThroughCommonChangeRegistry,
  type CommonChangeRegistryClient,
  type ConfigFileIdentitySnapshot,
  type CrestodianConfigSetCommonChangeContext,
} from "./common-change-config-set-adapter.js";

function snapshot(config: unknown, hash: string): ConfigFileIdentitySnapshot {
  return {
    config,
    hash,
    path: "/tmp/openclaw.json",
  };
}

function createRegistry(
  params: {
    integrityValid?: boolean;
    rejectPreflight?: boolean;
    rejectCreate?: string;
  } = {},
): CommonChangeRegistryClient & {
  states: string[];
} {
  const states: string[] = [];
  return {
    states,
    integrity_status: vi.fn(async () => ({ valid: params.integrityValid ?? true })),
    create_operation: vi.fn(async () => {
      if (params.rejectCreate) {
        throw new Error(params.rejectCreate);
      }
      return { operation_id: "op-config-set", revision: 1 };
    }),
    transition_operation: vi.fn(async (_id, state, revision) => {
      if (params.rejectPreflight && state === "preflight_passed") {
        throw new Error("preflight rejected");
      }
      states.push(state);
      return { revision: revision + 1 };
    }),
  };
}

function context(overrides: Partial<CrestodianConfigSetCommonChangeContext> = {}) {
  const registry = createRegistry();
  return {
    registry,
    missionAdmission: {
      result: "ALLOW_BOUNDED",
      admittedStageId: "one_configuration_write_entrypoint_adapter_migration",
    },
    attribution: {
      actor: "test-actor",
      session: "test-session",
      tool: "src/crestodian/operations.ts:config-set",
      workOrder: "test-work-order",
    },
    authority: {
      authorityId: "src/cli/config-cli.ts:runConfigSet",
      writerPath: "src/config/mutate.ts:replaceConfigFile",
      rollbackBoundary: "config_mutation_base_hash_atomic_write",
    },
    expectedConfigIdentity: {
      beforeHash: "before",
      path: "/tmp/openclaw.json",
    },
    idempotencyKey: "idem-1",
    expectedRegistryRevision: 0,
    ...overrides,
  } satisfies CrestodianConfigSetCommonChangeContext;
}

async function runAdapter(params: {
  commonChange?: CrestodianConfigSetCommonChangeContext;
  before?: ConfigFileIdentitySnapshot;
  after?: ConfigFileIdentitySnapshot;
  writer?: () => Promise<void>;
}) {
  const reads = [
    params.before ?? snapshot({ gateway: { port: "18000" } }, "before"),
    params.after ?? snapshot({ gateway: { port: "19001" } }, "after"),
  ];
  const readConfigFileSnapshot = vi.fn(async () => reads.shift() ?? reads.at(-1)!);
  const runConfigSet = vi.fn(async () => {
    await params.writer?.();
  });
  const result = await applyCrestodianConfigSetThroughCommonChangeRegistry({
    operation: {
      path: "gateway.port",
      value: "19001",
    },
    commonChange: params.commonChange ?? context(),
    readConfigFileSnapshot,
    runConfigSet,
  });
  return { result, readConfigFileSnapshot, runConfigSet };
}

describe("applyCrestodianConfigSetThroughCommonChangeRegistry", () => {
  it("creates one operation and stops at post_action_pending", async () => {
    const commonChange = context();
    const { result, runConfigSet } = await runAdapter({ commonChange });

    expect(result.transitions).toEqual([
      "proposed",
      "preflight_passed",
      "applied",
      "post_action_pending",
    ]);
    expect(runConfigSet).toHaveBeenCalledTimes(1);
    expect(commonChange.registry?.create_operation).toHaveBeenCalledTimes(1);
    expect((commonChange.registry as ReturnType<typeof createRegistry>).states).toEqual([
      "preflight_passed",
      "applied",
      "post_action_pending",
    ]);
    expect((commonChange.registry as ReturnType<typeof createRegistry>).states).not.toContain(
      "validated",
    );
    expect((commonChange.registry as ReturnType<typeof createRegistry>).states).not.toContain(
      "independently_reviewed",
    );
    expect((commonChange.registry as ReturnType<typeof createRegistry>).states).not.toContain(
      "closed",
    );
  });

  it("fails closed before mutation when mission admission is missing or not allowed", async () => {
    const commonChange = context({ missionAdmission: { result: "BLOCKED_MISSING_TRUTH" } });

    await expect(runAdapter({ commonChange })).rejects.toThrow(
      "common_change_config_set_blocked:mission_not_allow_bounded",
    );
    expect(commonChange.registry?.create_operation).not.toHaveBeenCalled();
  });

  it("fails closed before mutation when attribution is missing", async () => {
    const commonChange = context({
      attribution: {
        actor: "",
        session: "test-session",
        tool: "src/crestodian/operations.ts:config-set",
        workOrder: "test-work-order",
      },
    });

    await expect(runAdapter({ commonChange })).rejects.toThrow(
      "common_change_config_set_blocked:missing_actor",
    );
  });

  it("fails closed before mutation when authority is unresolved", async () => {
    const commonChange = context({
      authority: {
        authorityId: "",
        writerPath: "src/config/mutate.ts:replaceConfigFile",
        rollbackBoundary: "config_mutation_base_hash_atomic_write",
      },
    });

    await expect(runAdapter({ commonChange })).rejects.toThrow(
      "common_change_config_set_blocked:missing_authority",
    );
  });

  it("fails closed before mutation when expected configuration identity mismatches", async () => {
    const commonChange = context({
      expectedConfigIdentity: { beforeHash: "different", path: "/tmp/openclaw.json" },
    });

    await expect(runAdapter({ commonChange })).rejects.toThrow(
      "common_change_config_set_blocked:expected_config_identity_mismatch",
    );
  });

  it("fails closed before mutation when registry integrity is invalid", async () => {
    const commonChange = context({ registry: createRegistry({ integrityValid: false }) });

    await expect(runAdapter({ commonChange })).rejects.toThrow(
      "common_change_config_set_blocked:registry_integrity_invalid",
    );
  });

  it("fails closed before mutation when registry creation fails", async () => {
    const commonChange = context({
      registry: createRegistry({ rejectCreate: "registry unavailable" }),
    });
    const writer = vi.fn(async () => {});

    await expect(runAdapter({ commonChange, writer })).rejects.toThrow("registry unavailable");
    expect(writer).not.toHaveBeenCalled();
  });

  it("fails closed before mutation when registry revision is stale", async () => {
    const commonChange = context({ registry: createRegistry({ rejectCreate: "stale revision" }) });
    const writer = vi.fn(async () => {});

    await expect(runAdapter({ commonChange, writer })).rejects.toThrow("stale revision");
    expect(writer).not.toHaveBeenCalled();
  });

  it("fails closed before mutation when reused idempotency has different content", async () => {
    const commonChange = context({
      registry: createRegistry({ rejectCreate: "idempotency conflict" }),
    });
    const writer = vi.fn(async () => {});

    await expect(runAdapter({ commonChange, writer })).rejects.toThrow("idempotency conflict");
    expect(writer).not.toHaveBeenCalled();
  });

  it("fails closed before mutation when lifecycle preflight is rejected", async () => {
    const commonChange = context({ registry: createRegistry({ rejectPreflight: true }) });
    const writer = vi.fn(async () => {});

    await expect(runAdapter({ commonChange, writer })).rejects.toThrow("preflight rejected");
    expect(writer).not.toHaveBeenCalled();
  });

  it("does not record applied when the writer fails", async () => {
    const commonChange = context();

    await expect(
      runAdapter({
        commonChange,
        writer: async () => {
          throw new Error("writer failed");
        },
      }),
    ).rejects.toThrow("writer failed");

    expect((commonChange.registry as ReturnType<typeof createRegistry>).states).toEqual([
      "preflight_passed",
      "failed",
    ]);
  });

  it("moves to rollback_pending when read-back does not confirm the mutation", async () => {
    const commonChange = context();

    await expect(
      runAdapter({
        commonChange,
        after: snapshot({ gateway: { port: "18000" } }, "after"),
      }),
    ).rejects.toThrow("common_change_config_set_blocked:expected_mutation_not_confirmed");

    expect((commonChange.registry as ReturnType<typeof createRegistry>).states).toEqual([
      "preflight_passed",
      "rollback_pending",
    ]);
  });

  it("moves to rollback_pending when unrelated configuration difference is detected", async () => {
    const commonChange = context();

    await expect(
      runAdapter({
        commonChange,
        after: snapshot({ gateway: { port: "19001" }, messages: { ackReaction: ":)" } }, "after"),
      }),
    ).rejects.toThrow("common_change_config_set_blocked:unrelated_config_difference");

    expect((commonChange.registry as ReturnType<typeof createRegistry>).states).toEqual([
      "preflight_passed",
      "rollback_pending",
    ]);
  });

  it("uses distinct idempotency keys for create and every transition", async () => {
    const commonChange = context({ idempotencyKey: "idem-distinct" });

    await runAdapter({ commonChange });

    expect(commonChange.registry?.create_operation).toHaveBeenCalledWith(
      expect.any(Object),
      0,
      "idem-distinct:create",
    );
    expect(
      (commonChange.registry?.transition_operation as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[8],
      ),
    ).toEqual([
      "idem-distinct:preflight_passed",
      "idem-distinct:applied",
      "idem-distinct:post_action_pending",
    ]);
  });

  it("allows same-value idempotent writes without duplicating an unrelated diff", async () => {
    const commonChange = context();

    const { runConfigSet } = await runAdapter({
      commonChange,
      before: snapshot({ gateway: { port: "19001" } }, "before"),
      after: snapshot({ gateway: { port: "19001" } }, "before"),
    });

    expect(runConfigSet).toHaveBeenCalledTimes(1);
    expect((commonChange.registry as ReturnType<typeof createRegistry>).states).toEqual([
      "preflight_passed",
      "applied",
      "post_action_pending",
    ]);
    const appliedCall = (
      commonChange.registry?.transition_operation as ReturnType<typeof vi.fn>
    ).mock.calls.find((call) => call[1] === "applied");
    expect(appliedCall?.[3]).toMatchObject({
      changed_paths: [],
      idempotent_noop: true,
    });
  });

  it("does not accept caller-supplied closure data as authoritative", async () => {
    const commonChange = {
      ...context(),
      callerNarrative: "closed",
      lifecycle_state: "closed",
      validation_result: "PASS",
    } as CrestodianConfigSetCommonChangeContext;

    await runAdapter({ commonChange });

    expect((commonChange.registry as ReturnType<typeof createRegistry>).states).toEqual([
      "preflight_passed",
      "applied",
      "post_action_pending",
    ]);
  });
});
