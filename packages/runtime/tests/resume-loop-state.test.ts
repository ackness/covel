/**
 * A suspended agent resumes with the loop state its transcript cannot carry:
 * spent corrections, the deferred tools it activated, prose written before a
 * late interjection, a completing tool's output and its prompt segments. The
 * resumed loop behaves as the uninterrupted loop would have.
 */

import { describe, expect, it, vi } from "vitest";
import type { LLMMessage, RuntimeManifest, TurnInput } from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  createPluginDataTools,
  suspendTool,
  tool,
  type ToolModule,
} from "@covel/tools";
import { z } from "zod";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";
import { resumeRuntimePipeline } from "../src/resume/turn-resume.js";
import { collectExecutionSuspensions } from "../src/suspension-artifact.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";
import {
  input,
  makeExecutor,
  manifest,
  markTool,
  prose,
  queuedLLM,
  saveTool,
  scriptedLLM,
  toolCall,
  type GenerateParams,
} from "./_helpers/agent-loop-fixture.js";

const ASK = { reason: "Need input", resumeSchema: { type: "object" } };

const lookupTool = tool({
  name: "lookup",
  description: "look up a fact in the archive",
  parameters: z.object({}),
  async execute() {
    return { fact: "the gate is open" };
  },
});

function runtime(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return manifest({
    trigger: { type: "manual" },
    tools: { plugin: ["mark"], builtin: ["suspend"] },
    ...overrides,
  });
}

function deps(
  llm: TurnExecutorDeps["llm"],
  extra: Partial<TurnExecutorDeps> & {
    readonly modules?: readonly ToolModule[];
    readonly outputSchema?: Record<string, unknown>;
  } = {},
): TurnExecutorDeps {
  const { modules, outputSchema, ...rest } = extra;
  return {
    store: createMemoryStore(),
    llm,
    toolExecutor: makeExecutor([
      markTool,
      suspendTool,
      saveTool,
      lookupTool,
      ...(modules ?? []),
    ]),
    loadRuntime: async (rt) => ({
      manifest: rt,
      promptTemplate: "Do the work.",
      ...(outputSchema ? { outputSchema } : {}),
    }),
    ...rest,
  };
}

/** Run `rt` until it suspends and return its continuation. */
async function suspend(
  rt: RuntimeManifest,
  runDeps: TurnExecutorDeps,
): Promise<SuspensionRecord> {
  const turn = await runTurnPipeline(
    { ...input, origin: "manual", manualTrigger: { runtimeId: rt.name } },
    [rt],
    runDeps,
  );
  expect(turn.runtimeResults[0]?.status).toBe("suspended");
  const [record] = collectExecutionSuspensions(turn);
  if (!record) throw new Error("expected a continuation");
  return record;
}

function withoutLoop(record: SuspensionRecord): SuspensionRecord {
  const { loop: _loop, ...continuation } = record.pendingContinuation;
  return { ...record, pendingContinuation: continuation };
}

const toolNames = (request: GenerateParams | undefined) =>
  (request?.tools ?? []).map((definition) => definition.name);

describe("corrections survive a suspension", () => {
  const rt = runtime({ requireToolUse: true });

  async function suspended() {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The bare text answer spends the one tool-use correction.
    const llm = queuedLLM([prose("done"), toolCall("suspend", ASK)]);
    return suspend(rt, deps(llm));
  }

  it("does not correct a resumed loop again once the correction was spent", async () => {
    const record = await suspended();
    expect(record.pendingContinuation.loop).toEqual({
      corrections: { toolUse: 1 },
    });
    const llm = queuedLLM([prose("finished"), prose("finished again")]);
    const result = await resumeRuntimePipeline(record, {}, rt, deps(llm));
    expect(llm.requests).toHaveLength(1);
    expect(result.status).toBe("failed");
  });

  it("corrects a resumed loop whose continuation spent none", async () => {
    const record = withoutLoop(await suspended());
    const llm = queuedLLM([prose("finished"), prose("finished again")]);
    const result = await resumeRuntimePipeline(record, {}, rt, deps(llm));
    expect(llm.requests).toHaveLength(2);
    expect(result.status).toBe("failed");
  });
});

