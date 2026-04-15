import type { Transport } from "../transport/transport.js";

export interface LlmConfig {
  configured: boolean;
  slots: Record<
    string,
    {
      provider: string;
      model: string;
      protocol: string;
      tag?: string;
    }
  >;
  providers: string[];
}

export class LlmConfigResource {
  constructor(private readonly transport: Transport) {}

  async get(): Promise<LlmConfig> {
    return this.transport.request<LlmConfig>({
      method: "GET",
      path: "/api/llm-config",
    });
  }

  async listPresets(): Promise<unknown[]> {
    return this.transport.request<unknown[]>({
      method: "GET",
      path: "/api/presets",
    });
  }
}
