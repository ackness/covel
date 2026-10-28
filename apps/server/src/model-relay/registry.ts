/**
 * The server side of the local model relay (see
 * `@covel/ai-provider` `adapters/http/model-relay.ts`).
 *
 * A browser on a shared server opens one relay channel
 * (`GET /api/model-relay/stream`) under a random channel ID it keeps to
 * itself, and sends the same ID in `X-Model-Relay` with its model requests.
 * When such a request calls a model on the player's computer or local
 * network, {@link ModelRelayRegistry.relayFor} hands the HTTP request to that
 * channel; the browser makes it and posts the answer back in pieces (head,
 * body chunks, end or failure), which become the body of an ordinary
 * `Response`.
 *
 * The channel ID is the only credential: a request reaches the browser that
 * named the channel, never another one. The browser decides what it is
 * willing to call (only endpoints the player configured), so this module
 * moves bytes and enforces limits; it does not judge URLs.
 */

import { randomUUID } from "node:crypto";
import type { ProviderRelay, ProviderRelayRequest } from "@covel/ai-provider";

/** A channel ID: long, random, URL-safe. */
export const MODEL_RELAY_CHANNEL_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function parseModelRelayChannel(
  value: string | undefined,
): string | undefined {
  const id = value?.trim();
  return id && MODEL_RELAY_CHANNEL_PATTERN.test(id) ? id : undefined;
}

/** What the relay stream sends the browser. */
export type ModelRelayEvent =
  | {
      readonly type: "request";
      readonly id: string;
      readonly url: string;
      readonly method: "GET" | "POST";
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string;
    }
  | { readonly type: "cancel"; readonly id: string };

export type ModelRelaySink = (event: ModelRelayEvent) => void;

export interface ModelRelayLimits {
  /** How long a model call waits for its channel to connect. */
  readonly connectWaitMs: number;
  /** How long the browser may take to answer with a status and headers. */
  readonly headTimeoutMs: number;
  /** Requests in flight on one channel. */
  readonly maxPendingPerChannel: number;
  /** Size of one request body (the prompt JSON). */
  readonly maxRequestBodyBytes: number;
  /** Size of one response body. */
  readonly maxResponseBytes: number;
  /** Channels open at once on this server. */
  readonly maxChannels: number;
}

export const DEFAULT_MODEL_RELAY_LIMITS: ModelRelayLimits = {
  connectWaitMs: 10_000,
  headTimeoutMs: 15 * 60_000,
  maxPendingPerChannel: 16,
  maxRequestBodyBytes: 16 * 1024 * 1024,
  maxResponseBytes: 64 * 1024 * 1024,
  // The same ceiling as the event stream's connections.
  maxChannels: 512,
};

/** The answer to a relay post: accepted, or why not. */
export type ModelRelayAnswer =
  "ok" | "unknown" | "too-large" | "out-of-order" | "invalid";

export interface ModelRelayHead {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface Pending {
  readonly channelId: string;
  state: "head" | "body";
  bytes: number;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  resolve(response: Response): void;
  reject(error: Error): void;
  finish(): void;
}

interface Channel {
  readonly sink: ModelRelaySink;
  /** Ends the browser's stream. */
  readonly close: () => void;
  readonly requests: Set<string>;
}

/** Response headers that describe the browser's connection, not the answer. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
]);

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function relayError(message: string): Error {
  return new Error(`Local model relay: ${message}`);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

export function createModelRelayRegistry(
  limits: Partial<ModelRelayLimits> = {},
) {
  const config = { ...DEFAULT_MODEL_RELAY_LIMITS, ...limits };
  const channels = new Map<string, Channel>();
  const pending = new Map<string, Pending>();
  const waiters = new Map<string, Set<() => void>>();

  const failChannelRequests = (channel: Channel, reason: string) => {
    for (const id of [...channel.requests]) {
      pending.get(id)?.reject(relayError(reason));
    }
  };

  const waitForChannel = (channelId: string, signal?: AbortSignal) => {
    const present = channels.get(channelId);
    if (present) return Promise.resolve(present);
    return new Promise<Channel>((resolve, reject) => {
      const set = waiters.get(channelId) ?? new Set<() => void>();
      waiters.set(channelId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(wake);
        if (set.size === 0) waiters.delete(channelId);
        signal?.removeEventListener("abort", onAbort);
      };
      const wake = () => {
        const channel = channels.get(channelId);
        if (!channel) return;
        done();
        resolve(channel);
      };
      const onAbort = () => {
        done();
        reject(abortError(signal!));
      };
      const timer = setTimeout(() => {
        done();
        reject(
          relayError(
            "your browser is not connected. Keep the page open; the relay reconnects by itself.",
          ),
        );
      }, config.connectWaitMs);
      timer.unref?.();
      set.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  async function relayFetch(
    channelId: string,
    request: ProviderRelayRequest,
  ): Promise<Response> {
    const { signal } = request;
    signal?.throwIfAborted();
    if (
      request.body !== undefined &&
      Buffer.byteLength(request.body) > config.maxRequestBodyBytes
    ) {
      throw relayError("the request is too large to relay.");
    }
    const channel = await waitForChannel(channelId, signal);
    // An abort while the channel connected must not leave a request behind.
    signal?.throwIfAborted();
    if (channel.requests.size >= config.maxPendingPerChannel) {
      throw relayError("too many requests are already in progress.");
    }

    const id = randomUUID();
    return new Promise<Response>((resolve, reject) => {
      let resolved = false;
      let settled = false;
      const finish = () => {
        clearTimeout(headTimer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
        channel.requests.delete(id);
      };
      const entry: Pending = {
        channelId,
        state: "head",
        bytes: 0,
        resolve: (response) => {
          resolved = true;
          settled = true;
          clearTimeout(headTimer);
          resolve(response);
        },
        reject: (error) => {
          // Before the caller holds a Response the promise rejects; after,
          // the body it reads fails.
          if (resolved) entry.controller?.error(error);
          else if (!settled) reject(error);
          settled = true;
          finish();
        },
        finish,
      };
      const onAbort = () => {
        channel.sink({ type: "cancel", id });
        entry.reject(abortError(signal!));
      };
      const headTimer = setTimeout(() => {
        channel.sink({ type: "cancel", id });
        entry.reject(relayError("your browser did not get an answer in time."));
      }, config.headTimeoutMs);
      headTimer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, entry);
      channel.requests.add(id);
      channel.sink({
        type: "request",
        id,
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
    });
  }

  const owned = (channelId: string, requestId: string) => {
    const entry = pending.get(requestId);
    return entry && entry.channelId === channelId ? entry : undefined;
  };

  return {
    /**
     * Connect a browser's stream to its channel. A second connection under
     * the same ID (a reconnect) replaces the first; requests sent to the
     * first fail, because their answers would arrive nowhere. Undefined when
     * the server already holds its limit of channels.
     */
    attach(
      channelId: string,
      sink: ModelRelaySink,
      close: () => void = () => {},
    ): (() => void) | undefined {
      const previous = channels.get(channelId);
      if (!previous && channels.size >= config.maxChannels) return undefined;
      const channel: Channel = { sink, close, requests: new Set() };
      channels.set(channelId, channel);
      if (previous) {
        // One stream per channel: the older one ends, visibly, so two
        // holders of an ID displace each other instead of one going silent.
        failChannelRequests(previous, "the browser reconnected.");
        previous.close();
      }
      for (const wake of [...(waiters.get(channelId) ?? [])]) wake();
      return () => {
        if (channels.get(channelId) !== channel) return;
        channels.delete(channelId);
        failChannelRequests(channel, "the browser disconnected.");
      };
    },

