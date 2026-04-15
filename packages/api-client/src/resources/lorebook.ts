import type { Transport } from "../transport/transport.js";

export interface LorebookEntry {
  id: string;
  sessionId: string;
  pluginId: string;
  keys: readonly string[];
  content: string;
  strategy: "constant" | "selective";
  position: string;
  insertionOrder: number;
  enabled: boolean;
  extra?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface LorebookListResponse {
  entries: LorebookEntry[];
}

export class LorebookResource {
  constructor(private readonly transport: Transport) {}

  /** GET /api/sessions/:sessionId/lorebook */
  async list(sessionId: string): Promise<LorebookEntry[]> {
    const res = await this.transport.request<LorebookListResponse>({
      method: "GET",
      path: "/api/sessions/:sessionId/lorebook",
      params: { sessionId },
    });
    return res.entries ?? [];
  }

  /** PATCH /api/sessions/:sessionId/lorebook/:entryId */
  async setEnabled(
    sessionId: string,
    entryId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.transport.request<{ success: boolean; entryId: string; enabled: boolean }>({
      method: "PATCH",
      path: "/api/sessions/:sessionId/lorebook/:entryId",
      params: { sessionId, entryId },
      body: { enabled },
    });
  }

  /** DELETE /api/sessions/:sessionId/lorebook/:entryId */
  async delete(sessionId: string, entryId: string): Promise<void> {
    await this.transport.request<{ success: boolean }>({
      method: "DELETE",
      path: "/api/sessions/:sessionId/lorebook/:entryId",
      params: { sessionId, entryId },
    });
  }
}
