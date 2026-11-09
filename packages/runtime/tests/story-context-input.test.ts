import { describe, expect, it } from "vitest";
import type {
  InputSlot,
  LLMMessage,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import type { StoryContextValue } from "@covel/plugin-handlers-utils";
import { suspendTool, ToolRegistry } from "@covel/tools";
import { executeTurn } from "../src/execution.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { buildStoryContextInput } from "../src/turn-executor/story-context-input.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { answer, fixture, input, runtime } from "./operation-fixture.js";

const reads = {
  inject: [{ kind: "kernel", from: "story-context@1", name: "context" }],
} as const;

const provider = (
  name: string,
  storyContext: NonNullable<RuntimeManifest["storyContext"]>,
  extra: Partial<RuntimeManifest> = {},
) => runtime(name, { stage: "pre-turn", storyContext, ...extra });

function recorder(): TurnEmitter & {
  readonly events: { type: string; payload: Record<string, unknown> }[];
} {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    events,
    emit: async (type, payload) => {
      events.push({ type, payload });
    },
  };
}

const success = (
  runtimeId: string,
  output: unknown,
  runId = `run-${runtimeId}`,
): RuntimeResult => ({
  pluginId: runtimeId.split("/")[0]!,
  runtimeId,
  runId,
  turnId: "turn",
  status: "success",
  output: output as RuntimeResult["output"],
  toolCalls: [],
  durationMs: 0,
  timestamp: "now",
});

