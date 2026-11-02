import { describe, expect, it, vi } from "vitest";
import { commitExecution, resumeSuspendedRuntime } from "../src/index.js";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import type { SuspensionRecord } from "@covel/store";
import { suspendTool, tool, z } from "@covel/tools";
import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { readBaselineFixture } from "./helpers/read-baseline-fixture.js";
import {
  submitted,
  queuedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";

const suspend = {
  outcome: "suspended" as const,
  reason: "Choose",
  resumeSchema: { type: "object" },
};
const derived: FunctionHandler = async (ctx) => {
  const value = (await ctx.pluginData!.get("data", "record")) as {
    score: number;
  };
  await ctx.pluginData!.update("data", "record", [
    { op: "inc", path: "/score", by: 5 },
    { op: "merge", value: { bar: value.score + 105 } },
  ]);
  return suspend;
};

describe("pending read-derived calculations", () => {
  it.each([false, true])(
    "retains an agent's original calculation through fresh reads and resuspension (changed=%s)",
    async (changed) => {
      const f = await readBaselineFixture();
      const derive = tool({
        name: "derive",
        description: "Calculate from the current score",
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          const row = await ctx.store!.getPluginData("data", "record");
          const value = row!.value as { score: number };
          return withPendingProposals({ staged: true }, [
            makeProposal(ctx, "2026-10-31T00:00:00Z", "plugin.data.update", {
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
      const observations: unknown[] = [];
      const read = tool({
        name: "read",
        description: "Read the pending calculation",
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          const row = await ctx.store!.getPluginData("data", "record");
          observations.push(row!.value);
          return { value: row!.value };
        },
      });
      const modules = [derive, read, suspendTool];
      const toolExecutor = createToolExecutor({
        store: f.store,
        findTool: (name) => modules.find((module) => module.name === name),
      });
      const manifest = {
        ...f.manifest,
        runtimeType: "agent" as const,
        tools: { plugin: [derive.name, read.name], builtin: ["suspend"] },
      };
      const ask = toolCall("suspend", {
        reason: "Choose",
        fields: [{ type: "text", name: "answer", label: "Answer" }],
      });
      const resume = (saved: SuspensionRecord, again: boolean) =>
        resumeSuspendedRuntime(saved, { answer: "Continue" }, manifest, {
          store: f.store,
          toolExecutor,
          llm: queuedLLM([
            toolCall("read", {}),
            again ? ask : submitted("Calculation complete."),
          ]),
          loadRuntime: async () => ({ manifest, promptTemplate: "Continue." }),
        });
      const commitResume = (
        execution: Awaited<ReturnType<typeof resume>>,
        saved: SuspensionRecord,
      ) =>
        commitExecution({
          store: f.store,
          execution,
          completion: {
            kind: "resume",
            turnId: saved.turnId,
            suspensionId: saved.id,
            pluginId: saved.pluginId,
            runtimeId: saved.runtimeId,
          },
        });
      try {
        const execution = await f.prepare(
          async () => ({ outcome: "success", value: {} }),
          {
            manifest,
            deps: {
              toolExecutor,
              llm: queuedLLM([toolCall("derive", {}), ask]),
              loadRuntime: async () => ({
                manifest,
                promptTemplate: "Calculate.",
              }),
            },
          },
        );
        expect(execution.commit.results[0]?.status).toBe("suspended");
        expect((await f.commit(execution)).status).toBe("committed");
        const [first] = await f.store.listSuspensions("session");
        const original = structuredClone(first!.pendingContinuation.readScopes);
        const pending = structuredClone(
          first!.pendingContinuation.pendingProposals,
        );
        expect(original).toHaveLength(1);
        expect(original?.[0]?.reads).toHaveLength(1);
        expect(first!.pendingContinuation.takenUnder.writes).toEqual([]);
        expect(await f.get()).toEqual({ score: 10, bar: 110 });

        const again = await resume(first!, true);
        expect(again.result.status).toBe("suspended");
        expect((await commitResume(again, first!)).status).toBe("committed");
        const [next] = (await f.store.listSuspensions("session")).filter(
          (record) => !record.resolvedAt,
        );
        expect(next!.pendingContinuation.readScopes?.[0]).toEqual(
          original?.[0],
        );
        expect(next!.pendingContinuation.pendingProposals).toEqual(pending);
        expect(observations).toEqual([{ score: 15, bar: 115 }]);
        expect(await f.get()).toEqual({ score: 10, bar: 110 });

        if (changed) await f.set({ score: 20, bar: 120 });
        const last = await resume(next!, changed);
        expect(last.result.status).toBe(changed ? "suspended" : "success");
        const out = await commitResume(last, next!);
        expect(out.status).toBe(changed ? "failed" : "committed");
        expect(out.failedProposals.map((failure) => failure.code)).toEqual(
          changed ? ["conflict"] : [],
        );
        expect(observations.at(-1)).toEqual({
          score: changed ? 25 : 15,
          bar: 115,
        });
        expect(await f.get()).toEqual(
          changed ? { score: 20, bar: 120 } : { score: 15, bar: 115 },
        );
        const unresolved = (await f.store.listSuspensions("session")).filter(
          (record) => !record.resolvedAt,
        );
        expect(unresolved.map((record) => record.id)).toEqual(
          changed ? [next!.id] : [],
        );
        if (changed) {
          expect(unresolved[0]!.pendingContinuation.readScopes?.[0]).toEqual(
            original?.[0],
          );
          expect(
            await f.store.queryTraceEvents("session", {
              types: ["proposal.committed"],
            }),
          ).toEqual([]);
        }
      } finally {
        await toolExecutor.close();
      }
    },
  );

  it("saves and guards raw proposal commands returned with a function suspension", async () => {
    const f = await readBaselineFixture();
    const execution = await f.prepare(async (ctx) => {
      const value = (await ctx.pluginData!.get("data", "record")) as {
        score: number;
      };
      return withPendingProposals(suspend, [
        makeProposal(ctx, "2026-10-31T00:00:00Z", "plugin.data.update", {
          namespace: "data",
          key: "record",
          ops: [
            { op: "inc", path: "/score", by: 5 },
            { op: "merge", value: { bar: value.score + 105 } },
          ],
        }),
      ]);
    });
    expect(
      execution.commit.suspensions?.[0]?.pendingContinuation.pendingProposals,
    ).toHaveLength(1);
    await f.set({ score: 20, bar: 120 });
    expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
      "conflict",
    );
    expect(await f.store.listSuspensions("session")).toEqual([]);
  });
  it.each(["raw", "effects"] as const)(
    "orders saved relative writes before fresh %s calculations and owns their scope identity",
    async (kind) => {
      for (const changed of [false, true]) {
        const f = await readBaselineFixture();
        await f.commit(
          await f.prepare(async (ctx) => {
            await ctx.pluginData!.update("data", "record", [
              { op: "inc", path: "/score", by: 5 },
            ]);
            return suspend;
          }),
        );
        const [saved] = await f.store.listSuspensions("session");
        const prefixId = (
          saved!.pendingContinuation.pendingProposals[0] as { id: string }
        ).id;
        const resumed = await resumeSuspendedRuntime(saved!, {}, f.manifest, {
          store: f.store,
          llm: { generate: vi.fn() } as never,
          loadRuntime: async () => ({
            manifest: f.manifest,
            promptTemplate: "",
            handler: async (ctx) => {
              const value = (await ctx.pluginData!.get("data", "record")) as {
                score: number;
              };
              if (kind === "effects")
                return {
                  outcome: "success",
                  value: {},
                  effects: {
                    pluginData: [
                      {
                        namespace: "data",
                        key: "record",
                        value: { score: value.score, bar: value.score + 100 },
                      },
                    ],
                  },
                };
              const forged = {
                ...makeProposal(
                  ctx,
                  "2026-10-31T00:00:00Z",
                  "plugin.data.update",
                  {
                    namespace: "data",
                    key: "record",
                    ops: [{ op: "merge", value: { bar: value.score + 100 } }],
                  },
                ),
                id: prefixId,
                preconditions: [],
              };
              return withPendingProposals({ outcome: "success", value: {} }, [
                forged,
              ]);
            },
          }),
        });
        if (changed) await f.set({ score: 20, bar: 120 });
        const out = await f.commit(resumed);
        expect(out.failedProposals.map((failure) => failure.code)).toEqual(
          changed ? ["conflict"] : [],
        );
        expect(await f.get()).toEqual(
          changed ? { score: 20, bar: 120 } : { score: 15, bar: 115 },
        );
      }
    },
  );
  it.each(["set", "derived-merge"] as const)(
    "rejects a stale pending %s before saving a suspension",
    async (kind) => {
      const f = await readBaselineFixture();
      const execution = await f.prepare(
        kind === "derived-merge"
          ? derived
          : async (ctx) => {
              const value = await ctx.pluginData!.get("data", "record");
              await ctx.pluginData!.set("data", "record", value);
              return suspend;
            },
      );
      await f.set({ score: 20, bar: 120 });
      const out = await f.commit(execution);
      expect(out.status).toBe("failed");
      expect(out.failedProposals[0]?.code).toBe("conflict");
      expect(await f.store.listSuspensions("session")).toEqual([]);
      expect(await f.get()).toEqual({ score: 20, bar: 120 });
    },
  );

  it("preserves the original merge basis through resume reads and rejects resuspension after a change", async () => {
    const f = await readBaselineFixture();
    expect((await f.commit(await f.prepare(derived))).status).toBe("committed");
    const [saved] = await f.store.listSuspensions("session");
    expect(saved?.pendingContinuation.readScopes).toHaveLength(1);
    // The existing suspension digest deliberately excludes this operation list.
    expect(saved?.pendingContinuation.takenUnder.writes).toEqual([]);
    const original = structuredClone(saved!.pendingContinuation.readScopes);
    const resumed = await resumeSuspendedRuntime(saved!, {}, f.manifest, {
      store: f.store,
      llm: { generate: vi.fn() } as never,
      loadRuntime: async () => ({
        manifest: f.manifest,
        promptTemplate: "",
        handler: async (ctx) => {
          expect(await ctx.pluginData!.get("data", "record")).toEqual({
            score: 15,
            bar: 115,
          });
          return suspend;
        },
      }),
    });
    expect((await f.commit(resumed)).status).toBe("committed");
    const next = (await f.store.listSuspensions("session")).find(
      (record) => !record.resolvedAt,
    )!;
    expect(next.pendingContinuation.readScopes?.[0]).toEqual(original?.[0]);
    await f.set({ score: 20, bar: 120 });
    const stale = await resumeSuspendedRuntime(next, {}, f.manifest, {
      store: f.store,
      llm: { generate: vi.fn() } as never,
      loadRuntime: async () => ({
        manifest: f.manifest,
        promptTemplate: "",
        handler: async (ctx) => {
          // New reads observe the fresh external basis beneath the saved prefix.
          await ctx.pluginData!.get("data", "record");
          return suspend;
        },
      }),
    });
    const out = await f.commit(stale);
    expect(out.status).toBe("failed");
    expect(out.failedProposals[0]?.code).toBe("conflict");
    expect(await f.get()).toEqual({ score: 20, bar: 120 });
    expect(
      (await f.store.listSuspensions("session"))
        .filter((record) => !record.resolvedAt)
        .map((record) => record.id),
    ).toEqual([next.id]);
  });

  it("allows a valid pending calculation to finish once", async () => {
    const f = await readBaselineFixture();
    await f.commit(await f.prepare(derived));
    const [saved] = await f.store.listSuspensions("session");
    const resumed = await resumeSuspendedRuntime(saved!, {}, f.manifest, {
      store: f.store,
      llm: { generate: vi.fn() } as never,
      loadRuntime: async () => ({
        manifest: f.manifest,
        promptTemplate: "",
        handler: async () => ({ outcome: "success", value: {} }),
      }),
    });
    expect((await f.commit(resumed)).failedProposals).toEqual([]);
    expect(await f.get()).toEqual({ score: 15, bar: 115 });
  });

  it("uses the accepted saved prefix as the external basis of a fresh resume calculation", async () => {
    const f = await readBaselineFixture();
    await f.commit(await f.prepare(derived));
    const [saved] = await f.store.listSuspensions("session");
    const resumed = await resumeSuspendedRuntime(saved!, {}, f.manifest, {
      store: f.store,
      llm: { generate: vi.fn() } as never,
      loadRuntime: async () => ({
        manifest: f.manifest,
        promptTemplate: "",
        handler: async (ctx) => {
          const value = (await ctx.pluginData!.get("data", "record")) as {
            score: number;
          };
          await ctx.pluginData!.update("data", "record", [
            { op: "inc", path: "/score", by: 2 },
            { op: "merge", value: { bar: value.score + 102 } },
          ]);
          return { outcome: "success", value: {} };
        },
      }),
    });
    expect((await f.commit(resumed)).failedProposals).toEqual([]);
    expect(await f.get()).toEqual({ score: 17, bar: 117 });
  });

  it("refuses the original pending calculation after a fresh resume read instead of overwriting newer data", async () => {
    const f = await readBaselineFixture();
    await f.commit(await f.prepare(derived));
    const [saved] = await f.store.listSuspensions("session");
    await f.set({ score: 20, bar: 120 });
    const resumed = await resumeSuspendedRuntime(saved!, {}, f.manifest, {
      store: f.store,
      llm: { generate: vi.fn() } as never,
      loadRuntime: async () => ({
        manifest: f.manifest,
        promptTemplate: "",
        handler: async (ctx) => {
          await ctx.pluginData!.get("data", "record");
          return { outcome: "success", value: {} };
        },
      }),
    });
    const out = await f.commit(resumed);
    expect(out.failedProposals[0]?.code).toBe("conflict");
    expect(await f.get()).toEqual({ score: 20, bar: 120 });
  });
});
