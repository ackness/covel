import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import {
  forceCloseDatabase,
  IDBFactory as FakeIDBFactory,
} from "fake-indexeddb";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  BROWSER_IDB_DATABASE_NAME,
  MEDIA_CACHE_STORE_BLOBS,
} from "@covel/store/idb-schema";
import type { MediaCacheRecord } from "../media-cache.js";

let getCachedMedia: typeof import("../media-cache.js").getCachedMedia;
let putCachedMedia: typeof import("../media-cache.js").putCachedMedia;
let deleteCachedMedia: typeof import("../media-cache.js").deleteCachedMedia;
let factory: IDBFactory;
let connections: IDBDatabase[];

beforeEach(async () => {
  vi.resetModules();
  factory = new FakeIDBFactory();
  connections = [];
  vi.stubGlobal("indexedDB", factory);
  vi.stubGlobal("Blob", NativeBlob);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const open = factory.open.bind(factory);
  vi.spyOn(factory, "open").mockImplementation((name, version) => {
    const request = open(name, version);
    request.addEventListener("success", () => connections.push(request.result));
    return request;
  });
  ({ getCachedMedia, putCachedMedia, deleteCachedMedia } =
    await import("../media-cache.js"));
});

afterEach(() => {
  for (const connection of connections) connection.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deleteCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(BROWSER_IDB_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Cache connection blocked deletion"));
  });
}

function makeRecord(id: string): MediaCacheRecord {
  const blob = new Blob(["hello-" + id], { type: "image/png" });
  return {
    id,
    mime: "image/png",
    size: blob.size,
    blob,
    savedAt: 1234,
  };
}

