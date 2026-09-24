/**
 * Community HTTP permission enforcement (fail-closed) for outbound plugin HTTP.
 *
 * A community plugin may only reach an origin+method it declared under
 * `permissions.http`; anything else is rejected before the request is sent. The
 * SSRF guard (private-IP / DNS-rebinding checks inside `utils.fetchWithRetry`)
 * still runs for permitted origins — this is an ADDITIONAL allowlist, not a
 * replacement. Builtin plugins are trusted and NOT enforced (their
 * calls are already audited via the `utils.fetch.*` trace events emitted by
 * `withUtilsTrace`), so the facade returns their utils unchanged.
 *
 * Coverage: the wrapped utils are injected into BOTH `ctx.utils` and
 * `ctx.media` (see `turn-function-runtime.ts`), so `ctx.media.ingestUrl` — and
 * any remote URL `ctx.images.generate` / `ctx.speech.*` asks the media context
 * to ingest — is gated by the same allowlist as `ctx.utils.fetchWithRetry`.
 * Consequence for community plugins: an origin that only appears in a provider
 * response (image CDN, expiring asset URL) must still be declared under
 * `permissions.http`, otherwise ingest fails closed with
 * `http permission denied: …`.
 */

import type { PluginRuntimeUtils } from "@covel/shared/plugin-runtime";
import type { HttpPermissionDecl } from "@covel/shared";

export interface HttpPermissionOptions {
  /** True when the calling plugin is community-tier (untrusted). */
  readonly isCommunity: boolean;
  /** The runtime's declared `permissions.http` upper bound. */
  readonly httpPermissions: readonly HttpPermissionDecl[];
  /** For explanatory error messages. */
  readonly runtimeId: string;
}

/** Canonical origin (scheme + host + port) of a URL, or undefined if unparseable. */
function canonicalOrigin(raw: string): string | undefined {
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/**
 * Wrap `utils` so a community plugin's HTTP calls are checked against its
 * declared `permissions.http`. Trusted plugins get the utils back unchanged.
 */
export function enforceHttpPermissions(
  utils: PluginRuntimeUtils,
  opts: HttpPermissionOptions,
): PluginRuntimeUtils {
  if (!opts.isCommunity) return utils;

  // Pre-normalize the allowlist once: canonical origin → permitted methods
  // (methods default to GET only when the declaration omits them).
  const allow = opts.httpPermissions.map((p) => ({
    origin: canonicalOrigin(p.origin),
    methods: new Set((p.methods ?? ["GET"]).map((m) => m.toUpperCase())),
  }));

  return {
    validateBaseUrl: (url) => utils.validateBaseUrl(url),
    async fetchWithRetry(input, init) {
      const urlStr = typeof input === "string" ? input : input.href;
      const requestOrigin = canonicalOrigin(urlStr);
      const method = (init?.method ?? "GET").toUpperCase();
      const permitted =
        requestOrigin !== undefined &&
        allow.some((a) => a.origin === requestOrigin && a.methods.has(method));
      if (!permitted) {
        throw new Error(
          `http permission denied: ${opts.runtimeId} may not ${method} ` +
            `${requestOrigin ?? "(invalid url)"} — declare the origin under permissions.http`,
        );
      }
      return utils.fetchWithRetry(input, init);
    },
  };
}
