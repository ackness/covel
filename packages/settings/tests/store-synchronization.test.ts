import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  SettingsStore,
  SettingsRevisionConflictError,
  type SettingsBackendAdapter,
} from "../src/index.js";
import type { SettingsPersistenceBundle } from "@covel/shared/settings-persistence";

function backend(initial: Record<string, unknown> = {}) {
  let bundle: SettingsPersistenceBundle = {
    schemaVersion: 2,
    revision: 0,
    savedAt: "",
    entries: initial,
  };
  const adapter: SettingsBackendAdapter = {
    load: async () => ({ ...bundle.entries }),
    save: vi.fn(),
    loadSecrets: vi.fn(async () => ({ synthetic: "test-secret" })),
    saveSecrets: vi.fn(),
    loadWithRevision: vi.fn(async () => structuredClone(bundle)),
    saveWithRevision: vi.fn(async (entries, revision) => {
      if (bundle.revision !== revision) {
        throw new SettingsRevisionConflictError(bundle.revision);
      }
      bundle = {
        ...bundle,
        revision: revision + 1,
        entries: structuredClone(entries),
      };
      return structuredClone(bundle);
    }),
  };
  return { adapter, read: () => structuredClone(bundle) };
}

describe("settings synchronization", () => {
  it("rejects every queued same-value intent when the original field changed remotely", async () => {
    const { adapter, read } = backend({ shared: "original" });
    const remote = new SettingsStore(adapter);
    const local = new SettingsStore(adapter);
    await Promise.all([remote.init(), local.init()]);
    await remote.set("shared", "remote");
    const results = await Promise.allSettled([
      local.set("shared", "local"),
      local.set("shared", "local"),
    ]);
    expect(results.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
    ]);
    for (const result of results) {
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ conflictingKeys: ["shared"] });
    }
    expect(read().entries).toEqual({ shared: "remote" });
    expect(local.get("shared")).toBe("remote");
  });

  it("attempts the newest same-key intent after a prior I/O failure", async () => {
    const { adapter, read } = backend({ shared: "original" });
    const store = new SettingsStore(adapter);
    await store.init();
    vi.mocked(adapter.saveWithRevision!).mockRejectedValueOnce(
      new Error("temporary I/O failure"),
    );
    const results = await Promise.allSettled([
      store.set("shared", "first"),
      store.set("shared", "latest"),
    ]);
    expect(results.map(({ status }) => status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect(adapter.saveWithRevision).toHaveBeenCalledTimes(2);
    expect(read().entries).toEqual({ shared: "latest" });
    expect(store.get("shared")).toBe("latest");
  });

  it("advances queued same-key bases only after a confirmed local write", async () => {
    const { adapter, read } = backend({ shared: "original" });
    const store = new SettingsStore(adapter);
    await store.init();
    await Promise.all([
      store.set("shared", "first"),
      store.set("shared", "latest"),
      store.set("shared", "latest"),
    ]);
    expect(read().entries).toEqual({ shared: "latest" });
    expect(adapter.saveWithRevision).toHaveBeenCalledTimes(3);
  });

  it("revalidates a repeated intent after a remote write follows local confirmation", async () => {
    const { adapter, read } = backend({ shared: "original" });
    const store = new SettingsStore(adapter);
    await store.init();
    const save = vi.mocked(adapter.saveWithRevision!);
    const persist = save.getMockImplementation()!;
    save.mockImplementationOnce(async (entries, revision) => {
      const confirmed = await persist(entries, revision);
      await persist({ shared: "remote" }, confirmed.revision);
      return confirmed;
    });
    const results = await Promise.allSettled([
      store.set("shared", "local"),
      store.set("shared", "local"),
    ]);
    expect(results.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(store.get("shared")).toBe("remote");
    expect(read().entries).toEqual({ shared: "remote" });
  });

  it("persists an object edited through get without mutating the confirmed baseline", async () => {
    const { adapter, read } = backend({ roles: { story: "original" } });
    const store = new SettingsStore(adapter);
    await store.init();
    const roles = store.get<{ story: string }>("roles");
    roles.story = "edited";
    await store.set("roles", roles);
    expect(adapter.saveWithRevision).toHaveBeenCalledTimes(1);
    expect(read().entries).toEqual({ roles: { story: "edited" } });
    const updated = store.get<{ story: string }>("roles");
    updated.story = "failed edit";
    vi.mocked(adapter.saveWithRevision!).mockRejectedValueOnce(
      new Error("I/O failure"),
    );
    await expect(store.set("roles", updated)).rejects.toThrow("I/O failure");
    expect(store.get("roles")).toEqual({ story: "edited" });
    expect(read().entries).toEqual({ roles: { story: "edited" } });
  });

  it("captures each queued object's target before subsequent caller mutations", async () => {
    const { adapter, read } = backend({ roles: { story: "original" } });
    const store = new SettingsStore(adapter);
    await store.init();
    const roles = store.get<{ story: string }>("roles");
    roles.story = "first";
    const first = store.set("roles", roles);
    roles.story = "latest";
    const second = store.set("roles", roles);
    roles.story = "unsubmitted";
    await Promise.all([first, second]);
    expect(
      vi
        .mocked(adapter.saveWithRevision!)
        .mock.calls.map(([entries]) => entries.roles),
    ).toEqual([{ story: "first" }, { story: "latest" }]);
    expect(read().entries).toEqual({ roles: { story: "latest" } });
    expect(store.get("roles")).toEqual({ story: "latest" });
  });

  it("rejects same-key edits, publishes the latest value, and permits an explicit retry", async () => {
    const { adapter, read } = backend({ "ui.locale": "initial" });
    const first = new SettingsStore(adapter);
    const second = new SettingsStore(adapter);
    await Promise.all([first.init(), second.init()]);
    const observe = vi.fn();
    second.subscribe("ui.locale", observe);
    await first.set("ui.locale", "remote");
    await expect(second.set("ui.locale", "local")).rejects.toMatchObject({
      code: "settings_revision_conflict",
      conflictingKeys: ["ui.locale"],
    });
    expect(second.get("ui.locale")).toBe("remote");
    expect(observe).toHaveBeenCalledWith("remote");
    expect(read().entries).toEqual({ "ui.locale": "remote" });
    expect(second.isHydrated()).toBe(true);
    await second.set("ui.locale", "local");
    expect(read().entries).toEqual({ "ui.locale": "local" });
    expect(adapter.saveSecrets).not.toHaveBeenCalled();
  });

  it("treats nested settings as one key and distinguishes deletion from absence", async () => {
    const { adapter, read } = backend({
      roles: { story: "original", fast: "original" },
    });
    const first = new SettingsStore(adapter);
    const second = new SettingsStore(adapter);
    await Promise.all([first.init(), second.init()]);
    await first.set("roles", { story: "remote", fast: "original" });
    await expect(
      second.set("roles", { story: "original", fast: "local" }),
    ).rejects.toBeInstanceOf(SettingsRevisionConflictError);
    await first.clear("roles");
    await expect(second.set("roles", { story: "local" })).rejects.toMatchObject(
      { conflictingKeys: ["roles"] },
    );
    expect(second.has("roles")).toBe(false);
    expect(read().entries).toEqual({});
  });

  it("preserves pending unrelated edits after another queued edit conflicts", async () => {
    const { adapter, read } = backend({ shared: "original" });
    const first = new SettingsStore(adapter);
    const second = new SettingsStore(adapter);
    await Promise.all([first.init(), second.init()]);
    await first.set("shared", "remote");
    const conflicting = second.set("shared", "local");
    const unrelated = second.set("navigation", "memory");
    await expect(conflicting).rejects.toBeInstanceOf(
      SettingsRevisionConflictError,
    );
    await unrelated;
    expect(read().entries).toEqual({ shared: "remote", navigation: "memory" });
    expect(second.get("shared")).toBe("remote");
  });

  it("refreshes deletions and unknown plugin keys without reloading secrets", async () => {
    const { adapter } = backend({ removable: true });
    const first = new SettingsStore(adapter);
    const second = new SettingsStore(adapter);
    await Promise.all([first.init(), second.init()]);
    await first.clear("removable");
    await first.set("plugin.example.layout", { size: 2 });
    const secretReads = vi.mocked(adapter.loadSecrets).mock.calls.length;
    await second.refresh();
    expect(second.has("removable")).toBe(false);
    expect(second.get("plugin.example.layout")).toEqual({ size: 2 });
    expect(adapter.loadSecrets).toHaveBeenCalledTimes(secretReads);
    expect(second.snapshotSecrets()).toEqual({ synthetic: "test-secret" });
    expect(adapter.saveSecrets).not.toHaveBeenCalled();
  });

  it("validates remote values before retrying a disjoint write", async () => {
    const { adapter, read } = backend({ count: 1 });
    const first = new SettingsStore(adapter);
    const second = new SettingsStore(adapter);
    second.register({
      key: "count",
      schema: z.number(),
      default: 0,
      group: "general",
      label: "Count",
    });
    await Promise.all([first.init(), second.init()]);
    await first.set("count", "invalid");
    const savedBefore = vi.mocked(adapter.saveWithRevision!).mock.calls.length;
    await expect(second.set("other", true)).rejects.toThrow(
      "synchronization validation failed",
    );
    expect(vi.mocked(adapter.saveWithRevision!).mock.calls.length).toBe(
      savedBefore + 1,
    );
    expect(read().entries).toEqual({ count: "invalid" });
    expect(second.get("count")).toBe(1);
    expect(second.has("other")).toBe(false);
  });

  it("compares a pending write against changes loaded by an earlier refresh", async () => {
    const { adapter, read } = backend({ shared: "original" });
    const first = new SettingsStore(adapter);
    const second = new SettingsStore(adapter);
    await Promise.all([first.init(), second.init()]);
    await first.set("shared", "remote");
    const refresh = second.refresh();
    const pending = second.set("shared", "local");
    await refresh;
    await expect(pending).rejects.toMatchObject({
      conflictingKeys: ["shared"],
    });
    expect(read().entries).toEqual({ shared: "remote" });
  });

  it("rejects a remote secret namespace before publishing or replaying settings", async () => {
    const { adapter, read } = backend({ ordinary: true });
    const store = new SettingsStore(adapter);
    await store.init();
    await adapter.saveWithRevision!(
      { ordinary: true, "keys.synthetic": "synthetic-test-value" },
      0,
    );
    await expect(store.refresh()).rejects.toThrow("separate keys channel");
    expect(store.get("keys.synthetic")).toBe("test-secret");
    await expect(store.set("other", true)).rejects.toThrow(
      "separate keys channel",
    );
    expect((await store.export()).entries).toEqual({ ordinary: true });
    expect(read().entries).toEqual({
      ordinary: true,
      "keys.synthetic": "synthetic-test-value",
    });
    expect(adapter.saveSecrets).not.toHaveBeenCalled();
  });
});
