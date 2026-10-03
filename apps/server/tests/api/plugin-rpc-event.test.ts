/**
 * POST /api/sessions/:id/plugin-rpc with `kind: "event"` — a plugin's UI
 * emits a domain event that plugin declares.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import { createPluginRpcRegistry, createRpcExecutor } from "@covel/runtime";
import { createRpcApprovalGate, type RpcApprovalGate } from "@covel/approval";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSource,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { createEventBus } from "@covel/events";
import { pluginRpcRoutes } from "../../src/routes/api/plugin-rpc.js";
import { createEventDirectory } from "../../src/routes/api/bootstrap/event-directory.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { listRuntimeJobs } from "../../src/routes/api/plugin-rpc/jobs.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";

const SESSION = "sess-event-1";
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0)
    await rm(roots.pop()!, { recursive: true, force: true });
});

function runtime(
  pluginId: string,
  name: string,
  trigger: RuntimeManifest["trigger"],
): RuntimeManifest {
  return {
    name,
    pluginId,
    description: "test runtime",
    stage: "post-turn",
    runtimeType: "function",
    outputKind: "plugin",
    pluginType: "plugin",
    handler: "./handler.js",
    trigger,
    execution: "background",
  } as RuntimeManifest;
}

function register(
  registry: PluginRegistry,
  pluginId: string,
  args: {
    readonly runtimes: readonly RuntimeManifest[];
    readonly events?: readonly { topic: string; schema: string }[];
    readonly source?: PluginSource;
  },
): void {
  const manifests = args.runtimes.map((manifest, index) => ({
    plugin: { id: pluginId, kind: "plugin", description: pluginId },
    manifest: {
      ...manifest,
      // The package declaration carries the event contracts.
      ...(index === 0 && args.events
        ? {
            events: args.events.map((event) => ({
              ...event,
              description: event.topic,
              advertise: false,
            })),
          }
        : {}),
    },
    promptTemplate: "",
    rawFrontmatter: {},
  }));
  registry.register({
    id: pluginId,
    packageManifest: manifests[0],
    summary: {
      id: pluginId,
      name: pluginId,
      description: pluginId,
      pluginType: "plugin",
      runtimeCount: manifests.length,
    },
    manifests,
    loadedRuntimes: new Map(
      args.runtimes.map((manifest) => [
        manifest.name,
        { manifest, promptTemplate: "" },
      ]),
    ),
    status: "registered",
    source: args.source ?? "builtin",
  } as unknown as PluginRegistryEntry);
}

async function setup(source: PluginSource = "builtin"): Promise<{
  app: Hono;
  store: DataStore;
  gate: RpcApprovalGate;
}> {
  const store = createMemoryStore();
  const pluginRegistry = createPluginRegistry();
  const root = await mkdtemp(path.join(tmpdir(), "covel-rpc-event-"));
  roots.push(root);
  await writeFile(
    path.join(root, "location-selected.event.json"),
    JSON.stringify({
      type: "object",
      required: ["locationId"],
      properties: { locationId: { type: "string" } },
      additionalProperties: false,
    }),
  );
  // `map` declares the topic and handles it; `encounters` also subscribes.
  register(pluginRegistry, "map", {
    source,
    events: [
      {
        topic: "map.location-selected",
        schema: "location-selected.event.json",
      },
      { topic: "map.unheard", schema: "location-selected.event.json" },
    ],
    runtimes: [
      runtime("map", "map/travel", {
        type: "event",
        topic: "map.location-selected",
      }),
    ],
  });
  register(pluginRegistry, "encounters", {
    runtimes: [
      runtime("encounters", "encounters/arrive", {
        type: "event",
        topic: "map.location-selected",
      }),
      runtime("encounters", "encounters/manual", { type: "manual" }),
    ],
  });
  const now = new Date().toISOString();
  await store.createSession({
    phase: "playing",
    setupRuntimes: {},
    metadata: {
      approvalScopeNonce: globalThis.crypto.randomUUID(),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    id: SESSION,
    worldId: "cloudmere",
    status: "active",
    completedPlayerTurns: 1,
    locale: "zh-CN",
    activePlugins: ["map", "encounters"],
    createdAt: now,
    updatedAt: now,
  });
  const rpcRegistry = createPluginRpcRegistry();
  const eventDirectory = createEventDirectory({
    registry: pluginRegistry,
    resolvePluginDir: (pluginId) => (pluginId === "map" ? root : undefined),
  });
  const gate = createRpcApprovalGate();
  const sessionLock = createInProcessSessionLock();
  const eventBus = createEventBus(store);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("rpcExecutor", createRpcExecutor({ registry: rpcRegistry }));
    c.set("rpcRegistry", rpcRegistry);
    c.set("rpcApprovalGate", gate);
    c.set("pluginRegistry", pluginRegistry);
    c.set("sessionLock", sessionLock);
    c.set("eventDirectory", eventDirectory);
    c.set("eventBus", eventBus);
    await next();
  });
  app.route("/api/sessions", pluginRpcRoutes);
  return { app, store, gate };
}

function emit(app: Hono, body: Record<string, unknown>) {
  return app.request(`/api/sessions/${SESSION}/plugin-rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "event", ...body }),
  });
}

describe("plugin-rpc kind event", () => {
  let app: Hono;
  let store: DataStore;

  beforeEach(async () => {
    ({ app, store } = await setup());
  });

  it("queues every subscriber of the topic as an event job carrying the payload", async () => {
    const res = await emit(app, {
      pluginId: "map",
      topic: "map.location-selected",
      payload: { locationId: "docks" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      eventId: string;
      topic: string;
      deferredJobs: { jobId: string; runtimeId: string }[];
    };
    expect(body.status).toBe("ok");
    expect(body.topic).toBe("map.location-selected");
    expect(body.deferredJobs.map((job) => job.runtimeId).sort()).toEqual([
      "encounters/arrive",
      "map/travel",
    ]);

    const jobs = await listRuntimeJobs(store, { sessionId: SESSION });
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.origin).toMatchObject({
        activation: "event",
        sourceTurnId: body.eventId,
      });
      expect(job.payload).toMatchObject({
        activation: "event",
        triggerEvent: {
          topic: "map.location-selected",
          data: { locationId: "docks" },
        },
      });
    }
  });

  it("emits with no effect when nothing subscribes", async () => {
    const res = await emit(app, {
      pluginId: "map",
      topic: "map.unheard",
      payload: { locationId: "docks" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", deferredJobs: [] });
    expect(await listRuntimeJobs(store, { sessionId: SESSION })).toHaveLength(
      0,
    );
  });

  it("lets a plugin emit only the topics it declares itself", async () => {
    const res = await emit(app, {
      pluginId: "encounters",
      topic: "map.location-selected",
      payload: { locationId: "docks" },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      "event_not_declared",
    );
    expect(await listRuntimeJobs(store, { sessionId: SESSION })).toHaveLength(
      0,
    );
  });

  it("rejects a payload that does not match the topic's schema", async () => {
    const res = await emit(app, {
      pluginId: "map",
      topic: "map.location-selected",
      payload: { place: "docks" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "event_payload_invalid",
    );
    expect(await listRuntimeJobs(store, { sessionId: SESSION })).toHaveLength(
      0,
    );
  });

  it("asks a community plugin for each grant it lacks, then queues", async () => {
    let gate: RpcApprovalGate;
    ({ app, store, gate } = await setup("community"));
    const session = (await store.getSession(SESSION))!;
    const request = {
      pluginId: "map",
      topic: "map.location-selected",
      payload: { locationId: "docks" },
    };
    // Loading the plugin's code, emitting the event, and running the
    // community subscriber are three grants; the builtin subscriber needs none.
    const asked: string[] = [];
    for (let step = 0; step < 3; step++) {
      const res = await emit(app, request);
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        status: string;
        approvalId: string;
        pending: { action: string };
      };
      expect(body.status).toBe("approval-required");
      asked.push(body.pending.action);
      expect(await listRuntimeJobs(store, { sessionId: SESSION })).toHaveLength(
        0,
      );
      gate.decide(
        {
          approvalId: body.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        sessionApprovalScope(session, "map"),
      );
    }
    expect(asked.slice(1)).toEqual([
      "event:map.location-selected",
      "runtime:map/travel",
    ]);

    const res = await emit(app, request);
    expect(res.status).toBe(200);
    expect(await listRuntimeJobs(store, { sessionId: SESSION })).toHaveLength(
      2,
    );
  });
});
