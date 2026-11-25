/**
 * Bounded, single-shot localhost loopback HTTP listener for plugin OAuth/PKCE
 * flows (`net.loopbackCallback`).
 *
 * Security invariants:
 * - Binds on `127.0.0.1` and, when available, `::1`. The IPv4 listener uses
 *   an ephemeral port by default or falls back to one if preferred ports are busy.
 * - Never logs the full callback URL or query parameters (tokens/auth codes).
 * - Auto-closes after the first authorized callback with matching state, on
 *   abort, or on timeout.
 */

import { randomBytes } from "node:crypto";
import http from "node:http";

export type LoopbackCallbackErrorCode =
  "invalid_path" | "timeout" | "aborted" | "closed" | "listen_failed";

export class LoopbackCallbackError extends Error {
  constructor(
    readonly code: LoopbackCallbackErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LoopbackCallbackError";
  }
}

export interface LoopbackCallbackWaitResult {
  readonly callbackUrl: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface LoopbackCallbackSession {
  readonly callbackUrl: string;
  readonly state: string;
  readonly port: number;
  canAccept(): boolean;
  waitForCallback(): Promise<LoopbackCallbackWaitResult>;
  close(): Promise<void>;
}

export interface StartLoopbackCallbackOptions {
  readonly path: string;
  readonly ports?: "ephemeral" | readonly number[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly canAccept?: () => boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

const COMPLETE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorization Complete</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;text-align:center;">
  <h1>Authorization received</h1>
  <p>You may close this window and return to Covel.</p>
</body>
</html>`;

function isNodeErrno(error: unknown, codes: readonly string[]): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && codes.includes(code);
}

function listenOn(
  server: http.Server,
  host: string,
  port: number,
  options?: { readonly ipv6Only?: boolean },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(
          new LoopbackCallbackError(
            "listen_failed",
            "Loopback callback server returned no TCP port",
          ),
        );
        return;
      }
      resolve(addr.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      host,
      port,
      ...(options?.ipv6Only ? { ipv6Only: true } : {}),
    });
  });
}

function closeHttpServer(target: http.Server | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!target || !target.listening) {
      resolve();
      return;
    }
    target.closeAllConnections?.();
    target.close(() => resolve());
  });
}

function normalizeCallbackPath(rawPath: string): string {
  if (
    typeof rawPath !== "string" ||
    !rawPath.startsWith("/") ||
    rawPath.includes("..") ||
    rawPath.includes("?") ||
    rawPath.includes("#")
  ) {
    throw new LoopbackCallbackError(
      "invalid_path",
      `Invalid loopback callback path: "${String(rawPath)}"`,
    );
  }
  return rawPath;
}

const LOOPBACK_IPV4_HOST_RE = /^(?:localhost|127\.0\.0\.1)(?::(\d+))?$/i;
const LOOPBACK_IPV6_HOST_RE = /^\[::1\](?::(\d+))?$/i;

function isValidLoopbackHostHeader(
  rawHost: string | undefined,
  expectedPort: number,
): boolean {
  if (typeof rawHost !== "string") return false;
  const trimmed = rawHost.trim();
  if (!trimmed || trimmed !== rawHost) return false;
  const match =
    LOOPBACK_IPV4_HOST_RE.exec(trimmed) ?? LOOPBACK_IPV6_HOST_RE.exec(trimmed);
  if (!match) return false;
  const rawPort = match[1];
  if (rawPort !== undefined && Number(rawPort) !== expectedPort) {
    return false;
  }
  return true;
}

export async function startLoopbackCallbackSession(
  options: StartLoopbackCallbackOptions,
): Promise<LoopbackCallbackSession> {
  const callbackPath = normalizeCallbackPath(options.path);
  const state = randomBytes(32).toString("base64url");
  const canAccept = options.canAccept ?? (() => true);
  const rawTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(MIN_TIMEOUT_MS, Math.trunc(rawTimeout)),
  );

  if (options.signal?.aborted) {
    throw new LoopbackCallbackError(
      "aborted",
      "Loopback callback session was aborted before starting",
    );
  }

  let settled = false;
  let closePromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveWait!: (result: LoopbackCallbackWaitResult) => void;
  let rejectWait!: (reason: unknown) => void;

  const waitPromise = new Promise<LoopbackCallbackWaitResult>(
    (resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    },
  );
  // Prevent unhandled rejection crashes when callers only close or poll.
  void waitPromise.catch(() => {});

  const cleanupHooks = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (options.signal && onAbort) {
      options.signal.removeEventListener("abort", onAbort);
    }
  };

  let server: http.Server | undefined;
  let ipv6Server: http.Server | undefined;

  const closeServer = (): Promise<void> => {
    if (closePromise) return closePromise;
    cleanupHooks();
    if (!settled) {
      settled = true;
      rejectWait(
        new LoopbackCallbackError("closed", "Loopback callback session closed"),
      );
    }
    closePromise = Promise.all([
      closeHttpServer(server),
      closeHttpServer(ipv6Server),
    ]).then(() => {});
    return closePromise;
  };

  let boundPort = 0;

  const handleRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    if (settled) {
      res.writeHead(410, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end("Gone");
      return;
    }

    if (!isValidLoopbackHostHeader(req.headers.host, boundPort)) {
      res.writeHead(403, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end("Invalid host");
      return;
    }

    let reqUrl: URL;
    try {
      reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
    } catch {
      res.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end("Bad request");
      return;
    }

    if (reqUrl.pathname !== callbackPath) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end("Not found");
      return;
    }

    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      res.writeHead(405, {
        "Content-Type": "text/plain; charset=utf-8",
        Allow: "GET",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end("Method not allowed");
      return;
    }

    if (!matchesLoopbackState(reqUrl, state) || !canAccept()) {
      res.writeHead(403, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end("Callback rejected");
      return;
    }

    settled = true;
    cleanupHooks();

    const callbackUrl = `http://127.0.0.1:${boundPort}${reqUrl.pathname}${reqUrl.search}`;
    const query: Record<string, string> = {};
    for (const [k, v] of reqUrl.searchParams.entries()) {
      query[k] = v;
    }

    let finalized = false;
    let fallbackCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const finalizeCallback = (): void => {
      if (finalized) return;
      finalized = true;
      if (fallbackCloseTimer !== undefined) {
        clearTimeout(fallbackCloseTimer);
        fallbackCloseTimer = undefined;
      }
      resolveWait({ callbackUrl, query });
      void closeServer();
    };
    fallbackCloseTimer = setTimeout(finalizeCallback, 250);
    fallbackCloseTimer.unref?.();
    res.once("close", finalizeCallback);

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      Connection: "close",
    });
    res.end(COMPLETE_HTML, finalizeCallback);
  };

  const onAbort = (): void => {
    if (!settled) {
      settled = true;
      cleanupHooks();
      rejectWait(
        new LoopbackCallbackError(
          "aborted",
          "Loopback callback session was aborted",
        ),
      );
    }
    void closeServer();
  };

  try {
    const candidatePorts =
      Array.isArray(options.ports) && options.ports.length > 0
        ? [...options.ports, 0, 0, 0]
        : [0, 0, 0];
    let lastBusyError: unknown;
    for (let i = 0; i < candidatePorts.length; i++) {
      const candidate = candidatePorts[i]!;
      const isLast = i === candidatePorts.length - 1;
      const v4 = http.createServer(handleRequest);
      let candidatePort: number;
      try {
        candidatePort = await listenOn(v4, "127.0.0.1", candidate);
      } catch (error) {
        await closeHttpServer(v4);
        if (!isLast && isNodeErrno(error, ["EADDRINUSE", "EACCES"])) {
          lastBusyError = error;
          continue;
        }
        throw new LoopbackCallbackError(
          "listen_failed",
          `Failed to bind loopback callback listener on 127.0.0.1:${candidate}`,
          { cause: error ?? lastBusyError },
        );
      }

      // Bind the companion ::1 listener on the exact same port so IPv6-first
      // `localhost` redirects cannot land on another process holding [::1]:port.
      const v6 = http.createServer(handleRequest);
      try {
        await listenOn(v6, "::1", candidatePort, { ipv6Only: true });
        server = v4;
        ipv6Server = v6;
        boundPort = candidatePort;
        break;
      } catch (v6Error) {
        await closeHttpServer(v6);
        if (isNodeErrno(v6Error, ["EADDRINUSE", "EACCES"]) && !isLast) {
          await closeHttpServer(v4);
          lastBusyError = v6Error;
          continue;
        }
        // IPv6 unsupported/unavailable on host (or final ephemeral fallback):
        // continue with the IPv4 listener alone.
        server = v4;
        ipv6Server = undefined;
        boundPort = candidatePort;
        break;
      }
    }
  } catch (error) {
    await closeServer();
    throw error;
  }

  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    onAbort();
    await closeServer();
    await waitPromise;
  }
  timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      cleanupHooks();
      rejectWait(
        new LoopbackCallbackError(
          "timeout",
          `Loopback callback timed out after ${timeoutMs}ms`,
        ),
      );
    }
    void closeServer();
  }, timeoutMs);
  timer.unref?.();

  const callbackUrl = `http://127.0.0.1:${boundPort}${callbackPath}`;

  return {
    callbackUrl,
    state,
    port: boundPort,
    canAccept,
    waitForCallback() {
      return waitPromise;
    },
    close() {
      return closeServer();
    },
  };
}

export function matchesLoopbackState(url: URL, state: string): boolean {
  const states = url.searchParams.getAll("state");
  return states.length === 1 && states[0] === state;
}

const SCHEMELESS_LOOPBACK_RE =
  /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|\?|$)/i;

/**
 * Parse a user-pasted or browser-delivered OAuth callback input for loopback
 * state verification (accepts full `http:`/`https:` URLs, quoted/`<...>`
 * wrappers, `/path?...`, `?code=...`, and schemeless `localhost:...` pastes).
 */
export function parseLoopbackCallbackInput(raw: string): URL | null {
  let cleaned = raw.trim();
  if (
    (cleaned.startsWith("<") && cleaned.endsWith(">")) ||
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (!cleaned) return null;

  const direct = URL.parse(cleaned);
  if (direct && (direct.protocol === "http:" || direct.protocol === "https:")) {
    return direct;
  }
  if (cleaned.startsWith("/") || cleaned.startsWith("?")) {
    return URL.parse(cleaned, "http://127.0.0.1");
  }
  if (SCHEMELESS_LOOPBACK_RE.test(cleaned)) {
    return URL.parse(`http://${cleaned}`);
  }
  return null;
}
