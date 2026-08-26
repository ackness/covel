import type { FormData as UndiciFormData } from "undici";
import type { ProviderConfig } from "../../types.js";
import { outboundFetch } from "../../outbound-network.js";
import {
  computeBackoffMs,
  isRetriableStatus,
  isRetryDisabled,
  MAX_RETRIES,
  parseRetryAfterMs,
  sleepWithAbort,
} from "./retry.js";
import { buildProviderUrl, validateBaseUrl } from "./url-safety.js";

/**
 * Framework-owned requests use one npm Undici transport. Direct mode keeps
 * DNS pinning; desktop proxy modes select a matching npm Undici ProxyAgent.
 */
async function pinnedFetch(url: string, init: RequestInit): Promise<Response> {
  return outboundFetch(url, init);
}

function assertAllowedBaseUrl(
  baseUrl: string | undefined,
): asserts baseUrl is string {
  if (!baseUrl) {
    throw new Error("Provider error: baseUrl is required.");
  }
  if (!validateBaseUrl(baseUrl)) {
    throw new Error(
      `Provider error: baseUrl "${baseUrl}" is not allowed. Only public HTTPS endpoints are permitted (private/internal IPs are blocked).`,
    );
  }
}

/**
 * Reject 3xx redirects instead of following them. Only the initial baseUrl is
 * SSRF-checked (assertAllowedBaseUrl); a redirect Location is not, so following
 * it could reach a blocked internal/metadata host from an attacker-controlled
 * provider endpoint. LLM provider POSTs do not legitimately redirect, so we use
 * `redirect: "manual"` and fail closed on a 3xx.
 */
function rejectRedirect(response: Response, url: string): Response {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Provider error: refusing to follow redirect (HTTP ${response.status}) from "${url}".`,
    );
  }
  return response;
}

export async function postJson(
  config: ProviderConfig,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  overrideHeaders?: Record<string, string>,
): Promise<Response> {
  assertAllowedBaseUrl(config.baseUrl);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
    ...overrideHeaders,
  };

  const url = buildProviderUrl(config.baseUrl, path);
  const serializedBody = JSON.stringify(body);
  const effectiveSignal = signal ?? config.signal;

  const doFetch = async (): Promise<Response> =>
    rejectRedirect(
      await pinnedFetch(url, {
        method: "POST",
        headers,
        body: serializedBody,
        redirect: "manual",
        signal: effectiveSignal,
      }),
      url,
    );

  if (isRetryDisabled()) {
    return doFetch();
  }

  let response = await doFetch();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (!isRetriableStatus(response.status)) {
      return response;
    }

    await response.arrayBuffer().catch(() => {
      /* body already consumed or stream error */
    });

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const delay = retryAfterMs ?? computeBackoffMs(attempt);
    await sleepWithAbort(delay, effectiveSignal);

    response = await doFetch();
  }

  return response;
}

/**
 * Single-shot GET with the same SSRF guard + redirect posture as postJson.
 * No built-in retry: callers that poll (e.g. the DashScope WAN wire) already
 * control their own interval/backoff and decide per-status whether to retry.
 */
export async function getJson(
  config: ProviderConfig,
  path: string,
  signal?: AbortSignal,
  overrideHeaders?: Record<string, string>,
): Promise<Response> {
  assertAllowedBaseUrl(config.baseUrl);

  const headers: Record<string, string> = {
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
    ...overrideHeaders,
  };

  const url = buildProviderUrl(config.baseUrl, path);
  const effectiveSignal = signal ?? config.signal;

  return rejectRedirect(
    await pinnedFetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: effectiveSignal,
    }),
    url,
  );
}

export async function postFormData(
  config: ProviderConfig,
  path: string,
  body: UndiciFormData,
  signal?: AbortSignal,
): Promise<Response> {
  assertAllowedBaseUrl(config.baseUrl);

  const url = buildProviderUrl(config.baseUrl, path);
  return rejectRedirect(
    await pinnedFetch(url, {
      method: "POST",
      headers: {
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        ...config.headers,
      },
      body: body as unknown as BodyInit,
      redirect: "manual",
      signal: signal ?? config.signal,
    }),
    url,
  );
}
