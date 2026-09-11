import type { EnvVarDefinition } from "../types.js";

export const WEB_ENV_VARS = [
  {
    name: "RUNTIME_HOST",
    group: "web",
    type: "string",
    status: "active",
    defaultValue: "127.0.0.1",
    description: "Vite dev proxy target host for server API calls.",
  },
  {
    name: "RUNTIME_PORT",
    group: "web",
    type: "integer",
    status: "active",
    defaultValue: "3001",
    description:
      "Vite dev proxy target port override; defaults to SERVER_PORT, then 3001.",
  },
  {
    name: "VITE_ROUTER_DEVTOOLS",
    group: "web",
    type: "boolean",
    status: "active",
    defaultValue: "true",
    description:
      "Toggles the TanStack Router devtools floating button in dev. Defaults on; set to false to hide.",
  },
] as const satisfies readonly EnvVarDefinition[];
