import { describe, expect, it, vi } from "vitest";
import type {
  LLMMessage,
  LLMResponse,
  LLMToolDefinition,
  ProposalFor,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  runPostContextAssemblyHook,
  runPostLLMResponseHook,
  runPostRuntimeHook,
  runPreLLMCallHook,
  runPreScheduleHook,
  runPreToolUseHook,
} from "../src/hooks/wire-helpers.js";
import { useHookScope } from "./_helpers/hook-scope.js";

useHookScope(["plugin-a", "plugin-b"]);

const baseOpts = {
  sessionId: "sess-hooks",
  turnId: "turn-hooks",
  pluginId: "plugin-a",
  runtimeId: "plugin-a/main",
};

const sampleManifest: RuntimeManifest = {
  name: "plugin-a/main",
  pluginId: "plugin-a",
  description: "main",
  runtimeType: "agent",
  stage: "narrative",
  outputKind: "story",
  trigger: { type: "auto" },
};

const sampleResult: RuntimeResult = {
  pluginId: "plugin-a",
  runtimeId: "plugin-a/main",
  runId: "run-1",
  turnId: "turn-hooks",
  status: "success",
  output: { narrativeOutput: "original" },
  toolCalls: [],
  durationMs: 12,
  timestamp: "2026-11-21T00:00:00.000Z",
};

const sampleResponse: LLMResponse = {
  content: "draft text",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
};

describe("PostLLMResponse correction preservation", () => {
  it.each([
    ["empty string", { correction: "" }],
    ["whitespace string", { correction: "   " }],
    ["undefined correction", { correction: undefined }],
    ["non-string correction", { correction: 42 }],
    ["second non-empty correction", { correction: "different issue" }],
    [
      "response patch with empty correction",
      { response: { ...sampleResponse, content: "patched" }, correction: "" },
    ],
  ])(
    "preserves an earlier handler's non-empty correction when a second handler returns %s",
    async (_label, secondReplace) => {
      const pipeline = createHookPipeline();
      pipeline.register({
        id: "plugin-a:review-1",
        pluginId: "plugin-a",
        event: "PostLLMResponse",
        handler: async () => ({
          action: "continue",
          replace: { correction: "Keep third-person perspective." },
        }),
      });
      pipeline.register({
        id: "plugin-b:review-2",
        pluginId: "plugin-b",
        event: "PostLLMResponse",
        handler: async () => ({
          action: "continue",
          replace: secondReplace as Record<string, unknown>,
        }),
      });

      const outcome = await runPostLLMResponseHook(
        { ...baseOpts, pipeline },
        sampleResponse,
        [{ role: "user", content: "hello" }],
      );

      expect(outcome.correction).toBe("Keep third-person perspective.");
    },
  );
});

