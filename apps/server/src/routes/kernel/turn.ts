import { Hono } from "hono";
import type { Kernel } from "@covel/kernel";
import type { ApiKeyEnv } from "../../middleware/api-key-injection.js";

export function createTurnRoute(kernel: Kernel) {
  const route = new Hono<ApiKeyEnv>();

  /**
   * POST /api/kernel/turn
   *
   * Body: {
   *   runId: string;
   *   branchId: string;
   *   actorId: string;
   *   type: "user.input" | "system.event";
   *   locale?: string;
   *   payload: Record<string, unknown>;
   * }
   */
  route.post("/", async (c) => {
    const body = await c.req.json();
    const apiKeys = c.get("apiKeys");

    const result = await kernel.executeTurn(
      {
        runId: body.runId,
        branchId: body.branchId,
        actorId: body.actorId,
        type: body.type,
        locale: body.locale,
        payload: body.payload ?? {},
      },
      {
        apiKeys,
        traceId: body.traceId,
      }
    );

    return c.json(result);
  });

  return route;
}
