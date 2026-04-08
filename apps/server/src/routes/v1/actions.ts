import { Hono } from "hono";
import type { V1KernelSession } from "@covel/kernel";

export interface V1ActionRouteDeps {
  getOrCreateSession(sessionId: string): Promise<V1KernelSession> | V1KernelSession;
}

/**
 * V1 Action/Workflow API routes.
 *
 * POST /api/sessions/:sessionId/actions/:pluginId/:actionId/execute
 * GET  /api/sessions/:sessionId/workflows/:workflowRunId
 */
export function createV1ActionRoutes(deps: V1ActionRouteDeps): Hono {
  const app = new Hono();

  // Execute a plugin action (starts workflow)
  app.post("/sessions/:sessionId/actions/:pluginId/:actionId/execute", async (c) => {
    const { sessionId, pluginId, actionId } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const { payload } = body as { payload?: unknown };

    const session = await deps.getOrCreateSession(sessionId);
    const workflow = await session.executeAction(pluginId, actionId, payload);
    return c.json(workflow);
  });

  // Query workflow status
  app.get("/sessions/:sessionId/workflows/:workflowRunId", async (c) => {
    const { sessionId, workflowRunId } = c.req.param();
    const session = await deps.getOrCreateSession(sessionId);
    const workflow = session.getWorkflow(workflowRunId);
    if (!workflow) {
      return c.json({ error: `Workflow "${workflowRunId}" not found.` }, 404);
    }
    return c.json(workflow);
  });

  return app;
}
