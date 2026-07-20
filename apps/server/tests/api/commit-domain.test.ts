/**
 * Commit-domain fault injection — 2026-07-20 consolidated audit, Batch 2.
 *
 * Locks the behaviours that used to report success over incomplete state:
 *  - a proposal that fails to commit emits `proposal.failed` and
 *    withholds the completion barrier (`turn.completed`), and the
 *    auto-snapshot is not taken over a partially-committed turn.
 *  - a paused/ended session rejects actions without writing player
 *    messages, interactions, or compaction.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import { createHookPipeline } from "@covel/runtime";
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

const SESSION_ID = "sess-commit";
const RUNTIME_ID = "fake-narrator";

function makeEntry(args: {
  id: string;
  loaded: LoadedRuntime;
}): PluginRegistryEntry {
  const parsed = {
    manifest: args.loaded.manifest,
    promptTemplate: args.loaded.promptTemplate,
    rawFrontmatter: {},
  };
  const summary: PluginSummary = {
    id: args.id,
    name: args.id,
    description: "",
    pluginType: "plugin",
    runtimeCount: 1,
  };
  return {
    id: args.id,
    summary,
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[args.loaded.manifest.name, args.loaded]]),
    status: "registered",
  } as PluginRegistryEntry;
}

interface DrainedStream {
  readonly types: readonly string[];
  readonly events: ReadonlyArray<{
    type: string;
    payload: Record<string, unknown>;
  }>;
}

async function drain(res: Response): Promise<DrainedStream> {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  if (!res.body) return { types: [], events };
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
      if (!line.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(line.slice(6)) as {
          type?: string;
          payload?: Record<string, unknown>;
        };
        if (parsed.type) {
          events.push({ type: parsed.type, payload: parsed.payload ?? {} });
        }
      } catch {
        /* ignore non-JSON frames */
      }
    }
  }
  return { types: events.map((e) => e.type), events };
}

describe("commit-domain fault injection (Batch 2)", () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;
  let eventBus: ReturnType<typeof createEventBus>;
  let hookPipeline: ReturnType<typeof createHookPipeline> | undefined;

  const buildApp = () => {
    const localApp = new Hono();
    const { llm } = makeFakeLLM("A fake reply.");
    const sessionLock = createInProcessSessionLock();
    localApp.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", llm as any);
      c.set("loadRuntimeFn", async (m) =>
        registry.get(RUNTIME_ID)?.loadedRuntimes.get(m.name),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", sessionLock);
      if (hookPipeline) c.set("hookPipeline", hookPipeline);
      await next();
    });
    localApp.route("/api/actions", actionRoutes);
    return localApp;
  };

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    hookPipeline = undefined;

    const loaded = makeFakeLoadedRuntime({
      name: RUNTIME_ID,
      pluginId: RUNTIME_ID,
      outputKind: "story",
    });
    registry.register(makeEntry({ id: RUNTIME_ID, loaded }));

    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: [RUNTIME_ID],
      turnCount: 1,
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
    });

    eventBus = createEventBus(store);
    app = buildApp();
  });

  const sendMessage = () =>
    app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-1",
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "hello" },
      }),
    });

  // `turn.completed` rides emitSubEvent; the EventBus lifts the sub-type
  // onto `event.type`, so the bus event name IS "turn.completed".
  const collectSubTypes = (): string[] => {
    const seen: string[] = [];
    eventBus.onEmit((e) => seen.push(e.type));
    return seen;
  };

  it("baseline: a clean turn completes and snapshots", async () => {
    const subTypes = collectSubTypes();

    const res = await sendMessage();
    expect(res.status).toBe(200);
    const { types } = await drain(res);

    expect(types).toContain("execution.completed");
    expect(types).not.toContain("proposal.failed");
    expect(subTypes).toContain("turn.completed");
    expect(await store.listSnapshots(SESSION_ID)).not.toHaveLength(0);
  });

  it("a blocked proposal emits proposal.failed and withholds turn.completed", async () => {
    // A PreStateCommit hook that aborts is the cleanest fault injection: it
    // makes the commit return { committed: false } without throwing, which
    // is exactly the silently-dropped case the audit found.
    hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "test:PreStateCommit:block",
      event: "PreStateCommit",
      handler: async () => ({ action: "abort", reason: "test-blocked" }),
    });
    app = buildApp();

    const subTypes = collectSubTypes();

    const res = await sendMessage();
    expect(res.status).toBe(200);
    const { types, events } = await drain(res);

    const failure = events.find((e) => e.type === "proposal.failed");
    expect(failure).toBeDefined();
    expect(String(failure!.payload.error)).toContain("test-blocked");
    expect(failure!.payload.runtimeId).toBe(RUNTIME_ID);

    // The turn is visibly incomplete: no authoritative completion event and
    // no snapshot taken over the partially-committed state.
    expect(subTypes).not.toContain("turn.completed");
    expect(await store.listSnapshots(SESSION_ID)).toHaveLength(0);

    // execution.completed still fires — the runtimes DID run; the commit is
    // what failed, and proposal.failed is the signal for that.
    expect(types).toContain("execution.completed");
  });

  it("a paused session rejects the action with 409 and writes nothing", async () => {
    await store.updateSession(SESSION_ID, {
      status: "paused",
      updatedAt: new Date().toISOString(),
    });

    const res = await sendMessage();
    expect(res.status).toBe(409);

    expect(await store.listMessages(SESSION_ID)).toHaveLength(0);
    expect(await store.listTurnMessages(SESSION_ID)).toHaveLength(0);
    expect(await store.listTurnResults(SESSION_ID)).toHaveLength(0);
  });

  it("an ended session rejects the action with 409", async () => {
    await store.updateSession(SESSION_ID, {
      status: "ended",
      updatedAt: new Date().toISOString(),
    });
    const res = await sendMessage();
    expect(res.status).toBe(409);
    expect(await store.listMessages(SESSION_ID)).toHaveLength(0);
  });
});
