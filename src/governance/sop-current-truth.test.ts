import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  requireCurrentSopArtifact,
  resolveSopCurrentTruth as resolveRaw,
} from "./sop-current-truth.js";

function resolveSopCurrentTruth(
  input: readonly Record<string, unknown>[],
  currentContext: Parameters<typeof resolveRaw>[1],
) {
  return resolveRaw(
    input.map((artifact) => {
      if ("proofBindings" in artifact || !Array.isArray(artifact.proofPaths)) {
        return artifact;
      }
      const proofBindings = artifact.proofPaths
        .filter((proofPath): proofPath is string => typeof proofPath === "string")
        .filter((proofPath) => fs.existsSync(proofPath) && fs.lstatSync(proofPath).isFile())
        .map((proofPath) => ({
          path: proofPath,
          sha256: createHash("sha256").update(fs.readFileSync(proofPath)).digest("hex"),
          artifactId: artifact.id,
          role: artifact.role,
          scope: artifact.scope,
          sourceRevision: artifact.sourceRevision,
        }));
      return { ...artifact, proofBindings };
    }),
    currentContext,
  );
}

const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sop-current-truth-"));
const proof = (name: string) => {
  const proofPath = path.join(proofRoot, name);
  fs.writeFileSync(proofPath, "verified proof\n");
  return proofPath;
};
afterAll(() => fs.rmSync(proofRoot, { recursive: true, force: true }));

const context = {
  activeScope: "full-production-sop",
  activeRevision: "f8b3f29b9d",
  activePlanId: "plan-current",
  now: "2026-09-24T18:40:00.000Z",
  requiredWatchdogCoverage: ["worker", "delivery", "runtime", "native_tool_result"],
};

const artifacts = [
  {
    id: "plan-prior",
    role: "build_plan",
    scope: context.activeScope,
    issuedAt: "2026-09-15T08:00:00.000Z",
  },
  {
    id: "plan-current",
    role: "build_plan",
    scope: context.activeScope,
    issuedAt: "2026-09-15T13:11:00.000Z",
    supersedes: ["plan-prior"],
  },
  {
    id: "bounded-closeout",
    role: "closeout",
    scope: context.activeScope,
    issuedAt: "2026-09-15T13:00:00.000Z",
    bounded: true,
    sourceRevision: context.activeRevision,
    proofPaths: [proof("bounded-test-proof.json")],
  },
  {
    id: "issue-old",
    role: "issue_status",
    scope: context.activeScope,
    key: "SYSTEMWIDE-PRODUCTION-SOP-FLOW-TEST-20260915",
    issuedAt: "2026-09-15T12:57:00.000Z",
  },
  {
    id: "issue-current",
    role: "issue_status",
    scope: context.activeScope,
    key: "SYSTEMWIDE-PRODUCTION-SOP-FLOW-TEST-20260915",
    issuedAt: "2026-09-24T18:10:00.000Z",
  },
  {
    id: "old-runtime",
    role: "runtime_proof",
    scope: context.activeScope,
    issuedAt: "2026-09-24T18:00:00.000Z",
    sourceRevision: "e2b20879a6",
    proofPaths: [proof("phase10-activation-proof.json")],
  },
  {
    id: "incomplete-watchdog",
    role: "watchdog_proof",
    scope: context.activeScope,
    issuedAt: "2026-09-24T18:03:00.000Z",
    sourceRevision: context.activeRevision,
    coverage: ["worker", "delivery", "runtime"],
    proofPaths: [proof("watchdog-clean.json")],
  },
  {
    id: "expired-readiness",
    role: "readiness_report",
    scope: context.activeScope,
    issuedAt: "2026-09-15T15:00:00.000Z",
    expiresAt: "2026-09-22T15:00:00.000Z",
    sourceRevision: context.activeRevision,
    proofPaths: [proof("old-readiness.json")],
  },
  {
    id: "research",
    role: "research",
    scope: context.activeScope,
    issuedAt: "2026-09-15T07:50:00.000Z",
  },
] as const;

