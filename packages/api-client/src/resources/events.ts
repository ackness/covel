import type { Transport, SseEvent } from "../transport/transport.js";

export class EventsResource {
  constructor(private readonly transport: Transport) {}

  stream(sessionId?: string): AsyncIterable<SseEvent> {
    return this.transport.stream({
      method: "GET",
      path: "/api/events/stream",
      query: sessionId ? { sessionId } : undefined,
    });
  }

  async emit(
    sessionId: string,
    event: { type: string; topic: string; payload?: unknown },
  ): Promise<void> {
    return this.transport.request<void>({
      method: "POST",
      path: "/api/events/emit",
      body: { sessionId, ...event },
    });
  }
}
