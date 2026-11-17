/**
 * A batch recovery whose targets each pay an item cost the source turn's
 * inventory ledger already took from the prose: every target claims its
 * share of the credit, and the batch commits, through the real action route,
 * executor, commit and store.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeResult } from "@covel/shared";
import { createSqliteStore } from "@covel/store/sqlite";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const project = path.resolve(import.meta.dirname, "../../../..");
const sessionId = "claims-session";
const sourceTurnId = "source-turn";
const costs = ["cost-probe/first", "cost-probe/second"];

/** Two cost runtimes that each remove the item their plan names. */
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
  const item = (await ctx.store.getPluginData("plan", ctx.runtimeId))?.value;
  const answer = await ctx.services.call({
    pluginId: "inventory",
    name: "change",
    contract: "inventory.change@1",
    input: { changes: [{ op: "remove", item, quantity: 1 }] },
  });
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

  beforeEach(async () => {
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

  it.each([
    {
      name: "different items",
      plan: ["Chalk", "Rope"],
      credit: { chalk: 1, rope: 1 },
    },
    {
      name: "one item's credit",
      plan: ["Chalk", "Chalk"],
      credit: { chalk: 2 },
    },
  ])("lets every target claim its part of $name", async ({ plan, credit }) => {
    for (const name of ["Chalk", "Rope"])
      await setData("inventory", "items", name.toLowerCase(), {
        id: name.toLowerCase(),
        name,
        quantity: 1,
      });
    // The source turn's ledger took these from the prose.
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

    const response = await boot!.app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "retry_failed_runtimes",
        sessionId,
        requestId: "batch",
        payload: { runtimeIds: costs, retryFromTurnId: sourceTurnId },
      }),
    });
    const stream = await response.text();
    expect(response.status, stream).toBe(200);

    const attempt = (await store.listTurnResults(sessionId)).at(-1)!;
    expect(attempt.retryScope?.sourceTurnId).toBe(sourceTurnId);
    expect(attempt.commitStatus).toBe("committed");
    expect(
      (attempt.runtimeResults as RuntimeResult[]).map(
        ({ runtimeId, status, output }) => ({
          runtimeId,
          status,
          output,
        }),
      ),
    ).toEqual(
      costs.map((runtimeId, index) => ({
        runtimeId,
        status: "success",
        output: {
          results: [{ op: "remove", item: plan[index], status: "skipped" }],
        },
      })),
    );
    // Both costs were already paid; the bag is untouched and the credit used.
    for (const name of ["Chalk", "Rope"])
      expect(
        (
          await store.getPluginData(
            sessionId,
            "inventory",
            "items",
            name.toLowerCase(),
          )
        )?.value,
      ).toMatchObject({ quantity: 1 });
    for (const item of Object.keys(credit))
      expect(
        (
          await store.getPluginData(
            sessionId,
            "inventory",
            "prose-losses",
            `${sourceTurnId}/${item}`,
          )
        )?.value,
      ).toBe(0);
  });
});
