/**
 * Dimension providers in a session's plugin set, on SQLite and PostgreSQL:
 *
 * - several active providers are refused with their names (`409
 *   dimension_provider_conflict`), at creation, in the prep preflight and when
 *   a second one is turned on;
 * - a provider turned on after creation gets the world's dimensions at once;
 * - a session whose bound provider is gone still loads and changes plugins,
 *   with its dimensions kept as they are.
 *
 * PostgreSQL runs when `DATABASE_URL` reaches a server (always under
 * `pnpm test:pg`, which sets `COVEL_REQUIRE_PG_TESTS=1`).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRpcApprovalGate } from "@covel/approval";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  parsePluginMd,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import {
  DIMENSION_CONTRACT,
  DIMENSION_DATA_NAMESPACE,
  type SessionSnapshot,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import { createPgStore } from "@covel/store/postgres";
import { createSqliteStore } from "@covel/store/sqlite";
import { makeErrorHandler } from "../../src/api-error.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { worldDataSyncRoutes } from "../../src/routes/api/worlds/data-sync.js";
import { registerDimensionProvider } from "../helpers/dimension-provider.js";
import {
  createIsolatedPgDatabase,
  type IsolatedPgDatabase,
} from "./pg-test-db.js";

const BASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const REQUIRE_PG = process.env.COVEL_REQUIRE_PG_TESTS === "1";
let pgDatabase: IsolatedPgDatabase | undefined;

/** A database of this file's own, or none when PostgreSQL is not running. */
async function isolatedPgUrl(): Promise<string | null> {
  try {
    pgDatabase = await createIsolatedPgDatabase(
      BASE_URL,
      "covel_test_dimension_providers",
    );
    return pgDatabase.url;
  } catch (error) {
    if (REQUIRE_PG)
      throw new Error("PostgreSQL is required for the dimension tests", {
        cause: error,
      });
    return null;
  }
}

const pgUrl = await isolatedPgUrl();
afterAll(async () => {
  await pgDatabase?.cleanup();
}, 90_000);

const backends: [string, () => Promise<DataStore>][] = [
  ["sqlite", async () => createSqliteStore(":memory:")],
  ...(pgUrl
    ? [
        ["postgres", () => createPgStore(pgUrl, { freshSchema: true })] as [
          string,
          () => Promise<DataStore>,
        ],
      ]
    : []),
];

const RIVAL = "rival-dimensions";

/** A bundled plugin with no runtimes; `provides` names its contracts. */
function plugin(
  id: string,
  provides: readonly string[] = [],
): PluginRegistryEntry {
  return {
    id,
    rootPath: `/plugins/${id}`,
    source: "builtin",
    summary: {
      id,
      name: id,
      description: "",
      kind: "plugin",
      runtimeCount: 0,
    },
    packageManifest: parsePluginMd(
      `---\n${JSON.stringify({ id, kind: "plugin", description: id, provides: [...provides, `${id}@1`] })}\n---\n`,
      `${id}/PLUGIN.md`,
    ),
    manifests: [],
    loadedRuntimes: new Map(),
    status: "registered",
  };
}

