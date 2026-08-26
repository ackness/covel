/**
 * Regression tests for the two ways the settings store used to destroy data
 * silently:
 *
 *  1. `set()` mutated the in-memory map before awaiting the adapter and never
 *     rolled back — one failed write (localStorage quota, sidecar hiccup) left
 *     the map ahead of storage, and since every UI call site is
 *     fire-and-forget the player got no signal while every later write
 *     re-serialised the poisoned map and failed the same way.
 *  2. A failed `load()` was indistinguishable from "nothing stored yet". Since
 *     every save writes a full snapshot, the next single-setting change
 *     overwrote settings.json / keys.env with just that one key.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SettingsStore } from "../src/store.js";
import type { SettingsBackendAdapter } from "../src/types.js";
import { SettingsRevisionConflictError } from "../src/types.js";
import type { SettingsPersistenceBundle } from "@covel/shared/settings-persistence";
import { createMemoryAdapter } from "./test-adapter.js";

const localeEntry = {
  key: "ui.locale",
  schema: z.enum(["zh-CN", "en-US"]),
  default: "zh-CN" as const,
  group: "general" as const,
  label: "Locale",
};

function failingLoadAdapter(
  stored: Record<string, unknown>,
): SettingsBackendAdapter & { readEntries(): Record<string, unknown> } {
  let entries = { ...stored };
  return {
    async load() {
      throw new Error("HTTP 500");
    },
    async save(next) {
      entries = { ...next };
    },
    async loadSecrets() {
      return {};
    },
    async saveSecrets() {},
    readEntries: () => ({ ...entries }),
  };
}

describe("set() rollback on a failed write", () => {
  it("restores the previous value and rejects", async () => {
    const adapter = createMemoryAdapter({ "ui.locale": "zh-CN" });
    const store = new SettingsStore(adapter);
    store.register(localeEntry);
    await store.init();

    vi.spyOn(adapter, "save").mockRejectedValueOnce(
      new Error("QuotaExceededError"),
    );

    await expect(store.set("ui.locale", "en-US")).rejects.toThrow(
      "QuotaExceededError",
    );
    expect(store.get("ui.locale")).toBe("zh-CN");
    expect(adapter.readEntries()).toEqual({ "ui.locale": "zh-CN" });
  });

  it("leaves the store usable for the next write", async () => {
    const adapter = createMemoryAdapter({ "ui.locale": "zh-CN" });
    const store = new SettingsStore(adapter);
    store.register(localeEntry);
    await store.init();

    vi.spyOn(adapter, "save").mockRejectedValueOnce(new Error("transient"));
    await expect(store.set("ui.locale", "en-US")).rejects.toThrow();

    await store.set("ui.locale", "en-US");
    expect(store.get("ui.locale")).toBe("en-US");
    expect(adapter.readEntries()).toEqual({ "ui.locale": "en-US" });
  });

  it("rolls back a failed secret write without dropping the other keys", async () => {
    const adapter = createMemoryAdapter({}, { openai: "sk-old" });
    const store = new SettingsStore(adapter);
    await store.init();

    vi.spyOn(adapter, "saveSecrets").mockRejectedValueOnce(
      new Error("disk full"),
    );
    await expect(store.set("keys.anthropic", "sk-new")).rejects.toThrow();

    expect(store.snapshotSecrets()).toEqual({ openai: "sk-old" });
    expect(adapter.readSecrets()).toEqual({ openai: "sk-old" });
  });
});

describe("failed hydration", () => {
  it("coalesces concurrent and repeated init calls into one hydration", async () => {
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const adapter = createMemoryAdapter({ "ui.locale": "en-US" });
    const load = vi.spyOn(adapter, "load").mockImplementation(async () => {
      markLoadStarted();
      await loadGate;
      return { "ui.locale": "en-US" };
    });
    const loadSecrets = vi.spyOn(adapter, "loadSecrets");
    const store = new SettingsStore(adapter);
    store.register(localeEntry);

    const first = store.init();
    const second = store.init();
    expect(second).toBe(first);
    await loadStarted;
    expect(store.isHydrated()).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(loadSecrets).toHaveBeenCalledTimes(1);

    releaseLoad();
    await Promise.all([first, second, store.ready()]);
    expect(store.isHydrated()).toBe(true);
    expect(store.get("ui.locale")).toBe("en-US");

    const repeated = store.init();
    expect(repeated).toBe(first);
    await repeated;
    expect(load).toHaveBeenCalledTimes(1);
    expect(loadSecrets).toHaveBeenCalledTimes(1);
  });

  it("refuses writes before init without touching persisted data", async () => {
    const adapter = createMemoryAdapter({ "ui.locale": "en-US" });
    const store = new SettingsStore(adapter);
    store.register(localeEntry);

    expect(store.isHydrated()).toBe(false);
    await expect(store.set("ui.locale", "zh-CN")).rejects.toThrow(
      /not initialized/,
    );
    await expect(store.clearAll()).rejects.toThrow(/not initialized/);
    expect(adapter.readEntries()).toEqual({ "ui.locale": "en-US" });
  });

  it("refuses writes while init is still loading", async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    const adapter = createMemoryAdapter({ "ui.locale": "en-US" });
    vi.spyOn(adapter, "load").mockImplementation(async () => {
      markLoadStarted();
      await loadGate;
      return { "ui.locale": "en-US" };
    });
    const store = new SettingsStore(adapter);
    store.register(localeEntry);

    const initializing = store.init();
    await loadStarted;
    expect(store.isHydrated()).toBe(false);
    await expect(store.set("ui.locale", "zh-CN")).rejects.toThrow(
      /not initialized/,
    );
    expect(adapter.readEntries()).toEqual({ "ui.locale": "en-US" });

    releaseLoad();
    await initializing;
    expect(store.isHydrated()).toBe(true);
    await store.set("ui.locale", "zh-CN");
    expect(adapter.readEntries()).toEqual({ "ui.locale": "zh-CN" });
  });

  it("boots on defaults but refuses to write, leaving storage intact", async () => {
    const adapter = failingLoadAdapter({
      "ui.locale": "en-US",
      "llm.customPresets": [{ id: "custom_1" }],
    });
    const store = new SettingsStore(adapter);
    store.register(localeEntry);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await store.init();
    await store.ready();

    expect(store.isHydrated()).toBe(false);
    expect(store.get("ui.locale")).toBe("zh-CN"); // default, not a wipe
    await expect(store.set("ui.locale", "en-US")).rejects.toThrow(
      /refusing to write/,
    );
    // The stored blob must be untouched — this is the data-loss case.
    expect(adapter.readEntries()).toEqual({
      "ui.locale": "en-US",
      "llm.customPresets": [{ id: "custom_1" }],
    });
    spy.mockRestore();
  });

  it("reports hydrated when load succeeds", async () => {
    const store = new SettingsStore(createMemoryAdapter());
    await store.init();
    expect(store.isHydrated()).toBe(true);
  });

  it("refuses clearAll so a reset cannot wipe the data we failed to read", async () => {
    // A failed hydration makes the UI show defaults, which reads as "my
    // settings are gone" — and the player's natural response is Reset.
    const adapter = failingLoadAdapter({ "ui.locale": "en-US" });
    const store = new SettingsStore(adapter);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await store.init();

    await expect(store.clearAll()).rejects.toThrow(/refusing to write/);
    expect(adapter.readEntries()).toEqual({ "ui.locale": "en-US" });
    spy.mockRestore();
  });
});

describe("versioned persistence", () => {
  it("keeps legacy adapters compatible", async () => {
    const adapter = createMemoryAdapter({ old: true });
    const store = new SettingsStore(adapter);
    await store.init();
    await store.set("next", true);
    expect(adapter.readEntries()).toEqual({ old: true, next: true });
  });

  it("rejects invalid registered values during hydration without writing", async () => {
    const adapter = createMemoryAdapter({ "ui.locale": "invalid" });
    const store = new SettingsStore(adapter);
    store.register(localeEntry);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await store.init();
    expect(store.isHydrated()).toBe(false);
    expect(store.get("ui.locale")).toBe("zh-CN");
    expect(adapter.readEntries()).toEqual({ "ui.locale": "invalid" });
    spy.mockRestore();
  });

  it("quarantines an invalid key registered after hydration", async () => {
    const adapter = createMemoryAdapter({ "plugin.test.enabled": "no" });
    const store = new SettingsStore(adapter);
    await store.init();
    store.register({
      key: "plugin.test.enabled",
      schema: z.boolean(),
      default: false,
      group: "plugin",
      label: "Enabled",
    });
    expect(store.get("plugin.test.enabled")).toBe(false);
    expect(store.has("plugin.test.enabled")).toBe(false);
    await expect(store.set("other", true)).rejects.toThrow(/never loaded/);
    expect(adapter.readEntries()).toEqual({ "plugin.test.enabled": "no" });
  });

  it("detects a second store's CAS conflict without overwriting it", async () => {
    let bundle: SettingsPersistenceBundle = {
      schemaVersion: 2,
      revision: 0,
      savedAt: "",
      entries: {},
    };
    const versioned = (): SettingsBackendAdapter => ({
      async load() {
        return { ...bundle.entries };
      },
      async save() {},
      async loadSecrets() {
        return {};
      },
      async saveSecrets() {},
      async loadWithRevision() {
        return { ...bundle, entries: { ...bundle.entries } };
      },
      async saveWithRevision(entries, expectedRevision) {
        if (bundle.revision !== expectedRevision) {
          throw new SettingsRevisionConflictError(bundle.revision);
        }
        bundle = {
          schemaVersion: 2,
          revision: bundle.revision + 1,
          savedAt: "now",
          entries: { ...entries },
        };
        return bundle;
      },
    });
    const first = new SettingsStore(versioned());
    const second = new SettingsStore(versioned());
    await Promise.all([first.init(), second.init()]);
    await first.set("first", true);
    await expect(second.set("second", true)).rejects.toBeInstanceOf(
      SettingsRevisionConflictError,
    );
    expect(bundle.entries).toEqual({ first: true });
    await expect(second.set("third", true)).rejects.toThrow(/never loaded/);
  });

  it("uses the revision returned by each queued save", async () => {
    let bundle: SettingsPersistenceBundle = {
      schemaVersion: 2,
      revision: 0,
      savedAt: "",
      entries: {},
    };
    const expectedRevisions: number[] = [];
    const adapter: SettingsBackendAdapter = {
      async load() {
        return { ...bundle.entries };
      },
      async save() {},
      async loadSecrets() {
        return {};
      },
      async saveSecrets() {},
      async loadWithRevision() {
        return { ...bundle, entries: { ...bundle.entries } };
      },
      async saveWithRevision(entries, expectedRevision) {
        expectedRevisions.push(expectedRevision);
        if (expectedRevision !== bundle.revision) {
          throw new SettingsRevisionConflictError(bundle.revision);
        }
        bundle = {
          schemaVersion: 2,
          revision: bundle.revision + 1,
          savedAt: "now",
          entries: { ...entries },
        };
        return bundle;
      },
    };
    const store = new SettingsStore(adapter);
    await store.init();

    await Promise.all([store.set("first", true), store.set("second", true)]);

    expect(expectedRevisions).toEqual([0, 1]);
    expect(bundle).toMatchObject({
      revision: 2,
      entries: { first: true, second: true },
    });
  });

  it("observes fire-and-forget persistence failures", async () => {
    const adapter = createMemoryAdapter();
    const store = new SettingsStore(adapter);
    await store.init();
    vi.spyOn(adapter, "save").mockRejectedValueOnce(new Error("disk full"));
    const errors: Error[] = [];
    store.subscribePersistenceErrors((error) => errors.push(error));

    void store.set("fire.and.forget", true);
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect(errors[0]?.message).toBe("disk full");
    expect(store.get("fire.and.forget")).toBeUndefined();
  });
});

describe("concurrent writes", () => {
  it("serialises full settings snapshots so an older save cannot win last", async () => {
    let entries: Record<string, unknown> = {};
    let saveCalls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const adapter: SettingsBackendAdapter = {
      async load() {
        return {};
      },
      async save(next) {
        saveCalls += 1;
        if (saveCalls === 1) await firstGate;
        entries = { ...next };
      },
      async loadSecrets() {
        return {};
      },
      async saveSecrets() {},
    };
    const store = new SettingsStore(adapter);
    await store.init();

    const first = store.set("a.one", 1);
    const second = store.set("a.two", 2);
    await Promise.resolve();

    expect(saveCalls).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(entries).toEqual({ "a.one": 1, "a.two": 2 });
  });

  it("serialises full secret snapshots", async () => {
    let secrets: Record<string, string> = {};
    let saveCalls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const adapter: SettingsBackendAdapter = {
      async load() {
        return {};
      },
      async save() {},
      async loadSecrets() {
        return {};
      },
      async saveSecrets(next) {
        saveCalls += 1;
        if (saveCalls === 1) await firstGate;
        secrets = { ...next };
      },
    };
    const store = new SettingsStore(adapter);
    await store.init();

    const first = store.set("keys.deepseek", "key-a");
    const second = store.set("keys.openai", "key-b");
    await Promise.resolve();

    expect(saveCalls).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secrets).toEqual({ deepseek: "key-a", openai: "key-b" });
  });

  it("does not let a failed write roll back a concurrent successful one", async () => {
    const adapter = createMemoryAdapter();
    const store = new SettingsStore(adapter);
    await store.init();

    // First save rejects, second succeeds — the classic interleaving.
    const save = vi.spyOn(adapter, "save");
    save.mockRejectedValueOnce(new Error("transient"));

    const results = await Promise.allSettled([
      store.set("a.one", 1),
      store.set("a.two", 2),
    ]);

    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    // The second full snapshot persisted both optimistic mutations, so memory
    // must converge to that successful snapshot as well.
    expect(store.get("a.two")).toBe(2);
    expect(store.get("a.one")).toBe(1);
    expect(adapter.readEntries()).toEqual({ "a.one": 1, "a.two": 2 });
  });

  it("does not let an older failure roll back a newer write to the same key", async () => {
    const adapter = createMemoryAdapter({ "ui.locale": "zh-CN" });
    const store = new SettingsStore(adapter);
    store.register(localeEntry);
    await store.init();

    vi.spyOn(adapter, "save").mockRejectedValueOnce(new Error("transient"));

    const results = await Promise.allSettled([
      store.set("ui.locale", "en-US"),
      store.set("ui.locale", "zh-CN"),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect(store.get("ui.locale")).toBe("zh-CN");
    expect(adapter.readEntries()).toEqual({ "ui.locale": "zh-CN" });
  });

  it("keeps read-after-write synchronous", async () => {
    // `applyThemeSelection` fires `void store.set(...)` and reads the value
    // back in the same tick.
    const store = new SettingsStore(createMemoryAdapter());
    await store.init();

    void store.set("ui.scheme", "dark");

    expect(store.get("ui.scheme")).toBe("dark");
  });
});
