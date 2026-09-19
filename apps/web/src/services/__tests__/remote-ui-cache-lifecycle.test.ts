import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../api.js";
import { ApiError } from "../api/request.js";
import { RemoteDataService } from "../data-service/remote.js";
import type { SessionRecord } from "../api/types.js";
import * as cache from "../storage/remote-ui-cache.js";
import * as appKv from "../app-kv-store.js";
import { REMOTE_UI_CACHE_STORE } from "@covel/store/idb-schema";

vi.mock("../api.js", () => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteWorld: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let live: Map<string, SessionRecord>;
let session: SessionRecord;
let other: SessionRecord;
let first: RemoteDataService;
let second: RemoteDataService;
const missing = (id: string) =>
  new ApiError(
    404,
    `/api/sessions/${id}`,
    '{"error":"Missing","code":"session_not_found"}',
  );

beforeEach(() => {
  const id = crypto.randomUUID();
  session = {
    id,
    worldId: `world-${id}`,
    incarnation: "a".repeat(64),
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: [],
    locale: "en-US",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  other = {
    ...session,
    id: `other-${id}`,
    worldId: `other-world-${id}`,
    incarnation: "b".repeat(64),
  };
  live = new Map([
    [session.id, session],
    [other.id, other],
  ]);
  first = new RemoteDataService();
  second = new RemoteDataService();
  vi.mocked(api.getSession).mockImplementation(async (id) => {
    const record = live.get(id);
    if (!record) throw missing(id);
    return structuredClone(record);
  });
  vi.mocked(api.deleteSession).mockImplementation(async (id) => {
    live.delete(id);
  });
  vi.mocked(api.deleteWorld).mockImplementation(async (id) => {
    for (const record of live.values())
      if (record.worldId === id) live.delete(record.id);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of [session, other]) {
    const records = await cache.listRemoteUiOwners({
      kind: "session",
      id: owner.id,
    });
    for (const record of records) await cache.discardRemoteUiOwner(record);
    await appKv.removeSubmittedBlocks(owner.id);
  }
  vi.clearAllMocks();
});

const save = (service: RemoteDataService, owner = session, label = "initial") =>
  service.saveSubmittedBlocks(
    owner.id,
    [label],
    { [label]: { value: label } },
    owner,
  );
const owners = (owner = session) =>
  cache.listRemoteUiOwners({ kind: "session", id: owner.id });

it("merges concurrent submissions across instances and snapshots inputs before I/O", async () => {
  const ids = ["first"];
  const values = { first: { value: "captured" } };
  const pending = first.saveSubmittedBlocks(session.id, ids, values, session);
  ids.push("late");
  values.first.value = "mutated";
  await Promise.all([pending, save(second, session, "second")]);
  const result = await first.loadSubmittedBlocks(session.id, session);
  expect(result.ids.sort()).toEqual(["first", "second"]);
  expect(result.values.first).toEqual({ value: "captured" });
});

it.each(["session", "world"] as const)(
  "cleans both cache types after %s deletion",
  async (kind) => {
    await save(first);
    await save(second, other);
    await first.saveExecutionSteps(
      session.id,
      [{ runtimeId: "probe" }],
      session,
    );
    if (kind === "session") await second.deleteSession(session.id);
    else await second.deleteWorld(session.worldId);
    expect(await owners()).toEqual([]);
    expect(await second.loadSubmittedBlocks(other.id, other)).toMatchObject({
      ids: ["initial"],
    });
  },
);

it.each(["session", "world"] as const)(
  "rejects a late first write after %s deletion",
  async (kind) => {
    const entered = deferred();
    const release = deferred();
    const old = structuredClone(session);
    vi.mocked(api.getSession).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return old;
    });
    const pending = save(first).then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    try {
      if (kind === "session") await second.deleteSession(session.id);
      else await second.deleteWorld(session.worldId);
    } finally {
      release.resolve();
    }
    expect(await pending).toBeInstanceOf(cache.RemoteUiCacheChangedError);
    expect(await owners()).toEqual([]);
  },
);

it.each([true, false])(
  "preserves same-id replacement from an older response (local delete: %s)",
  async (deleteLocally) => {
    const entered = deferred();
    const release = deferred();
    const old = structuredClone(session);
    vi.mocked(api.getSession).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return old;
    });
    const pending = first.saveExecutionSteps(session.id, ["old"], session).then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    const replacement = { ...session, incarnation: "c".repeat(64) };
    try {
      if (deleteLocally) await second.deleteSession(session.id);
      live.set(session.id, replacement);
      await second.saveExecutionSteps(session.id, ["new"], replacement);
    } finally {
      release.resolve();
    }
    expect(await pending).toBeInstanceOf(cache.RemoteUiCacheChangedError);
    expect(await second.loadExecutionSteps(session.id, replacement)).toEqual([
      "new",
    ]);
    await expect(
      first.loadSubmittedBlocks(session.id, old),
    ).rejects.toBeInstanceOf(cache.RemoteUiCacheChangedError);
    expect(await second.loadExecutionSteps(session.id, replacement)).toEqual([
      "new",
    ]);
  },
);

