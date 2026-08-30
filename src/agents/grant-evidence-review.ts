import type {
  GrantApprovalReceipt,
  MissionIdentity,
} from "../governance/mission-manifest.types.js";
import { identityMatches } from "../governance/mission-manifest.types.js";

export function grantApprovalFresh(params: {
  approval: GrantApprovalReceipt | undefined;
  identity: MissionIdentity;
  evidenceManifestSha256: string;
}): boolean {
  return Boolean(
    params.approval &&
    params.approval.schema === "openclaw.grant_approval.v1" &&
    params.approval.reviewer === "Grant" &&
    params.approval.approved &&
    params.approval.evidenceManifestSha256 === params.evidenceManifestSha256 &&
    identityMatches(params.approval, params.identity),
  );
}
