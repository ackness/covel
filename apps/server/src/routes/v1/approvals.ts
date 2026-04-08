import { Hono } from "hono";
import type { V1KernelSession } from "@covel/kernel";

export interface V1ApprovalRouteDeps {
  getOrCreateSession(sessionId: string): Promise<V1KernelSession> | V1KernelSession;
}

/**
 * V1 Approval API routes.
 *
 * POST /api/sessions/:sessionId/approvals/callback
 */
export function createV1ApprovalRoutes(deps: V1ApprovalRouteDeps): Hono {
  const app = new Hono();

  // Approval callback (user approved/denied in frontend)
  app.post("/sessions/:sessionId/approvals/callback", async (c) => {
    const { sessionId } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const { interactionId, decision, response } = body as {
      interactionId?: string;
      decision?: "approved" | "denied";
      response?: unknown;
    };

    if (!interactionId || !decision) {
      return c.json({ error: "interactionId and decision are required." }, 400);
    }

    const session = await deps.getOrCreateSession(sessionId);
    const result = await session.handleApprovalCallback(interactionId, decision, response);

    return c.json({
      sessionId,
      ...result,
    });
  });

  return app;
}
