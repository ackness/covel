import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import {
  CHARACTER_ACTOR_CONTRACT,
  defaultSessionSeats,
  type LLMAdapter,
  type LLMResponse,
  type RuntimeManifest,
  type TurnInput,
} from "@covel/shared";
import type {
  FunctionHandler,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import {
  delegateBatchTool,
  delegateTool,
  tool,
  ToolRegistry,
} from "@covel/tools";
import {
  commitExecution,
  createToolExecutor,
  executeTurn,
  refuseReleasedJobs,
} from "../src/index.js";
import {
  createSubagentRunner,
  type SubagentRunArgs,
} from "../src/agent-loop/subagent-runner.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { DelegationBudget } from "../src/orchestration/delegation-budget.js";
import { createExecutionContext } from "../src/turn-executor/execution-context.js";
import { createPluginDataVisibility } from "../src/function-runtime/upstream-plugin-data.js";
import { createWorldModelView } from "../src/function-runtime/world-model-view.js";
import { baselinesFor } from "../src/read-baselines.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

const SESSION = "sess-subagent-vis";
const NOW = "2026-11-21T00:00:00.000Z";
const LINE_SCHEMA = {
  type: "object",
  properties: { line: { type: "string" } },
  required: ["line"],
  additionalProperties: false,
} as const;

const open: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((store) => store.close()));
});

function toolCall(name: string, args: object, id = name): LLMResponse {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
    usage: { inputTokens: 5, outputTokens: 2 },
  };
}

function submitOutput(value: Record<string, unknown>): LLMResponse {
  return toolCall("submit-output", value, "submit");
}

async function createSeededStore(activePlugins: string[]) {
  const store = createMemoryStore();
  open.push(store);
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: defaultSessionSeats(),
    activePlugins,
    completedPlayerTurns: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return store;
}

