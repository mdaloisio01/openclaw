import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROTECTED_SURFACE_REGISTRY,
  evaluateControlPlaneActivation,
  type ControlPlaneActivationInput,
} from "./control-plane-protection.js";

const now = new Date("2026-07-13T19:00:00Z");
const baseConfig = {
  agents: { list: [{ id: "main", default: true }] },
  browser: { allowPrivateNetwork: false },
  gateway: { auth: { mode: "token" } },
  memory: { backend: "qmd" },
  secrets: { providers: { gatewaytokenfile: { source: "file" } } },
  tools: { exec: { mode: "auto" } },
};

function raw(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value, "utf-8").digest("hex");
}

function manifestRequiredFields() {
  return {
    objective: "test scoped control-plane change",
    activationTimestamp: "2026-07-13T19:00:00.000Z",
    allowedFiles: ["/tmp/openclaw-control-plane/staged/candidate.json"],
    forbiddenFiles: ["/home/will/.openclaw/control-plane/live/openclaw.json"],
    allowedServices: ["openclaw-gateway.service"],
    allowedRestartScope: "none",
    allowedAgents: ["orchestrator"],
    allowedTools: ["control-plane-writer"],
    requiredEvidence: ["focused-test"],
    rollbackAssets: ["/tmp/openclaw-control-plane/rollback/candidate.rollback"],
    stopConditions: ["manifest mismatch"],
    doneCriteria: ["scoped write accepted"],
  } as const;
}

function validInput(
  overrides: Partial<ControlPlaneActivationInput> = {},
): ControlPlaneActivationInput {
  const candidateConfig = overrides.candidateConfig ?? {
    ...baseConfig,
    browser: { allowPrivateNetwork: true },
  };
  const candidateRaw = overrides.candidateRaw ?? raw(candidateConfig);
  const candidateSha256 = hash(candidateRaw);
  const manifest = overrides.manifest ?? {
    manifestId: "manifest-1",
    ...manifestRequiredFields(),
    candidateSha256,
    allowedConfigPaths: ["browser"],
    approvalClasses: ["browser"],
    expiresAt: "2026-07-13T20:00:00Z",
  };
  const approval = overrides.approval ?? {
    approvalId: "approval-1",
    manifestId: "manifest-1",
    candidateSha256,
    approvalClasses: ["browser"],
    approved: true,
    expiresAt: "2026-07-13T20:00:00Z",
  };
  return {
    beforeConfig: baseConfig,
    candidateConfig,
    candidateRaw,
    manifest,
    approval,
    now,
    candidatePath: "/tmp/openclaw-control-plane/staged/candidate.json",
    stagingRoot: "/tmp/openclaw-control-plane/staged",
    actor: "orchestrator",
    tool: "control-plane-writer",
    requestedServices: [],
    restartScope: "none",
    auditSinkAvailable: true,
    rollbackSinkAvailable: true,
    ...overrides,
  };
}

