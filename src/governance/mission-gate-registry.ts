import type { AcceptanceGate, EvidenceReceipt, MissionIdentity } from "./mission-manifest.types.js";
import { identityMatches } from "./mission-manifest.types.js";

export function latestPassingReceiptForGate(params: {
  gate: AcceptanceGate;
  receipts: readonly EvidenceReceipt[];
  identity: MissionIdentity;
  now: string;
}): EvidenceReceipt | undefined {
  const candidates = params.receipts
    .filter((receipt) => receipt.gateId === params.gate.id && receipt.status === "passed")
    .filter((receipt) => identityMatches(receipt, params.identity))
    .toSorted((a, b) => Date.parse(b.producedAt) - Date.parse(a.producedAt));
  const latest = candidates[0];
  if (!latest) {
    return undefined;
  }
  if (
    params.gate.freshnessMs !== undefined &&
    Date.parse(params.now) - Date.parse(latest.producedAt) > params.gate.freshnessMs
  ) {
    return undefined;
  }
  return latest;
}
