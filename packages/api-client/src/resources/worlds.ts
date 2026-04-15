import type { World } from "@covel/shared";

import type { Transport } from "../transport/transport.js";

export type { World };

interface WorldsListResponse {
  items: World[];
}

export class WorldsResource {
  constructor(private readonly transport: Transport) {}

  async list(): Promise<World[]> {
    const res = await this.transport.request<WorldsListResponse>({
      method: "GET",
      path: "/api/worlds",
    });
    return res.items ?? [];
  }

  async get(id: string): Promise<World> {
    return this.transport.request<World>({
      method: "GET",
      path: "/api/worlds/:id",
      params: { id },
    });
  }

  async create(data: {
    id: string;
    name: string;
    description: string;
    lore?: string;
    tags?: string[];
    locale?: string;
  }): Promise<World> {
    return this.transport.request<World>({
      method: "POST",
      path: "/api/worlds",
      body: data,
    });
  }

  async update(id: string, patch: Partial<World>): Promise<World> {
    return this.transport.request<World>({
      method: "PATCH",
      path: "/api/worlds/:id",
      params: { id },
      body: patch,
    });
  }
}
