import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  HandlerResult,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import { createEmitEventTool } from "@covel/tools";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { classifySetupResult } from "../src/turn-executor/setup-run.js";

const producer: RuntimeManifest = {
  description: "test",
  name: "probe/producer",
  pluginId: "probe",
  stage: "post-turn",
  runtimeType: "function",
  outputKind: "plugin",
  trigger: { type: "auto" },
};
const follower: RuntimeManifest = {
  ...producer,
  name: "probe/follower",
  trigger: { type: "event", topic: "probe.changed" },
};
const businessValue = {
  events: [{ topic: "probe.changed", data: { source: "business" } }],
  pluginData: [{ namespace: "state", key: "business", value: true }],
  statePatches: [{ table: "stats", field: "business", value: 1 }],
  interactions: [{ interactionId: "business-form", type: "form", fields: [] }],
  ui: [{ type: "business-card", id: "business" }],
  notifications: [{ message: "Business notification data" }],
  preGameDone: true,
};

describe("function business value and effect boundary", () => {
  it.each([false, true])(
    "only dispatches and commits explicit effects (publish=%s)",
    async (publish) => {
      const store = createMemoryStore();
      const runFollower = vi.fn(async (): Promise<HandlerResult> => ({
        outcome: "success",
        value: { observed: true },
      }));
      const effects = {
        events: [{ topic: "probe.changed", data: { source: "effect" } }],
        pluginData: [{ namespace: "state", key: "explicit", value: true }],
      };
      const turn = await executeTurn(
        {
          sessionId: "effect-session",
          turnId: "effect-turn",
          playerMessage: "act",
          origin: "manual",
        },
        [producer, follower],
        {
          store,
          llm: {
            generate: async () => {
              throw new Error("No model needed");
            },
          },
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "",
            handler:
              manifest.name === follower.name
                ? runFollower
                : async (): Promise<HandlerResult> => ({
                    outcome: "success",
                    value: businessValue,
                    completion: "pending",
                    ...(publish ? { effects } : {}),
                  }),
          }),
        },
      );
      const result = turn.runtimeResults.find(
        (r) => r.runtimeId === producer.name,
      )!;
      expect(result.status).toBe("success");
      expect(result.output).toEqual(businessValue);
      expect(result.canonicalValue).toEqual({ value: businessValue });
      expect(result.completion).toBe("pending");
      expect(classifySetupResult(result).doneSignal).toBe(false);
      expect(turn.pendingInputs).toBeUndefined();
      expect(runFollower).toHaveBeenCalledTimes(publish ? 1 : 0);
      expect(result.effects).toEqual(publish ? effects : undefined);
      const stored = (await store.listTurnResults("effect-session"))[0]!;
      const storedResults = stored.runtimeResults as RuntimeResult[];
      expect(storedResults[0]?.effects).toEqual(result.effects);
      expect(storedResults[0]?.output).toEqual(businessValue);

      const commit = await finalizeExecution({
        store,
        sessionId: "effect-session",
        executionContext: turn.executionContext,
        runtimes: [producer, follower],
        results: turn.runtimeResults,
        turnIds: [turn.turnId],
      });
      expect(commit.status).toBe("committed");
      expect(
        await store.getPluginData(
          "effect-session",
          "probe",
          "state",
          "business",
        ),
      ).toBeNull();
      expect(
        await store.getStateEntry("effect-session", "stats", "business"),
      ).toBeNull();
      expect(commit.events.map((event) => event.type)).not.toContain(
        "interaction.requested",
      );
      expect(commit.events.map((event) => event.type)).not.toContain(
        "ui.rendered",
      );
      expect(commit.events.map((event) => event.type)).not.toContain(
        "narrative.completed",
      );
      const explicit = await store.getPluginData(
        "effect-session",
        "probe",
        "state",
        "explicit",
      );
      if (publish) expect(explicit?.value).toBe(true);
      else expect(explicit).toBeNull();
      expect(
        commit.events.filter((event) => event.type === "event.emitted"),
      ).toHaveLength(publish ? 1 : 0);
    },
  );

  it.each([
    { ui: "invalid", expectedUi: 0 },
    { ui: [null, 42, { id: "valid-card", type: "form" }], expectedUi: 1 },
  ])(
    "ignores malformed UI effects during execution and commit",
    async ({ ui, expectedUi }) => {
      const store = createMemoryStore();
      const turn = await executeTurn(
        {
          sessionId: "ui-session",
          turnId: "ui-turn",
          playerMessage: "act",
          origin: "manual",
        },
        [producer],
        {
          store,
          llm: {
            generate: async () => {
              throw new Error("No model needed");
            },
          },
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "",
            handler: async () =>
              ({
                outcome: "success",
                value: { ready: true },
                effects: { ui },
              }) as unknown as HandlerResult,
          }),
        },
      );
      expect(turn.runtimeResults[0]?.status).toBe("success");
      const commit = await finalizeExecution({
        store,
        sessionId: "ui-session",
        executionContext: turn.executionContext,
        runtimes: [producer],
        results: turn.runtimeResults,
        turnIds: [turn.turnId],
      });
      expect(commit.status).toBe("committed");
      expect(
        commit.events.filter((event) => event.type === "ui.rendered"),
      ).toHaveLength(expectedUi);
    },
  );

  it.each(["failed", "skipped"] as const)(
    "keeps %s observation effects while stripping domain writes",
    async (outcome) => {
      const store = createMemoryStore();
      const observation = {
        jobStatus: [{ jobId: "job", state: "failed", sequence: 1 }],
        diagnostics: [{ code: "probe", message: "observed" }],
      };
      const turn = await executeTurn(
        {
          sessionId: "observed-session",
          turnId: "observed-turn",
          playerMessage: "act",
          origin: "manual",
        },
        [producer],
        {
          store,
          llm: {
            generate: async () => {
              throw new Error("No model needed");
            },
          },
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "",
            handler: async () =>
              ({
                outcome,
                ...(outcome === "failed"
                  ? { error: "blocked" }
                  : { skipReason: "cached" }),
                effects: {
                  ...observation,
                  statePatches: [{ table: "stats", field: "hp", value: 0 }],
                },
              }) as unknown as HandlerResult,
          }),
        },
      );
      const result = turn.runtimeResults[0]!;
      expect(result.status).toBe(outcome);
      expect(result.effects).toEqual(observation);
      const commit = await finalizeExecution({
        store,
        sessionId: "observed-session",
        executionContext: turn.executionContext,
        runtimes: [producer],
        results: turn.runtimeResults,
        turnIds: [turn.turnId],
      });
      expect(commit.status).toBe("committed");
      expect(
        await store.getStateEntry("observed-session", "stats", "hp"),
      ).toBeNull();
    },
  );

  it("does not retain domain effects when the success value fails its schema", async () => {
    const store = createMemoryStore();
    const turn = await executeTurn(
      {
        sessionId: "schema-session",
        turnId: "schema-turn",
        playerMessage: "act",
        origin: "manual",
      },
      [producer],
      {
        store,
        llm: {
          generate: async () => {
            throw new Error("No model needed");
          },
        },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          outputSchema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          handler: async (): Promise<HandlerResult> => ({
            outcome: "success",
            value: {},
            effects: {
              statePatches: [{ table: "stats", field: "hp", value: 0 }],
            },
          }),
        }),
      },
    );
    const result = turn.runtimeResults[0]!;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("output-schema-invalid");
    expect(result.effects).toBeUndefined();
    const commit = await finalizeExecution({
      store,
      sessionId: "schema-session",
      executionContext: turn.executionContext,
      runtimes: [producer],
      results: turn.runtimeResults,
      turnIds: [turn.turnId],
    });
    expect(commit.status).toBe("committed");
    expect(
      await store.getStateEntry("schema-session", "stats", "hp"),
    ).toBeNull();
  });

  it("commits a function tool event when declared effects.events is malformed", async () => {
    const store = createMemoryStore();
    const eventTool = createEmitEventTool({
      directory: {
        listTopics: async () => ["probe.changed"],
        validate: async () => ({ ok: true }),
      },
    });
    const eventProducer = {
      ...producer,
      tools: { builtin: ["emit-event"] },
    } as RuntimeManifest;
    const turn = await executeTurn(
      {
        sessionId: "tool-event-session",
        turnId: "tool-event-turn",
        playerMessage: "act",
        origin: "manual",
      },
      [eventProducer],
      {
        store,
        llm: {
          generate: async () => {
            throw new Error("No model needed");
          },
        },
        toolExecutor: createToolExecutor({
          findTool: (name) => (name === "emit-event" ? eventTool : undefined),
          getToolSource: () => "builtin",
          store,
        }),
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.tools!.call("emit-event", {
              topic: "probe.changed",
              data: { source: "tool" },
            });
            return {
              outcome: "success",
              value: { ready: true },
              effects: { events: {} },
            } as unknown as HandlerResult;
          },
        }),
      },
    );
    const result = turn.runtimeResults[0]!;
    expect(result.status).toBe("success");
    expect(result.effects?.events).toEqual([
      { topic: "probe.changed", data: { source: "tool" } },
    ]);
    const commit = await finalizeExecution({
      store,
      sessionId: "tool-event-session",
      executionContext: turn.executionContext,
      runtimes: [eventProducer],
      results: turn.runtimeResults,
      turnIds: [turn.turnId],
    });
    expect(commit.status).toBe("committed");
    expect(
      commit.events.filter((event) => event.type === "event.emitted"),
    ).toHaveLength(1);
  });
});
