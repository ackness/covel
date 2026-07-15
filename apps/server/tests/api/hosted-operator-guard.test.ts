import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import { worldRoutes } from "../../src/routes/api/worlds.js";
import { aiRoutes } from "../../src/routes/api/ai.js";
import { createModelDbRoutes } from "../../src/routes/model-db.js";

const ENV_KEYS = ["DEPLOYMENT_TIER", "COVEL_DESKTOP_REST_TOKEN"] as const;
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createApp(store: DataStore): Hono {
  const app = new Hono();
  const eventBus = createEventBus(store);
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("eventBus", eventBus);
    c.set("worldsDirs", []);
    await next();
  });
  app.route("/api/worlds", worldRoutes);
  app.route("/api/ai", aiRoutes);
  app.route(
    "/",
    createModelDbRoutes({
      modelDb: undefined,
    } as never),
  );
  return app;
}

const OPERATOR_HEADERS = {
  authorization: "Bearer operator-secret",
  "content-type": "application/json",
};

let store: DataStore;
let app: Hono;

beforeEach(async () => {
  process.env.DEPLOYMENT_TIER = "commercial";
  process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
  store = createMemoryStore();
  app = createApp(store);
  await store.upsertWorld({
    id: "existing",
    name: "Existing",
    description: "",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe("hosted global operator guard", () => {
  it.each([
    ["POST", "/api/worlds", { id: "new", name: "New" }],
    ["PATCH", "/api/worlds/existing", { name: "Changed" }],
    ["DELETE", "/api/worlds/existing", undefined],
    ["POST", "/api/worlds/existing/dimensions/import", { dimensions: {} }],
    ["POST", "/api/ai/generate-world", { prompt: "world" }],
    ["POST", "/api/model-db/refresh", undefined],
  ])(
    "rejects anonymous %s %s before route work",
    async (method, path, body) => {
      const res = await app.request(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });

      expect(res.status).toBe(401);
      expect((await res.json()) as object).toMatchObject({
        code: "operator_token_required",
      });
    },
  );

  it("rejects an arbitrary session owner token", async () => {
    const res = await app.request("/api/worlds", {
      method: "POST",
      headers: {
        authorization: "Bearer session-owner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "new", name: "New" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts the operator token", async () => {
    const res = await app.request("/api/worlds", {
      method: "POST",
      headers: OPERATOR_HEADERS,
      body: JSON.stringify({ id: "new", name: "New" }),
    });
    expect(res.status).toBe(200);
  });

  it("is a no-op on self tier", async () => {
    process.env.DEPLOYMENT_TIER = "self";
    const res = await app.request("/api/worlds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "local", name: "Local" }),
    });
    expect(res.status).toBe(200);
  });
});
