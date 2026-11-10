import { describe, expect, it } from "vitest";
import type { LLMAdapter, RuntimeManifest, TurnInput } from "@covel/shared";
import type { StoryContextValue } from "@covel/plugin-handlers-utils";
import { executeTurn } from "../src/execution.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";
import { answer, fixture, input, runtime } from "./operation-fixture.js";

const reads = {
  inject: [{ kind: "kernel", from: "story-context@1", name: "context" }],
} as const;
const note = "A".repeat(4_000);
const story = (name: string, extra: Partial<RuntimeManifest> = {}) =>
  runtime(name, {
    runtimeType: "agent",
    outputKind: "story",
    input: reads,
    ...extra,
  });

async function readNotes(options: {
  readers: readonly RuntimeManifest[];
  overrides?: Partial<TurnInput>;
  resolveModel?: TurnExecutorDeps["resolveModel"];
  resolveBudget?: LLMAdapter["resolveBudget"];
  withContextBudget?: boolean;
}) {
  const { store, services } = await fixture();
  const provider = runtime("provider/notes", {
    stage: "pre-turn",
    storyContext: {},
  });
  const selections = new Map<string, Record<string, unknown>>();
  const requests = new Map<string | undefined, string>();
  const functionInputs = new Map<string, StoryContextValue>();
  const resolutions: { runtimeId: string; override: string | undefined }[] = [];
  const emitter: TurnEmitter = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    emit: async (type, payload) => {
      if (type === "story-context.selected")
        selections.set(String(payload.runtimeId), payload);
    },
  };
  try {
    const execution = await executeTurn(
      { ...input, ...options.overrides },
      [provider, ...options.readers],
      {
        store,
        services,
        emitter,
        estimator: (text) => Math.ceil(text.length / 4),
        ...(options.withContextBudget === false
          ? {}
          : {
              contextBudget: {
                maxInputTokens: 100_000,
                reservedForResponse: 2_000,
              },
            }),
        llm: {
          generate: async (request) => {
            requests.set(request.model, JSON.stringify(request.messages));
            return answer();
          },
          resolveBudget:
            options.resolveBudget ??
            ((slot) => ({
              contextWindow: slot === "small-story" ? 8_000 : 100_000,
            })),
        },
        ...(options.resolveModel
          ? {
              resolveModel: (manifest, override) => {
                resolutions.push({ runtimeId: manifest.name, override });
                return options.resolveModel?.(manifest, override);
              },
            }
          : {}),
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "Tell the story.",
          handler: async (ctx) => {
            if (manifest.name === provider.name)
              return { outcome: "success", value: note };
            const slot = ctx.inputs?.context;
            if (slot?.cardinality === "one")
              functionInputs.set(
                manifest.name,
                slot.value as unknown as StoryContextValue,
              );
            return {
              outcome: "success",
              value: { narrativeOutput: "The story continues." },
            };
          },
        }),
      },
    );
    expect(execution.commit.results.map((result) => result.status)).toEqual(
      [provider, ...options.readers].map(() => "success"),
    );
    return { selections, requests, functionInputs, resolutions };
  } finally {
    await store.close();
  }
}