describe("wire-helpers structural guards for malformed replace payloads", () => {
  it.each([
    ["string", "not-an-array"],
    ["number", 123],
    ["plain object", { name: "plugin-a/main" }],
  ])(
    "runPreScheduleHook ignores malformed replace.triggered (%s) without throwing",
    async (_label, malformed) => {
      const pipeline = createHookPipeline();
      pipeline.register({
        id: "plugin-a:bad-schedule",
        pluginId: "plugin-a",
        event: "PreSchedule",
        handler: async () => ({
          action: "continue",
          replace: { triggered: malformed },
        }),
      });

      const triggered = await runPreScheduleHook(
        { sessionId: "sess-hooks", turnId: "turn-hooks", pipeline },
        { triggered: [sampleManifest] },
      );
      expect(triggered).toEqual([sampleManifest]);
    },
  );

  it.each([
    ["string", "corrupted"],
    ["number", 42],
    ["array", ["bad"]],
    ["boolean", true],
  ])(
    "runPostRuntimeHook keeps original RuntimeResult when replace.result is %s",
    async (_label, malformed) => {
      const pipeline = createHookPipeline();
      pipeline.register({
        id: "plugin-a:bad-post-runtime",
        pluginId: "plugin-a",
        event: "PostRuntime",
        handler: async () => ({
          action: "continue",
          replace: { result: malformed },
        }),
      });

      const outcome = await runPostRuntimeHook(
        { ...baseOpts, pipeline },
        sampleResult,
      );
      expect(outcome).toEqual(sampleResult);
    },
  );

  it("runPostRuntimeHook preserves valid status and required fields when replace.result omits or corrupts them", async () => {
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "plugin-a:partial-post-runtime",
      pluginId: "plugin-a",
      event: "PostRuntime",
      handler: async () => ({
        action: "continue",
        replace: {
          result: {
            output: { narrativeOutput: "rewritten" },
            status: "not-a-real-status",
            toolCalls: "not-an-array",
            durationMs: "nan",
            timestamp: 999,
          },
        },
      }),
    });

    const outcome = await runPostRuntimeHook(
      { ...baseOpts, pipeline },
      sampleResult,
    );
    expect(outcome).toMatchObject({
      pluginId: sampleResult.pluginId,
      runtimeId: sampleResult.runtimeId,
      runId: sampleResult.runId,
      turnId: sampleResult.turnId,
      status: "success",
      output: { narrativeOutput: "rewritten" },
      toolCalls: [],
      durationMs: 12,
      timestamp: sampleResult.timestamp,
    });
  });

  it("runPreLLMCallHook ignores non-array messages/tools and non-string model", async () => {
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "plugin-a:bad-pre-llm",
      pluginId: "plugin-a",
      event: "PreLLMCall",
      handler: async () => ({
        action: "continue",
        replace: {
          messages: "not-an-array",
          tools: 42,
          model: { bad: true },
        },
      }),
    });

    const messages: readonly LLMMessage[] = [{ role: "user", content: "hi" }];
    const tools: readonly LLMToolDefinition[] = [
      { name: "t", description: "d", parameters: { type: "object" } },
    ];
    const outcome = await runPreLLMCallHook(
      { ...baseOpts, pipeline },
      { messages, model: "slot-a", tools },
    );
    expect(outcome.messages).toEqual(messages);
    expect(outcome.tools).toEqual(tools);
    expect(outcome.model).toBe("slot-a");
  });

  it("runPostContextAssemblyHook ignores non-string systemPrompt and non-array messages", async () => {
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "plugin-a:bad-context",
      pluginId: "plugin-a",
      event: "PostContextAssembly",
      handler: async () => ({
        action: "continue",
        replace: { systemPrompt: 123, messages: "bad" },
      }),
    });

    const messages: readonly LLMMessage[] = [{ role: "user", content: "hi" }];
    const outcome = await runPostContextAssemblyHook(
      { ...baseOpts, pipeline },
      {
        systemPrompt: "original prompt",
        frameworkHead: "HEAD",
        messages,
      },
    );
    expect(outcome.systemPrompt).toBe("HEAD\n\noriginal prompt");
    expect(outcome.messages).toEqual(messages);
  });

  it.each([
    ["string", "bad"],
    ["array", ["bad"]],
    [
      "bad field types",
      { name: 123, arguments: { not: "string" }, id: "evil" },
    ],
  ])(
    "runPreToolUseHook ignores malformed replace.toolCall (%s)",
    async (_label, malformed) => {
      const pipeline = createHookPipeline();
      pipeline.register({
        id: "plugin-a:bad-pre-tool",
        pluginId: "plugin-a",
        event: "PreToolUse",
        handler: async () => ({
          action: "continue",
          replace: { toolCall: malformed },
        }),
      });

      const original = { id: "tc-1", name: "roll", arguments: '{"d":20}' };
      const outcome = await runPreToolUseHook(
        { ...baseOpts, pipeline },
        original,
      );
      expect(outcome).toEqual({ skipped: false, toolCall: original });
    },
  );
});

describe("PreStateCommit immutable proposal envelope across chained handlers", () => {
  it("prevents handler #1 from spoofing proposal.type or proposal.source seen by handler #2", async () => {
    const pipeline = createHookPipeline();
    const proposal: ProposalFor<"plugin.data"> = {
      id: "prop-1",
      type: "plugin.data",
      source: { pluginId: "plugin-a", runtimeId: "plugin-a/main" },
      sessionId: "sess-hooks",
      turnId: "turn-hooks",
      timestamp: "2026-11-21T00:00:00.000Z",
      payload: { namespace: "notes", key: "k", value: "original" },
    };

    pipeline.register<{ proposal: ProposalFor<"plugin.data"> }>({
      id: "plugin-a:spoof",
      pluginId: "plugin-a",
      event: "PreStateCommit",
      handler: async (_ctx, payload) => ({
        action: "continue",
        replace: {
          proposal: {
            ...payload.proposal,
            id: "forged-id",
            type: "plugin.data.delete" as unknown as "plugin.data",
            source: { pluginId: "other", runtimeId: "other/r" },
            sessionId: "other-session",
            turnId: "other-turn",
            payload: { ...payload.proposal.payload, value: "rewritten" },
          },
        },
      }),
    });

    const seenBySecond = vi.fn();
    pipeline.register<{ proposal: ProposalFor<"plugin.data"> }>({
      id: "plugin-b:guard",
      pluginId: "plugin-b",
      event: "PreStateCommit",
      match: (p) => p.proposal.type === "plugin.data",
      handler: async (_ctx, payload) => {
        seenBySecond(payload.proposal);
        return { action: "continue" };
      },
    });

    const result = await pipeline.run(
      "PreStateCommit",
      {
        event: "PreStateCommit",
        sessionId: "sess-hooks",
        turnId: "turn-hooks",
        pluginId: "plugin-a",
        runtimeId: "plugin-a/main",
      },
      { proposal },
    );

    expect(result.action).toBe("continue");
    expect(seenBySecond).toHaveBeenCalledOnce();
    expect(seenBySecond).toHaveBeenCalledWith({
      ...proposal,
      payload: { namespace: "notes", key: "k", value: "rewritten" },
    });
  });
});
