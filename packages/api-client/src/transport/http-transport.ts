import type { Transport, RequestInit, SseEvent } from "./transport.js";
import {
  ApiError,
  NetworkError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../types/errors.js";
import { parseSse } from "../sse/parse-sse.js";

export interface HttpTransportOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  defaultHeaders?: () => Record<string, string>;
}

function buildUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  // Replace :param placeholders in path
  let resolvedPath = path;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      resolvedPath = resolvedPath.replace(`:${key}`, encodeURIComponent(value));
    }
  }

  // Normalize base URL + path (avoid double slashes, handle trailing slash)
  const base = baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}${resolvedPath}`, "http://placeholder");

  // Append query params, filtering undefined values
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  // Return the path+search portion if base was relative, otherwise full URL
  if (baseUrl.startsWith("http://") || baseUrl.startsWith("https://")) {
    return url.toString().replace("http://placeholder", base);
  }
  return url.pathname + url.search;
}

async function throwForStatus(response: Response): Promise<never> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const message =
    (body as { message?: string } | undefined)?.message ??
    `HTTP ${response.status} ${response.statusText}`;

  switch (response.status) {
    case 404:
      throw new NotFoundError(message, body);
    case 401:
    case 403:
      throw new UnauthorizedError(message, body);
    case 422:
      throw new ValidationError(message, body);
    default:
      throw new ApiError(message, response.status, undefined, body);
  }
}

export class HttpTransport implements Transport {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly defaultHeaders?: () => Record<string, string>;

  constructor(opts: HttpTransportOptions) {
    this.baseUrl = opts.baseUrl;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = opts.defaultHeaders;
  }

  async request<T>(init: RequestInit): Promise<T> {
    const url = buildUrl(this.baseUrl, init.path, init.params, init.query);

    const headers: Record<string, string> = {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(this.defaultHeaders?.() ?? {}),
      ...(init.headers ?? {}),
    };

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: init.method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: init.signal,
      });
    } catch (cause) {
      throw new NetworkError(
        cause instanceof Error ? cause.message : "Network request failed",
        cause,
      );
    }

    if (!response.ok) {
      await throwForStatus(response);
    }

    // Handle empty responses (204 No Content)
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 204 || !contentType.includes("application/json")) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  stream(init: RequestInit): AsyncIterable<SseEvent> {
    const url = buildUrl(this.baseUrl, init.path, init.params, init.query);
    const fetchFn = this.fetchFn;
    const defaultHeaders = this.defaultHeaders;

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(defaultHeaders?.() ?? {}),
      ...(init.headers ?? {}),
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<SseEvent> {
        let generator: AsyncIterator<SseEvent> | null = null;

        return {
          async next(): Promise<IteratorResult<SseEvent>> {
            if (!generator) {
              let response: Response;
              try {
                response = await fetchFn(url, {
                  method: init.method,
                  headers,
                  body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
                  signal: init.signal,
                });
              } catch (cause) {
                throw new NetworkError(
                  cause instanceof Error ? cause.message : "Network request failed",
                  cause,
                );
              }

              if (!response.ok) {
                await throwForStatus(response);
              }

              if (!response.body) {
                return { done: true, value: undefined };
              }

              generator = parseSse(response.body)[Symbol.asyncIterator]();
            }

            return generator.next();
          },
          async return(value?: unknown): Promise<IteratorResult<SseEvent>> {
            await generator?.return?.(value);
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
}
