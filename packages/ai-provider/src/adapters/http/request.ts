import { observeJsonRequest } from "./request-observation.js";
import {
  assertLlmRequestBudget,
  awaitLlmRequest,
  createLlmRequestScope,
} from "@covel/shared";
import type { FormData as UndiciFormData } from "undici";
import type { ProviderConfig } from "../../types.js";
import { outboundFetch } from "../../outbound-network.js";
import {
  computeBackoffMs,
  isConnectionError,
  isRetryDisabled,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryDelayMs,
  shouldRetryResponse,
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
    void response.body?.cancel().catch(() => {});
    throw new Error(
      `Provider error: refusing to follow redirect (HTTP ${response.status}) from "${url}".`,
    );
  }
  return response;
}

export async function postJson(
  config: ProviderConfig,
  path: string | { append: string },
  body: Record<string, unknown>,
  signal?: AbortSignal,
  overrideHeaders?: Record<string, string>,
  options?: { retry?: boolean },
): Promise<Response> {
  assertAllowedBaseUrl(config.baseUrl);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
    ...overrideHeaders,
  };

  const url =
    typeof path === "string"
      ? buildProviderUrl(config.baseUrl, path)
      : (() => {
          const endpoint = new URL(config.baseUrl);
          endpoint.pathname =
            endpoint.pathname.replace(/\/+$/, "") + path.append;
          return endpoint.toString();
        })();
  const serializedBody = JSON.stringify(body);
  const scope = config.requestBudget
    ? createLlmRequestScope({
        budget: config.requestBudget,
        signal: signal ?? config.signal,
      })
    : undefined;
  const effectiveSignal = scope?.signal ?? signal ?? config.signal;

  let transportAttempt = 0;
  let transportRetryReason:
    "http-429" | "http-4xx" | "http-5xx" | "connection" | undefined;
  const doFetch = async (): Promise<Response> => {
    if (scope)
      assertLlmRequestBudget(scope.budget, {
        signal: effectiveSignal,
        consumeAttempt: true,
      });
    return observeJsonRequest(
      config.requestObservation,
      serializedBody,
      transportAttempt++,
      async () => {
        effectiveSignal?.throwIfAborted();
        return rejectRedirect(
          await awaitLlmRequest(
            pinnedFetch(url, {
              method: "POST",
              headers,
              body: serializedBody,
              redirect: "manual",
              signal: effectiveSignal,
            }),
            effectiveSignal,
          ),
          url,
        );
      },
      scope ? scope.budget.attempts - 1 : undefined,
      transportRetryReason,
    );
  };

  // Retries of both kinds, a response that asks for one and a connection
  // that gave no response, count against one limit.
  let retries = 0;
  const fetchThroughDrops = async (): Promise<Response> => {
    for (;;) {
      try {
        return await doFetch();
      } catch (error) {
        if (
          retries >= MAX_RETRIES ||
          effectiveSignal?.aborted ||
          !isConnectionError(error)
        )
          throw error;
        if (scope)
          assertLlmRequestBudget(scope.budget, {
            signal: effectiveSignal,
            requireAttempt: true,
          });
        await sleepWithAbort(computeBackoffMs(retries), effectiveSignal);
        retries += 1;
        transportRetryReason = "connection";
      }
    }
  };

  try {
    if (
      options?.retry === false ||
      config.transportRetry === false ||
      isRetryDisabled()
    ) {
      return await doFetch();
    }

    let response = await fetchThroughDrops();

    while (retries < MAX_RETRIES && shouldRetryResponse(response)) {
      const retryAfterMs = parseRetryDelayMs(response.headers);
      // A wait the call cannot sit out is not waited for: the caller gets the
      // provider's answer while there is still time to use a backup model.
      if (
        retryAfterMs !== null &&
        (retryAfterMs > MAX_RETRY_AFTER_MS ||
          (scope !== undefined &&
            Date.now() + retryAfterMs > scope.budget.deadline))
      )
        return response;
      // Discard rejected bodies without buffering an unbounded error stream.
      if (response.body) {
        await awaitLlmRequest(
          response.body.cancel().catch(() => {}),
          effectiveSignal,
        );
      }
      if (scope)
        assertLlmRequestBudget(scope.budget, {
          signal: effectiveSignal,
          requireAttempt: true,
        });

      const delay = retryAfterMs ?? computeBackoffMs(retries);
      await sleepWithAbort(delay, effectiveSignal);

      // Counted before the request is sent again, so a connection that drops
      // during this retry cannot use the count a second time.
      retries += 1;
      transportRetryReason =
        response.status === 429
          ? "http-429"
          : response.status >= 500
            ? "http-5xx"
            : "http-4xx";
      response = await fetchThroughDrops();
    }

    return response;
  } finally {
    scope?.dispose();
  }
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
  const scope = config.requestBudget
    ? createLlmRequestScope({
        budget: config.requestBudget,
        signal: signal ?? config.signal,
      })
    : undefined;
  const effectiveSignal = scope?.signal ?? signal ?? config.signal;

  try {
    if (scope)
      assertLlmRequestBudget(scope.budget, {
        signal: effectiveSignal,
        consumeAttempt: true,
      });
    return rejectRedirect(
      await awaitLlmRequest(
        pinnedFetch(url, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: effectiveSignal,
        }),
        effectiveSignal,
      ),
      url,
    );
  } finally {
    scope?.dispose();
  }
}

export async function postFormData(
  config: ProviderConfig,
  path: string,
  body: UndiciFormData,
  signal?: AbortSignal,
): Promise<Response> {
  assertAllowedBaseUrl(config.baseUrl);

  const url = buildProviderUrl(config.baseUrl, path);
  const scope = config.requestBudget
    ? createLlmRequestScope({
        budget: config.requestBudget,
        signal: signal ?? config.signal,
      })
    : undefined;
  try {
    if (scope)
      assertLlmRequestBudget(scope.budget, {
        signal: scope?.signal ?? signal ?? config.signal,
        consumeAttempt: true,
      });
    return rejectRedirect(
      await awaitLlmRequest(
        pinnedFetch(url, {
          method: "POST",
          headers: {
            ...(config.apiKey
              ? { authorization: `Bearer ${config.apiKey}` }
              : {}),
            ...config.headers,
          },
          body: body as unknown as BodyInit,
          redirect: "manual",
          signal: scope?.signal ?? signal ?? config.signal,
        }),
        scope?.signal ?? signal ?? config.signal,
      ),
      url,
    );
  } finally {
    scope?.dispose();
  }
}
