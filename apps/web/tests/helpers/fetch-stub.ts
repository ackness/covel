import { vi } from "vitest";

type RouteHandler = (request: Request) => Response | Promise<Response>;

interface RouteDefinition {
  method: string;
  url: string;
  handler: RouteHandler;
}

export interface FetchStubController {
  calls: Request[];
  restore(): void;
}

export function installFetchStub(routes: RouteDefinition[]): FetchStubController {
  const originalFetch = globalThis.fetch;
  const calls: Request[] = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request
      ? input
      : new Request(resolveRequestUrl(input), init);
    const rawBody =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : init?.body
            ? String(init.body)
            : null;
    const recordedRequest = {
      headers: request.headers,
      method: request.method,
      url: request.url,
      async json() {
        return rawBody ? JSON.parse(rawBody) : null;
      }
    } as unknown as Request;
    calls.push(recordedRequest);
    const matchedRoute = routes.find(
      (route) => route.method === request.method && route.url === request.url
    );

    if (!matchedRoute) {
      throw new Error(`Unexpected fetch request: ${request.method} ${request.url}`);
    }

    return await matchedRoute.handler(request);
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

function resolveRequestUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === "string" && input.startsWith("/")) {
    return new URL(input, "http://localhost");
  }

  return input;
}

export function createJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

export function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    }),
    {
      headers: {
        "content-type": "text/event-stream"
      }
    }
  );
}

export function serializeSseEvent(event: {
  id: number;
  type: string;
  data: unknown;
}): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
