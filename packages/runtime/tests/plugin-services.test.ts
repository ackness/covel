import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PluginServiceContext } from "@covel/shared/plugin-runtime";
import {
  PluginServiceRegistry,
  type PluginServiceCallEvent,
} from "../src/plugin-services.js";

function fixture(onCallCompleted?: (event: PluginServiceCallEvent) => void) {
  const active = new Set(["consumer", "provider"]);
  const events: PluginServiceCallEvent[] = [];
  const ensure = vi.fn(async (_sessionId: string, pluginId: string) => {
    if (!active.has(pluginId)) throw new Error("Plugin not authorized");
  });
  const registry = new PluginServiceRegistry({
    list: async () => [...active],
    ensure,
    onCallCompleted: (event) => {
      events.push(event);
      onCallCompleted?.(event);
    },
  });
  const abort = new AbortController();
  const client = registry.createClient({
    sessionId: "test",
    pluginId: "consumer",
    signal: abort.signal,
  });
  return { registry, client, abort, active, ensure, events };
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

  it("provides detached host snapshots of actual registrations", async () => {
    const { registry, client, active } = fixture();
    const dispose = registry.register("provider", {
      name: "rank",
      contract: request.contract,
      description: "Ranks values",
      input: schema,
      output: schema,
      handler: (input) => input,
    });
    active.delete("provider");
    expect(await client.discover(request.contract)).toEqual([]);
    const snapshot = registry.list();
    expect(snapshot).toEqual([
      {
        pluginId: "provider",
        name: "rank",
        contract: request.contract,
        description: "Ranks values",
      },
    ]);
    Object.assign(snapshot[0]!, { name: "mutated", contract: "mutated" });
    expect(registry.list()[0]).toMatchObject({
      name: "rank",
      contract: request.contract,
    });
    active.add("provider");
    await expect(client.call(request)).resolves.toEqual(request.input);
    dispose();
    expect(registry.list()).toEqual([]);
  });

  it("correlates nested calls and identifies each immediate caller", async () => {
    const { registry, client, active, events } = fixture();
    active.add("inner");
    registry.register("inner", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (input, context) => {
        expect(context.callerPluginId).toBe("provider");
        expect(context.services).not.toHaveProperty("list");
        return input;
      },
    });
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: async (_input, context) =>
        (await context.services.call({ ...request, pluginId: "inner" })) as {
          value: number;
        },
    });
    await client.call(request);
    expect(events).toHaveLength(2);
    const [inner, outer] = events;
    expect(outer).toMatchObject({
      sessionId: "test",
      callerPluginId: "consumer",
      providerPluginId: "provider",
      outcome: "success",
    });
    expect(outer).not.toHaveProperty("parentCallId");
    expect(outer).not.toHaveProperty("errorCode");
    expect(inner).toMatchObject({
      sessionId: "test",
      parentCallId: outer!.callId,
      callerPluginId: "provider",
      providerPluginId: "inner",
      name: "rank",
      contract: request.contract,
      outcome: "success",
    });
    expect(inner!.callId).not.toBe(outer!.callId);
    expect(outer!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits fixed error codes without retaining sensitive values", async () => {
    const { registry, client, active, events } = fixture();
    const secret = "sensitive-provider-output-and-credentials";
    const dispose = registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: z.unknown(),
      output: z.unknown(),
      handler: () => {
        throw new Error(secret);
      },
    });
    await expect(client.call(request, { timeoutMs: 0 })).rejects.toThrow();
    active.delete("provider");
    await expect(client.call(request)).rejects.toThrow();
    active.add("provider");
    await expect(
      client.call({ ...request, contract: "missing@1" }),
    ).rejects.toThrow();
    await expect(
      client.call({ ...request, input: { secret } }),
    ).rejects.toThrow(secret);
    dispose();
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: async (_input, context) =>
        (await context.services.call(request)) as { value: number },
    });
    await expect(client.call(request)).rejects.toThrow("cycle");
    expect(events.map((event) => event.errorCode)).toEqual([
      "invalid-options",
      "admission-error",
      "unavailable",
      "invocation-error",
      "cycle-or-depth-limit",
      "invocation-error",
    ]);
    expect(events.every((event) => event.outcome === "error")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
    for (const event of events) {
      expect(event).not.toHaveProperty("input");
      expect(event).not.toHaveProperty("output");
      expect(event).not.toHaveProperty("error");
      expect(event).not.toHaveProperty("gateway");
    }
  });

  it("reports only registered or admitted service identities", async () => {
    const { registry, client, active, events } = fixture();
    const secret = "sensitive-user-content";
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (input) => input,
    });
    active.delete("provider");
    await expect(client.call(request)).rejects.toThrow("Plugin not authorized");
    expect(events[0]).toMatchObject({
      providerPluginId: "provider",
      name: "rank",
      contract: request.contract,
      errorCode: "admission-error",
    });

    active.add("provider");
    await expect(
      client.call({ ...request, name: secret, contract: secret }),
    ).rejects.toThrow("unavailable");
    expect(events[1]).toMatchObject({
      providerPluginId: "provider",
      name: "<unavailable>",
      contract: "<unavailable>",
    });

    await expect(
      client.call({
        ...request,
        pluginId: secret,
        name: secret,
        contract: secret,
      }),
    ).rejects.toThrow("Plugin not authorized");
    expect(events[2]).toMatchObject({
      providerPluginId: "<unavailable>",
      name: "<unavailable>",
      contract: "<unavailable>",
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("keeps host correlation and admission scope private across nested calls", async () => {
    const events: PluginServiceCallEvent[] = [];
    let scope = "original-incarnation";
    const registry = new PluginServiceRegistry({
      list: async () => ["consumer", "provider"],
      ensure: async () => scope,
      onCallCompleted: (event) => events.push(event),
    });
    const client = registry.createClient({
      sessionId: "test",
      turnId: "turn-1",
      runtimeId: "consumer-runtime",
      pluginId: "consumer",
      signal: new AbortController().signal,
    });
    registry.register("provider", {
      name: "inner",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (input, context) => {
        expect(context).not.toHaveProperty("diagnosticScope");
        expect(context).not.toHaveProperty("turnId");
        return input;
      },
    });
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: async (_input, context) => {
        scope = "replacement-incarnation";
        return (await context.services.call({ ...request, name: "inner" })) as {
          value: number;
        };
      },
    });
    await client.call(request);
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(event).toMatchObject({
        diagnosticScope: "original-incarnation",
        turnId: "turn-1",
        runtimeId: "consumer-runtime",
      });
    await expect(
      client.call(request, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(events[2]).toMatchObject({ outcome: "cancelled" });
    expect(events[2]).not.toHaveProperty("diagnosticScope");
  });

  it("snapshots diagnostic identity before the caller can mutate a request", async () => {
    const { registry, client, events } = fixture();
    const mutableRequest = { ...request };
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (input) => {
        Object.assign(mutableRequest, {
          pluginId: { secret: "sensitive-input" },
          name: "mutated",
        });
        return input;
      },
    });
    await client.call(mutableRequest);
    expect(events[0]).toMatchObject({
      providerPluginId: "provider",
      name: "rank",
    });
    expect(JSON.stringify(events)).not.toContain("sensitive-input");
  });

  it("isolates observer failures from successful and failed calls", async () => {
    const { registry, client, events } = fixture(() => {
      throw new Error("observer unavailable");
    });
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (input) => input,
    });
    await expect(client.call(request)).resolves.toEqual(request.input);
    await expect(client.call({ ...request, name: "missing" })).rejects.toThrow(
      "unavailable",
    );
    expect(events.map((event) => event.outcome)).toEqual(["success", "error"]);
  });

  it("does not wait for or propagate an async observer rejection", async () => {
    let rejectObservation!: (error: Error) => void;
    const registry = new PluginServiceRegistry({
      list: async () => ["consumer", "provider"],
      ensure: async () => {},
      onCallCompleted: () =>
        new Promise<void>((_resolve, reject) => {
          rejectObservation = reject;
        }),
    });
    registry.register("provider", {
      name: "rank",
      contract: request.contract,
      input: schema,
      output: schema,
      handler: (input) => input,
    });
    const client = registry.createClient({
      sessionId: "test",
      pluginId: "consumer",
      signal: new AbortController().signal,
    });
    await expect(client.call(request)).resolves.toEqual(request.input);
    rejectObservation(new Error("observer unavailable"));
    await Promise.resolve();
  });

  it("cancels an uncooperative call promptly while the caller can continue", async () => {
    const { registry, client, abort, events } = fixture();
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
    expect(events.map((event) => event.outcome)).toEqual([
      "cancelled",
      "success",
    ]);
    expect(events[0]!.errorCode).toBe("cancelled");
    expect(JSON.stringify(events)).not.toContain("cancel one call");
  });

  it("applies a call deadline to nested calls and lent gateway and HTTP work", async () => {
    vi.useFakeTimers();
    const { registry, abort, events } = fixture();
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
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.outcome === "timeout")).toBe(true);
    expect(events.every((event) => event.errorCode === "timeout")).toBe(true);
  });

  it("stops waiting for admission and never invokes a provider after cancellation", async () => {
    let admit!: () => void;
    const ensure = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
    );
    const events: PluginServiceCallEvent[] = [];
    const registry = new PluginServiceRegistry({
      list: async () => [],
      ensure,
      onCallCompleted: (event) => events.push(event),
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
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "cancelled",
      errorCode: "cancelled",
    });
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
