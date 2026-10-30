/**
 * An agent imports another plugin's model-facing service as a tool
 * (`tools.services`). At run start the kernel binds the import to the one
 * active provider that offers the contract to models; without exactly one,
 * the tool is left out and a call to it answers `unavailable`. Imports work
 * the same in a top-level run, a resumed run and a sub-agent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import {
  defaultSessionSeats,
  type LLMAdapter,
  type LLMMessage,
  type LLMResponse,
  type LLMToolDefinition,
  type RuntimeManifest,
  type RuntimeResult,
  type TurnInput,
} from "@covel/shared";
import type {
  FunctionHandler,
  LoadedRuntime,
  PluginServiceContext,
} from "@covel/shared/plugin-runtime";
import type { ApprovalPipeline } from "@covel/approval";
import { suspendTool, ToolRegistry } from "@covel/tools";
import {
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import {
  prepareAgentToolSurface,
  withAgentToolSurface,
} from "../src/agent-loop/agent-tool-surface.js";
import { SERVICE_IMPORT_TIMEOUT_MS } from "../src/agent-loop/service-import-tools.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

const SESSION = "session";
const CONTRACT = "inventory.items@1";
const timestamp = "2026-10-30T00:00:00.000Z";
const ROW_ID = "123e4567-e89b-12d3-a456-426614174000";
const AGENT_MARK = "CALLER-PROMPT";
const HELPER_MARK = "HELPER-PROMPT";
const input: TurnInput = {
  sessionId: SESSION,
  turnId: "turn",
  playerMessage: "What is in my bag?",
  origin: "player",
  locale: "en",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const itemsInput = z.object({
  bag: z.string().describe("The bag to look in"),
});

function itemsService(
  overrides: Partial<Parameters<PluginServiceRegistry["register"]>[1]> = {},
) {
  return {
    name: "items",
    contract: CONTRACT,
    description: "List the items in a bag.",
    modelFacing: true,
    input: itemsInput,
    output: z.unknown(),
    handler: ({ bag }: { bag: string }) => ({
      items: [{ id: ROW_ID, name: `${bag} sword`, updatedAt: timestamp }],
    }),
    ...overrides,
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
    tools: { services: [{ contract: CONTRACT, name: "inventory-items" }] },
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

/** Routes each request by the marker in its system prompt. */
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

const open: DataStore[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close()));
});

