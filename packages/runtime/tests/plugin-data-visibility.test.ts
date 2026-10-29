/**
 * In-execution visibility of a plugin's own uncommitted plugin data.
 *
 * A runtime's plugin-data reads (`ctx.pluginData`, `ctx.store`, tool store
 * reads and the builtin `plugin-data-get/list`) include the writes of
 * completed, commit-eligible upstream runtimes of the same plugin, applied in
 * commit order. Other plugins, siblings of the same DAG level, seeds from
 * another execution and failed results stay invisible, and upstream writes
 * never enter the reader's own buffer, so nothing commits twice.
 */

import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  HandlerResult,
  JsonValue,
  LLMAdapter,
  LLMResponse,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import type {
  FunctionHandler,
  FunctionHandlerContext,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import { createPluginDataTools } from "@covel/tools";
import { commitExecution, executeTurn } from "../src/index.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import type { PluginDataReadObservation } from "../src/function-runtime/upstream-plugin-data.js";
import { collectUpstreamPluginDataWrites } from "../src/function-runtime/upstream-plugin-data.js";

const SESSION = "session";
const PLUGIN = "probe";
const baseInput: TurnInput = {
  sessionId: SESSION,
  turnId: "turn",
  logicalTurnId: "logical-turn",
  playerMessage: "Continue",
  origin: "player",
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

interface RunOptions {
  readonly stored?: readonly {
    readonly namespace: string;
    readonly key: string;
    readonly value: JsonValue;
    readonly pluginId?: string;
  }[];
  readonly input?: Partial<TurnInput>;
  readonly guards?: Record<string, LoadedRuntime["guard"]>;
  readonly llm?: LLMAdapter;
  readonly probe?: (read: PluginDataReadObservation) => void;
  readonly tools?: boolean;
}

async function run(
  runtimes: readonly RuntimeManifest[],
  handlers: Record<string, FunctionHandler>,
  options: RunOptions = {},
) {
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
  for (const row of options.stored ?? []) {
    const pluginId = row.pluginId ?? PLUGIN;
    await store.setPluginData({
      id: `${SESSION}:${pluginId}:${row.namespace}:${row.key}`,
      sessionId: SESSION,
      pluginId,
      namespace: row.namespace,
      key: row.key,
      value: row.value,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  const tools = createPluginDataTools(store);
  const execution = await executeTurn(
    { ...baseInput, ...options.input },
    runtimes,
    {
      store,
      llm: options.llm ?? ({ generate: vi.fn() } as never),
      ...(options.probe ? { pluginDataReadProbe: options.probe } : {}),
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
        ...(options.guards?.[runtime.name]
          ? { guard: options.guards[runtime.name] }
          : {}),
        ...(handlers[runtime.name] ? { handler: handlers[runtime.name] } : {}),
      }),
    },
  );
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: "turn", durationMs: 0 },
  });
  const stored = async (namespace: string, key: string, pluginId = PLUGIN) =>
    (await store.getPluginData(SESSION, pluginId, namespace, key))?.value;
  // The plan's results are full runtime results; its type is narrower.
  const results = execution.commit.results as readonly RuntimeResult[];
  const resultOf = (runtimeId: string) =>
    results.find((result) => result.runtimeId === runtimeId);
  return { store, execution, outcome, stored, resultOf, results };
}

const set =
  (key: string, value: JsonValue, result: HandlerResult = ok()) =>
  async (ctx: FunctionHandlerContext) => {
    await ctx.pluginData!.set("notes", key, value);
    return result;
  };

