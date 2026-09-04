import { parseJsonSseData, readSseStream } from "../sse.js";
import {
  actionRequestSchema,
  sseEnvelopeSchema,
  type ActionRequest,
  type ActionType,
  type SseEnvelope,
} from "@covel/shared";
import { sessionAuthHeaders } from "../session-credentials.js";
import { buildAiHeaders } from "./model-settings.js";

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
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAiHeaders(),
          ...sessionAuthHeaders(req.sessionId),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Action failed ${res.status}: ${text}`);
      }

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
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/steer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sessionAuthHeaders(sessionId),
      },
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
    { method: "POST", headers: sessionAuthHeaders(sessionId) },
  );
  return res.ok;
}
