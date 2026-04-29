import type { SettingKey, SettingsBackendAdapter } from '../types.js';

interface CovelIpcApiShape {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
}

function getIpc(): CovelIpcApiShape | null {
  if (typeof globalThis === 'undefined') return null;
  const w = globalThis as unknown as { covelIpc?: CovelIpcApiShape };
  return w.covelIpc ?? null;
}

interface JsonFileBackendOptions {
  /** Defaults to `/api/config/settings`. */
  readonly restEndpoint?: string;
  /** Defaults to `/api/config/keys`. */
  readonly restSecretsEndpoint?: string;
  /** Optional fetch override for testing. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Returns headers to merge into every privileged REST call. Used to
   * attach `Authorization: Bearer <token>` when the desktop shell injected
   * `COVEL_DESKTOP_REST_TOKEN` into the sidecar. Returning `{}` is fine —
   * the server gate is also no-op when the token env var is absent.
   */
  readonly getAuthHeaders?: () => Record<string, string>;
}

/**
 * Desktop backend. Writes to `<covelHome>/settings.json` via one of:
 *  1. Electron IPC (`covel:settings:*` channels) when the preload bridge is
 *     present (`window.covelIpc`).
 *  2. REST (`/api/config/settings`) otherwise — Tauri and self-deploy setups
 *     where the sidecar owns the file.
 */
export function createJsonFileBackend(
  opts: JsonFileBackendOptions = {},
): SettingsBackendAdapter {
  const endpoint = opts.restEndpoint ?? '/api/config/settings';
  const secretsEndpoint = opts.restSecretsEndpoint ?? '/api/config/keys';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const authHeaders = (): Record<string, string> => opts.getAuthHeaders?.() ?? {};

  return {
    async load(): Promise<Record<SettingKey, unknown>> {
      const ipc = getIpc();
      if (ipc) {
        const raw = await ipc.invoke<Record<SettingKey, unknown> | null>(
          'covel:settings:load',
        );
        return raw ?? {};
      }
      try {
        const res = await fetchImpl(endpoint);
        if (!res.ok) return {};
        const body = (await res.json()) as {
          entries?: Record<SettingKey, unknown>;
        };
        return body.entries ?? {};
      } catch {
        return {};
      }
    },
    async save(entries): Promise<void> {
      const ipc = getIpc();
      if (ipc) {
        await ipc.invoke('covel:settings:save', entries);
        return;
      }
      await fetchImpl(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ entries }),
      });
    },
    async loadSecrets(): Promise<Record<string, string>> {
      const ipc = getIpc();
      if (ipc) {
        const raw = await ipc.invoke<Record<string, string> | null>(
          'covel:keys:load',
        );
        return raw ?? {};
      }
      try {
        const res = await fetchImpl(secretsEndpoint);
        if (!res.ok) return {};
        const body = (await res.json().catch(() => ({}))) as Record<
          string,
          string
        >;
        return body ?? {};
      } catch {
        return {};
      }
    },
    async saveSecrets(keys): Promise<void> {
      const ipc = getIpc();
      if (ipc) {
        await ipc.invoke('covel:keys:save', keys);
        return;
      }
      await fetchImpl(secretsEndpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(keys),
      });
    },
  };
}
