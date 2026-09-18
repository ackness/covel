import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { APP_KV_STORE_WORLD_OVERLAYS } from "@covel/store/idb-schema";
import {
  appendStatePatch,
  getStatePatches,
  getWorldOverlay,
  removeWorldOverlay,
  setWorldOverlay,
} from "../app-kv-store.js";

afterEach(() => vi.restoreAllMocks());

it("appends atomically even without the service's session lock", async () => {
  const sessionId = `direct-patches-${crypto.randomUUID()}`;
  await Promise.all(
    ["first", "second"].map((id) =>
      appendStatePatch({
        id,
        sessionId,
        summary: id,
        packageName: "probe",
        createdAt: "2026-01-01",
      }),
    ),
  );
  expect(
    (await getStatePatches(sessionId))?.map((patch) => patch.id).sort(),
  ).toEqual(["first", "second"]);
});

it("does not acknowledge a write whose transaction aborts after request success", async () => {
  const worldId = `aborted-put-${crypto.randomUUID()}`;
  const before = { lore: "Before", updatedAt: "2026-01-01" };
  await setWorldOverlay(worldId, before);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    const request = put.call(this, value, key);
    if (this.name === APP_KV_STORE_WORLD_OVERLAYS)
      request.addEventListener("success", () => this.transaction.abort(), {
        once: true,
      });
    return request;
  });
  await expect(
    setWorldOverlay(worldId, { lore: "After", updatedAt: "2026-01-02" }),
  ).rejects.toThrow();
  expect(await getWorldOverlay(worldId)).toEqual(before);
});

it("does not acknowledge deletion whose transaction aborts after request success", async () => {
  const worldId = `aborted-delete-${crypto.randomUUID()}`;
  const before = { lore: "Preserve", updatedAt: "2026-01-01" };
  await setWorldOverlay(worldId, before);
  const remove = IDBObjectStore.prototype.delete;
  vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
    this: IDBObjectStore,
    key,
  ) {
    const request = remove.call(this, key);
    if (this.name === APP_KV_STORE_WORLD_OVERLAYS)
      request.addEventListener("success", () => this.transaction.abort(), {
        once: true,
      });
    return request;
  });
  await expect(removeWorldOverlay(worldId)).rejects.toThrow();
  expect(await getWorldOverlay(worldId)).toEqual(before);
});
