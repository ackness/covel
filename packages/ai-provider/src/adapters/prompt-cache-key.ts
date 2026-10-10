import type { ProviderConfig, TextGenerationParams } from "../types.js";

/**
 * The `prompt_cache_key` field of an OpenAI Chat or Responses request.
 *
 * OpenAI routes requests by a hash of the prompt's first tokens, and this key
 * is combined with it: requests with one key and one prefix reach the machine
 * that holds the cached prefix. The field is OpenAI's own. An OpenAI-compatible
 * server may reject a field it does not know, and a rejected request costs
 * more than a missed cache, so the key goes to api.openai.com only unless the
 * target's `providerOptions` set `promptCacheKey` (true for a relay that
 * forwards it, false to leave it out).
 */
export function openAiPromptCacheKeyField(
  config: ProviderConfig,
  params: Pick<
    TextGenerationParams,
    "promptCacheKey" | "providerRequestMetadata"
  >,
): { prompt_cache_key?: string } {
  if (!params.promptCacheKey) return {};
  const setting = params.providerRequestMetadata?.promptCacheKey;
  const send =
    typeof setting === "boolean" ? setting : isOpenAiHost(config.baseUrl);
  return send ? { prompt_cache_key: params.promptCacheKey } : {};
}

function isOpenAiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}
