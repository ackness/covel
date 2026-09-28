import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalStorageBackend } from "../src/backends/localstorage.js";
import { SettingsStore } from "../src/store.js";
import { locks } from "node:worker_threads";

function makeFakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(k: string) {
      return map.get(k) ?? null;
    },
    key(i: number) {
      return [...map.keys()][i] ?? null;
    },
    removeItem(k: string) {
      map.delete(k);
    },
    setItem(k: string, v: string) {
      map.set(k, v);
    },
  } as Storage;
}

describe("LocalStorageBackend", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = makeFakeStorage();
    vi.stubGlobal("navigator", { locks });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips entries", async () => {
    const be = createLocalStorageBackend(storage);
    expect(await be.load()).toEqual({});
    await be.save({
      "ui.locale": "en-US",
      "llm.slotConfig": { default: {} },
    });
    expect(await be.load()).toEqual({
      "ui.locale": "en-US",
      "llm.slotConfig": { default: {} },
    });
  });

  it("round-trips secrets separately from entries", async () => {
    const be = createLocalStorageBackend(storage);
    await be.save({ "ui.locale": "en-US" });
    await be.saveSecrets({ openai: "sk-x" });
    expect(await be.load()).toEqual({ "ui.locale": "en-US" });
    expect(await be.loadSecrets()).toEqual({ openai: "sk-x" });
  });

  it("preserves independent provider writes from two initialized stores", async () => {
    const first = new SettingsStore(createLocalStorageBackend(storage));
    const second = new SettingsStore(createLocalStorageBackend(storage));
    await Promise.all([first.init(), second.init()]);

    await first.set("keys.providerA", "synthetic-a");
    await second.set("keys.providerB", "synthetic-b");

    expect(await createLocalStorageBackend(storage).loadSecrets()).toEqual({
      providerA: "synthetic-a",
      providerB: "synthetic-b",
    });
  });

  it("atomically merges concurrent provider writes", async () => {
    const first = new SettingsStore(createLocalStorageBackend(storage));
    const second = new SettingsStore(createLocalStorageBackend(storage));
    await Promise.all([first.init(), second.init()]);
    await Promise.all([
      first.set("keys.providerA", "synthetic-a"),
      second.set("keys.providerB", "synthetic-b"),
    ]);
    expect(await createLocalStorageBackend(storage).loadSecrets()).toEqual({
      providerA: "synthetic-a",
      providerB: "synthetic-b",
    });
    expect(storage.getItem("covel:settings")).toBeNull();
  });

  it("deletes only the named provider and never resurrects a stale sibling", async () => {
    const backend = createLocalStorageBackend(storage);
    await backend.saveSecrets({
      providerA: "synthetic-a",
      providerB: "synthetic-b",
    });
    const first = new SettingsStore(createLocalStorageBackend(storage));
    const second = new SettingsStore(createLocalStorageBackend(storage));
    await Promise.all([first.init(), second.init()]);
    await Promise.all([
      first.clear("keys.providerA"),
      second.set("keys.providerB", "synthetic-next"),
    ]);
    expect(await backend.loadSecrets()).toEqual({
      providerB: "synthetic-next",
    });
  });

  it("preserves an explicit same-value write against another instance's change", async () => {
    const backend = createLocalStorageBackend(storage);
    await backend.saveSecrets({ providerA: "synthetic-old" });
    const first = new SettingsStore(createLocalStorageBackend(storage));
    const second = new SettingsStore(createLocalStorageBackend(storage));
    await Promise.all([first.init(), second.init()]);
    await first.set("keys.providerA", "synthetic-new");
    await second.set("keys.providerA", "synthetic-old");
    expect(await backend.loadSecrets()).toEqual({ providerA: "synthetic-old" });
  });

  it("preserves an explicit delete when the cached provider is already absent", async () => {
    const backend = createLocalStorageBackend(storage);
    const first = new SettingsStore(createLocalStorageBackend(storage));
    const second = new SettingsStore(createLocalStorageBackend(storage));
    await Promise.all([first.init(), second.init()]);
    await first.set("keys.providerA", "synthetic-a");
    await second.clear("keys.providerA");
    expect(await backend.loadSecrets()).toEqual({});
  });

  it("refuses a non-atomic secret write without Web Locks", async () => {
    storage.setItem("covel:keys", JSON.stringify({ providerA: "synthetic-a" }));
    vi.stubGlobal("navigator", {});
    await expect(
      createLocalStorageBackend(storage).saveSecrets({
        providerB: "synthetic-b",
      }),
    ).rejects.toThrow(/Web Locks/);
    expect(await createLocalStorageBackend(storage).loadSecrets()).toEqual({
      providerA: "synthetic-a",
    });
  });

  it("rejects corrupt JSON instead of treating it as empty", async () => {
    storage.setItem("covel:settings", "not-json");
    const be = createLocalStorageBackend(storage);
    await expect(be.load()).rejects.toThrow(/invalid/);
  });

  it("rejects corrupt secret values", async () => {
    storage.setItem(
      "covel:keys",
      JSON.stringify({ openai: "sk-x", bogus: 42 }),
    );
    const be = createLocalStorageBackend(storage);
    await expect(be.loadSecrets()).rejects.toThrow(/invalid/);
    const original = storage.getItem("covel:keys");
    await expect(be.saveSecrets({ openai: null })).rejects.toThrow(/invalid/);
    expect(storage.getItem("covel:keys")).toBe(original);
  });

  it("reads the current bundle and detects a stale revision", async () => {
    storage.setItem(
      "covel:settings",
      JSON.stringify({
        schemaVersion: 2,
        revision: 0,
        savedAt: "old",
        entries: { old: true },
      }),
    );
    const be = createLocalStorageBackend(storage);
    const initial = await be.loadWithRevision!();
    expect(initial).toMatchObject({
      schemaVersion: 2,
      revision: 0,
      entries: { old: true },
    });
    const saved = await be.saveWithRevision!({ next: true }, 0);
    expect(saved.revision).toBe(1);
    await expect(
      be.saveWithRevision!({ stale: true }, 0),
    ).rejects.toMatchObject({
      code: "settings_revision_conflict",
      currentRevision: 1,
    });
  });

  it.each([undefined, 1])(
    "preserves unsupported version %s on read and write",
    async (schemaVersion) => {
      const contents = JSON.stringify({
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
        entries: { retained: true },
      });
      storage.setItem("covel:settings", contents);
      const backend = createLocalStorageBackend(storage);
      await expect(backend.load()).rejects.toThrow(/unsupported/);
      await expect(backend.save({ replacement: true })).rejects.toThrow(
        /unsupported/,
      );
      expect(storage.getItem("covel:settings")).toBe(contents);
    },
  );
});
