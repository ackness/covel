import { describe, expect, it } from "vitest";
import type { WorldModelView, SubagentResult, LLMAdapter } from "@covel/shared";
import { tool, withPendingProposals, z } from "@covel/tools";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { createToolExecutionContext } from "../src/agent-loop/tool-execution-context.js";
import { createWorldModelView } from "../src/function-runtime/world-model-view.js";
import { queuedLLM, prose, toolCall } from "./_helpers/agent-loop-fixture.js";
import {
  fixture,
  fn,
  producer,
  story,
  tell,
  ok,
  writes,
  character,
  schema,
  refuseProducer,
  SESSION,
} from "./_helpers/world-read-fixture.js";

const peek = tool({
  name: "peek-world",
  description: "Read characters",
  parameters: z.object({}),
  execute: async (_args, ctx) =>
    withPendingProposals(
      {
        description: ctx.world!.characters.find((c) => c.id === "source")
          ?.description,
      },
      [character("derived", "derived")],
    ),
});
const peekSchema = tool({
  name: "peek-schema",
  description: "Read schema",
  parameters: z.object({}),
  execute: async (_args, ctx) => ({ types: ctx.world!.characterSchema?.types }),
});
const idle = tool({
  name: "idle",
  description: "No world property reads",
  parameters: z.object({}),
  execute: async (_args, ctx) => ({ acquired: Boolean(ctx.world) }),
});
const serviceRequest = {
  pluginId: "service",
  name: "peek",
  contract: "test.peek@1",
  input: {},
};
function services(property: "characters" | "dimensions" = "characters") {
  const registry = new PluginServiceRegistry({
    list: async () => ["source", "observer", "service", "storyteller"],
    ensure: async () => {},
  });
  registry.register("service", {
    name: "peek",
    contract: "test.peek@1",
    access: "read",
    modelFacing: true,
    description: "Read the world",
    input: z.object({}),
    output: z.unknown(),
    handler: async (_input, ctx) => ctx.world[property],
  });
  return registry;
}

