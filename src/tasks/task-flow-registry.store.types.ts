import type { TaskFlowRecord } from "./task-flow-registry.types.js";

export type TaskFlowRegistryStoreSnapshot = {
  flows: Map<string, TaskFlowRecord>;
};

export class TaskFlowRevisionConflictError extends Error {
  constructor() {
    super("TaskFlow revision changed in shared state");
    this.name = "TaskFlowRevisionConflictError";
  }
}
