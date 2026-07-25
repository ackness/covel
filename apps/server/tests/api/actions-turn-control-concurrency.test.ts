/**
 * POST /api/actions × turn-control — audit 2026-07-10 A-02.
 *
 * Two overlapping actions on the same session: the second queues on the
 * session lock and must NOT clobber the first turn's steer/abort
 * registration. Before the fix, registerActiveTurn ran before
 * sessionLock.withLock, so an abort issued while turn 1 was mid-execution
 * targeted the still-waiting turn 2.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
  type LoadedRuntime,
  type FunctionHandler,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { abortActiveTurn } from "../../src/routes/api/turn-control.js";

const PLUGIN_ID = "test-concurrency";
const RUNTIME = "test-concurrency/main";
const SESSION_ID = "sess-turn-control-concurrency";

function makeRegistryEntry(handler: FunctionHandler): PluginRegistryEntry {
  const manifest = {
    name: RUNTIME,
    pluginId: PLUGIN_ID,
    description: "test function runtime",
    stage: "narrative",
    runtimeType: "function",
    outputKind: "plugin",
    pluginType: "plugin",
    handler: "./handler.js",
    trigger: { type: "auto" },
  } as RuntimeManifest;
  const loaded: LoadedRuntime = { manifest, promptTemplate: "", handler };
  const parsed = { manifest, promptTemplate: "", rawFrontmatter: {} };
  const summary: PluginSummary = {
    id: PLUGIN_ID,
    name: PLUGIN_ID,
    description: "",
    pluginType: "plugin",
    runtimeCount: 1,
  };
  return {
    id: PLUGIN_ID,
    summary,
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[RUNTIME, loaded]]),
    status: "registered",
    source: "builtin",
  } as PluginRegistryEntry;
}

/** Read SSE frames until one matching `predicate` arrives; returns it. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (evt: { type: string; turnId?: string }) => boolean,
): Promise<{ type: string; turnId?: string; payload?: unknown }> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("stream ended before expected event");
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const evt = JSON.parse(line.slice(5).trim());
      if (predicate(evt)) return evt;
    }
  }
}

async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

describe("POST /api/actions — steer/abort targets the executing turn, not a queued one (A-02)", () => {
  it("abort during turn 1 hits turn 1 while turn 2 waits on the session lock", async () => {
    const store: DataStore = createMemoryStore();
    const pluginRegistry = createPluginRegistry();

    // Handler blocks until released so we control the mid-execution window.
    let releaseFirstTurn: (() => void) | undefined;
    let handlerStarted: (() => void) | undefined;
    const firstTurnStarted = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let callCount = 0;
    const handler: FunctionHandler = async () => {
      callCount += 1;
      if (callCount === 1) {
        handlerStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirstTurn = resolve;
        });
      }
      return { ok: true };
    };
    pluginRegistry.register(makeRegistryEntry(handler));

    const eventBus = createEventBus(store);
    const sessionLock = createInProcessSessionLock();
    const loaded = pluginRegistry.get(PLUGIN_ID)?.loadedRuntimes.get(RUNTIME);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", { generate: async () => ({}) } as any);
      c.set("loadRuntimeFn", async () => loaded);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/actions", actionRoutes);

    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: [PLUGIN_ID],
      turnCount: 1,
      preGameCompleted: [],
      createdAt: now,
    });

    const post = (requestId: string) =>
      app.request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          type: "send_message",
          sessionId: SESSION_ID,
          payload: { content: "go" },
        }),
      });

    const res1 = await post("req-1");
    expect(res1.status).toBe(200);
    const reader1 = res1.body!.getReader();
    // execution.started is emitted before the session lock, so wait for the
    // handler itself — that proves turn 1 is executing inside the lock.
    const started1 = await readUntil(
      reader1,
      (e) => e.type === "execution.started",
    );
    const turn1Id = started1.turnId;
    expect(turn1Id).toBeTruthy();
    await firstTurnStarted;

    // Second action for the same session queues before emitting lifecycle
    // events or registering turn control.
    const res2 = await post("req-2");
    expect(res2.status).toBe(200);
    const reader2 = res2.body!.getReader();

    // Drain the event loop so request 2 is genuinely queued on the lock.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // The control registry must still point at the turn actually executing.
    const aborted = abortActiveTurn(SESSION_ID);
    expect(aborted?.turnId).toBe(turn1Id);

    releaseFirstTurn?.();
    const [out1, out2] = await Promise.all([drain(reader1), drain(reader2)]);
    // Turn 1 was aborted mid-execution; turn 2 ran to completion untouched.
    expect(out1).toContain("aborted-by-player");
    expect(out2).toContain("execution.completed");
    expect(out2).not.toContain("aborted-by-player");
    expect(callCount).toBe(2);
  });
});
