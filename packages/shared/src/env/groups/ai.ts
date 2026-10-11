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
    name: "DEFAULT_BASE_URL",
    group: "ai",
    type: "url",
    status: "active",
    description:
      "Without an llm.toml, points the built-in story slot at this OpenAI-compatible endpoint (provider default) instead of DeepSeek; e2e:replay --record sends new requests here.",
  },
  {
    name: "DEFAULT_MODEL",
    group: "ai",
    type: "string",
    status: "active",
    defaultValue: "deepseek-v4-flash",
    description: "Model of the built-in story slot used without an llm.toml.",
  },
  {
    name: "DEFAULT_API_KEY",
    group: "ai",
    type: "secret",
    status: "active",
    secret: true,
    description:
      "Key of the default provider: the built-in slot set by DEFAULT_BASE_URL and the e2e:replay sessions.",
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
