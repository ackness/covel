import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { defaultSessionSeats, type PluginMessageCatalog } from "@covel/shared";
import { labelText, translate } from "@covel/plugin-handlers-utils";
import type {
  HandlerResult,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import type {
  FunctionHandler,
  LoadedRuntime,
  PluginServiceContext,
} from "@covel/shared/plugin-runtime";
import type { PluginServiceContext as SdkServiceContext } from "@covel/plugin-handlers-utils/plugin-api";
import { commitExecution, executeTurn } from "../src/index.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { readDependenciesOf } from "../src/read-dependencies.js";
import { createPluginDataVisibility } from "../src/function-runtime/upstream-plugin-data.js";
import { executeFunctionRuntime } from "../src/function-runtime/turn-function-runtime.js";

const SESSION = "session";
const timestamp = "2026-10-29T00:00:00.000Z";
const input: TurnInput = {
  sessionId: SESSION,
  turnId: "turn",
  logicalTurnId: "logical-turn",
  playerMessage: "Continue",
  origin: "player",
  locale: "en-US",
};
const ok = (): HandlerResult => ({ outcome: "success", value: {} });
const request = (pluginId = "provider", key = "sword") => ({
  pluginId,
  name: "read",
  contract: "fixture/read@1",
  input: { key },
});

function fn(
  pluginId: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name: `${pluginId}/run`,
    pluginId,
    description: "fixture",
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
    ...extra,
  } as RuntimeManifest;
}
const writer = fn("provider", { stage: "pre-turn" });
const reader = fn("consumer");
const story = fn("narrator", { stage: "narrative", outputKind: "story" });
const tell: FunctionHandler = async () => ({
  outcome: "success",
  value: { narrativeOutput: "The story goes on." },
});
const write: FunctionHandler = async (ctx) => {
  await ctx.pluginData!.set("items", "sword", "upstream");
  return ok();
};
const open: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((store) => store.close()));
});