async function fixture(options: { approval?: ApprovalPipeline } = {}) {
  const store = createMemoryStore();
  open.push(store);
  const plugins = ["caller", "provider", "other", "helper", "writer"];
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
  const active = new Set(plugins);
  const paused = new Set<string>();
  const admitted = () => [...active].filter((id) => !paused.has(id));
  const services = new PluginServiceRegistry({
    list: async () => admitted(),
    ensure: async (_sessionId, pluginId) => {
      if (!admitted().includes(pluginId))
        throw new Error(`Plugin is unavailable: ${pluginId}`);
    },
    paused: async () => [...paused].filter((id) => active.has(id)),
  });
  const tools = new ToolRegistry();
  tools.registerBuiltin(suspendTool);
  const toolExecutor = createToolExecutor({
    store,
    findTool: (name, context) => tools.find(name, context.pluginId),
    getToolSource: (name) => tools.source(name),
    ...(options.approval ? { approval: options.approval } : {}),
  });
  const emitter = makeEmitterSpy(SESSION, input.turnId);
  const deps = (
    llm: LLMAdapter,
    loaded: Record<string, Partial<LoadedRuntime>> = {},
  ) => ({
    store,
    services,
    toolExecutor,
    emitter,
    llm,
    loadRuntime: async (manifest: RuntimeManifest) => ({
      manifest,
      promptTemplate: manifest.subagentOnly
        ? `${HELPER_MARK} You help.`
        : `${AGENT_MARK} You tell the story.`,
      ...loaded[manifest.name],
    }),
  });
  const surface = async (manifest = agent()) =>
    withAgentToolSurface(
      toolExecutor,
      await prepareAgentToolSurface({ manifest, input, deps: { services } }),
      services,
    );
  const context = {
    sessionId: SESSION,
    turnId: input.turnId,
    pluginId: "caller",
    runtimeId: "caller/agent",
  };
  return {
    store,
    active,
    paused,
    services,
    toolExecutor,
    emitter,
    deps,
    surface,
    context,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const resultOf = (
  execution: Awaited<ReturnType<typeof executeTurn>>,
  runtimeId = "caller/agent",
) =>
  (execution.result.runtimeResults as readonly RuntimeResult[]).find(
    (result) => result.runtimeId === runtimeId,
  );

describe("an imported service tool", () => {
  it("is offered with the provider's description, schema and read-only annotations", async () => {
    const { services, deps, surface, context, toolExecutor } = await fixture();
    services.register("provider", itemsService());
    const { llm, requests } = scripted({
      [AGENT_MARK]: () => text("The bag is light."),
    });
    try {
      await executeTurn(input, [agent()], deps(llm));
      const offered = requests[0]!.tools.find(
        (tool) => tool.name === "inventory-items",
      );
      const expected: Record<string, unknown> = itemsInput.toJSONSchema({
        io: "input",
      });
      delete expected.$schema;
      expect(offered).toEqual({
        name: "inventory-items",
        description: "List the items in a bag.",
        parameters: expected,
      });
      expect(offered!.parameters).not.toHaveProperty("$schema");

      const executor = await surface();
      expect(executor.getToolInfo("inventory-items", context)).toMatchObject({
        annotations: {
          readOnly: true,
          stagesWrites: false,
          idempotent: true,
          concurrencySafe: true,
        },
      });
      const renamed = await surface(
        agent({
          tools: { services: [{ contract: CONTRACT, name: "check-bag" }] },
        }),
      );
      expect(renamed.getToolInfo("check-bag", context)?.name).toBe("check-bag");
      expect(renamed.getToolInfo("inventory-items", context)).toBeUndefined();
    } finally {
      await toolExecutor.close();
    }
  });

  it("answers with the provider's output as model-facing data, recorded and traced like any tool", async () => {
    const { services, deps, store, emitter, toolExecutor } = await fixture();
    services.register("provider", itemsService());
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        index === 0
          ? call("inventory-items", { bag: "leather" })
          : text("A sword waits in the bag."),
    });
    try {
      const execution = await executeTurn(input, [agent()], deps(llm));
      expect(resultOf(execution)?.status).toBe("success");
      expect(toolMessage(requests[1])).toEqual({
        data: { items: [{ name: "leather sword" }] },
      });
      const rows = await store.listToolCalls(SESSION);
      expect(rows).toMatchObject([
        { toolName: "inventory-items", pluginId: "caller" },
      ]);
      expect(
        emitter.events.find(
          (event) =>
            event.type === "tool.completed" &&
            event.payload.toolName === "inventory-items",
        ),
      ).toBeDefined();
      expect(
        emitter.events.find(
          (event) => event.type === "plugin.service.completed",
        )?.payload,
      ).toMatchObject({
        callerPluginId: "caller",
        providerPluginId: "provider",
        toolCallId: "call-inventory-items",
        outcome: "success",
      });
    } finally {
      await toolExecutor.close();
    }
  });

  it("goes through the approval policy", async () => {
    const approval: ApprovalPipeline = {
      check: (request) =>
        request.toolName === "inventory-items"
          ? { decision: "deny", reason: "not here" }
          : { decision: "allow" },
    } as ApprovalPipeline;
    const { services, deps, toolExecutor } = await fixture({ approval });
    const handler = vi.fn(() => ({ items: [] }));
    services.register("provider", itemsService({ handler }));
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        index === 0
          ? call("inventory-items", { bag: "leather" })
          : text("Nothing to see."),
    });
    try {
      await executeTurn(input, [agent()], deps(llm));
      expect(toolMessage(requests[1])).toMatchObject({
        error: { code: "refused" },
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await toolExecutor.close();
    }
  });

  it("checks arguments against the provider's input and counts a bad call as the caller's", async () => {
    const { services, deps, surface, context, toolExecutor } = await fixture();
    services.register("provider", itemsService());
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        index === 0
          ? call("inventory-items", { bag: 3 })
          : text("The bag stays shut."),
    });
    try {
      await executeTurn(input, [agent()], deps(llm));
      expect(toolMessage(requests[1])).toMatchObject({
        error: {
          code: "invalid-input",
          message: expect.stringContaining("bag"),
        },
      });
      const result = await (
        await surface()
      ).execute(
        { toolCallId: "direct", name: "inventory-items", arguments: "{}" },
        context,
      );
      expect(result.error?.code).toBe("invalid-input");
      expect(result.refused).toBeUndefined();
    } finally {
      await toolExecutor.close();
    }
  });

  it("passes the model's arguments to the provider, so its parser runs once for the handler", async () => {
    const { services, deps, toolExecutor } = await fixture();
    const handler = vi.fn((parsed: unknown) => ({ parsed }));
    services.register(
      "provider",
      itemsService({
        input: z.object({
          amount: z.string().transform(Number),
          tags: z.array(z.string()),
        }),
        handler,
      }),
    );
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        index === 0
          ? // The array arrives as JSON text and is repaired before the call.
            call("inventory-items", { amount: "2", tags: '["sharp"]' })
          : text("Two sharp swords."),
    });
    try {
      const execution = await executeTurn(input, [agent()], deps(llm));
      expect(resultOf(execution)?.status).toBe("success");
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]![0]).toEqual({ amount: 2, tags: ["sharp"] });
      expect(toolMessage(requests[1])).toEqual({
        data: { parsed: { amount: 2, tags: ["sharp"] } },
      });
    } finally {
      await toolExecutor.close();
    }
  });

  it("offers a Zod input that has no JSON Schema form through its explicit inputSchema", async () => {
    const { services, deps, toolExecutor } = await fixture();
    const bagSchema = {
      type: "object",
      properties: { bag: { type: "string", description: "The bag" } },
      required: ["bag"],
    };
    const handler = vi.fn((parsed: unknown) => parsed);
    services.register(
      "provider",
      itemsService({
        input: z.object({
          bag: z.custom<string>((value) => typeof value === "string"),
        }),
        inputSchema: bagSchema,
        handler,
      }),
    );
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        [
          call("inventory-items", { bag: 3 }, "call-bad"),
          call("inventory-items", { bag: "leather" }),
          text("The leather bag."),
        ][index]!,
    });
    try {
      const execution = await executeTurn(input, [agent()], deps(llm));
      expect(resultOf(execution)?.status).toBe("success");
      expect(
        requests[0]!.tools.find((tool) => tool.name === "inventory-items")
          ?.parameters,
      ).toEqual(bagSchema);
      expect(toolMessage(requests[1])).toMatchObject({
        error: { code: "invalid-input" },
      });
      expect(toolMessage(requests[2])).toEqual({ data: { bag: "leather" } });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await toolExecutor.close();
    }
  });

  it("goes through PreToolUse and PostToolUse, which can rewrite or stop it", async () => {
    const { services, deps, toolExecutor } = await fixture();
    const handler = vi.fn((parsed: unknown) => parsed);
    services.register("provider", itemsService({ handler }));
    const seen: { event: string; name: string; arguments: string }[] = [];
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "test:PreToolUse:bag",
      event: "PreToolUse",
      handler: async (_ctx, payload) => {
        const { toolCall } = payload as {
          toolCall: { id: string; name: string; arguments: string };
        };
        seen.push({ event: "PreToolUse", ...toolCall });
        if (toolCall.id === "call-blocked")
          return { action: "abort", reason: "No peeking." };
        return {
          action: "continue",
          replace: {
            toolCall: { ...toolCall, arguments: '{"bag":"rewritten"}' },
          },
        };
      },
    });
    hookPipeline.register({
      id: "test:PostToolUse:bag",
      event: "PostToolUse",
      handler: async (_ctx, payload) => {
        const { toolCall } = payload as {
          toolCall: { id: string; name: string; arguments: string };
        };
        seen.push({ event: "PostToolUse", ...toolCall });
        return { action: "continue" };
      },
    });
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        [
          call("inventory-items", { bag: "leather" }),
          call("inventory-items", { bag: "secret" }, "call-blocked"),
          text("Only one bag opened."),
        ][index]!,
    });
    try {
      const execution = await executeTurn(input, [agent()], {
        ...deps(llm),
        hookPipeline,
      });
      expect(resultOf(execution)?.status).toBe("success");
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]![0]).toEqual({ bag: "rewritten" });
      expect(toolMessage(requests[1])).toEqual({ data: { bag: "rewritten" } });
      expect(JSON.stringify(toolMessage(requests[2]))).toContain("No peeking.");
      expect(seen).toEqual([
        {
          event: "PreToolUse",
          id: "call-inventory-items",
          name: "inventory-items",
          arguments: '{"bag":"leather"}',
        },
        {
          event: "PostToolUse",
          id: "call-inventory-items",
          name: "inventory-items",
          arguments: '{"bag":"rewritten"}',
        },
        {
          event: "PreToolUse",
          id: "call-blocked",
          name: "inventory-items",
          arguments: '{"bag":"secret"}',
        },
      ]);
    } finally {
      await toolExecutor.close();
    }
  });

  it("times out a provider that never answers", async () => {
    const { services, surface, context, emitter, toolExecutor } =
      await fixture();
    services.register(
      "provider",
      itemsService({ handler: () => new Promise(() => {}) }),
    );
    try {
      const executor = await surface();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = executor.execute(
        {
          toolCallId: "slow",
          name: "inventory-items",
          arguments: JSON.stringify({ bag: "deep" }),
        },
        { ...context, emitter },
      );
      await vi.advanceTimersByTimeAsync(SERVICE_IMPORT_TIMEOUT_MS + 1);
      const result = await pending;
      expect(result.error?.code).toBe("timeout");
      expect(result.refused).toBe(true);
      expect(
        emitter.events.find(
          (event) => event.type === "plugin.service.completed",
        )?.payload,
      ).toMatchObject({ outcome: "timeout", toolCallId: "slow" });
    } finally {
      vi.useRealTimers();
      await toolExecutor.close();
    }
  });
});

