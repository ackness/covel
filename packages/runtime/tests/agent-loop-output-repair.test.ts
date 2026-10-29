import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import type { LLMAdapter } from "@covel/shared";
import { tool } from "@covel/tools";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import {
  checkAgentOutput,
  settleAgentLoop,
} from "../src/agent-loop/settle-agent-loop.js";
import { finalizeAgentOutput } from "../src/agent-loop/finalize-agent-output.js";
import { createAgentSchemaGate } from "../src/agent-loop/runtime-output-validator.js";
import { createLoopState } from "../src/agent-loop/loop-state.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { executeTurn } from "../src/execution.js";
import { commitExecution } from "../src/commit/commit-execution.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";
import {
  input,
  makeExecutor,
  manifest,
  prose,
  queuedLLM,
  runLoop,
  toolCall,
  type LoopRunOptions,
} from "./_helpers/agent-loop-fixture.js";

const outputSchema = {
  type: "object",
  required: ["answer"],
  properties: { answer: { type: "string" } },
  additionalProperties: false,
};
const loaded: LoadedRuntime = {
  manifest: manifest(),
  promptTemplate: "Write JSON.",
  outputSchema,
};
const valid = '{"answer":"fixed"}';

async function run(opts: LoopRunOptions) {
  const runtime = opts.manifest ?? manifest();
  const loop = await runLoop({
    ...opts,
    manifest: runtime,
    loaded: opts.loaded ?? loaded,
  });
  const args = {
    manifest: runtime,
    input,
    runId: "run-loop",
    startTime: Date.now(),
    toolLoop: loop,
    outputSchema: (opts.loaded ?? loaded).outputSchema,
  };
  return { loop, args, ...settleAgentLoop(args) };
}

afterEach(() => vi.restoreAllMocks());

