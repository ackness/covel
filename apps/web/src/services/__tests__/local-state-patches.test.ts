import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_KV_STORE_STATE_PATCHES } from "@covel/store/idb-schema";
import type { StatePatchRecord } from "../api/types.js";
import { getStatePatches, removeStatePatches } from "../app-kv-store.js";
import { LocalDataService } from "../data-service/local.js";
import { BrowserVault } from "../storage/browser-vault.js";

vi.mock("../api.js", () => ({ deleteSession: vi.fn(async () => {}) }));

let vault: BrowserVault;
let service: LocalDataService;
let second: LocalDataService;
let sessionId: string;

function patch(id: string): StatePatchRecord {
  return {
    id,
    sessionId,
    summary: id,
    packageName: "probe",
    createdAt: "2026-01-01",
  };
}

beforeEach(async () => {
  sessionId = `patch-session-${crypto.randomUUID()}`;
  vault = new BrowserVault({ dbName: `patch-vault-${crypto.randomUUID()}` });
  await vault.upsertWorld({
    id: "world",
    name: "World",
    description: "",
    createdAt: "2026-01-01",
  });
  service = new LocalDataService(vault);
  second = new LocalDataService(vault);
  await service.createSession("world", undefined, sessionId);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeStatePatches(sessionId);
  await vault.deleteDatabase();
});

it("reads persisted history and appends without losing it after reload", async () => {
  await service.addStatePatch(sessionId, patch("first"));
  await service.addStatePatch(sessionId, patch("second"));
  expect(
    (await second.listStatePatches(sessionId)).map((item) => item.id),
  ).toEqual(["first", "second"]);
  await second.addStatePatch(sessionId, patch("third"));
  expect((await getStatePatches(sessionId))?.map((item) => item.id)).toEqual([
    "first",
    "second",
    "third",
  ]);
});

it.each([false, true])(
  "retains same-instance concurrent appends (warm: %s)",
  async (warm) => {
    if (warm) await service.addStatePatch(sessionId, patch("existing"));
    await Promise.all([
      service.addStatePatch(sessionId, patch("first")),
      service.addStatePatch(sessionId, patch("second")),
    ]);
    expect(
      (await getStatePatches(sessionId))?.map((item) => item.id).sort(),
    ).toEqual(warm ? ["existing", "first", "second"] : ["first", "second"]);
  },
);

it("retains appends from different services that both read an empty list", async () => {
  await Promise.all([
    service.listStatePatches(sessionId),
    second.listStatePatches(sessionId),
  ]);
  await Promise.all([
    service.addStatePatch(sessionId, patch("first")),
    second.addStatePatch(sessionId, patch("second")),
  ]);
  expect(
    (await getStatePatches(sessionId))?.map((item) => item.id).sort(),
  ).toEqual(["first", "second"]);
});

it("reads another service's writes after its own earlier read", async () => {
  expect(await service.listStatePatches(sessionId)).toEqual([]);
  await second.addStatePatch(sessionId, patch("other-service"));
  expect(
    (await service.listStatePatches(sessionId)).map((item) => item.id),
  ).toEqual(["other-service"]);
});

it("rejects a late append after session deletion without rebuilding the cache", async () => {
  await second.listStatePatches(sessionId);
  await service.deleteSession(sessionId);
  // Wait for cache cleanup too, even on the old fire-and-forget implementation.
  await getStatePatches(sessionId);
  await expect(second.addStatePatch(sessionId, patch("late"))).rejects.toThrow(
    "Session not found",
  );
  expect(await getStatePatches(sessionId)).toBeNull();
});

it("rechecks existence when an append waits behind session deletion", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = service.withSessionWorkspace(sessionId, async () => {
    entered();
    await gate;
  });
  await started;
  const deletion = second.deleteSession(sessionId);
  const pendingCount = async () =>
    (await navigator.locks.query()).pending?.filter((lock) =>
      lock.name?.includes(sessionId),
    ).length ?? 0;
  let append: Promise<string> | undefined;
  try {
    await vi.waitFor(async () => expect(await pendingCount()).toBe(1));
    append = service.addStatePatch(sessionId, patch("queued")).then(
      () => "saved",
      (error: Error) => error.message,
    );
    await vi.waitFor(async () => expect(await pendingCount()).toBe(2));
  } finally {
    release();
    await Promise.all([owner, deletion]);
  }
  expect(await append).toBe(`Session not found: ${sessionId}`);
  expect(await getStatePatches(sessionId)).toBeNull();
});

it("rejects a patch for another session before writing", async () => {
  await expect(
    service.addStatePatch(sessionId, {
      ...patch("wrong-session"),
      sessionId: "another-session",
    }),
  ).rejects.toThrow("session mismatch");
  expect(await getStatePatches(sessionId)).toBeNull();
});

it("rejects transaction abort instead of acknowledging a patch that was not saved", async () => {
  await getStatePatches(sessionId);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    const request = put.call(this, value, key);
    if (this.name === APP_KV_STORE_STATE_PATCHES)
      request.addEventListener("success", () => this.transaction.abort(), {
        once: true,
      });
    return request;
  });
  await expect(
    service.addStatePatch(sessionId, patch("aborted")),
  ).rejects.toThrow();
  expect(await getStatePatches(sessionId)).toBeNull();
});
