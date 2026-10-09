import type { TFunction } from "i18next";

const KINDS = new Set([
  "unreachable",
  "timeout",
  "auth",
  "quota",
  "rate_limited",
  "not_found",
  "bad_request",
  "overloaded",
  "server",
  "refused",
  "config",
]);

/**
 * What the player can do about a failed provider call, before the provider's
 * own words. A kind this build does not know shows the words alone.
 */
export function describeProviderFailure(
  t: TFunction,
  kind: string | undefined,
  error: string | undefined,
): string | undefined {
  if (!kind || !KINDS.has(kind)) return error;
  const hint = t(`settings.failureHint.${kind}`);
  return error ? `${hint} (${error})` : hint;
}
