import type { Message, TurnMessage } from "@covel/shared";

import type { Transport } from "../transport/transport.js";

export type { Message, TurnMessage };

interface TurnMessagesResponse {
  items: TurnMessage[];
}

export interface SyncMessageInput {
  id?: string;
  role: string;
  content: string;
  turnId?: string;
  runtimeId?: string;
  block?: unknown;
  createdAt?: string;
}

export class MessagesResource {
  constructor(private readonly transport: Transport) {}

  /**
   * Flattened message list (legacy shape used by chat list rendering).
   * Returns a plain array — server endpoint emits no envelope here.
   */
  async list(sessionId: string): Promise<Message[]> {
    return this.transport.request<Message[]>({
      method: "GET",
      path: "/api/sessions/:sessionId/messages",
      params: { sessionId },
    });
  }

  /**
   * Rich `TurnMessage[]` list returned by `/turn-messages`. Use this when
   * UI render instructions are required (forms, choices, etc.).
   */
  async listTurnMessages(sessionId: string): Promise<TurnMessage[]> {
    const res = await this.transport.request<TurnMessagesResponse>({
      method: "GET",
      path: "/api/sessions/:sessionId/turn-messages",
      params: { sessionId },
    });
    return res.items ?? [];
  }

  async sync(sessionId: string, messages: SyncMessageInput[]): Promise<void> {
    await this.transport.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/sessions/:sessionId/messages/sync",
      params: { sessionId },
      body: { messages },
    });
  }
}
