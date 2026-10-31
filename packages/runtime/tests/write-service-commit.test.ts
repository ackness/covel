/**
 * Write services at commit.
 *
 * A write-service call stages its provider's writes as one operation on the
 * calling run's result. The operation commits after its caller's unit: next
 * to a story each one stands or drops alone, inside an auxiliary unit a
 * rejected operation drops the unit, and without a story the execution is
 * all-or-nothing. Records of every operation persist on `turn_results`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DataStore, StoreTransaction } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import type {
  HandlerResult,
  JsonValue,
  OperationRecord,
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  classifyExecutionFaults,
  commitExecution,
  executeTurn,
} from "../src/index.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import type { ProviderDatasets } from "../src/operations/operation-stage.js";
import { canStageOperations } from "../src/turn-executor/turn-runtime-execution.js";

const SESSION = "session";
const timestamp = "2026-10-30T00:00:00.000Z";
const BACKENDS = [
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const;

const open: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((store) => store.close()));
});

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
const ok = (value: Record<string, JsonValue> = {}): HandlerResult => ({
  outcome: "success",
  value,
});
const story = (pluginId = "narrator") =>
  fn(pluginId, "story", { stage: "narrative", outputKind: "story" });

type Ctx = Parameters<FunctionHandler>[0];
const trade = (ctx: Ctx, item: string, cost: number) =>
  ctx.services!.call({
    pluginId: "bank",
    name: "trade",
    contract: "bank.trade@1",
    input: { item, cost },
  });
const peek = (ctx: Ctx) =>
  ctx.services!.call({
    pluginId: "bank",
    name: "peek",
    contract: "bank.peek@1",
    input: {},
  });

interface Scenario {
  readonly runtimes: readonly RuntimeManifest[];
  readonly handlers: Record<string, FunctionHandler>;
  readonly create?: () => DataStore;
  /** The bank's gold before the execution. */
  readonly gold?: number;
  /** Runs between the execution and its commit, like a concurrent commit. */
  readonly beforeCommit?: (store: DataStore) => Promise<void>;
  readonly proposalGuard?: (proposal: Proposal) => string | undefined;
  /** A PreStateCommit hook refuses proposals for which this returns true. */
  readonly veto?: (proposal: Proposal) => boolean;
  readonly input?: Partial<TurnInput>;
  readonly datasets?: ProviderDatasets;
  readonly withoutSavepoints?: boolean;
  readonly abortReason?: string;
}

