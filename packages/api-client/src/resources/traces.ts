import type { Transport } from "../transport/transport.js";

// ── Wire types ───────────────────────────────────────────────────

/**
 * One append-only trace event emitted by the runtime during turn
 * execution. Event `type` is a dot-separated category (e.g.
 * `runtime.started`, `llm.call.completed`, `tool.invoked`); the
 * frontend categorises by the prefix for filter UIs.
 */
export interface TraceEvent {
  readonly type: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly flowId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

/** Events grouped by turnId, with derived start/end timestamps. */
export interface TurnTrace {
  readonly turnId: string;
  readonly flowId: string;
  readonly traceId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly eventCount: number;
  readonly events: readonly TraceEvent[];
}

interface TracesListResponse {
  sessionId: string;
  count: number;
  events: TraceEvent[];
}

interface TurnsListResponse {
  sessionId: string;
  turnCount: number;
  turns: TurnTrace[];
}

// ── Resource ─────────────────────────────────────────────────────

export class TracesResource {
  constructor(private readonly transport: Transport) {}

  /** GET /api/traces/:sessionId — flat event list, chronological. */
  async list(sessionId: string): Promise<TraceEvent[]> {
    const res = await this.transport.request<TracesListResponse>({
      method: "GET",
      path: "/api/traces/:sessionId",
      params: { sessionId },
    });
    return res.events ?? [];
  }

  /** GET /api/traces/:sessionId/turns — events grouped by turnId. */
  async listTurns(sessionId: string): Promise<TurnTrace[]> {
    const res = await this.transport.request<TurnsListResponse>({
      method: "GET",
      path: "/api/traces/:sessionId/turns",
      params: { sessionId },
    });
    return res.turns ?? [];
  }
}
