import { createServer } from "node:net";

/** Fetch with a hard per-request deadline so callers cannot leak hung sockets. */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One JSON request with a single deadline over the connection, the headers and
 * the body, so a peer that accepts the socket and then stalls cannot hold the
 * caller. A body that is not JSON reads as `null`. Rejects with the abort
 * error when the deadline passes.
 */
export async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const body: unknown = await res.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw error;
      return null;
    });
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Bind `port` on loopback (0 = any free port), release it, and report it. */
function claimPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const claimed = addr.port;
        server.close(() => resolve(claimed));
      } else {
        server.close(() => reject(new Error("Could not find free port")));
      }
    });
  });
}

/** Find a random free port. */
export function findFreePort(): Promise<number> {
  return claimPort(0);
}

/** The port a `server.port` file names, or undefined when it names none. */
export function parseStoredPort(
  text: string | null | undefined,
): number | undefined {
  const value = text?.trim() ?? "";
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  // Ports below 1024 need privileges the sidecar does not have.
  return port >= 1024 && port <= 65_535 ? port : undefined;
}

/**
 * The port for the next sidecar. The page origin includes the port, and the
 * browser keeps localStorage and IndexedDB per origin, so a new port on every
 * launch hides what the last launch stored (panel layout, the media cache) and
 * leaves it behind on disk. Use the previous port while it is free; fall back
 * to a random one when another process holds it.
 */
export async function findPreferredPort(
  previous: number | undefined,
  claim: (port: number) => Promise<number> = claimPort,
): Promise<number> {
  if (previous !== undefined) {
    try {
      return await claim(previous);
    } catch {
      // Taken, or not bindable: any free port will do.
    }
  }
  return claim(0);
}

/**
 * Longest wait between two readiness polls. A loopback health request costs
 * almost nothing, while every millisecond of this wait is added to the startup
 * the player watches after the server is already able to answer.
 */
export const MAX_POLL_INTERVAL_MS = 250;

/** Poll a URL until it returns 200 or timeout. */
export async function waitForServer(
  url: string,
  timeoutMs = 30_000,
  initialIntervalMs = 150,
  onProgress?: (elapsed: number, total: number) => void,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let interval = Math.min(MAX_POLL_INTERVAL_MS, initialIntervalMs);
  while (Date.now() < deadline) {
    onProgress?.(Date.now() - start, timeoutMs);
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const res = await fetchWithTimeout(
        url,
        Math.min(2_000, remaining),
        fetchImpl,
      );
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await sleep(interval);
    // Back off a little so a slow boot is not polled at the starting rate.
    interval = Math.min(MAX_POLL_INTERVAL_MS, Math.round(interval * 1.35));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}