function makeApp(store: DataStore, registry: PluginRegistry): Hono {
  const gate = createRpcApprovalGate();
  const sessionLock = createInProcessSessionLock();
  const eventBus = createEventBus();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("rpcApprovalGate", gate);
    c.set("activatePluginServerCode", async () => {});
    c.set("sessionLock", sessionLock);
    c.set("eventBus", eventBus);
    await next();
  });
  // The production handler: it answers the provider conflict with a 409.
  app.onError(makeErrorHandler("[dimension-provider-test]", false));
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/worlds", worldDataSyncRoutes);
  return app;
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe.each(backends)("dimension providers of a session (%s)", (_, open) => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;

  beforeEach(async () => {
    store = await open();
    registry = createPluginRegistry();
    await registerDimensionProvider(registry, "builtin");
    registry.register(plugin("notes"));
    registry.register(plugin(RIVAL, [DIMENSION_CONTRACT]));
    app = makeApp(store, registry);
    await store.upsertWorld({
      id: "w",
      name: "World",
      description: "",
      metadata: {
        dimensions: {
          stamina: {
            name: "Stamina",
            schema: { type: "integer", minimum: 0 },
            initialValue: 3,
          },
        },
      },
      createdAt: "2026-10-15T00:00:00.000Z",
    });
  });
  afterEach(async () => {
    await store.close();
  });

  const create = (body: Record<string, unknown>) =>
    app.request("/api/sessions", json({ id: "s", worldId: "w", ...body }));
  const toggle = (pluginId: string, method: "PUT" | "DELETE") =>
    app.request(`/api/sessions/s/plugins/${pluginId}`, { method });
  const stamina = async () =>
    (
      (await store.getPluginData(
        "s",
        "world-init",
        DIMENSION_DATA_NAMESPACE,
        "stamina",
      )) as { value: { value: unknown } } | null
    )?.value.value;

  it("refuses to start with two providers and names both, before and at the start", async () => {
    const preflight = await app.request(
      "/api/worlds/w/world-data/preflight",
      json({ plugins: ["world-init", RIVAL] }),
    );
    expect(preflight.status).toBe(409);
    expect(await preflight.json()).toMatchObject({
      code: "dimension_provider_conflict",
      details: { candidates: ["world-init", RIVAL] },
    });

    const res = await create({ plugins: [RIVAL] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body).toMatchObject({
      code: "dimension_provider_conflict",
      details: { candidates: ["world-init", RIVAL] },
    });
    expect(body.error).toContain(RIVAL);
    expect(await store.getSession("s")).toBeNull();

    // Keeping one of them starts the session.
    expect(
      (await create({ plugins: [RIVAL], excludedPlugins: ["world-init"] }))
        .status,
    ).toBe(201);
  });

  it("refuses to turn on a second provider beside the bound one", async () => {
    expect((await create({ plugins: [] })).status).toBe(201);
    const before = (await store.getSession("s"))!;
    expect(before.metadata?._dimensionProviderPluginId).toBe("world-init");

    const res = await toggle(RIVAL, "PUT");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "dimension_provider_conflict",
      details: { candidates: ["world-init", RIVAL] },
    });
    const after = (await store.getSession("s"))!;
    expect(after.activePlugins).toEqual(before.activePlugins);
    expect(after.metadata?.pluginSelection).toEqual(
      before.metadata?.pluginSelection,
    );
  });

  it("imports the world's dimensions when their provider is turned on later", async () => {
    const created = await create({ excludedPlugins: ["world-init"] });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      ignoredDimensions: ["stamina"],
    });
    expect(await stamina()).toBeUndefined();

    const res = await toggle("world-init", "PUT");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      worldData: { receivers: ["world-init"], imported: 1, conflicts: 0 },
    });
    expect(await stamina()).toBe(3);
    expect(
      (await store.getSession("s"))!.metadata?._dimensionProviderPluginId,
    ).toBe("world-init");
  });

  describe("when the bound provider is gone", () => {
    beforeEach(async () => {
      expect((await create({ plugins: ["notes"] })).status).toBe(201);
      expect(await stamina()).toBe(3);
      // The provider is uninstalled: the next start has no entry for it.
      registry = createPluginRegistry();
      registry.register(plugin("notes"));
      registry.register(plugin(RIVAL, [DIMENSION_CONTRACT]));
      app = makeApp(store, registry);
    });

    it("loads the game with the dimensions it had", async () => {
      const res = await app.request("/api/sessions/s/view");
      expect(res.status, await res.clone().text()).toBe(200);
      const view = (await res.json()) as SessionSnapshot;
      expect(view.dimensionProviderPluginId).toBe("world-init");
      expect(view.dimensions.stamina).toMatchObject({ value: 3 });
      expect(view.dimensionRecovery).toBeUndefined();
    });

    it("changes other plugins and keeps the provider for when it is back", async () => {
      const off = await toggle("notes", "DELETE");
      expect(off.status, await off.clone().text()).toBe(200);
      expect((await store.getSession("s"))!.activePlugins).toEqual([
        "world-init",
      ]);
      const on = await toggle("notes", "PUT");
      expect(on.status, await on.clone().text()).toBe(200);
      expect((await store.getSession("s"))!.activePlugins).toEqual(
        expect.arrayContaining(["world-init", "notes"]),
      );
      expect(await stamina()).toBe(3);
    });

    it("still refuses to turn the provider off or let another one take over", async () => {
      const off = await toggle("world-init", "DELETE");
      expect(off.status).toBe(409);
      expect(await off.json()).toMatchObject({
        code: "dimension_provider_required",
      });

      const rival = await toggle(RIVAL, "PUT");
      expect(rival.status).toBe(409);
      expect(await rival.json()).toMatchObject({
        code: "dimension_provider_conflict",
        details: { candidates: ["world-init", RIVAL] },
      });
      expect((await store.getSession("s"))!.activePlugins).not.toContain(RIVAL);
    });
  });
});
