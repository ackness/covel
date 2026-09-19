import { describe, expect, it, vi } from "vitest";
import { MockLLM } from "@covel/plugin-test-utils";
import type { TurnExecutorDeps } from "@covel/runtime";
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

function executionDeps(
  store: Awaited<ReturnType<typeof createSessionStore>>,
  loadedCache: Map<string, LoadedRuntime>,
): TurnExecutorDeps & { store: typeof store } {
  return {
    store,
    loadRuntime: async (manifest) => loadedCache.get(manifest.name),
    llm: new MockLLM(),
    gateway,
    mediaStore: createMemoryMediaStore(),
    utils,
  };
}

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
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
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
  it("revokes a timed-out follower and discards its early and late writes", async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const release = deferred<void>();
    const lateWrite = deferred<unknown>();
    const store = await createSessionStore();
    const runtimeManifest = manifest({ timeoutMs: 20 });
    const loadedCache = new Map([
      [
        RUNTIME_ID,
        loadedRuntime(async (ctx) => {
          await ctx.pluginData!.set("notes", "early", { value: "uncommitted" });
          started.resolve();
          await release.promise;
          try {
            await ctx.pluginData!.set("notes", "late", { value: "too-late" });
            lateWrite.resolve(undefined);
          } catch (error) {
            lateWrite.resolve(error);
          }
          return { outcome: "success", value: null };
        }, runtimeManifest),
      ],
    ]);
    try {
      const pending = runDeferredFollower({
        follower: {
          runtimeId: RUNTIME_ID,
          pluginId: PLUGIN_ID,
          triggerEvent: { topic: "test.ready", data: {} },
        },
        sessionId: SESSION_ID,
        locale: "zh-CN",
        manifests: [runtimeManifest],
        deps: executionDeps(store, loadedCache),
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(21);
      const job = await pending;
      expect(job.status).toBe("failed");
      expect(job.result.error).toContain("timed out after 20ms");
      release.resolve();
      expect(await lateWrite.promise).toBeInstanceOf(Error);
      expect(
        await store.listPluginData(SESSION_ID, PLUGIN_ID, "notes"),
      ).toEqual([]);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "commits nested results together and only exposes followers after commit (rollback=%s)",
    async (rollback) => {
      const store = await createSessionStore();
      const parent = manifest();
      const nested = manifest({
        name: "plugin/nested",
        trigger: { type: "manual" },
      });
      const next = manifest({
        name: "plugin/next",
        trigger: { type: "event", topic: "followup.ready" },
        execution: "background",
      });
      const loadedCache = new Map([
        [
          parent.name,
          loadedRuntime(async (ctx) => {
            await ctx.pluginData!.set("notes", "parent", { ok: true });
            await ctx.recursiveCall({
              manualTrigger: { runtimeId: nested.name },
            });
            return {
              outcome: "success",
              effects: {
                events: [{ topic: "followup.ready", data: { ok: true } }],
              },
            };
          }, parent),
        ],
        [
          nested.name,
          loadedRuntime(async (ctx) => {
            await ctx.pluginData!.set("notes", "nested", { ok: true });
            return { outcome: "success", value: null };
          }, nested),
        ],
        [
          next.name,
          loadedRuntime(
            async () => ({ outcome: "success", value: null }),
            next,
          ),
        ],
      ]);
      if (rollback)
        vi.spyOn(store, "withTransaction").mockRejectedValueOnce(
          new Error("synthetic commit failure"),
        );
      const job = await runDeferredFollower({
        follower: {
          runtimeId: RUNTIME_ID,
          pluginId: PLUGIN_ID,
          triggerEvent: { topic: "test.ready", data: {} },
        },
        sessionId: SESSION_ID,
        locale: "zh-CN",
        manifests: [parent, nested, next],
        deps: executionDeps(store, loadedCache),
      });
      expect(
        job.runtimeResults.map((result) => result.runtimeId).sort(),
      ).toEqual([parent.name, nested.name].sort());
      expect(job.status).toBe(rollback ? "failed" : "done");
      expect(
        (await store.listPluginData(SESSION_ID, PLUGIN_ID, "notes"))
          .map((row) => row.key)
          .sort(),
      ).toEqual(rollback ? [] : ["nested", "parent"]);
      expect(job.deferredFollowers).toEqual(
        rollback
          ? []
          : [
              {
                runtimeId: next.name,
                pluginId: PLUGIN_ID,
                triggerEvent: { topic: "followup.ready", data: { ok: true } },
              },
            ],
      );
    },
  );

  it.each(["skipped", "suspended"] as const)(
    "preserves the host follower job semantics for %s",
    async (outcome) => {
      const store = await createSessionStore();
      const runtimeManifest = manifest();
      const loadedCache = new Map([
        [
          RUNTIME_ID,
          loadedRuntime(async (ctx) => {
            await ctx.pluginData!.set("notes", "discarded", {
              value: "uncommitted",
            });
            return outcome === "skipped"
              ? { outcome, skipReason: "nothing to do" }
              : { outcome, reason: "needs input", resumeSchema: {} };
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
        manifests: [runtimeManifest],
        deps: executionDeps(store, loadedCache),
      });
      expect(job.result.status).toBe(outcome);
      expect(job.status).toBe(outcome === "skipped" ? "failed" : "done");
      expect(
        await store.listPluginData(SESSION_ID, PLUGIN_ID, "notes"),
      ).toEqual([]);
      expect(await store.listSuspensions(SESSION_ID)).toHaveLength(
        outcome === "suspended" ? 1 : 0,
      );
    },
  );

  it.each(["failed", "throw"])(
    "discards buffered writes when a follower ends with %s",
    async (ending) => {
      const store = await createSessionStore();
      const runtimeManifest = manifest();
      const loadedCache = new Map([
        [
          RUNTIME_ID,
          loadedRuntime(async (ctx) => {
            await ctx.pluginData!.set("notes", "pending", {
              value: "must-rollback",
            });
            if (ending === "throw") throw new Error("synthetic failure");
            return { outcome: "failed", error: "synthetic failure" };
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
        manifests: [runtimeManifest],
        deps: executionDeps(store, loadedCache),
      });
      expect(job.status).toBe("failed");
      expect(
        await store.getPluginData(SESSION_ID, PLUGIN_ID, "notes", "pending"),
      ).toBeNull();
    },
  );

  it("keeps writes private until success while allowing the follower to read them", async () => {
    const store = await createSessionStore();
    const runtimeManifest = manifest();
    let outsideValue: unknown;
    let insideValue: unknown;
    const loadedCache = new Map([
      [
        RUNTIME_ID,
        loadedRuntime(async (ctx) => {
          await ctx.pluginData!.set("notes", "pending", { value: "committed" });
          outsideValue = await store.getPluginData(
            SESSION_ID,
            PLUGIN_ID,
            "notes",
            "pending",
          );
          insideValue = await ctx.pluginData!.get("notes", "pending");
          return { outcome: "success", value: null };
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
      manifests: [runtimeManifest],
      deps: executionDeps(store, loadedCache),
    });
    expect(job.status).toBe("done");
    expect(outsideValue).toBeNull();
    expect(insideValue).toEqual({ value: "committed" });
    expect(
      (await store.getPluginData(SESSION_ID, PLUGIN_ID, "notes", "pending"))
        ?.value,
    ).toEqual({ value: "committed" });
  });

  it("uses declared setting defaults alongside explicit overrides", async () => {
    const store = await createSessionStore();
    const runtimeManifest = manifest({
      userSettings: [
        { key: "enabled", type: "toggle", default: true, label: "Enabled" },
        { key: "count", type: "number", default: 2, label: "Count" },
      ],
    });
    let received: unknown;
    const loadedCache = new Map([
      [
        RUNTIME_ID,
        loadedRuntime(async (ctx) => {
          received = ctx.userSettings;
          return { outcome: "success", value: null };
        }, runtimeManifest),
      ],
    ]);
    await runDeferredFollower({
      follower: {
        runtimeId: RUNTIME_ID,
        pluginId: PLUGIN_ID,
        triggerEvent: { topic: "test.ready", data: {} },
      },
      sessionId: SESSION_ID,
      locale: "zh-CN",
      manifests: [runtimeManifest],
      deps: executionDeps(store, loadedCache),
      userSettings: { count: 5 },
    });
    expect(received).toEqual({ enabled: true, count: 5 });
  });

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
    const runtimeManifest = manifest({
      userSettings: [
        {
          key: "enabled",
          type: "toggle",
          default: false,
          label: "Enabled",
        },
      ],
    });
    const loadedCache = new Map([
      [
        RUNTIME_ID,
        loadedRuntime(async (ctx) => {
          received = ctx;
          return {
            outcome: "success",
            effects: {
              pluginData: [
                {
                  namespace: "events",
                  key: "latest",
                  value: { topic: ctx.triggerEvent?.topic ?? null },
                },
              ],
            },
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
      manifests: [runtimeManifest],
      deps: executionDeps(store, loadedCache),
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
      manifests: [runtimeManifest],
      deps: executionDeps(store, loadedCache),
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
          async () => ({ outcome: "failed", error: "reported failure" }),
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
      manifests: [runtimeManifest],
      deps: executionDeps(store, loadedCache),
    });

    expect(job.status).toBe("failed");
    expect(job.result).toMatchObject({
      status: "failed",
      error: "reported failure",
      output: { error: "reported failure" },
    });
    const row = await getJobRow(store, job.jobId);
    expect(row.value).toMatchObject({
      status: "failed",
      error: "reported failure",
      runtimeResults: [{ status: "failed", error: "reported failure" }],
    });
  });

  it("enforces the declared recursion limit for deferred followers", async () => {
    const store = await createSessionStore();
    const runtimeManifest = manifest({ maxRecursionDepth: 0 });
    const loadedCache = new Map([
      [
        RUNTIME_ID,
        loadedRuntime(async (ctx) => {
          await ctx.recursiveCall({ playerMessage: "nested" });
          return { outcome: "success", value: null };
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
      manifests: [runtimeManifest],
      deps: executionDeps(store, loadedCache),
    });

    expect(job.status).toBe("failed");
    expect(job.result.error).toBe(
      'recursiveCall exceeded max depth 0 for runtime "plugin/follower"',
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
        manifests: [],
        deps: executionDeps(store, new Map()),
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
        manifests: [manifest()],
        deps: executionDeps(
          store,
          new Map([[RUNTIME_ID, loadedRuntime(undefined)]]),
        ),
      }),
    ).rejects.toThrow("deferred follower has no handler: plugin/follower");
  });
});
