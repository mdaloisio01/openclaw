import type {
  MissionIdentity,
  RestorationReceipt,
  RollbackReceipt,
} from "./mission-manifest.types.js";
import { identityMatches } from "./mission-manifest.types.js";

export function rollbackReceiptValid(
  receipt: RollbackReceipt | undefined,
  identity: MissionIdentity,
): boolean {
  return Boolean(
    receipt &&
    receipt.schema === "openclaw.rollback_receipt.v1" &&
    receipt.executed === true &&
    receipt.targetStateSha256 &&
    identityMatches(receipt, identity),
  );
}

export function restorationReceiptValid(
  receipt: RestorationReceipt | undefined,
  identity: MissionIdentity,
): boolean {
  return Boolean(
    receipt &&
    receipt.schema === "openclaw.restoration_receipt.v1" &&
    receipt.executed === true &&
    receipt.restoredStateSha256 &&
    identityMatches(receipt, identity),
  );
}
