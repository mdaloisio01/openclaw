import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOVERNED_ARTIFACT_FAILURE_CODES,
  GOVERNED_ARTIFACT_MAX_FILES,
  evaluateGovernedArtifactFact,
  normalizeGovernedArtifactDeclarations,
  verifyGovernedArtifacts,
  type GovernedArtifactDeclaration,
  type GovernedArtifactFact,
} from "./governed-artifact-verifier.js";

const roots: string[] = [];

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governed-artifacts-"));
  roots.push(root);
  const body = `${JSON.stringify({ missionId: "mission-1", planRevisionId: "plan-1", ok: true })}\n`;
  const pathname = path.join(root, "proof.json");
  await fs.writeFile(pathname, body);
  const declaration: GovernedArtifactDeclaration = {
    artifactId: "proof",
    artifactKind: "validation",
    missionId: "mission-1",
    workOrderId: "work-1",
    gateId: "gate-1",
    allowedRoot: root,
    pathname,
    required: true,
    minBytes: 1,
    maxBytes: 4096,
    expectedSha256: createHash("sha256").update(body).digest("hex"),
    requiredLabels: ["missionId", "planRevisionId"],
    requiredJsonFields: { ok: "true" },
    identityBindings: { missionId: "mission-1", planRevisionId: "plan-1" },
  };
  return { root, pathname, declaration };
}

const context = {
  missionId: "mission-1",
  workOrderId: "work-1",
  gateId: "gate-1",
  gateKind: "test" as const,
  operation: "verifyRequiredArtifacts",
  flowRevision: 7,
  observedAtMs: Date.parse("2026-09-17T00:00:00.000Z"),
};

