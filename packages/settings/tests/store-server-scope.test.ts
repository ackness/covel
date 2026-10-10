import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ServerSettingInfo } from "@covel/shared";
import { SettingsStore } from "../src/store.js";
import type { ServerSettingsChannel } from "../src/types.js";
import { createMemoryAdapter } from "./test-adapter.js";

const KEY = "diagnostics.traceRetention";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A server that stores what it is sent, unless told to fail. */
function createServer(initial: Record<string, ServerSettingInfo>) {
  let settings = { ...initial };
  const channel: ServerSettingsChannel & {
    failNextSave?: Error;
    saves: Array<Record<string, unknown>>;
  } = {
    saves: [],
    load: async () => ({ ...settings }),
    save: async (patch) => {
      channel.saves.push({ ...patch });
      if (channel.failNextSave) {
        const error = channel.failNextSave;
        channel.failNextSave = undefined;
        throw error;
      }
      for (const [key, value] of Object.entries(patch)) {
        settings = {
          ...settings,
          [key]:
            value === null
              ? { value: "30", source: "default", settable: true }
              : { value, source: "setting", settable: true },
        };
      }
      return { ...settings };
    },
  };
  return channel;
}

function createStore(channel?: ServerSettingsChannel) {
  const adapter = createMemoryAdapter();
  const store = new SettingsStore(adapter, { serverSettings: channel });
  store.register({
    key: KEY,
    schema: z.enum(["7", "30", "90", "keep"]),
    default: "30",
    group: "general",
    label: "Keep diagnostic traces",
    scope: "server",
  });
  store.register({
    key: "ui.theme",
    schema: z.string(),
    default: "light",
    group: "general",
    label: "Theme",
  });
  return { store, adapter };
}

describe("server-scoped settings", () => {
  it("is locked on the default until the server answers, then follows the server", async () => {
    const answer = deferred<Record<string, ServerSettingInfo>>();
    const { store } = createStore({
      load: () => answer.promise,
      save: async () => ({}),
    });
    const seen = vi.fn();
    store.subscribe(KEY, seen);
    await store.init();

    expect(store.serverSetting(KEY)).toMatchObject({
      status: "pending",
      value: "30",
      settable: false,
    });
    await expect(store.set(KEY, "7")).rejects.toThrow(/has not reported/);

    answer.resolve({
      [KEY]: { value: "90", source: "setting", settable: true },
    });
    await store.refreshServerSettings();
    expect(store.get(KEY)).toBe("90");
    expect(store.has(KEY)).toBe(true);
    expect(store.serverSetting(KEY)).toEqual({
      status: "ready",
      value: "90",
      source: "setting",
      settable: true,
    });
    expect(seen).toHaveBeenCalledWith("90");
    expect(store.serverSetting("ui.theme")).toBeUndefined();
  });

  it("writes to the server and never to the device's own storage", async () => {
    const server = createServer({
      [KEY]: { value: "30", source: "default", settable: true },
    });
    const { store, adapter } = createStore(server);
    await store.init();
    await store.refreshServerSettings();

    const write = store.set(KEY, "keep");
    expect(store.get(KEY)).toBe("keep");
    await write;
    expect(server.saves).toEqual([{ [KEY]: "keep" }]);
    expect(adapter.readEntries()).toEqual({});
    expect((await store.export()).entries).toEqual({});

    await store.clear(KEY);
    expect(server.saves.at(-1)).toEqual({ [KEY]: null });
    expect(store.get(KEY)).toBe("30");
    expect(store.has(KEY)).toBe(false);
  });

  it("puts the earlier value back and rejects when the server refuses a write", async () => {
    const server = createServer({
      [KEY]: { value: "7", source: "setting", settable: true },
    });
    const { store } = createStore(server);
    await store.init();
    await store.refreshServerSettings();
    const errors = vi.fn();
    store.subscribePersistenceErrors(errors);
    const seen = vi.fn();
    store.subscribe(KEY, seen);

    server.failNextSave = new Error("server away");
    const write = store.set(KEY, "90");
    expect(store.get(KEY)).toBe("90");
    await expect(write).rejects.toThrow("server away");
    expect(store.get(KEY)).toBe("7");
    expect(seen.mock.calls.map(([value]) => value)).toEqual(["90", "7"]);
    expect(errors).toHaveBeenCalledTimes(1);

    // A later write is not poisoned by the failed one.
    await store.set(KEY, "keep");
    expect(store.get(KEY)).toBe("keep");
  });

  it("shows the operator's value, locked, and sends nothing", async () => {
    const server = createServer({
      [KEY]: { value: "14", source: "env", settable: false },
    });
    const { store } = createStore(server);
    await store.init();
    await store.refreshServerSettings();

    expect(store.get(KEY)).toBe("14");
    expect(store.has(KEY)).toBe(false);
    await expect(store.set(KEY, "7")).rejects.toThrow(/fixed by the server/);
    expect(server.saves).toEqual([]);
  });

  it("rejects a value the schema refuses before asking the server", async () => {
    const server = createServer({
      [KEY]: { value: "30", source: "default", settable: true },
    });
    const { store } = createStore(server);
    await store.init();
    await store.refreshServerSettings();
    await expect(store.set(KEY, "12")).rejects.toThrow(/validation failed/);
    expect(server.saves).toEqual([]);
  });

  it("stays locked when the server cannot be asked, and recovers on a later refresh", async () => {
    let fail = true;
    const { store } = createStore({
      load: async () => {
        if (fail) throw new Error("offline");
        return { [KEY]: { value: "7", source: "setting", settable: true } };
      },
      save: async () => ({}),
    });
    await store.init();
    await expect(store.refreshServerSettings()).rejects.toThrow("offline");
    expect(store.isHydrated()).toBe(true);
    expect(store.serverSetting(KEY)).toMatchObject({
      status: "unavailable",
      value: "30",
      settable: false,
    });
    fail = false;
    await store.refreshServerSettings();
    expect(store.serverSetting(KEY)).toMatchObject({
      status: "ready",
      value: "7",
    });
  });

  it("without a channel reads the default and takes no write", async () => {
    const { store } = createStore();
    await store.init();
    expect(store.serverSetting(KEY)).toMatchObject({
      status: "unavailable",
      settable: false,
    });
    expect(store.get(KEY)).toBe("30");
    await expect(store.set(KEY, "7")).rejects.toThrow();
  });

  it("leaves the server's settings alone when the device is reset", async () => {
    const server = createServer({
      [KEY]: { value: "90", source: "setting", settable: true },
    });
    const { store } = createStore(server);
    await store.init();
    await store.refreshServerSettings();
    await store.set("ui.theme", "dark");
    await store.clearAll();
    expect(store.get("ui.theme")).toBe("light");
    expect(store.get(KEY)).toBe("90");
    expect(server.saves).toEqual([]);
  });
});
