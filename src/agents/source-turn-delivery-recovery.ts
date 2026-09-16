import type { MessageReceipt } from "../channels/message/types.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import type { QueuedDelivery } from "../infra/outbound/delivery-queue.js";
import {
  prepareExternalSourceDeliveryQueueOwner,
  recordRecoveredExternalSourceDelivery,
  SOURCE_TURN_DELIVERY_QUEUE_OWNER_KIND,
  type ExternalSourceDeliveryQueueIdentity,
} from "./source-turn-delivery-store.js";

function sourceOwnerIdentity(entry: QueuedDelivery): ExternalSourceDeliveryQueueIdentity {
  return {
    queueId: entry.id,
    channel: entry.channel,
    to: entry.to,
    ...(entry.accountId !== undefined ? { accountId: entry.accountId } : {}),
    ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
    payloads: entry.payloads,
    ...(entry.owner ? { owner: entry.owner } : {}),
  };
}

function wakeSourceOwner(sourceSessionKey: string): void {
  requestHeartbeat({
    source: "subagent-progress",
    intent: "event",
    reason: "source-continuation-pending",
    sessionKey: sourceSessionKey,
  });
}

/** Shared owner callbacks for startup and channel reconnect queue recovery. */
export function createSourceTurnDeliveryRecoveryCallbacks(params: { registryPath?: string } = {}): {
  isRecoveryCommitted: (entry: QueuedDelivery) => Promise<boolean>;
  commitRecoveredDelivery: (
    entry: QueuedDelivery,
    receipt: MessageReceipt | undefined,
  ) => Promise<void>;
} {
  return {
    isRecoveryCommitted: async (entry) => {
      if (entry.owner?.kind !== SOURCE_TURN_DELIVERY_QUEUE_OWNER_KIND) {
        return false;
      }
      const owner = await prepareExternalSourceDeliveryQueueOwner({
        ...(params.registryPath !== undefined ? { registryPath: params.registryPath } : {}),
        identity: sourceOwnerIdentity(entry),
      });
      if (owner.status !== "delivered") {
        return false;
      }
      wakeSourceOwner(owner.sourceSessionKey);
      return true;
    },
    commitRecoveredDelivery: async (entry, receipt) => {
      if (entry.owner?.kind !== SOURCE_TURN_DELIVERY_QUEUE_OWNER_KIND) {
        return;
      }
      const identity = sourceOwnerIdentity(entry);
      const owner = await prepareExternalSourceDeliveryQueueOwner({
        ...(params.registryPath !== undefined ? { registryPath: params.registryPath } : {}),
        identity,
      });
      if (owner.status === "not_owned") {
        return;
      }
      if (!receipt?.platformMessageIds.length) {
        throw new Error(`Recovered source delivery ${entry.id} has no transport receipt`);
      }
      const committed = await recordRecoveredExternalSourceDelivery({
        ...(params.registryPath !== undefined ? { registryPath: params.registryPath } : {}),
        identity,
        receipt,
      });
      if (committed.status === "delivered") {
        wakeSourceOwner(committed.sourceSessionKey);
      }
    },
  };
}
