/**
 * Plugin-facing utility surface.
 *
 * Plugins live outside the workspace and cannot import internal modules
 * (`adapters/http.ts`, etc.) directly. The runtime injects these helpers
 * into `FunctionHandlerContext.utils` so plugin handlers get a vetted
 * SSRF guard + retrying fetch without each plugin re-implementing them.
 *
 * Keep the surface narrow: validateBaseUrl + fetchWithRetry. Anything
 * fancier (streaming, multipart) belongs in `@covel/ai-provider`'s
 * private adapter helpers, not in plugin land.
 */

import {
  validateBaseUrl as validateBaseUrlInternal,
  isRetriableStatus,
  computeBackoffMs,
  parseRetryAfterMs,
  sleepWithAbort,
} from "./adapters/http.js";
import { createPinnedDispatcher } from "./adapters/http/dns-safety.js";
import type { ImageWire } from "./image/types.js";
import type { SpeechWire, TranscriptionWire } from "./speech/types.js";

/**
 * Shape of a plugin's media-wire registrations — what a wires module
 * default-exports (legacy `wires` frontmatter) and what
 * `PluginAPI.registerWires()` accepts (unified `entry` path). Each wire is
 * registered under the `<pluginId>/<wireId>` namespace.
 */
export interface WireModuleShape {
  readonly image?: readonly ImageWire[];
  readonly speech?: readonly SpeechWire[];
  readonly transcription?: readonly TranscriptionWire[];
}

export interface BaseUrlValidationResult {
  /** True when the URL passes SSRF policy. */
  readonly ok: boolean;
  /** Populated when ok=false; safe to surface in error messages. */
  readonly reason?: string;
}

/**
 * SSRF-safe URL check exposed to plugin handlers.
 * Mirrors `validateBaseUrl` from the internal http helpers but returns
 * a structured result so plugins can pipe the reason into their own
 * error records / logger calls.
 */
export function validateBaseUrlForPlugin(url: string): BaseUrlValidationResult {
  if (!url) return { ok: false, reason: "baseUrl is empty" };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        reason: `baseUrl protocol must be http(s): ${parsed.protocol}`,
      };
    }
  } catch {
    return { ok: false, reason: `baseUrl is not a valid URL: ${url}` };
  }
  if (validateBaseUrlInternal(url)) return { ok: true };
  return {
    ok: false,
    reason:
      `baseUrl rejected by SSRF policy: ${url} ` +
      `(private/link-local IP, cloud metadata host, or non-loopback http).`,
  };
}

export interface FetchWithRetryOptions {
  /**
   * Max retries after the initial attempt (default 3 — same as the
   * provider adapter's policy). Set to 0 to disable retries.
   */
  readonly maxRetries?: number;
  /** Abort signal — propagates into both fetch and the inter-attempt sleep. */
  readonly signal?: AbortSignal;
}

/**
 * fetch with exponential-backoff retry on 429 / 5xx. Honors `Retry-After`
 * when the server sends it. Does NOT retry on thrown fetch errors
 * (DNS / connection refused / network) — those bubble up to the caller.
 *
 * Plugins should call this for their own wire requests instead of bare
 * `fetch` so retry policy stays consistent across the framework.
 */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit & FetchWithRetryOptions = {},
): Promise<Response> {
  const { maxRetries = 3, signal, ...rest } = init;

  const url = new URL(input.toString());
  const verdict = validateBaseUrlForPlugin(url.toString());
  if (!verdict.ok) {
    throw new Error(
      verdict.reason ?? `baseUrl rejected by SSRF policy: ${url}`,
    );
  }

  const doFetch = async (): Promise<Response> => {
    // A fresh resolution + dispatcher per attempt prevents a retry from
    // following changed DNS to an address that was never policy-checked.
    const dispatcher = await createPinnedDispatcher(url);
    try {
      return await fetch(input, {
        ...rest,
        ...(signal ? { signal } : {}),
        dispatcher,
      } as RequestInit);
    } finally {
      // close() drains active response bodies before releasing the pool, so it
      // is safe to start shutdown once fetch has returned the response headers.
      void dispatcher.close();
    }
  };

  let response = await doFetch();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (!isRetriableStatus(response.status)) return response;
    await response.arrayBuffer().catch(() => {
      /* drain ignored */
    });
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const delay = retryAfterMs ?? computeBackoffMs(attempt);
    await sleepWithAbort(delay, signal);
    response = await doFetch();
  }
  return response;
}
