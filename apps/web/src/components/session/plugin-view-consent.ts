import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { z } from "zod";
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
export const sessionViewConsentKey = (pluginId: string, hash: string) =>
  `ui.pluginViewConsent.${pluginId}.${hash}.session`;

export function usePluginViewConsent(views: readonly PluginViewEntry[]) {
  const store = useSettingsStore();
  const contents = useMemo(
    () =>
      new Map(
        views
          .filter((entry) => entry.spec.bridge === "session")
          .map((entry) => [
            entry.mode,
            { spec: entry.spec, content: pluginViewContent(entry.spec) },
          ]),
      ),
    [views],
  );
  const contentKey = JSON.stringify(
    [...contents].map(([mode, value]) => [mode, value.content]),
  );
  const [hashes, setHashes] = useState<
    ReadonlyMap<string, { content: string; hash: string }>
  >(new Map());
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
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
      }); // Fail closed if hashing is unavailable.
    return () => {
      cancelled = true;
    };
  }, [contentKey]);
  const keyFor = (entry: PluginViewEntry) => {
    const value = hashes.get(entry.mode);
    const current = contents.get(entry.mode);
    return value &&
      current?.spec === entry.spec &&
      value.content === current.content
      ? sessionViewConsentKey(entry.pluginId, value.hash)
      : undefined;
  };
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeAll(listener),
    [store],
  );
  // A scalar snapshot also handles SettingsStore's optimistic update/rollback.
  useSyncExternalStore(
    subscribe,
    () =>
      JSON.stringify(
        views.map((entry) => {
          const key = keyFor(entry);
          return key ? store.get<unknown>(key) === true : false;
        }),
      ),
    () => "[]",
  );
  return {
    ready: (entry: PluginViewEntry) => Boolean(keyFor(entry)),
    isAllowed: (entry: PluginViewEntry) => {
      if (entry.spec.bridge !== "session") return true;
      const key = keyFor(entry);
      return Boolean(
        key &&
        !blocked.has(key) &&
        z.literal(true).safeParse(store.get<unknown>(key)).success,
      );
    },
    async grant(entry: PluginViewEntry) {
      const key = keyFor(entry);
      if (!key) return;
      await store.set(key, true);
      setBlocked(
        (previous) => new Set([...previous].filter((item) => item !== key)),
      );
    },
    async revoke(entry: PluginViewEntry) {
      const key = keyFor(entry);
      if (!key) return;
      setBlocked((previous) => new Set([...previous, key]));
      await store.clear(key);
    },
  };
}
