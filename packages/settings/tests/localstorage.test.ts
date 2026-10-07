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

  it("keeps every backup when several are created in the same millisecond", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123);
    try {
      const backend = createLocalStorageBackend(storage);
      const names: string[] = [];
      for (const value of ["first", "second", "third"]) {
        storage.setItem("covel:settings", value);
        names.push(await backend.backupBundle!());
      }
      expect(new Set(names).size).toBe(3);
      expect(
        await Promise.all(names.map((name) => backend.readBackup!(name))),
      ).toEqual(["first", "second", "third"]);
    } finally {
      now.mockRestore();
    }
  });

  it("round-trips secrets separately from entries", async () => {
    const be = createLocalStorageBackend(storage);
    await be.save({ "ui.locale": "en-US" });
    await be.saveSecrets({ openai: "sk-x" });
    expect(await be.load()).toEqual({ "ui.locale": "en-US" });
    expect(await be.loadSecrets()).toEqual({ openai: "sk-x" });
  });

  it("preserves prototype-named provider secrets when a second store saves another provider", async () => {
    const first = new SettingsStore(createLocalStorageBackend(storage));
    await first.init();
    await first.set("keys.__proto__", "synthetic-prototype-secret");
    const second = new SettingsStore(createLocalStorageBackend(storage));
    await second.init();
    expect(second.get("keys.__proto__")).toBe("synthetic-prototype-secret");
    await second.set("keys.sibling", "synthetic-sibling-secret");
    const stored = JSON.parse(storage.getItem("covel:keys")!);
    expect(Object.hasOwn(stored, "__proto__")).toBe(true);
    expect(stored.__proto__).toBe("synthetic-prototype-secret");
    expect((await second.export()).entries).toEqual({});
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

  it.each([
    ["not-json", "covel:settings.damaged.bak"],
    [
      JSON.stringify({ entries: { retained: true } }),
      "covel:settings.unversioned.bak",
    ],
  ])(
    "moves the unusable bundle %s aside whole and starts empty",
    async (contents, backupKey) => {
      storage.setItem("covel:settings", contents);
      const be = createLocalStorageBackend(storage);
      await expect(be.load()).resolves.toEqual({});
      expect(storage.getItem(backupKey)).toBe(contents);
      expect(storage.getItem("covel:settings")).toBeNull();
      expect(await be.takeArchivedBundle!()).toBe(backupKey);
      expect(await be.listBackups!()).toEqual([backupKey]);
      expect(await be.readBackup!(backupKey)).toBe(contents);
      expect(await be.readBackup!("covel:keys")).toBeNull();
    },
  );

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

  it("preserves a bundle from a later build on read and write", async () => {
    {
      const contents = JSON.stringify({
        schemaVersion: 3,
        entries: { retained: true },
      });
      storage.setItem("covel:settings", contents);
      const backend = createLocalStorageBackend(storage);
      await expect(backend.load()).rejects.toThrow(/unsupported/);
      await expect(backend.save({ replacement: true })).rejects.toThrow(
        /unsupported/,
      );
      expect(storage.getItem("covel:settings")).toBe(contents);
      expect(await backend.listBackups!()).toEqual([]);
    }
  });

  it("does not write over an earlier copy", async () => {
    storage.setItem("covel:settings.v1.bak", "the first copy");
    storage.setItem(
      "covel:settings",
      JSON.stringify({ schemaVersion: 1, entries: {} }),
    );
    const backend = createLocalStorageBackend(storage);
    await backend.loadWithRevision!();
    expect(storage.getItem("covel:settings.v1.bak")).toBe("the first copy");
    expect(await backend.takeArchivedBundle!()).toMatch(
      /^covel:settings\.v1\.\d+\.bak$/,
    );
  });

  it("moves a bundle from an earlier build aside and starts from defaults", async () => {
    const contents = JSON.stringify({
      schemaVersion: 1,
      savedAt: "2026-07-06T02:48:18.590Z",
      entries: { "ui.onboardedVersion": 3 },
    });
    storage.setItem("covel:settings", contents);
    const store = new SettingsStore(createLocalStorageBackend(storage));
    await store.init();

    // The store loaded, so it accepts writes; the old bytes are kept whole.
    expect(store.isHydrated()).toBe(true);
    expect(store.has("ui.onboardedVersion")).toBe(false);
    expect(storage.getItem("covel:settings.v1.bak")).toBe(contents);
    await store.set("ui.onboardedVersion", 4);
    expect(
      JSON.parse(storage.getItem("covel:settings") ?? "{}").entries,
    ).toEqual({ "ui.onboardedVersion": 4 });
  });

  it("reports the moved bundle once", async () => {
    storage.setItem(
      "covel:settings",
      JSON.stringify({ schemaVersion: 1, entries: {} }),
    );
    const backend = createLocalStorageBackend(storage);
    await backend.loadWithRevision!();
    await backend.loadWithRevision!();
    expect(await backend.takeArchivedBundle!()).toBe("covel:settings.v1.bak");
    expect(await backend.takeArchivedBundle!()).toBeNull();
  });

  it("leaves an earlier bundle in place when its copy cannot be written", async () => {
    const contents = JSON.stringify({ schemaVersion: 1, entries: {} });
    storage.setItem("covel:settings", contents);
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      if (key.endsWith(".bak")) throw new Error("quota exceeded");
      setItem(key, value);
    };
    const store = new SettingsStore(createLocalStorageBackend(storage));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await store.init();
    expect(store.isHydrated()).toBe(false);
    expect(storage.getItem("covel:settings")).toBe(contents);
  });
});
