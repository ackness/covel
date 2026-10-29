import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_KV_STORE_STATE_PATCHES } from "@covel/store/idb-schema";
import type { StatePatchRecord } from "../api/types.js";
import {
  appendStatePatch,
  getStatePatches,
  removeStatePatches,
} from "../app-kv-store.js";
import { LocalDataService } from "../data-service/local.js";
import { BrowserVault } from "../storage/browser-vault.js";

const api = await vi.hoisted(async () => {
  const { fakeSessionServer } =
    await import("./support/fake-session-server.js");
  return fakeSessionServer();
});
vi.mock("../api.js", () => api);

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
  await service.createSession("world", sessionId);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeStatePatches(sessionId);
  await vault.deleteDatabase();
});

it("reads restored cache history across service instances", async () => {
  await appendStatePatch(patch("first"));
  await appendStatePatch(patch("second"));
  expect(
    (await second.listStatePatches(sessionId)).map((item) => item.id),
  ).toEqual(["first", "second"]);
  await appendStatePatch(patch("third"));
  expect((await getStatePatches(sessionId))?.map((item) => item.id)).toEqual([
    "first",
    "second",
    "third",
  ]);
});

it.each([false, true])(
  "retains concurrent cache appends (warm: %s)",
  async (warm) => {
    if (warm) await appendStatePatch(patch("existing"));
    await Promise.all([
      appendStatePatch(patch("first")),
      appendStatePatch(patch("second")),
    ]);
    expect(
      (await getStatePatches(sessionId))?.map((item) => item.id).sort(),
    ).toEqual(warm ? ["existing", "first", "second"] : ["first", "second"]);
  },
);

it("retains concurrent cache restores after services read an empty list", async () => {
  await Promise.all([
    service.listStatePatches(sessionId),
    second.listStatePatches(sessionId),
  ]);
  await Promise.all([
    appendStatePatch(patch("first")),
    appendStatePatch(patch("second")),
  ]);
  expect(
    (await getStatePatches(sessionId))?.map((item) => item.id).sort(),
  ).toEqual(["first", "second"]);
});

it("reads restored cache entries after an earlier empty read", async () => {
  expect(await service.listStatePatches(sessionId)).toEqual([]);
  await appendStatePatch(patch("other-service"));
  expect(
    (await service.listStatePatches(sessionId)).map((item) => item.id),
  ).toEqual(["other-service"]);
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
  await expect(appendStatePatch(patch("aborted"))).rejects.toThrow();
  expect(await getStatePatches(sessionId)).toBeNull();
});