describe("plugin-data visibility within one execution", () => {
  it("shows an upstream runtime's writes to a later runtime of the same plugin", async () => {
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    const seen: Record<string, unknown> = {};
    await run([a, b], {
      [a.name]: set("x", "from a"),
      [b.name]: async (ctx) => {
        seen.get = await ctx.pluginData!.get("notes", "x");
        seen.list = await ctx.pluginData!.list("notes");
        seen.store = (await ctx.store.getPluginData("notes", "x"))?.value;
        seen.storeList = (await ctx.store.listPluginData("notes")).map(
          (row) => [row.key, row.value],
        );
        return ok();
      },
    });

    expect(seen.get).toBe("from a");
    expect(seen.list).toEqual([
      expect.objectContaining({ key: "x", value: "from a" }),
    ]);
    expect(seen.store).toBe("from a");
    expect(seen.storeList).toEqual([["x", "from a"]]);
  });

  it("does not show another plugin's writes", async () => {
    const a = fn("a", { stage: "pre-turn" });
    const other = fn("b", {}, "other");
    let seen: unknown = "unread";
    await run([a, other], {
      [a.name]: set("x", "from a"),
      [other.name]: async (ctx) => {
        seen = await ctx.pluginData!.get("notes", "x");
        return ok();
      },
    });

    expect(seen).toBeNull();
  });

  it("keeps siblings of one level apart", async () => {
    const a = fn("a");
    const b = fn("b");
    const seen: Record<string, unknown> = {};
    const { stored } = await run([a, b], {
      [a.name]: async (ctx) => {
        await ctx.pluginData!.set("notes", "a", "a");
        seen.a = await ctx.pluginData!.get("notes", "b");
        return ok();
      },
      [b.name]: async (ctx) => {
        await ctx.pluginData!.set("notes", "b", "b");
        seen.b = await ctx.pluginData!.get("notes", "a");
        return ok();
      },
    });

    expect(seen).toEqual({ a: null, b: null });
    expect([await stored("notes", "a"), await stored("notes", "b")]).toEqual([
      "a",
      "b",
    ]);
  });

  it("checks an operation list against upstream writes and commits each list once", async () => {
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    let before: unknown;
    const { stored, outcome } = await run(
      [a, b],
      {
        [a.name]: async (ctx) => {
          await ctx.pluginData!.update("notes", "gold", [{ op: "inc", by: 1 }]);
          return ok();
        },
        [b.name]: async (ctx) => {
          before = await ctx.pluginData!.get("notes", "gold");
          await ctx.pluginData!.update("notes", "gold", [{ op: "inc", by: 1 }]);
          return ok();
        },
      },
      { stored: [{ namespace: "notes", key: "gold", value: 10 }] },
    );

    expect(before).toBe(11);
    expect(outcome.status).toBe("committed");
    expect(await stored("notes", "gold")).toBe(12);
  });

  it("refuses an operation list early when an upstream write leaves it out of bounds", async () => {
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    const { resultOf, stored } = await run(
      [a, b],
      {
        [a.name]: async (ctx) => {
          await ctx.pluginData!.update("notes", "gold", [{ op: "inc", by: 1 }]);
          return ok();
        },
        [b.name]: async (ctx) => {
          await ctx.pluginData!.update("notes", "gold", [
            { op: "inc", by: 1, max: 11 },
          ]);
          return ok();
        },
      },
      { stored: [{ namespace: "notes", key: "gold", value: 10 }] },
    );

    expect(resultOf(b.name)).toMatchObject({ status: "failed" });
    expect(resultOf(b.name)?.error).toContain("pluginData.update");
    expect(await stored("notes", "gold")).toBe(11);
  });

  it("hides a failed upstream result's writes", async () => {
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    let seen: unknown = "unread";
    await run([a, b], {
      [a.name]: set("x", "from a", { outcome: "failed", error: "gave up" }),
      [b.name]: async (ctx) => {
        seen = await ctx.pluginData!.get("notes", "x");
        return ok();
      },
    });

    expect(seen).toBeNull();
  });

  it("shows the writes of a guard that skipped its agent, and not of one that let it run", async () => {
    const skipping = fn("skipping", { runtimeType: "agent", guard: "./g.js" });
    const passing = fn("passing", { runtimeType: "agent", guard: "./g.js" });
    const reader = fn("reader", { after: [skipping.name, passing.name] });
    const llm: LLMAdapter = {
      generate: async (): Promise<LLMResponse> => ({
        content: "done",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    let seen: unknown;
    await run(
      [skipping, passing, reader],
      {
        [reader.name]: async (ctx) => {
          seen = Object.fromEntries(
            (await ctx.pluginData!.list("notes")).map((entry) => [
              entry.key,
              entry.value,
            ]),
          );
          return ok();
        },
      },
      {
        llm,
        guards: {
          [skipping.name]: async (ctx) => {
            await ctx.pluginData!.set("notes", "skipped", true);
            return { skip: true };
          },
          [passing.name]: async (ctx) => {
            await ctx.pluginData!.set("notes", "passed", true);
            return { skip: false };
          },
        },
      },
    );

    expect(seen).toEqual({ skipped: true });
  });

  it("applies an upstream result's effects.pluginData before its buffered writes", async () => {
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    let seen: unknown;
    const { stored } = await run([a, b], {
      [a.name]: async (ctx) => {
        // Committed after the effects entry below, so it starts from 1.
        await ctx.pluginData!.update("notes", "count", [{ op: "inc", by: 1 }]);
        return {
          outcome: "success",
          value: {},
          effects: {
            pluginData: [{ namespace: "notes", key: "count", value: 1 }],
          },
        };
      },
      [b.name]: async (ctx) => {
        seen = await ctx.pluginData!.get("notes", "count");
        return ok();
      },
    });

    expect(seen).toBe(2);
    expect(await stored("notes", "count")).toBe(2);
  });

  it("never applies a retry seed's writes again", async () => {
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    const seed: RuntimeResult = {
      pluginId: PLUGIN,
      runtimeId: a.name,
      runId: "seed-run",
      turnId: "source-turn",
      status: "success",
      output: {},
      pendingProposals: [
        {
          id: "seed-update",
          type: "plugin.data.update",
          source: { pluginId: PLUGIN, runtimeId: a.name },
          sessionId: SESSION,
          turnId: "source-turn",
          timestamp: "2026-10-29T00:00:00.000Z",
          payload: {
            namespace: "notes",
            key: "gold",
            ops: [{ op: "inc", by: 1 }],
          },
        },
      ],
      toolCalls: [],
      durationMs: 1,
      timestamp: "2026-10-29T00:00:00.000Z",
    };
    let seen: unknown;
    const { stored, outcome } = await run(
      [a, b],
      {
        [b.name]: async (ctx) => {
          seen = await ctx.pluginData!.get("notes", "gold");
          await ctx.pluginData!.update("notes", "gold", [{ op: "inc", by: 1 }]);
          return ok();
        },
      },
      {
        stored: [{ namespace: "notes", key: "gold", value: 11 }],
        input: {
          turnId: "retry",
          origin: "manual",
          playerMessage: "",
          manualTrigger: {
            runtimeId: b.name,
            sourceTurnId: "source-turn",
            retrySeedResults: [seed],
          },
        },
      },
    );

    expect(seen).toBe(11);
    expect(outcome.status).toBe("committed");
    expect(await stored("notes", "gold")).toBe(12);
  });

  it("never applies a detached job's upstream results again", async () => {
    const a = fn("a");
    const detached = fn("detached", {
      after: [a.name],
      turnCompletion: { mode: "detached" },
    } as Partial<RuntimeManifest>);
    const upstream: RuntimeResult = {
      pluginId: PLUGIN,
      runtimeId: a.name,
      runId: "source-run",
      turnId: "source-turn",
      status: "success",
      output: {},
      effects: { pluginData: [{ namespace: "notes", key: "x", value: "old" }] },
      toolCalls: [],
      durationMs: 1,
      timestamp: "2026-10-29T00:00:00.000Z",
    };
    let seen: unknown = "unread";
    await run(
      [a, detached],
      {
        [detached.name]: async (ctx) => {
          seen = await ctx.pluginData!.get("notes", "x");
          return ok();
        },
      },
      {
        input: {
          turnId: "background-turn",
          origin: "background",
          playerMessage: "",
          detachedStage: {
            jobId: "job",
            runtimeId: detached.name,
            sourceTurnId: "source-turn",
            sourceExecutionId: "source-execution",
            sourceExecutionStartedAt: "2026-10-29T00:00:00.000Z",
            turnDigest: {
              turnId: "source-turn",
              playerMessage: "",
              lastPlayerInput: null,
              narrativeText: "",
              toolCallSummaries: [],
              runtimeResults: [],
            },
            upstreamResults: [upstream],
          },
        },
      },
    );

    expect(seen).toBeNull();
  });

  it("shows a nested child's writes through its successful parent, never through a failed one", async () => {
    const parent = fn("parent");
    const failing = fn("failing");
    const child = fn("child", { trigger: { type: "manual" } });
    const reader = fn("reader", { after: [parent.name, failing.name] });
    let seen: unknown;
    await run([parent, failing, child, reader], {
      [parent.name]: async (ctx) => {
        await ctx.recursiveCall({
          manualTrigger: { runtimeId: child.name, payload: { key: "kept" } },
        });
        return ok();
      },
      [failing.name]: async (ctx) => {
        await ctx.recursiveCall({
          manualTrigger: { runtimeId: child.name, payload: { key: "lost" } },
        });
        return { outcome: "failed", error: "parent gave up" };
      },
      [child.name]: async (ctx) => {
        const key = (ctx.manualPayload as { key: string }).key;
        await ctx.pluginData!.set("notes", key, true);
        return ok();
      },
      [reader.name]: async (ctx) => {
        seen = Object.fromEntries(
          (await ctx.pluginData!.list("notes")).map((entry) => [
            entry.key,
            entry.value,
          ]),
        );
        return ok();
      },
    });

    expect(seen).toEqual({ kept: true });
  });

  it("shows upstream writes to tool store reads and the builtin plugin-data tools", async () => {
    const a = fn("a");
    const b = fn("b", {
      after: [a.name],
      tools: { builtin: ["plugin-data-get", "plugin-data-list"] },
    });
    const seen: Record<string, unknown> = {};
    await run(
      [a, b],
      {
        [a.name]: set("x", "from a"),
        [b.name]: async (ctx) => {
          seen.get = await ctx.tools!.call("plugin-data-get", {
            namespace: "notes",
            key: "x",
          });
          seen.list = await ctx.tools!.call("plugin-data-list", {});
          return ok();
        },
      },
      { tools: true },
    );

    expect(seen.get).toMatchObject({ found: true, value: "from a" });
    expect(seen.list).toMatchObject({
      count: 1,
      items: [{ namespace: "notes", key: "x", value: "from a" }],
    });
  });

  it("shows upstream writes to an agent's tool calls", async () => {
    const a = fn("a");
    const agent = fn("agent", {
      runtimeType: "agent",
      after: [a.name],
      tools: { builtin: ["plugin-data-get"] },
    });
    const replies: LLMResponse[] = [
      {
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: "plugin-data-get",
            arguments: JSON.stringify({ namespace: "notes", key: "x" }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: "done",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ];
    const { resultOf, execution } = await run(
      [a, agent],
      { [a.name]: set("x", "from a") },
      {
        tools: true,
        llm: { generate: async () => replies.shift()! },
      },
    );

    expect(resultOf(agent.name)?.toolCalls[0]?.output).toMatchObject({
      found: true,
      value: "from a",
    });
    expect(
      execution.commit.readDependencies?.[resultOf(agent.name)!.runId],
    ).toEqual([resultOf(a.name)!.runId]);
  });

  it("records a dependency only for reads that saw an upstream write", async () => {
    const a = fn("a");
    const overwrites = fn("overwrites", { after: [a.name] });
    const reads = fn("reads", { after: [a.name] });
    const { execution, resultOf } = await run([a, overwrites, reads], {
      [a.name]: set("x", "from a"),
      [overwrites.name]: async (ctx) => {
        await ctx.pluginData!.set("notes", "x", "own");
        await ctx.pluginData!.get("notes", "x");
        return ok();
      },
      [reads.name]: async (ctx) => {
        await ctx.pluginData!.get("notes", "x");
        await ctx.pluginData!.set("notes", "x", "own");
        return ok();
      },
    });

    const edges = execution.commit.readDependencies ?? {};
    expect(edges[resultOf(overwrites.name)!.runId]).toBeUndefined();
    expect(edges[resultOf(reads.name)!.runId]).toEqual([
      resultOf(a.name)!.runId,
    ]);
  });

  it("ends a dependency at a whole-value operation anywhere in a list", async () => {
    const a = fn("a");
    const replaces = fn("replaces", { after: [a.name] });
    const reads = fn("reads", { after: [replaces.name] });
    const own = fn("own", { after: [a.name] });
    const seen: Record<string, unknown> = {};
    const { execution, resultOf } = await run([a, replaces, reads, own], {
      [a.name]: set("x", 1),
      [replaces.name]: async (ctx) => {
        await ctx.pluginData!.update("notes", "x", [
          { op: "inc", by: 1 },
          { op: "set", value: 5 },
        ]);
        return ok();
      },
      [reads.name]: async (ctx) => {
        seen.reads = await ctx.pluginData!.get("notes", "x");
        return ok();
      },
      [own.name]: async (ctx) => {
        await ctx.pluginData!.update("notes", "x", [
          { op: "inc", by: 1 },
          { op: "set", value: 7 },
        ]);
        seen.own = await ctx.pluginData!.get("notes", "x");
        return ok();
      },
    });

    expect(seen).toEqual({ reads: 5, own: 7 });
    const edges = execution.commit.readDependencies ?? {};
    // `replaces` overwrote a's value, so only it shapes what `reads` saw.
    expect(edges[resultOf(reads.name)!.runId]).toEqual([
      resultOf(replaces.name)!.runId,
    ]);
    // `own` overwrote the key itself before it read it.
    expect(edges[resultOf(own.name)!.runId]).toBeUndefined();
  });

  it("does not attach dependencies to a result that cannot commit", async () => {
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    const { execution } = await run([a, b], {
      [a.name]: set("x", "from a"),
      [b.name]: async (ctx) => {
        await ctx.pluginData!.get("notes", "x");
        return { outcome: "failed", error: "nope" };
      },
    });

    expect(execution.commit.readDependencies).toEqual({});
  });

  it("returns an owned copy and keeps upstream writes out of the reader's buffer", async () => {
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    const { resultOf, results } = await run([a, b], {
      [a.name]: set("x", { n: 1 }),
      [b.name]: async (ctx) => {
        const value = (await ctx.pluginData!.get("notes", "x")) as {
          n: number;
        };
        value.n = 99;
        return ok();
      },
    });

    expect(resultOf(b.name)?.pendingProposals).toBeUndefined();
    const writes = collectUpstreamPluginDataWrites(
      new Map(results.map((r) => [r.runtimeId, r])),
      SESSION,
      PLUGIN,
    );
    expect(writes.map((write) => write.proposal.payload)).toEqual([
      { namespace: "notes", key: "x", value: { n: 1 } },
    ]);
  });
});

describe("pluginDataReadProbe", () => {
  it("reports values with and without upstream writes that differ exactly where an upstream write landed", async () => {
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    const reads: PluginDataReadObservation[] = [];
    await run(
      [a, b],
      {
        [a.name]: set("x", "from a"),
        [b.name]: async (ctx) => {
          await ctx.pluginData!.get("notes", "x");
          await ctx.pluginData!.get("notes", "y");
          await ctx.store.listPluginData("notes");
          return ok();
        },
      },
      {
        stored: [{ namespace: "notes", key: "y", value: "stored" }],
        probe: (read) => reads.push(read),
      },
    );

    const ofB = reads.filter((read) => read.runtimeId === b.name);
    expect(
      ofB.map(({ kind, key, withoutUpstream, visible }) => ({
        kind,
        key,
        withoutUpstream,
        visible,
      })),
    ).toEqual([
      { kind: "get", key: "x", withoutUpstream: null, visible: "from a" },
      { kind: "get", key: "y", withoutUpstream: "stored", visible: "stored" },
      {
        kind: "list",
        key: undefined,
        withoutUpstream: [{ namespace: "notes", key: "y", value: "stored" }],
        visible: [
          { namespace: "notes", key: "x", value: "from a" },
          { namespace: "notes", key: "y", value: "stored" },
        ],
      },
    ]);
    expect(ofB[0]?.producers).toHaveLength(1);
    expect(ofB[1]?.producers).toEqual([]);
  });

  it("never lets a throwing probe break the read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = fn("a");
    const b = fn("b", { after: [a.name] });
    let seen: unknown;
    const { resultOf } = await run(
      [a, b],
      {
        [a.name]: set("x", "from a"),
        [b.name]: async (ctx) => {
          seen = await ctx.pluginData!.get("notes", "x");
          return ok();
        },
      },
      {
        probe: () => {
          throw new Error("probe broke");
        },
      },
    );

    expect(seen).toBe("from a");
    expect(resultOf(b.name)?.status).toBe("success");
  });
});
