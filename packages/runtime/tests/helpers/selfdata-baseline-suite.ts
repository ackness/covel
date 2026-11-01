import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DataStore } from "@covel/store";
import type {
  LLMAdapter,
  LLMResponse,
  Proposal,
  RuntimeManifest,
} from "@covel/shared";
import { tool, ToolRegistry } from "@covel/tools";
import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { executeTurn } from "../../src/index.js";
import { createToolExecutor } from "../../src/agent-loop/tool-executor.js";
import { createHookPipeline } from "../../src/hooks/pipeline.js";
import { readBaselineFixture } from "./read-baseline-fixture.js";

/** Also run by the server's live PostgreSQL integration suite. */
export function selfDataBaselineSuite(
  backend: string,
  create: () => DataStore | Promise<DataStore>,
) {
  describe(`selfData read baselines (${backend})`, () => {
    async function fixture(
      options: {
        write?: boolean;
        maxEntries?: number;
        format?: "summary" | "full" | "ids-only";
        replacement?: "upsert";
        otherNamespace?: boolean;
        noTools?: boolean;
        relativeOnly?: boolean;
        customTool?: "write" | "read";
        rebuildAfterCompaction?: boolean;
      } = {},
    ) {
      const f = await readBaselineFixture(create);
      const dataset = options.otherNamespace ? "other" : "data";
      const registry = new ToolRegistry();
      if (options.customTool)
        registry.registerPlugin(
          "writer",
          tool({
            name: "store-data",
            description: "Replace own data.",
            parameters: z.object({}),
            annotations: { readOnly: options.customTool === "read" },
            execute: async (_params, ctx) =>
              withPendingProposals({}, [
                makeProposal(ctx, "2026-11-01T00:00:00.000Z", "plugin.data", {
                  namespace: "data",
                  key: "record",
                  value: { score: 15, bar: 115 },
                }),
              ]),
          }),
        );
      const toolExecutor = createToolExecutor({
        store: f.store,
        findTool: (name, context) => registry.find(name, context.pluginId),
      });
      const manifest: RuntimeManifest = {
        ...f.manifest,
        name: "writer/derive",
        runtimeType: "agent",
        maxRetries: 0,
        input: {
          inject: [
            {
              kind: "plugin-data",
              namespace: "data",
              as: "<known-data>",
              format: options.format ?? "full",
              maxEntries: options.maxEntries ?? 50,
            },
          ],
        },
        tools: options.customTool
          ? { plugin: ["store-data"] }
          : options.noTools
            ? {}
            : {
                datasets: [
                  {
                    dataset,
                    tools:
                      options.write === false ? ["list"] : ["update", "upsert"],
                  },
                ],
              },
        datasets: {
          [dataset]: {
            namespace: dataset,
            schema: "./data.json",
            ops: ["set", "merge", "inc", "delete"],
            tools: ["list", "upsert", "update"],
          },
        },
      };
      const story: RuntimeManifest = {
        ...f.manifest,
        name: "writer/story",
        stage: "narrative",
        outputKind: "story",
      };
      const prepare = async (
        duringRequest?: () => Promise<void>,
        key = "record",
      ) => {
        let step = 0;
        const requests: string[] = [];
        const llm: LLMAdapter = {
          generate: vi.fn(
            async (
              params: Parameters<LLMAdapter["generate"]>[0],
            ): Promise<LLMResponse> => {
              requests.push(JSON.stringify(params.messages));
              if (step++ === 0) {
                expect(requests[0]).toContain("<known-data>");
                const prompt = params.messages
                  .map((message) => String(message.content))
                  .join("\n");
                // Script the model's calculation from the delivered value. An
                // ids-only window supplies no score, so use the fixture's plan.
                // PostgreSQL jsonb reorders keys, so do not assume key order.
                const score = Number(
                  prompt.match(
                    /- record(?: \||:) \{[^\n]*?"score":(\d+)/,
                  )?.[1] ?? 10,
                );
                if (options.rebuildAfterCompaction) expect(score).toBe(20);
                await duringRequest?.();
                if (
                  (options.customTool
                    ? options.customTool === "write"
                    : options.write !== false) &&
                  !options.noTools &&
                  !options.otherNamespace
                )
                  return {
                    content: null,
                    toolCalls: [
                      {
                        id: "replace",
                        name: options.customTool
                          ? "store-data"
                          : options.replacement === "upsert"
                            ? "data-upsert"
                            : "data-update",
                        arguments: JSON.stringify(
                          options.customTool
                            ? {}
                            : options.replacement === "upsert"
                              ? {
                                  key,
                                  record: {
                                    score: score + 5,
                                    bar: score + 105,
                                  },
                                }
                              : {
                                  key,
                                  ops: [
                                    { op: "inc", path: "/score", by: 5 },
                                    ...(options.relativeOnly
                                      ? []
                                      : [
                                          {
                                            op: "merge",
                                            value: { bar: score + 105 },
                                          },
                                        ]),
                                  ],
                                },
                        ),
                      },
                    ],
                    finishReason: "tool_calls",
                    usage: { inputTokens: 1, outputTokens: 1 },
                  };
              }
              return {
                content: "Done.",
                toolCalls: [],
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            },
          ),
        };
        const execution = await executeTurn(
          {
            sessionId: "session",
            turnId: crypto.randomUUID(),
            playerMessage: "Continue",
            origin: "player",
            locale: "en",
          },
          [story, manifest],
          {
            store: f.store,
            toolExecutor,
            llm,
            ...(options.rebuildAfterCompaction
              ? {
                  compactor: {
                    run: async () => {
                      await f.set({ score: 20, bar: 120 });
                      return { compacted: true };
                    },
                  },
                }
              : {}),
            loadRuntime: async (runtime) => ({
              manifest: runtime,
              promptTemplate: "Derive from the known data.",
              datasetSchemas: { [dataset]: {} },
              ...(runtime.name === story.name
                ? {
                    handler: async () => ({
                      outcome: "success" as const,
                      value: { narrativeOutput: "The story continues." },
                    }),
                  }
                : {}),
            }),
          },
        );
        expect(
          execution.result.runtimeResults.map((result) => result.status),
        ).toEqual(["success", "success"]);
        expect(JSON.stringify(requests)).not.toMatch(
          /preconditions|fingerprint|readScopes/,
        );
        expect(JSON.stringify(execution.result)).not.toMatch(
          /preconditions|fingerprint|readScopes/,
        );
        return execution;
      };
      const readsOf = (execution: Awaited<ReturnType<typeof prepare>>) =>
        Object.values(execution.commit.readBaselines!.runs).flatMap((scopes) =>
          scopes.flatMap((scope) => scope.reads),
        );
      return { ...f, prepare, readsOf, toolExecutor };
    }

    it.each(["summary", "full", "ids-only"] as const)(
      "rejects an injected-only %s replacement after an in-flight write and preserves story",
      async (format) => {
        const f = await fixture({ format });
        try {
          const execution = await f.prepare(() =>
            f.set({ score: 20, bar: 120 }),
          );
          const out = await f.commit(execution);
          expect(out.status).toBe("committed");
          expect(out.failedProposals).toEqual([
            expect.objectContaining({ code: "conflict" }),
          ]);
          expect(out.isolatedRuntimes).toEqual([
            expect.objectContaining({ runtimeId: "writer/derive" }),
          ]);
          expect(await f.get()).toEqual({ score: 20, bar: 120 });
          expect(await f.store.listMessages("session")).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ content: "The story continues." }),
            ]),
          );
          expect((await f.commit(await f.prepare())).failedProposals).toEqual(
            [],
          );
          expect(await f.get()).toEqual({
            score: 25,
            bar: format === "ids-only" ? 115 : 125,
          });
        } finally {
          await f.toolExecutor.close();
        }
      },
    );

    it("commits when the injected content is unchanged", async () => {
      const f = await fixture();
      try {
        const execution = await f.prepare();
        expect(f.readsOf(execution)).toEqual([
          expect.objectContaining({
            pluginId: "writer",
            namespace: "data",
            key: "record",
          }),
        ]);
        expect((await f.commit(execution)).failedProposals).toEqual([]);
        expect(await f.get()).toEqual({ score: 15, bar: 115 });
      } finally {
        await f.toolExecutor.close();
      }
    });

    it("uses the delivered prompt's basis after compaction rebuilds its preview", async () => {
      const f = await fixture({ rebuildAfterCompaction: true });
      try {
        const execution = await f.prepare();
        expect((await f.commit(execution)).failedProposals).toEqual([]);
        expect(await f.get()).toEqual({ score: 25, bar: 125 });
      } finally {
        await f.toolExecutor.close();
      }
    });

    it("does not record injected data without namespace write tools", async () => {
      const f = await fixture({ write: false });
      try {
        expect(f.readsOf(await f.prepare())).toEqual([]);
      } finally {
        await f.toolExecutor.close();
      }
    });

    it("guards injected data written through an entry tool", async () => {
      const f = await fixture({ customTool: "write" });
      try {
        const execution = await f.prepare(() => f.set({ score: 20, bar: 120 }));
        expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
          "conflict",
        );
        expect(await f.get()).toEqual({ score: 20, bar: 120 });
      } finally {
        await f.toolExecutor.close();
      }
    });

    it("does not record injection for a read-only entry tool", async () => {
      const f = await fixture({ customTool: "read" });
      try {
        expect(f.readsOf(await f.prepare())).toEqual([]);
      } finally {
        await f.toolExecutor.close();
      }
    });

    it.each([{ noTools: true }, { otherNamespace: true }])(
      "does not record injected data with unrelated tool access %j",
      async (options) => {
        const f = await fixture(options);
        try {
          expect(f.readsOf(await f.prepare())).toEqual([]);
        } finally {
          await f.toolExecutor.close();
        }
      },
    );

    it("retains latest-value semantics for a purely relative write", async () => {
      const f = await fixture({ relativeOnly: true });
      try {
        const execution = await f.prepare(() => f.set({ score: 20, bar: 120 }));
        expect((await f.commit(execution)).failedProposals).toEqual([]);
        expect(await f.get()).toEqual({ score: 25, bar: 120 });
      } finally {
        await f.toolExecutor.close();
      }
    });

    it("guards full content hidden by summary truncation", async () => {
      const f = await fixture({ format: "summary" });
      try {
        const base = {
          score: 10,
          bar: 110,
          padding: "x".repeat(250),
          detail: "old",
        };
        await f.set(base);
        const execution = await f.prepare(() =>
          f.set({ ...base, detail: "new" }),
        );
        expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
          "conflict",
        );
        expect(await f.get()).toEqual({ ...base, detail: "new" });
      } finally {
        await f.toolExecutor.close();
      }
    });

    it("keeps injected evidence private through forged payload fields and hook mutation", async () => {
      const f = await fixture();
      try {
        const execution = await f.prepare(() => f.set({ score: 20, bar: 120 }));
        const hooks = createHookPipeline();
        hooks.register<{ proposal: Proposal }>({
          id: "rewrite",
          pluginId: "writer",
          event: "PreStateCommit",
          handler: async (_ctx, { proposal }) => {
            expect(proposal).not.toHaveProperty("preconditions");
            if (proposal.type === "plugin.data.update")
              Object.assign(proposal, {
                preconditions: [],
                payload: {
                  ...proposal.payload,
                  pluginId: "elsewhere",
                  kind: "character",
                },
              });
            return { action: "continue" };
          },
        });
        const out = await f.commit(execution, { hookPipeline: hooks });
        expect(out.status).toBe("committed");
        expect(out.failedProposals[0]?.code).toBe("conflict");
        expect(await f.get()).toEqual({ score: 20, bar: 120 });
      } finally {
        await f.toolExecutor.close();
      }
    });

    it("records only the injected window and leaves unshown keys blind", async () => {
      const f = await fixture({ maxEntries: 1 });
      try {
        await f.set({ score: 1 }, "a");
        const execution = await f.prepare(() => f.set({ score: 20, bar: 120 }));
        expect(f.readsOf(execution)).toEqual([
          expect.objectContaining({ key: "a" }),
        ]);
        expect((await f.commit(execution)).failedProposals).toEqual([]);
        expect(await f.get()).toEqual({ score: 25, bar: 115 });
      } finally {
        await f.toolExecutor.close();
      }
    });

    it("detects deletion of an injected key", async () => {
      const f = await fixture();
      try {
        // Delete after the model staged a replacement so tool validation still succeeds.
        const execution = await f.prepare();
        await f.store.deletePluginData("session", "writer", "data", "record");
        expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
          "conflict",
        );
        expect(await f.get()).toBeUndefined();
      } finally {
        await f.toolExecutor.close();
      }
    });

    it("distinguishes injected JSON null from absence", async () => {
      const f = await fixture({ replacement: "upsert" });
      try {
        await f.set(null);
        const execution = await f.prepare(() =>
          f.store.deletePluginData("session", "writer", "data", "record"),
        );
        expect(f.readsOf(execution)).toEqual([
          expect.objectContaining({
            basis: expect.objectContaining({ exists: true }),
          }),
        ]);
        expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
          "conflict",
        );
        expect(await f.get()).toBeUndefined();
      } finally {
        await f.toolExecutor.close();
      }
    });
  });
}
