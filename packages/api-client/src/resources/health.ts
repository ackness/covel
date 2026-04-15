import type { Transport } from "../transport/transport.js";

export interface HealthStatus {
  status: string;
  version: string;
  storeBackend: string;
  bootId: string;
  timestamp: string;
  vector?: {
    capable: boolean;
    driver: string;
    modelCount: number;
    tableCount: number;
  };
}

export class HealthResource {
  constructor(private readonly transport: Transport) {}

  async get(): Promise<HealthStatus> {
    return this.transport.request<HealthStatus>({
      method: "GET",
      path: "/api/health",
    });
  }
}