it("cleans partial world deletion without clearing surviving sessions or swallowing the failure", async () => {
  other = { ...other, worldId: session.worldId };
  live.set(other.id, other);
  await save(first);
  await save(second, other);
  const failure = new ApiError(
    500,
    "/api/worlds/world",
    '{"error":"Synthetic failure"}',
  );
  vi.mocked(api.deleteWorld).mockImplementationOnce(async () => {
    live.delete(session.id);
    throw failure;
  });
  await expect(first.deleteWorld(session.worldId)).rejects.toBe(failure);
  expect(await owners()).toEqual([]);
  expect(await second.loadSubmittedBlocks(other.id, other)).toMatchObject({
    ids: ["initial"],
  });
  await second.deleteWorld(session.worldId);
  expect(await owners(other)).toEqual([]);
});

it.each([401, 500])(
  "retains caches when verification fails with %i",
  async (status) => {
    await save(first);
    const failure = new ApiError(
      status,
      "/api/sessions/session",
      '{"error":"Synthetic failure"}',
    );
    vi.mocked(api.getSession).mockRejectedValueOnce(failure);
    await expect(first.loadSubmittedBlocks(session.id, session)).rejects.toBe(
      failure,
    );
    expect(await second.loadSubmittedBlocks(session.id, session)).toMatchObject(
      { ids: ["initial"] },
    );
  },
);

it("isolates local and remote caches for the same session ID", async () => {
  await appKv.saveSubmittedBlocks(session.id, ["local-form"], {
    "local-form": { value: "local-only" },
  });
  expect(await first.loadSubmittedBlocks(session.id, session)).toEqual({
    ids: [],
    values: {},
  });
  await first.deleteSession(session.id);
  expect(await appKv.getSubmittedBlocks(session.id)).toMatchObject({
    ids: ["local-form"],
  });
});

it("still deletes server data when the browser cache is unavailable", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(cache, "invalidateRemoteUiScope").mockRejectedValue(
    new Error("Synthetic cache failure"),
  );
  vi.spyOn(cache, "listRemoteUiOwners").mockRejectedValue(
    new Error("Synthetic cache failure"),
  );
  await first.deleteSession(session.id);
  expect(live.has(session.id)).toBe(false);
});

it("rejects transaction aborts and preserves the previous committed cache", async () => {
  await save(first);
  const put = IDBObjectStore.prototype.put;
  const broken = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (this: IDBObjectStore, value, key) {
      const result =
        key === undefined ? put.call(this, value) : put.call(this, value, key);
      if (this.name === REMOTE_UI_CACHE_STORE) this.transaction.abort();
      return result;
    });
  await expect(save(first, session, "aborted")).rejects.toBeDefined();
  broken.mockRestore();
  expect(await second.loadSubmittedBlocks(session.id, session)).toMatchObject({
    ids: ["initial"],
  });
});

it("requires a captured incarnation before accessing remote cached data", async () => {
  await expect(
    first.saveExecutionSteps(session.id, ["unsafe"], {
      ...session,
      incarnation: undefined,
    }),
  ).rejects.toThrow("captured session incarnation");
  expect(api.getSession).not.toHaveBeenCalled();
  expect(await owners()).toEqual([]);
});

