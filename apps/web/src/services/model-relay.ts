/**
 * The browser side of the local model relay.
 *
 * On a shared server (health `deployment.modelRelay`), model requests run on
 * the server, which cannot reach the player's computer or local network. When
 * the player has configured such an endpoint, this module opens one relay
 * channel (`GET /api/model-relay/stream`) under a random ID and sends the same
 * ID in `X-Model-Relay` with model requests. The server hands each call to a
 * local endpoint to this channel; the browser makes it and posts the answer
 * back in pieces.
 *
 * The browser decides what it calls. A request is made only when its URL is
 * under one of the endpoints the player configured in this browser, on their
 * computer or local network, with GET or POST, without cookies and without
 * following redirects. Anything else is answered with a failure and never
 * fetched, so the server cannot use the relay to reach other addresses.
 */

import { isLocalNetworkBaseUrl, isLoopbackHostUrl } from "@covel/shared";
import { relayResponseBody } from "./model-relay-body.js";
import { getSettings } from "@/settings/store";
import { isModelRelaySupported } from "@/services/api/health.js";
import { parseJsonSseData, readSseStream } from "@/services/sse.js";

const STREAM_URL = "/api/model-relay/stream";
const CHANNEL_HEADER = "X-Model-Relay";
const MAX_BACKOFF_MS = 30_000;

/** Request headers the browser sets itself or that would leak this page. */
const DROPPED_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

interface RelayRequestEvent {
  readonly type: "request";
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

interface RelayCancelEvent {
  readonly type: "cancel";
  readonly id: string;
}

type RelayEvent = RelayRequestEvent | RelayCancelEvent;

function randomChannelId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Lives as long as this page: a reload starts a new channel. */
const channelId = randomChannelId();
const inflight = new Map<string, AbortController>();
let running = false;
let unsupported = false;

interface ProviderProfileLike {
  readonly baseUrl?: unknown;
}

/**
 * The endpoints this browser may call for the server: the player's own
 * provider connections that are on their computer or local network.
 */
export function relayEndpoints(): URL[] {
  const profiles =
    getSettings().get<readonly ProviderProfileLike[]>("llm.providers") ?? [];
  const endpoints: URL[] = [];
  for (const profile of profiles) {
    const baseUrl =
      typeof profile.baseUrl === "string" ? profile.baseUrl.trim() : "";
    if (!isLocalNetworkBaseUrl(baseUrl)) continue;
    try {
      endpoints.push(new URL(baseUrl));
    } catch {
      /* isLocalNetworkBaseUrl parsed it; unreachable. */
    }
  }
  return endpoints;
}

function basePath(url: URL): string {
  return url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
}

/** Why this browser refuses a relay request, or undefined to make it. */
export function relayRefusal(
  request: Pick<RelayRequestEvent, "url" | "method">,
  endpoints: readonly URL[] = relayEndpoints(),
): string | undefined {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return "the address is not a URL.";
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return `this browser relays only GET and POST, not ${request.method}.`;
  }
  // An encoded separator could step outside the endpoint's path on a server
  // that decodes it before routing.
  if (/%(2f|5c|2e)/i.test(target.pathname)) {
    return "this browser does not relay a path with encoded separators.";
  }
  const configured = endpoints.some(
    (endpoint) =>
      endpoint.origin === target.origin &&
      `${target.pathname}/`.startsWith(basePath(endpoint)),
  );
  if (!configured || !isLocalNetworkBaseUrl(target.href)) {
    return `this browser relays only to the model endpoints you added in Settings on your computer or local network, and ${target.origin} is not one of them.`;
  }
  if (target.protocol === "http:" && target.hostname === "[::1]") {
    return "use http://127.0.0.1 instead of http://[::1]: the page may reach this computer only through 127.0.0.1 or localhost.";
  }
  if (target.protocol === "http:" && !isLoopbackHostUrl(target)) {
    return `browsers do not let an HTTPS page reach a plain-http address on your local network (${target.origin}). Serve the model over HTTPS, or forward it on this computer through 127.0.0.1 or localhost.`;
  }
  return undefined;
}

/** Whether model requests from this page should name the relay channel. */
function relayWanted(): boolean {
  return !unsupported && isModelRelaySupported() && relayEndpoints().length > 0;
}

/**
 * The header that names this page's relay channel, when the server offers the
 * relay and the player configured a local endpoint. Opens the channel on
 * first use.
 */
