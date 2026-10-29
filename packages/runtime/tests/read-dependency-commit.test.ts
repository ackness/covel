/**
 * Read dependencies at commit.
 *
 * A runtime that read another runtime's uncommitted plugin data stands on
 * that write. When the producer is dropped at commit, an auxiliary reader is
 * dropped with it, and the drop cascades through hard dependents and readers
 * of readers. A story or setup unit never drops for what it read: it
 * commits, and one `read-dependency.kept` trace row says what it stood on.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { createPluginDataTools } from "@covel/tools";
import type {
  DeferredRuntimeJob,
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
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
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

const BACKENDS = [
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const;

const open: DataStore[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close()));
});

interface RunOptions {
  readonly create?: () => DataStore;
  /** Rows the store holds before the execution starts. */
  readonly stored?: readonly {
    readonly namespace: string;
    readonly key: string;
    readonly value: JsonValue;
  }[];
  /** Runs between the execution and its commit, like a concurrent commit. */
  readonly beforeCommit?: (store: DataStore) => Promise<void>;
  /** Wire the builtin plugin-data tools into `ctx.tools`. */
  readonly tools?: boolean;
}

async function storeRow(
  store: DataStore,
  row: { namespace: string; key: string; value: JsonValue },
  timestamp: string,
) {
  await store.setPluginData({
    id: `${SESSION}:${PLUGIN}:${row.namespace}:${row.key}`,
    sessionId: SESSION,
    pluginId: PLUGIN,
    namespace: row.namespace,
    key: row.key,
    value: row.value,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function run(
  runtimes: readonly RuntimeManifest[],
  handlers: Record<string, FunctionHandler>,
  proposalGuard?: (proposal: Proposal) => string | undefined,
  options: RunOptions = {},
) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = (options.create ?? createMemoryStore)();
  open.push(store);
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
  for (const row of options.stored ?? []) await storeRow(store, row, timestamp);
  const tools = createPluginDataTools(store);
  const execution = await executeTurn(input, runtimes, {
    store,
    llm: { generate: vi.fn() } as never,
    ...(options.tools
      ? {
          toolExecutor: createToolExecutor({
            store,
            findTool: (name) => tools.find((tool) => tool.name === name),
            getToolSource: () => "builtin",
          }),
        }
      : {}),
    loadRuntime: async (runtime) => ({
      manifest: runtime,
      promptTemplate: "",
      handler: handlers[runtime.name],
    }),
  });
  await options.beforeCommit?.(store);
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
  const readersOf = () => execution.commit.readDependencies ?? {};
  const kept = async () =>
    (
      await store.queryTraceEvents(SESSION, {
        types: ["read-dependency.kept"],
      })
    ).map((event) => event.payload);
  return { store, execution, outcome, notes, runOf, kept, readersOf };
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
    const other = fn("other");
    const detached = (id: string, upstream: string) =>
      fn(id, {
        needs: [upstream],
        turnCompletion: { mode: "detached" },
        effects: { writes: ["plugin-data:self:notes"] },
      } as Partial<RuntimeManifest>);
    const needsB = detached("needs-b", b.name);
    const needsOther = detached("needs-other", other.name);
    const { store, execution, outcome } = await run(
      [story, a, b, other, asker, needsB, needsOther],
      {
        [story.name]: tell,
        [a.name]: async (ctx) => {
          await write(ctx, "a");
          return ok();
        },
        [b.name]: readThenWrite("a", "b"),
        [other.name]: async (ctx) => {
          await write(ctx, "other");
          return ok();
        },
        [asker.name]: async () => ({
          outcome: "suspended",
          reason: "Need an answer",
          resumeSchema: { type: "object" },
        }),
        [needsB.name]: async () => ok(),
        [needsOther.name]: async () => ok(),
      },
      refuse("a"),
    );

    const jobsOf = (
      continuation: { readonly withheldRuntimeJobs?: unknown } | undefined,
    ) =>
      (
        (continuation?.withheldRuntimeJobs ??
          []) as readonly DeferredRuntimeJob[]
      ).map((job) => job.runtimeId);
    // Before the commit, the continuation holds back both jobs.
    expect(execution.commit.suspensions).toHaveLength(1);
    expect(
      jobsOf(execution.commit.suspensions?.[0]?.pendingContinuation).sort(),
    ).toEqual([needsB.name, needsOther.name].sort());

    expect(outcome.isolatedRuntimes?.map((item) => item.runtimeId)).toEqual([
      a.name,
      b.name,
    ]);
    const saved = await store.listSuspensions(SESSION);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.runtimeId).toBe(asker.name);
    // The job on the dropped reader is gone; the unrelated one stays.
    expect(jobsOf(saved[0]!.pendingContinuation)).toEqual([needsOther.name]);
  });
});

