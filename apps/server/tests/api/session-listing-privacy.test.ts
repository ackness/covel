/**
 * GET /api/sessions privacy gate.
 *
 * MemoryStore deployments serve local-mode (browser IndexedDB) frontends,
 * which never list sessions from the server — server-side sessions there are
 * transient sync copies for turn execution. On a shared public host the
 * listing must therefore be hidden, unless ENABLE_DEBUG_PAGE opts back in
 * (dev tooling) or NODE_ENV is not production.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createMemoryStore,
  type DataStore,
  type StoreBackend,
} from "@covel/store";
import { sessionRoutes } from "../../src/routes/api/session.js";

function buildApp(store: DataStore, backend?: StoreBackend): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    if (backend) {
      c.set("storeBackend", backend);
    }
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  return app;
}

async function seedSession(store: DataStore): Promise<void> {
  await store.createSession({
    id: "sess-privacy",
    worldId: "cloudmere",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_DEBUG_PAGE = process.env.ENABLE_DEBUG_PAGE;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("NODE_ENV", ORIGINAL_NODE_ENV);
  restoreEnv("ENABLE_DEBUG_PAGE", ORIGINAL_DEBUG_PAGE);
});

async function listItems(app: Hono): Promise<unknown[]> {
  const res = await app.request("/api/sessions");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: unknown[] };
  return body.items;
}

describe("GET /api/sessions listing privacy", () => {
  it("hides the listing on memory backend in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ENABLE_DEBUG_PAGE;
    const store = createMemoryStore();
    await seedSession(store);

    const items = await listItems(buildApp(store, "memory"));
    expect(items).toEqual([]);
  });

  it("keeps the listing when ENABLE_DEBUG_PAGE opts in", async () => {
    process.env.NODE_ENV = "production";
    process.env.ENABLE_DEBUG_PAGE = "1";
    const store = createMemoryStore();
    await seedSession(store);

    const items = await listItems(buildApp(store, "memory"));
    expect(items).toHaveLength(1);
  });

  it("keeps the listing outside production (dev servers)", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.ENABLE_DEBUG_PAGE;
    const store = createMemoryStore();
    await seedSession(store);

    const items = await listItems(buildApp(store, "memory"));
    expect(items).toHaveLength(1);
  });

  it("keeps the listing on persistent backends (remote mode)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ENABLE_DEBUG_PAGE;
    const store = createMemoryStore();
    await seedSession(store);

    const items = await listItems(buildApp(store, "sqlite"));
    expect(items).toHaveLength(1);
  });
});
