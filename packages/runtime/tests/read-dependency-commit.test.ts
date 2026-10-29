/**
 * Read dependencies at commit.
 *
 * A runtime that read another runtime's uncommitted plugin data stands on
 * that write. When the producer is dropped at commit, an auxiliary reader is
 * dropped with it, and the drop cascades through hard dependents and readers
 * of readers. A story or setup unit never drops for what it read: it
 * commits, and one `read-dependency.kept` trace row says what it stood on.
 */

import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  HandlerResult,
  JsonValue,
  Proposal,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type {
  FunctionHandler,
  FunctionHandlerContext,
} from "@covel/shared/plugin-runtime";
import { commitExecution, executeTurn } from "../src/index.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";

const SESSION = "session";
const PLUGIN = "probe";
const input = {
  sessionId: SESSION,
  turnId: "turn",
  logicalTurnId: "logical-turn",
  playerMessage: "Continue",
  origin: "player" as const,
};

function fn(
  id: string,
  extra: Partial<RuntimeManifest> = {},
  pluginId = PLUGIN,
): RuntimeManifest {
  return {
    name: `${pluginId}/${id}`,
    pluginId,
    description: id,
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
    ...extra,
  } as RuntimeManifest;
}

const ok = (value: Record<string, JsonValue> = {}): HandlerResult => ({
  outcome: "success",
  value,
});

const story = fn(
  "story",
  { stage: "narrative", outputKind: "story" },
  "narrator",
);
const tell: FunctionHandler = async () =>
  ok({ narrativeOutput: "The story goes on." });

async function write(ctx: FunctionHandlerContext, key: string, value = key) {
  await ctx.pluginData!.set("notes", key, value);
}

/** Read `from`, then write `key`: a write that stands on what it read. */
const readThenWrite =
  (from: string, key: string): FunctionHandler =>
  async (ctx) => {
    await ctx.pluginData!.get("notes", from);
    await write(ctx, key);
    return ok();
  };

/** The commit refuses plugin-data writes of the listed keys. */
const refuse =
  (...keys: string[]) =>
  (proposal: Proposal) => {
    const key = (proposal.payload as { key?: unknown }).key;
    return typeof key === "string" && keys.includes(key)
      ? `${key} refused`
      : undefined;
  };

async function run(
  runtimes: readonly RuntimeManifest[],
  handlers: Record<string, FunctionHandler>,
  proposalGuard?: (proposal: Proposal) => string | undefined,
) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = createMemoryStore();
  const timestamp = "2026-10-29T00:00:00.000Z";
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: [...new Set(runtimes.map((runtime) => runtime.pluginId))],
    completedPlayerTurns: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const execution = await executeTurn(input, runtimes, {
    store,
    llm: { generate: vi.fn() } as never,
    loadRuntime: async (runtime) => ({
      manifest: runtime,
      promptTemplate: "",
      handler: handlers[runtime.name],
    }),
  });
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    ...(proposalGuard ? { proposalGuard } : {}),
  });
  const notes = async (pluginId = PLUGIN) =>
    Object.fromEntries(
      (await store.listPluginData(SESSION, pluginId, "notes")).map((row) => [
        row.key,
        row.value,
      ]),
    );
  const runOf = (runtimeId: string) =>
    execution.commit.results.find((result) => result.runtimeId === runtimeId)!
      .runId;
  const kept = async () =>
    (
      await store.queryTraceEvents(SESSION, {
        types: ["read-dependency.kept"],
      })
    ).map((event) => event.payload);
  return { store, execution, outcome, notes, runOf, kept };
}

