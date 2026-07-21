/**
 * POST /api/actions — phase.changed hygiene regression test.
 *
 * Followup for 2026-04-12 audit Finding 4 / Task 5: actions.ts no longer
 * unconditionally emits `phase.changed { phase: 'playing' }` for every
 * action. The frontend reducer used to overwrite the real session phase
 * with the spurious 'playing' value, breaking sessions still in pre-game
 * (turnCount: 0).
 *
 * `phase` is fully removed — no proposal type,
 * no SSE event, no persistent session field. This test now protects the
 * migration by asserting `phase.changed` is never emitted, even indirectly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
  type LoadedRuntime,
} from "@covel/plugin-loader";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeFakeLLM, makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";

function makeSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "test-runtime",
    name: "Test Runtime",
    description: "",
    pluginType: "plugin",
    runtimeCount: 1,
    ...overrides,
  };
}

function makeEntry(args: {
  id: string;
  loaded: LoadedRuntime;
}): PluginRegistryEntry {
  const parsed = {
    manifest: args.loaded.manifest,
    promptTemplate: args.loaded.promptTemplate,
    rawFrontmatter: {},
  };
  return {
    id: args.id,
    summary: makeSummary({ id: args.id, name: args.id }),
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[args.loaded.manifest.name, args.loaded]]),
    status: "registered",
  } as PluginRegistryEntry;
}

/**
 * Drains the SSE stream from /api/actions and returns the parsed event types
 * (one per `event: <name>` line).
 */
async function drainActionStream(res: Response): Promise<string[]> {
  const eventTypes: string[] = [];
  if (!res.body) return eventTypes;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      // The SSE envelope JSON contains `"type": "<protocol-event-type>"`,
      // so just parse each `data:` line and read its `.type`.
      if (line.startsWith("data: ")) {
        try {
          const payload = JSON.parse(line.slice(6)) as { type?: string };
          if (payload.type) eventTypes.push(payload.type);
        } catch {
          // ignore non-JSON SSE lines
        }
      }
    }
  }
  return eventTypes;
}

describe("POST /api/actions — phase.changed hygiene (Finding 4 regression)", () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;
  let loadedByName: Map<string, LoadedRuntime>;
  const sessionId = "sess-1";
  const RUNTIME_ID = "fake-narrator";

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();

    const loaded = makeFakeLoadedRuntime({
      name: RUNTIME_ID,
      pluginId: RUNTIME_ID,
      outputKind: "story",
    });
    loadedByName = new Map([[RUNTIME_ID, loaded]]);
    registry.register(makeEntry({ id: RUNTIME_ID, loaded }));

    // Session starts in pre-game (turnCount: 0) — the broken behavior would
    // have forced a 'phase.changed → playing' emit for every action.
    await store.createSession({
      id: sessionId,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: [RUNTIME_ID],
      turnCount: 0,
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
    });

    const eventBus = createEventBus(store);
    const { llm } = makeFakeLLM("A fake reply.");
    const sessionLock = createInProcessSessionLock();

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", llm as any);
      c.set("loadRuntimeFn", async (m) => loadedByName.get(m.name));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/actions", actionRoutes);
  });

  it("does NOT emit phase.changed for a send_message during pre-game (turnCount: 0)", async () => {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-1",
        type: "send_message",
        sessionId,
        payload: { content: "hello" },
      }),
    });
    expect(res.status).toBe(200);

    const types = await drainActionStream(res);

    // Before the fix: types would contain 'phase.changed' fired right at
    // the start of every action stream. After the fix: it should not.
    expect(types).not.toContain("phase.changed");

    // Sanity: execution.started SHOULD still appear (it's the legitimate
    // "turn is running" signal that replaced the spurious phase.changed).
    expect(types).toContain("execution.started");
  });

  it("does NOT emit phase.changed for a start_session either", async () => {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-2",
        type: "start_session",
        sessionId,
        payload: {},
      }),
    });
    expect(res.status).toBe(200);

    const types = await drainActionStream(res);
    expect(types).not.toContain("phase.changed");
  });

  it("keeps turnCount at setup value when start_session leaves Pre-Game pending", async () => {
    const PREGAME_ID = "char-creator/player-init";
    const loaded = makeFakeLoadedRuntime({
      name: PREGAME_ID,
      pluginId: "char-creator",
      outputKind: "plugin",
      pluginType: "core-plugin",
    });
    const pregameLoaded: LoadedRuntime = {
      ...loaded,
      manifest: {
        ...loaded.manifest,
        priority: 50,
      },
    };
    loadedByName.set(PREGAME_ID, pregameLoaded);
    registry.register(makeEntry({ id: "char-creator", loaded: pregameLoaded }));

    const pendingSessionId = "sess-pending-pregame";
    await store.createSession({
      id: pendingSessionId,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: ["char-creator"],
      turnCount: 0,
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
    });

    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-pending",
        type: "start_session",
        sessionId: pendingSessionId,
        payload: {},
      }),
    });
    expect(res.status).toBe(200);
    await drainActionStream(res);

    const session = await store.getSession(pendingSessionId);
    const turnResults = await store.listTurnResults(pendingSessionId);
    const playerMessages = (
      await store.listTurnMessages(pendingSessionId)
    ).filter((msg) => msg.sourceType === "player");
    expect(turnResults).toHaveLength(1);
    expect(playerMessages).toHaveLength(0);
    expect(session?.turnCount).toBe(0);
  });
});
