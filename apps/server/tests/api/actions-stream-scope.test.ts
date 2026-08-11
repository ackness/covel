/**
 * POST /api/actions — SSE forwarding scope regression test.
 *
 * The action stream forwards out-of-band eventBus events (plugin-data.changed
 * etc.) wrapped in ITS turn's envelope. That subscription must live exactly as
 * long as this action holds the session lock: it used to survive into the
 * post-lock tail (deferred-follower scheduling, final trace/SSE writes), so
 * once the next action acquired the lock, its events were still delivered to
 * the previous request's stream under the previous turnId/traceId.
 *
 * This test parks a turn in its post-lock tail (by gating the recorder's
 * `turn.completed` trace write, which happens after the lock releases), emits
 * a forwarded bus event during that window, and asserts it does NOT ride the
 * stream — while an event emitted during the locked section still does.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type StoreTransaction } from "@covel/store";
import { createEventBus, type EventBus } from "@covel/events";
import {
  createPluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
  type LoadedRuntime,
} from "@covel/plugin-loader";
import { actionRoutes, setMemorySystem } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeFakeLLM, makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";

const SESSION_ID = "sess-stream-scope";
const RUNTIME_ID = "fake-narrator";

function makeEntry(loaded: LoadedRuntime): PluginRegistryEntry {
  const summary: PluginSummary = {
    id: loaded.manifest.pluginId,
    name: loaded.manifest.pluginId,
    description: "",
    pluginType: "plugin",
    runtimeCount: 1,
  };
  const parsed = {
    manifest: loaded.manifest,
    promptTemplate: loaded.promptTemplate,
    rawFrontmatter: {},
  };
  return {
    id: loaded.manifest.pluginId,
    summary,
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[loaded.manifest.name, loaded]]),
    status: "registered",
  } as PluginRegistryEntry;
}

function emitForwardedEvent(eventBus: EventBus, marker: string): void {
  eventBus.emit({
    id: crypto.randomUUID(),
    type: "event",
    topic: "plugin",
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    payload: { _subType: "plugin-data.changed", marker },
  });
}

/** Drain the actions SSE stream, returning the parsed envelopes. */
async function drainActionStream(
  res: Response,
): Promise<Array<{ type: string; payload?: { marker?: string } }>> {
  const envelopes: Array<{ type: string; payload?: { marker?: string } }> = [];
  if (!res.body) return envelopes;
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
        envelopes.push(JSON.parse(line.slice(6)));
      } catch {
        // ignore non-JSON SSE lines
      }
    }
  }
  return envelopes;
}

describe("POST /api/actions — event forwarding is scoped to the lock tenure", () => {
  it("does not forward bus events emitted after the session lock released", async () => {
    const store = createMemoryStore();
    const registry = createPluginRegistry();
    const loaded = makeFakeLoadedRuntime({ name: RUNTIME_ID });
    registry.register(makeEntry(loaded));
    setMemorySystem(undefined);

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

    const eventBus = createEventBus(store);

    // Gate the post-lock tail: the recorder's `turn.completed` trace row is
    // written AFTER the session lock releases, so blocking it parks the
    // request in exactly the window where the next action could already own
    // the session. The player-message write (role "user") now happens through
    // finalizeExecution's transaction under the lock — use it to emit the
    // in-lock control event.
    let releaseTail!: () => void;
    const tailGate = new Promise<void>((resolve) => (releaseTail = resolve));
    let reachedTail!: () => void;
    const tailReached = new Promise<void>((resolve) => (reachedTail = resolve));
    const gatedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "addTraceEvent") {
          return async (record: { type: string }) => {
            if (record.type === "turn.completed") {
              reachedTail();
              await tailGate;
            }
            return store.addTraceEvent(record as never);
          };
        }
        if (prop === "withTransaction") {
          return async <T>(fn: (tx: StoreTransaction) => Promise<T>) =>
            store.withTransaction!(async (tx) => {
              const observedTx = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "addMessage") {
                    return async (record: { role: string }) => {
                      if (record.role === "user") {
                        emitForwardedEvent(eventBus, "in-lock");
                      }
                      return tx.addMessage(record as never);
                    };
                  }
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              });
              return fn(observedTx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const { llm } = makeFakeLLM("A narrative line.");
    const sessionLock = createInProcessSessionLock();

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", gatedStore);
      c.set("pluginRegistry", registry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", llm as any);
      c.set("loadRuntimeFn", async () => loaded);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/actions", actionRoutes);

    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-scope",
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "hello" },
      }),
    });
    expect(res.status).toBe(200);

    // Drain concurrently — the handler needs a reader to make progress.
    const drained = drainActionStream(res);
    await tailReached;
    // The lock is released; a subsequent action's events would appear on the
    // bus exactly like this one.
    emitForwardedEvent(eventBus, "post-lock");
    releaseTail();
    const envelopes = await drained;

    expect(envelopes.map((e) => e.type)).toContain("execution.completed");
    const markers = envelopes
      .filter((e) => e.type === "plugin-data.changed")
      .map((e) => e.payload?.marker);
    // Emitted under this turn's lock tenure → belongs to this stream.
    expect(markers).toContain("in-lock");
    // Emitted after release → belongs to whoever owns the session next,
    // never to this stream's envelope.
    expect(markers).not.toContain("post-lock");
  });
});
