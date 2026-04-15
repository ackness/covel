import type { Character } from "@covel/shared";

import type { Transport } from "../transport/transport.js";

export type { Character };

interface CharactersListResponse {
  items: Character[];
}

export class CharactersResource {
  constructor(private readonly transport: Transport) {}

  async list(sessionId: string): Promise<Character[]> {
    const res = await this.transport.request<CharactersListResponse>({
      method: "GET",
      path: "/api/sessions/:sessionId/characters",
      params: { sessionId },
    });
    return res.items ?? [];
  }

  async create(
    sessionId: string,
    data: {
      id?: string;
      name: string;
      type: string;
      description?: string;
      fields?: unknown;
    },
  ): Promise<Character> {
    return this.transport.request<Character>({
      method: "POST",
      path: "/api/sessions/:sessionId/characters",
      params: { sessionId },
      body: data,
    });
  }
}
