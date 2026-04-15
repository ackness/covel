import type { Transport } from "../transport/transport.js";

export interface PluginDataEntry {
  namespace: string;
  key: string;
  value: unknown;
  updatedAt?: string;
}

interface PluginDataListResponse {
  items: PluginDataEntry[];
}

export class PluginDataResource {
  constructor(private readonly transport: Transport) {}

  /**
   * List all plugin-data entries for a plugin. When `namespace` is given,
   * results are restricted to that namespace; otherwise the entire plugin
   * scope is returned.
   */
  async list(
    sessionId: string,
    pluginId: string,
    namespace?: string,
  ): Promise<PluginDataEntry[]> {
    const path = namespace
      ? "/api/sessions/:sessionId/plugin-data/:pluginId/:namespace"
      : "/api/sessions/:sessionId/plugin-data/:pluginId";
    const params: Record<string, string> = { sessionId, pluginId };
    if (namespace) params.namespace = namespace;
    const res = await this.transport.request<PluginDataListResponse>({
      method: "GET",
      path,
      params,
    });
    return res.items ?? [];
  }

  async get(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<unknown> {
    return this.transport.request<unknown>({
      method: "GET",
      path: "/api/sessions/:sessionId/plugin-data/:pluginId/:namespace/:key",
      params: { sessionId, pluginId, namespace, key },
    });
  }

  async set(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.transport.request<{ success: boolean }>({
      method: "PUT",
      path: "/api/sessions/:sessionId/plugin-data/:pluginId/:namespace/:key",
      params: { sessionId, pluginId, namespace, key },
      body: { value },
    });
  }

  async delete(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    await this.transport.request<{ success: boolean }>({
      method: "DELETE",
      path: "/api/sessions/:sessionId/plugin-data/:pluginId/:namespace/:key",
      params: { sessionId, pluginId, namespace, key },
    });
  }
}
