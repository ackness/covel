import { lazy } from "react";

/** Wait before each retry of a chunk that failed to download. */
const RETRY_DELAYS_MS = [500, 1500] as const;

// Chromium, Firefox and Safari word a failed module download differently.
const CHUNK_LOAD_FAILURE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

function isChunkLoadError(error: unknown): boolean {
  return error instanceof TypeError && CHUNK_LOAD_FAILURE.test(error.message);
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Load a code-split module, retrying a download that failed. A server restart
 * or a dropped connection can cut a chunk mid-transfer; the browser fetches
 * the module again on the next `import()`. Other errors are not retried.
 */
export async function importWithRetry<T>(
  load: () => Promise<T>,
  delays: readonly number[] = RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<void> = pause,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isChunkLoadError(error)) throw error;
      await wait(delay);
    }
  }
}

/**
 * `React.lazy` that retries a failed chunk download. Plain `lazy` keeps the
 * first rejection for the page's lifetime, so an error boundary's retry can
 * never recover the view without a full reload.
 */
export const lazyWithRetry: typeof lazy = (load) =>
  lazy(() => importWithRetry(load));
