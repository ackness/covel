import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store";
import {
  executeTurn,
  commitExecution,
  PluginExtensionHost,
  PluginServiceRegistry,
  type LLMAdapter,
} from "@covel/runtime";
import { promptSegmentV1, type RuntimeManifest } from "@covel/shared";
import extractMemory from "../../../../plugins/memory/server/extract.js";
import registerMemory from "../../../../plugins/memory/server/index.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createSettledSessionLock } from "../../src/routes/api/plugin-rpc/settled-session-lock.js";
import { createRuntimeJobCredentials } from "../../src/routes/api/plugin-rpc/runtime-job-credentials.js";
import {
  createRuntimeJob,
  claimRuntimeJob,
  transitionRuntimeJob,
  listSettlingRuntimeJobs,
} from "../../src/routes/api/plugin-rpc/jobs.js";

const timestamp = "2026-09-27T00:00:00.000Z";
const story: RuntimeManifest = {
  name: "story",
  pluginId: "story",
  description: "story",
  runtimeType: "function",
  handler: "./story.js",
  stage: "narrative",
  outputKind: "story",
  trigger: { type: "auto" },
};
const memory: RuntimeManifest = {
  name: "memory/extract",
  pluginId: "memory",
  description: "memory",
  runtimeType: "function",
  handler: "./extract.js",
  stage: "post-turn",
  outputKind: "system",
  trigger: { type: "auto" },
  turnCompletion: { mode: "detached", settle: "before-next-execution" },
  input: { inject: [{ kind: "kernel", from: "turn-digest@1", name: "turn" }] },
  effects: {
    reads: ["plugin-data:self:blocks"],
    writes: ["plugin-data:self:blocks"],
  },
};
const llm: LLMAdapter = {
  generate: async () => {
    throw new Error("Unexpected agent generation");
  },
};

async function fixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: "session",
    worldId: null,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: ["story", "memory"],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const services = new PluginServiceRegistry({
    list: async () => (await store.getSession("session"))?.activePlugins ?? [],
    ensure: async (_session, pluginId) => {
      if (
        !(await store.getSession("session"))?.activePlugins.includes(pluginId)
      )
        throw new Error("Inactive");
    },
  });
  const extensions = new PluginExtensionHost(services);
  registerMemory({
    toolkit: { z },
    registerService: (definition) => services.register("memory", definition),
    provideExtension: (point, id, definition) =>
      extensions.register("memory", { point, id }, definition),
  });
  const loadRuntime = async (manifest: RuntimeManifest) => ({
    manifest,
    promptTemplate: "",
    handler:
      manifest.name === "story"
        ? async () => ({
            outcome: "success",
            value: { narrativeOutput: "The source-turn harbour." },
          })
        : extractMemory,
  });
  const raw = createInProcessSessionLock();
  const settled = createSettledSessionLock({
    sessionLock: raw,
    listPendingJobs: (sessionId) => listSettlingRuntimeJobs(store, sessionId),
    pollIntervalMs: 1,
  });
  return { store, extensions, raw, settled, loadRuntime };
}

describe("memory detached lifecycle", () => {
  it("uses source request services and lets the next execution snapshot see only the committed extraction", async () => {
    const { store, extensions, raw, settled, loadRuntime } = await fixture();
    const generateText = vi.fn(async () => ({
      text: '{"scene":"Committed harbour memory"}',
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const original = { llm, gateway: { generateText } };
    const replacement = {
      llm,
      gateway: {
        generateText: vi.fn(async () => {
          throw new Error("Wrong request credentials");
        }),
      },
    };
    const source = await executeTurn(
      {
        sessionId: "session",
        turnId: "source",
        playerMessage: "Go to the harbour",
        locale: "en",
        origin: "player",
      },
      [story, memory],
      { store, llm, loadRuntime, gateway: original.gateway },
    );
    const descriptor = source.deferredRuntimeJobs?.[0];
    expect(descriptor?.turnDigest).toMatchObject({
      turnId: "source",
      playerMessage: "Go to the harbour",
      narrativeText: "The source-turn harbour.",
    });
    const key = {
      jobId: descriptor!.jobId,
      sessionId: "session",
      expectedSessionIncarnation: timestamp,
    };
    const credentials = createRuntimeJobCredentials();
    credentials.register(key, original);
    credentials.provide([key], replacement);
    await createRuntimeJob(store, {
      ...key,
      pluginId: "memory",
      runtimeId: memory.name,
      origin: { activation: "stage", sourceTurnId: "source" },
      payload: descriptor,
      settle: "before-next-execution",
    });
    await claimRuntimeJob(store, {
      ...key,
      pluginId: "memory",
      ownerId: "worker",
      leaseMs: 10000,
    });
    await transitionRuntimeJob(store, {
      ...key,
      pluginId: "memory",
      from: ["claimed"],
      to: "running",
    });
    const nextStarted = vi.fn();
    const next = settled.withLock("session", {}, async () => {
      nextStarted();
      const execution = extensions.createExecution({
        sessionId: "session",
        locale: "en",
        turnId: "next",
        signal: new AbortController().signal,
        pluginData: await store.listPluginDataSessionScope("session"),
      });
      return execution.run(promptSegmentV1, {
        turnId: "next",
        playerMessage: "Continue",
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nextStarted).not.toHaveBeenCalled();
    const service = credentials.take(key)!;
    const worker = await executeTurn(
      {
        sessionId: "session",
        turnId: "worker",
        playerMessage: "unrelated later request",
        locale: "en",
        origin: "background",
        detachedStage: descriptor,
      },
      [story, memory],
      { store, llm: service.llm, gateway: service.gateway, loadRuntime },
    );
    expect(worker.runtimeResults[0]?.status).toBe("success");
    expect(
      await store.getPluginData("session", "memory", "blocks", "scene"),
    ).toBeNull();
    await raw.withLock("session", async () => {
      const result = await commitExecution({
        store,
        sessionId: "session",
        results: worker.runtimeResults,
        runtimes: [memory],
        turnIds: [],
        executionContext: worker.executionContext!,
        completion: { kind: "detached", turnId: "worker" },
        extraInTx: async (tx) => {
          await transitionRuntimeJob(tx, {
            ...key,
            pluginId: "memory",
            from: ["running"],
            to: "succeeded",
          });
        },
      });
      expect(result.status).toBe("committed");
    });
    const segments = (await next).flat();
    expect(segments[0]?.content).toContain("Committed harbour memory");
    expect(generateText).toHaveBeenCalledOnce();
    expect(generateText.mock.calls[0]?.[0].prompt).toContain(
      "The source-turn harbour.",
    );
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain(
      "unrelated later request",
    );
    expect(replacement.gateway.generateText).not.toHaveBeenCalled();
    credentials.clear();
  });

  it("does not wait or inject stale blocks after memory is disabled", async () => {
    const { store, extensions, settled } = await fixture();
    await createRuntimeJob(store, {
      sessionId: "session",
      pluginId: "memory",
      runtimeId: memory.name,
      jobId: "queued",
      origin: { activation: "stage", sourceTurnId: "source" },
      payload: {},
      settle: "before-next-execution",
    });
    await store.updateSession("session", { activePlugins: ["story"] });
    expect(await listSettlingRuntimeJobs(store, "session")).toEqual([]);
    await expect(
      settled.withLock("session", {}, async () => {
        const execution = extensions.createExecution({
          sessionId: "session",
          locale: "en",
          signal: new AbortController().signal,
          pluginData: [],
        });
        return execution.run(promptSegmentV1, {
          turnId: "next",
          playerMessage: "Go",
        });
      }),
    ).resolves.toEqual([]);
  });
});
