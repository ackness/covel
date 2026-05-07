/**
 * PR-6: Per-runtime model slot resolver.
 *
 * Sits in front of the existing `model-resolver.ts` chain. Given a runtime
 * manifest plus the session-level overrides map, returns the effective slot
 * name to feed downstream resolution.
 *
 * Priority (highest → lowest):
 *   1. Session override for this exact runtime ID
 *   2. Manifest `model` field
 *   3. Caller-supplied default (`undefined` → fall through to gateway default)
 *
 * The session map key uses the runtime's full identifier — for single-runtime
 * plugins this equals `pluginId`; for multi-runtime plugins it is
 * `pluginId/runtimeName`. The resolver only consults the exact key — there
 * is intentionally no plugin-level fan-out, so an override on
 * `codex/unlocker` does not silently apply to `codex/retriever`.
 */

import type { RuntimeManifest } from "@covel/shared";

export function resolveRuntimeSlot(
  manifest: RuntimeManifest,
  sessionOverrides: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const sessionSlot = sessionOverrides?.[manifest.name];
  if (sessionSlot && sessionSlot.length > 0) {
    return sessionSlot;
  }
  return manifest.model;
}
