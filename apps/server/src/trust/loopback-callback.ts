/**
 * Bounded, single-shot localhost loopback HTTP listener for plugin OAuth/PKCE
 * flows (`net.loopbackCallback`).
 *
 * Security invariants:
 * - Binds strictly on `127.0.0.1` (`ports: "ephemeral"` default -> OS port 0;
 *   or preferred ports with automatic ephemeral fallback on collision).
 * - Never logs the full callback URL or query parameters (tokens/auth codes).
 * - Auto-closes after the first matching `GET <path>`, on abort, or on timeout.
 */

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
  readonly port: number;
  waitForCallback(): Promise<LoopbackCallbackWaitResult>;
  close(): Promise<void>;
}

export interface StartLoopbackCallbackOptions {
  readonly path: string;
  readonly ports?: "ephemeral" | readonly number[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
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
    server.listen(port, host);
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

export async function startLoopbackCallbackSession(
  options: StartLoopbackCallbackOptions,
): Promise<LoopbackCallbackSession> {
  const callbackPath = normalizeCallbackPath(options.path);
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

  const closeServer = (): Promise<void> => {
    if (closePromise) return closePromise;
    cleanupHooks();
    if (!settled) {
      settled = true;
      rejectWait(
        new LoopbackCallbackError("closed", "Loopback callback session closed"),
      );
    }
    closePromise = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    return closePromise;
  };

  let boundPort = 0;

  const server = http.createServer((req, res) => {
    if (settled) {
      res.writeHead(410, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end("Gone");
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

    settled = true;
    cleanupHooks();

    const callbackUrl = `http://127.0.0.1:${boundPort}${reqUrl.pathname}${reqUrl.search}`;
    const query: Record<string, string> = {};
    for (const [k, v] of reqUrl.searchParams.entries()) {
      query[k] = v;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      Connection: "close",
    });
    res.end(COMPLETE_HTML, () => {
      resolveWait({ callbackUrl, query });
      void closeServer();
    });
  });

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
        ? [...options.ports, 0]
        : [0];
    let lastBusyError: unknown;
    for (let i = 0; i < candidatePorts.length; i++) {
      const candidate = candidatePorts[i]!;
      try {
        boundPort = await listenOn(server, "127.0.0.1", candidate);
        break;
      } catch (error) {
        const isLast = i === candidatePorts.length - 1;
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
    }
  } catch (error) {
    await closeServer();
    throw error;
  }

  options.signal?.addEventListener("abort", onAbort, { once: true });
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
    port: boundPort,
    waitForCallback() {
      return waitPromise;
    },
    close() {
      return closeServer();
    },
  };
}
