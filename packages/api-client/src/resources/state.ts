import type { Transport } from "../transport/transport.js";

export class StateResource {
  constructor(private readonly transport: Transport) {}

  async getAll(sessionId: string): Promise<unknown> {
    return this.transport.request<unknown>({
      method: "GET",
      path: "/api/sessions/:sessionId/state",
      params: { sessionId },
    });
  }

  async getTable(sessionId: string, table: string): Promise<unknown> {
    return this.transport.request<unknown>({
      method: "GET",
      path: "/api/sessions/:sessionId/state/:table",
      params: { sessionId, table },
    });
  }
}
