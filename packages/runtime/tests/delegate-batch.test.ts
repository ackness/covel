import { describe, expect, it } from "vitest";
import type { LLMAdapter } from "@covel/shared";
import { fixture, fn, story, tell } from "./_helpers/world-read-fixture.js";
import { submitted, toolCall, latch } from "./_helpers/agent-loop-fixture.js";

import type { ToolCallContext } from "../src/agent-loop/tool-executor.js";
import { withSubagentDelegate } from "../src/agent-loop/subagent-delegate.js";
import { createSubagentRunner } from "../src/agent-loop/subagent-runner.js";
import { DelegationBudget } from "../src/orchestration/delegation-budget.js";
import { createExecutionContext } from "../src/turn-executor/execution-context.js";
import { createWorldModelView } from "../src/function-runtime/world-model-view.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";
import {
  character,
  schema,
  SESSION,
  input,
} from "./_helpers/world-read-fixture.js";
import { baselinesFor } from "../src/read-baselines.js";
import { createRootOperationStage } from "../src/operations/operation-stage.js";
import type { SubagentRunArgs } from "../src/agent-loop/subagent-runner.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";
import { tool, z } from "@covel/tools";
import { PluginServiceRegistry } from "../src/plugin-services.js";

const child = fn(
  "child",
  {
    runtimeType: "agent",
    subagentOnly: true,
    stage: undefined,
    trigger: { type: "manual" },
    maxSteps: 2,
  },
  "actor",
);
const parent = fn("parent", {
  runtimeType: "agent",
  tools: { builtin: ["delegate-batch"] },
});
const request = (brief: string) => ({
  target: { contract: "test.batch@1" },
  brief,
});

describe("bounded batch delegation", () => {
  it("starts both children before either completes and joins by input index", async () => {
    const rendezvous = latch(2);
    const started: string[] = [];
    const llm: LLMAdapter = {
      generate: async (r) => {
        if (r.messages.some((m) => String(m.content).includes(parent.name))) {
          if (!r.messages.some((m) => m.role === "tool")) {
            expect(r.tools?.some((t) => t.name === "delegate-batch")).toBe(
              true,
            );
            return toolCall("delegate-batch", {
              requests: [request("first"), request("second")],
            });
          }
          const receipt = JSON.parse(
            String(r.messages.find((m) => m.role === "tool")!.content),
          );
          expect(receipt.data.results).toEqual([
            { ok: true, output: { line: "first" } },
            { ok: true, output: { line: "second" } },
          ]);
          return submitted("Parent done");
        }
        const brief = String(r.messages.at(-1)!.content);
        started.push(brief);
        await rendezvous();
        return submitJson(JSON.stringify({ line: brief }));
      },
    };
    const f = await fixture({ deps: { llm } });
    const result = await f.execute(
      [story, parent, { ...child, outputContract: "test.batch@1" }],
      { [story.name]: tell },
    );
    expect(result.resultOf(parent).status).toBe("success");
    expect(started).toEqual(["first", "second"]);
  });
});

