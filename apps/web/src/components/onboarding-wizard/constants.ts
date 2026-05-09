import type { ProviderOption } from "./types.js";

/**
 * Onboarding persistence uses a version number rather than a boolean so that
 * we can re-show the wizard after a tutorial has been materially updated.
 * Bump ONBOARDING_VERSION whenever the wizard flow changes in a way that
 * existing users should see again.
 */
export const ONBOARDING_VERSION = 3;
export const CUSTOM_PROVIDER_ID = "__custom__";
export const TOTAL_STEPS = 4;

export const PROVIDERS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    placeholder: "sk-...",
    keyEnv: "DEEPSEEK_API_KEY",
  },
  {
    id: "openai",
    name: "OpenAI",
    placeholder: "sk-...",
    keyEnv: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    placeholder: "sk-ant-...",
    keyEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "dashscope",
    name: "DashScope",
    placeholder: "sk-...",
    keyEnv: "DASHSCOPE_API_KEY",
  },
] as const satisfies readonly ProviderOption[];
