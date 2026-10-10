import { createHash } from "node:crypto";

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
