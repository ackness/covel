import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
} from "@covel/plugin-loader";
import {
  createMemoryStore,
  type DataStore,
  type SessionRecord,
} from "@covel/store";
import { traceRoutes } from "../../src/routes/api/traces.js";

function makeApp(
  store: DataStore,
  options?: {
    registry?: PluginRegistry;
    builtinToolNames?: readonly string[];
  },
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    if (options?.registry) {
      c.set("pluginRegistry" as never, options.registry);
    }
    if (options?.builtinToolNames) {
      c.set("builtinToolNames" as never, options.builtinToolNames);
    }
    await next();
  });
  app.route("/api/traces", traceRoutes);
  return app;
}

function makeSession(
  id: string,
  overrides?: Partial<SessionRecord>,
): SessionRecord {
  const now = new Date().toISOString();
  return {
    id,
    worldId: "world-1",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    activePlugins: [],
    metadata: {
      approvalScopeNonce: globalThis.crypto.randomUUID(),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSummary(overrides?: Partial<PluginSummary>): PluginSummary {
  return {
    id: "image-plugin",
    name: "Image Plugin",
    description: "Image plugin",
    pluginType: "plugin",
    runtimeCount: 1,
    ...overrides,
  };
}

function makeEntry(
  overrides?: Partial<PluginRegistryEntry>,
): PluginRegistryEntry {
  const parsed = {
    manifest: {
      name: "image-plugin",
      description: "Image plugin runtime",
      pluginType: "plugin",
      outputKind: "plugin",
      runtimeType: "function",
      trigger: { type: "manual" },
      capabilities: ["image-generation"],
      input: {
        inject: [
          {
            kind: "plugin-data",
            namespace: "images",
            as: "<images>",
            format: "summary",
          },
        ],
      },
      dataSchemas: {
        images: {
          namespace: "images",
          schemaVersion: 1,
          acceptsWorldData: true,
          schema: "./schemas/images.json",
        },
      },
      tools: {
        builtin: ["plugin-data-get"],
        plugin: ["save-image"],
      },
      ui: {
        right: ["./ui/panel.json"],
      },
    },
    promptTemplate: "",
    rawFrontmatter: {},
  };

  return {
    id: "image-plugin",
    summary: makeSummary(),
    manifest: parsed,
    manifests: [parsed],
    dataSchemas: {
      images: {
        namespace: "images",
        schemaVersion: 1,
        acceptsWorldData: true,
        schema: "./schemas/images.json",
      },
    },
    loadedRuntimes: new Map(),
    status: "registered",
    ...overrides,
  };
}

describe("traceRoutes", () => {
  it("lists stored trace events without synthesizing compatibility events", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession("sess-trace"));
    const ref = {
      id: "a".repeat(64),
      mime: "image/png",
      size: 10,
    };
    await store.addTraceEvent({
      id: "trace-1",
      sessionId: "sess-trace",
      type: "asset.generated",
      traceId: "trace-1",
      turnId: "turn-1",
      payload: {
        requestId: "req-1",
        seq: 1,
        flowId: "flow-1",
        asset: {
          id: "proposal-1",
          type: "asset.generate",
          sessionId: "sess-trace",
          turnId: "turn-1",
          source: { pluginId: "image-plugin", runtimeId: "image-plugin" },
          ref,
          modality: "image",
          createdAt: "2026-04-26T00:00:00.000Z",
        },
      },
      createdAt: "2026-04-26T00:00:00.000Z",
    });

    const app = makeApp(store);
    const res = await app.request("/api/traces/sess-trace");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(body.count).toBe(1);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      id: "trace-1",
      type: "asset.generated",
      requestId: "req-1",
      traceId: "trace-1",
      sessionId: "sess-trace",
      turnId: "turn-1",
      flowId: "flow-1",
      seq: 1,
    });
    expect(body.events[0].payload.asset).toMatchObject({ ref });
  });

  it("adds stable diagnostics for prompts and failures", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession("sess-diagnostics"));
    await store.addTraceEvent({
      id: "runtime-start-event",
      sessionId: "sess-diagnostics",
      type: "runtime.started",
      traceId: "trace-diagnostics",
      turnId: "turn-diagnostics",
      payload: {
        runtimeId: "story/narrator",
        pluginId: "story",
        stage: "narrative",
      },
      createdAt: "2026-04-25T23:59:59.000Z",
    });
    await store.addTraceEvent({
      id: "prompt-event",
      sessionId: "sess-diagnostics",
      type: "llm.calling",
      traceId: "trace-diagnostics",
      turnId: "turn-diagnostics",
      payload: {
        flowId: "trace-diagnostics",
        seq: 3,
        runtimeId: "story/narrator",
        pluginId: "story",
        slot: "default",
        provider: "openai",
        model: "gpt-test",
        attempt: 2,
        startedAt: "2026-04-25T23:59:40.000Z",
        messages: [
          { role: "system", content: "Follow the world rules." },
          { role: "user", content: "Open the door." },
        ],
        tools: [{ name: "inspect", description: "Inspect a target" }],
      },
      createdAt: "2026-04-26T00:00:00.000Z",
    });
    await store.addTraceEvent({
      id: "failure-event",
      sessionId: "sess-diagnostics",
      type: "tool.failed",
      traceId: "trace-diagnostics",
      turnId: "turn-diagnostics",
      payload: {
        flowId: "trace-diagnostics",
        seq: 4,
        runtimeId: "story/narrator",
        pluginId: "story",
        toolName: "inspect",
        toolCallId: "call-1",
        arguments: { target: "door" },
        code: "INVALID_ARGS",
        error: "target is required",
        details: ["missing target"],
        durationMs: 1001,
      },
      createdAt: "2026-04-26T00:00:01.000Z",
    });

    const app = makeApp(store);
    const res = await app.request("/api/traces/sess-diagnostics/turns");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      turns: Array<{
        events: Array<{
          id: string;
          diagnostic: Record<string, unknown>;
          payload: Record<string, unknown>;
        }>;
      }>;
    };
    const [, calling, failed] = body.turns[0].events;
    expect(calling).toMatchObject({
      id: "prompt-event",
      eventOrder: 1,
      diagnostic: {
        displayType: "llm.calling",
        severity: "info",
        runtimeId: "story/narrator",
        pluginId: "story",
        stage: "narrative",
        provider: "openai",
        model: "gpt-test",
        slot: "default",
        attempt: 2,
        startedAt: "2026-04-25T23:59:40.000Z",
        prompt: {
          contentAvailable: true,
          messageCount: 2,
          roles: ["system", "user"],
          toolCount: 1,
          contentPath: "payload.messages",
        },
      },
    });
    expect(calling.payload.messages).toHaveLength(2);
    expect(failed).toMatchObject({
      id: "failure-event",
      eventOrder: 2,
      diagnostic: {
        displayType: "tool.failed",
        severity: "error",
        runtimeId: "story/narrator",
        pluginId: "story",
        stage: "narrative",
        operation: "inspect",
        durationMs: 1001,
        error: {
          code: "INVALID_ARGS",
          message: "target is required",
          details: ["missing target"],
        },
        tool: {
          name: "inspect",
          callId: "call-1",
          argumentsAvailable: true,
          argumentsPath: "payload.arguments",
          resultAvailable: false,
          success: false,
          durationMs: 1001,
        },
      },
    });
  });

  it("marks slow successful calls with warning severity while preserving error priority", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession("sess-slow"));
    await store.addTraceEvent({
      id: "slow-event",
      sessionId: "sess-slow",
      type: "tool.completed",
      traceId: "trace-slow",
      turnId: "turn-slow",
      payload: {
        toolName: "inspect",
        toolCallId: "call-slow",
        result: { ok: true },
        success: true,
        durationMs: 1000,
      },
      createdAt: "2026-04-26T00:00:00.000Z",
    });
    const app = makeApp(store);
    const res = await app.request("/api/traces/sess-slow");
    const body = (await res.json()) as {
      events: Array<{
        eventOrder: number;
        diagnostic: Record<string, unknown>;
      }>;
    };
    expect(body.events[0]).toMatchObject({
      eventOrder: 0,
      diagnostic: {
        severity: "warning",
        warning: { code: "slow", thresholdMs: 1000 },
        tool: {
          resultAvailable: true,
          resultPath: "payload.result",
          success: true,
        },
      },
    });
  });

  it("does not synthesize asset events from plugin_data records", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession("sess-plugin-data"));
    await store.setPluginData({
      id: "pd-1",
      sessionId: "sess-plugin-data",
      pluginId: "image-plugin",
      namespace: "images",
      key: "img-1",
      value: {
        turnId: "turn-1",
        imageUrl: "https://example.test/old.png",
        mime: "image/png",
      },
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    });

    const app = makeApp(store);
    const res = await app.request("/api/traces/sess-plugin-data");
    const body = (await res.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };

    expect(body.events).toEqual([]);
  });

  it("groups stored trace events by turn", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession("sess-turns"));
    await store.addTraceEvent({
      id: "trace-1",
      sessionId: "sess-turns",
      type: "runtime.started",
      traceId: "trace-1",
      turnId: "turn-1",
      payload: { flowId: "flow-1", requestId: "req-1", seq: 1 },
      createdAt: "2026-04-26T00:00:00.000Z",
    });
    await store.addTraceEvent({
      id: "trace-2",
      sessionId: "sess-turns",
      type: "runtime.completed",
      traceId: "trace-1",
      turnId: "turn-1",
      payload: { flowId: "flow-1", requestId: "req-1", seq: 2 },
      createdAt: "2026-04-26T00:00:01.000Z",
    });

    const app = makeApp(store);
    const res = await app.request("/api/traces/sess-turns/turns");
    const body = (await res.json()) as {
      turns: Array<{
        turnId: string;
        flowId: string;
        traceId: string;
        eventCount: number;
        events: Array<{ type: string }>;
      }>;
    };

    expect(body.turns[0]).toMatchObject({
      turnId: "turn-1",
      flowId: "flow-1",
      traceId: "trace-1",
      eventCount: 2,
      events: [{ type: "runtime.started" }, { type: "runtime.completed" }],
    });

    const pageRes = await app.request(
      "/api/traces/sess-turns/turns/page?limit=2",
    );
    const pageBody = (await pageRes.json()) as {
      turns: Array<{ events: Array<{ eventOrder: number }> }>;
    };
    expect(pageBody.turns[0].events.map((event) => event.eventOrder)).toEqual([
      0, 1,
    ]);
  });

  it("includes a discovery snapshot on trace turns without plugin_data values", async () => {
    const store = createMemoryStore();
    await store.createSession(
      makeSession("sess-discovery", { activePlugins: ["image-plugin"] }),
    );
    await store.setPluginData({
      id: "pd-discovery",
      sessionId: "sess-discovery",
      pluginId: "image-plugin",
      namespace: "images",
      key: "cover",
      value: { secret: "do-not-leak", url: "https://example.test/cover.png" },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:01.000Z",
    });

    const registry = createPluginRegistry();
    registry.register(makeEntry());
    const app = makeApp(store, {
      registry,
      builtinToolNames: ["plugin-data-get", "plugin-data-set"],
    });

    const res = await app.request("/api/traces/sess-discovery/turns");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      discovery: {
        framework: {
          pluginData: { writePaths: string[] };
          tools: { builtin: string[] };
        };
        plugins: Array<{
          id: string;
          declaredPluginDataNamespaces: string[];
          tools: Array<{
            id: string;
            kind: "builtin" | "local";
            runtimeId?: string;
          }>;
        }>;
        pluginData: Array<{
          pluginId: string;
          namespaces: Array<{
            namespace: string;
            count: number;
            keys: Array<{ key: string; valueType: string }>;
          }>;
        }>;
      };
    };

    expect(body.discovery.framework.tools.builtin).toEqual([
      "plugin-data-get",
      "plugin-data-set",
    ]);
    expect(body.discovery.framework.pluginData.writePaths).toContain(
      "function-output:pluginData[]",
    );
    expect(body.discovery.plugins[0]).toMatchObject({
      id: "image-plugin",
      declaredPluginDataNamespaces: ["images"],
      tools: [
        {
          id: "plugin-data-get",
          kind: "builtin",
          runtimeId: "image-plugin",
        },
        {
          id: "save-image",
          kind: "local",
          runtimeId: "image-plugin",
        },
      ],
    });
    expect(body.discovery.pluginData[0]).toMatchObject({
      pluginId: "image-plugin",
      namespaces: [
        {
          namespace: "images",
          count: 1,
          keys: [{ key: "cover", valueType: "object" }],
        },
      ],
    });
    expect(JSON.stringify(body.discovery.pluginData)).not.toContain(
      "do-not-leak",
    );
  });
});