describe("sub-agent pluginDataVisibility", () => {
  it.each(["delegate", "delegate-batch"] as const)(
    "lets a sub-agent write service see same-turn upstream writes and merges read deps on success via %s",
    async (route) => {
      const store = await createSeededStore(["bank", "director", "helper"]);
      await store.setPluginData({
        id: `${SESSION}:bank:wallet:gold`,
        sessionId: SESSION,
        pluginId: "bank",
        namespace: "wallet",
        key: "gold",
        value: { amount: 10 },
        createdAt: NOW,
        updatedAt: NOW,
      });

      const services = new PluginServiceRegistry({
        list: async () => ["bank", "director", "helper"],
        ensure: async () => {},
      });
      let seenByService: unknown;
      services.register("bank", {
        name: "spend",
        contract: "bank.spend@1",
        access: "write",
        modelFacing: true,
        description: "Spend gold from wallet",
        input: z.object({ cost: z.number() }),
        output: z.object({ after: z.number() }),
        handler: async ({ cost }, ctx) => {
          const current = (await ctx.pluginData.get("wallet", "gold")) as {
            amount: number;
          } | null;
          seenByService = current;
          const after = (current?.amount ?? 0) - cost;
          await ctx.pluginData.set("wallet", "gold", { amount: after });
          return { after };
        },
      });

      const bankGrant: RuntimeManifest = {
        name: "bank/grant",
        pluginId: "bank",
        description: "upstream grant",
        runtimeType: "function",
        stage: "pre-turn",
        outputKind: "system",
        trigger: { type: "auto" },
      };
      const director: RuntimeManifest = {
        name: "director/main",
        pluginId: "director",
        description: "director",
        runtimeType: "agent",
        stage: "narrative",
        outputKind: "system",
        trigger: { type: "auto" },
        tools: { builtin: [route] },
      };
      const helper: RuntimeManifest = {
        name: "helper/clerk",
        pluginId: "helper",
        description: "clerk",
        runtimeType: "agent",
        outputKind: "system",
        subagentOnly: true,
        trigger: { type: "manual" },
        outputContract: "helper.clerk@1",
        output: { schema: "output.schema.json" },
        tools: {
          services: [{ contract: "bank.spend@1", name: "spend-gold" }],
        },
      };

      let directorCalls = 0;
      let helperCalls = 0;
      const llm: LLMAdapter = {
        generate: async (req) => {
          const system = req.messages
            .filter((m) => m.role === "system")
            .map((m) => String(m.content))
            .join("\n");
          if (system.includes("DIRECTOR-PROMPT")) {
            if (directorCalls++ === 0) {
              return route === "delegate-batch"
                ? toolCall("delegate-batch", {
                    requests: [
                      {
                        target: { contract: "helper.clerk@1" },
                        brief: "Spend 7 gold",
                      },
                    ],
                  })
                : toolCall("delegate", {
                    target: { contract: "helper.clerk@1" },
                    brief: "Spend 7 gold",
                  });
            }
            return submitOutput({ narrativeOutput: "Paid at the counter." });
          }
          if (helperCalls++ === 0) {
            return toolCall("spend-gold", { cost: 7 });
          }
          return submitOutput({ line: "Spent 7 gold" });
        },
      };

      const registry = new ToolRegistry();
      registry.registerBuiltin(delegateTool);
      registry.registerBuiltin(delegateBatchTool);

      const grantHandler: FunctionHandler = async (ctx) => {
        await ctx.pluginData!.set("wallet", "gold", { amount: 50 });
        return { outcome: "success", value: {} };
      };

      const input: TurnInput = {
        origin: "player",
        sessionId: SESSION,
        turnId: "turn-1",
        logicalTurnId: "lt-1",
        playerMessage: "Buy a map",
        locale: "en-US",
      };

      const execution = await executeTurn(
        input,
        [bankGrant, director, helper],
        {
          store,
          llm,
          services,
          hookScope: {
            activePluginIds: new Set(["bank", "director", "helper"]),
          },
          toolExecutor: createToolExecutor({
            store,
            findTool: (name, context) => registry.find(name, context.pluginId),
            getToolSource: (name) => registry.source(name),
          }),
          loadRuntime: async (manifest): Promise<LoadedRuntime> => {
            if (manifest.name === bankGrant.name) {
              return { manifest, promptTemplate: "", handler: grantHandler };
            }
            if (manifest.name === director.name) {
              return { manifest, promptTemplate: "DIRECTOR-PROMPT" };
            }
            return {
              manifest,
              promptTemplate: "HELPER-PROMPT",
              outputSchema: { ...LINE_SCHEMA },
              outputContractSchema: { ...LINE_SCHEMA },
            };
          },
        },
      );

      const grantResult = execution.commit.results.find(
        (r) => r.runtimeId === bankGrant.name,
      )!;
      const directorResult = execution.commit.results.find(
        (r) => r.runtimeId === director.name,
      )!;
      expect(directorResult.status).toBe("success");
      // The sub-agent's write service must see the uncommitted pre-turn grant (50), not stale committed 10.
      expect(seenByService).toEqual({ amount: 50 });
      // Read dependency on bank/grant must be merged into director's read dependencies.
      expect(execution.commit.readDependencies?.[directorResult.runId]).toEqual(
        [grantResult.runId],
      );

      const outcome = await commitExecution({
        store,
        execution,
        enqueueReleasedJobsInTx: refuseReleasedJobs,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      expect(outcome.status).toBe("committed");
      expect(
        (await store.getPluginData(SESSION, "bank", "wallet", "gold"))?.value,
      ).toEqual({ amount: 43 });
    },
  );

  it.each(["success", "failure"] as const)(
    "lets a sub-agent read-only plugin tool and dataset tool see upstream writes and merges deps only on %s",
    async (childOutcome) => {
      const store = await createSeededStore(["actor-pkg", "director"]);
      await store.setPluginData({
        id: `${SESSION}:actor-pkg:notes:entry`,
        sessionId: SESSION,
        pluginId: "actor-pkg",
        namespace: "notes",
        key: "entry",
        value: "committed-old",
        createdAt: NOW,
        updatedAt: NOW,
      });

      let pluginToolSaw: unknown;
      let datasetToolOutput = "";
      const readNoteTool = tool({
        name: "peek-note",
        description: "Read note",
        annotations: {
          readOnly: true,
          concurrencySafe: true,
          idempotent: true,
        },
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          pluginToolSaw = (await ctx.store!.getPluginData("notes", "entry"))
            ?.value;
          return { note: pluginToolSaw };
        },
      });

      const upstreamActor: RuntimeManifest = {
        name: "actor-pkg/prep",
        pluginId: "actor-pkg",
        description: "prep",
        runtimeType: "function",
        stage: "pre-turn",
        outputKind: "system",
        trigger: { type: "auto" },
      };
      const director: RuntimeManifest = {
        name: "director/main",
        pluginId: "director",
        description: "director",
        runtimeType: "agent",
        stage: "narrative",
        outputKind: "system",
        trigger: { type: "auto" },
        tools: { builtin: ["delegate"] },
      };
      const actor: RuntimeManifest = {
        name: "actor-pkg/guard",
        pluginId: "actor-pkg",
        description: "guard",
        runtimeType: "agent",
        outputKind: "system",
        subagentOnly: true,
        trigger: { type: "manual" },
        outputContract: "actor.guard@1",
        output: { schema: "output.schema.json" },
        datasets: {
          notes: {
            namespace: "notes",
            schema: "./note.json",
            ops: ["set"],
            tools: ["get"],
          },
        },
        tools: {
          plugin: ["peek-note"],
          datasets: [{ dataset: "notes", tools: ["get"] }],
        },
      };

      let directorCalls = 0;
      let actorCalls = 0;
      const llm: LLMAdapter = {
        generate: async (req) => {
          const system = req.messages
            .filter((m) => m.role === "system")
            .map((m) => String(m.content))
            .join("\n");
          if (system.includes("DIRECTOR-PROMPT")) {
            if (directorCalls++ === 0) {
              return toolCall("delegate", {
                target: { contract: "actor.guard@1" },
                brief: "Read the note",
              });
            }
            return submitOutput({ narrativeOutput: "Done." });
          }
          if (actorCalls === 0) {
            actorCalls++;
            return toolCall("peek-note", {});
          }
          if (actorCalls === 1) {
            actorCalls++;
            return toolCall("notes-get", { key: "entry" });
          }
          datasetToolOutput = JSON.stringify(
            req.messages.filter((m) => m.role === "tool"),
          );
          if (childOutcome === "failure") {
            throw new Error("actor failed after reading");
          }
          return submitOutput({ line: "Read it" });
        },
      };

      const registry = new ToolRegistry();
      registry.registerBuiltin(delegateTool);
      registry.registerPlugin("actor-pkg", readNoteTool);

      const prepHandler: FunctionHandler = async (ctx) => {
        await ctx.pluginData!.set("notes", "entry", "upstream-fresh");
        return { outcome: "success", value: {} };
      };

      const input: TurnInput = {
        origin: "player",
        sessionId: SESSION,
        turnId: "turn-2",
        logicalTurnId: "lt-2",
        playerMessage: "Inspect",
        locale: "en-US",
      };

      const execution = await executeTurn(
        input,
        [upstreamActor, director, actor],
        {
          store,
          llm,
          hookScope: {
            activePluginIds: new Set(["actor-pkg", "director"]),
          },
          toolExecutor: createToolExecutor({
            store,
            findTool: (name, context) => registry.find(name, context.pluginId),
            getToolSource: (name) => registry.source(name),
          }),
          loadRuntime: async (manifest): Promise<LoadedRuntime> => {
            if (manifest.name === upstreamActor.name) {
              return { manifest, promptTemplate: "", handler: prepHandler };
            }
            if (manifest.name === director.name) {
              return { manifest, promptTemplate: "DIRECTOR-PROMPT" };
            }
            return {
              manifest,
              promptTemplate: "ACTOR-PROMPT",
              outputSchema: { ...LINE_SCHEMA },
              outputContractSchema: { ...LINE_SCHEMA },
              datasetSchemas: { notes: { type: "string" } },
            };
          },
        },
      );

      const prepResult = execution.commit.results.find(
        (r) => r.runtimeId === upstreamActor.name,
      )!;
      const directorResult = execution.commit.results.find(
        (r) => r.runtimeId === director.name,
      )!;
      expect(pluginToolSaw).toBe("upstream-fresh");
      expect(datasetToolOutput).toContain("upstream-fresh");
      expect(
        execution.commit.readDependencies?.[directorResult.runId] ?? [],
      ).toEqual(childOutcome === "success" ? [prepResult.runId] : []);
    },
  );

  it("discards forked pluginDataVisibility reads if parentSignal aborts before final acceptance", async () => {
    const store = await createSeededStore(["actor-pkg", "director"]);
    let sawValue: unknown;
    const readTool = tool({
      name: "peek-note",
      description: "Read note",
      annotations: { readOnly: true },
      parameters: z.object({}),
      execute: async (_args, ctx) => {
        sawValue = (await ctx.store!.getPluginData("notes", "entry"))?.value;
        return { value: sawValue };
      },
    });
    const registry = new ToolRegistry();
    registry.registerPlugin("actor-pkg", readTool);

    const provider: RuntimeManifest = {
      name: "actor-pkg/guard",
      pluginId: "actor-pkg",
      description: "guard",
      runtimeType: "agent",
      outputKind: "system",
      subagentOnly: true,
      trigger: { type: "manual" },
      outputContract: "actor.guard@1",
      output: { schema: "output.schema.json" },
      tools: { plugin: ["peek-note"] },
    };

    const parentVisibility = createPluginDataVisibility({
      pluginId: "director",
      runtimeId: "director/main",
      runId: "dir-run",
      upstreamOf: (pluginId) =>
        pluginId === "actor-pkg"
          ? [
              {
                runId: "prep-run",
                runtimeId: "actor-pkg/prep",
                proposal: {
                  id: "p1",
                  type: "plugin.data",
                  sessionId: SESSION,
                  turnId: "turn-3",
                  timestamp: NOW,
                  source: {
                    pluginId: "actor-pkg",
                    runtimeId: "actor-pkg/prep",
                  },
                  payload: {
                    namespace: "notes",
                    key: "entry",
                    value: "upstream-secret",
                  },
                },
              },
            ]
          : [],
    });

    const parentAbort = new AbortController();
    const emitter = makeEmitterSpy();
    const originalEmit = emitter.emit;
    emitter.emit = async (type, payload) => {
      await originalEmit(type, payload);
      if (type === "subagent.completed") {
        parentAbort.abort(new Error("parent aborted during completion emit"));
      }
    };

    let calls = 0;
    const llm: LLMAdapter = {
      generate: async () =>
        calls++ === 0
          ? toolCall("peek-note", {})
          : submitOutput({ line: "ok" }),
    };

    const runner = createSubagentRunner({ activeRuntimes: [provider] });
    const input: TurnInput = {
      origin: "player",
      sessionId: SESSION,
      turnId: "turn-3",
      playerMessage: "go",
      locale: "en-US",
    };

    const result = await runner.run({
      caller: { pluginId: "director", runtimeId: "director/main", depth: 0 },
      request: { target: { contract: "actor.guard@1" }, brief: "check" },
      input,
      deps: {
        store,
        llm,
        emitter,
        toolExecutor: createToolExecutor({
          store,
          findTool: (name, ctx) => registry.find(name, ctx.pluginId),
          getToolSource: (name) => registry.source(name),
        }),
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "ACTOR-PROMPT",
          outputSchema: { ...LINE_SCHEMA },
          outputContractSchema: { ...LINE_SCHEMA },
        }),
      },
      executionContext: createExecutionContext(input),
      parentCallId: "pc-1",
      parentSignal: parentAbort.signal,
      pluginDataVisibility: parentVisibility,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(sawValue).toBe("upstream-secret");
    expect([...parentVisibility.recorder]).toEqual([]);
    expect(baselinesFor(parentVisibility.recorder).snapshot()).toEqual([]);
  });
});

describe("sub-agent delegation budget recovery", () => {
  it("clears loadingBudget on rejection so a subsequent call can retry and succeed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await createSeededStore(["actor-pkg", "caller-pkg"]);
    const world = await createWorldModelView(store, SESSION, [], []);
    const realGetSession = store.getSession.bind(store);
    let getSessionCalls = 0;
    vi.spyOn(store, "getSession").mockImplementation(async (sessionId) => {
      getSessionCalls++;
      if (getSessionCalls === 1) {
        throw new Error("transient store failure");
      }
      return realGetSession(sessionId);
    });

    const provider: RuntimeManifest = {
      name: "actor-pkg/guard",
      pluginId: "actor-pkg",
      description: "guard",
      runtimeType: "agent",
      outputKind: "system",
      subagentOnly: true,
      trigger: { type: "manual" },
      outputContract: "actor.guard@1",
      output: { schema: "output.schema.json" },
    };

    const runner = createSubagentRunner({ activeRuntimes: [provider] });
    const input: TurnInput = {
      origin: "player",
      sessionId: SESSION,
      turnId: "turn-retry-budget",
      playerMessage: "go",
      locale: "en-US",
    };

    const runArgs: SubagentRunArgs = {
      caller: {
        pluginId: "caller-pkg",
        runtimeId: "caller-pkg/main",
        depth: 0,
      },
      request: { target: { contract: "actor.guard@1" }, brief: "hello" },
      world,
      input,
      deps: {
        store,
        llm: { generate: async () => submitOutput({ line: "Recovered" }) },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "ACTOR-PROMPT",
          outputSchema: { ...LINE_SCHEMA },
          outputContractSchema: { ...LINE_SCHEMA },
        }),
      },
      executionContext: createExecutionContext(input),
      parentCallId: "pc-budget",
    };

    const first = await runner.run(runArgs);
    expect(first).toMatchObject({ ok: false, error: { code: "internal" } });

    const second = await runner.run(runArgs);
    expect(second).toMatchObject({ ok: true, output: { line: "Recovered" } });
    expect(getSessionCalls).toBe(2);

    const third = await runner.run(runArgs);
    expect(third).toMatchObject({ ok: true, output: { line: "Recovered" } });
    expect(getSessionCalls).toBe(2);
  });

  it("does not leak calls or actors in DelegationBudget when parentSignal aborts before batch start", async () => {
    const store = await createSeededStore(["actor-pkg", "caller-pkg"]);
    await store.upsertCharacter({
      id: "char-a",
      sessionId: SESSION,
      name: "Alice",
      type: "npc",
      description: "Guard A",
      fields: {},
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await store.upsertCharacter({
      id: "char-b",
      sessionId: SESSION,
      name: "Bob",
      type: "npc",
      description: "Guard B",
      fields: {},
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const world = await createWorldModelView(store, SESSION, [], []);

    // Block child #2's async world loading while child #1 reaches the batch barrier.
    let releaseList!: () => void;
    const listBlocked = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let enteredList!: () => void;
    const listEntered = new Promise<void>((resolve) => {
      enteredList = resolve;
    });
    const realListCharacters = store.listCharacters.bind(store);
    vi.spyOn(store, "listCharacters").mockImplementation(async (sessionId) => {
      enteredList();
      await listBlocked;
      return realListCharacters(sessionId);
    });

    const provider: RuntimeManifest = {
      name: "actor-pkg/character",
      pluginId: "actor-pkg",
      description: "actor",
      runtimeType: "agent",
      outputKind: "system",
      subagentOnly: true,
      trigger: { type: "manual" },
      outputContract: CHARACTER_ACTOR_CONTRACT,
    };

    const delegation = new DelegationBudget({
      sessionId: SESSION,
      store,
      settings: { maxSubagentCalls: 2, maxActors: 1 },
    });

    const generate = vi.fn<LLMAdapter["generate"]>(async () =>
      submitOutput({
        segments: [{ kind: "dialogue", text: "Hi" }],
        intent: "greet",
      }),
    );

    const runner = createSubagentRunner({
      activeRuntimes: [provider],
      delegation,
    });
    const input: TurnInput = {
      origin: "player",
      sessionId: SESSION,
      turnId: "turn-abort-batch",
      playerMessage: "go",
      locale: "en-US",
    };
    const deps = {
      store,
      llm: { generate },
      loadRuntime: async (manifest: RuntimeManifest) => ({
        manifest,
        promptTemplate: "ACTOR-PROMPT",
      }),
    };

    const abort = new AbortController();
    const batchPromise = runner.runBatch([
      {
        caller: {
          pluginId: "caller-pkg",
          runtimeId: "caller-pkg/main",
          depth: 0,
        },
        request: {
          target: { contract: CHARACTER_ACTOR_CONTRACT },
          characterId: "char-a",
          brief: "Speak as Alice",
        },
        world,
        input,
        deps,
        executionContext: createExecutionContext(input),
        parentCallId: "batch-1",
        parentSignal: abort.signal,
        batchIndex: 0,
      },
      {
        caller: {
          pluginId: "caller-pkg",
          runtimeId: "caller-pkg/main",
          depth: 0,
        },
        request: {
          target: { contract: CHARACTER_ACTOR_CONTRACT },
          characterId: "char-b",
          brief: "Speak as Bob",
        },
        // Omit `world` so child #2 awaits `createWorldModelView` while child #1 waits on the batch barrier.
        input,
        deps,
        executionContext: createExecutionContext(input),
        parentCallId: "batch-1",
        parentSignal: abort.signal,
        batchIndex: 1,
      },
    ]);

    await listEntered;
    abort.abort(new Error("cancelled before batch start"));
    releaseList();

    const outcomes = await batchPromise;
    expect(outcomes).toMatchObject([
      { ok: false, error: { code: "cancelled" } },
      { ok: false, error: { code: "cancelled" } },
    ]);
    expect(generate).not.toHaveBeenCalled();
    // Neither calls nor actorIds may be permanently consumed by pre-start abort.
    expect(delegation.snapshot().calls).toBe(0);
    expect(delegation.snapshot().actorIds).toEqual([]);
    expect(runner.inFlight).toBe(0);

    // Subsequent live call can still use the full intact actor quota (char-b).
    const followup = await runner.run({
      caller: {
        pluginId: "caller-pkg",
        runtimeId: "caller-pkg/main",
        depth: 0,
      },
      request: {
        target: { contract: CHARACTER_ACTOR_CONTRACT },
        characterId: "char-b",
        brief: "Now speak as Bob",
      },
      world,
      input,
      deps,
      executionContext: createExecutionContext(input),
      parentCallId: "followup-1",
    });
    expect(followup.ok).toBe(true);
    expect(delegation.snapshot().calls).toBe(1);
    expect(delegation.snapshot().actorIds).toEqual(["char-b"]);
  });
});