describe("output repair", () => {
  it("repairs schema prose with tools off, required fields and additive step events", async () => {
    const emitter = makeEmitterSpy();
    const llm = queuedLLM([prose("an unstructured draft"), prose(valid)]);
    const { result, loop } = await run({ llm, deps: { emitter } });
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ answer: "fixed" });
    expect(loop.stop).toEqual({ reason: "completed", repaired: true });
    expect(result.stop).toEqual(loop.stop);
    expect(llm.requests).toHaveLength(2);
    const request = llm.requests[1]!;
    expect(request.tools).toBeUndefined();
    expect(request.defaults?.toolChoice).toBeUndefined();
    expect(request.messages).toContainEqual({
      role: "assistant",
      content: "an unstructured draft",
    });
    const message = request.messages.at(-1)?.content;
    expect(message).toContain("plain prose instead of the JSON object");
    expect(message).toContain("Required fields: {answer}");
    expect(message).not.toContain("run-loop");
    expect(message).not.toContain("plug/loop");
    expect(message).not.toContain("an unstructured draft");
    const steps = emitter.events.filter((e) => e.type.startsWith("step."));
    expect(steps.map((e) => [e.type, e.payload.step])).toEqual([
      ["step.started", 1],
      ["step.completed", 1],
      ["step.started", 2],
      ["step.completed", 2],
    ]);
    expect(steps[2]?.payload).toMatchObject({ repair: true, toolCount: 0 });
    expect(steps[3]?.payload).toMatchObject({
      repair: true,
      notes: [{ kind: "output-repair" }],
      stopReason: "completed",
    });
  });

  it("clears a required manifest tool choice for repair", async () => {
    const llm = queuedLLM([prose("draft"), prose(valid)]);
    const { result } = await run({
      llm,
      manifest: manifest({ llm: { toolChoice: "required" } }),
    });
    expect(result.status).toBe("success");
    expect(llm.requests[1]?.tools).toBeUndefined();
    expect(llm.requests[1]?.defaults?.toolChoice).toBeUndefined();
  });

  it("keeps schema mismatch invalid after exactly one repair", async () => {
    const llm = queuedLLM([prose('{"answer":7}')]);
    const { result } = await run({ llm });
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.messages.at(-1)?.content).toContain(
      "/answer must be string",
    );
    expect(result.stop).toEqual({ reason: "invalid-output" });
    expect(result.status).toBe("failed");
  });

  it("repairs an empty completed story and commits its narrative", async () => {
    const runtime = manifest({ outputKind: "story", tools: {} });
    const llm = queuedLLM([
      prose('{"narrativeOutput":" "}'),
      prose("The lantern lights the stairs."),
    ]);
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: input.sessionId,
      locale: "en-US",
      status: "active",
      phase: "playing",
      activePlugins: [runtime.pluginId],
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      completedPlayerTurns: 0,
      createdAt: now,
      updatedAt: now,
    });
    const execution = await executeTurn(
      { ...input, logicalTurnId: "logical-story" },
      [runtime],
      {
        store,
        llm,
        loadRuntime: async () => ({
          manifest: runtime,
          promptTemplate: "Write the story.",
        }),
      },
    );
    const result = execution.result.runtimeResults[0];
    expect(result?.stop).toEqual({ reason: "completed", repaired: true });
    expect(llm.requests[1]?.messages.at(-1)?.content).toContain(
      "the story text is empty",
    );
    expect(result?.output).toEqual({
      narrativeOutput: "The lantern lights the stairs.",
    });
    const committed = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });
    expect(committed.status).toBe("committed");
    expect(
      (await store.getSession(input.sessionId))?.completedPlayerTurns,
    ).toBe(1);
    expect(
      (await store.listMessages(input.sessionId))
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual(["The lantern lights the stairs."]);
  });

  it.each([0, 2])(
    "honors the output repair budget %s",
    async (outputRepair) => {
      const llm = queuedLLM([prose("prose")]);
      const { result } = await run({
        llm,
        manifest: manifest({ loopProfile: { corrections: { outputRepair } } }),
      });
      expect(llm.requests).toHaveLength(1 + outputRepair);
      expect(result.stop).toEqual({ reason: "invalid-output" });
    },
  );

  it("never repairs completing-tool output that fails its schema", async () => {
    const save = tool({
      name: "save",
      description: "save",
      parameters: z.object({}),
      execute: async () => ({ answer: 7 }),
    });
    const llm = queuedLLM([toolCall("save", {})]);
    const runtime = manifest({
      requireToolUse: true,
      completeAfterTools: ["save"],
      tools: { plugin: ["save"] },
      output: { schema: "./output.schema.json" },
    });
    const { result, loop } = await run({
      llm,
      manifest: runtime,
      deps: { toolExecutor: makeExecutor([save]) },
    });
    expect(loop.finalToolOutput).toEqual({ answer: 7 });
    expect(result.stop).toEqual({ reason: "invalid-output" });
    expect(llm.requests).toHaveLength(1);
  });

  it("skips repair with less than three seconds left", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const generate = vi.fn<LLMAdapter["generate"]>(async () => {
      vi.mocked(Date.now).mockReturnValue(now + 7_001);
      return prose("prose");
    });
    const { result } = await run({ llm: { generate } });
    expect(generate).toHaveBeenCalledOnce();
    expect(result.stop).toEqual({ reason: "invalid-output" });
  });

  it("repairs after a max-steps finalizer and keeps both stop flags", async () => {
    const emitter = makeEmitterSpy();
    const llm = queuedLLM([
      toolCall("mark", { note: "a" }),
      prose("bad finalizer"),
      prose(valid),
    ]);
    const { result } = await run({ llm, maxSteps: 1, deps: { emitter } });
    expect(llm.requests).toHaveLength(3);
    expect(result.stop).toEqual({
      reason: "max-steps",
      finalizer: true,
      repaired: true,
    });
    expect(
      emitter.events
        .filter((e) => e.type === "step.started")
        .map((e) => e.payload),
    ).toMatchObject([
      { step: 1 },
      { step: 2, finalizer: true },
      { step: 3, repair: true },
    ]);
  });

  it("repairs a PreStep tool-finished exit using one past the last started step", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "finish",
      event: "PreStep",
      handler: async () => ({
        action: "continue",
        replace: { stop: { reason: "tool-finished" } },
      }),
    });
    const emitter = makeEmitterSpy();
    const llm = queuedLLM([prose(valid)]);
    const { result } = await run({ llm, hookPipeline, deps: { emitter } });
    expect(result.stop).toEqual({ reason: "tool-finished", repaired: true });
    expect(
      emitter.events.find((e) => e.type === "step.started")?.payload,
    ).toMatchObject({ step: 1, repair: true });
  });

  it.each(["requireToolUse", "requireExplicitCompletion"] as const)(
    "does not repair unmet %s",
    async (requirement) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const llm = queuedLLM([prose("prose")]);
      const { result } = await run({
        llm,
        manifest: manifest({ [requirement]: true }),
        ...(requirement === "requireExplicitCompletion"
          ? {
              loaded: {
                manifest: manifest(),
                promptTemplate: "Finish explicitly.",
              },
            }
          : {}),
      });
      expect(result.status).toBe("failed");
      expect(llm.requests).toHaveLength(2); // Original tool-use correction only.
      expect(llm.requests.at(-1)?.tools?.length).toBeGreaterThan(0);
    },
  );

  it("preserves the original output if the repair request fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const { result, loop } = await run({
      llm: {
        generate: async () => {
          if (++calls > 1) throw new Error("provider unavailable");
          return prose("original prose");
        },
      },
    });
    expect(calls).toBe(2);
    expect(loop.finalContent).toBe("original prose");
    expect(loop.stop).toEqual({ reason: "completed" });
    expect(result.stop).toEqual({ reason: "invalid-output" });
  });

  it("resets streamed drafts and replaces all steered prose", async () => {
    const emitter = makeEmitterSpy();
    const chunks: { textDelta: string; reset?: true }[] = [];
    const drafts = [
      '{"narrativeOutput":" "}',
      '{"narrativeOutput":" "}',
      "The repaired story.",
    ];
    const llm: LLMAdapter = {
      generate: async () => prose("fallback"),
      stream: async function* () {
        yield { type: "text-delta", textDelta: drafts.shift()! };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const steering = [[], ["Look again"], [], []];
    const { result } = await run({
      llm,
      manifest: manifest({ outputKind: "story", tools: {} }),
      deps: {
        emitter,
        onDelta: async (chunk: { textDelta: string; reset?: true }) => {
          chunks.push(chunk);
        },
        turnControl: { drainSteering: () => steering.shift() ?? [] },
      },
    });
    expect(result.output).toEqual({ narrativeOutput: "The repaired story." });
    const reset = chunks.findIndex((chunk) => chunk.reset);
    expect(reset).toBeGreaterThan(0);
    expect(
      chunks
        .slice(reset + 1)
        .map((chunk) => chunk.textDelta)
        .join(""),
    ).toBe("The repaired story.");
  });
});

