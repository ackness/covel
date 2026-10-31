import { describe, expect, it } from "vitest";
import { tool } from "@covel/tools";
import { z } from "zod";
import type { RuntimeManifest } from "@covel/shared";
import {
  createSubagentRunner,
  type SubagentSettledEvent,
} from "../src/agent-loop/subagent-runner.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { PreLLMCallRequest } from "../src/hooks/wire-helpers.js";
import {
  input,
  makeExecutor,
  prose,
  queuedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const read = tool({
  name: "read",
  description: "Read data",
  annotations: { readOnly: true },
  parameters: z.object({ query: z.string() }),
  execute: async () => ({ found: true }),
});

describe("sub-agent context overflow settlement", () => {
  it.each([false, true])(
    "returns the stop to the caller and attributes faults only when unfinished (rescue: %s)",
    async (rescue) => {
      const provider: RuntimeManifest = {
        name: "actor/answer",
        pluginId: "actor",
        description: "Answer",
        runtimeType: "agent",
        outputKind: "system",
        subagentOnly: true,
        outputContract: "answer@1",
        trigger: { type: "manual" },
        tools: { plugin: ["read"] },
        loopProfile: { finalizer: { maxSteps: rescue } },
        maxRetries: 0,
      };
      const outcomes: SubagentSettledEvent[] = [];
      const runner = createSubagentRunner({
        activeRuntimes: [provider],
        onSettled: (event) => outcomes.push(event),
      });
      const llm = queuedLLM([
        toolCall("read", { query: "q".repeat(3_000) }),
        prose('{"answer":"sub-agent answer"}'),
      ]);
      const hookPipeline = createHookPipeline();
      hookPipeline.register<PreLLMCallRequest>({
        id: "short-prompt",
        event: "PreLLMCall",
        handler: async (_ctx, payload) => ({
          action: "continue",
          replace: {
            messages: payload.messages.map((message) =>
              message.role === "system"
                ? { ...message, content: "sys" }
                : message.role === "user"
                  ? { ...message, content: "go" }
                  : message,
            ),
          },
        }),
      });
      const result = await runner.run({
        caller: { pluginId: "parent", runtimeId: "parent/main", depth: 0 },
        request: {
          target: { contract: "answer@1" },
          brief: "Answer the question",
        },
        input,
        parentCallId: "parent-call",
        executionContext: {
          executionId: "execution",
          origin: "player",
          countPolicy: "complete-player-turn",
        },
        deps: {
          llm,
          hookPipeline,
          toolExecutor: makeExecutor([read]),
          estimator: (text) => text.length,
          contextBudget: { maxInputTokens: 1_000, reservedForResponse: 100 },
          loadRuntime: async () => ({
            manifest: provider,
            promptTemplate: "Answer",
          }),
        },
      });
      expect(result.ok).toBe(rescue);
      expect(result.stopReason).toBe("context-overflow");
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        ok: rescue,
        stopReason: "context-overflow",
      });
      expect(outcomes[0]?.fault).toBe(rescue ? undefined : "runtime");
      if (result.ok)
        expect(JSON.stringify(result.output)).toContain("sub-agent answer");
      else expect(result.error.code).toBe("internal");
      expect(llm.requests).toHaveLength(rescue ? 2 : 1);
    },
  );
});
