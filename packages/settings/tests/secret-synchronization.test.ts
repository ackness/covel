import { describe, expect, it, vi } from "vitest";
import {
  SettingsStore,
  createJsonFileBackend,
  type SettingsIpcTransport,
} from "../src/index.js";
import { createMemoryAdapter } from "./test-adapter.js";

describe("independent secret synchronization", () => {
  it("reloads IPC keys from the current file without saving a snapshot", async () => {
    let secrets: Record<string, string> = { fixture: "initial-secret" };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "covel:settings:load")
        return { schemaVersion: 2, revision: 0, savedAt: "", entries: {} };
      if (channel === "covel:keys:load") return { ...secrets };
      throw new Error("unexpected write");
    });
    const store = new SettingsStore(
      createJsonFileBackend({
        ipc: { invoke: invoke as SettingsIpcTransport["invoke"] },
      }),
    );
    await store.init();
    invoke.mockClear();
    secrets = {};
    await store.refreshSecrets();
    expect(store.snapshotSecrets()).toEqual({});
    expect(invoke).toHaveBeenCalledExactlyOnceWith("covel:keys:load");
  });

  it("loads another window's update and deletion without writing keys", async () => {
    const adapter = createMemoryAdapter({}, { fixture: "initial-secret" });
    const local = new SettingsStore(adapter);
    const remote = new SettingsStore(adapter);
    await Promise.all([local.init(), remote.init()]);
    const listener = vi.fn();
    local.subscribe("keys.fixture", listener);
    await remote.set("keys.fixture", "updated-secret");
    const save = vi.spyOn(adapter, "saveSecrets");
    await local.refreshSecrets();
    expect(local.snapshotSecrets()).toEqual({ fixture: "updated-secret" });
    expect(listener).toHaveBeenLastCalledWith("updated-secret");
    expect(save).not.toHaveBeenCalled();
    await remote.clear("keys.fixture");
    save.mockClear();
    await local.refreshSecrets();
    expect(local.snapshotSecrets()).toEqual({});
    expect(listener).toHaveBeenLastCalledWith("");
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves pending edits and does not delete keys discovered during a reload", async () => {
    const adapter = createMemoryAdapter({}, { existing: "existing-secret" });
    const store = new SettingsStore(adapter);
    await store.init();
    await adapter.saveSecrets({ remote: "remote-secret" });
    let release!: () => void;
    const originalLoad = adapter.loadSecrets;
    vi.spyOn(adapter, "loadSecrets").mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return originalLoad();
    });
    const save = vi.spyOn(adapter, "saveSecrets");
    const reload = store.refreshSecrets();
    await Promise.resolve();
    const edit = store.set("keys.personal", "personal-secret");
    release();
    await Promise.all([reload, edit]);
    expect(save).toHaveBeenCalledExactlyOnceWith({
      personal: "personal-secret",
    });
    expect(store.snapshotSecrets()).toEqual(adapter.readSecrets());
    expect(store.snapshotSecrets()).toEqual({
      existing: "existing-secret",
      remote: "remote-secret",
      personal: "personal-secret",
    });
  });

  it("keeps confirmed keys after a failed reload and retries on the next read", async () => {
    const adapter = createMemoryAdapter({}, { fixture: "confirmed-secret" });
    const store = new SettingsStore(adapter);
    await store.init();
    vi.spyOn(adapter, "loadSecrets").mockRejectedValueOnce(
      new Error("read failed"),
    );
    await expect(store.refreshSecrets()).rejects.toThrow("read failed");
    expect(store.snapshotSecrets()).toEqual({ fixture: "confirmed-secret" });
    await adapter.saveSecrets({ fixture: null });
    await store.refreshSecrets();
    expect(store.snapshotSecrets()).toEqual({});
  });

  it("does not replay an already confirmed edit into a later unrelated save", async () => {
    const adapter = createMemoryAdapter();
    const store = new SettingsStore(adapter);
    await store.init();
    const originalSave = adapter.saveSecrets;
    const save = vi
      .spyOn(adapter, "saveSecrets")
      .mockImplementationOnce(async (patch) => {
        await originalSave(patch);
        // Another window changes the same provider before the next local save.
        await originalSave({ first: "remote-secret" });
      });
    await Promise.all([
      store.set("keys.first", "first-secret"),
      store.set("keys.second", "second-secret"),
    ]);
    expect(save.mock.calls[1]?.[0]).toEqual({ second: "second-secret" });
    expect(adapter.readSecrets()).toEqual({
      first: "remote-secret",
      second: "second-secret",
    });
    await store.refreshSecrets();
    expect(store.snapshotSecrets()).toEqual(adapter.readSecrets());
  });
});
