/**
 * Background manual and event activations on the durable runtime job worker:
 * how a queued run settles its job, its writes and the followers it emits.
 */

import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type FunctionHandler,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { enqueueActivatedRuntimeJob } from "../../src/routes/api/plugin-rpc/runtime-job-enqueue.js";
import { createTestRuntimeJobWorker } from "./__helpers/runtime-job-worker.js";

const PLUGIN_ID = "test-activated";
const ENTRY = `${PLUGIN_ID}/entry`;
const FOLLOWER = `${PLUGIN_ID}/follower`;
const SESSION_ID = "sess-activated";

function manifest(name: string, extra: Partial<RuntimeManifest> = {}) {
  return {
    name,
    pluginId: PLUGIN_ID,
    description: "test function runtime",
    runtimeType: "function",
    outputKind: "plugin",
    pluginType: "plugin",
    handler: "./handler.js",
    trigger: { type: "manual" },
    ...extra,
  } as RuntimeManifest;
}

async function setup(handlers: {
  readonly entry: FunctionHandler;
  readonly follower?: FunctionHandler;
}) {
  const store: DataStore = createMemoryStore();
  const eventBus = createEventBus(store);
  const sessionLock = createInProcessSessionLock();
  const pluginRegistry = createPluginRegistry();
  const runtimes = new Map<string, LoadedRuntime>([
    [
      ENTRY,
      {
        manifest: manifest(ENTRY),
        promptTemplate: "",
        handler: handlers.entry,
      },
    ],
  ]);
  if (handlers.follower)
    runtimes.set(FOLLOWER, {
      manifest: manifest(FOLLOWER, {
        execution: "background",
        trigger: { type: "event", topic: "test-activated.ready" },
      }),
      promptTemplate: "",
      handler: handlers.follower,
    });
  pluginRegistry.register({
    id: PLUGIN_ID,
    summary: {
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      description: "",
      pluginType: "plugin",
      runtimeCount: runtimes.size,
    },
    manifests: [...runtimes.values()].map((loaded) => ({
      runtime: { type: "function" as const },
      manifest: loaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    })),
    loadedRuntimes: runtimes,
    status: "registered",
    source: "builtin",
  } as PluginRegistryEntry);
  const now = new Date().toISOString();
  await store.createSession({
    id: SESSION_ID,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    locale: "en-US",
    activePlugins: [PLUGIN_ID],
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
    },
    createdAt: now,
    updatedAt: now,
  });
  const worker = createTestRuntimeJobWorker({
    store,
    eventBus,
    sessionLock,
    pluginRegistry,
    deps: {
      loadRuntime: async (m: RuntimeManifest) => runtimes.get(m.name),
      llm: {
        generate: async () => {
          throw new Error("function runtimes do not use the LLM");
        },
      },
    },
  });
  const enqueue = async (expectFollower = false) => {
    const session = (await store.getSession(SESSION_ID))!;
    const queued = await store.withTransaction((tx) =>
      enqueueActivatedRuntimeJob(tx, {
        sessionId: SESSION_ID,
        session,
        pluginId: PLUGIN_ID,
        runtimeId: ENTRY,
        activation: "manual",
        sourceTurnId: "source-turn",
        locale: session.locale,
        ...(expectFollower ? { expectFollower } : {}),
      }),
    );
    worker.wake();
    return queued.job.jobId;
  };
  const jobs = async () =>
    new Map(
      (await store.listPluginData(SESSION_ID, PLUGIN_ID, "_runtime_jobs")).map(
        (row) => [
          row.key,
          row.value as {
            status: string;
            runtimeId: string;
            reason?: string;
            error?: string;
            origin: { activation: string };
            result?: { deferredJobs?: { jobId: string }[] };
          },
        ],
      ),
    );
  const settle = async (jobId: string, statuses: readonly string[]) => {
    for (let i = 0; i < 2_000; i++) {
      const job = (await jobs()).get(jobId);
      if (job && statuses.includes(job.status)) return job;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`job ${jobId} did not reach ${statuses.join("/")}`);
  };
  return { store, enqueue, jobs, settle };
}

describe("activated runtime jobs", () => {
  it("commits a reported failure's writes and settles the job failed", async () => {
    const env = await setup({
      entry: async () => ({
        outcome: "success",
        value: { status: "failed", error: "provider refused the prompt" },
        effects: {
          pluginData: [{ namespace: "state", key: "last", value: "failed" }],
        },
      }),
    });
    const job = await env.settle(await env.enqueue(), ["failed"]);
    expect(job).toMatchObject({
      reason: "runtime-reported-failure",
      error: "provider refused the prompt",
    });
    expect(
      (await env.store.getPluginData(SESSION_ID, PLUGIN_ID, "state", "last"))
        ?.value,
    ).toBe("failed");
  });

  it("queues emitted followers with the entry's commit and runs them", async () => {
    let followerSaw: unknown;
    const env = await setup({
      entry: async () => ({
        outcome: "success",
        value: {},
        effects: {
          events: [{ topic: "test-activated.ready", data: { prompt: "fog" } }],
        },
      }),
      follower: async (ctx) => {
        followerSaw = (ctx.triggerEvent as { data: unknown }).data;
        return { outcome: "success", value: {} };
      },
    });
    const entry = await env.settle(await env.enqueue(true), ["succeeded"]);
    const followerJobId = entry.result?.deferredJobs?.[0]?.jobId;
    expect(followerJobId).toBeDefined();
    const follower = await env.settle(followerJobId!, ["succeeded"]);
    expect(follower).toMatchObject({
      runtimeId: FOLLOWER,
      origin: { activation: "event" },
    });
    expect(followerSaw).toEqual({ prompt: "fog" });
  });

  it("rolls back the run and queues no follower when its proposals fail", async () => {
    const env = await setup({
      entry: async () => ({
        outcome: "success",
        value: {},
        effects: {
          // A reserved namespace is rejected at commit.
          pluginData: [{ namespace: "_forbidden", key: "k", value: 1 }],
          events: [{ topic: "test-activated.ready", data: {} }],
        },
      }),
      follower: async () => ({ outcome: "success", value: {} }),
    });
    const jobId = await env.enqueue(true);
    const job = await env.settle(jobId, ["failed"]);
    expect(job.reason).toBe("execution-failed");
    expect([...(await env.jobs()).keys()]).toEqual([jobId]);
  });

  it("goes stale when the session is paused while the runtime executes", async () => {
    let release!: () => void;
    const started = Promise.withResolvers<void>();
    const env = await setup({
      entry: async () => {
        started.resolve();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          outcome: "success",
          value: {},
          effects: {
            pluginData: [{ namespace: "state", key: "late", value: true }],
          },
        };
      },
    });
    const jobId = await env.enqueue();
    await started.promise;
    await env.store.updateSession(SESSION_ID, { status: "paused" });
    release();
    await env.settle(jobId, ["stale"]);
    expect(
      await env.store.getPluginData(SESSION_ID, PLUGIN_ID, "state", "late"),
    ).toBeNull();
  });
});
