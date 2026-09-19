import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStorageBackend } from "../src/backends/localstorage.js";
import { SettingsStore } from "../src/store.js";
import type { SettingsBackendAdapter } from "../src/types.js";
import { createMemoryAdapter } from "./test-adapter.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

type BackendKind = "snapshot" | "revision";

async function backend(
  kind: BackendKind,
  initial: Record<string, unknown> = {},
): Promise<SettingsBackendAdapter> {
  const adapter =
    kind === "revision"
      ? createLocalStorageBackend(memoryStorage())
      : createMemoryAdapter();
  await adapter.save(initial);
  return adapter;
}

function observeWithFaults(store: SettingsStore, key: string) {
  store.subscribe(key, () => {
    throw new Error("synthetic-private-listener-detail");
  });
  const keyListener = vi.fn();
  store.subscribe(key, keyListener);
  store.subscribeAll(() => {
    throw "synthetic-private-global-detail";
  });
  const globalListener = vi.fn();
  store.subscribeAll(globalListener);
  return { keyListener, globalListener };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(["snapshot", "revision"] as const)(
  "settings observer isolation with %s persistence",
  (kind) => {
    it.each(["ordinary", "keys.synthetic-private-provider"])(
      "keeps successful %s writes successful and continues notifying siblings",
      async (key) => {
        const diagnostic = vi
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        const adapter = await backend(kind);
        const store = new SettingsStore(adapter);
        await store.init();
        const { keyListener, globalListener } = observeWithFaults(store, key);
        const persistenceError = vi.fn();
        store.subscribePersistenceErrors(persistenceError);
        const value = "synthetic-private-setting-value";

        await expect(store.set(key, value)).resolves.toBeUndefined();

        expect(store.get(key)).toBe(value);
        const saved = key.startsWith("keys.")
          ? (await adapter.loadSecrets())[key.slice("keys.".length)]
          : (await adapter.load())[key];
        expect(saved).toBe(value);
        expect(keyListener).toHaveBeenCalledWith(value);
        expect(globalListener).toHaveBeenCalledWith(value, key);
        expect(persistenceError).not.toHaveBeenCalled();
        expect(diagnostic).toHaveBeenCalled();
        const logged = JSON.stringify(diagnostic.mock.calls);
        for (const sensitive of [
          key,
          value,
          "synthetic-private-listener-detail",
          "synthetic-private-global-detail",
        ]) {
          expect(logged).not.toContain(sensitive);
        }
      },
    );

    it("publishes every key after an atomic setMany even when earlier observers fail", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const adapter = await backend(kind);
      const store = new SettingsStore(adapter);
      await store.init();
      const { keyListener, globalListener } = observeWithFaults(store, "first");
      const second = vi.fn();
      store.subscribe("second", second);

      await expect(
        store.setMany({ first: "saved-first", second: "saved-second" }),
      ).resolves.toBeUndefined();

      expect(await adapter.load()).toEqual({
        first: "saved-first",
        second: "saved-second",
      });
      expect(keyListener).toHaveBeenCalledWith("saved-first");
      expect(second).toHaveBeenCalledWith("saved-second");
      expect(globalListener).toHaveBeenCalledWith("saved-first", "first");
      expect(globalListener).toHaveBeenCalledWith("saved-second", "second");
    });

    it("retains the real write failure and rollback when value observers throw", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const adapter = await backend(kind, { setting: "confirmed" });
      const store = new SettingsStore(adapter);
      await store.init();
      const { keyListener } = observeWithFaults(store, "setting");
      const persistenceError = vi.fn();
      store.subscribePersistenceErrors(persistenceError);
      const writeError = new Error("synthetic I/O failure");
      vi.spyOn(
        adapter,
        kind === "revision" ? "saveWithRevision" : "save",
      ).mockRejectedValueOnce(writeError);

      await expect(store.set("setting", "uncommitted")).rejects.toBe(
        writeError,
      );

      expect(store.get("setting")).toBe("confirmed");
      expect(await adapter.load()).toEqual({ setting: "confirmed" });
      expect(persistenceError).toHaveBeenCalledWith(writeError);
      if (kind === "revision") {
        expect(keyListener).toHaveBeenCalledWith("confirmed");
      }
      await expect(store.set("setting", "next")).resolves.toBeUndefined();
      expect(await adapter.load()).toEqual({ setting: "next" });
    });

    it("isolates persistence-error observers without losing the original failure", async () => {
      const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
      const adapter = await backend(kind, { setting: "confirmed" });
      const store = new SettingsStore(adapter);
      await store.init();
      store.subscribePersistenceErrors(() => {
        throw new Error("synthetic-private-error-observer");
      });
      const healthy = vi.fn();
      store.subscribePersistenceErrors(healthy);
      const writeError = new Error("synthetic-private-write-error");
      vi.spyOn(
        adapter,
        kind === "revision" ? "saveWithRevision" : "save",
      ).mockRejectedValueOnce(writeError);

      await expect(store.set("setting", "uncommitted")).rejects.toBe(
        writeError,
      );

      expect(healthy).toHaveBeenCalledWith(writeError);
      expect(store.get("setting")).toBe("confirmed");
      expect(diagnostic).toHaveBeenCalled();
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(
        "synthetic-private",
      );
      // A throw in the detached rejection observer must not become an unhandled
      // rejection after the caller has already handled the write failure.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  },
);

it("finishes publishing a refreshed snapshot and keeps its queue usable after observer faults", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const adapter = await backend("revision", { first: "old", second: "old" });
  const local = new SettingsStore(adapter);
  const remote = new SettingsStore(adapter);
  await Promise.all([local.init(), remote.init()]);
  const { keyListener, globalListener } = observeWithFaults(local, "first");
  const second = vi.fn();
  local.subscribe("second", second);
  const persistenceError = vi.fn();
  local.subscribePersistenceErrors(persistenceError);
  await remote.setMany({ first: "fresh-first", second: "fresh-second" });

  await expect(local.refresh()).resolves.toBeUndefined();

  expect(local.get("first")).toBe("fresh-first");
  expect(local.get("second")).toBe("fresh-second");
  expect(keyListener).toHaveBeenCalledWith("fresh-first");
  expect(second).toHaveBeenCalledWith("fresh-second");
  expect(globalListener).toHaveBeenCalledWith("fresh-second", "second");
  expect(persistenceError).not.toHaveBeenCalled();
  await expect(local.set("first", "next")).resolves.toBeUndefined();
  expect(await adapter.load()).toEqual({
    first: "next",
    second: "fresh-second",
  });
});
