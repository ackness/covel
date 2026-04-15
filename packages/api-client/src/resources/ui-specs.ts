import type { Transport } from "../transport/transport.js";

export interface UiSpecSlotEntry {
  pluginId: string;
  specs: readonly Record<string, unknown>[];
}

export interface UiSpecs {
  right: UiSpecSlotEntry[];
  message: UiSpecSlotEntry[];
  left: UiSpecSlotEntry[];
}

export class UiSpecsResource {
  constructor(private readonly transport: Transport) {}

  async get(sessionId?: string): Promise<UiSpecs> {
    return this.transport.request<UiSpecs>({
      method: "GET",
      path: "/api/ui-specs",
      query: sessionId ? { sessionId } : undefined,
    });
  }
}
