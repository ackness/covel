/**
 * Unified runtime-settings storage interface.
 *
 * Two implementations:
 *   ApiSettingsStorage   — delegates to the backend REST API (local / self-hosted)
 *   LocalSettingsStorage — persists to localStorage (Vercel static / no backend)
 *
 * StorageFactory.create() probes the backend health endpoint once and returns
 * the appropriate implementation. The result is cached for the lifetime of the
 * page so every subsequent call is instant.
 */

import * as api from './api'
import {
  idbGetRuntimeSettings,
  idbSetRuntimeSettings,
} from './localDb'
import type {
  RuntimeSettingsSchemaResponse,
  RuntimeSettingsValuesResponse,
} from './api'

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ISettingsStorage {
  getSchema(projectId: string): Promise<RuntimeSettingsSchemaResponse>
  getValues(projectId: string, sessionId?: string): Promise<RuntimeSettingsValuesResponse>
  patch(params: {
    projectId: string
    sessionId?: string
    scope: 'project' | 'session'
    values: Record<string, unknown>
  }): Promise<RuntimeSettingsValuesResponse & { ok: boolean }>
}

// ─── API implementation (backend available) ───────────────────────────────────

class ApiSettingsStorage implements ISettingsStorage {
  getSchema(projectId: string) {
    return api.getRuntimeSettingsSchema(projectId)
  }

  getValues(projectId: string, sessionId?: string) {
    return api.getRuntimeSettings(projectId, sessionId)
  }

  patch({ projectId, sessionId, scope, values }: Parameters<ISettingsStorage['patch']>[0]) {
    return api.patchRuntimeSettings({ project_id: projectId, session_id: sessionId, scope, values })
  }
}

// ─── LocalStorage implementation (no backend / Vercel static) ─────────────────

class LocalSettingsStorage implements ISettingsStorage {
  async getSchema(projectId: string): Promise<RuntimeSettingsSchemaResponse> {
    void projectId
    return { fields: [], by_plugin: {}, enabled_plugins: [] }
  }

  async getValues(projectId: string, sessionId?: string): Promise<RuntimeSettingsValuesResponse> {
    const projectOverrides = await idbGetRuntimeSettings(projectId, 'project')
    const sessionOverrides = sessionId
      ? await idbGetRuntimeSettings(projectId, `session:${sessionId}`)
      : {}
    const values = { ...projectOverrides, ...sessionOverrides }
    const byPlugin: Record<string, Record<string, unknown>> = {}
    for (const [fullKey, value] of Object.entries(values)) {
      const dotIdx = fullKey.indexOf('.')
      if (dotIdx > 0) {
        const pluginName = fullKey.slice(0, dotIdx)
        const fieldName = fullKey.slice(dotIdx + 1)
        byPlugin[pluginName] ??= {}
        byPlugin[pluginName][fieldName] = value
      }
    }
    return { values, by_plugin: byPlugin, project_overrides: projectOverrides, session_overrides: sessionOverrides }
  }

  async patch({ projectId, sessionId, scope, values }: Parameters<ISettingsStorage['patch']>[0]) {
    const scopeKey = scope === 'session' && sessionId ? `session:${sessionId}` : 'project'
    const current = await idbGetRuntimeSettings(projectId, scopeKey)
    const next = { ...current }
    for (const [k, v] of Object.entries(values)) {
      if (v === null || v === undefined) {
        delete next[k]
      } else {
        next[k] = v
      }
    }
    await idbSetRuntimeSettings(projectId, scopeKey, next)
    return { ok: true, ...(await this.getValues(projectId, sessionId)) }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

type StorageBackend = 'api' | 'local'

let _cached: ISettingsStorage | null = null
let _detectedBackend: StorageBackend | null = null
let _storagePersistent: boolean | null = null

async function probeHealth(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/health', { method: 'GET', signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const data = await res.json()
      return data.storage_persistent !== false
    }
    return false
  } catch {
    return null // null = network error / connection refused / timeout
  }
}

async function detectBackend(): Promise<StorageBackend> {
  if (_detectedBackend) return _detectedBackend

  let persistent = await probeHealth()
  if (persistent === null) {
    // Network error — backend may still be starting up (local dev race condition).
    // Retry with progressive delays to handle slow cold starts (e.g. LiteLLM ~10s).
    const retryDelays = [2000, 3000, 5000]
    for (const delay of retryDelays) {
      await new Promise<void>((r) => setTimeout(r, delay))
      persistent = await probeHealth()
      if (persistent !== null) break
    }
    persistent = persistent ?? false
  }

  _storagePersistent = persistent
  _detectedBackend = persistent ? 'api' : 'local'
  return _detectedBackend
}

export const StorageFactory = {
  async create(): Promise<ISettingsStorage> {
    if (_cached) return _cached
    const backend = await detectBackend()
    _cached = backend === 'api' ? new ApiSettingsStorage() : new LocalSettingsStorage()
    return _cached
  },

  /** Whether the backend storage is persistent across restarts. */
  async isStoragePersistent(): Promise<boolean> {
    if (_storagePersistent === null) await detectBackend()
    return _storagePersistent ?? false
  },

  /** Re-probe backend if currently detected as non-persistent.
   *  Useful when backend starts after the frontend (dev race condition). */
  async redetectIfNeeded(): Promise<boolean> {
    if (_storagePersistent === true) return true
    // Reset and re-probe
    _cached = null
    _detectedBackend = null
    _storagePersistent = null
    await detectBackend()
    return _storagePersistent ?? false
  },

  /** Force a specific backend — useful for testing or explicit env config. */
  forceBackend(backend: StorageBackend) {
    _cached = backend === 'api' ? new ApiSettingsStorage() : new LocalSettingsStorage()
    _detectedBackend = backend
  },

  /** Reset cache — mainly for tests. */
  reset() {
    _cached = null
    _detectedBackend = null
    _storagePersistent = null
  },
}
