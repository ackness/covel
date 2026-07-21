import i18n from "@/i18n";
import { emitToast } from "@/lib/toast-channel";
import {
  operatorAuthHeaders,
  sessionAuthHeaders,
} from "../session-credentials.js";
import { buildAiHeaders, needsProviderKeys } from "./model-settings.js";

/**
 * Session-scoped API paths embed the id as `/api/sessions/{id}` or
 * `/api/sessions/{id}/...`. Pull it out so `request()` can attach that
 * session's owner token. Cross-session paths (`/api/sessions?worldId=`,
 * `/api/sessions` itself) have no id segment and match nothing.
 */
const SESSION_PATH_RE = /\/api\/sessions\/([^/?#]+)/;

/** Owner-token header for a session-scoped request, or `{}` when the URL isn't
 * session-scoped or no token is stored. Harmless on tiers that ignore it. */
function sessionTokenHeader(url: string): Record<string, string> {
  const id = SESSION_PATH_RE.exec(url)?.[1];
  if (!id) return {};
  return sessionAuthHeaders(decodeURIComponent(id));
}

/** Options for the internal `request` fetch wrapper. */
interface RequestOptions extends RequestInit {
  /** Session id carried in a body, query, or non-standard route path. */
  sessionId?: string;
  /** Attach the hosted operator credential for global administration. */
  operatorAuth?: boolean;
  /**
   * Suppress the global error toast for this request. Use for probe-style
   * calls where a non-2xx response is part of normal operation (e.g. auth
   * polling or optional capability checks).
   */
  silentErrors?: boolean;
}

/**
 * Emit a user-visible toast for an HTTP failure. Split out so `request()`
 * stays focused on transport concerns.
 */
function emitHttpErrorToast(url: string, status: number, body: string): void {
  const shortTitle = i18n.t("toast.errorTitle", {
    defaultValue: "Something went wrong",
  }) as string;
  // Detail keeps enough context for the player to paste into a bug report.
  const detail = `${status} ${url}${body ? `\n${body.slice(0, 800)}` : ""}`;
  emitToast("error", shortTitle, detail);
}

function emitNetworkErrorToast(url: string, err: unknown): void {
  const short = i18n.t("toast.networkError", {
    defaultValue: "Network error - check your connection",
  }) as string;
  const detail = `${url}\n${err instanceof Error ? err.message : String(err)}`;
  emitToast("error", short, detail);
}

/**
 * Gateway statuses that mean "backend not reachable yet", never a real app
 * response (the API server returns 4xx/500 for its own errors, and 429 for rate
 * limits — none of these). The Vite dev proxy answers 503 while the runtime
 * server is still booting, and a brief server restart in prod looks the same.
 */
const RETRYABLE_STATUS = new Set([502, 503, 504]);
// 5 retries, capped exponential backoff (250 → 2000 ms) ≈ a 5.75s window — wide
// enough to cover the dev runtime server's boot (plugin discovery + DB init)
// so the first load waits it out instead of failing.
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2000;

function backoffMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
}

function isIdempotent(init: RequestInit): boolean {
  return (init.method ?? "GET").toUpperCase() === "GET";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function request<T>(
  url: string,
  init?: RequestOptions,
): Promise<T> {
  const { silentErrors, sessionId, operatorAuth, ...fetchInit } = init ?? {};
  // Only GETs are retried — they're idempotent, so a boot-race ECONNREFUSED (dev
  // server not up yet) or a transient gateway error can be retried without risk
  // of double-submitting. Non-GET requests keep the single-shot behaviour.
  const canRetry = isIdempotent(fetchInit);

  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= MAX_RETRIES;

    let res: Response;
    try {
      res = await fetch(url, {
        ...fetchInit,
        headers: {
          "Content-Type": "application/json",
          ...(needsProviderKeys(url) ? buildAiHeaders() : {}),
          ...sessionTokenHeader(url),
          ...sessionAuthHeaders(sessionId),
          ...(operatorAuth ? operatorAuthHeaders() : {}),
          ...fetchInit.headers,
        },
      });
    } catch (err) {
      // Transport-level failure (offline, DNS, CORS preflight, or the dev proxy
      // resetting the socket because the runtime server isn't up yet).
      if (canRetry && !isLastAttempt) {
        await delay(backoffMs(attempt));
        continue;
      }
      if (!silentErrors) emitNetworkErrorToast(url, err);
      throw err;
    }

    if (!res.ok) {
      if (canRetry && !isLastAttempt && RETRYABLE_STATUS.has(res.status)) {
        await delay(backoffMs(attempt));
        continue;
      }
      const text = await res.text().catch(() => "");
      if (!silentErrors) emitHttpErrorToast(url, res.status, text);
      throw new Error(`API ${res.status}: ${text}`);
    }

    return res.json();
  }
}
