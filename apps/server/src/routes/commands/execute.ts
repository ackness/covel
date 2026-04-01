import { Hono } from "hono";
import type { CommandBus } from "@covel/plugin-runtime";

export function createCommandExecuteRoute(commandBus: CommandBus) {
  const route = new Hono();

  route.post("/", async (c) => {
    const body = await c.req.json<{
      command: string;
      sessionId?: string;
      actorId?: string;
      locale?: string;
    }>();

    if (!body.command || typeof body.command !== "string") {
      return c.json({ error: "Missing required field: command" }, 400);
    }

    try {
      const result = await commandBus.dispatch(body.command, {
        sessionId: body.sessionId,
        actorId: body.actorId,
        locale: body.locale,
      });

      return c.json({ result });
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error) {
        const cmdError = error as { code: string; message: string; issues?: unknown[] };
        const status = cmdError.code === "COMMAND_NOT_FOUND" ? 404 : 400;
        return c.json(
          {
            error: cmdError.message,
            code: cmdError.code,
            ...(cmdError.issues ? { issues: cmdError.issues } : {}),
          },
          status
        );
      }
      throw error;
    }
  });

  return route;
}
