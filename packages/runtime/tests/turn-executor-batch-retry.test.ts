import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { FunctionHandlerContext } from "@covel/plugin-loader";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";

const sessionId = "batch-session";
function manifest(
  name: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name,
    description: name,
    stage: "post-turn",
    outputKind: "system",
    runtimeType: "function",
    handler: "./handler.js",
    trigger: { type: "auto" },
    ...extra,
  };
}
function seed(
  runtimeId: string,
  output: Record<string, unknown>,
): RuntimeResult {
  return {
    runtimeId,
    pluginId: runtimeId,
    runId: `seed-${runtimeId}`,
    turnId: "source",
    status: "success",
    output,
    toolCalls: [],
    durationMs: 1,
    timestamp: "2026-01-01T00:00:00Z",
  };
}
async function run(
  runtimes: RuntimeManifest[],
  ids: string[] | string,
  handlers: Record<
    string,
    (ctx: FunctionHandlerContext) => Promise<Record<string, unknown>>
  >,
  seeds: RuntimeResult[] = [],
  scoped = true,
) {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: runtimes.map((rt) => rt.pluginId),
    completedPlayerTurns: 1,
    createdAt: "2026-01-01T00:00:00Z",
  });
  const calls: string[] = [];
  const result = await executeTurn(
    {
      sessionId,
      turnId: "batch",
      playerMessage: "",
      origin: "manual",
      manualTrigger: {
        ...(typeof ids === "string" ? { runtimeId: ids } : { runtimeIds: ids }),
        ...(scoped ? { sourceTurnId: "source" } : {}),
        retrySeedResults: seeds,
      },
    },
    runtimes,
    {
      store,
      llm: {
        generate: async () => {
          throw new Error("No model calls in this fixture");
        },
      },
      loadRuntime: async (rt) => ({
        manifest: rt,
        promptTemplate: "",
        handler: async (ctx) => {
          calls.push(rt.name);
          return {
            outcome: "success",
            value: (await handlers[rt.name]!(ctx)) as never,
          };
        },
      }),
    },
  );
  return { result, calls, store };
}

