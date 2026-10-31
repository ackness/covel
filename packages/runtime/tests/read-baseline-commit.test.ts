import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import type { Proposal } from "@covel/shared";
import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { createCommitPipeline } from "../src/commit/session-commit-pipeline.js";
import { prepareRuntimeProposals } from "../src/session/session-runtime-result.js";
import { readBaselineFixture } from "./helpers/read-baseline-fixture.js";

describe.each([
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const)("read-derived replacements (%s)", (_name, create) => {
  it("rejects the stale relative prefix and derived merge together, then accepts fresh recomputation", async () => {
    const f = await readBaselineFixture(create);
    const derive =
      (by: number): FunctionHandler =>
      async (ctx) => {
        const value = (await ctx.pluginData!.get("data", "record")) as {
          score: number;
        };
        await ctx.pluginData!.update("data", "record", [
          { op: "inc", path: "/score", by },
          { op: "merge", value: { bar: value.score + by + 100 } },
        ]);
        return { outcome: "success", value: {} };
      };
    const first = await f.prepare(derive(15));
    const stale = await f.prepare(derive(-5));
    expect((await f.commit(first)).failedProposals).toEqual([]);
    const rejected = await f.commit(stale);
    expect(rejected.failedProposals).toEqual([
      expect.objectContaining({ code: "conflict" }),
    ]);
    expect(await f.get()).toEqual({ score: 25, bar: 125 });
    expect(
      (await f.commit(await f.prepare(derive(-5)))).failedProposals,
    ).toEqual([]);
    expect(await f.get()).toEqual({ score: 20, bar: 120 });
  });

  it("rejects a stale whole-value plan through the real mutation boundary", async () => {
    const f = await readBaselineFixture(create);
    const execution = await f.prepare(async (ctx) => {
      const value = await ctx.pluginData!.get("data", "record");
      await ctx.pluginData!.set("data", "record", value);
      return { outcome: "success", value: {} };
    });
    await f.set({ score: 20, bar: 120 });
    expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
      "conflict",
    );
    expect(await f.get()).toEqual({ score: 20, bar: 120 });
  });

  it("rolls back a guarded standalone pipeline batch, including writes after the failed check", async () => {
    const f = await readBaselineFixture(create);
    const execution = await f.prepare(async (ctx) => {
      await ctx.pluginData!.get("data", "record");
      await ctx.pluginData!.update("data", "record", [
        { op: "inc", path: "/score", by: 5 },
      ]);
      await ctx.pluginData!.update("data", "record", [
        { op: "merge", value: { bar: 115 } },
      ]);
      return { outcome: "success", value: {} };
    });
    const result = execution.commit.results[0]!;
    const prepared = await prepareRuntimeProposals(
      result,
      f.store,
      "session",
      "system",
      { readScopes: execution.commit.readBaselines!.runs[result.runId] },
    );
    await f.set({ score: 20, bar: 120 });
    const outcomes = await createCommitPipeline(f.store).commitAll(
      prepared.proposals,
    );
    expect(outcomes.every((outcome) => !outcome.committed)).toBe(true);
    expect(outcomes[0]?.code).toBe("conflict");
    expect(await f.get()).toEqual({ score: 20, bar: 120 });
    expect(
      await f.store.queryTraceEvents("session", {
        types: ["proposal.committed"],
      }),
    ).toEqual([]);
  });

  it("reuses a transaction-bound handle and leaves fan-out behind its owner's barrier", async () => {
    const f = await readBaselineFixture(create);
    const execution = await f.prepare(async (ctx) => {
      await ctx.pluginData!.get("data", "record");
      await ctx.pluginData!.set("data", "record", { score: 15, bar: 115 });
      return { outcome: "success", value: {} };
    });
    const result = execution.commit.results[0]!;
    const prepared = await prepareRuntimeProposals(
      result,
      f.store,
      "session",
      "system",
      { readScopes: execution.commit.readBaselines!.runs[result.runId] },
    );
    const deferred: Array<() => Promise<void>> = [];
    await f.store.withTransaction(async (tx) => {
      expect("withTransaction" in tx).toBe(false);
      const outcomes = await createCommitPipeline(tx).commitAll(
        prepared.proposals,
        (fn) => deferred.push(fn),
      );
      expect(outcomes.every((outcome) => outcome.committed)).toBe(true);
    });
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred.map((fn) => fn()));
    expect(await f.get()).toEqual({ score: 15, bar: 115 });
  });

  it("fails closed on corrupted host evidence without trusting raw proposal metadata", async () => {
    const f = await readBaselineFixture(create);
    const execution = await f.prepare(async (ctx) => {
      await ctx.pluginData!.get("data", "record");
      await ctx.pluginData!.set("data", "record", { score: 15 });
      return { outcome: "success", value: {} };
    });
    const result = execution.commit.results[0]!;
    const corrupted = {
      ...execution,
      commit: {
        ...execution.commit,
        readBaselines: {
          ...execution.commit.readBaselines!,
          runs: {
            [result.runId]: [
              { reads: [{ kind: "plugin-data", basis: "invalid" }] },
            ],
          } as never,
        },
      },
    };
    const outcome = await f.commit(corrupted);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("Read-baseline evidence is invalid");
    expect(await f.get()).toEqual({ score: 10, bar: 110 });
  });

  it.each(["read-write-read", "blind-write-read"])(
    "keeps %s prefixes out of the external basis",
    async (mode) => {
      const f = await readBaselineFixture(create);
      const execution = await f.prepare(async (ctx) => {
        if (mode === "read-write-read")
          await ctx.pluginData!.get("data", "record");
        else
          await ctx.pluginData!.set("data", "record", { score: 10, bar: 110 });
        await ctx.pluginData!.update("data", "record", [
          { op: "inc", path: "/score", by: 5 },
        ]);
        const value = (await ctx.pluginData!.get("data", "record")) as {
          score: number;
        };
        expect(value.score).toBe(15);
        await ctx.pluginData!.update("data", "record", [
          { op: "merge", value: { bar: value.score + 100 } },
        ]);
        return { outcome: "success", value: {} };
      });
      expect((await f.commit(execution)).failedProposals).toEqual([]);
      expect(await f.get()).toEqual({ score: 15, bar: 115 });
    },
  );

  it("rolls back every key and duplicate batch item when its second read target is stale", async () => {
    const f = await readBaselineFixture(create);
    await f.set({ score: 1 }, "second");
    const execution = await f.prepare(async (ctx) => {
      await ctx.pluginData!.list("data");
      await ctx.pluginData!.set("data", "unrelated", { score: 1 });
      return withPendingProposals({ outcome: "success", value: {} }, [
        makeProposal(ctx, "2026-10-30T00:00:00Z", "plugin.data.batch", {
          items: [
            { namespace: "data", key: "record", value: { score: 11 } },
            { namespace: "data", key: "second", value: { score: 2 } },
            { namespace: "data", key: "record", value: { score: 12 } },
          ],
        }),
      ]);
    });
    await f.set({ score: 3 }, "second");
    expect((await f.commit(execution)).failedProposals[0]?.code).toBe(
      "conflict",
    );
    expect(await f.get()).toEqual({ score: 10, bar: 110 });
    expect(await f.get("unrelated")).toBeUndefined();
  });

  it.each(["mutate", "replace", "add-replacement", "redirect"])(
    "pins read evidence through a hook that tries to %s",
    async (mode) => {
      const f = await readBaselineFixture(create);
      const execution = await f.prepare(async (ctx) => {
        await ctx.pluginData!.get("data", "record");
        await ctx.pluginData!.update(
          "data",
          "record",
          mode === "add-replacement"
            ? [{ op: "inc", path: "/score", by: 1 }]
            : [{ op: "merge", value: { score: 11 } }],
        );
        return { outcome: "success", value: {} };
      });
      const hookPipeline = createHookPipeline();
      hookPipeline.register<{ proposal: Proposal }>({
        id: "rewrite",
        pluginId: "writer",
        event: "PreStateCommit",
        handler: async (_context, { proposal }) => {
          expect(proposal).not.toHaveProperty("preconditions");
          if (proposal.type !== "plugin.data.update")
            return { action: "continue" };
          const payload = {
            ...proposal.payload,
            key: mode === "redirect" ? "elsewhere" : "record",
            ops: [{ op: "merge" as const, value: { score: 12 } }],
          };
          if (mode === "mutate") {
            Object.assign(proposal, { preconditions: [], payload });
            await f.set({ score: 20, bar: 120 });
            return { action: "continue" };
          }
          if (mode !== "redirect") await f.set({ score: 20, bar: 120 });
          return {
            action: "continue",
            replace: { proposal: { ...proposal, payload, preconditions: [] } },
          };
        },
      });
      const out = await f.commit(execution, { hookPipeline });
      expect(out.failedProposals).toHaveLength(1);
      if (mode === "redirect")
        expect(out.failedProposals[0]?.error).toBe(
          "A commit hook cannot redirect a guarded write target.",
        );
      else expect(out.failedProposals[0]?.code).toBe("conflict");
      expect(await f.get("elsewhere")).toBeUndefined();
      expect(JSON.stringify(out.failedProposals)).not.toMatch(
        /preconditions|fingerprint/,
      );
    },
  );

  it("accepts a same-target hook value rewrite against an unchanged basis", async () => {
    const f = await readBaselineFixture(create);
    const execution = await f.prepare(async (ctx) => {
      await ctx.pluginData!.get("data", "record");
      await ctx.pluginData!.set("data", "record", { score: 11 });
      return { outcome: "success", value: {} };
    });
    const hookPipeline = createHookPipeline();
    hookPipeline.register<{ proposal: Proposal }>({
      id: "rewrite",
      pluginId: "writer",
      event: "PreStateCommit",
      handler: async (_context, { proposal }) => ({
        action: "continue",
        replace: {
          proposal:
            proposal.type === "plugin.data"
              ? {
                  ...proposal,
                  payload: { ...proposal.payload, value: { score: 12 } },
                }
              : proposal,
        },
      }),
    });
    expect(
      (await f.commit(execution, { hookPipeline })).failedProposals,
    ).toEqual([]);
    expect(await f.get()).toEqual({ score: 12 });
  });

  it("keeps pure relative hook rewrites outside replacement target pinning", async () => {
    const f = await readBaselineFixture(create);
    await f.set({ score: 3 }, "other");
    const execution = await f.prepare(async (ctx) => {
      await ctx.pluginData!.get("data", "record");
      await ctx.pluginData!.update("data", "record", [
        { op: "inc", path: "/score", by: 2 },
      ]);
      return { outcome: "success", value: {} };
    });
    const hookPipeline = createHookPipeline();
    hookPipeline.register<{ proposal: Proposal }>({
      id: "relative",
      pluginId: "writer",
      event: "PreStateCommit",
      handler: async (_ctx, { proposal }) => ({
        action: "continue",
        replace: {
          proposal:
            proposal.type === "plugin.data.update"
              ? { ...proposal, payload: { ...proposal.payload, key: "other" } }
              : proposal,
        },
      }),
    });
    expect(
      (await f.commit(execution, { hookPipeline })).failedProposals,
    ).toEqual([]);
    expect(await f.get("other")).toEqual({ score: 5 });
  });
});
