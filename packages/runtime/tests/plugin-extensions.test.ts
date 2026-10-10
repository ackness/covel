import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineExtensionPoint,
  promptHistoryTransformV1,
  uiSlotV1,
  type ExtensionMode,
  type ExtensionPluginDataRecord,
  type PluginExtensionContext,
} from "@covel/shared";
import { PluginExtensionHost } from "../src/plugin-extensions.js";
import {
  PluginServiceRegistry,
  type PluginServiceCallEvent,
} from "../src/plugin-services.js";
import { createTurnEmitter } from "../src/trace/turn-emitter.js";
import { createMemoryStore } from "@covel/store/memory";

function fixture<M extends ExtensionMode>(
  mode: M,
  onError: "skip" | "fail-turn" = "skip",
) {
  const point = defineExtensionPoint({
    id: "test.value@1",
    mode,
    onError,
    timeoutMs: 20,
    input: z.object({ value: z.number(), turnId: z.string() }),
    output: z.object({ value: z.number() }),
  });
  const active = new Set(["alpha", "beta", "inner"]);
  const approved = new Set(active);
  const events: PluginServiceCallEvent[] = [];
  const ensure = vi.fn(async (_session: string, id: string) => {
    if (!active.has(id) || !approved.has(id)) throw new Error("Not admitted");
  });
  const services = new PluginServiceRegistry({
    list: async () => [...active].filter((id) => approved.has(id)),
    ensure,
    onCallCompleted: (event) => {
      events.push(event);
    },
  });
  const host = new PluginExtensionHost(services, [point]);
  const abort = new AbortController();
  const snapshot: ExtensionPluginDataRecord[] = [
    {
      pluginId: "alpha",
      sessionId: "session",
      namespace: "values",
      key: "one",
      value: { number: 1 },
      updatedAt: "2026-01-01",
    },
    {
      pluginId: "beta",
      sessionId: "session",
      namespace: "values",
      key: "two",
      value: { number: 2 },
    },
    {
      pluginId: "alpha",
      sessionId: "other-session",
      namespace: "values",
      key: "secret",
      value: "secret",
    },
  ];
  // Deliberately unfiltered: the host enforces plugin/namespace/session scope.
  const readPluginData = vi.fn(async () => snapshot);
  const execution = () =>
    host.createExecution({
      sessionId: "session",
      locale: "en",
      turnId: "turn",
      signal: abort.signal,
      readPluginData,
    });
  return {
    point,
    active,
    approved,
    events,
    ensure,
    services,
    host,
    abort,
    snapshot,
    readPluginData,
    execution,
  };
}

const input = { value: 2, turnId: "turn" };

