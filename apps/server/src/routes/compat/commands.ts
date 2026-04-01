import { Hono } from "hono";
import type { CommandRegistry } from "@covel/plugin-runtime";

/**
 * Frontend-compatible GET /commands
 * Returns CommandSummary[] = [{ name, description, usage, examples, positionalHints, flagHints }]
 */
export function createCompatCommandsRoute(commandRegistry: CommandRegistry) {
  const route = new Hono();

  route.get("/", (c) => {
    return c.json(commandRegistry.listSummaries());
  });

  return route;
}
