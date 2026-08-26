import { beforeEach, describe, expect, it } from "vitest";
import { createLocalStorageBackend } from "../src/backends/localstorage.js";

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
  });

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
  });

  it("migrates v1 on read and detects a stale revision", async () => {
    storage.setItem(
      "covel:settings",
      JSON.stringify({
        schemaVersion: 1,
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
});
