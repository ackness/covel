/**
 * POST /api/actions — commit-time corrections for runs dropped through a read
 * dependency.
 *
 * A runtime that read an earlier runtime's uncommitted plugin data is dropped
 * at commit when that runtime's writes are refused. Like any other drop, it
 * arrives as a `runtime.failed` correction that names the dropped run.
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
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createTestRuntimeJobWorker } from "./__helpers/runtime-job-worker.js";

const PLUGIN_ID = "test-read-dependency";
const STORY = `${PLUGIN_ID}/story`;
const WRITER = `${PLUGIN_ID}/writer`;
const READER = `${PLUGIN_ID}/reader`;
const SESSION_ID = "sess-read-dependency";

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

describe("POST /api/actions — a run dropped for what it read", () => {
  it("corrects the reader of a refused write with its runId", async () => {
    const store = createMemoryStore();
    const pluginRegistry = createPluginRegistry();
    const eventBus = createEventBus(store);
    const sessionLock = createInProcessSessionLock();
    const story = manifest(STORY, { stage: "narrative", outputKind: "story" });
    const writer = manifest(WRITER, { stage: "pre-turn" });
    const reader = manifest(READER);
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
        WRITER,
        {
          manifest: writer,
          promptTemplate: "",
          // Plugin code may not write a framework namespace, so the commit
          // refuses this runtime's writes, `notes/tide` included.
          handler: async () => ({
            outcome: "success",
            value: {},
            effects: {
              pluginData: [
                { namespace: "notes", key: "tide", value: "high" },
                { namespace: "_jobs", key: "x", value: 1 },
              ],
            },
          }),
        },
      ],
      [
        READER,
        {
          manifest: reader,
          promptTemplate: "",
          handler: async (ctx) => {
            const tide = await ctx.pluginData!.get("notes", "tide");
            await ctx.pluginData!.set(
              "notes",
              "plan",
              `sail at ${String(tide)}`,
            );
            return { outcome: "success", value: {} };
          },
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
      manifests: [story, writer, reader].map((runtime) => ({
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
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
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
        requestId: "req-read-dependency",
        type: "submit_actions",
        sessionId: SESSION_ID,
        payload: { actions: [{ kind: "say", text: "go" }] },
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
    const persisted = (await store.listTurnResults(SESSION_ID)).flatMap(
      (row) => row.runtimeResults as RuntimeResult[],
    );
    const readerRun = persisted.find((item) => item.runtimeId === READER);
    const writerRun = persisted.find((item) => item.runtimeId === WRITER);
    expect(readerRun).toMatchObject({
      status: "failed",
      error: `read data of ${WRITER} that did not commit`,
    });

    const corrections = events
      .filter((event) => event.type === "runtime.failed")
      .map((event) => event.payload);
    expect(corrections).toEqual([
      expect.objectContaining({ runtimeId: WRITER, runId: writerRun?.runId }),
      expect.objectContaining({
        runtimeId: READER,
        runId: readerRun?.runId,
        turnId: readerRun?.turnId,
        status: "failed",
        error: `read data of ${WRITER} that did not commit`,
      }),
    ]);
    expect(await store.listPluginData(SESSION_ID, PLUGIN_ID, "notes")).toEqual(
      [],
    );
  });
});
