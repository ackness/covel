import { describe, expect, it } from "vitest";
import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import type { LLMResponse } from "@covel/shared";
import { tool, z } from "@covel/tools";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { readBaselineFixture } from "./helpers/read-baseline-fixture.js";

type Context = Parameters<FunctionHandler>[0];
const readers: Record<string, (ctx: Context, key: string) => Promise<unknown>> =
  {
    "pluginData.get": (ctx, key) => ctx.pluginData!.get("data", key),
    "pluginData.list": (ctx) => ctx.pluginData!.list("data"),
    "store.getPluginData": (ctx, key) => ctx.store.getPluginData("data", key),
    "store.listPluginData": (ctx) => ctx.store.listPluginData("data"),
  };

describe("automatic same-key guards", () => {
  it.each(
    (
      [
        "plugin.data",
        "plugin.data.delete",
        "plugin.data.update",
        "plugin.data.batch",
      ] as const
    ).flatMap((type) =>
      (["pluginId", "kind"] as const).map((field) => [type, field] as const),
    ),
  )(
    "uses the rebound target for raw %s payloads with an extra %s",
    async (type, field) => {
      const extra =
        field === "pluginId"
          ? { pluginId: "forged-owner" }
          : { kind: "character", id: "forged-character" };
      const f = await readBaselineFixture();
      const execution = await f.prepare(async (ctx) => {
        const value = (await ctx.pluginData!.get("data", "record")) as {
          score: number;
        };
        const item = {
          namespace: "data",
          key: "record",
          value: { score: value.score + 5, bar: value.score + 105 },
          ...extra,
        };
        const proposal =
          type === "plugin.data.batch"
            ? makeProposal(ctx, "2026-10-31T00:00:00Z", type, {
                items: [item],
              })
            : type === "plugin.data.update"
              ? makeProposal(ctx, "2026-10-31T00:00:00Z", type, {
                  ...item,
                  ops: [{ op: "merge", value: item.value }],
                })
              : makeProposal(ctx, "2026-10-31T00:00:00Z", type, item);
        return withPendingProposals({ outcome: "success", value: {} }, [
          {
            ...proposal,
            source: { pluginId: "forged-source", runtimeId: "forged-runtime" },
          },
        ]);
      });
      await f.set({ score: 20, bar: 120 });
      expect((await f.commit(execution)).failedProposals).toEqual([
        expect.objectContaining({ code: "conflict" }),
      ]);
      expect(await f.get()).toEqual({ score: 20, bar: 120 });
    },
  );

  it("discards the speculative reads of a passing guard and a failed tool", async () => {
    const f = await readBaselineFixture();
    const failed = tool({
      name: "failed-read",
      description: "Read unsuccessfully",
      parameters: z.object({}),
      execute: async (_args, context) => {
        await context.store!.getPluginData("data", "record");
        throw new Error("Failed before returning an observation");
      },
    });
    const blind = tool({
      name: "blind",
      description: "Write without reading",
      parameters: z.object({}),
      execute: async (_args, context) =>
        withPendingProposals({ staged: true }, [
          makeProposal(context, "2026-10-31T00:00:00Z", "plugin.data", {
            namespace: "data",
            key: "record",
            value: { score: 11 },
          }),
        ]),
    });
    const toolExecutor = createToolExecutor({
      store: f.store,
      findTool: (name) =>
        [failed, blind].find((module) => module.name === name),
    });
    const manifest = {
      ...f.manifest,
      runtimeType: "agent" as const,
      outputKind: "story" as const,
      stage: "narrative" as const,
      tools: { plugin: [failed.name, blind.name] },
    };
    const responses: LLMResponse[] = [failed.name, blind.name].map((name) => ({
      content: null,
      toolCalls: [{ id: name, name, arguments: "{}" }],
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    responses.push({
      content: "The story continues.",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    let step = 0;
    const requests: unknown[] = [];
    try {
      const execution = await f.prepare(
        async () => ({ outcome: "success", value: {} }),
        {
          manifest,
          deps: {
            toolExecutor,
            llm: {
              generate: async (request) => {
                requests.push(request);
                return responses[step++]!;
              },
            },
            loadRuntime: async () => ({
              manifest,
              promptTemplate: "",
              guard: async (ctx) => {
                await ctx.pluginData!.get("data", "record");
                return { skip: false };
              },
            }),
          },
        },
      );
      await f.set({ score: 20, bar: 120 });
      expect((await f.commit(execution)).failedProposals).toEqual([]);
      expect(await f.get()).toEqual({ score: 11 });
      expect(JSON.stringify(requests)).not.toMatch(
        /readScopes|preconditions|fingerprint/,
      );
    } finally {
      await toolExecutor.close();
    }
  });
  it("ignores forged conditions on a blind raw proposal", async () => {
    const f = await readBaselineFixture();
    const execution = await f.prepare(async (ctx) => {
      const forged = {
        ...makeProposal(ctx, "2026-10-31T00:00:00Z", "plugin.data", {
          namespace: "data",
          key: "record",
          value: { score: 11 },
        }),
        preconditions: () => {
          throw new Error("Untrusted metadata must be discarded");
        },
      };
      return withPendingProposals({ outcome: "success", value: {} }, [forged]);
    });
    await f.set({ score: 20, bar: 120 });
    expect((await f.commit(execution)).failedProposals).toEqual([]);
    expect(await f.get()).toEqual({ score: 11 });
  });
  it("captures a function's governed tool reads at the runtime's commit scope", async () => {
    const f = await readBaselineFixture();
    const derive = tool({
      name: "derive",
      description: "Derive a display value",
      parameters: z.object({}),
      execute: async (_args, context) => {
        const row = await context.store!.getPluginData("data", "record");
        const value = row!.value as { score: number };
        return withPendingProposals({ staged: true }, [
          makeProposal(context, "2026-10-31T00:00:00Z", "plugin.data.update", {
            namespace: "data",
            key: "record",
            ops: [
              { op: "inc", path: "/score", by: 5 },
              { op: "merge", value: { bar: value.score + 105 } },
            ],
          }),
        ]);
      },
    });
    const toolExecutor = createToolExecutor({
      store: f.store,
      findTool: (name) => (name === derive.name ? derive : undefined),
    });
    try {
      const execution = await f.prepare(
        async (ctx) => {
          await ctx.tools!.call("derive", {});
          return { outcome: "success", value: {} };
        },
        {
          manifest: { ...f.manifest, tools: { plugin: ["derive"] } },
          deps: { toolExecutor },
        },
      );
      await f.set({ score: 20, bar: 120 });
      expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
        "conflict",
      );
      expect(await f.get()).toEqual({ score: 20, bar: 120 });
    } finally {
      await toolExecutor.close();
    }
  });

  it("guards writes retained by a skipped agent guard", async () => {
    const f = await readBaselineFixture();
    const manifest = { ...f.manifest, runtimeType: "agent" as const };
    const execution = await f.prepare(
      async () => ({ outcome: "success", value: {} }),
      {
        manifest,
        deps: {
          loadRuntime: async () => ({
            manifest,
            promptTemplate: "",
            guard: async (ctx) => {
              const value = await ctx.pluginData!.get("data", "record");
              await ctx.pluginData!.set("data", "record", value);
              return { skip: true };
            },
          }),
        },
      },
    );
    await f.set({ score: 20, bar: 120 });
    expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
      "conflict",
    );
  });
  it.each(Object.entries(readers))(
    "captures %s for raw proposals and rejects forged envelope conditions",
    async (_surface, read) => {
      const f = await readBaselineFixture();
      const execution = await f.prepare(async (ctx) => {
        await read(ctx, "record");
        const proposal = makeProposal(
          ctx,
          "2026-10-30T00:00:00Z",
          "plugin.data",
          { namespace: "data", key: "record", value: { score: 11, bar: 111 } },
        );
        const forged = { ...proposal, preconditions: [] };
        return withPendingProposals({ outcome: "success", value: {} }, [
          forged,
        ]);
      });
      await f.set({ score: 20, bar: 120 });
      expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
        "conflict",
      );
      expect(await f.get()).toEqual({ score: 20, bar: 120 });
      expect(JSON.stringify(execution.result)).not.toMatch(
        /preconditions|fingerprint|readScopes/,
      );
    },
  );

  it.each(["set", "merge", "upsertItem", "delete"] as const)(
    "guards %s replacement operations after an explicit read",
    async (op) => {
      const f = await readBaselineFixture();
      await f.set(
        op === "upsertItem" ? [{ id: "a", count: 1 }] : { score: 10 },
      );
      const execution = await f.prepare(async (ctx) => {
        await ctx.pluginData!.get("data", "record");
        const ops =
          op === "set"
            ? [{ op, value: {} }]
            : op === "merge"
              ? [{ op, value: { score: 11 } }]
              : op === "upsertItem"
                ? [{ op, key: "id", value: { id: "a", count: 2 } }]
                : [{ op }];
        await ctx.pluginData!.update("data", "record", ops);
        return { outcome: "success", value: {} };
      });
      await f.set(
        op === "upsertItem" ? [{ id: "a", count: 3 }] : { score: 20 },
      );
      expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
        "conflict",
      );
    },
  );

  it.each(["absent", "null"] as const)(
    "distinguishes %s from a newly stored value",
    async (state) => {
      const f = await readBaselineFixture();
      if (state === "absent")
        await f.store.deletePluginData("session", "writer", "data", "record");
      else await f.set(null);
      const execution = await f.prepare(async (ctx) => {
        expect(await ctx.pluginData!.get("data", "record")).toBeNull();
        await ctx.pluginData!.set("data", "record", { score: 11 });
        return { outcome: "success", value: {} };
      });
      if (state === "absent") await f.set(null);
      else
        await f.store.deletePluginData("session", "writer", "data", "record");
      expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
        "conflict",
      );
    },
  );

  it("retains latest-value semantics for pure relative lists after stale reads", async () => {
    const f = await readBaselineFixture();
    const handler: FunctionHandler = async (ctx) => {
      await ctx.pluginData!.get("data", "record");
      await ctx.pluginData!.update("data", "record", [
        { op: "inc", path: "/score", by: 5 },
      ]);
      return { outcome: "success", value: {} };
    };
    const a = await f.prepare(handler);
    const b = await f.prepare(handler);
    expect((await f.commit(a)).failedProposals).toEqual([]);
    expect((await f.commit(b)).failedProposals).toEqual([]);
    expect(await f.get()).toEqual({ score: 20, bar: 110 });
  });

  it("keeps blind writes, other keys and list phantoms outside the guarantee", async () => {
    const f = await readBaselineFixture();
    const execution = await f.prepare(async (ctx) => {
      await ctx.pluginData!.list("data");
      await ctx.pluginData!.set("data", "new", { value: 1 });
      return { outcome: "success", value: {} };
    });
    await f.set({ value: 2 }, "new");
    expect((await f.commit(execution)).failedProposals).toEqual([]);
    expect(await f.get("new")).toEqual({ value: 1 });
  });

  it("captures effect-derived replacements and cannot be changed by mutating a returned object", async () => {
    const f = await readBaselineFixture();
    const execution = await f.prepare(async (ctx) => {
      const value = (await ctx.pluginData!.get("data", "record")) as {
        score: number;
      };
      value.score = 500;
      return {
        outcome: "success",
        value: {},
        effects: { pluginData: [{ namespace: "data", key: "record", value }] },
      };
    });
    expect((await f.commit(execution)).failedProposals).toEqual([]);
    expect(await f.get()).toMatchObject({ score: 500 });
  });
});
