import type { EnvVarDefinition } from "../types.js";

export const FEATURE_ENV_VARS = [
  {
    name: "COVEL_COMPACTOR_CONTEXT_WINDOW",
    group: "feature",
    type: "integer",
    status: "active",
    defaultValue: "32768",
    description: "Compactor context window used for threshold comparisons.",
  },
  {
    name: "COVEL_TRACE_TRUNCATE",
    group: "feature",
    type: "boolean",
    status: "planned",
    defaultValue: "false",
    description: "Planned trace payload truncation switch.",
  },
] as const satisfies readonly EnvVarDefinition[];
