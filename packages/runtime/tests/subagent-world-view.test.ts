import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import type { LLMAdapter, Proposal, WorldModelView } from "@covel/shared";
import { tool, z } from "@covel/tools";
import { createWorldModelView } from "../src/function-runtime/world-model-view.js";
import { createSubagentRunner } from "../src/agent-loop/subagent-runner.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { createExecutionContext } from "../src/turn-executor/execution-context.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { prose, toolCall, latch } from "./_helpers/agent-loop-fixture.js";
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
  input,
} from "./_helpers/world-read-fixture.js";

const child = fn(
  "child",
  {
    runtimeType: "agent",
    subagentOnly: true,
    trigger: { type: "manual" },
  },
  "actor",
);
const target = { contract: "test.child-world@1" };
const peekRequest = {
  pluginId: "service",
  name: "peek",
  contract: "test.peek@1",
  input: {},
};

function services() {
  return new PluginServiceRegistry({
    list: async () => ["source", "observer", "storyteller", "service", "actor"],
    ensure: async () => {},
  });
}

function viewValue(world: WorldModelView) {
  return {
    description: world.characters.find((c) => c.id === "source")?.description,
    types: world.characterSchema?.types,
  };
}

describe("sub-agent world snapshots", () => {
  it.each(
    (["run", "delegate"] as const).flatMap((route) =>
      (["success", "failure", "idle"] as const).flatMap((childOutcome) =>
        [false, true].map((changed) => ({ route, childOutcome, changed })),
      ),
    ),
  )(
    "guards accepted inherited character reads via $route (child=$childOutcome, changed=$changed)",
    async ({ route, childOutcome, changed }) => {
      const hookPipeline = createHookPipeline();
      hookPipeline.register<{ proposal: Proposal }>({
        id: "rewrite-producer",
        pluginId: producer.pluginId,
        event: "PreStateCommit",
        handler: async (_ctx, { proposal }) => ({
          action: "continue",
          replace: {
            proposal:
              changed &&
              proposal.type === "character.upsert" &&
              proposal.source.runtimeId === producer.name
                ? {
                    ...proposal,
                    payload: { ...proposal.payload, description: "rewritten" },
                  }
                : proposal,
          },
        }),
      });
      let childCalls = 0;
      let parentCalls = 0;
      let childEvidence = "";
      const llm: LLMAdapter = {
        generate: async (request) => {
          if (request.tools?.some((t) => t.name === "delegate")) {
            switch (parentCalls++) {
              case 0:
                return toolCall("delegate", {
                  target,
                  brief: "A constant brief",
                });
              case 1:
                return toolCall("stage-character", {
                  id: "source",
                  description: "consumer",
                  expectedVersion: 2,
                });
              default:
                return prose("Parent complete");
            }
          }
          if (childOutcome === "idle") return prose("Child complete");
          if (childCalls++ === 0)
            return toolCall("get-character", { id: "source" });
          childEvidence = JSON.stringify(
            request.messages.filter((m) => m.role === "tool"),
          );
          if (childOutcome === "failure")
            throw new Error("child failed after reading");
          return prose("Child complete");
        },
      };
      const actor = {
        ...child,
        outputContract: target.contract,
        tools: { builtin: ["get-character"] },
      };
      const reader = fn(
        "read",
        route === "delegate"
          ? {
              runtimeType: "agent",
              tools: { builtin: ["delegate", "stage-character"] },
            }
          : {},
      );
      const f = await fixture({ deps: { llm, hookPipeline } });
      const r = await f.execute([producer, story, reader, actor], {
        [producer.name]: async () => writes(character("source", "staged", 1)),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          const result = await ctx.agents!.run({
            target,
            brief: "A constant brief",
          });
          expect(result.ok).toBe(childOutcome !== "failure");
          return writes(character("source", "consumer", 2));
        },
      });
      expect(r.resultOf(reader).status).toBe("success");
      if (childOutcome !== "idle") expect(childEvidence).toContain("staged");
      expect(r.edges(reader)).toEqual(
        childOutcome === "success" ? [r.resultOf(producer).runId] : [],
      );
      const outcome = await r.commit();
      const conflicts = childOutcome === "success" && changed;
      expect(outcome.status).toBe("committed");
      expect(outcome.failedProposals.map((failure) => failure.code)).toEqual(
        conflicts ? ["conflict"] : [],
      );
      expect(await f.store.getCharacter(SESSION, "source")).toMatchObject({
        description: conflicts ? "rewritten" : "consumer",
        version: conflicts ? 2 : 3,
      });
      expect(
        (await f.store.listMessages(SESSION)).map((m) => m.content),
      ).toContain("The story continues.");
      expect(JSON.stringify(r.execution.result)).not.toMatch(
        /preconditions|fingerprint|readBaselines/,
      );
    },
  );

  it.each([
    "get-character",
    "list-characters",
    "plugin-tool",
    "direct-service",
    "imported-service",
    "nested-service",
    "idle",
    "dimensions",
  ])(
    "uses the admitted world through %s with property-level attribution",
    async (surface) => {
      const registry = services();
      let serviceCalls = 0;
      let toolCalls = 0;
      let retainedTool: WorldModelView | undefined;
      let retainedService: WorldModelView | undefined;
      registry.register("service", {
        name: "peek",
        contract: "test.peek@1",
        access: "read",
        modelFacing: true,
        description: "Read the invocation world",
        input: z.object({}),
        output: z.unknown(),
        handler: async (_args, ctx) => {
          serviceCalls++;
          retainedService = ctx.world;
          return viewValue(ctx.world);
        },
      });
      registry.register("service", {
        name: "nested",
        contract: "test.nested@1",
        access: "read",
        modelFacing: true,
        description: "Read through a nested service",
        input: z.object({}),
        output: z.unknown(),
        handler: async (_args, ctx) => ctx.services.call(peekRequest),
      });
      const read = tool({
        name: "child-peek",
        description: "Read the child world",
        annotations: { readOnly: true },
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          toolCalls++;
          retainedTool = ctx.world;
          if (surface === "direct-service")
            return ctx.services!.call(peekRequest);
          if (surface === "idle") return { acquired: Boolean(ctx.world) };
          if (surface === "dimensions")
            return {
              dimensions: ctx.world!.dimensions,
              seats: ctx.world!.seats,
              world: ctx.world!.worldRecord,
            };
          return viewValue(ctx.world!);
        },
      });
      const name =
        surface === "imported-service" || surface === "nested-service"
          ? "read-world"
          : surface === "get-character" || surface === "list-characters"
            ? surface
            : read.name;
      let modelCalls = 0;
      let modelEvidence = "";
      const llm: LLMAdapter = {
        generate: async (request) => {
          if (modelCalls++ === 0)
            return toolCall(
              name,
              name === "get-character" ? { id: "source" } : {},
            );
          modelEvidence = JSON.stringify(
            request.messages.filter((m) => m.role === "tool"),
          );
          return prose("Child complete");
        },
      };
      const actor = {
        ...child,
        outputContract: target.contract,
        tools:
          surface === "imported-service" || surface === "nested-service"
            ? {
                services: [
                  {
                    contract:
                      surface === "nested-service"
                        ? "test.nested@1"
                        : "test.peek@1",
                    name,
                  },
                ],
              }
            : surface === "plugin-tool"
              ? { plugin: [name] }
              : { builtin: [name] },
      };
      const reader = fn("read");
      const f = await fixture({
        tools: [read],
        deps: { llm, services: registry },
      });
      const r = await f.execute([producer, story, reader, actor], {
        [producer.name]: async () => writes(schema(), character()),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          const result = await ctx.agents!.run({
            target,
            brief: "A constant safe brief",
          });
          expect(result.ok).toBe(true);
          return ok();
        },
      });
      expect(modelCalls).toBe(2);
      const observes = !["idle", "dimensions"].includes(surface);
      if (observes) expect(modelEvidence).toContain("staged");
      if (surface.endsWith("service") || surface === "plugin-tool")
        expect(modelEvidence).toContain("visitor");
      expect(r.edges(reader)).toEqual(
        observes ? [r.resultOf(producer).runId] : [],
      );
      expect(serviceCalls).toBe(surface.endsWith("service") ? 1 : 0);
      expect(toolCalls).toBe(
        ["plugin-tool", "direct-service", "idle", "dimensions"].includes(
          surface,
        )
          ? 1
          : 0,
      );
      if (retainedTool) expect(() => retainedTool!.characters).toThrow();
      if (retainedService) expect(() => retainedService!.characters).toThrow();
      expect(r.results.some((result) => result.runtimeId === actor.name)).toBe(
        false,
      );
      expect(JSON.stringify(r.execution.result)).not.toContain(
        "readDependencies",
      );
      const outcome = await r.commit(refuseProducer);
      expect(
        outcome.isolatedRuntimes?.some(
          (result) => result.runtimeId === reader.name,
        ),
      ).toBe(observes);
    },
  );

  it.each(["success", "model-failure", "invalid-output"] as const)(
    "accepts world reads and service operations only after %s",
    async (outcome) => {
      const registry = services();
      let serviceCalls = 0;
      registry.register("service", {
        name: "write",
        contract: "test.write@1",
        access: "write",
        modelFacing: true,
        description: "Record the child observation",
        input: z.object({}),
        output: z.object({ description: z.string() }),
        handler: async (_args, ctx) => {
          serviceCalls++;
          const description = viewValue(ctx.world).description!;
          expect(description).toBe("staged");
          await ctx.pluginData.set("notes", "child", description);
          return { description };
        },
      });
      let modelCalls = 0;
      const llm: LLMAdapter = {
        generate: async () => {
          if (modelCalls++ === 0) return toolCall("record-world", {});
          if (outcome === "model-failure")
            throw new Error("child failed after staging an operation");
          return prose(
            outcome === "invalid-output"
              ? "malformed output"
              : '{"answer":"accepted"}',
          );
        },
      };
      const actor = {
        ...child,
        outputContract: target.contract,
        tools: {
          services: [{ contract: "test.write@1", name: "record-world" }],
        },
      };
      const f = await fixture({ deps: { llm, services: registry } });
      const reader = fn("read");
      const handlers = {
        [producer.name]: async () => writes(character()),
        [story.name]: tell,
        [reader.name]: async (ctx: Parameters<typeof tell>[0]) => {
          const result = await ctx.agents!.run({
            target,
            brief: "A constant safe brief",
            budget: { maxSteps: 2 },
          });
          expect(result.ok).toBe(outcome === "success");
          await ctx.pluginData!.set("notes", "independent", true);
          return ok();
        },
      };
      const r = await f.execute([producer, story, reader, actor], handlers, {
        deps: {
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: manifest.name,
            handler: handlers[manifest.name],
            ...(manifest.subagentOnly
              ? {
                  outputSchema: {
                    type: "object",
                    properties: { answer: { type: "string" } },
                    required: ["answer"],
                    additionalProperties: false,
                  },
                }
              : {}),
          }),
        },
      });
      expect(serviceCalls).toBe(1);
      expect(modelCalls).toBeGreaterThanOrEqual(2);
      expect(r.resultOf(reader).status, r.resultOf(reader).error).toBe(
        "success",
      );
      expect(r.edges(reader)).toEqual(
        outcome === "success" ? [r.resultOf(producer).runId] : [],
      );
      expect(r.resultOf(reader).operations?.map((op) => op.status)).toEqual([
        outcome === "success" ? "staged" : "discarded",
      ]);
      expect((await r.commit(refuseProducer)).status).toBe("committed");
      expect(await f.notes()).toEqual(
        outcome === "success" ? {} : { independent: true },
      );
      expect(await f.notes("service")).toEqual({});
    },
  );

  it.each([
    ["memory", createMemoryStore],
    ["sqlite", () => createSqliteStore(":memory:")],
  ] as const)(
    "drops an auxiliary child reader and its writes at the real %s commit boundary",
    async (_backend, create) => {
      let modelCalls = 0;
      const f = await fixture({
        create,
        deps: {
          llm: {
            generate: async () =>
              modelCalls++ === 0
                ? toolCall("get-character", { id: "source" })
                : prose("Complete"),
          },
        },
      });
      const actor = {
        ...child,
        outputContract: target.contract,
        tools: { builtin: ["get-character"] },
      };
      const reader = fn("read");
      const unrelated = fn("unrelated");
      const r = await f.execute([producer, story, reader, unrelated, actor], {
        [producer.name]: async () => writes(character()),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          expect(
            (await ctx.agents!.run({ target, brief: "Constant" })).ok,
          ).toBe(true);
          await ctx.pluginData!.set("notes", "derived", true);
          return writes(character("derived", "derived", 1));
        },
        [unrelated.name]: async (ctx) => {
          await ctx.pluginData!.set("notes", "unrelated", true);
          return ok();
        },
      });
      expect(modelCalls).toBe(2);
      expect(r.execution.commit.readDependencies).toEqual({
        [r.resultOf(reader).runId]: [r.resultOf(producer).runId],
      });
      expect((await r.commit(refuseProducer)).isolatedRuntimes).toHaveLength(2);
      expect(await f.notes()).toEqual({ unrelated: true });
      expect(
        (await f.store.listCharacters(SESSION)).map((c) => [
          c.description,
          c.version,
        ]),
      ).toEqual([
        ["original", 1],
        ["original", 1],
      ]);
      expect(
        (await f.store.listMessages(SESSION)).map((m) => m.content),
      ).toContain("The story continues.");
    },
  );
  it.each(["story", "setup", "no-story"] as const)(
    "preserves the %s unit commit failure domain for child reads",
    async (kind) => {
      let calls = 0;
      const f = await fixture({
        deps: {
          llm: {
            generate: async () =>
              calls++ % 2 === 0
                ? toolCall("list-characters", {})
                : prose("Complete"),
          },
        },
      });
      const actor = {
        ...child,
        outputContract: target.contract,
        tools: { builtin: ["list-characters"] },
      };
      const reader = fn(
        "read",
        kind === "story" ? { outputKind: "story", stage: "narrative" } : {},
      );
      const setup = fn("setup", {
        stage: "setup",
        trigger: { type: "manual" },
      });
      if (kind === "setup")
        await f.store.updateSession(SESSION, {
          setupRuntimes: {
            [setup.name]: {
              state: "done",
              resolution: "completed",
              generation: 1,
              attempts: 1,
              completedAt: "2026-10-31",
              pluginVersion: "0.0.0",
            },
          },
          updatedAt: "2026-10-31",
        });
      const r = await f.execute(
        [producer, reader, ...(kind === "setup" ? [story, setup] : []), actor],
        {
          [producer.name]: async () => writes(character()),
          [story.name]: tell,
          [setup.name]: async () => ok(),
          [reader.name]: async (ctx) => {
            for (let i = 0; i < 2; i++)
              expect(
                (
                  await ctx.agents!.run({
                    target,
                    brief: "Constant safe brief",
                  })
                ).ok,
              ).toBe(true);
            if (kind === "setup")
              await ctx.recursiveCall({
                manualTrigger: { runtimeId: setup.name },
              });
            await ctx.pluginData!.set("notes", "read", true);
            return kind === "story" ? tell(ctx) : ok();
          },
        },
      );
      expect(calls).toBe(4);
      expect(r.edges(reader)).toEqual([r.resultOf(producer).runId]);
      expect((await r.commit(refuseProducer)).status).toBe(
        kind === "no-story" ? "failed" : "committed",
      );
      expect(await f.notes()).toEqual(
        kind === "no-story" ? {} : { read: true },
      );
      const traces = await f.store.queryTraceEvents(SESSION, {
        types: ["read-dependency.kept"],
      });
      expect(traces).toHaveLength(kind === "no-story" ? 0 : 1);
      if (kind !== "no-story")
        expect(traces[0]?.payload).toMatchObject({
          runId: r.resultOf(reader).runId,
          producerRunId: r.resultOf(producer).runId,
        });
    },
  );

  it.each([false, true])(
    "inherits own pending world writes once while keeping child plugin data committed, same package: %s",
    async (samePackage) => {
      const actorPlugin = samePackage ? "observer" : "actor";
      let calls = 0;
      const read = tool({
        name: "child-read",
        description: "Read child data",
        annotations: { readOnly: true },
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          expect(
            ctx.world!.characters.find((c) => c.id === "derived"),
          ).toMatchObject({ description: "own pending", version: 2 });
          expect(ctx.pendingProposals).toEqual([]);
          expect(await ctx.store!.getPluginData("notes", "pending")).toBeNull();
          expect(
            await ctx.store!.getPluginData("notes", "committed"),
          ).toMatchObject({ value: "actor data" });
          return { description: "own pending" };
        },
      });
      const f = await fixture({
        tools: [read],
        deps: {
          llm: {
            generate: async () =>
              calls++ === 0 ? toolCall("child-read", {}) : prose("Complete"),
          },
        },
      });
      await f.store.setPluginData({
        id: "actor-row",
        sessionId: SESSION,
        pluginId: actorPlugin,
        namespace: "notes",
        key: "committed",
        value: "actor data",
        createdAt: "2026-10-31",
        updatedAt: "2026-10-31",
      });
      const actor = {
        ...child,
        pluginId: actorPlugin,
        name: `${actorPlugin}/child`,
        outputContract: target.contract,
        tools: { builtin: [read.name] },
      };
      const reader = fn("read", { tools: { builtin: ["stage-character"] } });
      const r = await f.execute([story, reader, actor], {
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          await ctx.pluginData!.set("notes", "pending", "parent private data");
          await ctx.tools!.call("stage-character", {
            id: "derived",
            description: "own pending",
            expectedVersion: 1,
          });
          expect(
            (await ctx.agents!.run({ target, brief: "Constant safe brief" }))
              .ok,
          ).toBe(true);
          return ok();
        },
      });
      expect(calls).toBe(2);
      expect(r.edges(reader)).toEqual([]);
      expect(
        r
          .resultOf(reader)
          .pendingProposals?.filter((p) => p.type === "character.upsert"),
      ).toHaveLength(1);
      expect((await r.commit()).status).toBe("committed");
      expect(
        (await f.store.listCharacters(SESSION)).find((c) => c.id === "derived"),
      ).toMatchObject({ description: "own pending", version: 2 });
    },
  );
  it.each(["success", "cancelled", "deadline", "load-failure"] as const)(
    "keeps a supplied world without a child store and isolates %s exits",
    async (exit) => {
      const f = await fixture();
      const recorder = new Set(["parent-read"]);
      const upstream = [
        {
          runId: "character-producer",
          runtimeId: producer.name,
          proposal: character(),
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
      let retained: WorldModelView | undefined;
      let observations = 0;
      const peek = tool({
        name: "peek-child",
        description: "Read an inherited character",
        annotations: { readOnly: true },
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          retained = ctx.world;
          observations++;
          expect(
            ctx.world!.characters.find((c) => c.id === "source")?.description,
          ).toBe("staged");
          return { description: "staged" };
        },
      });
      const actor = {
        ...child,
        outputContract: target.contract,
        tools: { builtin: [peek.name] },
      };
      const runner = createSubagentRunner({ activeRuntimes: [actor] });
      const abort = new AbortController();
      let modelCalls = 0;
      const startedAt = Date.now();
      const result = await runner.run({
        caller: { pluginId: "observer", runtimeId: "observer/read", depth: 0 },
        request: { target: { contract: target.contract }, brief: "Constant" },
        world,
        input,
        parentCallId: "parent-run",
        parentSignal: abort.signal,
        parentDeadline: startedAt + 60_000,
        executionContext: createExecutionContext(input),
        deps: {
          llm: {
            generate: async () =>
              modelCalls++ === 0 ? toolCall(peek.name, {}) : prose("Complete"),
          },
          toolExecutor: createToolExecutor({
            findTool: (name) => (name === peek.name ? peek : undefined),
          }),
          loadRuntime: async (manifest) => {
            if (exit === "load-failure")
              throw new Error("provider unavailable");
            return { manifest, promptTemplate: "Child" };
          },
          emitter: {
            sessionId: SESSION,
            turnId: input.turnId,
            emit: async (type) => {
              if (type !== "subagent.completed") return;
              if (exit === "cancelled") abort.abort(new Error("caller ended"));
              if (exit === "deadline")
                vi.spyOn(Date, "now").mockReturnValue(startedAt + 60_001);
            },
          },
        },
      });
      expect(modelCalls).toBe(exit === "load-failure" ? 0 : 2);
      expect(observations).toBe(exit === "load-failure" ? 0 : 1);
      expect(result.ok).toBe(exit === "success");
      if (exit === "cancelled")
        expect(result).toMatchObject({ error: { code: "cancelled" } });
      if (exit === "deadline")
        expect(result).toMatchObject({ error: { code: "timeout" } });
      if (retained) expect(() => retained!.characters).toThrow();
      expect([...recorder]).toEqual(
        exit === "success"
          ? ["parent-read", "character-producer"]
          : ["parent-read"],
      );
      expect(runner.inFlight).toBe(0);
    },
  );

  it("unions successful concurrent children without retaining failed siblings across invocations or sessions", async () => {
    const meet = latch(3);
    const schemaProducer = fn("schema", { stage: "pre-turn" }, "source");
    const observations: string[] = [];
    const peek = tool({
      name: "concurrent-world",
      description: "Read one world property",
      annotations: { readOnly: true },
      parameters: z.object({
        property: z.enum(["characters", "characterSchema"]),
      }),
      execute: async ({ property }, ctx) => {
        if (property === "characters")
          expect(
            ctx.world!.characters.find((c) => c.id === "source")?.description,
          ).toBe("staged");
        else expect(ctx.world!.characterSchema?.types).toContain("visitor");
        observations.push(property);
        await meet();
        return { observed: property };
      },
    });
    const counts = new Map<string, number>();
    const f = await fixture({
      tools: [peek],
      deps: {
        llm: {
          generate: async ({ messages }) => {
            const brief = String(
              messages.find((m) => m.role === "user")?.content,
            );
            const count = counts.get(brief) ?? 0;
            counts.set(brief, count + 1);
            if (count === 0)
              return toolCall(peek.name, {
                property:
                  brief === "failed schema" ? "characterSchema" : "characters",
              });
            if (brief === "failed schema") throw new Error("failed sibling");
            return prose("Complete");
          },
        },
      },
    });
    const actor = {
      ...child,
      outputContract: target.contract,
      tools: { builtin: [peek.name] },
    };
    const reader = fn("read");
    const first = await f.execute(
      [producer, schemaProducer, story, reader, actor],
      {
        [producer.name]: async () => writes(character()),
        [schemaProducer.name]: async () => writes(schema()),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          const results = await Promise.all(
            ["successful first", "failed schema", "successful second"].map(
              (brief) => ctx.agents!.run({ target, brief }),
            ),
          );
          expect(results.map((r) => r.ok)).toEqual([true, false, true]);
          return ok();
        },
      },
    );
    expect(observations.sort()).toEqual([
      "characterSchema",
      "characters",
      "characters",
    ]);
    expect([...counts.values()]).toEqual([2, 2, 2]);
    expect(first.edges(reader)).toEqual([first.resultOf(producer).runId]);
    // Losing the failed child's schema producer does not discard its caller.
    expect(
      (
        await first.commit((p) =>
          p.source.runtimeId === schemaProducer.name
            ? "schema refused"
            : undefined,
        )
      ).isolatedRuntimes?.some((r) => r.runtimeId === reader.name),
    ).toBe(false);
    for (const sessionId of [SESSION, "another-session"]) {
      if (sessionId !== SESSION)
        await f.store.createSession({
          id: sessionId,
          locale: "en-US",
          status: "active",
          phase: "playing",
          setupRuntimes: {},
          seats: [],
          activePlugins: ["source", "observer", "storyteller", "actor"],
          completedPlayerTurns: 0,
          createdAt: "2026-10-31",
          updatedAt: "2026-10-31",
        });
      const clean = await f.execute(
        [producer, story, reader, actor],
        {
          [producer.name]: async () => writes(character()),
          [story.name]: tell,
          [reader.name]: async () => ok(),
        },
        { input: { sessionId, turnId: `clean-${sessionId}` } },
      );
      expect(clean.edges(reader)).toEqual([]);
      expect(
        (await clean.commit(refuseProducer)).isolatedRuntimes?.some(
          (r) => r.runtimeId === reader.name,
        ),
      ).toBe(false);
    }
  });
  it.each([false, true])(
    "keeps story text and a safe notice when a successful child's operation is refused (concealed=%s)",
    async (concealed) => {
      const registry = services();
      let serviceCalls = 0;
      registry.register("service", {
        name: "write",
        contract: "test.write@1",
        access: "write",
        modelFacing: true,
        description: "Stage a world observation",
        input: z.object({ secret: z.string() }),
        output: z.object({ observed: z.string(), secret: z.string() }),
        handler: async (_args, ctx) => {
          serviceCalls++;
          const observed = ctx.world.characters.find(
            (c) => c.id === "source",
          )?.description;
          expect(observed).toBe("staged");
          await ctx.pluginData.set("notes", "child", observed!);
          return { observed: observed!, secret: "PRIVATE-SERVICE-RESULT" };
        },
      });
      let modelCalls = 0;
      const f = await fixture({
        deps: {
          services: registry,
          llm: {
            generate: async () =>
              modelCalls++ === 0
                ? toolCall("record", { secret: "PRIVATE-SERVICE-REQUEST" })
                : prose("Complete"),
          },
        },
      });
      const actor = {
        ...child,
        concealed,
        outputContract: target.contract,
        tools: { services: [{ contract: "test.write@1", name: "record" }] },
      };
      const r = await f.execute([producer, story, actor], {
        [producer.name]: async () => writes(character()),
        [story.name]: async (ctx) => {
          expect(
            (await ctx.agents!.run({ target, brief: "Constant safe brief" }))
              .ok,
          ).toBe(true);
          return tell(ctx);
        },
      });
      expect(serviceCalls).toBe(1);
      expect(modelCalls).toBe(2);
      expect(r.edges(story)).toEqual([r.resultOf(producer).runId]);
      const outcome = await r.commit((p) =>
        p.source.pluginId === "service" ? "PRIVATE-SERVICE-ERROR" : undefined,
      );
      expect(outcome.status).toBe("committed");
      expect(await f.notes("service")).toEqual({});
      const savedStories = await f.store.listMessages(SESSION);
      expect(
        savedStories.find(
          (message) => message.content === "The story continues.",
        )?.metadata,
      ).toMatchObject({ operationFailures: { count: 1 } });
      expect(outcome.operationFailureMessages).toEqual([
        {
          messageId: savedStories.find(
            (message) => message.content === "The story continues.",
          )!.id,
          count: 1,
        },
      ]);
      expect(
        (await f.store.listMessages(SESSION)).map((m) => m.content),
      ).toContain("The story continues.");
      const publicArtifacts = JSON.stringify([
        savedStories.map((message) => message.metadata),
        outcome.operationFailureMessages,
      ]);
      for (const secret of [
        "PRIVATE-SERVICE-REQUEST",
        "PRIVATE-SERVICE-RESULT",
        "PRIVATE-SERVICE-ERROR",
      ])
        expect(publicArtifacts).not.toContain(secret);
      expect(outcome.operations).toEqual([
        expect.objectContaining({
          contract: "test.write@1",
          status: "failed",
          reason: "rejected",
        }),
      ]);
    },
  );
  it("discards a saved auxiliary suspension whose only world read came from a successful child", async () => {
    let calls = 0;
    const f = await fixture({
      deps: {
        llm: {
          generate: async () =>
            calls++ === 0
              ? toolCall("get-character", { id: "source" })
              : prose("Complete"),
        },
      },
    });
    const actor = {
      ...child,
      outputContract: target.contract,
      tools: { builtin: ["get-character"] },
    };
    const reader = fn("read");
    const r = await f.execute([producer, story, reader, actor], {
      [producer.name]: async () => writes(character()),
      [story.name]: tell,
      [reader.name]: async (ctx) => {
        expect(
          (await ctx.agents!.run({ target, brief: "Constant safe brief" })).ok,
        ).toBe(true);
        return {
          outcome: "suspended",
          reason: "Need input",
          resumeSchema: { type: "object" },
        };
      },
    });
    expect(calls).toBe(2);
    expect(r.resultOf(reader).status).toBe("suspended");
    expect(r.edges(reader)).toEqual([r.resultOf(producer).runId]);
    expect(r.execution.commit.suspensions).toHaveLength(1);
    expect((await r.commit(refuseProducer)).isolatedRuntimes).toContainEqual(
      expect.objectContaining({
        runId: r.resultOf(reader).runId,
        cause: "read",
      }),
    );
    expect(await f.store.listSuspensions(SESSION)).toEqual([]);
    expect(f.events.some((e) => e.type === "turn.suspended")).toBe(false);
    expect(
      (await f.store.listTurnResults(SESSION)).every(
        (row) => row.commitStatus !== "pending",
      ),
    ).toBe(true);
  });
});