describe("output gate agreement", () => {
  it.each([
    [
      "empty story",
      { outputKind: "story" },
      '{"narrativeOutput":" "}',
      false,
      "invalid-output",
    ],
    ["schema prose", {}, "plain text", false, "short-circuit"],
    ["schema mismatch", {}, '{"answer":7}', false, "short-circuit"],
    ["valid JSON", {}, valid, true, "ok"],
  ] as const)(
    "agrees with settlement for %s (%s)",
    async (_name, overrides, content, ok, gateKind) => {
      const { args, result } = await run({
        llm: queuedLLM([prose(content)]),
        manifest: manifest({
          ...overrides,
          loopProfile: { corrections: { outputRepair: 0 } },
        }),
      });
      const finalized = finalizeAgentOutput({
        manifest: args.manifest,
        finalContent: content,
        executedToolCalls: [],
        failedToolCalls: [],
        pendingProposals: [],
        schemaGate: createAgentSchemaGate({ ...args, collectedToolCalls: [] }),
      });
      expect(finalized.kind).toBe(gateKind);
      expect(checkAgentOutput(args).ok).toBe(ok);
      expect(result.status === "success").toBe(ok);
      if (!ok) expect(result.stop).toEqual({ reason: "invalid-output" });
    },
  );

  it("caps schema error lists without including raw output or runtime identity", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        i === 0 ? "field".repeat(60) : `field${i}`,
        { type: "string" },
      ]),
    );
    const schema = { type: "object", properties };
    const content = JSON.stringify(
      Object.fromEntries(Object.keys(properties).map((key) => [key, 7])),
    );
    const { args } = await run({
      llm: queuedLLM([prose(content)]),
      loaded: { ...loaded, outputSchema: schema },
      manifest: manifest({ loopProfile: { corrections: { outputRepair: 0 } } }),
    });
    const checked = checkAgentOutput(args);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.errors).toHaveLength(5);
      expect(checked.errors.every((error) => error.length <= 200)).toBe(true);
      expect(checked.errors.some((error) => error.length === 200)).toBe(true);
      expect(checked.errors.join(" ")).not.toContain(content);
    }
  });

  it("keeps dry runs silent and never decorates a tool-owned output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { args } = await run({ llm: queuedLLM([prose(valid)]) });
    const toolOutput = {
      narrativeOutput: "story",
      interactions: [{ interactionId: "a" }],
      pluginData: [{ value: "data" }],
    };
    const toolLoop = {
      ...args.toolLoop,
      finalContent: null,
      executedToolCalls: [
        { name: "mark", arguments: "{}", success: true, result: toolOutput },
      ],
      finalToolOutput: null,
    };
    const before = structuredClone(toolLoop);
    checkAgentOutput({ ...args, outputSchema: undefined, toolLoop });
    expect(toolLoop).toEqual(before);
    const modelLoop = {
      ...args.toolLoop,
      finalContent: JSON.stringify({ answer: "fixed", pluginData: [] }),
    };
    const modelArgs = { ...args, outputSchema: undefined, toolLoop: modelLoop };
    expect(checkAgentOutput(modelArgs)).toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
    settleAgentLoop(modelArgs);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("repair phase transition", () => {
  it("allows a successful PreStep stop to enter finalizing before stopped", () => {
    const loop = createLoopState();
    loop.enter("awaiting-pre-step");
    loop.enter("finalizing");
    loop.enter("stopped");
    expect(loop.phase).toBe("stopped");
  });
});
