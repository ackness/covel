import { createMemoryStore } from "@covel/store/memory";
import {
  getToolContent,
  getPendingProposals,
  applyDataOps,
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "@covel/store";
import {
  executeTurn,
  commitExecution,
  createToolExecutor,
  createFunctionStoreView,
} from "@covel/runtime";

import { tool } from "@covel/tools";
import createAdvance from "../tools/advance-world-time.js";
import { DEFAULT_TIME, initialTick, loadTime, describeTime } from "../clock.js";

const now = "2026-09-18T00:00:00Z";
const clockReader = (store) =>
  createFunctionStoreView(store, {
    sessionId: "s",
    pluginId: "world-time",
    runtimeId: "world-time/context",
    turnId: "test",
  });
async function fixture({
  withReader = false,
  request = { amount: 1, unit: "hour", reason: "An hour-long walk." },
} = {}) {
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
    outputContract: "narrative-engine@1",
    trigger: { type: "auto" },
    inputs: {
      worldTime: {
        from: { capability: "world-time-context@1", cardinality: "one" },
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
  const advanceResults = [];
  const executeAdvance = advance.execute;
  advance.execute = async (params, ctx) => {
    const result = await executeAdvance(params, ctx);
    advanceResults.push(result);
    return result;
  };
  const generate = vi.fn(async () => ({
    content: null,
    toolCalls: [
      {
        id: "advance",
        name: advance.name,
        arguments: JSON.stringify(request),
      },
    ],
    finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  // A post-turn runtime of another plugin that reads the settled time.
  const readerHandler = vi.fn(async () => ({ outcome: "success", value: {} }));
  if (withReader)
    loaded.set("ledger", {
      manifest: {
        name: "ledger",
        pluginId: "ledger",
        stage: "post-turn",
        runtimeType: "function",
        outputKind: "system",
        trigger: { type: "auto" },
        inputs: {
          worldTime: {
            from: { capability: "world-time-evolution@1", cardinality: "one" },
            select: "/summary",
            required: false,
          },
        },
      },
      handler: readerHandler,
      promptTemplate: "",
    });
  const runtimes = [
    ...manifests.map((manifest) => loaded.get(manifest.name).manifest),
    story,
    ...(withReader ? [loaded.get("ledger").manifest] : []),
  ];
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
  const commit = (execution, extraInTx) =>
    commitExecution({
      store,
      execution,
      completion: {
        kind: "turn",
        turnId: execution.result.turnId,
        durationMs: 1,
      },
      extraInTx,
    });
  return {
    store,
    run,
    commit,
    storyHandler,
    readerHandler,
    generate,
    advance,
    loaded,
    advanceResults,
  };
}

describe("world-time pipeline", () => {
  it("discovers the core plugin, binds the current time before narration, and commits after narration", async () => {
    const { store, run, commit, storyHandler, generate, advanceResults } =
      await fixture();
    const result = await run();
    expect(
      result.result.runtimeResults.map((item) => [item.runtimeId, item.status]),
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
    expect((await loadTime(clockReader(restored), "en")).tick).toBe(value.tick);
    const later = await run("next-turn");
    const [update] = getPendingProposals(advanceResults.at(-1));
    expect(update.type).toBe("plugin.data.update");
    expect(update.payload.ops.map((op) => op.op)).toEqual(["inc", "merge"]);
    expect(update.payload.ops[0]).toEqual({ op: "inc", path: "/tick", by: 60 });
    expect(update.payload.ops[1].value).not.toHaveProperty("schemaVersion");
    const predicted = {
      ...value,
      tick: value.tick + 60,
      ...describeTime(value.definition, value.tick + 60, "en"),
      lastTurnId: "next-turn",
      lastDelta: 60,
      reason: "An hour-long walk.",
    };
    expect(applyDataOps({ exists: true, value }, update.payload.ops)).toEqual({
      ok: true,
      exists: true,
      value: predicted,
    });
    await commit(later);
    expect(
      (await store.getPluginData("s", "world-time", "clock", "current")).value,
    ).toEqual({ ...predicted, locale: "en", units: ["minute", "hour", "day"] });
    expect((await loadTime(clockReader(restored), "en")).tick).toBe(value.tick);
    expect((await loadTime(clockReader(store), "en")).tick).toBe(
      value.tick + 60,
    );
  });
  it("gives a same-stage reader this turn's settled time, not the time the turn started at", async () => {
    const { run, commit, readerHandler } = await fixture({ withReader: true });
    await commit(await run());
    expect(readerHandler.mock.calls[0][0].inputs.worldTime.value).toEqual({
      display: "World era 1 · Month 1 1 · 09:00 · Morning",
      unit: "minute",
      elapsedSinceStart: 60,
      elapsedThisTurn: 60,
    });
    await commit(await run("next-turn"));
    expect(readerHandler.mock.calls[1][0].inputs.worldTime.value).toMatchObject(
      { elapsedSinceStart: 120, elapsedThisTurn: 60 },
    );
  });

  it("runs the reader without the time when the time was not settled", async () => {
    const { run, readerHandler, generate } = await fixture({
      withReader: true,
    });
    generate.mockRejectedValue(new Error("model unavailable"));
    const result = await run();
    expect(
      result.result.runtimeResults.find(
        (item) => item.runtimeId === "world-time/advance",
      ).status,
    ).toBe("failed");
    expect(readerHandler).toHaveBeenCalledOnce();
    expect(readerHandler.mock.calls[0][0].inputs?.worldTime).toBeUndefined();
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
      result.result.runtimeResults.find(
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
        value: await loadTime(clockReader(store), "en"),
      },
      narrative: { cardinality: "one", value: "A short conversation." },
    };
    ctx.store = createFunctionStoreView(store, ctx);
    const first = await advance.execute({ reason: "conversation" }, ctx);
    const pendingProposals = getPendingProposals(first);
    expect(pendingProposals).toHaveLength(1);
    expect(pendingProposals[0].type).toBe("plugin.data");
    const { summary: _summary, ...expected } = getToolContent(first);
    expect(pendingProposals[0].payload.value).toEqual(expected);
    const second = await advance.execute(
      { reason: "duplicate" },
      {
        ...ctx,
        pendingProposals,
        store: createFunctionStoreView(store, ctx, [...pendingProposals]),
      },
    );
    expect(getPendingProposals(second)).toHaveLength(0);
    expect(getToolContent(second).tick).toBe(initialTick(DEFAULT_TIME) + 10);
  });
  it("loads the permissive clock dataset for both real runtimes", async () => {
    const { loaded } = await fixture();
    for (const id of ["world-time/context", "world-time/advance"]) {
      const runtime = loaded.get(id);
      expect(runtime.manifest.datasets.clock).toEqual({
        namespace: "clock",
        schema: "./schemas/clock.schema.json",
        ops: ["set", "merge", "inc"],
      });
      expect(runtime.datasetSchemas.clock).toMatchObject({
        required: ["schemaVersion", "definition", "tick"],
        additionalProperties: true,
      });
    }
  });

  it("advances on top of a pending context set before either write commits", async () => {
    const { store, advance, run, commit } = await fixture();
    const ctx = {
      sessionId: "s",
      turnId: "buffered",
      pluginId: "world-time",
      runtimeId: "world-time/advance",
    };
    const base = await loadTime(clockReader(store), "en");
    const init = makeProposal(
      { ...ctx, runtimeId: "world-time/context" },
      now,
      "plugin.data",
      {
        namespace: "clock",
        key: "current",
        value: {
          schemaVersion: 1,
          definition: base.definition,
          tick: base.tick,
          ...describeTime(base.definition, base.tick, "en"),
        },
      },
    );
    const result = await advance.execute(
      { amount: 1, unit: "hour", reason: "Walked" },
      {
        ...ctx,
        inputSlots: {
          currentTime: { value: base },
          narrative: { value: "They walk for an hour." },
        },
        store: createFunctionStoreView(store, ctx, [init]),
      },
    );
    const [update] = getPendingProposals(result);
    expect(update.type).toBe("plugin.data.update");
    const { summary: _summary, ...expected } = getToolContent(result);
    expect(
      applyDataOps(
        { exists: true, value: init.payload.value },
        update.payload.ops,
      ),
    ).toEqual({ ok: true, exists: true, value: expected });
    // Use the real context handler's initialization and the buffered tool's
    // update in one pipeline execution, in that order.
    const original = advance.execute;
    advance.execute = async () => result;
    const execution = await run("buffered");
    advance.execute = original;
    expect(execution.result.runtimeResults[0].status).toBe("success");
    expect((await commit(execution)).status).toBe("committed");
    expect(
      (await store.getPluginData("s", "world-time", "clock", "current")).value,
    ).toEqual({ ...expected, locale: "en", units: ["minute", "hour", "day"] });
  });

  it.each([
    [0, "forward", 0],
    [1, "backward", -60],
  ])(
    "commits amount %i in direction %s as inc by %i",
    async (amount, direction, delta) => {
      const { store, run, commit, advanceResults, advance } = await fixture({
        request: { amount, unit: "hour", direction, reason: "Time shifts." },
      });
      const definition = {
        ...DEFAULT_TIME,
        evolution: { ...DEFAULT_TIME.evolution, mode: "bidirectional" },
      };
      const base = {
        schemaVersion: 1,
        definition,
        tick: initialTick(definition),
        ...describeTime(definition, initialTick(definition), "en"),
        extra: "preserved",
      };
      await store.setPluginData({
        id: "clock",
        sessionId: "s",
        pluginId: "world-time",
        namespace: "clock",
        key: "current",
        value: base,
        createdAt: now,
        updatedAt: now,
      });
      const execution = await run();
      const [update] = getPendingProposals(advanceResults.at(-1));
      expect(update.payload.ops[0]).toEqual({
        op: "inc",
        path: "/tick",
        by: delta,
      });
      expect((await commit(execution)).status).toBe("committed");
      const value = (
        await store.getPluginData("s", "world-time", "clock", "current")
      ).value;
      expect(value).toEqual({
        ...base,
        locale: "en",
        units: ["minute", "hour", "day"],
        tick: base.tick + delta,
        ...describeTime(definition, base.tick + delta, "en"),
        lastTurnId: "turn",
        lastDelta: delta,
        reason: "Time shifts.",
      });
      const replay = await advance.execute(
        { amount, unit: "hour", direction, reason: "Replay" },
        {
          sessionId: "s",
          turnId: "turn",
          pluginId: "world-time",
          runtimeId: "world-time/advance",
          inputSlots: {
            currentTime: { value: { ...base, locale: "en" } },
            narrative: { value: "Time shifts." },
          },
          store: clockReader(store),
        },
      );
      expect(getPendingProposals(replay)).toEqual([]);
      expect(getToolContent(replay).tick).toBe(value.tick);
    },
  );

  it("rejects an advance when the clock changed since narration started", async () => {
    const { store, advance } = await fixture();
    const base = await loadTime(clockReader(store), "en");
    await expect(
      advance.execute(
        { reason: "Walked" },
        {
          sessionId: "s",
          turnId: "changed",
          pluginId: "world-time",
          runtimeId: "world-time/advance",
          inputSlots: {
            currentTime: { value: base },
            narrative: { value: "Walked." },
          },
          store: {
            getPluginData: async () => ({ value: { tick: base.tick + 1 } }),
          },
        },
      ),
    ).rejects.toThrow("World time changed since this narrative started");
  });

  it("refuses a clock without tick as a dataset violation and keeps the story", async () => {
    const { store, run, commit, advance } = await fixture();
    const original = advance.execute;
    advance.execute = async (params, ctx) => {
      const result = await original(params, ctx);
      return withPendingProposals(getToolContent(result), [
        makeProposal(ctx, now, "plugin.data", {
          namespace: "clock",
          key: "current",
          value: { schemaVersion: 1, definition: DEFAULT_TIME },
        }),
      ]);
    };
    const execution = await run();
    const outcome = await commit(execution);
    expect(outcome.status).toBe("committed");
    expect(outcome.failedProposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "dataset-violation" }),
      ]),
    );
    expect(outcome.isolatedRuntimes.map((entry) => entry.runtimeId)).toEqual([
      "world-time/advance",
    ]);
    expect(
      (await store.getPluginData("s", "world-time", "clock", "current")).value
        .tick,
    ).toBe(initialTick(DEFAULT_TIME));
    expect(
      execution.result.runtimeResults.find(
        (entry) => entry.runtimeId === "story",
      ).status,
    ).toBe("success");
  });
});
