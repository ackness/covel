import { afterEach, describe, expect, it } from "vitest";
import {
  createMediaStoreFromEnv,
  createStoreFromEnv,
  resolveBackendFromEnv,
  STORAGE_MIGRATIONS,
} from "../src/index.js";
import { BROWSER_IDB_SCHEMA_VERSION } from "../src/indexeddb/idb-schema.js";

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

  it("rejects an unknown STORE_BACKEND instead of falling back", () => {
    withEnv({
      STORE_BACKEND: "idb",
      SQLITE_PATH: undefined,
      DATABASE_URL: undefined,
    });

    expect(() => resolveBackendFromEnv()).toThrow(
      'Unknown STORE_BACKEND "idb". Accepted values: memory, sqlite, pg.',
    );
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
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: {},
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

  it("rejects non-server media backends on the server env path", async () => {
    for (const backend of ["idb", "s3"]) {
      withEnv({
        STORE_BACKEND: "memory",
        SQLITE_PATH: undefined,
        DATABASE_URL: undefined,
        MEDIA_BACKEND: backend,
        MEDIA_ROOT: undefined,
      });

      await expect(async () => createMediaStoreFromEnv()).rejects.toThrow(
        `Unknown MEDIA_BACKEND "${backend}"`,
      );
    }
  });

  it("summarizes storage migration descriptors", () => {
    const summary = STORAGE_MIGRATIONS;

    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "browser:idb:cache-media",
          domain: "browser",
          backend: "idb",
          version: BROWSER_IDB_SCHEMA_VERSION,
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
