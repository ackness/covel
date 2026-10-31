/**
 * A tool calls other plugins' services through `context.services`, with the
 * rules of a function runtime's `ctx.services`: the tool's plugin and
 * runtime are the caller, the call shares the tool's deadline and read
 * scope, and a failure the provider owns is answered as refused, not as the
 * caller's failed call.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import { defaultSessionSeats, ToolError } from "@covel/shared";
import { tool, type ToolModule } from "@covel/tools";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import {
  createToolExecutor,
  type ToolCallContext,
} from "../src/agent-loop/tool-executor.js";
import { createPluginDataVisibility } from "../src/function-runtime/upstream-plugin-data.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

const SESSION = "session";
const TURN = "turn";
const timestamp = "2026-10-30T00:00:00.000Z";
const READ = { pluginId: "provider", name: "read", contract: "fixture.read@1" };

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const active = new Set(["caller", "provider", "inner"]);
  const registry = new PluginServiceRegistry({
    list: async () => [...active],
    ensure: async (_sessionId, pluginId) => {
      if (!active.has(pluginId)) throw new Error(`Not active: ${pluginId}`);
    },
  });
  const emitter = makeEmitterSpy(SESSION, TURN);
  const context = (extra: Partial<ToolCallContext> = {}): ToolCallContext => ({
    sessionId: SESSION,
    turnId: TURN,
    pluginId: "caller",
    runtimeId: "caller/agent",
    services: registry,
    emitter,
    ...extra,
  });
  const run = async (
    module: ToolModule,
    extra: Partial<ToolCallContext> = {},
    args: unknown = {},
  ) => {
    const executor = createToolExecutor({ findTool: () => module });
    try {
      return await executor.execute(
        {
          toolCallId: "call-1",
          name: module.name,
          arguments: JSON.stringify(args),
        },
        context(extra),
      );
    } finally {
      await executor.close();
    }
  };
  const serviceEvents = () =>
    emitter.events
      .filter((event) => event.type === "plugin.service.completed")
      .map((event) => event.payload);
  return { active, registry, emitter, context, run, serviceEvents };
}

const caller = (
  execute: ToolModule["execute"],
  extra: Partial<Parameters<typeof tool>[0]> = {},
) =>
  tool({
    name: "ask",
    description: "Ask the provider",
    parameters: z.object({}).passthrough(),
    execute: (params, ctx) => execute(params, ctx),
    ...extra,
  });

describe("context.services in a tool", () => {
  it("calls a provider as the tool's plugin and runtime, linked to the tool call", async () => {
    const { registry, run, serviceEvents } = fixture();
    registry.register("inner", {
      name: "leaf",
      contract: "fixture.leaf@1",
      input: z.unknown(),
      output: z.string(),
      handler: () => "leaf",
    });
    registry.register("provider", {
      ...READ,
      input: z.object({ key: z.string() }),
      output: z.object({ value: z.string(), seenBy: z.string() }),
      handler: async ({ key }, ctx) => ({
        value: `${key}:${String(
          await ctx.services.call({
            pluginId: "inner",
            name: "leaf",
            contract: "fixture.leaf@1",
            input: null,
          }),
        )}`,
        seenBy: ctx.callerPluginId,
      }),
    });

    const result = await run(
      caller((_params, ctx) =>
        ctx.services!.call({ ...READ, input: { key: "sword" } }),
      ),
    );

    expect(result.success).toBe(true);
    expect(result.parsedResult).toEqual({
      value: "sword:leaf",
      seenBy: "caller",
    });
    const [nested, outer] = serviceEvents();
    expect(outer).toMatchObject({
      callerPluginId: "caller",
      providerPluginId: "provider",
      runtimeId: "caller/agent",
      toolCallId: "call-1",
      outcome: "success",
    });
    expect(nested).toMatchObject({
      callerPluginId: "provider",
      providerPluginId: "inner",
      toolCallId: "call-1",
      parentCallId: outer!.callId,
    });
  });

  it("is absent without a service registry", async () => {
    const { run } = fixture();
    let seen: unknown = "unset";
    await run(
      caller(async (_params, ctx) => {
        seen = ctx.services;
        return {};
      }),
      { services: undefined },
    );
    expect(seen).toBeUndefined();
  });

  it("cancels a call the tool did not await and settles it before answering", async () => {
    const { registry, run } = fixture();
    let aborted: boolean | undefined;
    let settled = false;
    registry.register("provider", {
      ...READ,
      input: z.unknown(),
      output: z.unknown(),
      handler: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(ctx.signal.reason);
          });
        }),
    });
    let call: Promise<unknown> | undefined;
    const result = await run(
      caller(async (_params, ctx) => {
        call = ctx.services!.call({ ...READ, input: null });
        call.then(
          () => (settled = true),
          () => (settled = true),
        );
        // Let the provider start before the tool returns.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { done: true };
      }),
    );
    expect(result.success).toBe(true);
    expect(aborted).toBe(true);
    expect(settled).toBe(true);
  });

  it("aborts the service call when the tool times out", async () => {
    const { registry, run, serviceEvents } = fixture();
    let aborted = false;
    registry.register("provider", {
      ...READ,
      input: z.unknown(),
      output: z.unknown(),
      handler: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(ctx.signal.reason);
          });
        }),
    });
    const result = await run(
      caller((_params, ctx) => ctx.services!.call({ ...READ, input: null }), {
        timeoutMs: 20,
      }),
    );
    expect(result.error?.code).toBe("timeout");
    expect(result.refused).toBeUndefined();
    expect(result.serviceFailure).toBeUndefined();
    await vi.waitFor(() => expect(aborted).toBe(true));
    await vi.waitFor(() =>
      expect(serviceEvents()[0]).toMatchObject({ outcome: "cancelled" }),
    );
  });

  it("reads upstream writes through the tool's read scope and records the producer", async () => {
    const { registry } = fixture();
    const store = createMemoryStore();
    await store.createSession({
      id: SESSION,
      locale: "en",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      activePlugins: ["caller", "provider"],
      completedPlayerTurns: 0,
      seats: defaultSessionSeats(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const write = (pluginId: string, value: string) => ({
      id: `write-${pluginId}`,
      type: "plugin.data" as const,
      sessionId: SESSION,
      turnId: TURN,
      timestamp,
      source: { pluginId, runtimeId: `${pluginId}/writer` },
      payload: { namespace: "items", key: "sword", value },
    });
    const read = (pluginId: string) =>
      registry.register(pluginId, {
        name: "read",
        contract: `fixture.${pluginId}@1`,
        input: z.unknown(),
        output: z.unknown(),
        handler: (_input, ctx) => ctx.pluginData.get("items", "sword"),
      });
    read("provider");
    read("caller");
    const visibility = createPluginDataVisibility({
      pluginId: "caller",
      runtimeId: "caller/agent",
      runId: "caller-run",
      upstreamOf: (pluginId) =>
        pluginId === "provider"
          ? [
              {
                runId: "producer-run",
                runtimeId: "provider/writer",
                proposal: write("provider", "upstream"),
              },
            ]
          : [],
    });
    const executor = createToolExecutor({
      store,
      findTool: () =>
        caller(async (_params, ctx) => ({
          provider: await ctx.services!.call({
            pluginId: "provider",
            name: "read",
            contract: "fixture.provider@1",
            input: null,
          }),
          own: await ctx.services!.call({
            pluginId: "caller",
            name: "read",
            contract: "fixture.caller@1",
            input: null,
          }),
        })),
    });
    try {
      const result = await executor.execute(
        { toolCallId: "call-1", name: "ask", arguments: "{}" },
        {
          sessionId: SESSION,
          turnId: TURN,
          pluginId: "caller",
          runtimeId: "caller/agent",
          services: registry,
          pluginDataVisibility: visibility,
          pendingProposals: [write("caller", "buffered")],
        },
      );
      expect(result.parsedResult).toEqual({
        provider: "upstream",
        own: "buffered",
      });
      // The caller's own buffered write is no dependency on another run.
      expect([...visibility.recorder]).toEqual(["producer-run"]);
    } finally {
      await executor.close();
      await store.close();
    }
  });
});

describe("a service failure inside a tool", () => {
  const failing = (
    registry: PluginServiceRegistry,
    definition: Partial<Parameters<PluginServiceRegistry["register"]>[1]>,
  ) =>
    registry.register("provider", {
      ...READ,
      input: z.unknown(),
      output: z.unknown(),
      handler: () => null,
      ...definition,
    } as Parameters<PluginServiceRegistry["register"]>[1]);
  const ask = caller((_params, ctx) =>
    ctx.services!.call({ ...READ, input: { key: "sword" } }),
  );

  it("answers an unavailable provider as unavailable and refused", async () => {
    const { run, active, registry } = fixture();
    failing(registry, {});
    active.delete("provider");
    const result = await run(ask);
    expect(result.error).toEqual({
      code: "unavailable",
      message:
        'The tool "ask" is unavailable: the service it calls is not available in this session.',
    });
    expect(result.refused).toBe(true);
    expect(result.serviceFailure).toMatchObject({
      providerPluginId: "provider",
      errorCode: "admission-error",
    });
    expect(result.result).not.toContain("provider");
  });

  it("answers a service the provider does not register as unavailable", async () => {
    const { run, registry } = fixture();
    failing(registry, { contract: "fixture.other@1" });
    const result = await run(ask);
    expect(result.error?.code).toBe("unavailable");
    expect(result.refused).toBe(true);
    expect(result.serviceFailure?.errorCode).toBe("unavailable");
  });

  it("passes a provider's ToolError through, refused", async () => {
    const { run, registry } = fixture();
    failing(registry, {
      handler: () => {
        throw new ToolError("not-found", "m", { hint: "h" });
      },
    });
    const result = await run(ask);
    expect(result.error).toEqual({
      code: "not-found",
      message: "m",
      hint: "h",
    });
    expect(result.refused).toBe(true);
  });

  it("answers a rejected input as invalid-input, not refused", async () => {
    const { run, registry, serviceEvents } = fixture();
    failing(registry, {
      inputSchema: { type: "object" },
      input: z.object({ key: z.number() }),
    });
    const result = await run(ask);
    expect(result.error?.code).toBe("invalid-input");
    expect(result.error?.message).toContain("key:");
    expect(result.refused).toBeUndefined();
    expect(result.serviceFailure).toBeUndefined();
    expect(serviceEvents()[0]).toMatchObject({
      outcome: "error",
      errorCode: "input-validation",
    });
  });

  it("answers an invalid result as internal and refused", async () => {
    const { run, registry } = fixture();
    failing(registry, { output: z.string(), handler: () => 42 });
    const result = await run(ask);
    expect(result.error).toEqual({
      code: "internal",
      message: "The service returned an invalid result.",
    });
    expect(result.refused).toBe(true);
  });

  it("answers a plain provider error with one line and no IDs", async () => {
    const { run, registry } = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    failing(registry, {
      handler: () => {
        throw new Error(
          "row 123e4567-e89b-12d3-a456-426614174000 broke\nsecond line",
        );
      },
    });
    const result = await run(ask);
    expect(result.error).toEqual({
      code: "internal",
      message: 'Tool "ask" failed: row <id> broke',
    });
    expect(result.refused).toBe(true);
  });

  it("answers the caller's own abort as cancelled, not refused", async () => {
    const { run, registry } = fixture();
    const controller = new AbortController();
    failing(registry, {
      handler: () => {
        controller.abort(new Error("player stopped"));
        return new Promise(() => {});
      },
    });
    const result = await run(ask, { signal: controller.signal });
    expect(result.error?.code).toBe("cancelled");
    expect(result.refused).toBeUndefined();
  });
});
