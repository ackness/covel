import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import type { EventBus } from "@covel/events";
import type { DataStore } from "@covel/store";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  watch: vi.fn(),
  load: vi.fn(),
  worldRoot: "",
}));
vi.mock("node:fs", () => ({ watch: fixtures.watch }));
vi.mock("node:fs/promises", () => ({
  realpath: async (value: string) => value,
  lstat: async () => ({ isSymbolicLink: () => false }),
}));
vi.mock("../../src/world-seed-loader.js", () => ({
  loadSingleWorld: fixtures.load,
  preserveWorldProvenance: (value: unknown) => value,
}));
vi.mock("../../src/world-data/session-import/utils.js", () => ({
  resolveWorldRoot: async () => fixtures.worldRoot,
  readWorldManifest: async () => ({ id: "world" }),
}));

import { createWorldFileWatcher } from "../../src/world-file-watcher.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("serializes reloads and drains accepted work before releasing dependencies", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = path.resolve("fixture-worlds");
  fixtures.worldRoot = path.join(root, "world");
  let change!: (type: string, filename: string) => void;
  const close = vi.fn();
  fixtures.watch.mockImplementation((_path, _opts, callback) => {
    change = callback;
    return { close };
  });
  const world = (revision: number) => ({
    id: "world",
    metadata: { dimensions: { revision } },
  });
  fixtures.load
    .mockReset()
    .mockResolvedValueOnce(world(1))
    .mockResolvedValueOnce(world(2));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = vi
    .fn()
    .mockImplementationOnce(() => blocked)
    .mockResolvedValue(undefined);
  const store = {
    getWorld: async () => world(0),
    upsertWorld: write,
    listSessions: async () => [],
  } as unknown as DataStore;
  const sessionLock = createInProcessSessionLock();
  const watcher = createWorldFileWatcher(
    root,
    store,
    {
      emit: vi.fn(),
    } as unknown as EventBus,
    sessionLock,
  );
  watcher.start();
  change("change", path.join("world", "tone.yaml"));
  await vi.advanceTimersByTimeAsync(500);
  expect(write).toHaveBeenCalledOnce();
  change("change", path.join("world", "tone.yaml"));
  await vi.advanceTimersByTimeAsync(500);
  expect(fixtures.load).toHaveBeenCalledOnce();

  let stopped = false;
  const stop = watcher.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
  expect(stopped).toBe(false);
  change("change", path.join("world", "tone.yaml"));
  release();
  await stop;
  await vi.runAllTimersAsync();
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1]?.[0]).toMatchObject(world(2));
  expect(fixtures.load).toHaveBeenCalledTimes(2);
});
