import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coreDrainPendingDeliveries: vi.fn(async () => {}),
  deliverOutboundPayloads: vi.fn(async () => []),
  isRecoveryCommitted: vi.fn(async () => false),
  commitRecoveredDelivery: vi.fn(async () => {}),
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  drainPendingDeliveries: mocks.coreDrainPendingDeliveries,
}));

vi.mock("../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../agents/source-turn-delivery-recovery.js", () => ({
  createSourceTurnDeliveryRecoveryCallbacks: () => ({
    isRecoveryCommitted: mocks.isRecoveryCommitted,
    commitRecoveredDelivery: mocks.commitRecoveredDelivery,
  }),
}));

type DeliveryQueueRuntimeModule = typeof import("./delivery-queue-runtime.js");

let drainPendingDeliveries: DeliveryQueueRuntimeModule["drainPendingDeliveries"];

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeAll(async () => {
  ({ drainPendingDeliveries } = await import("./delivery-queue-runtime.js"));
});

beforeEach(() => {
  mocks.coreDrainPendingDeliveries.mockClear();
  mocks.deliverOutboundPayloads.mockClear();
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});

describe("plugin-sdk delivery queue drainPendingDeliveries", () => {
  it("injects the lazy outbound deliver runtime when no deliver fn is provided", async () => {
    await drainPendingDeliveries({
      drainKey: "demo:test",
      logLabel: "Demo reconnect drain",
      cfg: {},
      log,
      selectEntry: () => ({ match: false }),
    });

    expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledTimes(1);
    const [[{ deliver: lazyDeliver }]] = mocks.coreDrainPendingDeliveries.mock
      .calls as unknown as Array<[{ deliver?: unknown }]>;
    expect(lazyDeliver).toBe(mocks.deliverOutboundPayloads);
    expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        isRecoveryCommitted: mocks.isRecoveryCommitted,
        commitRecoveredDelivery: mocks.commitRecoveredDelivery,
      }),
    );
  });

  it("preserves an explicit deliver fn without loading the lazy runtime", async () => {
    const deliver = vi.fn(async () => []);

    await drainPendingDeliveries({
      drainKey: "demo:test",
      logLabel: "Demo reconnect drain",
      cfg: {},
      log,
      deliver,
      selectEntry: () => ({ match: false }),
    });

    expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledTimes(1);
    const [[{ deliver: explicitDeliver }]] = mocks.coreDrainPendingDeliveries.mock
      .calls as unknown as Array<[{ deliver?: unknown }]>;
    expect(explicitDeliver).toBe(deliver);
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