describe("read dependencies of lists", () => {
  const a = fn("a", { stage: "pre-turn" });
  const o = fn("o", { stage: "pre-turn" });
  // Lists only: these readers never get a key.
  const listsNotes = fn("lists-notes");
  const listsElsewhere = fn("lists-elsewhere");
  const listsAll = fn("lists-all", {
    tools: { builtin: ["plugin-data-list"] },
  });
  const outsider = fn("outsider", { stage: "pre-turn" }, "outsider");

  const listThenWrite =
    (namespace: string, key: string): FunctionHandler =>
    async (ctx) => {
      await ctx.pluginData!.list(namespace);
      await write(ctx, key);
      return ok();
    };

  /** Isolated runs by runtime; siblings of one level finish in any order. */
  const byRuntime = (
    items: readonly { runtimeId: string }[] | undefined,
  ): readonly { runtimeId: string }[] =>
    [...(items ?? [])].sort((x, y) => x.runtimeId.localeCompare(y.runtimeId));

  async function lists(refused: string) {
    return run(
      [story, a, o, outsider, listsNotes, listsElsewhere, listsAll],
      {
        [story.name]: tell,
        [a.name]: async (ctx) => {
          await write(ctx, "a");
          return ok();
        },
        [o.name]: async (ctx) => {
          await ctx.pluginData!.set("elsewhere", "o", "o");
          return ok();
        },
        [outsider.name]: async (ctx) => {
          await write(ctx, "outsider");
          return ok();
        },
        [listsNotes.name]: listThenWrite("notes", "lists-notes"),
        [listsElsewhere.name]: listThenWrite("elsewhere", "lists-elsewhere"),
        [listsAll.name]: async (ctx) => {
          // The builtin list without a namespace.
          await ctx.tools!.call("plugin-data-list", {});
          await write(ctx, "lists-all");
          return ok();
        },
      },
      refuse(refused),
      { tools: true },
    );
  }

  it("records the producers of the listed namespace, or of all plugin data", async () => {
    const { readersOf, runOf } = await lists("never");

    const edges = Object.fromEntries(
      Object.entries(readersOf()).map(([reader, producers]) => [
        reader,
        [...producers].sort(),
      ]),
    );
    // The other plugin's producer is in no reader's set.
    expect(edges).toEqual({
      [runOf(listsNotes.name)]: [runOf(a.name)],
      [runOf(listsElsewhere.name)]: [runOf(o.name)],
      [runOf(listsAll.name)]: [runOf(a.name), runOf(o.name)].sort(),
    });
  });

  it("drops a namespace's readers and every unscoped reader with its producer", async () => {
    const { outcome, notes, runOf } = await lists("a");

    expect(outcome.status).toBe("committed");
    expect(byRuntime(outcome.isolatedRuntimes)).toEqual(
      [
        { runtimeId: a.name, runId: runOf(a.name), error: "a refused" },
        {
          runtimeId: listsNotes.name,
          runId: runOf(listsNotes.name),
          error: `read data of ${a.name} that did not commit`,
        },
        {
          runtimeId: listsAll.name,
          runId: runOf(listsAll.name),
          error: `read data of ${a.name} that did not commit`,
        },
      ].sort((x, y) => x.runtimeId.localeCompare(y.runtimeId)),
    );
    // The reader of another namespace commits.
    expect(await notes()).toEqual({ "lists-elsewhere": "lists-elsewhere" });
  });

  it("leaves a namespace's readers alone when another namespace's producer drops", async () => {
    const { outcome, notes } = await lists("o");

    expect(
      Object.fromEntries(
        (outcome.isolatedRuntimes ?? []).map((item) => [
          item.runtimeId,
          item.error,
        ]),
      ),
    ).toEqual({
      [o.name]: "o refused",
      [listsElsewhere.name]: `read data of ${o.name} that did not commit`,
      [listsAll.name]: `read data of ${o.name} that did not commit`,
    });
    expect(await notes()).toEqual({ a: "a", "lists-notes": "lists-notes" });
  });
});

for (const [backend, create] of BACKENDS) {
  describe(`an operation list refused at commit: ${backend}`, () => {
    const a = fn("a", { stage: "pre-turn" });
    const b = fn("b");
    const narrate = fn("story", { stage: "narrative", outputKind: "story" });

    it("rolls the producer back whole, drops its reader and keeps the story", async () => {
      const { outcome, notes, runOf, store } = await run(
        [narrate, a, b],
        {
          [narrate.name]: async (ctx) => {
            await write(ctx, "told");
            return ok({ narrativeOutput: "The story goes on." });
          },
          [a.name]: async (ctx) => {
            // Readable data first, then an operation list that passes the
            // early check against 5 gold.
            await write(ctx, "a", "ready");
            await ctx.pluginData!.update("notes", "gold", [
              { op: "inc", by: -5, min: 0 },
            ]);
            return ok();
          },
          [b.name]: async (ctx) => {
            const seen = await ctx.pluginData!.get("notes", "a");
            await write(ctx, "b", String(seen));
            return ok();
          },
        },
        undefined,
        {
          create,
          stored: [{ namespace: "notes", key: "gold", value: 5 }],
          // A concurrent commit spends gold, so the list goes out of bounds.
          beforeCommit: (store) =>
            storeRow(
              store,
              { namespace: "notes", key: "gold", value: 3 },
              "2026-10-29T00:00:01.000Z",
            ),
        },
      );

      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes).toEqual([
        {
          runtimeId: a.name,
          runId: runOf(a.name),
          error: expect.stringMatching(
            /^plugin\.data\.update: .*\(op 0, out-of-bounds\)$/,
          ),
        },
        {
          runtimeId: b.name,
          runId: runOf(b.name),
          error: `read data of ${a.name} that did not commit`,
        },
      ]);
      // Neither a's readable write nor b's write survives; the story's does.
      expect(await notes()).toEqual({ gold: 3, told: "told" });
      expect(
        (await store.listMessages(SESSION)).map((message) => message.content),
      ).toContain("The story goes on.");
    });
  });
}

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
