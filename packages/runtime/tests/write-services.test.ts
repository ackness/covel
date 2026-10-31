import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import { ToolError, type RuntimeResult } from "@covel/shared";
import type {
  PluginServiceContext,
  PluginWriteServiceContext,
} from "@covel/shared/plugin-runtime";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import {
  createRootOperationStage,
  type OperationStage,
} from "../src/operations/operation-stage.js";

const SESSION = "session";
const TURN = "turn";
const timestamp = "2026-10-30T00:00:00.000Z";
const open: DataStore[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close()));
});

const change = (key = "gold", by = -5) => ({
  pluginId: "bank",
  name: "change",
  contract: "bank.change@1",
  input: { key, by },
});

function fixture(options: { readonly active?: readonly string[] } = {}): {
  store: DataStore;
  registry: PluginServiceRegistry;
  root: ReturnType<typeof createRootOperationStage>;
  client: (
    stage?: OperationStage | null,
    extra?: Partial<Parameters<PluginServiceRegistry["createClient"]>[0]>,
  ) => ReturnType<PluginServiceRegistry["createClient"]>;
} {
  const store = createMemoryStore();
  open.push(store);
  const active = new Set(options.active ?? ["bank", "shop", "notes"]);
  const registry = new PluginServiceRegistry({
    list: async () => [...active],
    ensure: async (_sessionId, pluginId) => {
      if (!active.has(pluginId)) throw new Error("Not active");
    },
  });
  const root = createRootOperationStage({
    caller: { pluginId: "shop", runtimeId: "shop/trade", runId: "run-1" },
    sessionId: SESSION,
    turnId: TURN,
  });
  const client = (
    stage: OperationStage | null = root,
    extra: Partial<Parameters<PluginServiceRegistry["createClient"]>[0]> = {},
  ) =>
    registry.createClient({
      sessionId: SESSION,
      turnId: TURN,
      pluginId: "shop",
      runtimeId: "shop/trade",
      signal: new AbortController().signal,
      gateway: { generateText: async () => "text" } as never,
      utils: {} as never,
      reads: { store, locale: "en-US" },
      ...(stage ? { operations: stage } : {}),
      ...extra,
    });
  return { store, registry, root, client };
}

const balance = z.object({ key: z.string(), by: z.number() });

function registerChange(
  registry: PluginServiceRegistry,
  handler?: (
    input: z.infer<typeof balance>,
    ctx: PluginWriteServiceContext,
  ) => Promise<unknown>,
) {
  registry.register("bank", {
    name: "change",
    contract: "bank.change@1",
    access: "write",
    input: balance,
    output: z.unknown(),
    handler:
      handler ??
      (async ({ key, by }, ctx) => {
        const current = ((await ctx.pluginData.get("balances", key)) ??
          0) as number;
        await ctx.pluginData.set("balances", key, current + by);
        return { balance: current + by };
      }),
  });
}

function attached(stage: ReturnType<typeof createRootOperationStage>) {
  const result = {} as RuntimeResult;
  stage.attachTo(result, true);
  return result;
}