describe("story-context@1 kernel input", () => {
  it("hands pre-turn notes to function and agent readers in rank order, without an edge", async () => {
    const { store, services } = await fixture();
    const clock = provider("clock/now", {
      select: "/note",
      priority: "high",
      title: { en: "World time", zh: "世界时间" },
    });
    const omen = provider(
      "omen/sense",
      { select: "/cue" },
      { concealed: true },
    );
    const quiet = provider("quiet/check", { select: "/note" });
    const broken = provider("broken/check", { select: "/note" });
    const failing = provider("failing/check", {});
    // Only a pre-turn runtime is a provider, whatever its manifest says.
    const late = runtime("late/narrative", {
      storyContext: { title: "Late" },
    });
    const consumer = runtime("observer/consumer", {
      stage: "post-turn",
      input: reads,
    });
    const story = runtime("observer/story", {
      runtimeType: "agent",
      outputKind: "story",
      input: reads,
    });
    const seen = new Map<string, Readonly<Record<string, InputSlot>>>();
    const handlers: Record<string, FunctionHandler> = {
      [clock.name]: async () => ({
        outcome: "success",
        value: { display: "dusk", note: "Dusk of the third day." },
      }),
      [omen.name]: async () => ({
        outcome: "success",
        value: { cue: { title: "Omen", content: "A crow watches the gate." } },
      }),
      [quiet.name]: async () => ({ outcome: "success", value: { note: null } }),
      [broken.name]: async () => ({ outcome: "success", value: { note: 5 } }),
      [failing.name]: async () => {
        throw new Error("provider down");
      },
      [late.name]: async () => ({ outcome: "success", value: "Too late." }),
      [consumer.name]: async (ctx) => {
        seen.set(consumer.name, ctx.inputs ?? {});
        return { outcome: "success", value: {} };
      },
    };
    const requests: (readonly LLMMessage[])[] = [];
    const emitter = recorder();
    try {
      const execution = await executeTurn(
        input,
        [clock, omen, quiet, broken, failing, late, consumer, story],
        {
          store,
          services,
          emitter,
          llm: {
            generate: async (request) => {
              requests.push(request.messages);
              return answer();
            },
          },
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "Tell the story.",
            handler: handlers[manifest.name],
          }),
        },
      );
      const results = execution.commit.results;
      const status = (name: string) =>
        results.find((result) => result.runtimeId === name)?.status;
      // An invalid note never fails its provider.
      expect(status(broken.name)).toBe("success");
      expect(status(failing.name)).toBe("failed");
      expect(status(story.name)).toBe("success");

      const value = seen.get(consumer.name)?.context;
      expect(value).toMatchObject({
        cardinality: "one",
        source: { pluginId: "__kernel", runtimeId: "story-context@1" },
      });
      if (value?.cardinality !== "one") throw new Error("expected one slot");
      const notes = value.value as unknown as StoryContextValue;
      expect(notes).toEqual({
        items: [
          {
            title: "World time",
            content: "Dusk of the third day.",
            priority: "high",
            source: { pluginId: "clock", runtimeId: "clock/now" },
          },
          {
            title: "Omen",
            content: "A crow watches the gate.",
            priority: "normal",
            source: { pluginId: "omen", runtimeId: "omen/sense" },
          },
        ],
        omitted: [
          {
            title: "broken",
            source: { pluginId: "broken", runtimeId: "broken/check" },
            reason: "invalid",
          },
        ],
      });
      expect(Object.isFrozen(notes.items[0])).toBe(true);

      // The story agent reads the notes in its own block, once.
      const prompt = JSON.stringify(requests[0]);
      expect(prompt).toContain("<story-context>");
      expect(prompt.indexOf("Dusk of the third day.")).toBeLessThan(
        prompt.indexOf("A crow watches the gate."),
      );
      expect(prompt).not.toContain("runtime-inputs");
      expect(prompt).not.toContain("Too late.");

      // Each reader depends on the providers whose notes it received.
      const runOf = (name: string) =>
        results.find((result) => result.runtimeId === name)!.runId;
      for (const reader of [consumer.name, story.name])
        expect(
          [
            ...(execution.commit.readDependencies?.[runOf(reader)] ?? []),
          ].sort(),
        ).toEqual([runOf(clock.name), runOf(omen.name)].sort());

      // Each reader's trace lists the notes; the concealed one by title only.
      const traces = emitter.events.filter(
        (event) => event.type === "story-context.selected",
      );
      expect(traces.map((event) => event.payload.runtimeId).sort()).toEqual(
        [consumer.name, story.name].sort(),
      );
      expect(traces[0]?.payload).toMatchObject({
        budgetTokens: 3_000,
        included: [
          {
            title: "World time",
            pluginId: "clock",
            runtimeId: "clock/now",
            tokens: expect.any(Number),
          },
          { title: "Omen" },
        ],
        omitted: [
          {
            title: "broken",
            pluginId: "broken",
            runtimeId: "broken/check",
            reason: "invalid",
          },
        ],
      });
      expect(JSON.stringify(traces)).not.toContain("crow");
    } finally {
      await store.close();
    }
  });

  it("freezes the notes into a suspended story's continuation", async () => {
    const { store, services } = await fixture();
    const clock = provider("clock/now", { title: "World time" });
    const story = runtime("observer/story", {
      runtimeType: "agent",
      outputKind: "story",
      input: reads,
      tools: { builtin: ["suspend"] },
    });
    const tools = new ToolRegistry();
    tools.registerBuiltin(suspendTool);
    const toolExecutor = createToolExecutor({
      store,
      findTool: (name, context) => tools.find(name, context.pluginId),
      getToolSource: (name) => tools.source(name),
    });
    try {
      const execution = await executeTurn(input, [clock, story], {
        store,
        services,
        toolExecutor,
        llm: {
          generate: async () => ({
            content: null,
            toolCalls: [
              {
                id: "ask",
                name: "suspend",
                arguments: JSON.stringify({
                  reason: "Which gate?",
                  fields: [{ type: "text", name: "gate", label: "Gate" }],
                }),
              },
            ],
            finishReason: "tool_calls" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "Tell the story.",
          handler: async () => ({ outcome: "success", value: "Dusk." }),
        }),
      });
      expect(
        execution.commit.results.find(
          (result) => result.runtimeId === story.name,
        )?.status,
      ).toBe("suspended");
      const [suspension] = execution.commit.suspensions ?? [];
      expect(suspension?.pendingContinuation.inputSlots?.context).toMatchObject(
        {
          value: {
            items: [{ title: "World time", content: "Dusk." }],
            omitted: [],
          },
        },
      );
    } finally {
      await toolExecutor.close();
      await store.close();
    }
  });

  it("gives an empty value and no block when nothing contributes", async () => {
    const { store, services } = await fixture();
    const consumer = runtime("observer/consumer", {
      stage: "post-turn",
      input: reads,
    });
    const story = runtime("observer/story", {
      runtimeType: "agent",
      outputKind: "story",
      input: reads,
    });
    let seen: InputSlot | undefined;
    const requests: (readonly LLMMessage[])[] = [];
    const emitter = recorder();
    try {
      await executeTurn(input, [consumer, story], {
        store,
        services,
        emitter,
        llm: {
          generate: async (request) => {
            requests.push(request.messages);
            return answer();
          },
        },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "Tell the story.",
          handler: async (ctx) => {
            seen = ctx.inputs?.context;
            return { outcome: "success", value: {} };
          },
        }),
      });
      expect(seen).toMatchObject({ value: { items: [], omitted: [] } });
      expect(JSON.stringify(requests)).not.toContain("story-context");
      expect(
        emitter.events.some((event) => event.type === "story-context.selected"),
      ).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("budgets 10% of the story model's input window", async () => {
    const { store, services } = await fixture();
    const short = provider("a/short", { order: 1 });
    const long = provider("b/long", { order: 2 });
    const consumer = runtime("observer/consumer", {
      stage: "post-turn",
      input: reads,
    });
    let seen: StoryContextValue | undefined;
    const handlers: Record<string, FunctionHandler> = {
      [short.name]: async () => ({ outcome: "success", value: "Short." }),
      [long.name]: async () => ({
        outcome: "success",
        value: "A rule that is much longer than the budget. ".repeat(10),
      }),
      [consumer.name]: async (ctx) => {
        const slot = ctx.inputs?.context as
          { value: StoryContextValue } | undefined;
        seen = slot?.value;
        return { outcome: "success", value: {} };
      },
    };
    try {
      await executeTurn(input, [short, long, consumer], {
        store,
        services,
        estimator: (text) => Math.ceil(text.length / 4),
        // 1,000 input tokens less a 200-token reply leaves 800: 80 for notes.
        contextBudget: { maxInputTokens: 1_000, reservedForResponse: 200 },
        llm: {
          generate: async () => answer(),
          resolveBudget: (slot) =>
            slot === "story" ? { contextWindow: 1_000 } : undefined,
        },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: handlers[manifest.name],
        }),
      });
      expect(seen?.items.map((item) => item.content)).toEqual(["Short."]);
      expect(seen?.omitted).toEqual([
        {
          title: "b",
          source: { pluginId: "b", runtimeId: "b/long" },
          reason: "budget",
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("reads retry seeds without depending on them, and a rerun replaces its seed", () => {
    const clock = provider("clock/now", { select: "/note" });
    const omen = provider("omen/sense", {});
    const seededClock = success("clock/now", { note: "Seeded dusk." });
    const seededOmen = success("omen/sense", "Seeded omen.");
    const rerunOmen = success("omen/sense", "Fresh omen.", "run-fresh");
    const fromSeeds = buildStoryContextInput({
      results: new Map([
        [seededClock.runtimeId, seededClock],
        [seededOmen.runtimeId, seededOmen],
      ]),
      seeds: new Set([seededClock, seededOmen]),
      activeRuntimes: [clock, omen],
    });
    expect(
      (fromSeeds.value as unknown as StoryContextValue).items.map(
        (item) => item.content,
      ),
    ).toEqual(["Seeded dusk.", "Seeded omen."]);
    expect(fromSeeds.producerIds).toEqual([]);

    const rerun = buildStoryContextInput({
      results: new Map([
        [seededClock.runtimeId, seededClock],
        [rerunOmen.runtimeId, rerunOmen],
      ]),
      seeds: new Set([seededClock, seededOmen]),
      activeRuntimes: [clock, omen],
    });
    expect(
      (rerun.value as unknown as StoryContextValue).items.map(
        (item) => item.content,
      ),
    ).toEqual(["Seeded dusk.", "Fresh omen."]);
    expect(rerun.producerIds).toEqual(["run-fresh"]);
    // A provider no longer active contributes nothing.
    expect(
      buildStoryContextInput({
        results: new Map([[seededClock.runtimeId, seededClock]]),
        activeRuntimes: [omen],
      }).selection.included,
    ).toEqual([]);
  });
});