describe("governed artifact verifier", () => {
  it("accepts only bounded required declarations inside non-secret absolute roots", async () => {
    const { declaration } = await fixture();

    expect(normalizeGovernedArtifactDeclarations([declaration])).toEqual([declaration]);
    expect(normalizeGovernedArtifactDeclarations([{ ...declaration, required: false }])).toBeNull();
    expect(
      normalizeGovernedArtifactDeclarations([
        { ...declaration, allowedRoot: "/safe", pathname: "/outside/proof.json" },
      ]),
    ).toBeNull();
    expect(
      normalizeGovernedArtifactDeclarations([
        {
          ...declaration,
          allowedRoot: "/safe/credentials",
          pathname: "/safe/credentials/proof.json",
        },
      ]),
    ).toBeNull();
    for (const basename of [".env", ".npmrc", ".git-credentials", "signing-key.pem"]) {
      expect(
        normalizeGovernedArtifactDeclarations([
          { ...declaration, pathname: path.join(declaration.allowedRoot, basename) },
        ]),
      ).toBeNull();
    }
    for (const relativePath of [
      ".config/gh/hosts.yml",
      ".docker/config.json",
      ".git/config",
      ".kube/config",
    ]) {
      expect(
        normalizeGovernedArtifactDeclarations([
          { ...declaration, pathname: path.join(declaration.allowedRoot, relativePath) },
        ]),
      ).toBeNull();
    }
  });

  it("accepts exact bounded bytes with matching labels, fields, hash, and identity", async () => {
    const { declaration } = await fixture();
    const result = await verifyGovernedArtifacts([declaration], context);
    expect(result.requiredPassed).toBe(true);
    expect(result.results[0]).toMatchObject({
      artifactId: "proof",
      status: "verified",
      flowRevision: 7,
      computedSha256: declaration.expectedSha256,
    });
  });

  it("rejects an allowed root redirected through a symlink", async () => {
    const { declaration } = await fixture();
    const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governed-root-link-"));
    roots.push(linkParent);
    const redirectedRoot = path.join(linkParent, "mission-root");
    await fs.symlink(declaration.allowedRoot, redirectedRoot, "dir");

    const result = await verifyGovernedArtifacts(
      [
        {
          ...declaration,
          allowedRoot: redirectedRoot,
          pathname: path.join(redirectedRoot, path.basename(declaration.pathname)),
        },
      ],
      context,
    );

    expect(result.results[0]).toMatchObject({
      status: "rejected",
      failureCode: "symlink_escape",
    });
  });

  it("re-reads exact bytes and rejects an artifact changed after an earlier pass", async () => {
    const { declaration, pathname } = await fixture();
    expect((await verifyGovernedArtifacts([declaration], context)).requiredPassed).toBe(true);

    await fs.writeFile(pathname, '{"missionId":"mission-1","planRevisionId":"changed"}\n');
    const reverified = await verifyGovernedArtifacts([declaration], context);

    expect(reverified.requiredPassed).toBe(false);
    expect(reverified.results[0]).toMatchObject({
      status: "rejected",
      failureCode: "hash_mismatch",
    });
  });

  it.each([
    [
      "missing",
      async (item: GovernedArtifactDeclaration) => ({
        ...item,
        pathname: `${item.pathname}.missing`,
      }),
    ],
    [
      "hash_mismatch",
      async (item: GovernedArtifactDeclaration) => ({ ...item, expectedSha256: "bad" }),
    ],
    [
      "required_label_missing",
      async (item: GovernedArtifactDeclaration) => ({ ...item, requiredLabels: ["absent-label"] }),
    ],
    [
      "identity_mismatch",
      async (item: GovernedArtifactDeclaration) => ({
        ...item,
        identityBindings: { missionId: "other" },
      }),
    ],
  ] as const)("returns %s with a specific repair action", async (failureCode, mutate) => {
    const { declaration } = await fixture();
    const result = await verifyGovernedArtifacts([await mutate(declaration)], context);
    expect(result.requiredPassed).toBe(false);
    expect(result.results[0]).toMatchObject({ status: "rejected", failureCode });
    expect(result.nextAction).toContain("Repair artifact proof");
  });

  it("rejects traversal and symlink escape and allows a missing optional artifact", async () => {
    const { root, declaration } = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governed-outside-"));
    roots.push(outside);
    const outsideFile = path.join(outside, "outside.txt");
    await fs.writeFile(outsideFile, "outside");
    const link = path.join(root, "escape.txt");
    await fs.symlink(outsideFile, link);

    const result = await verifyGovernedArtifacts(
      [
        { ...declaration, artifactId: "traversal", pathname: outsideFile },
        { ...declaration, artifactId: "symlink", pathname: link },
        {
          ...declaration,
          artifactId: "optional",
          pathname: path.join(root, "optional-missing.txt"),
          required: false,
        },
      ],
      context,
    );
    expect(
      result.results.map((entry) => [entry.artifactId, entry.status, entry.failureCode]),
    ).toEqual([
      ["optional", "optional_missing", "missing"],
      ["symlink", "rejected", "symlink_escape"],
      ["traversal", "rejected", "outside_allowed_root"],
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "rejects an ancestor symlink rebound between validation and open",
    async () => {
      const { root, declaration } = await fixture();
      const inside = path.join(root, "inside");
      const movedInside = path.join(root, "inside-before-race");
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governed-race-outside-"));
      roots.push(outside);
      await fs.mkdir(inside);
      await fs.writeFile(path.join(inside, "proof.json"), "inside");
      await fs.writeFile(path.join(outside, "proof.json"), "outside");
      const pathname = path.join(inside, "proof.json");
      let rebound = false;
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (openedPath) => {
          if (rebound || openedPath !== pathname) {
            return;
          }
          rebound = true;
          await fs.rename(inside, movedInside);
          await fs.symlink(outside, inside);
        },
      });

      const result = await verifyGovernedArtifacts(
        [
          {
            ...declaration,
            pathname,
            expectedSha256: undefined,
            requiredLabels: undefined,
            requiredJsonFields: undefined,
            identityBindings: undefined,
          },
        ],
        context,
      );

      expect(result.results[0]).toMatchObject({
        status: "rejected",
        failureCode: "symlink_escape",
      });
    },
  );

  it("rejects an in-root hardlink to an out-of-root proof inode", async () => {
    const { root, declaration } = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governed-hardlink-outside-"));
    roots.push(outside);
    const outsidePath = path.join(outside, "proof.json");
    const hardlinkPath = path.join(root, "hardlink-proof.json");
    await fs.copyFile(declaration.pathname, outsidePath);
    try {
      await fs.link(outsidePath, hardlinkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw error;
    }

    const result = await verifyGovernedArtifacts(
      [{ ...declaration, pathname: hardlinkPath }],
      context,
    );

    expect(result.results[0]).toMatchObject({
      status: "rejected",
      failureCode: "outside_allowed_root",
    });
  });

  it("returns every closed failure code deterministically", async () => {
    const { root, pathname } = await fixture();
    const declaration: GovernedArtifactDeclaration = {
      artifactId: "proof",
      artifactKind: "validation",
      missionId: "mission-1",
      workOrderId: "work-1",
      gateId: "gate-1",
      allowedRoot: root,
      pathname,
      required: true,
    };
    const validFact: GovernedArtifactFact = {
      declaredPath: pathname,
      canonicalPath: pathname,
      canonicalRoot: root,
      lexicalInsideRoot: true,
      exists: true,
      readable: true,
      regularFile: true,
      sizeBytes: 2,
      modifiedAtMs: context.observedAtMs,
      computedSha256: "actual",
      contentText: "ok",
      parsedJson: { ok: true },
    };
    const collectorCodes = [
      "missing",
      "unreadable",
      "wrong_type",
      "outside_allowed_root",
      "symlink_escape",
      "forbidden_secret_path",
      "invalid_declaration",
      "verifier_internal_error",
    ] as const;
    const observed = new Set<string>();
    for (const collectorFailure of collectorCodes) {
      observed.add(
        evaluateGovernedArtifactFact(declaration, { ...validFact, collectorFailure }, context)
          .failureCode!,
      );
    }
    const contentCases: Array<{
      declaration?: Partial<GovernedArtifactDeclaration>;
      fact?: Partial<GovernedArtifactFact>;
      context?: Partial<typeof context>;
    }> = [
      { fact: { sizeBytes: 0, contentText: "" } },
      { declaration: { minBytes: 3 } },
      { declaration: { maxBytes: 1 } },
      { declaration: { requiredLabels: ["missing"] } },
      { declaration: { requiredJsonFields: { missing: "value" } } },
      { declaration: { expectedSha256: "expected" } },
      { declaration: { minModifiedAtMs: context.observedAtMs + 1 } },
      { context: { missionId: "other-mission" } },
    ];
    for (const item of contentCases) {
      observed.add(
        evaluateGovernedArtifactFact(
          { ...declaration, ...item.declaration },
          { ...validFact, ...item.fact },
          { ...context, ...item.context },
        ).failureCode!,
      );
    }
    expect([...observed].toSorted()).toEqual([...GOVERNED_ARTIFACT_FAILURE_CODES].toSorted());
  });

  it("bounds the number of filesystem declarations evaluated", async () => {
    const { declaration } = await fixture();
    const declarations = Array.from({ length: GOVERNED_ARTIFACT_MAX_FILES + 1 }, (_, index) => ({
      ...declaration,
      artifactId: `artifact-${String(index).padStart(3, "0")}`,
    }));

    const result = await verifyGovernedArtifacts(declarations, context);

    expect(result.results).toHaveLength(GOVERNED_ARTIFACT_MAX_FILES + 1);
    expect(result.results.at(-1)).toMatchObject({
      artifactId: `artifact-${GOVERNED_ARTIFACT_MAX_FILES}`,
      status: "rejected",
      failureCode: "invalid_declaration",
    });
  });
});
