/**
 * Write-service operations at commit on real PostgreSQL.
 *
 * A write-service call stages its provider's writes as one operation, which
 * commits after its caller's unit in a savepoint of its own. On PostgreSQL the
 * rejection comes from inside the transaction: an operation's `update` goes
 * out of bounds against a row a concurrent commit changed. Next to a story
 * only that operation is dropped, both of its keys; inside an auxiliary unit
 * the rejected operation drops the unit. The settled records persist on the
 * turn's `turn_results` rows.
 *
 * Skipped when `DATABASE_URL` is not set or PG is unreachable, unless
 * `COVEL_REQUIRE_PG_TESTS=1` (`pnpm test:pg`).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  OperationRecord,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import type { DataStore } from "@covel/store";
import { createPgStore } from "@covel/store/postgres";
import {
  commitExecution,
  executeTurn,
  PluginServiceRegistry,
  createToolExecutor,
  resumeSuspendedRuntime,
  type ExecutionDeps,
} from "@covel/runtime";
import {
  createIsolatedPgDatabase,
  type IsolatedPgDatabase,
} from "./pg-test-db.js";

const BASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const REQUIRE_PG = process.env.COVEL_REQUIRE_PG_TESTS === "1";
let isolatedDatabase: IsolatedPgDatabase | undefined;

async function createIsolatedPgUrl(): Promise<string | null> {
  try {
    isolatedDatabase = await createIsolatedPgDatabase(
      BASE_URL,
      "covel_test_write_operations_pg",
    );
    return isolatedDatabase.url;
  } catch (error) {
    if (REQUIRE_PG) {
      throw new Error("PostgreSQL is required for write-operation tests", {
        cause: error,
      });
    }
    return null;
  }
}

const isolatedUrl = await createIsolatedPgUrl();

const AT = "2026-10-30T00:00:00.000Z";
const PLUGINS = ["narrator", "shop", "bank"];

function fn(
  pluginId: string,
  id: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name: `${pluginId}/${id}`,
    pluginId,
    description: id,
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
    ...extra,
  } as RuntimeManifest;
}

type Ctx = Parameters<FunctionHandler>[0];
const trade = (ctx: Ctx, item: string, cost: number) =>
  ctx.services!.call({
    pluginId: "bank",
    name: "trade",
    contract: "bank.trade@1",
    input: { item, cost },
  });

function bankServices(): PluginServiceRegistry {
  const registry = new PluginServiceRegistry({
    list: async () => PLUGINS,
    ensure: async (_sessionId, pluginId) => {
      if (!PLUGINS.includes(pluginId)) throw new Error("Not active");
    },
  });
  // Two keys per call: the item first, then the payment.
  registry.register("bank", {
    name: "trade",
    contract: "bank.trade@1",
    access: "write",
    input: z.object({ item: z.string(), cost: z.number() }),
    output: z.unknown(),
    handler: async ({ item, cost }, ctx) => {
      await ctx.pluginData.set("items", item, { owned: true });
      await ctx.pluginData.update("wallet", "gold", [
        { op: "inc", path: "/amount", by: -cost, min: 0 },
      ]);
      return { item };
    },
  });
  return registry;
}

describe.skipIf(!isolatedUrl)("write-service operations on real PG", () => {
  let store: DataStore;

  beforeAll(async () => {
    store = await createPgStore(isolatedUrl!, { freshSchema: true });
  });

  afterAll(async () => {
    await store?.close();
    await isolatedDatabase?.cleanup();
  }, 90_000);

  const setGold = (session: string, amount: number) =>
    store.setPluginData({
      id: `${session}:bank:wallet:gold`,
      sessionId: session,
      pluginId: "bank",
      namespace: "wallet",
      key: "gold",
      value: { amount },
      createdAt: AT,
      updatedAt: AT,
    });

  async function run(
    session: string,
    runtimes: readonly RuntimeManifest[],
    handlers: Record<string, FunctionHandler>,
    concurrentGold: number,
  ) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.createSession({
      id: session,
      locale: "en-US",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: PLUGINS,
      completedPlayerTurns: 1,
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      createdAt: AT,
      updatedAt: AT,
    });
    await setGold(session, 100);
    const execution = await executeTurn(
      {
        sessionId: session,
        turnId: `${session}-turn`,
        logicalTurnId: `${session}-logical`,
        playerMessage: "Buy",
        origin: "player",
      },
      runtimes,
      {
        store,
        services: bankServices(),
        llm: { generate: vi.fn() } as never,
        loadRuntime: async (runtime) => ({
          manifest: runtime,
          promptTemplate: "",
          handler: handlers[runtime.name],
        }),
      },
    );
    // A concurrent commit spends most of the gold.
    await setGold(session, concurrentGold);
    const outcome = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: `${session}-turn`, durationMs: 0 },
    });
    const items = async () =>
      (await store.listPluginData(session, "bank", "items"))
        .map((row) => row.key)
        .sort();
    const gold = async () =>
      (
        (await store.getPluginData(session, "bank", "wallet", "gold"))
          ?.value as { amount: number } | undefined
      )?.amount;
    const persisted = async (): Promise<OperationRecord[]> =>
      (await store.listTurnResults(session))
        .flatMap((row) => row.runtimeResults as RuntimeResult[])
        .flatMap((result) => result.operations ?? [])
        .sort((a, b) => a.seq - b.seq);
    return { outcome, items, gold, persisted, execution };
  }

  it.each(["throw", "failure", "suspend"] as const)(
    "settles abandoned recursive operations when the parent ends with %s",
    async (ending) => {
      const session = `pg-abandoned-${ending}`;
      const parent = fn("shop", "parent", { stage: "pre-turn" });
      const child = fn("shop", "child", { trigger: { type: "manual" } });
      const narrator = fn("narrator", "story", {
        stage: "narrative",
        outputKind: "story",
      });
      const { outcome, items, gold, persisted, execution } = await run(
        session,
        [parent, child, narrator],
        {
          [parent.name]: async (ctx) => {
            await ctx.recursiveCall({
              manualTrigger: { runtimeId: child.name },
            });
            if (ending === "throw") throw new Error("Parent failed");
            if (ending === "failure")
              return { outcome: "failed", error: "Parent failed" };
            return {
              outcome: "suspended",
              reason: "Wait",
              resumeSchema: { type: "object" },
            };
          },
          [child.name]: async (ctx) => {
            await trade(ctx, "a", 5);
            await ctx.pluginData!.set("notes", "child", "must not commit");
            return { outcome: "success", value: {} };
          },
          [narrator.name]: async () => ({
            outcome: "success",
            value: { narrativeOutput: "The story continues." },
          }),
        },
        100,
      );
      expect(
        execution.commit.results.find(
          (result) => result.runtimeId === parent.name,
        )?.status,
      ).toBe("failed");
      expect(
        execution.commit.results.some(
          (result) => result.runtimeId === child.name,
        ),
      ).toBe(false);
      expect(outcome.status).toBe("committed");
      expect(outcome.operations).toMatchObject([
        { status: "discarded", reason: "caller-dropped" },
      ]);
      expect(
        (await persisted()).map((record) => [
          record.id,
          record.status,
          record.reason,
        ]),
      ).toEqual(
        outcome.operations.map((operation) => [
          operation.id,
          operation.status,
          operation.reason,
        ]),
      );
      expect(await items()).toEqual([]);
      expect(await gold()).toBe(100);
      expect(await store.listPluginData(session, "shop", "notes")).toEqual([]);
      expect(await store.listSuspensions(session)).toEqual([]);
    },
  );

  it("drops a story's conflicting operation whole and commits the others and the story", async () => {
    const narrator = fn("narrator", "story", {
      stage: "narrative",
      outputKind: "story",
    });
    const { outcome, items, gold, persisted } = await run(
      "pg-write-story",
      [narrator],
      {
        [narrator.name]: async (ctx) => {
          await trade(ctx, "a", 5);
          await trade(ctx, "b", 10);
          await trade(ctx, "c", 1);
          await ctx.pluginData!.set("notes", "told", "yes");
          return {
            outcome: "success",
            value: { narrativeOutput: "You shop." },
          };
        },
      },
      12,
    );
    expect(outcome.status).toBe("committed");
    expect(
      outcome.operations.map((op) => [op.status, op.reason ?? null]),
    ).toEqual([
      ["committed", null],
      ["failed", "conflict"],
      ["committed", null],
    ]);
    expect(await items()).toEqual(["a", "c"]);
    expect(await gold()).toBe(6);
    expect(
      (await store.getPluginData("pg-write-story", "narrator", "notes", "told"))
        ?.value,
    ).toBe("yes");
    expect(
      (await persisted()).map((record) => [
        record.id,
        record.status,
        record.reason ?? null,
      ]),
    ).toEqual(
      outcome.operations.map((op) => [op.id, op.status, op.reason ?? null]),
    );
  });

  it("drops an auxiliary caller whole when one of its operations conflicts", async () => {
    const narrator = fn("narrator", "story", {
      stage: "narrative",
      outputKind: "story",
    });
    const shop = fn("shop", "buy", { stage: "pre-turn" });
    const { outcome, items, gold, persisted, execution } = await run(
      "pg-write-aux",
      [narrator, shop],
      {
        [narrator.name]: async () => ({
          outcome: "success",
          value: { narrativeOutput: "You shop." },
        }),
        [shop.name]: async (ctx) => {
          await ctx.pluginData!.set("receipts", "r", "x");
          await trade(ctx, "a", 5);
          await trade(ctx, "b", 10);
          return { outcome: "success", value: {} };
        },
      },
      12,
    );
    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes).toEqual([
      expect.objectContaining({
        runtimeId: shop.name,
        runId: execution.commit.results.find(
          (result) => result.runtimeId === shop.name,
        )!.runId,
        cause: "rejected",
      }),
    ]);
    expect(
      outcome.operations.map((op) => [op.status, op.reason ?? null]),
    ).toEqual([
      ["discarded", "caller-dropped"],
      ["failed", "conflict"],
    ]);
    expect(await items()).toEqual([]);
    expect(await gold()).toBe(12);
    expect(
      await store.listPluginData("pg-write-aux", "shop", "receipts"),
    ).toEqual([]);
    expect((await persisted()).map((record) => record.status)).toEqual([
      "discarded",
      "failed",
    ]);
  });
  async function actorSession(id: string) {
    await store.createSession({
      id,
      status: "active",
      phase: "playing",
      locale: "en-US",
      activePlugins: PLUGINS,
      setupRuntimes: {},
      seats: [],
      completedPlayerTurns: 0,
      metadata: { orchestration: { maxSubagentCalls: 2 } },
      createdAt: AT,
      updatedAt: AT,
    });
    await store.upsertCharacter({
      id: `${id}-mara`,
      name: "Mara",
      sessionId: id,
      type: "npc",
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    });
  }
  const actor: RuntimeManifest = {
    name: "shop/actor",
    pluginId: "shop",
    description: "Character",
    runtimeType: "agent",
    outputKind: "system",
    trigger: { type: "manual" },
    subagentOnly: true,
    outputContract: "character-actor@1",
  };
  const actorAnswer = () => ({
    content: JSON.stringify({
      segments: [{ kind: "dialogue", text: "I will pay." }],
      intent: "PRIVATE-ACTOR-INTENT",
    }),
    toolCalls: [],
    finishReason: "stop" as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  });

  it("settles a rejected character operation independently of its committed story", async () => {
    const session = "actor-operation";
    await actorSession(session);
    await setGold(session, 10);
    const services = bankServices();
    services.register("bank", {
      name: "pay",
      contract: "actor.pay@1",
      access: "write",
      modelFacing: true,
      description: "Pay four coins",
      input: z.object({}),
      output: z.unknown(),
      handler: async (_input, ctx) => {
        await ctx.pluginData.update("wallet", "gold", [
          { op: "inc", path: "/amount", by: -4, min: 0 },
        ]);
        return { paid: 4 };
      },
    });
    const provider = {
      ...actor,
      tools: { services: [{ contract: "actor.pay@1", name: "pay" }] },
    };
    const main = fn("narrator", "story", {
      stage: "narrative",
      outputKind: "story",
    });
    let calls = 0;
    const toolExecutor = createToolExecutor({
      store,
      findTool: () => undefined,
    });
    try {
      const execution = await executeTurn(
        {
          sessionId: session,
          turnId: `${session}-turn`,
          playerMessage: "Pay",
          origin: "player",
        },
        [main, provider],
        {
          store,
          services,
          toolExecutor,
          llm: {
            generate: async () =>
              calls++ === 0
                ? {
                    content: null,
                    toolCalls: [
                      { id: "payment", name: "pay", arguments: "{}" },
                    ],
                    finishReason: "tool_calls",
                    usage: { inputTokens: 1, outputTokens: 1 },
                  }
                : actorAnswer(),
          },
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "Act",
            ...(manifest === main
              ? {
                  handler: async (ctx) => {
                    expect(
                      (
                        await ctx.agents!.run({
                          target: { contract: "character-actor@1" },
                          characterId: `${session}-mara`,
                          brief: "Pay four coins",
                        })
                      ).ok,
                    ).toBe(true);
                    return {
                      outcome: "success" as const,
                      value: { narrativeOutput: "The shop remains open." },
                    };
                  },
                }
              : {}),
          }),
        },
      );
      await setGold(session, 2);
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: `${session}-turn`, durationMs: 0 },
      });
      expect(outcome.status).toBe("committed");
      expect(outcome.operations).toMatchObject([{ status: "failed" }]);
      expect(
        (await store.getPluginData(session, "bank", "wallet", "gold"))?.value,
      ).toEqual({ amount: 2 });
      expect((await store.listMessages(session))[0]?.content).toBe(
        "The shop remains open.",
      );
      expect(
        JSON.stringify(await store.listTurnResults(session)),
      ).not.toContain("PRIVATE-ACTOR-INTENT");
    } finally {
      await toolExecutor.close();
    }
  });

  it("retains consumed delegation JSON across claimed resume and resuspension", async () => {
    const session = "actor-continuation";
    await actorSession(session);
    const main = fn("shop", "ask", { stage: "narrative" });
    let finish = false;
    let starts = 0;
    const accepted: boolean[] = [];
    const deps = (): ExecutionDeps => ({
      store,
      llm: {
        generate: async () => {
          starts++;
          return actorAnswer();
        },
      },
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: "Act",
        ...(manifest === main
          ? {
              handler: async (ctx) => {
                accepted.push(
                  (
                    await ctx.agents!.run({
                      target: { contract: "character-actor@1" },
                      characterId: `${session}-mara`,
                      brief: "Respond",
                    })
                  ).ok,
                );
                return finish
                  ? { outcome: "success" as const, value: {} }
                  : {
                      outcome: "suspended" as const,
                      reason: "Continue later",
                      resumeSchema: { type: "object" },
                    };
              },
            }
          : {}),
      }),
    });
    const first = await executeTurn(
      {
        sessionId: session,
        turnId: `${session}-turn`,
        playerMessage: "Ask",
        origin: "player",
      },
      [main, actor],
      deps(),
    );
    await commitExecution({
      store,
      execution: first,
      completion: { kind: "turn", turnId: `${session}-turn`, durationMs: 0 },
    });
    for (const final of [false, true]) {
      finish = final;
      const row = (await store.listSuspensions(session)).find(
        (record) => !record.resolvedAt,
      )!;
      expect(row.pendingContinuation.delegation?.calls).toBe(final ? 2 : 1);
      const claim = (await store.claimSuspension(row.id))!;
      const resumed = await resumeSuspendedRuntime(
        { ...row, resolvedAt: claim },
        {},
        main,
        deps(),
        { activeRuntimes: [main, actor] },
      );
      expect((await store.getSuspension(row.id))?.resolvedAt).toBe(claim);
      expect(
        (await store.getSuspension(row.id))?.pendingContinuation.delegation
          ?.calls,
      ).toBe(2);
      await commitExecution({
        store,
        execution: resumed,
        completion: {
          kind: "resume",
          turnId: row.turnId,
          suspensionId: row.id,
          pluginId: main.pluginId,
          runtimeId: main.name,
        },
      });
    }
    expect(accepted).toEqual([true, true, false]);
    expect(starts).toBe(2);
  });
});
