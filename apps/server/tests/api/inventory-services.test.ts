import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteStore } from "@covel/store/sqlite";
import type {
  ActionRequest,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  Proposal,
} from "@covel/shared";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";
import { runtimeResultsOf } from "../helpers/runtime-results.js";

const project = path.resolve(import.meta.dirname, "../../../..");
const sessionId = "inventory-session";
const client = vi.hoisted(() => ({ address: "" }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: client.address } }),
}));
const headers = {
  Authorization: "Bearer synthetic-inventory-token",
  "Content-Type": "application/json",
};
const textOf = (message: LLMMessage) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
const reply = (
  content: string | null,
  toolCalls: LLMResponse["toolCalls"] = [],
): LLMResponse => ({
  content,
  toolCalls,
  finishReason: toolCalls.length ? "tool_calls" : "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
});
const tool = (name: string, args: unknown) =>
  reply(null, [
    {
      id: `call-${name}`,
      name,
      arguments: JSON.stringify(args),
    },
  ]);
const exchange = {
  changes: [
    { op: "remove", item: "Gold coin", quantity: 10 },
    { op: "add", item: "Sword" },
  ],
};
interface Frame {
  type: string;
  turnId: string;
  payload: Record<string, unknown>;
}

describe("bundled inventory services through the action API", () => {
  let root: string;
  let boot: ApiBootstrapResult | undefined;
  let store: ReturnType<typeof createSqliteStore>;
  let narratorStep: number;
  let purchase: boolean;
  let refused: boolean;
  let foundTorch: boolean;
  let rejectLedger: boolean;
  let beforeProse: (() => Promise<void>) | undefined;
  const requests = new Map<string, Parameters<LLMAdapter["generate"]>[0][]>();
  const generate: LLMAdapter["generate"] = async (request) => {
    // The bundled extractor's terminal tool identifies its runtime request.
    const runtimeId = request.tools?.some(
      ({ name }) => name === "submit-world-facts",
    )
      ? "world-ir"
      : "narrator";
    requests.set(runtimeId, [...(requests.get(runtimeId) ?? []), request]);
    if (runtimeId === "world-ir") {
      const input = JSON.parse(
        textOf(request.messages.findLast(({ role }) => role === "user")!),
      ) as {
        characters: { id: string; type: string }[];
        operations?: unknown[];
      };
      const holder = input.characters.find(({ type }) => type === "player")!.id;
      if (purchase && !refused) {
        expect(input.operations).toEqual([
          expect.objectContaining({
            contract: "inventory.change@1",
            request: exchange,
          }),
        ]);
        return tool("submit-world-facts", {
          schemaVersion: 1,
          entities: [
            { id: "gold", type: "item", name: "Gold coin" },
            { id: "sword", type: "item", name: "Sword" },
            ...(foundTorch
              ? [{ id: "torch", type: "item", name: "Torch" }]
              : []),
          ],
          relations: [],
          statements: [],
          events: [
            {
              id: "pay-gold",
              type: "inventory_change",
              attributes: {
                item: "gold",
                holder,
                operation: "lose",
                quantity: 10,
              },
            },
            {
              id: "receive-sword",
              type: "inventory_change",
              attributes: {
                item: "sword",
                holder,
                operation: "gain",
                quantity: 1,
              },
            },
            ...(foundTorch
              ? [
                  {
                    id: "find-torch",
                    type: "inventory_change",
                    attributes: {
                      item: "torch",
                      holder,
                      operation: "gain",
                      quantity: 1,
                    },
                  },
                ]
              : []),
          ],
        });
      }
      expect(input.operations).toBeUndefined();
      return tool("submit-world-facts", {
        schemaVersion: 1,
        entities: [],
        relations: [],
        statements: [],
        events: [],
      });
    }
    if (purchase) {
      const step = narratorStep++;
      if (step === 0) {
        expect(request.tools?.map(({ name }) => name)).toEqual(
          expect.arrayContaining(["check-bag", "change-inventory"]),
        );
        return tool("check-bag", {});
      }
      const toolAnswers = request.messages
        .filter(({ role }) => role === "tool")
        .map(textOf);
      if (step === 1) {
        const bag = JSON.parse(toolAnswers.at(-1)!) as {
          data: { items: { name: string; quantity: number }[] };
        };
        expect(bag.data.items).toContainEqual(
          expect.objectContaining({
            name: "Gold coin",
            quantity: refused ? 5 : 12,
          }),
        );
        return tool("change-inventory", exchange);
      }
      if (refused) expect(toolAnswers.at(-1)).toContain('"code":"refused"');
      else
        expect(JSON.parse(toolAnswers.at(-1)!)).toMatchObject({
          staged: { count: 1 },
          data: { results: [{ quantity: 2 }, { quantity: 1 }] },
        });
      // Await a test-controlled write after staging, before returning prose.
      if (beforeProse) {
        const callback = beforeProse;
        beforeProse = undefined;
        await callback();
      }
    }
    return reply(
      JSON.stringify({
        segments: [
          {
            kind: "narration",
            text: purchase
              ? refused
                ? "You cannot afford the Sword. The merchant keeps it and waits."
                : `You pay 10 Gold coin and receive a Sword. ${foundTorch ? "You also find a Torch. " : ""}The merchant waits.`
              : "You look around the quiet shop. The merchant waits.",
          },
        ],
        cues: { present: ["Ren"] },
      }),
    );
  };

  beforeEach(async () => {
    client.address = crypto.randomUUID();
    root = await mkdtemp(path.join(tmpdir(), "inv-api-"));
    const builtin = path.join(root, "builtin");
    const user = path.join(root, "user");
    await mkdir(user);
    await mkdir(builtin);
    for (const id of ["narrator", "world-ir", "inventory"]) {
      await cp(path.join(project, "plugins", id), path.join(builtin, id), {
        recursive: true,
        filter: (source) => !source.includes("node_modules"),
      });
    }
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-inventory-token");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "en");
    requests.clear();
    narratorStep = 0;
    purchase = true;
    refused = false;
    foundTorch = false;
    rejectLedger = false;
    beforeProse = undefined;
    store = createSqliteStore(path.join(root, "session.sqlite"));
    const now = new Date().toISOString();
    await store.createSession({
      id: sessionId,
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      completedPlayerTurns: 0,
      activePlugins: ["narrator", "world-ir", "inventory"],
      locale: "en-US",
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertCharacterSchema({
      sessionId,
      version: 1,
      types: ["npc", "companion"],
      attributes: [],
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertCharacter({
      id: "player-ren",
      sessionId,
      name: "Ren",
      type: "player",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await seedGold(12);
    let guardRegistered = false;
    boot = await bootstrapApi({
      pluginsDir: builtin,
      pluginsDirs: [builtin, user],
      store,
      storeBackend: "sqlite",
      llmAdapter: { generate },
      perRequestMiddleware: [
        async (c, next) => {
          if (!guardRegistered) {
            const hooks = c.get("hookPipeline");
            if (!hooks) throw new Error("Missing hook pipeline");
            hooks.register<{ proposal: Proposal }>({
              id: "check-ledger",
              pluginId: "inventory",
              event: "PreStateCommit",
              handler: async (_ctx, { proposal }) =>
                rejectLedger &&
                proposal.source.runtimeId === "inventory/ledger" &&
                proposal.type === "plugin.data.update"
                  ? {
                      action: "abort",
                      reason: "The Torch change needs correction.",
                    }
                  : { action: "continue" },
            });
            guardRegistered = true;
          }
          await next();
        },
      ],
    });
  });
  afterEach(async () => {
    await closeTestApi(boot);
    boot = undefined;
    await store?.close();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function seedGold(quantity: number) {
    const now = new Date().toISOString();
    await store.setPluginData({
      id: "gold-row",
      sessionId,
      pluginId: "inventory",
      namespace: "items",
      key: "gold",
      value: {
        id: "gold",
        name: "Gold coin",
        quantity,
        tags: ["currency"],
        equipped: false,
      },
      createdAt: now,
      updatedAt: now,
    });
  }
  async function act(
    action: Pick<ActionRequest, "type" | "payload"> = {
      type: "submit_actions",
      payload: {
        actions: [
          {
            kind: "say",
            text: purchase ? "Buy the Sword for 10 Gold coin." : "Look around.",
          },
        ],
      },
    },
    failedRuntimeIds: readonly string[] = [],
  ) {
    const response = await boot!.app.request("/api/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId,
        ...action,
      }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Frame);
    expect(
      events.filter(({ type }) => type === "error.occurred"),
      body,
    ).toEqual([]);
    expect(
      events.find(({ type }) => type === "execution.completed")?.payload,
      body,
    ).toMatchObject({ committed: true });
    const last = (await store.listTurnResults(sessionId)).at(-1)!;
    expect(last.commitStatus, body).toBe("committed");
    const results = runtimeResultsOf(last);
    expect(
      results
        .filter(({ status }) => status === "failed")
        .map(({ runtimeId }) => runtimeId),
      body,
    ).toEqual(failedRuntimeIds);
    return {
      events,
      row: last,
      results,
      operations: results.flatMap((result) => result.operations ?? []),
    };
  }
  async function items() {
    return (await store.listPluginData(sessionId, "inventory", "items")).map(
      ({ value }) =>
        value as { name: string; quantity: number; removed?: boolean },
    );
  }

  it("commits one sword and one payment when extraction reports the same exchange", async () => {
    const { operations, results, events } = await act();
    const bag = await items();
    expect(bag.find(({ name }) => name === "Gold coin")?.quantity).toBe(2);
    expect(
      bag.filter(
        ({ name, quantity, removed }) =>
          name === "Sword" && quantity > 0 && !removed,
      ),
    ).toEqual([expect.objectContaining({ quantity: 1 })]);
    expect(operations).toEqual([
      expect.objectContaining({
        contract: "inventory.change@1",
        status: "committed",
      }),
    ]);
    expect(
      results.find(({ runtimeId }) => runtimeId === "inventory/ledger")?.output,
    ).toMatchObject({ alreadyApplied: 2, applied: 0 });
    expect(events.filter(({ type }) => type === "operation.failed")).toEqual(
      [],
    );
  });
  it("refuses an unaffordable purchase without an operation or a failure event", async () => {
    refused = true;
    await seedGold(5);
    const before = await items();
    const { operations, events } = await act();
    expect(await items()).toEqual(before);
    expect(operations).toEqual([]);
    expect(events.filter(({ type }) => type === "operation.failed")).toEqual(
      [],
    );
  });
  it.each(["retry_runtime", "retry_failed_runtimes"] as const)(
    "%s applies only the outstanding ledger change after a committed purchase",
    async (type) => {
      foundTorch = true;
      rejectLedger = true;
      const source = await act(undefined, ["inventory/ledger"]);
      expect(source.operations).toEqual([
        expect.objectContaining({ status: "committed" }),
      ]);
      expect(await items()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Gold coin", quantity: 2 }),
          expect.objectContaining({ name: "Sword", quantity: 1 }),
        ]),
      );
      expect((await items()).some(({ name }) => name === "Torch")).toBe(false);
      rejectLedger = false;
      requests.clear();
      const retry = await act({
        type,
        payload: {
          retryFromTurnId: source.row.turnId,
          ...(type === "retry_runtime"
            ? { runtimeId: "inventory/ledger" }
            : { runtimeIds: ["inventory/ledger"] }),
        },
      });
      expect(retry.results).toEqual([
        expect.objectContaining({
          runtimeId: "inventory/ledger",
          status: "success",
          output: expect.objectContaining({ alreadyApplied: 2, applied: 1 }),
        }),
      ]);
      expect(await items()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Gold coin", quantity: 2 }),
          expect.objectContaining({ name: "Sword", quantity: 1 }),
          expect.objectContaining({ name: "Torch", quantity: 1 }),
        ]),
      );
      expect(await items()).toHaveLength(3);
      expect(retry.operations).toEqual([]);
      expect(requests.size).toBe(0);
      expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(1);
    },
  );
  it.each(["en-US", "zh-CN"])(
    "persists service badges in both languages for a %s session",
    async (locale) => {
      await store.updateSession(sessionId, { locale });
      const { row } = await act();
      expect(
        (
          await store.getPluginData(
            sessionId,
            "inventory",
            "message",
            row.turnId,
          )
        )?.value,
      ).toMatchObject({
        changes: [
          { badge: { en: "Lost", zh: "失去" } },
          { badge: { en: "Gained", zh: "获得" } },
        ],
      });
    },
  );
  it("keeps the story after a concurrent stock conflict and tells the next turn what was not applied", async () => {
    // Panel actions share the execution lock; interleave a store write here.
    beforeProse = () => seedGold(0);
    const { operations, events, row } = await act(undefined, [
      "world-ir",
      "inventory/ledger",
    ]);
    expect(operations).toEqual([
      expect.objectContaining({ status: "failed", reason: "conflict" }),
    ]);
    expect(events.filter(({ type }) => type === "operation.failed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ count: 1 }),
      }),
    ]);
    const messages = await store.listTurnMessages(sessionId);
    expect(
      messages.some(
        (message) =>
          message.turnId === row.turnId &&
          message.role === "assistant" &&
          message.content.includes("receive a Sword"),
      ),
    ).toBe(true);
    expect(await items()).toEqual([
      expect.objectContaining({ name: "Gold coin", quantity: 0 }),
    ]);
    purchase = false;
    requests.clear();
    await act();
    const prompt = requests
      .get("narrator")![0]!
      .messages.map(textOf)
      .join("\n");
    const notice = prompt.match(
      /<operations-not-applied>([\s\S]*?)<\/operations-not-applied>/,
    )?.[1];
    expect(notice).toContain(operations[0]!.summary);
  });
  it("offers neither bag import when inventory is inactive and still commits the turn", async () => {
    await store.updateSession(sessionId, {
      activePlugins: ["narrator", "world-ir"],
    });
    purchase = false;
    const { operations } = await act();
    const tools =
      requests.get("narrator")![0]!.tools?.map(({ name }) => name) ?? [];
    expect(tools).not.toContain("check-bag");
    expect(tools).not.toContain("change-inventory");
    expect(operations).toEqual([]);
  });
});
