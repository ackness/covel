export interface PersistedPendingBlockRecord {
  blockId: string;
  sessionId: string;
  flowId: string;
  turnId: string;
  blockEnvelope?: Record<string, unknown>;
  packageName?: string;
  resumeHandler?: string;
}

export interface PendingBlockStore {
  save(input: PersistedPendingBlockRecord): Promise<void>;
  getByBlockId(blockId: string): Promise<PersistedPendingBlockRecord | null>;
  delete(blockId: string): Promise<void>;
}

export type StorageRepositoriesWithPendingBlocks = {
  pendingBlocks: PendingBlockStore;
};
