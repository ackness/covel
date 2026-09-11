import type { EnvVarDefinition } from "../types.js";

export const TEST_ENV_VARS = [
  {
    name: "E2E_BASE_URL",
    group: "test",
    type: "url",
    status: "active",
    defaultValue: "http://127.0.0.1:5181",
    description:
      "Playwright base URL override; when omitted, Playwright starts its isolated local stack.",
  },
  {
    name: "E2E_MODEL_SLOT",
    group: "test",
    type: "string",
    status: "active",
    defaultValue: "e2e",
    description: "Model slot used by the e2e plugin verification script.",
  },
  {
    name: "CI",
    group: "test",
    type: "boolean",
    status: "active",
    defaultValue: "false",
    description: "CI mode for lint and Playwright behavior.",
  },
  {
    name: "LIVE_LLM_ENABLED",
    group: "test",
    type: "boolean",
    status: "active",
    defaultValue: "false",
    description: "Enables live LLM provider tests.",
  },
  {
    name: "BASE_URL",
    group: "test",
    type: "url",
    status: "active",
    defaultValue: "http://localhost:5173",
    description: "README screenshot script frontend URL.",
  },
  {
    name: "SESSION_ID",
    group: "test",
    type: "string",
    status: "active",
    description: "README screenshot script session id.",
  },
  {
    name: "COVEL_PG_PREFLIGHT_HOST",
    group: "test",
    type: "string",
    status: "active",
    defaultValue: "127.0.0.1",
    description:
      "dev:pg TCP preflight host override; otherwise follows DATABASE_URL.",
  },
  {
    name: "COVEL_PG_PREFLIGHT_PORT",
    group: "test",
    type: "integer",
    status: "active",
    defaultValue: "5432",
    description:
      "dev:pg TCP preflight port override; otherwise follows DATABASE_URL, then POSTGRES_PORT.",
  },
  {
    name: "COVEL_PG_PREFLIGHT_SKIP",
    group: "test",
    type: "boolean",
    status: "active",
    defaultValue: "false",
    description: "Set to 1 to skip the dev:pg TCP preflight.",
  },
] as const satisfies readonly EnvVarDefinition[];