    /** Whether {@link attach} would accept this channel now. */
    canAttach(channelId: string): boolean {
      return channels.has(channelId) || channels.size < config.maxChannels;
    },

    /** The relay for model calls made on behalf of this channel's browser. */
    relayFor(channelId: string): ProviderRelay {
      return { fetch: (request) => relayFetch(channelId, request) };
    },

    head(
      channelId: string,
      requestId: string,
      head: ModelRelayHead,
    ): ModelRelayAnswer {
      const entry = owned(channelId, requestId);
      if (!entry) return "unknown";
      if (entry.state !== "head") return "out-of-order";
      // Build the Response before anything changes, so a head the platform
      // refuses (a malformed header or status text) fails this request
      // instead of leaving its caller waiting.
      const nullBody = NULL_BODY_STATUSES.has(head.status);
      let response: Response;
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(head.headers)) {
          if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
            headers.set(name, value);
        }
        const init = {
          status: head.status,
          ...(head.statusText ? { statusText: head.statusText } : {}),
          headers,
        };
        response = nullBody
          ? new Response(null, init)
          : new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  entry.controller = controller;
                },
                cancel: () => {
                  // The reader stopped early: the browser can stop too.
                  channels
                    .get(channelId)
                    ?.sink({ type: "cancel", id: requestId });
                  entry.finish();
                },
              }),
              init,
            );
      } catch {
        channels.get(channelId)?.sink({ type: "cancel", id: requestId });
        entry.reject(relayError("your browser sent an invalid answer."));
        return "invalid";
      }
      if (nullBody) {
        entry.resolve(response);
        entry.finish();
        return "ok";
      }
      entry.state = "body";
      entry.resolve(response);
      return "ok";
    },

    chunk(
      channelId: string,
      requestId: string,
      bytes: Uint8Array,
    ): ModelRelayAnswer {
      const entry = owned(channelId, requestId);
      if (!entry) return "unknown";
      if (entry.state !== "body") return "out-of-order";
      entry.bytes += bytes.byteLength;
      if (entry.bytes > config.maxResponseBytes) {
        channels.get(channelId)?.sink({ type: "cancel", id: requestId });
        entry.reject(relayError("the answer is too large to relay."));
        return "too-large";
      }
      entry.controller?.enqueue(bytes);
      return "ok";
    },

    end(channelId: string, requestId: string): ModelRelayAnswer {
      const entry = owned(channelId, requestId);
      if (!entry) return "unknown";
      if (entry.state !== "body") return "out-of-order";
      entry.controller?.close();
      entry.finish();
      return "ok";
    },

    fail(
      channelId: string,
      requestId: string,
      message: string,
    ): ModelRelayAnswer {
      const entry = owned(channelId, requestId);
      if (!entry) return "unknown";
      entry.reject(relayError(message));
      return "ok";
    },

    /** Requests in flight, for tests and diagnostics. */
    get pendingCount(): number {
      return pending.size;
    },
  };
}

export type ModelRelayRegistry = ReturnType<typeof createModelRelayRegistry>;
