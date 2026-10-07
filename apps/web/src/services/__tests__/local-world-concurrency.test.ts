import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserVault } from "../storage/browser-vault.js";
import { LocalDataService } from "../data-service/local.js";

const api = vi.hoisted(() => ({ deleteSession: vi.fn() }));
vi.mock("../api.js", () => api);
vi.mock("../app-kv-store.js", () => ({
  removeStatePatches: async () => {},
  removeSubmittedBlocks: async () => {},
  removeExecutionSteps: async () => {},
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let vault: BrowserVault;
let secondVault: BrowserVault;
let service: LocalDataService;
let second: LocalDataService;
let dbName: string;

beforeEach(async () => {
  vi.clearAllMocks();
  dbName = `world-concurrency-${crypto.randomUUID()}`;
  vault = new BrowserVault({ dbName });
  secondVault = new BrowserVault({ dbName });
  for (const id of ["world-a", "world-b"]) {
    await vault.upsertWorld({
      id,
      name: id,
      description: "Original",
      createdAt: "2026-01-01",
    });
  }
  service = new LocalDataService(vault);
  second = new LocalDataService(secondVault);
  await Promise.all([service.listWorlds(), second.listWorlds()]);
  api.deleteSession.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  secondVault.close();
  await vault.deleteDatabase();
});

// Observe actual admission or an incorrect early completion, without relying
// on a delay to establish whether the competing operation has started.
async function waitForWorldWaiterOrDone(done: () => boolean) {
  await vi.waitFor(async () => {
    const pending = (await navigator.locks.query()).pending ?? [];
    expect(
      done() ||
        pending.some(
          (lock) =>
            lock.name?.includes(dbName) && lock.name.includes("world-a"),
        ),
    ).toBe(true);
  });
}

it("merges different world fields across service instances", async () => {
  const read = deferred();
  const release = deferred();
  const getWorld = vault.getWorld.bind(vault);
  vi.spyOn(vault, "getWorld").mockImplementationOnce(async (id) => {
    const world = await getWorld(id);
    read.resolve();
    await release.promise;
    return world;
  });
  const firstEdit = service.updateWorld("world-a", { name: "Edited name" });
  await read.promise;
  let done = false;
  const secondEdit = second
    .updateWorld("world-a", { description: "Edited description" })
    .finally(() => {
      done = true;
    });
  try {
    await waitForWorldWaiterOrDone(() => done);
  } finally {
    release.resolve();
    await Promise.all([firstEdit, secondEdit]);
  }
  expect(await second.getWorld("world-a")).toMatchObject({
    name: "Edited name",
    description: "Edited description",
  });
});

it.each(["edited", "deleted", "replaced"] as const)(
  "rejects a generated revision after another vault %s the world",
  async (change) => {
    const expectedWorld = (await service.getWorld("world-a"))!;
    if (change !== "edited") await second.deleteWorld("world-a");
    if (change === "edited")
      await second.updateWorld("world-a", { description: "Keep this edit" });
    if (change === "replaced")
      await second.saveGeneratedWorld({
        ...expectedWorld,
        description: "Keep this replacement",
      });
    const kept = await second.getWorld("world-a");
    await expect(
      service.saveGeneratedWorld(
        { ...expectedWorld, lore: "Stale model result" },
        { expectedWorld },
      ),
    ).rejects.toThrow("World changed during revision");
    expect(await second.getWorld("world-a")).toEqual(kept);
  },
);

it("compares revision baselines after waiting for the world lock", async () => {
  const expectedWorld = (await service.getWorld("world-a"))!;
  const read = deferred();
  const release = deferred();
  const getWorld = secondVault.getWorld.bind(secondVault);
  vi.spyOn(secondVault, "getWorld").mockImplementationOnce(async (id) => {
    const current = await getWorld(id);
    read.resolve();
    await release.promise;
    return current;
  });
  const edit = second.updateWorld("world-a", { name: "Keep queued edit" });
  await read.promise;
  let done = false;
  const revision = service
    .saveGeneratedWorld(
      { ...expectedWorld, lore: "Old revision" },
      { expectedWorld },
    )
    .then(
      () => "saved",
      (error: Error) => error.message,
    )
    .finally(() => {
      done = true;
    });
  try {
    await waitForWorldWaiterOrDone(() => done);
  } finally {
    release.resolve();
    await edit;
  }
  expect(await revision).toMatch(/World changed during revision/);
  expect((await second.getWorld("world-a"))?.name).toBe("Keep queued edit");
});

it("compares the public dimensions shape and ignores object key insertion order", async () => {
  const original = (await vault.getWorld("world-a"))!;
  await vault.upsertWorld({
    ...original,
    metadata: { dimensions: {}, generated: true },
  });
  const expectedWorld = (await service.getWorld("world-a"))!;
  expect(expectedWorld.dimensions).toEqual({});
  await secondVault.upsertWorld({
    ...original,
    metadata: { generated: true, dimensions: {} },
  });
  await service.saveGeneratedWorld(
    { ...expectedWorld, lore: "New revision" },
    { expectedWorld },
  );
  expect((await second.getWorld("world-a"))?.lore).toBe("New revision");
});

it("keeps initial generated saves and snapshots revision inputs before waiting", async () => {
  const expectedWorld = (await service.getWorld("world-a"))!;
  const generated = { ...expectedWorld, lore: "New revision" };
  const locked = deferred();
  const release = deferred();
  const owner = secondVault.withWorldLock("world-a", "exclusive", async () => {
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const saving = service.saveGeneratedWorld(generated, { expectedWorld });
  generated.lore = "Later caller mutation";
  expectedWorld.name = "Later caller mutation";
  release.resolve();
  await owner;
  expect((await saving).lore).toBe("New revision");
  await second.saveGeneratedWorld({ ...generated, id: "world-new" });
  expect((await service.getWorld("world-new"))?.id).toBe("world-new");
});

it("does not overwrite a world another vault claimed while generation was running", async () => {
  const generated = {
    id: "world-new",
    name: "Model result",
    description: "Stale generation",
    createdAt: "2026-01-01",
  };
  await second.saveGeneratedWorld({
    ...generated,
    name: "Keep the other window's world",
  });
  const kept = await second.getWorld(generated.id);
  await expect(service.saveGeneratedWorld(generated)).rejects.toThrow(
    "World already exists: world-new",
  );
  expect(await service.getWorld(generated.id)).toEqual(kept);
  const original = await service.getWorld("world-a");
  await expect(
    second.saveGeneratedWorld({ ...generated, id: "world-a" }),
  ).rejects.toThrow("World already exists: world-a");
  expect(await service.getWorld("world-a")).toEqual(original);
});

it("lists and locks sessions through lightweight heads without loading history", async () => {
  await service.createSession("world-a", "session-a");
  await service.updateSession("session-a", { status: "paused" });
  const checkpointRead = vi
    .spyOn(secondVault, "getLatestCheckpoint")
    .mockRejectedValue(new Error("Full checkpoint must not be read"));
  expect(await second.listSessions("world-a")).toEqual([
    expect.objectContaining({ id: "session-a", status: "paused" }),
  ]);
  expect(await second.getSession("session-a")).toMatchObject({
    status: "paused",
  });
  await second.deleteSession("session-a");
  expect(checkpointRead).not.toHaveBeenCalled();
  expect(await vault.getSession("session-a")).toBeNull();
});

it("does not let a checkpoint overwrite a concurrent world edit", async () => {
  await service.createSession("world-a", "session-a");
  const committing = deferred();
  const release = deferred();
  const apply = vault.applySessionCommit.bind(vault);
  vi.spyOn(vault, "applySessionCommit").mockImplementationOnce(
    async (commit) => {
      committing.resolve();
      await release.promise;
      return apply(commit);
    },
  );
  const sessionEdit = service.updateSession("session-a", { status: "paused" });
  await committing.promise;
  let done = false;
  const worldEdit = second
    .updateWorld("world-a", { name: "New world name" })
    .finally(() => {
      done = true;
    });
  try {
    await waitForWorldWaiterOrDone(() => done);
  } finally {
    release.resolve();
    await Promise.all([sessionEdit, worldEdit]);
  }
  expect((await second.getWorld("world-a"))?.name).toBe("New world name");
  expect((await second.getSession("session-a"))?.status).toBe("paused");
});

it("drains admitted session creation before deleting the world", async () => {
  const locked = deferred();
  const release = deferred();
  const owner = vault.withSessionLock("session-new", async () => {
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const creation = service.createSession("world-a", "session-new");
  await vi.waitFor(async () => {
    expect(
      (await navigator.locks.query()).pending?.some(
        (lock) =>
          lock.name?.includes(dbName) && lock.name.includes("session-new"),
      ),
    ).toBe(true);
  });
  let deleted = false;
  const deletion = second.deleteWorld("world-a").finally(() => {
    deleted = true;
  });
  try {
    await waitForWorldWaiterOrDone(() => deleted);
  } finally {
    release.resolve();
    await Promise.all([owner, creation, deletion]);
  }
  expect(await second.getWorld("world-a")).toBeNull();
  expect(await second.getSession("session-new")).toBeNull();
  expect(api.deleteSession).toHaveBeenCalledWith("session-new", {
    silentErrors: true,
  });
});

it("rejects creation queued after world deletion has started", async () => {
  await service.createSession("world-a", "session-a");
  const deleting = deferred();
  const release = deferred();
  api.deleteSession.mockImplementationOnce(async () => {
    deleting.resolve();
    await release.promise;
  });
  const deletion = service.deleteWorld("world-a");
  await deleting.promise;
  let done = false;
  const creation = second
    .createSession("world-a", "session-new")
    .then(
      () => "created",
      (error: Error) => error.message,
    )
    .finally(() => {
      done = true;
    });
  try {
    await waitForWorldWaiterOrDone(() => done);
  } finally {
    release.resolve();
    await deletion;
  }
  expect(await creation).toBe("World not found: world-a");
  expect(await second.getSession("session-new")).toBeNull();
  expect(await second.getWorld("world-a")).toBeNull();
});

it("rejects creation when the world no longer exists", async () => {
  await service.deleteWorld("world-a");
  await expect(second.createSession("world-a", "session-new")).rejects.toThrow(
    "World not found: world-a",
  );
  expect(await second.getSession("session-new")).toBeNull();
});

it("keeps independent sessions and other worlds concurrent", async () => {
  await service.createSession("world-a", "session-a");
  await second.createSession("world-a", "session-a2");
  const entered = deferred();
  const release = deferred();
  const owner = service.withSessionWorkspace("session-a", async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    await second.withSessionWorkspace("session-a2", async () => {});
    await second.updateWorld("world-b", { name: "Independent" });
    expect((await second.getWorld("world-b"))?.name).toBe("Independent");
  } finally {
    release.resolve();
    await owner;
  }
});