describe("read dependencies at commit", () => {
  const a = fn("a", { stage: "pre-turn" });
  const b = fn("b");

  it("drops an auxiliary reader with the producer it read", async () => {
    const { outcome, notes, runOf } = await run(
      [story, a, b],
      {
        [story.name]: tell,
        [a.name]: async (ctx) => {
          await write(ctx, "a");
          return ok();
        },
        [b.name]: readThenWrite("a", "b"),
      },
      refuse("a"),
    );

    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes).toEqual([
      { runtimeId: a.name, runId: runOf(a.name), error: "a refused" },
      {
        runtimeId: b.name,
        runId: runOf(b.name),
        error: `read data of ${a.name} that did not commit`,
      },
    ]);
    expect(await notes()).toEqual({});
  });

  it("settles the reader's persisted result as failed", async () => {
    const { store, runOf } = await run(
      [story, a, b],
      {
        [story.name]: tell,
        [a.name]: async (ctx) => {
          await write(ctx, "a");
          return ok();
        },
        [b.name]: readThenWrite("a", "b"),
      },
      refuse("a"),
    );

    const persisted = (await store.listTurnResults(SESSION)).flatMap(
      (row) => row.runtimeResults as RuntimeResult[],
    );
    expect(persisted.find((r) => r.runId === runOf(b.name))).toMatchObject({
      status: "failed",
      error: `read data of ${a.name} that did not commit`,
    });
  });

  it("cascades to hard dependents and to readers of readers", async () => {
    const c = fn("c", { needs: [b.name] });
    const d = fn("d", { after: [b.name] });
    const unrelated = fn("unrelated", { after: [b.name] });
    const { outcome, notes } = await run(
      [story, a, b, c, d, unrelated],
      {
        [story.name]: tell,
        [a.name]: async (ctx) => {
          await write(ctx, "a");
          return ok();
        },
        [b.name]: readThenWrite("a", "b"),
        [c.name]: async (ctx) => {
          await write(ctx, "c");
          return ok();
        },
        [d.name]: readThenWrite("b", "d"),
        [unrelated.name]: readThenWrite("nothing", "unrelated"),
      },
      refuse("a"),
    );

    expect(outcome.status).toBe("committed");
    expect(
      Object.fromEntries(
        (outcome.isolatedRuntimes ?? []).map((item) => [
          item.runtimeId,
          item.error,
        ]),
      ),
    ).toEqual({
      [a.name]: "a refused",
      [b.name]: `read data of ${a.name} that did not commit`,
      [c.name]: `upstream ${b.name} did not commit`,
      [d.name]: `read data of ${b.name} that did not commit`,
    });
    expect(await notes()).toEqual({ unrelated: "unrelated" });
  });

  it("keeps a reader that overwrote the key before it read it", async () => {
    const { outcome, notes } = await run(
      [story, a, b],
      {
        [story.name]: tell,
        [a.name]: async (ctx) => {
          await write(ctx, "a");
          return ok();
        },
        [b.name]: async (ctx) => {
          await ctx.pluginData!.set("notes", "a", "b's own");
          await ctx.pluginData!.get("notes", "a");
          return ok();
        },
      },
      refuse("a-never"),
    );

    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes).toBeUndefined();
    expect(await notes()).toEqual({ a: "b's own" });
  });

  it("keeps an overwriting reader when its producer is dropped", async () => {
    const { outcome, notes, runOf } = await run(
      [story, a, b],
      {
        [story.name]: tell,
        [a.name]: async (ctx) => {
          await write(ctx, "a");
          await write(ctx, "a-refused");
          return ok();
        },
        [b.name]: async (ctx) => {
          await ctx.pluginData!.set("notes", "a", "b's own");
          await ctx.pluginData!.get("notes", "a");
          return ok();
        },
      },
      refuse("a-refused"),
    );

    expect(outcome.isolatedRuntimes).toEqual([
      { runtimeId: a.name, runId: runOf(a.name), error: "a-refused refused" },
    ]);
    expect(await notes()).toEqual({ a: "b's own" });
  });

  it("commits a story that read a dropped producer and traces it once", async () => {
    const prelude = fn("prelude", { stage: "pre-turn" }, "narrator");
    const { outcome, notes, runOf, kept } = await run(
      [story, prelude],
      {
        [prelude.name]: async (ctx) => {
          await write(ctx, "mood", "grim");
          return ok();
        },
        [story.name]: async (ctx) => {
          const mood = await ctx.pluginData!.get("notes", "mood");
          // Read twice: still one row per producer.
          await ctx.pluginData!.list("notes");
          await write(ctx, "told", String(mood));
          return ok({ narrativeOutput: `A ${String(mood)} night.` });
        },
      },
      refuse("mood"),
    );

    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes).toEqual([
      {
        runtimeId: prelude.name,
        runId: runOf(prelude.name),
        error: "mood refused",
      },
    ]);
    expect(await notes("narrator")).toEqual({ told: "grim" });
    expect(await kept()).toEqual([
      {
        runtimeId: story.name,
        runId: runOf(story.name),
        producerRuntimeId: prelude.name,
        producerRunId: runOf(prelude.name),
        reason: `read data of ${prelude.name} that did not commit`,
      },
    ]);
  });

  it("rolls the whole execution back without a story, as before", async () => {
    const { outcome, notes, kept } = await run(
      [a, b],
      {
        [a.name]: async (ctx) => {
          await write(ctx, "a");
          return ok();
        },
        [b.name]: readThenWrite("a", "b"),
      },
      refuse("a"),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.isolatedRuntimes).toBeUndefined();
    expect(await notes()).toEqual({});
    expect(await kept()).toEqual([]);
  });

  it("drops the jobs a surviving continuation holds back on a dropped reader", async () => {
    const asker = fn("asker");
    const needsB = fn("needs-b", {
      needs: [b.name],
      turnCompletion: { mode: "detached" },
      effects: { writes: ["plugin-data:self:notes"] },
    } as Partial<RuntimeManifest>);
    const { store, outcome } = await run(
      [story, a, b, asker, needsB],
      {
        [story.name]: tell,
        [a.name]: async (ctx) => {
          await write(ctx, "a");
          return ok();
        },
        [b.name]: readThenWrite("a", "b"),
        [asker.name]: async () => ({
          outcome: "suspended",
          reason: "Need an answer",
          resumeSchema: { type: "object" },
        }),
        [needsB.name]: async () => ok(),
      },
      refuse("a"),
    );

    expect(outcome.isolatedRuntimes?.map((item) => item.runtimeId)).toEqual([
      a.name,
      b.name,
    ]);
    const [saved] = await store.listSuspensions(SESSION);
    expect(saved?.pendingContinuation.withheldRuntimeJobs ?? []).toEqual([]);
  });
});

