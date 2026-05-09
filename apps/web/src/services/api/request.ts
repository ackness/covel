import i18n from "@/i18n";
import { emitToast } from "@/lib/toast-channel";
import { buildAiHeaders, needsProviderKeys } from "./model-settings.js";

/** Options for the internal `request` fetch wrapper. */
interface RequestOptions extends RequestInit {
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

export async function request<T>(
  url: string,
  init?: RequestOptions,
): Promise<T> {
  const { silentErrors, ...fetchInit } = init ?? {};
  let res: Response;
  try {
    res = await fetch(url, {
      ...fetchInit,
      headers: {
        "Content-Type": "application/json",
        ...(needsProviderKeys(url) ? buildAiHeaders() : {}),
        ...fetchInit.headers,
      },
    });
  } catch (err) {
    // Transport-level failure (offline, DNS, CORS preflight). These never
    // reach `res.ok`, so surface them explicitly unless the caller opted out.
    if (!silentErrors) emitNetworkErrorToast(url, err);
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (!silentErrors) emitHttpErrorToast(url, res.status, text);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}
