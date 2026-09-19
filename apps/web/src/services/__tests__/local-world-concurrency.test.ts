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
