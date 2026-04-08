import { Hono } from "hono";
import type { V1KernelSession } from "@covel/kernel";

export interface V1RuntimeRouteDeps {
  getOrCreateSession(sessionId: string): Promise<V1KernelSession> | V1KernelSession;
}

/**
 * V1 Runtime API routes.
 *
 * POST /api/sessions/:sessionId/runtimes/:pluginId/:runtimeId/execute
 * GET  /api/sessions/:sessionId/runtimes
 * GET  /api/sessions/:sessionId/runtimes/:pluginId/:runtimeId/last-record
 */
export function createV1RuntimeRoutes(deps: V1RuntimeRouteDeps): Hono {
  const app = new Hono();

  // Execute a single runtime
  app.post("/sessions/:sessionId/runtimes/:pluginId/:runtimeId/execute", async (c) => {
    const { sessionId, pluginId, runtimeId } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const { trigger } = body as {
      trigger?: { type: string; action?: string; payload?: unknown };
    };

    const session = await deps.getOrCreateSession(sessionId);
    const result = await session.executeRuntime(pluginId, runtimeId, trigger?.payload);

    return c.json({
      traceId: result.record.traceId,
      record: result.record,
    });
  });

  // List available runtimes for a session
  app.get("/sessions/:sessionId/runtimes", async (c) => {
    const { sessionId } = c.req.param();
    const session = await deps.getOrCreateSession(sessionId);
    return c.json({ sessionId, runtimes: session.listRuntimes() });
  });

  // Get last record for a runtime
  app.get("/sessions/:sessionId/runtimes/:pluginId/:runtimeId/last-record", async (c) => {
    const { sessionId, pluginId, runtimeId } = c.req.param();
    const session = await deps.getOrCreateSession(sessionId);
    return c.json({
      sessionId,
      pluginId,
      runtimeId,
      record: session.getLastRecord(pluginId, runtimeId) ?? null,
    });
  });

  return app;
}
