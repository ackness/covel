import {
  SettingsRevisionConflictError,
  type SettingKey,
  type SettingsBackendAdapter,
} from "../types.js";
import {
  emptySettingsPersistenceBundle,
  parseSettingsPersistenceBundle,
  type SettingsPersistenceBundle,
} from "@covel/shared/settings-persistence";

interface CovelIpcApiShape {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
}

function getIpc(): CovelIpcApiShape | null {
  if (typeof globalThis === "undefined") return null;
  const w = globalThis as unknown as { covelIpc?: CovelIpcApiShape };
  return w.covelIpc ?? null;
}

function assertIpcWriteSucceeded(channel: string, result: unknown): void {
  if (
    result &&
    typeof result === "object" &&
    "ok" in result &&
    (result as { ok?: unknown }).ok === false
  ) {
    throw new Error(`[settings] IPC ${channel} failed`);
  }
}

function parseIpcBundle(value: unknown): SettingsPersistenceBundle {
  try {
    return parseSettingsPersistenceBundle(value);
  } catch (error) {
    throw new Error(
      `[settings] IPC settings bundle is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function throwForSaveResponse(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as {
    code?: unknown;
    details?: { revision?: unknown };
  } | null;
  if (
    res.status === 409 &&
    body?.code === "settings_revision_conflict" &&
    typeof body.details?.revision === "number"
  ) {
    throw new SettingsRevisionConflictError(body.details.revision);
  }
  throw new Error(`[settings] save failed: HTTP ${res.status}`);
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
 * In-memory marker for a desktop key that exists in the sidecar but is never
 * returned across REST. It must neither be rendered nor sent as provider key.
 */
export const SERVER_MANAGED_SECRET = "__covel_server_managed_secret__";

export function isServerManagedSecret(value: unknown): boolean {
  return value === SERVER_MANAGED_SECRET;
}

/**
 * Desktop backend. Writes to `<covelHome>/settings.json` via one of:
 *  1. Electron IPC (`covel:settings:*` channels) when the preload bridge is
 *     present (`window.covelIpc`).
 *  2. REST (`/api/config/settings`) otherwise — self-deploy setups where the
 *     sidecar owns the file.
 */
export function createJsonFileBackend(
  opts: JsonFileBackendOptions = {},
): SettingsBackendAdapter {
  const endpoint = opts.restEndpoint ?? "/api/config/settings";
  const secretsEndpoint = opts.restSecretsEndpoint ?? "/api/config/keys";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const authHeaders = (): Record<string, string> =>
    opts.getAuthHeaders?.() ?? {};
  let restConfiguredProviders = new Set<string>();

  return {
    async load(): Promise<Record<SettingKey, unknown>> {
      return (await this.loadWithRevision!()).entries;
    },
    async loadWithRevision(): Promise<SettingsPersistenceBundle> {
      const ipc = getIpc();
      if (ipc) {
        const raw = await ipc.invoke<unknown>("covel:settings:load");
        return parseIpcBundle(raw);
      }
      // `GET /api/config/settings` is bearer-gated exactly like the PUT, so it
      // needs the same header — without it a tokened desktop install 401s on
      // every boot.
      const res = await fetchImpl(endpoint, { headers: authHeaders() });
      // 404 is "no settings file yet" — a legitimate empty state. Anything
      // else (sidecar restarting, 500, offline) must propagate: `save()`
      // always writes a full snapshot, so treating a failed load as "empty"
      // makes the next single-setting change overwrite settings.json with
      // just that one key.
      if (res.status === 404) return emptySettingsPersistenceBundle();
      if (!res.ok) {
        throw new Error(`[settings] load failed: HTTP ${res.status}`);
      }
      return parseIpcBundle(await res.json());
    },
    async save(entries): Promise<void> {
      const current = await this.loadWithRevision!();
      await this.saveWithRevision!(entries, current.revision);
    },
    async saveWithRevision(
      entries: Record<SettingKey, unknown>,
      expectedRevision: number,
    ): Promise<SettingsPersistenceBundle> {
      const ipc = getIpc();
      if (ipc) {
        const result = await ipc.invoke<{
          ok?: unknown;
          code?: unknown;
          revision?: unknown;
          bundle?: unknown;
        }>("covel:settings:save", { entries, expectedRevision });
        if (
          result?.ok === false &&
          result.code === "settings_revision_conflict" &&
          typeof result.revision === "number"
        ) {
          throw new SettingsRevisionConflictError(result.revision);
        }
        assertIpcWriteSucceeded("covel:settings:save", result);
        return parseIpcBundle(result?.bundle);
      }
      const res = await fetchImpl(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ entries, expectedRevision }),
      });
      if (!res.ok) {
        return throwForSaveResponse(res);
      }
      return parseIpcBundle(await res.json());
    },
    async loadSecrets(): Promise<Record<string, string>> {
      const ipc = getIpc();
      if (ipc) {
        const raw = await ipc.invoke<Record<string, string> | null>(
          "covel:keys:load",
        );
        return raw ?? {};
      }
      const res = await fetchImpl(secretsEndpoint, { headers: authHeaders() });
      // Same contract as `load()` — a swallowed failure here would let the
      // next key edit wipe every other provider key out of keys.env.
      if (res.status === 404) {
        restConfiguredProviders.clear();
        return {};
      }
      if (!res.ok) {
        throw new Error(`[settings] secrets load failed: HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as {
        providers?: unknown;
      };
      if (!Array.isArray(body.providers)) {
        throw new Error("[settings] secrets load returned an invalid body");
      }
      restConfiguredProviders = new Set(
        body.providers.filter(
          (provider): provider is string =>
            typeof provider === "string" && provider.length > 0,
        ),
      );
      return Object.fromEntries(
        [...restConfiguredProviders].map((provider) => [
          provider,
          SERVER_MANAGED_SECRET,
        ]),
      );
    },
    async saveSecrets(keys): Promise<void> {
      const ipc = getIpc();
      if (ipc) {
        const result = await ipc.invoke("covel:keys:save", keys);
        assertIpcWriteSucceeded("covel:keys:save", result);
        return;
      }
      // SettingsStore persists a full secret snapshot, while the REST API is a
      // non-disclosing patch surface. Preserve opaque server-managed entries,
      // send newly-entered values, and translate omissions into deletions.
      const patch: Record<string, string | null> = {};
      for (const [provider, value] of Object.entries(keys)) {
        if (!isServerManagedSecret(value)) patch[provider] = value;
      }
      for (const provider of restConfiguredProviders) {
        if (!(provider in keys)) patch[provider] = null;
      }
      const res = await fetchImpl(secretsEndpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        throw new Error(`[settings] secrets save failed: HTTP ${res.status}`);
      }
      restConfiguredProviders = new Set(
        Object.entries(keys)
          .filter(([, value]) => value.length > 0)
          .map(([provider]) => provider),
      );
    },
  };
}