describe("media-cache", () => {
  it("shares its connection with app state and releases both for deletion", async () => {
    const app = await import("../../services/app-kv-store.js");
    await Promise.all([
      putCachedMedia(makeRecord("shared")),
      app.saveExecutionSteps("session", [
        { runtimeId: "probe", status: "completed" },
      ]),
    ]);
    expect(factory.open).toHaveBeenCalledTimes(1);
    await deleteCache();
    expect(await getCachedMedia("shared")).toBeNull();
    expect(await app.getExecutionSteps("session")).toEqual([]);
  });

  it("falls back on a blocked open and does not leave an abandoned connection", async () => {
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(BROWSER_IDB_DATABASE_NAME, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // Request a genuine upgrade while another document retains the old handle.
    const open = vi.mocked(factory.open).getMockImplementation()!;
    vi.mocked(factory.open).mockImplementation((name, version) =>
      open(name, (version ?? 1) + 1),
    );
    const app = await import("../../services/app-kv-store.js");
    await Promise.all([
      expect(getCachedMedia("blocked")).resolves.toBeNull(),
      expect(app.getExecutionSteps("session")).rejects.toMatchObject({
        name: "InvalidStateError",
      }),
    ]);
    let settled = false;
    const repeated = putCachedMedia(makeRecord("still-blocked")).then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200 });
    } finally {
      blocker.close();
      await repeated;
    }
    await deleteCache();
    await putCachedMedia(makeRecord("retry-blocked"));
    expect(await getCachedMedia("retry-blocked")).not.toBeNull();
  });

  it("does not expose record URLs or browser exception messages in warnings", async () => {
    const record = makeRecord("privacy");
    await putCachedMedia(record);
    const expected = {
      ...record,
      size: record.size + 1,
      url: "https://example.invalid/?token=synthetic-private-value",
    };
    expect(await getCachedMedia(record.id, expected)).toBeNull();
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new Error("synthetic-private-value");
    });
    await expect(
      putCachedMedia(makeRecord("failed-write")),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
    const logged = vi
      .mocked(console.warn)
      .mock.calls.flat()
      .map((value) =>
        value instanceof Error ? String(value) : JSON.stringify(value),
      )
      .join(" ");
    expect(logged).not.toContain("synthetic-private-value");
  });

  it("keeps the first admitted record when writes race", async () => {
    const first = makeRecord("race");
    await Promise.all([
      putCachedMedia(first),
      putCachedMedia({ ...first, savedAt: 9999 }),
    ]);
    expect((await getCachedMedia("race"))?.savedAt).toBe(first.savedAt);
  });

  it("does not evict a valid replacement written after an invalid read", async () => {
    const valid = makeRecord("repaired");
    await getCachedMedia(valid.id);
    await new Promise<void>((resolve) => {
      const tx = connections[0]!.transaction(
        MEDIA_CACHE_STORE_BLOBS,
        "readwrite",
      );
      tx.objectStore(MEDIA_CACHE_STORE_BLOBS).put({
        ...valid,
        size: valid.size + 1,
      });
      tx.oncomplete = () => resolve();
    });
    let repaired!: () => void;
    const repair = new Promise<void>((resolve) => {
      repaired = resolve;
    });
    const get = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementationOnce(function (
      this: IDBObjectStore,
      key,
    ) {
      const request = get.call(this, key);
      request.addEventListener("success", () => {
        // Queue another document's replacement before deferred eviction starts.
        const tx = this.transaction.db.transaction(
          MEDIA_CACHE_STORE_BLOBS,
          "readwrite",
        );
        tx.objectStore(MEDIA_CACHE_STORE_BLOBS).put(valid);
        tx.oncomplete = () => repaired();
      });
      return request;
    });
    expect(await getCachedMedia(valid.id, valid)).toBeNull();
    await repair;
    expect(await getCachedMedia(valid.id, valid)).not.toBeNull();
  });

  it("retries a failed open on a later cache operation", async () => {
    vi.mocked(factory.open).mockImplementationOnce(() => {
      throw new DOMException("Synthetic open failure", "UnknownError");
    });
    expect(await getCachedMedia("retry")).toBeNull();
    await putCachedMedia(makeRecord("retry"));
    expect(await getCachedMedia("retry")).not.toBeNull();
  });

  it("reopens after an unexpected close without losing persisted blobs", async () => {
    await putCachedMedia(makeRecord("close"));
    const connection = connections[0]!;
    const closed = new Promise<void>((resolve) =>
      connection.addEventListener("close", () => resolve(), { once: true }),
    );
    // The dependency's declaration incorrectly accepts a constructor.
    (forceCloseDatabase as unknown as (db: IDBDatabase) => void)(connection);
    await closed;
    expect(await getCachedMedia("close")).not.toBeNull();
  });

  it("releases the connection for database deletion and opens a fresh cache", async () => {
    await putCachedMedia(makeRecord("delete"));
    await deleteCache();
    expect(await getCachedMedia("delete")).toBeNull();
    await putCachedMedia(makeRecord("new"));
    expect(await getCachedMedia("new")).not.toBeNull();
  });

  it.each(["put", "delete"] as const)(
    "reports an aborted %s transaction even after request success",
    async (operation) => {
      const record = makeRecord("aborted");
      if (operation === "delete") await putCachedMedia(record);
      else await getCachedMedia(record.id);
      function abortAfterSuccess<T>(
        store: IDBObjectStore,
        request: IDBRequest<T>,
      ) {
        if (store.name === MEDIA_CACHE_STORE_BLOBS)
          request.addEventListener("success", () => store.transaction.abort(), {
            once: true,
          });
        return request;
      }
      if (operation === "put") {
        const put = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
          this: IDBObjectStore,
          value,
          key,
        ) {
          return abortAfterSuccess(this, put.call(this, value, key));
        });
      } else {
        const remove = IDBObjectStore.prototype.delete;
        vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(
          function (this: IDBObjectStore, key) {
            return abortAfterSuccess(this, remove.call(this, key));
          },
        );
      }
      await expect(
        operation === "put"
          ? putCachedMedia(record)
          : deleteCachedMedia(record.id),
      ).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
      const stored = await getCachedMedia(record.id);
      if (operation === "put") expect(stored).toBeNull();
      else expect(stored).not.toBeNull();
    },
  );

  it("treats a malformed stored blob as a cache miss", async () => {
    await getCachedMedia("corrupt");
    await new Promise<void>((resolve, reject) => {
      const tx = connections[0]!.transaction(
        MEDIA_CACHE_STORE_BLOBS,
        "readwrite",
      );
      tx.objectStore(MEDIA_CACHE_STORE_BLOBS).put({
        id: "corrupt",
        mime: "image/png",
        size: 1,
        savedAt: 1,
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    await expect(
      getCachedMedia("corrupt", { id: "corrupt", mime: "image/png", size: 1 }),
    ).resolves.toBeNull();
  });

  it("round-trips put → get for a single record", async () => {
    const record = makeRecord("abc");
    await putCachedMedia(record);
    const got = await getCachedMedia("abc");
    expect(got).not.toBeNull();
    expect(got?.id).toBe("abc");
    expect(got?.mime).toBe("image/png");
    expect(got?.size).toBe(record.size);
    expect(got?.blob).toBeInstanceOf(Blob);
  });

  it("returns null for a missing id", async () => {
    const got = await getCachedMedia("never-stored");
    expect(got).toBeNull();
  });

  it("put is idempotent: re-putting the same id keeps the first record", async () => {
    const first = makeRecord("dup");
    await putCachedMedia(first);
    const second: MediaCacheRecord = {
      ...first,
      blob: new Blob(["different"], { type: "image/png" }),
      savedAt: 9999,
    };
    await putCachedMedia(second);
    const got = await getCachedMedia("dup");
    // Idempotent: the original (first) record wins.
    expect(got?.savedAt).toBe(1234);
  });

  it("delete removes the record", async () => {
    await putCachedMedia(makeRecord("zap"));
    await deleteCachedMedia("zap");
    const got = await getCachedMedia("zap");
    expect(got).toBeNull();
  });

  it("returns null gracefully when indexedDB is unavailable", async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const got = await getCachedMedia("anything");
    expect(got).toBeNull();
    // putCachedMedia should also be a no-op (resolves without throwing)
    await expect(putCachedMedia(makeRecord("noop"))).resolves.toBeUndefined();
  });

  it("evicts a cached record when its size disagrees with the expected ref", async () => {
    await putCachedMedia(makeRecord("evict-size"));
    const got = await getCachedMedia("evict-size", {
      id: "evict-size",
      mime: "image/png",
      size: 999_999, // intentionally wrong
    });
    expect(got).toBeNull();
    // After eviction, a follow-up read returns nothing (record gone).
    // Allow the deferred delete a microtask to complete.
    await Promise.resolve();
    const after = await getCachedMedia("evict-size");
    expect(after).toBeNull();
  });

  it("evicts a cached record when its mime disagrees with the expected ref", async () => {
    await putCachedMedia(makeRecord("evict-mime"));
    const got = await getCachedMedia("evict-mime", {
      id: "evict-mime",
      mime: "image/jpeg", // stored is image/png
      size: makeRecord("evict-mime").size,
    });
    expect(got).toBeNull();
  });

  it("returns the record when expected shape matches", async () => {
    const record = makeRecord("ok");
    await putCachedMedia(record);
    const got = await getCachedMedia("ok", {
      id: "ok",
      mime: record.mime,
      size: record.size,
    });
    expect(got).not.toBeNull();
    expect(got?.id).toBe("ok");
  });
});