it("preserves caches when the server cannot prove a session incarnation", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await save(first);
  live.set(session.id, { ...session, incarnation: undefined });
  await expect(first.loadSubmittedBlocks(session.id, session)).rejects.toThrow(
    "cannot verify cache ownership",
  );
  const failure = new Error("Synthetic delete failure");
  vi.mocked(api.deleteSession).mockRejectedValueOnce(failure);
  await expect(second.deleteSession(session.id)).rejects.toBe(failure);
  live.set(session.id, session);
  expect(await first.loadSubmittedBlocks(session.id, session)).toMatchObject({
    ids: ["initial"],
  });
});

it("continues world cleanup after one cache transaction fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  other = { ...other, worldId: session.worldId };
  live.set(other.id, other);
  await save(first);
  await save(second, other);
  const discard = cache.discardRemoteUiOwner;
  vi.spyOn(cache, "discardRemoteUiOwner").mockImplementation(async (owner) => {
    if (owner.sessionId === session.id)
      throw new Error("Synthetic storage failure");
    await discard(owner);
  });
  await first.deleteWorld(session.worldId);
  expect(live.has(session.id)).toBe(false);
  expect(live.has(other.id)).toBe(false);
  expect(await owners(other)).toEqual([]);
  expect(await owners()).toHaveLength(1);
});

it("rejects a stale world binding after the session moves to another world", async () => {
  await save(first);
  const entered = deferred();
  const release = deferred();
  const old = structuredClone(session);
  vi.mocked(api.getSession).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return old;
  });
  const pending = first.loadExecutionSteps(session.id, session).then(
    () => undefined,
    (error: unknown) => error,
  );
  await entered.promise;
  const moved = { ...session, worldId: other.worldId };
  try {
    live.set(session.id, moved);
    await second.saveExecutionSteps(session.id, ["moved"], moved);
  } finally {
    release.resolve();
  }
  expect(await pending).toBeInstanceOf(cache.RemoteUiCacheChangedError);
  expect(await second.loadExecutionSteps(session.id, moved)).toEqual(["moved"]);
  expect(await second.loadSubmittedBlocks(session.id, moved)).toMatchObject({
    ids: ["initial"],
  });
});

it("fences a late first write after another reader confirms remote deletion", async () => {
  const entered = deferred();
  const release = deferred();
  const old = structuredClone(session);
  vi.mocked(api.getSession).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return old;
  });
  const pending = save(first).then(
    () => undefined,
    (error: unknown) => error,
  );
  await entered.promise;
  try {
    live.delete(session.id);
    await expect(
      second.loadSubmittedBlocks(session.id, session),
    ).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    release.resolve();
  }
  expect(await pending).toBeInstanceOf(cache.RemoteUiCacheChangedError);
  expect(await owners()).toEqual([]);
});

it("saves streaming display updates under a verified binding without repeated HTTP reads", async () => {
  await save(first);
  vi.mocked(api.getSession).mockClear();
  for (let index = 0; index < 10; index++) {
    await first.saveExecutionSteps(session.id, [{ index }], session);
  }
  expect(api.getSession).not.toHaveBeenCalled();
  expect(await second.loadExecutionSteps(session.id, session)).toEqual([
    { index: 9 },
  ]);
  expect(api.getSession).toHaveBeenCalledTimes(1);
});

it.each(["session", "world"] as const)(
  "fences a bound display write across %s deletion and replacement",
  async (kind) => {
    await save(first);
    const entered = deferred();
    const release = deferred();
    const commit = cache.useRemoteUiCache;
    vi.spyOn(cache, "useRemoteUiCache").mockImplementationOnce(
      async (owner, stamp, update) => {
        entered.resolve();
        await release.promise;
        return commit(owner, stamp, update);
      },
    );
    const pending = first.saveExecutionSteps(session.id, ["old"], session).then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    const replacement = { ...session, incarnation: "replacement" };
    try {
      if (kind === "session") await second.deleteSession(session.id);
      else await second.deleteWorld(session.worldId);
      live.set(session.id, replacement);
      await second.saveExecutionSteps(session.id, ["new"], replacement);
    } finally {
      release.resolve();
    }
    expect(await pending).toBeInstanceOf(cache.RemoteUiCacheChangedError);
    expect(await second.loadExecutionSteps(session.id, replacement)).toEqual([
      "new",
    ]);
  },
);
