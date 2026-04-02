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
    try {
      const body = await c.req.json<{
        runId: string;
        branchId: string;
        actorId: string;
        type: string;
        locale?: string;
        payload?: Record<string, unknown>;
        traceId?: string;
      }>();
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown kernel error";
      console.error("[kernel/turn] Error:", err);
      return c.json({ error: message, code: "KERNEL_ERROR" }, 500);
    }
  });

  return route;
}
