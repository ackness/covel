import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createTraceRecord } from "../../../modules/domain/src/index.js";
import { createInMemoryStorageRepositories } from "../../../modules/storage/src/index.js";
import { createRuntimeComposition, createRuntimeServer } from "../src/index.js";

async function listen(server: ReturnType<typeof createRuntimeServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to resolve listening address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("runtime traces API", () => {
  const servers = new Set<ReturnType<typeof createRuntimeServer>>();

  afterEach(async () => {
    await Promise.all(
      Array.from(servers).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          })
      )
    );
    servers.clear();
  });

  it("serves GET /traces?traceId=... with flow and model trace events for the requested trace", async () => {
    const repositories = createInMemoryStorageRepositories();
    await repositories.traceRecords.save(createTraceRecord({
      traceId: "trace_req_01",
      spanId: "span_flow_01",
      sessionId: "session_01",
      turnId: "turn_01",
      component: "flow-engine",
      eventType: "flow.started",
      payload: {
        flowId: "flow_01"
      },
      createdAt: new Date("2026-03-24T12:00:00.000Z")
    }));
    await repositories.traceRecords.save(createTraceRecord({
      traceId: "trace_req_01",
      spanId: "span_model_01",
      sessionId: "session_01",
      turnId: "turn_01",
      component: "model-gateway",
      eventType: "model.completed",
      payload: {
        model: "qwen-plus"
      },
      createdAt: new Date("2026-03-24T12:00:01.000Z")
    }));
    await repositories.traceRecords.save(createTraceRecord({
      traceId: "trace_req_02",
      spanId: "span_flow_02",
      sessionId: "session_02",
      turnId: "turn_02",
      component: "flow-engine",
      eventType: "flow.completed",
      payload: {
        flowId: "flow_02"
      },
      createdAt: new Date("2026-03-24T12:00:02.000Z")
    }));

    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      },
      repositories
    });
    servers.add(server);

    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/traces?traceId=trace_req_01`);
    const body = await response.json() as Array<{
      traceId: string;
      component: string;
      eventType: string;
      payload: Record<string, unknown>;
    }>;

    expect(response.status).toBe(200);
    expect(body).toEqual([
      expect.objectContaining({
        traceId: "trace_req_01",
        component: "flow-engine",
        eventType: "flow.started",
        payload: {
          flowId: "flow_01"
        }
      }),
      expect.objectContaining({
        traceId: "trace_req_01",
        component: "model-gateway",
        eventType: "model.completed",
        payload: {
          model: "qwen-plus"
        }
      })
    ]);
  });

  it("serves GET /traces/:traceId with the full ordered trace record list", async () => {
    const repositories = createInMemoryStorageRepositories();
    await repositories.traceRecords.save(createTraceRecord({
      traceId: "trace_req_03",
      spanId: "span_flow_03",
      sessionId: "session_03",
      turnId: "turn_03",
      component: "flow-engine",
      eventType: "flow.started",
      payload: {
        flowId: "flow_03"
      },
      createdAt: new Date("2026-03-24T12:10:00.000Z")
    }));
    await repositories.traceRecords.save(createTraceRecord({
      traceId: "trace_req_03",
      spanId: "span_model_03",
      sessionId: "session_03",
      turnId: "turn_03",
      component: "model-gateway",
      eventType: "model.completed",
      payload: {
        provider: "openaiCompatible"
      },
      createdAt: new Date("2026-03-24T12:10:01.000Z")
    }));

    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      },
      repositories
    });
    servers.add(server);

    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/traces/trace_req_03`);
    const body = await response.json() as Array<{
      traceId: string;
      spanId: string;
      component: string;
      eventType: string;
      createdAt: string;
    }>;

    expect(response.status).toBe(200);
    expect(body.map((entry) => entry.spanId)).toEqual([
      "span_flow_03",
      "span_model_03"
    ]);
    expect(body.map((entry) => `${entry.component}/${entry.eventType}`)).toEqual([
      "flow-engine/flow.started",
      "model-gateway/model.completed"
    ]);
    expect(body.every((entry) => entry.traceId === "trace_req_03")).toBe(true);
  });

  it("persists runtime-generated model traces so they are readable through /traces", async () => {
    const runtime = await createRuntimeComposition({
      env: {}
    });
    await runtime.repositories.worlds.save({
      id: "world_trace_runtime",
      name: "Trace world",
      description: "Runtime trace integration",
      createdAt: new Date("2026-03-24T12:20:00.000Z")
    });
    await runtime.repositories.sessions.save({
      id: "session_trace_runtime",
      worldId: "world_trace_runtime",
      status: "active",
      createdAt: new Date("2026-03-24T12:20:01.000Z")
    });

    const server = createRuntimeServer({
      flowEngine: runtime.flowEngine,
      repositories: runtime.repositories
    });
    servers.add(server);

    const baseUrl = await listen(server);
    const actionResponse = await fetch(`${baseUrl}/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requestId: "req_trace_runtime",
        type: "send_message",
        sessionId: "session_trace_runtime",
        payload: {
          content: "Record this trace."
        }
      })
    });

    expect(actionResponse.status).toBe(200);

    const traceResponse = await fetch(`${baseUrl}/traces/trace_req_trace_runtime`);
    const traceEntries = await traceResponse.json() as Array<{
      traceId: string;
      component: string;
      eventType: string;
      payload: Record<string, unknown>;
    }>;

    expect(traceResponse.status).toBe(200);
    expect(traceEntries).toEqual([
      expect.objectContaining({
        traceId: "trace_req_trace_runtime",
        component: "model-gateway",
        eventType: "model.completed",
        payload: {
          model: "qwen3.5-flash"
        }
      })
    ]);
  });
});
