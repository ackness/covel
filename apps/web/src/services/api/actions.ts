import { parseJsonSseData, readSseStream } from "../sse.js";
import { pauseSessionSubscriptions } from "../subscription.js";
import {
  actionRequestSchema,
  sseEnvelopeSchema,
  type ActionRequest,
  type ActionType,
  type SseEnvelope,
} from "@covel/shared";
import { ApiError, request, requestResponse } from "./request.js";
import { z } from "zod";

const actionApprovalSchema = z.object({
  status: z.literal("approval-required"),
  approvalId: z.string().min(1),
  pending: z.object({
    sessionId: z.string(),
    pluginId: z.string(),
    action: z.string(),
  }),
});
export type ActionApproval = z.infer<typeof actionApprovalSchema>;

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
  onApproval?: (approval: ActionApproval) => Promise<boolean>,
): AbortController {
  const controller = new AbortController();
  const resumeSubscriptions = pauseSessionSubscriptions();

  (async () => {
    try {
      const body = actionRequestSchema.parse(req);
      const send = () =>
        requestResponse("/api/actions", {
          method: "POST",
          body: JSON.stringify(body),
          signal: controller.signal,
          sessionId: req.sessionId,
          operatorAuth: true,
        });
      let res = await send();
      const requested = new Set<string>();
      while (res.status === 202) {
        const approval = actionApprovalSchema.parse(await res.json());
        const key = JSON.stringify([
          approval.pending.pluginId,
          approval.pending.action,
        ]);
        if (
          approval.pending.sessionId !== req.sessionId ||
          requested.has(key) ||
          !onApproval
        ) {
          throw new ApiError(
            202,
            "/api/actions",
            JSON.stringify({
              error: "Plugin approval is required",
              code: "approval_required",
            }),
          );
        }
        requested.add(key);
        const allowed = await onApproval(approval);
        controller.signal.throwIfAborted();
        if (!allowed)
          throw new ApiError(
            403,
            "/api/actions",
            JSON.stringify({
              error: "Plugin action was not authorized",
              code: "plugin_approval_denied",
            }),
          );
        res = await send();
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
    } finally {
      resumeSubscriptions();
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
