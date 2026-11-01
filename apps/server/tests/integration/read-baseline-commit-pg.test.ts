import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { createPgStore } from "@covel/store/postgres";
import type { HandlerResult, RuntimeManifest } from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import {
  classifyExecutionFaults,
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
  PluginServiceRegistry,
} from "@covel/runtime";
import { z } from "zod";
import { selfDataBaselineSuite } from "../../../../packages/runtime/tests/helpers/selfdata-baseline-suite.js";
import { createPgAdvisorySessionLock } from "../../src/lib/pg-session-lock.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  createIsolatedPgDatabase,
  type IsolatedPgDatabase,
} from "./pg-test-db.js";

let database: IsolatedPgDatabase | undefined;
try {
  database = await createIsolatedPgDatabase(
    process.env.DATABASE_URL ??
      "postgresql://covel:covel_dev@localhost:5432/covel",
    "covel_test_read_baselines",
  );
} catch (error) {
  if (process.env.COVEL_REQUIRE_PG_TESTS === "1")
    throw new Error("PostgreSQL is required for read-baseline commit tests", {
      cause: error,
    });
}
afterAll(async () => {
  await database?.cleanup();
}, 90_000);

describe.skipIf(!database)("selfData PostgreSQL parity", () => {
  selfDataBaselineSuite("postgres", () =>
    createPgStore(database!.url, { freshSchema: true }),
  );
});

const open: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((store) => store.close()));
});
const at = "2026-10-31T00:00:00.000Z";
const manifest = {
  name: "writer",
  pluginId: "writer",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "system",
  trigger: { type: "auto" },
} as RuntimeManifest;

