import { afterEach, describe, expect, it } from "vitest";
import { createStoreFromEnv, resolveBackendFromEnv } from "../src/factory.js";

const ENV_KEYS = ["STORE_BACKEND", "SQLITE_PATH", "DATABASE_URL"] as const;

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
      STORE_BACKEND: "postgres",
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
});
