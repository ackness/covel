import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SettingsRevisionConflictError, SettingsStore } from "../src/index.js";
import { createMemoryAdapter } from "./test-adapter.js";

describe("ordinary settings replacement", () => {
  it("validates the complete replacement before any write or deletion", async () => {
    const adapter = createMemoryAdapter({ keep: 1, remove: true });
    const save = vi.spyOn(adapter, "save");
    const store = new SettingsStore(adapter);
    store.register({
      key: "keep",
      schema: z.number(),
      default: 0,
      group: "general",
      label: "Keep",
    });
    await store.init();
    const base = (await store.export()).entries;
    await expect(
      store.replaceEntries({ keep: "invalid" }, base),
    ).rejects.toThrow("validation");
    await expect(
      store.replaceEntries({ "keys.synthetic": "test-secret" }, base),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(adapter.readEntries()).toEqual(base);
  });

  it("rejects a stale local editor base before writing", async () => {
    const adapter = createMemoryAdapter({ keep: 1 });
    const save = vi.spyOn(adapter, "save");
    const store = new SettingsStore(adapter);
    await store.init();
    const base = (await store.export()).entries;
    await store.set("new", true);
    await expect(store.replaceEntries({}, base)).rejects.toBeInstanceOf(
      SettingsRevisionConflictError,
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(adapter.readEntries()).toEqual({ keep: 1, new: true });
  });

  it("rolls back all replacement changes together on backend failure", async () => {
    const adapter = createMemoryAdapter({ remove: true, unknown: 1 });
    vi.spyOn(adapter, "save").mockRejectedValueOnce(new Error("I/O failure"));
    const store = new SettingsStore(adapter);
    await store.init();
    const base = (await store.export()).entries;
    await expect(
      store.replaceEntries({ added: true, unknown: 2 }, base),
    ).rejects.toThrow("I/O failure");
    expect((await store.export()).entries).toEqual(base);
    expect(adapter.readEntries()).toEqual(base);
  });
});