describe("SOP current-truth resolution", () => {
  it("keeps bounded, superseded, stale, and incomplete proof out of active routing", () => {
    const resolved = resolveSopCurrentTruth(artifacts, context);
    const classes = Object.fromEntries(
      resolved.map((result) => [result.artifact.id, result.classification]),
    );
    expect(classes).toMatchObject({
      "plan-prior": "superseded",
      "plan-current": "current",
      "bounded-closeout": "partially_stale",
      "issue-old": "stale",
      "issue-current": "current",
      "old-runtime": "stale",
      "incomplete-watchdog": "partially_stale",
      "expired-readiness": "stale",
      research: "support",
    });
    expect(requireCurrentSopArtifact(resolved, "build_plan").id).toBe("plan-current");
    expect(requireCurrentSopArtifact(resolved, "issue_status").id).toBe("issue-current");
    expect(() => requireCurrentSopArtifact(resolved, "readiness_report")).toThrow();
    expect(
      resolved.find((item) => item.artifact.id === "bounded-closeout")?.unsafeReadings,
    ).toContain("full_closeout_claim");
  });

  it("rejects missing active plan identity, ambiguous current issues, and invalid supersession", () => {
    expect(() =>
      resolveSopCurrentTruth(artifacts, { ...context, activePlanId: undefined }),
    ).toThrow("plan identity");
    const sameTime = [
      ...artifacts,
      {
        id: "issue-tie",
        role: "issue_status",
        scope: context.activeScope,
        key: "SYSTEMWIDE-PRODUCTION-SOP-FLOW-TEST-20260915",
        issuedAt: "2026-09-24T18:10:00.000Z",
      },
    ];
    expect(() =>
      requireCurrentSopArtifact(resolveSopCurrentTruth(sameTime, context), "issue_status"),
    ).toThrow("2 current routing candidates");
    const badSupersession = [{ ...artifacts[1], supersedes: ["missing-prior"] }];
    expect(() => resolveSopCurrentTruth(badSupersession, context)).toThrow();
  });

  it("keeps an eligible issue status when a future record exists", () => {
    const future = {
      id: "issue-future",
      role: "issue_status",
      scope: context.activeScope,
      key: "SYSTEMWIDE-PRODUCTION-SOP-FLOW-TEST-20260915",
      issuedAt: "2026-09-24T19:00:00.000Z",
      supersedes: ["issue-current"],
    };
    const resolved = resolveSopCurrentTruth([...artifacts, future], context);
    expect(requireCurrentSopArtifact(resolved, "issue_status").id).toBe("issue-current");
    expect(resolved.find((item) => item.artifact.id === future.id)?.classification).toBe(
      "partially_stale",
    );
  });

  it("keeps the designated plan despite a newer unapproved draft", () => {
    const draft = {
      id: "plan-draft",
      role: "build_plan",
      scope: context.activeScope,
      issuedAt: "2026-09-24T18:30:00.000Z",
    };
    const resolved = resolveSopCurrentTruth([...artifacts, draft], context);
    expect(requireCurrentSopArtifact(resolved, "build_plan").id).toBe("plan-current");
    expect(resolved.find((item) => item.artifact.id === draft.id)?.classification).toBe(
      "superseded",
    );
  });

  it("ignores plans from another scope when no plan is active here", () => {
    const historical = { ...artifacts[1], scope: "completed-other-mission", supersedes: [] };
    const resolved = resolveSopCurrentTruth([historical], {
      ...context,
      activePlanId: undefined,
    });
    expect(resolved[0].classification).toBe("archive_only");
  });

  it("rejects supersession across distinct issue identities", () => {
    const otherIssue = {
      id: "other-issue",
      role: "issue_status",
      scope: context.activeScope,
      key: "OTHER-ISSUE",
      issuedAt: "2026-09-24T18:20:00.000Z",
      supersedes: ["issue-current"],
    };
    expect(() => resolveSopCurrentTruth([...artifacts, otherIssue], context)).toThrow(
      "invalid SOP supersession",
    );
  });

  it("rejects closeout proof from a different or unknown source revision", () => {
    const closeout = {
      id: "complete-closeout",
      role: "closeout",
      scope: context.activeScope,
      issuedAt: "2026-09-24T18:15:00.000Z",
      proofPaths: [proof("complete-closeout.md")],
    };
    expect(
      resolveSopCurrentTruth([closeout], { ...context, activePlanId: undefined })[0].canRoute,
    ).toBe(false);
    expect(
      resolveSopCurrentTruth([{ ...closeout, sourceRevision: "old-revision" }], {
        ...context,
        activePlanId: undefined,
      })[0].canRoute,
    ).toBe(false);
    expect(
      resolveSopCurrentTruth([{ ...closeout, sourceRevision: context.activeRevision }], {
        ...context,
        activePlanId: undefined,
      })[0].canRoute,
    ).toBe(true);
  });

  it("does not let newer ineligible proof stale the active-revision proof", () => {
    const matching = {
      id: "runtime-current",
      role: "runtime_proof",
      scope: context.activeScope,
      issuedAt: "2026-09-24T18:15:00.000Z",
      sourceRevision: context.activeRevision,
      proofPaths: [proof("runtime-current.json")],
    };
    const wrongRevision = {
      ...matching,
      id: "runtime-newer-wrong-revision",
      issuedAt: "2026-09-24T18:20:00.000Z",
      sourceRevision: "other-revision",
    };
    const resolved = resolveSopCurrentTruth([matching, wrongRevision], {
      ...context,
      activePlanId: undefined,
    });
    expect(requireCurrentSopArtifact(resolved, "runtime_proof").id).toBe(matching.id);
    expect(resolved[1].classification).toBe("stale");
  });

  it("keeps build-state and export readings bound to source and proof", () => {
    const interpretation = {
      id: "build-state",
      role: "build_state_interpretation",
      scope: context.activeScope,
      issuedAt: "2026-09-24T18:10:00.000Z",
      sourceRevision: context.activeRevision,
      proofPaths: [proof("build-state-proof.json")],
    };
    const ownContext = { ...context, activePlanId: undefined };
    expect(resolveSopCurrentTruth([interpretation], ownContext)[0].canRoute).toBe(true);
    expect(
      resolveSopCurrentTruth([{ ...interpretation, proofPaths: [] }], ownContext)[0].classification,
    ).toBe("partially_stale");
    expect(
      resolveSopCurrentTruth(
        [{ ...interpretation, role: "export", sourceRevision: "old-revision" }],
        ownContext,
      )[0].classification,
    ).toBe("stale");
  });

  it("rejects missing, empty, and directory proof paths", () => {
    const empty = path.join(proofRoot, "empty.json");
    const directory = path.join(proofRoot, "directory");
    fs.writeFileSync(empty, "");
    fs.mkdirSync(directory);
    for (const proofPath of [path.join(proofRoot, "missing.json"), empty, directory]) {
      const artifact = {
        id: "proof-boundary",
        role: "runtime_proof",
        scope: context.activeScope,
        issuedAt: "2026-09-24T18:10:00.000Z",
        sourceRevision: context.activeRevision,
        proofPaths: [proofPath],
      };
      const resolved = resolveSopCurrentTruth([artifact], { ...context, activePlanId: undefined });
      expect(resolved[0].classification).toBe("partially_stale");
      expect(resolved[0].canRoute).toBe(false);
    }
  });

  it("rejects proof bound to another artifact or changed bytes", () => {
    const proofPath = proof("closeout-bound.md");
    const artifact = {
      id: "closeout-bound",
      role: "closeout",
      scope: context.activeScope,
      issuedAt: "2026-09-24T18:10:00.000Z",
      sourceRevision: context.activeRevision,
      proofPaths: [proofPath],
    };
    const ownContext = { ...context, activePlanId: undefined };
    const valid = resolveSopCurrentTruth([artifact], ownContext)[0].artifact;
    expect(resolveSopCurrentTruth([valid], ownContext)[0].canRoute).toBe(true);
    const wrongArtifact = {
      ...valid,
      proofBindings: [{ ...valid.proofBindings[0], artifactId: "other-closeout" }],
    };
    expect(resolveSopCurrentTruth([wrongArtifact], ownContext)[0].classification).toBe(
      "partially_stale",
    );
    fs.writeFileSync(proofPath, "changed proof\n");
    expect(resolveSopCurrentTruth([valid], ownContext)[0].classification).toBe("partially_stale");
  });

  it("keeps a fresh report current only through its explicit recurrence deadline", () => {
    const report = {
      id: "readiness-current",
      role: "readiness_report",
      scope: context.activeScope,
      issuedAt: "2026-09-24T18:00:00.000Z",
      expiresAt: "2026-10-01T18:00:00.000Z",
      sourceRevision: context.activeRevision,
      proofPaths: [proof("readiness-current.json")],
    };
    expect(
      resolveSopCurrentTruth([report], { ...context, activePlanId: undefined })[0].classification,
    ).toBe("current");
    expect(
      resolveSopCurrentTruth([report], {
        ...context,
        activePlanId: undefined,
        now: "2026-10-02T00:00:00.000Z",
      })[0].classification,
    ).toBe("stale");
  });
});