describe("story-context model budget", () => {
  it.each([
    {
      name: "the declared story slot",
      manifest: { model: "small-story" },
      overrides: {},
    },
    {
      name: "a session override ahead of the declared slot",
      manifest: { model: "wide-story" },
      overrides: { runtimeModelOverrides: { "caller/story": "small-story" } },
    },
    {
      name: "a request override ahead of the session override",
      manifest: { model: "wide-story" },
      overrides: {
        runtimeModelOverrides: { "caller/story": "wide-story" },
        modelOverride: "small-story",
      },
    },
  ])("uses $name for both notes and the model request", async (testCase) => {
    const reader = story("caller/story", testCase.manifest);
    const { selections, requests } = await readNotes({
      readers: [reader],
      overrides: testCase.overrides,
    });
    // 8,000 context tokens minus 2,000 reserved for output: 600 for notes.
    expect(selections.get(reader.name)).toMatchObject({
      budgetTokens: 600,
      included: [],
      omitted: [{ reason: "budget" }],
    });
    expect([...requests.keys()]).toEqual(["small-story"]);
    expect(requests.get("small-story")).not.toContain(note);
  });

  it("uses the host's resolved target and output reserve", async () => {
    const reader = story("caller/story");
    const { selections, requests, resolutions } = await readNotes({
      readers: [reader],
      overrides: { runtimeModelOverrides: { [reader.name]: "chosen-slot" } },
      resolveModel: (_manifest, override) =>
        override === "chosen-slot" ? "small-story" : "wide-story",
      resolveBudget: (slot) => ({
        contextWindow: slot === "small-story" ? 10_000 : 100_000,
        requestedMaxOutputTokens: 4_000,
      }),
    });
    expect(selections.get(reader.name)?.budgetTokens).toBe(600);
    expect([...requests.keys()]).toEqual(["small-story"]);
    expect(resolutions).toContainEqual({
      runtimeId: reader.name,
      override: "chosen-slot",
    });
  });

  it("resolves an unnamed story model through the adapter's default", async () => {
    const reader = story("caller/story");
    const { selections, requests } = await readNotes({
      readers: [reader],
      resolveBudget: (slot) => ({
        contextWindow: slot === undefined ? 8_000 : 100_000,
      }),
    });
    expect(selections.get(reader.name)?.budgetTokens).toBe(600);
    expect([...requests.keys()]).toEqual([undefined]);
  });

  it("budgets each story reader against its own model", async () => {
    const small = story("caller/small", { model: "wide-story" });
    const wide = story("observer/wide", { model: "wide-story" });
    const { selections, requests } = await readNotes({
      readers: [wide, small],
      overrides: { runtimeModelOverrides: { [small.name]: "small-story" } },
    });
    expect(selections.get(small.name)).toMatchObject({
      budgetTokens: 600,
      included: [],
      omitted: [{ reason: "budget" }],
    });
    expect(selections.get(wide.name)).toMatchObject({
      budgetTokens: 3_000,
      included: [{ runtimeId: "provider/notes" }],
      omitted: [],
    });
    expect(requests.get("small-story")).not.toContain(note);
    expect(requests.get("wide-story")).toContain(note);
  });

  it("uses the function story's default without agent overrides", async () => {
    const reader = story("caller/story", {
      runtimeType: "function",
      model: "small-story",
    });
    const { selections, functionInputs, resolutions } = await readNotes({
      readers: [reader],
      overrides: {
        modelOverride: "wide-story",
        runtimeModelOverrides: { [reader.name]: "wide-story" },
      },
      resolveModel: (manifest, override) => override ?? manifest.model,
    });
    expect(selections.get(reader.name)?.budgetTokens).toBe(600);
    expect(functionInputs.get(reader.name)).toMatchObject({
      items: [],
      omitted: [{ reason: "budget" }],
    });
    expect(resolutions).toEqual([]);
  });

  it.each(["unknown", "unresolvable", "no-budget"])(
    "keeps the fixed cap when the story model budget is %s",
    async (mode) => {
      const reader = story("caller/story", { runtimeType: "function" });
      const { selections, functionInputs } = await readNotes({
        readers: [reader],
        withContextBudget: mode !== "no-budget",
        resolveBudget: () => {
          if (mode === "unresolvable") throw new Error("Model unavailable");
          return undefined;
        },
      });
      expect(selections.get(reader.name)?.budgetTokens).toBe(3_000);
      expect(functionInputs.get(reader.name)?.items[0]?.content).toBe(note);
    },
  );

  it.each(["function", "agent"] as const)(
    "keeps the story purpose for a %s non-story reader without a story runtime",
    async (runtimeType) => {
      const reader = runtime("observer/notes", {
        runtimeType,
        model: "wide-story",
        input: reads,
      });
      const { selections, functionInputs, requests } = await readNotes({
        readers: [reader],
        overrides: {
          modelOverride: "wide-story",
          runtimeModelOverrides: { [reader.name]: "small-story" },
        },
      });
      expect(selections.get(reader.name)?.budgetTokens).toBe(3_000);
      if (runtimeType === "function")
        expect(functionInputs.get(reader.name)?.items[0]?.content).toBe(note);
      else {
        expect([...requests.keys()]).toEqual(["small-story"]);
        expect(requests.get("small-story")).toContain(note);
      }
    },
  );
});
