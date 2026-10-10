import { createHash } from "node:crypto";
import type { PluginRuntimeGateway } from "@covel/shared/plugin-runtime";

/**
 * Cache-routing key for one runtime's model requests in one session.
 *
 * A runtime's requests in a session repeat one prefix (system prompt, tools,
 * history), and two runtimes or two sessions share none. A provider that
 * routes by such a key (OpenAI `prompt_cache_key`) then sends the requests to
 * the machine that holds the prefix. The key is a hash: it carries no session
 * ID and no text, and it stays inside the 64 characters OpenAI allows.
 */
export function promptCacheKeyFor(
  sessionId: string,
  runtimeId: string,
): string {
  const digest = createHash("sha256")
    .update(`${sessionId}\n${runtimeId}`)
    .digest("hex");
  return `covel-${digest.slice(0, 32)}`;
}

/**
 * A gateway whose `generateText` calls carry `key`: a function runtime's
 * calls in one session repeat the runtime's own instructions, and the key
 * sends them to the machine that holds that prefix. A key a plugin passes
 * itself is replaced, so a plugin cannot route into another runtime's cache.
 * Object generation does not take a key.
 */
export function withPromptCacheKey(
  gateway: PluginRuntimeGateway,
  key: string,
): PluginRuntimeGateway {
  return {
    ...gateway,
    generateText: (input) =>
      gateway.generateText({ ...input, promptCacheKey: key }),
  };
}
