import { parseJsonSseData, readSseStream } from "../sse.js";
import { buildAiHeaders } from "./model-settings.js";
import type { SseEnvelope } from "./types.js";

// -- Actions (SSE) -------------------------------------------------

export type ActionType =
  | "send_message"
  | "execute_command"
  | "start_session"
  | "retry_runtime"
  | "trigger_event";

export interface ActionRequest {
  requestId: string;
  type: ActionType;
  sessionId: string;
  locale?: string;
  payload: Record<string, unknown>;
}

/**
 * Send an action and receive SSE events via callback.
 * Returns an AbortController to cancel the stream.
 */
export function sendAction(
  req: ActionRequest,
  onEvent: (envelope: SseEnvelope) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAiHeaders(),
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Action failed ${res.status}: ${text}`);
      }

      await readSseStream({
        response: res,
        signal: controller.signal,
        parse: parseJsonSseData<SseEnvelope>,
        onMessage: onEvent,
      });

      onDone?.();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return controller;
}

// -- Mid-turn player control (W4) ----------------------------------

/**
 * Interject a player message into the session's in-flight turn. The server
 * merges it into the next LLM step of story runtimes and persists it to
 * history. 409 (no active turn) resolves to false so callers can fall back
 * to a normal send.
 */
export async function steerTurn(
  sessionId: string,
  message: string,
): Promise<boolean> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/steer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    },
  );
  return res.ok;
}

/**
 * Abort the session's in-flight turn. Cuts the LLM stream server-side and
 * discards uncommitted proposals. Resolves false when no turn is active.
 */
export async function abortTurn(sessionId: string): Promise<boolean> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/abort`,
    { method: "POST" },
  );
  return res.ok;
}

/**
 * Trigger a custom kernel event for the given session.
 * Useful for manual plugin triggers (e.g., image generation button).
 */
export function triggerEvent(
  sessionId: string,
  eventType: string,
  eventData: Record<string, unknown>,
  locale: string,
  onEvent: (envelope: SseEnvelope) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
): AbortController {
  return sendAction(
    {
      requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: "trigger_event",
      sessionId,
      locale,
      payload: { eventType, eventData },
    },
    onEvent,
    onError,
    onDone,
  );
}
