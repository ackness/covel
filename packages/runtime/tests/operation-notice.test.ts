import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LLMMessage, RuntimeManifest } from "@covel/shared";
import { executeTurn } from "../src/execution.js";
import { commitExecution } from "../src/commit/commit-execution.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { answer, fixture, input, runtime } from "./operation-fixture.js";

describe("previous-turn operation notices", () => {
  it.each(["en-US", "zh-CN"])(
    "shows only the failed operation to its caller in %s until the next committed turn",
    async (locale) => {
      const { store, services } = await fixture(locale);
      services.register("provider", {
        name: "change",
        contract: "change@1",
        modelFacing: true,
        description: "Record a change",
        access: "write",
        input: z.object({ key: z.string() }),
        output: z.unknown(),
        handler: async ({ key }, ctx) => {
          await ctx.pluginData.set("values", key, true);
          return { key };
        },
      });
      const narrator = runtime("caller/story", {
        runtimeType: "agent",
        outputKind: "story",
        tools: { services: [{ contract: "change@1", name: "change" }] },
      });
      const observer = runtime("observer/story", {
        runtimeType: "agent",
        outputKind: "story",
        stage: "post-turn",
      });
      let calls = 0;
      let first = true;
      const requests = new Map<string, (readonly LLMMessage[])[]>();
      let current = "first";
      const deps = {
        store,
        services,
        toolExecutor: createToolExecutor({ store, findTool: () => undefined }),
        loadRuntime: async (manifest: typeof narrator) => ({
          manifest,
          promptTemplate: manifest.name,
        }),
        llm: {
          generate: async (request: { messages: readonly LLMMessage[] }) => {
            const isNarrator = request.messages.some((message) =>
              String(message.content).includes("caller/story"),
            );
            const key = `${current}/${isNarrator ? "caller" : "observer"}`;
            requests.set(key, [...(requests.get(key) ?? []), request.messages]);
            if (first && isNarrator && calls++ < 2)
              return {
                ...answer(),
                content: null,
                finishReason: "tool_calls" as const,
                toolCalls: [
                  {
                    id: `call-${calls}`,
                    name: "change",
                    arguments: JSON.stringify({
                      key: calls === 1 ? "kept" : "rejected",
                    }),
                  },
                ],
              };
            return answer();
          },
        },
      };
      const run = (turnId: string, extra = {}) =>
        executeTurn(
          { ...input, locale, turnId, ...extra },
          [narrator, observer],
          deps,
        );
      const commit = (
        execution: Awaited<ReturnType<typeof executeTurn>>,
        turnId: string,
      ) =>
        commitExecution({
          store,
          execution,
          completion: { kind: "turn", turnId, durationMs: 0 },
          proposalGuard: (proposal) =>
            "key" in proposal.payload && proposal.payload.key === "rejected"
              ? "The change was refused."
              : undefined,
        });
      try {
        const initial = await run("first");
        const settled = await commit(initial, "first");
        expect(settled.status).toBe("committed");
        expect(settled.operations.map((operation) => operation.status)).toEqual(
          ["committed", "failed"],
        );
        const summaries = initial.commit.results
          .flatMap((result) => result.operations ?? [])
          .map((op) => op.summary);
        first = false;
        current = "retry";
        await run("retry", {
          origin: "manual",
          manualTrigger: { runtimeId: narrator.name, sourceTurnId: "first" },
        });
        expect(JSON.stringify(requests.get("retry/caller"))).not.toContain(
          "operations-not-applied",
        );
        current = "second";
        const second = await run("second");
        const prompt =
          requests
            .get("second/caller")?.[0]
            ?.map((m) => String(m.content))
            .join("\n") ?? "";
        const block = prompt.match(
          /<operations-not-applied>([\s\S]*?)<\/operations-not-applied>/,
        )?.[1];
        expect(block).toContain(summaries[1]);
        expect(block).not.toContain(summaries[0]);
        expect(block?.match(/^- /gm)).toHaveLength(1);
        expect(block).toContain(
          locale === "en-US"
            ? "These actions from the previous turn"
            : "上一回合的以下操作",
        );
        expect(JSON.stringify(requests.get("second/observer"))).not.toContain(
          "operations-not-applied",
        );
        await commit(second, "second");
        current = "third";
        await run("third");
        expect(JSON.stringify(requests.get("third/caller"))).not.toContain(
          "operations-not-applied",
        );
      } finally {
        await store.close();
      }
    },
  );

  it("tells a sub-agent whose delegated write was rejected on the next turn", async () => {
    const { store, services } = await fixture();
    services.register("provider", {
      name: "change",
      contract: "change@1",
      modelFacing: true,
      description: "Record a change",
      access: "write",
      input: z.object({ key: z.string() }),
      output: z.unknown(),
      handler: async ({ key }, ctx) => {
        await ctx.pluginData.set("values", key, true);
        return { key };
      },
    });
    const lineSchema = {
      type: "object",
      properties: { line: { type: "string" } },
      required: ["line"],
    };
    const helper: RuntimeManifest = runtime("nested/actor", {
      runtimeType: "agent",
      subagentOnly: true,
      trigger: { type: "manual" },
      outputContract: "fixture.helper@1",
      output: { schema: "output.schema.json" },
      tools: { services: [{ contract: "change@1", name: "change" }] },
    });
    const main = runtime("caller/main", { outputKind: "story" });
    let turn = "first";
    let helperCalls = 0;
    const helperRequests = new Map<string, string>();
    const otherRequests: string[] = [];
    const deps = {
      store,
      services,
      toolExecutor: createToolExecutor({ store, findTool: () => undefined }),
      llm: {
        generate: async (request: { messages: readonly LLMMessage[] }) => {
          const text = request.messages
            .map((message) => String(message.content))
            .join("\n");
          if (!text.includes("HELPER-PROMPT")) {
            otherRequests.push(text);
            return answer();
          }
          helperRequests.set(turn, helperRequests.get(turn) ?? text);
          const index = turn === "first" ? helperCalls++ : 2;
          return index < 2
            ? {
                ...answer(),
                content: null,
                finishReason: "tool_calls" as const,
                toolCalls: [
                  {
                    id: `call-${index}`,
                    name: "change",
                    arguments: JSON.stringify({
                      key: index === 0 ? "kept" : "rejected",
                    }),
                  },
                ],
              }
            : answer(JSON.stringify({ line: "Done." }));
        },
      },
      loadRuntime: async (manifest: RuntimeManifest) =>
        manifest.name === helper.name
          ? {
              manifest,
              promptTemplate: "HELPER-PROMPT You help.",
              outputSchema: lineSchema,
              outputContractSchema: lineSchema,
            }
          : {
              manifest,
              promptTemplate: "",
              handler: async (ctx: {
                agents?: { run(request: object): Promise<unknown> };
              }) => {
                await ctx.agents!.run({
                  target: { contract: "fixture.helper@1" },
                  brief: "Record the changes.",
                });
                return {
                  outcome: "success" as const,
                  value: { narrativeOutput: "The changes are recorded." },
                };
              },
            },
    };
    const run = (turnId: string) =>
      executeTurn({ ...input, turnId }, [main, helper], deps as never);
    const commit = (
      execution: Awaited<ReturnType<typeof executeTurn>>,
      turnId: string,
    ) =>
      commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId, durationMs: 0 },
        proposalGuard: (proposal) =>
          "key" in proposal.payload && proposal.payload.key === "rejected"
            ? "The change was refused."
            : undefined,
      });
    const block = (text: string | undefined) =>
      text?.match(
        /<operations-not-applied>([\s\S]*?)<\/operations-not-applied>/,
      )?.[1];
    try {
      const first = await run("first");
      const operations = first.commit.results.flatMap(
        (result) => result.operations ?? [],
      );
      expect(operations).toMatchObject([
        { invokedBy: { runtimeId: helper.name } },
        { invokedBy: { runtimeId: helper.name } },
      ]);
      const settled = await commit(first, "first");
      expect(settled.status).toBe("committed");
      expect(settled.operations.map((operation) => operation.status)).toEqual([
        "committed",
        "failed",
      ]);
      expect(block(helperRequests.get("first"))).toBeUndefined();

      turn = "second";
      await commit(await run("second"), "second");
      const notice = block(helperRequests.get("second"));
      expect(notice).toContain(operations[1]!.summary);
      expect(notice).not.toContain(operations[0]!.summary);
      expect(notice?.match(/^- /gm)).toHaveLength(1);
      expect(otherRequests.join("\n")).not.toContain("operations-not-applied");

      turn = "third";
      await run("third");
      expect(block(helperRequests.get("third"))).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});
