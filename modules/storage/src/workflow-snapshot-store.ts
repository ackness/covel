import type { WorkflowSnapshotRecord } from "../../contracts/src/index.js";

export interface WorkflowSnapshotStore {
  save(record: WorkflowSnapshotRecord): Promise<void>;
  getByRunId(runId: string): Promise<WorkflowSnapshotRecord | null>;
  listBySessionId(sessionId: string): Promise<WorkflowSnapshotRecord[]>;
}

export type StorageRepositoriesWithWorkflowSnapshots = {
  workflowSnapshots: WorkflowSnapshotStore;
};
