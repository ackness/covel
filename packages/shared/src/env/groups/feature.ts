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
    name: "COVEL_INSTRUCTION_LOCALE",
    group: "feature",
    type: "enum",
    status: "active",
    values: ["en", "zh"],
    defaultValue: "(derived from the session locale)",
    description:
      "Force one instruction language for every session: en reads the canonical English prompt bodies, zh prefers the *.zh.md variants. When unset, Simplified Chinese sessions read Chinese instructions where they exist and all other sessions read English.",
  },
  {
    name: "COVEL_COMPACTOR_CONTEXT_WINDOW",
    group: "feature",
    type: "integer",
    status: "active",
    defaultValue: "(narrative slot model capability, else 262144)",
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
    name: "COVEL_TRACE_RETENTION_DAYS",
    group: "feature",
    type: "integer",
    status: "active",
    defaultValue: "30",
    description:
      "Delete runtime trace events and the stored event trail older than N days: a session's after each committed execution, every session's at server start and once a day. 0 keeps all traces. When set, it wins over the player's Settings choice; when unset, the player's choice applies (self tier only), then 30.",
  },
  {
    name: "COVEL_PLUGIN_LOG_LEVEL",
    group: "feature",
    type: "enum",
    status: "active",
    values: ["debug", "info", "warn", "error"],
    description:
      "Lowest level a plugin's ctx.logger records into its _logs ring. Defaults to debug in development and info when NODE_ENV=production.",
  },
  {
    name: "COVEL_AUTO_SNAPSHOT_RETENTION",
    group: "feature",
    type: "integer",
    status: "active",
    defaultValue: "20",
    description:
      "Auto snapshots kept per session; older kind=auto snapshots are deleted after each checkpoint unless a fork names them as parent. 0 keeps all.",
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