describe("an absent import", () => {
  it("is not offered, and a call answers unavailable while the story commits", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { deps, store, surface, context, toolExecutor } = await fixture();
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        index === 0
          ? call("inventory-items", { bag: "leather" })
          : text("You find nothing to count."),
    });
    try {
      const execution = await executeTurn(input, [agent()], deps(llm));
      expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain(
        "inventory-items",
      );
      expect(toolMessage(requests[1])).toMatchObject({
        error: {
          code: "unavailable",
          message: `The tool "inventory-items" is unavailable in this session: no active provider offers ${CONTRACT}.`,
        },
      });
      expect(resultOf(execution)?.status).toBe("success");
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      expect(outcome.status).toBe("committed");

      const result = await (
        await surface()
      ).execute(
        { toolCallId: "direct", name: "inventory-items", arguments: "{}" },
        context,
      );
      expect(result.refused).toBe(true);
    } finally {
      await toolExecutor.close();
    }
  });

  it("is not found by search-tools when deferred", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { deps, toolExecutor } = await fixture();
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        [
          call("search-tools", { query: "inventory items in a bag" }),
          text("Nothing to look in."),
        ][index]!,
    });
    try {
      const execution = await executeTurn(
        input,
        [
          agent({
            tools: {
              builtin: ["suspend"],
              services: [{ contract: CONTRACT, name: "inventory-items" }],
              defer: true,
            },
          }),
        ],
        deps(llm),
      );
      expect(resultOf(execution)?.status).toBe("success");
      const names = requests.map((request) =>
        request.tools.map((tool) => tool.name),
      );
      expect(names[0]).toContain("search-tools");
      expect(names[0]).not.toContain("inventory-items");
      expect(names[1]).not.toContain("inventory-items");
      expect(JSON.stringify(toolMessage(requests[1]))).not.toContain(
        "inventory-items",
      );
    } finally {
      await toolExecutor.close();
    }
  });

  it.each([
    {
      case: "two model-facing providers",
      setup: (f: Fixture, handler: () => unknown) => {
        f.services.register("provider", itemsService({ handler }));
        f.services.register("other", itemsService({ handler }));
      },
      reason: "more than one plugin provides it",
    },
    {
      case: "an active and a paused provider",
      setup: (f: Fixture, handler: () => unknown) => {
        f.services.register("provider", itemsService({ handler }));
        f.services.register("other", itemsService({ handler }));
        f.paused.add("other");
      },
      reason: "more than one plugin provides it",
    },
    {
      case: "only a paused provider",
      setup: (f: Fixture, handler: () => unknown) => {
        f.services.register("provider", itemsService({ handler }));
        f.paused.add("provider");
      },
      reason: "its provider is paused after repeated errors",
    },
    {
      case: "only a provider that does not offer it to models",
      setup: (f: Fixture, handler: () => unknown) => {
        f.services.register(
          "provider",
          itemsService({ modelFacing: false, handler }),
        );
      },
      reason: "its provider does not offer it to models",
    },
  ])(
    "with $case: not offered, never substituted",
    async ({ setup, reason }) => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const f = await fixture();
      const handler = vi.fn(() => ({ items: [] }));
      setup(f, handler);
      try {
        const executor = await f.surface();
        expect(
          executor.getToolInfo("inventory-items", f.context),
        ).toBeUndefined();
        const result = await executor.execute(
          {
            toolCallId: "direct",
            name: "inventory-items",
            arguments: JSON.stringify({ bag: "leather" }),
          },
          f.context,
        );
        expect(result.error).toMatchObject({
          code: "unavailable",
          message: `The tool "inventory-items" is unavailable in this session: ${reason}.`,
        });
        expect(result.refused).toBe(true);
        expect(result.result).not.toMatch(/provider"|other"/);
        expect(handler).not.toHaveBeenCalled();
      } finally {
        await f.toolExecutor.close();
      }
    },
  );
});