describe("loop perturbation survives a suspension", () => {
  async function suspended(rt: RuntimeManifest) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = queuedLLM([
      toolCall("mark", { note: "a" }, "tc-1"),
      toolCall("mark", { note: "a" }, "tc-2"),
      toolCall("suspend", ASK, "tc-3"),
    ]);
    const record = await suspend(rt, deps(llm));
    expect(record.pendingContinuation.loop?.corrections).toEqual({
      loopPerturbation: 1,
    });
    return record;
  }

  it("fails the resumed loop at the next repeat instead of perturbing it", async () => {
    const rt = runtime({ loopDetectionThreshold: 2 });
    const record = await suspended(rt);
    const llm = queuedLLM([
      toolCall("mark", { note: "a" }, "tc-4"),
      prose("done"),
    ]);
    const result = await resumeRuntimePipeline(record, {}, rt, deps(llm));
    expect(result).toMatchObject({
      status: "failed",
      stop: { reason: "loop-detected" },
    });
    expect(llm.requests).toHaveLength(1);
  });

  it("takes the tools away at the next repeat for the answer-without-tools fallback", async () => {
    const rt = runtime({
      loopDetectionThreshold: 2,
      loopProfile: { fallback: "answer-without-tools" },
    });
    const record = await suspended(rt);
    const llm = queuedLLM([
      toolCall("mark", { note: "a" }, "tc-4"),
      prose("done"),
    ]);
    const result = await resumeRuntimePipeline(record, {}, rt, deps(llm));
    expect(result.status).toBe("success");
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.tools).toBeUndefined();
  });

  it("perturbs a resumed loop whose continuation spent none", async () => {
    const rt = runtime({ loopDetectionThreshold: 2 });
    const record = withoutLoop(await suspended(rt));
    const llm = queuedLLM([
      toolCall("mark", { note: "a" }, "tc-4"),
      prose("done"),
    ]);
    const result = await resumeRuntimePipeline(record, {}, rt, deps(llm));
    expect(result.status).toBe("success");
    expect(llm.requests).toHaveLength(2);
  });
});

describe("activated deferred tools survive a suspension", () => {
  const rt = runtime({
    tools: { plugin: ["lookup"], builtin: ["suspend"], defer: ["lookup"] },
  });

  async function suspended() {
    const llm = queuedLLM([
      toolCall("search-tools", { query: "look up a fact archive" }, "tc-1"),
      toolCall("suspend", ASK, "tc-2"),
    ]);
    const record = await suspend(rt, deps(llm));
    expect(toolNames(llm.requests[1])).toContain("lookup");
    return record;
  }

  it("offers the activated tools on the first resumed request", async () => {
    const record = await suspended();
    expect(record.pendingContinuation.loop).toEqual({
      activatedTools: ["lookup"],
    });
    const llm = queuedLLM([toolCall("lookup", {}, "tc-3"), prose("found it")]);
    const result = await resumeRuntimePipeline(record, {}, rt, deps(llm));
    expect(result.status).toBe("success");
    expect(toolNames(llm.requests[0])).toContain("lookup");
    expect(result.toolCalls.map((call) => call.toolName)).toEqual([
      "search-tools",
      "lookup",
    ]);
  });

  it("skips a saved name that is no longer deferred or no longer resolves", async () => {
    const record = await suspended();
    const stale: SuspensionRecord = {
      ...record,
      pendingContinuation: {
        ...record.pendingContinuation,
        loop: { activatedTools: ["lookup", "suspend", "vanished"] },
      },
    };
    const llm = queuedLLM([prose("done")]);
    const result = await resumeRuntimePipeline(stale, {}, rt, deps(llm));
    expect(result.status).toBe("success");
    const names = toolNames(llm.requests[0]);
    expect(names.filter((name) => name === "suspend")).toHaveLength(1);
    expect(names).toContain("lookup");
    expect(names).not.toContain("vanished");
  });
});

describe("steered prose survives a suspension", () => {
  it("joins the prose written before the suspension into the final output", async () => {
    const rt = runtime({ loopProfile: { steering: true } });
    let steered = false;
    const turnControl = {
      drainSteering: () => {
        // One interjection arrives while the first answer streams.
        if (steered || llm.requests.length !== 1) return [];
        steered = true;
        return ["Wait, one more thing."];
      },
    };
    const llm = queuedLLM([
      prose("Before the question."),
      toolCall("suspend", ASK),
    ]);
    const record = await suspend(rt, deps(llm, { turnControl }));
    expect(record.pendingContinuation.loop).toEqual({
      steeredProse: ["Before the question."],
    });
    const resumed = queuedLLM([prose("After the answer.")]);
    const result = await resumeRuntimePipeline(record, {}, rt, deps(resumed));
    expect(result.status).toBe("success");
    expect(JSON.stringify(result.output)).toContain(
      "Before the question.\\n\\nAfter the answer.",
    );
  });
});

