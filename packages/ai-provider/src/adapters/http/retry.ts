import { isEnvEnabled } from "@covel/shared";

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;
const JITTER_MIN = 0.75;
const JITTER_MAX = 1.25;

export const MAX_RETRIES = 3;

export function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function computeBackoffMs(attempt: number): number {
  const exp = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
  return Math.min(MAX_BACKOFF_MS, Math.floor(exp * jitter));
}

export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed) * 1000;
}

export function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isRetryDisabled(): boolean {
  return isEnvEnabled("COVEL_LLM_RETRY_DISABLED");
}