describe("finalizeExecution read dependencies", () => {
  const TURN = "turn";
  function result(
    runtime: RuntimeManifest,
    key: string | undefined,
    output: Record<string, unknown> = {},
  ): RuntimeResult {
    return {
      pluginId: runtime.pluginId,
      runtimeId: runtime.name,
      runId: `${runtime.name}-run`,
      turnId: TURN,
      status: "success",
      output,
      ...(key
        ? {
            effects: {
              pluginData: [{ namespace: "notes", key, value: key }],
            },
          }
        : {}),
      toolCalls: [],
      durationMs: 1,
      timestamp: "2026-10-29T00:00:00.000Z",
    };
  }

  async function finalize(
    runtimes: readonly RuntimeManifest[],
    results: readonly RuntimeResult[],
    readDependencies: Record<string, string[]>,
    proposalGuard?: (proposal: Proposal) => string | undefined,
    commitUnits?: readonly number[],
  ) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemoryStore();
    const outcome = await finalizeExecution({
      store,
      sessionId: SESSION,
      executionContext: {
        executionId: "execution",
        origin: "player",
        countPolicy: "none",
      },
      runtimes,
      results,
      ...(commitUnits ? { commitUnits } : {}),
      turnIds: [],
      readDependencies,
      ...(proposalGuard ? { proposalGuard } : {}),
    });
    const kept = (
      await store.queryTraceEvents(SESSION, {
        types: ["read-dependency.kept"],
      })
    ).map((event) => event.payload);
    return { outcome, kept, warn, store };
  }

  const narrator = fn("story", { stage: "narrative", outputKind: "story" });
  const storyResult = result(narrator, undefined, {
    narrativeOutput: "The story goes on.",
  });

  it("commits a setup unit that read a dropped producer and traces it", async () => {
    const producer = fn("producer");
    const setup = fn("setup", { stage: "setup" });
    const { outcome, kept } = await finalize(
      [narrator, producer, setup],
      [storyResult, result(producer, "p"), result(setup, "s")],
      { [`${setup.name}-run`]: [`${producer.name}-run`] },
      refuse("p"),
    );

    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes?.map((item) => item.runtimeId)).toEqual([
      producer.name,
    ]);
    expect(kept).toEqual([
      {
        runtimeId: setup.name,
        runId: `${setup.name}-run`,
        producerRuntimeId: producer.name,
        producerRunId: `${producer.name}-run`,
        reason: `read data of ${producer.name} that did not commit`,
      },
    ]);
  });

  it("ignores an edge inside one unit", async () => {
    const child = fn("child");
    const parent = fn("parent");
    const { outcome, kept, warn } = await finalize(
      [narrator, child, parent],
      [storyResult, result(child, "c"), result(parent, "p")],
      { [`${parent.name}-run`]: [`${child.name}-run`] },
      undefined,
      [1, 2],
    );

    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes).toBeUndefined();
    expect(kept).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns about and ignores a producer that commits after its reader", async () => {
    const early = fn("early");
    const late = fn("late");
    const { outcome, warn } = await finalize(
      [narrator, early, late],
      [storyResult, result(early, "e"), result(late, "l")],
      { [`${early.name}-run`]: [`${late.name}-run`] },
      refuse("l"),
    );

    expect(outcome.isolatedRuntimes?.map((item) => item.runtimeId)).toEqual([
      late.name,
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("which commits after it"),
    );
  });

  it("ignores producer ids that name no run of the execution", async () => {
    const reader = fn("reader");
    const { outcome } = await finalize(
      [narrator, reader],
      [storyResult, result(reader, "r")],
      { [`${reader.name}-run`]: ["not-a-run"] },
    );

    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes).toBeUndefined();
  });
});
