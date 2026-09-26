import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PluginServiceContext } from "@covel/shared/plugin-runtime";
import { PluginServiceRegistry } from "../src/plugin-services.js";

function fixture() {
  const active = new Set(["consumer", "provider"]);
  const ensure = vi.fn(async (_sessionId: string, pluginId: string) => {
    if (!active.has(pluginId)) throw new Error("Plugin not authorized");
  });
  const registry = new PluginServiceRegistry({
    list: async () => [...active],
    ensure,
  });
  const abort = new AbortController();
  const client = registry.createClient({
    sessionId: "test",
    pluginId: "consumer",
    signal: abort.signal,
  });
  return { registry, client, abort, active, ensure };
}
const request = {
  pluginId: "provider",
  name: "rank",
  contract: "fixture/rank@1",
  input: { value: 3 },
};
const schema = z.object({ value: z.number() });

describe("public plugin services", () => {
  afterEach(() => vi.useRealTimers());

  it("cancels an uncooperative call promptly while the caller can continue", async () => {
    const { registry, client, abort } = fixture();
    let rejectWork!: (error: Error) => void;
    let serviceSignal!: AbortSignal;
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (_input, context) => {
        serviceSignal = context.signal;
        return new Promise((_resolve, reject) => {
          rejectWork = reject;
        });
      },
    });
    registry.register("provider", {
      name: "fallback",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (input) => input,
    });
    const local = new AbortController();
    const call = client.call(request, { signal: local.signal });
    const rejected = expect(call).rejects.toThrow("cancel one call");
    await vi.waitFor(() => expect(serviceSignal).toBeDefined());
    local.abort(new Error("cancel one call"));
    await rejected;
    expect(serviceSignal.aborted).toBe(true);
    expect(abort.signal.aborted).toBe(false);
    expect(await client.call({ ...request, name: "fallback" })).toEqual(
      request.input,
    );
    // A provider that ignores cancellation may still reject later.
    rejectWork(new Error("late provider failure"));
    await Promise.resolve();
  });

  it("applies a call deadline to nested calls and lent gateway and HTTP work", async () => {
    vi.useFakeTimers();
    const { registry, abort } = fixture();
    const signals: AbortSignal[] = [];
    const generateText = vi.fn(async (input) => {
      signals.push(input.signal);
      return {};
    });
    const fetchWithRetry = vi.fn(async (_input, init) => {
      signals.push(init.signal);
      return new Response();
    });
    const client = registry.createClient({
      sessionId: "test",
      pluginId: "consumer",
      signal: abort.signal,
      gateway: {
        generateText,
        generateObject: vi.fn(),
        resolveSlot: vi.fn(),
      } as never,
      utils: { fetchWithRetry, validateBaseUrl: vi.fn() },
    });
    registry.register("provider", {
      name: "inner",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: async (_input, context) => {
        signals.push(context.signal);
        await context.gateway!.generateText({} as never);
        await context.utils!.fetchWithRetry("https://example.com");
        return new Promise(() => {});
      },
    });
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: async (_input, context) => {
        signals.push(context.signal);
        return (await context.services.call({ ...request, name: "inner" })) as {
          value: number;
        };
      },
    });
    const call = client.call(request, { timeoutMs: 10 });
    const rejected = expect(call).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(abort.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting for admission and never invokes a provider after cancellation", async () => {
    let admit!: () => void;
    const ensure = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
    );
    const registry = new PluginServiceRegistry({
      list: async () => [],
      ensure,
    });
    const abort = new AbortController();
    const client = registry.createClient({
      sessionId: "test",
      pluginId: "consumer",
      signal: abort.signal,
    });
    const handler = vi.fn((input) => input);
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler,
    });
    const call = client.call(request);
    const rejected = expect(call).rejects.toThrow("parent cancelled");
    abort.abort(new Error("parent cancelled"));
    await rejected;
    admit();
    await Promise.resolve();
    await Promise.resolve();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("cleans up call resources on success and failure and rejects retained contexts", async () => {
    vi.useFakeTimers();
    const { registry, client, abort } = fixture();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    let retained!: PluginServiceContext;
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (input, context) => {
        retained = context;
        return input;
      },
    });
    expect(await client.call(request, { timeoutMs: 100 })).toEqual(
      request.input,
    );
    expect(retained.signal.aborted).toBe(true);
    await expect(retained.services.call(request)).rejects.toThrow("completed");
    await expect(
      client.call({ ...request, input: null }, { timeoutMs: 100 }),
    ).rejects.toThrow();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid or pre-cancelled call controls before admission", async () => {
    const { client, ensure } = fixture();
    for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648, "10"]) {
      await expect(
        client.call(request, { timeoutMs: timeoutMs as number }),
      ).rejects.toThrow("timeoutMs");
    }
    await expect(
      client.call(request, { signal: {} as AbortSignal }),
    ).rejects.toThrow("AbortSignal");
    await expect(client.call(request, null as never)).rejects.toThrow(
      "options",
    );
    await expect(
      client.call(request, {
        signal: AbortSignal.abort(new Error("already cancelled")),
      }),
    ).rejects.toThrow("already cancelled");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("rejects malformed JavaScript service definitions during registration", () => {
    const { registry } = fixture();
    const valid = {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (input: unknown) => input,
    };
    for (const definition of [
      null,
      { ...valid, name: 1 },
      { ...valid, contract: 1 },
      { ...valid, input: {} },
      { ...valid, output: {} },
      { ...valid, handler: 1 },
      { ...valid, description: 1 },
    ]) {
      expect(() => registry.register("provider", definition as never)).toThrow(
        "Service requires",
      );
    }
    expect(() => registry.register("provider", valid)).not.toThrow();
  });

  it("discovers contracts, validates both boundaries, and isolates object ownership", async () => {
    const { registry, client } = fixture();
    const value = { value: 4 };
    const handler = vi.fn(async (input, context) => {
      input.value = 999;
      expect(context.callerPluginId).toBe("consumer");
      expect(context).not.toHaveProperty("store");
      expect(context).not.toHaveProperty("pluginData");
      return value;
    });
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler,
    });
    expect(await client.discover(request.contract)).toEqual([
      expect.objectContaining({ pluginId: "provider", name: "rank" }),
    ]);
    const result = (await client.call(request)) as { value: number };
    result.value = 100;
    expect(value.value).toBe(4);
    expect(request.input.value).toBe(3);
    await expect(
      client.call({ ...request, input: { value: "invalid" } }),
    ).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(
      client.call({ ...request, contract: "fixture/rank@2" }),
    ).rejects.toThrow("unavailable");
  });

  it("denies disabled providers and consumers and removes disposed registrations", async () => {
    const { registry, client, active } = fixture();
    const dispose = registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (v) => v,
    });
    active.delete("provider");
    expect(await client.discover(request.contract)).toEqual([]);
    await expect(client.call(request)).rejects.toThrow("not authorized");
    active.add("provider");
    dispose();
    await expect(client.call(request)).rejects.toThrow("unavailable");
    active.delete("consumer");
    await expect(client.discover(request.contract)).rejects.toThrow(
      "not authorized",
    );
  });

  it("rejects duplicate registration, output violations, recursion and cancelled results", async () => {
    const { registry, client, abort } = fixture();
    const definition = {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: () => ({ value: "invalid" }) as unknown as { value: number },
    };
    const dispose = registry.register("provider", definition);
    expect(() => registry.register("provider", definition)).toThrow(
      "Duplicate",
    );
    await expect(client.call(request)).rejects.toThrow();
    dispose();
    const disposeRecursive = registry.register("provider", {
      ...definition,
      handler: async (_v, ctx) =>
        (await ctx.services.call(request)) as { value: number },
    });
    await expect(client.call(request)).rejects.toThrow("cycle");
    disposeRecursive();
    registry.register("provider", {
      ...definition,
      handler: (v) => {
        abort.abort(new Error("cancelled"));
        return v;
      },
    });
    await expect(client.call(request)).rejects.toThrow("cancelled");
    await expect(client.call(request)).rejects.toThrow("cancelled");
  });

  it("lends the gateway with slot secrets stripped, including nested hops", async () => {
    const active = new Set(["consumer", "provider", "inner"]);
    const registry = new PluginServiceRegistry({
      list: async () => [...active],
      ensure: async (_sessionId: string, pluginId: string) => {
        if (!active.has(pluginId)) throw new Error("Plugin not authorized");
      },
    });
    const resolved = {
      presetId: "preset",
      provider: "prov",
      protocol: "proto",
      baseUrl: "https://api.example",
      apiKey: "sk-secret",
      headers: { authorization: "Bearer sk-secret" },
      model: "model",
      tag: "text",
      metadata: { embeddingFormat: "base64" },
      // Undeclared extras the runtime result actually carries.
      capability: "evaluation",
      parameterOverrides: { maxOutputTokens: 0 },
    };
    const gateway = { resolveSlot: () => resolved } as never;
    const client = registry.createClient({
      sessionId: "test",
      pluginId: "consumer",
      signal: new AbortController().signal,
      gateway,
    });
    const seen: unknown[] = [];
    registry.register("inner", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (_v, ctx) => {
        seen.push(ctx.gateway?.resolveSlot({}));
        return { value: 1 };
      },
    });
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: async (_v, ctx) => {
        seen.push(ctx.gateway?.resolveSlot({}));
        await ctx.services.call({
          pluginId: "inner",
          name: "rank",
          contract: request.contract,
          input: { value: 1 },
        });
        return { value: 2 };
      },
    });

    await client.call(request);

    expect(seen).toHaveLength(2);
    for (const slot of seen) {
      expect(slot).toMatchObject({
        presetId: "preset",
        model: "model",
        metadata: { embeddingFormat: "base64" },
      });
      expect(slot).not.toHaveProperty("apiKey");
      expect(slot).not.toHaveProperty("headers");
      expect(slot).not.toHaveProperty("capability");
      expect(slot).not.toHaveProperty("parameterOverrides");
    }
    // The caller's own facade is untouched — only the lent view strips.
    expect(resolved.apiKey).toBe("sk-secret");
  });
});