describe("imported reads and the commit", () => {
  const writer: RuntimeManifest = {
    name: "writer/write",
    pluginId: "writer",
    description: "writer",
    runtimeType: "function",
    stage: "pre-turn",
    outputKind: "system",
    trigger: { type: "auto" },
  };
  const write: FunctionHandler = async (ctx) => {
    await ctx.pluginData!.set("items", "sword", "upstream sword");
    return { outcome: "success", value: {} };
  };
  // Tells the story when the importing agent is auxiliary.
  const narrator: RuntimeManifest = {
    name: "other/narrator",
    pluginId: "other",
    description: "narrator",
    runtimeType: "function",
    stage: "narrative",
    outputKind: "story",
    trigger: { type: "auto" },
  };
  const tell: FunctionHandler = async () => ({
    outcome: "success",
    value: { narrativeOutput: "The story goes on." },
  });

  it.each([false, true])(
    "records the provider's uncommitted write as a read dependency (story caller: %s)",
    async (story) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { services, deps, store, toolExecutor } = await fixture();
      // The provider reads its own data, upstream writes included.
      services.register(
        "writer",
        itemsService({
          handler: async (_input: unknown, ctx: PluginServiceContext) => ({
            sword: await ctx.pluginData.get("items", "sword"),
          }),
        }),
      );
      const caller = agent(story ? {} : { outputKind: "system" });
      const { llm, requests } = scripted({
        [AGENT_MARK]: (index) =>
          index === 0
            ? call("inventory-items", { bag: "leather" })
            : text(story ? "The sword gleams." : "{}"),
      });
      try {
        const execution = await executeTurn(
          input,
          [writer, caller, ...(story ? [] : [narrator])],
          {
            ...deps(llm),
            loadRuntime: async (manifest: RuntimeManifest) => ({
              manifest,
              promptTemplate: `${AGENT_MARK} Tell it.`,
              ...(manifest.name === writer.name ? { handler: write } : {}),
              ...(manifest.name === narrator.name ? { handler: tell } : {}),
            }),
          },
        );
        expect(toolMessage(requests[1])).toEqual({
          data: { sword: "upstream sword" },
        });
        const reader = resultOf(execution)!;
        const producer = resultOf(execution, writer.name)!;
        expect(reader.status).toBe("success");
        expect(execution.commit.readDependencies?.[reader.runId]).toEqual([
          producer.runId,
        ]);
        const outcome = await commitExecution({
          store,
          execution,
          completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
          proposalGuard: (proposal) =>
            proposal.source.pluginId === "writer"
              ? "writer refused"
              : undefined,
        });
        expect(outcome.status).toBe("committed");
        const isolated =
          outcome.isolatedRuntimes?.map((result) => result.runtimeId) ?? [];
        expect(isolated).toContain(writer.name);
        if (story) {
          expect(isolated).not.toContain(caller.name);
          const kept = await store.queryTraceEvents(SESSION, {
            types: ["read-dependency.kept"],
          });
          expect(kept.map((event) => event.payload)).toMatchObject([
            { runtimeId: caller.name, producerRuntimeId: writer.name },
          ]);
        } else {
          expect(isolated).toContain(caller.name);
        }
      } finally {
        await toolExecutor.close();
      }
    },
  );
});

