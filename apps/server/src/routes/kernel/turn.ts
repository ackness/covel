import { Hono } from "hono";
import type { Kernel } from "@covel/kernel";
import type { ApiKeyEnv } from "../../middleware/api-key-injection.js";

export function createTurnRoute(kernel: Kernel) {
  const route = new Hono<ApiKeyEnv>();

  /**
   * POST /api/kernel/turn
   *
   * DEBUG-ONLY: Uses the default kernel session. Not suitable for
   * multi-session production use. Prefer /actions endpoint instead.
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
    if ((process.env.DEPLOYMENT_TIER ?? "self") === "self") {
      console.warn("[kernel/turn] WARNING: /api/kernel/turn uses default session — debug only, not for production");
    }
    let body: {
      runId: string;
      branchId: string;
      actorId: string;
      type: string;
      locale?: string;
      payload?: Record<string, unknown>;
      traceId?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Malformed JSON body", code: "INVALID_JSON" }, 400);
    }

    try {
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
      const rawMessage = err instanceof Error ? err.message : "Unknown kernel error";
      console.error("[kernel/turn] Error:", err);
      const tier = process.env.DEPLOYMENT_TIER ?? "self";
      const message = tier === "self" ? rawMessage : "An internal error occurred";
      return c.json({ error: message, code: "KERNEL_ERROR" }, 500);
    }
  });

  return route;
}