describe("a completing tool's output survives a suspension", () => {
  it("keeps the tool's output as the answer when the resumed model ends with text", async () => {
    const outputSchema = {
      type: "object",
      properties: { saved: { type: "boolean" } },
      required: ["saved"],
    };
    const rt = runtime({
      requireToolUse: true,
      completeAfterTools: ["save"],
      tools: { plugin: ["save"], builtin: ["suspend"] },
    });
    const llm = queuedLLM([
      {
        content: null,
        toolCalls: [
          { id: "tc-save", name: "save", arguments: "{}" },
          { id: "tc-ask", name: "suspend", arguments: JSON.stringify(ASK) },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const record = await suspend(rt, deps(llm, { outputSchema }));
    expect(record.pendingContinuation.loop).toEqual({
      completingToolOutput: { saved: true },
    });
    const resumed = queuedLLM([prose("All done, nothing else to add.")]);
    const result = await resumeRuntimePipeline(
      record,
      {},
      rt,
      deps(resumed, { outputSchema }),
    );
    expect(result).toMatchObject({
      status: "success",
      output: { saved: true },
    });
  });
});

describe("context on resume", () => {
  it("hands PreLLMCall the saved prompt segments and runs PostContextAssembly once", async () => {
    const rt = runtime();
    const hookPipeline = createHookPipeline();
    const seen: { event: string; segments: unknown }[] = [];
    for (const event of ["PostContextAssembly", "PreLLMCall"] as const)
      hookPipeline.register({
        id: `observe-${event}`,
        event,
        handler: async (_context, payload) => {
          seen.push({
            event,
            segments: (payload as { promptSegments?: unknown }).promptSegments,
          });
          return { action: "continue" };
        },
      });
    const extensionExecution = {
      run: async (point: { id: string }, value: unknown) =>
        point.id === "prompt.segment@1"
          ? [
              [
                {
                  id: "house-rules",
                  content: "<house-rules>",
                  position: "system",
                  audience: "all",
                  volatility: "session",
                  providerPluginId: "rules",
                },
              ],
            ]
          : value,
    } as unknown as TurnExecutorDeps["extensionExecution"];
    const included = [{ pluginId: "rules", id: "house-rules" }];
    const record = await suspend(
      rt,
      deps(queuedLLM([toolCall("suspend", ASK)]), {
        hookPipeline,
        extensionExecution,
      }),
    );
    expect(record.pendingContinuation.promptSegments).toEqual(included);
    const result = await resumeRuntimePipeline(
      record,
      {},
      rt,
      deps(queuedLLM([prose("done")]), { hookPipeline, extensionExecution }),
    );
    expect(result.status).toBe("success");
    expect(seen).toEqual([
      { event: "PostContextAssembly", segments: included },
      { event: "PreLLMCall", segments: included },
      { event: "PreLLMCall", segments: included },
    ]);
  });

  it("reads committed upstream writes and its own buffered write", async () => {
    const store = createMemoryStore();
    const timestamp = "2026-10-29T00:00:00.000Z";
    await store.createSession({
      id: input.sessionId,
      locale: "en-US",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: ["plug"],
      completedPlayerTurns: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const upstream: RuntimeManifest = manifest({
      name: "plug/upstream",
      runtimeType: "function",
      tools: undefined,
    });
    const agent = manifest({
      name: "plug/agent",
      stage: "post-turn",
      tools: {
        builtin: ["plugin-data-get", "plugin-data-set", "suspend"],
      },
    });
    const modules = [...createPluginDataTools(store), suspendTool];
    const executionDeps = (llm: TurnExecutorDeps["llm"]) => ({
      store,
      llm,
      toolExecutor: createToolExecutor({
        store,
        findTool: (name) => modules.find((module) => module.name === name),
      }),
      loadRuntime: async (rt: RuntimeManifest) => ({
        manifest: rt,
        promptTemplate: "Do the work.",
        handler: async (ctx: {
          pluginData?: {
            set(namespace: string, key: string, value: unknown): Promise<void>;
          };
        }) => {
          await ctx.pluginData!.set("notes", "upstream", "from upstream");
          return { outcome: "success" as const, value: {} };
        },
      }),
    });
    const turnInput: TurnInput = {
      ...input,
      logicalTurnId: "logical-turn",
    };
    const execution = await executeTurn(
      turnInput,
      [upstream, agent],
      executionDeps(
        queuedLLM([
          toolCall(
            "plugin-data-set",
            { namespace: "notes", key: "own", value: "from the agent" },
            "tc-1",
          ),
          toolCall("suspend", ASK, "tc-2"),
        ]),
      ) as never,
    );
    expect(
      (
        await commitExecution({
          store,
          execution,
          completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
        })
      ).status,
    ).toBe("committed");
    const [record] = await store.listSuspensions(input.sessionId);
    expect(
      await store.getPluginData(input.sessionId, "plug", "notes", "own"),
    ).toBeNull();

    const llm = scriptedLLM((_params, call) =>
      call === 1
        ? toolCall(
            "plugin-data-get",
            { namespace: "notes", key: "upstream" },
            "tc-3",
          )
        : call === 2
          ? toolCall(
              "plugin-data-get",
              { namespace: "notes", key: "own" },
              "tc-4",
            )
          : prose("done"),
    );
    const resumed = await resumeSuspendedRuntime(
      record!,
      {},
      agent,
      executionDeps(llm) as never,
    );
    expect(resumed.result.status).toBe("success");
    const toolResults = (llm.requests.at(-1)!.messages as LLMMessage[])
      .filter((message) => message.role === "tool")
      .map((message) => JSON.stringify(message.content));
    expect(toolResults.some((text) => text.includes("from upstream"))).toBe(
      true,
    );
    expect(toolResults.some((text) => text.includes("from the agent"))).toBe(
      true,
    );
  });
});
