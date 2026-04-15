import type { Transport, SseEvent } from "../transport/transport.js";

export type ActionType =
  | "start_session"
  | "send_message"
  | "execute_command"
  | "trigger_event"
  | "retry_runtime";

/**
 * Wire shape expected by `POST /api/actions`. The server reads
 * `requestId`, `type`, `sessionId`, `locale?`, `model?`, `payload`.
 *
 * `payload` is action-specific:
 *   - `start_session` → `{ plugins?: string[] }`
 *   - `send_message` → `{ content: string }`
 *   - `trigger_event` → `{ eventType: string, ...evt }`
 *   - `retry_runtime` → `{ runtimeId: string, turnId?: string }`
 */
export interface ActionRequest {
  type: ActionType | string;
  sessionId: string;
  payload?: Record<string, unknown>;
  locale?: string;
  model?: string;
  /** Optional client-supplied request id; auto-generated if omitted. */
  requestId?: string;
}

export class ActionsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * Post an action and return an async-iterable of SSE events.
   * Caller drives the iteration with `for await (const evt of stream)`.
   */
  run(req: ActionRequest, headers?: Record<string, string>): AsyncIterable<SseEvent> {
    const body: ActionRequest = {
      requestId: req.requestId ?? generateRequestId(),
      type: req.type,
      sessionId: req.sessionId,
      payload: req.payload ?? {},
      ...(req.locale !== undefined ? { locale: req.locale } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
    };
    return this.transport.stream({
      method: "POST",
      path: "/api/actions",
      body,
      headers,
    });
  }
}

function generateRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
