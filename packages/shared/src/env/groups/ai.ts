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
    name: "COVEL_IMG_KEY",
    group: "ai",
    type: "secret",
    status: "active",
    secret: true,
    description:
      "API key for the offline portrait and scene generation scripts; it wins over the selected provider's own key.",
  },
] as const satisfies readonly EnvVarDefinition[];
