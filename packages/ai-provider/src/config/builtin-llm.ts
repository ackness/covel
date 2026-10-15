/**
 * The model configuration used when no llm.toml is present.
 *
 * Without settings it is one DeepSeek `story` slot, so a fresh install boots
 * and every runtime resolves to it through the gateway's first-slot fallback.
 * `DEFAULT_BASE_URL` points that slot at any OpenAI API endpoint
 * instead: the provider is then `default`, whose key is read from
 * `DEFAULT_API_KEY` like any other `<PROVIDER>_API_KEY`, and
 * `DEFAULT_MODEL` names the model. No key lives in this text.
 */
export const BUILTIN_LLM_PROVIDER = "default";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";

export interface BuiltinLlmSettings {
  /** `DEFAULT_BASE_URL`: the endpoint, as an llm.toml `baseUrl` takes it. */
  baseUrl?: string;
  /** `DEFAULT_MODEL`: the model the endpoint serves. */
  model?: string;
}

/** The provider the built-in slot uses for these settings. */
export const builtinLlmProvider = (settings: BuiltinLlmSettings = {}) =>
  settings.baseUrl ? BUILTIN_LLM_PROVIDER : "deepseek";

/** The built-in llm.toml text for these settings. */
export function builtinLlmToml(settings: BuiltinLlmSettings = {}): string {
  const baseUrl = settings.baseUrl ?? DEEPSEEK_BASE_URL;
  const model = settings.model ?? DEEPSEEK_MODEL;
  return `
[covel.story]
provider = ${JSON.stringify(builtinLlmProvider(settings))}
model    = ${JSON.stringify(model)}
baseUrl  = ${JSON.stringify(baseUrl)}
protocol = "openai-chat-v1"
`;
}
