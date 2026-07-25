/**
 * POST /api/actions — deferred background followers on the main turn path.
 *
 * Sync-mode deferred-follower scheduling was wired into plugin-rpc.ts
 * (see plugin-rpc.test.ts's "sync target + background follower" case), but
 * the main narrative route (/api/actions) never consumed
 * `executeTurn()`'s `result.deferredFollowers` — an `execution: 'background'`
 * runtime triggered by an event emitted on the main turn path (e.g.
 * scene-stage/background-gen off scene-stage/resolver) would never run.
 * This test pins the fix: the follower actually executes and commits.
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

const PLUGIN_ID = "test-deferred";
const TARGET = "test-deferred/target";
const FOLLOWER = "test-deferred/follower";
const SESSION_ID = "sess-deferred-followers";

function makeSummary(id: string): PluginSummary {
  return {
    id,
    name: id,
    description: "",
    pluginType: "plugin",
    runtimeCount: 2,
  };
}

function makeManifest(args: {
  runtimeId: string;
  stage?: RuntimeManifest["stage"];
  execution?: "background";
  trigger: RuntimeManifest["trigger"];
}): RuntimeManifest {
  return {
    name: args.runtimeId,
    pluginId: PLUGIN_ID,
    description: "test function runtime",
    ...(args.stage ? { stage: args.stage } : {}),
    runtimeType: "function",
    outputKind: "plugin",
    pluginType: "plugin",
    handler: "./handler.js",
    trigger: args.trigger,
    ...(args.execution ? { execution: args.execution } : {}),
  } as RuntimeManifest;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  maxAttempts = 200,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("waitFor: predicate did not become true in time");
}

describe("POST /api/actions — deferred background followers (main path)", () => {
  it("schedules and runs an execution:background follower triggered by an event from the main turn", async () => {
    const store: DataStore = createMemoryStore();
    const pluginRegistry = createPluginRegistry();

    const targetManifest = makeManifest({
      runtimeId: TARGET,
      stage: "narrative",
      trigger: { type: "auto" },
    });
    const targetHandler: FunctionHandler = async () => ({
      ok: true,
      events: [{ topic: "test-deferred.ready", data: { value: "hello" } }],
    });
    const targetLoaded: LoadedRuntime = {
      manifest: targetManifest,
      promptTemplate: "",
      handler: targetHandler,
    };

    const followerManifest = makeManifest({
      runtimeId: FOLLOWER,
      execution: "background",
      trigger: { type: "event", topic: "test-deferred.ready" },
    });
    let followerRan = false;
    const followerHandler: FunctionHandler = async (ctx) => {
      followerRan = true;
      const event = ctx.triggerEvent as
        { data?: { value?: string } } | undefined;
      return {
        pluginData: [
          {
            namespace: "seen",
            key: "last",
            value: { value: event?.data?.value },
          },
        ],
      };
    };
    const followerLoaded: LoadedRuntime = {
      manifest: followerManifest,
      promptTemplate: "",
      handler: followerHandler,
    };

    const parsedTarget = {
      manifest: targetManifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    const parsedFollower = {
      manifest: followerManifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    pluginRegistry.register({
      id: PLUGIN_ID,
      summary: makeSummary(PLUGIN_ID),
      manifest: parsedTarget,
      manifests: [parsedTarget, parsedFollower],
      loadedRuntimes: new Map([
        [TARGET, targetLoaded],
        [FOLLOWER, followerLoaded],
      ]),
      status: "registered",
      source: "builtin",
    } as PluginRegistryEntry);

    const eventBus = createEventBus(store);
    const sessionLock = createInProcessSessionLock();
    const loadRuntimeFn = async (m: RuntimeManifest) =>
      m.name === TARGET
        ? targetLoaded
        : m.name === FOLLOWER
          ? followerLoaded
          : undefined;

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", { generate: async () => ({}) } as any);
      c.set("loadRuntimeFn", loadRuntimeFn);
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

    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-1",
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "go" },
      }),
    });
    expect(res.status).toBe(200);

    // /api/actions runs the turn inside the SSE stream generator — drain it.
    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Follower must not have run synchronously within the request — it's
    // scheduled via setImmediate, same as plugin-rpc.ts's sync mode.
    // (By the time the stream is fully drained the setImmediate may already
    // have fired, so this only documents intent — the real assertion is the
    // committed output below.)
    await waitFor(async () => {
      const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "seen");
      return rows.length === 1;
    });

    expect(followerRan).toBe(true);
    const seen = await store.listPluginData(SESSION_ID, PLUGIN_ID, "seen");
    expect(seen[0]?.value).toEqual({ value: "hello" });

    // The pending job row the scheduler writes before setImmediate must have
    // settled to done.
    const jobs = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.value).toMatchObject({ status: "done" });
  });
});
