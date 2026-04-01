import { Hono } from "hono";
import type { CommandRegistry } from "@covel/plugin-runtime";

export function createCommandsListRoute(commandRegistry: CommandRegistry) {
  const route = new Hono();

  route.get("/", (c) => {
    return c.json({ commands: commandRegistry.listSummaries() });
  });

  return route;
}
