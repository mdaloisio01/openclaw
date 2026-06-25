declare module "../../scripts/lib/grant-hardening-rulebook.mjs" {
  export const GRANT_HARDENING_RELATIVE_PATHS: {
    doctrine: string;
    corrections: string;
    contract: string;
    checklist: string;
    closeoutGate: string;
    afterActionAudit: string;
  };

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

  export function loadGrantHardeningRulebook(params: {
    workspaceDir?: string;
    includeRunArtifacts?: boolean;
  }): Promise<GrantRulebook>;

  export function buildGrantRunInjection(rulebook: GrantRulebook): {
    systemPromptSuffix: string;
    taskMessageSuffix: string;
  };

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
  };
}

declare module "../../scripts/lib/grant-retirement-request.mjs" {
  export const GRANT_RETIREMENT_ALLOWED_REASONS: readonly [
    "obsolete_rule",
    "superseded_by_higher_quality_rule",
    "false_positive_pattern",
    "capability_materially_fixed",
  ];

  export type CreateGrantRetirementRequestParams = {
    workspace: string;
    outcomeCode: string;
    reason: string;
    evidence?: string;
    proofPaths?: string[];
    notes?: string;
    requestedBy?: string;
    approvedBy?: string;
    requestedAt?: string;
    approvedAt?: string;
    dryRun?: boolean;
  };

  export type CreateGrantRetirementRequestResult = {
    ok: true;
    dryRun: boolean;
    requestPath: string;
    queuePath: string;
    outcomeCode: string;
    reason: string;
  };

  export function createGrantRetirementRequest(
    params: CreateGrantRetirementRequestParams,
  ): Promise<CreateGrantRetirementRequestResult>;
}
