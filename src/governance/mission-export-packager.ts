import type { ExportManifest, MissionIdentity } from "./mission-manifest.types.js";
import { identityMatches } from "./mission-manifest.types.js";

export function exportManifestComplete(
  manifest: ExportManifest | undefined,
  identity: MissionIdentity,
): boolean {
  if (!manifest || manifest.schema !== "openclaw.export_manifest.v1") {
    return false;
  }
  if (!identityMatches(manifest, identity)) {
    return false;
  }
  return manifest.items
    .filter((item) => item.required)
    .every((item) => Boolean(item.path && item.sha256 && typeof item.sizeBytes === "number"));
}
