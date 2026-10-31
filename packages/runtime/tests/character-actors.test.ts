import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  CHARACTER_ACTOR_CONTRACT,
  storyOutputJsonSchema,
  type LLMAdapter,
  type RuntimeManifest,
  type LLMResponse,
  type SubagentResult,
} from "@covel/shared";
import { composeStory, policies } from "./_helpers/orchestration-fixture.js";
import {
  executeTurn,
  commitExecution,
  createToolExecutor,
  type ExecutionDeps,
} from "../src/index.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { createSubagentRunner } from "../src/agent-loop/subagent-runner.js";
import { createExecutionContext } from "../src/turn-executor/execution-context.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import { DelegationBudget } from "../src/orchestration/delegation-budget.js";

const actor: RuntimeManifest = {
  pluginId: "sample",
  name: "sample/actor",
  description: "Character actor",
  runtimeType: "agent",
  outputKind: "system",
  subagentOnly: true,
  outputContract: CHARACTER_ACTOR_CONTRACT,
  trigger: { type: "manual" },
};
const narrator: RuntimeManifest = {
  pluginId: "sample",
  name: "sample/story",
  description: "Story orchestrator",
  runtimeType: "function",
  outputKind: "story",
  stage: "narrative",
  outputContract: "narrative-engine@2",
};
const input = {
  sessionId: "scene",
  turnId: "turn",
  playerMessage: "private player action",
  origin: "player" as const,
  locale: "en-US",
};
const response = (value: unknown): LLMResponse => ({
  content: JSON.stringify(value),
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
});
async function storeFixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: "scene",
    status: "active",
    phase: "playing",
    locale: "en-US",
    activePlugins: ["sample"],
    seats: [],
    setupRuntimes: {},
    completedPlayerTurns: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    metadata: {
      orchestration: { turnPolicy: { pluginId: "sample", name: "ensemble" } },
    },
  });
  for (const [id, name] of [
    ["actor-a", "Mara"],
    ["actor-b", "Ivo"],
  ])
    await store.upsertCharacter({
      id: id!,
      name: name!,
      sessionId: "scene",
      type: "npc",
      version: 1,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
  await store.addMessage({
    id: "seen",
    sessionId: "scene",
    role: "assistant",
    content: "raw secret",
    metadata: {
      kind: "story",
      presentCharacterIds: ["actor-a"],
      segments: [{ kind: "narration", text: "Mara witnessed the lantern." }],
    },
    createdAt: "2026-01-01",
  });
  await store.addMessage({
    id: "unseen",
    sessionId: "scene",
    role: "assistant",
    content: "private scene",
    metadata: {
      kind: "story",
      presentCharacterIds: ["actor-b"],
      segments: [{ kind: "narration", text: "Ivo's excluded secret." }],
    },
    createdAt: "2026-01-02",
  });
  return store;
}
describe("character actor composition", () => {
  it.each(["all", "policy-missing", "actor-missing", "actor-failure"])(
    "commits one story with isolated contributions: %s",
    async (mode) => {
      const store = await storeFixture();
      const requests: string[] = [];
      const services = new PluginServiceRegistry({
        list: async () => ["sample"],
        ensure: async () => {},
      });
      if (mode !== "policy-missing")
        for (const policy of policies) services.register("sample", policy);
      const llm: LLMAdapter = {
        generate: async (params) => {
          const text = JSON.stringify(params.messages);
          requests.push(text);
          if (mode === "actor-failure" && text.includes("Ivo"))
            throw new Error("actor failed");
          return response({
            segments: [{ kind: "dialogue", text: "I am listening." }],
            intent: "private intention sentinel",
          });
        },
      };
      const deps = {
        store,
        llm,
        services,
        toolExecutor: createToolExecutor({ store, findTool: () => undefined }),
        loadRuntime: async (manifest: RuntimeManifest) => ({
          manifest,
          promptTemplate: "Respond as the selected character.",
          ...(manifest.runtimeType === "function"
            ? { handler: composeStory, outputSchema: storyOutputJsonSchema() }
            : {}),
        }),
      };
      const execution = await executeTurn(
        input,
        mode === "actor-missing" ? [narrator] : [narrator, actor],
        deps,
      );
      expect(execution.result.runtimeResults).toHaveLength(1);
      expect(execution.result.runtimeResults[0]?.status).toBe("success");
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      expect(outcome.status).toBe("committed");
      const stories = (await store.listMessages("scene")).filter(
        (row) => (row.metadata as { turnId?: string })?.turnId === "turn",
      );
      expect(stories).toHaveLength(1);
      expect(JSON.stringify(stories)).not.toContain(
        "private intention sentinel",
      );
      for (const request of requests)
        expect(request).not.toMatch(
          /actor-a|actor-b|private player action|raw secret/,
        );
      const mara = requests.find(
        (request) => request.includes("Mara") && request.includes("profile"),
      );
      if (mara) {
        expect(mara).toContain("Mara witnessed the lantern");
        expect(mara).not.toContain("Ivo's excluded secret");
      }
      await store.close();
    },
  );
  it("validates same-package actor targets and caps sequential provider starts", async () => {
    const store = await storeFixture();
    let starts = 0;
    const budget = new DelegationBudget({
      sessionId: "scene",
      store,
      settings: { maxSubagentCalls: 1 },
    });
    const runner = createSubagentRunner({
      activeRuntimes: [actor],
      delegation: budget,
    });
    const deps = {
      store,
      delegation: budget,
      llm: {
        generate: async () => {
          starts++;
          return response({ segments: [{ kind: "action", text: "Waits." }] });
        },
      },
      loadRuntime: async () => ({ manifest: actor, promptTemplate: "Actor" }),
    };
    const run = (request: unknown): Promise<SubagentResult> =>
      runner.run({
        caller: { pluginId: "sample", runtimeId: "sample/story", depth: 0 },
        request,
        input,
        deps,
        executionContext: createExecutionContext(input),
        parentCallId: "parent",
      });
    expect(
      await run({ target: { runtimeId: actor.name }, brief: "Speak" }),
    ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(
      await run({
        target: { runtimeId: actor.name },
        characterId: "actor-a",
        brief: "Speak",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await run({
        target: { contract: CHARACTER_ACTOR_CONTRACT },
        characterId: "actor-a",
        brief: "Speak",
      }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(starts).toBe(1);
    await store.close();
  });
  it("atomically claims the last actor slot and never refunds failed providers", async () => {
    const store = await storeFixture();
    const budget = new DelegationBudget({
      sessionId: "scene",
      store,
      settings: { maxActors: 1, maxSubagentCalls: 2 },
    });
    const settled = vi.fn();
    const runner = createSubagentRunner({
      activeRuntimes: [actor],
      delegation: budget,
      onSettled: settled,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starts = 0;
    const deps = {
      store,
      delegation: budget,
      llm: {
        generate: async () => {
          starts++;
          await gate;
          throw new Error("Provider failure");
        },
      },
      loadRuntime: async () => ({
        manifest: { ...actor, maxRetries: 0 },
        promptTemplate: "Actor",
      }),
    };
    const run = (characterId: string, extras = {}) =>
      runner.run({
        caller: { pluginId: "sample", runtimeId: "sample/story", depth: 0 },
        request: {
          target: { contract: CHARACTER_ACTOR_CONTRACT },
          characterId,
          brief: "Speak",
          ...extras,
        },
        input,
        deps,
        executionContext: createExecutionContext(input),
        parentCallId: "parent",
      });
    expect(await run("actor-a", { data: {} })).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
    expect(await run("missing")).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
    expect(budget.snapshot().calls).toBe(0);
    const first = run("actor-a");
    await vi.waitFor(() => expect(starts).toBe(1));
    expect(await run("actor-b")).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(settled).not.toHaveBeenCalled();
    release();
    expect(await first).toMatchObject({ ok: false });
    expect(budget.snapshot()).toMatchObject({
      calls: 1,
      actorIds: ["actor-a"],
    });
    expect(await run("actor-b")).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(await run("actor-a")).toMatchObject({ ok: false });
    expect(await run("actor-a")).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(starts).toBe(2);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(runner.inFlight).toBe(0);
    await store.close();
  });
  it.each([{ maxActors: 0 }, { maxSubagentCalls: 0 }])(
    "zero allowance starts no provider: %j",
    async (settings) => {
      const store = await storeFixture();
      const loadRuntime = vi.fn(async () => ({
        manifest: actor,
        promptTemplate: "Actor",
      }));
      const budget = new DelegationBudget({
        sessionId: "scene",
        store,
        settings,
      });
      const runner = createSubagentRunner({
        activeRuntimes: [actor],
        delegation: budget,
      });
      const result = await runner.run({
        caller: { pluginId: "sample", runtimeId: "sample/story", depth: 0 },
        request: {
          target: { contract: CHARACTER_ACTOR_CONTRACT },
          characterId: "actor-a",
          brief: "Speak",
        },
        input,
        deps: {
          store,
          loadRuntime,
          llm: { generate: async () => response({}) },
        },
        executionContext: createExecutionContext(input),
        parentCallId: "parent",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      expect(loadRuntime).not.toHaveBeenCalled();
      expect(budget.snapshot().calls).toBe(0);
      await store.close();
    },
  );
  it("parallel calls race for a single cumulative call without queuing", async () => {
    const store = await storeFixture();
    const budget = new DelegationBudget({
      sessionId: "scene",
      store,
      settings: { maxSubagentCalls: 1 },
    });
    const runner = createSubagentRunner({
      activeRuntimes: [actor],
      delegation: budget,
    });
    const loadRuntime = vi.fn(async () => ({
      manifest: actor,
      promptTemplate: "Actor",
    }));
    const results = await Promise.all(
      ["actor-a", "actor-b"].map((characterId) =>
        runner.run({
          caller: { pluginId: "sample", runtimeId: "sample/story", depth: 0 },
          request: {
            target: { contract: CHARACTER_ACTOR_CONTRACT },
            characterId,
            brief: "Speak",
          },
          input,
          deps: {
            store,
            loadRuntime,
            llm: {
              generate: async () =>
                response({ segments: [{ kind: "action", text: "Waits." }] }),
            },
          },
          executionContext: createExecutionContext(input),
          parentCallId: "parent",
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { error: { code: "unavailable" } },
    ]);
    expect(loadRuntime).toHaveBeenCalledTimes(1);
    await store.close();
  });

  it.each(["execute", "pipeline"])(
    "shares the allowance with recursive function calls through %s",
    async (entry) => {
      const store = await storeFixture();
      await store.updateSession("scene", {
        metadata: { orchestration: { maxSubagentCalls: 1 } },
      });
      const leaf: RuntimeManifest = {
        pluginId: "sample",
        name: "sample/leaf",
        description: "Recursive helper",
        runtimeType: "function",
        outputKind: "system",
        trigger: { type: "manual" },
      };
      const replies: SubagentResult[] = [];
      let starts = 0;
      const deps: ExecutionDeps = {
        store,
        llm: {
          generate: async () => {
            starts++;
            return response({ segments: [{ kind: "action", text: "Waits." }] });
          },
        },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "Actor",
          ...(manifest === actor
            ? {}
            : {
                handler: async (ctx) => {
                  replies.push(
                    await ctx.agents!.run({
                      target: { contract: CHARACTER_ACTOR_CONTRACT },
                      characterId: "actor-a",
                      brief: "Speak",
                    }),
                  );
                  if (manifest === narrator)
                    await ctx.recursiveCall({
                      manualTrigger: { runtimeId: leaf.name },
                    });
                  return {
                    outcome: "success" as const,
                    value: { narrativeOutput: "The conversation continues." },
                  };
                },
              }),
        }),
      };
      const result =
        entry === "execute"
          ? (await executeTurn(input, [narrator, leaf, actor], deps)).result
          : await runTurnPipeline(input, [narrator, leaf, actor], deps);
      expect(result.runtimeResults[0]?.status).toBe("success");
      expect(replies).toMatchObject([
        { ok: true },
        { ok: false, error: { code: "unavailable" } },
      ]);
      expect(starts).toBe(1);
      await store.close();
    },
  );
});
