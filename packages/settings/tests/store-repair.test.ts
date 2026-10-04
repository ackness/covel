/**
 * A stored value that the current schema refuses used to make the whole store
 * read-only: one retired option after an upgrade, and nothing could be saved
 * again. With a backend that keeps a copy, the store drops such values, the
 * keys read their defaults, and the copy holds what was there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { locks } from "node:worker_threads";
import { createLocalStorageBackend } from "../src/backends/localstorage.js";
import { SettingsStore } from "../src/store.js";
import type { SettingsRepair } from "../src/types.js";

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

const length = {
  key: "plugin.narrator.length",
  schema: z.enum(["short", "medium", "long"]),
  default: "medium" as const,
  group: "plugin" as const,
  pluginId: "narrator",
  label: "Reply length",
};

function bundle(entries: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 2,
    revision: 4,
    savedAt: "",
    entries,
  });
}

function storedEntries(storage: Storage): Record<string, unknown> {
  return JSON.parse(storage.getItem("covel:settings") ?? "{}").entries;
}

describe("stored values the current schema refuses", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = makeStorage();
    vi.stubGlobal("navigator", { locks });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("drops them at load, keeps a copy, and leaves the store writable", async () => {
    // "epic" was an option of an earlier version of the plugin.
    const before = bundle({ [length.key]: "epic", "ui.scheme": "dark" });
    storage.setItem("covel:settings", before);
    const store = new SettingsStore(createLocalStorageBackend(storage));
    store.register(length);
    const repairs: SettingsRepair[] = [];
    store.subscribeRepairs((repair) => repairs.push(repair));
    await store.init();

    expect(store.isHydrated()).toBe(true);
    expect(store.get(length.key)).toBe("medium");
    expect(store.has(length.key)).toBe(false);
    expect(store.get("ui.scheme")).toBe("dark");
    expect(repairs).toEqual([
      { backup: "covel:settings.conflict.bak", keys: [length.key] },
    ]);
    expect(await store.readBackup("covel:settings.conflict.bak")).toBe(before);
    expect(await store.listBackups()).toEqual(["covel:settings.conflict.bak"]);
    expect(storedEntries(storage)).toEqual({ "ui.scheme": "dark" });

    await store.set(length.key, "long");
    expect(storedEntries(storage)).toEqual({
      "ui.scheme": "dark",
      [length.key]: "long",
    });
  });

  it("drops one registered after the load without blocking other writes", async () => {
    const before = bundle({ [length.key]: "epic", "ui.scheme": "dark" });
    storage.setItem("covel:settings", before);
    const store = new SettingsStore(createLocalStorageBackend(storage));
    const repairs: SettingsRepair[] = [];
    store.subscribeRepairs((repair) => repairs.push(repair));
    await store.init();

    // The plugin loads after the settings, as plugins do.
    store.register(length);
    expect(store.get(length.key)).toBe("medium");
    expect(store.has(length.key)).toBe(false);
    // A write issued at once waits for the stored value to go, then lands.
    await store.set("ui.scheme", "light");

    expect(store.isHydrated()).toBe(true);
    expect(repairs).toEqual([
      { backup: "covel:settings.conflict.bak", keys: [length.key] },
    ]);
    expect(storage.getItem("covel:settings.conflict.bak")).toBe(before);
    expect(storedEntries(storage)).toEqual({ "ui.scheme": "light" });
    expect(store.has(length.key)).toBe(false);
  });

  it("keeps a value the player sets for that key during the repair", async () => {
    storage.setItem("covel:settings", bundle({ [length.key]: "epic" }));
    const store = new SettingsStore(createLocalStorageBackend(storage));
    await store.init();
    store.register(length);
    await store.set(length.key, "short");
    expect(store.get(length.key)).toBe("short");
    expect(storedEntries(storage)).toEqual({ [length.key]: "short" });
  });

  it("drops nothing when the copy cannot be kept", async () => {
    const before = bundle({ [length.key]: "epic" });
    storage.setItem("covel:settings", before);
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      if (key.endsWith(".bak")) throw new Error("quota exceeded");
      setItem(key, value);
    };
    const store = new SettingsStore(createLocalStorageBackend(storage));
    store.register(length);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await store.init();

    expect(store.isHydrated()).toBe(false);
    expect(storage.getItem("covel:settings")).toBe(before);
    await expect(store.set("ui.scheme", "light")).rejects.toThrow(
      /refusing to write/,
    );
  });
});
