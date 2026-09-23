import type { TaskFlowStatus } from "./task-flow-registry.types.js";

export type ParentFlowLinkErrorCode =
  | "scope_kind_not_session"
  | "parent_flow_not_found"
  | "owner_key_mismatch"
  | "cancel_requested"
  | "child_creation_closed"
  | "terminal";

export class ParentFlowLinkError extends Error {
  constructor(
    public readonly code: ParentFlowLinkErrorCode,
    message: string,
    public readonly details?: {
      flowId?: string;
      status?: TaskFlowStatus;
    },
  ) {
    super(message);
    this.name = "ParentFlowLinkError";
  }
}

export function isParentFlowLinkError(error: unknown): error is ParentFlowLinkError {
  return error instanceof ParentFlowLinkError;
}
