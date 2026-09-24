import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