describe("control-plane protection enforcement", () => {
  it("defines a machine-readable protected-surface contract for every default rule", () => {
    for (const rule of DEFAULT_PROTECTED_SURFACE_REGISTRY) {
      expect(rule.path).toEqual(expect.any(String));
      expect(rule.approvalClass).toEqual(expect.any(String));
      expect(["critical", "high", "medium"]).toContain(rule.riskClass);
      expect(rule.owner).toBe("control-plane-protection");
      expect(rule.allowedWriter).toBe("control-plane-writer");
      expect(rule.requiredTests.length).toBeGreaterThan(0);
      expect(rule.requiredRuntimeProof.length).toBeGreaterThan(0);
      expect(rule.rollbackRequired).toBe(true);
    }
  });

  it("keeps specific auth approval ahead of generic gateway runtime approval", () => {
    const authIndex = DEFAULT_PROTECTED_SURFACE_REGISTRY.findIndex(
      (rule) => rule.path === "gateway.auth",
    );
    const gatewayIndex = DEFAULT_PROTECTED_SURFACE_REGISTRY.findIndex(
      (rule) => rule.path === "gateway",
    );

    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(gatewayIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeLessThan(gatewayIndex);
  });

  it("requires auth approval for gateway auth changes instead of generic runtime approval", () => {
    const candidateConfig = { ...baseConfig, gateway: { auth: { mode: "none" } } };
    const candidateRaw = raw(candidateConfig);
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateConfig,
        candidateRaw,
        manifest: {
          manifestId: "manifest-auth",
          ...manifestRequiredFields(),
          candidateSha256: hash(candidateRaw),
          allowedConfigPaths: ["gateway.auth"],
          approvalClasses: ["runtime"],
          expiresAt: "2026-07-13T20:00:00Z",
        },
        approval: {
          approvalId: "approval-auth",
          manifestId: "manifest-auth",
          candidateSha256: hash(candidateRaw),
          approvalClasses: ["runtime"],
          approved: true,
          expiresAt: "2026-07-13T20:00:00Z",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "missing_approval_class" });
  });

  it("allows an approved scoped change", () => {
    const decision = evaluateControlPlaneActivation(validInput());

    expect(decision).toMatchObject({
      ok: true,
      noOp: false,
      changedPaths: ["browser.allowPrivateNetwork"],
      requiredApprovalClasses: ["browser"],
    });
  });

  it("handles a hash-identical no-op activation", () => {
    const candidateRaw = raw(baseConfig);
    const candidateSha256 = hash(candidateRaw);
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateConfig: baseConfig,
        candidateRaw,
        manifest: {
          manifestId: "manifest-noop",
          ...manifestRequiredFields(),
          candidateSha256,
          allowedConfigPaths: [],
          expiresAt: "2026-07-13T20:00:00Z",
        },
        approval: {
          approvalId: "approval-noop",
          manifestId: "manifest-noop",
          candidateSha256,
          approvalClasses: [],
          approved: true,
          expiresAt: "2026-07-13T20:00:00Z",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: true, noOp: true, changedPaths: [] });
  });

  it("rejects a modified candidate after approval", () => {
    const approvedRaw = raw({ ...baseConfig, browser: { allowPrivateNetwork: true } });
    const tampered = { ...baseConfig, browser: { allowPrivateNetwork: true, extra: true } };
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateConfig: tampered,
        candidateRaw: raw(tampered),
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          candidateSha256: hash(approvedRaw),
          allowedConfigPaths: ["browser"],
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "candidate_manifest_mismatch" });
  });

  it("rejects a manifest/candidate mismatch", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          candidateSha256: "wrong",
          allowedConfigPaths: ["browser"],
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "candidate_manifest_mismatch" });
  });

  it("rejects manifests missing required work-order scope fields", () => {
    const candidateConfig = { ...baseConfig, browser: { allowPrivateNetwork: true } };
    const candidateRaw = raw(candidateConfig);
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateConfig,
        candidateRaw,
        manifest: {
          manifestId: "manifest-1",
          candidateSha256: hash(candidateRaw),
          allowedConfigPaths: ["browser"],
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "malformed_manifest" });
  });

  it("rejects candidate files outside declared manifest file scope", () => {
    const candidateConfig = { ...baseConfig, browser: { allowPrivateNetwork: true } };
    const candidateRaw = raw(candidateConfig);
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateConfig,
        candidateRaw,
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          allowedFiles: ["/tmp/openclaw-control-plane/staged/other.json"],
          candidateSha256: hash(candidateRaw),
          allowedConfigPaths: ["browser"],
          approvalClasses: ["browser"],
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "allowed_section_escape" });
  });

  it("rejects unauthorized actors outside manifest scope", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        actor: "unknown-agent",
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "unauthorized_actor" });
  });

  it("rejects unauthorized tools outside manifest scope", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        tool: "doctor",
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "unauthorized_tool" });
  });

  it("rejects unauthorized service restart scope", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        requestedServices: ["other.service"],
        restartScope: "gateway",
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          candidateSha256: hash(raw({ ...baseConfig, browser: { allowPrivateNetwork: true } })),
          allowedConfigPaths: ["browser"],
          approvalClasses: ["browser"],
          allowedServices: ["openclaw-gateway.service"],
          allowedRestartScope: "gateway",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "unauthorized_service_restart" });
  });

  it("rejects restart scope expansion beyond the manifest", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        requestedServices: ["openclaw-gateway.service"],
        restartScope: "gateway",
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          candidateSha256: hash(raw({ ...baseConfig, browser: { allowPrivateNetwork: true } })),
          allowedConfigPaths: ["browser"],
          approvalClasses: ["browser"],
          allowedRestartScope: "none",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "restart_scope_expansion" });
  });

  it("rejects an approval/manifest mismatch", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        approval: {
          approvalId: "approval-1",
          manifestId: "other",
          candidateSha256: hash(raw({ ...baseConfig, browser: { allowPrivateNetwork: true } })),
          approvalClasses: ["browser"],
          approved: true,
          expiresAt: "2026-07-13T20:00:00Z",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "approval_manifest_mismatch" });
  });

  it("rejects an allowed-section escape", () => {
    const candidateConfig = { ...baseConfig, tools: { exec: { mode: "manual" } } };
    const candidateRaw = raw(candidateConfig);
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateConfig,
        candidateRaw,
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          candidateSha256: hash(candidateRaw),
          allowedConfigPaths: ["browser"],
        },
        approval: {
          approvalId: "approval-1",
          manifestId: "manifest-1",
          candidateSha256: hash(candidateRaw),
          approvalClasses: ["browser"],
          approved: true,
          expiresAt: "2026-07-13T20:00:00Z",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "allowed_section_escape" });
  });

  it("rejects forbidden-section mutation", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          candidateSha256: hash(raw({ ...baseConfig, browser: { allowPrivateNetwork: true } })),
          allowedConfigPaths: ["browser"],
          forbiddenConfigPaths: ["browser"],
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "forbidden_section_mutation" });
  });

  it("rejects protected deletion", () => {
    const { browser: _browser, ...candidateConfig } = baseConfig;
    const candidateRaw = raw(candidateConfig);
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateConfig,
        candidateRaw,
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          candidateSha256: hash(candidateRaw),
          allowedConfigPaths: ["browser"],
          approvalClasses: ["browser"],
        },
        approval: {
          approvalId: "approval-1",
          manifestId: "manifest-1",
          candidateSha256: hash(candidateRaw),
          approvalClasses: ["browser"],
          approved: true,
          expiresAt: "2026-07-13T20:00:00Z",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "protected_deletion" });
  });

  it("rejects unauthorized new section", () => {
    const candidateConfig = { ...baseConfig, surprise: { enabled: true } };
    const candidateRaw = raw(candidateConfig);
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateConfig,
        candidateRaw,
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          candidateSha256: hash(candidateRaw),
          allowedConfigPaths: ["surprise"],
        },
        approval: {
          approvalId: "approval-1",
          manifestId: "manifest-1",
          candidateSha256: hash(candidateRaw),
          approvalClasses: ["control"],
          approved: true,
          expiresAt: "2026-07-13T20:00:00Z",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "unknown_section" });
  });

  it("rejects approval replay", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({ seenApprovalIds: new Set(["approval-1"]) }),
    );

    expect(decision).toMatchObject({ ok: false, code: "approval_replay" });
  });

  it("rejects expired approval", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        approval: {
          approvalId: "approval-1",
          manifestId: "manifest-1",
          candidateSha256: hash(raw({ ...baseConfig, browser: { allowPrivateNetwork: true } })),
          approvalClasses: ["browser"],
          approved: true,
          expiresAt: "2026-07-13T18:00:00Z",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "approval_expired" });
  });

  it("rejects missing audit sink", () => {
    const decision = evaluateControlPlaneActivation(validInput({ auditSinkAvailable: false }));

    expect(decision).toMatchObject({ ok: false, code: "audit_unavailable" });
  });

  it("rejects missing rollback sink", () => {
    const decision = evaluateControlPlaneActivation(validInput({ rollbackSinkAvailable: false }));

    expect(decision).toMatchObject({ ok: false, code: "rollback_unavailable" });
  });

  it("rejects malformed diff input", () => {
    const decision = evaluateControlPlaneActivation(validInput({ beforeConfig: "bad" }));

    expect(decision).toMatchObject({ ok: false, code: "malformed_config" });
  });

  it("rejects symlink candidates", () => {
    const decision = evaluateControlPlaneActivation(validInput({ candidateIsSymlink: true }));

    expect(decision).toMatchObject({ ok: false, code: "candidate_symlink" });
  });

  it("rejects symlink candidates before path traversal", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateIsSymlink: true,
        candidatePath: "/tmp/openclaw-control-plane/outside/candidate.json",
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "candidate_symlink" });
  });

  it("rejects broken symlink candidates deterministically", () => {
    const decision = evaluateControlPlaneActivation(validInput({ candidateIsSymlink: true }));

    expect(decision).toMatchObject({ ok: false, code: "candidate_symlink" });
  });

  it("rejects chained symlink candidates deterministically", () => {
    const decision = evaluateControlPlaneActivation(validInput({ candidateIsSymlink: true }));

    expect(decision).toMatchObject({ ok: false, code: "candidate_symlink" });
  });

  it("rejects path traversal", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({ candidatePath: "/tmp/openclaw-control-plane/outside/candidate.json" }),
    );

    expect(decision).toMatchObject({ ok: false, code: "path_traversal" });
  });

  it("rejects candidate replacement race", () => {
    const approvedRaw = raw({ ...baseConfig, browser: { allowPrivateNetwork: true } });
    const raceRaw = raw({ ...baseConfig, browser: { allowPrivateNetwork: false } });
    const decision = evaluateControlPlaneActivation(
      validInput({
        candidateConfig: { ...baseConfig, browser: { allowPrivateNetwork: false } },
        candidateRaw: raceRaw,
        manifest: {
          manifestId: "manifest-1",
          ...manifestRequiredFields(),
          candidateSha256: hash(approvedRaw),
          allowedConfigPaths: ["browser"],
        },
        approval: {
          approvalId: "approval-1",
          manifestId: "manifest-1",
          candidateSha256: hash(approvedRaw),
          approvalClasses: ["browser"],
          approved: true,
          expiresAt: "2026-07-13T20:00:00Z",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "candidate_manifest_mismatch" });
  });

  it("rejects protected changes without matching approval class", () => {
    const decision = evaluateControlPlaneActivation(
      validInput({
        approval: {
          approvalId: "approval-1",
          manifestId: "manifest-1",
          candidateSha256: hash(raw({ ...baseConfig, browser: { allowPrivateNetwork: true } })),
          approvalClasses: ["agents"],
          approved: true,
          expiresAt: "2026-07-13T20:00:00Z",
        },
      }),
    );

    expect(decision).toMatchObject({ ok: false, code: "missing_approval_class" });
  });
});
