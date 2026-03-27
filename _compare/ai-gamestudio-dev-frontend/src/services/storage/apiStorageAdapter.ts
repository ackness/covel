/**
 * API StorageAdapter — delegates to backend REST endpoints.
 * Used in persistent mode when backend storage is available.
 *
 * Stub implementation: will be fully wired when backend /api/storage/* endpoints land.
 */
import type { Scope, StorageAdapter } from './types';

function getBaseUrl(): string {
  const configured = String(import.meta.env.VITE_API_BASE_URL || '').trim();
  const base = configured || '/api';
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`StorageAPI ${res.status}: ${path}`);
  return res.json();
}

export class ApiStorageAdapter implements StorageAdapter {
  private sessionId?: string;
  constructor(sessionId?: string) { this.sessionId = sessionId; }

  async kvGet(
    scope: Scope, ns: string, collection: string, key: string,
  ): Promise<unknown | null> {
    const sid = this.scopeParam(scope);
    return request(`/storage/${sid}/${ns}/${collection}/${key}`);
  }

  async kvSet(
    scope: Scope, ns: string, collection: string, key: string, value: unknown,
  ): Promise<void> {
    const sid = this.scopeParam(scope);
    await request(`/storage/${sid}/${ns}/${collection}/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  }

  async kvQuery(
    scope: Scope, ns: string, collection: string,
  ): Promise<Record<string, unknown>> {
    const sid = this.scopeParam(scope);
    return request(`/storage/${sid}/${ns}/${collection}`);
  }

  async kvDelete(
    scope: Scope, ns: string, collection: string, key: string,
  ): Promise<void> {
    const sid = this.scopeParam(scope);
    await request(`/storage/${sid}/${ns}/${collection}/${key}`, {
      method: 'DELETE',
    });
  }

  async logAppend(
    scope: Scope, ns: string, collection: string, entry: unknown,
  ): Promise<void> {
    const sid = this.scopeParam(scope);
    await request(`/storage/${sid}/${ns}/${collection}/log`, {
      method: 'POST',
      body: JSON.stringify({ entry }),
    });
  }

  async logQuery(
    scope: Scope, ns: string, collection: string, limit = 50,
  ): Promise<unknown[]> {
    const sid = this.scopeParam(scope);
    return request(`/storage/${sid}/${ns}/${collection}/log?limit=${limit}`);
  }

  async graphAdd(
    scope: Scope, ns: string,
    fromId: string, toId: string, relation: string, data?: unknown,
  ): Promise<void> {
    const sid = this.scopeParam(scope);
    await request(`/storage/${sid}/${ns}/graph`, {
      method: 'POST',
      body: JSON.stringify({ from_id: fromId, to_id: toId, relation, data }),
    });
  }

  async graphQuery(
    scope: Scope, ns: string, collection: string, nodeId?: string,
  ): Promise<unknown[]> {
    const sid = this.scopeParam(scope);
    const qs = nodeId ? `?node_id=${nodeId}` : '';
    return request(`/storage/${sid}/${ns}/${collection}/graph${qs}`);
  }

  private scopeParam(scope: Scope): string {
    if (scope === 'session' && this.sessionId) return `session:${this.sessionId}`;
    return scope;
  }
}
