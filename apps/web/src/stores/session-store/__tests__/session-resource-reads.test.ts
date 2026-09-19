import { expect, it, vi } from "vitest";
import {
  invalidateSessionResource,
  refreshSessionResource,
} from "../session-resource-reads.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("does not retry a network failure even when an event invalidated the read", async () => {
  const owner = vi.fn();
  const read = vi.fn(async () => {
    invalidateSessionResource(owner, ["plugins", "session"]);
    throw new Error("offline");
  });
  const apply = vi.fn();
  await expect(
    refreshSessionResource(owner, ["plugins", "session"], {
      read,
      apply,
      isCurrent: () => true,
    }),
  ).rejects.toThrow("offline");
  expect(read).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it("does not read or publish for an already obsolete visit", async () => {
  const read = vi.fn(async () => "value");
  const apply = vi.fn();
  await refreshSessionResource(vi.fn(), ["plugins", "session"], {
    read,
    apply,
    isCurrent: () => false,
  });
  expect(read).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

it("keeps a new read owned after an obsolete request settles from a released resource map", async () => {
  const owner = vi.fn();
  const resource = ["plugins", "session"];
  const obsolete = deferred<string>();
  const obsoleteApply = vi.fn();
  const first = refreshSessionResource(owner, resource, {
    read: () => obsolete.promise,
    apply: obsoleteApply,
    isCurrent: () => true,
  });
  const secondApply = vi.fn();
  await refreshSessionResource(owner, resource, {
    read: async () => "second",
    apply: secondApply,
    isCurrent: () => true,
  });
  expect(secondApply).toHaveBeenCalledExactlyOnceWith("second");
  const current = deferred<string>();
  const read = vi
    .fn()
    .mockReturnValueOnce(current.promise)
    .mockResolvedValue("fresh");
  const apply = vi.fn();
  const third = refreshSessionResource(owner, resource, {
    read,
    apply,
    isCurrent: () => true,
  });
  obsolete.resolve("obsolete");
  await first;
  invalidateSessionResource(owner, resource);
  current.resolve("old-view");
  await third;
  expect(obsoleteApply).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenCalledExactlyOnceWith("fresh");
});

it("keeps independent world and plugin reads current", async () => {
  const owner = vi.fn();
  const plugins = deferred<string>();
  const world = deferred<string>();
  const pluginApply = vi.fn();
  const worldApply = vi.fn();
  const readPlugins = vi.fn(() => plugins.promise);
  const readWorld = vi.fn(() => world.promise);
  const pluginRead = refreshSessionResource(owner, ["plugins", "session"], {
    read: readPlugins,
    apply: pluginApply,
    isCurrent: () => true,
  });
  const worldRead = refreshSessionResource(owner, ["world", "world"], {
    read: readWorld,
    apply: worldApply,
    isCurrent: () => true,
  });
  world.resolve("world");
  plugins.resolve("plugins");
  await Promise.all([pluginRead, worldRead]);
  expect(pluginApply).toHaveBeenCalledExactlyOnceWith("plugins");
  expect(worldApply).toHaveBeenCalledExactlyOnceWith("world");
  expect(readPlugins).toHaveBeenCalledOnce();
  expect(readWorld).toHaveBeenCalledOnce();
});

it.each(["whole", "namespace"])(
  "re-reads overlapping snapshots after the %s read publishes first",
  async (first) => {
    const owner = vi.fn();
    const whole = deferred<{ message: string; untouched: string }>();
    const namespace = deferred<string>();
    const fresh = { message: "fresh", untouched: "retained" };
    const wholeRead = vi
      .fn<() => Promise<typeof fresh>>()
      .mockReturnValueOnce(whole.promise)
      .mockResolvedValue(fresh);
    const namespaceRead = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(namespace.promise)
      .mockResolvedValue("fresh");
    let state = { message: "initial", untouched: "initial" };
    const readWhole = refreshSessionResource(
      owner,
      ["plugin-data", "session"],
      {
        read: wholeRead,
        apply: (value) => {
          state = value;
        },
        isCurrent: () => true,
      },
    );
    const readNamespace = refreshSessionResource(
      owner,
      ["plugin-data", "session", "plugin", "message"],
      {
        read: namespaceRead,
        apply: (value) => {
          state = { ...state, message: value };
        },
        isCurrent: () => true,
      },
    );
    if (first === "whole") {
      whole.resolve(fresh);
      await readWhole;
      namespace.resolve("stale");
    } else {
      namespace.resolve("fresh");
      await readNamespace;
      whole.resolve({ message: "stale", untouched: "retained" });
    }
    await Promise.all([readWhole, readNamespace]);
    expect(state).toEqual(fresh);
    expect(wholeRead).toHaveBeenCalledTimes(first === "whole" ? 1 : 2);
    expect(namespaceRead).toHaveBeenCalledTimes(first === "namespace" ? 1 : 2);
  },
);
