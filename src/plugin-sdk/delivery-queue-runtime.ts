import {
  drainPendingDeliveries as coreDrainPendingDeliveries,
  type DeliverFn,
} from "../infra/outbound/delivery-queue.js";

type OutboundDeliverRuntimeModule = typeof import("../infra/outbound/deliver-runtime.js");
type SourceTurnDeliveryRecoveryModule = typeof import("../agents/source-turn-delivery-recovery.js");
type DrainPendingDeliveriesOptions = Omit<
  Parameters<typeof coreDrainPendingDeliveries>[0],
  "commitRecoveredDelivery" | "deliver" | "isRecoveryCommitted"
> & {
  deliver?: DeliverFn;
};

let outboundDeliverRuntimePromise: Promise<OutboundDeliverRuntimeModule> | null = null;
let sourceTurnDeliveryRecoveryPromise: Promise<SourceTurnDeliveryRecoveryModule> | null = null;

async function loadOutboundDeliverRuntime(): Promise<OutboundDeliverRuntimeModule> {
  outboundDeliverRuntimePromise ??= import("../infra/outbound/deliver-runtime.js");
  return await outboundDeliverRuntimePromise;
}

async function loadSourceTurnDeliveryRecovery(): Promise<SourceTurnDeliveryRecoveryModule> {
  sourceTurnDeliveryRecoveryPromise ??= import("../agents/source-turn-delivery-recovery.js");
  return await sourceTurnDeliveryRecoveryPromise;
}

export async function drainPendingDeliveries(opts: DrainPendingDeliveriesOptions): Promise<void> {
  const deliver =
    opts.deliver ?? (await loadOutboundDeliverRuntime()).deliverOutboundPayloadsInternal;
  const { createSourceTurnDeliveryRecoveryCallbacks } = await loadSourceTurnDeliveryRecovery();
  await coreDrainPendingDeliveries({
    ...opts,
    deliver,
    ...createSourceTurnDeliveryRecoveryCallbacks(),
  });
}