for (const backend of ["memory", "sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !database)(
    `read-baseline commit on ${backend}`,
    () => {
      it.each(["replace", "absence", "batch", "derived"] as const)(
        "serializes two completed %s plans and rejects the stale one atomically",
        async (kind) => {
          const sessionId = crypto.randomUUID();
          const firstStore =
            backend === "postgres"
              ? await createPgStore(database!.url, { freshSchema: true })
              : backend === "sqlite"
                ? createSqliteStore(":memory:")
                : createMemoryStore();
          const secondStore =
            backend === "postgres"
              ? await createPgStore(database!.url)
              : firstStore;
          open.push(...new Set([firstStore, secondStore]));
          await firstStore.createSession({
            id: sessionId,
            locale: "en",
            status: "active",
            phase: "playing",
            setupRuntimes: {},
            seats: [],
            activePlugins: ["writer"],
            completedPlayerTurns: 0,
            createdAt: at,
            updatedAt: at,
          });
          const seed = async (key: string, value: unknown) =>
            firstStore.setPluginData({
              id: `${sessionId}:${key}`,
              sessionId,
              pluginId: "writer",
              namespace: "data",
              key,
              value,
              createdAt: at,
              updatedAt: at,
            });
          if (kind !== "absence") await seed("record", { score: 10, bar: 110 });
          await seed("independent", { score: 1 });
          const handler: FunctionHandler = async (
            ctx,
          ): Promise<HandlerResult> => {
            const value = (await ctx.pluginData!.get("data", "record")) as {
              score: number;
            } | null;
            if (kind === "batch") {
              await ctx.pluginData!.get("data", "independent");
              return {
                outcome: "success",
                value: {},
                effects: {
                  pluginData: [
                    {
                      namespace: "data",
                      key: "independent",
                      value: { score: 2 },
                    },
                    {
                      namespace: "data",
                      key: "record",
                      value: {
                        score: value!.score + 5,
                        bar: value!.score + 105,
                      },
                    },
                  ],
                },
              };
            }
            if (kind === "derived")
              await ctx.pluginData!.update("data", "record", [
                { op: "inc", path: "/score", by: 5 },
                { op: "merge", value: { bar: value!.score + 105 } },
              ]);
            else
              await ctx.pluginData!.set("data", "record", {
                score: (value?.score ?? 0) + 5,
                bar: (value?.score ?? 0) + 105,
              });
            return { outcome: "success", value: {} };
          };
          const prepare = (store: DataStore, turnId: string) =>
            executeTurn(
              {
                sessionId,
                turnId,
                logicalTurnId: turnId,
                origin: "player",
                playerMessage: "Continue",
              },
              [manifest],
              {
                store,
                llm: { generate: vi.fn() } as never,
                loadRuntime: async () => ({
                  manifest,
                  promptTemplate: "",
                  handler,
                }),
              },
            );
          const plans = await Promise.all([
            prepare(firstStore, "first"),
            prepare(secondStore, "second"),
          ]);
          const poolA =
            database && backend === "postgres"
              ? postgres(database.url, { max: 1 })
              : undefined;
          const poolB =
            database && backend === "postgres"
              ? postgres(database.url, { max: 1 })
              : undefined;
          const sharedLock = createInProcessSessionLock();
          const lockA = poolA ? createPgAdvisorySessionLock(poolA) : sharedLock;
          const lockB = poolB ? createPgAdvisorySessionLock(poolB) : sharedLock;
          try {
            const outcomes = await Promise.all(
              plans.map((execution, index) =>
                (index === 0 ? lockA : lockB).withLock(sessionId, () =>
                  commitExecution({
                    store: index === 0 ? firstStore : secondStore,
                    execution: {
                      ...execution,
                      commit: {
                        ...execution.commit,
                        sessionClock: { now: at },
                      },
                    },
                    completion: {
                      kind: "turn",
                      turnId: index === 0 ? "first" : "second",
                      durationMs: 0,
                    },
                  }),
                ),
              ),
            );
            expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
              "committed",
              "failed",
            ]);
            expect(
              (await firstStore.getSession(sessionId))?.completedPlayerTurns,
            ).toBe(1);
            const failure = outcomes.find(
              (outcome) => outcome.status === "failed",
            )!;
            expect(failure.failedProposals[0]?.code).toBe("conflict");
            expect(failure.events).toEqual([]);
            expect(
              (
                await firstStore.getPluginData(
                  sessionId,
                  "writer",
                  "data",
                  "record",
                )
              )?.value,
            ).toEqual(
              kind === "absence"
                ? { score: 5, bar: 105 }
                : { score: 15, bar: 115 },
            );
            expect(
              (
                await firstStore.getPluginData(
                  sessionId,
                  "writer",
                  "data",
                  "independent",
                )
              )?.value,
            ).toEqual({ score: kind === "batch" ? 2 : 1 });
            expect(
              (
                await firstStore.queryTurnResults(sessionId, {
                  commitStatus: "committed",
                })
              ).length,
            ).toBe(1);
          } finally {
            await Promise.all([poolA?.end(), poolB?.end()]);
            await firstStore.deleteSession(sessionId);
          }
        },
      );
      it.each(["provider", "resume"] as const)(
        "preserves the existing %s failure boundary for stale derived writes",
        async (mode) => {
          const store =
            backend === "postgres"
              ? await createPgStore(database!.url, { freshSchema: true })
              : backend === "sqlite"
                ? createSqliteStore(":memory:")
                : createMemoryStore();
          open.push(store);
          const sessionId = crypto.randomUUID();
          await store.createSession({
            id: sessionId,
            locale: "en",
            status: "active",
            phase: "playing",
            setupRuntimes: {},
            seats: [],
            activePlugins: ["writer", "bank"],
            completedPlayerTurns: 0,
            createdAt: at,
            updatedAt: at,
          });
          const provider = mode === "provider" ? "bank" : "writer";
          const row = {
            id: `${sessionId}:record`,
            sessionId,
            pluginId: provider,
            namespace: "data",
            key: "record",
            value: { score: 10, bar: 110 },
            createdAt: at,
            updatedAt: at,
          };
          await store.setPluginData(row);
          const services = new PluginServiceRegistry({
            list: async () => ["writer", "bank"],
            ensure: async () => {},
          });
          services.register("bank", {
            name: "derive",
            contract: "bank.derive@1",
            access: "write",
            input: z.object({}),
            output: z.unknown(),
            handler: async (_args, ctx) => {
              const value = (await ctx.pluginData.get("data", "record")) as {
                score: number;
              };
              await ctx.pluginData.update("data", "record", [
                { op: "inc", path: "/score", by: 5 },
                { op: "merge", value: { bar: value.score + 105 } },
              ]);
              return {};
            },
          });
          services.register("bank", {
            name: "independent",
            contract: "bank.independent@1",
            access: "write",
            input: z.object({}),
            output: z.unknown(),
            handler: async (_args, ctx) => {
              await ctx.pluginData.set("data", "independent", true);
              return {};
            },
          });
          const runtime =
            mode === "provider"
              ? {
                  ...manifest,
                  outputKind: "story" as const,
                  stage: "narrative" as const,
                }
              : manifest;
          const handler: FunctionHandler = async (ctx) => {
            if (mode === "provider") {
              await ctx.services!.call({
                pluginId: "bank",
                name: "derive",
                contract: "bank.derive@1",
                input: {},
              });
              await ctx.services!.call({
                pluginId: "bank",
                name: "independent",
                contract: "bank.independent@1",
                input: {},
              });
              return {
                outcome: "success",
                value: { narrativeOutput: "The story continues." },
              };
            }
            const value = (await ctx.pluginData!.get("data", "record")) as {
              score: number;
            };
            await ctx.pluginData!.update("data", "record", [
              { op: "inc", path: "/score", by: 5 },
              { op: "merge", value: { bar: value.score + 105 } },
            ]);
            return {
              outcome: "suspended",
              reason: "Choose",
              resumeSchema: { type: "object" },
            };
          };
          const deps = {
            store,
            services,
            llm: { generate: vi.fn() } as never,
            loadRuntime: async () => ({
              manifest: runtime,
              promptTemplate: "",
              handler,
            }),
          };
          const execution = await executeTurn(
            {
              sessionId,
              turnId: "source",
              logicalTurnId: "source",
              origin: "player",
              playerMessage: "Continue",
            },
            [runtime],
            deps,
          );
          const commit = (
            pending: Parameters<typeof commitExecution>[0]["execution"],
          ) =>
            commitExecution({
              store,
              execution: pending,
              completion: { kind: "turn", turnId: "source", durationMs: 0 },
            });
          const runLocked = <T>(fn: () => Promise<T>) =>
            createInProcessSessionLock().withLock(sessionId, fn);
          // This fixture has one commit owner; the cross-connection race above
          // exercises the PostgreSQL host advisory lock separately.
          if (mode === "resume")
            expect((await runLocked(() => commit(execution))).status).toBe(
              "committed",
            );
          await store.setPluginData({ ...row, value: { score: 20, bar: 120 } });
          const pending =
            mode === "resume"
              ? await resumeSuspendedRuntime(
                  (await store.listSuspensions(sessionId))[0]!,
                  {},
                  runtime,
                  {
                    ...deps,
                    loadRuntime: async () => ({
                      manifest: runtime,
                      promptTemplate: "",
                      handler: async (ctx) => {
                        await ctx.pluginData!.get("data", "record");
                        return { outcome: "success", value: {} };
                      },
                    }),
                  },
                )
              : execution;
          const out = await runLocked(() => commit(pending));
          expect(out.status).toBe(mode === "provider" ? "committed" : "failed");
          expect(out.failedProposals[0]?.code).toBe("conflict");
          expect(out.failedProposals[0]?.proposal.source.pluginId).toBe(
            provider,
          );
          expect(
            (await store.getPluginData(sessionId, provider, "data", "record"))
              ?.value,
          ).toEqual({ score: 20, bar: 120 });
          if (mode === "provider") {
            expect(
              out.operations?.map((operation) => operation.status),
            ).toEqual(["failed", "committed"]);
            expect(
              (
                await store.getPluginData(
                  sessionId,
                  "bank",
                  "data",
                  "independent",
                )
              )?.value,
            ).toBe(true);
            expect(
              (await store.listMessages(sessionId)).map(
                (message) => message.content,
              ),
            ).toContain("The story continues.");
          }
          const faults = classifyExecutionFaults(
            pending.commit.results,
            out,
            new Set(),
            [],
            pending.commit.serviceCalls ?? [],
          );
          expect(
            [...faults.values()].some((verdict) => verdict.kind === "fault"),
          ).toBe(false);
          await store.deleteSession(sessionId);
        },
      );
    },
  );
}
