import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_IDB_DATABASE_NAME,
  createMediaStoreFromEnv,
  createStore,
  createStoreFromEnv,
  IDB_BROWSER_STORAGE_SCHEMA_VERSION,
  IDB_DATA_STORE_SCHEMA_VERSION,
  resolveBackendFromEnv,
  summarizeStorageMigrations,
} from "../src/index.js";

const ENV_KEYS = [
  "STORE_BACKEND",
  "SQLITE_PATH",
  "DATABASE_URL",
  "MEDIA_BACKEND",
  "MEDIA_ROOT",
  "VECTOR_BACKEND",
] as const;

function withEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
): void {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }
}

describe("store factory env wiring", () => {
  const savedEnv: Partial<
    Record<(typeof ENV_KEYS)[number], string | undefined>
  > = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  it("resolves invalid STORE_BACKEND through the shared env fallback", () => {
    withEnv({
      STORE_BACKEND: "idb",
      SQLITE_PATH: undefined,
      DATABASE_URL: undefined,
    });

    expect(resolveBackendFromEnv()).toBe("sqlite");
  });

  it("creates an in-memory store when STORE_BACKEND=memory", async () => {
    withEnv({
      STORE_BACKEND: "memory",
      SQLITE_PATH: undefined,
      DATABASE_URL: undefined,
    });

    const store = await createStoreFromEnv();
    await store.createSession({
      id: "factory-memory-session",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "en",
      activePlugins: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(await store.getSession("factory-memory-session")).toMatchObject({
      id: "factory-memory-session",
      status: "active",
    });
  });

  it("creates an IndexedDB store through the generic factory", async () => {
    await import("fake-indexeddb/auto");

    const store = await createStore({
      backend: "idb",
      idbDbName: "factory-idb-store",
    });
    await store.createSession({
      id: "factory-idb-session",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "en",
      activePlugins: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(await store.getSession("factory-idb-session")).toMatchObject({
      id: "factory-idb-session",
      status: "active",
    });
  });

  it("uses the unified browser IndexedDB name by default", async () => {
    await import("fake-indexeddb/auto");

    const store = await createStore({ backend: "idb" });
    await store.createSession({
      id: "factory-default-idb-session",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "en",
      activePlugins: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.close?.();

    const req = indexedDB.open(BROWSER_IDB_DATABASE_NAME);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(db.objectStoreNames.contains("sessions")).toBe(true);
    db.close();
  });

  it("fails fast for pg backend when DATABASE_URL is missing", async () => {
    withEnv({
      STORE_BACKEND: "pg",
      SQLITE_PATH: undefined,
      DATABASE_URL: undefined,
    });

    await expect(createStoreFromEnv()).rejects.toThrow(
      "DATABASE_URL required for pg backend",
    );
  });

  it("mirrors memory DataStore media backend by default", async () => {
    withEnv({
      STORE_BACKEND: "memory",
      SQLITE_PATH: undefined,
      DATABASE_URL: undefined,
      MEDIA_BACKEND: undefined,
      MEDIA_ROOT: undefined,
    });

    const store = await createMediaStoreFromEnv();
    expect(store).toBeDefined();
    const ref = await store!.put(new Uint8Array([1, 2, 3]), "image/png");
    expect(await store!.resolveUrl(ref)).toBe(`memory://media/${ref.id}`);
  });

  it("uses MEDIA_BACKEND=none to disable media storage", async () => {
    withEnv({
      STORE_BACKEND: "memory",
      SQLITE_PATH: undefined,
      DATABASE_URL: undefined,
      MEDIA_BACKEND: "none",
      MEDIA_ROOT: undefined,
    });

    await expect(createMediaStoreFromEnv()).resolves.toBeUndefined();
  });

  it("falls back from non-server media backends on the server env path", async () => {
    withEnv({
      STORE_BACKEND: "memory",
      SQLITE_PATH: undefined,
      DATABASE_URL: undefined,
      MEDIA_BACKEND: "idb",
      MEDIA_ROOT: undefined,
    });

    const store = await createMediaStoreFromEnv();
    expect(store).toBeDefined();
    const ref = await store!.put(new Uint8Array([4, 5, 6]), "image/png");
    expect(await store!.resolveUrl(ref)).toBe(`memory://media/${ref.id}`);

    withEnv({
      STORE_BACKEND: "memory",
      SQLITE_PATH: undefined,
      DATABASE_URL: undefined,
      MEDIA_BACKEND: "s3",
      MEDIA_ROOT: undefined,
    });

    const s3Fallback = await createMediaStoreFromEnv();
    expect(s3Fallback).toBeDefined();
    const s3Ref = await s3Fallback!.put(new Uint8Array([7, 8, 9]), "image/png");
    expect(await s3Fallback!.resolveUrl(s3Ref)).toBe(
      `memory://media/${s3Ref.id}`,
    );
  });

  it("summarizes storage migration descriptors", () => {
    const summary = summarizeStorageMigrations();

    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "browser:idb:unified-storage",
          domain: "browser",
          backend: "idb",
          version: IDB_BROWSER_STORAGE_SCHEMA_VERSION,
        }),
        expect.objectContaining({
          id: "data:idb:store",
          domain: "data",
          backend: "idb",
          version: IDB_DATA_STORE_SCHEMA_VERSION,
        }),
        expect.objectContaining({
          id: "vector:embedded:model-registry",
          domain: "vector",
          backend: "embedded",
        }),
      ]),
    );
  });

  it("returns no media store for pg without DATABASE_URL", async () => {
    withEnv({
      STORE_BACKEND: "pg",
      SQLITE_PATH: undefined,
      DATABASE_URL: undefined,
      MEDIA_BACKEND: undefined,
      MEDIA_ROOT: undefined,
    });

    await expect(createMediaStoreFromEnv()).resolves.toBeUndefined();
  });
});