async function direct(
  options: {
    llm?: LLMAdapter;
    settings?: unknown;
    provider?: Partial<import("@covel/shared").RuntimeManifest>;
    deps?: Partial<TurnExecutorDeps>;
    tools?: NonNullable<Parameters<typeof fixture>[0]>["tools"];
  } = {},
) {
  const f = await fixture({ tools: options.tools });
  const recorder = new Set(["earlier-parent-read"]);
  const upstream = [
    {
      runId: "character-source",
      runtimeId: "source/character",
      proposal: character(),
    },
    { runId: "schema-source", runtimeId: "source/schema", proposal: schema() },
  ];
  const pending: import("@covel/shared").Proposal[] = [];
  const world = await createWorldModelView(
    f.store,
    SESSION,
    upstream.map((w) => w.proposal),
    pending,
    undefined,
    undefined,
    { upstream, recorder },
  );
  const delegation = new DelegationBudget({
    sessionId: SESSION,
    store: f.store,
    settings: options.settings,
  });
  const emitter = makeEmitterSpy();
  const provider: import("@covel/shared").RuntimeManifest = {
    ...child,
    outputContract: "test.batch@1",
    tools: { builtin: options.tools?.map((t) => t.name) ?? [] },
    timeoutMs: 1000,
    ...options.provider,
  };
  let loader: TurnExecutorDeps["loadRuntime"] = async (manifest) => ({
    manifest,
    promptTemplate: manifest.name,
  });
  const deps: TurnExecutorDeps = {
    ...f.baseDeps,
    llm: options.llm ?? {
      generate: async (r) =>
        submitJson(JSON.stringify({ line: r.messages.at(-1)?.content })),
    },
    loadRuntime: (...args) => loader(...args),
    delegation,
    emitter,
    ...options.deps,
  };
  const runner = createSubagentRunner({
    activeRuntimes: [provider],
    delegation,
  });
  const operations = createRootOperationStage({
    caller: { pluginId: "observer", runtimeId: parent.name },
    sessionId: SESSION,
    turnId: input.turnId,
  });
  const executor = withSubagentDelegate(deps.toolExecutor!, runner, {
    caller: { pluginId: "observer", runtimeId: parent.name, depth: 0 },
    input,
    deps,
    executionContext: createExecutionContext(input),
    operations,
  });
  const abort = new AbortController();
  const context: ToolCallContext = {
    sessionId: SESSION,
    turnId: input.turnId,
    pluginId: "observer",
    runtimeId: parent.name,
    world,
    signal: abort.signal,
    authorizedToolNames: new Set(["delegate-batch"]),
    emitter: deps.emitter,
  };
  const args = (brief: string): SubagentRunArgs => ({
    caller: { pluginId: "observer", runtimeId: parent.name, depth: 0 },
    input,
    deps,
    request: request(brief),
    world,
    parentCallId: "unrelated",
    executionContext: createExecutionContext(input),
  });
  const batch = (value: unknown, id = "batch") =>
    executor.execute(
      {
        name: "delegate-batch",
        toolCallId: id,
        arguments: JSON.stringify(value),
      },
      context,
    );
  return {
    ...f,
    recorder,
    world,
    pending,
    delegation,
    emitter,
    provider,
    setLoader: (next: TurnExecutorDeps["loadRuntime"]) => {
      loader = next;
    },
    deps,
    runner,
    operations,
    executor,
    abort,
    context,
    batch,
    args,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function results(
  value: Awaited<ReturnType<Awaited<ReturnType<typeof direct>>["batch"]>>,
) {
  return (
    value.parsedResult as {
      results: (
        | { ok: true; output: Record<string, unknown> }
        | { ok: false; error: { code: string } }
      )[];
    }
  ).results;
}

describe("batch admission and lifetime", () => {
  it.each([
    {},
    { requests: [] },
    { requests: Array.from({ length: 33 }, () => request("x")) },
    { requests: [request("x")], extra: true },
  ])("rejects an invalid container before any child: %j", async (value) => {
    const f = await direct();
    expect((await f.batch(value)).success).toBe(false);
    expect(f.delegation.snapshot().calls).toBe(0);
    expect(
      f.emitter.events.filter((e) => e.type.startsWith("subagent.")),
    ).toHaveLength(0);
  });

  it("isolates malformed entries and enforces per-request limits without losing valid siblings", async () => {
    const f = await direct();
    const result = await f.batch({
      requests: [
        request("first"),
        { ...request("bad"), maxSteps: 0 },
        { ...request("large"), data: { value: "x".repeat(32769) } },
        request("x".repeat(20001)),
        request("last"),
      ],
    });
    expect(result.success).toBe(true);
    expect(results(result).map((r) => r.ok)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(f.delegation.snapshot().calls).toBe(2);
    const terminal = f.emitter.events.filter((e) =>
      ["subagent.completed", "subagent.failed"].includes(e.type),
    );
    expect(terminal).toHaveLength(5);
    expect(new Set(terminal.map((e) => e.payload.subagentCallId)).size).toBe(5);
    expect(terminal.map((e) => e.payload.batchIndex).sort()).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(terminal.every((e) => e.payload.parentCallId === "batch")).toBe(
      true,
    );
  });

  it("admits an ordered eight-entry prefix without refilling from fast completions", async () => {
    const started: string[] = [];
    const f = await direct({
      llm: {
        generate: async (r) => {
          started.push(String(r.messages.at(-1)?.content));
          return submitted("Done");
        },
      },
    });
    const result = await f.batch({
      requests: Array.from({ length: 9 }, (_, i) => request(String(i))),
    });
    expect(results(result).map((r) => r.ok)).toEqual([
      ...Array(8).fill(true),
      false,
    ]);
    expect(results(result)[8]).toMatchObject({
      error: { code: "unavailable" },
    });
    expect(started).toEqual(Array.from({ length: 8 }, (_, i) => String(i)));
    expect(f.delegation.snapshot().calls).toBe(8);
    expect(f.runner.inFlight).toBe(0);
  });

  it("refuses immediately while unrelated work fills the pool and never retries", async () => {
    const release = deferred();
    const allStarted = deferred();
    let calls = 0;
    const f = await direct({
      llm: {
        generate: async () => {
          if (++calls === 8) allStarted.resolve();
          await release.promise;
          return submitted("Done");
        },
      },
    });
    const occupied = Array.from({ length: 8 }, (_, i) =>
      f.runner.run(f.args(`other-${i}`)),
    );
    await allStarted.promise;
    expect(
      results(await f.batch({ requests: [request("refused")] }))[0],
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.delegation.snapshot().calls).toBe(8);
    release.resolve();
    await Promise.all(occupied);
    expect(calls).toBe(8);
    expect(f.runner.inFlight).toBe(0);
  });

  it.each([0, 3])(
    "preserves existing claims against a call cap of %s",
    async (cap) => {
      const f = await direct({ settings: { maxSubagentCalls: cap } });
      if (cap) {
        f.delegation.claim();
        f.delegation.claim();
      }
      const result = await f.batch({ requests: [request("a"), request("b")] });
      expect(results(result).map((r) => r.ok)).toEqual(
        cap ? [true, false] : [false, false],
      );
      expect(f.delegation.snapshot().calls).toBe(cap);
    },
  );

  it("keeps failures indexed and charges admitted failures without leaking diagnostics", async () => {
    const f = await direct({
      llm: {
        generate: async (r) => {
          if (r.messages.at(-1)?.content === "bad")
            throw new Error("PRIVATE-PROVIDER-ERROR");
          return submitted("Done");
        },
      },
    });
    const result = await f.batch({
      requests: [request("bad"), request("good"), request("bad")],
    });
    expect(results(result).map((r) => r.ok)).toEqual([false, true, false]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-PROVIDER-ERROR");
    expect(f.delegation.snapshot().calls).toBe(3);
  });

  it("releases a timed-out non-cooperative loader while a later sibling succeeds", async () => {
    const f = await direct();
    let loads = 0;
    f.setLoader(async (manifest) =>
      ++loads === 1
        ? new Promise<never>(() => {})
        : { manifest, promptTemplate: "child" },
    );
    const result = await f.runner.runBatch([
      {
        ...f.args("never"),
        request: { ...request("never"), budget: { timeoutMs: 30 } },
      },
      f.args("good"),
    ]);
    expect(result).toMatchObject([
      { ok: false, error: { code: "timeout" } },
      { ok: true },
    ]);
    expect(f.runner.inFlight).toBe(0);
  });

  it("propagates parent cancellation through non-cooperative models without late publication", async () => {
    const both = deferred();
    const release = deferred();
    let calls = 0;
    const f = await direct({
      llm: {
        generate: async () => {
          if (++calls === 2) both.resolve();
          await release.promise;
          throw new Error("late rejection");
        },
      },
    });
    const running = f.batch({ requests: [request("a"), request("b")] });
    const rejected = expect(running).rejects.toThrow("parent stopped");
    await both.promise;
    f.abort.abort(new Error("parent stopped"));
    await rejected;
    expect(f.runner.inFlight).toBe(0);
    expect(f.delegation.snapshot().calls).toBe(2);
    release.resolve();
    await Promise.resolve();
    expect(
      f.emitter.events.filter((e) => e.type === "subagent.completed"),
    ).toHaveLength(0);
  });
});

describe("batch speculative evidence and operations", () => {
  it.each([false, true])(
    "keeps admission snapshots and success-only evidence (cancel outer=%s)",
    async (cancelOuter) => {
      const loading = deferred();
      const release = deferred();
      let loads = 0;
      const retained: import("@covel/shared").WorldModelView[] = [];
      const peek = tool({
        name: "peek-batch-world",
        description: "Read the inherited world",
        annotations: { readOnly: true },
        parameters: z.object({ failed: z.boolean() }),
        execute: async ({ failed }, ctx) => {
          retained.push(ctx.world!);
          expect(
            ctx.world!.characters.find((c) => c.id === "source")?.description,
          ).toBe("staged");
          if (failed)
            expect(ctx.world!.characterSchema?.types).toContain("visitor");
          return { read: true };
        },
      });
      const f = await direct({
        tools: [peek],
        llm: {
          generate: async (r) => {
            const bad =
              r.messages.find((m) => m.role === "user")?.content === "bad";
            if (!r.messages.some((m) => m.role === "tool"))
              return toolCall(peek.name, { failed: bad });
            if (bad) throw new Error("failed after reading");
            return submitted("Done");
          },
        },
      });
      f.setLoader(async (manifest) => {
        if (++loads === 2) loading.resolve();
        await release.promise;
        return { manifest, promptTemplate: manifest.name };
      });
      const originalEmit = f.emitter.emit;
      f.emitter.emit = async (type, payload) => {
        await originalEmit(type, payload);
        if (
          cancelOuter &&
          type === "tool.completed" &&
          payload.toolName === "delegate-batch"
        )
          f.abort.abort(new Error("closed before publication"));
      };
      const running = f.batch({ requests: [request("good"), request("bad")] });
      const rejected = cancelOuter
        ? expect(running).rejects.toThrow("closed before publication")
        : undefined;
      await loading.promise;
      f.pending.push(character("source", "later pending"), {
        ...schema(),
        payload: { types: ["npc", "later"], attributes: [] },
      });
      release.resolve();
      if (rejected) await rejected;
      else
        expect(results(await running).map((r) => r.ok)).toEqual([true, false]);
      expect([...f.recorder]).toEqual(
        cancelOuter
          ? ["earlier-parent-read"]
          : ["earlier-parent-read", "character-source"],
      );
      expect(baselinesFor(f.recorder).snapshot()).toHaveLength(
        cancelOuter ? 0 : 1,
      );
      expect(retained).toHaveLength(2);
      for (const world of retained) expect(() => world.characters).toThrow();
      expect(
        f.world.characters.find((c) => c.id === "source")?.description,
      ).toBe("later pending");
      expect(f.world.characterSchema?.types).toEqual(["npc", "later"]);
      expect(f.runner.inFlight).toBe(0);
    },
  );

  it.each([false, true])(
    "shares provider locks and discards only failed children (cancel outer=%s)",
    async (cancelOuter) => {
      const services = new PluginServiceRegistry({
        list: async () => ["actor", "observer", "service"],
        ensure: async () => {},
      });
      const release = deferred();
      const entered = deferred();
      let active = 0;
      let handlers = 0;
      services.register("service", {
        name: "write",
        contract: "test.batch-write@1",
        access: "write",
        modelFacing: true,
        description: "Stage a note",
        input: z.object({ key: z.string() }),
        output: z.object({ staged: z.boolean() }),
        handler: async ({ key }, ctx) => {
          expect(++active).toBe(1);
          if (++handlers === 1) {
            entered.resolve();
            await release.promise;
          }
          await ctx.pluginData.set("notes", key, key);
          active--;
          return { staged: true };
        },
      });
      const f = await direct({
        deps: { services },
        provider: {
          tools: {
            services: [{ contract: "test.batch-write@1", name: "write-note" }],
          },
        },
        llm: {
          generate: async (r) => {
            const key = String(
              r.messages.find((m) => m.role === "user")?.content,
            );
            if (!r.messages.some((m) => m.role === "tool"))
              return toolCall("write-note", { key });
            if (key === "bad") throw new Error("discard my operation");
            return submitted("Done");
          },
        },
      });
      const originalEmit = f.emitter.emit;
      f.emitter.emit = async (type, payload) => {
        await originalEmit(type, payload);
        if (
          cancelOuter &&
          type === "tool.completed" &&
          payload.toolName === "delegate-batch"
        )
          f.abort.abort(new Error("closed before publication"));
      };
      const running = f.batch({ requests: [request("bad"), request("good")] });
      const rejected = cancelOuter
        ? expect(running).rejects.toThrow()
        : undefined;
      await entered.promise;
      expect(handlers).toBe(1);
      release.resolve();
      if (rejected) await rejected;
      else
        expect(results(await running).map((r) => r.ok)).toEqual([false, true]);
      expect(handlers).toBe(2);
      expect(f.operations.held().map((op) => op.request)).toEqual(
        cancelOuter ? [] : [{ key: "good" }],
      );
      expect(await f.store.listPluginData(SESSION, "service", "notes")).toEqual(
        [],
      );
    },
  );
});

it.each([0, 1])(
  "counts distinct actors separately from repeated identities with maxActors=%s",
  async (maxActors) => {
    const f = await direct({
      settings: { maxActors },
      provider: { outputContract: "character-actor@1" },
      llm: {
        generate: async () =>
          submitJson(
            JSON.stringify({
              segments: [{ kind: "dialogue", text: "Hello" }],
              intent: "PRIVATE-INTENT",
            }),
          ),
      },
    });
    const result = await f.batch({
      requests: ["source", "source", "derived"].map((character) => ({
        target: { contract: "character-actor@1" },
        character,
        brief: "A safe brief",
      })),
    });
    expect(results(result).map((r) => r.ok)).toEqual(
      maxActors ? [true, true, false] : [false, false, false],
    );
    expect(f.delegation.snapshot().calls).toBe(maxActors ? 2 : 0);
    expect(f.delegation.snapshot().actorIds).toHaveLength(maxActors);
  },
);

it("refuses undeclared batches at final authorization and strips delegation at child depth", async () => {
  const f = await direct();
  const result = await f.executor.execute(
    {
      name: "delegate-batch",
      toolCallId: "unauthorized",
      arguments: JSON.stringify({ requests: [request("x")] }),
    },
    { ...f.context, authorizedToolNames: new Set() },
  );
  expect(result.success).toBe(false);
  expect(f.delegation.snapshot().calls).toBe(0);
  expect(
    (
      await f.runner.runBatch([
        { ...f.args("too deep"), caller: { ...f.args("x").caller, depth: 1 } },
      ])
    )[0],
  ).toMatchObject({ ok: false, error: { code: "unavailable" } });
});

it("keeps private batch results out of persistence while the parent submits its own output", async () => {
  let parentCalls = 0;
  const llm: LLMAdapter = {
    generate: async (r) => {
      if (r.messages.some((m) => String(m.content).includes(parent.name))) {
        parentCalls++;
        if (parentCalls > 1) return submitted("The parent finished.");
        return toolCall("delegate-batch", {
          requests: [
            {
              target: { contract: "character-actor@1" },
              character: "source",
              brief: "PRIVATE-BRIEF",
            },
          ],
        });
      }
      return submitJson(
        JSON.stringify({
          segments: [{ kind: "dialogue", text: "Hello" }],
          intent: "PRIVATE-INTENT",
        }),
      );
    },
  };
  const f = await fixture({ deps: { llm } });
  const finishing = parent;
  const result = await f.execute(
    [story, finishing, { ...child, outputContract: "character-actor@1" }],
    { [story.name]: tell },
  );
  expect(parentCalls).toBe(2);
  expect(result.resultOf(parent).status).toBe("success");
  expect(result.resultOf(parent).output).toEqual({
    narrativeOutput: "The parent finished.",
  });
  expect(JSON.stringify(result.execution.result)).not.toMatch(
    /PRIVATE-BRIEF|PRIVATE-INTENT/,
  );
});

it("keeps a valid sibling after another child fails output repair", async () => {
  const f = await direct({
    llm: {
      generate: async (r) =>
        submitJson(
          JSON.stringify(
            r.messages.find((m) => m.role === "user")?.content === "invalid"
              ? { wrong: true }
              : { line: "Done" },
          ),
        ),
    },
  });
  f.setLoader(async (manifest) => ({
    manifest,
    promptTemplate: manifest.name,
    outputSchema: {
      type: "object",
      properties: { line: { type: "string" } },
      required: ["line"],
      additionalProperties: false,
    },
  }));
  const result = await f.batch({
    requests: [request("invalid"), request("valid")],
  });
  expect(result.success).toBe(true);
  expect(results(result).map((r) => r.ok)).toEqual([false, true]);
  expect(f.delegation.snapshot().calls).toBe(2);
});

it("redacts private batch arguments even when final authorization refuses the call", async () => {
  const f = await direct({ provider: { outputContract: "character-actor@1" } });
  const result = await f.executor.execute(
    {
      name: "delegate-batch",
      toolCallId: "private-refusal",
      arguments: JSON.stringify({
        requests: [
          {
            target: { contract: "character-actor@1" },
            brief: "PRIVATE-UNAUTHORIZED-BRIEF",
            character: "source",
          },
        ],
      }),
    },
    { ...f.context, delegation: f.delegation, authorizedToolNames: new Set() },
  );
  expect(result.success).toBe(false);
  expect(f.delegation.snapshot().calls).toBe(0);
  expect(f.delegation.privacy.calls.has("private-refusal")).toBe(true);
  const recorded = await f.store.listToolCalls(SESSION);
  expect(recorded).toHaveLength(1);
  expect(JSON.stringify(recorded)).not.toContain("PRIVATE-UNAUTHORIZED-BRIEF");
});

function submitJson(content: string) {
  return toolCall("submit-output", JSON.parse(content));
}
