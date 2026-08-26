import type { EnvVarDefinition } from "../types.js";

export const FEATURE_ENV_VARS = [
  {
    name: "COVEL_LLM_MAX_CONCURRENT",
    group: "feature",
    type: "integer",
    status: "active",
    defaultValue: "4",
    description:
      "Process-wide maximum concurrent LLM calls. Zero or a negative value disables the gate.",
  },
  {
    name: "COVEL_EFFECTS_POLICY",
    group: "feature",
    type: "enum",
    status: "active",
    values: ["warn", "strict"],
    defaultValue: "warn",
    description:
      "Policy for same-layer effects read/write hazards: warn preserves parallelism; strict serializes conflicting pairs.",
  },
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
      "Auto-snapshot checkpoint cadence: save a kind=auto snapshot every N completed player turns (the first one always snapshots). 1 = every turn.",
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
