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
  sleepWithAbort,
} from "./adapters/http.js";
import {
  MAX_RETRY_AFTER_MS,
  parseRetryDelayMs,
} from "./adapters/http/retry.js";
import { createPinnedDispatcher } from "./adapters/http/dns-safety.js";
import { fetchWithDispatcher, outboundFetch } from "./outbound-network.js";
import type { ImageWire } from "./image/types.js";
import type { MusicWire } from "./music/types.js";
import type { SpeechWire, TranscriptionWire } from "./speech/types.js";
import type { TextWire } from "./text/types.js";

/**
 * Shape of the media-wire registrations `PluginAPI.registerWires()` accepts
 * from the plugin's `entry` module. Each wire is
 * registered under the `<pluginId>/<wireId>` namespace.
 */
export interface WireModuleShape {
  readonly image?: readonly ImageWire[];
  readonly speech?: readonly SpeechWire[];
  readonly transcription?: readonly TranscriptionWire[];
  readonly music?: readonly MusicWire[];
  readonly text?: readonly TextWire[];
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
  /**
   * Optional overall request timeout in milliseconds. Bounds both in-flight
   * attempts and inter-attempt retry sleeps; a Retry-After or backoff wait that
   * would outlast this deadline fails fast and returns the response immediately.
   */
  readonly timeoutMs?: number;
  /**
   * Outbound transport policy:
   * - `"direct"` (default): pinned DNS direct fetch (`fetchWithRetry`).
   * - `"instance-auth"`: bounded proxy path for `net.authProxy` in `personal`
   *   deployments; rejected on direct `fetchWithRetry`.
   */
  readonly proxy?: "direct" | "instance-auth";
}

async function runRetryingPluginFetch(
  input: string | URL,
  init: RequestInit & FetchWithRetryOptions,
  options: { readonly useAuthProxy: boolean },
): Promise<Response> {
  const {
    maxRetries = 3,
    signal,
    timeoutMs,
    redirect,
    proxy: _proxy,
    ...rest
  } = init;
  // Direct fetch honors an explicit `manual` opt-in; proxy fetch refuses 3xx unconditionally.
  const returnRedirects = !options.useAuthProxy && redirect === "manual";

  const url = new URL(input.toString());
  const verdict = validateBaseUrlForPlugin(url.toString());
  if (!verdict.ok) {
    throw new Error(
      verdict.reason ?? `baseUrl rejected by SSRF policy: ${url}`,
    );
  }

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined;
  let effectiveSignal = signal;
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
    const boundedTimeoutMs = Math.max(0, timeoutMs);
    deadline = Date.now() + boundedTimeoutMs;
    const timeoutController = new AbortController();
    timeoutTimer = setTimeout(() => {
      timeoutController.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    }, boundedTimeoutMs);
    effectiveSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
  }

  const doFetch = async (): Promise<Response> => {
    const requestInit: RequestInit = {
      ...rest,
      redirect: "manual",
      ...(effectiveSignal ? { signal: effectiveSignal } : {}),
    };
    if (options.useAuthProxy) {
      // Proxy resolves destination DNS at the proxy hop; when direct/DIRECT
      // fallback is chosen, strictDirect keeps plugin requests on the strict
      // non-private DNS policy, and 3xx redirects are still refused.
      const response = await outboundFetch(input, requestInit, {
        strictDirect: true,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `baseUrl rejected by SSRF policy: refusing to follow redirect (HTTP ${response.status}) from "${url}".`,
        );
      }
      return response;
    }

    // A fresh resolution + dispatcher per attempt prevents a retry from
    // following changed DNS to an address that was never policy-checked.
    const dispatcher = await createPinnedDispatcher(url);
    try {
      const response = await fetchWithDispatcher(
        input,
        requestInit,
        dispatcher,
      );
      if (!returnRedirects && response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `baseUrl rejected by SSRF policy: refusing to follow redirect (HTTP ${response.status}) from "${url}".`,
        );
      }
      return response;
    } finally {
      // close() drains active response bodies before releasing the pool, so it
      // is safe to start shutdown once fetch has returned the response headers.
      void dispatcher.close().catch(() => {});
    }
  };

  try {
    let response = await doFetch();
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (!isRetriableStatus(response.status)) return response;
      const retryAfterMs = parseRetryDelayMs(response.headers);
      // Mirror core provider retry semantics (`adapters/http/request.ts`): a
      // remote endpoint cannot pin a worker indefinitely with a huge
      // Retry-After header, nor outlast the caller's timeout deadline. Return
      // the response intact so the caller can read the failure reason.
      if (
        retryAfterMs !== null &&
        (retryAfterMs > MAX_RETRY_AFTER_MS ||
          (deadline !== undefined && Date.now() + retryAfterMs > deadline))
      ) {
        return response;
      }
      const delay = retryAfterMs ?? computeBackoffMs(attempt);
      if (deadline !== undefined && Date.now() + delay > deadline) {
        return response;
      }
      await response.body?.cancel().catch(() => {});
      await sleepWithAbort(delay, effectiveSignal);
      response = await doFetch();
    }
    return response;
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  }
}

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit & FetchWithRetryOptions = {},
): Promise<Response> {
  if (init.proxy === "instance-auth") {
    throw new Error("net.authProxy is not permitted on direct fetchWithRetry");
  }
  return runRetryingPluginFetch(input, init, { useAuthProxy: false });
}

/**
 * Retrying fetch for bounded `net.authProxy` requests in `personal` mode:
 * validates the target URL against SSRF policy, routes through the configured
 * host proxy without local DNS pinning, and unconditionally rejects 3xx hops.
 */
export async function fetchWithAuthProxyRetry(
  input: string | URL,
  init: RequestInit & FetchWithRetryOptions = {},
): Promise<Response> {
  return runRetryingPluginFetch(input, init, { useAuthProxy: true });
}
