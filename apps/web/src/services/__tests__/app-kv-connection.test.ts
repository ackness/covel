import "fake-indexeddb/auto";
import {
  forceCloseDatabase,
  IDBFactory as FakeIDBFactory,
} from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BROWSER_STORAGE_DB_NAME } from "../storage/data-store.js";

let factory: IDBFactory;
let connections: IDBDatabase[];
let cache: typeof import("../app-kv-store.js");

beforeEach(async () => {
  vi.resetModules();
  factory = new FakeIDBFactory();
  connections = [];
  vi.stubGlobal("indexedDB", factory);
  const open = factory.open.bind(factory);
  vi.spyOn(factory, "open").mockImplementation((name, version) => {
    const request = open(name, version);
    request.addEventListener("success", () => connections.push(request.result));
    return request;
  });
  cache = await import("../app-kv-store.js");
});

afterEach(() => {
  for (const connection of connections) connection.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deleteCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(BROWSER_STORAGE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Old cache connection blocked deletion"));
  });
}

it("allows a later operation to retry a synchronous open failure", async () => {
  vi.mocked(factory.open).mockImplementationOnce(() => {
    throw new DOMException("Synthetic open failure", "UnknownError");
  });
  await expect(cache.getExecutionSteps("session")).rejects.toThrow(
    "Synthetic open failure",
  );
  await cache.saveExecutionSteps("session", [{ status: "completed" }]);
  expect(await cache.getExecutionSteps("session")).toEqual([
    { status: "completed" },
  ]);
});

it("allows a later operation to retry after an asynchronous open error", async () => {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(BROWSER_STORAGE_DB_NAME, 99);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
  await expect(cache.getExecutionSteps("session")).rejects.toMatchObject({
    name: "VersionError",
  });
  await deleteCache();
  await cache.saveExecutionSteps("session", [{ status: "completed" }]);
  expect(await cache.getExecutionSteps("session")).toEqual([
    { status: "completed" },
  ]);
});

it("reopens after an unexpected close and retains persisted data", async () => {
  await cache.saveExecutionSteps("session", [{ status: "completed" }]);
  const connection = connections[0]!;
  const closed = new Promise<void>((resolve) => {
    connection.addEventListener("close", () => resolve(), { once: true });
  });
  // fake-indexeddb declares a constructor parameter, but its implementation
  // accepts the live connection instance and emits the real close event.
  const forceClose = forceCloseDatabase as unknown as (db: IDBDatabase) => void;
  forceClose(connection);
  await closed;
  expect(await cache.getExecutionSteps("session")).toEqual([
    { status: "completed" },
  ]);
  expect(factory.open).toHaveBeenCalledTimes(2);
});

it("releases its connection for cache deletion and recreates it on demand", async () => {
  await cache.saveExecutionSteps("session", [{ status: "completed" }]);
  await deleteCache();
  expect(await cache.getExecutionSteps("session")).toEqual([]);
  await cache.saveExecutionSteps("session", [{ status: "running" }]);
  expect(await cache.getExecutionSteps("session")).toEqual([
    { status: "running" },
  ]);
});

it("shares an in-flight open across concurrent callers", async () => {
  await Promise.all([
    cache.saveExecutionSteps("first", [{ status: "completed" }]),
    cache.saveExecutionSteps("second", [{ status: "running" }]),
  ]);
  expect(await cache.getExecutionSteps("first")).toEqual([
    { status: "completed" },
  ]);
  expect(await cache.getExecutionSteps("second")).toEqual([
    { status: "running" },
  ]);
  expect(factory.open).toHaveBeenCalledTimes(1);
});
