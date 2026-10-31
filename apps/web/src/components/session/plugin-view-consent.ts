import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useSyncExternalStore,
} from "react";
import type { SessionBridgeGrant } from "@covel/shared";
import type { SettingsStoreApi } from "@covel/settings";
import { useSettingsStore } from "@/settings/use-settings.js";
import type { UISlotSpec } from "@/services/api.js";
import type { PluginViewEntry } from "./game-view/use-plugin-views.js";

// Canonical JSON binds consent to all spec content, including inlined HTML,
// independently of object insertion order. No server-code approval is reused.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function pluginViewContent(spec: UISlotSpec): string {
  return JSON.stringify(canonical(spec));
}
export async function hashPluginViewContent(content: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export const sessionViewConsentKey = (
  pluginId: string,
  hash: string,
  capability: SessionBridgeGrant = "session",
) => `ui.pluginViewConsent.${pluginId}.${hash}.${capability}`;

export function requestedViewGrants(
  entry: PluginViewEntry,
): SessionBridgeGrant[] {
  return ["session", ...(entry.spec.capabilities ?? [])];
}

// Track unfinished writes across mounts: optimistic SettingsStore notifications
// must never authorize a frame before persistence has succeeded.
const writes = new WeakMap<SettingsStoreApi, Map<string, symbol>>();
const denied = new WeakMap<SettingsStoreApi, Set<string>>();
const listeners = new Set<() => void>();
let revision = 0;
function changed() {
  revision++;
  for (const listener of listeners) listener();
}

export function usePluginViewConsent(
  views: readonly PluginViewEntry[],
  scope = "",
) {
  const store = useSettingsStore();
  const pending = writes.get(store) ?? new Map<string, symbol>();
  writes.set(store, pending);
  const blocked = denied.get(store) ?? new Set<string>();
  denied.set(store, blocked);
  const contentKey = JSON.stringify(
    views
      .filter((entry) => entry.spec.bridge === "session")
      .map((entry) => [entry.mode, pluginViewContent(entry.spec)]),
  );
  const owner = useRef({ contentKey, scope });
  if (owner.current.contentKey !== contentKey || owner.current.scope !== scope)
    owner.current = { contentKey, scope };
  const [hashes, setHashes] = useState<
    ReadonlyMap<string, { content: string; hash: string }>
  >(new Map());
  useEffect(() => {
    let cancelled = false;
    const entries = JSON.parse(contentKey) as [string, string][];
    void Promise.all(
      entries.map(
        async ([mode, content]) =>
          [
            mode,
            { content, hash: await hashPluginViewContent(content) },
          ] as const,
      ),
    )
      .then((values) => {
        if (!cancelled) setHashes(new Map(values));
      })
      .catch(() => {
        if (!cancelled) setHashes(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [contentKey]);
  useLayoutEffect(
    () => () => {
      owner.current = { contentKey: "", scope: "" };
    },
    [],
  );
  const keyFor = (
    entry: PluginViewEntry,
    capability: SessionBridgeGrant = "session",
  ) => {
    const value = hashes.get(entry.mode);
    return value &&
      value.content === pluginViewContent(entry.spec) &&
      views.some((item) => item === entry) &&
      /^[a-f0-9]{64}$/.test(value.hash)
      ? sessionViewConsentKey(entry.pluginId, value.hash, capability)
      : undefined;
  };
  const subscribe = useCallback(
    (listener: () => void) => {
      listeners.add(listener);
      const stop = store.subscribeAll(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    [store],
  );
  useSyncExternalStore(
    subscribe,
    () =>
      JSON.stringify([
        revision,
        views.map((entry) =>
          requestedViewGrants(entry).map((capability) => {
            const key = keyFor(entry, capability);
            return key ? store.get<unknown>(key) === true : false;
          }),
        ),
      ]),
    () => "[]",
  );
  const allows = (entry: PluginViewEntry, capability: SessionBridgeGrant) => {
    const key = keyFor(entry, capability);
    return Boolean(
      key &&
      !pending.has(key) &&
      !blocked.has(key) &&
      store.get<unknown>(key) === true,
    );
  };
  return {
    ready: (entry: PluginViewEntry) => Boolean(keyFor(entry)),
    isGranted: allows,
    isAllowed: (entry: PluginViewEntry) =>
      entry.spec.bridge !== "session" ||
      requestedViewGrants(entry).every((capability) =>
        allows(entry, capability),
      ),
    // Read again at every async boundary; this closure checks the current store.
    isCurrent: (entry: PluginViewEntry) => {
      const captured = owner.current;
      return () =>
        owner.current === captured &&
        requestedViewGrants(entry).every((capability) =>
          allows(entry, capability),
        );
    },
    async grant(entry: PluginViewEntry, isCurrentDialog?: () => boolean) {
      const captured = owner.current;
      const keys = requestedViewGrants(entry).map((capability) =>
        keyFor(entry, capability),
      );
      if (keys.some((key) => !key)) return;
      const valid = keys as string[];
      const token = Symbol("consent-save");
      for (const key of valid) {
        pending.set(key, token);
        blocked.add(key);
      }
      changed();
      try {
        await store.setMany(
          Object.fromEntries(valid.map((key) => [key, true])),
        );
        if (
          owner.current !== captured ||
          !(isCurrentDialog?.() ?? true) ||
          valid.some((key) => pending.get(key) !== token)
        ) {
          // A closed dialog or revoked grant cannot become a later visit's consent.
          for (const key of valid)
            if (pending.get(key) === token || !pending.has(key))
              await store.clear(key);
          return;
        }
        for (const key of valid) blocked.delete(key);
      } finally {
        for (const key of valid)
          if (pending.get(key) === token) pending.delete(key);
        changed();
      }
    },
    async revoke(entry: PluginViewEntry, capability?: SessionBridgeGrant) {
      const keys = (capability ? [capability] : requestedViewGrants(entry))
        .map((item) => keyFor(entry, item))
        .filter((key): key is string => Boolean(key));
      for (const key of keys) {
        blocked.add(key);
        pending.delete(key);
      }
      changed();
      await Promise.all(keys.map((key) => store.clear(key)));
    },
  };
}