describe("write-service context", () => {
  it("gives a write handler data writes, randomness and the turn, but no model or HTTP access", async () => {
    const { registry, client } = fixture();
    let seen: Record<string, unknown> = {};
    registerChange(registry, async (_input, ctx) => {
      const loose = ctx as unknown as Record<string, unknown>;
      seen = {
        gateway: "gateway" in loose ? loose.gateway : "absent",
        utils: "utils" in loose ? loose.utils : "absent",
        turnId: ctx.turnId,
        callerPluginId: ctx.callerPluginId,
        locale: ctx.locale,
        random: typeof ctx.random.int,
        writer: ["set", "delete", "update", "get", "list"].map(
          (method) => typeof (ctx.pluginData as never)[method],
        ),
        settings: typeof ctx.getOwnSettings,
        services: typeof ctx.services.call,
        world: Array.isArray(ctx.world.characters),
      };
      return {};
    });
    await client().call(change());
    expect(seen).toEqual({
      gateway: "absent",
      utils: "absent",
      turnId: TURN,
      callerPluginId: "shop",
      locale: "en-US",
      random: "function",
      writer: Array(5).fill("function"),
      settings: "function",
      services: "function",
      world: true,
    });
  });

  it("keeps a read handler's context unchanged", async () => {
    const { registry, client } = fixture();
    let context: PluginServiceContext | undefined;
    registry.register("bank", {
      name: "peek",
      contract: "bank.peek@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: async (_input, ctx) => {
        context = ctx;
        return null;
      },
    });
    await client().call({
      pluginId: "bank",
      name: "peek",
      contract: "bank.peek@1",
      input: {},
    });
    expect(context?.gateway).toBeDefined();
    expect("random" in context!).toBe(false);
    expect(typeof (context!.pluginData as { set?: unknown }).set).toBe(
      "undefined",
    );
  });

  it("reads its own writes and what earlier calls of the caller staged", async () => {
    const { registry, client, root, store } = fixture();
    await store.setPluginData({
      id: `${SESSION}:bank:balances:gold`,
      sessionId: SESSION,
      pluginId: "bank",
      namespace: "balances",
      key: "gold",
      value: 20,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    registerChange(registry, async ({ key, by }, ctx) => {
      const before = (await ctx.pluginData.get("balances", key)) as number;
      await ctx.pluginData.set("balances", key, before + by);
      return { before, after: await ctx.pluginData.get("balances", key) };
    });
    expect(await client().call(change("gold", -5))).toEqual({
      before: 20,
      after: 15,
    });
    expect(await client().call(change("gold", -5))).toEqual({
      before: 15,
      after: 10,
    });
    expect(attached(root).operations?.map((record) => record.seq)).toEqual([
      1, 2,
    ]);
  });

  it("answers conflict when an update does not fit the value it sees", async () => {
    const { registry, client } = fixture();
    registerChange(registry, async ({ key, by }, ctx) => {
      await ctx.pluginData.set("balances", key, { amount: 3 });
      await ctx.pluginData.update("balances", key, [
        { op: "inc", path: "/amount", by, min: 0 },
      ]);
      return {};
    });
    const error = await client()
      .call(change("gold", -5))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("conflict");
  });

  it("refuses writes to reserved namespaces, its own hidden ones included", async () => {
    const { registry, client, root } = fixture();
    registerChange(registry, async (_input, ctx) => {
      await ctx.pluginData.set("_hidden.x", "k", 1);
      return {};
    });
    const error = await client()
      .call(change())
      .catch((err: unknown) => err);
    expect((error as ToolError).code).toBe("invalid-input");
    expect(root.held()).toEqual([]);
  });

  it("lets a write handler call read services but not another write service", async () => {
    const { registry, client } = fixture();
    registry.register("notes", {
      name: "log",
      contract: "notes.log@1",
      access: "write",
      input: z.unknown(),
      output: z.unknown(),
      handler: async (_input, ctx) => {
        await ctx.pluginData.set("log", "entry", "x");
        return {};
      },
    });
    registry.register("notes", {
      name: "peek",
      contract: "notes.peek@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: async () => "peeked",
    });
    registerChange(registry, async (_input, ctx) => {
      const read = await ctx.services.call({
        pluginId: "notes",
        name: "peek",
        contract: "notes.peek@1",
        input: {},
      });
      const nested = await ctx.services
        .call({
          pluginId: "notes",
          name: "log",
          contract: "notes.log@1",
          input: {},
        })
        .catch((err: unknown) => err);
      return { read, nested: (nested as ToolError).code };
    });
    expect(await client().call(change())).toEqual({
      read: "peeked",
      nested: "unavailable",
    });
  });
});

describe("staging write-service calls", () => {
  it("stages one operation per successful call, with the provider's identity", async () => {
    const { registry, client, root } = fixture();
    registerChange(registry);
    await client(root, { toolCallId: "call-1" }).call(change());
    const result = attached(root);
    expect(result.operations).toHaveLength(1);
    const [record] = result.operations!;
    expect(record).toMatchObject({
      contract: "bank.change@1",
      providerPluginId: "bank",
      service: "change",
      invokedBy: { pluginId: "shop", runtimeId: "shop/trade" },
      toolCallId: "call-1",
      seq: 1,
      status: "staged",
      request: { key: "gold", by: -5 },
      result: { balance: -5 },
    });
    const writes = result.operationWrites![record!.id]!;
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      sessionId: SESSION,
      turnId: TURN,
      type: "plugin.data",
      payload: { namespace: "balances", key: "gold", value: -5 },
      source: { pluginId: "bank", runtimeId: "service:change" },
    });
  });

  it.each([
    [
      "throws",
      async (ctx: PluginWriteServiceContext) => {
        await ctx.pluginData.set("balances", "gold", 1);
        throw new Error("boom");
      },
    ],
    [
      "returns invalid output",
      async (ctx: PluginWriteServiceContext) => {
        await ctx.pluginData.set("balances", "gold", 1);
        return 42;
      },
    ],
  ])("stages nothing when the handler %s", async (_name, body) => {
    const { registry, client, root } = fixture();
    registry.register("bank", {
      name: "change",
      contract: "bank.change@1",
      access: "write",
      input: balance,
      output: z.object({}),
      handler: (_input, ctx) => body(ctx) as never,
    });
    await expect(client().call(change())).rejects.toThrow();
    expect(root.held()).toEqual([]);
  });

  it("stages nothing when the call times out, even if the handler keeps writing", async () => {
    const { registry, client, root } = fixture();
    let late: unknown;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    registerChange(registry, async (_input, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      try {
        await ctx.pluginData.set("balances", "gold", 1);
      } catch (error) {
        late = error;
      }
      finished();
      return {};
    });
    await expect(client().call(change(), { timeoutMs: 5 })).rejects.toThrow();
    await done;
    expect(late).toBeInstanceOf(Error);
    expect(root.held()).toEqual([]);
  });

  it("stages nothing when the caller cancels", async () => {
    const { registry, client, root } = fixture();
    const controller = new AbortController();
    registerChange(registry, async (_input, ctx) => {
      await ctx.pluginData.set("balances", "gold", 1);
      controller.abort();
      return {};
    });
    await expect(
      client().call(change(), { signal: controller.signal }),
    ).rejects.toThrow();
    expect(root.held()).toEqual([]);
  });

  it("leaves no record for a call that wrote nothing", async () => {
    const { registry, client, root } = fixture();
    registerChange(registry, async () => ({ unchanged: true }));
    expect(await client().call(change())).toEqual({ unchanged: true });
    expect(attached(root).operations).toBeUndefined();
  });

  it("runs calls of one caller to one provider one after the other", async () => {
    const { registry, root, client } = fixture();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    registerChange(registry, async ({ key, by }, ctx) => {
      const n = ++call;
      order.push(`start ${n}`);
      const current = ((await ctx.pluginData.get("balances", key)) ??
        0) as number;
      if (n === 1) await firstHeld;
      await ctx.pluginData.set("balances", key, current + by);
      order.push(`end ${n}`);
      return { seen: current };
    });
    const a = root.child();
    const b = root.child();
    const first = client(a).call(change("gold", 10));
    const second = client(b).call(change("gold", 5));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["start 1"]);
    releaseFirst();
    expect(await first).toEqual({ seen: 0 });
    expect(await second).toEqual({ seen: 10 });
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    a.commit();
    b.commit();
    expect(root.held()).toHaveLength(2);
  });

  it("answers unavailable without a stage, and refused for a self-call", async () => {
    const { registry, client } = fixture();
    registerChange(registry);
    const noStage = await client(null)
      .call(change())
      .catch((err: unknown) => err);
    expect((noStage as ToolError).code).toBe("unavailable");
    expect((noStage as Error).message).toBe(
      "Write services cannot be called here.",
    );
    const bankStage = createRootOperationStage({
      caller: { pluginId: "bank", runtimeId: "bank/run" },
      sessionId: SESSION,
      turnId: TURN,
    });
    const self = await registry
      .createClient({
        sessionId: SESSION,
        turnId: TURN,
        pluginId: "bank",
        runtimeId: "bank/run",
        signal: new AbortController().signal,
        operations: bankStage,
      })
      .call(change())
      .catch((err: unknown) => err);
    expect((self as ToolError).code).toBe("refused");
    // A tool of the stage owner's plugin is refused too.
    const viaOwner = await registry
      .createClient({
        sessionId: SESSION,
        turnId: TURN,
        pluginId: "shop",
        signal: new AbortController().signal,
        operations: bankStage,
      })
      .call(change())
      .catch((err: unknown) => err);
    expect((viaOwner as ToolError).code).toBe("refused");
  });

  it("records a sub-agent's call as its own, and refuses it the delegating plugin's write services", async () => {
    const { registry, client, root } = fixture({
      active: ["bank", "shop", "helper"],
    });
    registerChange(registry);
    registry.register("shop", {
      name: "restock",
      contract: "shop.restock@1",
      access: "write",
      input: z.unknown(),
      output: z.unknown(),
      handler: async (_input, ctx) => {
        await ctx.pluginData.set("stock", "sword", 1);
        return {};
      },
    });
    const helper = { pluginId: "helper", runtimeId: "helper/actor" };
    const sub = root.child(helper);
    const own = client(sub, { pluginId: "helper", runtimeId: "helper/actor" });
    await own.call(change());
    const refused = await own
      .call({
        pluginId: "shop",
        name: "restock",
        contract: "shop.restock@1",
        input: {},
      })
      .catch((err: unknown) => err);
    expect((refused as ToolError).code).toBe("refused");
    sub.commit();
    expect(attached(root).operations?.[0]?.invokedBy).toEqual(helper);
  });

  it("refuses to register a write extension provider or a mismatched access", () => {
    const { registry } = fixture();
    expect(() =>
      registry.register("bank", {
        name: "x",
        contract: "bank.x@1",
        access: "nope" as never,
        input: z.unknown(),
        output: z.unknown(),
        handler: async () => null,
      }),
    ).toThrow();
  });
});

describe("child stages", () => {
  it("hands a committed child's operations to its parent and takes back a discarded one's", async () => {
    const { registry, root, client } = fixture();
    registerChange(registry);
    const kept = root.child();
    const dropped = root.child();
    await client(kept).call(change("gold", 1));
    await client(dropped).call(change("gold", 2));
    // A later call does not see what a discarded child staged.
    dropped.discard();
    kept.commit();
    const third = root.child();
    expect(await client(third).call(change("gold", 4))).toEqual({
      balance: 5,
    });
    third.commit();
    const result = attached(root);
    expect(
      result.operations?.map((record) => [record.seq, record.status]),
    ).toEqual([
      [1, "staged"],
      [2, "discarded"],
      [3, "staged"],
    ]);
    expect(Object.keys(result.operationWrites ?? {})).toHaveLength(2);
  });
});
