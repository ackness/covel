import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { APP_KV_STORE_WORLD_OVERLAYS } from "@covel/store/idb-schema";
import {
  appendStatePatch,
  getExecutionSteps,
  getStatePatches,
  getWorldOverlay,
  removeWorldOverlay,
  removeExecutionSteps,
  setWorldOverlay,
  saveExecutionSteps,
} from "../app-kv-store.js";

afterEach(() => vi.restoreAllMocks());

it("captures timeline entries before asynchronous storage work", async () => {
  const sessionId = `owned-timeline-${crypto.randomUUID()}`;
  const steps = [{ runtimeId: "probe", detail: { progress: 1 } }];
  const saving = saveExecutionSteps(sessionId, steps);
  steps[0]!.detail.progress = 99;
  await saving;
  expect(await getExecutionSteps(sessionId)).toEqual([
    { runtimeId: "probe", detail: { progress: 1 } },
  ]);
});

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

it("merges independent timeline windows atomically and preserves absent history", async () => {
  const sessionId = `history-${crypto.randomUUID()}`;
  const early = { turnId: "early", runtimeId: "story", status: "completed" };
  const late = { turnId: "late", runtimeId: "story", status: "suspended" };
  await Promise.all([
    saveExecutionSteps(sessionId, [early]),
    saveExecutionSteps(sessionId, [late]),
  ]);
  expect(await getExecutionSteps(sessionId)).toEqual([early, late]);
  const resumed = { ...late, status: "running" };
  await saveExecutionSteps(sessionId, [resumed]);
  await saveExecutionSteps(sessionId, []);
  expect(await getExecutionSteps(sessionId)).toEqual([early, resumed]);
  await removeExecutionSteps(sessionId);
  expect(await getExecutionSteps(sessionId)).toEqual([]);
});

it("rejects unkeyed timeline rows without partially overwriting history", async () => {
  const sessionId = `invalid-history-${crypto.randomUUID()}`;
  const before = { turnId: "before", runtimeId: "story" };
  await saveExecutionSteps(sessionId, [before]);
  await expect(
    saveExecutionSteps(sessionId, [
      { turnId: "new", runtimeId: "story" },
      { status: "completed" },
    ]),
  ).rejects.toThrow("Invalid execution history identity");
  expect(await getExecutionSteps(sessionId)).toEqual([before]);
});

it("deduplicates replayed state patches atomically while preserving distinct same-time commits", async () => {
  const sessionId = `replayed-patches-${crypto.randomUUID()}`;
  const patch = {
    id: "sp_trace:1",
    sessionId,
    summary: "First",
    packageName: "probe",
    data: { stats: { hp: 1 } },
    createdAt: "2026-09-19T00:00:00Z",
  };
  const writes = Promise.all([
    appendStatePatch(patch),
    appendStatePatch({ ...patch, data: { stats: { hp: 999 } } }),
    appendStatePatch({
      ...patch,
      id: "sp_trace:2",
      data: { stats: { mp: 3 } },
    }),
  ]);
  patch.data.stats.hp = 100;
  await writes;
  expect(await getStatePatches(sessionId)).toEqual([
    { ...patch, data: { stats: { hp: 1 } } },
    { ...patch, id: "sp_trace:2", data: { stats: { mp: 3 } } },
  ]);
});
