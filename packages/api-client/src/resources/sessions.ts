import type { Session, SessionPhase } from "@covel/shared";

import type { Transport } from "../transport/transport.js";

export type { Session, SessionPhase };

interface SessionsListResponse {
  items: Session[];
}

export interface CreateSessionInput {
  worldId?: string;
  /** Optional explicit session ID. Server defaults to `${worldId}-${uuid8}`. */
  id?: string;
  locale?: string;
  /** Initial active plugin ids. Server seeds defaults from world manifest. */
  plugins?: string[];
}

export interface SubmitInputItem {
  turnId: string;
  interactionId: string;
  type?: "form" | "choice" | "confirmation";
  values: Record<string, unknown>;
}

export interface SubmitInputsBatchInput {
  turnId: string;
  submissions: SubmitInputItem[];
}

export interface SubmitInputsBatchResponse {
  results: Array<{
    submissionId: string;
    interactionId: string;
    filledNarrative: string;
    accepted: boolean;
  }>;
  accepted: boolean;
}

export class SessionsResource {
  constructor(private readonly transport: Transport) {}

  async list(): Promise<Session[]> {
    const res = await this.transport.request<SessionsListResponse>({
      method: "GET",
      path: "/api/sessions",
    });
    return res.items ?? [];
  }

  async get(id: string): Promise<Session> {
    return this.transport.request<Session>({
      method: "GET",
      path: "/api/sessions/:id",
      params: { id },
    });
  }

  async create(data: CreateSessionInput): Promise<Session> {
    return this.transport.request<Session>({
      method: "POST",
      path: "/api/sessions",
      body: data,
    });
  }

  async update(
    id: string,
    patch: Partial<Pick<Session, "phase" | "activePlugins">>,
  ): Promise<Session> {
    return this.transport.request<Session>({
      method: "PATCH",
      path: "/api/sessions/:id",
      params: { id },
      body: patch,
    });
  }

  async delete(id: string): Promise<void> {
    await this.transport.request<{ deleted: boolean }>({
      method: "DELETE",
      path: "/api/sessions/:id",
      params: { id },
    });
  }

  async getSnapshot(id: string): Promise<unknown> {
    return this.transport.request<unknown>({
      method: "GET",
      path: "/api/sessions/:id/snapshot",
      params: { id },
    });
  }

  async submitInputs(
    id: string,
    input: SubmitInputsBatchInput,
  ): Promise<SubmitInputsBatchResponse> {
    return this.transport.request<SubmitInputsBatchResponse>({
      method: "POST",
      path: "/api/sessions/:id/submit-inputs",
      params: { id },
      body: input,
    });
  }
}
