import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import {
  createMemoryStore,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "@covel/store";
import {
  executeTurn,
  finalizeExecution,
  createToolExecutor,
  createFunctionStoreView,
} from "@covel/runtime";
import { tool, getPendingProposals } from "@covel/tools";
import createAdvance from "../tools/advance-world-time.js";
import { DEFAULT_TIME, initialTick, loadTime } from "../clock.js";

const now = "2026-09-18T00:00:00Z";
async function fixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: "s",
    locale: "en",
    worldId: "world",
    presetId: "default",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    completedPlayerTurns: 0,
    activePlugins: ["world-time", "story"],
    createdAt: now,
    updatedAt: now,
  });
  const discovery = (
    await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
  ).find((entry) => entry.id === "world-time");
  const manifests = (await loadPluginManifest(discovery)).map(
    (entry) => entry.manifest,
  );
  const loaded = new Map(
    await Promise.all(
      manifests.map(async (manifest) => [
        manifest.name,
        await loadRuntime(discovery, manifest.name),
      ]),
    ),
  );
  const story = {
    name: "story",
    pluginId: "story",
    stage: "narrative",
    runtimeType: "function",
    outputKind: "story",
    capabilities: ["narrative-engine"],
    trigger: { type: "auto" },
    inputs: {
      worldTime: {
        from: { capability: "world-time-context", cardinality: "one" },
        required: true,
      },
    },
  };
  const storyHandler = vi.fn(async (ctx) => ({
    outcome: "success",
    value: {
      narrativeOutput: `At ${ctx.inputs.worldTime.value.display}, they walk for one hour.`,
    },
  }));
  loaded.set("story", {
    manifest: story,
    handler: storyHandler,
    promptTemplate: "",
  });
  const advance = createAdvance({ tool });
  const generate = vi.fn(async () => ({
    content: null,
    toolCalls: [
      {
        id: "advance",
        name: advance.name,
        arguments: JSON.stringify({
          amount: 1,
          unit: "hour",
          reason: "An hour-long walk.",
        }),
      },
    ],
    finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const runtimes = [...manifests, story];
  const run = (turnId = "turn", options) =>
    executeTurn(
      {
        sessionId: "s",
        turnId,
        origin: "player",
        playerMessage: "Walk.",
        locale: "en",
      },
      runtimes,
      {
        store,
        llm: { generate },
        getPluginSource: () => "builtin",
        loadRuntime: async (manifest) => loaded.get(manifest.name),
        toolExecutor: createToolExecutor({
          store,
          findTool: (name) => (name === advance.name ? advance : undefined),
        }),
      },
      options,
    );
  const commit = (result, extraInTx) =>
    finalizeExecution({
      store,
      sessionId: "s",
      runtimes,
      results: result.runtimeResults,
      turnIds: [],
      executionContext: {
        executionId: "e",
        origin: "player",
        countPolicy: "none",
      },
      extraInTx,
    });
  return { store, run, commit, storyHandler, generate, advance };
}

describe("world-time pipeline", () => {
  it("discovers the core plugin, binds the current time before narration, and commits after narration", async () => {
    const { store, run, commit, storyHandler, generate } = await fixture();
    const result = await run();
    expect(
      result.runtimeResults.map((item) => [item.runtimeId, item.status]),
    ).toEqual([
      ["world-time/context", "success"],
      ["story", "success"],
      ["world-time/advance", "success"],
    ]);
    expect(storyHandler.mock.calls[0][0].inputs.worldTime.value.tick).toBe(
      initialTick(DEFAULT_TIME),
    );
    expect(generate).toHaveBeenCalledOnce();
    expect(
      await store.getPluginData("s", "world-time", "clock", "current"),
    ).toBeNull();
    expect((await commit(result)).status).toBe("committed");
    const value = (
      await store.getPluginData("s", "world-time", "clock", "current")
    ).value;
    expect(value.tick).toBe(initialTick(DEFAULT_TIME) + 60);
    const checkpoint = await exportSessionCheckpoint(store, "s", {
      revision: 1,
      actionId: "checkpoint",
    });
    const restored = createMemoryStore();
    await replaceSessionFromCheckpoint(restored, checkpoint);
    expect((await loadTime(restored, "s", "world-time", "en")).tick).toBe(
      value.tick,
    );
    await commit(await run("next-turn"));
    expect((await loadTime(restored, "s", "world-time", "en")).tick).toBe(
      value.tick,
    );
    expect((await loadTime(store, "s", "world-time", "en")).tick).toBe(
      value.tick + 60,
    );
  });
  it("rolls back time when a sibling commit fails", async () => {
    const { store, run, commit } = await fixture();
    expect(
      (
        await commit(await run(), async () => {
          throw new Error("rollback");
        })
      ).status,
    ).toBe("failed");
    expect(
      await store.getPluginData("s", "world-time", "clock", "current"),
    ).toBeNull();
  });
  it("keeps recursive stories read-only until the outer turn settles time", async () => {
    const { store, run, commit, storyHandler, generate } = await fixture();
    const result = await run("nested-turn", { recursionDepth: 1 });
    expect(storyHandler).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(
      result.runtimeResults.find(
        (entry) => entry.runtimeId === "world-time/advance",
      ).status,
    ).toBe("skipped");
    expect((await commit(result)).status).toBe("committed");
    expect(
      await store.getPluginData("s", "world-time", "clock", "current"),
    ).toBeNull();
  });
  it("does not evolve time after a failed story", async () => {
    const { store, run, commit, storyHandler, generate } = await fixture();
    storyHandler.mockRejectedValueOnce(new Error("story failed"));
    const result = await run();
    expect(generate).not.toHaveBeenCalled();
    expect((await commit(result)).status).toBe("failed");
    expect(
      await store.getPluginData("s", "world-time", "clock", "current"),
    ).toBeNull();
  });
  it("rejects unbound manual advancement and deduplicates a buffered same-turn call", async () => {
    const { store, advance } = await fixture();
    const ctx = {
      sessionId: "s",
      turnId: "t",
      pluginId: "world-time",
      runtimeId: "world-time/advance",
    };
    await expect(advance.execute({ reason: "manual" }, ctx)).rejects.toThrow(
      /same-turn/,
    );
    ctx.inputSlots = {
      currentTime: {
        cardinality: "one",
        value: await loadTime(store, "s", "world-time", "en"),
      },
      narrative: { cardinality: "one", value: "A short conversation." },
    };
    ctx.store = createFunctionStoreView(store, ctx);
    const first = await advance.execute({ reason: "conversation" }, ctx);
    const pendingProposals = getPendingProposals(first);
    expect(pendingProposals).toHaveLength(1);
    const second = await advance.execute(
      { reason: "duplicate" },
      {
        ...ctx,
        pendingProposals,
        store: createFunctionStoreView(store, ctx, [...pendingProposals]),
      },
    );
    expect(getPendingProposals(second)).toHaveLength(0);
    expect(second.tick).toBe(initialTick(DEFAULT_TIME) + 10);
  });
});