describe("world read surfaces", () => {
  it.each([
    "function-tool",
    "skipped-guard",
    "get-character",
    "list-characters",
    "plugin-tool",
    "schema-tool",
  ])("records %s reads on the invoking runtime", async (surface) => {
    const functionTool = surface === "function-tool";
    const guarded = surface === "skipped-guard";
    const name =
      surface === "plugin-tool" || functionTool
        ? "peek-world"
        : surface === "schema-tool"
          ? "peek-schema"
          : surface;
    const reader = fn("read", {
      runtimeType: functionTool ? "function" : "agent",
      ...(guarded ? { guard: "guard.js" } : { tools: { builtin: [name] } }),
    });
    const llm = queuedLLM([
      toolCall(name, name === "get-character" ? { id: "source" } : {}),
      prose("Complete"),
    ]);
    const f = await fixture({ tools: [peek, peekSchema], deps: { llm } });
    const r = await f.execute(
      [producer, story, reader],
      {
        [producer.name]: async () => writes(schema(), character()),
        [story.name]: tell,
        ...(functionTool
          ? {
              [reader.name]: async (ctx: Parameters<typeof tell>[0]) => {
                await ctx.tools!.call(name, {});
                return ok();
              },
            }
          : {}),
      },
      {
        guards: guarded
          ? {
              [reader.name]: async (ctx) => {
                void ctx.world!.characters;
                await ctx.pluginData!.set("notes", "guard", true);
                return { skip: true };
              },
            }
          : {},
      },
    );
    expect(r.resultOf(reader).status, r.resultOf(reader).error).toBe(
      guarded ? "skipped" : "success",
    );
    expect(r.edges(reader)).toEqual([r.resultOf(producer).runId]);
    expect(JSON.stringify(llm.requests)).not.toContain(
      r.resultOf(producer).runId,
    );
    const outcome = await r.commit(refuseProducer);
    expect(outcome.isolatedRuntimes).toContainEqual(
      expect.objectContaining({ runtimeId: reader.name, cause: "read" }),
    );
    expect(await f.notes()).toEqual({});
  });

  it("discards a passing guard's observations", async () => {
    const f = await fixture({ deps: { llm: queuedLLM([prose("Complete")]) } });
    const reader = fn("read", { runtimeType: "agent", guard: "guard.js" });
    const r = await f.execute(
      [producer, story, reader],
      { [producer.name]: async () => writes(character()), [story.name]: tell },
      {
        guards: {
          [reader.name]: async (ctx) => {
            void ctx.world!.characters;
            return { skip: false };
          },
        },
      },
    );
    expect(r.resultOf(reader).status, r.resultOf(reader).error).toBe("success");
    expect(r.edges(reader)).toEqual([]);
    expect((await r.commit(refuseProducer)).isolatedRuntimes).toHaveLength(1);
  });

  it.each(["direct", "tool", "import", "nested-write"])(
    "attributes %s service world reads to the runtime",
    async (route) => {
      const registry = services();
      registry.register("service", {
        name: "write",
        contract: "test.write@1",
        access: "write",
        input: z.object({}),
        output: z.unknown(),
        handler: async (_input, ctx) => {
          const result = await ctx.services.call(serviceRequest);
          void ctx.world.characters;
          await ctx.pluginData.set("notes", "service", true);
          return result;
        },
      });
      const toolModule = tool({
        name: "service-tool",
        description: "Read a service",
        parameters: z.object({}),
        execute: async (_input, ctx) => ctx.services!.call(serviceRequest),
      });
      const reader = fn(
        "read",
        route === "import"
          ? {
              runtimeType: "agent",
              tools: {
                services: [{ contract: "test.peek@1", name: "read-world" }],
              },
            }
          : route === "tool"
            ? { tools: { builtin: ["service-tool"] } }
            : {},
      );
      const f = await fixture({
        tools: [toolModule],
        deps: {
          services: registry,
          llm: queuedLLM([toolCall("read-world", {}), prose("Complete")]),
        },
      });
      const r = await f.execute([producer, story, reader], {
        [producer.name]: async () => writes(character()),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          if (route === "tool") await ctx.tools!.call("service-tool", {});
          else
            await ctx.services!.call(
              route === "nested-write"
                ? { ...serviceRequest, name: "write", contract: "test.write@1" }
                : serviceRequest,
            );
          await ctx.pluginData!.set("notes", "derived", true);
          return ok();
        },
      });
      expect(r.resultOf(reader).status, r.resultOf(reader).error).toBe(
        "success",
      );
      expect(r.edges(reader)).toEqual([r.resultOf(producer).runId]);
      const outcome = await r.commit(refuseProducer);
      expect(outcome.isolatedRuntimes).toContainEqual(
        expect.objectContaining({ runtimeId: reader.name, cause: "read" }),
      );
      expect(await f.notes()).toEqual({});
      expect(await f.notes("service")).toEqual({});
      if (route === "nested-write")
        expect(r.resultOf(reader).operations?.[0]).toMatchObject({
          providerPluginId: "service",
          invokedBy: { runtimeId: reader.name },
        });
    },
  );

  it("does not turn unused tools or dimension-only services into character/schema readers", async () => {
    const f = await fixture({
      tools: [idle],
      deps: {
        services: services("dimensions"),
        llm: queuedLLM([
          toolCall("idle", {}),
          toolCall("dimensions", {}),
          prose("Complete"),
        ]),
      },
    });
    const reader = fn("read", {
      runtimeType: "agent",
      tools: {
        builtin: ["idle"],
        services: [{ contract: "test.peek@1", name: "dimensions" }],
      },
    });
    const r = await f.execute([producer, story, reader], {
      [producer.name]: async () => writes(schema(), character()),
      [story.name]: tell,
    });
    expect(r.resultOf(reader).status, r.resultOf(reader).error).toBe("success");
    expect(r.edges(reader)).toEqual([]);
    expect((await r.commit(refuseProducer)).isolatedRuntimes).toHaveLength(1);
  });

  it("uses detached concurrent tool snapshots and revokes both tool and service property reads", async () => {
    let retainedService: WorldModelView | undefined;
    const registry = services();
    registry.register("service", {
      name: "retain",
      contract: "test.retain@1",
      input: z.object({}),
      output: z.object({}),
      handler: async (_input, ctx) => {
        retainedService = ctx.world;
        return {};
      },
    });
    const f = await fixture();
    const pending = [character()];
    const upstream = [
      { runId: "producer", runtimeId: producer.name, proposal: schema() },
      {
        runId: "character-producer",
        runtimeId: producer.name,
        proposal: character(),
      },
    ];
    const recorder = new Set<string>();
    const world = await createWorldModelView(
      f.store,
      SESSION,
      upstream.map((w) => w.proposal),
      pending,
      undefined,
      undefined,
      { upstream, recorder },
    );
    const caller = {
      sessionId: SESSION,
      turnId: "turn",
      pluginId: "observer",
      runtimeId: "observer/read",
      world,
      pendingProposals: pending,
      services: registry,
    };
    const first = createToolExecutionContext(caller, f.store);
    const second = createToolExecutionContext(caller, f.store);
    expect(recorder.size).toBe(0);
    pending.push(character("source", "later"));
    await Promise.all([
      Promise.resolve().then(() => {
        expect(
          first.context.world!.characters.find((c) => c.id === "source")
            ?.description,
        ).toBe("staged");
      }),
      Promise.resolve().then(() => {
        expect(second.context.world!.characterSchema?.types).toContain(
          "visitor",
        );
      }),
      first.context.services!.call({
        pluginId: "service",
        name: "retain",
        contract: "test.retain@1",
        input: {},
      }),
    ]);
    expect([...recorder].sort()).toEqual(["character-producer", "producer"]);
    (
      first.context.world!.characters.find((c) => c.id === "source") as {
        description: string;
      }
    ).description = "local";
    expect(
      second.context.world!.characters.find((c) => c.id === "source")
        ?.description,
    ).toBe("staged");
    recorder.clear();
    first.close();
    second.close();
    expect(() => first.context.world!.characters).toThrow();
    expect(() => retainedService!.characterSchema).toThrow();
    expect(recorder.size).toBe(0);
  });

  it.each(["characters", "characterSchema"] as const)(
    "keeps concurrent service observations scoped and cancels retained %s facades",
    async (property) => {
      const f = await fixture();
      const registry = services();
      let acquired = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const retained: WorldModelView[] = [];
      registry.register("service", {
        name: "concurrent",
        contract: "test.concurrent@1",
        input: z.object({}),
        output: z.unknown(),
        handler: async (_args, ctx) => {
          const world = ctx.world;
          retained.push(world);
          if (++acquired === 2) release();
          await ready;
          return world[property];
        },
      });
      const recorders = [new Set<string>(), new Set<string>()];
      const calls = await Promise.all(
        recorders.map(async (recorder, index) => {
          const upstream = [
            {
              runId: `invocation-${index}`,
              runtimeId: producer.name,
              proposal: property === "characters" ? character() : schema(),
            },
          ];
          const world = await createWorldModelView(
            f.store,
            SESSION,
            upstream.map((w) => w.proposal),
            [],
            undefined,
            undefined,
            { upstream, recorder },
          );
          const controller = new AbortController();
          const call = createToolExecutionContext(
            {
              sessionId: SESSION,
              turnId: "turn",
              pluginId: "observer",
              runtimeId: "observer/read",
              world,
              services: registry,
              signal: controller.signal,
            },
            f.store,
          );
          return { ...call, controller };
        }),
      );
      expect(recorders.map((r) => [...r])).toEqual([[], []]);
      await Promise.all(
        calls.map((call) =>
          call.context.services!.call({
            pluginId: "service",
            name: "concurrent",
            contract: "test.concurrent@1",
            input: {},
          }),
        ),
      );
      expect(recorders.map((r) => [...r])).toEqual([
        ["invocation-0"],
        ["invocation-1"],
      ]);
      for (const call of calls) call.controller.abort(new Error("cancelled"));
      for (const recorder of recorders) recorder.clear();
      for (const view of retained) expect(() => view[property]).toThrow();
      for (const call of calls) {
        expect(() => call.context.world![property]).toThrow();
        call.close();
      }
      expect(recorders.map((r) => [...r])).toEqual([[], []]);
    },
  );

  it.each(
    (["run", "delegate"] as const).flatMap((route) =>
      [false, true].flatMap((fail) =>
        [false, true].map((brief) => ({ route, fail, brief })),
      ),
    ),
  )(
    "keeps $route children committed-only, child failure: $fail, parent world brief: $brief",
    async ({ route, fail, brief }) => {
      let childSaw: unknown;
      let parentBrief = "A constant brief";
      let answer: SubagentResult | undefined;
      const briefTool = tool({
        name: "parent-brief",
        description: "Prepare a brief from the parent world",
        annotations: { readOnly: true },
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          parentBrief = ctx.world!.characters.find(
            (c) => c.id === "source",
          )!.description!;
          return { brief: parentBrief };
        },
      });
      const childTool = tool({
        name: "child-world",
        description: "Read committed world",
        annotations: { readOnly: true },
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          childSaw = ctx.world!.characters.find(
            (c) => c.id === "source",
          )?.description;
          return { description: childSaw };
        },
      });
      let childCalls = 0;
      let parentCalls = 0;
      const llm: LLMAdapter = {
        generate: async (request) => {
          if (request.tools?.some((t) => t.name === "delegate")) {
            const call = parentCalls++;
            if (brief && call === 0) return toolCall("parent-brief", {});
            if (call === (brief ? 1 : 0))
              return toolCall("delegate", {
                target: { contract: "test.actor@1" },
                brief: parentBrief,
              });
            return prose("Parent complete");
          }
          if (childCalls++ === 0) return toolCall("child-world", {});
          if (fail) throw new Error("child failed");
          return prose("Child complete");
        },
      };
      const actor = fn(
        "child",
        {
          runtimeType: "agent",
          stage: "narrative",
          trigger: { type: "manual" },
          subagentOnly: true,
          outputContract: "test.actor@1",
          tools: { builtin: ["child-world"] },
        },
        "actor",
      );
      const reader = fn(
        "read",
        route === "delegate"
          ? {
              runtimeType: "agent",
              tools: { builtin: ["delegate", "parent-brief"] },
            }
          : {},
      );
      const f = await fixture({ tools: [childTool, briefTool], deps: { llm } });
      const r = await f.execute([producer, story, reader, actor], {
        [producer.name]: async () => writes(character()),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          answer = await ctx.agents!.run({
            target: { contract: "test.actor@1" },
            brief: brief
              ? (ctx.world!.characters.find((c) => c.id === "source")
                  ?.description ?? "")
              : parentBrief,
          });
          return ok();
        },
      });
      expect(childSaw).toBe("original");
      if (route === "run") expect(answer?.ok).toBe(!fail);
      else {
        const delegated = r
          .resultOf(reader)
          .toolCalls.find((t) => t.toolName === "delegate");
        if (fail) expect(delegated?.output).toMatchObject({ ok: false });
        else expect(delegated?.output).toEqual({ description: "original" });
      }
      expect(r.resultOf(reader).status, r.resultOf(reader).error).toBe(
        "success",
      );
      expect(r.edges(reader)).toEqual(
        brief ? [r.resultOf(producer).runId] : [],
      );
      expect(Object.keys(r.execution.commit.readDependencies ?? {})).toEqual([
        ...(brief ? [r.resultOf(reader).runId] : []),
      ]);
      expect(
        ((await r.commit(refuseProducer)).isolatedRuntimes ?? []).some(
          (r) => r.runtimeId === reader.name && r.cause === "read",
        ),
      ).toBe(brief);
    },
  );
});