export function modelRelayHeaders(): Record<string, string> {
  if (!relayWanted()) return {};
  if (!running) void runChannel();
  return { [CHANNEL_HEADER]: channelId };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function post(
  requestId: string,
  phase: "head" | "chunk" | "end" | "fail",
  body?: { json: unknown } | { bytes: Uint8Array },
): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/model-relay/requests/${encodeURIComponent(requestId)}/${phase}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          [CHANNEL_HEADER]: channelId,
          ...(body
            ? {
                "Content-Type":
                  "json" in body
                    ? "application/json"
                    : "application/octet-stream",
              }
            : {}),
        },
        ...(body
          ? {
              body:
                "json" in body
                  ? JSON.stringify(body.json)
                  : (body.bytes as unknown as BodyInit),
            }
          : {}),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

function describeFailure(error: unknown, target: URL): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "the request was cancelled.";
  }
  return `your browser could not reach ${target.origin}. Check that the model server is running and allows ${window.location.origin} through CORS, and that the browser may access your local network.`;
}

async function handleRequest(event: RelayRequestEvent): Promise<void> {
  const refusal = relayRefusal(event);
  if (refusal) {
    await post(event.id, "fail", { json: { message: refusal } });
    return;
  }
  const target = new URL(event.url);
  const controller = new AbortController();
  inflight.set(event.id, controller);
  try {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(event.headers ?? {})) {
      const lower = name.toLowerCase();
      if (DROPPED_REQUEST_HEADERS.has(lower)) continue;
      if (lower.startsWith("proxy-") || lower.startsWith("sec-")) continue;
      headers[name] = value;
    }
    const response = await fetch(target, {
      method: event.method,
      headers,
      ...(event.method === "POST" && event.body !== undefined
        ? { body: event.body }
        : {}),
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "cors",
    });
    const headOk = await post(event.id, "head", {
      json: {
        status: response.status,
        ...(response.statusText ? { statusText: response.statusText } : {}),
        headers: Object.fromEntries(response.headers.entries()),
      },
    });
    if (!headOk) {
      controller.abort();
      await response.body?.cancel().catch(() => {});
      // The server may still be waiting for this request: tell it.
      await post(event.id, "fail", {
        json: { message: "the model server's answer was refused." },
      });
      return;
    }
    const reader = response.body?.getReader();
    if (reader) {
      if (
        !(await relayResponseBody(reader, (bytes) =>
          post(event.id, "chunk", { bytes }),
        ))
      ) {
        controller.abort();
        return;
      }
    }
    await post(event.id, "end");
  } catch (error) {
    await post(event.id, "fail", {
      json: { message: describeFailure(error, target) },
    });
  } finally {
    inflight.delete(event.id);
  }
}

/** Only string-valued headers survive the trip from the server. */
function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string") result[name] = item;
  }
  return result;
}

function parseRelayEvent(data: string): RelayEvent | undefined {
  const parsed = parseJsonSseData<{
    readonly type?: unknown;
    readonly id?: unknown;
    readonly url?: unknown;
    readonly method?: unknown;
    readonly headers?: unknown;
    readonly body?: unknown;
  }>(data);
  if (!parsed || typeof parsed.id !== "string") return undefined;
  if (parsed.type === "cancel") return { type: "cancel", id: parsed.id };
  if (
    parsed.type === "request" &&
    typeof parsed.url === "string" &&
    typeof parsed.method === "string"
  ) {
    return {
      type: "request",
      id: parsed.id,
      url: parsed.url,
      method: parsed.method,
      headers: stringRecord(parsed.headers),
      ...(typeof parsed.body === "string" ? { body: parsed.body } : {}),
    };
  }
  return undefined;
}

/** Keep the channel open while it is wanted, reconnecting after a drop. */
async function runChannel(): Promise<void> {
  if (running) return;
  running = true;
  let backoff = 1_000;
  try {
    while (relayWanted()) {
      try {
        const response = await fetch(STREAM_URL, {
          headers: { Accept: "text/event-stream", [CHANNEL_HEADER]: channelId },
          cache: "no-store",
          credentials: "same-origin",
        });
        // A server without the relay answers 404: stop asking.
        if (response.status === 404) {
          unsupported = true;
          await response.body?.cancel().catch(() => {});
          return;
        }
        if (!response.ok)
          throw new Error(`relay stream: HTTP ${response.status}`);
        backoff = 1_000;
        await readSseStream<RelayEvent>({
          response,
          parse: (data) => parseRelayEvent(data),
          onMessage: (event) => {
            if (event.type === "cancel") {
              inflight.get(event.id)?.abort();
            } else {
              void handleRequest(event);
            }
          },
        });
      } catch {
        // Dropped or refused: try again after a pause.
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  } finally {
    running = false;
  }
}
