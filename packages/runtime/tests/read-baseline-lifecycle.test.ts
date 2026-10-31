import { describe, expect, it, vi } from "vitest";
import { resumeSuspendedRuntime } from "../src/index.js";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { readBaselineFixture } from "./helpers/read-baseline-fixture.js";

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
