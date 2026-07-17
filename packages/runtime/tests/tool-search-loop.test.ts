/**
 * Deferred tool loading (tool-search) — end-to-end agent-loop behaviour.
 *
 * A manifest with `tools.defer` advertises a REDUCED tool list (search-tools
 * instead of the deferred schemas); when the LLM calls `search-tools`, the
 * loop intercepts it (never reaching the ToolExecutor), ranks the deferred
 * pool with BM25, and grows the working tool surface so the NEXT step can
 * call the activated tool directly. These tests script the LLM and capture
 * the `tools` array of every request to pin that contract, plus the
 * `defer: [subset]` and no-defer shapes of buildToolDefinitions.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { SEARCH_TOOLS_TOOL_NAME, tool } from "@covel/tools";
import type { ToolModule } from "@covel/tools";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { buildToolDefinitions } from "../src/turn-executor/turn-executor-helpers.js";
import { resolveDeferredToolNames } from "../src/agent-loop/tool-search.js";
import type {
  LLMAdapter,
  LLMResponse,
  LLMToolDefinition,
} from "../src/llm/llm-adapter.js";

const SESSION_ID = "sess-tool-search";

function echoTool(name: string, description: string): ToolModule {
  return tool({
    name,
    description,
    parameters: z.object({ value: z.string() }),
    execute: async (params: { value: string }) => ({ echoed: params.value }),
  });
}

const TOOL_POOL: ToolModule[] = [
  echoTool(
    "set-scene-background",
    "Switch the scene background image to a registered variant.",
  ),
  echoTool("roll-dice", "Roll dice with an expression like 2d6+3."),
  echoTool("grant-item", "Give the player an inventory item."),
];

/** Scripted adapter: replays canned responses, recording each request's tools. */
class ScriptedLLM implements LLMAdapter {
  readonly requestTools: (readonly LLMToolDefinition[] | undefined)[] = [];
  private step = 0;
  constructor(private readonly script: LLMResponse[]) {}
  async generate(params: {
    tools?: readonly LLMToolDefinition[];
  }): Promise<LLMResponse> {
    this.requestTools.push(params.tools);
    const response = this.script[this.step];
    this.step += 1;
    if (!response) throw new Error("ScriptedLLM: script exhausted");
    return response;
  }
}

function toolCallResponse(name: string, args: object): LLMResponse {
  return {
    content: null,
    toolCalls: [{ id: `tc-${name}`, name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const DONE: LLMResponse = {
  content: "done.",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 5 },
};

function makeManifest(over?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "mega/worker",
    pluginId: "mega",
    description: "test runtime with a deferred tool pool",
    priority: 500,
    outputKind: "plugin",
    tools: {
      builtin: TOOL_POOL.map((t) => t.name),
      defer: true,
    },
    trigger: { type: "auto" },
    ...over,
  } as RuntimeManifest;
}

function makeDeps(llm: LLMAdapter): TurnExecutorDeps {
  return {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: "Do the task using your tools.",
    }),
    llm,
    toolExecutor: createToolExecutor({
      findTool: (name) => TOOL_POOL.find((t) => t.name === name),
    }),
  };
}

const TURN_INPUT: TurnInput = {
  sessionId: SESSION_ID,
  turnId: "turn-1",
  playerMessage: "roll for initiative",
};

describe("tool-search: deferred loading in the agent loop", () => {
  it("advertises only search-tools initially, activates matches for the next step", async () => {
    const llm = new ScriptedLLM([
      toolCallResponse(SEARCH_TOOLS_TOOL_NAME, { query: "roll dice" }),
      toolCallResponse("roll-dice", { value: "2d6" }),
      DONE,
    ]);
    const manifest = makeManifest();

    const result = await executeTurn(TURN_INPUT, [manifest], makeDeps(llm), {
      maxSteps: 5,
    });
    const rr = result.runtimeResults.find((r) => r.runtimeId === manifest.name);
    expect(rr?.status).toBe("success");

    // Step 1: reduced surface — search-tools + runtime-done, no pool schemas.
    const firstTools = (llm.requestTools[0] ?? []).map((d) => d.name);
    expect(firstTools).toContain(SEARCH_TOOLS_TOOL_NAME);
    expect(firstTools).toContain("runtime-done");
    for (const t of TOOL_POOL) expect(firstTools).not.toContain(t.name);

    // Step 2: the activated tool joined the surface and stays for step 3.
    const secondTools = (llm.requestTools[1] ?? []).map((d) => d.name);
    expect(secondTools).toContain("roll-dice");
    const thirdTools = (llm.requestTools[2] ?? []).map((d) => d.name);
    expect(thirdTools).toContain("roll-dice");

    // The activated tool actually executed through the normal executor path.
    const rollCall = rr?.toolCalls?.find((tc) => tc.toolName === "roll-dice");
    expect(rollCall?.output).toEqual({ echoed: "2d6" });
    // And the search itself is traced.
    const searchCall = rr?.toolCalls?.find(
      (tc) => tc.toolName === SEARCH_TOOLS_TOOL_NAME,
    );
    expect(searchCall?.output).toMatchObject({
      activated: ["roll-dice"],
      query: "roll dice",
    });
  });

  it("feeds a no-match result back without activating anything", async () => {
    const llm = new ScriptedLLM([
      toolCallResponse(SEARCH_TOOLS_TOOL_NAME, { query: "teleport wormhole" }),
      DONE,
    ]);
    const result = await executeTurn(
      TURN_INPUT,
      [makeManifest()],
      makeDeps(llm),
      { maxSteps: 4 },
    );
    expect(result.runtimeResults[0]?.status).toBe("success");
    const secondTools = (llm.requestTools[1] ?? []).map((d) => d.name);
    for (const t of TOOL_POOL) expect(secondTools).not.toContain(t.name);
  });
});

describe("buildToolDefinitions defer shapes", () => {
  const toolExecutor = createToolExecutor({
    findTool: (name) => TOOL_POOL.find((t) => t.name === name),
  });

  it("defer: [subset] withholds only the listed names", () => {
    const manifest = makeManifest({
      tools: {
        builtin: TOOL_POOL.map((t) => t.name),
        defer: ["set-scene-background", "grant-item"],
      },
    });
    const names = (buildToolDefinitions(manifest, toolExecutor) ?? []).map(
      (d) => d.name,
    );
    expect(names).toContain("roll-dice");
    expect(names).toContain(SEARCH_TOOLS_TOOL_NAME);
    expect(names).not.toContain("set-scene-background");
    expect(names).not.toContain("grant-item");
  });

  it("defer entries outside the whitelist are ignored", () => {
    const manifest = makeManifest({
      tools: {
        builtin: ["roll-dice"],
        defer: ["roll-dice", "not-declared-tool"],
      },
    });
    expect(resolveDeferredToolNames(manifest)).toEqual(new Set(["roll-dice"]));
  });

  it("no defer ⇒ byte-identical full advertisement, no search-tools", () => {
    const manifest = makeManifest({
      tools: { builtin: TOOL_POOL.map((t) => t.name) },
    });
    const names = (buildToolDefinitions(manifest, toolExecutor) ?? []).map(
      (d) => d.name,
    );
    for (const t of TOOL_POOL) expect(names).toContain(t.name);
    expect(names).not.toContain(SEARCH_TOOLS_TOOL_NAME);
  });
});
