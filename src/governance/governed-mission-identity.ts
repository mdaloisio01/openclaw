import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readRegularFileSync, walkDirectorySync } from "../infra/fs-safe.js";
import { buildWorkspaceSkillSnapshot } from "../skills/loading/workspace.js";
import type { SkillSnapshot } from "../skills/types.js";
import type { GovernedAuthorityRef } from "./governed-mission-contract.js";
import type { GovernedMissionState } from "./governed-mission-state.js";
import type { GovernedMissionIdentityBindings } from "./governed-mission-transition.js";

const AUTHORITY_MAX_BYTES = 10 * 1024 * 1024;
const BUILD_INFO_MAX_BYTES = 1024 * 1024;
const RUNTIME_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const RUNTIME_GRAPH_MAX_BYTES = 256 * 1024 * 1024;
const RUNTIME_GRAPH_MAX_ENTRIES = 50_000;
const GOVERNED_SKILL_MAX_BYTES = 256_000;
const EXECUTABLE_JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

export type GovernedRuntimeIdentity = {
  sourceRevision: string;
  runtimeBuildSha256: string;
};

let currentRuntimeIdentity: GovernedRuntimeIdentity | undefined;
let currentRuntimeIdentityMeasured = false;

export function resolveGovernedAuthorityPath(uri: string): string {
  const withoutFragment = uri.split("#", 1)[0] ?? "";
  const pathname = withoutFragment.startsWith("file:")
    ? fileURLToPath(withoutFragment)
    : withoutFragment;
  if (!path.isAbsolute(pathname)) {
    throw new Error("governed authority URI must resolve to an absolute local file");
  }
  return pathname;
}

export function readGovernedAuthoritySha256(
  authorityRef: GovernedAuthorityRef,
): string | undefined {
  try {
    const pathname = resolveGovernedAuthorityPath(authorityRef.uri);
    const body = readRegularFileSync({ filePath: pathname, maxBytes: AUTHORITY_MAX_BYTES }).buffer;
    return createHash("sha256").update(body).digest("hex");
  } catch {
    return undefined;
  }
}

/** Remeasure host-owned identity instead of comparing persisted mission values to themselves. */
export function observeGovernedMissionIdentity(params: {
  mission: Pick<
    GovernedMissionState,
    "contractHash" | "authorityRef" | "planRevisionId" | "policyVersion" | "skillSha256"
  >;
  trustedRuntimeIdentity?: GovernedRuntimeIdentity;
  observedSkillSha256?: string;
}): GovernedMissionIdentityBindings | undefined {
  const authorityHash = readGovernedAuthoritySha256(params.mission.authorityRef);
  const runtimeIdentity = params.trustedRuntimeIdentity ?? readCurrentGovernedRuntimeIdentity();
  if (!authorityHash || !runtimeIdentity || !params.observedSkillSha256) {
    return undefined;
  }
  return {
    contractHash: params.mission.contractHash,
    authorityHash,
    planRevisionId: params.mission.planRevisionId,
    sourceRevision: runtimeIdentity.sourceRevision,
    runtimeBuildSha256: runtimeIdentity.runtimeBuildSha256,
    policyVersion: params.mission.policyVersion,
    skillSha256: params.observedSkillSha256,
  };
}

/** Hash the exact skill instructions in the host-resolved snapshot. */
export function readGovernedSkillSnapshotSha256(
  snapshot: Pick<SkillSnapshot, "resolvedSkills"> | undefined,
): string | undefined {
  if (!snapshot?.resolvedSkills) {
    return undefined;
  }
  try {
    const skills = snapshot.resolvedSkills
      .map((skill) => ({
        name: skill.name,
        bodySha256: createHash("sha256")
          .update(
            readRegularFileSync({
              filePath: skill.filePath,
              maxBytes: GOVERNED_SKILL_MAX_BYTES,
            }).buffer,
          )
          .digest("hex"),
      }))
      .toSorted(
        (left, right) =>
          left.name.localeCompare(right.name, "en") ||
          left.bodySha256.localeCompare(right.bodySha256, "en"),
      );
    return createHash("sha256")
      .update("openclaw-governed-skill-snapshot-v1\0")
      .update(JSON.stringify(skills))
      .digest("hex");
  } catch {
    return undefined;
  }
}

export function readGovernedWorkspaceSkillSha256(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
}): string | undefined {
  try {
    return readGovernedSkillSnapshotSha256(
      buildWorkspaceSkillSnapshot(params.workspaceDir, {
        config: params.config,
        agentId: params.agentId,
      }),
    );
  } catch {
    return undefined;
  }
}

export function readCurrentGovernedRuntimeIdentity(): GovernedRuntimeIdentity | undefined {
  if (!currentRuntimeIdentityMeasured) {
    currentRuntimeIdentityMeasured = true;
    const runtimeArtifactPath = fileURLToPath(import.meta.url);
    currentRuntimeIdentity =
      path.extname(runtimeArtifactPath) === ".js"
        ? readGovernedRuntimeIdentityFromArtifactPath(runtimeArtifactPath)
        : undefined;
  }
  return currentRuntimeIdentity;
}

export function readGovernedRuntimeIdentityFromArtifactPath(
  runtimeArtifactPath: string,
): GovernedRuntimeIdentity | undefined {
  try {
    const moduleDir = path.dirname(runtimeArtifactPath);
    const buildInfo = readRegularFileSync({
      filePath: path.join(moduleDir, "build-info.json"),
      maxBytes: BUILD_INFO_MAX_BYTES,
    }).buffer;
    const parsed = JSON.parse(buildInfo.toString("utf8")) as {
      commit?: unknown;
      dirty?: unknown;
    };
    const sourceRevision = boundedString(parsed.commit, 128);
    if (!sourceRevision || parsed.dirty !== false) {
      return undefined;
    }
    const scan = walkDirectorySync(moduleDir, {
      maxEntries: RUNTIME_GRAPH_MAX_ENTRIES,
      symlinks: "include",
      include: (entry) =>
        (entry.kind === "file" || entry.kind === "symlink") &&
        EXECUTABLE_JAVASCRIPT_EXTENSIONS.has(path.extname(entry.name)),
    });
    if (scan.truncated || scan.entries.some((entry) => entry.kind !== "file")) {
      return undefined;
    }
    const artifacts = scan.entries.toSorted((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    if (
      !artifacts.some((entry) => path.resolve(entry.path) === path.resolve(runtimeArtifactPath))
    ) {
      return undefined;
    }
    const hash = createHash("sha256");
    hash.update("openclaw-governed-runtime-v1\0");
    hash.update("build-info.json\0");
    hash.update(buildInfo);
    hash.update("\0");
    let totalBytes = 0;
    for (const artifact of artifacts) {
      const body = readRegularFileSync({
        filePath: artifact.path,
        maxBytes: RUNTIME_ARTIFACT_MAX_BYTES,
      }).buffer;
      totalBytes += body.byteLength;
      if (totalBytes > RUNTIME_GRAPH_MAX_BYTES) {
        return undefined;
      }
      hash.update(artifact.relativePath.replaceAll(path.sep, "/"));
      hash.update("\0");
      hash.update(body);
      hash.update("\0");
    }
    return {
      sourceRevision,
      runtimeBuildSha256: hash.digest("hex"),
    };
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}