describe("kernel extension execution", () => {
  it("records final slot validation once and persists the same sanitized failure before returning skip", async () => {
    const events: PluginServiceCallEvent[] = [];
    const services = new PluginServiceRegistry({
      ensure: async () => "private-incarnation",
      list: async () => ["alpha"],
      onCallCompleted: (event) => {
        events.push(event);
      },
    });
    const host = new PluginExtensionHost(services);
    const declaration = {
      point: uiSlotV1.id,
      id: "backdrop",
      slot: "stage.backdrop@1",
    };
    host.register("alpha", declaration, {
      handler: () => ({ actors: [] }),
    });
    declaration.slot = "stage.cast@1";
    const records: unknown[] = [];
    const store = createMemoryStore();
    let persist!: () => void;
    const persisted = new Promise<void>((resolve) => {
      persist = resolve;
    });
    const emitter = createTurnEmitter({
      sessionId: "session",
      turnId: "turn",
      traceId: "flow",
      store: {
        addTraceEvent: async (record) => {
          await persisted;
          await store.addTraceEvent(record);
          records.push(record);
        },
      },
    });
    const execution = host.createExecution({
      sessionId: "session",
      locale: "en",
      turnId: "turn",
      signal: new AbortController().signal,
      readPluginData: async () => [],
      emitter,
    });
    let finished = false;
    const result = execution
      .run(uiSlotV1, { slot: "stage.backdrop@1", previous: null, events: [] })
      .then((value) => {
        finished = true;
        return value;
      });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(finished).toBe(false);
    expect(events[0]).toMatchObject({
      outcome: "error",
      errorCode: "output-validation",
      extension: {
        point: "ui.slot@1",
        id: "backdrop",
        slot: "stage.backdrop@1",
      },
    });
    persist();
    await expect(result).resolves.toBeNull();
    await expect(
      execution.run(uiSlotV1, {
        slot: "stage.backdrop@1",
        previous: null,
        events: [],
      }),
    ).resolves.toBeNull();
    expect(events).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        type: "plugin.service.completed",
        traceId: "flow",
        turnId: "turn",
        payload: expect.objectContaining({
          callId: events[0]!.callId,
          outcome: "error",
          errorCode: "output-validation",
          seq: 0,
        }),
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("private-incarnation");
    expect(JSON.stringify(records)).not.toContain("actors");
    expect(await store.listTraceEvents("session")).toEqual(records);
    await store.close();
  });

  it("fails required final attribution once and isolates a failing trace observer", async () => {
    const { services, events } = fixture("single", "fail-turn");
    const point = defineExtensionPoint({
      id: "test.attributed@1",
      mode: "single",
      onError: "fail-turn",
      timeoutMs: 100,
      input: z.unknown(),
      output: z.number(),
      attributeOutput: () => {
        throw new Error("private-output");
      },
    });
    const host = new PluginExtensionHost(services, [point]);
    host.register(
      "alpha",
      { point: point.id, id: "value" },
      { handler: () => 1 },
    );
    const emit = vi.fn(async () => {
      throw new Error("private-store-error");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execution = host.createExecution({
      sessionId: "session",
      locale: "en",
      signal: new AbortController().signal,
      readPluginData: async () => [],
      emitter: { sessionId: "session", turnId: "turn", emit },
    });
    await expect(execution.run(point, null)).rejects.toThrow(
      "output failed validation",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "error",
      errorCode: "output-validation",
    });
    expect(emit).toHaveBeenCalledOnce();
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private-");
    expect(warning).toHaveBeenCalledWith(
      "[plugin-services] trace observation failed",
      expect.objectContaining({ callId: events[0]!.callId }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-");
    warning.mockRestore();
  });
  it("composes pipelines deterministically while retaining input-only fields", async () => {
    const { point, host, execution } = fixture("pipeline");
    const seen: string[] = [];
    for (const [pluginId, id, order, value] of [
      ["beta", "first", 0, 2],
      ["alpha", "second", 1, 3],
      ["alpha", "first", 0, 5],
    ] as const) {
      host.register(
        pluginId,
        { point: point.id, id, order },
        {
          handler: (current: typeof input) => {
            expect(current.turnId).toBe("turn");
            seen.push(`${pluginId}/${id}`);
            return { value: current.value * value };
          },
        },
      );
    }
    await expect(execution().run(point, input)).resolves.toEqual({ value: 60 });
    expect(seen).toEqual(["alpha/first", "beta/first", "alpha/second"]);
  });

  it("collects independent results and skips invalid output with sanitized diagnostics", async () => {
    const { point, host, execution, events } = fixture("collect");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    host.register(
      "alpha",
      { point: point.id, id: "bad" },
      { handler: () => ({ value: "secret-invalid-output" }) },
    );
    host.register(
      "beta",
      { point: point.id, id: "good" },
      { handler: (value: typeof input) => ({ value: value.value + 1 }) },
    );
    await expect(execution().run(point, input)).resolves.toEqual([
      { value: 3 },
    ]);
    expect(events.map((event) => event.outcome)).toEqual(["error", "success"]);
    expect(JSON.stringify(events)).not.toContain("secret-invalid-output");
    // The skip names the provider and the point in the server log.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      "skipped provider alpha/bad of test.value@1 for session",
    );
    warn.mockRestore();
  });

  it("tells the caller why a provider was skipped", async () => {
    const { point, host, abort, readPluginData } = fixture("collect");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    host.register(
      "alpha",
      { point: point.id, id: "failing" },
      {
        handler: () => {
          throw new Error("fast model unreachable");
        },
      },
    );
    host.register(
      "beta",
      { point: point.id, id: "good" },
      { handler: (value: typeof input) => ({ value: value.value + 1 }) },
    );
    const failures: unknown[] = [];
    const execution = host.createExecution({
      sessionId: "session",
      locale: "en",
      turnId: "turn",
      signal: abort.signal,
      readPluginData,
      onProviderError: (failure) => failures.push(failure),
    });
    await expect(execution.run(point, input)).resolves.toEqual([{ value: 3 }]);
    expect(failures).toEqual([
      {
        pluginId: "alpha",
        providerId: "failing",
        point: point.id,
        error: expect.objectContaining({ message: "fast model unreachable" }),
      },
    ]);
    warn.mockRestore();
  });

  it("returns undefined for an empty single point and rejects active conflicts", async () => {
    const { point, host, execution, active } = fixture("single");
    await expect(execution().run(point, input)).resolves.toBeUndefined();
    const handler = vi.fn(() => ({ value: 1 }));
    host.register("alpha", { point: point.id, id: "one" }, { handler });
    await expect(execution().run(point, input)).resolves.toEqual({ value: 1 });
    host.register("beta", { point: point.id, id: "two" }, { handler });
    await expect(execution().run(point, input)).rejects.toThrow(
      "Conflicting providers",
    );
    expect(handler).toHaveBeenCalledTimes(1);
    active.delete("beta");
    await expect(execution().run(point, input)).resolves.toEqual({ value: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not invoke inactive or unapproved providers", async () => {
    const { point, host, execution, active, approved, events } =
      fixture("pipeline");
    const handler = vi.fn(() => ({ value: 10 }));
    host.register("alpha", { point: point.id, id: "one" }, { handler });
    host.register("beta", { point: point.id, id: "two" }, { handler });
    active.delete("alpha");
    approved.delete("beta");
    await expect(execution().run(point, input)).resolves.toEqual({ value: 2 });
    expect(handler).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("deduplicates concurrent equivalent input within an execution and isolates cached values", async () => {
    const { point, host, execution, events } = fixture("pipeline");
    const handler = vi.fn((value: typeof input) => ({
      value: value.value + 1,
    }));
    host.register("alpha", { point: point.id, id: "one" }, { handler });
    const run = execution();
    const [first, second] = await Promise.all([
      run.run(point, input),
      run.run(point, { turnId: "turn", value: 2 }),
    ]);
    first.value = 500;
    expect(second).toEqual({ value: 3 });
    await expect(run.run(point, input)).resolves.toEqual({ value: 3 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    await execution().run(point, input);
    expect(handler).toHaveBeenCalledTimes(2);
    await run.run(point, { ...input, value: 3 });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("reads detached, own-plugin execution snapshots and expires retained data access", async () => {
    const { point, host, execution, snapshot, readPluginData } =
      fixture("pipeline");
    let retained!: PluginExtensionContext;
    host.register(
      "alpha",
      { point: point.id, id: "one" },
      {
        handler: async (_input, context) => {
          retained = context;
          const list = await context.pluginData.list("values");
          expect(list).toHaveLength(1);
          expect(list[0]?.updatedAt).toBe("2026-01-01");
          (list[0]!.value as { number: number }).number = 200;
          // Later source changes do not leak into the execution's first read.
          (snapshot[0]!.value as { number: number }).number = 100;
          expect(
            await context.pluginData.get("values", "secret"),
          ).toBeUndefined();
          const row = await context.pluginData.get("values", "one");
          expect(context).toMatchObject({
            sessionId: "session",
            locale: "en",
            turnId: "turn",
          });
          expect(context.pluginData).not.toHaveProperty("set");
          return { value: (row!.value as { number: number }).number };
        },
      },
    );
    const run = execution();
    await expect(run.run(point, input)).resolves.toEqual({ value: 1 });
    expect(readPluginData).toHaveBeenCalledTimes(1);
    expect(readPluginData).toHaveBeenCalledWith("alpha", "values");
    await expect(retained.pluginData.list("values")).rejects.toThrow(
      "completed",
    );
  });

  it("never exposes hidden world data to extension handlers", async () => {
    const { point, host, execution, readPluginData } = fixture("pipeline");
    host.register(
      "alpha",
      { point: point.id, id: "one" },
      {
        handler: async (_input, context) => {
          expect(await context.pluginData.list("_hidden.events")).toEqual([]);
          expect(
            await context.pluginData.get("_hidden.events", "one"),
          ).toBeUndefined();
          return { value: 1 };
        },
      },
    );
    await expect(execution().run(point, input)).resolves.toEqual({ value: 1 });
    expect(readPluginData).not.toHaveBeenCalled();
  });

  it("reuses timeout cancellation and skips only the failing provider", async () => {
    const { point, host, execution, events } = fixture("pipeline");
    let signal!: AbortSignal;
    host.register(
      "alpha",
      { point: point.id, id: "slow" },
      {
        handler: (_input, context) => {
          signal = context.signal;
          return new Promise(() => {});
        },
      },
    );
    host.register(
      "beta",
      { point: point.id, id: "good" },
      { handler: () => ({ value: 3 }) },
    );
    await expect(execution().run(point, input)).resolves.toEqual({ value: 3 });
    expect(signal.aborted).toBe(true);
    expect(events.map((event) => event.outcome)).toEqual([
      "timeout",
      "success",
    ]);
  });

  it("propagates execution cancellation even when the point skips failures", async () => {
    const { point, host, execution, abort, events } = fixture("pipeline");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    host.register(
      "alpha",
      { point: point.id, id: "slow" },
      {
        handler: () => {
          started();
          return new Promise(() => {});
        },
      },
    );
    const promise = execution().run(point, input);
    await ready;
    abort.abort(new Error("Execution cancelled"));
    await expect(promise).rejects.toThrow("Execution cancelled");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events[0]?.outcome).toBe("cancelled");
  });

  it("fails required points and never admits the kernel as a plugin", async () => {
    const { point, host, execution, ensure } = fixture("pipeline", "fail-turn");
    host.register(
      "alpha",
      { point: point.id, id: "bad" },
      {
        handler: () => {
          throw new Error("provider failed");
        },
      },
    );
    await expect(execution().run(point, input)).rejects.toThrow(
      "provider failed",
    );
    expect(ensure).toHaveBeenCalledWith("session", "alpha");
    expect(ensure).not.toHaveBeenCalledWith("session", "__kernel");
  });

  it("does not lend kernel admission or private data to nested services", async () => {
    const { point, host, execution, services, ensure, approved } = fixture(
      "pipeline",
      "fail-turn",
    );
    const inner = vi.fn((_input: unknown, context: unknown) => {
      expect(context).not.toHaveProperty("pluginData");
      return { value: 8 };
    });
    services.register("inner", {
      name: "read",
      contract: "test.read@1",
      input: z.unknown(),
      output: z.object({ value: z.number() }),
      handler: inner,
    });
    host.register(
      "alpha",
      { point: point.id, id: "one" },
      {
        handler: async (_input, context) => {
          approved.delete("alpha");
          return context.services.call({
            pluginId: "inner",
            name: "read",
            contract: "test.read@1",
            input: null,
          });
        },
      },
    );
    await expect(execution().run(point, input)).rejects.toThrow("Not admitted");
    expect(inner).not.toHaveBeenCalled();
    expect(
      ensure.mock.calls.filter(([, pluginId]) => pluginId === "alpha"),
    ).toHaveLength(2);
  });

  it("prevents plugin service clients from calling extension handlers directly", async () => {
    const { point, host, services, abort } = fixture("pipeline");
    const handler = vi.fn(() => ({ value: 4 }));
    host.register("alpha", { point: point.id, id: "one" }, { handler });
    const client = services.createClient({
      sessionId: "session",
      pluginId: "beta",
      signal: abort.signal,
    });
    expect(await client.discover(point.id)).toEqual([]);
    await expect(
      client.call({
        pluginId: "alpha",
        name: host.list()[0]!.name,
        contract: point.id,
        input,
      }),
    ).rejects.toThrow("unavailable");
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves history provenance and metadata when no provider is active", async () => {
    const { services, abort } = fixture("pipeline");
    const host = new PluginExtensionHost(services);
    const execution = host.createExecution({
      sessionId: "session",
      locale: "en",
      signal: abort.signal,
      readPluginData: async () => [],
    });
    const message = {
      sessionId: "session",
      sourceType: "runtime",
      role: "assistant",
      content: "hello",
      turnId: "old",
      metadata: { block: { type: "asset.generate" } },
      id: "message",
      createdAt: "2026-01-01",
      order: 4,
      sourceRuntimeId: "writer/narrate",
    };
    await expect(
      execution.run(promptHistoryTransformV1, {
        messages: [message],
        turnId: "turn",
      }),
    ).resolves.toEqual({ messages: [message] });
  });
});
