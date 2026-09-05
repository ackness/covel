import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SettingsStore, type SettingEntry } from "../src/index.js";
import { createMemoryAdapter } from "./test-adapter.js";

const secretCases = [
  { key: "keys.synthetic" },
  { key: "keys.synthetic", backend: "settings" as const },
  { key: "plugin.synthetic.credential", backend: "keys" as const },
  { key: "plugin.synthetic.credential", secret: true },
];

function registerSecret(
  store: SettingsStore,
  entry: (typeof secretCases)[number],
) {
  if (entry.backend || entry.secret) {
    store.register({
      ...entry,
      schema: z.string(),
      default: "",
      group: "llm",
      label: "Synthetic credential",
    } satisfies SettingEntry);
  }
}

describe("settings secret boundaries", () => {
  it.each(secretCases)(
    "rejects selected secret entry $key before writing any part of an import",
    async (entry) => {
      const adapter = createMemoryAdapter(
        { existing: true },
        { preserved: "synthetic-existing" },
      );
      const store = new SettingsStore(adapter);
      registerSecret(store, entry);
      await store.init();
      const save = vi.spyOn(adapter, "save");
      const saveSecrets = vi.spyOn(adapter, "saveSecrets");
      await expect(
        store.import(
          {
            schemaVersion: 1,
            exportedAt: "",
            entries: { ordinary: true, [entry.key]: "synthetic-test-value" },
          },
          { keys: ["ordinary", entry.key], includeSecrets: false },
        ),
      ).rejects.toThrow("separate keys channel");
      expect(save).not.toHaveBeenCalled();
      expect(saveSecrets).not.toHaveBeenCalled();
      expect(adapter.readEntries()).toEqual({ existing: true });
      expect(adapter.readSecrets()).toEqual({
        preserved: "synthetic-existing",
      });
      expect((await store.export()).entries).toEqual({ existing: true });
      expect(JSON.stringify(await store.export())).not.toContain(
        "synthetic-test-value",
      );
    },
  );

  it.each(secretCases)(
    "routes $key writes and clears through the secret channel",
    async (entry) => {
      const adapter = createMemoryAdapter();
      const store = new SettingsStore(adapter);
      registerSecret(store, entry);
      await store.init();
      await store.set(entry.key, "synthetic-test-value");
      const provider = entry.key.startsWith("keys.")
        ? entry.key.slice(5)
        : entry.key;
      expect(store.get(entry.key)).toBe("synthetic-test-value");
      expect(adapter.readEntries()).toEqual({});
      expect(adapter.readSecrets()).toEqual({
        [provider]: "synthetic-test-value",
      });
      expect((await store.export()).entries).toEqual({});
      await store.clear(entry.key);
      expect(adapter.readSecrets()).toEqual({});
      expect(store.has(entry.key)).toBe(false);
    },
  );

  it("requires the dedicated keys bundle even when secret import is enabled", async () => {
    const adapter = createMemoryAdapter();
    const store = new SettingsStore(adapter);
    await store.init();
    await expect(
      store.import(
        {
          schemaVersion: 1,
          exportedAt: "",
          entries: { "keys.synthetic": "synthetic-test-value" },
        },
        { keys: ["keys.synthetic"], includeSecrets: true },
      ),
    ).rejects.toThrow("separate keys channel");
    await store.import(
      {
        schemaVersion: 1,
        exportedAt: "",
        entries: { ordinary: true },
        keys: { synthetic: "synthetic-test-value" },
      },
      { keys: ["ordinary"], includeSecrets: true },
    );
    expect(adapter.readEntries()).toEqual({ ordinary: true });
    expect(adapter.readSecrets()).toEqual({
      synthetic: "synthetic-test-value",
    });
    expect((await store.export()).keys).toBeUndefined();
    expect((await store.export({ includeSecrets: true })).keys).toEqual({
      synthetic: "synthetic-test-value",
    });
  });

  it("does not publish or rewrite misplaced secret entries during hydration", async () => {
    const adapter = createMemoryAdapter({
      "keys.synthetic": "synthetic-test-value",
    });
    const store = new SettingsStore(adapter);
    const save = vi.spyOn(adapter, "save");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await store.init();
      expect(store.isHydrated()).toBe(false);
      await expect(store.set("ordinary", true)).rejects.toThrow("never loaded");
      expect(save).not.toHaveBeenCalled();
      expect(adapter.readEntries()).toEqual({
        "keys.synthetic": "synthetic-test-value",
      });
      expect((await store.export()).entries).toEqual({});
    } finally {
      log.mockRestore();
    }
  });

  it("excludes a dynamically registered secret from ordinary exports", async () => {
    const adapter = createMemoryAdapter({
      "plugin.synthetic.credential": "synthetic-test-value",
      ordinary: true,
    });
    const store = new SettingsStore(adapter);
    await store.init();
    store.register({
      key: "plugin.synthetic.credential",
      schema: z.string(),
      default: "",
      group: "plugin",
      label: "Synthetic credential",
      secret: true,
    });
    expect(store.isHydrated()).toBe(false);
    expect((await store.export()).entries).toEqual({ ordinary: true });
    expect((await store.export({ includeSecrets: true })).entries).toEqual({
      ordinary: true,
    });
    expect(adapter.readEntries()).toHaveProperty("plugin.synthetic.credential");
  });
});