async function fixture(
  messagesOf?: (
    pluginId: string,
  ) => readonly PluginMessageCatalog[] | undefined,
) {
  const store = createMemoryStore();
  open.push(store);
  const active = new Set(["provider", "consumer", "inner", "narrator"]);
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: [...active],
    completedPlayerTurns: 1,
    seats: defaultSessionSeats(),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const registry = new PluginServiceRegistry(
    {
      list: async () => [...active],
      ensure: async (_sessionId, pluginId) => {
        if (!active.has(pluginId)) throw new Error("Not active");
      },
    },
    messagesOf,
  );
  const registerRead = (pluginId = "provider") =>
    registry.register(pluginId, {
      name: "read",
      contract: "fixture/read@1",
      input: z.object({ key: z.string() }),
      output: z.unknown(),
      handler: ({ key }, ctx) => ctx.pluginData.get("items", key),
    });
  const put = async (
    pluginId: string,
    namespace: string,
    key: string,
    value: unknown,
    sessionId = SESSION,
  ) => {
    await store.setPluginData({
      id: `${sessionId}:${pluginId}:${namespace}:${key}`,
      sessionId,
      pluginId,
      namespace,
      key,
      value,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  };
  const client = registry.createClient({
    sessionId: SESSION,
    pluginId: "consumer",
    signal: new AbortController().signal,
    reads: { store, locale: "en-US" },
  });
  const run = async (
    runtimes: readonly RuntimeManifest[],
    handlers: Record<string, FunctionHandler>,
    options: {
      guards?: Record<string, LoadedRuntime["guard"]>;
      input?: Partial<TurnInput>;
    } = {},
  ) => {
    const execution = await executeTurn(
      { ...input, ...options.input },
      runtimes,
      {
        store,
        services: registry,
        llm: { generate: vi.fn() } as never,
        hookScope: {
          activePluginIds: active,
          settings: {
            provider: { tone: "provider setting" },
            consumer: { tone: "caller setting" },
          },
        },
        loadRuntime: async (runtime) => ({
          manifest: runtime,
          promptTemplate: "",
          handler: handlers[runtime.name],
          guard: options.guards?.[runtime.name],
        }),
      },
    );
    const resultOf = (runtimeId: string) => {
      const result = (
        execution.commit.results as readonly RuntimeResult[]
      ).find((result) => result.runtimeId === runtimeId);
      if (!result) throw new Error(`Missing result: ${runtimeId}`);
      return result;
    };
    const dependenciesOf = (runtimeId: string) =>
      execution.commit.readDependencies?.[resultOf(runtimeId).runId] ?? [];
    return { execution, resultOf, dependenciesOf };
  };
  return { store, registry, registerRead, put, client, run };
}

describe("read-service context", () => {
  it("reads only the provider's committed data and filters hidden namespaces", async () => {
    const { registry, client, put, store } = await fixture();
    await put("provider", "items", "sword", { name: "Sword" });
    await put("consumer", "items", "sword", "caller secret");
    await put("provider", "items", "sword", "other session", "other-session");
    await put("provider", "_hidden.items", "sword", "hidden secret");
    const get = vi.spyOn(store, "getPluginData");
    const list = vi.spyOn(store, "listPluginData");
    registry.register("provider", {
      name: "read",
      contract: "fixture/read@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: async (_input, ctx) => ({
        sessionId: ctx.sessionId,
        locale: ctx.locale,
        value: await ctx.pluginData.get("items", "sword"),
        missing: await ctx.pluginData.get("items", "missing"),
        rows: await ctx.pluginData.list("items"),
        hidden: await ctx.pluginData.get("_hidden.items", "sword"),
        hiddenRows: await ctx.pluginData.list("_hidden.items"),
      }),
    });
    expect(await client.call(request())).toEqual({
      sessionId: SESSION,
      locale: "en-US",
      value: { name: "Sword" },
      missing: null,
      rows: [{ key: "sword", value: { name: "Sword" } }],
      hidden: null,
      hiddenRows: [],
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("sees upstream provider writes and attaches their run IDs to the caller", async () => {
    const { registerRead, run, store } = await fixture();
    registerRead();
    let seen: unknown;
    const { resultOf, execution, dependenciesOf } = await run(
      [writer, reader],
      {
        [writer.name]: write,
        [reader.name]: async (ctx) => {
          seen = await ctx.services!.call(request());
          return ok();
        },
      },
    );
    expect(seen).toBe("upstream");
    expect(resultOf(reader.name).status).toBe("success");
    expect(dependenciesOf(reader.name)).toEqual([resultOf(writer.name).runId]);
    expect(execution.commit.readDependencies).toEqual({
      [resultOf(reader.name).runId]: [resultOf(writer.name).runId],
    });
    expect(
      await store.getPluginData(SESSION, "provider", "items", "sword"),
    ).toBeNull();
    expect(resultOf(reader.name).pendingProposals ?? []).toEqual([]);
  });

  it.each([false, true])(
    "keeps story semantics when a provider is rejected (story caller: %s)",
    async (storyCaller) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { registerRead, run, store } = await fixture();
      registerRead();
      const caller = storyCaller
        ? fn("consumer", { stage: "narrative", outputKind: "story" })
        : reader;
      const { execution, resultOf } = await run(
        [writer, caller, ...(storyCaller ? [] : [story])],
        {
          [writer.name]: write,
          [story.name]: tell,
          [caller.name]: async (ctx) => {
            const value = await ctx.services!.call(request());
            await ctx.pluginData!.set("items", "read", value);
            return storyCaller ? tell(ctx) : ok();
          },
        },
      );
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
        proposalGuard: (proposal) =>
          proposal.source.pluginId === "provider"
            ? "provider refused"
            : undefined,
      });
      expect(outcome.status).toBe("committed");
      expect(
        outcome.isolatedRuntimes?.map((result) => result.runtimeId),
      ).toEqual(storyCaller ? [writer.name] : [writer.name, caller.name]);
      expect(
        (await store.getPluginData(SESSION, "consumer", "items", "read"))
          ?.value,
      ).toBe(storyCaller ? "upstream" : undefined);
      const kept = await store.queryTraceEvents(SESSION, {
        types: ["read-dependency.kept"],
      });
      expect(kept.map((event) => event.payload)).toEqual(
        storyCaller
          ? [
              {
                runtimeId: caller.name,
                runId: resultOf(caller.name).runId,
                producerRuntimeId: writer.name,
                producerRunId: resultOf(writer.name).runId,
                reason: `read data of ${writer.name} that did not commit`,
              },
            ]
          : [],
      );
    },
  );

  it("overlays operations, deletes and batches in commit order, preserving list order", async () => {
    const { registry, put, run, store } = await fixture();
    await put("provider", "items", "kept", 10);
    await put("provider", "items", "removed", "old");
    registry.register("provider", {
      name: "read",
      contract: "fixture/read@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: async (_input, ctx) => ({
        rows: await ctx.pluginData.list("items"),
        missing: await ctx.pluginData.get("items", "removed"),
        count: await ctx.pluginData.get("items", "kept"),
      }),
    });
    const second = fn("provider", {
      name: "provider/second",
      stage: "narrative",
    });
    let seen: unknown;
    const { execution, resultOf, dependenciesOf } = await run(
      [writer, second, reader],
      {
        [writer.name]: async (ctx) => {
          await ctx.pluginData!.update("items", "kept", [{ op: "inc", by: 1 }]);
          await ctx.pluginData!.set("items", "removed", null);
          return {
            outcome: "success",
            value: {},
            effects: {
              pluginData: [
                { namespace: "items", key: "first", value: "first" },
              ],
            },
          };
        },
        [second.name]: async (ctx) => {
          await ctx.pluginData!.update("items", "kept", [{ op: "inc", by: 2 }]);
          await ctx.pluginData!.set("items", "last", "last");
          return ok();
        },
        [reader.name]: async (ctx) => {
          seen = await ctx.services!.call(request());
          return ok();
        },
      },
    );
    expect(seen).toEqual({
      rows: [
        { key: "kept", value: 13 },
        { key: "first", value: "first" },
        { key: "last", value: "last" },
      ],
      missing: null,
      count: 13,
    });
    expect(dependenciesOf(reader.name)).toEqual([
      resultOf(writer.name).runId,
      resultOf(second.name).runId,
    ]);
    const outcome = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });
    expect(outcome.status).toBe("committed");
    expect(
      (await store.getPluginData(SESSION, "provider", "items", "kept"))?.value,
    ).toBe(13);
  });

  it("includes a self-call's buffered writes without depending on itself or overwritten upstream", async () => {
    const { registerRead, run } = await fixture();
    registerRead();
    const self = fn("provider", { name: "provider/self" });
    let seen: unknown;
    const { resultOf, dependenciesOf } = await run([writer, self], {
      [writer.name]: write,
      [self.name]: async (ctx) => {
        await ctx.pluginData!.set("items", "sword", "buffered");
        seen = await ctx.services!.call(request());
        return ok();
      },
    });
    expect(seen).toBe("buffered");
    expect(resultOf(self.name).status).toBe("success");
    expect(dependenciesOf(self.name)).toEqual([]);
  });

  it("keeps the top caller's recorder across nested providers and isolates its buffer", async () => {
    const { registry, registerRead, put, run } = await fixture();
    await put("provider", "items", "sword", "provider stored");
    const inner = fn("inner", { stage: "pre-turn" });
    registerRead("inner");
    registry.register("provider", {
      name: "read",
      contract: "fixture/read@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: async (_input, ctx) => {
        expect(ctx.callerPluginId).toBe("consumer");
        expect(await ctx.pluginData.get("items", "sword")).toBe(
          "provider stored",
        );
        return ctx.services.call(request("inner"));
      },
    });
    let seen: unknown;
    const { resultOf, dependenciesOf } = await run([inner, reader], {
      [inner.name]: async (ctx) => {
        await ctx.pluginData!.set("items", "sword", "inner upstream");
        return ok();
      },
      [reader.name]: async (ctx) => {
        await ctx.pluginData!.set("items", "sword", "caller buffer");
        seen = await ctx.services!.call(request());
        return ok();
      },
    });
    expect(seen).toBe("inner upstream");
    expect(dependenciesOf(reader.name)).toEqual([resultOf(inner.name).runId]);
  });

  it("exposes no write methods and returns detached values for get and list", async () => {
    const checkReadOnlyTypes = async (ctx: PluginServiceContext) => {
      const sdk: SdkServiceContext = ctx;
      // @ts-expect-error Read services cannot write provider data.
      await ctx.pluginData.set("items", "sword", {});
      // @ts-expect-error The SDK exposes the same read-only boundary.
      await sdk.pluginData.update("items", "sword", []);
    };
    // Type-check the forbidden writes without executing them.
    void checkReadOnlyTypes;
    const { registry, client, put } = await fixture();
    await put("provider", "items", "sword", { damage: 5 });
    registry.register("provider", {
      name: "read",
      contract: "fixture/read@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: async (_input, ctx) => {
        expect(Object.keys(ctx.pluginData).sort()).toEqual(["get", "list"]);
        const value = await ctx.pluginData.get("items", "sword");
        expect(value).toEqual({ damage: 5 });
        Object.assign(value as object, { damage: 99 });
        const rows = await ctx.pluginData.list("items");
        for (const row of rows)
          Object.assign(row.value as object, { damage: 100 });
        return ctx.pluginData.get("items", "sword");
      },
    });
    expect(await client.call(request())).toEqual({ damage: 5 });
  });

  it("lazily clones the caller's world for each service call", async () => {
    const { registry, run, store } = await fixture();
    await store.upsertCharacter({
      id: "ada",
      sessionId: SESSION,
      name: "Ada",
      type: "npc",
      fields: {},
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    registry.register("provider", {
      name: "read",
      contract: "fixture/read@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: (_input, ctx) => {
        expect(ctx.world.characters.map((character) => character.name)).toEqual(
          ["Ada"],
        );
        expect(ctx.world).toBe(ctx.world);
        Object.assign(ctx.world.characters[0] ?? {}, { name: "Changed" });
        return null;
      },
    });
    let callerNames: unknown;
    const { resultOf } = await run([reader], {
      [reader.name]: async (ctx) => {
        await ctx.services!.call(request());
        await ctx.services!.call(request());
        callerNames = ctx.world?.characters.map((character) => character.name);
        return ok();
      },
    });
    expect(resultOf(reader.name).status).toBe("success");
    expect(callerNames).toEqual(["Ada"]);
  });

  it("returns the provider's frozen turn settings", async () => {
    const { registry, run } = await fixture();
    registry.register("provider", {
      name: "read",
      contract: "fixture/read@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: (_input, ctx) => {
        expect(Object.isFrozen(ctx.getOwnSettings())).toBe(true);
        return ctx.getOwnSettings();
      },
    });
    let seen: unknown;
    const { resultOf } = await run([reader], {
      [reader.name]: async (ctx) => {
        seen = await ctx.services!.call(request());
        return ok();
      },
    });
    expect(resultOf(reader.name).status).toBe("success");
    expect(seen).toEqual({ tone: "provider setting" });
  });

  it("gives write and nested read services their own provider's message catalogs", async () => {
    const catalogs: Record<string, readonly PluginMessageCatalog[]> = {
      consumer: [{ locale: "zh", messages: { Saved: "调用方" } }],
      provider: [{ locale: "zh", messages: { Saved: "已保存" } }],
      inner: [{ locale: "zh", messages: { Saved: "已读取" } }],
    };
    const { registry, run } = await fixture((id) => catalogs[id]);
    registry.register("inner", {
      name: "read",
      contract: "fixture/read@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: (_input, ctx) => ({
        text: translate(ctx, "Saved"),
        badge: labelText(ctx, "Saved"),
      }),
    });
    registry.register("provider", {
      name: "save",
      contract: "fixture/save@1",
      access: "write",
      input: z.unknown(),
      output: z.unknown(),
      handler: async (_input, ctx) => {
        const badge = labelText(ctx, "Saved");
        await ctx.pluginData.set("labels", "saved", badge);
        return {
          text: translate(ctx, "Saved"),
          badge,
          nested: await ctx.services.call(request("inner")),
        };
      },
    });
    let seen: unknown;
    const { resultOf } = await run(
      [reader],
      {
        [reader.name]: async (ctx) => {
          seen = await ctx.services!.call({
            pluginId: "provider",
            name: "save",
            contract: "fixture/save@1",
            input: {},
          });
          return ok();
        },
      },
      { input: { locale: "zh-CN" } },
    );
    expect(resultOf(reader.name).status).toBe("success");
    expect(seen).toEqual({
      text: "已保存",
      badge: { en: "Saved", zh: "已保存" },
      nested: {
        text: "已读取",
        badge: { en: "Saved", zh: "已读取" },
      },
    });
  });

  it.each(["get", "list"] as const)(
    "rejects %s before and after an aborted store read",
    async (kind) => {
      const { registry, store } = await fixture();
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const abort = new AbortController();
      const pending: Promise<unknown>[] = [];
      const waitForAbort = async () => {
        started.resolve();
        await finish.promise;
      };
      const load =
        kind === "get"
          ? vi.spyOn(store, "getPluginData").mockImplementation(async () => {
              await waitForAbort();
              return null;
            })
          : vi.spyOn(store, "listPluginData").mockImplementation(async () => {
              await waitForAbort();
              return [];
            });
      let retained: PluginServiceContext | undefined;
      registry.register("provider", {
        name: "read",
        contract: "fixture/read@1",
        input: z.unknown(),
        output: z.unknown(),
        handler: async (_input, ctx) => {
          retained = ctx;
          const read =
            kind === "get"
              ? ctx.pluginData.get("items", "sword")
              : ctx.pluginData.list("items");
          pending.push(read);
          return read;
        },
      });
      const client = registry.createClient({
        sessionId: SESSION,
        pluginId: "consumer",
        signal: abort.signal,
        reads: { store },
      });
      const call = client.call(request());
      await started.promise;
      const reason = new Error("caller cancelled");
      abort.abort(reason);
      await expect(call).rejects.toBe(reason);
      finish.resolve();
      for (const read of pending) await expect(read).rejects.toBe(reason);
      if (!retained) throw new Error("Service was not called");
      await expect(retained.pluginData.get("items", "sword")).rejects.toBe(
        reason,
      );
      await expect(retained.pluginData.list("items")).rejects.toBe(reason);
      expect(load).toHaveBeenCalledTimes(1);
    },
  );

  it("gives guards the same provider overlay and records on the skipped result", async () => {
    const { registerRead, run } = await fixture();
    registerRead();
    const guard = fn("consumer", { runtimeType: "agent", guard: "./guard.js" });
    let seen: unknown;
    const { resultOf, dependenciesOf } = await run(
      [writer, guard],
      { [writer.name]: write },
      {
        guards: {
          [guard.name]: async (ctx) => {
            seen = await ctx.services!.call(request());
            return { skip: true };
          },
        },
      },
    );
    expect(seen).toBe("upstream");
    expect(resultOf(guard.name).status).toBe("skipped");
    expect(dependenciesOf(guard.name)).toEqual([resultOf(writer.name).runId]);
  });

  it("reads committed data without upstreamOf and records no upstream dependency", async () => {
    const { registry, registerRead, put, store } = await fixture();
    registerRead();
    await put("provider", "items", "sword", "stored");
    const visibility = createPluginDataVisibility({
      pluginId: "consumer",
      runtimeId: reader.name,
    });
    const client = registry.createClient({
      sessionId: SESSION,
      pluginId: "consumer",
      signal: new AbortController().signal,
      reads: { store, visibility },
    });
    expect(await client.call(request())).toBe("stored");
    expect([...visibility.recorder]).toEqual([]);
  });

  it("does not apply a provider's retry seed operations twice", async () => {
    const { registerRead, put, run } = await fixture();
    registerRead();
    await put("provider", "items", "sword", 11);
    const seed: RuntimeResult = {
      pluginId: writer.pluginId,
      runtimeId: writer.name,
      runId: "seed-run",
      turnId: "source-turn",
      status: "success",
      output: {},
      toolCalls: [],
      durationMs: 0,
      timestamp,
      pendingProposals: [
        {
          id: "seed-op",
          type: "plugin.data.update",
          source: { pluginId: writer.pluginId, runtimeId: writer.name },
          sessionId: SESSION,
          turnId: "source-turn",
          timestamp,
          payload: {
            namespace: "items",
            key: "sword",
            ops: [{ op: "inc", by: 1 }],
          },
        },
      ],
    };
    let seen: unknown;
    const { resultOf, dependenciesOf } = await run(
      [writer, reader],
      {
        [reader.name]: async (ctx) => {
          seen = await ctx.services!.call(request());
          return ok();
        },
      },
      {
        input: {
          origin: "manual",
          playerMessage: "",
          manualTrigger: {
            runtimeId: reader.name,
            sourceTurnId: "source-turn",
            retrySeedResults: [seed],
          },
        },
      },
    );
    expect(seen).toBe(11);
    expect(resultOf(reader.name).status).toBe("success");
    expect(dependenciesOf(reader.name)).toEqual([]);
  });

  it("uses the invocation's existing settle path to attach read dependencies", async () => {
    const { store, registry, registerRead } = await fixture();
    registerRead();
    const upstream = [
      {
        runId: "producer-run",
        runtimeId: writer.name,
        proposal: {
          id: "write",
          type: "plugin.data" as const,
          sessionId: SESSION,
          turnId: input.turnId,
          timestamp,
          source: { pluginId: writer.pluginId, runtimeId: writer.name },
          payload: { namespace: "items", key: "sword", value: "upstream" },
        },
      },
    ];
    const result = await executeFunctionRuntime({
      manifest: reader,
      input,
      loaded: {
        manifest: reader,
        promptTemplate: "",
        handler: async (ctx) => {
          expect(await ctx.services!.call(request())).toBe("upstream");
          return ok();
        },
      },
      deps: {
        store,
        services: registry,
        llm: { generate: vi.fn() } as never,
        loadRuntime: async () => undefined,
      },
      upstreamOf: (pluginId) => (pluginId === writer.pluginId ? upstream : []),
      hookPipeline: undefined,
      triggerEvent: undefined,
      executionContext: {
        executionId: "execution",
        origin: "player",
        countPolicy: "none",
      },
      createRecursiveCall: () => async () => {
        throw new Error("Unused");
      },
      recursionDepth: 0,
      startTime: Date.now(),
      runId: "caller-run",
      timeoutMs: 5000,
    });
    expect(result.status).toBe("success");
    expect(readDependenciesOf(result)).toEqual(["producer-run"]);
  });
});
