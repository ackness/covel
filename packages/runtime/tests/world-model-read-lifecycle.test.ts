import { describe, expect, it } from "vitest";
import type {
  HandlerResult,
  RuntimeResult,
  WorldModelView,
} from "@covel/shared";
import { withPendingProposals } from "@covel/tools";
import {
  applySuspensionAbandonTx,
  commitExecution,
  planSuspensionAbandon,
  resumeSuspendedRuntime,
} from "../src/index.js";
import { attachNestedResults } from "../src/turn-executor/nested-results.js";
import { queuedLLM, toolCall } from "./_helpers/agent-loop-fixture.js";
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
  AT,
} from "./_helpers/world-read-fixture.js";

const suspend = (): HandlerResult => ({
  outcome: "suspended",
  reason: "Need an answer",
  resumeSchema: { type: "object" },
});
const ask = {
  reason: "Need an answer",
  fields: [{ type: "text", name: "answer", label: "Answer" }],
};

describe("world read lifecycle", () => {
  it("revokes a cancelled reader and starts the next invocation with a fresh recorder", async () => {
    const f = await fixture();
    const reader = fn("read");
    const controller = new AbortController();
    let retained: WorldModelView | undefined;
    const cancelled = await f.execute(
      [producer, story, reader],
      {
        [producer.name]: async () => writes(character()),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          retained = ctx.world;
          void retained!.characters;
          controller.abort(new Error("execution cancelled"));
          return ok();
        },
      },
      { deps: { turnControl: { executionSignal: controller.signal } } },
    );
    expect(cancelled.resultOf(reader).status).toBe("failed");
    expect(cancelled.edges(reader)).toEqual([]);
    expect(() => retained!.characterSchema).toThrow();
    const clean = await f.execute(
      [producer, story, reader],
      {
        [producer.name]: async () => writes(character()),
        [story.name]: tell,
        [reader.name]: async () => ok(),
      },
      { input: { turnId: "after-cancellation" } },
    );
    expect(clean.edges(reader)).toEqual([]);
    expect((await clean.commit(refuseProducer)).isolatedRuntimes).toHaveLength(
      1,
    );
  });

  it.each(["retry", "detached"] as const)(
    "excludes settled seed subtrees in a real %s execution",
    async (mode) => {
      const f = await fixture();
      const reader = fn("read", {
        after: [producer.name],
        ...(mode === "detached"
          ? {
              turnCompletion: { mode: "detached" },
              effects: { writes: ["plugin-data:self:notes"] },
            }
          : {}),
      });
      const seed: RuntimeResult = {
        pluginId: producer.pluginId,
        runtimeId: producer.name,
        runId: "historical-run",
        turnId: "source-turn",
        status: "success",
        output: {},
        pendingProposals: [
          schema(),
          character("source", "old", 1),
          character("rejected", "ghost"),
        ],
        toolCalls: [],
        durationMs: 0,
        timestamp: AT,
      };
      attachNestedResults(seed, [
        { ...seed, runId: "historical-child", runtimeId: "source/child" },
      ]);
      const r = await f.execute(
        [producer, reader],
        {
          [reader.name]: async (ctx) => {
            expect(
              ctx
                .world!.characters.map((c) => [c.id, c.description, c.version])
                .sort(),
            ).toEqual([
              ["derived", "original", 1],
              ["source", "original", 1],
            ]);
            expect(ctx.world!.characterSchema?.version).toBe(1);
            expect(ctx.world!.dimensions).toEqual({});
            await ctx.pluginData!.set("notes", "current", true);
            return ok();
          },
        },
        {
          input:
            mode === "retry"
              ? {
                  origin: "manual",
                  turnId: "retry-turn",
                  playerMessage: "",
                  manualTrigger: {
                    runtimeId: reader.name,
                    sourceTurnId: "source-turn",
                    retrySeedResults: [seed],
                  },
                }
              : {
                  origin: "background",
                  turnId: "background-turn",
                  playerMessage: "",
                  detachedStage: {
                    jobId: "job",
                    runtimeId: reader.name,
                    sourceTurnId: "source-turn",
                    sourceExecutionId: "source-execution",
                    sourceExecutionStartedAt: AT,
                    turnDigest: {
                      turnId: "source-turn",
                      playerMessage: "",
                      actions: [],
                      lastPlayerInput: null,
                      narrativeText: "",
                      toolCallSummaries: [],
                      runtimeResults: [],
                    },
                    upstreamResults: [seed],
                  },
                },
        },
      );
      expect(r.resultOf(reader).status, r.resultOf(reader).error).toBe(
        "success",
      );
      expect(r.edges(reader)).toEqual([]);
      expect(JSON.stringify(r.execution.commit.readDependencies)).not.toContain(
        "historical",
      );
      expect((await r.commit()).status).toBe("committed");
      expect(await f.notes()).toEqual({ current: true });
      expect((await f.store.getCharacterSchema(SESSION))?.version).toBe(1);
    },
  );

  it.each(
    [false, true].flatMap((stageWrites) =>
      ["world", "plugin-data"].map((rejected) => ({ stageWrites, rejected })),
    ),
  )(
    "drops a suspended function reader of rejected $rejected, with staged writes: $stageWrites",
    async ({ stageWrites, rejected }) => {
      const f = await fixture();
      const reader = fn("read", { tools: { builtin: ["stage-character"] } });
      const dataProducer = fn("data", { stage: "pre-turn" });
      const child = fn("child", { trigger: { type: "manual" } });
      const later = fn("later", {
        turnCompletion: { mode: "detached" },
        effects: { writes: ["plugin-data:self:notes"] },
      });
      const r = await f.execute(
        [producer, dataProducer, story, reader, child, later],
        {
          [producer.name]: async () => writes(character()),
          [dataProducer.name]: async (ctx) => {
            await ctx.pluginData!.set("notes", "upstream", true);
            return ok();
          },
          [story.name]: tell,
          [reader.name]: async (ctx) => {
            expect(
              ctx.world!.characters.find((c) => c.id === "source")?.description,
            ).toBe("staged");
            await ctx.pluginData!.get("notes", "upstream");
            await ctx.progress?.report({
              jobId: "waiting",
              state: "running",
              sequence: 1,
            });
            if (stageWrites) {
              await ctx.pluginData!.set("notes", "derived", true);
              await ctx.tools!.call("stage-character", {
                id: "derived",
                description: "derived",
              });
              await ctx.recursiveCall({
                manualTrigger: { runtimeId: child.name },
              });
            }
            return suspend();
          },
          [child.name]: async (ctx) => {
            await ctx.pluginData!.set("notes", "nested", true);
            return ok();
          },
        },
      );
      expect(r.resultOf(reader).status, r.resultOf(reader).error).toBe(
        "suspended",
      );
      expect(new Set(r.edges(reader))).toEqual(
        new Set([r.resultOf(producer).runId, r.resultOf(dataProducer).runId]),
      );
      expect(r.execution.commit.suspensions).toHaveLength(1);
      const released: string[] = [];
      const outcome = await r.commit(
        (p) =>
          p.source.runtimeId ===
          (rejected === "world" ? producer.name : dataProducer.name)
            ? "producer refused"
            : undefined,
        async (_tx, jobs) => {
          released.push(...jobs.map((job) => job.runtimeId));
        },
      );
      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes).toContainEqual(
        expect.objectContaining({ runtimeId: reader.name, cause: "read" }),
      );
      expect(await f.store.listSuspensions(SESSION)).toEqual([]);
      expect(f.events.filter((e) => e.type === "turn.suspended")).toEqual([]);
      expect(await f.notes()).toEqual(
        rejected === "world" ? { upstream: true } : {},
      );
      expect((await f.store.getSession(SESSION))?.completedPlayerTurns).toBe(1);
      expect(
        (await f.store.listCharacters(SESSION)).find((c) => c.id === "source")
          ?.description,
      ).toBe(rejected === "world" ? "original" : "staged");
      expect(
        (await f.store.listCharacters(SESSION)).find((c) => c.id === "derived")
          ?.description,
      ).toBe("original");
      const states = await f.store.listJobStatus(SESSION, {
        progressScopeId: r.execution.commit.executionContext.executionId,
        jobId: "waiting",
      });
      expect(states.at(-1)?.state).toBe("failed");
      expect(
        r.execution.result.withheldRuntimeJobs?.map((job) => job.runtimeId),
      ).toContain(later.name);
      expect(released).toEqual([later.name]);
    },
  );

  it.each([false, true])(
    "drops a suspended agent reader at source commit, with staged writes: %s",
    async (stageWrites) => {
      const script = [
        toolCall("list-characters", {}),
        ...(stageWrites
          ? [
              toolCall("stage-character", {
                id: "derived",
                description: "derived",
              }),
            ]
          : []),
        toolCall("suspend", ask),
      ];
      const f = await fixture({ deps: { llm: queuedLLM(script) } });
      const reader = fn("read", {
        runtimeType: "agent",
        tools: { builtin: ["list-characters", "stage-character", "suspend"] },
      });
      const r = await f.execute([producer, story, reader], {
        [producer.name]: async () => writes(character()),
        [story.name]: tell,
      });
      expect(r.resultOf(reader).status, r.resultOf(reader).error).toBe(
        "suspended",
      );
      expect(r.edges(reader)).toEqual([r.resultOf(producer).runId]);
      const outcome = await r.commit(refuseProducer);
      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes).toContainEqual(
        expect.objectContaining({ runtimeId: reader.name, cause: "read" }),
      );
      expect(await f.store.listSuspensions(SESSION)).toEqual([]);
      expect(f.events.filter((e) => e.type === "turn.suspended")).toEqual([]);
      expect(
        (await f.store.listCharacters(SESSION)).map((c) => c.description),
      ).toEqual(["original", "original"]);
      expect((await f.store.getSession(SESSION))?.completedPlayerTurns).toBe(1);
    },
  );

  it("saves a surviving continuation, resumes twice from committed state, and never replays producers", async () => {
    const f = await fixture();
    const reader = fn("read", { tools: { builtin: ["stage-character"] } });
    let leg = 0;
    const handlers = {
      [producer.name]: async () =>
        writes(character("source", "staged", 1), schema()),
      [story.name]: tell,
      [reader.name]: async (ctx: Parameters<typeof tell>[0]) => {
        expect(
          ctx.world!.characters.find((c) => c.id === "source"),
        ).toMatchObject({ description: "staged", version: 2 });
        expect(ctx.world!.characterSchema?.version).toBe(2);
        if (leg === 0)
          await ctx.tools!.call("stage-character", {
            id: "derived",
            description: "saved",
          });
        else
          expect(
            ctx.world!.characters.find((c) => c.id === "derived")?.description,
          ).toBe("saved");
        await ctx.pluginData!.set("notes", `leg-${leg}`, true);
        return leg++ < 2 ? suspend() : ok();
      },
    };
    const r = await f.execute([producer, story, reader], handlers);
    expect(r.edges(reader)).toEqual([r.resultOf(producer).runId]);
    expect((await r.commit()).status).toBe("committed");
    for (let pass = 0; pass < 2; pass++) {
      const suspension = (await f.store.listSuspensions(SESSION)).find(
        (s) => s.resolvedAt === undefined,
      )!;
      expect(JSON.stringify(suspension)).not.toContain(
        r.resultOf(producer).runId,
      );
      const resumed = await resumeSuspendedRuntime(
        suspension,
        {},
        reader,
        r.deps,
        { activeRuntimes: [producer, story, reader] },
      );
      expect(resumed.result.status).toBe(pass === 0 ? "suspended" : "success");
      expect(resumed.commit.readDependencies ?? {}).toEqual({});
      expect(
        (
          await commitExecution({
            store: f.store,
            eventBus: f.eventBus,
            execution: resumed,
            completion: {
              kind: "resume",
              turnId: suspension.turnId,
              suspensionId: suspension.id,
              pluginId: suspension.pluginId,
              runtimeId: suspension.runtimeId,
            },
          })
        ).status,
      ).toBe("committed");
    }
    expect(await f.notes()).toEqual({
      "leg-0": true,
      "leg-1": true,
      "leg-2": true,
    });
    expect(
      (await f.store.listCharacters(SESSION)).find((c) => c.id === "source")
        ?.version,
    ).toBe(2);
    expect((await f.store.getSession(SESSION))?.completedPlayerTurns).toBe(1);
  });

  it("abandons saved derived work without committing it", async () => {
    const f = await fixture();
    const reader = fn("read");
    const r = await f.execute([producer, story, reader], {
      [producer.name]: async () => writes(character()),
      [story.name]: tell,
      [reader.name]: async (ctx) => {
        void ctx.world!.characters;
        await ctx.pluginData!.set("notes", "derived", true);
        return suspend();
      },
    });
    await r.commit();
    const [saved] = await f.store.listSuspensions(SESSION);
    const plan = await planSuspensionAbandon(f.store, saved!);
    await f.store.withTransaction((tx) =>
      applySuspensionAbandonTx(tx, plan, AT),
    );
    expect(await f.notes()).toEqual({});
  });

  it.each(["failed", "suspended"] as const)(
    "never exposes a %s producer and starts the next invocation with a fresh recorder",
    async (status) => {
      const f = await fixture();
      const reader = fn("read");
      const first = await f.execute([producer, story, reader], {
        [producer.name]: async () =>
          withPendingProposals(
            status === "failed"
              ? { outcome: "failed", error: "failed" }
              : suspend(),
            [character()],
          ),
        [story.name]: tell,
        [reader.name]: async (ctx) => {
          expect(
            ctx.world!.characters.find((c) => c.id === "source")?.description,
          ).toBe("original");
          return ok();
        },
      });
      expect(first.edges(reader)).toEqual([]);
      await first.commit();
      const readAndFail = await f.execute(
        [producer, story, reader],
        {
          [producer.name]: async () => writes(character()),
          [story.name]: tell,
          [reader.name]: async (ctx) => {
            void ctx.world!.characters;
            throw new Error("failed attempt");
          },
        },
        { input: { turnId: "failed-attempt" } },
      );
      expect(readAndFail.edges(reader)).toEqual([]);
      await readAndFail.commit(refuseProducer);
      const clean = await f.execute(
        [producer, story, reader],
        {
          [producer.name]: async () => writes(character()),
          [story.name]: tell,
          [reader.name]: async () => ok(),
        },
        { input: { turnId: "clean-attempt" } },
      );
      expect(clean.edges(reader)).toEqual([]);
      expect(
        (await clean.commit(refuseProducer)).isolatedRuntimes,
      ).toHaveLength(1);
    },
  );
});
