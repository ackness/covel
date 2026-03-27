/**
 * Unified storage abstraction types for frontend.
 * Mirrors backend StoragePort scope/interface design.
 */

export type Scope = 'session' | 'project' | 'local' | 'global';

export interface StorageAdapter {
  // KV operations
  kvGet(scope: Scope, ns: string, collection: string, key: string): Promise<unknown | null>;
  kvSet(scope: Scope, ns: string, collection: string, key: string, value: unknown): Promise<void>;
  kvQuery(scope: Scope, ns: string, collection: string): Promise<Record<string, unknown>>;
  kvDelete(scope: Scope, ns: string, collection: string, key: string): Promise<void>;

  // Log operations
  logAppend(scope: Scope, ns: string, collection: string, entry: unknown): Promise<void>;
  logQuery(scope: Scope, ns: string, collection: string, limit?: number): Promise<unknown[]>;

  // Graph operations
  graphAdd(scope: Scope, ns: string, fromId: string, toId: string, relation: string, data?: unknown): Promise<void>;
  graphQuery(scope: Scope, ns: string, collection: string, nodeId?: string): Promise<unknown[]>;
}
