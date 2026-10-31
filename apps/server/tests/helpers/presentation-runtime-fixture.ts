import { createEventBus } from "@covel/events";
import { createPluginRegistry } from "@covel/plugin-loader";
import type {
  FunctionHandler,
  PluginRuntimeGateway,
} from "@covel/shared/plugin-runtime";
import type { DeferredRuntimeJob, RuntimeManifest } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  commitExecution,
  executeTurn,
  createTurnEmitter,
  type HookPipeline,
} from "@covel/runtime";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createRuntimeJobWorker } from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";
import { createRuntimeJobExecutor } from "../../src/routes/api/plugin-rpc/runtime-job-executor.js";
import { createPluginRpcRuntimeTurnRunner } from "../../src/routes/api/plugin-rpc/runtime-turn.js";
import { enqueueDeferredRuntimeJobs } from "../../src/routes/api/plugin-rpc/runtime-job-enqueue.js";
import { listRuntimeJobs } from "../../src/routes/api/plugin-rpc/jobs.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";

export async function presentationFixture(
  options: {
    store?: DataStore;
    hooks?: HookPipeline;
    handler?: FunctionHandler;
    storyHandler?: FunctionHandler;
    queueMs?: number;
    ready?: () => boolean;
  } = {},
) {
  const store = options.store ?? createMemoryStore();
  const sessionId = crypto.randomUUID();
  const at = new Date().toISOString();
  const story: RuntimeManifest = {
    name: "public-story/tell",
    pluginId: "public-story",
    description: "Public source",
    version: "1.0.0",
    runtimeType: "function",
    handler: "./handler.js",
    stage: "narrative",
    outputKind: "story",
    outputContract: "narrative-engine@2",
  };
  const presentation: RuntimeManifest = {
    name: "public-display/render",
    pluginId: "public-display",
    description: "Bounded display",
    version: "1.0.0",
    runtimeType: "function",
    handler: "./handler.js",
    stage: "post-turn",
    outputKind: "system",
    turnCompletion: {
      mode: "detached",
      ...(options.queueMs ? { maxQueueMs: options.queueMs } : {}),
    },
    presentation: { budget: { calls: 2 }, publicAssetNamespaces: ["art"] },
    inputs: {
      story: { from: { capability: "narrative-engine@2" }, required: false },
    },
    effects: {
      reads: ["plugin-data:self:art", "plugin-data:self:display"],
      writes: ["plugin-data:self:display"],
    },
  };
  const manifests = [story, presentation];
  await store.createSession({
    id: sessionId,
    locale: "en-US",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [],
    activePlugins: manifests.map((runtime) => runtime.pluginId),
    metadata: {
      sessionIncarnationNonce: crypto.randomUUID(),
      approvalScopeNonce: crypto.randomUUID(),
    },
    createdAt: at,
    updatedAt: at,
  });
  const session = (await store.getSession(sessionId))!;
  const registry = createPluginRegistry();
  for (const manifest of manifests)
    registry.register({
      id: manifest.pluginId,
      summary: {
        id: manifest.pluginId,
        name: manifest.pluginId,
        description: "Fixture",
        kind: "plugin",
        runtimeCount: 1,
      },
      manifests: [
        {
          manifest,
          runtime: { function: {} },
          promptTemplate: "",
          rawFrontmatter: {},
        },
      ],
      loadedRuntimes: new Map(),
      status: "registered",
    });
  registry.syncSessionActivations(sessionId, session.activePlugins);
  const events = createEventBus(store);
  const lock = createInProcessSessionLock();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const gateway: PluginRuntimeGateway = {
    resolveSlot: () => ({
      presetId: "text",
      provider: "fixture",
      model: "deterministic",
      protocol: "openai-chat-v1",
      tag: "text",
      metadata: {},
      apiKey: "request-secret",
    }),
    generateText: async (input) => {
      calls.push(input.prompt ?? "");
      await gate;
      input.signal?.throwIfAborted();
      return {
        text: "Generated display",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    generateObject: async <T>() => ({
      object: {} as T,
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
  const llm = {
    generate: async (): Promise<never> => {
      throw new Error("Unexpected agent model call");
    },
  };
  const loaded = async (manifest: RuntimeManifest) => ({
    manifest,
    promptTemplate: "",
    handler:
      manifest.name === story.name
        ? (options.storyHandler ??
          (async () => ({
            outcome: "success" as const,
            value: {
              segments: [{ kind: "narration", text: "Public library story" }],
              cues: { scene: "Library" },
              secret: "raw-source-secret",
            },
          })))
        : manifest.name !== presentation.name
          ? async () => ({ outcome: "success" as const, value: {} })
          : (options.handler ??
            ((async (ctx) => {
              const input = ctx.inputs?.story;
              const source =
                input?.cardinality === "one" ? input.value : undefined;
              await ctx.gateway!.generateText({
                prompt: JSON.stringify(source),
              });
              await ctx.pluginData!.set("display", "current", {
                title: "Generated display",
              });
              return { outcome: "success" as const, value: {} };
            }) satisfies FunctionHandler)),
  });
  const deps = {
    store,
    llm,
    gateway,
    eventBus: events,
    loadRuntime: loaded,
    hookPipeline: options.hooks,
  };
  const executor = createRuntimeJobExecutor({
    store,
    eventBus: events,
    registry,
    createRunner: (_job, services, activeRuntimes) =>
      createPluginRpcRuntimeTurnRunner({
        store,
        eventBus: events,
        sessionLock: lock,
        sessionId,
        session,
        activeRuntimes,
        hookPipeline: options.hooks,
        approvalScopes: new Map(
          activeRuntimes.map((runtime) => [
            runtime.pluginId,
            sessionApprovalScope(session, runtime.pluginId),
          ]),
        ),
        deps: { ...deps, ...services },
      }),
  })({ llm, gateway });
  const makeWorker = () =>
    createRuntimeJobWorker({
      store,
      eventBus: events,
      tryWithCommitLock: lock.tryWithLock.bind(lock),
      execute: executor,
      ...(options.ready ? { canExecute: options.ready } : {}),
    });
  let worker = makeWorker();
  async function source(turnId: string = crypto.randomUUID()) {
    return lock.withLock(sessionId, async () => {
      const emitter = createTurnEmitter({
        store,
        eventBus: events,
        sessionId,
        turnId,
      });
      const execution = await executeTurn(
        {
          sessionId,
          turnId,
          origin: "player",
          playerMessage: "private-player-intent",
          locale: "en-US",
        },
        manifests,
        { ...deps, emitter },
      );
      let descriptors: readonly DeferredRuntimeJob[] =
        execution.result.deferredRuntimeJobs ?? [];
      const outcome = await commitExecution({
        store,
        eventBus: events,
        emitter,
        execution,
        hookPipeline: options.hooks,
        completion: { kind: "turn", turnId, durationMs: 0 },
        extraInTx: async (tx) => {
          const jobs = await enqueueDeferredRuntimeJobs(tx, {
            sessionId,
            session,
            activeRuntimes: manifests,
            descriptors,
            locale: "en-US",
          });
          descriptors = jobs.map(
            ({ job }) =>
              (job.payload as { descriptor: DeferredRuntimeJob }).descriptor,
          );
        },
      });
      return { execution, outcome, descriptors };
    });
  }
  return {
    store,
    sessionId,
    session,
    story,
    presentation,
    manifests,
    registry,
    events,
    lock,
    get worker() {
      return worker;
    },
    calls,
    release,
    source,
    restart: async () => {
      await worker.close();
      worker = makeWorker();
      worker.wake();
    },
    jobs: () => listRuntimeJobs(store, { sessionId }),
    close: async () => {
      release();
      await worker.close();
      await events.close();
      await store.deleteSession(sessionId);
      if (!options.store) await store.close();
    },
  };
}