async function run(scenario: Scenario) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = (scenario.create ?? createMemoryStore)();
  open.push(store);
  const plugins = new Set([
    "bank",
    "guard",
    ...scenario.runtimes.map((runtime) => runtime.pluginId),
  ]);
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [...plugins],
    completedPlayerTurns: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const setGold = async (amount: number) =>
    store.setPluginData({
      id: `${SESSION}:bank:wallet:gold`,
      sessionId: SESSION,
      pluginId: "bank",
      namespace: "wallet",
      key: "gold",
      value: { amount },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  await setGold(scenario.gold ?? 100);
  const registry = new PluginServiceRegistry({
    list: async () => [...plugins],
    ensure: async (_sessionId, pluginId) => {
      if (!plugins.has(pluginId)) throw new Error("Not active");
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
      return { item, gold: await ctx.pluginData.get("wallet", "gold") };
    },
  });
  registry.register("bank", {
    name: "peek",
    contract: "bank.peek@1",
    input: z.unknown(),
    output: z.unknown(),
    handler: async (_input, ctx) => ctx.pluginData.get("wallet", "gold"),
  });
  const hookPipeline = createHookPipeline();
  if (scenario.veto)
    hookPipeline.register<{ proposal: Proposal }>({
      id: "veto",
      pluginId: "guard",
      event: "PreStateCommit",
      handler: async (_ctx, payload) =>
        scenario.veto!(payload.proposal)
          ? { action: "abort", reason: "vetoed" }
          : { action: "continue" },
    });
  const input: TurnInput = {
    sessionId: SESSION,
    turnId: "turn",
    logicalTurnId: "logical-turn",
    playerMessage: "Buy",
    origin: "player",
    ...scenario.input,
  };
  const execution = await executeTurn(input, scenario.runtimes, {
    store,
    services: registry,
    hookPipeline,
    hookScope: { activePluginIds: plugins },
    llm: { generate: vi.fn() } as never,
    ...("datasets" in scenario
      ? {
          loadPluginDatasets: async (pluginId: string) =>
            pluginId === "bank" ? scenario.datasets : undefined,
        }
      : {}),
    loadRuntime: async (runtime) => ({
      manifest: runtime,
      promptTemplate: "",
      handler: scenario.handlers[runtime.name],
    }),
  });
  await scenario.beforeCommit?.(store);
  if (scenario.withoutSavepoints) {
    const withTransaction = store.withTransaction.bind(store);
    store.withTransaction = (body) =>
      withTransaction((tx) =>
        body(
          new Proxy(tx, {
            get: (target, property) => {
              if (property === "savepoint") return undefined;
              const value = Reflect.get(target, property) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as StoreTransaction,
        ),
      ) as never;
  }
  const outcome = await commitExecution({
    store,
    execution: scenario.abortReason
      ? {
          ...execution,
          commit: { ...execution.commit, abortReason: scenario.abortReason },
        }
      : execution,
    hookPipeline,
    completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    ...(scenario.proposalGuard
      ? { proposalGuard: scenario.proposalGuard }
      : {}),
  });
  const results = execution.commit.results as readonly RuntimeResult[];
  const resultOf = (runtimeId: string) =>
    results.find((result) => result.runtimeId === runtimeId)!;
  const items = async () =>
    (await store.listPluginData(SESSION, "bank", "items"))
      .map((row) => row.key)
      .sort();
  const gold = async () =>
    (
      (await store.getPluginData(SESSION, "bank", "wallet", "gold"))?.value as
        { amount: number } | undefined
    )?.amount;
  const persisted = async (): Promise<OperationRecord[]> =>
    (await store.listTurnResults(SESSION))
      .flatMap((row) => row.runtimeResults as RuntimeResult[])
      .flatMap((result) => result.operations ?? [])
      .sort((a, b) => a.seq - b.seq);
  const kept = async () =>
    (
      await store.queryTraceEvents(SESSION, {
        types: ["read-dependency.kept"],
      })
    ).map((event) => event.payload);
  return {
    store,
    execution,
    outcome,
    results,
    resultOf,
    items,
    gold,
    persisted,
    kept,
  };
}

const settled = (operations: readonly { status: string; reason?: string }[]) =>
  operations.map((operation) =>
    operation.reason
      ? `${operation.status}/${operation.reason}`
      : operation.status,
  );

/** A story that buys three items and keeps a note of its own. */
const buyThree = (narrator = story()) => ({
  runtimes: [narrator],
  handlers: {
    [narrator.name]: async (ctx: Ctx) => {
      await trade(ctx, "a", 5);
      await trade(ctx, "b", 10);
      await trade(ctx, "c", 1);
      await ctx.pluginData!.set("notes", "told", "yes");
      return ok({ narrativeOutput: "You shop." });
    },
  },
});

for (const [backend, create] of BACKENDS) {
  describe(`write-service operations at commit: ${backend}`, () => {
    it("commits a story's operations after its writes, dropping a conflicting one whole", async () => {
      const { outcome, items, gold, persisted, store, results } = await run({
        ...buyThree(),
        create,
        // Another commit spent most of the gold meanwhile.
        beforeCommit: async (store) => {
          await store.setPluginData({
            id: `${SESSION}:bank:wallet:gold`,
            sessionId: SESSION,
            pluginId: "bank",
            namespace: "wallet",
            key: "gold",
            value: { amount: 12 },
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        },
      });
      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes ?? []).toEqual([]);
      expect(settled(outcome.operations)).toEqual([
        "committed",
        "failed/conflict",
        "committed",
      ]);
      // The second operation's item write went with its payment.
      expect(await items()).toEqual(["a", "c"]);
      expect(await gold()).toBe(6);
      expect(
        (await store.getPluginData(SESSION, "narrator", "notes", "told"))
          ?.value,
      ).toBe("yes");
      expect(await store.listMessages(SESSION)).not.toHaveLength(0);
      expect(outcome.failedProposals).toEqual([
        expect.objectContaining({ code: "conflict" }),
      ]);
      // A conflict counts against no one.
      expect(classifyExecutionFaults(results, outcome).get("bank")).not.toEqual(
        expect.objectContaining({ kind: "fault" }),
      );
      // Saved records match the outcome.
      const saved = await persisted();
      expect(
        saved.map((record) => [record.id, record.status, record.reason]),
      ).toEqual(
        outcome.operations.map((operation) => [
          operation.id,
          operation.status,
          operation.reason,
        ]),
      );
      expect(saved.map((record) => record.contract)).toEqual(
        Array(3).fill("bank.trade@1"),
      );
    });

    it("drops a vetoed story-attached operation alone", async () => {
      const { outcome, items, gold } = await run({
        ...buyThree(),
        create,
        veto: (proposal) => (proposal.payload as { key?: string }).key === "b",
      });
      expect(outcome.status).toBe("committed");
      expect(settled(outcome.operations)).toEqual([
        "committed",
        "failed/rejected",
        "committed",
      ]);
      expect(await items()).toEqual(["a", "c"]);
      expect(await gold()).toBe(94);
    });

    it("drops an auxiliary caller with its writes and all its operations when one is rejected", async () => {
      const narrator = story();
      const shop = fn("shop", "buy", { stage: "pre-turn" });
      const { outcome, items, gold, store, resultOf } = await run({
        runtimes: [narrator, shop],
        create,
        handlers: {
          [narrator.name]: async () => ok({ narrativeOutput: "You shop." }),
          [shop.name]: async (ctx) => {
            await ctx.pluginData!.set("receipts", "r", "kept?");
            await trade(ctx, "a", 5);
            await trade(ctx, "b", 10);
            return ok();
          },
        },
        proposalGuard: (proposal) =>
          (proposal.payload as { key?: string }).key === "b"
            ? "b refused"
            : undefined,
      });
      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes).toEqual([
        expect.objectContaining({
          runtimeId: shop.name,
          runId: resultOf(shop.name).runId,
          cause: "rejected",
        }),
      ]);
      expect(settled(outcome.operations)).toEqual([
        "discarded/caller-dropped",
        "failed/rejected",
      ]);
      expect(await items()).toEqual([]);
      expect(await gold()).toBe(100);
      expect(await store.listPluginData(SESSION, "shop", "receipts")).toEqual(
        [],
      );
    });

    it("rolls everything back when an operation is rejected without a story", async () => {
      const shop = fn("shop", "buy");
      const { outcome, items, gold, persisted } = await run({
        runtimes: [shop],
        create,
        input: { origin: "manual" },
        handlers: {
          [shop.name]: async (ctx) => {
            await trade(ctx, "a", 5);
            await trade(ctx, "b", 500);
            return ok();
          },
        },
        // The second payment no longer fits.
        beforeCommit: async (store) => {
          await store.setPluginData({
            id: `${SESSION}:bank:wallet:gold`,
            sessionId: SESSION,
            pluginId: "bank",
            namespace: "wallet",
            key: "gold",
            value: { amount: 100 },
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        },
        gold: 1000,
      });
      expect(outcome.status).toBe("failed");
      expect(outcome.failedProposals).toEqual([
        expect.objectContaining({ code: "conflict" }),
      ]);
      expect(settled(outcome.operations)).toEqual([
        "discarded/execution-failed",
        "discarded/execution-failed",
      ]);
      expect(settled(await persisted())).toEqual(settled(outcome.operations));
      expect(await items()).toEqual([]);
      expect(await gold()).toBe(100);
    });

    it("does not attempt a story's operations when the store cannot isolate them", async () => {
      const { outcome, items, gold } = await run({
        ...buyThree(),
        create,
        withoutSavepoints: true,
      });
      expect(outcome.status).toBe("committed");
      expect(settled(outcome.operations)).toEqual(
        Array(3).fill("failed/store-unsupported"),
      );
      expect(await items()).toEqual([]);
      expect(await gold()).toBe(100);
    });

    it("leaves records discarded when the execution rolls back", async () => {
      const { outcome, persisted, items } = await run({
        ...buyThree(),
        create,
        abortReason: "stopped",
      });
      expect(outcome.status).toBe("failed");
      expect(settled(await persisted())).toEqual(
        Array(3).fill("discarded/execution-failed"),
      );
      expect(await items()).toEqual([]);
    });

    it("keeps model-facing records without IDs or times", async () => {
      const { persisted } = await run({ ...buyThree(), create });
      for (const record of await persisted()) {
        const text = JSON.stringify([
          record.summary,
          record.request,
          record.result,
        ]);
        expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
        expect(text).not.toContain(timestamp.slice(0, 10));
        expect(record.invokedBy).toEqual({
          pluginId: "narrator",
          runtimeId: "narrator/story",
        });
      }
    });
  });
}

describe("readers of operation writes", () => {
  it("lets the provider's later runtime read the staged value and depend on the operation; its read service records nothing", async () => {
    const narrator = story();
    const ledger = fn("bank", "ledger");
    let seenByService: unknown;
    let seenByRuntime: unknown;
    const { outcome, execution, resultOf } = await run({
      runtimes: [narrator, ledger],
      handlers: {
        [narrator.name]: async (ctx) => {
          await trade(ctx, "a", 5);
          seenByService = await peek(ctx);
          return ok({ narrativeOutput: "You shop." });
        },
        [ledger.name]: async (ctx) => {
          seenByRuntime = await ctx.pluginData!.get("wallet", "gold");
          return ok();
        },
      },
    });
    expect(seenByService).toEqual({ amount: 95 });
    expect(seenByRuntime).toEqual({ amount: 95 });
    const [operation] = outcome.operations;
    const dependencies = execution.commit.readDependencies ?? {};
    expect(dependencies[resultOf(ledger.name).runId]).toEqual([operation!.id]);
    expect(dependencies[resultOf(narrator.name).runId] ?? []).toEqual([]);
  });

  it("drops an auxiliary reader of a story-attached operation that failed", async () => {
    const narrator = story();
    const ledger = fn("bank", "ledger");
    const { outcome, resultOf, store } = await run({
      runtimes: [narrator, ledger],
      handlers: {
        [narrator.name]: async (ctx) => {
          await trade(ctx, "a", 5);
          return ok({ narrativeOutput: "You shop." });
        },
        [ledger.name]: async (ctx) => {
          const gold = (await ctx.pluginData!.get("wallet", "gold")) as {
            amount: number;
          };
          await ctx.pluginData!.set("log", "last", gold.amount);
          return ok();
        },
      },
      veto: (proposal) => (proposal.payload as { key?: string }).key === "a",
    });
    expect(outcome.status).toBe("committed");
    expect(settled(outcome.operations)).toEqual(["failed/rejected"]);
    expect(outcome.isolatedRuntimes).toEqual([
      {
        runtimeId: ledger.name,
        runId: resultOf(ledger.name).runId,
        cause: "read",
        error: "read data of bank.trade@1 that did not commit",
      },
    ]);
    expect(await store.listPluginData(SESSION, "bank", "log")).toEqual([]);
  });

  it("commits a story that read a dropped auxiliary operation and traces it", async () => {
    const shop = fn("shop", "buy", { stage: "pre-turn" });
    const teller = story("bank");
    const { outcome, kept, resultOf } = await run({
      runtimes: [shop, teller],
      handlers: {
        [shop.name]: async (ctx) => {
          await trade(ctx, "a", 5);
          await ctx.pluginData!.set("receipts", "r", "x");
          return ok();
        },
        [teller.name]: async (ctx) => {
          const gold = (await ctx.pluginData!.get("wallet", "gold")) as {
            amount: number;
          };
          return ok({ narrativeOutput: `You have ${gold.amount} gold.` });
        },
      },
      proposalGuard: (proposal) =>
        (proposal.payload as { key?: string }).key === "r"
          ? "receipt refused"
          : undefined,
    });
    expect(outcome.status).toBe("committed");
    expect(settled(outcome.operations)).toEqual(["discarded/caller-dropped"]);
    expect(await kept()).toEqual([
      {
        runtimeId: teller.name,
        runId: resultOf(teller.name).runId,
        producerOperationId: outcome.operations[0]!.id,
        producerContract: "bank.trade@1",
        reason: "read data of bank.trade@1 that did not commit",
      },
    ]);
  });
});

describe("provider datasets", () => {
  const datasets: ProviderDatasets = {
    datasets: { wallet: { namespace: "wallet", ops: ["inc", "set"] } },
    schemas: {
      wallet: {
        type: "object",
        properties: { amount: { type: "integer", minimum: 0 } },
        required: ["amount"],
      },
    },
  };
  // `items` is not a dataset; only the wallet is checked.
  const shop = fn("shop", "buy");

  it("checks a runtime-less provider's dataset writes in a manual run", async () => {
    const { outcome, gold } = await run({
      runtimes: [shop],
      input: { origin: "manual" },
      datasets,
      handlers: {
        [shop.name]: async (ctx) => {
          await trade(ctx, "a", 5);
          return ok();
        },
      },
    });
    expect(outcome.status).toBe("committed");
    expect(await gold()).toBe(95);
  });

  it("rejects an operation write that breaks the provider's schema", async () => {
    const { outcome, gold } = await run({
      runtimes: [shop],
      input: { origin: "manual" },
      datasets: {
        ...datasets,
        schemas: {
          wallet: {
            type: "object",
            properties: { amount: { type: "integer", minimum: 99 } },
          },
        },
      },
      handlers: {
        [shop.name]: async (ctx) => {
          await trade(ctx, "a", 5);
          return ok();
        },
      },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failedProposals).toEqual([
      expect.objectContaining({ code: "dataset-violation" }),
    ]);
    expect(await gold()).toBe(100);
  });

  it("fails the call before the handler when the provider's datasets cannot be loaded", async () => {
    let answer: unknown;
    const { outcome, items } = await run({
      runtimes: [shop],
      input: { origin: "manual" },
      datasets: undefined,
      handlers: {
        [shop.name]: async (ctx) => {
          answer = await trade(ctx, "a", 5).catch((error: unknown) => error);
          return ok();
        },
      },
      create: createMemoryStore,
    });
    expect(outcome.status).toBe("committed");
    expect(answer).toMatchObject({
      code: "unavailable",
      message:
        "The write service is unavailable: its plugin's data rules could not be loaded.",
    });
    expect(outcome.operations).toEqual([]);
    expect(await items()).toEqual([]);
  });
});

describe("where write services cannot be called", () => {
  it("fails a function run that suspends after staging an operation", async () => {
    const shop = fn("shop", "buy");
    const { resultOf, outcome, items } = await run({
      runtimes: [shop],
      input: { origin: "manual" },
      handlers: {
        [shop.name]: async (ctx) => {
          await trade(ctx, "a", 5);
          return {
            outcome: "suspended",
            reason: "Need confirmation",
            resumeSchema: { type: "object" },
          };
        },
      },
    });
    expect(resultOf(shop.name)).toMatchObject({
      status: "failed",
      error:
        "shop/buy cannot suspend after changing another plugin's data through a write service",
    });
    expect(resultOf(shop.name).operations?.map((op) => op.status)).toEqual([
      "discarded",
    ]);
    expect(settled(outcome.operations)).toEqual(["discarded/caller-dropped"]);
    expect(await items()).toEqual([]);
  });

  it("answers unavailable in a scoped retry", async () => {
    const shop = fn("shop", "buy");
    let answer: unknown;
    const { items } = await run({
      runtimes: [shop],
      input: {
        origin: "manual",
        manualTrigger: { runtimeId: shop.name, sourceTurnId: "older-turn" },
      },
      handlers: {
        [shop.name]: async (ctx) => {
          answer = await trade(ctx, "a", 5).catch((error: unknown) => error);
          return ok();
        },
      },
    });
    expect((answer as { code?: string }).code).toBe("unavailable");
    expect((answer as Error).message).toBe(
      "Write services cannot be called here.",
    );
    expect(await items()).toEqual([]);
  });

  it("gives no stage to detached, background or resumed runs, or to agents that can suspend", () => {
    const manifest = fn("shop", "buy");
    const input = {
      sessionId: SESSION,
      turnId: "turn",
      playerMessage: "",
      origin: "player",
    } as TurnInput;
    const context = (origin: string) =>
      ({
        executionId: "x",
        origin,
        countPolicy: "none",
      }) as never;
    const live = { detached: false };
    expect(canStageOperations(manifest, input, context("player"), live)).toBe(
      true,
    );
    expect(
      canStageOperations(manifest, input, context("player"), {
        detached: true,
      }),
    ).toBe(false);
    for (const origin of ["background", "resume"])
      expect(canStageOperations(manifest, input, context(origin), live)).toBe(
        false,
      );
    expect(
      canStageOperations(
        {
          ...manifest,
          runtimeType: "agent",
          tools: { builtin: ["suspend"] },
        } as RuntimeManifest,
        input,
        context("player"),
        live,
      ),
    ).toBe(false);
  });
});
