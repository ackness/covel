/**
 * Batch recoveries whose targets each pay an item cost the source turn's
 * inventory ledger may already have taken from the prose, through the real
 * action route, executor, commit and store: targets claim their share of the
 * credit together, a claim beyond the credit rolls the batch back, and a
 * claim leaves with its target's operation when that target fails.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Proposal, RuntimeResult } from "@covel/shared";
import { createSqliteStore } from "@covel/store/sqlite";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const project = path.resolve(import.meta.dirname, "../../../..");
const sessionId = "claims-session";
const sourceTurnId = "source-turn";
const costs = ["cost-probe/first", "cost-probe/second"] as const;

/**
 * Two cost runtimes. Each removes the item its plan names, records that it
 * paid in its own data, and fails after paying when its plan says so.
 */
async function writeCostPlugin(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "cost-probe", type: "module" }),
  );
  await writeFile(
    path.join(dir, "PLUGIN.md"),
    `---
id: cost-probe
kind: plugin
description: Pays item costs through the inventory
version: 1.0.0
---
`,
  );
  await writeFile(
    path.join(dir, "pay.js"),
    `export default async (ctx) => {
  const plan = (await ctx.store.getPluginData("plan", ctx.runtimeId))?.value;
  const answer = await ctx.services.call({
    pluginId: "inventory",
    name: "change",
    contract: "inventory.change@1",
    input: { changes: [{ op: "remove", item: plan.item, quantity: 1 }] },
  });
  if (plan.fail) throw new Error("Failed after paying");
  await ctx.pluginData.set("paid", ctx.runtimeId, true);
  return { outcome: "success", value: answer };
};
`,
  );
  for (const id of ["first", "second"]) {
    await mkdir(path.join(dir, "runtimes", id), { recursive: true });
    await writeFile(
      path.join(dir, "runtimes", id, "RUNTIME.md"),
      `---
description: Pays one item cost
schedule:
  stage: post-turn
  trigger:
    type: auto
function:
  handler: ../../pay.js
---
`,
    );
  }
}

