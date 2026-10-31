import { describe, expect, it } from "vitest";
import type { LLMMessage, RuntimeResult } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { suspendTool, tool } from "@covel/tools";
import { z } from "zod";
import { collectExecutionSuspensions } from "../src/suspension-artifact.js";
import { resumeRuntimePipeline } from "../src/resume/turn-resume.js";
import { buildResumedToolMessage } from "../src/agent-loop/turn-agent-tool-loop-messages.js";
import { createLoopContextPolicy } from "../src/agent-loop/loop-context-policy.js";
import {
  expectMatchedToolCalls,
  makeExecutor,
  manifest,
  prose,
  queuedLLM,
  runLoop,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const elidedIds = (messages: readonly LLMMessage[]) =>
  messages
    .filter(
      (message) =>
        message.role === "tool" &&
        String(message.content).includes("[older tool output omitted]"),
    )
    .map((message) => message.toolCallId);

describe("context policy after suspension", () => {
  it("rebuilds an empty ledger deterministically and leaves the saved canonical transcript unchanged", async () => {
    const store = createMemoryStore();
    const read = tool({
      name: "read",
      description: "Read a page",
      parameters: z.object({ page: z.number() }),
      execute: async ({ page }) => ({ page, body: "r".repeat(800) }),
    });
    const runtime = manifest({
      tools: { plugin: ["read"], builtin: ["suspend"] },
    });
    const estimator = (text: string) => text.length;
    const contextBudget = { maxInputTokens: 5_000, reservedForResponse: 100 };
    const executor = makeExecutor([read, suspendTool]);
    const messages: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ];
    const initial = queuedLLM([
      ...Array.from({ length: 4 }, (_, page) =>
        toolCall("read", { page }, `read-${page}`),
      ),
      toolCall(
        "suspend",
        {
          reason: "Need input",
          fields: [{ type: "text", name: "answer", label: "Answer" }],
        },
        "pause",
      ),
    ]);
    const suspended = await runLoop({
      llm: initial,
      manifest: runtime,
      messages,
      allowSuspend: true,
      maxSteps: 8,
      estimator,
      contextBudget,
      deps: { store, toolExecutor: executor },
    });
    expect(suspended).toMatchObject({ status: "suspended" });
    const [record] = collectExecutionSuspensions({
      runtimeResults: [suspended as unknown as RuntimeResult],
    });
    if (!record) throw new Error("expected a suspension artifact");
    const before = structuredClone(record);
    expect(record.pendingContinuation.messages).toEqual(messages);
    expect(JSON.stringify(record)).not.toContain("[older tool output omitted]");
    expect(JSON.stringify(record)).toContain("r".repeat(800));

    const resumeData = { answer: "continue" };
    const restored = (record.pendingContinuation.messages as LLMMessage[]).map(
      (message) =>
        message.toolCallId === "pause"
          ? buildResumedToolMessage("pause", resumeData)
          : message,
    );
    const fixedTokens = estimator(
      [
        "sys",
        `<tool_definitions>${JSON.stringify(initial.requests[0]!.tools)}</tool_definitions>`,
      ].join("\n"),
    );
    const normalPolicy = createLoopContextPolicy({});
    // Reproduce the policy's decisions at each request of an uninterrupted loop.
    for (let end = 2; end < restored.length; end += 2)
      normalPolicy.fit(restored.slice(1, end), {
        inputLimit: 4_900,
        fixedTokens,
        estimator,
        mode: "normal",
      });
    const expected = normalPolicy.fit(restored.slice(1), {
      inputLimit: 4_900,
      fixedTokens,
      estimator,
      mode: "normal",
    });
    const fresh = createLoopContextPolicy({}).fit(restored.slice(1), {
      inputLimit: 4_900,
      fixedTokens,
      estimator,
      mode: "normal",
    });
    const condensedIds = (request: readonly LLMMessage[]) =>
      restored
        .filter(
          (message) =>
            message.role === "tool" &&
            (!request.some(
              (candidate) => candidate.toolCallId === message.toolCallId,
            ) ||
              elidedIds(request).includes(message.toolCallId)),
        )
        .map((message) => message.toolCallId);
    expect(condensedIds(fresh.messages)).toEqual(
      condensedIds(expected.messages),
    );
    expect(elidedIds(fresh.messages).length).toBeGreaterThan(0);
    const resumedLLM = queuedLLM([prose("resumed answer")]);
    const result = await resumeRuntimePipeline(record, resumeData, runtime, {
      store,
      llm: resumedLLM,
      toolExecutor: executor,
      estimator,
      contextBudget,
      loadRuntime: async () => ({
        manifest: runtime,
        promptTemplate: "prompt",
      }),
    });
    expect(result.status).toBe("success");
    expect(resumedLLM.requests).toHaveLength(1);
    const request = resumedLLM.requests[0]!;
    expectMatchedToolCalls(request.messages);
    expect(elidedIds(request.messages)).toEqual(elidedIds(fresh.messages));
    expect(record).toEqual(before);
    expect(result.toolCalls).toHaveLength(4);
    expect(JSON.stringify(result.toolCalls)).toContain("r".repeat(800));
  });
});