describe("imports in every agent entry", () => {
  it("are deferred when a defer list names them, and stay offered otherwise", async () => {
    const { services, deps, toolExecutor } = await fixture();
    services.register("provider", itemsService());
    services.register(
      "provider",
      itemsService({ name: "weight", contract: "inventory.weight@1" }),
    );
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        [
          call("search-tools", { query: "items in a bag" }),
          call("inventory-items", { bag: "leather" }),
          text("A sword."),
        ][index]!,
    });
    try {
      await executeTurn(
        input,
        [
          agent({
            tools: {
              services: [
                { contract: CONTRACT, name: "inventory-items" },
                { contract: "inventory.weight@1", name: "inventory-weight" },
              ],
              defer: ["inventory-items"],
            },
          }),
        ],
        deps(llm),
      );
      const names = requests.map((request) =>
        request.tools.map((tool) => tool.name),
      );
      expect(names[0]).toEqual(
        expect.arrayContaining(["search-tools", "inventory-weight"]),
      );
      expect(names[0]).not.toContain("inventory-items");
      expect(names[1]).toContain("inventory-items");
      expect(toolMessage(requests[2])).toEqual({
        data: { items: [{ name: "leather sword" }] },
      });
    } finally {
      await toolExecutor.close();
    }
  });

  it("are deferred like other tools and found by search-tools", async () => {
    const { services, deps, toolExecutor } = await fixture();
    services.register("provider", itemsService());
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        [
          call("search-tools", { query: "items in a bag" }),
          call("inventory-items", { bag: "leather" }),
          text("A sword."),
        ][index]!,
    });
    try {
      await executeTurn(
        input,
        [
          agent({
            tools: {
              services: [{ contract: CONTRACT, name: "inventory-items" }],
              defer: true,
            },
          }),
        ],
        deps(llm),
      );
      const names = requests.map((request) =>
        request.tools.map((tool) => tool.name),
      );
      expect(names[0]).toContain("search-tools");
      expect(names[0]).not.toContain("inventory-items");
      expect(names[1]).toContain("inventory-items");
      expect(toolMessage(requests[2])).toEqual({
        data: { items: [{ name: "leather sword" }] },
      });
    } finally {
      await toolExecutor.close();
    }
  });

  it("are offered again to a resumed run", async () => {
    const { services, deps, store, toolExecutor } = await fixture();
    services.register("provider", itemsService());
    const manifest = agent({
      outputKind: "system",
      tools: {
        builtin: ["suspend"],
        services: [{ contract: CONTRACT, name: "inventory-items" }],
      },
    });
    const { llm, requests } = scripted({
      [AGENT_MARK]: (index) =>
        [
          call("suspend", {
            reason: "Which bag?",
            resumeSchema: { type: "object" },
          }),
          call("inventory-items", { bag: "leather" }),
          text(JSON.stringify({ done: true })),
        ][index]!,
    });
    try {
      const execution = await executeTurn(input, [manifest], deps(llm));
      expect(resultOf(execution)?.status).toBe("suspended");
      await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      const [suspension] = await store.listSuspensions(SESSION);
      const resumed = await resumeSuspendedRuntime(
        suspension!,
        { bag: "leather" },
        manifest,
        deps(llm),
      );
      expect(resumed.result.status).toBe("success");
      expect(requests[1]!.tools.map((tool) => tool.name)).toContain(
        "inventory-items",
      );
      expect(toolMessage(requests[2])).toEqual({
        data: { items: [{ name: "leather sword" }] },
      });
    } finally {
      await toolExecutor.close();
    }
  });

  it("are offered to a sub-agent, which calls as itself", async () => {
    const { services, deps, emitter, toolExecutor } = await fixture();
    services.register("provider", itemsService());
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
      tools: { services: [{ contract: CONTRACT, name: "inventory-items" }] },
      maxRetries: 0,
    };
    const lineSchema = {
      type: "object",
      properties: { line: { type: "string" } },
      required: ["line"],
    };
    let answer: unknown;
    const main: RuntimeManifest = {
      name: "caller/main",
      pluginId: "caller",
      description: "main",
      runtimeType: "function",
      stage: "narrative",
      outputKind: "system",
      trigger: { type: "auto" },
    };
    const { llm, requests } = scripted({
      [HELPER_MARK]: (index) =>
        index === 0
          ? call("inventory-items", { bag: "leather" })
          : text(JSON.stringify({ line: "A sword." })),
    });
    try {
      await executeTurn(input, [main, helper], {
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
                  answer = await ctx.agents!.run({
                    target: { contract: "fixture.helper@1" },
                    brief: "Look in the bag.",
                  });
                  return { outcome: "success", value: {} };
                },
              },
      });
      expect(answer).toMatchObject({ ok: true, output: { line: "A sword." } });
      expect(requests[0]!.tools.map((tool) => tool.name)).toContain(
        "inventory-items",
      );
      expect(
        emitter.events.find(
          (event) => event.type === "plugin.service.completed",
        )?.payload,
      ).toMatchObject({
        callerPluginId: "helper",
        providerPluginId: "provider",
        outcome: "success",
      });
    } finally {
      await toolExecutor.close();
    }
  });
});
