/**
 * StoragePort — unified frontend storage entry point.
 *
 * Detects persistent vs ephemeral mode and returns the appropriate adapter.
 * Local scope always uses IDB regardless of mode.
 */
import type { StorageAdapter } from './types';
import { IdbStorageAdapter } from './idbStorageAdapter';
import { ApiStorageAdapter } from './apiStorageAdapter';

let _persistent: boolean | null = null;

async function detectPersistent(): Promise<boolean> {
  if (_persistent !== null) return _persistent;
  try {
    const base = String(import.meta.env.VITE_API_BASE_URL || '').trim() || '/api';
    const url = base.endsWith('/') ? `${base}health` : `${base}/health`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      _persistent = !!data.storage_persistent;
    } else {
      _persistent = false;
    }
  } catch {
    _persistent = false;
  }
  return _persistent;
}

export class StoragePort {
  private api: ApiStorageAdapter | null;
  private idb: IdbStorageAdapter;
  public readonly persistent: boolean;
  private constructor(
    api: ApiStorageAdapter | null,
    idb: IdbStorageAdapter,
    persistent: boolean,
  ) {
    this.api = api;
    this.idb = idb;
    this.persistent = persistent;
  }

  static async create(sessionId?: string): Promise<StoragePort> {
    const persistent = await detectPersistent();
    const idb = new IdbStorageAdapter();
    const api = persistent ? new ApiStorageAdapter(sessionId) : null;
    return new StoragePort(api, idb, persistent);
  }

  /** Get the adapter for a given scope. Local always uses IDB. */
  adapter(scope: 'local'): IdbStorageAdapter;
  adapter(scope: string): StorageAdapter;
  adapter(scope: string): StorageAdapter {
    if (scope === 'local') return this.idb;
    return this.api ?? this.idb;
  }

  /** Reset detection cache (for testing). */
  static resetDetection(): void {
    _persistent = null;
  }
}
