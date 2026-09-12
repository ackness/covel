import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SettingsStore } from "../src/store.js";
import { createMemoryAdapter } from "./test-adapter.js";

const entry = {
  key: "plugin.synthetic.display",
  schema: z.object({
    title: z.string().trim().default("Default"),
    input: z.array(z.string()).default(["text"]),
  }),
  default: { title: "Default", input: ["text"] },
  group: "plugin" as const,
  label: "Synthetic display",
};
const partial = { title: " Example " };
const normalized = { title: "Example", input: ["text"] };

describe("settings schema normalization", () => {
  it("hydrates parsed values without rewriting the backend", async () => {
    const adapter = createMemoryAdapter({ [entry.key]: partial });
    const store = new SettingsStore(adapter);
    store.register(entry);
    await store.init();

    expect(store.get(entry.key)).toEqual(normalized);
    expect((await store.export()).entries[entry.key]).toEqual(normalized);
    expect(adapter.readEntries()[entry.key]).toEqual(partial);
  });

  it.each(["set", "import"] as const)(
    "%s persists and notifies with parsed values",
    async (operation) => {
      const adapter = createMemoryAdapter();
      const store = new SettingsStore(adapter);
      store.register(entry);
      await store.init();
      const observe = vi.fn();
      store.subscribe(entry.key, observe);

      if (operation === "set") {
        await store.set(entry.key, partial);
      } else {
        await store.import(
          {
            schemaVersion: 1,
            exportedAt: "2026-09-12T00:00:00Z",
            entries: { [entry.key]: partial },
          },
          { keys: [entry.key] },
        );
      }

      expect(store.get(entry.key)).toEqual(normalized);
      expect(adapter.readEntries()[entry.key]).toEqual(normalized);
      expect(observe).toHaveBeenLastCalledWith(normalized);
      expect(partial).toEqual({ title: " Example " });
    },
  );

  it("normalizes dynamically registered values and their rollback snapshot", async () => {
    const adapter = createMemoryAdapter({ [entry.key]: partial });
    const store = new SettingsStore(adapter);
    await store.init();
    store.register(entry);
    expect(store.get(entry.key)).toEqual(normalized);

    vi.spyOn(adapter, "save").mockRejectedValueOnce(new Error("I/O failure"));
    await expect(store.set(entry.key, { title: "Changed" })).rejects.toThrow(
      "I/O failure",
    );
    expect(store.get(entry.key)).toEqual(normalized);
    expect(adapter.readEntries()[entry.key]).toEqual(partial);
  });
});
