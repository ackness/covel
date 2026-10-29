/**
 * POST /api/actions — commit-time corrections for runs dropped at commit.
 *
 * A runtime can run nested (through `ctx.recursiveCall`) and at top level in
 * the same turn. When only the nested run's unit is dropped, the correction
 * names the dropped runs by `runId` and never marks the top-level run of the
 * same runtime, which committed, as failed.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { droppedRunPayloads } from "../../src/routes/api/actions/dropped-runs.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createTestRuntimeJobWorker } from "./__helpers/runtime-job-worker.js";

const PLUGIN_ID = "test-dropped";
const STORY = `${PLUGIN_ID}/story`;
const PARENT = `${PLUGIN_ID}/parent`;
const SHARED = `${PLUGIN_ID}/shared`;
const SESSION_ID = "sess-dropped-nested";

function manifest(
  name: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: PLUGIN_ID,
    description: "test function runtime",
    runtimeType: "function",
    outputKind: "system",
    handler: "./handler.js",
    stage: "post-turn",
    trigger: { type: "auto" },
    ...extra,
  } as RuntimeManifest;
}

function run(
  runtimeId: string,
  runId: string,
  extra: Partial<RuntimeResult> = {},
): RuntimeResult {
  return {
    pluginId: PLUGIN_ID,
    runtimeId,
    runId,
    turnId: "turn",
    status: "success",
    output: {},
    toolCalls: [],
    durationMs: 1,
    timestamp: "2026-10-29T00:00:00.000Z",
    ...extra,
  };
}

describe("droppedRunPayloads", () => {
  it("reports dropped nested-only runs with their identity", () => {
    expect(
      droppedRunPayloads(
        {
          runtimeResults: [run(PARENT, "parent-run")],
          nestedRuntimeResults: [run(SHARED, "nested-run")],
        },
        [
          { runtimeId: SHARED, runId: "nested-run", error: "child rejected" },
          { runtimeId: PARENT, runId: "parent-run", error: "dropped" },
        ],
      ),
    ).toEqual([
      {
        runtimeId: SHARED,
        pluginId: PLUGIN_ID,
        turnId: "turn",
        runId: "nested-run",
        status: "failed",
        durationMs: 1,
        error: "child rejected",
      },
      expect.objectContaining({ runtimeId: PARENT, runId: "parent-run" }),
    ]);
  });

  it("never reports a dropped nested run over a committed top-level run of the same runtime", () => {
    expect(
      droppedRunPayloads(
        {
          runtimeResults: [run(PARENT, "parent-run"), run(SHARED, "top-run")],
          nestedRuntimeResults: [run(SHARED, "nested-run")],
        },
        [
          { runtimeId: SHARED, runId: "nested-run", error: "rejected" },
          { runtimeId: PARENT, runId: "parent-run", error: "rejected" },
        ],
      ).map((payload) => payload.runId),
    ).toEqual(["parent-run"]);
  });
});

describe("POST /api/actions — runs dropped with a nested unit", () => {
  it("corrects the dropped runs and leaves the committed top-level run of the same runtime alone", async () => {
    const store = createMemoryStore();
    const pluginRegistry = createPluginRegistry();
    const eventBus = createEventBus(store);
    const sessionLock = createInProcessSessionLock();
    const story = manifest(STORY, { stage: "narrative", outputKind: "story" });
    // `parent` calls `shared` nested; `shared` also runs at top level.
    const parent = manifest(PARENT);
    const shared = manifest(SHARED);
    const loaded = new Map<string, LoadedRuntime>([
      [
        STORY,
        {
          manifest: story,
          promptTemplate: "",
          handler: async () => ({
            outcome: "success",
            value: { narrativeOutput: "The harbour is quiet." },
          }),
        },
      ],
      [
        PARENT,
        {
          manifest: parent,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.recursiveCall({ manualTrigger: { runtimeId: SHARED } });
            return { outcome: "success", value: {} };
          },
        },
      ],
      [
        SHARED,
        {
          manifest: shared,
          promptTemplate: "",
          // Plugin code may not write a framework namespace: the nested run's
          // write is rejected at commit, the top-level run's write lands.
          handler: async (ctx) => ({
            outcome: "success",
            value: {},
            effects: {
              pluginData: [
                ctx.recursionDepth > 0
                  ? { namespace: "_jobs", key: "x", value: 1 }
                  : { namespace: "notes", key: "top", value: 1 },
              ],
            },
          }),
        },
      ],
    ]);
    pluginRegistry.register({
      id: PLUGIN_ID,
      summary: {
        id: PLUGIN_ID,
        name: PLUGIN_ID,
        description: "",
        kind: "plugin",
        runtimeCount: 3,
      },
      manifests: [story, parent, shared].map((runtime) => ({
        runtime: { function: {} },
        manifest: runtime,
        promptTemplate: "",
        rawFrontmatter: {},
      })),
      loadedRuntimes: loaded,
      status: "registered",
      source: "builtin",
    } as PluginRegistryEntry);
    const loadRuntimeFn = async (m: RuntimeManifest) => loaded.get(m.name);
    const runtimeJobWorker = createTestRuntimeJobWorker({
      store,
      eventBus,
      sessionLock,
      pluginRegistry,
      deps: {
        loadRuntime: loadRuntimeFn,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        llm: { generate: async () => ({}) } as any,
        resolveModel: () => undefined,
      },
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("runtimeJobWorker", runtimeJobWorker);
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
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: SESSION_ID,
      status: "active",
      activePlugins: [PLUGIN_ID],
      completedPlayerTurns: 1,
      locale: "en-US",
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-dropped-nested",
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "go" },
      }),
    });
    const events = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map(
        (line) =>
          JSON.parse(line.slice(6)) as {
            type: string;
            payload: Record<string, unknown>;
          },
      );

    expect(
      events.find((event) => event.type === "execution.completed")?.payload,
    ).toMatchObject({ committed: true });
    const rows = await store.listTurnResults(SESSION_ID);
    const persisted = rows.flatMap(
      (row) => row.runtimeResults as RuntimeResult[],
    );
    const topShared = rows.find((row) => row.origin === "player")
      ?.runtimeResults as RuntimeResult[];
    const topSharedRun = topShared.find((item) => item.runtimeId === SHARED);
    const nestedSharedRun = persisted.find(
      (item) => item.runtimeId === SHARED && item.runId !== topSharedRun?.runId,
    );
    const parentRun = topShared.find((item) => item.runtimeId === PARENT);
    expect([topSharedRun?.status, nestedSharedRun?.status]).toEqual([
      "success",
      "failed",
    ]);

    const corrections = events
      .filter((event) => event.type === "runtime.failed")
      .map((event) => event.payload);
    expect(corrections).toEqual([
      expect.objectContaining({
        runtimeId: PARENT,
        runId: parentRun?.runId,
        turnId: parentRun?.turnId,
        status: "failed",
      }),
    ]);
    expect(
      (await store.listPluginData(SESSION_ID, PLUGIN_ID, "notes")).map(
        (row) => row.key,
      ),
    ).toEqual(["top"]);
  });
});
