/**
 * Minimal store interface for the session kernel commit path.
 */

export interface KernelStore {
  addMessage(record: {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    metadata?: unknown;
    createdAt: string;
  }): Promise<void>;
  updateSession(id: string, patch: Record<string, unknown>): Promise<void>;
  saveEvent(record: {
    id: string;
    sessionId: string;
    type: string;
    topic: string;
    payload: unknown;
    createdAt: string;
  }): Promise<void>;
  addStateChange(record: {
    id: string;
    sessionId: string;
    tableName: string;
    fieldName: string;
    value: unknown;
    changedBy: string;
    turnId: string;
    reason?: string;
    createdAt: string;
  }): Promise<void>;
  addTraceEvent(record: {
    id: string;
    sessionId: string;
    type: string;
    traceId: string;
    turnId: string;
    payload: unknown;
    createdAt: string;
  }): Promise<void>;
  upsertCharacter?(record: {
    id: string;
    sessionId: string;
    name: string;
    type: string;
    description?: string;
    fields?: unknown;
    version: number;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  setPluginData?(record: {
    id: string;
    sessionId: string;
    pluginId: string;
    namespace: string;
    key: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  setPluginDataBatch?(
    records: readonly {
      id: string;
      sessionId: string;
      pluginId: string;
      namespace: string;
      key: string;
      value: unknown;
      createdAt: string;
      updatedAt: string;
    }[],
  ): Promise<void>;
  /**
   * Working Memory upsert (S3-T3). Optional so the kernel stays compatible
   * with thin mock stores in existing tests that don't need WM.
   */
  upsertWorkingMemory?(record: {
    id: string;
    sessionId: string;
    key: string;
    scope: "player" | "story" | "shared";
    value: unknown;
    schemaRef?: string;
    updatedAt: string;
  }): Promise<void>;
  /**
   * Session lorebook upsert (S3-T2). Optional for the same reason as
   * upsertWorkingMemory — thin mock stores may not implement it.
   */
  upsertLorebookEntries?(
    records: ReadonlyArray<{
      id: string;
      sessionId: string;
      pluginId: string;
      keys: readonly string[];
      content: string;
      strategy: "constant" | "selective";
      position: string;
      insertionOrder: number;
      enabled: boolean;
      extra?: unknown;
      createdAt: string;
      updatedAt: string;
    }>,
  ): Promise<void>;
  /**
   * Scoped transaction API (preferred). When present, `commitAll()` runs the
   * whole proposal chain inside a single `withTransaction` callback so a
   * mid-chain failure auto-rolls-back and leaves no partial state. The callback
   * receives a transaction-bound store view — commit handlers write through
   * that `tx`, not the outer store, so on PostgreSQL the chain runs on an
   * isolated pooled connection instead of serializing the whole store behind a
   * shared begin/commit window.
   *
   * Optional so thin mock stores (and any backend without scoped transactions)
   * remain assignable; `commitAll()` falls back to a non-transactional loop
   * when it is absent.
   */
  withTransaction?<T>(fn: (tx: KernelStore) => Promise<T>): Promise<T>;

  /**
   * Imperative transaction shim — retained for backward compatibility and thin
   * mock stores. The commit pipeline no longer drives these directly; it
   * prefers {@link KernelStore.withTransaction}.
   */
  beginTx?(): Promise<void>;
  commitTx?(): Promise<void>;
  rollbackTx?(): Promise<void>;
}
