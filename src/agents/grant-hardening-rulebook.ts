import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";

export type GrantBoundaryLock = {
  scoped_closeout_rule: string;
  owner_rule: string;
  command_rule: string;
  ambiguity_rule: string;
  promotion_rule: string;
};

export type GrantRulebookVerification = {
  verifiedAt: string;
  doctrinePath: string;
  doctrineSha256: string;
  correctionsPath: string;
  correctionsSha256: string;
  contractPath: string;
  contractSha256: string;
  boundaryLock: GrantBoundaryLock;
  checklistPath?: string;
  checklistSha256?: string;
  closeoutGatePath?: string;
  closeoutGateSha256?: string;
  afterActionAuditPath?: string;
  afterActionAuditSha256?: string;
};

export type GrantRulebook = {
  doctrine: string;
  corrections: string;
  contractRecord: unknown;
  checklist?: string;
  closeoutGate?: string;
  afterActionAudit?: string;
  verification: GrantRulebookVerification;
};

type GrantHardeningRulebookModule = {
  loadGrantHardeningRulebook(params: {
    workspaceDir?: string;
    includeRunArtifacts?: boolean;
  }): Promise<GrantRulebook>;
  buildGrantRunInjection(rulebook: GrantRulebook): {
    systemPromptSuffix: string;
    taskMessageSuffix: string;
  };
  attachGrantRulebookMetadata<T extends Record<string, unknown>>(
    record: T,
    verification: GrantRulebookVerification,
  ): T & {
    grantRulebook: {
      verifiedAt: string;
      doctrinePath: string;
      doctrineSha256: string;
      correctionsPath: string;
      correctionsSha256: string;
      contractPath: string;
      contractSha256: string;
      boundaryLock: GrantBoundaryLock;
    };
  };
};

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const grantHardeningRulebookModuleUrl = pathToFileURL(
  path.join(OPENCLAW_PACKAGE_ROOT, "scripts", "lib", "grant-hardening-rulebook.mjs"),
).href;

let grantHardeningRulebookModulePromise: Promise<GrantHardeningRulebookModule> | undefined;
let grantHardeningRulebookModule: GrantHardeningRulebookModule | undefined;

async function loadModule(): Promise<GrantHardeningRulebookModule> {
  if (grantHardeningRulebookModule) return grantHardeningRulebookModule;
  grantHardeningRulebookModulePromise ??= import(
    grantHardeningRulebookModuleUrl
  ) as Promise<GrantHardeningRulebookModule>;
  grantHardeningRulebookModule = await grantHardeningRulebookModulePromise;
  return grantHardeningRulebookModule;
}

function requireLoadedModule(): GrantHardeningRulebookModule {
  if (!grantHardeningRulebookModule) {
    throw new Error(
      "Grant hardening rulebook module was used before loadGrantHardeningRulebook initialized it.",
    );
  }
  return grantHardeningRulebookModule;
}

export async function loadGrantHardeningRulebook(params: {
  workspaceDir?: string;
  includeRunArtifacts?: boolean;
}): Promise<GrantRulebook> {
  const module = await loadModule();
  return module.loadGrantHardeningRulebook(params);
}

export function buildGrantRunInjection(rulebook: GrantRulebook): {
  systemPromptSuffix: string;
  taskMessageSuffix: string;
} {
  return requireLoadedModule().buildGrantRunInjection(rulebook);
}

export function attachGrantRulebookMetadata<T extends Record<string, unknown>>(
  record: T,
  verification: GrantRulebookVerification,
): T & {
  grantRulebook: {
    verifiedAt: string;
    doctrinePath: string;
    doctrineSha256: string;
    correctionsPath: string;
    correctionsSha256: string;
    contractPath: string;
    contractSha256: string;
    boundaryLock: GrantBoundaryLock;
  };
} {
  return requireLoadedModule().attachGrantRulebookMetadata(record, verification);
}
