/**
 * An agent imports another plugin's write service as a tool. A call stages
 * one operation and answers with the staged notice; the operation counts
 * only when the tool invocation, and any sub-agent around it, succeeds.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import {
  defaultSessionSeats,
  ToolError,
  type LLMAdapter,
  type LLMMessage,
  type LLMResponse,
  type LLMToolDefinition,
  type RuntimeManifest,
  type RuntimeResult,
  type TurnInput,
} from "@covel/shared";
import { suspendTool, tool, ToolRegistry } from "@covel/tools";
import { commitExecution, executeTurn } from "../src/index.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import {
  prepareAgentToolSurface,
  withAgentToolSurface,
} from "../src/agent-loop/agent-tool-surface.js";
import { createRootOperationStage } from "../src/operations/operation-stage.js";

const SESSION = "session";
const CONTRACT = "bank.pay@1";
const timestamp = "2026-10-30T00:00:00.000Z";
const AGENT_MARK = "CALLER-PROMPT";
const HELPER_MARK = "HELPER-PROMPT";
const input: TurnInput = {
  sessionId: SESSION,
  turnId: "turn",
  playerMessage: "Pay the smith",
  origin: "player",
  locale: "en",
};

const open: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((store) => store.close()));
});

const payInput = z.object({ amount: z.number().describe("Coins to pay") });

function payService(
  handler?: Parameters<PluginServiceRegistry["register"]>[1]["handler"],
) {
  return {
    name: "pay",
    contract: CONTRACT,
    access: "write",
    description: "Pay coins from the purse.",
    modelFacing: true,
    input: payInput,
    output: z.unknown(),
    handler:
      handler ??
      (async ({ amount }: { amount: number }, ctx: never) => {
        const writer = (
          ctx as {
            pluginData: {
              update(n: string, k: string, ops: unknown): Promise<void>;
            };
          }
        ).pluginData;
        await writer.update("purse", "coins", [
          { op: "inc", path: "/amount", by: -amount, min: 0 },
        ]);
        return { paid: amount };
      }),
  } as Parameters<PluginServiceRegistry["register"]>[1];
}

function agent(extra: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: "caller/agent",
    pluginId: "caller",
    description: "caller",
    runtimeType: "agent",
    stage: "narrative",
    outputKind: "story",
    trigger: { type: "auto" },
    tools: { services: [{ contract: CONTRACT, name: "bank-pay" }] },
    maxRetries: 0,
    ...extra,
  };
}

interface Request {
  readonly mark: string;
  readonly tools: readonly LLMToolDefinition[];
  readonly messages: readonly LLMMessage[];
}
type Reply = (index: number, request: Request) => LLMResponse;

function text(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
function call(name: string, args: object, id = `call-${name}`): LLMResponse {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function scripted(routes: Record<string, Reply>) {
  const requests: Request[] = [];
  const counts = new Map<string, number>();
  const llm: LLMAdapter = {
    async generate(params) {
      const system = params.messages
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n");
      const mark = Object.keys(routes).find((key) => system.includes(key));
      if (!mark) throw new Error("unrouted model request");
      const request = {
        mark,
        tools: params.tools ?? [],
        messages: params.messages,
      };
      requests.push(request);
      const index = counts.get(mark) ?? 0;
      counts.set(mark, index + 1);
      return routes[mark]!(index, request);
    },
  };
  return { llm, requests };
}

function toolMessage(request: Request | undefined): unknown {
  const message = request?.messages.findLast((item) => item.role === "tool");
  return message ? JSON.parse(String(message.content)) : undefined;
}

async function fixture() {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = createMemoryStore();
  open.push(store);
  const plugins = ["caller", "bank", "helper"];
  await store.createSession({
    id: SESSION,
    locale: "en",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: plugins,
    completedPlayerTurns: 0,
    seats: defaultSessionSeats(),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await store.setPluginData({
    id: `${SESSION}:bank:purse:coins`,
    sessionId: SESSION,
    pluginId: "bank",
    namespace: "purse",
    key: "coins",
    value: { amount: 10 },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const services = new PluginServiceRegistry({
    list: async () => plugins,
    ensure: async (_sessionId, pluginId) => {
      if (!plugins.includes(pluginId)) throw new Error("Not active");
    },
  });
  const tools = new ToolRegistry();
  tools.registerBuiltin(suspendTool);
  const toolExecutor = createToolExecutor({
    store,
    findTool: (name, context) => tools.find(name, context.pluginId),
    getToolSource: (name) => tools.source(name),
  });
  const deps = (llm: LLMAdapter) => ({
    store,
    services,
    toolExecutor,
    llm,
    loadRuntime: async (manifest: RuntimeManifest) => ({
      manifest,
      promptTemplate: manifest.subagentOnly
        ? `${HELPER_MARK} You help.`
        : `${AGENT_MARK} You tell the story.`,
    }),
  });
  const coins = async () =>
    (
      (await store.getPluginData(SESSION, "bank", "purse", "coins"))?.value as
        { amount: number } | undefined
    )?.amount;
  return { store, services, tools, toolExecutor, deps, coins };
}

const resultOf = (
  execution: Awaited<ReturnType<typeof executeTurn>>,
  runtimeId = "caller/agent",
) =>
  (execution.commit.results as readonly RuntimeResult[]).find(
    (result) => result.runtimeId === runtimeId,
  )!;

const context = {
  sessionId: SESSION,
  turnId: input.turnId,
  pluginId: "caller",
  runtimeId: "caller/agent",
};

describe("an imported write service", () => {
  it("is offered with write annotations and answers with the staged notice", async () => {
    const { services, deps, toolExecutor, store, coins } = await fixture();
    services.register("bank", payService());
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        index === 0 ? call("bank-pay", { amount: 3 }) : text("You pay."),
    });
    try {
      const prepared = await prepareAgentToolSurface({
        manifest: agent(),
        input,
        deps: { services },
        canWrite: true,
      });
      const executor = withAgentToolSurface(toolExecutor, prepared, services);
      expect(executor.getToolInfo("bank-pay", context)).toMatchObject({
        annotations: {
          readOnly: false,
          stagesWrites: true,
          idempotent: false,
          concurrencySafe: false,
        },
      });

      const execution = await executeTurn(input, [agent()], deps(llm));
      expect(toolMessage(requests[1])).toEqual({
        data: { paid: 3 },
        staged: {
          count: 1,
          kinds: ["plugin.data.update"],
          notice:
            "Staged: it takes effect when the turn ends and may still be rejected.",
        },
      });
      const result = resultOf(execution);
      expect(result.operations).toMatchObject([
        {
          contract: CONTRACT,
          toolCallId: "call-bank-pay",
          status: "staged",
        },
      ]);
      // The caller's own proposals never hold the provider's writes.
      expect(
        (result.pendingProposals ?? []).filter(
          (proposal) => proposal.source.pluginId === "bank",
        ),
      ).toEqual([]);
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      expect(outcome.operations.map((op) => op.status)).toEqual(["committed"]);
      expect(await coins()).toBe(7);
    } finally {
      await toolExecutor.close();
    }
  });

  it("passes a provider's conflict to the model as a refusal", async () => {
    const { services, toolExecutor } = await fixture();
    services.register(
      "bank",
      payService(async () => {
        throw new ToolError("conflict", "The purse holds too little.");
      }),
    );
    try {
      const stage = createRootOperationStage({
        caller: { pluginId: "caller", runtimeId: "caller/agent" },
        sessionId: SESSION,
        turnId: input.turnId,
      });
      const executor = withAgentToolSurface(
        toolExecutor,
        await prepareAgentToolSurface({
          manifest: agent(),
          input,
          deps: { services },
          canWrite: true,
        }),
        services,
        stage,
      );
      const result = await executor.execute(
        {
          toolCallId: "direct",
          name: "bank-pay",
          arguments: JSON.stringify({ amount: 99 }),
        },
        context,
      );
      expect(result.error?.code).toBe("conflict");
      expect(result.refused).toBe(true);
      expect(stage.held()).toEqual([]);
    } finally {
      await toolExecutor.close();
    }
  });

  it("is absent, not allowed, for an agent that can suspend", async () => {
    const { services, deps, toolExecutor, coins } = await fixture();
    services.register("bank", payService());
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        index === 0
          ? call("bank-pay", { amount: 3 })
          : text(JSON.stringify({ done: true })),
    });
    try {
      await executeTurn(
        input,
        [
          agent({
            outputKind: "system",
            tools: {
              builtin: ["suspend"],
              services: [{ contract: CONTRACT, name: "bank-pay" }],
            },
          }),
        ],
        deps(llm),
      );
      expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain(
        "bank-pay",
      );
      expect(toolMessage(requests[1])).toMatchObject({
        error: {
          code: "unavailable",
          message:
            'The tool "bank-pay" is unavailable in this run: it changes data, which this runtime cannot do here.',
        },
      });
      expect(await coins()).toBe(10);
    } finally {
      await toolExecutor.close();
    }
  });

  it("keeps a sub-agent's write import; its operation lands on the delegating story run", async () => {
    const { services, deps, toolExecutor, store, coins } = await fixture();
    services.register("bank", payService());
    const helper: RuntimeManifest = {
      name: "helper/actor",
      pluginId: "helper",
      description: "helper",
      runtimeType: "agent",
      outputKind: "system",
      subagentOnly: true,
      trigger: { type: "manual" },
      outputContract: "fixture.helper@1",
      output: { schema: "output.schema.json" },
      tools: { services: [{ contract: CONTRACT, name: "bank-pay" }] },
      maxRetries: 0,
    };
    const lineSchema = {
      type: "object",
      properties: { line: { type: "string" } },
      required: ["line"],
    };
    const main: RuntimeManifest = {
      name: "caller/main",
      pluginId: "caller",
      description: "main",
      runtimeType: "function",
      stage: "narrative",
      outputKind: "story",
      trigger: { type: "auto" },
    };
    const { llm, requests } = scripted({
      [HELPER_MARK]: (index) =>
        index === 0
          ? call("bank-pay", { amount: 4 })
          : text(JSON.stringify({ line: "Paid." })),
    });
    try {
      const execution = await executeTurn(input, [main, helper], {
        ...deps(llm),
        loadRuntime: async (manifest: RuntimeManifest) =>
          manifest.name === helper.name
            ? {
                manifest,
                promptTemplate: `${HELPER_MARK} You help.`,
                outputSchema: lineSchema,
                outputContractSchema: lineSchema,
              }
            : {
                manifest,
                promptTemplate: "",
                handler: async (ctx) => {
                  await ctx.agents!.run({
                    target: { contract: "fixture.helper@1" },
                    brief: "Pay the smith.",
                  });
                  return {
                    outcome: "success",
                    value: { narrativeOutput: "The smith is paid." },
                  };
                },
              },
      });
      expect(requests[0]!.tools.map((tool) => tool.name)).toContain("bank-pay");
      expect(resultOf(execution, main.name).operations).toMatchObject([
        {
          status: "staged",
          invokedBy: { pluginId: "helper", runtimeId: "helper/actor" },
        },
      ]);
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      expect(outcome.operations.map((op) => op.status)).toEqual(["committed"]);
      expect(await coins()).toBe(6);
    } finally {
      await toolExecutor.close();
    }
  });
});

describe("a plugin tool that calls a write service", () => {
  const callPay = async (
    ctx: { services?: { call(request: object): Promise<unknown> } },
    amount: number,
  ) =>
    ctx.services!.call({
      pluginId: "bank",
      name: "pay",
      contract: CONTRACT,
      input: { amount },
    });

  it("takes back the operation when the tool then fails", async () => {
    const { services, tools, deps, toolExecutor, store, coins } =
      await fixture();
    services.register("bank", payService());
    tools.registerPlugin(
      "caller",
      tool({
        name: "pay-and-fail",
        description: "Pay, then fail",
        parameters: z.object({}),
        async execute(_args, ctx) {
          await callPay(ctx, 2);
          throw new Error("the smith left");
        },
      }),
    );
    const { llm } = scripted({
      [AGENT_MARK]: (index) =>
        index === 0 ? call("pay-and-fail", {}) : text("No deal."),
    });
    try {
      const execution = await executeTurn(
        input,
        [agent({ tools: { plugin: ["pay-and-fail"] } })],
        deps(llm),
      );
      expect(
        resultOf(execution).operations?.map((op) => [op.status, op.reason]),
      ).toEqual([["discarded", "caller-dropped"]]);
      await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      expect(await coins()).toBe(10);
    } finally {
      await toolExecutor.close();
    }
  });

  it("fails when the tool says it is read-only", async () => {
    const { services, tools, deps, toolExecutor } = await fixture();
    services.register("bank", payService());
    tools.registerPlugin(
      "caller",
      tool({
        name: "peek-and-pay",
        description: "Pretends to only look",
        annotations: { readOnly: true },
        parameters: z.object({}),
        async execute(_args, ctx) {
          await callPay(ctx, 2);
          return { looked: true };
        },
      }),
    );
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        index === 0 ? call("peek-and-pay", {}) : text("Hm."),
    });
    try {
      const execution = await executeTurn(
        input,
        [agent({ tools: { plugin: ["peek-and-pay"] } })],
        deps(llm),
      );
      expect(toolMessage(requests[1])).toMatchObject({
        error: expect.anything(),
      });
      expect(resultOf(execution).operations?.map((op) => op.status)).toEqual([
        "discarded",
      ]);
    } finally {
      await toolExecutor.close();
    }
  });
});
