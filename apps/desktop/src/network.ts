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

/** Find a random free port. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not find free port")));
      }
    });
    server.on("error", reject);
  });
}

/** Poll a URL until it returns 200 or timeout. */
export async function waitForServer(
  url: string,
  timeoutMs = 30_000,
  initialIntervalMs = 150,
  onProgress?: (elapsed: number, total: number) => void,
): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let interval = initialIntervalMs;
  while (Date.now() < deadline) {
    onProgress?.(Date.now() - start, timeoutMs);
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const res = await fetchWithTimeout(url, Math.min(2_000, remaining));
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
    // Back off: start with rapid polls for quick boot, then slow to 1s.
    interval = Math.min(1000, Math.round(interval * 1.35));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}
