/**
 * Framework discovery routes for developer tooling and AI agents.
 */

import { Hono } from "hono";
import { buildFrameworkCapabilities } from "./discovery.js";

type Env = {
  Variables: {
    builtinToolNames?: readonly string[];
  };
};

export const frameworkRoutes = new Hono<Env>();

frameworkRoutes.get("/capabilities", (c) => {
  return c.json(buildFrameworkCapabilities(c.get("builtinToolNames")));
});
