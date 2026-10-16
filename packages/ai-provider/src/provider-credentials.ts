import { getBuiltinProviderConnection } from "@covel/shared";
import { AiProviderError } from "./errors.js";
import type { ProviderResolution } from "./provider-registry.js";

/** Check effective credentials after request and server keys have been merged. */
export function assertProviderCredentials(
  provider: string,
  resolved: ProviderResolution,
): void {
  const builtin = getBuiltinProviderConnection(provider);
  if (!builtin || builtin.local || resolved.usesBuiltinAdapter === false)
    return;
  // A custom endpoint may be an unauthenticated LAN gateway, even when it
  // uses a built-in provider's name or protocol. Only the known remote origin
  // has a credential requirement we can enforce without making a request.
  if (resolved.config.baseUrl) {
    try {
      if (
        new URL(resolved.config.baseUrl).origin !==
        new URL(builtin.baseUrl).origin
      )
        return;
    } catch {
      return; // Invalid addresses retain their existing configuration error.
    }
  }
  if (resolved.config.apiKey?.trim()) return;
  const authHeaders = new Set([
    "authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
  ]);
  if (
    Object.entries(resolved.config.headers ?? {}).some(
      ([name, value]) => authHeaders.has(name.toLowerCase()) && value.trim(),
    )
  )
    return;
  throw new AiProviderError({
    code: "MISSING_API_KEY",
    message: `No API key for ${builtin.label}`,
    provider,
    retriable: false,
  });
}
