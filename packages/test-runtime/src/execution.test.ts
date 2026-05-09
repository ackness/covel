import { describe, expect, it } from "vitest";
import type {
  FunctionHandlerContext,
  LoadedRuntime,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
} from "@covel/plugin-loader";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import {
  createMemoryMediaStore,
  createMemoryStore,
  type PluginDataRecord,
} from "@covel/store";

import {
  runDeferredFollower,
  writeExpectedFollowerFailureJob,
} from "./execution.js";

const SESSION_ID = "session-execution";
const PLUGIN_ID = "plugin";
const RUNTIME_ID = "plugin/follower";

const gateway: PluginRuntimeGateway = {
  async generateText() {
    return {
      text: "",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
  async generateObject<T = unknown>() {
    return {
      object: {} as T,
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
  resolveSlot() {
    return null;
  },
};

const utils: PluginRuntimeUtils = {
  validateBaseUrl() {
    return { ok: true };
  },
  fetchWithRetry() {
    return Promise.resolve(new Response());
  },
};

function runtimeResult(patch: Partial<RuntimeResult> = {}): RuntimeResult {
  return {
    runtimeId: RUNTIME_ID,
    pluginId: PLUGIN_ID,
    runId: "run-1",
    turnId: "turn-1",
    status: "success",
    durationMs: 1,
    output: {},
    toolCalls: [],
    timestamp: "2026-05-09T00:00:00.000Z",
    ...patch,
  };
}

function manifest(patch: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: RUNTIME_ID,
    pluginId: PLUGIN_ID,
    description: "Deferred test follower",
    runtimeType: "function",
    handler: "handler.js",
    trigger: { type: "event", topic: "test.ready" },
    outputKind: "plugin",
    capabilities: [],
    ...patch,
  };
}

function loadedRuntime(
  handler: LoadedRuntime["handler"],
  runtimeManifest = manifest(),
): LoadedRuntime {
  return {
    manifest: runtimeManifest,
    promptTemplate: "",
    references: [],
    ...(handler ? { handler } : {}),
  };
}

async function createSessionStore() {
  const store = createMemoryStore();
  const now = "2026-05-09T00:00:00.000Z";
  await store.createSession({
    id: SESSION_ID,
    locale: "zh-CN",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    activePlugins: [PLUGIN_ID],
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

async function getJobRow(
  store: Awaited<ReturnType<typeof createSessionStore>>,
  jobId: string,
): Promise<PluginDataRecord> {
  const row = await store.getPluginData(SESSION_ID, PLUGIN_ID, "_jobs", jobId);
  if (!row) throw new Error(`missing job row: ${jobId}`);
  return row;
}

describe("test-runtime execution helpers", () => {
  it("writes expected follower failure jobs with failed runtime errors", async () => {
    const store = await createSessionStore();
    const failed = runtimeResult({
      status: "failed",
      error: "runtime failed before emitting the event",
    });

    const job = await writeExpectedFollowerFailureJob({
      store,
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      runtimeId: RUNTIME_ID,
      turnId: "turn-1",
      runtimeResults: [failed],
    });

    expect(job).toMatchObject({
      runtimeId: RUNTIME_ID,
      pluginId: PLUGIN_ID,
      status: "failed",
    });
    const row = await getJobRow(store, job.jobId);
    expect(row.value).toMatchObject({
      status: "failed",
      runtimeId: RUNTIME_ID,
      turnId: "turn-1",
      reason: "expected-background-follower-missing",
      error: "runtime failed before emitting the event",
      runtimeResults: [failed],
    });
  });

  it("writes expected follower failure fallback errors", async () => {
    const store = await createSessionStore();
    const successful = runtimeResult();

    const job = await writeExpectedFollowerFailureJob({
      store,
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      runtimeId: RUNTIME_ID,
      turnId: "turn-1",
      runtimeResults: [successful],
    });

    const row = await getJobRow(store, job.jobId);
    expect(row.value).toMatchObject({
      status: "failed",
      runtimeId: RUNTIME_ID,
      turnId: "turn-1",
      error:
        'runtime "plugin/follower" completed without emitting a matching background follower event',
      runtimeResults: [successful],
    });
  });

  it("runs deferred followers and commits returned plugin data", async () => {
    const store = await createSessionStore();
    let received: FunctionHandlerContext | undefined;
    const runtimeManifest = manifest();
    const loadedCache = new Map([
      [
        RUNTIME_ID,
        loadedRuntime(async (ctx) => {
          received = ctx;
          return {
            pluginData: [
              {
                namespace: "events",
                key: "latest",
                value: { topic: ctx.triggerEvent?.topic },
              },
            ],
          };
        }, runtimeManifest),
      ],
    ]);

    const job = await runDeferredFollower({
      follower: {
        runtimeId: RUNTIME_ID,
        pluginId: PLUGIN_ID,
        triggerEvent: { topic: "test.ready", data: { ok: true } },
      },
      sessionId: SESSION_ID,
      locale: "zh-CN",
      store,
      manifests: [runtimeManifest],
      loadedCache,
      gateway,
      mediaStore: createMemoryMediaStore(),
      utils,
      config: { temperature: 0.1 },
      userSettings: { enabled: true },
    });

    expect(job.status).toBe("done");
    expect(job.result).toMatchObject({
      runtimeId: RUNTIME_ID,
      pluginId: PLUGIN_ID,
      turnId: expect.stringMatching(/^turn-/),
      status: "success",
      output: {
        pluginData: [
          {
            namespace: "events",
            key: "latest",
            value: { topic: "test.ready" },
          },
        ],
      },
    });
    expect(received).toMatchObject({
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      locale: "zh-CN",
      config: { temperature: 0.1 },
      userSettings: { enabled: true },
      triggerEvent: { topic: "test.ready", data: { ok: true } },
    });
    expect(received?.turnId).toMatch(/^turn-/);
    expect(received?.store).not.toHaveProperty("setPluginData");

    const committed = await store.getPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "events",
      "latest",
    );
    expect(committed?.value).toEqual({ topic: "test.ready" });

    const row = await getJobRow(store, job.jobId);
    expect(row.value).toMatchObject({
      status: "done",
      runtimeId: RUNTIME_ID,
      runtimeResults: [
        {
          runtimeId: RUNTIME_ID,
          pluginId: PLUGIN_ID,
          status: "success",
        },
      ],
    });
  });

  it("records thrown deferred follower errors as failed jobs", async () => {
    const store = await createSessionStore();
    const runtimeManifest = manifest();
    const loadedCache = new Map([
      [
        RUNTIME_ID,
        loadedRuntime(async () => {
          throw new Error("boom");
        }, runtimeManifest),
      ],
    ]);

    const job = await runDeferredFollower({
      follower: {
        runtimeId: RUNTIME_ID,
        pluginId: PLUGIN_ID,
        triggerEvent: { topic: "test.ready", data: {} },
      },
      sessionId: SESSION_ID,
      locale: "zh-CN",
      store,
      manifests: [runtimeManifest],
      loadedCache,
      gateway,
      mediaStore: createMemoryMediaStore(),
      utils,
      config: {},
    });

    expect(job.status).toBe("failed");
    expect(job.result).toMatchObject({
      runtimeId: RUNTIME_ID,
      pluginId: PLUGIN_ID,
      status: "failed",
      error: "boom",
      output: {},
    });
    const row = await getJobRow(store, job.jobId);
    expect(row.value).toMatchObject({
      status: "failed",
      runtimeId: RUNTIME_ID,
      error: "boom",
      runtimeResults: [{ status: "failed", error: "boom" }],
    });
  });

  it("records reported deferred follower failures as failed jobs", async () => {
    const store = await createSessionStore();
    const runtimeManifest = manifest();
    const loadedCache = new Map([
      [
        RUNTIME_ID,
        loadedRuntime(
          async () => ({ status: "failed", error: "reported failure" }),
          runtimeManifest,
        ),
      ],
    ]);

    const job = await runDeferredFollower({
      follower: {
        runtimeId: RUNTIME_ID,
        pluginId: PLUGIN_ID,
        triggerEvent: { topic: "test.ready", data: {} },
      },
      sessionId: SESSION_ID,
      locale: "zh-CN",
      store,
      manifests: [runtimeManifest],
      loadedCache,
      gateway,
      mediaStore: createMemoryMediaStore(),
      utils,
      config: {},
    });

    expect(job.status).toBe("failed");
    expect(job.result).toMatchObject({
      status: "failed",
      error: "reported failure",
      output: { status: "failed", error: "reported failure" },
    });
    const row = await getJobRow(store, job.jobId);
    expect(row.value).toMatchObject({
      status: "failed",
      error: "reported failure",
      runtimeResults: [{ status: "failed", error: "reported failure" }],
    });
  });

  it("keeps recursiveCall unavailable for deferred followers", async () => {
    const store = await createSessionStore();
    const runtimeManifest = manifest();
    const loadedCache = new Map([
      [
        RUNTIME_ID,
        loadedRuntime(async (ctx) => {
          await ctx.recursiveCall({ playerMessage: "nested" });
          return {};
        }, runtimeManifest),
      ],
    ]);

    const job = await runDeferredFollower({
      follower: {
        runtimeId: RUNTIME_ID,
        pluginId: PLUGIN_ID,
        triggerEvent: { topic: "test.ready", data: {} },
      },
      sessionId: SESSION_ID,
      locale: "zh-CN",
      store,
      manifests: [runtimeManifest],
      loadedCache,
      gateway,
      mediaStore: createMemoryMediaStore(),
      utils,
      config: {},
    });

    expect(job.status).toBe("failed");
    expect(job.result.error).toBe(
      "recursiveCall is unavailable for test-runtime deferred followers",
    );
  });

  it("throws when deferred follower manifests or handlers are missing", async () => {
    const store = await createSessionStore();

    await expect(
      runDeferredFollower({
        follower: {
          runtimeId: RUNTIME_ID,
          pluginId: PLUGIN_ID,
          triggerEvent: { topic: "test.ready", data: {} },
        },
        sessionId: SESSION_ID,
        locale: "zh-CN",
        store,
        manifests: [],
        loadedCache: new Map(),
        gateway,
        mediaStore: createMemoryMediaStore(),
        utils,
        config: {},
      }),
    ).rejects.toThrow("deferred follower not found: plugin/follower");

    await expect(
      runDeferredFollower({
        follower: {
          runtimeId: RUNTIME_ID,
          pluginId: PLUGIN_ID,
          triggerEvent: { topic: "test.ready", data: {} },
        },
        sessionId: SESSION_ID,
        locale: "zh-CN",
        store,
        manifests: [manifest()],
        loadedCache: new Map([[RUNTIME_ID, loadedRuntime(undefined)]]),
        gateway,
        mediaStore: createMemoryMediaStore(),
        utils,
        config: {},
      }),
    ).rejects.toThrow("deferred follower has no handler: plugin/follower");
  });
});
