import type { ServerSettingInfo } from "@covel/shared";
import type { ServerSettingsChannel } from "@covel/settings";
import {
  ensureDesktopRestToken,
  getDesktopRestAuthHeaders,
} from "@/lib/desktop-bridge";
import { operatorAuthHeaders } from "@/services/session-credentials";

const ENDPOINT = "/api/config/server-settings";

function parseSnapshot(body: unknown): Record<string, ServerSettingInfo> {
  const settings = (body as { settings?: unknown } | null)?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("The server sent no settings");
  }
  const result: Record<string, ServerSettingInfo> = {};
  for (const [key, raw] of Object.entries(settings)) {
    const info = raw as Partial<ServerSettingInfo> | null;
    if (
      !info ||
      (info.source !== "env" &&
        info.source !== "setting" &&
        info.source !== "default") ||
      typeof info.settable !== "boolean"
    ) {
      throw new Error("The server sent no settings");
    }
    result[key] = {
      value: info.value,
      source: info.source,
      settable: info.settable,
    };
  }
  return result;
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string" && body.error
    ? body.error
    : res.statusText || `HTTP ${res.status}`;
}

/**
 * The server's own settings (`scope: "server"`), the same route on the
 * desktop app and in a browser. The server decides who may write; this only
 * presents the credentials the device has.
 */
export function createServerSettingsChannel(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): ServerSettingsChannel {
  return {
    async load() {
      const res = await fetchImpl(ENDPOINT);
      if (!res.ok) throw new Error(await errorMessage(res));
      return parseSnapshot(await res.json());
    },
    async save(patch) {
      await ensureDesktopRestToken();
      const res = await fetchImpl(ENDPOINT, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...operatorAuthHeaders(),
          ...getDesktopRestAuthHeaders(),
        },
        body: JSON.stringify({ entries: patch }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      return parseSnapshot(await res.json());
    },
  };
}