describe("prose-loss credit in a batch recovery", () => {
  let root: string;
  let boot: ApiBootstrapResult | undefined;
  let store: ReturnType<typeof createSqliteStore>;
  /** A cost runtime whose own proposals the commit guard refuses. */
  let refuse: string | undefined;

  beforeEach(async () => {
    refuse = undefined;
    root = await mkdtemp(path.join(tmpdir(), "covel-claims-"));
    const plugins = path.join(root, "plugins");
    await cp(
      path.join(project, "plugins", "inventory"),
      path.join(plugins, "inventory"),
      {
        recursive: true,
        filter: (source) => !source.includes("node_modules"),
      },
    );
    await writeCostPlugin(path.join(plugins, "cost-probe"));
    store = createSqliteStore(path.join(root, "session.sqlite"));
    const now = new Date().toISOString();
    await store.createSession({
      id: sessionId,
      status: "active",
      phase: "playing",
      locale: "en-US",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: ["inventory", "cost-probe"],
      metadata: {
        approvalScopeNonce: "approval",
        sessionIncarnationNonce: "incarnation",
      },
      createdAt: now,
      updatedAt: now,
    });
    let hookRegistered = false;
    boot = await bootstrapApi({
      pluginsDir: plugins,
      covelHome: path.join(root, "home"),
      worldsDirs: [],
      store,
      storeBackend: "sqlite",
      llmAdapter: {
        generate: async () => {
          throw new Error("unexpected model call");
        },
      },
      perRequestMiddleware: [
        async (context, next) => {
          if (!hookRegistered) {
            const hooks = context.get("hookPipeline");
            if (!hooks) throw new Error("Missing hook pipeline");
            hooks.register<{ proposal: Proposal }>({
              id: "refuse-cost",
              pluginId: "cost-probe",
              event: "PreStateCommit",
              handler: async (_context, { proposal }) =>
                proposal.source.runtimeId === refuse
                  ? { action: "abort", reason: "Temporary cost failure" }
                  : { action: "continue" },
            });
            hookRegistered = true;
          }
          await next();
        },
      ],
    });
  });

  afterEach(async () => {
    await closeTestApi(boot);
    boot = undefined;
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  async function setData(
    pluginId: string,
    namespace: string,
    key: string,
    value: unknown,
  ) {
    const now = new Date().toISOString();
    await store.setPluginData({
      id: `${namespace}-${key}`,
      sessionId,
      pluginId,
      namespace,
      key,
      value: value as never,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * A committed source turn whose two cost runtimes failed, a bag of one
   * Chalk and one Rope, the credit the source's ledger left, and the item
   * each cost runtime removes.
   */
  async function failedCosts(
    credit: Readonly<Record<string, number>>,
    plan: readonly { item: string; fail?: boolean }[],
  ) {
    for (const name of ["Chalk", "Rope"])
      await setData("inventory", "items", name.toLowerCase(), {
        id: name.toLowerCase(),
        name,
        quantity: 1,
      });
    for (const [item, quantity] of Object.entries(credit))
      await setData(
        "inventory",
        "prose-losses",
        `${sourceTurnId}/${item}`,
        quantity,
      );
    for (const [index, runtimeId] of costs.entries())
      await setData("cost-probe", "plan", runtimeId, plan[index]);
    await store.saveTurnResult({
      id: sourceTurnId,
      sessionId,
      turnId: sourceTurnId,
      origin: "player",
      commitStatus: "committed",
      runtimeResults: costs.map((runtimeId): RuntimeResult => ({
        pluginId: "cost-probe",
        runtimeId,
        runId: `source-${runtimeId}`,
        turnId: sourceTurnId,
        status: "failed",
        output: null,
        toolCalls: [],
        durationMs: 1,
        timestamp: "2026-11-17T00:00:00.000Z",
      })),
      durationMs: 1,
      createdAt: "2026-11-17T00:00:00.000Z",
    });
  }

  /** Recover `runtimeIds`; returns the attempt's committed state and results. */
  async function recover(runtimeIds: readonly string[]) {
    const response = await boot!.app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "retry_failed_runtimes",
        sessionId,
        requestId: crypto.randomUUID(),
        payload: { runtimeIds, retryFromTurnId: sourceTurnId },
      }),
    });
    const stream = await response.text();
    expect(response.status, stream).toBe(200);
    expect(stream).not.toContain("retry_target_not_failed");
    const attempt = (await store.listTurnResults(sessionId)).at(-1)!;
    expect(attempt.retryScope).toMatchObject({ sourceTurnId, recovery: true });
    return {
      commitStatus: attempt.commitStatus,
      results: (attempt.runtimeResults as RuntimeResult[]).map(
        ({ runtimeId, status, output }) => ({ runtimeId, status, output }),
      ),
    };
  }

  async function value(pluginId: string, namespace: string, key: string) {
    return (await store.getPluginData(sessionId, pluginId, namespace, key))
      ?.value;
  }

  async function quantities() {
    return {
      Chalk: (
        (await value("inventory", "items", "chalk")) as { quantity: number }
      ).quantity,
      Rope: (
        (await value("inventory", "items", "rope")) as { quantity: number }
      ).quantity,
    };
  }

  const credit = (item: string) =>
    value("inventory", "prose-losses", `${sourceTurnId}/${item}`);

  const skipped = (item: string) => ({
    results: [{ op: "remove", item, status: "skipped" }],
  });

  it.each<{
    name: string;
    plan: readonly string[];
    given: Readonly<Record<string, number>>;
  }>([
    {
      name: "different items",
      plan: ["Chalk", "Rope"],
      given: { chalk: 1, rope: 1 },
    },
    {
      name: "one item's credit",
      plan: ["Chalk", "Chalk"],
      given: { chalk: 2 },
    },
  ])("lets every target claim its part of $name", async ({ plan, given }) => {
    await failedCosts(
      given,
      plan.map((item) => ({ item })),
    );

    expect(await recover(costs)).toEqual({
      commitStatus: "committed",
      results: costs.map((runtimeId, index) => ({
        runtimeId,
        status: "success",
        output: skipped(plan[index]!),
      })),
    });
    // Both costs were already paid; the bag is untouched and the credit used.
    expect(await quantities()).toEqual({ Chalk: 1, Rope: 1 });
    for (const item of Object.keys(given)) expect(await credit(item)).toBe(0);
  });

  it("rolls the batch back when two targets claim the last unit, then pays one from the bag", async () => {
    await failedCosts({ chalk: 1 }, [{ item: "Chalk" }, { item: "Chalk" }]);

    // Both claims fit what each saw, but not together: the second is refused
    // at commit, and a recovery without a story commits all or nothing.
    expect((await recover(costs)).commitStatus).toBe("failed");
    expect(await credit("chalk")).toBe(1);
    expect(await quantities()).toEqual({ Chalk: 1, Rope: 1 });

    expect((await recover([costs[0]])).results).toEqual([
      { runtimeId: costs[0], status: "success", output: skipped("Chalk") },
    ]);
    expect((await recover([costs[1]])).results).toEqual([
      {
        runtimeId: costs[1],
        status: "success",
        output: { results: [expect.objectContaining({ status: "removed" })] },
      },
    ]);
    expect(await credit("chalk")).toBe(0);
    expect(await quantities()).toEqual({ Chalk: 0, Rope: 1 });
  });

  it("withdraws the claim of a target that fails after paying", async () => {
    await failedCosts({ chalk: 1 }, [
      { item: "Chalk" },
      { item: "Chalk", fail: true },
    ]);

    const batch = await recover(costs);
    expect(batch.commitStatus).toBe("committed");
    expect(batch.results.map(({ status }) => status)).toEqual([
      "success",
      "failed",
    ]);
    // The first target's claim committed; the failed one's left with it.
    expect(await credit("chalk")).toBe(0);
    expect(await quantities()).toEqual({ Chalk: 1, Rope: 1 });

    await setData("cost-probe", "plan", costs[1], { item: "Chalk" });
    expect((await recover([costs[1]])).results).toEqual([
      {
        runtimeId: costs[1],
        status: "success",
        output: { results: [expect.objectContaining({ status: "removed" })] },
      },
    ]);
    expect(await quantities()).toEqual({ Chalk: 0, Rope: 1 });
  });

  it("withdraws every claim of a batch whose commit is refused, then recovers each", async () => {
    await failedCosts({ chalk: 2 }, [{ item: "Chalk" }, { item: "Chalk" }]);

    refuse = costs[1];
    expect((await recover(costs)).commitStatus).toBe("failed");
    expect(await credit("chalk")).toBe(2);
    expect(await value("cost-probe", "paid", costs[0])).toBeUndefined();

    refuse = undefined;
    for (const runtimeId of costs)
      expect((await recover([runtimeId])).results).toEqual([
        { runtimeId, status: "success", output: skipped("Chalk") },
      ]);
    expect(await credit("chalk")).toBe(0);
    expect(await quantities()).toEqual({ Chalk: 1, Rope: 1 });
  });
});
