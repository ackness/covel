import type { RuntimeSettingsService } from "./types.js";

/**
 * In-memory runtime settings service.
 * Settings are keyed by "sessionId:pluginId:runtimeId".
 */
export function createRuntimeSettingsService(): RuntimeSettingsService {
  // Key: "sessionId:pluginId:runtimeId" → settings
  const store = new Map<string, Record<string, unknown>>();

  function settingsKey(sessionId: string, pluginId: string, runtimeId: string): string {
    return `${sessionId}:${pluginId}:${runtimeId}`;
  }

  async function getResolved(
    sessionId: string,
    pluginId: string,
    runtimeId: string,
  ): Promise<Record<string, unknown>> {
    const key = settingsKey(sessionId, pluginId, runtimeId);
    return { ...(store.get(key) ?? {}) };
  }

  async function update(
    sessionId: string,
    pluginId: string,
    runtimeId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const key = settingsKey(sessionId, pluginId, runtimeId);
    const current = store.get(key) ?? {};
    store.set(key, { ...current, ...patch });
  }

  return { getResolved, update };
}
