import type { EnvVarDefinition } from "../types.js";

export const AI_ENV_VARS = [
  {
    name: "COVEL_MODEL_DB_PATH",
    group: "ai",
    type: "path",
    status: "active",
    description: "Explicit model database JSON override.",
  },
  {
    name: "COVEL_PROMPTS_DIR",
    group: "ai",
    type: "path",
    status: "active",
    description: "Prompt template root directory override.",
  },
  {
    name: "COVEL_LLM_RETRY_DISABLED",
    group: "ai",
    type: "boolean",
    status: "active",
    defaultValue: "false",
    description: "Disables provider HTTP retry when set to 1.",
  },
  {
    name: "COVEL_LLM_REPLAY",
    group: "ai",
    type: "enum",
    status: "documented",
    values: ["auto", "record", "replay"],
    description: "Documented dev LLM replay cache mode.",
  },
  {
    name: "COVEL_LLM_REPLAY_DIR",
    group: "ai",
    type: "path",
    status: "documented",
    defaultValue: "debugs/llm-cache",
    description: "Documented dev LLM replay cache directory.",
  },
  {
    name: "COVEL_ALLOWED_LLM_HOSTS",
    group: "ai",
    type: "string",
    status: "documented",
    description: "Documented custom LLM host allowlist.",
  },
] as const satisfies readonly EnvVarDefinition[];
