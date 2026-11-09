/**
 * The steps every execution entry point shares: the live-session gate, the
 * registry sync, the player's settings snapshot and the session hook scope.
 */

import { Hono, type Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import type { DataStore, SessionRecord, WorldRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  SessionNotActiveError,
  executionHookScope,
  loadExecutionUserSettings,
  readExecutionSession,
  requireActiveSession,
  syncLiveSessionRuntimes,
  syncSessionRuntimes,
} from "../../src/routes/api/execution-context.js";

const SESSION_ID = "execution-context-session";
const PLUGIN_ID = "context-plugin";
const RUNTIME_ID = `${PLUGIN_ID}/runner`;

function runtimeManifest(): RuntimeManifest {
  return {
    name: RUNTIME_ID,
    pluginId: PLUGIN_ID,
    description: "fixture",
    runtimeType: "function",
    handler: "./handler.js",
    trigger: { type: "manual" },
    userSettings: [
      { key: "tone", type: "text", default: "manifest", label: "Tone" },
      { key: "pace", type: "text", default: "slow", label: "Pace" },
    ],
  };
}

function registryWithPlugin(): PluginRegistry {
  const registry = createPluginRegistry();
  const manifest = runtimeManifest();
  registry.register({
    id: PLUGIN_ID,
    summary: {
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      description: "fixture",
      kind: "plugin",
      runtimeCount: 1,
    },
    packageManifest: {
      plugin: { id: PLUGIN_ID, kind: "plugin", description: "fixture" },
      manifest: {
        kind: "plugin",
        name: PLUGIN_ID,
        pluginId: PLUGIN_ID,
        description: "fixture",
        userSettings: manifest.userSettings,
      },
      promptTemplate: "",
      rawFrontmatter: {},
    },
    manifests: [
      {
        runtime: { function: {} },
        manifest,
        promptTemplate: "",
        rawFrontmatter: {},
      },
    ],
    loadedRuntimes: new Map(),
    status: "registered",
  });
  return registry;
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: SESSION_ID,
    status: "active",
    locale: "zh-CN",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [PLUGIN_ID],
    metadata: {
      approvalScopeNonce: "approval-scope",
      sessionIncarnationNonce: "incarnation-a",
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Run `fn` inside a request whose context carries the store and registry. */
async function inRequest<T>(
  store: DataStore,
  registry: PluginRegistry,
  fn: (c: Context) => Promise<T>,
): Promise<T> {
  let result: { value: T } | { error: unknown } | undefined;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("sessionLock", createInProcessSessionLock());
    await next();
  });
  app.post("/run", async (c) => {
    try {
      result = { value: await fn(c) };
    } catch (error) {
      result = { error };
    }
    return c.body(null, 204);
  });
  await app.request("/run", { method: "POST" });
  if (!result) throw new Error("the request did not run");
  if ("error" in result) throw result.error;
  return result.value;
}

async function refusal(
  outcome: SessionRecord | Response,
): Promise<{ status: number; code: unknown }> {
  if (!(outcome instanceof Response))
    throw new Error("expected the session to be refused");
  const body = (await outcome.json()) as { code?: unknown };
  return { status: outcome.status, code: body.code };
}

describe("readExecutionSession", () => {
  it("returns the session read under the lock when it may run", async () => {
    const store = createMemoryStore();
    const accepted = sessionRecord();
    await store.createSession(accepted);
    await store.updateSession(SESSION_ID, {
      activePlugins: [],
      updatedAt: new Date().toISOString(),
    });

    const live = await inRequest(store, registryWithPlugin(), (c) =>
      readExecutionSession(c, {
        store,
        sessionId: SESSION_ID,
        expectedSession: accepted,
      }),
    );

    // The live record, not the one the request accepted.
    expect(live).toMatchObject({ id: SESSION_ID, activePlugins: [] });
  });

  it("refuses a session that is gone, replaced or not active", async () => {
    const store = createMemoryStore();
    const accepted = sessionRecord();
    const registry = registryWithPlugin();
    const read = () =>
      inRequest(store, registry, (c) =>
        readExecutionSession(c, {
          store,
          sessionId: SESSION_ID,
          expectedSession: accepted,
        }),
      ).then(refusal);

    expect(await read()).toEqual({
      status: 404,
      code: "session_not_found",
    });

    await store.createSession(sessionRecord({ status: "paused" }));
    expect(await read()).toEqual({ status: 409, code: "session_not_active" });

    await store.deleteSession(SESSION_ID);
    await store.createSession(
      sessionRecord({
        metadata: {
          approvalScopeNonce: "approval-scope",
          sessionIncarnationNonce: "incarnation-b",
        },
      }),
    );
    expect(await read()).toEqual({
      status: 409,
      code: "session_incarnation_changed",
    });
  });

  it("admits the statuses the caller allows", async () => {
    const store = createMemoryStore();
    const accepted = sessionRecord({ status: "paused" });
    await store.createSession(accepted);

    const live = await inRequest(store, registryWithPlugin(), (c) =>
      readExecutionSession(c, {
        store,
        sessionId: SESSION_ID,
        expectedSession: accepted,
        allowedStatuses: ["active", "paused"],
      }),
    );

    expect(live).toMatchObject({ status: "paused" });
  });

  it("stops before reading once the signal is aborted", async () => {
    const store = createMemoryStore();
    const accepted = sessionRecord();
    await store.createSession(accepted);
    const getSession = vi.spyOn(store, "getSession");
    const shutdown = new AbortController();
    shutdown.abort(new Error("server shutting down"));

    await expect(
      inRequest(store, registryWithPlugin(), (c) =>
        readExecutionSession(c, {
          store,
          sessionId: SESSION_ID,
          expectedSession: accepted,
          signal: shutdown.signal,
        }),
      ),
    ).rejects.toThrow("server shutting down");
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("requireActiveSession", () => {
  it("returns an active session and refuses a deleted or inactive one", async () => {
    const store = createMemoryStore();
    await expect(requireActiveSession(store, SESSION_ID)).rejects.toMatchObject(
      {
        name: "SessionNotActiveError",
        status: "deleted",
      },
    );

    await store.createSession(sessionRecord({ status: "ended" }));
    const refused = await requireActiveSession(store, SESSION_ID).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(SessionNotActiveError);
    expect(refused).toMatchObject({ status: "ended" });

    await store.updateSession(SESSION_ID, {
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    await expect(
      requireActiveSession(store, SESSION_ID),
    ).resolves.toMatchObject({ id: SESSION_ID, status: "active" });
  });
});

describe("syncSessionRuntimes", () => {
  it("activates the session's plugins and returns their runtimes", () => {
    const registry = registryWithPlugin();

    expect(
      syncSessionRuntimes(registry, SESSION_ID, [PLUGIN_ID]).map(
        (runtime) => runtime.name,
      ),
    ).toEqual([RUNTIME_ID]);
    expect(registry.getActivePlugins(SESSION_ID)).toEqual([PLUGIN_ID]);

    // A plugin the session no longer has is deactivated.
    expect(syncSessionRuntimes(registry, SESSION_ID, [])).toEqual([]);
    expect(registry.getActivePlugins(SESSION_ID)).toEqual([]);
  });
});

describe("syncLiveSessionRuntimes", () => {
  it("syncs from a fresh read under the lock and fails closed once deleted", async () => {
    const store = createMemoryStore();
    const registry = registryWithPlugin();
    await store.createSession(sessionRecord());

    const runtimes = await inRequest(store, registry, (c) =>
      syncLiveSessionRuntimes(c, SESSION_ID),
    );
    expect(runtimes.map((runtime) => runtime.name)).toEqual([RUNTIME_ID]);

    await store.deleteSession(SESSION_ID);
    await expect(
      inRequest(store, registry, (c) => syncLiveSessionRuntimes(c, SESSION_ID)),
    ).resolves.toEqual([]);
    expect(registry.getActivePlugins(SESSION_ID)).toEqual([]);
  });
});

describe("loadExecutionUserSettings", () => {
  const world = {
    metadata: {
      pluginSettings: { [PLUGIN_ID]: { tone: "world", pace: "fast" } },
    },
  } as unknown as WorldRecord;
  const store: Pick<DataStore, "getWorld"> = {
    getWorld: async (id) => (id === "world-1" ? world : null),
  };

  it("puts the player's settings over the world's and freezes them", async () => {
    const settings = await loadExecutionUserSettings(
      store,
      { worldId: "world-1" },
      { [PLUGIN_ID]: { tone: "player" } },
    );

    expect(settings).toEqual({ [PLUGIN_ID]: { tone: "player", pace: "fast" } });
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings?.[PLUGIN_ID])).toBe(true);
  });

  it("is undefined when neither layer has settings", async () => {
    await expect(
      loadExecutionUserSettings(store, { worldId: undefined }, undefined),
    ).resolves.toBeUndefined();
  });
});

describe("executionHookScope", () => {
  it("scopes hooks to the session's runnable plugins, settings and locale", () => {
    const scope = executionHookScope({
      pluginRegistry: registryWithPlugin(),
      session: { activePlugins: [PLUGIN_ID, "not-installed"], locale: "zh-CN" },
      userSettings: { [PLUGIN_ID]: { tone: "player" } },
    });

    expect([...scope.activePluginIds]).toEqual([PLUGIN_ID]);
    expect(scope.settings).toEqual({
      [PLUGIN_ID]: { tone: "player", pace: "slow" },
    });
    expect(scope.locale).toBe("zh-CN");
  });
});
