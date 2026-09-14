function resolveGrantRetirementRequestModuleUrl(): string {
  const currentUrl = new URL(import.meta.url);
  const relativeModulePath = currentUrl.pathname.includes("/dist/")
    ? "../scripts/lib/grant-retirement-request.mjs"
    : "../../scripts/lib/grant-retirement-request.mjs";
  return new URL(relativeModulePath, currentUrl).href;
}

type GrantRetirementRequestModule = {
  createGrantRetirementRequest(
    params: CreateGrantRetirementRequestParams,
  ): Promise<CreateGrantRetirementRequestResult>;
  GRANT_RETIREMENT_ALLOWED_REASONS: readonly string[];
};

export type GrantRetirementAllowedReason = (typeof GRANT_RETIREMENT_ALLOWED_REASONS)[number];

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

const grantRetirementRequestModule = (await import(
  resolveGrantRetirementRequestModuleUrl()
)) as GrantRetirementRequestModule;

export const GRANT_RETIREMENT_ALLOWED_REASONS =
  grantRetirementRequestModule.GRANT_RETIREMENT_ALLOWED_REASONS;

export async function createGrantRetirementRequest(
  params: CreateGrantRetirementRequestParams,
): Promise<CreateGrantRetirementRequestResult> {
  return await grantRetirementRequestModule.createGrantRetirementRequest(params);
}
