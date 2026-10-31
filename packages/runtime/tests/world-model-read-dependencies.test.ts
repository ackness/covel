import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { z } from "zod";
import type { RuntimeResult } from "@covel/shared";
import { classifyExecutionFaults } from "../src/index.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { latch } from "./_helpers/agent-loop-fixture.js";
import {
  fixture,
  fn,
  producer,
  story,
  tell,
  ok,
  writes,
  character,
  schema,
  refuseProducer,
  SESSION,
} from "./_helpers/world-read-fixture.js";

describe("world reads through commit", () => {
  it.each([
    ["memory", createMemoryStore],
    ["sqlite", () => createSqliteStore(":memory:")],
  ] as const)(
    "discards independently valid derived writes after late producer rejection on %s",
    async (_name, create) => {
      const f = await fixture({ create });
      const reader = fn("read");
      let observed: unknown;
      const r = await f.execute([producer, story, reader], {
        [producer.name]: async () => writes(character()),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          observed = ctx.world!.characters.find(
            (c) => c.id === "source",
          )?.description;
          await ctx.pluginData!.set("notes", "derived", String(observed));
          return writes(character("derived", String(observed), 1));
        },
      });
      expect(observed).toBe("staged");
      expect(r.edges(reader)).toEqual([r.resultOf(producer).runId]);
      const outcome = await r.commit(refuseProducer);
      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes).toEqual([
        expect.objectContaining({
          runId: r.resultOf(producer).runId,
          cause: "rejected",
        }),
        expect.objectContaining({
          runId: r.resultOf(reader).runId,
          cause: "read",
        }),
      ]);
      expect(
        (await f.store.listCharacters(SESSION)).map((c) => [
          c.description,
          c.version,
        ]),
      ).toEqual([
        ["original", 1],
        ["original", 1],
      ]);
      expect(await f.notes()).toEqual({});
      expect(
        (await f.store.listMessages(SESSION)).map((m) => m.content),
      ).toContain("The story continues.");
      const persisted = (await f.store.listTurnResults(SESSION)).flatMap(
        (row) => row.runtimeResults as RuntimeResult[],
      );
      expect(
        persisted.find((result) => result.runId === r.resultOf(reader).runId),
      ).toMatchObject({ status: "failed" });
      expect(JSON.stringify(persisted)).not.toContain("readDependencies");
      expect(
        classifyExecutionFaults(
          r.execution.commit.results,
          outcome,
          new Set(),
        ).get(reader.pluginId),
      ).toMatchObject({ kind: "neutral" });
    },
  );

  it.each(["characters", "characterSchema"] as const)(
    "records only the accessed %s property",
    async (property) => {
      const f = await fixture();
      const characterProducer = producer;
      const schemaProducer = fn(
        "schema",
        { stage: "pre-turn" },
        "schema-source",
      );
      const reader = fn("read");
      const r = await f.execute(
        [characterProducer, schemaProducer, story, reader],
        {
          [producer.name]: async () => writes(character()),
          [schemaProducer.name]: async () => writes(schema()),
          [story.name]: tell,
          [reader.name]: async (ctx) => {
            await ctx.pluginData!.set(
              "notes",
              "derived",
              JSON.stringify(ctx.world![property]),
            );
            return ok();
          },
        },
      );
      const observedProducer =
        property === "characters" ? characterProducer : schemaProducer;
      expect(r.edges(reader)).toEqual([r.resultOf(observedProducer).runId]);
      const outcome = await r.commit((p) =>
        p.source.runtimeId === observedProducer.name ? "refused" : undefined,
      );
      expect(outcome.isolatedRuntimes).toContainEqual(
        expect.objectContaining({ runtimeId: reader.name, cause: "read" }),
      );
      expect(await f.notes()).toEqual({});
    },
  );

  it.each(["produce", "middle"])(
    "cascades world and hard dependencies only downstream when %s is rejected",
    async (rejected) => {
      const f = await fixture();
      const b = fn("middle");
      const c = fn("last", { after: [b.name] });
      const d = fn("hard", { needs: [{ runtime: b.name }] });
      const e = fn("independent");
      const r = await f.execute([producer, story, b, c, d, e], {
        [producer.name]: async () => writes(character()),
        [story.name]: tell,
        [b.name]: async (ctx) => {
          void ctx.world!.characters;
          await ctx.pluginData!.set("notes", "middle", true);
          return writes(character("derived", "middle"));
        },
        [c.name]: async (ctx) => {
          void ctx.world!.characters;
          await ctx.pluginData!.get("notes", "middle");
          await ctx.pluginData!.set("notes", "last", true);
          return ok();
        },
        [d.name]: async (ctx) => {
          await ctx.pluginData!.set("notes", "hard", true);
          return ok();
        },
        [e.name]: async (ctx) => {
          await ctx.pluginData!.set("notes", "independent", true);
          return ok();
        },
      });
      expect(new Set(r.edges(c))).toEqual(
        new Set([r.resultOf(producer).runId, r.resultOf(b).runId]),
      );
      const outcome = await r.commit((p) =>
        p.source.runtimeId.endsWith(`/${rejected}`) ? "rejected" : undefined,
      );
      expect(outcome.status).toBe("committed");
      expect(await f.notes()).toEqual({ independent: true });
      expect(
        (await f.store.listCharacters(SESSION)).find((c) => c.id === "source")
          ?.description,
      ).toBe(rejected === "produce" ? "original" : "staged");
    },
  );

  it("keeps a story reader and writes one structural trace for both properties", async () => {
    const f = await fixture();
    const r = await f.execute([producer, story], {
      [producer.name]: async () => writes(schema(), character()),
      [story.name]: async (ctx) => {
        void ctx.world!.characters;
        void ctx.world!.characterSchema;
        void ctx.world!.characters;
        return tell(ctx);
      },
    });
    expect(r.edges(story)).toEqual([r.resultOf(producer).runId]);
    const outcome = await r.commit(refuseProducer);
    expect(outcome.status).toBe("committed");
    const traces = await f.store.queryTraceEvents(SESSION, {
      types: ["read-dependency.kept"],
    });
    expect(traces.map((t) => t.payload)).toEqual([
      {
        runtimeId: story.name,
        runId: r.resultOf(story).runId,
        producerRuntimeId: producer.name,
        producerRunId: r.resultOf(producer).runId,
        reason: `read data of ${producer.name} that did not commit`,
      },
    ]);
    expect(JSON.stringify(traces)).not.toContain("staged");
  });

  it("rolls back the whole execution without a story", async () => {
    const f = await fixture();
    const reader = fn("read");
    const r = await f.execute([producer, reader], {
      [producer.name]: async () => writes(character()),
      [reader.name]: async (ctx) => {
        void ctx.world!.characters;
        await ctx.pluginData!.set("notes", "read", true);
        return ok();
      },
    });
    expect((await r.commit(refuseProducer)).status).toBe("failed");
    expect(await f.notes()).toEqual({});
  });

  it("freezes sibling visibility before a parallel level and exposes both writes to the next level", async () => {
    const f = await fixture();
    const meet = latch(2);
    const left = fn("left", { stage: "pre-turn" });
    const right = fn("right", { stage: "pre-turn" });
    const reader = fn("read");
    const seen: string[][] = [];
    const r = await f.execute(
      [left, right, story, reader],
      Object.fromEntries([
        ...[left, right].map(
          (m) =>
            [
              m.name,
              async (ctx: Parameters<typeof tell>[0]) => {
                await meet();
                seen.push(
                  ctx.world!.characters.map((c) => c.description ?? ""),
                );
                return writes(
                  character(m === left ? "source" : "derived", m.name),
                );
              },
            ] as const,
        ),
        [story.name, tell],
        [
          reader.name,
          async (ctx: Parameters<typeof tell>[0]) => {
            expect(ctx.world!.characters.map((c) => c.description)).toEqual([
              left.name,
              right.name,
            ]);
            return ok();
          },
        ],
      ]),
    );
    expect(seen).toEqual([
      ["original", "original"],
      ["original", "original"],
    ]);
    expect(new Set(r.edges(reader))).toEqual(
      new Set([r.resultOf(left).runId, r.resultOf(right).runId]),
    );
    expect((await r.commit()).status).toBe("committed");
  });

  it.each(["parent-fails", "commit-rejects", "commits"])(
    "attributes recursive descendants by run through %s",
    async (mode) => {
      const failParent = mode === "parent-fails";
      const f = await fixture();
      const parent = producer;
      const child = fn("child", { stage: "pre-turn" }, parent.pluginId);
      const grandchild = fn(
        "grandchild",
        { trigger: { type: "manual" } },
        parent.pluginId,
      );
      const reader = fn("read");
      let seen: unknown;
      const r = await f.execute([parent, child, grandchild, story, reader], {
        [parent.name]: async (ctx) => {
          await ctx.recursiveCall({ manualTrigger: { runtimeId: child.name } });
          if (failParent) throw new Error("parent failed");
          await ctx.pluginData!.set("notes", "reject-parent", true);
          return writes(character("source", "parent", 1));
        },
        [child.name]: async (ctx) => {
          await ctx.recursiveCall({
            manualTrigger: { runtimeId: grandchild.name },
          });
          return writes(character("source", "child", 1));
        },
        [grandchild.name]: async () =>
          writes(character("source", "grandchild", 1)),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          seen = ctx.world!.characters.find((c) => c.id === "source");
          await ctx.pluginData!.set("notes", "derived", true);
          return ok();
        },
      });
      const childRuns = r.results.filter((x) => x.runtimeId === child.name);
      expect(childRuns).toHaveLength(failParent ? 1 : 2);
      expect(new Set(childRuns.map((x) => x.runId)).size).toBe(
        childRuns.length,
      );
      expect(r.edges(reader).length).toBe(failParent ? 2 : 5);
      const expected = r.results
        .filter((x) =>
          x.pendingProposals?.some((p) => p.type === "character.upsert"),
        )
        .map((x) => x.runId);
      expect(r.edges(reader)).toEqual(expected);
      expect(seen).toMatchObject({
        description: failParent ? "child" : "parent",
      });
      const outcome = await r.commit((p) =>
        mode === "commit-rejects" &&
        p.type === "plugin.data" &&
        p.payload.key === "reject-parent"
          ? "refused"
          : undefined,
      );
      if (mode === "commit-rejects")
        expect(outcome.isolatedRuntimes).toContainEqual(
          expect.objectContaining({ runtimeId: reader.name, cause: "read" }),
        );
      expect(outcome.status).toBe("committed");
      if (mode === "commits") {
        expect(
          (await f.store.listCharacters(SESSION)).find(
            (c) => c.id === "source",
          ),
        ).toEqual(seen);
        expect(outcome.isolatedRuntimes ?? []).toEqual([]);
      }
    },
  );

  it.each(["auxiliary", "story"])(
    "settles a rejected %s operation without inventing world reads",
    async (owner) => {
      const services = new PluginServiceRegistry({
        list: async () => ["source", "observer", "service", "storyteller"],
        ensure: async () => {},
      });
      services.register("service", {
        name: "write",
        contract: "test.write@1",
        access: "write",
        input: z.object({}),
        output: z.object({}),
        handler: async (_input, ctx) => {
          await ctx.pluginData.set("notes", "operation", true);
          return {};
        },
      });
      const f = await fixture({ deps: { services } });
      const reader = fn("read");
      const r = await f.execute([producer, story, reader], {
        [producer.name]: async (ctx) => {
          if (owner === "auxiliary")
            await ctx.services!.call({
              pluginId: "service",
              name: "write",
              contract: "test.write@1",
              input: {},
            });
          return writes(character());
        },
        [story.name]: async (ctx) => {
          if (owner === "story")
            await ctx.services!.call({
              pluginId: "service",
              name: "write",
              contract: "test.write@1",
              input: {},
            });
          return tell(ctx);
        },
        [reader.name]: async (ctx) => {
          if (owner === "auxiliary") void ctx.world!.characters;
          await ctx.pluginData!.set("notes", "derived", true);
          return ok();
        },
      });
      expect(
        r.resultOf(owner === "auxiliary" ? producer : story).operations,
      ).toHaveLength(1);
      expect(r.edges(story)).toEqual([]);
      expect(r.edges(reader)).toEqual(
        owner === "auxiliary" ? [r.resultOf(producer).runId] : [],
      );
      const outcome = await r.commit((p) =>
        p.source.pluginId === "service" ? "operation refused" : undefined,
      );
      expect(outcome.status).toBe("committed");
      if (owner === "auxiliary")
        expect(outcome.isolatedRuntimes).toContainEqual(
          expect.objectContaining({ runtimeId: reader.name, cause: "read" }),
        );
      else {
        expect(outcome.isolatedRuntimes ?? []).toEqual([]);
        expect(await f.notes()).toEqual({ derived: true });
      }
      expect(await f.notes("service")).toEqual({});
      const persisted = (await f.store.listTurnResults(SESSION)).flatMap(
        (row) => row.runtimeResults as RuntimeResult[],
      );
      expect(
        persisted.flatMap((r) => r.operations ?? []).map((o) => o.status),
      ).toEqual(["failed"]);
    },
  );
});
