import { describe, expect, it, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import { createEmitEventTool, runtimeDoneTool } from "@covel/tools";
import {
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import type { LLMResponse } from "../src/llm/llm-adapter.js";

async function run(
  path: "turn" | "resume",
  finishAt: number,
  callerLimit?: number,
  pluginLimit?: number,
) {
  const store = createMemoryStore();
  const input: TurnInput = {
    sessionId: "budget-session",
    turnId: "budget-turn",
    origin: "manual",
    playerMessage: "continue",
    manualTrigger: { runtimeId: "probe" },
  };
  const manifest = {
    name: "probe",
    pluginId: "probe",
    description: "Budget probe",
    stage: "narrative",
    outputKind: "system",
    trigger: { type: "manual" },
    tools: { builtin: ["emit-event"] },
    maxRetries: 0,
    ...(pluginLimit ? { maxSteps: pluginLimit } : {}),
  } as RuntimeManifest;
  const emit = createEmitEventTool({
    directory: {
      listTopics: async () => ["probe.progress"],
      validate: async () => ({ ok: true }),
    },
  });
  let step = 0;
  const generate = vi.fn(async (): Promise<LLMResponse> => {
    step++;
    const done = step === finishAt;
    return {
      content: null,
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [
        {
          id: `call-${step}`,
          name: done ? "runtime-done" : "emit-event",
          arguments: JSON.stringify(
            done
              ? { reason: "done" }
              : { topic: "probe.progress", data: { step } },
          ),
        },
      ],
    };
  });
  const deps = {
    store,
    llm: { generate },
    loadRuntime: async () => ({ manifest, promptTemplate: "Use the tools." }),
    toolExecutor: createToolExecutor({
      store,
      findTool: (name) =>
        name === emit.name
          ? emit
          : name === runtimeDoneTool.name
            ? runtimeDoneTool
            : undefined,
    }),
  };
  const options = callerLimit ? { maxSteps: callerLimit } : undefined;
  const result =
    path === "turn"
      ? (await executeTurn(input, [manifest], deps, options)).runtimeResults[0]!
      : await resumeSuspendedRuntime(
          {
            id: "suspension",
            sessionId: input.sessionId,
            turnId: input.turnId,
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
            reason: "wait",
            resumeSchema: {},
            createdAt: new Date().toISOString(),
            pendingContinuation: {
              executionContext: {
                executionId: "prior-run",
                origin: "manual",
                countPolicy: "none",
              },
              messages: [],
              toolCallsSoFar: [],
              pendingProposals: [],
            },
          },
          {},
          manifest,
          deps,
          options,
        );
  return { result, generate };
}

describe.each(["turn", "resume"] as const)("%s tool budget", (path) => {
  it("allows 20 steps by default and can finish on the final step", async () => {
    const { result, generate } = await run(path, 20);
    expect(generate).toHaveBeenCalledTimes(20);
    expect(result.status).toBe("success");
  });

  it("stops unfinished work at 20 steps", async () => {
    const { result, generate } = await run(path, 21);
    expect(generate).toHaveBeenCalledTimes(20);
    expect(result.status).toBe("failed");
  });

  it("stops as soon as the work completes", async () => {
    const { result, generate } = await run(path, 2);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("success");
  });

  it.each([
    [3, undefined, 3],
    [3, 4, 4],
  ])(
    "honors caller %s and plugin %s limits",
    async (caller, plugin, expected) => {
      const { result, generate } = await run(path, 21, caller, plugin);
      expect(generate).toHaveBeenCalledTimes(expected);
      expect(result.status).toBe("failed");
    },
  );
});
