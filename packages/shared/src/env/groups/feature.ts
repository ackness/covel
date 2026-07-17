import type { EnvVarDefinition } from "../types.js";

export const FEATURE_ENV_VARS = [
  {
    name: "COVEL_COMPACTOR_CONTEXT_WINDOW",
    group: "feature",
    type: "integer",
    status: "active",
    defaultValue: "(narrative slot model capability, else 32768)",
    description:
      "Explicit override for the context window used by the compactor and prompt budget. When unset, the active narrative slot's model capability contextWindow is used.",
  },
  {
    name: "COVEL_SNAPSHOT_INTERVAL_TURNS",
    group: "feature",
    type: "integer",
    status: "active",
    defaultValue: "5",
    description:
      "Auto-snapshot checkpoint cadence: save a kind=auto snapshot every N turns (turnCount <= 1 always snapshots). 1 = every turn.",
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
