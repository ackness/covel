import { parseJsonSseData, readSseStream } from "../sse.js";
import {
  actionRequestSchema,
  sseEnvelopeSchema,
  type ActionRequest,
  type ActionType,
  type SseEnvelope,
} from "@covel/shared";
import { ApiError, request, requestResponse } from "./request.js";

// -- Actions (SSE) -------------------------------------------------

export type { ActionRequest, ActionType } from "@covel/shared";

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
      const body = actionRequestSchema.parse(req);
      const res = await requestResponse("/api/actions", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
        sessionId: req.sessionId,
      });

      await readSseStream({
        response: res,
        signal: controller.signal,
        parse: (data) => {
          const decoded = parseJsonSseData<unknown>(data);
          return decoded === undefined
            ? undefined
            : sseEnvelopeSchema.parse(decoded);
        },
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

// -- Mid-turn player control ----------------------------------

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
  try {
    await request<{ ok: true; turnId: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/steer`,
      {
        method: "POST",
        body: JSON.stringify({ message }),
        silentStatuses: [409],
      },
    );
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return false;
    throw error;
  }
}

/**
 * Abort the session's in-flight turn. Cuts the LLM stream server-side and
 * discards uncommitted proposals. Resolves false when no turn is active.
 */
export async function abortTurn(sessionId: string): Promise<boolean> {
  try {
    await request<{ ok: true; turnId: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST", silentStatuses: [409] },
    );
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return false;
    throw error;
  }
}
