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

describe("concurrent writes", () => {
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
    // The point of the per-key undo: the rejected write must not erase the
    // concurrent one that landed. A whole-map snapshot rollback did exactly
    // that.
    expect(store.get("a.two")).toBe(2);
    expect(store.has("a.one")).toBe(false);
    // KNOWN, PRE-EXISTING: `save` writes a full snapshot, so the successful
    // write persisted `a.one` too (it was still in the map when B serialised).
    // Memory is authoritative and self-corrects on the next write. Fixing the
    // disk divergence needs a write queue, which would defer the in-memory
    // mutation and break synchronous read-after-write (`applyThemeSelection`
    // does `void set(...)` then `get(...)` in the same tick).
    expect(adapter.readEntries()).toEqual({ "a.one": 1, "a.two": 2 });
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
