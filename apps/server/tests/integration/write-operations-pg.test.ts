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
});
