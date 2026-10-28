import { observeJsonRequest } from "./request-observation.js";
import {
  assertLlmRequestBudget,
  awaitLlmRequest,
  createLlmRequestScope,
  trimTrailingSlashes,
} from "@covel/shared";
import type { FormData as UndiciFormData } from "undici";
import { ProviderBaseUrlError } from "../../errors.js";
import { providerHostPolicy } from "../../host-policy.js";
import { isRelayableBaseUrl, type ProviderRelay } from "./model-relay.js";
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
import { readAccountFailure } from "./response.js";
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
    throw new ProviderBaseUrlError("Provider error: baseUrl is required.");
  }
  if (!validateBaseUrl(baseUrl)) {
    // On a shared host a player's own gateway (127.0.0.1, a LAN address) is
    // the usual cause: say why the server cannot reach it and what works.
    const sharedHost = !providerHostPolicy().localNetwork;
    const explanation = !sharedHost
      ? ""
      : isRelayableBaseUrl(baseUrl)
        ? " This is a shared server: it reaches an endpoint on your computer or local network only through the local model relay in your browser, and no relay was connected for this request. Keep the page open and try again, and check that the model server allows this site through CORS."
        : " This is a shared server and it sends model requests to public addresses itself, over HTTPS only. Use a public HTTPS endpoint; an endpoint on your computer or local network (127.0.0.1, localhost, a private address or a .local name) goes through your browser instead.";
    throw new ProviderBaseUrlError(
      `Provider error: baseUrl "${baseUrl}" is not allowed. Only public HTTPS endpoints are permitted (private/internal IPs are blocked).${explanation}`,
    );
  }
}

/**
 * The player's browser, when this request goes to an endpoint on their
 * computer or network that they chose themselves (`relayable`: no server-owned
 * credential attached) and the host is shared. A personal host reaches such
 * an endpoint itself.
 */
function relayFor(config: ProviderConfig): ProviderRelay | undefined {
  return config.relay &&
    config.relayable === true &&
    !providerHostPolicy().localNetwork &&
    isRelayableBaseUrl(config.baseUrl)
    ? config.relay
    : undefined;
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * How this request leaves the server: through the relay for an endpoint on
 * the player's computer, otherwise over the network after the SSRF guard.
 */
function transportFor(config: ProviderConfig): {
  readonly send: Transport;
  readonly baseUrl: string;
} {
  const relay = relayFor(config);
  if (!relay) {
    assertAllowedBaseUrl(config.baseUrl);
    return { send: pinnedFetch, baseUrl: config.baseUrl };
  }
  // relayFor accepted this URL, so it is a non-empty string.
  const baseUrl = config.baseUrl as string;
  const send: Transport = (url, init) =>
    relay.fetch({
      url,
      method: init.method === "GET" ? "GET" : "POST",
      headers: { ...(init.headers as Record<string, string> | undefined) },
      ...(typeof init.body === "string" ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  return { send, baseUrl };
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
  const { send, baseUrl } = transportFor(config);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
    ...overrideHeaders,
  };

  const url =
    typeof path === "string"
      ? buildProviderUrl(baseUrl, path)
      : (() => {
          const endpoint = new URL(baseUrl);
          endpoint.pathname =
            trimTrailingSlashes(endpoint.pathname) + path.append;
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
            send(url, {
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
      // A 429 for an empty account is no rate limit: the provider answers the
      // same way until the player adds credit.
      let bodyRead = false;
      if (
        response.status === 429 &&
        response.headers.get("x-should-retry") !== "true"
      ) {
        const read = await awaitLlmRequest(
          readAccountFailure(response),
          effectiveSignal,
        );
        if (read.account) return read.response;
        bodyRead = true;
      }
      // Discard rejected bodies without buffering an unbounded error stream.
      if (!bodyRead && response.body) {
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
  const { send, baseUrl } = transportFor(config);

  const headers: Record<string, string> = {
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
    ...overrideHeaders,
  };

  const url = buildProviderUrl(baseUrl, path);
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
        send(url, {
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
  if (relayFor(config)) {
    throw new ProviderBaseUrlError(
      `Provider error: baseUrl "${config.baseUrl}" is on your computer, and file uploads cannot go through the local model relay. Use a public HTTPS endpoint for this model.`,
    );
  }
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
