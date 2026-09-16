import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import { runtimeDoneTool, suspendTool, tool } from "@covel/tools";
import { z } from "zod";
import type { RuntimeManifest } from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { resumeSuspendedRuntime } from "../src/resume/turn-resume.js";
import type { LLMResponse } from "../src/llm/llm-adapter.js";
import { collectExecutionSuspensions } from "../src/suspension-artifact.js";

function response(
  content: string | null,
  name?: string,
  args: Record<string, unknown> = {},
): LLMResponse {
  return {
    content,
    toolCalls: name
      ? [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }]
      : [],
    finishReason: name ? "tool_calls" : "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

async function run(
  script: LLMResponse[],
  strict = true,
  resume?: "explicit" | "tool-use",
) {
  const store = createMemoryStore();
  await store.appendTurnMessage({
    id: "seed",
    sessionId: "s",
    turnId: "old",
    role: "user",
    sourceType: "player",
    content: "Start",
    order: 0,
    createdAt: "2026-01-01T00:00:00Z",
  });
  const write = vi.fn(async () => ({ updated: true }));
  const tools = [
    runtimeDoneTool,
    tool({
      name: "save-facts",
      description: "Save facts",
      parameters: z.object({ text: z.string().optional() }),
      execute: write,
    }),
    tool({
      name: "read-facts",
      description: "Read facts",
      parameters: z.object({ scope: z.string().optional() }),
      execute: async () => ({ facts: [] }),
    }),
    tool({
      name: "broken-read",
      description: "Fail to read",
      parameters: z.object({}),
      execute: async () => {
        throw new Error("Read unavailable");
      },
    }),
    suspendTool,
  ];
  const manifest = {
    name: "external-extractor",
    pluginId: "external-extractor",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
    tools: { plugin: tools.slice(1).map((entry) => entry.name) },
    completeAfterTools: ["save-facts"],
    requireExplicitCompletion: strict,
    requireToolUse: resume === "tool-use",
    maxSteps: 4,
    maxRetries: 0,
  } as RuntimeManifest;
  let index = 0;
  const generate = vi.fn(
    async () => script[Math.min(index++, script.length - 1)]!,
  );
  const deps = {
    store,
    llm: { generate },
    loadRuntime: async () => ({
      manifest,
      promptTemplate: "Extract facts conservatively.",
    }),
    toolExecutor: createToolExecutor({
      findTool: (name) => tools.find((entry) => entry.name === name),
      store,
    }),
  };
  const result = resume
    ? await resumeSuspendedRuntime(
        {
          id: "suspended",
          sessionId: "s",
          turnId: "t",
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          reason: "Await input",
          resumeSchema: {},
          createdAt: "2026-01-01T00:00:00Z",
          pendingContinuation: {
            messages: [
              { role: "system", content: "Extract facts conservatively." },
            ],
            toolCallsSoFar: [],
            pendingProposals: [],
            executionContext: {
              executionId: "before-suspend",
              origin: "manual",
              sourceTurnId: "source",
              countPolicy: "none",
            },
          },
        },
        {},
        manifest,
        deps,
      )
    : (
        await executeTurn(
          {
            sessionId: "s",
            turnId: "t",
            playerMessage: "Continue",
            origin: "player",
          },
          [manifest],
          deps,
        )
      ).runtimeResults.find((entry) => entry.runtimeId === manifest.name);
  return {
    result,
    generate,
    write,
    resumeCaptured: async () => {
      expect(result?.status).toBe("suspended");
      const [suspension] = collectExecutionSuspensions({
        runtimeResults: [result!],
      });
      expect(suspension).toBeDefined();
      return resumeSuspendedRuntime(
        JSON.parse(JSON.stringify(suspension)),
        {},
        manifest,
        deps,
      );
    },
  };
}

describe("explicit completion for third-party extractors", () => {
  it.each(["explicit", "tool-use"] as const)(
    "enforces the %s contract after suspension too",
    async (resume) => {
      const { result, write } = await run(
        [response('{"updated":true}')],
        resume === "explicit",
        resume,
      );
      expect(result?.status).toBe("failed");
      expect(result?.error).toContain(
        resume === "explicit" ? "requireExplicitCompletion" : "requireToolUse",
      );
      expect(write).not.toHaveBeenCalled();
    },
  );
  it.each([
    "Facts were updated.",
    '{"updated":true}',
    '{"toolCalls":[{"name":"save-facts","output":{}}]}',
  ])("rejects an unexecuted claim after one correction: %s", async (text) => {
    const { result, generate, write } = await run([response(text)]);
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("requireExplicitCompletion");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
  });

  it("accepts a real no-change completion without inventing a write", async () => {
    const { result, write } = await run([response(null, "runtime-done")]);
    expect(result?.status).toBe("success");
    expect(write).not.toHaveBeenCalled();
  });

  it("corrects drift into a real write and completes immediately", async () => {
    const { result, generate, write } = await run([
      response('{"updated":true}'),
      response(null, "save-facts"),
    ]);
    expect(result?.status).toBe("success");
    expect(write).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a successful read for completed extraction", async () => {
    const { result, write } = await run([
      response(null, "read-facts"),
      response("Updated everything."),
    ]);
    expect(result?.status).toBe("failed");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not hide an unresolved tool failure behind no-change", async () => {
    const { result } = await run([
      response(null, "broken-read"),
      response(null, "runtime-done"),
    ]);
    expect(result?.status).toBe("failed");
  });

  it("accepts a completing tool after correcting invalid arguments", async () => {
    const { result, generate, write } = await run([
      response(null, "save-facts", { text: 42 }),
      response(null, "save-facts", { text: "A confirmed fact" }),
    ]);
    expect(result?.status).toBe("success");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("accepts no-change after correcting a failed query", async () => {
    const { result, write } = await run([
      response(null, "read-facts", { scope: 42 }),
      response(null, "read-facts", { scope: "current" }),
      response(null, "runtime-done"),
    ]);
    expect(result?.status).toBe("success");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not let a write conceal a different failed query", async () => {
    const { result, write } = await run([
      response(null, "broken-read"),
      response(null, "save-facts"),
    ]);
    expect(result?.status).toBe("failed");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("preserves text completion for runtimes that do not opt in", async () => {
    const { result, generate } = await run(
      [response("An intentional textual result.")],
      false,
    );
    expect(result?.status).toBe("success");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "retains a failed query across suspension, repaired: %s",
    async (repair) => {
      const { resumeCaptured, write } = await run([
        response(null, "read-facts", { scope: 42 }),
        response(null, "suspend", {
          reason: "Choose a scope",
          resumeSchema: {},
        }),
        ...(repair ? [response(null, "read-facts", { scope: "current" })] : []),
        response(null, "runtime-done"),
      ]);
      const resumed = await resumeCaptured();
      expect(resumed.status).toBe(repair ? "success" : "failed");
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("retains a successful finishing tool from a batch suspended afterwards", async () => {
    const batch = response(null, "save-facts");
    const suspended = response(null, "suspend", {
      reason: "Confirm",
      resumeSchema: {},
    });
    const { resumeCaptured, write } = await run([
      { ...batch, toolCalls: [...batch.toolCalls!, ...suspended.toolCalls!] },
      response("Confirmed."),
    ]);
    expect((await resumeCaptured()).status).toBe("success");
    expect(write).toHaveBeenCalledTimes(1);
  });
});