describe("batch runtime recovery", () => {
  it("runs independent targets together using committed inputs without rerunning story or event followers", async () => {
    const bothStarted = Promise.withResolvers<void>();
    let started = 0;
    const handler = async (ctx: FunctionHandlerContext) => {
      expect(ctx.inputs?.story?.value).toMatchObject({
        text: "Original story",
      });
      if (++started === 2) bothStarted.resolve();
      await bothStarted.promise;
      return { events: [{ topic: "changed", data: {} }], ok: true };
    };
    const targets = ["a", "b"].map((name) =>
      manifest(name, {
        needs: ["story"],
        inputs: { story: { from: { runtime: "story" }, required: true } },
      }),
    );
    const { result, calls, store } = await run(
      [
        manifest("story", { stage: "narrative", outputKind: "story" }),
        ...targets,
        manifest("follower", { trigger: { type: "event", topic: "changed" } }),
      ],
      ["b", "a"],
      { a: handler, b: handler },
      [
        seed("story", {
          text: "Original story",
          events: [{ topic: "changed", data: {} }],
        }),
      ],
    );
    expect(calls.sort()).toEqual(["a", "b"]);
    expect(result.runtimeResults.map((rr) => rr.status)).toEqual([
      "success",
      "success",
    ]);
    expect(result.runtimeResults.map((rr) => rr.runtimeId).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(result.deferredFollowers ?? []).toEqual([]);
    expect(result.executionContext?.countPolicy).toBe("none");
    expect(await store.listTurnMessages(sessionId)).toEqual([]);
  });

  it("orders selected dependencies and excludes all target seeds", async () => {
    const { result, calls } = await run(
      [
        manifest("a"),
        manifest("b", {
          needs: ["a"],
          inputs: { a: { from: { runtime: "a" }, required: true } },
        }),
      ],
      ["b", "a"],
      {
        a: async () => ({ version: "fresh" }),
        b: async (ctx) => {
          expect(ctx.inputs?.a?.value).toEqual({ version: "fresh" });
          return { ok: true };
        },
      },
      [seed("a", { version: "stale" }), seed("b", { ok: false })],
    );
    expect(calls).toEqual(["a", "b"]);
    expect(result.runtimeResults.map((rr) => rr.status)).toEqual([
      "success",
      "success",
    ]);
  });

  it("keeps a downstream skipped when its selected dependency fails", async () => {
    const { result, calls } = await run(
      [manifest("a"), manifest("b", { needs: ["a"] })],
      ["a", "b"],
      {
        a: async () => {
          throw new Error("Synthetic upstream failure");
        },
      },
      [seed("a", { stale: true })],
    );
    expect(calls).toEqual(["a"]);
    expect(
      result.runtimeResults.map((rr) => [rr.runtimeId, rr.status]),
    ).toEqual([
      ["a", "failed"],
      ["b", "skipped"],
    ]);
  });

  it("keeps stage barriers even when selected IDs are in reverse order", async () => {
    const { calls } = await run(
      [
        manifest("first", { stage: "pre-turn" }),
        manifest("last", { stage: "audit" }),
      ],
      ["last", "first"],
      { first: async () => ({}), last: async () => ({}) },
    );
    expect(calls).toEqual(["first", "last"]);
  });

  it("rejects recursive scope expansion inside a batch", async () => {
    const { result, calls } = await run(
      [manifest("a"), manifest("unrelated")],
      ["a"],
      {
        a: async (ctx) => {
          await ctx.recursiveCall({ playerMessage: "Expand" });
          return {};
        },
      },
    );
    expect(calls).toEqual(["a"]);
    expect(result.runtimeResults[0]?.status).toBe("failed");
    expect(result.runtimeResults[0]?.error).toContain("scoped recovery");
  });

  it.each([[], ["missing"], ["a", "a"]].map((ids) => ({ ids })))(
    "rejects invalid target set $ids without running",
    async ({ ids }) => {
      const { result, calls } = await run([manifest("a")], ids, {});
      expect(calls).toEqual([]);
      expect(result.abortReason).toContain("manual-trigger");
    },
  );
});

describe("single runtime recovery scope", () => {
  it.each([true, false])(
    "limits event followers only for recovery (scoped=%s)",
    async (scoped) => {
      const { result, calls } = await run(
        [
          manifest("target"),
          manifest("follower", {
            trigger: { type: "event", topic: "changed" },
          }),
        ],
        "target",
        {
          target: async () => ({ events: [{ topic: "changed", data: {} }] }),
          follower: async () => ({ updated: true }),
        },
        [seed("follower", { alreadyCommitted: true })],
        scoped,
      );
      expect(calls).toEqual(scoped ? ["target"] : ["target", "follower"]);
      expect(result.runtimeResults.map((row) => row.runtimeId)).toEqual(calls);
      expect(
        result.runtimeResults.every((row) => row.status === "success"),
      ).toBe(true);
      expect(result.deferredFollowers ?? []).toEqual([]);
    },
  );

  it.each([true, false])(
    "limits recursive execution only for recovery (scoped=%s)",
    async (scoped) => {
      const { result, calls } = await run(
        [manifest("target"), manifest("leaf")],
        "target",
        {
          target: async (ctx) => {
            await ctx.recursiveCall({ manualTrigger: { runtimeId: "leaf" } });
            return { ok: true };
          },
          leaf: async () => ({ nested: true }),
        },
        [],
        scoped,
      );
      expect(calls).toEqual(scoped ? ["target"] : ["target", "leaf"]);
      const target = result.runtimeResults.find(
        (row) => row.runtimeId === "target",
      );
      expect(target?.status).toBe(scoped ? "failed" : "success");
      if (scoped) expect(target?.error).toContain("scoped recovery");
    },
  );

  it.each([true, false])(
    "keeps detached targets in the foreground only for recovery (scoped=%s)",
    async (scoped) => {
      const { result, calls } = await run(
        [
          manifest("target", {
            effects: { writes: ["media:*"] },
            turnCompletion: { mode: "detached" },
          }),
        ],
        "target",
        { target: async () => ({ generated: true }) },
        [],
        scoped,
      );
      expect(calls).toEqual(scoped ? ["target"] : []);
      expect(result.runtimeResults.map((row) => row.status)).toEqual(
        scoped ? ["success"] : [],
      );
      expect(result.deferredRuntimeJobs ?? []).toHaveLength(scoped ? 0 : 1);
    },
  );
});
