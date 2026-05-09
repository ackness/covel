import { parseJsonSseData, readSseStream } from "../sse.js";
import { buildAiHeaders } from "./model-settings.js";
import type { SseEnvelope } from "./types.js";

// -- Actions (SSE) -------------------------------------------------

export type ActionType =
  | "send_message"
  | "execute_command"
  | "submit_block_response"
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
